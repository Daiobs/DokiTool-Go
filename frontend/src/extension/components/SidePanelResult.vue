<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MediaItem, UnifiedMedia } from "../../types/media";
import { readyItem } from "../../utils/mediaContract";
import type {
  BatchSaveMode,
  EnqueueDownloadItem,
  EnqueueMultiPartItemsRequest,
  ExtensionSettings,
} from "../protocol";
import SidePanelSubtitlePanel from "./SidePanelSubtitlePanel.vue";
import {
  buildBatchPrimaryCtaLabel,
  buildChecklistMultiPartRequest,
  buildChecklistSubfolderEnqueueItems,
  buildChecklistZipEnqueueItem,
  buildExtensionTargetContext,
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
import {
  advancePreviewVideoRouteOnError,
  buildAllCheckedIdSet,
  buildMediaWorkWatchKey,
  buildPreferredOptionKeyMap,
  buildSelectedChecklistEntries,
  deriveSidePanelCollections,
  filterDeferredResolvableEntries,
  formatQualityPreferenceLabel,
  invertChecklistIdSet,
  LIVE_PHOTO_FILTER_OPTIONS,
  markPreviewUrlBroken,
  mergeResolvedChecklistEntries,
  pickActivePreviewVideoUrl,
  preserveOriginalResolveUrl,
  resolveActiveMediaItem,
  resolveActiveQualitySelection,
  resolveAlbumThumbnailUrl,
  resolveChecklistPool,
  resolveDirectCopyButtonTitle,
  resolveDirectCopyCandidateUrl,
  resolveEffectiveBatchSaveMode,
  resolveInitialActiveSelection,
  resolveMixedItemDisplayTitle,
  resolveMixedItemTypeBadge,
  resolvePreviewCoverUrl,
  resolvePreviewVideoCandidates,
  resolveSafeLivePhotoResourceUrl,
  resolveZipModeTooltip,
  shouldStreamBatchViaMultiPart,
  summarizeChecklistSelection,
  toggleChecklistItemId,
} from "../sidePanelResultModel";

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
  (
    e: "enqueue-multipart",
    payload: Omit<EnqueueMultiPartItemsRequest, "type">,
  ): void;
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
const targetContext = computed(() => buildExtensionTargetContext(apiOrigin.value));
const copyTargetContext = computed(() => ({ apiOrigin: apiOrigin.value }));
const layoutKind = computed(() => classifyMediaLayout(props.media));

const brokenUrls = ref<Record<string, boolean>>({});
const previewVideoRouteIndex = ref(0);
const activeCollectionIdx = ref(0);
const livePhotoFilter = ref<LivePhotoSaveFilter>("both");
const saveMode = ref<BatchSaveMode>(props.settings.batchSaveMode || "subfolder");
const activeItemId = ref<string>("");
const selectedOptionKeyByItem = ref<Record<string, string>>({});
const checkedIds = ref<Set<string>>(new Set());
const previewModalItem = ref<MediaItem | null>(null);
const previewLiveMode = ref<"motion" | "image">("motion");
const batchPreparingProgress = ref<{ current: number; total: number } | null>(
  null,
);
const copiedDirectLink = ref(false);
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
const copiedOptionKey = ref("");
let copyOptionResetTimer: ReturnType<typeof setTimeout> | null = null;

function markUrlBroken(url: string) {
  brokenUrls.value = markPreviewUrlBroken(brokenUrls.value, url);
}

const collectionsState = computed(() =>
  deriveSidePanelCollections(props.media, activeCollectionIdx.value),
);
const collections = computed(() => collectionsState.value.collections);
const visibleEpisodes = computed(() => collectionsState.value.visibleEpisodes);
const albumItems = computed(() => collectionsState.value.albumItems);
const hasLivePhotos = computed(() => collectionsState.value.hasLivePhotos);

const checklistPool = computed<MediaItem[]>(() =>
  resolveChecklistPool(
    layoutKind.value,
    props.media.items,
    albumItems.value,
    visibleEpisodes.value,
  ),
);

function buildQualityOptionsFor(item: MediaItem): SidePanelQualityOption[] {
  return buildSidePanelQualityOptions(props.media, item, apiOrigin.value);
}

function selectPreferredFor(
  opts: SidePanelQualityOption[],
  item: MediaItem | null | undefined,
  pref = props.settings.qualityPreference,
): SidePanelQualityOption | null {
  return selectPreferredQualityOption(
    opts,
    item,
    pref,
    props.media,
    apiOrigin.value,
  );
}

function resetChecklistToAllChecked() {
  checkedIds.value = buildAllCheckedIdSet(checklistPool.value);
}

function initSelectionForMedia() {
  brokenUrls.value = {};
  previewVideoRouteIndex.value = 0;
  previewModalItem.value = null;
  livePhotoFilter.value = "both";
  saveMode.value = props.settings.batchSaveMode || "subfolder";
  batchPreparingProgress.value = null;

  const initial = resolveInitialActiveSelection(props.media, collections.value);
  activeCollectionIdx.value = initial.activeCollectionIdx;
  activeItemId.value = initial.activeItemId;

  selectedOptionKeyByItem.value = buildPreferredOptionKeyMap({
    items: props.media.items,
    resolveOptions: buildQualityOptionsFor,
    selectPreferred: (opts, item) => selectPreferredFor(opts, item),
  });
  resetChecklistToAllChecked();
}

watch(
  () => buildMediaWorkWatchKey(props.media),
  () => initSelectionForMedia(),
  { immediate: true },
);

watch(
  () => props.settings.qualityPreference,
  (newPref) => {
    selectedOptionKeyByItem.value = buildPreferredOptionKeyMap({
      items: props.media.items,
      resolveOptions: buildQualityOptionsFor,
      selectPreferred: (opts, item) => selectPreferredFor(opts, item, newPref),
      baseMap: selectedOptionKeyByItem.value,
    });
  },
);

watch(
  () => props.settings.batchSaveMode,
  (nextMode) => {
    saveMode.value = nextMode || "subfolder";
  },
);

function selectCollection(index: number) {
  if (activeCollectionIdx.value === index) return;
  activeCollectionIdx.value = index;
  const firstEp = visibleEpisodes.value[0];
  if (firstEp) activeItemId.value = firstEp.id;
  resetChecklistToAllChecked();
}

const activeItem = computed<MediaItem | null>(() =>
  resolveActiveMediaItem(props.media.items, activeItemId.value),
);

const activeQualityOptions = computed<SidePanelQualityOption[]>(() =>
  buildSidePanelQualityOptions(props.media, activeItem.value, apiOrigin.value),
);

const activeSelectedOption = computed<SidePanelQualityOption | null>(() =>
  resolveActiveQualitySelection({
    options: activeQualityOptions.value,
    item: activeItem.value,
    selectedOptionKeyByItem: selectedOptionKeyByItem.value,
    preference: props.settings.qualityPreference,
    fallbackSelect: (opts, item, pref) => selectPreferredFor(opts, item, pref),
  }),
);

function chooseQualityOption(opt: SidePanelQualityOption) {
  if (!activeItem.value || !opt.downloadable) return;
  selectedOptionKeyByItem.value = {
    ...selectedOptionKeyByItem.value,
    [activeItem.value.id]: opt.key,
  };
}

const previewCoverUrl = computed<string>(() =>
  resolvePreviewCoverUrl({
    media: props.media,
    activeItem: activeItem.value,
    activeOption: activeSelectedOption.value,
    ctx: targetContext.value,
    brokenUrls: brokenUrls.value,
  }),
);

const previewVideoCandidates = computed<string[]>(() =>
  resolvePreviewVideoCandidates({
    platform: props.media.platform,
    activeItem: activeItem.value,
    activeOption: activeSelectedOption.value,
    allOptions: activeQualityOptions.value,
    ctx: targetContext.value,
  }),
);

watch(
  [
    () => activeItem.value?.id ?? "",
    () => activeSelectedOption.value?.key ?? "",
    () => previewVideoCandidates.value.join("\n"),
  ],
  () => {
    previewVideoRouteIndex.value = 0;
  },
);

const previewVideoUrl = computed<string>(() =>
  pickActivePreviewVideoUrl(
    previewVideoCandidates.value,
    previewVideoRouteIndex.value,
    brokenUrls.value,
  ),
);

function handlePreviewVideoError(event?: Event) {
  const target = event?.currentTarget as
    | (HTMLVideoElement & { getAttribute?: (name: string) => string | null })
    | null
    | undefined;
  const failedUrl =
    target?.getAttribute?.("src") || target?.src || previewVideoUrl.value;
  const next = advancePreviewVideoRouteOnError({
    failedUrl,
    currentPreviewUrl: previewVideoUrl.value,
    candidates: previewVideoCandidates.value,
    routeIndex: previewVideoRouteIndex.value,
    brokenUrls: brokenUrls.value,
  });
  brokenUrls.value = next.brokenUrls;
  previewVideoRouteIndex.value = next.nextRouteIndex;
}

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
const isDashMuxSelected = computed<boolean>(() =>
  Boolean(activeSelectedOption.value?.isDashMux),
);
const directCopyCandidateUrl = computed<string>(() =>
  resolveDirectCopyCandidateUrl({
    media: props.media,
    activeItem: activeItem.value,
    activeOption: activeSelectedOption.value,
    copyCtx: copyTargetContext.value,
  }),
);
const directCopyButtonTitle = computed<string>(() =>
  resolveDirectCopyButtonTitle(isDashMuxSelected.value),
);

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

async function handleCopyExternalOptionUrl(opt: SidePanelQualityOption) {
  const url = opt.copyUrl || opt.directUrl;
  if (!url) return;
  const ok = await copyTextToClipboard(url);
  if (ok) {
    copiedOptionKey.value = opt.key;
    if (copyOptionResetTimer) clearTimeout(copyOptionResetTimer);
    copyOptionResetTimer = setTimeout(() => {
      if (copiedOptionKey.value === opt.key) copiedOptionKey.value = "";
    }, 1800);
    emit("notify", { message: "直链已复制到剪贴板", tone: "success" });
  } else {
    emit("notify", { message: "复制失败，请手动复制", tone: "error" });
  }
}

function handleSinglePrimaryDownload() {
  const item = activeItem.value;
  if (!item || !readyItem(item)) return;
  if (layoutKind.value === "mixed" && item.type === "live_photo") {
    try {
      const idx = Math.max(0, checklistPool.value.findIndex((c) => c.id === item.id));
      const items = buildChecklistSubfolderEnqueueItems({
        media: props.media,
        entries: [{ item, ordinalIndex: idx + 1 }],
        totalCount: checklistPool.value.length,
        settings: props.settings,
        livePhotoFilter: livePhotoFilter.value,
        workFingerprint: props.workFingerprint,
      });
      if (items.length > 0) emit("enqueue-downloads", { items });
    } catch (err) {
      emit("notify", {
        message: err instanceof Error ? err.message : "构建下载任务失败",
        tone: "error",
      });
    }
    return;
  }
  const opt = activeSelectedOption.value;
  if (!opt || !opt.downloadable) return;
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

function resolveSafeLiveResourceUrl(item: MediaItem, role: "image" | "motion"): string {
  return resolveSafeLivePhotoResourceUrl(item, role, targetContext.value, brokenUrls.value);
}

function mixedItemTypeBadge(item: MediaItem) {
  return resolveMixedItemTypeBadge(item);
}

function mixedItemDisplayTitle(item: MediaItem, idx: number): string {
  return resolveMixedItemDisplayTitle(item, idx, props.media.title);
}

function resolveAlbumThumbUrl(item: MediaItem): string {
  return resolveAlbumThumbnailUrl(item, targetContext.value, brokenUrls.value);
}

function toggleCheckItem(item: MediaItem) {
  checkedIds.value = toggleChecklistItemId(checkedIds.value, item);
}

function selectAllChecklist() {
  resetChecklistToAllChecked();
}

function invertChecklist() {
  checkedIds.value = invertChecklistIdSet(checklistPool.value, checkedIds.value);
}

const checklistSummary = computed(() =>
  summarizeChecklistSelection(checklistPool.value, checkedIds.value),
);
const checkedCount = computed(() => checklistSummary.value.checkedCount);
const checkableTotalCount = computed(
  () => checklistSummary.value.checkableTotalCount,
);

function requestLazyResolvePromise(item: MediaItem): Promise<MediaItem | null> {
  return new Promise((resolve) => {
    emit("request-resolve-item", item, (resolved) => resolve(resolved));
  });
}

async function handleSelectEpisode(item: MediaItem) {
  activeItemId.value = item.id;
  if (item.state === "deferred" && item.resolve_url) {
    const resolved = await requestLazyResolvePromise(item);
    if (resolved && readyItem(resolved)) {
      const preferred = selectPreferredFor(buildQualityOptionsFor(resolved), resolved);
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

const selectedChecklistEntries = computed<ChecklistItemSelectionEntry[]>(() =>
  buildSelectedChecklistEntries(
    checklistPool.value,
    checkedIds.value,
    selectedOptionKeyByItem.value,
    buildQualityOptionsFor,
  ),
);

const batchPrimaryCtaLabel = computed(() =>
  buildBatchPrimaryCtaLabel({
    checkedCount: checkedCount.value,
    checkableTotalCount: checkableTotalCount.value,
    preparing: batchPreparingProgress.value,
  }),
);

const zipPreviewDecision = computed(() => {
  const readyEntries = selectedChecklistEntries.value.filter((e) =>
    readyItem(e.item),
  );
  if (!readyEntries.length) return { ok: true as const, reason: "" };
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

const effectiveSaveMode = computed<BatchSaveMode>(() =>
  resolveEffectiveBatchSaveMode(saveMode.value, zipPreviewDecision.value),
);

const zipModeTooltip = computed<string>(() =>
  resolveZipModeTooltip(layoutKind.value, zipPreviewDecision.value),
);

async function handleBatchPrimaryDownload() {
  if (effectiveSaveMode.value === "zip") {
    await handleBatchZipSave();
  } else {
    await handleBatchSubfolderSave();
  }
}

async function prepareResolvedChecklistEntries(): Promise<
  ChecklistItemSelectionEntry[] | null
> {
  const rawEntries = selectedChecklistEntries.value;
  if (!rawEntries.length) {
    emit("notify", { message: "请至少勾选一项要下载的内容", tone: "info" });
    return null;
  }

  const deferredList = filterDeferredResolvableEntries(rawEntries);
  const resolvedById = new Map<string, MediaItem>();
  if (deferredList.length > 0) {
    batchPreparingProgress.value = { current: 0, total: deferredList.length };
    try {
      for (let i = 0; i < deferredList.length; i++) {
        batchPreparingProgress.value = { current: i + 1, total: deferredList.length };
        const deferredItem = deferredList[i].item;
        const resolved = await requestLazyResolvePromise(deferredItem);
        if (resolved && readyItem(resolved)) {
          resolvedById.set(
            resolved.id,
            preserveOriginalResolveUrl(deferredItem, resolved),
          );
        }
      }
    } finally {
      batchPreparingProgress.value = null;
    }
  }
  return mergeResolvedChecklistEntries(rawEntries, resolvedById);
}

async function handleBatchSubfolderSave() {
  if (batchPreparingProgress.value) return;
  const rawEntries = selectedChecklistEntries.value;
  if (!rawEntries.length) {
    emit("notify", { message: "请至少勾选一项要下载的内容", tone: "info" });
    return;
  }

  if (shouldStreamBatchViaMultiPart(layoutKind.value, rawEntries)) {
    try {
      const req = buildChecklistMultiPartRequest({
        media: props.media, entries: rawEntries, totalCount: checklistPool.value.length,
        settings: props.settings, livePhotoFilter: livePhotoFilter.value, workFingerprint: props.workFingerprint,
      });
      if (!req.items.length) {
        emit("notify", { message: "未生成可下载的文件条目", tone: "error" });
        return;
      }
      emit("enqueue-multipart", req);
    } catch (err) {
      emit("notify", { message: err instanceof Error ? err.message : "构建多P后台下载任务失败", tone: "error" });
    }
    return;
  }

  const prepared = rawEntries.filter((entry) => readyItem(entry.item));
  if (!prepared.length) {
    emit("notify", { message: "所选条目未能完成解析，请重试", tone: "error" });
    return;
  }

  try {
    const items = buildChecklistSubfolderEnqueueItems({
      media: props.media, entries: prepared, totalCount: checklistPool.value.length,
      settings: props.settings, livePhotoFilter: livePhotoFilter.value, workFingerprint: props.workFingerprint,
    });
    if (!items.length) {
      emit("notify", { message: "未生成可下载的文件条目", tone: "error" });
      return;
    }
    emit("enqueue-downloads", { items, groupBatchId: `subfolder-${Date.now()}` });
  } catch (err) {
    emit("notify", { message: err instanceof Error ? err.message : "构建子文件夹下载任务失败", tone: "error" });
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
        :class="{ 'sp-stage--audio': activeItem?.type === 'audio' }"
      >
        <div
          v-if="activeItem?.type === 'audio'"
          class="sp-stage__audio"
          data-testid="audio-preview-stage"
        >
          <img
            v-if="previewCoverUrl"
            :src="previewCoverUrl"
            alt="音频封面预览"
            referrerpolicy="no-referrer"
            class="sp-stage__audio-cover"
            @error="markUrlBroken(previewCoverUrl)"
          />
          <div v-else class="sp-stage__audio-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </div>
          <audio
            v-if="previewVideoUrl"
            :key="previewVideoUrl"
            :src="previewVideoUrl"
            controls
            preload="metadata"
            referrerpolicy="no-referrer"
            class="sp-stage__audio-player"
            @error="handlePreviewVideoError($event)"
          />
          <span v-else class="sp-stage__audio-hint">
            音频流已就绪，可直接后台下载或复制直链
          </span>
        </div>
        <video
          v-else-if="previewVideoUrl"
          :key="previewVideoUrl"
          :src="previewVideoUrl"
          :poster="previewCoverUrl || undefined"
          controls
          preload="metadata"
          playsinline
          referrerpolicy="no-referrer"
          class="sp-stage__video"
          @error="handlePreviewVideoError($event)"
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
            v-if="activeSelectedOption?.muxPair || activeSelectedOption?.isDashMux"
            class="sp-stage__chip sp-stage__chip--mux"
            title="下载时由后台 Offscreen Mediabunny 自动无损合成音视频轨"
          >
            {{ activeSelectedOption?.isDashMux ? "DASH 无损合流" : "下载自动无损合流原声" }}
          </span>
        </div>
      </div>

      <!-- Work Meta Header -->
      <div class="sp-work-meta">
        <div class="sp-work-meta__badges">
          <span v-if="layoutKind === 'album' && albumItems.length > 1" class="sp-badge sp-badge--accent">
            {{ platformBadgeText }} · {{ albumItems.length }} 项图集
          </span>
          <span v-else-if="layoutKind === 'mixed'" class="sp-badge sp-badge--accent">
            {{ platformBadgeText }} · {{ media.items.length }} 项混排
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

      <!-- Primary Single-Work CTA Bar (shown exclusively in Single layout) -->
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
          :title="directCopyButtonTitle"
          @click="handleCopyDirectLink"
        >
          <span>{{ copiedDirectLink ? "已复制" : "复制直链" }}</span>
        </button>
      </div>
    </div>

    <!-- Unified Multi-Item Checklist Card (Album / Multi-Video / Mixed Carousel) -->
    <div v-if="layoutKind !== 'single'" class="sp-panel-card">
      <!-- 3-Way Live Photo Mode Pill Selector (Album & Mixed) -->
      <div v-if="(layoutKind === 'album' || layoutKind === 'mixed') && hasLivePhotos" class="sp-live-bar">
        <span class="sp-live-bar__label">实况保存：</span>
        <div class="sp-live-pills" role="radiogroup" aria-label="实况照片保存模式">
          <button
            v-for="opt in LIVE_PHOTO_FILTER_OPTIONS"
            :key="opt.value"
            type="button"
            class="sp-live-pill"
            :class="{ 'sp-live-pill--on': livePhotoFilter === opt.value }"
            @click="livePhotoFilter = opt.value"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <!-- Pixiv-Style Album / LivePhoto Checklist Grid -->
      <template v-if="layoutKind === 'album'">
        <div class="sp-checklist-hd">
          <div class="sp-checklist-hd__title">
            <span>勾选要保存的条目</span>
            <span class="sp-checklist-hd__count">
              {{ checkedCount }} / {{ checkableTotalCount }}
            </span>
          </div>
          <div class="sp-checklist-hd__btns">
            <button type="button" class="sp-mini-link" @click="selectAllChecklist">全选</button>
            <button type="button" class="sp-mini-link" @click="invertChecklist">反选</button>
          </div>
        </div>

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

            <span class="sp-thumb-cell__idx">{{ String(idx + 1).padStart(2, "0") }}</span>
            <span v-if="item.type === 'live_photo'" class="sp-thumb-cell__live">LIVE</span>
            <span
              class="sp-thumb-cell__check"
              :class="{ 'sp-thumb-cell__check--on': checkedIds.has(item.id) }"
              role="checkbox"
              :aria-checked="checkedIds.has(item.id)"
            >
              <svg v-if="checkedIds.has(item.id)" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
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
      </template>

      <!-- Bilibili Multi-P / Collection Episode Checklist -->
      <template v-else-if="layoutKind === 'multi_video'">
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
            <span class="sp-checklist-hd__count">已选 {{ checkedCount }} / {{ checkableTotalCount }}</span>
          </div>
          <div class="sp-checklist-hd__btns">
            <button type="button" class="sp-mini-link" @click="selectAllChecklist">全选</button>
            <button type="button" class="sp-mini-link" @click="invertChecklist">反选</button>
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
              <svg v-if="checkedIds.has(ep.id)" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
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
              <span class="sp-ep-row__title sp-truncate-1">{{ ep.title || `第 ${idx + 1} 集` }}</span>
              <span v-if="resolvingItemIds.has(ep.id)" class="sp-ep-row__tag sp-ep-row__tag--loading">解析中...</span>
              <span v-else-if="ep.state === 'deferred'" class="sp-ep-row__tag sp-ep-row__tag--lazy" title="点击预览或直接批量下载时自动按需解析">按需解析</span>
              <span v-else-if="ep.state === 'unavailable'" class="sp-ep-row__tag sp-ep-row__tag--err">不可用</span>
              <span v-else-if="ep.duration_ms" class="sp-ep-row__dur">{{ formatDurationMs(ep.duration_ms) }}</span>
            </button>
          </div>
        </div>
      </template>

      <!-- Mixed Image + Video Carousel Checklist (e.g. Instagram Carousels & X Mixed Tweets) -->
      <template v-else-if="layoutKind === 'mixed'">
        <div class="sp-checklist-hd">
          <div class="sp-checklist-hd__title">
            <span>混排条目列表</span>
            <span class="sp-checklist-hd__count">已选 {{ checkedCount }} / {{ checkableTotalCount }}</span>
          </div>
          <div class="sp-checklist-hd__btns">
            <button type="button" class="sp-mini-link" @click="selectAllChecklist">全选</button>
            <button type="button" class="sp-mini-link" @click="invertChecklist">反选</button>
          </div>
        </div>

        <div class="sp-ep-list sp-mixed-list">
          <div
            v-for="(item, idx) in checklistPool"
            :key="item.id"
            class="sp-ep-row sp-mixed-row"
            :class="{
              'sp-ep-row--active': activeItem?.id === item.id,
              'sp-ep-row--disabled': item.state === 'unavailable',
            }"
          >
            <button
              type="button"
              class="sp-ep-row__check"
              :class="{ 'sp-ep-row__check--on': checkedIds.has(item.id) }"
              :disabled="item.state === 'unavailable'"
              role="checkbox"
              :aria-checked="checkedIds.has(item.id)"
              @click.stop="toggleCheckItem(item)"
            >
              <svg v-if="checkedIds.has(item.id)" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
              </svg>
            </button>

            <button
              type="button"
              class="sp-ep-row__body sp-mixed-row__body"
              :disabled="item.state === 'unavailable'"
              @click="handleSelectEpisode(item)"
            >
              <span class="sp-mixed-row__thumb">
                <img
                  v-if="resolveAlbumThumbUrl(item)"
                  :src="resolveAlbumThumbUrl(item)"
                  :alt="`第 ${idx + 1} 项缩略图`"
                  referrerpolicy="no-referrer"
                  loading="lazy"
                  class="sp-mixed-row__thumb-img"
                  @error="markUrlBroken(resolveAlbumThumbUrl(item))"
                />
                <span v-else class="sp-mixed-row__thumb-idx">{{ String(idx + 1).padStart(2, "0") }}</span>
              </span>

              <span class="sp-ep-row__p">{{ String(idx + 1).padStart(2, "0") }}</span>
              <span class="sp-mixed-type" :class="`sp-mixed-type--${mixedItemTypeBadge(item).tone}`">
                {{ mixedItemTypeBadge(item).text }}
              </span>
              <span class="sp-ep-row__title sp-truncate-1">{{ mixedItemDisplayTitle(item, idx) }}</span>

              <span v-if="resolvingItemIds.has(item.id)" class="sp-ep-row__tag sp-ep-row__tag--loading">解析中...</span>
              <span v-else-if="item.state === 'deferred'" class="sp-ep-row__tag sp-ep-row__tag--lazy">按需解析</span>
              <span v-else-if="item.state === 'unavailable'" class="sp-ep-row__tag sp-ep-row__tag--err">不可用</span>
              <span v-else-if="item.duration_ms" class="sp-ep-row__dur">{{ formatDurationMs(item.duration_ms) }}</span>
            </button>
          </div>
        </div>
      </template>

      <!-- Compact Save-Mode Toggle + Unified Primary Download Action -->
      <div class="sp-batch-actions">
        <div class="sp-save-mode-row">
          <div class="sp-save-mode-pills" role="radiogroup" aria-label="批量保存方式">
            <button
              type="button"
              role="radio"
              :aria-checked="effectiveSaveMode === 'subfolder'"
              class="sp-save-mode-pill"
              :class="{ 'sp-save-mode-pill--on': effectiveSaveMode === 'subfolder' }"
              data-save-mode="subfolder"
              title="逐个流式保存到下载目录的标题子文件夹，零 500 MB 内存打包上限"
              @click="saveMode = 'subfolder'"
            >
              存子文件夹
            </button>
            <button
              type="button"
              role="radio"
              :aria-checked="effectiveSaveMode === 'zip'"
              class="sp-save-mode-pill"
              :class="{ 'sp-save-mode-pill--on': effectiveSaveMode === 'zip' }"
              data-save-mode="zip"
              :disabled="!zipPreviewDecision.ok"
              :title="zipModeTooltip"
              @click="saveMode = 'zip'"
            >
              打包 ZIP
            </button>
          </div>

          <button
            type="button"
            class="sp-btn sp-btn--ghost sp-btn--xs sp-save-mode-row__copy"
            :disabled="!directCopyCandidateUrl"
            :title="directCopyButtonTitle"
            @click="handleCopyDirectLink"
          >
            {{ copiedDirectLink ? "已复制" : "复制直链" }}
          </button>
        </div>

        <button
          type="button"
          class="sp-btn sp-btn--primary sp-batch-actions__primary"
          :disabled="checkedCount === 0 || Boolean(batchPreparingProgress)"
          @click="handleBatchPrimaryDownload"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span class="sp-truncate-1">{{ batchPrimaryCtaLabel }}</span>
        </button>
      </div>
    </div>

    <!-- Clickable Quality / Track Variant Cards (for Single Video/Audio/Image, Active Multi-P Episode, or Active Video/Audio Item in Mixed Post) -->
    <div
      v-if="
        layoutKind !== 'album' &&
        (layoutKind !== 'mixed' ||
          activeItem?.type === 'video' ||
          activeItem?.type === 'audio') &&
        activeQualityOptions.length > 0
      "
      class="sp-panel-card"
    >
      <div class="sp-section-hd">
        <span class="sp-section-hd__title">画质与音轨选择</span>
        <span class="sp-section-hd__hint">
          记忆偏好：{{ formatQualityPreferenceLabel(settings.qualityPreference) }}
        </span>
      </div>

      <div class="sp-variant-list">
        <div
          v-for="opt in activeQualityOptions"
          :key="opt.key"
          class="sp-variant-entry"
        >
          <button
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
                <span
                  v-if="opt.deliveryMode === 'native_direct'"
                  class="sp-variant-badge sp-variant-badge--native"
                  data-testid="native-direct-badge"
                  title="非白名单域名直链将由 Chrome 原生下载引擎直接保存"
                >
                  浏览器直下
                </span>
                <span
                  v-else-if="opt.deliveryMode === 'external_only'"
                  class="sp-variant-badge sp-variant-badge--external"
                  data-testid="external-only-badge"
                  :title="opt.externalOnlyReason || '非白名单流媒体，支持复制直链或打开原帖'"
                >
                  需外链 · 非白名单流
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

          <div
            v-if="opt.deliveryMode === 'native_direct'"
            class="sp-native-notice"
            data-testid="native-direct-notice"
          >
            该长尾直链域名不在扩展白名单内，将移交浏览器原生下载器直接保存（扩展不代理请求、不读取响应体、不附加 Cookie）。
          </div>
          <div
            v-else-if="opt.deliveryMode === 'external_only'"
            class="sp-external-fallback"
            data-testid="external-only-fallback"
          >
            <span class="sp-external-fallback__reason">
              {{
                opt.externalOnlyReason ||
                "该长尾流媒体域名不在扩展权限白名单内，支持复制直链或打开原帖"
              }}
            </span>
            <div class="sp-external-fallback__actions">
              <button
                v-if="opt.copyUrl"
                type="button"
                class="sp-btn sp-btn--ghost sp-btn--xs"
                @click="handleCopyExternalOptionUrl(opt)"
              >
                {{ copiedOptionKey === opt.key ? "已复制" : "复制直链" }}
              </button>
              <button
                v-if="media.source_url"
                type="button"
                class="sp-btn sp-btn--secondary sp-btn--xs"
                @click="openSafeHttpTab(media.source_url)"
              >
                打开原帖
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Pure-Client Subtitle Track Panel (VTT / SRT / Bilingual Merge, Whitelist Enforced) -->
    <SidePanelSubtitlePanel
      :media="media"
      :api-origin="apiOrigin"
      :base-title="media.title || activeItem?.title || ''"
      @notify="emit('notify', $event)"
    />

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
              resolveSafeLiveResourceUrl(previewModalItem, 'motion')
            "
            :key="resolveSafeLiveResourceUrl(previewModalItem, 'motion')"
            :src="resolveSafeLiveResourceUrl(previewModalItem, 'motion')"
            :poster="resolveSafeLiveResourceUrl(previewModalItem, 'image') || undefined"
            controls
            autoplay
            loop
            playsinline
            referrerpolicy="no-referrer"
            class="sp-lightbox__media"
            @error="markUrlBroken(resolveSafeLiveResourceUrl(previewModalItem, 'motion'))"
          />
          <img
            v-else-if="resolveAlbumThumbUrl(previewModalItem)"
            :src="resolveAlbumThumbUrl(previewModalItem)"
            alt="预览图"
            referrerpolicy="no-referrer"
            class="sp-lightbox__media"
            @error="markUrlBroken(resolveAlbumThumbUrl(previewModalItem))"
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
  box-shadow: var(--sp-shadow-card);
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
  background: var(--sp-bg-stage);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.sp-stage--audio {
  aspect-ratio: auto;
  min-height: 112px;
  max-height: none;
  padding: 34px 12px 12px;
}

.sp-stage__audio {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.sp-stage__audio-cover {
  width: 68px;
  height: 68px;
  border-radius: var(--sp-radius-md);
  object-fit: cover;
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.sp-stage__audio-icon {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: var(--sp-pink-soft);
  border: 1px solid var(--sp-pink-border);
  color: var(--sp-pink-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.sp-stage__audio-player {
  width: 100%;
  max-width: 100%;
  height: 36px;
}

.sp-stage__audio-hint {
  font-size: 11px;
  color: var(--sp-stage-placeholder-text);
  text-align: center;
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
  color: var(--sp-stage-placeholder-text);
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
  background: var(--sp-ghost-bg);
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
  background: var(--sp-ghost-bg-hover);
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
  background: var(--sp-seg-bg);
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
  background: var(--sp-accent-soft-strong);
  color: var(--sp-accent-text-strong);
  box-shadow: inset 0 0 0 1px var(--sp-border-accent);
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
  color: var(--sp-accent-text);
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
  background: var(--sp-ghost-bg);
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
  background: var(--sp-ghost-bg-hover);
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
  border-color: var(--sp-accent-solid);
  box-shadow: 0 0 0 1px var(--sp-accent-border);
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
  background-color: #6366f1;
  background-image: linear-gradient(135deg, #6366f1, #ec4899);
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
  background: var(--sp-accent-start);
  border-color: var(--sp-accent-solid);
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

/* Batch Action Buttons & Compact Save-Mode Segmented Control */
.sp-batch-actions {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-top: 2px;
}

.sp-save-mode-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.sp-save-mode-pills {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px;
  background: var(--sp-seg-bg);
  padding: 2px;
  border-radius: var(--sp-radius-sm);
  border: 1px solid var(--sp-border);
}

.sp-save-mode-pill {
  border: none;
  border-radius: 6px;
  padding: 4px 6px;
  background: transparent;
  color: var(--sp-text-muted);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 140ms ease;
}

.sp-save-mode-pill:hover:not(:disabled):not(.sp-save-mode-pill--on) {
  color: var(--sp-text-primary);
}

.sp-save-mode-pill--on {
  background: var(--sp-seg-active-bg);
  color: var(--sp-accent-text-strong);
  box-shadow: var(--sp-shadow-xs), inset 0 0 0 1px var(--sp-border-accent);
}

.sp-save-mode-pill:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.sp-save-mode-row__copy {
  flex-shrink: 0;
  padding: 4px 8px;
}

.sp-batch-actions__primary {
  width: 100%;
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
  color: var(--sp-accent-text-strong);
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
  background: var(--sp-accent-soft);
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
  background: var(--sp-accent-start);
  border-color: var(--sp-accent-solid);
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
  color: var(--sp-accent-text);
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
  background: var(--sp-muted-pill-bg);
  color: var(--sp-text-secondary);
}

.sp-ep-row__tag--loading {
  background: var(--sp-accent-soft);
  color: var(--sp-accent-text);
}

.sp-ep-row__tag--err {
  background: var(--sp-danger-soft);
  color: var(--sp-danger-text);
}

/* Mixed Carousel Rows */
.sp-mixed-row__thumb {
  width: 28px;
  height: 28px;
  border-radius: 5px;
  overflow: hidden;
  background: var(--sp-bg-stage);
  border: 1px solid var(--sp-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.sp-mixed-row__thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.sp-mixed-row__thumb-idx {
  font-family: var(--sp-font-mono);
  font-size: 9.5px;
  color: var(--sp-stage-placeholder-text);
}

.sp-mixed-type {
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

.sp-mixed-type--video {
  background: var(--sp-accent-soft);
  color: var(--sp-accent-text-strong);
  border: 1px solid var(--sp-accent-border);
}

.sp-mixed-type--image {
  background: var(--sp-success-soft);
  color: var(--sp-success-text);
  border: 1px solid var(--sp-success-border);
}

.sp-mixed-type--live {
  background-color: #6366f1;
  background-image: linear-gradient(135deg, #6366f1, #ec4899);
  color: #ffffff;
}

.sp-mixed-type--audio {
  background: var(--sp-pink-soft);
  color: var(--sp-pink-text);
  border: 1px solid var(--sp-pink-border);
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
  background: var(--sp-bg-hover);
}

.sp-variant-card--active {
  background: var(--sp-accent-soft);
  border-color: var(--sp-accent-start);
  box-shadow: inset 0 0 0 1px var(--sp-accent-border);
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
  border-color: var(--sp-accent-solid);
  background: radial-gradient(circle, var(--sp-accent-solid) 42%, transparent 46%);
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
  background: var(--sp-accent-soft);
  color: var(--sp-accent-text-strong);
  border: 1px solid var(--sp-accent-border);
}

.sp-variant-badge--audio {
  background: var(--sp-success-soft);
  color: var(--sp-success-text);
}

.sp-variant-badge--track {
  background: var(--sp-pink-soft);
  color: var(--sp-pink-text);
}

.sp-variant-entry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.sp-variant-badge--silent {
  background: var(--sp-warning-soft);
  color: var(--sp-warning-text);
}

.sp-variant-badge--native {
  background: var(--sp-muted-pill-bg);
  color: var(--sp-text-secondary);
  border: 1px solid var(--sp-border);
}

.sp-variant-badge--external {
  background: var(--sp-warning-soft);
  color: var(--sp-warning-text);
  border: 1px solid var(--sp-warning-border);
}

.sp-native-notice {
  padding: 5px 9px;
  border-radius: var(--sp-radius-sm);
  background: var(--sp-muted-pill-bg);
  border: 1px solid var(--sp-border);
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--sp-text-secondary);
}

.sp-external-fallback {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 9px;
  border-radius: var(--sp-radius-sm);
  background: var(--sp-warning-soft);
  border: 1px solid var(--sp-warning-border);
}

.sp-external-fallback__reason {
  flex: 1;
  min-width: 120px;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--sp-warning-text);
}

.sp-external-fallback__actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
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
  background: var(--sp-muted-pill-bg);
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
  background: var(--sp-backdrop-strong);
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
  color: var(--sp-text-primary);
}

.sp-lightbox__close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid var(--sp-border);
  background: var(--sp-ghost-bg);
  color: var(--sp-text-primary);
  cursor: pointer;
}

.sp-lightbox__close:hover {
  background: var(--sp-ghost-bg-hover);
  border-color: var(--sp-border-strong);
}

.sp-lightbox__body {
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--sp-bg-stage);
}

.sp-lightbox__media {
  max-width: 100%;
  max-height: 72vh;
  object-fit: contain;
  border-radius: 6px;
}
</style>
