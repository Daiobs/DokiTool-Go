<script setup>
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import AppIcon from "./AppIcon.vue";
import ResultVideoStageCard from "./result/ResultVideoStageCard.vue";
import ResultGalleryCard from "./result/ResultGalleryCard.vue";
import ResultLivePhotoCard from "./result/ResultLivePhotoCard.vue";
import ResultDetailsSidebar from "./result/ResultDetailsSidebar.vue";
import CapabilityUpgradeNotice from "./result/CapabilityUpgradeNotice.vue";
import {
  LATEST_EXTENSION_VERSION,
  isExtensionVersionOutdated,
} from "../core/capabilityHub";
import { useExtensionRuntime } from "../composables/useExtensionRuntime";
import {
  deliveryRoutes,
  readyItem,
  readyVariant,
  getDownloadTarget,
  sourceUrl,
} from "../utils/mediaContract";
import {
  isAudioOnlyVariant,
  isCorsBlockedDirectUrl,
  isRefererBlockedWebImageUrl,
  isSplitSilentVideoVariant,
  isTbvideoVideoItem,
  listSubtitleTracks,
  resolveEffectiveDefaultVariant,
  resolveWhitelistedExtensionMuxSpec,
  shouldAutoUpgradeDefaultVariant,
} from "../core/media";
import {
  variantLabel,
  groupVariantsForDisplay,
} from "../utils/mediaSources";
import { selectYouTubeMuxPair } from "../utils/youtubeHelperCore";
import { resolvePlatformPresentation } from "../utils/platforms";
import { apiConfig } from "../services/apiConfig";
import { t, stripSilentOnlyNotice } from "./result/resultI18n";
import {
  buildAllQualityOptions,
  formatYouTubeMuxOptionSize,
  formatHeaderReadyStatus,
  formatHeaderReadyTitle,
  buildPlayerQualityTagText,
  resolvePrimaryDownloadCtaLabel,
  extractMuxVariants,
  summarizeMuxTiers,
} from "./result/resultPresentation";

const props = defineProps({
  resultData: Object,
  resultVersion: Number,
  locale: String,
  selection: Object,
  isDownloading: Boolean,
  resolvingIds: Object,
  formatNumber: Function,
  formatDuration: Function,
  extensionState: { type: Object, default: null },
  latestExtensionVersion: { type: String, default: "" },
});

const emit = defineEmits([
  "download-main",
  "download-separate",
  "download-backup",
  "download-all",
  "download-images",
  "download-image",
  "download-music",
  "download-live-video",
  "download-live-cover",
  "download-all-live",
  "download-all-live-covers",
  "copy-url",
  "switch-video",
  "select-video",
  "toggle-video",
  "select-all-videos",
  "clear-selection",
  "select-collection",
  "download-index",
  "download-selected",
  "download-all-videos",
  "download-selected-zip",
  "download-all-zip",
  "refresh-item",
  "prompt-select-quality",
  "open-extension",
  "extension-youtube-ready",
  "extension-state-change",
]);

const context = { apiOrigin: apiConfig.baseUrl };
const urlOf = (source) => (source ? sourceUrl(source, context) : "");
const brokenImageUrls = ref({});
const safeImageUrl = (raw) =>
  raw && !brokenImageUrls.value[raw] && !isRefererBlockedWebImageUrl(raw)
    ? raw
    : "";
const markImageBroken = (raw) => {
  if (raw && !brokenImageUrls.value[raw]) {
    brokenImageUrls.value = { ...brokenImageUrls.value, [raw]: true };
  }
};

const currentItem = computed(() => props.selection?.currentVideo.value || null);
const target = computed(() => props.selection?.currentTarget.value || null);
const muxVariants = computed(() =>
  extractMuxVariants(currentItem.value, context),
);
const hasMuxVariants = computed(() => muxVariants.value.length > 0);
const bilibiliDashSummary = computed(() => summarizeMuxTiers(muxVariants.value));
const youtubeHelper = computed(
  () => props.resultData?.extra?.youtube_helper || null,
);
const isYouTubeHelperBlocked = computed(
  () =>
    !!youtubeHelper.value &&
    ["missing", "outdated", "login_required"].includes(
      youtubeHelper.value.status,
    ),
);
const isYouTubeHelperReady = computed(
  () => youtubeHelper.value?.status === "ready",
);
const isYouTubeHelperInstallRequired = computed(
  () =>
    youtubeHelper.value?.status === "missing" ||
    youtubeHelper.value?.status === "outdated",
);

const isClientMounted = ref(false);
const ytHelperModalDismissed = ref(false);
const imageModalOpen = ref(false);
const ytHelperModalOpen = computed(
  () => isYouTubeHelperInstallRequired.value && !ytHelperModalDismissed.value,
);

const fallbackRuntime = props.extensionState ? null : useExtensionRuntime();
const extensionBridgeState = computed(
  () =>
    props.extensionState ||
    fallbackRuntime?.extensionState.value || {
      connected: false,
      version: "",
      extensionId: "",
      capabilities: [],
    },
);
const effectiveLatestExtensionVersion = computed(
  () =>
    (props.latestExtensionVersion || "").trim() || LATEST_EXTENSION_VERSION,
);
const isExtensionConnected = computed(() =>
  Boolean(extensionBridgeState.value.connected),
);
const isExtensionOutdated = computed(
  () =>
    isExtensionConnected.value &&
    isExtensionVersionOutdated(
      extensionBridgeState.value.version,
      effectiveLatestExtensionVersion.value,
    ),
);
const canExtensionDashMux = computed(
  () =>
    isExtensionConnected.value &&
    Array.isArray(extensionBridgeState.value.capabilities) &&
    extensionBridgeState.value.capabilities.includes("dash_mux"),
);
const canExtensionYouTubeParse = computed(
  () =>
    isExtensionConnected.value &&
    Array.isArray(extensionBridgeState.value.capabilities) &&
    extensionBridgeState.value.capabilities.includes("youtube_parse"),
);

const activeVariant = computed(() =>
  target.value && "variant" in target.value
    ? target.value.variant
    : readyItem(currentItem.value)
      ? currentItem.value.variants.find(
          (v) => v.id === props.selection?.currentSelection.value?.variant_id,
        )
      : null,
);
const isActiveExtensionDashMux = computed(() =>
  Boolean(
    canExtensionDashMux.value &&
      activeVariant.value &&
      readyVariant(activeVariant.value) &&
      resolveWhitelistedExtensionMuxSpec(activeVariant.value, context) !== null,
  ),
);
const playableFallbackVideoUrl = computed(() => {
  if (!readyItem(currentItem.value)) return "";
  const defaultDecision = getDownloadTarget(currentItem.value, null, context);
  if (
    defaultDecision.kind === "file" &&
    defaultDecision.variant.metadata?.has_audio !== false
  ) {
    return defaultDecision.url;
  }
  const audibleVariant = currentItem.value.variants.find(
    (v) =>
      readyVariant(v) &&
      v.delivery.kind === "file" &&
      !isAudioOnlyVariant(v) &&
      v.metadata?.has_audio !== false,
  );
  if (audibleVariant) {
    const decision = getDownloadTarget(
      currentItem.value,
      { variant_id: audibleVariant.id },
      context,
    );
    if (decision.kind === "file") return decision.url;
  }
  if (defaultDecision.kind === "file") return defaultDecision.url;
  const fileVariant = currentItem.value.variants.find(
    (v) => readyVariant(v) && v.delivery.kind === "file",
  );
  if (!fileVariant) return "";
  const decision = getDownloadTarget(
    currentItem.value,
    { variant_id: fileVariant.id },
    context,
  );
  return decision.kind === "file" ? decision.url : "";
});
const playableAudibleFallbackVideoUrl = computed(() => {
  if (!readyItem(currentItem.value)) return "";
  const defaultDecision = getDownloadTarget(currentItem.value, null, context);
  if (
    defaultDecision.kind === "file" &&
    !isAudioOnlyVariant(defaultDecision.variant) &&
    defaultDecision.variant.metadata?.has_audio !== false
  ) {
    return defaultDecision.url;
  }
  const audibleVariant = currentItem.value.variants.find(
    (v) =>
      readyVariant(v) &&
      v.delivery.kind === "file" &&
      !isAudioOnlyVariant(v) &&
      v.metadata?.has_audio !== false,
  );
  if (!audibleVariant) return "";
  const decision = getDownloadTarget(
    currentItem.value,
    { variant_id: audibleVariant.id },
    context,
  );
  return decision.kind === "file" ? decision.url : "";
});
const isActiveRefererProtectedVideo = computed(() =>
  Boolean(
    target.value?.kind === "file" &&
      target.value.source?.browser_fetch === "blocked" &&
      currentItem.value?.type === "video",
  ),
);
const activeVideoUrl = computed(() => {
  if (isYouTubeHelperBlocked.value) return "";
  if (isActiveRefererProtectedVideo.value) return "";
  if (
    target.value?.kind === "file" &&
    isActiveYouTubeSplitVideo.value &&
    activeYouTubeMuxPair.value &&
    playableAudibleFallbackVideoUrl.value
  ) {
    return playableAudibleFallbackVideoUrl.value;
  }
  if (target.value?.kind === "file") return target.value.url;
  if (isActiveExtensionDashMux.value) return playableFallbackVideoUrl.value;
  return "";
});
const copyVideoUrl = computed(() => {
  if (isActiveExtensionDashMux.value || isYouTubeHelperBlocked.value) {
    return "";
  }
  if (target.value?.kind === "file") {
    return target.value.url;
  }
  if (
    target.value?.kind === "hls" &&
    target.value.variant?.delivery?.kind === "hls"
  ) {
    try {
      const routes = deliveryRoutes(
        target.value.variant.delivery.sources,
        context,
      );
      if (routes.length > 0) return routes[0];
      const fallbackSource = target.value.variant.delivery.sources.find(
        (src) => src?.availability !== "unavailable",
      );
      return fallbackSource ? sourceUrl(fallbackSource, context) : "";
    } catch {
      return "";
    }
  }
  return "";
});
const metadata = computed(() => activeVariant.value?.metadata || {});
const attachments = computed(() => props.resultData?.attachments || []);
const subtitleTrackCount = computed(() => listSubtitleTracks(props.resultData, apiConfig.baseUrl).length);
const openSubtitlesTab = () => { activeTab.value = "subtitles"; };

const isYouTubeAudioOnlyVariant = (variant) =>
  Boolean(youtubeHelper.value) && isAudioOnlyVariant(variant);
const isActiveYouTubeSplitVideo = computed(
  () =>
    Boolean(youtubeHelper.value) &&
    isSplitSilentVideoVariant(currentItem.value, activeVariant.value),
);
const isActiveYouTubeAudioOnly = computed(() =>
  isYouTubeAudioOnlyVariant(activeVariant.value),
);
const youtubeMuxPairsByVariantId = computed(() => {
  const map = new Map();
  if (
    !isYouTubeHelperReady.value ||
    currentItem.value?.type !== "video" ||
    !readyItem(currentItem.value)
  ) {
    return map;
  }
  const itemVariants = currentItem.value.variants;
  const itemAttachments = attachments.value;
  for (const variant of itemVariants) {
    if (
      variant?.state !== "deferred" &&
      variant?.metadata?.has_audio === false
    ) {
      const pair = selectYouTubeMuxPair(variant, itemVariants, itemAttachments);
      if (pair?.ok) map.set(variant.id, pair);
    }
  }
  return map;
});
const activeYouTubeMuxPair = computed(() =>
  activeVariant.value?.id
    ? youtubeMuxPairsByVariantId.value.get(activeVariant.value.id) || null
    : null,
);

const displayVariantLabel = (variant) => {
  const raw = variantLabel(variant, props.locale);
  if (!variant) return raw;
  if (youtubeMuxPairsByVariantId.value.has(variant.id)) {
    const stripped = stripSilentOnlyNotice(raw);
    const out = stripped || raw;
    return props.locale === "en" && out === "自适应" ? "Adaptive" : out;
  }
  return raw;
};

const formatOptionSize = (option) =>
  formatYouTubeMuxOptionSize(
    option,
    youtubeMuxPairsByVariantId.value,
    props.locale,
    currentItem.value?.duration_ms,
  );

const hasVideo = computed(
  () =>
    currentItem.value && ["video", "audio"].includes(currentItem.value.type),
);
const imageItems = computed(() =>
  props.resultData.items.filter((item) => item.type === "image"),
);
const liveItems = computed(() =>
  props.resultData.items.filter((item) => item.type === "live_photo"),
);
const hasImages = computed(() => imageItems.value.length > 0);
const hasLivePhotos = computed(() => liveItems.value.length > 0);
const isMulti = computed(() => props.selection?.isMulti.value);
const currentIndex = computed(() => props.selection?.selectedIndex.value ?? 0);
const visibleVideos = computed(() => props.selection?.visibleList.value || []);
const collections = computed(() => props.selection?.collections.value || []);
const activeCollection = computed(
  () => props.selection?.sectionIndex.value || 0,
);
const selectedCount = computed(() => props.selection?.selectedCount.value || 0);
const batchZipAvailable = computed(() => {
  const items = selectedCount.value
    ? props.selection.getBatchVideos()
    : props.selection.list.value;
  return !items.some((item) => {
    if (isTbvideoVideoItem(item)) return true;
    const itemTarget = getDownloadTarget(
      item,
      props.selection?.selectionFor?.(item.id) || null,
      context,
    );
    if (itemTarget?.kind !== "file") return false;
    return (
      itemTarget.source?.browser_fetch === "blocked" ||
      isCorsBlockedDirectUrl(itemTarget.url) ||
      (itemTarget.routes || []).some((route) => isCorsBlockedDirectUrl(route))
    );
  });
});
const selectedTotal = computed(() => props.selection?.total.value || 0);
const isResolving = computed(() =>
  props.resolvingIds?.has(currentItem.value?.id),
);

const allQualityOptions = computed(() =>
  buildAllQualityOptions(
    currentItem.value,
    props.selection?.currentSelection.value,
    target.value,
    context,
    {
      allowExtensionDashMux: canExtensionDashMux.value,
      muxPairsByVariantId: youtubeMuxPairsByVariantId.value,
    },
  ),
);
watch(
  () => [
    props.resultVersion,
    currentItem.value?.id,
    currentItem.value?.state,
    readyItem(currentItem.value) ? currentItem.value.variants.length : 0,
    canExtensionDashMux.value,
    isYouTubeHelperReady.value,
    youtubeMuxPairsByVariantId.value.size,
  ],
  () => {
    const item = currentItem.value;
    if (!item || !readyItem(item) || !item.default?.variant_id) return;
    if (typeof props.selection?.applyAutoChoice !== "function") return;
    if (props.selection?.hasManualChoice?.(item.id)) return;
    const options = allQualityOptions.value;
    const best = resolveEffectiveDefaultVariant(options, null);
    const defaultOption =
      options.find((opt) => opt.variant.id === item.default?.variant_id) ||
      null;
    if (!shouldAutoUpgradeDefaultVariant(defaultOption, best)) return;
    const currentVariantId =
      props.selection?.currentSelection?.value?.variant_id ||
      item.default.variant_id;
    if (best && best.variant.id !== currentVariantId) {
      props.selection.applyAutoChoice(
        {
          variant_id: best.variant.id,
          ...(best.source?.id ? { source_id: best.source.id } : {}),
        },
        item.id,
      );
    }
  },
  { immediate: true },
);
const showAllQualityVariants = ref(false);
const downloadableQualityOptions = computed(() =>
  allQualityOptions.value.filter((option) => option.downloadable),
);
const otherQualityOptions = computed(() =>
  allQualityOptions.value.filter((option) => !option.downloadable),
);
const higherQualityNotice = computed(
  () => (currentItem.value?.higher_quality_variants?.length || 0) > 0,
);
const unavailableQualityReason = computed(() => {
  if (
    !currentItem.value ||
    downloadableQualityOptions.value.some(
      (option) => option.downloadTarget.kind === "file",
    )
  )
    return "";
  const decision = getDownloadTarget(currentItem.value, null, context);
  return props.locale === "en"
    ? "No complete downloadable file is currently available."
    : `暂无可直接下载的完整文件。${"message" in decision ? decision.message : ""}`;
});
const qualityGroups = computed(() =>
  groupVariantsForDisplay(
    downloadableQualityOptions.value.map((option) => option.variant),
  ),
);
const hasHiddenQualityVariants = computed(
  () => qualityGroups.value.length < downloadableQualityOptions.value.length,
);
const qualityOptions = computed(() => {
  if (showAllQualityVariants.value) return downloadableQualityOptions.value;
  const optionsById = new Map(
    downloadableQualityOptions.value.map((option) => [
      option.variant.id,
      option,
    ]),
  );
  return qualityGroups.value.map((group) => {
    const options = group.map((variant) => optionsById.get(variant.id));
    return options.find((option) => option.active) || options[0];
  });
});
const hasBackup = computed(() => allQualityOptions.value.length > 0);
const isTargetBlocked = computed(
  () =>
    !isActiveExtensionDashMux.value &&
    (!target.value ||
      target.value.kind === "unsupported" ||
      target.value.kind === "unavailable" ||
      target.value.kind === "invalid"),
);
const needsQualitySelection = computed(
  () =>
    !isYouTubeHelperBlocked.value &&
    !isResolving.value &&
    isTargetBlocked.value &&
    downloadableQualityOptions.value.length > 0,
);

const targetMessage = computed(() => {
  const hasCjk = (value) => /[\u4e00-\u9fff]/.test(String(value || ""));
  if (isYouTubeHelperBlocked.value) {
    const helperMsg = youtubeHelper.value?.message;
    if (helperMsg && !(props.locale === "en" && hasCjk(helperMsg))) {
      return helperMsg;
    }
    return props.locale === "en"
      ? "Please install and enable the DokiTool Chrome extension before downloading"
      : "请先安装并启用 DokiTool Chrome 官方扩展后再下载";
  }
  if (isActiveRefererProtectedVideo.value) {
    return t(
      props.locale,
      isExtensionConnected.value
        ? "extDirectReadyOverlay"
        : "extDirectRequiredOverlay",
    );
  }
  if (target.value && "message" in target.value && target.value.message) {
    if (props.locale === "en" && hasCjk(target.value.message)) {
      return "This version requires processing before download and cannot play directly here";
    }
    return target.value.message;
  }
  if (target.value?.kind === "file") {
    return "";
  }
  return props.locale === "en"
    ? "This version requires processing before download and cannot play directly here"
    : "该版本需要处理后下载，暂不能在播放器直接播放";
});
const sourceHint = computed(() =>
  t(
    props.locale,
    target.value?.kind === "file" && target.value.source.access === "relay"
      ? "relaySourceHint"
      : "sourceHint",
  ),
);
const youtubeHelperDisplayVersion = computed(() =>
  youtubeHelper.value?.provider === "extension"
    ? youtubeHelper.value?.extensionVersion ||
      youtubeHelper.value?.version ||
      extensionBridgeState.value.version ||
      null
    : youtubeHelper.value?.version,
);
const headerStatusText = computed(() =>
  isYouTubeHelperReady.value
    ? formatHeaderReadyStatus(
        youtubeHelperDisplayVersion.value,
        props.locale,
        youtubeHelper.value?.provider,
      )
    : sourceHint.value,
);
const headerStatusTitle = computed(() =>
  isYouTubeHelperReady.value
    ? formatHeaderReadyTitle(
        youtubeHelperDisplayVersion.value,
        props.locale,
        youtubeHelper.value?.provider,
      )
    : undefined,
);
const playerQualityTagText = computed(() =>
  buildPlayerQualityTagText(
    activeVariant.value,
    displayVariantLabel(activeVariant.value),
    Boolean(activeYouTubeMuxPair.value),
    props.locale,
  ),
);
const primaryDownloadLabel = computed(() => {
  if (isActiveRefererProtectedVideo.value && !needsQualitySelection.value) {
    return t(
      props.locale,
      isExtensionConnected.value
        ? "downloadViaExtension"
        : "installExtensionToDownload",
    );
  }
  if (
    !needsQualitySelection.value &&
    currentItem.value?.type === "audio" &&
    !isActiveYouTubeAudioOnly.value
  ) {
    return t(props.locale, "downloadAudio");
  }
  return resolvePrimaryDownloadCtaLabel({
    locale: props.locale,
    needsQualitySelection: needsQualitySelection.value,
    isActiveYouTubeSplitVideo: isActiveYouTubeSplitVideo.value,
    hasActiveYouTubeMuxPair: Boolean(activeYouTubeMuxPair.value),
    isActiveYouTubeAudioOnly: isActiveYouTubeAudioOnly.value,
    activeVariant: activeVariant.value,
  });
});
const platformPresentation = computed(() =>
  resolvePlatformPresentation(
    props.resultData?.platform,
    props.locale,
    currentItem.value?.type,
  ),
);
const mediaTypeBadge = computed(() => {
  const itemType = currentItem.value?.type;
  const isAudio = !hasImages.value && itemType === "audio";
  const isLive = !isMulti.value && !hasImages.value && itemType === "live_photo";
  return {
    icon: hasImages.value
      ? "fa-images"
      : isAudio
        ? "fa-music"
        : "fa-play",
    text: isMulti.value
      ? t(props.locale, "collection")
      : t(
          props.locale,
          itemType === "live_photo"
            ? "live"
            : itemType === "image"
              ? "images"
              : itemType === "audio"
                ? "audio"
                : "video",
        ),
    style: hasImages.value
      ? "image"
      : isLive
        ? "live"
        : isAudio
          ? "audio"
          : "video",
  };
});

const activeTab = ref("info");
const sidebarRef = ref(null);
const playbackFailed = ref(false);
const detectedDurationSeconds = ref(0);
const manualSelection = ref(0);
const handleDurationDetected = (rawSeconds) => {
  const sec = Number(rawSeconds);
  if (Number.isFinite(sec) && sec > 0) {
    detectedDurationSeconds.value = sec;
  }
};
const mediaIdentity = computed(() =>
  JSON.stringify([props.resultVersion, currentItem.value?.id]),
);
const playerKey = computed(() =>
  JSON.stringify([
    mediaIdentity.value,
    activeVideoUrl.value,
    manualSelection.value,
  ]),
);
const mainPosterUrl = computed(() =>
  safeImageUrl(urlOf(currentItem.value?.cover || props.resultData?.cover)),
);

const attemptedSources = new Set();
watch(mediaIdentity, () => {
  attemptedSources.clear();
  playbackFailed.value = false;
  detectedDurationSeconds.value = 0;
  brokenImageUrls.value = {};
  activeTab.value = "info";
  showAllQualityVariants.value = false;
});
watch(activeVideoUrl, () => {
  playbackFailed.value = false;
});

const selectQuality = (option) => {
  if (!option.downloadable) return;
  manualSelection.value++;
  attemptedSources.clear();
  playbackFailed.value = false;
  emit("switch-video", { variant_id: option.variant.id });
};

const originalPageUrl = computed(() => {
  try {
    const raw = currentItem.value?.source_url || props.resultData.source_url;
    return raw ? sourceUrl({ url: raw }) : "";
  } catch {
    return "";
  }
});

const updatePlaybackStatus = (event, failed) => {
  const element = event?.currentTarget || event?.target;
  if (
    !element ||
    (element.dataset?.playbackKey ||
      element.getAttribute?.("data-playback-key") ||
      element.props?.["data-playback-key"]) !== playerKey.value ||
    (element.currentSrc && element.currentSrc !== activeVideoUrl.value)
  )
    return;
  if (!failed) {
    playbackFailed.value = false;
    return;
  }
  if (target.value?.kind !== "file") return;
  if (activeVideoUrl.value !== target.value.url) {
    playbackFailed.value = true;
    return;
  }
  attemptedSources.add(target.value.url);
  const next = target.value.routes.find((url) => !attemptedSources.has(url));
  if (next && attemptedSources.size < 3) {
    const source = target.value.variant.delivery.sources.find(
      (candidate) => urlOf(candidate) === next,
    );
    if (source) {
      emit("switch-video", {
        variant_id: target.value.variant.id,
        ...(source.id ? { source_id: source.id } : {}),
      });
      return;
    }
  }
  playbackFailed.value = true;
};

const showCopyToast = ref(false);
const copyToastText = ref("");
let copyTimer;
const copyToClipboard = async (text) => {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(String(text));
    copyToastText.value = String(text);
    showCopyToast.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (showCopyToast.value = false), 2000);
  } catch {
    emit("copy-url", text);
  }
};

const syncBodyScrollLock = () => {
  if (typeof document === "undefined" || !document.body) return;
  document.body.style.overflow = imageModalOpen.value ? "hidden" : "";
};
const closeYtHelperModal = () => {
  ytHelperModalDismissed.value = true;
};
const openYtHelperModal = () => {
  ytHelperModalDismissed.value = false;
};
const onImageModalOpenChange = (open) => {
  imageModalOpen.value = open;
  syncBodyScrollLock();
};

watch(
  () => props.resultVersion,
  () => {
    ytHelperModalDismissed.value = false;
    imageModalOpen.value = false;
    syncBodyScrollLock();
  },
);
watch(
  () => youtubeHelper.value?.status,
  () => {
    ytHelperModalDismissed.value = false;
  },
);

const extConnectedTitleText = computed(() => {
  const ver = extensionBridgeState.value.version
    ? ` (v${extensionBridgeState.value.version})`
    : "";
  return `${t(props.locale, "extConnectedTitle")}${ver}`;
});
const extUpdateBadgeText = computed(() =>
  t(props.locale, "extUpdateBadge").replace(
    "{version}",
    effectiveLatestExtensionVersion.value,
  ),
);
const extUpdateBadgeTitle = computed(() =>
  t(props.locale, "extUpdateBadgeTitle").replace(
    "{version}",
    effectiveLatestExtensionVersion.value,
  ),
);
const extInstallHintText = computed(() => {
  const maxRes = bilibiliDashSummary.value?.maxResolution;
  if (maxRes) {
    return t(props.locale, "extInstallHintWithRes").replace("{res}", maxRes);
  }
  return t(props.locale, "extInstallHintGeneric");
});

let autoReparseTriggeredVersion = -1;
let allowAutoReparse = false;
const triggerAutoReparseIfReady = () => {
  if (
    allowAutoReparse &&
    isYouTubeHelperInstallRequired.value &&
    canExtensionYouTubeParse.value &&
    autoReparseTriggeredVersion !== props.resultVersion
  ) {
    autoReparseTriggeredVersion = props.resultVersion;
    ytHelperModalDismissed.value = true;
    emit("extension-youtube-ready");
  }
};
watch(canExtensionYouTubeParse, (ready, prevReady) => {
  if (!prevReady && ready) {
    triggerAutoReparseIfReady();
  }
});
const handleStandaloneWindowReturn = () => {
  if (
    !fallbackRuntime ||
    (typeof document !== "undefined" && document.visibilityState === "hidden")
  ) {
    return;
  }
  allowAutoReparse = true;
  void fallbackRuntime.probeExtension().then((state) => {
    emit("extension-state-change", {
      connected: Boolean(state.connected),
      version: state.version || "",
    });
    triggerAutoReparseIfReady();
  });
};

onMounted(() => {
  isClientMounted.value = true;
  syncBodyScrollLock();
  if (fallbackRuntime) {
    void fallbackRuntime.probeExtension().then((state) => {
      emit("extension-state-change", {
        connected: Boolean(state.connected),
        version: state.version || "",
      });
      allowAutoReparse = true;
    });
    if (typeof document !== "undefined") {
      document.addEventListener?.("visibilitychange", handleStandaloneWindowReturn);
    }
    if (typeof window !== "undefined") {
      window.addEventListener?.("focus", handleStandaloneWindowReturn);
    }
  } else {
    allowAutoReparse = true;
  }
});
onUnmounted(() => {
  fallbackRuntime?.dispose();
  if (typeof document !== "undefined") {
    if (fallbackRuntime) {
      document.removeEventListener?.("visibilitychange", handleStandaloneWindowReturn);
    }
    if (document.body) {
      document.body.style.overflow = "";
    }
  }
  if (fallbackRuntime && typeof window !== "undefined") {
    window.removeEventListener?.("focus", handleStandaloneWindowReturn);
  }
  clearTimeout(copyTimer);
});

const openQualityPicker = (notify = false) => {
  activeTab.value = "backup";
  if (notify) emit("prompt-select-quality");
  nextTick(() => {
    sidebarRef.value?.focusFirstQualityOption?.();
  });
};
const handlePrimaryDownloadClick = () => {
  if (needsQualitySelection.value) {
    openQualityPicker(true);
    return;
  }
  if (isActiveRefererProtectedVideo.value && !isExtensionConnected.value) {
    emit("open-extension");
    return;
  }
  emit("download-main");
};
const handleSelectLiveQuality = (item) => {
  props.selection.selectItem(item.id);
  activeTab.value = "backup";
};

const detailsCardHeight = ref(0);
const detailsColumnHeight = ref(0);
const canAlignBase = computed(
  () =>
    Boolean(hasVideo.value) &&
    !isMulti.value &&
    !hasImages.value &&
    !hasLivePhotos.value,
);
const hasDetailsBaseline = computed(
  () => canAlignBase.value && detailsColumnHeight.value > 0,
);
const detailsLayoutStyle = computed(() =>
  hasDetailsBaseline.value
    ? {
        "--rs-details-card-height": `${detailsCardHeight.value}px`,
        "--rs-details-column-height": `${detailsColumnHeight.value}px`,
      }
    : undefined,
);
const onBaselineChange = ({ cardHeight, columnHeight }) => {
  detailsCardHeight.value = cardHeight;
  detailsColumnHeight.value = columnHeight;
};
</script>

<template>
  <section
    v-if="resultData"
    class="rs"
    role="region"
    :aria-label="t(locale, 'resultTitle')"
  >
    <div class="rs-header">
      <div class="rs-header-inner">
        <div class="rs-header-left">
          <div class="rs-status-dot-wrapper">
            <div class="rs-status-dot"></div>
            <div class="rs-status-dot-pulse"></div>
          </div>
          <span class="rs-header-title">{{ t(locale, "resultTitle") }}</span
          ><span
            v-if="platformPresentation.id"
            data-testid="result-platform-badge"
            :data-platform="platformPresentation.id"
            :data-platform-builtin="
              platformPresentation.isBuiltin ? 'true' : 'false'
            "
            class="rs-header-badge rs-header-badge--platform"
            :class="{
              'rs-header-badge--platform-generic':
                !platformPresentation.isBuiltin,
            }"
            ><AppIcon :class="['fas', platformPresentation.icon]" /><span
              class="rs-header-badge-label"
              >{{ platformPresentation.label }}</span
            ></span
          ><span
            class="rs-header-badge"
            :class="'rs-header-badge--' + mediaTypeBadge.style"
            ><AppIcon :class="['fas', mediaTypeBadge.icon]" />{{
              mediaTypeBadge.text
            }}</span
          ><button
            v-if="subtitleTrackCount > 0 && !isYouTubeHelperBlocked"
            type="button"
            data-testid="result-subtitle-badge"
            class="rs-header-badge rs-header-badge--sub"
            @click="openSubtitlesTab"
          ><AppIcon class="fas fa-comment-dots" /><span>{{ locale === "en" ? `${subtitleTrackCount} Subtitles` : `${subtitleTrackCount} 字幕` }}</span></button>
        </div>
        <div class="rs-header-right">
          <span
            v-if="isExtensionConnected"
            data-testid="extension-connected-badge"
            class="rs-header-hint rs-header-hint--ready rs-header-hint--ext"
            :title="isYouTubeHelperReady ? headerStatusTitle : extConnectedTitleText"
            role="status"
            ><AppIcon
              class="fas fa-circle-check rs-header-hint-icon"
            /><span class="rs-header-hint-text">{{
              isYouTubeHelperReady
                ? headerStatusText
                : t(locale, "extConnected")
            }}</span></span
          ><button
            v-if="isExtensionOutdated"
            type="button"
            data-testid="extension-update-badge"
            class="rs-ext-update-pill"
            :title="extUpdateBadgeTitle"
            @click="emit('open-extension')"
            ><AppIcon class="fas fa-bolt rs-ext-update-pill-icon" /><span
              class="rs-ext-update-pill-text"
              >{{ extUpdateBadgeText }}</span
            ></button
          ><span
            v-if="!isExtensionConnected"
            class="rs-header-hint"
            :class="{ 'rs-header-hint--ready': isYouTubeHelperReady }"
            :title="headerStatusTitle"
            :role="isYouTubeHelperReady ? 'status' : undefined"
            ><AppIcon
              :class="[
                'fas',
                isYouTubeHelperReady ? 'fa-circle-check' : 'fa-link',
                'rs-header-hint-icon',
              ]"
            /><span class="rs-header-hint-text">{{
              headerStatusText
            }}</span></span
          >
        </div>
      </div>
    </div>
    <div
      v-if="isExtensionOutdated"
      data-testid="extension-reload-banner"
      class="rs-ext-reload-banner"
      role="status"
    >
      <div class="rs-ext-reload-banner-copy">
        <AppIcon class="fas fa-redo rs-ext-reload-banner-icon" />
        <span>{{
          locale === "en"
            ? `Your loaded DokiTool extension (v${extensionBridgeState.version || "old"}) is behind v${effectiveLatestExtensionVersion}. Download the latest .zip, extract it over your original extension directory, then open chrome://extensions and click Reload.`
            : `检测到当前已加载的 DokiTool 扩展（v${extensionBridgeState.version || "旧版"}）低于最新版 v${effectiveLatestExtensionVersion}，请先下载新版 .zip 解压覆盖原扩展目录，再在 chrome://extensions 点击「刷新」即可生效。`
        }}</span>
      </div>
      <button
        type="button"
        class="rs-ext-reload-banner-btn"
        @click="emit('open-extension')"
      >
        {{ locale === "en" ? "Upgrade Guide" : "查看更新指引" }}
      </button>
    </div>
    <div v-if="playbackFailed" class="rs-playback-error" role="alert">
      <span>{{ t(locale, "playbackFailed") }}</span
      ><a
        v-if="originalPageUrl"
        :href="originalPageUrl"
        target="_blank"
        rel="noopener noreferrer"
        >{{ t(locale, "openOriginal") }}</a
      >
    </div>
    <div
      v-if="youtubeHelper?.status === 'login_required'"
      class="rs-yt-helper-alert"
      role="alert"
    >
      <div class="rs-yt-helper-alert-title">
        <AppIcon class="fas fa-exclamation-triangle" />
        <span>{{
          locale === "en"
            ? "YouTube requested verification for your current network exit. Switch nodes and retry."
            : "当前网络出口被 YouTube 要求验证，请更换节点后重试"
        }}</span>
      </div>
      <p class="rs-yt-helper-alert-desc">
        {{
          locale === "en"
            ? "This site and helper use cookie-free anonymous requests and never ask for YouTube sign-in or cookies. Switch to an unblocked network exit and parse again."
            : "本站与助手脚本均采用无 Cookie 匿名请求，不提供也不要求登录 YouTube 账号或导入 Cookie。请切换至未被风控的网络出口节点后重新点击解析。"
        }}
      </p>
    </div>
    <div
      class="rs-main"
      :class="{ 'rs-main--align-details': hasDetailsBaseline }"
      :style="detailsLayoutStyle"
    >
      <div class="rs-media-col">
        <ResultVideoStageCard
          :has-video="Boolean(hasVideo)"
          :is-multi="Boolean(isMulti)"
          :align-details="hasDetailsBaseline"
          :locale="locale"
          :platform="resultData?.platform"
          :disable-video-preload="Boolean(youtubeHelper)"
          :current-item="currentItem"
          :active-variant="activeVariant"
          :active-video-url="activeVideoUrl"
          :copy-video-url="copyVideoUrl"
          :player-key="playerKey"
          :main-poster-url="mainPosterUrl"
          :player-quality-tag-text="playerQualityTagText"
          :primary-download-label="primaryDownloadLabel"
          :is-resolving="Boolean(isResolving)"
          :can-refresh-item="Boolean(currentItem && currentItem.state !== 'unavailable' && (currentItem.resolve_url || resultData?.refresh_url))"
          :target-message="targetMessage"
          :downloadable-count="downloadableQualityOptions.length"
          :is-you-tube-helper-install-required="isYouTubeHelperInstallRequired"
          :yt-helper-modal-dismissed="ytHelperModalDismissed"
          :needs-quality-selection="needsQualitySelection"
          :is-active-you-tube-split-video="isActiveYouTubeSplitVideo"
          :is-active-you-tube-audio-only="isActiveYouTubeAudioOnly"
          :is-active-extension-dash-mux="isActiveExtensionDashMux"
          :is-active-referer-protected-video="isActiveRefererProtectedVideo"
          :is-extension-connected="isExtensionConnected"
          :is-you-tube-helper-blocked="isYouTubeHelperBlocked"
          :is-target-blocked="isTargetBlocked"
          :selected-count="selectedCount"
          :batch-zip-available="batchZipAvailable"
          :visible-videos="visibleVideos"
          :current-index="currentIndex"
          :selected-set="selection.selectedSet.value"
          :selected-total="selectedTotal"
          :collections="collections"
          :active-collection="activeCollection"
          :resolving-ids="resolvingIds"
          :selection="selection"
          @playback-error="updatePlaybackStatus($event, true)"
          @playback-loaded="updatePlaybackStatus($event, false)"
          @duration-detected="handleDurationDetected"
          @mark-image-broken="markImageBroken"
          @open-quality-picker="openQualityPicker(false)"
          @open-yt-helper-modal="openYtHelperModal"
          @open-extension="emit('open-extension')"
          @refresh-item="emit('refresh-item', $event)"
          @primary-download="handlePrimaryDownloadClick"
          @download-selected="emit('download-selected')"
          @download-all-videos="emit('download-all-videos')"
          @download-selected-zip="emit('download-selected-zip', $event)"
          @copy-url="emit('copy-url', $event)"
          @select-video="emit('select-video', $event)"
          @toggle-video="emit('toggle-video', $event)"
          @select-all-videos="emit('select-all-videos')"
          @clear-selection="emit('clear-selection')"
          @select-collection="emit('select-collection', $event)"
        />

        <ResultGalleryCard
          v-if="hasImages"
          :image-items="imageItems"
          :locale="locale"
          :selection="selection"
          :result-version="resultVersion"
          :suspend-keys="false"
          :safe-image-url="safeImageUrl"
          @download-images="emit('download-images')"
          @download-image="emit('download-image', $event)"
          @mark-image-broken="markImageBroken"
          @modal-open-change="onImageModalOpenChange"
        />

        <ResultLivePhotoCard
          v-if="hasLivePhotos"
          :live-items="liveItems"
          :locale="locale"
          :selection="selection"
          :result-version="resultVersion"
          :safe-image-url="safeImageUrl"
          @select-live-quality="handleSelectLiveQuality"
          @download-live-video="emit('download-live-video', $event)"
          @download-live-cover="emit('download-live-cover', $event)"
          @download-all-live="emit('download-all-live')"
          @download-all-live-covers="emit('download-all-live-covers')"
          @mark-image-broken="markImageBroken"
        />
      </div>

      <ResultDetailsSidebar
        ref="sidebarRef"
        v-model:active-tab="activeTab"
        :result-data="resultData"
        :locale="locale"
        :current-item="currentItem"
        :active-variant="activeVariant"
        :metadata="metadata"
        :attachments="attachments"
        :has-backup="hasBackup"
        :is-you-tube-helper-blocked="isYouTubeHelperBlocked"
        :can-align-base="canAlignBase"
        :align-details="hasDetailsBaseline"
        :media-identity="mediaIdentity"
        :format-number="formatNumber"
        :format-duration="formatDuration"
        :safe-image-url="safeImageUrl"
        :display-variant-label="displayVariantLabel"
        :format-option-size="formatOptionSize"
        :quality-options="qualityOptions"
        :downloadable-count="downloadableQualityOptions.length"
        :other-quality-options="otherQualityOptions"
        :has-hidden-quality-variants="hasHiddenQualityVariants"
        :show-all-quality-variants="showAllQualityVariants"
        :unavailable-quality-reason="unavailableQualityReason"
        :higher-quality-notice="higherQualityNotice"
        :is-bilibili="hasMuxVariants"
        :is-multi="Boolean(isMulti)"
        :is-extension-connected="isExtensionConnected"
        :bilibili-dash-summary="bilibiliDashSummary"
        :detected-duration-seconds="detectedDurationSeconds"
        @toggle-show-all-qualities="
          showAllQualityVariants = !showAllQualityVariants
        "
        @select-quality="selectQuality"
        @open-extension="emit('open-extension')"
        @copy-text="copyToClipboard"
        @copy-url="emit('copy-url', $event)"
        @download-music="emit('download-music', $event)"
        @mark-image-broken="markImageBroken"
        @baseline-change="onBaselineChange"
      />
    </div>

    <div
      v-if="!isExtensionConnected && bilibiliDashSummary"
      class="rs-ext-hint"
      data-testid="extension-install-hint"
    >
      <span class="rs-ext-hint-text">{{ extInstallHintText }}</span>
      <button
        type="button"
        class="rs-ext-hint-link"
        data-extension-install-cta
        @click="emit('open-extension')"
      >
        {{ t(locale, "extInstallHintCta") }}
      </button>
    </div>

    <Teleport to="body"
      ><Transition name="rs-toast"
        ><div v-if="showCopyToast" class="rs-copy-toast">
          <div class="rs-copy-toast-icon"><AppIcon class="fas fa-check" /></div>
          <div class="rs-copy-toast-content">
            <div class="rs-copy-toast-title">{{ t(locale, "copied") }}</div>
            <div class="rs-copy-toast-text">{{ copyToastText }}</div>
          </div>
        </div></Transition
      ></Teleport
    >

    <CapabilityUpgradeNotice
      :open="ytHelperModalOpen"
      :is-client-mounted="isClientMounted"
      mode="client_session"
      :youtube-helper="youtubeHelper"
      :latest-extension-version="effectiveLatestExtensionVersion"
      :locale="locale"
      @close="closeYtHelperModal"
      @open-extension="emit('open-extension')"
    />
  </section>
</template>

<style scoped>
.rs {
  --c-accent: #6c5ce7;
  --c-accent-light: #818cf8;
  --c-accent-dark: #4f46e5;
  --c-accent-2: #a855f7;
  --c-accent-3: #ec4899;
  --c-accent-4: #f472b6;
  --c-success: #10b981;
  --c-success-light: #34d399;
  --c-danger: #ef4444;
  --c-danger-light: #f87171;
  --c-warn: #f59e0b;
  --c-warn-light: #fbbf24;
  --c-info: #06b6d4;
  --c-bg: #fff;
  --c-bg-2: #f8fafc;
  --c-bg-3: #f1f5f9;
  --c-bg-elevated: #ffffff;
  --c-fg: #0f172a;
  --c-fg-2: #475569;
  --c-fg-3: #94a3b8;
  --c-fg-4: #cbd5e1;
  --c-border: #e2e8f0;
  --c-border-2: #f1f5f9;
  --c-border-light: #f8fafc;
  --sh-sm: 0 1px 2px rgba(0, 0, 0, 0.03);
  --sh-md: 0 4px 12px rgba(0, 0, 0, 0.06);
  --sh-lg: 0 8px 28px rgba(0, 0, 0, 0.08);
  --sh-xl: 0 16px 48px rgba(0, 0, 0, 0.12);
  --sh-2xl: 0 24px 72px rgba(0, 0, 0, 0.16);
  --sh-glow: 0 0 40px rgba(108, 92, 231, 0.15);
  --r-sm: 0.5rem;
  --r-md: 0.75rem;
  --r-lg: 1rem;
  --r-xl: 1.25rem;
  --r-2xl: 1.5rem;
  --r-3xl: 2rem;
  --r-full: 9999px;
  --t-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
  --t-base: 220ms cubic-bezier(0.4, 0, 0.2, 1);
  --t-slow: 350ms cubic-bezier(0.4, 0, 0.2, 1);
  --content-max: 1320px;
  --sidebar-w: 380px;
  --sidebar-w-xl: 420px;
  --gap: 1.5rem;
  --gap-lg: 2rem;

  max-width: var(--content-max);
  margin: 0 auto 4rem;
  font-family: inherit;
  color: var(--c-fg);
  background: linear-gradient(
    180deg,
    rgba(108, 92, 231, 0.02) 0%,
    rgba(168, 85, 247, 0.01) 100%
  );
  border-radius: var(--r-2xl);
  padding: 1.5rem;
}

.dark .rs {
  --c-bg: #0f172a;
  --c-bg-2: #1e293b;
  --c-bg-3: #334155;
  --c-bg-elevated: #1e293b;
  --c-fg: #f1f5f9;
  --c-fg-2: #cbd5e1;
  --c-fg-3: #94a3b8;
  --c-fg-4: #64748b;
  --c-border: #334155;
  --c-border-2: #1e293b;
  --c-border-light: #334155;
  --sh-sm: 0 1px 2px rgba(0, 0, 0, 0.2);
  --sh-md: 0 4px 12px rgba(0, 0, 0, 0.25);
  --sh-lg: 0 8px 28px rgba(0, 0, 0, 0.35);
  --sh-xl: 0 16px 48px rgba(0, 0, 0, 0.45);
  --sh-2xl: 0 24px 72px rgba(0, 0, 0, 0.5);
  --sh-glow: 0 0 40px rgba(108, 92, 231, 0.25);
  background: linear-gradient(
    180deg,
    rgba(108, 92, 231, 0.08) 0%,
    rgba(168, 85, 247, 0.04) 100%
  );
}

.rs-header {
  position: relative;
  margin-bottom: 1.25rem;
  border-radius: var(--r-xl);
  overflow: hidden;
}
.rs-header::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    135deg,
    rgba(108, 92, 231, 0.08) 0%,
    rgba(168, 85, 247, 0.06) 50%,
    rgba(236, 72, 153, 0.04) 100%
  );
  border: 1px solid rgba(108, 92, 231, 0.12);
}
.rs-header-inner {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.625rem;
  padding: 1rem 1.25rem;
  backdrop-filter: blur(12px);
}
.rs-header-left,
.rs-header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.rs-header-right {
  flex-wrap: wrap;
  gap: 0.5rem 0.625rem;
}
.rs-header-left {
  flex-wrap: wrap;
  min-width: 0;
  gap: 0.5rem 0.625rem;
}
.rs-status-dot-wrapper {
  position: relative;
  width: 1rem;
  height: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.rs-status-dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: linear-gradient(135deg, #10b981, #34d399);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2),
    0 0 10px rgba(16, 185, 129, 0.4);
  position: relative;
  z-index: 2;
}
.rs-status-dot-pulse {
  position: absolute;
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: rgba(16, 185, 129, 0.5);
  animation: rsStatusPulse 2s ease-in-out infinite;
}
@keyframes rsStatusPulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.6;
  }
  50% {
    transform: scale(2.4);
    opacity: 0;
  }
}
.rs-header-title {
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--c-fg);
  letter-spacing: 0.02em;
}
.rs-header-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0.65rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
  transition: all var(--t-fast);
}
.rs-header-badge-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rs-header-badge--platform {
  background: linear-gradient(
    135deg,
    rgba(15, 23, 42, 0.08),
    rgba(15, 23, 42, 0.04)
  );
  color: var(--c-fg-2);
  border: 1px solid rgba(15, 23, 42, 0.14);
  max-width: 11rem;
}
.rs-header-badge--platform-generic {
  background: linear-gradient(
    135deg,
    rgba(6, 182, 212, 0.16),
    rgba(108, 92, 231, 0.12)
  );
  color: #0e7490;
  border: 1px solid rgba(6, 182, 212, 0.28);
}
.rs-header-badge--video {
  background: linear-gradient(
    135deg,
    rgba(108, 92, 231, 0.2),
    rgba(108, 92, 231, 0.1)
  );
  color: var(--c-accent);
  border: 1px solid rgba(108, 92, 231, 0.25);
}
.rs-header-badge--audio {
  background: linear-gradient(
    135deg,
    rgba(16, 185, 129, 0.2),
    rgba(6, 182, 212, 0.12)
  );
  color: #047857;
  border: 1px solid rgba(16, 185, 129, 0.28);
}
.rs-header-badge--image {
  background: linear-gradient(
    135deg,
    rgba(236, 72, 153, 0.2),
    rgba(236, 72, 153, 0.1)
  );
  color: var(--c-accent-3);
  border: 1px solid rgba(236, 72, 153, 0.25);
}
.rs-header-badge--live {
  background: linear-gradient(
    135deg,
    rgba(239, 68, 68, 0.2),
    rgba(239, 68, 68, 0.1)
  );
  color: var(--c-danger);
  border: 1px solid rgba(239, 68, 68, 0.25);
}
.rs-header-badge--sub {
  background: rgba(99, 102, 241, 0.12);
  color: var(--c-accent);
  border: 1px solid rgba(99, 102, 241, 0.28);
  cursor: pointer;
  font-family: inherit;
}
:global(.dark) .rs-header-badge--platform {
  background: linear-gradient(
    135deg,
    rgba(148, 163, 184, 0.18),
    rgba(148, 163, 184, 0.1)
  );
  color: #e2e8f0;
  border-color: rgba(148, 163, 184, 0.28);
}
:global(.dark) .rs-header-badge--platform-generic {
  background: linear-gradient(
    135deg,
    rgba(34, 211, 238, 0.18),
    rgba(129, 140, 248, 0.16)
  );
  color: #67e8f9;
  border-color: rgba(34, 211, 238, 0.3);
}
:global(.dark) .rs-header-badge--audio {
  background: linear-gradient(
    135deg,
    rgba(16, 185, 129, 0.22),
    rgba(6, 182, 212, 0.14)
  );
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.32);
}
.rs-header-badge:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.1);
}
.rs-header-hint {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.75rem;
  background: rgba(108, 92, 231, 0.06);
  border-radius: 999px;
  border: 1px solid rgba(108, 92, 231, 0.1);
  transition: all var(--t-fast);
}
.rs-header-hint:hover {
  background: rgba(108, 92, 231, 0.1);
  border-color: rgba(108, 92, 231, 0.18);
}
.rs-header-hint-icon {
  font-size: 0.65rem;
  color: var(--c-accent);
}
.rs-header-hint-text {
  font-size: 0.6875rem;
  color: var(--c-fg-3);
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.rs-header-hint--ready {
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.22);
}
.rs-header-hint--ready:hover {
  background: rgba(16, 185, 129, 0.14);
  border-color: rgba(16, 185, 129, 0.32);
}
.rs-header-hint--ready .rs-header-hint-icon {
  color: var(--c-success);
}
.rs-header-hint--ready .rs-header-hint-text {
  color: var(--c-fg-2);
  font-weight: 600;
}
.rs-ext-update-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.65rem;
  border-radius: 999px;
  border: 1px solid rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.1);
  color: #b45309;
  font-family: inherit;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--t-fast);
}
.rs-ext-update-pill:hover {
  background: rgba(245, 158, 11, 0.18);
  border-color: rgba(245, 158, 11, 0.52);
  transform: translateY(-1px);
}
.rs-ext-update-pill:focus-visible {
  outline: 2px solid var(--c-warn);
  outline-offset: 2px;
}
.rs-ext-update-pill-icon {
  font-size: 0.625rem;
}
:global(.dark) .rs-ext-update-pill {
  background: rgba(245, 158, 11, 0.16);
  border-color: rgba(251, 191, 36, 0.36);
  color: #fcd34d;
}
:global(.dark) .rs-ext-update-pill:hover {
  background: rgba(245, 158, 11, 0.24);
  border-color: rgba(251, 191, 36, 0.55);
}

.rs-playback-error {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  margin-bottom: 1.25rem;
  padding: 0.875rem 1rem;
  border: 1px solid #fbbf24;
  border-radius: 0.875rem;
  background: #fffbeb;
  color: #92400e;
  font-size: 0.875rem;
  line-height: 1.6;
}
.rs-playback-error a {
  color: inherit;
  font-weight: 600;
  text-decoration: underline;
}
:global(.dark) .rs-playback-error {
  background: #3b2d14;
  color: #fde68a;
  border-color: #a16207;
}

.rs-main {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--gap);
  align-items: start;
}
@media (min-width: 768px) {
  .rs-main {
    gap: 1.75rem;
  }
}
@media (min-width: 1040px) {
  .rs-main {
    grid-template-columns: 1fr var(--sidebar-w);
  }
  .rs-main--align-details .rs-media-col {
    height: var(--rs-details-column-height);
    min-height: 0;
  }
}
@media (min-width: 1300px) {
  .rs-main {
    grid-template-columns: 1fr var(--sidebar-w-xl);
  }
}

.rs-media-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}

.rs-ext-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.9rem;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--c-fg-3);
}
.rs-ext-hint-link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--c-accent);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.rs-ext-hint-link:hover {
  color: var(--c-accent-dark);
}
.rs-ext-hint-link:focus-visible {
  outline: 2px solid var(--c-accent);
  outline-offset: 2px;
  border-radius: 3px;
}

@media (max-width: 480px) {
  .rs {
    padding: 0 0.5rem;
    margin-bottom: 2.5rem;
    --gap: 1rem;
  }
  .rs-header {
    border-radius: var(--r-md);
    padding: 0.5rem 0.75rem;
  }
}

.rs-copy-toast {
  position: fixed;
  right: 1.5rem;
  bottom: 1.5rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--c-bg-elevated, #ffffff);
  border-radius: var(--r-lg, 1rem);
  box-shadow: var(--sh-lg, 0 8px 28px rgba(0, 0, 0, 0.08));
  border: 1px solid var(--c-border, #e2e8f0);
  z-index: 9999;
  min-width: 180px;
}
.rs-copy-toast-icon {
  width: 2rem;
  height: 2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #10b981;
  background-image: linear-gradient(135deg, #10b981, #34d399);
  border-radius: 50%;
  flex-shrink: 0;
  color: #fff;
  font-size: 0.75rem;
}
.rs-copy-toast-content {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}
.rs-copy-toast-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--c-fg, #0f172a);
}
.rs-copy-toast-text {
  font-size: 0.65rem;
  color: var(--c-fg-3, #94a3b8);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rs-toast-enter-active {
  animation: toast-in 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.rs-toast-leave-active {
  animation: toast-out 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateX(100%) translateY(20%);
  }
  to {
    opacity: 1;
    transform: translateX(0) translateY(0);
  }
}
@keyframes toast-out {
  from {
    opacity: 1;
    transform: translateX(0) translateY(0);
  }
  to {
    opacity: 0;
    transform: translateX(100%) translateY(20%);
  }
}

.rs-yt-helper-alert {
  margin-bottom: 1.25rem;
  padding: 1rem 1.25rem;
  border-radius: var(--r-xl);
  border: 1px solid rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.06);
  box-shadow: var(--sh-sm);
}
.rs-yt-helper-alert-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 700;
  color: var(--c-danger);
  margin-bottom: 0.375rem;
}
.rs-yt-helper-alert-desc {
  margin: 0;
  font-size: 0.875rem;
  color: var(--c-fg-2);
  line-height: 1.6;
}
.rs-ext-reload-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 1.25rem;
  padding: 0.75rem 1rem;
  border-radius: var(--r-xl);
  border: 1px solid rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.1);
  color: var(--c-fg);
  font-size: 0.85rem;
  line-height: 1.5;
}
.rs-ext-reload-banner-copy {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1;
  min-width: 220px;
}
.rs-ext-reload-banner-icon {
  color: var(--c-warn);
  flex-shrink: 0;
}
.rs-ext-reload-banner-btn {
  padding: 0.375rem 0.85rem;
  border-radius: var(--r-full);
  border: 1px solid rgba(245, 158, 11, 0.45);
  background-color: #d97706;
  color: #ffffff;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.rs-ext-reload-banner-btn:hover {
  background-color: #b45309;
}
</style>
