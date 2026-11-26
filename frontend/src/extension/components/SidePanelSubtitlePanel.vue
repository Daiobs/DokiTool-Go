<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import {
  createSubtitleDownloadController,
  type SubtitleControllerState,
} from "../../core/media/subtitleController";
import {
  MAX_SUBTITLE_TRACK_BYTES,
  fetchSubtitleTrackText,
  listSubtitleTracks,
  type SubtitleTrackOption,
} from "../../core/media/subtitleEngine";
import type { UnifiedMedia } from "../../types/media";
import { isWhitelistedMediaUrl } from "../hostWhitelist";
import {
  buildExtraAllowedOrigins,
  copyTextToClipboard,
  openSafeHttpTab,
} from "../uiTargetHelpers";

const props = withDefaults(
  defineProps<{
    media: UnifiedMedia;
    apiOrigin: string;
    baseTitle?: string;
    extraAllowedOrigins?: string[];
    fetchImpl?: typeof fetch;
  }>(),
  { baseTitle: "", extraAllowedOrigins: undefined, fetchImpl: undefined },
);

const emit = defineEmits<{
  (e: "notify", payload: { message: string; tone?: "success" | "error" | "info" }): void;
}>();

const copiedTrackId = ref("");
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

const tracks = computed<SubtitleTrackOption[]>(() => listSubtitleTracks(props.media, props.apiOrigin));
const effectiveAllowedOrigins = computed<string[] | undefined>(() =>
  props.extraAllowedOrigins !== undefined
    ? props.extraAllowedOrigins
    : buildExtraAllowedOrigins(props.apiOrigin),
);

const whitelistedRoutesFor = (track: SubtitleTrackOption): string[] =>
  track.routes.filter((route) => isWhitelistedMediaUrl(route, effectiveAllowedOrigins.value).allowed);
const isTrackWhitelisted = (track: SubtitleTrackOption): boolean =>
  whitelistedRoutesFor(track).length > 0;

const whitelistedTracks = computed<SubtitleTrackOption[]>(() => tracks.value.filter(isTrackWhitelisted));
const hasNonWhitelistedTracks = computed(() => tracks.value.some((t) => !isTrackWhitelisted(t)));
const resolvedBaseTitle = computed(() => props.baseTitle?.trim() || props.media.title?.trim() || "subtitle");

function formatSubtitleError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === "SUBTITLE_UNWHITELISTED") {
    return "该字幕域名不在扩展安全白名单内，扩展不直连拉取；可复制直链或由浏览器新标签打开保存。";
  }
  if (code === "SUBTITLE_TOO_LARGE") {
    return "字幕文件超过 5 MiB 安全上限，已中止下载。";
  }
  if (code === "SUBTITLE_FETCH_FAILED" || code === "SUBTITLE_HTTP_ERROR" || err instanceof TypeError) {
    return "字幕拉取失败（链接可能已过期或被源站拦截），请点击刷新重新解析后再试。";
  }
  return "字幕下载或转换失败，请稍后重试。";
}

const controllerState = ref<SubtitleControllerState | null>(null);
const controller = createSubtitleDownloadController({
  getBaseTitle: () => resolvedBaseTitle.value,
  maxBytes: MAX_SUBTITLE_TRACK_BYTES,
  validateBeforeDownload: (primary, secondary) => {
    if (whitelistedRoutesFor(primary).length === 0 || (secondary && whitelistedRoutesFor(secondary).length === 0)) {
      throw Object.assign(new Error("Subtitle host not whitelisted"), { code: "SUBTITLE_UNWHITELISTED" });
    }
  },
  fetchTrackText: async (track, signal) => {
    const allowed = whitelistedRoutesFor(track);
    if (!allowed.length) {
      throw Object.assign(new Error("Subtitle host not whitelisted"), { code: "SUBTITLE_UNWHITELISTED" });
    }
    return fetchSubtitleTrackText(allowed[0], {
      fetchImpl: props.fetchImpl,
      signal,
      maxBytes: MAX_SUBTITLE_TRACK_BYTES,
      routes: allowed,
    });
  },
  formatError: formatSubtitleError,
  formatEmptyCuesError: () => "未能从该字幕轨解析出有效时间轴内容。",
  formatSuccessStatus: (result) => `已保存 ${result.filename}（共 ${result.cueCount} 条字幕）`,
  onSuccess: (result) => {
    emit("notify", { message: `已保存字幕：${result.filename}`, tone: "success" });
  },
  onStateChange: (next) => {
    controllerState.value = next;
  },
});
controllerState.value = controller.getState();

watch(
  whitelistedTracks,
  (list) => controller.syncTracks(list),
  { immediate: true },
);

onUnmounted(() => {
  controller.dispose();
  if (copyResetTimer) {
    clearTimeout(copyResetTimer);
    copyResetTimer = null;
  }
});

const snap = computed(() => controllerState.value ?? controller.getState());
const targetFormat = computed({
  get: () => snap.value.targetFormat,
  set: (v) => controller.setTargetFormat(v),
});
const primaryId = computed({
  get: () => snap.value.primaryId,
  set: (v) => controller.setPrimaryId(v),
});
const secondaryId = computed({
  get: () => snap.value.secondaryId,
  set: (v) => controller.setSecondaryId(v),
});
const canMergeBilingual = computed(() => snap.value.canMergeBilingual);
const primaryTrack = computed(() => snap.value.primaryTrack);
const secondaryCandidates = computed(() => snap.value.secondaryCandidates);
const secondaryTrack = computed(() => snap.value.secondaryTrack);
const busyKey = computed(() => snap.value.busyKey);
const errorMessage = computed(() => snap.value.errorMessage);
const statusMessage = computed(() => snap.value.statusMessage);
const runDownload = controller.runDownload;

const trackKindLabel = (kind: SubtitleTrackOption["trackKind"]): string =>
  kind === "manual" ? "人工" : kind === "auto" ? "自动" : "";

const formatOptionLabel = (track: SubtitleTrackOption): string => {
  const kind = trackKindLabel(track.trackKind);
  const lang = track.language && track.label.toLowerCase() !== track.language.toLowerCase() ? ` (${track.language})` : "";
  return `${track.label}${lang}${kind ? ` · ${kind}` : ""}`;
};

async function handleCopyTrackUrl(track: SubtitleTrackOption): Promise<void> {
  if (!track.url) return;
  const ok = await copyTextToClipboard(track.url);
  if (ok) {
    copiedTrackId.value = track.id;
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      if (copiedTrackId.value === track.id) copiedTrackId.value = "";
    }, 1800);
    emit("notify", { message: "字幕直链已复制到剪贴板", tone: "success" });
  } else {
    emit("notify", { message: "复制失败，请手动复制", tone: "error" });
  }
}
</script>

<template>
  <div v-if="tracks.length > 0" class="sp-panel-card sp-sub" data-testid="sidepanel-subtitle-panel">
    <div class="sp-sub__hd">
      <div class="sp-sub__hd-left">
        <span class="sp-sub__title">字幕下载</span>
        <span class="sp-sub__count">{{ tracks.length }} 轨</span>
      </div>
      <div class="sp-sub__fmt" role="group" aria-label="字幕导出格式">
        <button type="button" class="sp-sub__fmt-btn" :class="{ 'sp-sub__fmt-btn--on': targetFormat === 'vtt' }" @click="targetFormat = 'vtt'">VTT</button>
        <button type="button" class="sp-sub__fmt-btn" :class="{ 'sp-sub__fmt-btn--on': targetFormat === 'srt' }" @click="targetFormat = 'srt'">SRT</button>
      </div>
    </div>

    <div v-if="canMergeBilingual" class="sp-sub__merge" data-testid="sidepanel-subtitle-bilingual">
      <label class="sp-sub__field">
        <span class="sp-sub__field-lbl">主字幕</span>
        <select v-model="primaryId" class="sp-sub__select" :disabled="!!busyKey">
          <option v-for="t in whitelistedTracks" :key="t.id" :value="t.id">{{ formatOptionLabel(t) }}</option>
        </select>
      </label>
      <label class="sp-sub__field">
        <span class="sp-sub__field-lbl">副字幕（双语可选）</span>
        <select v-model="secondaryId" class="sp-sub__select" :disabled="!!busyKey">
          <option value="">不合并（单语导出）</option>
          <option v-for="t in secondaryCandidates" :key="t.id" :value="t.id">{{ formatOptionLabel(t) }}</option>
        </select>
      </label>
      <button
        type="button"
        class="sp-btn sp-btn--primary sp-btn--sm sp-sub__merge-btn"
        data-testid="sidepanel-subtitle-primary-download"
        :disabled="!!busyKey || !primaryTrack"
        @click="runDownload(primaryTrack, secondaryTrack, targetFormat, 'configured')"
      >
        {{ busyKey === "configured" ? "正在生成字幕..." : secondaryTrack ? `下载双语字幕 (.${targetFormat})` : `下载所选字幕 (.${targetFormat})` }}
      </button>
    </div>

    <p v-if="hasNonWhitelistedTracks" class="sp-sub__notice" data-testid="subtitle-nonwhitelisted-notice">
      部分长尾字幕域名不在扩展安全白名单内，扩展不直连拉取；可复制直链或由浏览器新标签打开保存。
    </p>

    <p v-if="errorMessage" class="sp-sub__alert sp-sub__alert--err" role="alert" data-testid="sidepanel-subtitle-error">{{ errorMessage }}</p>
    <p v-else-if="statusMessage" class="sp-sub__alert sp-sub__alert--ok" role="status" data-testid="sidepanel-subtitle-status">{{ statusMessage }}</p>

    <ul class="sp-sub__list">
      <li v-for="track in tracks" :key="track.id" class="sp-sub__row" :data-subtitle-id="track.id">
        <div class="sp-sub__meta">
          <div class="sp-sub__name-row">
            <span class="sp-sub__label sp-truncate-1" :title="track.label">{{ track.label }}</span>
            <span
              v-if="trackKindLabel(track.trackKind)"
              class="sp-sub__kind"
              :class="`sp-sub__kind--${track.trackKind}`"
              :data-track-kind="track.trackKind"
            >{{ trackKindLabel(track.trackKind) }}</span>
            <span v-if="!isTrackWhitelisted(track)" class="sp-sub__kind sp-sub__kind--ext" data-testid="subtitle-nonwhitelisted-badge">非白名单</span>
          </div>
          <div class="sp-sub__submeta">
            <span v-if="track.language">{{ track.language }}</span>
            <span>{{ track.format.toUpperCase() }}</span>
          </div>
        </div>

        <div v-if="isTrackWhitelisted(track)" class="sp-sub__actions">
          <button type="button" class="sp-btn sp-btn--ghost sp-btn--xs" :disabled="!!busyKey" @click="runDownload(track, null, 'vtt', `${track.id}:vtt`)">VTT</button>
          <button type="button" class="sp-btn sp-btn--ghost sp-btn--xs" :disabled="!!busyKey" @click="runDownload(track, null, 'srt', `${track.id}:srt`)">SRT</button>
        </div>
        <div v-else class="sp-sub__actions">
          <button type="button" class="sp-btn sp-btn--ghost sp-btn--xs" @click="handleCopyTrackUrl(track)">{{ copiedTrackId === track.id ? "已复制" : "复制直链" }}</button>
          <button type="button" class="sp-btn sp-btn--secondary sp-btn--xs" @click="openSafeHttpTab(track.url)">打开</button>
        </div>
      </li>
    </ul>

    <p class="sp-sub__foot">纯客户端无 Cookie 直连白名单即时转换保存（单轨上限 5 MiB，导出期间请保持侧边栏开启）。</p>
  </div>
</template>

<style scoped>
.sp-sub { gap: 7px; }
.sp-sub__hd { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.sp-sub__hd-left { display: inline-flex; align-items: center; gap: 6px; }
.sp-sub__title { font-size: 12px; font-weight: 600; color: var(--sp-text-secondary); }
.sp-sub__count { font-family: var(--sp-font-mono); font-size: 10.5px; color: var(--sp-accent-text); background: var(--sp-accent-soft); padding: 1px 6px; border-radius: 999px; }
.sp-sub__fmt { display: inline-flex; padding: 2px; border-radius: var(--sp-radius-xs); background: var(--sp-seg-bg); border: 1px solid var(--sp-border); gap: 2px; }
.sp-sub__fmt-btn { border: none; background: transparent; color: var(--sp-text-muted); font-family: inherit; font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 4px; cursor: pointer; }
.sp-sub__fmt-btn--on { background: var(--sp-seg-active-bg); color: var(--sp-accent-text-strong); box-shadow: inset 0 0 0 1px var(--sp-border-accent); }
.sp-sub__merge { display: flex; flex-direction: column; gap: 6px; padding: 7px 8px; border-radius: var(--sp-radius-sm); background: var(--sp-bg-base); border: 1px solid var(--sp-border); }
.sp-sub__field { display: flex; flex-direction: column; gap: 2px; }
.sp-sub__field-lbl { font-size: 10px; font-weight: 600; color: var(--sp-text-muted); }
.sp-sub__select { width: 100%; padding: 5px 7px; border-radius: var(--sp-radius-xs); border: 1px solid var(--sp-border-strong); background: var(--sp-bg-surface); color: var(--sp-text-primary); font-family: inherit; font-size: 11.5px; }
.sp-sub__merge-btn { width: 100%; }
.sp-sub__notice { margin: 0; padding: 6px 8px; border-radius: var(--sp-radius-xs); background: var(--sp-warning-soft); border: 1px solid var(--sp-warning-border); color: var(--sp-warning-text); font-size: 10.5px; line-height: 1.4; }
.sp-sub__alert { margin: 0; padding: 6px 8px; border-radius: var(--sp-radius-xs); font-size: 11px; line-height: 1.4; word-break: break-word; }
.sp-sub__alert--err { background: var(--sp-danger-soft); border: 1px solid var(--sp-danger-border); color: var(--sp-danger-text); }
.sp-sub__alert--ok { background: var(--sp-success-soft); border: 1px solid var(--sp-success-border); color: var(--sp-success-text); }
.sp-sub__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; max-height: 185px; overflow-y: auto; }
.sp-sub__row { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 7px; border-radius: var(--sp-radius-sm); background: var(--sp-bg-base); border: 1px solid var(--sp-border); min-width: 0; }
.sp-sub__meta { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sp-sub__name-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
.sp-sub__label { font-size: 11.5px; font-weight: 600; color: var(--sp-text-primary); }
.sp-sub__kind { font-size: 9.5px; font-weight: 700; padding: 1px 5px; border-radius: 999px; flex-shrink: 0; }
.sp-sub__kind--manual { background: var(--sp-success-soft); color: var(--sp-success-text); border: 1px solid var(--sp-success-border); }
.sp-sub__kind--auto { background: var(--sp-warning-soft); color: var(--sp-warning-text); border: 1px solid var(--sp-warning-border); }
.sp-sub__kind--ext { background: var(--sp-muted-pill-bg); color: var(--sp-text-secondary); border: 1px solid var(--sp-border); }
.sp-sub__submeta { display: flex; align-items: center; gap: 6px; font-size: 10px; font-family: var(--sp-font-mono); color: var(--sp-text-muted); }
.sp-sub__actions { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
.sp-sub__foot { margin: 0; font-size: 10px; line-height: 1.4; color: var(--sp-text-muted); }
</style>
