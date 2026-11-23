<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import AppIcon from "../AppIcon.vue";
import {
  readyItem,
  readyVariant,
  getDownloadTarget,
} from "../../utils/mediaContract";
import { apiConfig } from "../../services/apiConfig";
import { t } from "./resultI18n";

const props = defineProps({
  imageItems: { type: Array, default: () => [] },
  locale: String,
  selection: Object,
  resultVersion: Number,
  suspendKeys: Boolean,
  safeImageUrl: Function,
});

const emit = defineEmits([
  "download-images",
  "download-image",
  "mark-image-broken",
  "modal-open-change",
]);

const context = { apiOrigin: apiConfig.baseUrl };
const imageUrl = (item) => {
  const selected = props.selection?.selectionFor(item.id);
  const result = getDownloadTarget(item, selected, context);
  return result.kind === "file" ? result.url : "";
};

const galleryEl = ref(null);
const loadedImageDims = ref({});

const declaredImageDimensions = (item) => {
  if (!readyItem(item)) return null;
  const selected = props.selection?.selectionFor(item.id);
  const result = getDownloadTarget(item, selected, context);
  const meta =
    (result && "variant" in result ? result.variant?.metadata : null) ||
    item.variants?.find((v) => readyVariant(v))?.metadata ||
    null;
  const width = Number(meta?.width);
  const height = Number(meta?.height);
  return Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(height) &&
    height > 0
    ? { width, height }
    : null;
};

const effectiveImageDimensions = (item) =>
  declaredImageDimensions(item) || loadedImageDims.value[item.id] || null;

const singleImageItemStyle = (item) => {
  if (props.imageItems.length !== 1) return undefined;
  const dims = effectiveImageDimensions(item);
  return {
    "--rs-single-img-ratio": dims ? `${dims.width} / ${dims.height}` : "4 / 3",
  };
};

const onGalleryImageLoad = (event, itemId) => {
  const img = event?.currentTarget || event?.target;
  const width = Number(img?.naturalWidth);
  const height = Number(img?.naturalHeight);
  if (
    itemId &&
    Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(height) &&
    height > 0
  ) {
    const prev = loadedImageDims.value[itemId];
    if (!prev || prev.width !== width || prev.height !== height) {
      loadedImageDims.value = {
        ...loadedImageDims.value,
        [itemId]: { width, height },
      };
    }
  }
};

const syncCachedGalleryImageDimensions = () => {
  const imgs = galleryEl.value?.querySelectorAll?.("img[data-gallery-item-id]");
  if (!imgs) return;
  imgs.forEach((img) => {
    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      const id = img.getAttribute("data-gallery-item-id");
      if (id) onGalleryImageLoad({ currentTarget: img }, id);
    }
  });
};

const activeImageIndex = ref(0);
const imageModalOpen = ref(false);

const setModalOpen = (next) => {
  if (imageModalOpen.value !== next) {
    imageModalOpen.value = next;
    emit("modal-open-change", next);
  }
};

const openImageModal = (index) => {
  activeImageIndex.value = index;
  setModalOpen(true);
  props.selection?.selectItem(props.imageItems[index].id);
};

const closeImageModal = () => {
  setModalOpen(false);
};

const nextImage = () => {
  if (!props.imageItems.length) return;
  activeImageIndex.value =
    (activeImageIndex.value + 1) % props.imageItems.length;
  props.selection?.selectItem(props.imageItems[activeImageIndex.value].id);
};

const prevImage = () => {
  if (!props.imageItems.length) return;
  activeImageIndex.value =
    (activeImageIndex.value - 1 + props.imageItems.length) %
    props.imageItems.length;
  props.selection?.selectItem(props.imageItems[activeImageIndex.value].id);
};

const handleKeydown = (event) => {
  if (props.suspendKeys || !imageModalOpen.value) return;
  if (event.key === "Escape") closeImageModal();
  if (event.key === "ArrowRight") nextImage();
  if (event.key === "ArrowLeft") prevImage();
};

watch(
  () => props.resultVersion,
  () => {
    activeImageIndex.value = 0;
    loadedImageDims.value = {};
    closeImageModal();
    nextTick(syncCachedGalleryImageDimensions);
  },
);

onMounted(() => {
  syncCachedGalleryImageDimensions();
  window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown);
  if (imageModalOpen.value) {
    emit("modal-open-change", false);
  }
});
</script>

<template>
  <div class="rs-card rs-card--gallery">
    <div class="rs-card-hd">
      <div class="rs-card-hd-left">
        <AppIcon class="fas fa-images rs-card-icon"></AppIcon>
        <span>{{ t(locale, "imageSource") }}</span>
      </div>
      <span class="rs-count-tag">{{
        t(locale, "imagesCount").replace("{count}", imageItems.length)
      }}</span>
    </div>

    <div
      ref="galleryEl"
      class="rs-gallery"
      :class="{
        'rs-gallery--1': imageItems.length === 1,
        'rs-gallery--2': imageItems.length === 2 || imageItems.length === 4,
        'rs-gallery--3':
          imageItems.length === 3 ||
          imageItems.length === 5 ||
          imageItems.length === 6,
        'rs-gallery--4': imageItems.length > 6,
      }"
    >
      <button
        v-for="(item, idx) in imageItems"
        :key="item.id"
        @click="openImageModal(idx)"
        class="rs-gallery-item"
        :style="singleImageItemStyle(item)"
        :data-gallery-single="imageItems.length === 1 ? 'true' : undefined"
        :aria-label="`${t(locale, 'preview')} ${idx + 1}`"
      >
        <img
          v-if="safeImageUrl(imageUrl(item))"
          :src="safeImageUrl(imageUrl(item))"
          :data-gallery-item-id="item.id"
          :width="declaredImageDimensions(item)?.width || undefined"
          :height="declaredImageDimensions(item)?.height || undefined"
          class="rs-gallery-img"
          :alt="`${t(locale, 'imagesTitle')} ${idx + 1}`"
          referrerpolicy="no-referrer"
          loading="lazy"
          @load="onGalleryImageLoad($event, item.id)"
          @error="emit('mark-image-broken', imageUrl(item))"
        />
        <div class="rs-gallery-mask">
          <AppIcon class="fas fa-search-plus"></AppIcon>
        </div>
      </button>
    </div>

    <div class="rs-card-actions">
      <button @click="emit('download-images')" class="rs-btn rs-btn--primary">
        <AppIcon class="fas fa-download"></AppIcon>
        <span>{{ t(locale, "allImages") }} ({{ imageItems.length }})</span>
      </button>
    </div>
  </div>

  <Teleport to="body"
    ><Transition name="rs-modal"
      ><div
        v-if="imageModalOpen && imageItems[activeImageIndex]"
        class="rs-modal"
        @click.self="closeImageModal"
        role="dialog"
        aria-modal="true"
        :aria-label="t(locale, 'preview')"
      >
        <button
          @click="closeImageModal"
          class="rs-modal-close"
          :aria-label="t(locale, 'close')"
        >
          <AppIcon class="fas fa-times" /></button
        ><button
          v-if="imageItems.length > 1"
          @click="prevImage"
          class="rs-modal-nav rs-modal-nav--prev"
        >
          <AppIcon class="fas fa-chevron-left" /></button
        ><button
          v-if="imageItems.length > 1"
          @click="nextImage"
          class="rs-modal-nav rs-modal-nav--next"
        >
          <AppIcon class="fas fa-chevron-right" />
        </button>
        <div class="rs-modal-body">
          <img
            v-if="safeImageUrl(imageUrl(imageItems[activeImageIndex]))"
            :src="safeImageUrl(imageUrl(imageItems[activeImageIndex]))"
            referrerpolicy="no-referrer"
            class="rs-modal-img"
            :alt="imageItems[activeImageIndex].title || 'Image'"
            @error="emit('mark-image-broken', imageUrl(imageItems[activeImageIndex]))"
          />
        </div>
        <button
          class="rs-btn rs-btn--primary"
          @click="emit('download-image', imageItems[activeImageIndex])"
        >
          <AppIcon class="fas fa-download" />{{
            locale === "en" ? "Download image" : "下载图片"
          }}
        </button>
        <div class="rs-modal-num">
          {{ activeImageIndex + 1 }} / {{ imageItems.length }}
        </div>
      </div></Transition
    ></Teleport
  >
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
.rs-count-tag {
  font-size: 0.6875rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  background: rgba(236, 72, 153, 0.08);
  color: var(--c-accent-3);
  font-weight: 600;
}

.rs-gallery {
  display: grid;
  gap: 0.625rem;
  padding: 1rem 1.125rem;
}
.rs-gallery--1 {
  grid-template-columns: 1fr;
}
.rs-gallery--2 {
  grid-template-columns: 1fr 1fr;
}
.rs-gallery--3 {
  grid-template-columns: repeat(3, 1fr);
}
.rs-gallery--4 {
  grid-template-columns: repeat(4, 1fr);
}

@media (max-width: 767px) {
  .rs-gallery--3 {
    grid-template-columns: repeat(2, 1fr);
  }
  .rs-gallery--4 {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (min-width: 768px) and (max-width: 1039px) {
  .rs-gallery--4 {
    grid-template-columns: repeat(3, 1fr);
  }
}

.rs-gallery-item {
  position: relative;
  border-radius: var(--r-md);
  overflow: hidden;
  aspect-ratio: 4/3;
  cursor: pointer;
  border: 1px solid var(--c-border);
  padding: 0;
  background: var(--c-bg-3);
  transition: transform var(--t-base), box-shadow var(--t-base);
}
.rs-gallery--1 .rs-gallery-item {
  width: 100%;
  aspect-ratio: var(--rs-single-img-ratio, 4/3);
  max-height: 70vh;
  max-height: 70dvh;
  transition: aspect-ratio var(--t-base), transform var(--t-base),
    box-shadow var(--t-base);
}
.rs-gallery-item:hover {
  transform: translateY(-2px);
  box-shadow: var(--sh-xl);
}
.rs-gallery-item:focus-visible {
  outline: 2px solid var(--c-accent);
  outline-offset: 2px;
}
.rs-gallery-img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
}
.rs-gallery-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0);
  color: #fff;
  font-size: 1.25rem;
  opacity: 0;
  transition: all var(--t-base);
}
.rs-gallery-item:hover .rs-gallery-mask {
  background: rgba(0, 0, 0, 0.35);
  opacity: 1;
}

.rs-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.65rem 1.25rem;
  font-size: 0.7875rem;
  font-weight: 600;
  border-radius: var(--r-lg, 1rem);
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: all var(--t-base, 220ms cubic-bezier(0.4, 0, 0.2, 1));
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
  transition: opacity var(--t-base, 220ms cubic-bezier(0.4, 0, 0.2, 1));
}
.rs-btn:hover::before {
  opacity: 1;
}
.rs-btn:active {
  transform: scale(0.96);
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

.rs-modal {
  --t-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
  --t-base: 220ms cubic-bezier(0.4, 0, 0.2, 1);
  --r-lg: 1rem;
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.96);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.rs-modal-close {
  position: absolute;
  top: 1rem;
  right: 1rem;
  z-index: 10;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--t-fast);
}
.rs-modal-close:hover {
  background: rgba(255, 255, 255, 0.18);
}
.rs-modal-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--t-fast);
}
.rs-modal-nav:hover {
  background: rgba(255, 255, 255, 0.2);
}
.rs-modal-nav--prev {
  left: 1rem;
}
.rs-modal-nav--next {
  right: 1rem;
}
@media (max-width: 640px) {
  .rs-modal-nav {
    width: 2.25rem;
    height: 2.25rem;
    font-size: 0.8rem;
  }
  .rs-modal-nav--prev {
    left: 0.4rem;
  }
  .rs-modal-nav--next {
    right: 0.4rem;
  }
}
.rs-modal-body {
  display: flex;
  align-items: center;
  justify-content: center;
  max-width: 90vw;
  max-height: 85vh;
  padding: 2rem;
}
.rs-modal-img {
  max-width: 100%;
  max-height: 80vh;
  object-fit: contain;
  border-radius: 0.5rem;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
}
.rs-modal > .rs-btn {
  border-radius: var(--r-lg, 0.75rem);
  flex-shrink: 0;
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
  .rs-modal {
    flex-direction: column;
    gap: 1rem;
    padding: 4rem 3.25rem 3.25rem;
    box-sizing: border-box;
  }
  .rs-modal-body {
    max-width: 100%;
    max-height: calc(100vh - 11.5rem);
    max-height: calc(100dvh - 11.5rem);
    padding: 0;
    min-height: 0;
  }
  .rs-modal-img {
    max-width: 100%;
    max-height: calc(100vh - 11.5rem);
    max-height: calc(100dvh - 11.5rem);
  }
  .rs-modal > .rs-btn {
    width: auto;
    max-width: 100%;
    margin: 0 auto;
  }
}
.rs-modal-num {
  position: absolute;
  bottom: 1.25rem;
  right: 1.25rem;
  color: rgba(255, 255, 255, 0.55);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.rs-modal-enter-active {
  transition: opacity 0.25s ease;
}
.rs-modal-leave-active {
  transition: opacity 0.18s ease;
}
.rs-modal-enter-from,
.rs-modal-leave-to {
  opacity: 0;
}
</style>
