<script setup>
import { computed, ref } from "vue";
import AppIcon from "../AppIcon.vue";
import {
  formatCodecLabel,
  variantSpecifications,
} from "../../utils/mediaSources";
import { t, qualityBitrates, formatBitrate } from "./resultI18n";

const props = defineProps({
  locale: String,
  currentItemId: String,
  qualityOptions: { type: Array, default: () => [] },
  downloadableCount: { type: Number, default: 0 },
  otherQualityOptions: { type: Array, default: () => [] },
  hasHiddenQualityVariants: Boolean,
  showAllQualityVariants: Boolean,
  unavailableQualityReason: String,
  higherQualityNotice: Boolean,
  isBilibili: Boolean,
  isExtensionConnected: Boolean,
  bilibiliDashSummary: { type: Object, default: null },
  displayVariantLabel: Function,
  formatOptionSize: Function,
});

const emit = defineEmits(["select-quality", "toggle-show-all", "copy-url"]);

const panelEl = ref(null);

const visibleOtherOptions = computed(() =>
  props.otherQualityOptions.filter((option) => !option?.dashMux),
);

const focusFirstOption = () => {
  const panel = panelEl.value;
  panel?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  const firstOption = panel?.querySelector?.(".rs-backup-item");
  firstOption?.focus?.();
};

defineExpose({ focusFirstOption });
</script>

<template>
  <div ref="panelEl" class="rs-tab-panel">
    <div class="rs-backup-label-row">
      <span>{{ t(locale, "selectQuality") }}</span>
      <button
        v-if="hasHiddenQualityVariants"
        class="rs-quality-display-toggle"
        :aria-expanded="showAllQualityVariants"
        @click="emit('toggle-show-all')"
      >
        {{
          showAllQualityVariants
            ? locale === "en"
              ? "Compact view"
              : "精简展示"
            : locale === "en"
              ? `All downloadable versions (${downloadableCount})`
              : `全部可下载版本 (${downloadableCount})`
        }}
      </button>
    </div>
    <p
      v-if="unavailableQualityReason"
      class="rs-stat-note rs-quality-unavailable"
      role="status"
    >
      {{ unavailableQualityReason }}
    </p>
    <p
      v-if="higherQualityNotice && !bilibiliDashSummary && !isExtensionConnected"
      class="rs-stat-note rs-higher-quality-note"
    >
      {{
        locale === "en"
          ? "Higher quality is available but requires processing that is not supported yet."
          : "存在更高画质，需要处理，当前暂不支持。"
      }}
    </p>
    <div class="rs-backup-list">
      <div
        v-for="option in qualityOptions"
        :key="option.variant.id"
        class="rs-backup-group"
      >
        <button
          @click="emit('select-quality', option)"
          class="rs-backup-item"
          :class="{ 'rs-backup-item--cur': option.active }"
          :data-extension-mux="option.extensionMux || undefined"
        >
          <div class="rs-backup-hd">
            <span class="rs-backup-name"
              >{{ formatOptionSize(option) }} ·
              {{ displayVariantLabel(option.variant) }}</span
            ><span v-if="option.active" class="rs-backup-playing"
              ><AppIcon class="fas fa-circle-check rs-backup-cur" />{{
                t(locale, "currentPlaying")
              }}</span
            >
          </div>
          <div class="rs-backup-meta">
            <span
              v-if="option.extensionMux"
              class="rs-backup-meta-tag rs-backup-meta-tag--ext"
              data-extension-mux-tag
              >{{ t(locale, "extMuxTag") }}</span
            ><span
              v-if="option.variant.provenance === 'original_endpoint'"
              class="rs-backup-meta-tag"
              >{{ locale === "en" ? "Original" : "原画" }}</span
            ><span
              v-for="rate in qualityBitrates(option.variant.metadata, locale)"
              :key="rate.key"
              class="rs-backup-meta-tag"
              ><AppIcon class="fas fa-wave-square" />
              {{ rate.label }} {{ formatBitrate(rate.value) }} </span
            ><span
              v-if="option.variant.metadata?.width"
              class="rs-backup-meta-tag"
              ><AppIcon class="fas fa-arrows-alt" />{{
                option.variant.metadata.height
                  ? `${option.variant.metadata.width}×${option.variant.metadata.height}`
                  : `${option.variant.metadata.width}w`
              }}</span
            ><span
              v-if="option.variant.metadata?.video_codec"
              class="rs-backup-meta-tag"
              :title="option.variant.metadata.video_codec"
              ><AppIcon class="fas fa-microchip" />{{
                formatCodecLabel(option.variant.metadata.video_codec)
              }}</span
            ><span
              v-else-if="option.variant.metadata?.audio_codec"
              class="rs-backup-meta-tag"
              :title="option.variant.metadata.audio_codec"
              ><AppIcon class="fas fa-microchip" />{{
                formatCodecLabel(option.variant.metadata.audio_codec)
              }}</span
            ><span
              v-if="option.capabilities.length && !option.extensionMux"
              class="rs-backup-meta-tag"
              >{{ option.capabilities.join(" + ") }}</span
            >
          </div>
        </button>
      </div>
    </div>
    <details
      v-if="visibleOtherOptions.length"
      :key="currentItemId"
      class="rs-other-versions"
    >
      <summary>
        {{
          locale === "en"
            ? `Other versions (${visibleOtherOptions.length})`
            : `其他版本 (${visibleOtherOptions.length})`
        }}
      </summary>
      <div
        v-for="option in visibleOtherOptions"
        :key="option.variant.id"
        class="rs-other-version"
      >
        <div class="rs-backup-name">
          {{ displayVariantLabel(option.variant) }}
        </div>
        <div class="rs-backup-meta">
          <span
            v-for="specification in variantSpecifications(option.variant)"
            :key="specification"
            class="rs-backup-meta-tag"
            >{{ specification }}</span
          >
          <span v-if="option.capabilities.length" class="rs-backup-meta-tag">{{
            option.capabilities.join(" + ")
          }}</span>
        </div>
        <p class="rs-stat-note">{{ option.downloadTarget.message }}</p>
        <div v-if="option.streamCopyUrl" class="rs-other-version-actions">
          <button
            type="button"
            class="rs-other-copy-btn"
            data-testid="copy-stream-url-btn"
            @click="emit('copy-url', option.streamCopyUrl)"
          >
            <AppIcon class="fas fa-copy" />
            <span>{{ locale === "en" ? "Copy stream URL" : "复制流链接" }}</span>
          </button>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
.rs-tab-panel {
  padding: 1rem 1.125rem;
  animation: rsFadeIn 0.2s ease;
}
.rs-stat-note {
  margin-top: 0.6rem;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--c-fg-3);
}
.rs-backup-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.6875rem;
  color: var(--c-fg-3);
  margin-bottom: 0.5rem;
  font-weight: 500;
}
.rs-quality-display-toggle {
  border: 0;
  padding: 0;
  background: none;
  color: var(--c-accent);
  font: inherit;
  cursor: pointer;
}
.rs-backup-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.rs-other-versions {
  margin-top: 0.65rem;
  color: var(--c-fg-3);
  font-size: 0.6875rem;
}
.rs-other-versions > summary {
  cursor: pointer;
}
.rs-other-version {
  display: grid;
  gap: 0.25rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--c-border-2);
}
.rs-other-version-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.25rem;
}
.rs-other-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0.6rem;
  border-radius: var(--r-sm, 0.375rem);
  border: 1px solid var(--c-border);
  background: var(--c-bg-2);
  color: var(--c-fg-2);
  font-size: 0.6875rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--t-fast);
}
.rs-other-copy-btn:hover {
  border-color: var(--c-accent);
  color: var(--c-fg);
  background: var(--c-bg-3);
}
.rs-backup-item {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.5rem 0.75rem;
  background: var(--c-bg-2);
  border: 1px solid var(--c-border-2);
  border-radius: var(--r-md);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  width: 100%;
  transition: all var(--t-fast);
}
.rs-backup-item:hover {
  border-color: rgba(108, 92, 231, 0.25);
  background: linear-gradient(
    135deg,
    rgba(108, 92, 231, 0.03) 0%,
    rgba(168, 85, 247, 0.03) 100%
  );
}
.rs-backup-item--cur {
  border-color: var(--c-accent);
  background: rgba(108, 92, 231, 0.06);
  box-shadow: 0 0 0 1px var(--c-accent);
}
.rs-backup-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.rs-backup-name {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--c-fg);
}
.rs-backup-cur {
  color: var(--c-accent);
  font-size: 0.8rem;
}
.rs-backup-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.rs-backup-meta-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  font-size: 0.625rem;
  color: var(--c-fg-3);
  background: var(--c-bg);
  padding: 0.1rem 0.45rem;
  border-radius: 0.25rem;
}
.rs-backup-meta-tag--ext {
  color: #4338ca;
  background: rgba(99, 102, 241, 0.12);
  font-weight: 600;
}
:global(.dark) .rs-backup-meta-tag--ext {
  color: #c7d2fe;
  background: rgba(129, 140, 248, 0.2);
}
.rs-backup-playing {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--c-accent);
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
@media (prefers-reduced-motion: reduce) {
  .rs-tab-panel {
    animation: none;
  }
}
</style>
