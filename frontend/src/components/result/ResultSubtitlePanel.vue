<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import AppIcon from "../AppIcon.vue";
import {
  buildSubtitleDownloadResult,
  type SubtitleTrackOption,
} from "../../core/media/subtitleEngine";

const props = withDefaults(
  defineProps<{
    tracks: SubtitleTrackOption[];
    baseTitle?: string;
    locale?: string;
    disabled?: boolean;
    fetchImpl?: typeof fetch;
  }>(),
  {
    baseTitle: "subtitle",
    locale: "zh-CN",
    disabled: false,
    fetchImpl: undefined,
  },
);

const isEn = computed(() => props.locale === "en");
const targetFormat = ref<"vtt" | "srt">("vtt");
const primaryId = ref<string>("");
const secondaryId = ref<string>("");
const busyKey = ref<string>("");
const errorMessage = ref<string>("");
const statusMessage = ref<string>("");
let activeController: AbortController | null = null;

watch(
  () => props.tracks,
  (list) => {
    const safeList = Array.isArray(list) ? list : [];
    if (!safeList.some((track) => track.id === primaryId.value)) {
      primaryId.value = safeList[0]?.id || "";
    }
    if (
      secondaryId.value &&
      (!safeList.some((track) => track.id === secondaryId.value) ||
        secondaryId.value === primaryId.value)
    ) {
      secondaryId.value = "";
    }
    errorMessage.value = "";
    statusMessage.value = "";
  },
  { immediate: true },
);

watch(primaryId, (nextPrimary) => {
  if (secondaryId.value === nextPrimary) {
    secondaryId.value = "";
  }
});

onUnmounted(() => {
  activeController?.abort();
  activeController = null;
});

const primaryTrack = computed(
  () =>
    props.tracks.find((track) => track.id === primaryId.value) ||
    props.tracks[0] ||
    null,
);
const secondaryCandidates = computed(() =>
  props.tracks.filter((track) => track.id !== primaryTrack.value?.id),
);
const secondaryTrack = computed(
  () =>
    secondaryCandidates.value.find((track) => track.id === secondaryId.value) ||
    null,
);
const canMergeBilingual = computed(() => props.tracks.length >= 2);

const trackKindLabel = (kind: SubtitleTrackOption["trackKind"]): string => {
  if (kind === "manual") return isEn.value ? "Manual" : "人工";
  if (kind === "auto") return isEn.value ? "Auto" : "自动";
  return "";
};

const formatTrackOptionLabel = (track: SubtitleTrackOption): string => {
  const kindText = trackKindLabel(track.trackKind);
  const langTag =
    track.language &&
    track.label.toLowerCase() !== track.language.toLowerCase()
      ? ` (${track.language})`
      : "";
  return `${track.label}${langTag}${kindText ? ` · ${kindText}` : ""}`;
};

const triggerBlobDownload = (
  content: string,
  filename: string,
  mimeType: string,
): void => {
  if (
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof document === "undefined"
  ) {
    return;
  }
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body?.appendChild?.(link);
  link.click?.();
  link.remove?.();
  setTimeout(() => {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Ignore revoke errors
    }
  }, 1000);
};

const formatDownloadError = (err: unknown): string => {
  const rec = err as { code?: string; name?: string } | null;
  if (rec?.code === "SUBTITLE_TOO_LARGE") {
    return isEn.value
      ? "Subtitle file exceeds the 5 MiB safety limit and was aborted."
      : "字幕文件超过 5 MiB 安全上限，已中止下载。";
  }
  if (
    rec?.code === "SUBTITLE_FETCH_FAILED" ||
    rec?.code === "SUBTITLE_HTTP_ERROR" ||
    err instanceof TypeError
  ) {
    return isEn.value
      ? "Unable to fetch this subtitle directly in the browser (blocked by CORS or expired link). Refresh or try the DokiTool extension."
      : "无法在网页内直接拉取该字幕（可能受源站跨域 CORS 限制或链接已过期），请刷新解析或改用 DokiTool 扩展重试。";
  }
  return isEn.value
    ? "Failed to process this subtitle track. Please try again."
    : "字幕下载或转换失败，请稍后重试。";
};

const runDownload = async (
  primary: SubtitleTrackOption | null,
  secondary: SubtitleTrackOption | null,
  format: "vtt" | "srt",
  key: string,
): Promise<void> => {
  if (!primary || props.disabled || busyKey.value) return;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  busyKey.value = key;
  errorMessage.value = "";
  statusMessage.value = "";

  try {
    const result = await buildSubtitleDownloadResult({
      primaryTrack: primary,
      secondaryTrack: secondary,
      targetFormat: format,
      baseTitle: props.baseTitle || "subtitle",
      fetchImpl: props.fetchImpl,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    if (result.cueCount === 0) {
      errorMessage.value = isEn.value
        ? "No valid subtitle cues were found in this track."
        : "未能从该字幕轨解析出有效时间轴内容。";
      return;
    }
    triggerBlobDownload(result.content, result.filename, result.mimeType);
    statusMessage.value = isEn.value
      ? `Saved ${result.filename} (${result.cueCount} cues)`
      : `已生成 ${result.filename}（共 ${result.cueCount} 条字幕）`;
  } catch (err: unknown) {
    if ((err as { name?: string } | null)?.name === "AbortError") return;
    errorMessage.value = formatDownloadError(err);
  } finally {
    if (activeController === controller) {
      activeController = null;
    }
    if (busyKey.value === key) {
      busyKey.value = "";
    }
  }
};

const downloadConfigured = () =>
  runDownload(primaryTrack.value, secondaryTrack.value, targetFormat.value, "configured");
</script>

<template>
  <div class="rs-tab-panel rs-sub-panel" data-testid="result-subtitle-panel">
    <div class="rs-sub-head">
      <span class="rs-sub-summary">
        <AppIcon class="fas fa-comment-dots" />
        <span>{{
          isEn
            ? `${tracks.length} subtitle track${tracks.length === 1 ? "" : "s"}`
            : `共 ${tracks.length} 条字幕轨`
        }}</span>
      </span>
      <div class="rs-sub-fmt" role="group" :aria-label="isEn ? 'Output format' : '导出格式'">
        <button
          type="button"
          class="rs-sub-fmt-btn"
          :class="{ 'rs-sub-fmt-btn--on': targetFormat === 'vtt' }"
          @click="targetFormat = 'vtt'"
        >VTT</button>
        <button
          type="button"
          class="rs-sub-fmt-btn"
          :class="{ 'rs-sub-fmt-btn--on': targetFormat === 'srt' }"
          @click="targetFormat = 'srt'"
        >SRT</button>
      </div>
    </div>

    <div v-if="canMergeBilingual" class="rs-sub-merge" data-testid="subtitle-bilingual-box">
      <div class="rs-sub-merge-title">
        <AppIcon class="fas fa-layer-group" />
        <span>{{ isEn ? "Single / Bilingual Export" : "单语 / 双语合并导出" }}</span>
      </div>
      <div class="rs-sub-selects">
        <label class="rs-sub-field">
          <span class="rs-sub-field-label">{{ isEn ? "Primary" : "主字幕" }}</span>
          <select v-model="primaryId" class="rs-sub-select" :disabled="disabled || !!busyKey">
            <option v-for="track in tracks" :key="track.id" :value="track.id">
              {{ formatTrackOptionLabel(track) }}
            </option>
          </select>
        </label>
        <label class="rs-sub-field">
          <span class="rs-sub-field-label">{{ isEn ? "Secondary (optional)" : "副字幕（双语可选）" }}</span>
          <select v-model="secondaryId" class="rs-sub-select" :disabled="disabled || !!busyKey">
            <option value="">{{ isEn ? "None (single language)" : "不合并（单语导出）" }}</option>
            <option v-for="track in secondaryCandidates" :key="track.id" :value="track.id">
              {{ formatTrackOptionLabel(track) }}
            </option>
          </select>
        </label>
      </div>
      <button
        type="button"
        class="rs-sub-primary-btn"
        data-testid="subtitle-primary-download"
        :disabled="disabled || !!busyKey || !primaryTrack"
        @click="downloadConfigured"
      >
        <AppIcon :class="['fas', busyKey === 'configured' ? 'fa-spinner fa-spin' : 'fa-download']" />
        <span>{{
          secondaryTrack
            ? isEn
              ? `Download Bilingual (.${targetFormat})`
              : `下载双语字幕 (.${targetFormat})`
            : isEn
              ? `Download Selected (.${targetFormat})`
              : `下载所选字幕 (.${targetFormat})`
        }}</span>
      </button>
    </div>

    <p v-if="errorMessage" class="rs-sub-alert rs-sub-alert--err" role="alert" data-testid="subtitle-error">
      <AppIcon class="fas fa-exclamation-circle" />
      <span>{{ errorMessage }}</span>
    </p>
    <p v-else-if="statusMessage" class="rs-sub-alert rs-sub-alert--ok" role="status" data-testid="subtitle-status">
      <AppIcon class="fas fa-circle-check" />
      <span>{{ statusMessage }}</span>
    </p>

    <ul class="rs-sub-list">
      <li v-for="track in tracks" :key="track.id" class="rs-sub-item" :data-subtitle-id="track.id">
        <div class="rs-sub-meta">
          <div class="rs-sub-title-row">
            <span class="rs-sub-label">{{ track.label }}</span>
            <span
              v-if="trackKindLabel(track.trackKind)"
              class="rs-sub-badge"
              :class="`rs-sub-badge--${track.trackKind}`"
              :data-track-kind="track.trackKind"
            >{{ trackKindLabel(track.trackKind) }}</span>
          </div>
          <div class="rs-sub-submeta">
            <span v-if="track.language">{{ track.language }}</span>
            <span class="rs-sub-ext">{{ track.format.toUpperCase() }}</span>
          </div>
        </div>
        <div class="rs-sub-actions">
          <button
            type="button"
            class="rs-sub-mini-btn"
            :disabled="disabled || !!busyKey"
            @click="runDownload(track, null, 'vtt', `${track.id}:vtt`)"
          >VTT</button>
          <button
            type="button"
            class="rs-sub-mini-btn"
            :disabled="disabled || !!busyKey"
            @click="runDownload(track, null, 'srt', `${track.id}:srt`)"
          >SRT</button>
        </div>
      </li>
    </ul>

    <p class="rs-sub-footnote">
      {{
        isEn
          ? "Fetched directly in your browser without cookies (5 MiB track cap)."
          : "字幕正文在浏览器本地无 Cookie 直连拉取并转换（单轨上限 5 MiB）。"
      }}
    </p>
  </div>
</template>

<style scoped>
.rs-sub-panel { display: flex; flex-direction: column; gap: 0.75rem; }
.rs-sub-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.rs-sub-summary { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.75rem; font-weight: 600; color: var(--c-fg-2); }
.rs-sub-fmt { display: inline-flex; padding: 2px; border-radius: 0.5rem; background: var(--c-bg-2); border: 1px solid var(--c-border); }
.rs-sub-fmt-btn { border: none; background: transparent; color: var(--c-fg-3); font-size: 0.6875rem; font-weight: 600; padding: 0.2rem 0.55rem; border-radius: 0.375rem; cursor: pointer; font-family: inherit; }
.rs-sub-fmt-btn--on { background: var(--c-accent); color: #fff; }
.rs-sub-merge { display: flex; flex-direction: column; gap: 0.55rem; padding: 0.7rem 0.75rem; border-radius: var(--r-md); background: var(--c-bg-2); border: 1px solid var(--c-border-2); }
.rs-sub-merge-title { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.75rem; font-weight: 600; color: var(--c-fg); }
.rs-sub-selects { display: flex; flex-direction: column; gap: 0.45rem; }
.rs-sub-field { display: flex; flex-direction: column; gap: 0.2rem; }
.rs-sub-field-label { font-size: 0.65rem; font-weight: 600; color: var(--c-fg-3); }
.rs-sub-select { width: 100%; padding: 0.38rem 0.55rem; font-size: 0.75rem; color: var(--c-fg); background: var(--c-bg-elevated); border: 1px solid var(--c-border); border-radius: 0.45rem; font-family: inherit; }
.rs-sub-primary-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; width: 100%; padding: 0.5rem 0.85rem; font-size: 0.75rem; font-weight: 600; border-radius: 0.55rem; border: 1px solid rgba(255, 255, 255, 0.16); cursor: pointer; font-family: inherit; background-color: #4f46e5; background-image: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: #fff; transition: opacity var(--t-fast); }
.rs-sub-primary-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.rs-sub-alert { margin: 0; display: flex; align-items: flex-start; gap: 0.4rem; padding: 0.55rem 0.65rem; border-radius: var(--r-sm); font-size: 0.7rem; line-height: 1.45; }
.rs-sub-alert--err { background: rgba(239, 68, 68, 0.1); color: #b91c1c; border: 1px solid rgba(239, 68, 68, 0.25); }
.rs-sub-alert--ok { background: rgba(16, 185, 129, 0.1); color: #047857; border: 1px solid rgba(16, 185, 129, 0.25); }
:global(.dark) .rs-sub-alert--err { color: #fca5a5; }
:global(.dark) .rs-sub-alert--ok { color: #6ee7b7; }
.rs-sub-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.45rem; }
.rs-sub-item { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.55rem 0.65rem; background: var(--c-bg-2); border: 1px solid var(--c-border-2); border-radius: var(--r-md); }
.rs-sub-meta { min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.rs-sub-title-row { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; }
.rs-sub-label { font-size: 0.75rem; font-weight: 600; color: var(--c-fg); word-break: break-word; }
.rs-sub-badge { font-size: 0.625rem; font-weight: 700; padding: 0.08rem 0.4rem; border-radius: 999px; line-height: 1.3; }
.rs-sub-badge--manual { background: rgba(16, 185, 129, 0.14); color: #047857; border: 1px solid rgba(16, 185, 129, 0.3); }
.rs-sub-badge--auto { background: rgba(245, 158, 11, 0.14); color: #b45309; border: 1px solid rgba(245, 158, 11, 0.3); }
:global(.dark) .rs-sub-badge--manual { color: #6ee7b7; }
:global(.dark) .rs-sub-badge--auto { color: #fcd34d; }
.rs-sub-submeta { display: flex; align-items: center; gap: 0.4rem; font-size: 0.65rem; color: var(--c-fg-3); }
.rs-sub-ext { font-weight: 600; letter-spacing: 0.03em; }
.rs-sub-actions { display: inline-flex; gap: 0.3rem; flex-shrink: 0; }
.rs-sub-mini-btn { padding: 0.28rem 0.5rem; font-size: 0.6875rem; font-weight: 600; border-radius: 0.4rem; border: 1px solid var(--c-border); background: var(--c-bg-elevated); color: var(--c-fg-2); cursor: pointer; font-family: inherit; transition: border-color var(--t-fast), color var(--t-fast); }
.rs-sub-mini-btn:hover:not(:disabled) { border-color: var(--c-accent); color: var(--c-accent); }
.rs-sub-mini-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.rs-sub-footnote { margin: 0; font-size: 0.65rem; line-height: 1.45; color: var(--c-fg-3); }
</style>
