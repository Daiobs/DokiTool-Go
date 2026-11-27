<script setup>
import {
  computed,
  defineAsyncComponent,
  getCurrentScope,
  h,
  inject,
  markRaw,
  nextTick,
  ref,
  shallowRef,
  onMounted,
  onUnmounted,
  watch,
} from "vue";
import { useVideoStore } from "./stores/video";
import HeaderNav from "./components/HeaderNav.vue";
import HeroSection from "./components/HeroSection.vue";
import PlatformGrid from "./components/PlatformGrid.vue";
import TutorialSection from "./components/TutorialSection.vue";
import FaqSection from "./components/FaqSection.vue";
import FooterSection from "./components/FooterSection.vue";
import ParticlesCanvas from "./components/ParticlesCanvas.vue";
import { useVideoParser } from "./composables/useVideoParser";
import {
  MODAL_VERSION_CHECK_COOLDOWN_MS,
  VISIBILITY_VERSION_CHECK_COOLDOWN_MS,
  useExtensionRuntime,
} from "./composables/useExtensionRuntime";
import { refreshPlatformCatalog } from "./utils/platforms";
import {
  homeInitialStateKey,
  isInAppBrowser,
  readBrowserPreferences,
  persistPreference,
} from "./ssr/initialState";

const initialState = inject(homeInitialStateKey, {
  prerendered: false,
  locale: "zh-CN",
  isDark: false,
  inputUrl: "",
});
const isReady = ref(!initialState.prerendered);
const showInAppBanner = ref(false);

// Share the preload with the async component, but allow a later parse to retry
// after a transient chunk-loading failure.
let resultSectionModule;
const loadResultSection = () =>
  (resultSectionModule ??= import("./components/ResultSection.vue").catch(
    (error) => {
      resultSectionModule = undefined;
      throw error;
    },
  ));
const ResultSection = defineAsyncComponent({
  loader: loadResultSection,
  loadingComponent: {
    setup: () => () =>
      h(
        "p",
        {
          role: "status",
          class: "py-6 text-center text-sm text-slate-500 dark:text-slate-400",
        },
        locale.value === "en" ? "Preparing the result…" : "正在显示解析结果…",
      ),
  },
  errorComponent: {
    setup: () => () =>
      h(
        "p",
        {
          role: "alert",
          class: "py-6 text-center text-sm text-rose-600 dark:text-rose-400",
        },
        locale.value === "en"
          ? "The result could not be displayed. Please parse again."
          : "结果暂时无法显示，请重新解析。",
      ),
  },
});

const ToastContainer = defineAsyncComponent(() =>
  import("./components/ToastContainer.vue"),
);
const ProgressModal = defineAsyncComponent(() =>
  import("./components/ProgressModal.vue"),
);
let extensionModalModule;
const loadExtensionModal = () =>
  (extensionModalModule ??= import("./components/ExtensionDownloadModal.vue").catch(
    (error) => {
      extensionModalModule = undefined;
      throw error;
    },
  ));
const ExtensionDownloadModal = defineAsyncComponent({
  loader: loadExtensionModal,
  errorComponent: {
    setup: () => () =>
      h(
        "div",
        {
          role: "dialog",
          "aria-modal": "true",
          class:
            "fixed inset-0 z-[10000] flex items-center justify-center bg-slate-900/60 p-4",
          onClick: (e) => {
            if (e.target === e.currentTarget) showExtensionModal.value = false;
          },
        },
        h(
          "div",
          {
            class:
              "w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 text-center shadow-2xl dark:border-slate-700 dark:bg-slate-900",
          },
          [
            h(
              "p",
              { class: "text-sm text-slate-700 dark:text-slate-200" },
              locale.value === "en"
                ? "Site assets were updated. Refresh this page or download the extension package directly."
                : "页面资源已更新，请刷新页面或直接下载 Chrome 扩展包。",
            ),
            h("div", { class: "mt-4 flex justify-center gap-2" }, [
              h(
                "a",
                {
                  href: "/helper/dokitool-chrome-extension.zip",
                  download: "dokitool-chrome-extension.zip",
                  class:
                    "rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-700",
                },
                locale.value === "en" ? "Download (.zip)" : "直接下载扩展包 (.zip)",
              ),
              h(
                "button",
                {
                  type: "button",
                  class:
                    "rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 dark:border-slate-600 dark:text-slate-200",
                  onClick: () => {
                    showExtensionModal.value = false;
                  },
                },
                locale.value === "en" ? "Close" : "关闭",
              ),
            ]),
          ],
        ),
      ),
  },
});
const showExtensionModal = ref(false);
const loadDownloadCard = () => import("./components/DownloadCard.vue");
const DownloadCard = defineAsyncComponent({
  loader: loadDownloadCard,
  errorComponent: {
    setup: () => () => null,
  },
});

const videoStore = useVideoStore();
const hasShownToast = ref(false);
watch(
  () => videoStore.toasts.length,
  (len) => {
    if (len > 0) hasShownToast.value = true;
  },
  { flush: "sync", immediate: true },
);
const isDark = ref(initialState.isDark);

const isDownloading = computed(() =>
  videoStore.downloads.some((task) =>
    ["queued", "preparing", "downloading"].includes(task.status),
  ),
);
const locale = ref(initialState.locale);
const {
  inputUrl,
  parseError,
  parseStatusText,
  currentPlatform,
  platformMismatchDetected,
  needsManualHelperRefresh,
  parseButton,
  parseVideo,
  switchToAllAndRetry,
  cancelParse,
  selectPlatform,
  resolveItem,
  markWaitingForYouTubeHelperInstall,
  handleYouTubeHelperTabReturn,
  resumePendingYouTubeHelperInstall,
  triggerManualHelperRefresh,
} = useVideoParser({
  videoStore,
  locale,
  showToast: (message, type, duration) =>
    videoStore.addToast(message, type, duration),
});
inputUrl.value = initialState.inputUrl;

const showToast = (message, type = "success", duration = 3000) => {
  videoStore.addToast(message, type, duration);
};

const resolveSelectedItem = async (item) => {
  const refreshUrl = videoStore.resultData?.refresh_url?.trim() || "";
  if (
    !item ||
    item.state === "unavailable" ||
    (!item.resolve_url && !refreshUrl) ||
    videoStore.resolvingItems.has(item.id)
  )
    return;
  const version = videoStore.resultVersion;
  videoStore.setResolving(item.id, true);
  try {
    const resolved = await resolveItem(item, undefined, {
      ...(refreshUrl ? { refreshUrl } : {}),
    });
    videoStore.replaceItem(resolved, version);
  } catch (error) {
    if (videoStore.resultVersion === version)
      showToast(error.message || "解析失败", "error");
  } finally {
    if (videoStore.resultVersion === version)
      videoStore.setResolving(item.id, false);
  }
};

const appScope = getCurrentScope();
const selectionRef = shallowRef(null);
let selectionCtrl;
let selectionPromise;
const ensureVideoSelection = () => {
  if (selectionCtrl) return Promise.resolve(selectionCtrl);
  return (selectionPromise ??= import("./composables/useVideoSelection")
    .then(({ useVideoSelection }) => {
      if (!selectionCtrl) {
        const init = () => {
          const ctrl = markRaw(useVideoSelection({ videoStore }));
          ctrl.syncResult();
          watch(
            () => ctrl.currentVideo.value,
            (item) => {
              if (item?.state === "deferred") void resolveSelectedItem(item);
            },
            { immediate: true },
          );
          return ctrl;
        };
        selectionCtrl = (appScope && appScope.run(init)) || init();
        selectionRef.value = selectionCtrl;
      }
      return selectionCtrl;
    })
    .catch((error) => {
      selectionPromise = undefined;
      throw error;
    }));
};

let downloadCtrl;
let mediaDownloadPromise;
const ensureMediaDownload = () => {
  if (downloadCtrl) return Promise.resolve(downloadCtrl);
  return (mediaDownloadPromise ??= Promise.all([
    import("./composables/useMediaDownload"),
    ensureVideoSelection(),
  ])
    .then(([{ useMediaDownload }, selection]) => {
      downloadCtrl ??= useMediaDownload({
        videoStore,
        showToast,
        selection,
        resolveItem,
      });
      return downloadCtrl;
    })
    .catch((error) => {
      mediaDownloadPromise = undefined;
      throw error;
    }));
};

const forwardDownloadAction =
  (method) =>
  (...args) => {
    if (downloadCtrl) return downloadCtrl[method](...args);
    return ensureMediaDownload().then((ctrl) => ctrl[method](...args));
  };

const downloadMainVideo = forwardDownloadAction("downloadMainVideo");
const downloadBackupVideo = forwardDownloadAction("downloadBackupVideo");
const downloadYouTubeSeparate = forwardDownloadAction(
  "downloadYouTubeSeparate",
);
const downloadVideoByIndex = forwardDownloadAction("downloadVideoByIndex");
const downloadSelected = forwardDownloadAction("downloadSelected");
const downloadAllVideos = forwardDownloadAction("downloadAllVideos");
const downloadVideosAsZip = forwardDownloadAction("downloadVideosAsZip");
const downloadAllMedia = forwardDownloadAction("downloadAllMedia");
const downloadMusic = forwardDownloadAction("downloadMusic");
const downloadLiveVideo = forwardDownloadAction("downloadLiveVideo");
const downloadLiveCover = forwardDownloadAction("downloadLiveCover");
const downloadImage = forwardDownloadAction("downloadImage");
const handleCancelDownload = forwardDownloadAction("handleCancelDownload");
const handleRetryDownload = forwardDownloadAction("handleRetryDownload");
const handleRefreshDownload = forwardDownloadAction("handleRefreshDownload");
const handleQueryDownload = forwardDownloadAction("handleQueryDownload");
const handleBrowserDownload = forwardDownloadAction("handleBrowserDownload");
const handleClearCompleted = forwardDownloadAction("handleClearCompleted");

// Start fetching the result UI and media download controller alongside a valid
// parse request, not on the initial visit and not only after the API finishes.
watch(
  () => parseButton.isLoading.value,
  (loading) => {
    if (loading) {
      void loadResultSection().catch(() => {});
      void loadDownloadCard().catch(() => {});
      void ensureVideoSelection().catch(() => {});
      void ensureMediaDownload().catch(() => {});
    }
  },
  { flush: "sync" },
);

watch(
  () => videoStore.resultVersion,
  () => {
    if (selectionCtrl) {
      selectionCtrl.syncResult();
    } else if (videoStore.resultData) {
      void ensureVideoSelection().catch(() => {});
    }
    if (videoStore.resultData) {
      void loadDownloadCard().catch(() => {});
      void ensureMediaDownload().catch(() => {});
      if (typeof window !== "undefined") {
        void nextTick(() => {
          const el = resultAnchorRef.value;
          if (el && typeof el.scrollIntoView === "function") {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        });
      }
    }
  },
  { flush: "sync" },
);

const copyUrl = async (url) => {
  if (!url) {
    showToast("复制失败", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(String(url));
    showToast("已复制到剪贴板");
  } catch (e) {
    showToast("复制失败", "error");
  }
};

const downloadAll = () => downloadAllMedia("all");
const downloadAllImages = () => downloadAllMedia("images");
const downloadAllLivePhotos = () => downloadAllMedia("live");
const downloadAllLiveCovers = () => downloadAllMedia("covers");

const switchVideo = (choice) => selectionCtrl?.choose(choice);
const selectVideo = (index) => selectionCtrl?.selectIndex(index);
const toggleVideo = (index) => selectionCtrl?.toggleSelect(index);
const selectAllVideos = () => selectionCtrl?.selectAll();
const clearSelection = () => selectionCtrl?.clearSelection();
const selectCollection = (index) => selectionCtrl?.setSection(index);
const promptSelectQuality = () => {
  showToast(
    locale.value === "en"
      ? "Please select a quality version in the Quality tab first"
      : "请先在「画质选项」中选择需要的清晰度版本",
    "info",
  );
};

const resultAnchorRef = ref(null);
const extRuntime = useExtensionRuntime({
  onStateChange: (state) => {
    void import("./downloads/saveFilePicker")
      .then(({ syncWebSaveFilePickerPreference }) =>
        syncWebSaveFilePickerPreference(
          Boolean(state.connected && state.useSaveFilePicker),
        ),
      )
      .catch(() => {});
  },
});
const extensionState = extRuntime.extensionState;
const latestExtensionVersion = extRuntime.latestExtensionVersion;
const extensionConnected = computed(() => extensionState.value.connected);
const extensionVersion = computed(() => extensionState.value.version);

const openExtensionModal = () => {
  showExtensionModal.value = true;
  void extRuntime.probeExtension();
  void extRuntime.refreshLatestExtensionVersion({
    cooldownMs: MODAL_VERSION_CHECK_COOLDOWN_MS,
  });
};

let preloadNoticeShown = false;
const onVitePreloadError = () => {
  if (preloadNoticeShown) return;
  preloadNoticeShown = true;
  showToast(
    locale.value === "en"
      ? "A newer version of DokiTool is available. Please refresh the page."
      : "检测到站点已发布新版本，请刷新页面以加载最新资源",
    "info",
    6000,
  );
};

const formatNumber = (num) => {
  if (!num && num !== 0) return "0";
  const n = Number(num);
  if (!Number.isFinite(n)) return "0";
  if (locale.value === "en") {
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }
  if (n >= 1e8) return (n / 1e8).toFixed(1) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
  return String(n);
};

const formatDuration = (seconds) => {
  const duration = Number(seconds);
  if (!Number.isFinite(duration) || duration <= 0) return "0:00";
  const totalSec = Math.round(duration);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
};

const toggleTheme = () => {
  isDark.value = !isDark.value;
  persistPreference("theme", isDark.value ? "dark" : "light");
  document.documentElement.classList.toggle("dark", isDark.value);
  document.documentElement.style.colorScheme = isDark.value ? "dark" : "light";
};

const setLocale = (lang) => {
  locale.value = lang;
  persistPreference("lang", lang);
  document.documentElement.lang = lang;
};

const onVisibilityOrFocus = () => {
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    return;
  }
  void handleYouTubeHelperTabReturn();
  void extRuntime.probeExtension();
  void extRuntime.refreshLatestExtensionVersion({
    cooldownMs: VISIBILITY_VERSION_CHECK_COOLDOWN_MS,
  });
};

const handleExtensionYouTubeReady = () => {
  showExtensionModal.value = false;
  const candidateUrl =
    inputUrl.value.trim() || videoStore.resultData?.source_url || "";
  if (!candidateUrl) return;
  if (candidateUrl !== inputUrl.value) {
    inputUrl.value = candidateUrl;
  }
  void parseVideo();
};

onMounted(() => {
  void refreshPlatformCatalog();
  let hasSavedDownloads = false;
  try {
    hasSavedDownloads = Boolean(
      typeof sessionStorage !== "undefined" &&
        sessionStorage.getItem("dokitool-downloads-v1"),
    );
  } catch {
    hasSavedDownloads = false;
  }
  if (hasSavedDownloads) {
    void loadDownloadCard().catch(() => {});
    void ensureMediaDownload()
      .then((ctrl) => ctrl.restoreDownloads())
      .catch(() => {});
  }
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  ) {
    void import("./utils/youtubeHelperCore")
      .then(({ cleanupLeftoverYouTubeOpfsTempFiles }) =>
        cleanupLeftoverYouTubeOpfsTempFiles(),
      )
      .catch(() => {});
  }
  // Static HTML and the first client render use the same language and controls.
  // Restore preferences only after hydration; the head bootstrap already applied
  // the background theme before CSS, without mutating the hydrated subtree.
  const preferences = readBrowserPreferences();
  isDark.value = preferences.isDark;
  locale.value = preferences.locale;
  document.documentElement.classList.toggle("dark", isDark.value);
  document.documentElement.style.colorScheme = isDark.value ? "dark" : "light";
  document.documentElement.lang = locale.value;
  showInAppBanner.value = isInAppBrowser();
  isReady.value = true;
  document.addEventListener("visibilitychange", onVisibilityOrFocus);
  window.addEventListener("focus", onVisibilityOrFocus);
  window.addEventListener("vite:preloadError", onVitePreloadError);
  void extRuntime.probeExtension();
  extRuntime.scheduleIdleVersionCheck();
  void resumePendingYouTubeHelperInstall();
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisibilityOrFocus);
  window.removeEventListener("focus", onVisibilityOrFocus);
  window.removeEventListener("vite:preloadError", onVitePreloadError);
  extRuntime.dispose();
});
</script>

<template>
  <div class="min-h-screen">
    <ParticlesCanvas />
    <ToastContainer v-if="hasShownToast" />
    <!-- Body teleports are created after hydration; the static page has no
         teleport targets, so Vue must not hydrate them against body content. -->
    <ProgressModal v-if="isReady && videoStore.showProgress" />
    <ExtensionDownloadModal
      v-if="isReady && showExtensionModal"
      :locale="locale"
      :extension-connected="extensionConnected"
      :extension-version="extensionVersion"
      :latest-extension-version="latestExtensionVersion"
      @close="showExtensionModal = false"
    />
    <DownloadCard
      v-if="videoStore.downloads.length > 0"
      :downloads="videoStore.downloads"
      :locale="locale"
      @cancel="handleCancelDownload"
      @retry="handleRetryDownload"
      @refresh="handleRefreshDownload"
      @query="handleQueryDownload"
      @handoff="handleBrowserDownload"
      @clear-completed="handleClearCompleted"
    />

    <p
      v-if="showInAppBanner"
      data-in-app-browser-banner
      role="status"
      class="relative z-40 border-b border-amber-200 bg-amber-50/95 px-4 py-2 text-center text-xs sm:text-sm text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/90 dark:text-amber-100"
    >
      {{
        locale === "en"
          ? "In-app browser detected. Saving files may be restricted — please open in your system browser."
          : "检测到应用内置浏览器，保存文件可能受限，请在系统浏览器中打开。"
      }}
    </p>

    <HeaderNav
      :is-dark="isDark"
      :locale="locale"
      :extension-connected="extensionConnected"
      :extension-version="extensionVersion"
      :latest-extension-version="latestExtensionVersion"
      @toggle-theme="toggleTheme"
      @set-locale="setLocale"
      @open-extension="openExtensionModal"
    />

    <main class="max-w-7xl mx-auto px-4 pb-8 pt-0 relative z-10">
      <HeroSection
        v-model:input-url="inputUrl"
        :is-ready="isReady"
        :is-loading="parseButton.isLoading.value"
        :is-error="!!parseError || parseButton.state.value === 'error'"
        :parse-error="parseError"
        :parse-status-text="parseStatusText"
        :platform-mismatch="platformMismatchDetected"
        :locale="locale"
        :current-platform="currentPlatform"
        @parse="parseVideo"
        @cancel="cancelParse"
        @select-platform="selectPlatform"
        @switch-all-retry="switchToAllAndRetry"
      />

      <div
        v-if="videoStore.resultData && selectionRef"
        ref="resultAnchorRef"
        class="scroll-mt-20"
      >
        <ResultSection
          :result-data="videoStore.resultData"
          :result-version="videoStore.resultVersion"
          :is-downloading="isDownloading"
          :needs-manual-helper-refresh="needsManualHelperRefresh"
          :locale="locale"
          :selection="selectionRef"
          :format-number="formatNumber"
          :format-duration="formatDuration"
          :resolving-ids="videoStore.resolvingItems"
          :extension-state="extensionState"
          :latest-extension-version="latestExtensionVersion"
          @refresh-item="resolveSelectedItem"
          @open-extension="openExtensionModal"
          @extension-youtube-ready="handleExtensionYouTubeReady"
        @install-youtube-helper="markWaitingForYouTubeHelperInstall"
        @refresh-youtube-helper-page="triggerManualHelperRefresh"
        @download-main="downloadMainVideo"
        @prompt-select-quality="promptSelectQuality"
        @download-backup="downloadBackupVideo"
        @download-separate="downloadYouTubeSeparate"
        @download-all="downloadAll"
        @download-images="downloadAllImages"
        @download-image="downloadImage"
        @download-music="downloadMusic"
        @download-live-video="downloadLiveVideo"
        @download-live-cover="downloadLiveCover"
        @download-all-live="downloadAllLivePhotos"
        @download-all-live-covers="downloadAllLiveCovers"
        @copy-url="copyUrl"
        @switch-video="switchVideo"
        @select-video="selectVideo"
        @toggle-video="toggleVideo"
        @select-all-videos="selectAllVideos"
        @clear-selection="clearSelection"
        @select-collection="selectCollection"
        @download-index="downloadVideoByIndex"
        @download-selected="downloadSelected"
        @download-all-videos="downloadAllVideos"
          @download-selected-zip="
            (videos) => downloadVideosAsZip(videos, undefined)
          "
          @download-all-zip="(videos) => downloadVideosAsZip(videos, undefined)"
        />
      </div>

      <PlatformGrid :locale="locale" />
      <TutorialSection :locale="locale" />
      <FaqSection :locale="locale" />
    </main>

    <FooterSection
      :locale="locale"
      @open-extension="openExtensionModal"
    />
  </div>
</template>
