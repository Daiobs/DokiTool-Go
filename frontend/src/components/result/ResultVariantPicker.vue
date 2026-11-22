<script setup>
import { computed, ref, watch } from "vue";
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
  bilibiliDashSummary: { type: Object, default: null },
  displayVariantLabel: Function,
  formatOptionSize: Function,
});

const emit = defineEmits([
  "select-quality",
  "toggle-show-all",
  "open-extension",
]);

const EXT_ICON_PATH =
  "M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 2c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z";

const panelEl = ref(null);
const inspectedBiliMuxId = ref(null);

watch(
  () => props.currentItemId,
  () => {
    inspectedBiliMuxId.value = null;
  },
);

const isBilibiliMuxOption = (option) =>
  Boolean(
    props.isBilibili &&
      option?.variant?.state !== "deferred" &&
      option?.variant?.delivery?.kind === "mux",
  );

const hasBilibiliMuxOtherOptions = computed(() =>
  props.otherQualityOptions.some(isBilibiliMuxOption),
);
const allOtherOptionsAreBilibiliMux = computed(
  () =>
    props.otherQualityOptions.length > 0 &&
    props.otherQualityOptions.every(isBilibiliMuxOption),
);
const otherVersionsSummaryLabel = computed(() => {
  const count = String(props.otherQualityOptions.length);
  if (allOtherOptionsAreBilibiliMux.value) {
    return t(props.locale, "biliDashSummaryAll").replace("{count}", count);
  }
  if (hasBilibiliMuxOtherOptions.value) {
    return t(props.locale, "biliDashSummaryMixed").replace("{count}", count);
  }
  return props.locale === "en"
    ? `Other versions (${count})`
    : `其他版本 (${count})`;
});

const toggleBiliMuxOption = (variantId) => {
  inspectedBiliMuxId.value =
    inspectedBiliMuxId.value === variantId ? null : variantId;
};

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
    <div
      v-if="bilibiliDashSummary"
      class="rs-bili-dash-quality-card"
      data-bilibili-dash-quality-card
    >
      <div class="rs-bili-dash-quality-head">
        <AppIcon class="fas fa-bolt rs-bili-dash-quality-bolt" />
        <span>{{
          t(
            locale,
            bilibiliDashSummary.tierCount === 1
              ? "biliDashTitleOne"
              : "biliDashTitle",
          ).replace("{count}", String(bilibiliDashSummary.tierCount))
        }}</span>
      </div>
      <div
        v-if="bilibiliDashSummary.specText"
        class="rs-bili-dash-quality-specs"
      >
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
      <p class="rs-bili-dash-quality-desc">{{ t(locale, "biliDashHint") }}</p>
      <button
        type="button"
        class="rs-bili-dash-quality-cta"
        data-bilibili-dash-quality-cta
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
    <p
      v-if="higherQualityNotice && !bilibiliDashSummary"
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
            ><span v-if="option.capabilities.length" class="rs-backup-meta-tag">{{
              option.capabilities.join(" + ")
            }}</span>
          </div>
        </button>
      </div>
    </div>
    <details
      v-if="otherQualityOptions.length"
      :key="currentItemId"
      class="rs-other-versions"
    >
      <summary>{{ otherVersionsSummaryLabel }}</summary>
      <div
        v-if="hasBilibiliMuxOtherOptions && !inspectedBiliMuxId"
        class="rs-bili-mux-guide"
        data-bilibili-mux-guide
        role="status"
      >
        <p class="rs-bili-mux-guide-text">
          {{ t(locale, "biliDashMuxExplain") }}
        </p>
        <button
          type="button"
          class="rs-bili-mux-guide-btn"
          data-bilibili-mux-open-extension
          @click="emit('open-extension')"
        >
          {{ t(locale, "biliDashOpenGuide") }}
        </button>
      </div>
      <div
        v-for="option in otherQualityOptions"
        :key="option.variant.id"
        class="rs-other-version"
        :class="{ 'rs-other-version--bili-mux': isBilibiliMuxOption(option) }"
      >
        <template v-if="isBilibiliMuxOption(option)">
          <button
            type="button"
            class="rs-bili-mux-trigger"
            :class="{
              'rs-bili-mux-trigger--active':
                inspectedBiliMuxId === option.variant.id,
            }"
            :aria-expanded="inspectedBiliMuxId === option.variant.id"
            data-bilibili-mux-option
            @click="toggleBiliMuxOption(option.variant.id)"
          >
            <div class="rs-backup-hd">
              <span class="rs-backup-name">{{
                displayVariantLabel(option.variant)
              }}</span>
              <span class="rs-bili-mux-badge">{{
                t(locale, "biliDashBadge")
              }}</span>
            </div>
            <div class="rs-backup-meta">
              <span
                v-for="specification in variantSpecifications(option.variant)"
                :key="specification"
                class="rs-backup-meta-tag"
                >{{ specification }}</span
              ><span
                v-for="rate in qualityBitrates(option.variant.metadata, locale)"
                :key="rate.key"
                class="rs-backup-meta-tag"
                ><AppIcon class="fas fa-wave-square" /> {{ rate.label }}
                {{ formatBitrate(rate.value) }}</span
              ><span class="rs-backup-meta-tag">{{
                t(locale, "biliDashMuxCap")
              }}</span>
            </div>
          </button>
          <div
            v-if="inspectedBiliMuxId === option.variant.id"
            class="rs-bili-mux-guide"
            data-bilibili-mux-guide
            role="status"
          >
            <p class="rs-bili-mux-guide-text">
              {{ t(locale, "biliDashMuxExplain") }}
            </p>
            <button
              type="button"
              class="rs-bili-mux-guide-btn"
              data-bilibili-mux-open-extension
              @click="emit('open-extension')"
            >
              {{ t(locale, "biliDashOpenGuide") }}
            </button>
          </div>
        </template>
        <template v-else>
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
        </template>
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
.rs-bili-dash-quality-card {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  margin-bottom: 0.65rem;
  padding: 0.7rem 0.8rem;
  border-radius: var(--r-md);
  border: 1px solid rgba(99, 102, 241, 0.24);
  background: linear-gradient(
    135deg,
    rgba(99, 102, 241, 0.08) 0%,
    rgba(168, 85, 247, 0.06) 100%
  );
}
:global(.dark) .rs-bili-dash-quality-card {
  border-color: rgba(129, 140, 248, 0.32);
  background: linear-gradient(
    135deg,
    rgba(99, 102, 241, 0.16) 0%,
    rgba(168, 85, 247, 0.12) 100%
  );
}
.rs-bili-dash-quality-head {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--c-fg);
}
.rs-bili-dash-quality-bolt {
  font-size: 0.7rem;
  color: var(--c-accent);
}
.rs-bili-dash-quality-specs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.rs-bili-dash-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.1rem 0.42rem;
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 600;
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
.rs-bili-dash-quality-desc {
  margin: 0;
  font-size: 0.6875rem;
  line-height: 1.45;
  color: var(--c-fg-2);
}
.rs-bili-dash-quality-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  width: 100%;
  padding: 0.48rem 0.75rem;
  border: none;
  border-radius: var(--r-sm);
  background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
  color: #fff;
  font-family: inherit;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--t-fast);
  box-shadow: 0 2px 10px rgba(79, 70, 229, 0.26);
}
.rs-bili-dash-quality-cta:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(79, 70, 229, 0.38);
}
.rs-bili-dash-quality-cta:focus-visible,
.rs-bili-mux-trigger:focus-visible,
.rs-bili-mux-guide-btn:focus-visible {
  outline: 2px solid var(--c-accent);
  outline-offset: 2px;
}
.rs-bili-dash-ext-icon {
  width: 0.85rem;
  height: 0.85rem;
  flex-shrink: 0;
}
.rs-other-version--bili-mux {
  border-bottom: none;
  padding: 0.25rem 0;
}
.rs-bili-mux-trigger {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  width: 100%;
  padding: 0.5rem 0.65rem;
  text-align: left;
  font-family: inherit;
  border-radius: var(--r-md);
  border: 1px dashed rgba(99, 102, 241, 0.32);
  background: var(--c-bg-2);
  cursor: pointer;
  transition: all var(--t-fast);
}
.rs-bili-mux-trigger:hover,
.rs-bili-mux-trigger--active {
  border-style: solid;
  border-color: var(--c-accent);
  background: rgba(99, 102, 241, 0.07);
}
:global(.dark) .rs-bili-mux-trigger:hover,
:global(.dark) .rs-bili-mux-trigger--active {
  background: rgba(129, 140, 248, 0.14);
}
.rs-bili-mux-badge {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0.1rem 0.42rem;
  border-radius: 999px;
  font-size: 0.6rem;
  font-weight: 600;
  color: #4338ca;
  background: rgba(99, 102, 241, 0.12);
}
:global(.dark) .rs-bili-mux-badge {
  color: #c7d2fe;
  background: rgba(129, 140, 248, 0.2);
}
.rs-bili-mux-guide {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.45rem;
  margin: 0.4rem 0 0.25rem;
  padding: 0.6rem 0.7rem;
  border-radius: var(--r-sm);
  border: 1px solid rgba(99, 102, 241, 0.24);
  background: rgba(99, 102, 241, 0.06);
}
:global(.dark) .rs-bili-mux-guide {
  border-color: rgba(129, 140, 248, 0.3);
  background: rgba(99, 102, 241, 0.14);
}
.rs-bili-mux-guide-text {
  margin: 0;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--c-fg-2);
}
.rs-bili-mux-guide-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.35rem 0.7rem;
  border: 1px solid rgba(99, 102, 241, 0.35);
  border-radius: var(--r-sm);
  background: var(--c-bg);
  color: #4338ca;
  font-family: inherit;
  font-size: 0.6875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--t-fast);
}
.rs-bili-mux-guide-btn:hover {
  border-color: var(--c-accent);
  background: rgba(99, 102, 241, 0.1);
}
:global(.dark) .rs-bili-mux-guide-btn {
  color: #c7d2fe;
  border-color: rgba(129, 140, 248, 0.4);
}
:global(.dark) .rs-bili-mux-guide-btn:hover {
  background: rgba(129, 140, 248, 0.18);
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
