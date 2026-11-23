<script setup>
import { computed, ref, watch } from "vue";
import AppIcon from "../AppIcon.vue";
import {
  readyItem,
  readyVariant,
  resourceSource,
  sourceUrl,
} from "../../utils/mediaContract";
import { apiConfig } from "../../services/apiConfig";
import { t } from "./resultI18n";

const props = defineProps({
  liveItems: { type: Array, default: () => [] },
  locale: String,
  selection: Object,
  resultVersion: Number,
  safeImageUrl: Function,
});

const emit = defineEmits([
  "select-live-quality",
  "download-live-video",
  "download-live-cover",
  "download-all-live",
  "download-all-live-covers",
  "mark-image-broken",
]);

const context = { apiOrigin: apiConfig.baseUrl };
const urlOf = (source) => (source ? sourceUrl(source, context) : "");

const activeLiveIndex = ref(0);
const liveViewMode = ref("video");
const totalLivePhotos = computed(() => props.liveItems.length);

const liveVariant = (item) => {
  if (!readyItem(item)) return null;
  const choice = props.selection?.selectionFor(item.id);
  return choice
    ? item.variants.find((variant) => variant.id === choice.variant_id)
    : item.variants.length === 1
      ? item.variants[0]
      : null;
};

const liveResources = (item) =>
  readyVariant(liveVariant(item)) && liveVariant(item).delivery.kind === "pair"
    ? liveVariant(item).delivery.resources
    : [];

const liveUrl = (item, role) => {
  const resource = liveResources(item).find(
    (candidate) => candidate.role === role,
  );
  return resource ? urlOf(resourceSource(resource)) : "";
};

watch(
  () => props.resultVersion,
  () => {
    activeLiveIndex.value = 0;
  },
);
</script>

<template>
  <div class="rs-card rs-card--live">
    <div class="rs-live-carousel">
      <div class="rs-live-carousel-hd">
        <span class="rs-live-badge">
          <span class="rs-live-dot"></span>
          {{ t(locale, "live") }} {{ activeLiveIndex + 1 }}/{{
            totalLivePhotos
          }}
        </span>
        <button
          v-if="liveItems[activeLiveIndex]?.variants?.length > 1"
          class="rs-btn rs-btn--ghost rs-btn--sm"
          @click="emit('select-live-quality', liveItems[activeLiveIndex])"
        >
          {{ t(locale, "selectQuality") }}
        </button>
        <div class="rs-live-toggle">
          <button
            @click="liveViewMode = 'video'"
            class="rs-live-toggle-btn"
            :class="{ 'rs-live-toggle-btn--on': liveViewMode === 'video' }"
          >
            <AppIcon class="fas fa-video"></AppIcon>
            {{ t(locale, "overlayVideo") }}
          </button>
          <button
            @click="liveViewMode = 'cover'"
            class="rs-live-toggle-btn"
            :class="{ 'rs-live-toggle-btn--on': liveViewMode === 'cover' }"
          >
            <AppIcon class="fas fa-image"></AppIcon>
            {{ t(locale, "overlayCover") }}
          </button>
        </div>
      </div>

      <div class="rs-live-carousel-body">
        <button
          @click="
            activeLiveIndex =
              activeLiveIndex === 0 ? totalLivePhotos - 1 : activeLiveIndex - 1
          "
          class="rs-live-nav rs-live-nav--prev"
          :disabled="totalLivePhotos <= 1"
        >
          <AppIcon class="fas fa-chevron-left"></AppIcon>
        </button>
        <button
          @click="activeLiveIndex = (activeLiveIndex + 1) % totalLivePhotos"
          class="rs-live-nav rs-live-nav--next"
          :disabled="totalLivePhotos <= 1"
        >
          <AppIcon class="fas fa-chevron-right"></AppIcon>
        </button>

        <div class="rs-live-carousel-content">
          <template v-if="liveViewMode === 'video'">
            <video
              :src="liveUrl(liveItems[activeLiveIndex], 'motion')"
              :poster="
                safeImageUrl(liveUrl(liveItems[activeLiveIndex], 'image')) ||
                undefined
              "
              controls
              referrerpolicy="no-referrer"
              class="rs-live-carousel-video"
            >
              <track kind="captions" :src="undefined" />
            </video>
            <img
              v-if="safeImageUrl(liveUrl(liveItems[activeLiveIndex], 'image'))"
              :src="safeImageUrl(liveUrl(liveItems[activeLiveIndex], 'image'))"
              referrerpolicy="no-referrer"
              hidden
              alt=""
              class="rs-poster-probe"
              @error="
                emit(
                  'mark-image-broken',
                  liveUrl(liveItems[activeLiveIndex], 'image'),
                )
              "
            />
          </template>
          <template v-else>
            <img
              v-if="safeImageUrl(liveUrl(liveItems[activeLiveIndex], 'image'))"
              :src="safeImageUrl(liveUrl(liveItems[activeLiveIndex], 'image'))"
              referrerpolicy="no-referrer"
              class="rs-live-carousel-image"
              :alt="`${t(locale, 'live')} ${activeLiveIndex + 1}`"
              @error="
                emit(
                  'mark-image-broken',
                  liveUrl(liveItems[activeLiveIndex], 'image'),
                )
              "
            />
          </template>
        </div>
      </div>

      <div class="rs-live-carousel-actions">
        <button
          @click="emit('download-live-video', liveItems[activeLiveIndex])"
          class="rs-btn rs-btn--ghost rs-btn--sm"
        >
          <AppIcon class="fas fa-video"></AppIcon>
          {{ t(locale, "overlayVideo") }}
        </button>
        <button
          @click="emit('download-live-cover', liveItems[activeLiveIndex])"
          class="rs-btn rs-btn--ghost rs-btn--sm"
        >
          <AppIcon class="fas fa-image"></AppIcon>
          {{ t(locale, "overlayCover") }}
        </button>
      </div>
    </div>

    <div class="rs-live-bulk-bar">
      <button
        @click="emit('download-all-live')"
        class="rs-btn rs-btn--primary rs-btn--block"
      >
        <AppIcon class="fas fa-download"></AppIcon>
        {{ t(locale, "downloadAllLive") }} ({{ totalLivePhotos }}
        {{ t(locale, "live") }})
      </button>
      <button
        @click="emit('download-all-live-covers')"
        class="rs-btn rs-btn--ghost rs-btn--block"
      >
        <AppIcon class="fas fa-images"></AppIcon>
        {{ t(locale, "downloadAllCovers") }} ({{ totalLivePhotos }})
      </button>
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

.rs-live-dot {
  display: inline-block;
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: var(--c-danger);
  animation: rsPulse 1.8s ease infinite;
}
.rs-live-carousel {
  background: #0a0a14;
}
.rs-live-carousel-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.625rem 0.875rem;
  background: rgba(0, 0, 0, 0.3);
}
.rs-live-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.65rem;
  background-color: #6d28d9;
  background-image: linear-gradient(
    135deg,
    rgba(108, 92, 231, 0.9),
    rgba(168, 85, 247, 0.9)
  );
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  color: #fff;
}
.rs-live-toggle {
  display: flex;
  gap: 0.3rem;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 0.45rem;
  padding: 0.15rem;
}
.rs-live-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.55rem;
  border: none;
  background: transparent;
  border-radius: 0.35rem;
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.65rem;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--t-fast);
  font-family: inherit;
}
.rs-live-toggle-btn:hover {
  color: rgba(255, 255, 255, 0.9);
}
.rs-live-toggle-btn--on {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}
.rs-live-toggle-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.rs-live-carousel-body {
  position: relative;
  aspect-ratio: 16/9;
}
.rs-live-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.4);
  color: #fff;
  font-size: 0.9rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--t-fast);
}
.rs-live-nav:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.3);
}
.rs-live-nav--prev {
  left: 0.5rem;
}
.rs-live-nav--next {
  right: 0.5rem;
}
.rs-live-nav:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}
.rs-live-carousel-content {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rs-live-carousel-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.rs-live-carousel-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.rs-live-carousel-actions {
  display: flex;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.5rem 0.875rem;
  background: rgba(0, 0, 0, 0.2);
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}
.rs-live-bulk-bar {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.875rem 1.125rem;
  border-top: 1px solid var(--c-border);
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
.rs-btn--sm {
  padding: 0.45rem 0.85rem;
  font-size: 0.7rem;
  border-radius: 0.55rem;
  gap: 0.35rem;
}
.rs-btn--block {
  width: 100%;
}
.rs-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}
.rs-btn--primary {
  background-color: #4f46e5;
  background-image: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: #fff;
  box-shadow: 0 4px 16px rgba(108, 92, 231, 0.35), 0 1px 3px rgba(0, 0, 0, 0.1);
}
.rs-btn--primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 28px rgba(108, 92, 231, 0.45),
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
.rs-live-carousel-actions .rs-btn--ghost {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(8px);
}
.rs-live-carousel-actions .rs-btn--ghost:hover {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.25);
  color: #fff;
  transform: translateY(-1px);
}

@keyframes rsPulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.45;
    transform: scale(0.75);
  }
}
@media (prefers-reduced-motion: reduce) {
  .rs-live-dot {
    animation: none;
  }
}
@media (max-width: 480px) {
  .rs-card {
    border-radius: var(--r-lg);
  }
  .rs-live-carousel-hd {
    padding: 0.5rem 0.625rem;
  }
  .rs-live-badge {
    font-size: 0.65rem;
    padding: 0.2rem 0.5rem;
  }
  .rs-live-toggle-btn {
    padding: 0.2rem 0.4rem;
    font-size: 0.6rem;
  }
  .rs-live-nav {
    width: 2rem;
    height: 2rem;
    font-size: 0.75rem;
  }
}
</style>
