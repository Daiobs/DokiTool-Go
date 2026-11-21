<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { MediaItem, UnifiedMedia } from "../types/media";
import SidePanelBatchQueue from "./components/SidePanelBatchQueue.vue";
import SidePanelDownloads from "./components/SidePanelDownloads.vue";
import SidePanelHeader, {
  type PanelViewMode,
} from "./components/SidePanelHeader.vue";
import SidePanelResult from "./components/SidePanelResult.vue";
import SidePanelSettings from "./components/SidePanelSettings.vue";
import {
  type BackgroundToSidePanelBroadcast,
  type ConnectionCheckResult,
  type EnqueueDownloadItem,
  type ExtensionDownloadTask,
  type ExtensionSettings,
  type ExtensionStateSnapshot,
  type MatchedPlatformUrl,
  type PendingPanelIntent,
  type TabSyncState,
} from "./protocol";
import {
  DEFAULT_EXTENSION_SETTINGS,
  buildWorkFingerprint,
  consumePendingIntent,
} from "./storage";
import {
  applyExtensionTheme,
  createSidePanelBroadcastBridge,
  getNextExtensionTheme,
  mergeEnqueuedTasks,
  readCachedExtensionTheme,
  sendSidePanelRequest,
} from "./uiTargetHelpers";
import {
  extractSupportedUrlsFromText,
  matchSupportedPlatformUrl,
} from "./urlMatcher";

// ============================================================================
// Core Reactive State
// ============================================================================

const viewMode = ref<PanelViewMode>("single");
const settingsOpen = ref<boolean>(false);
const downloadsExpanded = ref<boolean>(false);

const settings = ref<ExtensionSettings>({
  ...DEFAULT_EXTENSION_SETTINGS,
  theme: readCachedExtensionTheme(),
});
const connection = ref<ConnectionCheckResult | null>(null);
const tabSync = ref<TabSyncState | null>(null);
const tasks = ref<ExtensionDownloadTask[]>([]);
const savedWorkFingerprints = ref<string[]>([]);

// Single-link parse state
const urlInput = ref<string>("");
const isParsing = ref<boolean>(false);
const parseError = ref<string>("");
const parseErrorStatus = ref<number | undefined>(undefined);
const activeMedia = ref<UnifiedMedia | null>(null);
const activeWorkFingerprint = ref<string>("");
const activeResultDedupeKey = ref<string>("");
const resultOrigin = ref<"tab" | "manual" | null>(null);

// Non-destructive sync banner when user is inspecting a manual result & switches tabs
const pendingTabSyncOffer = ref<MatchedPlatformUrl | null>(null);
let lastAutoParsedDedupeKey = "";
let parseGeneration = 0;

// Lazy episode resolve tracking
const resolvingItemIds = ref<Set<string>>(new Set());
const inFlightResolves = new Map<string, Promise<MediaItem | null>>();

// Batch mode state
const batchRawText = ref<string>("");
const activeBatchGroupId = ref<string>("");
const submittingBatch = ref<boolean>(false);

// Lightweight toast notification
const toast = ref<{
  message: string;
  tone: "success" | "error" | "info";
} | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// Consumed intent deduplication so Port + GET_INITIAL_STATE + session storage never double-fire
const consumedIntentIds = new Set<string>();
let bridgeHandle: { dispose: () => void } | null = null;

// ============================================================================
// Computed Derived State
// ============================================================================

const isCurrentWorkSaved = computed<boolean>(() =>
  Boolean(
    activeWorkFingerprint.value &&
      savedWorkFingerprints.value.includes(activeWorkFingerprint.value),
  ),
);

const batchUrlPreviewCount = computed<number>(() => {
  if (!batchRawText.value.trim()) return 0;
  return extractSupportedUrlsFromText(batchRawText.value).items.length;
});

const currentTabMatched = computed<MatchedPlatformUrl | null>(
  () => tabSync.value?.matched ?? null,
);

const showOneClickCurrentTabBtn = computed<boolean>(() => {
  const matched = currentTabMatched.value;
  if (!matched || matched.isLikelyFeedOrHome) return false;
  if (!settings.value.autoFollowTab) {
    return (
      !activeMedia.value ||
      activeResultDedupeKey.value !== matched.dedupeKey ||
      Boolean(parseError.value)
    );
  }
  return false;
});

// ============================================================================
// Notification Helper
// ============================================================================

function showToast(
  message: string,
  tone: "success" | "error" | "info" = "info",
) {
  toast.value = { message, tone };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = null;
  }, 2600);
}

// ============================================================================
// Core Parse & Sync Engine
// ============================================================================

function extractFirstSupportedUrl(rawText: string): MatchedPlatformUrl | null {
  const direct = matchSupportedPlatformUrl(rawText.trim());
  if (direct) return direct;
  const extracted = extractSupportedUrlsFromText(rawText);
  return extracted.items[0] ?? null;
}

async function runParseUrl(
  rawCandidate: string,
  origin: "tab" | "manual",
  options?: { forceRefresh?: boolean },
) {
  const matched = extractFirstSupportedUrl(rawCandidate);
  if (!matched) {
    parseGeneration += 1;
    isParsing.value = false;
    parseErrorStatus.value = undefined;
    parseError.value =
      "未识别到支持的 14 个平台链接（本地隐私保护：未向后端发送任何请求）";
    return;
  }

  const myGen = ++parseGeneration;
  isParsing.value = true;
  parseError.value = "";
  parseErrorStatus.value = undefined;
  urlInput.value = matched.url;
  if (origin === "tab") {
    lastAutoParsedDedupeKey = matched.dedupeKey;
    pendingTabSyncOffer.value = null;
  }

  const rpc = await sendSidePanelRequest({
    type: "PARSE_URL",
    url: matched.url,
    locale: "zh-CN",
    ...(options?.forceRefresh ? { forceRefresh: true } : {}),
  });

  if (myGen !== parseGeneration) return;
  isParsing.value = false;

  if (!rpc.ok) {
    parseError.value = rpc.error || "解析失败，请稍后重试";
    parseErrorStatus.value = rpc.status;
    return;
  }

  activeMedia.value = rpc.data.media;
  activeWorkFingerprint.value =
    rpc.data.workFingerprint || buildWorkFingerprint(rpc.data.media);
  activeResultDedupeKey.value = rpc.data.matched?.dedupeKey || matched.dedupeKey;
  resultOrigin.value = origin;
  if (
    rpc.data.isSaved &&
    activeWorkFingerprint.value &&
    !savedWorkFingerprints.value.includes(activeWorkFingerprint.value)
  ) {
    savedWorkFingerprints.value = [
      activeWorkFingerprint.value,
      ...savedWorkFingerprints.value,
    ];
  }
}

function handleManualSubmit() {
  if (!urlInput.value.trim()) {
    showToast("请先粘贴或输入作品分享链接", "info");
    return;
  }
  pendingTabSyncOffer.value = null;
  void runParseUrl(urlInput.value, "manual");
}

async function handlePasteAndParse() {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      const clip = (await navigator.clipboard.readText()).trim();
      if (!clip) {
        showToast("剪贴板为空", "info");
        return;
      }
      urlInput.value = clip;
      pendingTabSyncOffer.value = null;
      void runParseUrl(clip, "manual");
      return;
    }
  } catch {
    // Clipboard blocked
  }
  showToast("请在输入框内按 Cmd+V / Ctrl+V 粘贴", "info");
}

function handleClearInput() {
  urlInput.value = "";
  parseError.value = "";
  parseErrorStatus.value = undefined;
}

function handleParseCurrentTabClick() {
  const matched = currentTabMatched.value;
  if (!matched) return;
  pendingTabSyncOffer.value = null;
  void runParseUrl(matched.url, "tab");
}

function handleAcceptTabSyncOffer() {
  const offer = pendingTabSyncOffer.value;
  pendingTabSyncOffer.value = null;
  if (!offer) return;
  void runParseUrl(offer.url, "tab");
}

function handleRefreshCurrentResult() {
  const targetUrl =
    urlInput.value.trim() || activeMedia.value?.source_url || "";
  if (!targetUrl) return;
  void runParseUrl(targetUrl, resultOrigin.value ?? "manual", {
    forceRefresh: true,
  });
}

// Evaluate tabSync updates with smart non-destructive manual result protection
function evaluateTabSync(nextTabSync: TabSyncState | null) {
  tabSync.value = nextTabSync;
  const matched = nextTabSync?.matched ?? null;

  if (!matched || matched.isLikelyFeedOrHome) {
    pendingTabSyncOffer.value = null;
    return;
  }

  if (!settings.value.autoFollowTab) {
    pendingTabSyncOffer.value = null;
    if (!urlInput.value.trim() && !activeMedia.value) {
      urlInput.value = matched.url;
    }
    return;
  }

  // User has an active manually pasted result for a DIFFERENT work -> protect it!
  if (
    resultOrigin.value === "manual" &&
    activeMedia.value !== null &&
    activeResultDedupeKey.value !== matched.dedupeKey
  ) {
    pendingTabSyncOffer.value = matched;
    return;
  }

  pendingTabSyncOffer.value = null;
  if (
    lastAutoParsedDedupeKey === matched.dedupeKey &&
    (isParsing.value ||
      (activeMedia.value !== null &&
        activeResultDedupeKey.value === matched.dedupeKey))
  ) {
    return;
  }

  void runParseUrl(matched.url, "tab");
}

async function handlePendingIntent(intent: PendingPanelIntent | null) {
  if (!intent || !intent.intentId) return;
  if (consumedIntentIds.has(intent.intentId)) return;
  consumedIntentIds.add(intent.intentId);

  // Acknowledge consumption in both background & session storage
  void sendSidePanelRequest({
    type: "CONSUME_INTENT",
    intentId: intent.intentId,
  });
  void consumePendingIntent(intent.intentId).catch(() => undefined);

  if (intent.mode !== "inspect" || !intent.url) {
    return;
  }

  settingsOpen.value = false;
  viewMode.value = "single";
  pendingTabSyncOffer.value = null;
  urlInput.value = intent.url;

  const matchedIntent = extractFirstSupportedUrl(intent.url);
  const isSameAsTab =
    Boolean(matchedIntent) &&
    matchedIntent?.dedupeKey === tabSync.value?.matched?.dedupeKey;
  await runParseUrl(intent.url, isSameAsTab ? "tab" : "manual");
}

function applySnapshot(snapshot: ExtensionStateSnapshot) {
  settings.value = { ...snapshot.settings };
  applyExtensionTheme(snapshot.settings.theme);
  tasks.value = [...snapshot.tasks];
  savedWorkFingerprints.value = [...snapshot.savedWorkFingerprints];
  if (snapshot.connection !== undefined) {
    connection.value = snapshot.connection ?? null;
  }
  if (snapshot.pendingIntent) {
    tabSync.value = snapshot.tabSync;
    void handlePendingIntent(snapshot.pendingIntent);
  } else {
    evaluateTabSync(snapshot.tabSync);
  }
}

function handleBackgroundBroadcast(msg: BackgroundToSidePanelBroadcast) {
  switch (msg.type) {
    case "STATE_SNAPSHOT":
      applySnapshot(msg.snapshot);
      break;
    case "TASKS_UPDATED":
      tasks.value = [...msg.tasks];
      if (msg.savedWorkFingerprints) {
        savedWorkFingerprints.value = [...msg.savedWorkFingerprints];
      }
      break;
    case "TAB_SYNC_UPDATED":
      evaluateTabSync(msg.tabSync);
      break;
    case "PANEL_INTENT":
      void handlePendingIntent(msg.intent);
      break;
  }
}

// ============================================================================
// Header / Settings / Lazy Resolve / Download Task Handlers
// ============================================================================

async function handleToggleAutoFollowHeader() {
  const nextVal = !settings.value.autoFollowTab;
  settings.value = { ...settings.value, autoFollowTab: nextVal };
  const rpc = await sendSidePanelRequest({
    type: "UPDATE_SETTINGS",
    patch: { autoFollowTab: nextVal },
  });
  if (rpc.ok) {
    settings.value = { ...rpc.data.settings };
    if (settings.value.autoFollowTab) {
      evaluateTabSync(tabSync.value);
    } else {
      pendingTabSyncOffer.value = null;
    }
  } else {
    settings.value = { ...settings.value, autoFollowTab: !nextVal };
    showToast(rpc.error || "更新自动跟随开关失败", "error");
  }
}

async function handleCycleThemeHeader() {
  const prevTheme = settings.value.theme;
  const nextTheme = getNextExtensionTheme(prevTheme);
  settings.value = { ...settings.value, theme: nextTheme };
  applyExtensionTheme(nextTheme);
  const rpc = await sendSidePanelRequest({
    type: "UPDATE_SETTINGS",
    patch: { theme: nextTheme },
  });
  if (rpc.ok) {
    settings.value = { ...rpc.data.settings };
    applyExtensionTheme(rpc.data.settings.theme);
  } else {
    settings.value = { ...settings.value, theme: prevTheme };
    applyExtensionTheme(prevTheme);
    showToast(rpc.error || "切换主题失败", "error");
  }
}

function handleSettingsSaved(nextSettings: ExtensionSettings) {
  settings.value = { ...nextSettings };
  applyExtensionTheme(nextSettings.theme);
  if (settings.value.autoFollowTab) {
    evaluateTabSync(tabSync.value);
  } else {
    pendingTabSyncOffer.value = null;
  }
}

function handleLazyItemResolve(
  item: MediaItem,
  done: (resolved: MediaItem | null) => void,
) {
  if (!activeMedia.value || item.state === "unavailable" || !item.resolve_url) {
    done(item);
    return;
  }
  const existing = inFlightResolves.get(item.id);
  if (existing) {
    void existing.then(done);
    return;
  }

  const platform = activeMedia.value.platform;
  const resolveUrl = item.resolve_url;

  const nextSet = new Set(resolvingItemIds.value);
  nextSet.add(item.id);
  resolvingItemIds.value = nextSet;

  const promise = (async (): Promise<MediaItem | null> => {
    try {
      const rpc = await sendSidePanelRequest({
        type: "RESOLVE_LAZY_ITEM",
        resolveUrl,
        platform,
        locale: "zh-CN",
      });
      if (!rpc.ok) {
        showToast(rpc.error || "分集解析失败", "error");
        return null;
      }
      const resolvedItem =
        rpc.data.media.items.find((cand) => cand.id === item.id) ??
        rpc.data.media.items[0] ??
        null;
      if (resolvedItem && activeMedia.value) {
        activeMedia.value = {
          ...activeMedia.value,
          items: activeMedia.value.items.map((old) =>
            old.id === item.id ? resolvedItem : old,
          ),
        };
      }
      return resolvedItem;
    } finally {
      inFlightResolves.delete(item.id);
      const cleanSet = new Set(resolvingItemIds.value);
      cleanSet.delete(item.id);
      resolvingItemIds.value = cleanSet;
    }
  })();

  inFlightResolves.set(item.id, promise);
  void promise.then(done);
}

async function handleEnqueueDownloads(payload: {
  items: EnqueueDownloadItem[];
  groupBatchId?: string;
}) {
  if (!payload.items.length) return;
  const rpc = await sendSidePanelRequest({
    type: "ENQUEUE_DOWNLOADS",
    items: payload.items,
    ...(payload.groupBatchId ? { groupBatchId: payload.groupBatchId } : {}),
  });
  if (!rpc.ok) {
    showToast(rpc.error || "提交下载任务失败", "error");
    return;
  }
  tasks.value = mergeEnqueuedTasks(tasks.value, rpc.data.tasks);
  downloadsExpanded.value = true;
  showToast(
    payload.items.length > 1
      ? `已将 ${payload.items.length} 个文件加入后台落盘队列`
      : "已开始后台下载（关闭侧边栏不影响落盘）",
    "success",
  );
}

async function handleSubmitBatchUrls(urls: string[]) {
  if (!urls.length || submittingBatch.value) return;
  submittingBatch.value = true;
  try {
    const rpc = await sendSidePanelRequest({
      type: "ENQUEUE_BATCH_URLS",
      urls,
      qualityPreference: settings.value.qualityPreference,
      batchSaveMode: settings.value.batchSaveMode,
      subfolderPrefix: settings.value.subfolderPrefix,
    });
    if (!rpc.ok) {
      showToast(rpc.error || "提交批量队列失败", "error");
      return;
    }
    activeBatchGroupId.value = rpc.data.groupBatchId;
    tasks.value = mergeEnqueuedTasks(tasks.value, rpc.data.tasks);
    downloadsExpanded.value = true;
    showToast(`已启动 ${urls.length} 条链接后台批量队列`, "success");
  } finally {
    submittingBatch.value = false;
  }
}

async function handleRetryFailedBatch(taskIds: string[]) {
  let retried = 0;
  for (const taskId of taskIds) {
    const rpc = await sendSidePanelRequest({ type: "RETRY_TASK", taskId });
    if (rpc.ok) retried += 1;
  }
  if (retried > 0) {
    showToast(`已重新排队 ${retried} 个失败任务`, "info");
  }
}

async function handleCancelTask(taskId: string) {
  const rpc = await sendSidePanelRequest({ type: "CANCEL_TASK", taskId });
  if (!rpc.ok) {
    showToast(rpc.error || "取消失败", "error");
  }
}

async function handleRetryTask(taskId: string) {
  const rpc = await sendSidePanelRequest({ type: "RETRY_TASK", taskId });
  if (!rpc.ok) {
    showToast(rpc.error || "重试失败", "error");
  }
}

async function handleClearFinishedTasks() {
  const rpc = await sendSidePanelRequest({ type: "CLEAR_FINISHED_TASKS" });
  if (!rpc.ok) {
    showToast(rpc.error || "清理任务记录失败", "error");
  }
}

async function handleOpenDownloadFolder(payload: {
  taskId: string;
  chromeDownloadId?: number;
}) {
  const rpc = await sendSidePanelRequest({
    type: "OPEN_DOWNLOAD_FOLDER",
    taskId: payload.taskId,
    chromeDownloadId: payload.chromeDownloadId,
  });
  if (!rpc.ok) {
    showToast(rpc.error || "无法打开文件所在目录", "error");
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

onMounted(async () => {
  bridgeHandle = createSidePanelBroadcastBridge(handleBackgroundBroadcast);

  const initialRes = await sendSidePanelRequest({ type: "GET_INITIAL_STATE" });
  if (initialRes.ok) {
    applySnapshot(initialRes.data);
  }

  // Cold-start safety net: check session pending intent directly if none consumed yet
  if (consumedIntentIds.size === 0) {
    const intentRes = await sendSidePanelRequest({ type: "CONSUME_INTENT" });
    if (intentRes.ok && intentRes.data.intent) {
      await handlePendingIntent(intentRes.data.intent);
    } else {
      const directSessionIntent = await consumePendingIntent().catch(() => null);
      if (directSessionIntent) {
        await handlePendingIntent(directSessionIntent);
      }
    }
  }
});

onUnmounted(() => {
  bridgeHandle?.dispose();
  bridgeHandle = null;
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <div class="sp-shell">
    <SidePanelHeader
      v-model:mode="viewMode"
      :settings="settings"
      :connection="connection"
      :batch-url-count="batchUrlPreviewCount"
      @toggle-auto-follow="handleToggleAutoFollowHeader"
      @cycle-theme="handleCycleThemeHeader"
      @open-settings="settingsOpen = true"
    />

    <main class="sp-main">
      <!-- SINGLE LINK MODE -->
      <template v-if="viewMode === 'single'">
        <!-- Non-destructive Tab Switch Sync Banner (when manual result is protected) -->
        <div v-if="pendingTabSyncOffer" class="sp-sync-banner">
          <div class="sp-sync-banner__text">
            当前标签页已切换为
            <strong>{{ pendingTabSyncOffer.platformLabel }}</strong> 新作品
          </div>
          <div class="sp-sync-banner__actions">
            <button
              type="button"
              class="sp-btn sp-btn--primary sp-btn--xs"
              @click="handleAcceptTabSyncOffer"
            >
              点击同步解析
            </button>
            <button
              type="button"
              class="sp-sync-banner__dismiss"
              aria-label="忽略提示"
              @click="pendingTabSyncOffer = null"
            >
              ✕
            </button>
          </div>
        </div>

        <!-- Feed / Homepage Helpful Hint Banner -->
        <div
          v-else-if="currentTabMatched && currentTabMatched.isLikelyFeedOrHome"
          class="sp-hint-strip sp-hint-strip--feed"
        >
          <span class="sp-hint-strip__dot" />
          <span>
            已识别 <strong>{{ currentTabMatched.platformLabel }}</strong> 首页/信息流 — 点进作品自动解析，或在卡片上右键极速下载
          </span>
        </div>

        <!-- Non-Supported Platform Quiet Privacy Status (shown when idle) -->
        <div
          v-else-if="!currentTabMatched && !activeMedia && !isParsing"
          class="sp-hint-strip sp-hint-strip--idle"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span>当前标签页非支持平台（零外发请求）</span>
        </div>

        <!-- Prominent 1-Click Parse Current Tab Button when autoFollowTab is off -->
        <button
          v-if="showOneClickCurrentTabBtn && currentTabMatched"
          type="button"
          class="sp-btn sp-btn--primary sp-current-tab-cta"
          :disabled="isParsing"
          @click="handleParseCurrentTabClick"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          <span>解析当前页 ({{ currentTabMatched.platformLabel }})</span>
        </button>

        <!-- Manual URL / Share Text Input Box -->
        <form class="sp-url-bar" @submit.prevent="handleManualSubmit">
          <div class="sp-url-bar__input-wrap">
            <input
              v-model="urlInput"
              type="text"
              spellcheck="false"
              autocomplete="off"
              class="sp-input sp-url-bar__input"
              placeholder="粘贴作品链接或整段分享口令..."
            />
            <button
              v-if="urlInput"
              type="button"
              class="sp-url-bar__clear"
              title="清空输入"
              aria-label="清空链接"
              @click="handleClearInput"
            >
              ✕
            </button>
          </div>

          <div class="sp-url-bar__btns">
            <button
              type="button"
              class="sp-btn sp-btn--ghost sp-btn--sm"
              :disabled="isParsing"
              title="读取剪贴板并立即解析"
              @click="handlePasteAndParse"
            >
              粘贴
            </button>
            <button
              type="submit"
              class="sp-btn sp-btn--primary sp-btn--sm sp-url-bar__submit"
              :disabled="isParsing || !urlInput.trim()"
            >
              {{ isParsing ? "解析中..." : "解析" }}
            </button>
          </div>
        </form>

        <!-- Loading Skeleton State -->
        <div v-if="isParsing && !activeMedia" class="sp-loading-card">
          <div class="sp-loading-card__spinner sp-spin" />
          <div class="sp-loading-card__text">
            <strong>正在无痕解析媒体直链...</strong>
            <span>不携带任何浏览器站点 Cookie</span>
          </div>
        </div>

        <!-- Parse Error Banner (preserves exact 401 platform-allowlist or invalid-token messages) -->
        <div v-if="parseError" class="sp-error-card" role="alert">
          <div class="sp-error-card__msg">{{ parseError }}</div>
          <div class="sp-error-card__actions">
            <button
              type="button"
              class="sp-btn sp-btn--secondary sp-btn--xs"
              @click="handleManualSubmit"
            >
              重试解析
            </button>
            <button
              v-if="parseErrorStatus === 401"
              type="button"
              class="sp-btn sp-btn--ghost sp-btn--xs"
              @click="settingsOpen = true"
            >
              检查凭据设置
            </button>
          </div>
        </div>

        <!-- Parsed Single-Work / Album / Multi-P Result View -->
        <SidePanelResult
          v-if="activeMedia"
          :media="activeMedia"
          :work-fingerprint="activeWorkFingerprint"
          :is-saved="isCurrentWorkSaved"
          :settings="settings"
          :resolving-item-ids="resolvingItemIds"
          @enqueue-downloads="handleEnqueueDownloads"
          @request-resolve-item="handleLazyItemResolve"
          @refresh-parse="handleRefreshCurrentResult"
          @notify="(p) => showToast(p.message, p.tone)"
        />

        <!-- Clean Empty Guide Card when completely idle -->
        <div
          v-else-if="!isParsing && !parseError"
          class="sp-empty-guide"
        >
          <div class="sp-empty-guide__title">极速素材收集已就绪</div>
          <ul class="sp-empty-guide__list">
            <li>支持抖音、小红书、B站、微博、YouTube 4K60、X、IG、快手、最右、头条等 14 平台</li>
            <li>网页任意卡片右键可「极速下载」或按 <kbd>Alt+Shift+D</kbd> 呼出本面板</li>
            <li>后台独立 Offscreen 引擎写盘，随时关掉侧边栏下载不断流</li>
          </ul>
        </div>
      </template>

      <!-- BATCH QUEUE MODE -->
      <SidePanelBatchQueue
        v-else
        v-model="batchRawText"
        :settings="settings"
        :tasks="tasks"
        :active-batch-group-id="activeBatchGroupId"
        :submitting="submittingBatch"
        @submit-batch="handleSubmitBatchUrls"
        @retry-failed-batch="handleRetryFailedBatch"
        @open-settings="settingsOpen = true"
        @notify="(p) => showToast(p.message, p.tone)"
      />
    </main>

    <!-- Persistent Bottom Download Task Drawer -->
    <SidePanelDownloads
      v-model:expanded="downloadsExpanded"
      :tasks="tasks"
      @cancel-task="handleCancelTask"
      @retry-task="handleRetryTask"
      @clear-finished="handleClearFinishedTasks"
      @open-folder="handleOpenDownloadFolder"
      @notify="(p) => showToast(p.message, p.tone)"
    />

    <!-- Slide-Over Settings Drawer -->
    <SidePanelSettings
      :open="settingsOpen"
      :settings="settings"
      :connection="connection"
      @close="settingsOpen = false"
      @saved="handleSettingsSaved"
      @connection-checked="(c) => (connection = c)"
      @notify="(p) => showToast(p.message, p.tone)"
    />

    <!-- Compact Floating Toast -->
    <Transition name="sp-toast">
      <div
        v-if="toast"
        class="sp-toast"
        :class="`sp-toast--${toast.tone}`"
        role="status"
      >
        {{ toast.message }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.sp-shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.sp-main {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

/* Smart Sync Banner */
.sp-sync-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  border-radius: var(--sp-radius-md);
  background: var(--sp-sync-banner-bg);
  border: 1px solid var(--sp-border-accent);
  min-width: 0;
}

.sp-sync-banner__text {
  font-size: 11.5px;
  color: var(--sp-accent-text-strong);
  line-height: 1.35;
  min-width: 0;
}

.sp-sync-banner__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.sp-sync-banner__dismiss {
  border: none;
  background: transparent;
  color: var(--sp-accent-text);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 4px;
}

/* Quiet Status / Feed Hints */
.sp-hint-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 9px;
  border-radius: var(--sp-radius-sm);
  font-size: 11px;
  line-height: 1.4;
}

.sp-hint-strip--feed {
  background: var(--sp-accent-soft);
  border: 1px solid var(--sp-accent-border);
  color: var(--sp-accent-text-strong);
}

.sp-hint-strip__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sp-accent-solid);
  flex-shrink: 0;
}

.sp-hint-strip--idle {
  background: var(--sp-subtle-bg);
  border: 1px solid var(--sp-border);
  color: var(--sp-text-muted);
}

.sp-current-tab-cta {
  width: 100%;
}

/* URL Bar */
.sp-url-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--sp-bg-surface);
  border: 1px solid var(--sp-border);
  border-radius: var(--sp-radius-md);
  box-shadow: var(--sp-shadow-card);
  padding: 8px;
}

.sp-url-bar__input-wrap {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
}

.sp-url-bar__input {
  padding-right: 28px;
  font-size: 12px;
}

.sp-url-bar__clear {
  position: absolute;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  background: var(--sp-muted-pill-bg);
  color: var(--sp-text-secondary);
  font-size: 10px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.sp-url-bar__clear:hover {
  background: var(--sp-ghost-bg-hover);
  color: var(--sp-text-primary);
}

.sp-url-bar__btns {
  display: flex;
  gap: 6px;
}

.sp-url-bar__submit {
  flex: 1;
}

/* Loading & Error Cards */
.sp-loading-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 12px;
  border-radius: var(--sp-radius-md);
  background: var(--sp-bg-surface);
  border: 1px solid var(--sp-border);
  box-shadow: var(--sp-shadow-card);
}

.sp-loading-card__spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2.2px solid var(--sp-accent-border);
  border-top-color: var(--sp-accent-solid);
  flex-shrink: 0;
}

.sp-loading-card__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11.5px;
  color: var(--sp-text-muted);
}

.sp-loading-card__text strong {
  color: var(--sp-text-primary);
  font-size: 12px;
}

.sp-error-card {
  padding: 9px 10px;
  border-radius: var(--sp-radius-md);
  background: var(--sp-danger-soft);
  border: 1px solid var(--sp-danger-border);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.sp-error-card__msg {
  font-size: 12px;
  font-weight: 600;
  color: var(--sp-danger-text-strong);
  word-break: break-word;
}

.sp-error-card__actions {
  display: flex;
  gap: 6px;
}

/* Empty State Guide */
.sp-empty-guide {
  padding: 12px;
  border-radius: var(--sp-radius-md);
  background: var(--sp-bg-empty);
  border: 1px dashed var(--sp-border-strong);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sp-empty-guide__title {
  font-size: 12px;
  font-weight: 700;
  color: var(--sp-text-secondary);
}

.sp-empty-guide__list {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--sp-text-muted);
  font-size: 11px;
  line-height: 1.45;
}

.sp-empty-guide__list kbd {
  font-family: var(--sp-font-mono);
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--sp-bg-elevated);
  border: 1px solid var(--sp-border-strong);
  color: var(--sp-text-secondary);
}

/* Floating Toast */
.sp-toast {
  position: fixed;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100vw - 24px);
  padding: 6px 12px;
  border-radius: var(--sp-radius-pill);
  background: var(--sp-bg-toast);
  border: 1px solid var(--sp-border-strong);
  color: var(--sp-text-primary);
  font-size: 11.5px;
  font-weight: 600;
  box-shadow: var(--sp-shadow-toast);
  z-index: 90;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.sp-toast--success {
  border-color: var(--sp-success-border);
  color: var(--sp-success-text);
}

.sp-toast--error {
  border-color: var(--sp-danger-border);
  color: var(--sp-danger-text);
}

.sp-toast-enter-active,
.sp-toast-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.sp-toast-enter-from,
.sp-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
