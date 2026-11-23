<script setup>
import AppIcon from "../AppIcon.vue";
import VideoPlaylist from "../VideoPlaylist.vue";
import { t } from "./resultI18n";

defineProps({
  hasVideo: Boolean,
  isMulti: Boolean,
  alignDetails: Boolean,
  locale: String,
  platform: String,
  currentItem: Object,
  activeVariant: Object,
  activeVideoUrl: String,
  copyVideoUrl: { type: String, default: undefined },
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
  isActiveExtensionDashMux: Boolean,
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
});

const emit = defineEmits([
  "playback-error",
  "playback-loaded",
  "mark-image-broken",
  "open-quality-picker",
  "open-yt-helper-modal",
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
        :data-extension-dash-mux-save="isActiveExtensionDashMux || undefined"
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
        @click="emit('copy-url', copyVideoUrl !== undefined ? copyVideoUrl : activeVideoUrl)"
        class="rs-btn rs-btn--ghost-light"
        :disabled="!(copyVideoUrl !== undefined ? copyVideoUrl : activeVideoUrl)"
      >
        <AppIcon class="fas fa-copy" /><span>{{
          t(locale, "copyVideo")
        }}</span>
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
