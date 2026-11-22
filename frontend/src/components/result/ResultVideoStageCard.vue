<script setup>
import AppIcon from "../AppIcon.vue";
import VideoPlaylist from "../VideoPlaylist.vue";
import { t, formatBilibiliDashTitle } from "./resultI18n";

defineProps({
  hasVideo: Boolean,
  isMulti: Boolean,
  alignDetails: Boolean,
  locale: String,
  platform: String,
  currentItem: Object,
  activeVariant: Object,
  activeVideoUrl: String,
  playerKey: String,
  mainPosterUrl: String,
  playerQualityTagText: String,
  primaryDownloadLabel: String,
  isResolving: Boolean,
  targetMessage: String,
  downloadableCount: { type: Number, default: 0 },
  isYouTubeHelperInstallRequired: Boolean,
  ytHelperModalDismissed: Boolean,
  needsQualitySelection: Boolean,
  isActiveYouTubeSplitVideo: Boolean,
  isActiveYouTubeAudioOnly: Boolean,
  isYouTubeHelperBlocked: Boolean,
  isTargetBlocked: Boolean,
  selectedCount: { type: Number, default: 0 },
  batchZipAvailable: Boolean,
  visibleVideos: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: 0 },
  selectedSet: Object,
  selectedTotal: { type: Number, default: 0 },
  collections: { type: Array, default: () => [] },
  activeCollection: { type: Number, default: 0 },
  resolvingIds: Object,
  selection: Object,
  bilibiliDashSummary: { type: Object, default: null },
});

const emit = defineEmits([
  "playback-error",
  "playback-loaded",
  "mark-image-broken",
  "open-quality-picker",
  "open-yt-helper-modal",
  "open-extension",
  "refresh-item",
  "primary-download",
  "download-selected",
  "download-all-videos",
  "download-selected-zip",
  "copy-url",
  "select-video",
  "toggle-video",
  "select-all-videos",
  "clear-selection",
  "select-collection",
]);

const EXT_ICON_PATH =
  "M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 2c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z";
</script>

<template>
  <div
    v-if="hasVideo"
    class="rs-card rs-card--video"
    :class="{ 'rs-card--align-details': alignDetails }"
  >
    <div class="rs-card-hd">
      <div class="rs-card-hd-left">
        <AppIcon class="fas fa-play-circle rs-card-icon" /><span>{{
          t(locale, "videoSource")
        }}</span>
      </div>
      <span v-if="activeVariant" class="rs-quality-tag">{{
        playerQualityTagText
      }}</span>
    </div>
    <div class="rs-video-stage">
      <audio
        v-if="currentItem.type === 'audio' && activeVideoUrl"
        :key="playerKey"
        :data-playback-key="playerKey"
        :src="activeVideoUrl"
        :preload="platform === 'youtube' ? 'none' : undefined"
        controls
        class="rs-music-player"
        @error="emit('playback-error', $event)"
        @loadeddata="emit('playback-loaded', $event)"
      />
      <video
        v-else
        :key="playerKey"
        :data-playback-key="playerKey"
        :src="activeVideoUrl || undefined"
        :preload="platform === 'youtube' ? 'none' : undefined"
        controls
        referrerpolicy="no-referrer"
        class="rs-video"
        :poster="mainPosterUrl || undefined"
        @error="emit('playback-error', $event)"
        @loadeddata="emit('playback-loaded', $event)"
      >
        <track kind="captions" :src="undefined" />
      </video>
      <img
        v-if="mainPosterUrl"
        :src="mainPosterUrl"
        referrerpolicy="no-referrer"
        hidden
        alt=""
        class="rs-poster-probe"
        @error="emit('mark-image-broken', mainPosterUrl)"
      />
      <div v-if="isResolving || !activeVideoUrl" class="rs-stage-overlay">
        <div v-if="isResolving" class="rs-stage-spinner"></div>
        <span>{{ isResolving ? t(locale, "resolving") : targetMessage }}</span
        ><button
          v-if="downloadableCount > 0 && !activeVariant && !isResolving"
          class="rs-btn rs-btn--ghost"
          @click="emit('open-quality-picker')"
        >
          {{ t(locale, "selectQuality") }}</button
        ><button
          v-if="
            isYouTubeHelperInstallRequired &&
            ytHelperModalDismissed &&
            !isResolving
          "
          type="button"
          data-yt-helper-reopen
          class="rs-btn rs-btn--ghost"
          @click="emit('open-yt-helper-modal')"
        >
          {{ locale === "en" ? "Install Helper" : "查看安装说明" }}</button
        ><button
          v-if="currentItem.resolve_url && !isResolving"
          class="rs-btn rs-btn--ghost"
          @click="emit('refresh-item', currentItem)"
        >
          {{ locale === "en" ? "Refresh item" : "刷新此条目" }}
        </button>
      </div>
    </div>
    <div class="rs-card-actions">
      <button
        @click="emit('primary-download')"
        class="rs-btn rs-btn--primary"
        :data-select-quality-first="needsQualitySelection || undefined"
        :data-youtube-mux-save="isActiveYouTubeSplitVideo || undefined"
        :data-youtube-audio-only-save="isActiveYouTubeAudioOnly || undefined"
        :disabled="
          isYouTubeHelperBlocked ||
          isResolving ||
          (isTargetBlocked && !needsQualitySelection)
        "
      >
        <AppIcon
          :class="[
            'fas',
            needsQualitySelection ? 'fa-layer-group' : 'fa-download',
          ]"
        /><span>{{ primaryDownloadLabel }}</span>
      </button>
      <button
        v-if="isMulti"
        @click="
          selectedCount
            ? emit('download-selected')
            : emit('download-all-videos')
        "
        class="rs-btn rs-btn--accent"
      >
        <AppIcon class="fas fa-layer-group" /><span>{{
          selectedCount
            ? t(locale, "downloadSelected") + "（" + selectedCount + "）"
            : t(locale, "downloadAllVideos")
        }}</span>
      </button>
      <button
        v-if="isMulti && batchZipAvailable"
        @click="
          emit(
            'download-selected-zip',
            selectedCount ? selection.getBatchVideos() : selection.list.value,
          )
        "
        class="rs-btn rs-btn--ghost"
      >
        <AppIcon class="fas fa-file-archive" />{{
          t(locale, "downloadAllZip")
        }}
      </button>
      <button
        @click="emit('copy-url', activeVideoUrl)"
        class="rs-btn rs-btn--ghost-light"
        :disabled="!activeVideoUrl"
      >
        <AppIcon class="fas fa-copy" /><span>{{
          t(locale, "copyVideo")
        }}</span>
      </button>
    </div>
    <div
      v-if="bilibiliDashSummary"
      class="rs-bili-dash-callout"
      data-bilibili-dash-callout
      role="region"
      :aria-label="formatBilibiliDashTitle(bilibiliDashSummary, locale)"
    >
      <div class="rs-bili-dash-body">
        <div class="rs-bili-dash-head">
          <span class="rs-bili-dash-title">
            <AppIcon class="fas fa-bolt rs-bili-dash-bolt" />
            <span>{{
              formatBilibiliDashTitle(bilibiliDashSummary, locale)
            }}</span>
          </span>
          <div class="rs-bili-dash-specs">
            <span
              v-if="bilibiliDashSummary.maxResolution"
              class="rs-bili-dash-pill rs-bili-dash-pill--res"
            >
              {{
                t(locale, "biliDashUpTo").replace(
                  "{res}",
                  bilibiliDashSummary.maxResolution,
                )
              }}
            </span>
            <span
              v-if="bilibiliDashSummary.videoCodecs.length"
              class="rs-bili-dash-pill"
            >
              {{ bilibiliDashSummary.videoCodecs.join(" / ") }}
            </span>
            <span
              v-if="bilibiliDashSummary.audioCodec"
              class="rs-bili-dash-pill"
            >
              + {{ bilibiliDashSummary.audioCodec }}
            </span>
          </div>
        </div>
        <p class="rs-bili-dash-desc">{{ t(locale, "biliDashHint") }}</p>
      </div>
      <button
        type="button"
        class="rs-btn rs-bili-dash-cta"
        data-bilibili-dash-extension-cta
        @click="emit('open-extension')"
      >
        <svg
          class="rs-bili-dash-ext-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path :d="EXT_ICON_PATH" />
        </svg>
        <span>{{ t(locale, "biliDashCta") }}</span>
      </button>
    </div>
  </div>

  <div v-if="isMulti" class="rs-card rs-card--playlist">
    <div class="rs-card-hd">
      <div class="rs-card-hd-left">
        <AppIcon class="fas fa-list rs-card-icon" /><span
          >{{ t(locale, "episodes") }}（{{ visibleVideos.length }}）</span
        >
      </div>
    </div>
    <div class="rs-playlist">
      <VideoPlaylist
        :videos="visibleVideos"
        :current-index="currentIndex"
        :selected-set="selectedSet"
        :total="selectedTotal"
        :collections="collections"
        :active-collection="activeCollection"
        :resolving-ids="resolvingIds"
        @select="emit('select-video', $event)"
        @toggle="emit('toggle-video', $event)"
        @select-all="emit('select-all-videos')"
        @clear-selection="emit('clear-selection')"
        @select-collection="emit('select-collection', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.rs-card {
  background: var(--c-bg-elevated);
  border: 1px solid var(--c-border);
  border-radius: var(--r-xl);
  box-shadow: var(--sh-md);
  overflow: hidden;
  transition: all var(--t-base);
  position: relative;
}
.rs-card::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(108, 92, 231, 0.4) 20%,
    rgba(168, 85, 247, 0.3) 50%,
    rgba(236, 72, 153, 0.3) 80%,
    transparent 100%
  );
  opacity: 0;
  transition: opacity var(--t-base);
}
.rs-card:hover {
  box-shadow: var(--sh-xl);
  transform: translateY(-2px);
}
.rs-card:hover::before {
  opacity: 1;
}
.rs-card--video {
  background: linear-gradient(var(--c-bg-elevated), var(--c-bg-elevated))
      padding-box,
    linear-gradient(135deg, var(--c-accent), var(--c-accent-2), var(--c-accent-3))
      border-box;
  border: 1.5px solid transparent;
}
.rs-card--video::before {
  opacity: 0;
}
.rs-card--video:hover {
  transform: translateY(-2px);
  box-shadow: 0 18px 50px -22px rgba(108, 92, 231, 0.5);
}
.rs-card--playlist {
  animation: rsFadeIn 0.35s ease;
}

.rs-card-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.875rem 1.125rem;
  background: var(--c-bg-2);
  border-bottom: 1px solid var(--c-border);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--c-fg-2);
}
.rs-card-hd-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.rs-card-icon {
  font-size: 0.875rem;
  color: var(--c-accent);
}
.rs-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: center;
  padding: 0.875rem 1.125rem;
  border-top: 1px solid var(--c-border-2);
}
.rs-quality-tag {
  font-size: 0.6875rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  background: rgba(108, 92, 231, 0.08);
  color: var(--c-accent);
  font-weight: 600;
}

.rs-video-stage {
  background: #0a0a14;
  position: relative;
}
.rs-stage-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  color: rgba(255, 255, 255, 0.9);
  font-size: 0.875rem;
  background: rgba(10, 10, 20, 0.62);
  backdrop-filter: blur(2px);
}
.rs-stage-spinner {
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.25);
  border-top-color: var(--color-primary, #6366f1);
  animation: rs-spin 0.8s linear infinite;
}
@keyframes rs-spin {
  to {
    transform: rotate(360deg);
  }
}
.rs-playlist {
  padding: 1rem 1.125rem;
}
.rs-video {
  display: block;
  width: 100%;
  max-height: 520px;
  object-fit: contain;
  background: #000;
}
.rs-music-player {
  width: 100%;
  height: 2.25rem;
  border-radius: 999px;
}
@media (max-width: 640px) {
  .rs-video {
    max-height: 260px;
  }
}
@media (min-width: 641px) and (max-width: 1039px) {
  .rs-video {
    max-height: 400px;
  }
}
@media (min-width: 1040px) {
  .rs-card--video.rs-card--align-details {
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  .rs-card--align-details .rs-video-stage {
    flex: 1;
    min-height: 0;
  }
  .rs-card--align-details .rs-video {
    position: absolute;
    inset: 0;
    height: 100%;
    max-height: none;
  }
}

.rs-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.65rem 1.25rem;
  font-size: 0.7875rem;
  font-weight: 600;
  border-radius: var(--r-lg);
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: all var(--t-base);
  white-space: nowrap;
  line-height: 1.4;
  position: relative;
  overflow: hidden;
}
.rs-btn::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, transparent 50%);
  opacity: 0;
  transition: opacity var(--t-base);
}
.rs-btn:hover::before {
  opacity: 1;
}
.rs-btn:active {
  transform: scale(0.96);
}
.rs-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}
.rs-btn--primary {
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
  color: #fff;
  box-shadow: 0 4px 16px rgba(108, 92, 231, 0.35), 0 1px 3px rgba(0, 0, 0, 0.1);
}
.rs-btn--primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 28px rgba(108, 92, 231, 0.45),
    0 2px 6px rgba(0, 0, 0, 0.12);
}
.rs-btn--accent {
  background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
  color: #fff;
  box-shadow: 0 4px 16px rgba(168, 85, 247, 0.35), 0 1px 3px rgba(0, 0, 0, 0.1);
}
.rs-btn--accent:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 28px rgba(168, 85, 247, 0.45),
    0 2px 6px rgba(0, 0, 0, 0.12);
}
.rs-btn--ghost {
  background: var(--c-bg-3);
  color: var(--c-fg-2);
  border: 1px solid var(--c-border);
}
.rs-btn--ghost:hover {
  background: var(--c-bg-2);
  border-color: var(--c-accent);
  color: var(--c-fg);
  transform: translateY(-1px);
}
.rs-btn--ghost-light {
  background: var(--c-bg-2);
  color: var(--c-fg-2);
  border: 1px solid var(--c-border);
}
.rs-btn--ghost-light:hover {
  background: var(--c-bg-3);
  border-color: var(--c-accent);
  color: var(--c-fg);
  transform: translateY(-1px);
}

.rs-bili-dash-callout {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 1rem;
  padding: 0.8rem 1.125rem;
  flex-shrink: 0;
  border-top: 1px solid rgba(99, 102, 241, 0.2);
  background: linear-gradient(
    135deg,
    rgba(99, 102, 241, 0.08) 0%,
    rgba(168, 85, 247, 0.06) 100%
  );
}
:global(.dark) .rs-bili-dash-callout {
  border-top-color: rgba(129, 140, 248, 0.28);
  background: linear-gradient(
    135deg,
    rgba(99, 102, 241, 0.16) 0%,
    rgba(168, 85, 247, 0.12) 100%
  );
}
.rs-bili-dash-body {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.rs-bili-dash-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 0.55rem;
}
.rs-bili-dash-title {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--c-fg);
}
.rs-bili-dash-bolt {
  font-size: 0.75rem;
  color: var(--c-accent);
}
.rs-bili-dash-specs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}
.rs-bili-dash-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.12rem 0.45rem;
  border-radius: 999px;
  font-size: 0.65rem;
  font-weight: 600;
  line-height: 1.35;
  color: #4338ca;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.22);
}
.rs-bili-dash-pill--res {
  font-weight: 700;
  color: #3730a3;
  background: rgba(99, 102, 241, 0.16);
  border-color: rgba(99, 102, 241, 0.32);
}
:global(.dark) .rs-bili-dash-pill {
  color: #c7d2fe;
  background: rgba(129, 140, 248, 0.16);
  border-color: rgba(129, 140, 248, 0.3);
}
:global(.dark) .rs-bili-dash-pill--res {
  color: #e0e7ff;
  background: rgba(129, 140, 248, 0.24);
  border-color: rgba(165, 180, 252, 0.38);
}
.rs-bili-dash-desc {
  margin: 0;
  font-size: 0.72rem;
  line-height: 1.45;
  color: var(--c-fg-2);
}
.rs-bili-dash-cta {
  flex-shrink: 0;
  padding: 0.55rem 0.95rem;
  font-size: 0.75rem;
  background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
  color: #fff;
  box-shadow: 0 4px 14px rgba(79, 70, 229, 0.3);
}
.rs-bili-dash-cta:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(79, 70, 229, 0.42);
}
.rs-bili-dash-cta:focus-visible {
  outline: 2px solid var(--c-accent);
  outline-offset: 2px;
}
.rs-bili-dash-ext-icon {
  width: 0.9rem;
  height: 0.9rem;
  flex-shrink: 0;
}
@media (max-width: 768px) {
  .rs-bili-dash-callout {
    flex-direction: column;
    align-items: stretch;
    padding: 0.75rem 0.875rem;
  }
  .rs-bili-dash-cta {
    width: 100%;
    white-space: normal;
    text-align: center;
  }
}

@keyframes rsFadeIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (max-width: 480px) {
  .rs-card {
    border-radius: var(--r-lg);
  }
  .rs-card-hd {
    padding: 0.65rem 0.875rem;
  }
  .rs-card-actions {
    padding: 0.65rem 0.875rem;
  }
  .rs-video {
    max-height: 220px;
  }
}
@media (min-width: 481px) and (max-width: 767px) {
  .rs-video {
    max-height: 320px;
  }
}
</style>
