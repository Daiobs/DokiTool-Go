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
  type OwnerStatsResult,
  type PendingPanelIntent,
  type TabSyncState,
} from "./protocol";
import {
  computeTodayVsYesterday,
  formatPercent,
  type TodayVsYesterdaySummary,
} from "./statsTypes";
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
  mergeMediaAttachmentsById,
  openMonitorDashboardTab,
  readCachedExtensionTheme,
  sendSidePanelRequest,
} from "./uiTargetHelpers";
import {
  extractActiveParseUrlsFromText,
  extractSupportedUrlsFromText,
  matchActiveParseUrl,
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

// Read-only owner telemetry capsule state (silently populated ONLY on 200 OK)
const OWNER_STATS_THROTTLE_MS = 15_000;
const ownerStats = ref<OwnerStatsResult | null>(null);
let ownerStatsGeneration = 0;
let lastOwnerStatsCredentialKey = "";
let lastOwnerStatsFetchAt = 0;

// ============================================================================
// Computed Derived State
// ============================================================================

const showOwnerStatsPill = computed<boolean>(() =>
  Boolean(settings.value.bearerToken.trim() && ownerStats.value),
);

const ownerTodaySummary = computed<TodayVsYesterdaySummary | null>(() =>
  ownerStats.value ? computeTodayVsYesterday(ownerStats.value.stats) : null,
);

const ownerTodayRateText = computed<string>(() => {
  const s = ownerTodaySummary.value;
  if (!s || s.total <= 0) return "—";
  return formatPercent(s.ok, s.total, 1);
});

const ownerTodayRateTone = computed<"ok" | "warn" | "danger" | "idle">(() => {
  const s = ownerTodaySummary.value;
  if (!s || s.successRate === null) return "idle";
  if (s.successRate >= 95) return "ok";
  if (s.successRate >= 80) return "warn";
  return "danger";
});

const ownerShanghaiWorkers = computed<number>(() => {
  const workers = ownerStats.value?.stats.shanghai?.waiting_workers;
  return typeof workers === "number" && Number.isFinite(workers) && workers > 0
    ? Math.floor(workers)
    : 0;
});

const ownerShanghaiOnline = computed<boolean>(
  () => ownerShanghaiWorkers.value > 0,
);

const ownerShanghaiTitle = computed<string>(() => {
  const sh = ownerStats.value?.stats.shanghai;
  if (!sh || sh.mode === "off") {
    return "上海出口节点未启用";
  }
  return `上海出口 (${sh.mode}) · 在线 Worker ${ownerShanghaiWorkers.value} · 待处理 ${sh.queued_tasks}`;
});

const isCurrentWorkSaved = computed<boolean>(() =>
  Boolean(
    activeWorkFingerprint.value &&
      savedWorkFingerprints.value.includes(activeWorkFingerprint.value),
  ),
);

const batchUrlPreviewCount = computed<number>(() => {
  if (!batchRawText.value.trim()) return 0;
  return extractActiveParseUrlsFromText(batchRawText.value).items.length;
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
// Notification & Owner Telemetry Helpers
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

async function refreshOwnerStatsSilently(options?: {
  force?: boolean;
  targetSettings?: ExtensionSettings;
}) {
  const target = options?.targetSettings ?? settings.value;
  const token = target.bearerToken.trim();
  const apiBaseUrl = target.apiBaseUrl.trim();
  if (!token) {
    ownerStatsGeneration += 1;
    lastOwnerStatsCredentialKey = "";
    lastOwnerStatsFetchAt = 0;
    ownerStats.value = null;
    return;
  }

  const credKey = `${apiBaseUrl}|${token}`;
  const now = Date.now();
  const credentialsChanged = credKey !== lastOwnerStatsCredentialKey;
  if (
    !options?.force &&
    !credentialsChanged &&
    now - lastOwnerStatsFetchAt < OWNER_STATS_THROTTLE_MS
  ) {
    return;
  }

  if (credentialsChanged) {
    ownerStats.value = null;
  }
  lastOwnerStatsCredentialKey = credKey;
  lastOwnerStatsFetchAt = now;
  const myGen = ++ownerStatsGeneration;

  try {
    const rpc = await sendSidePanelRequest({ type: "FETCH_OWNER_STATS" });
    if (myGen !== ownerStatsGeneration) return;
    if (!settings.value.bearerToken.trim()) {
      ownerStats.value = null;
      return;
    }
    if (rpc.ok) {
      ownerStats.value = rpc.data;
    } else {
      ownerStats.value = null;
    }
  } catch {
    if (myGen === ownerStatsGeneration) {
      ownerStats.value = null;
    }
  }
}

function handleOpenMonitorDashboard() {
  void openMonitorDashboardTab();
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

function extractFirstActiveParseUrl(
  rawText: string,
): MatchedPlatformUrl | null {
  const direct = matchActiveParseUrl(rawText.trim());
  if (direct) return direct;
  const extracted = extractActiveParseUrlsFromText(rawText);
  return extracted.items[0] ?? null;
}

async function runParseUrl(
  rawCandidate: string,
  origin: "tab" | "manual",
  options?: { forceRefresh?: boolean },
) {
  const matched =
    origin === "tab"
      ? extractFirstSupportedUrl(rawCandidate)
      : extractFirstActiveParseUrl(rawCandidate);
  if (!matched) {
    parseGeneration += 1;
    isParsing.value = false;
    parseErrorStatus.value = undefined;
    parseError.value =
      origin === "tab"
        ? "未识别到支持的 14 个核心平台链接（本地隐私保护：未向后端发送任何请求）"
        : "未识别到有效的公开媒体链接（已本地拦截内网、IP 与浏览器内部地址）";
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
  if (settings.value.bearerToken.trim()) {
    void refreshOwnerStatsSilently();
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

  const matchedIntent = extractFirstActiveParseUrl(intent.url);
  const isSameAsTab =
    Boolean(matchedIntent) &&
    !matchedIntent?.isGeneric &&
    matchedIntent?.dedupeKey === tabSync.value?.matched?.dedupeKey;
  await runParseUrl(intent.url, isSameAsTab ? "tab" : "manual");
}

function applySnapshot(snapshot: ExtensionStateSnapshot) {
  const prevToken = settings.value.bearerToken.trim();
  const prevUrl = settings.value.apiBaseUrl.trim();
  settings.value = { ...snapshot.settings };
  applyExtensionTheme(snapshot.settings.theme);
  tasks.value = [...snapshot.tasks];
  savedWorkFingerprints.value = [...snapshot.savedWorkFingerprints];
  if (snapshot.connection !== undefined) {
    connection.value = snapshot.connection ?? null;
  }
  const nextToken = snapshot.settings.bearerToken.trim();
  const nextUrl = snapshot.settings.apiBaseUrl.trim();
  if (!nextToken) {
    void refreshOwnerStatsSilently({ targetSettings: snapshot.settings });
  } else if (
    nextToken !== prevToken ||
    nextUrl !== prevUrl ||
    ownerStats.value === null
  ) {
    void refreshOwnerStatsSilently({ targetSettings: snapshot.settings });
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
  const prevToken = settings.value.bearerToken.trim();
  const prevUrl = settings.value.apiBaseUrl.trim();
  settings.value = { ...nextSettings };
  applyExtensionTheme(nextSettings.theme);
  const nextToken = nextSettings.bearerToken.trim();
  const nextUrl = nextSettings.apiBaseUrl.trim();
  if (!nextToken) {
    void refreshOwnerStatsSilently({ targetSettings: nextSettings });
  } else if (nextToken !== prevToken || nextUrl !== prevUrl) {
    void refreshOwnerStatsSilently({
      force: true,
      targetSettings: nextSettings,
    });
  }
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
      const rawResolvedItem =
        rpc.data.media.items.find((cand) => cand.id === item.id) ??
        rpc.data.media.items[0] ??
        null;
      const resolvedItem: MediaItem | null =
        rawResolvedItem &&
        (!rawResolvedItem.state || rawResolvedItem.state === "ready") &&
        !rawResolvedItem.resolve_url
          ? { ...rawResolvedItem, resolve_url: resolveUrl }
          : rawResolvedItem;
      if (resolvedItem && activeMedia.value) {
        const mergedAttachments = mergeMediaAttachmentsById(
          activeMedia.value.attachments,
          rpc.data.media.attachments,
        );
        activeMedia.value = {
          ...activeMedia.value,
          items: activeMedia.value.items.map((old) =>
            old.id === item.id ? resolvedItem : old,
          ),
          ...(mergedAttachments ? { attachments: mergedAttachments } : {}),
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

    <!-- Read-Only Owner Status Capsule (STRICTLY shown only when owner /api/stats returns 200 OK) -->
    <div
      v-if="showOwnerStatsPill && ownerTodaySummary"
      class="sp-owner-pill"
      data-testid="owner-stats-pill"
    >
      <div class="sp-owner-pill__metrics">
        <span
          class="sp-owner-pill__item"
          :title="`今日成功 ${ownerTodaySummary.ok} / 失败 ${ownerTodaySummary.failed}`"
        >
          <span
            class="sp-owner-pill__dot"
            :class="`sp-owner-pill__dot--${ownerTodayRateTone}`"
          />
          <span class="sp-owner-pill__value">
            今日 {{ ownerTodaySummary.total }} 次
          </span>
          <span class="sp-owner-pill__sep">·</span>
          <span
            class="sp-owner-pill__rate"
            :class="`sp-owner-pill__rate--${ownerTodayRateTone}`"
          >
            {{ ownerTodayRateText }}
          </span>
        </span>

        <span
          class="sp-owner-pill__item sp-owner-pill__shanghai"
          :title="ownerShanghaiTitle"
        >
          <span
            class="sp-owner-pill__dot"
            :class="
              ownerShanghaiOnline
                ? 'sp-owner-pill__dot--ok'
                : 'sp-owner-pill__dot--idle'
            "
          />
          <span>上海 {{ ownerShanghaiWorkers }} 节点</span>
        </span>
      </div>

      <button
        type="button"
        class="sp-owner-pill__btn"
        data-testid="open-monitor-dashboard-btn"
        title="在新标签页打开宽屏解析监控大盘"
        @click="handleOpenMonitorDashboard"
      >
        <span>解析监控大盘</span>
        <span aria-hidden="true">↗</span>
      </button>
    </div>

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
          <span>当前标签页非自动跟随平台（零外发请求，长尾站点可手动粘贴或右键解析）</span>
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
              placeholder="粘贴作品链接或分享口令（支持 14 核心平台及 TikTok/Vimeo/Reddit/SoundCloud 等长尾站点）..."
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
            <li>支持抖音、小红书、B站、微博、YouTube 4K60、X、IG 等 14 核心平台，并支持主动粘贴解析 TikTok、Vimeo、Reddit、SoundCloud 等长尾站点</li>
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

/* Compact Owner Telemetry Capsule */
.sp-owner-pill {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 10px;
  background: var(--sp-bg-surface);
  border-bottom: 1px solid var(--sp-border);
  font-size: 11px;
  color: var(--sp-text-secondary);
  min-width: 0;
}

.sp-owner-pill__metrics {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}

.sp-owner-pill__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  min-width: 0;
}

.sp-owner-pill__shanghai {
  color: var(--sp-text-muted);
}

.sp-owner-pill__dot {
  width: 6.5px;
  height: 6.5px;
  border-radius: 50%;
  flex-shrink: 0;
}

.sp-owner-pill__dot--ok {
  background: var(--sp-success);
  box-shadow: 0 0 6px var(--sp-success-glow);
}

.sp-owner-pill__dot--warn {
  background: var(--sp-warning);
}

.sp-owner-pill__dot--danger {
  background: var(--sp-danger);
  box-shadow: 0 0 6px var(--sp-danger-glow);
}

.sp-owner-pill__dot--idle {
  background: var(--sp-dot-idle);
}

.sp-owner-pill__value {
  font-weight: 600;
  color: var(--sp-text-primary);
  font-variant-numeric: tabular-nums;
}

.sp-owner-pill__sep {
  color: var(--sp-text-muted);
}

.sp-owner-pill__rate {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.sp-owner-pill__rate--ok {
  color: var(--sp-success-text);
}

.sp-owner-pill__rate--warn {
  color: var(--sp-warning-text);
}

.sp-owner-pill__rate--danger {
  color: var(--sp-danger-text);
}

.sp-owner-pill__rate--idle {
  color: var(--sp-text-muted);
}

.sp-owner-pill__btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  border-radius: var(--sp-radius-pill);
  border: 1px solid var(--sp-accent-border);
  background: var(--sp-accent-soft);
  color: var(--sp-accent-text-strong);
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.3;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 150ms ease, border-color 150ms ease;
}

.sp-owner-pill__btn:hover {
  background: var(--sp-accent-soft-strong);
  border-color: var(--sp-border-accent);
}

.sp-owner-pill__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--sp-focus-ring);
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
