<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  MediaGroup,
  MediaItem,
  ReadyVariant,
  Source,
  UnifiedMedia,
} from "../../types/media";
import {
  getDownloadTarget,
  readyItem,
  readyVariant,
  resourceSource,
  sourceUrl,
} from "../../utils/mediaContract";
import type { EnqueueDownloadItem, ExtensionSettings } from "../protocol";
import {
  buildChecklistSubfolderEnqueueItems,
  buildChecklistZipEnqueueItem,
  buildPrimarySingleCtaLabel,
  buildSidePanelQualityOptions,
  buildSingleDownloadEnqueueItem,
  classifyMediaLayout,
  copyTextToClipboard,
  formatDurationMs,
  formatPlatformDisplayName,
  openSafeHttpTab,
  resolveSafeApiOrigin,
  selectPreferredQualityOption,
  type ChecklistItemSelectionEntry,
  type LivePhotoSaveFilter,
  type SidePanelQualityOption,
} from "../uiTargetHelpers";

const props = defineProps<{
  media: UnifiedMedia;
  workFingerprint: string;
  isSaved: boolean;
  settings: ExtensionSettings;
  resolvingItemIds: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  (
    e: "enqueue-downloads",
    payload: { items: EnqueueDownloadItem[]; groupBatchId?: string },
  ): void;
  (e: "resolve-lazy-item", item: MediaItem): Promise<MediaItem | null> | void;
  (e: "refresh-parse"): void;
  (
    e: "notify",
    payload: { message: string; tone?: "success" | "error" | "info" },
  ): void;
  (
    e: "request-resolve-item",
    item: MediaItem,
    done: (resolved: MediaItem | null) => void,
  ): void;
}>();

const apiOrigin = computed(() => resolveSafeApiOrigin(props.settings.apiBaseUrl));
const targetContext = computed(() => ({ apiOrigin: apiOrigin.value }));

const layoutKind = computed(() => classifyMediaLayout(props.media));

// Track broken image/video preview URLs so UI gracefully falls back without ugly broken icons
const brokenUrls = ref<Record<string, boolean>>({});
function markUrlBroken(url: string) {
  if (url && !brokenUrls.value[url]) {
    brokenUrls.value = { ...brokenUrls.value, [url]: true };
  }
}
function safeAssetUrl(raw: string): string {
  return raw && !brokenUrls.value[raw] ? raw : "";
}
function safeSourceUrl(src?: Source | null): string {
  if (!src) return "";
  try {
    return safeAssetUrl(sourceUrl(src, targetContext.value));
  } catch {
    return "";
  }
}

// Collections & episodes for multi_video (e.g. Bilibili multi-P / seasons)
const collections = computed<MediaGroup[]>(() =>
  (props.media.groups ?? []).filter((g) => g.kind !== "album"),
);
const activeCollectionIdx = ref(0);

const allVideoOrAudioItems = computed<MediaItem[]>(() =>
  props.media.items.filter(
    (it) => it.type === "video" || it.type === "audio",
  ),
);

const visibleEpisodes = computed<MediaItem[]>(() => {
  const group = collections.value[activeCollectionIdx.value];
  if (!group) return allVideoOrAudioItems.value;
  const byId = new Map(allVideoOrAudioItems.value.map((it) => [it.id, it]));
  return group.item_ids
    .map((id) => byId.get(id))
    .filter((it): it is MediaItem => Boolean(it));
});

const albumItems = computed<MediaItem[]>(() =>
  props.media.items.filter(
    (it) => it.type === "image" || it.type === "live_photo",
  ),
);

const hasLivePhotos = computed(() =>
  albumItems.value.some((it) => it.type === "live_photo"),
);

const livePhotoFilter = ref<LivePhotoSaveFilter>("both");

// Active item for single view or multi_video active player
const activeItemId = ref<string>("");
// Per-item selected quality option key (`variant:...` or `attachment:...`)
const selectedOptionKeyByItem = ref<Record<string, string>>({});
// Checklist selected item IDs (for album or multi_video)
const checkedIds = ref<Set<string>>(new Set());

// Lightbox modal for album/LivePhoto preview
const previewModalItem = ref<MediaItem | null>(null);
const previewLiveMode = ref<"motion" | "image">("motion");

const batchPreparingProgress = ref<{ current: number; total: number } | null>(
  null,
);
const copiedDirectLink = ref(false);
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

function isItemCheckable(item: MediaItem): boolean {
  return item.state !== "unavailable";
}

const checklistPool = computed<MediaItem[]>(() => {
  if (layoutKind.value === "album") return albumItems.value;
  if (layoutKind.value === "multi_video") return visibleEpisodes.value;
  return [];
});

function initSelectionForMedia() {
  brokenUrls.value = {};
  activeCollectionIdx.value = 0;
  previewModalItem.value = null;
  livePhotoFilter.value = "both";
  batchPreparingProgress.value = null;

  const defaultId =
    props.media.default_item_id || props.media.items[0]?.id || "";
  if (collections.value.length > 0 && defaultId) {
    const foundGroup = collections.value.findIndex((g) =>
      g.item_ids.includes(defaultId),
    );
    if (foundGroup >= 0) {
      activeCollectionIdx.value = foundGroup;
    }
  }
  activeItemId.value = defaultId;

  // Pre-select preferred quality option for every ready item according to settings.qualityPreference
  const nextOptionMap: Record<string, string> = {};
  for (const item of props.media.items) {
    if (readyItem(item)) {
      const opts = buildSidePanelQualityOptions(
        props.media,
        item,
        apiOrigin.value,
      );
      const preferred = selectPreferredQualityOption(
        opts,
        item,
        props.settings.qualityPreference,
        props.media,
        apiOrigin.value,
      );
      if (preferred) {
        nextOptionMap[item.id] = preferred.key;
      }
    }
  }
  selectedOptionKeyByItem.value = nextOptionMap;

  // Default all checkable items to checked so 1-click saves the entire album / multi-P!
  resetChecklistToAllChecked();
}

function resetChecklistToAllChecked() {
  const next = new Set<string>();
  for (const item of checklistPool.value) {
    if (isItemCheckable(item)) {
      next.add(item.id);
    }
  }
  checkedIds.value = next;
}

// Re-initialize only when the logical work changes (not when lazy resolve mutates an episode in place)
watch(
  () =>
    `${props.media.platform}:${props.media.content_id || ""}:${props.media.source_url || ""}:${props.media.generated_at || ""}`,
  () => {
    initSelectionForMedia();
  },
  { immediate: true },
);

// Re-apply quality preference when user updates default quality preference in Settings
watch(
  () => props.settings.qualityPreference,
  (newPref) => {
    const nextMap = { ...selectedOptionKeyByItem.value };
    for (const item of props.media.items) {
      if (readyItem(item)) {
        const opts = buildSidePanelQualityOptions(
          props.media,
          item,
          apiOrigin.value,
        );
        const preferred = selectPreferredQualityOption(
          opts,
          item,
          newPref,
          props.media,
          apiOrigin.value,
        );
        if (preferred) {
          nextMap[item.id] = preferred.key;
        }
      }
    }
    selectedOptionKeyByItem.value = nextMap;
  },
);

function selectCollection(index: number) {
  if (activeCollectionIdx.value === index) return;
  activeCollectionIdx.value = index;
  const firstEp = visibleEpisodes.value[0];
  if (firstEp) {
    activeItemId.value = firstEp.id;
  }
  resetChecklistToAllChecked();
}

const activeItem = computed<MediaItem | null>(() => {
  const found = props.media.items.find((it) => it.id === activeItemId.value);
  return found ?? props.media.items[0] ?? null;
});

const activeQualityOptions = computed<SidePanelQualityOption[]>(() =>
  buildSidePanelQualityOptions(props.media, activeItem.value, apiOrigin.value),
);

const activeSelectedOption = computed<SidePanelQualityOption | null>(() => {
  const opts = activeQualityOptions.value;
  if (!opts.length) return null;
  const item = activeItem.value;
  const savedKey = item ? selectedOptionKeyByItem.value[item.id] : undefined;
  if (savedKey) {
    const matched = opts.find((o) => o.key === savedKey);
    if (matched) return matched;
  }
  return selectPreferredQualityOption(
    opts,
    item,
    props.settings.qualityPreference,
    props.media,
    apiOrigin.value,
  );
});

function chooseQualityOption(opt: SidePanelQualityOption) {
  if (!activeItem.value || !opt.downloadable) return;
  selectedOptionKeyByItem.value = {
    ...selectedOptionKeyByItem.value,
    [activeItem.value.id]: opt.key,
  };
}

// Inline preview URL resolution (prefers muxed playable preview stream for YouTube split 4K variants)
const previewCoverUrl = computed<string>(() => {
  const itemCover = safeSourceUrl(activeItem.value?.cover);
  if (itemCover) return itemCover;
  const mediaCover = safeSourceUrl(props.media.cover);
  if (mediaCover) return mediaCover;
  if (activeItem.value?.type === "image") {
    return safeAssetUrl(activeSelectedOption.value?.directUrl || "");
  }
  if (activeItem.value?.type === "live_photo") {
    return safeAssetUrl(resolveLiveResourceUrl(activeItem.value, "image"));
  }
  return "";
});

const previewVideoUrl = computed<string>(() => {
  const item = activeItem.value;
  if (!item) return "";
  if (item.type === "live_photo") {
    return safeAssetUrl(resolveLiveResourceUrl(item, "motion"));
  }
  if (item.type !== "video" && item.type !== "audio") return "";

  const chosen = activeSelectedOption.value;
  if (!chosen) return "";

  // On YouTube, if the user selected a 4K/1080p video-only adaptive stream (`muxPair`),
  // prefer an inline-playable muxed stream (e.g. 360p with audio) for smooth preview if available
  if (props.media.platform === "youtube" && chosen.muxPair) {
    const muxedPlayable = activeQualityOptions.value.find(
      (o) =>
        !o.isAudioOnly &&
        !o.muxPair &&
        o.variant.metadata?.has_audio === true &&
        o.downloadTarget.kind === "file" &&
        safeAssetUrl(o.directUrl),
    );
    if (muxedPlayable) {
      return safeAssetUrl(muxedPlayable.directUrl);
    }
  }

  if (chosen.downloadTarget.kind === "file") {
    return safeAssetUrl(chosen.directUrl);
  }
  return "";
});

const durationLabel = computed(() =>
  formatDurationMs(
    activeItem.value?.duration_ms ??
      activeSelectedOption.value?.variant.metadata?.duration_ms,
  ),
);

const platformBadgeText = computed(() =>
  formatPlatformDisplayName(props.media.platform),
);

const singlePrimaryCtaText = computed(() =>
  buildPrimarySingleCtaLabel({
    item: activeItem.value,
    option: activeSelectedOption.value,
  }),
);

const directCopyCandidateUrl = computed<string>(() => {
  if (activeSelectedOption.value?.directUrl) {
    return activeSelectedOption.value.directUrl;
  }
  if (activeItem.value?.type === "live_photo") {
    return (
      resolveLiveResourceUrl(activeItem.value, "motion") ||
      resolveLiveResourceUrl(activeItem.value, "image")
    );
  }
  return props.media.source_url || "";
});

async function handleCopyDirectLink() {
  const url = directCopyCandidateUrl.value;
  if (!url) return;
  const ok = await copyTextToClipboard(url);
  if (ok) {
    copiedDirectLink.value = true;
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copiedDirectLink.value = false;
    }, 1800);
    emit("notify", { message: "直链已复制到剪贴板", tone: "success" });
  } else {
    emit("notify", { message: "复制失败，请手动复制", tone: "error" });
  }
}

function handleSinglePrimaryDownload() {
  const item = activeItem.value;
  const opt = activeSelectedOption.value;
  if (!item || !opt || !opt.downloadable) return;
  try {
    const enqueueItem = buildSingleDownloadEnqueueItem({
      media: props.media,
      item,
      option: opt,
      settings: props.settings,
      workFingerprint: props.workFingerprint,
    });
    emit("enqueue-downloads", { items: [enqueueItem] });
  } catch (err) {
    emit("notify", {
      message: err instanceof Error ? err.message : "构建下载任务失败",
      tone: "error",
    });
  }
}

// ============================================================================
// Album / LivePhoto / Multi-P Helpers
// ============================================================================

function resolveLiveResourceUrl(
  item: MediaItem,
  role: "image" | "motion",
): string {
  if (!readyItem(item)) return "";
  const pairVar = item.variants.find(
    (v): v is ReadyVariant => readyVariant(v) && v.delivery.kind === "pair",
  );
  if (!pairVar || pairVar.delivery.kind !== "pair") return "";
  const res = pairVar.delivery.resources.find((r) => r.role === role);
  const src = res ? resourceSource(res, targetContext.value) : undefined;
  if (!src) return "";
  try {
    return sourceUrl(src, targetContext.value);
  } catch {
    return "";
  }
}

function resolveAlbumThumbUrl(item: MediaItem): string {
  const cover = safeSourceUrl(item.cover);
  if (cover) return cover;
  if (item.type === "live_photo") {
    return safeAssetUrl(resolveLiveResourceUrl(item, "image"));
  }
  if (readyItem(item)) {
    const target = getDownloadTarget(item, null, targetContext.value);
    if (target.kind === "file") {
      return safeAssetUrl(target.url);
    }
  }
  return "";
}

function toggleCheckItem(item: MediaItem) {
  if (!isItemCheckable(item)) return;
  const next = new Set(checkedIds.value);
  if (next.has(item.id)) {
    next.delete(item.id);
  } else {
    next.add(item.id);
  }
  checkedIds.value = next;
}

function selectAllChecklist() {
  resetChecklistToAllChecked();
}

function invertChecklist() {
  const next = new Set<string>();
  for (const item of checklistPool.value) {
    if (isItemCheckable(item) && !checkedIds.value.has(item.id)) {
      next.add(item.id);
    }
  }
  checkedIds.value = next;
}

const checkedCount = computed(() => {
  let count = 0;
  for (const item of checklistPool.value) {
    if (checkedIds.value.has(item.id)) count++;
  }
  return count;
});

const checkableTotalCount = computed(
  () => checklistPool.value.filter((it) => isItemCheckable(it)).length,
);

function requestLazyResolvePromise(item: MediaItem): Promise<MediaItem | null> {
  return new Promise((resolve) => {
    emit("request-resolve-item", item, (resolved) => {
      resolve(resolved);
    });
  });
}

async function handleSelectEpisode(item: MediaItem) {
  activeItemId.value = item.id;
  if (item.state === "deferred" && item.resolve_url) {
    const resolved = await requestLazyResolvePromise(item);
    if (resolved && readyItem(resolved)) {
      const opts = buildSidePanelQualityOptions(
        props.media,
        resolved,
        apiOrigin.value,
      );
      const preferred = selectPreferredQualityOption(
        opts,
        resolved,
        props.settings.qualityPreference,
        props.media,
        apiOrigin.value,
      );
      if (preferred) {
        selectedOptionKeyByItem.value = {
          ...selectedOptionKeyByItem.value,
          [resolved.id]: preferred.key,
        };
      }
    }
  }
}

function openAlbumPreview(item: MediaItem) {
  previewModalItem.value = item;
  previewLiveMode.value = item.type === "live_photo" ? "motion" : "image";
}

const selectedChecklistEntries = computed<ChecklistItemSelectionEntry[]>(() => {
  const list = checklistPool.value;
  const out: ChecklistItemSelectionEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!checkedIds.value.has(item.id)) continue;
    let explicitOption: SidePanelQualityOption | null = null;
    if (readyItem(item) && selectedOptionKeyByItem.value[item.id]) {
      const opts = buildSidePanelQualityOptions(
        props.media,
        item,
        apiOrigin.value,
      );
      explicitOption =
        opts.find((o) => o.key === selectedOptionKeyByItem.value[item.id]) ??
        null;
    }
    out.push({
      item,
      ordinalIndex: i + 1,
      explicitOption,
    });
  }
  return out;
});

const subfolderBatchLabel = computed(() => {
  if (batchPreparingProgress.value) {
    return `正在解析分P (${batchPreparingProgress.value.current}/${batchPreparingProgress.value.total})...`;
  }
  const sel = checkedCount.value;
  const tot = checklistPool.value.length;
  if (layoutKind.value === "multi_video") {
    return `按标题存子文件夹 · 已选分P (${sel}/${tot})`;
  }
  if (hasLivePhotos.value && albumItems.value.every((i) => i.type === "live_photo")) {
    return `按标题存子文件夹 · 实况 (${sel}/${tot})`;
  }
  return `按标题存子文件夹 · 已选图片 (${sel}/${tot})`;
});

const zipPreviewDecision = computed(() => {
  const readyEntries = selectedChecklistEntries.value.filter((e) =>
    readyItem(e.item),
  );
  if (!readyEntries.length) {
    return { ok: true as const, reason: "" };
  }
  const res = buildChecklistZipEnqueueItem({
    media: props.media,
    entries: readyEntries,
    totalCount: checklistPool.value.length,
    settings: props.settings,
    livePhotoFilter: livePhotoFilter.value,
    workFingerprint: props.workFingerprint,
  });
  return res.ok ? { ok: true as const, reason: "" } : { ok: false as const, reason: res.reason };
});

async function prepareResolvedChecklistEntries(): Promise<
  ChecklistItemSelectionEntry[] | null
> {
  const rawEntries = selectedChecklistEntries.value;
  if (!rawEntries.length) {
    emit("notify", { message: "请至少勾选一项要下载的内容", tone: "info" });
    return null;
  }

  const deferredList = rawEntries.filter(
    (e) => e.item.state === "deferred" && Boolean(e.item.resolve_url),
  );

  const resolvedById = new Map<string, MediaItem>();
  if (deferredList.length > 0) {
    batchPreparingProgress.value = { current: 0, total: deferredList.length };
    try {
      for (let i = 0; i < deferredList.length; i++) {
        batchPreparingProgress.value = {
          current: i + 1,
          total: deferredList.length,
        };
        const resolved = await requestLazyResolvePromise(deferredList[i].item);
        if (resolved && readyItem(resolved)) {
          resolvedById.set(resolved.id, resolved);
        }
      }
    } finally {
      batchPreparingProgress.value = null;
    }
  }

  return rawEntries
    .map((entry) => {
      const updatedItem = resolvedById.get(entry.item.id) ?? entry.item;
      return {
        ...entry,
        item: updatedItem,
      };
    })
    .filter((entry) => readyItem(entry.item));
}

async function handleBatchSubfolderSave() {
  if (batchPreparingProgress.value) return;
  const prepared = await prepareResolvedChecklistEntries();
  if (!prepared || !prepared.length) {
    if (prepared && !prepared.length) {
      emit("notify", {
        message: "所选条目未能完成解析，请重试",
        tone: "error",
      });
    }
    return;
  }

  try {
    const items = buildChecklistSubfolderEnqueueItems({
      media: props.media,
      entries: prepared,
      totalCount: checklistPool.value.length,
      settings: props.settings,
      livePhotoFilter: livePhotoFilter.value,
      workFingerprint: props.workFingerprint,
    });
    if (!items.length) {
      emit("notify", { message: "未生成可下载的文件条目", tone: "error" });
      return;
    }
    const groupBatchId = `subfolder-${Date.now()}`;
    emit("enqueue-downloads", { items, groupBatchId });
  } catch (err) {
    emit("notify", {
      message: err instanceof Error ? err.message : "构建子文件夹下载任务失败",
      tone: "error",
    });
  }
}

async function handleBatchZipSave() {
  if (batchPreparingProgress.value) return;
  const prepared = await prepareResolvedChecklistEntries();
  if (!prepared || !prepared.length) return;

  const built = buildChecklistZipEnqueueItem({
    media: props.media,
    entries: prepared,
    totalCount: checklistPool.value.length,
    settings: props.settings,
    livePhotoFilter: livePhotoFilter.value,
    workFingerprint: props.workFingerprint,
  });

  if (!built.ok) {
    emit("notify", { message: built.reason, tone: "error" });
    return;
  }
  emit("enqueue-downloads", { items: [built.item] });
}
</script>

<template>
  <section class="sp-result">
    <!-- Work Metadata & Media Stage Card -->
    <div class="sp-work-card">
      <!-- Compact stage preview for Single or Active Multi-Video or Single LivePhoto -->
      <div
        v-if="layoutKind !== 'album' || albumItems.length === 1"
        class="sp-stage"
      >
        <video
          v-if="previewVideoUrl"
          :key="previewVideoUrl"
          :src="previewVideoUrl"
          :poster="previewCoverUrl || undefined"
          controls
          preload="metadata"
          playsinline
          referrerpolicy="no-referrer"
          class="sp-stage__video"
          @error="markUrlBroken(previewVideoUrl)"
        />
        <img
          v-else-if="previewCoverUrl"
          :src="previewCoverUrl"
          alt="作品封面预览"
          referrerpolicy="no-referrer"
          class="sp-stage__cover"
          @error="markUrlBroken(previewCoverUrl)"
        />
        <div v-else class="sp-stage__placeholder">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <polygon points="10 9 15 12 10 15 10 9" fill="currentColor" />
          </svg>
          <span>{{ activeItem?.state === 'deferred' ? '点选分集自动加载播放源' : '媒体流已就绪，可直接后台下载' }}</span>
        </div>

        <div class="sp-stage__badges">
          <span class="sp-stage__chip">{{ platformBadgeText }}</span>
          <span v-if="durationLabel" class="sp-stage__chip sp-stage__chip--mono">
            {{ durationLabel }}
          </span>
          <span
            v-if="activeSelectedOption?.muxPair"
            class="sp-stage__chip sp-stage__chip--mux"
            title="下载时由后台 Offscreen Mediabunny 自动无损合成音视频轨"
          >
            下载自动无损合流原声
          </span>
        </div>
      </div>

      <!-- Work Meta Header -->
      <div class="sp-work-meta">
        <div class="sp-work-meta__badges">
          <span v-if="layoutKind === 'album' && albumItems.length > 1" class="sp-badge sp-badge--accent">
            {{ platformBadgeText }} · {{ albumItems.length }} 项图集
          </span>
          <span
            v-if="isSaved"
            class="sp-badge sp-badge--saved"
            title="此作品近期已下载保存过，仍可随时重新下载"
          >
            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
            </svg>
            已保存
          </span>

          <div class="sp-work-meta__spacer" />

          <button
            v-if="media.source_url"
            type="button"
            class="sp-link-icon-btn"
            title="在新标签页打开原作品页"
            @click="openSafeHttpTab(media.source_url)"
          >
            原帖 ↗
          </button>
          <button
            type="button"
            class="sp-link-icon-btn"
            title="强制重新解析最新直链"
            @click="emit('refresh-parse')"
          >
            刷新
          </button>
        </div>

        <h2 class="sp-work-meta__title sp-truncate-2" :title="media.title || ''">
          {{ media.title || activeItem?.title || `${platformBadgeText} 素材作品` }}
        </h2>

        <div v-if="media.author?.name" class="sp-work-meta__author sp-truncate-1">
          @{{ media.author.name }}
        </div>
      </div>

      <!-- Primary Single-Work CTA Bar (shown for Single layout OR as quick current-episode download in Multi-Video) -->
      <div v-if="layoutKind === 'single'" class="sp-cta-row">
        <button
          type="button"
          class="sp-btn sp-btn--primary sp-cta-row__main"
          :disabled="!activeSelectedOption || !activeSelectedOption.downloadable"
          @click="handleSinglePrimaryDownload"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span class="sp-truncate-1">{{ singlePrimaryCtaText }}</span>
        </button>

        <button
          type="button"
          class="sp-btn sp-btn--secondary sp-cta-row__copy"
          :disabled="!directCopyCandidateUrl"
          title="复制当前选中画质直链到剪贴板"
          @click="handleCopyDirectLink"
        >
          <span>{{ copiedDirectLink ? "已复制" : "复制直链" }}</span>
        </button>
      </div>

      <!-- Compact current-episode quick save strip in multi-video mode -->
      <div
        v-else-if="layoutKind === 'multi_video' && activeItem && readyItem(activeItem)"
        class="sp-cta-row sp-cta-row--compact"
      >
        <button
          type="button"
          class="sp-btn sp-btn--ghost sp-btn--sm sp-cta-row__main"
          :disabled="!activeSelectedOption || !activeSelectedOption.downloadable"
          @click="handleSinglePrimaryDownload"
        >
          <span class="sp-truncate-1">仅下当前集：{{ singlePrimaryCtaText }}</span>
        </button>
        <button
          type="button"
          class="sp-btn sp-btn--ghost sp-btn--sm"
          :disabled="!directCopyCandidateUrl"
          @click="handleCopyDirectLink"
        >
          {{ copiedDirectLink ? "已复制" : "复制直链" }}
        </button>
      </div>
    </div>

    <!-- Pixiv-Style Album / LivePhoto Checklist Grid -->
    <div v-if="layoutKind === 'album'" class="sp-panel-card">
      <!-- 3-Way Live Photo Mode Pill Selector -->
      <div v-if="hasLivePhotos" class="sp-live-bar">
        <span class="sp-live-bar__label">实况保存：</span>
        <div class="sp-live-pills" role="radiogroup" aria-label="实况照片保存模式">
          <button
            type="button"
            class="sp-live-pill"
            :class="{ 'sp-live-pill--on': livePhotoFilter === 'both' }"
            @click="livePhotoFilter = 'both'"
          >
            实况视频+封面全下
          </button>
          <button
            type="button"
            class="sp-live-pill"
            :class="{ 'sp-live-pill--on': livePhotoFilter === 'motion' }"
            @click="livePhotoFilter = 'motion'"
          >
            仅实况视频
          </button>
          <button
            type="button"
            class="sp-live-pill"
            :class="{ 'sp-live-pill--on': livePhotoFilter === 'image' }"
            @click="livePhotoFilter = 'image'"
          >
            仅静态图
          </button>
        </div>
      </div>

      <!-- Checklist Header -->
      <div class="sp-checklist-hd">
        <div class="sp-checklist-hd__title">
          <span>勾选要保存的条目</span>
          <span class="sp-checklist-hd__count">
            {{ checkedCount }} / {{ checkableTotalCount }}
          </span>
        </div>
        <div class="sp-checklist-hd__btns">
          <button type="button" class="sp-mini-link" @click="selectAllChecklist">
            全选
          </button>
          <button type="button" class="sp-mini-link" @click="invertChecklist">
            反选
          </button>
        </div>
      </div>

      <!-- Thumbnail Grid -->
      <div
        class="sp-thumb-grid"
        :class="{
          'sp-thumb-grid--single': albumItems.length === 1,
          'sp-thumb-grid--two': albumItems.length === 2,
        }"
      >
        <div
          v-for="(item, idx) in albumItems"
          :key="item.id"
          class="sp-thumb-cell"
          :class="{ 'sp-thumb-cell--checked': checkedIds.has(item.id) }"
          @click="toggleCheckItem(item)"
        >
          <img
            v-if="resolveAlbumThumbUrl(item)"
            :src="resolveAlbumThumbUrl(item)"
            :alt="`图集第 ${idx + 1} 项`"
            referrerpolicy="no-referrer"
            loading="lazy"
            class="sp-thumb-cell__img"
            @error="markUrlBroken(resolveAlbumThumbUrl(item))"
          />
          <div v-else class="sp-thumb-cell__fallback">
            #{{ String(idx + 1).padStart(2, "0") }}
          </div>

          <span class="sp-thumb-cell__idx">
            {{ String(idx + 1).padStart(2, "0") }}
          </span>

          <span v-if="item.type === 'live_photo'" class="sp-thumb-cell__live">
            LIVE
          </span>

          <span
            class="sp-thumb-cell__check"
            :class="{ 'sp-thumb-cell__check--on': checkedIds.has(item.id) }"
            role="checkbox"
            :aria-checked="checkedIds.has(item.id)"
          >
            <svg
              v-if="checkedIds.has(item.id)"
              viewBox="0 0 16 16"
              width="11"
              height="11"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
            </svg>
          </span>

          <button
            type="button"
            class="sp-thumb-cell__zoom"
            title="放大预览"
            aria-label="放大预览"
            @click.stop="openAlbumPreview(item)"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Dual Batch Action Buttons (honoring settings.batchSaveMode) -->
      <div class="sp-batch-actions">
        <button
          type="button"
          class="sp-btn sp-batch-actions__subfolder"
          :class="
            settings.batchSaveMode === 'subfolder' || !zipPreviewDecision.ok
              ? 'sp-btn--primary'
              : 'sp-btn--secondary'
          "
          :disabled="checkedCount === 0 || Boolean(batchPreparingProgress)"
          title="逐个流式保存到下载目录的标题子文件夹，零 500 MB 内存打包上限"
          @click="handleBatchSubfolderSave"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span class="sp-truncate-1">{{ subfolderBatchLabel }}</span>
        </button>

        <div class="sp-batch-actions__subrow">
          <button
            type="button"
            class="sp-btn sp-btn--sm sp-batch-actions__zip"
            :class="
              settings.batchSaveMode === 'zip' && zipPreviewDecision.ok
                ? 'sp-btn--primary'
                : 'sp-btn--ghost'
            "
            :disabled="
              checkedCount === 0 ||
              Boolean(batchPreparingProgress) ||
              !zipPreviewDecision.ok
            "
            :title="
              zipPreviewDecision.ok
                ? '将已选条目无压缩打包为单个 ZIP 文件保存'
                : zipPreviewDecision.reason
            "
            @click="handleBatchZipSave"
          >
            <span>打包 ZIP ({{ checkedCount }})</span>
          </button>

          <button
            type="button"
            class="sp-btn sp-btn--ghost sp-btn--sm"
            :disabled="!directCopyCandidateUrl"
            @click="handleCopyDirectLink"
          >
            {{ copiedDirectLink ? "已复制" : "复制直链" }}
          </button>
        </div>
      </div>
    </div>

    <!-- Bilibili Multi-P / Collection Episode Checklist -->
    <div v-if="layoutKind === 'multi_video'" class="sp-panel-card">
      <!-- Collection Switcher Tabs -->
      <div v-if="collections.length > 1" class="sp-collection-tabs">
        <button
          v-for="(col, idx) in collections"
          :key="col.id"
          type="button"
          class="sp-collection-tab"
          :class="{ 'sp-collection-tab--on': activeCollectionIdx === idx }"
          @click="selectCollection(idx)"
        >
          {{ col.title || `合集 ${idx + 1}` }}
        </button>
      </div>

      <div class="sp-checklist-hd">
        <div class="sp-checklist-hd__title">
          <span>分P / 剧集列表</span>
          <span class="sp-checklist-hd__count">
            已选 {{ checkedCount }} / {{ checkableTotalCount }}
          </span>
        </div>
        <div class="sp-checklist-hd__btns">
          <button type="button" class="sp-mini-link" @click="selectAllChecklist">
            全选
          </button>
          <button type="button" class="sp-mini-link" @click="invertChecklist">
            反选
          </button>
        </div>
      </div>

      <div class="sp-ep-list">
        <div
          v-for="(ep, idx) in visibleEpisodes"
          :key="ep.id"
          class="sp-ep-row"
          :class="{
            'sp-ep-row--active': activeItem?.id === ep.id,
            'sp-ep-row--disabled': ep.state === 'unavailable',
          }"
        >
          <button
            type="button"
            class="sp-ep-row__check"
            :class="{ 'sp-ep-row__check--on': checkedIds.has(ep.id) }"
            :disabled="ep.state === 'unavailable'"
            role="checkbox"
            :aria-checked="checkedIds.has(ep.id)"
            @click.stop="toggleCheckItem(ep)"
          >
            <svg
              v-if="checkedIds.has(ep.id)"
              viewBox="0 0 16 16"
              width="10"
              height="10"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
            </svg>
          </button>

          <button
            type="button"
            class="sp-ep-row__body"
            :disabled="ep.state === 'unavailable'"
            @click="handleSelectEpisode(ep)"
          >
            <span class="sp-ep-row__p">P{{ ep.index ?? idx + 1 }}</span>
            <span class="sp-ep-row__title sp-truncate-1">
              {{ ep.title || `第 ${idx + 1} 集` }}
            </span>
            <span v-if="resolvingItemIds.has(ep.id)" class="sp-ep-row__tag sp-ep-row__tag--loading">
              解析中...
            </span>
            <span
              v-else-if="ep.state === 'deferred'"
              class="sp-ep-row__tag sp-ep-row__tag--lazy"
              title="点击预览或直接批量下载时自动按需解析"
            >
              按需解析
            </span>
            <span
              v-else-if="ep.state === 'unavailable'"
              class="sp-ep-row__tag sp-ep-row__tag--err"
            >
              不可用
            </span>
            <span v-else-if="ep.duration_ms" class="sp-ep-row__dur">
              {{ formatDurationMs(ep.duration_ms) }}
            </span>
          </button>
        </div>
      </div>

      <!-- Dual Batch Action Buttons for Multi-Video -->
      <div class="sp-batch-actions">
        <button
          type="button"
          class="sp-btn sp-batch-actions__subfolder"
          :class="
            settings.batchSaveMode === 'subfolder' || !zipPreviewDecision.ok
              ? 'sp-btn--primary'
              : 'sp-btn--secondary'
          "
          :disabled="checkedCount === 0 || Boolean(batchPreparingProgress)"
          @click="handleBatchSubfolderSave"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span class="sp-truncate-1">{{ subfolderBatchLabel }}</span>
        </button>

        <button
          type="button"
          class="sp-btn sp-btn--sm sp-batch-actions__zip"
          :class="
            settings.batchSaveMode === 'zip' && zipPreviewDecision.ok
              ? 'sp-btn--primary'
              : 'sp-btn--ghost'
          "
          :disabled="
            checkedCount === 0 ||
            Boolean(batchPreparingProgress) ||
            !zipPreviewDecision.ok
          "
          :title="
            zipPreviewDecision.ok
              ? '将已选分P打包为单个 ZIP 文件（500 MB 以内）'
              : zipPreviewDecision.reason
          "
          @click="handleBatchZipSave"
        >
          打包 ZIP ({{ checkedCount }})
        </button>
      </div>
    </div>

    <!-- Clickable Quality / Track Variant Cards (for Single Video/Audio/Image or Active Multi-P Episode) -->
    <div
      v-if="layoutKind !== 'album' && activeQualityOptions.length > 0"
      class="sp-panel-card"
    >
      <div class="sp-section-hd">
        <span class="sp-section-hd__title">画质与音轨选择</span>
        <span class="sp-section-hd__hint">
          记忆偏好：{{
            settings.qualityPreference === "best"
              ? "最高画质"
              : settings.qualityPreference === "1080p"
                ? "1080p 优先"
                : "仅音频 M4A"
          }}
        </span>
      </div>

      <div class="sp-variant-list">
        <button
          v-for="opt in activeQualityOptions"
          :key="opt.key"
          type="button"
          class="sp-variant-card"
          :class="{
            'sp-variant-card--active': activeSelectedOption?.key === opt.key,
            'sp-variant-card--disabled': !opt.downloadable,
          }"
          :disabled="!opt.downloadable"
          @click="chooseQualityOption(opt)"
        >
          <div class="sp-variant-card__top">
            <div class="sp-variant-card__title-group">
              <span class="sp-variant-card__radio" />
              <span class="sp-variant-card__label">{{ opt.titleLabel }}</span>
              <span
                v-if="opt.audioBadge"
                class="sp-variant-badge"
                :class="`sp-variant-badge--${opt.audioBadge.tone}`"
              >
                {{ opt.audioBadge.text }}
              </span>
            </div>
            <span class="sp-variant-card__size">{{ opt.sizeLabel }}</span>
          </div>

          <div v-if="opt.specs.length > 0" class="sp-variant-card__specs">
            <span
              v-for="spec in opt.specs"
              :key="spec"
              class="sp-variant-spec-chip"
            >
              {{ spec }}
            </span>
            <span class="sp-variant-spec-chip sp-variant-spec-chip--ext">
              {{ opt.resolvedExt.toUpperCase() }}
            </span>
          </div>
        </button>
      </div>
    </div>

    <!-- Lightbox Preview Overlay inside SidePanel -->
    <div
      v-if="previewModalItem"
      class="sp-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="大图与实况预览"
      @click.self="previewModalItem = null"
    >
      <div class="sp-lightbox__card">
        <div class="sp-lightbox__hd">
          <div v-if="previewModalItem.type === 'live_photo'" class="sp-live-pills">
            <button
              type="button"
              class="sp-live-pill"
              :class="{ 'sp-live-pill--on': previewLiveMode === 'motion' }"
              @click="previewLiveMode = 'motion'"
            >
              实况动态
            </button>
            <button
              type="button"
              class="sp-live-pill"
              :class="{ 'sp-live-pill--on': previewLiveMode === 'image' }"
              @click="previewLiveMode = 'image'"
            >
              静态封面
            </button>
          </div>
          <span v-else class="sp-lightbox__title">高清预览</span>

          <button
            type="button"
            class="sp-lightbox__close"
            aria-label="关闭预览"
            @click="previewModalItem = null"
          >
            ✕
          </button>
        </div>

        <div class="sp-lightbox__body">
          <video
            v-if="
              previewModalItem.type === 'live_photo' &&
              previewLiveMode === 'motion' &&
              resolveLiveResourceUrl(previewModalItem, 'motion')
            "
            :src="resolveLiveResourceUrl(previewModalItem, 'motion')"
            :poster="resolveLiveResourceUrl(previewModalItem, 'image') || undefined"
            controls
            autoplay
            loop
            playsinline
            referrerpolicy="no-referrer"
            class="sp-lightbox__media"
          />
          <img
            v-else-if="resolveAlbumThumbUrl(previewModalItem)"
            :src="resolveAlbumThumbUrl(previewModalItem)"
            alt="预览图"
            referrerpolicy="no-referrer"
            class="sp-lightbox__media"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sp-result {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.sp-work-card,
.sp-panel-card {
  background: var(--sp-bg-surface);
  border: 1px solid var(--sp-border);
  border-radius: var(--sp-radius-lg);
  overflow: hidden;
  min-width: 0;
}

.sp-panel-card {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.sp-stage {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  max-height: 196px;
  background: #060913;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.sp-stage__video,
.sp-stage__cover {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.sp-stage__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--sp-text-muted);
  font-size: 11.5px;
  padding: 12px;
  text-align: center;
}

.sp-stage__badges {
  position: absolute;
  top: 7px;
  left: 7px;
  right: 7px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  pointer-events: none;
}

.sp-stage__chip {
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(11, 17, 32, 0.78);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #f8fafc;
  font-size: 10.5px;
  font-weight: 600;
}

.sp-stage__chip--mono {
  font-family: var(--sp-font-mono);
}

.sp-stage__chip--mux {
  background: rgba(99, 102, 241, 0.82);
  border-color: rgba(165, 180, 252, 0.45);
}

.sp-work-meta {
  padding: 9px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.sp-work-meta__badges {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}

.sp-work-meta__spacer {
  flex: 1;
}

.sp-link-icon-btn {
  border: 1px solid var(--sp-border);
  background: rgba(148, 163, 184, 0.08);
  color: var(--sp-text-secondary);
  border-radius: var(--sp-radius-xs);
  padding: 2px 6px;
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 140ms ease;
}

.sp-link-icon-btn:hover {
  color: var(--sp-text-primary);
  border-color: var(--sp-border-strong);
  background: rgba(148, 163, 184, 0.16);
}

.sp-work-meta__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--sp-text-primary);
  word-break: break-word;
}

.sp-work-meta__author {
  font-size: 11.5px;
  color: var(--sp-text-muted);
}

.sp-cta-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
  padding: 0 10px 10px;
  min-width: 0;
}

.sp-cta-row--compact {
  padding-top: 2px;
}

.sp-cta-row__main {
  flex: 1;
  min-width: 0;
}

.sp-cta-row__copy {
  flex-shrink: 0;
  padding-left: 10px;
  padding-right: 10px;
}

/* Live Photo 3-way selector */
.sp-live-bar {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--sp-border);
}

.sp-live-bar__label {
  font-size: 11px;
  font-weight: 600;
  color: var(--sp-text-secondary);
}

.sp-live-pills {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  background: var(--sp-bg-base);
  padding: 2px;
  border-radius: var(--sp-radius-sm);
  border: 1px solid var(--sp-border);
}

.sp-live-pill {
  border: none;
  border-radius: 6px;
  padding: 5px 4px;
  background: transparent;
  color: var(--sp-text-muted);
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 140ms ease;
}

.sp-live-pill--on {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.28), rgba(139, 92, 246, 0.28));
  color: #e0e7ff;
  box-shadow: inset 0 0 0 1px rgba(129, 140, 248, 0.4);
}

/* Checklist Header */
.sp-checklist-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.sp-checklist-hd__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--sp-text-secondary);
}

.sp-checklist-hd__count {
  font-family: var(--sp-font-mono);
  font-size: 11px;
  color: #a5b4fc;
  background: var(--sp-accent-soft);
  padding: 1px 6px;
  border-radius: 999px;
}

.sp-checklist-hd__btns {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sp-mini-link {
  border: 1px solid var(--sp-border);
  background: rgba(148, 163, 184, 0.08);
  color: var(--sp-text-secondary);
  border-radius: var(--sp-radius-xs);
  padding: 2px 7px;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 140ms ease;
}

.sp-mini-link:hover {
  color: var(--sp-text-primary);
  border-color: var(--sp-border-accent);
}

/* Pixiv-style Thumbnail Grid */
.sp-thumb-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.sp-thumb-grid--single {
  grid-template-columns: minmax(0, 1fr);
}

.sp-thumb-grid--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.sp-thumb-cell {
  position: relative;
  aspect-ratio: 1 / 1;
  border-radius: var(--sp-radius-sm);
  overflow: hidden;
  background: var(--sp-bg-base);
  border: 1.5px solid var(--sp-border);
  cursor: pointer;
  transition: border-color 140ms ease, transform 140ms ease;
}

.sp-thumb-grid--single .sp-thumb-cell {
  aspect-ratio: 16 / 10;
  max-height: 180px;
}

.sp-thumb-cell--checked {
  border-color: #818cf8;
  box-shadow: 0 0 0 1px rgba(129, 140, 248, 0.35);
}

.sp-thumb-cell__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.sp-thumb-cell__fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--sp-text-muted);
  font-family: var(--sp-font-mono);
  font-size: 12px;
}

.sp-thumb-cell__idx {
  position: absolute;
  top: 4px;
  left: 4px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(11, 17, 32, 0.75);
  color: #e2e8f0;
  font-family: var(--sp-font-mono);
  font-size: 10px;
  font-weight: 600;
}

.sp-thumb-cell__live {
  position: absolute;
  bottom: 4px;
  right: 4px;
  padding: 1px 5px;
  border-radius: 4px;
  background: linear-gradient(135deg, #6366f1, #ec4899);
  color: #ffffff;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.sp-thumb-cell__check {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  background: rgba(11, 17, 32, 0.72);
  border: 1.5px solid rgba(255, 255, 255, 0.55);
  color: #ffffff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 140ms ease;
}

.sp-thumb-cell__check--on {
  background: #6366f1;
  border-color: #818cf8;
}

.sp-thumb-cell__zoom {
  position: absolute;
  bottom: 4px;
  left: 4px;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  border: none;
  background: rgba(11, 17, 32, 0.72);
  color: #e2e8f0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.85;
}

.sp-thumb-cell__zoom:hover {
  opacity: 1;
  background: rgba(99, 102, 241, 0.85);
}

/* Batch Action Buttons */
.sp-batch-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 2px;
}

.sp-batch-actions__subfolder {
  width: 100%;
}

.sp-batch-actions__subrow {
  display: flex;
  gap: 6px;
}

.sp-batch-actions__zip {
  flex: 1;
}

/* Multi-video Episodes */
.sp-collection-tabs {
  display: flex;
  gap: 5px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.sp-collection-tab {
  border: 1px solid var(--sp-border);
  background: var(--sp-bg-base);
  color: var(--sp-text-muted);
  border-radius: var(--sp-radius-pill);
  padding: 3px 9px;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.sp-collection-tab--on {
  background: var(--sp-accent-soft);
  color: #c7d2fe;
  border-color: var(--sp-border-accent);
}

.sp-ep-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 190px;
  overflow-y: auto;
  padding-right: 2px;
}

.sp-ep-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border-radius: var(--sp-radius-sm);
  background: var(--sp-bg-base);
  border: 1px solid var(--sp-border);
  min-width: 0;
  transition: border-color 140ms ease, background-color 140ms ease;
}

.sp-ep-row--active {
  background: rgba(99, 102, 241, 0.12);
  border-color: var(--sp-border-accent);
}

.sp-ep-row--disabled {
  opacity: 0.45;
}

.sp-ep-row__check {
  width: 17px;
  height: 17px;
  border-radius: 4px;
  border: 1.5px solid var(--sp-border-strong);
  background: var(--sp-bg-surface);
  color: #ffffff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  padding: 0;
}

.sp-ep-row__check--on {
  background: #6366f1;
  border-color: #818cf8;
}

.sp-ep-row__body {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  padding: 0;
}

.sp-ep-row__p {
  font-family: var(--sp-font-mono);
  font-size: 10.5px;
  font-weight: 700;
  color: #a5b4fc;
  flex-shrink: 0;
}

.sp-ep-row__title {
  flex: 1;
  min-width: 0;
  color: var(--sp-text-primary);
}

.sp-ep-row__dur {
  font-family: var(--sp-font-mono);
  font-size: 10.5px;
  color: var(--sp-text-muted);
  flex-shrink: 0;
}

.sp-ep-row__tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  font-weight: 600;
  flex-shrink: 0;
}

.sp-ep-row__tag--lazy {
  background: rgba(148, 163, 184, 0.14);
  color: var(--sp-text-secondary);
}

.sp-ep-row__tag--loading {
  background: var(--sp-accent-soft);
  color: #a5b4fc;
}

.sp-ep-row__tag--err {
  background: var(--sp-danger-soft);
  color: #fca5a5;
}

/* Variant Cards */
.sp-section-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.sp-section-hd__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--sp-text-secondary);
}

.sp-section-hd__hint {
  font-size: 10.5px;
  color: var(--sp-text-muted);
}

.sp-variant-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sp-variant-card {
  width: 100%;
  min-width: 0;
  text-align: left;
  padding: 7px 9px;
  border-radius: var(--sp-radius-md);
  background: var(--sp-bg-base);
  border: 1px solid var(--sp-border);
  color: var(--sp-text-primary);
  font-family: inherit;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 5px;
  transition: border-color 140ms ease, background-color 140ms ease;
}

.sp-variant-card:hover:not(:disabled) {
  border-color: var(--sp-border-strong);
  background: rgba(30, 44, 74, 0.45);
}

.sp-variant-card--active {
  background: rgba(99, 102, 241, 0.13);
  border-color: #6366f1;
  box-shadow: inset 0 0 0 1px rgba(99, 102, 241, 0.25);
}

.sp-variant-card--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sp-variant-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.sp-variant-card__title-group {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}

.sp-variant-card__radio {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid var(--sp-border-strong);
  flex-shrink: 0;
  position: relative;
}

.sp-variant-card--active .sp-variant-card__radio {
  border-color: #818cf8;
  background: radial-gradient(circle, #818cf8 42%, transparent 46%);
}

.sp-variant-card__label {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--sp-text-primary);
}

.sp-variant-card__size {
  font-family: var(--sp-font-mono);
  font-size: 11px;
  color: var(--sp-text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

.sp-variant-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
}

.sp-variant-badge--mux {
  background: rgba(99, 102, 241, 0.2);
  color: #c7d2fe;
  border: 1px solid rgba(129, 140, 248, 0.35);
}

.sp-variant-badge--audio {
  background: rgba(16, 185, 129, 0.14);
  color: #6ee7b7;
}

.sp-variant-badge--track {
  background: rgba(236, 72, 153, 0.16);
  color: #f9a8d4;
}

.sp-variant-badge--silent {
  background: rgba(245, 158, 11, 0.15);
  color: #fcd34d;
}

.sp-variant-card__specs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-left: 18px;
}

.sp-variant-spec-chip {
  font-size: 10px;
  color: var(--sp-text-muted);
  background: rgba(148, 163, 184, 0.09);
  padding: 1px 5px;
  border-radius: 4px;
}

.sp-variant-spec-chip--ext {
  font-family: var(--sp-font-mono);
  color: var(--sp-text-secondary);
}

/* Lightbox inside SidePanel */
.sp-lightbox {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(6, 9, 19, 0.88);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
}

.sp-lightbox__card {
  width: 100%;
  max-height: 90vh;
  background: var(--sp-bg-surface);
  border: 1px solid var(--sp-border-strong);
  border-radius: var(--sp-radius-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.sp-lightbox__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--sp-border);
}

.sp-lightbox__title {
  font-size: 12px;
  font-weight: 600;
}

.sp-lightbox__close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid var(--sp-border);
  background: rgba(148, 163, 184, 0.1);
  color: var(--sp-text-primary);
  cursor: pointer;
}

.sp-lightbox__body {
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #050811;
}

.sp-lightbox__media {
  max-width: 100%;
  max-height: 72vh;
  object-fit: contain;
  border-radius: 6px;
}
</style>
