<script setup>
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import AppIcon from "../AppIcon.vue";
import ResultVariantPicker from "./ResultVariantPicker.vue";
import { resourceSource, sourceUrl } from "../../utils/mediaContract";
import { isRefererProtectedMediaRoute } from "../../core/media";
import { apiConfig } from "../../services/apiConfig";
import { t, formatDate } from "./resultI18n";

const props = defineProps({
  resultData: Object,
  locale: String,
  currentItem: Object,
  activeVariant: Object,
  metadata: { type: Object, default: () => ({}) },
  attachments: { type: Array, default: () => [] },
  hasBackup: Boolean,
  isYouTubeHelperBlocked: Boolean,
  activeTab: { type: String, default: "info" },
  canAlignBase: Boolean,
  alignDetails: Boolean,
  mediaIdentity: String,
  formatNumber: Function,
  formatDuration: Function,
  safeImageUrl: Function,
  displayVariantLabel: Function,
  formatOptionSize: Function,
  qualityOptions: { type: Array, default: () => [] },
  downloadableCount: { type: Number, default: 0 },
  otherQualityOptions: { type: Array, default: () => [] },
  hasHiddenQualityVariants: Boolean,
  showAllQualityVariants: Boolean,
  unavailableQualityReason: String,
  higherQualityNotice: Boolean,
  isBilibili: Boolean,
  isMulti: Boolean,
  isExtensionConnected: Boolean,
  bilibiliDashSummary: { type: Object, default: null },
});

const emit = defineEmits([
  "update:active-tab",
  "toggle-show-all-qualities",
  "select-quality",
  "open-extension",
  "copy-text",
  "download-music",
  "mark-image-broken",
  "baseline-change",
]);

const context = { apiOrigin: apiConfig.baseUrl };
const urlOf = (source) => (source ? sourceUrl(source, context) : "");

const author = computed(() => props.resultData?.author || null);
const stats = computed(() =>
  Object.entries(props.resultData?.statistics || {}).map(([key, stat]) => ({
    key,
    value: stat.value,
    unverified: stat.state === "unverified",
    icon:
      {
        likes: "fa-heart",
        comments: "fa-comment",
        saves: "fa-bookmark",
        shares: "fa-share-alt",
      }[key] || "fa-play",
    label: t(
      props.locale,
      {
        plays: "statPlay",
        views: "statPlay",
        likes: "statLike",
        comments: "statComment",
        shares: "statShare",
        saves: "statCollect",
      }[key] || key,
    ),
  })),
);
const EXT_ICON_PATH =
  "M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 2c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z";

const isProtectedDashAudio = (attachment) => {
  if (!attachment) return false;
  if (
    attachment.role !== "background_audio" &&
    attachment.resource?.role !== "audio"
  ) {
    return false;
  }
  if (
    typeof attachment.id === "string" &&
    attachment.id.startsWith("bilibili-audio-")
  ) {
    return true;
  }
  const src =
    attachment.resource?.delivery?.kind === "file"
      ? resourceSource(attachment.resource)
      : null;
  const rawUrl = src ? urlOf(src) : "";
  return Boolean(rawUrl && isRefererProtectedMediaRoute(rawUrl, src));
};

const isBilibiliDashAudio = isProtectedDashAudio;

const visibleAttachments = computed(() => {
  const currentId = props.currentItem?.id;
  const list = props.attachments.filter((att) => {
    if (
      typeof att?.id === "string" &&
      att.id.startsWith("bilibili-audio-") &&
      currentId &&
      att.id !== `bilibili-audio-${currentId}`
    ) {
      return false;
    }
    return true;
  });

  if (
    currentId &&
    !list.some((att) => att?.id === `bilibili-audio-${currentId}`) &&
    props.currentItem?.state !== "deferred" &&
    props.currentItem?.state !== "unavailable" &&
    Array.isArray(props.currentItem?.variants)
  ) {
    let bestAudioLeaf = null;
    let bestBitrate = -1;
    for (const variant of props.currentItem.variants) {
      if (variant?.state === "deferred" || variant?.delivery?.kind !== "mux") {
        continue;
      }
      for (const res of variant.delivery.resources || []) {
        if (res?.role !== "audio" || res?.delivery?.kind !== "file") continue;
        const bitrate = Number(
          res.metadata?.audio_bitrate_bps || res.metadata?.bitrate_bps || 0,
        );
        if (!bestAudioLeaf || bitrate > bestBitrate) {
          bestAudioLeaf = res;
          bestBitrate = bitrate;
        }
      }
    }
    if (bestAudioLeaf) {
      list.push({
        id: `bilibili-audio-${currentId}`,
        role: "background_audio",
        title: "原声音频 (M4A)",
        resource: bestAudioLeaf,
      });
    }
  }
  return list;
});

const allTags = computed(() => props.resultData?.tags || []);
const hasMusic = computed(() => visibleAttachments.value.length > 0);
const playCountNote = computed(() =>
  props.locale === "en"
    ? "The platform did not provide verified counts."
    : "平台未提供可确认的统计值，未将缺失值当作 0。",
);

const infoCards = computed(() => [
  {
    icon: "fa-pen",
    label: t(props.locale, "infoTitle"),
    value:
      (props.isMulti
        ? props.currentItem?.title || props.resultData?.title
        : props.resultData?.title || props.currentItem?.title) ||
      t(props.locale, "unknownTitle"),
  },
  {
    icon: "fa-calendar",
    label: t(props.locale, "publishTime"),
    value:
      formatDate(props.resultData?.published_at) ||
      t(props.locale, "unknownTime"),
  },
  {
    icon: "fa-cube",
    label: t(props.locale, "type"),
    value: props.currentItem?.type || t(props.locale, "unknownType"),
  },
  {
    icon: "fa-expand",
    label: t(props.locale, "quality"),
    value: props.displayVariantLabel(props.activeVariant),
  },
  {
    icon: "fa-clock",
    label: t(props.locale, "duration"),
    value:
      props.formatDuration?.(
        (props.metadata.duration_ms || props.currentItem?.duration_ms || 0) /
          1000,
      ) || "—",
  },
]);

const tabs = computed(() => [
  { key: "info", icon: "fa-info-circle", label: t(props.locale, "tabInfo") },
  ...(stats.value.length
    ? [
        {
          key: "stats",
          icon: "fa-chart-bar",
          label: t(props.locale, "tabStats"),
        },
      ]
    : []),
  ...(props.hasBackup
    ? [
        {
          key: "backup",
          icon: "fa-layer-group",
          label: t(props.locale, "tabBackup"),
        },
      ]
    : []),
  ...(allTags.value.length
    ? [{ key: "tags", icon: "fa-tags", label: t(props.locale, "tabTags") }]
    : []),
  ...(hasMusic.value
    ? [{ key: "music", icon: "fa-music", label: t(props.locale, "tabMusic") }]
    : []),
]);

const attachmentUrl = (attachment) =>
  !props.isYouTubeHelperBlocked &&
  !isBilibiliDashAudio(attachment) &&
  attachment.resource.delivery.kind === "file"
    ? urlOf(resourceSource(attachment.resource))
    : "";

const infoColumnEl = ref(null);
const authorCardEl = ref(null);
const infoCardEl = ref(null);
const tabsEl = ref(null);
const detailsPanelEl = ref(null);
const variantPickerRef = ref(null);

const focusFirstQualityOption = () => {
  variantPickerRef.value?.focusFirstOption?.();
};

defineExpose({ focusFirstQualityOption });

// Measure the details panel, never the selected tab. While another desktop tab
// is open the same panel stays laid out, but hidden/inert and out of normal flow.
const desktopLayout = ref(false);
const detailsCardHeight = ref(0);
const detailsColumnHeight = ref(0);
const canAlignDetails = computed(
  () => desktopLayout.value && props.canAlignBase,
);

let layoutDisposed = false;
let layoutFrame = 0;
let layoutQueued = false;
let layoutObserver;
let observedLayoutNodes = [];
let desktopQuery;

const setBaseline = (cardHeight, columnHeight) => {
  if (
    detailsCardHeight.value !== cardHeight ||
    detailsColumnHeight.value !== columnHeight
  ) {
    detailsCardHeight.value = cardHeight;
    detailsColumnHeight.value = columnHeight;
    emit("baseline-change", { cardHeight, columnHeight });
  }
};

const clearDetailsBaseline = () => {
  setBaseline(0, 0);
};

const measureDetailsLayout = () => {
  if (layoutDisposed) return;
  const nodes = canAlignDetails.value
    ? [
        detailsPanelEl.value,
        tabsEl.value,
        authorCardEl.value,
        infoCardEl.value,
      ].filter(Boolean)
    : [];
  if (
    layoutObserver &&
    (nodes.length !== observedLayoutNodes.length ||
      nodes.some((node, index) => node !== observedLayoutNodes[index]))
  ) {
    layoutObserver.disconnect();
    nodes.forEach((node) => layoutObserver.observe(node));
    observedLayoutNodes = nodes;
  }
  if (!canAlignDetails.value) {
    clearDetailsBaseline();
    return;
  }
  const details = detailsPanelEl.value?.getBoundingClientRect?.();
  const navigation = tabsEl.value?.getBoundingClientRect?.();
  if (
    !details?.width ||
    !details.height ||
    !navigation?.height ||
    !window.getComputedStyle
  )
    return;
  const cardStyle = window.getComputedStyle(infoCardEl.value);
  const columnStyle = window.getComputedStyle(infoColumnEl.value);
  const pixels = (value) => Number.parseFloat(value) || 0;
  const cardHeight = Math.ceil(
    details.height +
      navigation.height +
      pixels(cardStyle.borderTopWidth) +
      pixels(cardStyle.borderBottomWidth),
  );
  const authorHeight =
    authorCardEl.value?.getBoundingClientRect?.().height || 0;
  const columnHeight = Math.ceil(
    cardHeight + authorHeight + (authorHeight ? pixels(columnStyle.rowGap) : 0),
  );
  setBaseline(cardHeight, columnHeight);
};

const queueDetailsMeasurement = () => {
  if (layoutDisposed || layoutQueued) return;
  layoutQueued = true;
  nextTick(() => {
    if (layoutDisposed) {
      layoutQueued = false;
      return;
    }
    const measure = () => {
      layoutFrame = 0;
      layoutQueued = false;
      measureDetailsLayout();
    };
    if (window.requestAnimationFrame)
      layoutFrame = window.requestAnimationFrame(measure);
    else measure();
  });
};

const updateLayoutViewport = () => {
  desktopLayout.value = desktopQuery?.matches ?? window.innerWidth >= 1040;
  if (!desktopLayout.value) clearDetailsBaseline();
  queueDetailsMeasurement();
};

watch(
  [canAlignDetails, () => props.mediaIdentity],
  () => {
    clearDetailsBaseline();
    queueDetailsMeasurement();
  },
  { flush: "post" },
);

watch(hasMusic, (available) => {
  if (!available && props.activeTab === "music") {
    emit("update:active-tab", "info");
  }
});

watch(
  [infoCards, author, tabs, () => props.activeTab, () => props.locale],
  queueDetailsMeasurement,
  { flush: "post" },
);

onMounted(() => {
  desktopQuery = window.matchMedia?.("(min-width: 1040px)");
  if (window.ResizeObserver)
    layoutObserver = new window.ResizeObserver(queueDetailsMeasurement);
  desktopQuery?.addEventListener?.("change", updateLayoutViewport);
  window.addEventListener("resize", updateLayoutViewport, { passive: true });
  updateLayoutViewport();
});

onUnmounted(() => {
  layoutDisposed = true;
  if (layoutFrame) window.cancelAnimationFrame?.(layoutFrame);
  layoutObserver?.disconnect();
  desktopQuery?.removeEventListener?.("change", updateLayoutViewport);
  window.removeEventListener("resize", updateLayoutViewport);
});
</script>

<template>
  <div
    ref="infoColumnEl"
    class="rs-info-col"
    :class="{ 'rs-info-col--align-details': alignDetails }"
  >
    <div v-if="author" ref="authorCardEl" class="rs-card rs-card--author">
      <div class="rs-author-inner">
        <div class="rs-author-avatar-wrap">
          <img
            v-if="safeImageUrl(urlOf(author.avatar))"
            :src="safeImageUrl(urlOf(author.avatar))"
            class="rs-author-avatar"
            :alt="author.name || 'Author'"
            referrerpolicy="no-referrer"
            @error="emit('mark-image-broken', urlOf(author.avatar))"
          />
          <div v-else class="rs-author-avatar-fb">
            <AppIcon class="fas fa-user" />
          </div>
        </div>
        <div class="rs-author-detail">
          <div
            class="rs-author-name rs-copyable"
            @click="emit('copy-text', author.name)"
          >
            {{ author.name || t(locale, "unknownAuthor") }}
          </div>
          <div
            v-if="author.id"
            class="rs-author-id rs-copyable"
            @click="emit('copy-text', author.id)"
          >
            @{{ author.id }}
          </div>
          <div
            v-if="
              resultData.statistics?.likes?.state !== 'unverified' &&
              resultData.statistics?.likes
            "
            class="rs-author-likes"
          >
            <AppIcon class="fas fa-heart" />{{
              t(locale, "infoLikes").replace(
                "{count}",
                formatNumber(resultData.statistics.likes.value),
              )
            }}
          </div>
        </div>
      </div>
    </div>

    <div ref="infoCardEl" class="rs-card rs-card--info">
      <nav ref="tabsEl" class="rs-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          @click="emit('update:active-tab', tab.key)"
          class="rs-tab"
          :class="{ 'rs-tab--on': activeTab === tab.key }"
        >
          <AppIcon :class="['fas', tab.icon]" /><span>{{ tab.label }}</span>
        </button>
      </nav>

      <div
        v-if="activeTab === 'info' || canAlignDetails"
        ref="detailsPanelEl"
        class="rs-tab-panel rs-tab-panel--details"
        :class="{ 'rs-tab-panel--measure': activeTab !== 'info' }"
        :aria-hidden="activeTab !== 'info' ? 'true' : undefined"
        :inert="activeTab !== 'info' ? '' : undefined"
      >
        <div class="rs-info-list">
          <div
            v-for="card in infoCards"
            :key="card.label"
            class="rs-info-row rs-copyable"
            @click="emit('copy-text', card.value)"
          >
            <div class="rs-info-icon">
              <AppIcon :class="['fas', card.icon]" />
            </div>
            <div class="rs-info-text">
              <span class="rs-info-key">{{ card.label }}</span
              ><span class="rs-info-val">{{ card.value }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="activeTab === 'stats'" class="rs-tab-panel">
        <div class="rs-stat-grid">
          <div v-for="stat in stats" :key="stat.key" class="rs-stat-cell">
            <div class="rs-stat-icon">
              <AppIcon :class="['fas', stat.icon]" />
            </div>
            <div class="rs-stat-num">
              {{ stat.unverified ? "—" : formatNumber(stat.value) }}
            </div>
            <div class="rs-stat-label">{{ stat.label }}</div>
          </div>
        </div>
        <p v-if="stats.some((stat) => stat.unverified)" class="rs-stat-note">
          {{ playCountNote }}
        </p>
      </div>

      <ResultVariantPicker
        v-if="activeTab === 'backup'"
        ref="variantPickerRef"
        :locale="locale"
        :current-item-id="currentItem?.id"
        :quality-options="qualityOptions"
        :downloadable-count="downloadableCount"
        :other-quality-options="otherQualityOptions"
        :has-hidden-quality-variants="hasHiddenQualityVariants"
        :show-all-quality-variants="showAllQualityVariants"
        :unavailable-quality-reason="unavailableQualityReason"
        :higher-quality-notice="higherQualityNotice"
        :is-bilibili="isBilibili"
        :is-extension-connected="isExtensionConnected"
        :bilibili-dash-summary="bilibiliDashSummary"
        :display-variant-label="displayVariantLabel"
        :format-option-size="formatOptionSize"
        @select-quality="emit('select-quality', $event)"
        @toggle-show-all="emit('toggle-show-all-qualities')"
      />

      <div v-if="activeTab === 'tags'" class="rs-tab-panel">
        <div class="rs-tags-wrap">
          <span
            v-for="tag in allTags"
            :key="tag"
            class="rs-tag rs-tag--hash rs-copyable-tag"
            @click="emit('copy-text', tag)"
            ># {{ tag }}</span
          >
        </div>
      </div>

      <div v-if="activeTab === 'music'" class="rs-tab-panel">
        <div
          v-for="attachment in visibleAttachments"
          :key="attachment.id"
          class="rs-music"
        >
          <div class="rs-music-title">
            {{ attachment.title || t(locale, "unknownMusic") }}
          </div>
          <div v-if="attachment.author?.name" class="rs-music-artist">
            {{ attachment.author.name }}
          </div>
          <div
            v-if="isBilibiliDashAudio(attachment) && isExtensionConnected"
            class="rs-bili-audio-connected"
            data-bilibili-dash-audio-connected
          >
            <p class="rs-stat-note">
              {{ t(locale, "extAudioConnectedExplain") }}
            </p>
            <button
              type="button"
              class="rs-btn rs-btn--primary rs-btn--sm rs-btn--block"
              data-bilibili-dash-audio-ext-download
              @click="emit('download-music', attachment)"
            >
              <AppIcon class="fas fa-download" />
              <span>{{ t(locale, "extAudioDownloadCta") }}</span>
            </button>
          </div>
          <div
            v-else-if="isBilibiliDashAudio(attachment)"
            class="rs-bili-audio-guide"
            data-bilibili-dash-audio-guide
            role="status"
          >
            <p class="rs-bili-audio-guide-text">
              {{ t(locale, "biliDashAudioExplain") }}
            </p>
            <button
              type="button"
              class="rs-btn rs-btn--primary rs-btn--sm rs-btn--block rs-bili-audio-cta"
              data-bilibili-dash-audio-cta
              @click="emit('open-extension')"
            >
              <svg
                class="rs-bili-audio-ext-icon"
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
              <span>{{ t(locale, "biliDashAudioCta") }}</span>
            </button>
          </div>
          <template v-else>
            <audio
              v-if="
                attachment.role === 'background_audio' &&
                attachmentUrl(attachment)
              "
              :src="attachmentUrl(attachment)"
              controls
              class="rs-music-player"
            />
            <p v-else-if="!attachmentUrl(attachment)" class="rs-stat-note">
              该附件暂不支持直接播放
            </p>
            <button
              @click="emit('download-music', attachment)"
              class="rs-btn rs-btn--primary rs-btn--sm rs-btn--block"
              :disabled="isYouTubeHelperBlocked"
            >
              <AppIcon class="fas fa-download" />{{
                locale === "en" ? "Download" : "下载附件"
              }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rs-info-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
@media (min-width: 1040px) {
  .rs-info-col {
    position: sticky;
    top: 1rem;
  }
  .rs-info-col--align-details {
    max-height: var(--rs-details-column-height);
  }
  .rs-info-col--align-details .rs-card--author,
  .rs-info-col--align-details .rs-tabs {
    flex-shrink: 0;
  }
  .rs-info-col--align-details .rs-card--info {
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-height: var(--rs-details-card-height);
  }
  .rs-info-col--align-details :deep(.rs-tab-panel:not(.rs-tab-panel--details)) {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior-y: contain;
  }
}

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

.rs-card--author {
  background: linear-gradient(
    135deg,
    rgba(108, 92, 231, 0.05) 0%,
    rgba(168, 85, 247, 0.03) 50%,
    rgba(236, 72, 153, 0.02) 100%
  );
  border: 1px solid rgba(108, 92, 231, 0.1);
}
.rs-author-inner {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 1.125rem 1.25rem;
}
.rs-author-avatar-wrap {
  position: relative;
  flex-shrink: 0;
}
.rs-author-avatar {
  width: 3rem;
  height: 3rem;
  border-radius: var(--r-md);
  object-fit: cover;
  box-shadow: 0 0 0 2px var(--c-bg-elevated), 0 0 0 4px rgba(108, 92, 231, 0.15),
    0 4px 12px rgba(0, 0, 0, 0.08);
  transition: transform var(--t-fast);
}
.rs-author-avatar-fb {
  width: 3rem;
  height: 3rem;
  border-radius: var(--r-md);
  background: linear-gradient(135deg, var(--c-bg-3), var(--c-bg-2));
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-fg-3);
  font-size: 1.125rem;
  box-shadow: 0 0 0 2px var(--c-bg-elevated), 0 0 0 4px rgba(108, 92, 231, 0.1),
    0 4px 12px rgba(0, 0, 0, 0.06);
}
.rs-author-inner:hover .rs-author-avatar {
  transform: scale(1.05);
}
.rs-author-detail {
  min-width: 0;
}
.rs-author-name {
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--c-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rs-author-id {
  font-size: 0.6875rem;
  color: var(--c-fg-3);
  margin-top: 0.1rem;
}
.rs-author-likes {
  display: flex;
  align-items: center;
  gap: 0.2rem;
  font-size: 0.6875rem;
  color: var(--c-accent-3);
  margin-top: 0.15rem;
}
.rs-copyable {
  position: relative;
  cursor: pointer;
  transition: all var(--t-fast);
}
.rs-copyable:hover {
  color: var(--c-accent);
}
.rs-info-row.rs-copyable {
  padding-right: 1.5rem;
}
.rs-info-row.rs-copyable:hover {
  background: rgba(108, 92, 231, 0.04);
  border-radius: var(--r-sm);
}

.rs-tabs {
  display: flex;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  border-bottom: 1px solid var(--c-border);
  padding: 0 0.5rem;
  gap: 0;
}
.rs-tabs::-webkit-scrollbar {
  display: none;
}
.rs-tab {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.7rem 0.75rem;
  border: none;
  background: none;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--c-fg-3);
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: all var(--t-fast);
  font-family: inherit;
}
.rs-tab:hover {
  color: var(--c-fg-2);
}
.rs-tab--on {
  color: var(--c-accent);
  border-bottom-color: var(--c-accent);
  font-weight: 600;
}
.rs-tab-panel {
  padding: 1rem 1.125rem;
  animation: rsFadeIn 0.2s ease;
}
.rs-tab-panel--details {
  flex-shrink: 0;
}
.rs-tab-panel--measure {
  position: absolute;
  inset: 0 0 auto;
  visibility: hidden;
  pointer-events: none;
  animation: none;
}

.rs-info-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.rs-info-row {
  display: flex;
  gap: 0.625rem;
  padding: 0.625rem 0.75rem;
  background: var(--c-bg-2);
  border-radius: var(--r-md);
  border: 1px solid var(--c-border-2);
  transition: border-color var(--t-fast), background var(--t-fast);
}
.rs-info-row:hover {
  border-color: rgba(108, 92, 231, 0.2);
  background: linear-gradient(
    135deg,
    rgba(108, 92, 231, 0.02) 0%,
    rgba(168, 85, 247, 0.02) 100%
  );
}
.rs-info-icon {
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.4rem;
  background: rgba(108, 92, 231, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-accent);
  font-size: 0.7rem;
  flex-shrink: 0;
}
.rs-info-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.rs-info-key {
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--c-fg-3);
}
.rs-info-val {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--c-fg);
  line-height: 1.35;
  word-break: break-all;
}

.rs-stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(95px, 1fr));
  gap: 0.5rem;
}
.rs-stat-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  padding: 0.75rem 0.4rem;
  background: var(--c-bg-2);
  border-radius: var(--r-md);
  border: 1px solid var(--c-border-2);
  transition: all var(--t-fast);
}
.rs-stat-cell:hover {
  border-color: rgba(108, 92, 231, 0.18);
  transform: translateY(-1px);
  box-shadow: var(--sh-sm);
}
.rs-stat-icon {
  font-size: 0.95rem;
  color: var(--c-accent);
}
.rs-stat-num {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--c-fg);
  font-variant-numeric: tabular-nums;
}
.rs-stat-note {
  margin-top: 0.6rem;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--c-fg-3);
}
.rs-stat-label {
  font-size: 0.625rem;
  color: var(--c-fg-3);
  font-weight: 500;
}

.rs-tags-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.rs-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 600;
  transition: all var(--t-fast);
  position: relative;
  overflow: hidden;
}
.rs-tag--hash {
  background: linear-gradient(
    135deg,
    rgba(108, 92, 231, 0.08) 0%,
    rgba(168, 85, 247, 0.06) 100%
  );
  color: var(--c-accent);
  border: 1px solid rgba(108, 92, 231, 0.15);
  box-shadow: 0 1px 2px rgba(108, 92, 231, 0.08);
}
.rs-tag--hash:hover {
  background: linear-gradient(
    135deg,
    rgba(108, 92, 231, 0.12) 0%,
    rgba(168, 85, 247, 0.1) 100%
  );
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(108, 92, 231, 0.15);
}
.rs-copyable-tag {
  position: relative;
  cursor: pointer;
}

.rs-music {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}
.rs-music-title {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--c-fg);
}
.rs-music-artist {
  font-size: 0.6875rem;
  color: var(--c-fg-3);
  margin-top: 0.1rem;
}
.rs-music-player {
  width: 100%;
  height: 2.25rem;
  border-radius: 999px;
}
.rs-bili-audio-guide {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 0.75rem 0.85rem;
  border-radius: var(--r-md);
  background: linear-gradient(
    135deg,
    rgba(108, 92, 231, 0.08) 0%,
    rgba(168, 85, 247, 0.05) 100%
  );
  border: 1px solid rgba(108, 92, 231, 0.22);
  text-align: left;
}
:global(.dark) .rs-bili-audio-guide {
  background: linear-gradient(
    135deg,
    rgba(129, 140, 248, 0.14) 0%,
    rgba(168, 85, 247, 0.08) 100%
  );
  border-color: rgba(129, 140, 248, 0.32);
}
.rs-bili-audio-guide-text {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--c-fg-2);
}
.rs-bili-audio-ext-icon {
  width: 0.85rem;
  height: 0.85rem;
  flex-shrink: 0;
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
@media (max-width: 480px) {
  .rs-card {
    border-radius: var(--r-lg);
  }
  .rs-stat-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>
