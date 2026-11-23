import { withTbvideoItems } from "../services/tbvideo";
import type {
  Attachment,
  MediaItem,
  ReadyVariant,
  Resource,
  UnifiedMedia,
  YouTubeHelperState,
} from "../types/media";
import {
  availableSources,
  deliveryRoutes,
  readyItem,
  readyVariant,
  sourceUrl,
  validateMediaEnvelope,
  type TargetContext,
} from "../utils/mediaContract";
import {
  MIN_YOUTUBE_HELPER_VERSION,
  YOUTUBE_HELPER_SCRIPT_URL,
  YOUTUBE_HELPER_VERSION,
  selectYouTubeMuxPair,
  type YouTubeHelperContextResponse,
} from "../utils/youtubeHelperCore";
import {
  computeEarliestExpiresAtMs,
  extractDashMuxSpec,
  extractVariantEarliestExpiresAtMs,
} from "./dashMuxSpec";
import {
  EXTENSION_DNR_RULE_IDS,
  buildExtensionDnrRules,
  type ExtensionDnrRule,
} from "./dnrRules";
import { buildEnqueueItemsForMedia } from "./extensionDownload";
import {
  buildSafeDownloadPath,
  sanitizeSubfolderPrefix,
} from "./filenameSanitizer";
import {
  LOOPBACK_HOST_PERMISSIONS,
  isSafeNativeBrowserDownloadUrl,
  isWhitelistedMediaUrl,
  validateApiBaseUrl,
} from "./hostWhitelist";
import {
  buildExtensionTargetContext,
  formatPlatformDisplayName,
} from "./uiTargetHelpers";
import {
  COMMAND_OPEN_SIDEPANEL,
  CONTEXT_MENU_INSPECT_ID,
  CONTEXT_MENU_QUICK_DOWNLOAD_ID,
  OFFSCREEN_IDLE_CLOSE_MS,
  OFFSCREEN_PORT_NAME,
  SIDEPANEL_PORT_NAME,
  TAB_SYNC_DEBOUNCE_MS,
  YOUTUBE_TAB_SYNC_DEBOUNCE_MS,
  errRpc,
  isOffscreenToBackgroundMessage,
  isSidePanelRequest,
  okRpc,
  type AuthMode,
  type BackgroundToOffscreenRequest,
  type BackgroundToSidePanelBroadcast,
  type BatchSaveMode,
  type ConnectionCheckResult,
  type EnqueueDownloadItem,
  type ExtensionDownloadTask,
  type ExtensionRpcResponse,
  type ExtensionSettings,
  type ExtensionStateSnapshot,
  type HandOffBlobDownloadResult,
  type MatchedPlatformUrl,
  type MediaRefreshContext,
  type OffscreenDownloadSpec,
  type OffscreenResponseMap,
  type OffscreenToBackgroundMessage,
  type OwnerStatsResult,
  type PendingPanelIntent,
  type QualityPreference,
  type SidePanelResponseMap,
  type SidePanelToBackgroundRequest,
  type TabSyncState,
} from "./protocol";
import { isValidStatsSnapshot } from "../monitor/statsTypes";
import {
  buildApiAuthHeaders,
  buildWorkFingerprint,
  createExtensionStorage,
  type ExtensionStorageController,
} from "./storage";
import {
  matchActiveParseUrl,
  matchSupportedPlatformUrl,
} from "./urlMatcher";

// ============================================================================
// Minimal Structural Chrome MV3 Types (Zero `@types/chrome` Dependency)
// ============================================================================

export interface ChromeTabLike {
  id?: number;
  windowId?: number;
  url?: string;
  active?: boolean;
}

export interface ChromePortLike {
  name?: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage?: {
    addListener(listener: (message: unknown) => void): void;
  };
  onDisconnect?: {
    addListener(listener: () => void): void;
  };
}

export interface ChromeContextMenuClickInfo {
  menuItemId: string | number;
  linkUrl?: string;
  srcUrl?: string;
  pageUrl?: string;
}

export interface ChromeDownloadDelta {
  id: number;
  state?: {
    previous?: string;
    current?: string;
  };
  error?: {
    previous?: string;
    current?: string;
  };
}

export type ChromeRuntimeMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

export interface ChromeActionLike {
  setBadgeText(details: { text: string; tabId?: number }): Promise<void> | void;
  setBadgeBackgroundColor(details: {
    color: string | [number, number, number, number];
    tabId?: number;
  }): Promise<void> | void;
  setTitle?(details: { title: string; tabId?: number }): Promise<void> | void;
}

export interface ChromeBackgroundApi {
  runtime: {
    id?: string;
    getManifest?(): {
      host_permissions?: string[];
      optional_host_permissions?: string[];
    };
    getContexts?(filter: {
      contextTypes?: string[];
      documentUrls?: string[];
    }): Promise<Array<{ contextType: string; documentUrl?: string }>>;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(listener: ChromeRuntimeMessageListener): void;
      removeListener?(listener: ChromeRuntimeMessageListener): void;
    };
    onConnect?: {
      addListener(listener: (port: ChromePortLike) => void): void;
    };
    onInstalled?: {
      addListener(listener: (details: { reason: string }) => void): void;
    };
    onStartup?: {
      addListener(listener: () => void): void;
    };
  };
  declarativeNetRequest?: {
    updateDynamicRules(options: {
      removeRuleIds?: number[];
      addRules?: ExtensionDnrRule[];
    }): Promise<void>;
    getDynamicRules?(): Promise<ExtensionDnrRule[]>;
  };
  sidePanel?: {
    setPanelBehavior?(behavior: {
      openPanelOnActionClick: boolean;
    }): Promise<void> | void;
    open(options: { tabId?: number; windowId?: number }): Promise<void>;
  };
  contextMenus?: {
    removeAll(callback?: () => void): Promise<void> | void;
    create(
      createProperties: {
        id: string;
        title: string;
        contexts: string[];
      },
      callback?: () => void,
    ): void;
    onClicked: {
      addListener(
        listener: (info: ChromeContextMenuClickInfo, tab?: ChromeTabLike) => void,
      ): void;
    };
  };
  commands?: {
    onCommand: {
      addListener(
        listener: (command: string, tab?: ChromeTabLike) => void,
      ): void;
    };
  };
  tabs?: {
    query(queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
    }): Promise<ChromeTabLike[]>;
    get?(tabId: number): Promise<ChromeTabLike>;
    onActivated?: {
      addListener(
        listener: (activeInfo: { tabId: number; windowId: number }) => void,
      ): void;
    };
    onUpdated?: {
      addListener(
        listener: (
          tabId: number,
          changeInfo: { status?: string; url?: string },
          tab: ChromeTabLike,
        ) => void,
      ): void;
    };
  };
  offscreen?: {
    createDocument(parameters: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
    closeDocument(): Promise<void>;
    hasDocument?(): Promise<boolean>;
  };
  downloads?: {
    download(options: {
      url: string;
      filename?: string;
      saveAs?: boolean;
      conflictAction?: "uniquify" | "overwrite" | "prompt";
    }): Promise<number>;
    cancel?(downloadId: number): Promise<void>;
    show?(downloadId: number): void;
    onChanged: {
      addListener(listener: (delta: ChromeDownloadDelta) => void): void;
    };
  };
  action?: ChromeActionLike;
  permissions?: {
    contains?(permissions: {
      origins?: string[];
      permissions?: string[];
    }): Promise<boolean>;
    onAdded?: {
      addListener(listener: (permissions: { origins?: string[] }) => void): void;
    };
  };
}

export interface BackgroundControllerDeps {
  chrome?: ChromeBackgroundApi;
  storage?: ExtensionStorageController;
  fetchImpl?: typeof fetch;
  now?: () => number;
  offscreenIdleCloseMs?: number;
  badgeSuccessDurationMs?: number;
  tabSyncDebounceMs?: number;
  youtubeTabSyncDebounceMs?: number;
  maxBatchDownloadConcurrency?: number;
}

export interface BackgroundController {
  init(): Promise<void>;
  syncDynamicDnrRules(extraOrigins?: string[]): Promise<ExtensionDnrRule[]>;
  ensureOffscreenDocument(): Promise<void>;
  getSnapshot(): Promise<ExtensionStateSnapshot>;
  handleRuntimeMessage: ChromeRuntimeMessageListener;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

export const DEFAULT_ACTION_TITLE = "打开 DokiTool 侧边栏" as const;

export interface ActionIndicatorState {
  badgeText: string;
  badgeColor?: string;
  title: string;
  shouldScheduleClear: boolean;
}

const ACTION_STAGE_LABELS: Readonly<
  Partial<Record<ExtensionDownloadTask["status"], string>>
> = {
  queued: "排队中",
  parsing: "解析中",
  downloading: "下载中",
  muxing: "合流中",
  saving: "保存中",
};

function clampActivePercent(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(99, Math.round(raw)));
}

function formatActionSpeed(bytesPerSecond: unknown): string {
  if (
    typeof bytesPerSecond !== "number" ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond <= 0
  ) {
    return "";
  }
  if (bytesPerSecond >= 1_000_000) {
    return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;
  }
  if (bytesPerSecond >= 1_000) {
    return `${Math.round(bytesPerSecond / 1_000)} KB/s`;
  }
  return `${Math.round(bytesPerSecond)} B/s`;
}

function truncateActionTaskTitle(raw: string | undefined, maxChars = 28): string {
  const cleaned = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!cleaned) return "下载任务";
  const chars = Array.from(cleaned);
  if (chars.length <= maxChars) return cleaned;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

export function computeActionIndicator(
  tasks: ExtensionDownloadTask[],
  terminalOutcome?: "completed" | "failed" | "clear",
): ActionIndicatorState {
  const activeTasks = Array.isArray(tasks)
    ? tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status))
    : [];
  const activeCount = activeTasks.length;

  if (activeCount === 1) {
    const task = activeTasks[0];
    const isProgressStage =
      task.status === "downloading" ||
      task.status === "muxing" ||
      task.status === "saving";
    const pct = clampActivePercent(task.percent);
    const hasMeasurablePct = isProgressStage && pct >= 1;
    const badgeText = hasMeasurablePct ? `${pct}%` : "1";
    const stageLabel = ACTION_STAGE_LABELS[task.status] ?? "下载中";
    const pctPart = hasMeasurablePct ? ` ${pct}%` : "";
    const speedText = formatActionSpeed(task.speed);
    const speedPart = speedText ? ` (${speedText})` : "";
    const shortTitle = truncateActionTaskTitle(task.title || task.filename, 28);
    return {
      badgeText,
      badgeColor: "#6366f1",
      title: `DokiTool · ${stageLabel}${pctPart}${speedPart}\n${shortTitle}`,
      shouldScheduleClear: false,
    };
  }

  if (activeCount > 1) {
    const allHaveTotal = activeTasks.every(
      (t) => typeof t.total === "number" && Number.isFinite(t.total) && t.total > 0,
    );
    let aggPct: number;
    if (allHaveTotal) {
      let sumLoaded = 0;
      let sumTotal = 0;
      for (const t of activeTasks) {
        const safeTotal = t.total;
        const hasLoaded =
          typeof t.loaded === "number" &&
          Number.isFinite(t.loaded) &&
          t.loaded > 0;
        const safeLoaded = hasLoaded
          ? Math.min(t.loaded, safeTotal)
          : (clampActivePercent(t.percent) / 100) * safeTotal;
        sumLoaded += safeLoaded;
        sumTotal += safeTotal;
      }
      aggPct = sumTotal > 0 ? clampActivePercent((sumLoaded / sumTotal) * 100) : 0;
    } else {
      const sumPct = activeTasks.reduce(
        (acc, t) => acc + clampActivePercent(t.percent),
        0,
      );
      aggPct = clampActivePercent(sumPct / activeCount);
    }

    const totalSpeed = activeTasks.reduce(
      (acc, t) =>
        acc +
        (typeof t.speed === "number" && Number.isFinite(t.speed) && t.speed > 0
          ? t.speed
          : 0),
      0,
    );
    const speedText = formatActionSpeed(totalSpeed);
    const speedPart = speedText ? ` (${speedText})` : "";

    const topTask =
      activeTasks.find(
        (t) =>
          t.status === "downloading" ||
          t.status === "muxing" ||
          t.status === "saving",
      ) ?? activeTasks[0];
    const topPct = clampActivePercent(topTask.percent);
    const topTitle = truncateActionTaskTitle(
      topTask.title || topTask.filename,
      28,
    );

    return {
      badgeText: aggPct >= 1 ? `${aggPct}%` : String(activeCount),
      badgeColor: "#6366f1",
      title: `DokiTool · 后台下载中 ${activeCount} 个任务 · 总进度 ${aggPct}%${speedPart}\n当前：${topTitle} (${topPct}%)`,
      shouldScheduleClear: false,
    };
  }

  if (terminalOutcome === "completed") {
    return {
      badgeText: "✓",
      badgeColor: "#10b981",
      title: "DokiTool · 后台下载已完成（点击打开侧边栏查看）",
      shouldScheduleClear: true,
    };
  }

  if (terminalOutcome === "failed") {
    return {
      badgeText: "!",
      badgeColor: "#ef4444",
      title: "DokiTool · 有后台任务失败（点击打开侧边栏查看或重试）",
      shouldScheduleClear: false,
    };
  }

  return {
    badgeText: "",
    title: DEFAULT_ACTION_TITLE,
    shouldScheduleClear: false,
  };
}

const ACTIVE_TASK_STATUSES = new Set<ExtensionDownloadTask["status"]>([
  "queued",
  "parsing",
  "downloading",
  "muxing",
  "saving",
]);

const FINISHED_TASK_STATUSES = new Set<ExtensionDownloadTask["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

function sanitizeRelativeDownloadPath(rawPath: string): string {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) return "download.bin";
  const segments = trimmed
    .split(/[/\\]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..");
  if (segments.length === 0) return "download.bin";
  const leaf = segments[segments.length - 1];
  const dotIdx = leaf.lastIndexOf(".");
  const ext = dotIdx > 0 ? leaf.slice(dotIdx + 1) : "";
  const stem = dotIdx > 0 ? leaf.slice(0, dotIdx) : leaf;
  const folderPrefix = sanitizeSubfolderPrefix(segments.slice(0, -1).join("/"));
  return buildSafeDownloadPath({
    prefix: folderPrefix,
    stem,
    ext,
  });
}

export class HttpStatusError extends Error {
  status: number;
  retry_after_seconds?: number;
  rateLimitRetried?: boolean;
  code?: string;

  constructor(
    message: string,
    status: number,
    retryAfterSeconds?: number,
    code?: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
    if (
      typeof retryAfterSeconds === "number" &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds > 0
    ) {
      this.retry_after_seconds = Math.ceil(retryAfterSeconds);
    }
    this.code = code;
  }
}

export async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  onRateLimitWait?: (seconds: number) => void,
): Promise<T> {
  const abortErr = () =>
    signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortErr();
    try {
      return await operation();
    } catch (err) {
      const statusErr = err as HttpStatusError | undefined;
      if (statusErr?.rateLimitRetried) throw err;
      const wait = statusErr?.retry_after_seconds;
      if (
        statusErr?.status !== 429 ||
        !(typeof wait === "number" && wait > 0 && wait <= 15) ||
        attempt >= 2
      ) {
        if (statusErr?.status === 429 && !Object.isFrozen(statusErr)) {
          statusErr.rateLimitRetried = true;
        }
        throw err;
      }
      for (let sec = Math.ceil(wait); sec > 0; sec--) {
        if (signal?.aborted) throw abortErr();
        onRateLimitWait?.(sec);
        await new Promise<void>((res, rej) => {
          const stop = () => {
            clearTimeout(timer);
            rej(abortErr());
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", stop);
            res();
          }, 1000);
          (timer as { unref?: () => void })?.unref?.();
          signal?.addEventListener("abort", stop, { once: true });
          if (signal?.aborted) stop();
        });
      }
    }
  }
}

function parseRetryAfterHeader(
  response: Response,
  payload?: unknown,
): number | undefined {
  if (response.status !== 429) return undefined;
  const bodyRetry = (
    payload as { error?: { retry_after_seconds?: unknown } } | null
  )?.error?.retry_after_seconds;
  for (const candidate of [bodyRetry, response.headers.get("Retry-After")]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) {
      return Math.ceil(n);
    }
  }
  return undefined;
}

function extractApiErrorMessage(
  payload: unknown,
  fallbackStatus: number,
): { message: string; code?: string } {
  if (payload && typeof payload === "object") {
    const rec = payload as {
      code?: unknown;
      msg?: unknown;
      message?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    const errMsg =
      (typeof rec.error?.message === "string" && rec.error.message.trim()) ||
      (typeof rec.msg === "string" && rec.msg.trim()) ||
      (typeof rec.message === "string" && rec.message.trim()) ||
      "";
    const errCode =
      (typeof rec.error?.code === "string" && rec.error.code.trim()) ||
      (typeof rec.code === "string" && rec.code.trim()) ||
      undefined;
    if (errMsg) {
      return { message: errMsg, code: errCode };
    }
  }
  if (fallbackStatus === 401) {
    return { message: "认证凭据无效", code: "UNAUTHORIZED" };
  }
  return { message: `请求失败（HTTP ${fallbackStatus}）` };
}

interface PendingBlobDownloadRecord {
  downloadId: number;
  taskId: string;
  blobUrl: string;
  filename: string;
  opfsTempName?: string;
}

export function createBackgroundController(
  deps?: BackgroundControllerDeps,
): BackgroundController {
  const chromeApi =
    deps?.chrome ??
    (globalThis as unknown as { chrome?: ChromeBackgroundApi }).chrome;
  if (!chromeApi?.runtime) {
    throw new Error("Background controller requires chrome.runtime API");
  }

  const storage = deps?.storage ?? createExtensionStorage();
  const fetchFn: typeof fetch =
    deps?.fetchImpl ??
    ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const nowFn = deps?.now ?? (() => Date.now());
  const offscreenIdleCloseMs =
    deps?.offscreenIdleCloseMs ?? OFFSCREEN_IDLE_CLOSE_MS;
  const badgeSuccessDurationMs = deps?.badgeSuccessDurationMs ?? 3_000;
  const tabSyncDebounceMs = deps?.tabSyncDebounceMs ?? TAB_SYNC_DEBOUNCE_MS;
  const youtubeTabSyncDebounceMs =
    deps?.youtubeTabSyncDebounceMs ?? YOUTUBE_TAB_SYNC_DEBOUNCE_MS;
  const maxBatchDownloadConcurrency = Math.max(
    1,
    deps?.maxBatchDownloadConcurrency ?? 3,
  );

  let disposed = false;
  let idSeq = 0;
  const nextId = (prefix: string): string =>
    `${prefix}-${nowFn()}-${++idSeq}`;

  const sidePanelPorts = new Set<ChromePortLike>();
  let offscreenPort: ChromePortLike | null = null;
  let offscreenDocumentOpen = false;
  let inFlightOffscreenRpcs = 0;
  let offscreenIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let badgeClearTimer: ReturnType<typeof setTimeout> | null = null;
  let tabSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActionBadgeText: string | null = null;
  let lastActionBadgeColor: string | null = null;
  let lastActionTitle: string | null = null;

  let currentTabSync: TabSyncState | null = null;
  let initialTabSyncPromise: Promise<void> | null = null;
  let lastBroadcastTabKey = "";
  let lastConnectionCheck: ConnectionCheckResult | null = null;

  const tasks = new Map<string, ExtensionDownloadTask>();
  const taskOrder: string[] = [];
  const parseAbortControllers = new Map<string, AbortController>();
  const pendingBlobDownloads = new Map<number, PendingBlobDownloadRecord>();
  const earlyDownloadDeltas = new Map<number, ChromeDownloadDelta>();

  let backgroundAsyncJobs = 0;
  const idleWaiters: Array<() => void> = [];
  const taskSettledWaiters = new Map<string, Array<() => void>>();

  let dnrMutex: Promise<unknown> = Promise.resolve();
  let offscreenMutex: Promise<void> = Promise.resolve();

  const flushSettledTaskWaiters = () => {
    for (const [taskId, callbacks] of Array.from(taskSettledWaiters.entries())) {
      const t = tasks.get(taskId);
      if (disposed || !t || FINISHED_TASK_STATUSES.has(t.status)) {
        taskSettledWaiters.delete(taskId);
        for (const cb of callbacks) cb();
      }
    }
  };

  const notifyIfCompletelyIdle = () => {
    flushSettledTaskWaiters();
    const hasActiveTask = Array.from(tasks.values()).some((t) =>
      ACTIVE_TASK_STATUSES.has(t.status),
    );
    if (
      !hasActiveTask &&
      pendingBlobDownloads.size === 0 &&
      backgroundAsyncJobs === 0
    ) {
      for (const resolve of idleWaiters.splice(0)) {
        resolve();
      }
    }
  };

  const trackBackgroundJob = <T>(promise: Promise<T>): Promise<T> => {
    backgroundAsyncJobs += 1;
    return promise.finally(() => {
      backgroundAsyncJobs = Math.max(0, backgroundAsyncJobs - 1);
      notifyIfCompletelyIdle();
    });
  };

  const getOrderedTasks = (): ExtensionDownloadTask[] => {
    const list: ExtensionDownloadTask[] = [];
    for (const id of taskOrder) {
      const t = tasks.get(id);
      if (t) list.push({ ...t });
    }
    return list;
  };

  const countActiveTasks = (): number => {
    let count = 0;
    for (const task of tasks.values()) {
      if (ACTIVE_TASK_STATUSES.has(task.status)) {
        count += 1;
      }
    }
    return count;
  };

  const broadcastToSidePanels = (msg: BackgroundToSidePanelBroadcast): void => {
    for (const port of Array.from(sidePanelPorts)) {
      try {
        port.postMessage(msg);
      } catch {
        sidePanelPorts.delete(port);
      }
    }
  };

  const broadcastTasksUpdated = async (
    includeSavedFingerprints = false,
  ): Promise<void> => {
    flushSettledTaskWaiters();
    let savedWorkFingerprints: string[] | undefined;
    if (includeSavedFingerprints) {
      const saved = await storage.getSavedWorks();
      savedWorkFingerprints = saved.map((s) => s.fingerprint);
    }
    broadcastToSidePanels({
      type: "TASKS_UPDATED",
      tasks: getOrderedTasks(),
      ...(savedWorkFingerprints ? { savedWorkFingerprints } : {}),
    });
  };

  const updateBadge = (
    terminalOutcome?: "completed" | "failed" | "clear",
  ): void => {
    if (disposed || !chromeApi.action) return;
    // Preserve terminal "!" / "✓" indicators when a late cancel/abort callback
    // invokes `updateBadge()` without an explicit terminal outcome while idle.
    if (
      countActiveTasks() === 0 &&
      terminalOutcome === undefined &&
      (lastActionBadgeText === "!" || lastActionBadgeText === "✓")
    ) {
      return;
    }
    const indicator = computeActionIndicator(getOrderedTasks(), terminalOutcome);

    if (badgeClearTimer !== null) {
      clearTimeout(badgeClearTimer);
      badgeClearTimer = null;
    }

    if (
      indicator.badgeColor !== undefined &&
      indicator.badgeColor !== lastActionBadgeColor
    ) {
      lastActionBadgeColor = indicator.badgeColor;
      void chromeApi.action.setBadgeBackgroundColor({
        color: indicator.badgeColor,
      });
    }

    if (indicator.badgeText !== lastActionBadgeText) {
      lastActionBadgeText = indicator.badgeText;
      void chromeApi.action.setBadgeText({ text: indicator.badgeText });
    }

    if (indicator.title !== lastActionTitle) {
      lastActionTitle = indicator.title;
      void chromeApi.action.setTitle?.({ title: indicator.title });
    }

    if (indicator.shouldScheduleClear) {
      badgeClearTimer = setTimeout(() => {
        badgeClearTimer = null;
        if (!disposed && countActiveTasks() === 0) {
          updateBadge("clear");
        }
      }, badgeSuccessDurationMs);
      (badgeClearTimer as { unref?: () => void })?.unref?.();
    }
  };

  // ==========================================================================
  // 1. Dynamic DNR Rule Synchronization
  // ==========================================================================

  const syncDynamicDnrRules = (
    extraOrigins?: string[],
  ): Promise<ExtensionDnrRule[]> => {
    const run = async (): Promise<ExtensionDnrRule[]> => {
      const extensionId = chromeApi.runtime.id || "dokitool-ext";
      const settings = await storage.getSettings();
      const originsSet = new Set<string>();
      const validated = validateApiBaseUrl(settings.apiBaseUrl);
      if (validated.ok && !validated.isLoopback) {
        originsSet.add(validated.origin);
      }
      for (const candidate of extraOrigins ?? []) {
        const extraValidated = validateApiBaseUrl(candidate);
        if (extraValidated.ok && !extraValidated.isLoopback) {
          originsSet.add(extraValidated.origin);
        }
      }
      const rules = buildExtensionDnrRules(extensionId, {
        extraApiOrigins: Array.from(originsSet),
      });

      if (chromeApi.declarativeNetRequest?.updateDynamicRules) {
        await chromeApi.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [...EXTENSION_DNR_RULE_IDS],
          addRules: rules,
        });
      }
      return rules;
    };

    const chained = dnrMutex.then(run, run);
    dnrMutex = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  };

  const resolveExtraAllowedMediaOrigins = async (
    settings: ExtensionSettings,
  ): Promise<string[]> => {
    const allowed = new Set<string>();
    const validated = validateApiBaseUrl(settings.apiBaseUrl);
    if (validated.ok) {
      allowed.add(validated.origin);
    }

    const manifestHosts =
      chromeApi.runtime.getManifest?.()?.host_permissions ?? [];
    for (const pattern of LOOPBACK_HOST_PERMISSIONS) {
      if (manifestHosts.includes(pattern)) {
        allowed.add(pattern);
        continue;
      }
      if (chromeApi.permissions?.contains) {
        try {
          const granted = await chromeApi.permissions.contains({
            origins: [pattern],
          });
          if (granted) {
            allowed.add(pattern);
          }
        } catch {
          // Ignore permission check errors
        }
      }
    }
    return Array.from(allowed);
  };

  // ==========================================================================
  // 2. Offscreen Lifecycle & Idle Cleanup
  // ==========================================================================

  const clearOffscreenIdleTimer = () => {
    if (offscreenIdleTimer !== null) {
      clearTimeout(offscreenIdleTimer);
      offscreenIdleTimer = null;
    }
  };

  const isOffscreenIdle = (): boolean =>
    countActiveTasks() === 0 &&
    pendingBlobDownloads.size === 0 &&
    inFlightOffscreenRpcs === 0;

  const scheduleOffscreenIdleCloseIfIdle = () => {
    clearOffscreenIdleTimer();
    if (disposed || !isOffscreenIdle()) {
      return;
    }
    offscreenIdleTimer = setTimeout(() => {
      offscreenIdleTimer = null;
      if (disposed || !isOffscreenIdle()) {
        return;
      }
      void (async () => {
        try {
          if (offscreenDocumentOpen || (await hasOpenOffscreenContext())) {
            await chromeApi.offscreen?.closeDocument();
          }
        } catch {
          // Ignore if already closed
        } finally {
          offscreenDocumentOpen = false;
        }
      })();
    }, offscreenIdleCloseMs);
    (offscreenIdleTimer as { unref?: () => void })?.unref?.();
  };

  const hasOpenOffscreenContext = async (): Promise<boolean> => {
    if (typeof chromeApi.runtime.getContexts === "function") {
      try {
        const contexts = await chromeApi.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
        });
        return contexts.length > 0;
      } catch {
        // Fall through
      }
    }
    if (typeof chromeApi.offscreen?.hasDocument === "function") {
      try {
        return await chromeApi.offscreen.hasDocument();
      } catch {
        // Fall through
      }
    }
    return offscreenDocumentOpen;
  };

  const ensureOffscreenDocument = (): Promise<void> => {
    const run = async (): Promise<void> => {
      clearOffscreenIdleTimer();
      // Always ensure DNR rules are active before Offscreen initiates network requests
      await syncDynamicDnrRules();

      if (await hasOpenOffscreenContext()) {
        offscreenDocumentOpen = true;
        return;
      }
      if (!chromeApi.offscreen?.createDocument) {
        offscreenDocumentOpen = true;
        return;
      }

      try {
        await chromeApi.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["BLOBS"],
          justification:
            "Stream media to OPFS and create Blob URLs for cookie-free downloads",
        });
        offscreenDocumentOpen = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/single offscreen document/i.test(msg)) {
          offscreenDocumentOpen = true;
          return;
        }
        throw err;
      }
    };

    const next = offscreenMutex.then(run, run);
    offscreenMutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const sendToOffscreen = async <
    T extends BackgroundToOffscreenRequest["type"],
  >(
    req: Extract<BackgroundToOffscreenRequest, { type: T }>,
    options?: { skipEnsure?: boolean },
  ): Promise<OffscreenResponseMap[T]> => {
    clearOffscreenIdleTimer();
    const isNonTaskRpc =
      req.type === "OFFSCREEN_YOUTUBE_PLAYER" || req.type === "OFFSCREEN_PING";
    if (isNonTaskRpc) {
      inFlightOffscreenRpcs += 1;
    }
    try {
      if (!options?.skipEnsure) {
        await ensureOffscreenDocument();
      }
      const raw = (await chromeApi.runtime.sendMessage(req)) as
        | ExtensionRpcResponse<OffscreenResponseMap[T]>
        | undefined;
      if (!raw || typeof raw !== "object" || !("ok" in raw)) {
        throw new Error("Offscreen 执行器未响应");
      }
      if (!raw.ok) {
        const err = new Error(raw.error || "Offscreen 请求失败") as Error & {
          code?: string;
          status?: number;
        };
        err.code = raw.code;
        err.status = raw.status;
        throw err;
      }
      return raw.data;
    } finally {
      if (isNonTaskRpc) {
        inFlightOffscreenRpcs = Math.max(0, inFlightOffscreenRpcs - 1);
        scheduleOffscreenIdleCloseIfIdle();
      }
    }
  };

  const sendReleaseBlobToOffscreen = async (params: {
    taskId: string;
    blobUrl: string;
    opfsTempName?: string;
  }): Promise<void> => {
    try {
      await chromeApi.runtime.sendMessage({
        type: "RELEASE_BLOB",
        taskId: params.taskId,
        blobUrl: params.blobUrl,
        ...(params.opfsTempName ? { opfsTempName: params.opfsTempName } : {}),
      } satisfies BackgroundToOffscreenRequest);
    } catch {
      // Ignore if offscreen already closed
    }
  };

  // ==========================================================================
  // 3. Cookie-Free API Client, Parse, YouTube 3-Step Flow & Lazy Resolve
  // ==========================================================================

  const fetchApiJson = async (
    url: string,
    settings: Pick<ExtensionSettings, "bearerToken">,
    init?: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const extraHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers = buildApiAuthHeaders(settings, {
      Accept: "application/json",
      ...extraHeaders,
    });

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    const timeout = setTimeout(
      () => controller.abort(new Error("请求后端超时，请稍后重试")),
      55_000,
    );
    (timeout as { unref?: () => void })?.unref?.();

    try {
      const resp = await fetchFn(url, {
        ...init,
        headers,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });

      const payload = await resp.json().catch(() => null);
      if (!resp.ok) {
        const extracted = extractApiErrorMessage(payload, resp.status);
        throw new HttpStatusError(
          extracted.message,
          resp.status,
          parseRetryAfterHeader(resp, payload),
          extracted.code,
        );
      }
      if (payload === null) {
        throw new HttpStatusError(
          `接口返回无效 JSON（HTTP ${resp.status}）`,
          resp.status,
        );
      }
      return payload;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  const runTestConnection = async (params?: {
    apiBaseUrl?: string;
    bearerToken?: string;
  }): Promise<ConnectionCheckResult> => {
    const saved = await storage.getSettings();
    const candidateUrl =
      params?.apiBaseUrl !== undefined ? params.apiBaseUrl : saved.apiBaseUrl;
    const candidateToken =
      params?.bearerToken !== undefined
        ? params.bearerToken.trim()
        : saved.bearerToken;
    const authMode: AuthMode =
      candidateToken.length > 0 ? "authenticated" : "anonymous";

    const validated = validateApiBaseUrl(candidateUrl);
    if (!validated.ok) {
      const invalidRes: ConnectionCheckResult = {
        ok: false,
        status: 0,
        authMode,
        message: validated.error || "后端地址格式无效",
        checkedAt: nowFn(),
      };
      lastConnectionCheck = invalidRes;
      return invalidRes;
    }

    if (!validated.isLoopback && chromeApi.declarativeNetRequest) {
      await syncDynamicDnrRules([validated.origin]).catch(() => []);
    }

    const endpoint = `${validated.origin}/api/platforms?schema_version=1.0`;
    try {
      const headers = buildApiAuthHeaders(
        { bearerToken: candidateToken },
        { Accept: "application/json" },
      );
      const resp = await fetchFn(endpoint, {
        method: "GET",
        headers,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      const payload = await resp.json().catch(() => null);

      if (resp.status === 200 && (payload as { code?: unknown })?.code === "OK") {
        const platforms = Array.isArray(
          (payload as { data?: { platforms?: unknown[] } })?.data?.platforms,
        )
          ? (payload as { data: { platforms: unknown[] } }).data.platforms
          : [];
        const platformCount = platforms.length;
        const message =
          authMode === "authenticated"
            ? `200 已就绪（已加载 ${platformCount} 个平台）`
            : `200 匿名模式已连通（已加载 ${platformCount} 个平台）`;
        const okRes: ConnectionCheckResult = {
          ok: true,
          status: 200,
          authMode,
          platformCount,
          message,
          checkedAt: nowFn(),
        };
        lastConnectionCheck = okRes;
        return okRes;
      }

      const extracted = extractApiErrorMessage(payload, resp.status);
      const formattedMessage = extracted.message.startsWith(String(resp.status))
        ? extracted.message
        : `${resp.status} ${extracted.message}`;
      const failRes: ConnectionCheckResult = {
        ok: false,
        status: resp.status,
        authMode,
        message: formattedMessage,
        checkedAt: nowFn(),
      };
      lastConnectionCheck = failRes;
      return failRes;
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : "无法连接后端服务";
      const netFail: ConnectionCheckResult = {
        ok: false,
        status: 0,
        authMode,
        message: msg,
        checkedAt: nowFn(),
      };
      lastConnectionCheck = netFail;
      return netFail;
    }
  };

  const fetchOwnerStats = async (): Promise<
    ExtensionRpcResponse<OwnerStatsResult>
  > => {
    const saved = await storage.getSettings();
    const token = saved.bearerToken.trim();
    if (!token) {
      return errRpc("未配置凭据", { status: 401, code: "NO_TOKEN" });
    }

    const validated = validateApiBaseUrl(saved.apiBaseUrl);
    if (!validated.ok) {
      return errRpc(validated.error || "后端地址格式无效", {
        status: 400,
        code: "STATS_FAILED",
      });
    }

    if (!validated.isLoopback && chromeApi.declarativeNetRequest) {
      await syncDynamicDnrRules([validated.origin]).catch(() => []);
    }

    const endpoint = `${validated.origin}/api/stats?schema_version=1.0`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("获取监控统计超时，请稍后重试")),
      15_000,
    );
    (timeout as { unref?: () => void })?.unref?.();

    try {
      const headers = buildApiAuthHeaders(
        { bearerToken: token },
        { Accept: "application/json" },
      );
      const resp = await fetchFn(endpoint, {
        method: "GET",
        headers,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await resp.json().catch(() => null);

      if (
        resp.status === 200 &&
        payload &&
        typeof payload === "object" &&
        (payload as { code?: unknown }).code === "OK" &&
        isValidStatsSnapshot((payload as { data?: unknown }).data)
      ) {
        return okRpc({
          stats: (payload as { data: OwnerStatsResult["stats"] }).data,
          apiOrigin: validated.origin,
          fetchedAt: nowFn(),
        });
      }

      if (resp.status === 200) {
        return errRpc("监控接口返回数据格式无效", {
          status: 502,
          code: "STATS_FAILED",
        });
      }

      const extracted = extractApiErrorMessage(payload, resp.status);
      return errRpc(extracted.message, {
        status: resp.status,
        code: resp.status === 401 ? "UNAUTHORIZED" : "STATS_FAILED",
      });
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : "无法获取监控统计";
      return errRpc(msg, { status: 0, code: "STATS_FAILED" });
    } finally {
      clearTimeout(timeout);
    }
  };

  const parseSupportedUrlInternal = async (
    matched: MatchedPlatformUrl,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<UnifiedMedia> => {
    const validated = validateApiBaseUrl(settings.apiBaseUrl);
    if (!validated.ok) {
      throw new Error(validated.error || "后端地址无效");
    }
    const apiOrigin = validated.origin;
    await syncDynamicDnrRules();

    const requestStandardParse = async (): Promise<UnifiedMedia> => {
      const parseEndpoint = `${apiOrigin}/api/parse?schema_version=1.0&platform=all&url=${encodeURIComponent(matched.url)}`;
      const payload = await withRateLimitRetry(
        () => fetchApiJson(parseEndpoint, settings, { method: "GET" }, signal),
        signal,
      );
      return withTbvideoItems(validateMediaEnvelope(payload, { apiOrigin }));
    };

    if (matched.platform === "youtube" && matched.youtubeVideoId) {
      const videoId = matched.youtubeVideoId;
      let contextData: YouTubeHelperContextResponse;
      try {
        const contextPayload = (await withRateLimitRetry(
          () =>
            fetchApiJson(
              `${apiOrigin}/api/youtube/context?schema_version=1.0`,
              settings,
              { method: "GET" },
              signal,
            ),
          signal,
        )) as {
          schema_version?: string;
          code?: string;
          data?: YouTubeHelperContextResponse;
        };
        if (
          !contextPayload ||
          contextPayload.schema_version !== "1.0" ||
          contextPayload.code !== "OK" ||
          !contextPayload.data?.player_id
        ) {
          throw new Error("获取 YouTube 解析上下文失败");
        }
        contextData = contextPayload.data;
      } catch (err) {
        if (err instanceof HttpStatusError && err.status === 404) {
          return requestStandardParse();
        }
        throw err;
      }

      const { player: playerResult } = await sendToOffscreen({
        type: "OFFSCREEN_YOUTUBE_PLAYER",
        payload: {
          video_id: videoId,
          signature_timestamp: contextData.signature_timestamp,
          client: contextData.client,
        },
        timeoutMs: 20_000,
      });

      const playStatus = playerResult?.playabilityStatus?.status || "ERROR";
      if (playStatus === "LOGIN_REQUIRED") {
        const err = new Error(
          "当前网络出口被 YouTube 要求验证，请更换节点后重试",
        ) as Error & { code?: string };
        err.code = "LOGIN_REQUIRED";
        throw err;
      }
      if (playStatus !== "OK") {
        throw new Error(
          playerResult?.playabilityStatus?.reason ||
            `YouTube 返回不可播放状态（${playStatus}）`,
        );
      }

      const vd = playerResult.videoDetails;
      const finalizeBody: Record<string, unknown> = {
        video_id: videoId,
        player_id: contextData.player_id,
        formats: playerResult.streamingData?.formats || [],
        adaptiveFormats: playerResult.streamingData?.adaptiveFormats || [],
      };
      if (typeof vd?.title === "string" && vd.title.trim()) {
        finalizeBody.title = vd.title.trim();
      }
      if (typeof vd?.author === "string" && vd.author.trim()) {
        finalizeBody.author = vd.author.trim();
      }
      if (
        typeof vd?.lengthSeconds === "number" &&
        Number.isInteger(vd.lengthSeconds) &&
        vd.lengthSeconds > 0
      ) {
        finalizeBody.duration_seconds = vd.lengthSeconds;
      }
      if (typeof vd?.thumbnail === "string" && vd.thumbnail.trim()) {
        finalizeBody.thumbnail = vd.thumbnail.trim();
      }

      const finalizePayload = await withRateLimitRetry(
        () =>
          fetchApiJson(
            `${apiOrigin}/api/youtube/finalize?schema_version=1.0`,
            settings,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(finalizeBody),
            },
            signal,
          ),
        signal,
      );

      const finalized = withTbvideoItems(
        validateMediaEnvelope(finalizePayload, { apiOrigin }),
      );
      const readyState: YouTubeHelperState = {
        status: "ready",
        version: YOUTUBE_HELPER_VERSION,
        min_version: MIN_YOUTUBE_HELPER_VERSION,
        script_url: YOUTUBE_HELPER_SCRIPT_URL,
      };
      return {
        ...finalized,
        extra: {
          ...(finalized.extra || {}),
          youtube_helper: readyState,
        },
      };
    }

    return requestStandardParse();
  };

  const resolveLazyItemInternal = async (
    rawResolveUrl: string,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<UnifiedMedia> => {
    if (
      typeof rawResolveUrl !== "string" ||
      !rawResolveUrl.startsWith("/api/resolve?") ||
      /[\\\s#]/.test(rawResolveUrl)
    ) {
      throw new Error("条目解析地址无效");
    }

    const queryPart = rawResolveUrl.slice("/api/resolve?".length);
    const params = new URLSearchParams(queryPart);
    const innerSourceUrl = params.get("url") || "";
    if (!matchSupportedPlatformUrl(innerSourceUrl)) {
      throw new Error("条目源链接不在受支持的 14 个平台白名单内");
    }

    const validated = validateApiBaseUrl(settings.apiBaseUrl);
    if (!validated.ok) {
      throw new Error(validated.error || "后端地址无效");
    }
    await syncDynamicDnrRules();

    const fullUrl =
      validated.origin +
      rawResolveUrl +
      (params.has("schema_version") ? "" : "&schema_version=1.0");

    const payload = await withRateLimitRetry(
      () => fetchApiJson(fullUrl, settings, { method: "GET" }, signal),
      signal,
    );
    return withTbvideoItems(
      validateMediaEnvelope(payload, { apiOrigin: validated.origin }),
    );
  };

  const hydrateDeferredMediaItems = async (
    media: UnifiedMedia,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<UnifiedMedia> => {
    if (!media.items.some((item) => item.state === "deferred" && item.resolve_url)) {
      return media;
    }
    const hydratedItems: MediaItem[] = [];
    const mergedAttachments: Attachment[] = [...(media.attachments ?? [])];
    const attachmentIdxById = new Map<string, number>();
    for (let i = 0; i < mergedAttachments.length; i++) {
      const id =
        typeof mergedAttachments[i]?.id === "string"
          ? mergedAttachments[i].id
          : "";
      if (id) attachmentIdxById.set(id, i);
    }
    for (const item of media.items) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (item.state === "deferred" && item.resolve_url) {
        const resolvedMedia = await resolveLazyItemInternal(
          item.resolve_url,
          settings,
          signal,
        );
        const matchedItem = resolvedMedia.items.find((c) => c.id === item.id);
        hydratedItems.push(
          matchedItem && readyItem(matchedItem)
            ? matchedItem.resolve_url
              ? matchedItem
              : { ...matchedItem, resolve_url: item.resolve_url }
            : item,
        );
        for (const att of resolvedMedia.attachments ?? []) {
          if (!att) continue;
          const id = typeof att.id === "string" ? att.id : "";
          if (id && attachmentIdxById.has(id)) {
            mergedAttachments[attachmentIdxById.get(id)!] = att;
          } else {
            if (id) attachmentIdxById.set(id, mergedAttachments.length);
            mergedAttachments.push(att);
          }
        }
      } else {
        hydratedItems.push(item);
      }
    }
    return {
      ...media,
      items: hydratedItems,
      ...(mergedAttachments.length ? { attachments: mergedAttachments } : {}),
    };
  };

  // ==========================================================================
  // 4. Task Queue, Offscreen Dispatch, Blob Handoff & Downloads Tracking
  // ==========================================================================

  const insertOrUpdateTask = (task: ExtensionDownloadTask): void => {
    if (!tasks.has(task.taskId)) {
      taskOrder.unshift(task.taskId);
    }
    tasks.set(task.taskId, task);
  };

  const enrichSpecAllowedOrigins = async (
    spec: OffscreenDownloadSpec,
    settings: ExtensionSettings,
  ): Promise<OffscreenDownloadSpec> => {
    const extra = await resolveExtraAllowedMediaOrigins(settings);
    const merged = Array.from(
      new Set([...(spec.extraAllowedOrigins ?? []), ...extra]),
    );
    return {
      ...spec,
      extraAllowedOrigins: merged,
    };
  };

  const isSpecExpiredForDispatch = (spec: OffscreenDownloadSpec): boolean => {
    const exp = spec.refreshContext?.expiresAtMs;
    return (
      typeof exp === "number" &&
      Number.isFinite(exp) &&
      exp <= nowFn() + 5_000
    );
  };

  const refreshSpecFromContext = async (
    originalSpec: OffscreenDownloadSpec,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<OffscreenDownloadSpec> => {
    const ctx = originalSpec.refreshContext;
    if (!ctx) {
      throw new Error("缺少可重新解析的媒体上下文");
    }

    const validated = validateApiBaseUrl(settings.apiBaseUrl);
    const apiOrigin = validated.ok ? validated.origin : originalSpec.apiOrigin;
    const now = nowFn();
    const targetCtx: TargetContext = buildExtensionTargetContext(apiOrigin, now);

    let freshMedia: UnifiedMedia;
    if (ctx.resolveUrl && ctx.resolveUrl.startsWith("/api/resolve?")) {
      freshMedia = await resolveLazyItemInternal(ctx.resolveUrl, settings, signal);
    } else if (ctx.parseUrl) {
      const matched = matchActiveParseUrl(ctx.parseUrl);
      if (!matched) {
        throw new Error("刷新链接无效或不受允许");
      }
      freshMedia = await parseSupportedUrlInternal(matched, settings, signal);
      const deferredMatch = freshMedia.items.find(
        (it) =>
          it.id === ctx.itemId &&
          it.state === "deferred" &&
          Boolean(it.resolve_url),
      );
      if (
        deferredMatch &&
        deferredMatch.state === "deferred" &&
        deferredMatch.resolve_url
      ) {
        const resolvedPart = await resolveLazyItemInternal(
          deferredMatch.resolve_url,
          settings,
          signal,
        );
        const resolvedItem = resolvedPart.items.find((it) => it.id === ctx.itemId);
        if (resolvedItem && readyItem(resolvedItem)) {
          freshMedia = {
            ...freshMedia,
            items: freshMedia.items.map((it) =>
              it.id === ctx.itemId
                ? resolvedItem.resolve_url
                  ? resolvedItem
                  : { ...resolvedItem, resolve_url: deferredMatch.resolve_url }
                : it,
            ),
            attachments: [
              ...(freshMedia.attachments ?? []),
              ...(resolvedPart.attachments ?? []),
            ],
          };
        }
      }
    } else {
      throw new Error("缺少可重新解析的媒体链接");
    }

    const targetItem =
      freshMedia.items.find((it) => it.id === ctx.itemId) ??
      (freshMedia.items.length === 1 ? freshMedia.items[0] : undefined);
    if (!targetItem || !readyItem(targetItem)) {
      throw new Error("重新解析后未找到对应的就绪媒体条目");
    }

    const buildNextRefreshContext = (
      expiresAtMs?: number,
    ): MediaRefreshContext => {
      const { expiresAtMs: _staleExp, ...baseCtx } = ctx;
      const nextResolveUrl =
        targetItem.resolve_url?.trim() || baseCtx.resolveUrl;
      return {
        ...baseCtx,
        ...(nextResolveUrl ? { resolveUrl: nextResolveUrl } : {}),
        ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
      };
    };

    const stripTransportFields = (
      base: OffscreenDownloadSpec,
    ): Omit<
      OffscreenDownloadSpec,
      "segments" | "youtubeMux" | "dashMux" | "zipEntries" | "sizeBytes"
    > => {
      const {
        segments: _s,
        youtubeMux: _y,
        dashMux: _d,
        zipEntries: _z,
        sizeBytes: _sz,
        ...rest
      } = base;
      return rest;
    };

    const basePreserved = stripTransportFields(originalSpec);

    // 1) Attachment-targeted refresh (e.g. standalone Bilibili M4A or BGM)
    if (ctx.attachmentId) {
      const expectedBiliId = `bilibili-audio-${targetItem.id}`;
      let audioRes: Resource | undefined = freshMedia.attachments?.find(
        (att) =>
          att &&
          (att.id === ctx.attachmentId ||
            (ctx.attachmentId!.startsWith("bilibili-audio-") &&
              att.id === expectedBiliId)) &&
          att.resource?.delivery?.kind === "file",
      )?.resource;

      if (
        !audioRes &&
        (ctx.attachmentId.startsWith("bilibili-audio-") ||
          ctx.attachmentId.startsWith("mux-audio-"))
      ) {
        for (const v of targetItem.variants) {
          if (!readyVariant(v) || v.delivery.kind !== "mux") continue;
          const leaf = v.delivery.resources.find(
            (r) => r.role === "audio" && r.delivery.kind === "file",
          );
          if (leaf) {
            audioRes = leaf;
            break;
          }
        }
      }

      if (audioRes && audioRes.delivery.kind === "file") {
        const avail = availableSources(audioRes.delivery.sources, now);
        const routes = deliveryRoutes(avail, targetCtx);
        if (routes.length > 0) {
          const expiresAtMs = computeEarliestExpiresAtMs(avail);
          const sizeBytes = avail[0]?.size_bytes ?? originalSpec.sizeBytes;
          return {
            ...basePreserved,
            kind: "direct_file",
            apiOrigin,
            routes,
            ...(sizeBytes ? { sizeBytes } : {}),
            refreshContext: buildNextRefreshContext(expiresAtMs),
          };
        }
      }
    }

    // 2) Variant-targeted refresh
    if (ctx.variantId) {
      const targetVariant = targetItem.variants.find(
        (v): v is ReadyVariant => readyVariant(v) && v.id === ctx.variantId,
      );
      if (targetVariant) {
        if (targetVariant.delivery.kind === "mux") {
          const dashMux = extractDashMuxSpec(targetVariant, targetCtx);
          if (dashMux) {
            const expiresAtMs = extractVariantEarliestExpiresAtMs(
              targetVariant,
              now,
            );
            const sizeBytes =
              (dashMux.videoSize || 0) + (dashMux.audioSize || 0) ||
              originalSpec.sizeBytes;
            return {
              ...basePreserved,
              kind: "dash_mux",
              apiOrigin,
              routes: dashMux.videoRoutes,
              mimeType: originalSpec.mimeType || "video/mp4",
              ...(sizeBytes ? { sizeBytes } : {}),
              dashMux,
              refreshContext: buildNextRefreshContext(expiresAtMs),
            };
          }
        } else if (targetVariant.delivery.kind === "file") {
          const avail = availableSources(targetVariant.delivery.sources, now);
          const routes = deliveryRoutes(avail, targetCtx);
          if (routes.length > 0) {
            if (
              originalSpec.kind === "youtube_mux" &&
              targetVariant.metadata?.has_audio === false
            ) {
              const pair = selectYouTubeMuxPair(
                targetVariant,
                targetItem.variants,
                freshMedia.attachments,
              );
              if (pair.ok) {
                const videoUrl = routes[0];
                const audioUrl = sourceUrl(pair.audioSource, targetCtx);
                const expiresAtMs = computeEarliestExpiresAtMs([
                  avail[0],
                  pair.audioSource,
                ]);
                const sizeBytes =
                  (avail[0]?.size_bytes || 0) +
                    (pair.audioSource.size_bytes || 0) ||
                  originalSpec.sizeBytes;
                return {
                  ...basePreserved,
                  kind: "youtube_mux",
                  apiOrigin,
                  routes: [videoUrl],
                  ...(sizeBytes ? { sizeBytes } : {}),
                  youtubeMux: {
                    videoUrl,
                    audioUrl,
                    ...(avail[0]?.size_bytes
                      ? { videoSize: avail[0].size_bytes }
                      : {}),
                    ...(pair.audioSource.size_bytes
                      ? { audioSize: pair.audioSource.size_bytes }
                      : {}),
                    outputContainer: pair.outputContainer,
                  },
                  refreshContext: buildNextRefreshContext(expiresAtMs),
                };
              }
            }

            const finalRoutes = [...routes];
            if (
              targetItem.type === "video" &&
              (freshMedia.platform === "zuiyou" ||
                freshMedia.platform === "pipigx") &&
              targetItem.tbvideo?.platform === freshMedia.platform
            ) {
              const srcId = avail[0]?.id;
              const tbCand =
                srcId && Object.hasOwn(targetItem.tbvideo.sources, srcId)
                  ? targetItem.tbvideo.sources[srcId]
                  : Object.values(targetItem.tbvideo.sources)[0];
              if (tbCand && !finalRoutes.includes(tbCand)) {
                finalRoutes.push(tbCand);
              }
            }
            const expiresAtMs = computeEarliestExpiresAtMs(avail);
            const sizeBytes = avail[0]?.size_bytes ?? originalSpec.sizeBytes;
            return {
              ...basePreserved,
              kind:
                originalSpec.kind === "youtube_direct"
                  ? "youtube_direct"
                  : "direct_file",
              apiOrigin,
              routes: finalRoutes,
              ...(sizeBytes ? { sizeBytes } : {}),
              refreshContext: buildNextRefreshContext(expiresAtMs),
            };
          }
        } else if (targetVariant.delivery.kind === "hls") {
          const avail = availableSources(targetVariant.delivery.sources, now);
          const routes = deliveryRoutes(avail, targetCtx);
          if (routes.length > 0) {
            const expiresAtMs = computeEarliestExpiresAtMs(avail);
            return {
              ...basePreserved,
              kind: "hls",
              apiOrigin,
              routes,
              refreshContext: buildNextRefreshContext(expiresAtMs),
            };
          }
        } else if (targetVariant.delivery.kind === "segments") {
          const rebuilt = buildEnqueueItemsForMedia(freshMedia, {
            apiOrigin,
            itemIds: [targetItem.id],
            variantSelections: {
              [targetItem.id]: { variant_id: targetVariant.id },
            },
            sourceUrl: ctx.parseUrl,
            now,
          });
          if (rebuilt.length > 0 && rebuilt[0].spec.segments) {
            return {
              ...basePreserved,
              kind: "segments",
              apiOrigin,
              routes: rebuilt[0].spec.routes,
              segments: rebuilt[0].spec.segments,
              refreshContext: buildNextRefreshContext(
                rebuilt[0].spec.refreshContext?.expiresAtMs,
              ),
            };
          }
        } else if (targetVariant.delivery.kind === "pair") {
          const matchedRes =
            (ctx.resourceRole
              ? targetVariant.delivery.resources.find(
                  (r) => r.role === ctx.resourceRole,
                )
              : undefined) ??
            targetVariant.delivery.resources.find(
              (r) => r.role === "motion" || r.role === "video",
            ) ??
            targetVariant.delivery.resources[0];
          if (matchedRes?.delivery.kind === "file") {
            const avail = availableSources(matchedRes.delivery.sources, now);
            const routes = deliveryRoutes(avail, targetCtx);
            if (routes.length > 0) {
              const expiresAtMs = computeEarliestExpiresAtMs(avail);
              const sizeBytes = avail[0]?.size_bytes ?? originalSpec.sizeBytes;
              return {
                ...basePreserved,
                kind: "direct_file",
                apiOrigin,
                routes,
                ...(sizeBytes ? { sizeBytes } : {}),
                refreshContext: buildNextRefreshContext(expiresAtMs),
              };
            }
          } else if (matchedRes?.delivery.kind === "hls") {
            const avail = availableSources(matchedRes.delivery.sources, now);
            const routes = deliveryRoutes(avail, targetCtx);
            if (routes.length > 0) {
              const expiresAtMs = computeEarliestExpiresAtMs(avail);
              return {
                ...basePreserved,
                kind: "hls",
                apiOrigin,
                routes,
                refreshContext: buildNextRefreshContext(expiresAtMs),
              };
            }
          } else if (matchedRes?.delivery.kind === "segments") {
            const rebuilt = buildEnqueueItemsForMedia(freshMedia, {
              apiOrigin,
              itemIds: [targetItem.id],
              variantSelections: {
                [targetItem.id]: { variant_id: targetVariant.id },
              },
              sourceUrl: ctx.parseUrl,
              now,
            });
            const matchedEntry =
              (ctx.resourceRole
                ? rebuilt.find(
                    (entry) =>
                      entry.spec.refreshContext?.resourceRole ===
                      ctx.resourceRole,
                  )
                : undefined) ?? rebuilt[0];
            if (matchedEntry?.spec.segments) {
              return {
                ...basePreserved,
                kind: "segments",
                apiOrigin,
                routes: matchedEntry.spec.routes,
                segments: matchedEntry.spec.segments,
                refreshContext: buildNextRefreshContext(
                  matchedEntry.spec.refreshContext?.expiresAtMs,
                ),
              };
            }
          }
        }
      }
    }

    // 3) Fallback by quality preference when exact variant/attachment changed upstream
    const rebuiltItems = buildEnqueueItemsForMedia(freshMedia, {
      apiOrigin,
      qualityPreference: ctx.attachmentId ? "audio" : settings.qualityPreference,
      itemIds: [targetItem.id],
      sourceUrl: ctx.parseUrl,
      now,
    });
    const rebuiltSpec =
      (ctx.resourceRole
        ? rebuiltItems.find(
            (entry) =>
              entry.spec.refreshContext?.resourceRole === ctx.resourceRole,
          )?.spec
        : undefined) ?? rebuiltItems[0]?.spec;
    if (!rebuiltSpec) {
      throw new Error("重新解析后未找到可用下载源");
    }
    return {
      ...basePreserved,
      kind: rebuiltSpec.kind,
      apiOrigin,
      routes: rebuiltSpec.routes,
      ...(rebuiltSpec.sizeBytes ? { sizeBytes: rebuiltSpec.sizeBytes } : {}),
      ...(rebuiltSpec.segments ? { segments: rebuiltSpec.segments } : {}),
      ...(rebuiltSpec.youtubeMux ? { youtubeMux: rebuiltSpec.youtubeMux } : {}),
      ...(rebuiltSpec.dashMux ? { dashMux: rebuiltSpec.dashMux } : {}),
      refreshContext: buildNextRefreshContext(
        rebuiltSpec.refreshContext?.expiresAtMs,
      ),
    };
  };

  const dispatchSpecTaskToOffscreen = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    dispatchOpts?: { forceRefresh?: boolean; skipAutoRefresh?: boolean },
  ): Promise<void> => {
    const task = tasks.get(taskId);
    if (!task || task.status === "cancelled") return;

    const settings = await storage.getSettings();
    let effectiveSpec = spec;

    const refreshCtx = effectiveSpec.refreshContext;
    const shouldForceRefresh = Boolean(dispatchOpts?.forceRefresh && refreshCtx);
    const shouldAutoPreRefresh = Boolean(
      !dispatchOpts?.skipAutoRefresh &&
        !shouldForceRefresh &&
        refreshCtx &&
        isSpecExpiredForDispatch(effectiveSpec) &&
        (task.autoRefreshCount ?? 0) < 1,
    );

    if (shouldForceRefresh || shouldAutoPreRefresh) {
      const refreshController = new AbortController();
      parseAbortControllers.set(taskId, refreshController);
      const currentBeforeRefresh = tasks.get(taskId);
      if (!currentBeforeRefresh || currentBeforeRefresh.status === "cancelled") {
        parseAbortControllers.delete(taskId);
        scheduleOffscreenIdleCloseIfIdle();
        return;
      }
      const nextRefreshCount = shouldAutoPreRefresh
        ? (currentBeforeRefresh.autoRefreshCount ?? 0) + 1
        : currentBeforeRefresh.autoRefreshCount;
      tasks.set(taskId, {
        ...currentBeforeRefresh,
        status: "parsing",
        statusText: "签名链接已过期，正在自动重新解析...",
        percent: 0,
        loaded: 0,
        speed: 0,
        error: undefined,
        ...(nextRefreshCount !== undefined
          ? { autoRefreshCount: nextRefreshCount }
          : {}),
        updatedAt: nowFn(),
      });
      updateBadge();
      await broadcastTasksUpdated();

      try {
        effectiveSpec = await refreshSpecFromContext(
          effectiveSpec,
          settings,
          refreshController.signal,
        );
      } catch (err) {
        const afterErr = tasks.get(taskId);
        if (!afterErr) return;
        const cancelled =
          afterErr.status === "cancelled" ||
          refreshController.signal.aborted ||
          (err instanceof Error && err.name === "AbortError");
        if (cancelled) {
          tasks.set(taskId, {
            ...afterErr,
            status: "cancelled",
            statusText: "已取消",
            speed: 0,
            error: undefined,
            updatedAt: nowFn(),
          });
          updateBadge();
        } else {
          const msg =
            err instanceof Error && err.message
              ? err.message
              : "重新解析下载链接失败";
          tasks.set(taskId, {
            ...afterErr,
            status: "failed",
            statusText: "刷新链接失败",
            speed: 0,
            error: msg,
            lastErrorCode: "MEDIA_URL_EXPIRED",
            updatedAt: nowFn(),
          });
          updateBadge("failed");
        }
        await broadcastTasksUpdated();
        scheduleOffscreenIdleCloseIfIdle();
        notifyIfCompletelyIdle();
        return;
      } finally {
        parseAbortControllers.delete(taskId);
      }
    }

    const enrichedSpec = await enrichSpecAllowedOrigins(effectiveSpec, settings);
    const latestBeforeStart = tasks.get(taskId);
    if (!latestBeforeStart || latestBeforeStart.status === "cancelled") {
      scheduleOffscreenIdleCloseIfIdle();
      return;
    }

    const validatedSpecApi = validateApiBaseUrl(enrichedSpec.apiOrigin);
    const effectiveAllowedOrigins = Array.from(
      new Set([
        ...(enrichedSpec.extraAllowedOrigins ?? []),
        ...(validatedSpecApi.ok ? [validatedSpecApi.origin] : []),
      ]),
    );
    const isWhitelistedRoute = (rawUrl: string): boolean =>
      isWhitelistedMediaUrl(rawUrl, effectiveAllowedOrigins).allowed;

    const failUnwhitelistedInBackground = async (params: {
      message: string;
      unwhitelistedHost?: string;
      fallbackUrl?: string;
    }): Promise<void> => {
      const current = tasks.get(taskId);
      if (!current || current.status === "cancelled") {
        scheduleOffscreenIdleCloseIfIdle();
        notifyIfCompletelyIdle();
        return;
      }
      tasks.set(taskId, {
        ...current,
        status: "failed",
        statusText: "未授权媒体域名",
        speed: 0,
        error: params.message,
        lastErrorCode: "UNWHITELISTED_CDN",
        ...(params.unwhitelistedHost
          ? { unwhitelistedHost: params.unwhitelistedHost }
          : {}),
        ...(params.fallbackUrl ? { fallbackUrl: params.fallbackUrl } : {}),
        updatedAt: nowFn(),
        retryPayload: { kind: "spec", spec: enrichedSpec },
      });
      updateBadge("failed");
      await broadcastTasksUpdated();
      scheduleOffscreenIdleCloseIfIdle();
      notifyIfCompletelyIdle();
    };

    // Zero-`<all_urls>` routing guard BEFORE launching offscreen.html:
    // - Case A (`direct_file`): whitelisted -> Offscreen OPFS; non-whitelisted -> native `chrome.downloads.download`
    // - Case B (`dash_mux` | `hls` | `segments` | `youtube_mux` | `batch_zip`): non-whitelisted -> fail cleanly with UNWHITELISTED_CDN
    if (enrichedSpec.kind === "direct_file") {
      const hasWhitelistedRoute = enrichedSpec.routes.some(isWhitelistedRoute);
      if (!hasWhitelistedRoute) {
        const nativeUrl = enrichedSpec.routes.find(
          (r) =>
            isSafeNativeBrowserDownloadUrl(r, effectiveAllowedOrigins).safe,
        );
        if (!nativeUrl) {
          const firstRoute = enrichedSpec.routes[0] || "";
          const check = firstRoute
            ? isSafeNativeBrowserDownloadUrl(
                firstRoute,
                effectiveAllowedOrigins,
              )
            : { safe: false, hostname: "", reason: "缺少可用下载线路" };
          await failUnwhitelistedInBackground({
            message: check.reason || "下载链接不符合安全规则，已拦截下载",
            unwhitelistedHost: check.hostname || undefined,
            fallbackUrl: latestBeforeStart.fallbackUrl || firstRoute || undefined,
          });
          return;
        }

        if (!chromeApi.downloads?.download) {
          tasks.set(taskId, {
            ...latestBeforeStart,
            status: "failed",
            statusText: "保存失败",
            speed: 0,
            error: "chrome.downloads API 不可用",
            fallbackUrl: nativeUrl,
            updatedAt: nowFn(),
            retryPayload: { kind: "spec", spec: enrichedSpec },
          });
          updateBadge("failed");
          await broadcastTasksUpdated();
          scheduleOffscreenIdleCloseIfIdle();
          notifyIfCompletelyIdle();
          return;
        }

        const safeFilename = sanitizeRelativeDownloadPath(enrichedSpec.filename);
        let downloadId: number;
        try {
          downloadId = await chromeApi.downloads.download({
            url: nativeUrl,
            filename: safeFilename,
            saveAs: false,
            conflictAction: "uniquify",
          });
        } catch (err) {
          const current = tasks.get(taskId);
          if (current && current.status !== "cancelled") {
            const errMsg =
              err instanceof Error && err.message
                ? err.message
                : "调用浏览器原生下载失败";
            tasks.set(taskId, {
              ...current,
              status: "failed",
              statusText: "保存失败",
              speed: 0,
              error: errMsg,
              fallbackUrl: nativeUrl,
              updatedAt: nowFn(),
              retryPayload: { kind: "spec", spec: enrichedSpec },
            });
            updateBadge("failed");
            await broadcastTasksUpdated();
          }
          scheduleOffscreenIdleCloseIfIdle();
          notifyIfCompletelyIdle();
          return;
        }

        const afterDownloadStart = tasks.get(taskId);
        if (!afterDownloadStart || afterDownloadStart.status === "cancelled") {
          void chromeApi.downloads?.cancel?.(downloadId)?.catch?.(() => {});
          scheduleOffscreenIdleCloseIfIdle();
          notifyIfCompletelyIdle();
          return;
        }

        const record: PendingBlobDownloadRecord = {
          downloadId,
          taskId,
          blobUrl: "",
          filename: safeFilename,
        };
        pendingBlobDownloads.set(downloadId, record);

        tasks.set(taskId, {
          ...afterDownloadStart,
          filename: safeFilename,
          status: "downloading",
          statusText: "浏览器原生下载中...",
          total: enrichedSpec.sizeBytes ?? afterDownloadStart.total,
          chromeDownloadId: downloadId,
          fallbackUrl: nativeUrl,
          updatedAt: nowFn(),
          retryPayload: { kind: "spec", spec: enrichedSpec },
        });
        updateBadge();
        await broadcastTasksUpdated();

        // Replay if `onChanged` fired synchronously during `downloads.download`
        const earlyDelta = earlyDownloadDeltas.get(downloadId);
        if (earlyDelta) {
          earlyDownloadDeltas.delete(downloadId);
          void trackBackgroundJob(handleDownloadTerminalDelta(record, earlyDelta));
        }
        return;
      }
    } else if (
      enrichedSpec.kind === "hls" ||
      enrichedSpec.kind === "segments" ||
      enrichedSpec.kind === "dash_mux" ||
      enrichedSpec.kind === "youtube_mux" ||
      enrichedSpec.kind === "batch_zip"
    ) {
      const STREAM_UNWHITELISTED_MSG =
        "该长尾流媒体（HLS/合流）域名不在扩展白名单内，请复制直链或打开原帖下载";
      let badRoute: string | undefined;

      if (enrichedSpec.kind === "hls") {
        if (!enrichedSpec.routes.some(isWhitelistedRoute)) {
          badRoute = enrichedSpec.routes[0] || "";
        }
      } else if (enrichedSpec.kind === "segments") {
        if (!enrichedSpec.routes.some(isWhitelistedRoute)) {
          badRoute = enrichedSpec.routes[0] || "";
        } else if (enrichedSpec.segments?.length) {
          for (const seg of enrichedSpec.segments) {
            const segRoutes = seg.routes?.length
              ? seg.routes
              : seg.url
                ? [seg.url]
                : [];
            if (!segRoutes.some(isWhitelistedRoute)) {
              badRoute = segRoutes[0] || "";
              break;
            }
          }
        }
      } else if (enrichedSpec.kind === "dash_mux") {
        const videoRoutes = enrichedSpec.dashMux?.videoRoutes ?? [];
        const audioRoutes = enrichedSpec.dashMux?.audioRoutes ?? [];
        if (!videoRoutes.some(isWhitelistedRoute)) {
          badRoute = videoRoutes[0] || "";
        } else if (!audioRoutes.some(isWhitelistedRoute)) {
          badRoute = audioRoutes[0] || "";
        }
      } else if (enrichedSpec.kind === "youtube_mux") {
        const videoUrl = enrichedSpec.youtubeMux?.videoUrl ?? "";
        const audioUrl = enrichedSpec.youtubeMux?.audioUrl ?? "";
        if (!videoUrl || !isWhitelistedRoute(videoUrl)) {
          badRoute = videoUrl;
        } else if (!audioUrl || !isWhitelistedRoute(audioUrl)) {
          badRoute = audioUrl;
        }
      } else if (enrichedSpec.kind === "batch_zip") {
        for (const entry of enrichedSpec.zipEntries ?? []) {
          if (!entry.routes.some(isWhitelistedRoute)) {
            badRoute = entry.routes[0] || "";
            break;
          }
          if (entry.segments?.length) {
            for (const seg of entry.segments) {
              const segRoutes = seg.routes?.length
                ? seg.routes
                : seg.url
                  ? [seg.url]
                  : [];
              if (!segRoutes.some(isWhitelistedRoute)) {
                badRoute = segRoutes[0] || "";
                break;
              }
            }
            if (badRoute !== undefined) break;
          }
        }
      }

      if (badRoute !== undefined) {
        const check = badRoute
          ? isWhitelistedMediaUrl(badRoute, effectiveAllowedOrigins)
          : { allowed: false, hostname: "" };
        await failUnwhitelistedInBackground({
          message:
            enrichedSpec.kind === "batch_zip"
              ? "该长尾站点媒体域名不在扩展打包白名单内，请使用子文件夹方式原生下载"
              : STREAM_UNWHITELISTED_MSG,
          unwhitelistedHost: check.hostname || undefined,
          fallbackUrl:
            latestBeforeStart.fallbackUrl ||
            enrichedSpec.routes[0] ||
            badRoute ||
            undefined,
        });
        return;
      }
    }

    const updatedTask: ExtensionDownloadTask = {
      ...latestBeforeStart,
      status: enrichedSpec.kind === "youtube_mux" ? "muxing" : "downloading",
      statusText:
        enrichedSpec.kind === "youtube_mux"
          ? "正在准备 4K 无损合流..."
          : enrichedSpec.kind === "dash_mux"
            ? "正在准备音视频无损合流..."
            : "正在准备下载...",
      total: enrichedSpec.sizeBytes ?? latestBeforeStart.total,
      updatedAt: nowFn(),
      retryPayload: { kind: "spec", spec: enrichedSpec },
    };
    tasks.set(taskId, updatedTask);
    updateBadge();
    await broadcastTasksUpdated();

    if (tasks.get(taskId)?.status === "cancelled") {
      scheduleOffscreenIdleCloseIfIdle();
      return;
    }

    try {
      await sendToOffscreen({
        type: "OFFSCREEN_START_TASK",
        taskId,
        spec: enrichedSpec,
      });
      if (tasks.get(taskId)?.status === "cancelled") {
        void sendToOffscreen(
          { type: "OFFSCREEN_CANCEL_TASK", taskId },
          { skipEnsure: true },
        ).catch(() => {});
        scheduleOffscreenIdleCloseIfIdle();
      }
    } catch (err) {
      const current = tasks.get(taskId);
      if (!current || current.status === "cancelled") return;
      const msg =
        err instanceof Error && err.message ? err.message : "启动后台下载失败";
      tasks.set(taskId, {
        ...current,
        status: "failed",
        statusText: "启动失败",
        speed: 0,
        error: msg,
        updatedAt: nowFn(),
      });
      updateBadge("failed");
      await broadcastTasksUpdated();
      scheduleOffscreenIdleCloseIfIdle();
    }
  };

  const enqueueDownloadItems = async (
    items: EnqueueDownloadItem[],
    groupBatchId?: string,
  ): Promise<{ taskIds: string[]; tasks: ExtensionDownloadTask[] }> => {
    const settings = await storage.getSettings();
    const extraOrigins = await resolveExtraAllowedMediaOrigins(settings);
    const createdTasks: ExtensionDownloadTask[] = [];
    const createdIds: string[] = [];

    // Insert in reverse order when unshifting so visual order matches `items`
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const taskId = nextId("task");
      const mergedRefreshContext = item.spec.refreshContext ?? item.refreshContext;
      const enrichedSpec: OffscreenDownloadSpec = {
        ...item.spec,
        ...(mergedRefreshContext ? { refreshContext: mergedRefreshContext } : {}),
        extraAllowedOrigins: Array.from(
          new Set([...(item.spec.extraAllowedOrigins ?? []), ...extraOrigins]),
        ),
      };
      const ts = nowFn();
      const task: ExtensionDownloadTask = {
        taskId,
        ...(groupBatchId ? { groupBatchId } : {}),
        title: item.title,
        filename: enrichedSpec.filename,
        platform: item.platform,
        ...(item.workFingerprint
          ? { workFingerprint: item.workFingerprint }
          : {}),
        status: "queued",
        statusText: "排队等待下载...",
        percent: 0,
        loaded: 0,
        total: enrichedSpec.sizeBytes ?? 0,
        speed: 0,
        ...(item.fallbackUrl ? { fallbackUrl: item.fallbackUrl } : {}),
        createdAt: ts,
        updatedAt: ts,
        retryPayload: { kind: "spec", spec: enrichedSpec },
      };
      insertOrUpdateTask(task);
      createdTasks.unshift(task);
      createdIds.unshift(taskId);
    }

    updateBadge();
    await broadcastTasksUpdated();

    for (const created of createdTasks) {
      if (created.retryPayload?.kind === "spec") {
        void trackBackgroundJob(
          dispatchSpecTaskToOffscreen(created.taskId, created.retryPayload.spec),
        );
      }
    }

    return { taskIds: createdIds, tasks: createdTasks };
  };

  const waitTaskSettled = (taskId: string): Promise<void> => {
    const current = tasks.get(taskId);
    if (disposed || !current || FINISHED_TASK_STATUSES.has(current.status)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const list = taskSettledWaiters.get(taskId);
      if (list) {
        list.push(resolve);
      } else {
        taskSettledWaiters.set(taskId, [resolve]);
      }
    });
  };

  const executeUrlToDownloadFlow = async (params: {
    placeholderTaskId: string;
    matched: MatchedPlatformUrl;
    qualityPreference: QualityPreference;
    batchSaveMode: BatchSaveMode;
    subfolderPrefix: string;
    forceSubfolder: boolean;
    groupBatchId?: string;
  }): Promise<string[]> => {
    const {
      placeholderTaskId,
      matched,
      qualityPreference,
      batchSaveMode,
      subfolderPrefix,
      forceSubfolder,
      groupBatchId,
    } = params;

    const existing = tasks.get(placeholderTaskId);
    if (!existing || existing.status === "cancelled") {
      return [];
    }

    const parseController = new AbortController();
    parseAbortControllers.set(placeholderTaskId, parseController);

    tasks.set(placeholderTaskId, {
      ...existing,
      status: "parsing",
      statusText: "正在解析链接...",
      error: undefined,
      unwhitelistedHost: undefined,
      updatedAt: nowFn(),
    });
    updateBadge();
    await broadcastTasksUpdated();

    try {
      const settings = await storage.getSettings();
      const rawMedia = await parseSupportedUrlInternal(
        matched,
        settings,
        parseController.signal,
      );
      const hydratedMedia = await hydrateDeferredMediaItems(
        rawMedia,
        settings,
        parseController.signal,
      );

      if (tasks.get(placeholderTaskId)?.status === "cancelled") {
        return [];
      }

      const extraAllowedOrigins = await resolveExtraAllowedMediaOrigins(settings);
      const enqueueItems = buildEnqueueItemsForMedia(hydratedMedia, {
        apiOrigin: settings.apiBaseUrl,
        qualityPreference,
        batchSaveMode,
        subfolderPrefix,
        forceSubfolder,
        extraAllowedOrigins,
        sourceUrl: matched.url,
        now: nowFn(),
      });

      const spawnedIds: string[] = [];
      const first = enqueueItems[0];
      const currentPlaceholder = tasks.get(placeholderTaskId);
      if (!currentPlaceholder || currentPlaceholder.status === "cancelled") {
        return [];
      }

      // Transition placeholder task directly into item #1
      const firstSpec = await enrichSpecAllowedOrigins(first.spec, settings);
      tasks.set(placeholderTaskId, {
        ...currentPlaceholder,
        ...(groupBatchId ? { groupBatchId } : {}),
        title: first.title,
        filename: firstSpec.filename,
        platform: first.platform,
        workFingerprint: first.workFingerprint,
        fallbackUrl: first.fallbackUrl || matched.url,
        status: "queued",
        statusText: "排队等待下载...",
        percent: 0,
        loaded: 0,
        total: firstSpec.sizeBytes ?? 0,
        speed: 0,
        chromeDownloadId: undefined,
        error: undefined,
        updatedAt: nowFn(),
        retryPayload: { kind: "spec", spec: firstSpec },
      });
      spawnedIds.push(placeholderTaskId);

      // Insert sibling items right after placeholder in taskOrder
      const placeholderIdx = taskOrder.indexOf(placeholderTaskId);
      for (let i = 1; i < enqueueItems.length; i++) {
        const sibling = enqueueItems[i];
        const sibId = nextId("task");
        const sibSpec = await enrichSpecAllowedOrigins(sibling.spec, settings);
        const ts = nowFn();
        const sibTask: ExtensionDownloadTask = {
          taskId: sibId,
          ...(groupBatchId ? { groupBatchId } : {}),
          title: sibling.title,
          filename: sibSpec.filename,
          platform: sibling.platform,
          ...(sibling.workFingerprint
            ? { workFingerprint: sibling.workFingerprint }
            : {}),
          fallbackUrl: sibling.fallbackUrl || matched.url,
          status: "queued",
          statusText: "排队等待下载...",
          percent: 0,
          loaded: 0,
          total: sibSpec.sizeBytes ?? 0,
          speed: 0,
          createdAt: ts,
          updatedAt: ts,
          retryPayload: { kind: "spec", spec: sibSpec },
        };
        tasks.set(sibId, sibTask);
        if (placeholderIdx >= 0) {
          taskOrder.splice(placeholderIdx + i, 0, sibId);
        } else {
          taskOrder.push(sibId);
        }
        spawnedIds.push(sibId);
      }

      updateBadge();
      await broadcastTasksUpdated();

      for (const spawnedId of spawnedIds) {
        const t = tasks.get(spawnedId);
        if (t && t.retryPayload?.kind === "spec") {
          void trackBackgroundJob(
            dispatchSpecTaskToOffscreen(spawnedId, t.retryPayload.spec),
          );
        }
      }

      return spawnedIds;
    } catch (err) {
      const current = tasks.get(placeholderTaskId);
      if (!current) return [];
      const cancelled =
        current.status === "cancelled" ||
        parseController.signal.aborted ||
        (err instanceof Error && err.name === "AbortError");

      if (cancelled) {
        tasks.set(placeholderTaskId, {
          ...current,
          status: "cancelled",
          statusText: "已取消",
          speed: 0,
          error: undefined,
          updatedAt: nowFn(),
        });
        updateBadge();
      } else {
        const msg =
          err instanceof Error && err.message ? err.message : "解析链接失败";
        tasks.set(placeholderTaskId, {
          ...current,
          status: "failed",
          statusText: "解析失败",
          speed: 0,
          error: msg,
          fallbackUrl: matched.url,
          updatedAt: nowFn(),
          retryPayload: {
            kind: "url",
            url: matched.url,
            qualityPreference,
            batchSaveMode,
            subfolderPrefix,
          },
        });
        updateBadge("failed");
      }
      await broadcastTasksUpdated();
      scheduleOffscreenIdleCloseIfIdle();
      return [];
    } finally {
      parseAbortControllers.delete(placeholderTaskId);
    }
  };

  const enqueueBatchUrls = async (req: {
    urls: string[];
    qualityPreference?: QualityPreference;
    batchSaveMode?: BatchSaveMode;
    subfolderPrefix?: string;
  }): Promise<{
    groupBatchId: string;
    taskIds: string[];
    tasks: ExtensionDownloadTask[];
  }> => {
    const settings = await storage.getSettings();
    const qualityPreference =
      req.qualityPreference ?? settings.qualityPreference;
    const batchSaveMode = req.batchSaveMode ?? settings.batchSaveMode;
    const subfolderPrefix =
      req.subfolderPrefix !== undefined
        ? req.subfolderPrefix
        : settings.subfolderPrefix;

    const seenKeys = new Set<string>();
    const matchedList: MatchedPlatformUrl[] = [];
    for (const rawUrl of req.urls) {
      const matched = matchActiveParseUrl(rawUrl);
      if (!matched || seenKeys.has(matched.dedupeKey)) continue;
      seenKeys.add(matched.dedupeKey);
      matchedList.push(matched);
    }

    if (matchedList.length === 0) {
      throw new Error("未提取到有效的公开媒体链接");
    }

    const groupBatchId = nextId("batch");
    const createdTasks: ExtensionDownloadTask[] = [];
    const createdIds: string[] = [];

    for (let i = matchedList.length - 1; i >= 0; i--) {
      const matched = matchedList[i];
      const taskId = nextId("task");
      const ts = nowFn();
      const placeholder: ExtensionDownloadTask = {
        taskId,
        groupBatchId,
        title: `${matched.platformLabel} · ${matched.url}`,
        filename: matched.url,
        platform: matched.platform,
        status: "queued",
        statusText: "等待批量解析...",
        percent: 0,
        loaded: 0,
        total: 0,
        speed: 0,
        fallbackUrl: matched.url,
        createdAt: ts,
        updatedAt: ts,
        retryPayload: {
          kind: "url",
          url: matched.url,
          qualityPreference,
          batchSaveMode,
          subfolderPrefix,
        },
      };
      insertOrUpdateTask(placeholder);
      createdTasks.unshift(placeholder);
      createdIds.unshift(taskId);
    }

    updateBadge();
    await broadcastTasksUpdated();

    // Sequential parse with bounded in-flight download backpressure (2-3 concurrent downloads)
    void trackBackgroundJob(
      (async () => {
        const inFlightSettles: Set<Promise<void>> = new Set();

        for (let idx = 0; idx < matchedList.length; idx++) {
          if (disposed) break;
          const taskId = createdIds[idx];
          const matched = matchedList[idx];
          const current = tasks.get(taskId);
          if (!current || current.status === "cancelled") continue;

          // Throttle if download concurrency pool is saturated
          while (inFlightSettles.size >= maxBatchDownloadConcurrency) {
            await Promise.race(inFlightSettles);
          }

          const spawned = await executeUrlToDownloadFlow({
            placeholderTaskId: taskId,
            matched,
            qualityPreference,
            batchSaveMode,
            subfolderPrefix,
            forceSubfolder: true,
            groupBatchId,
          });

          for (const sid of spawned) {
            const p = waitTaskSettled(sid).finally(() => {
              inFlightSettles.delete(p);
            });
            inFlightSettles.add(p);
          }
        }

        await Promise.all(Array.from(inFlightSettles));
      })(),
    );

    return {
      groupBatchId,
      taskIds: createdIds,
      tasks: createdTasks,
    };
  };

  // ==========================================================================
  // 5. Authoritative Blob Handoff & `chrome.downloads.onChanged`
  // ==========================================================================

  const handleDownloadTerminalDelta = async (
    record: PendingBlobDownloadRecord,
    delta: ChromeDownloadDelta,
  ): Promise<void> => {
    const state = delta.state?.current;
    if (state !== "complete" && state !== "interrupted") {
      return;
    }

    pendingBlobDownloads.delete(record.downloadId);
    const task = tasks.get(record.taskId);
    let savedWorkUpdated = false;
    let outcome: "completed" | "failed" | undefined;

    if (state === "complete") {
      if (task) {
        tasks.set(record.taskId, {
          ...task,
          status: "completed",
          statusText: "已完成",
          percent: 100,
          loaded: task.total > 0 ? task.total : task.loaded,
          speed: 0,
          chromeDownloadId: record.downloadId,
          error: undefined,
          updatedAt: nowFn(),
        });
        if (task.workFingerprint) {
          await storage.recordSavedWork({
            fingerprint: task.workFingerprint,
            platform: task.platform,
            title: task.title,
            filename: record.filename,
            savedAt: nowFn(),
          });
          savedWorkUpdated = true;
        }
      }
      outcome = "completed";
    } else {
      const errReason = delta.error?.current || "DOWNLOAD_INTERRUPTED";
      const userCancelled =
        task?.status === "cancelled" ||
        /USER_CANCELED|USER_SHUTDOWN/i.test(errReason);
      if (task) {
        tasks.set(record.taskId, {
          ...task,
          status: userCancelled ? "cancelled" : "failed",
          statusText: userCancelled ? "已取消" : "保存中断",
          speed: 0,
          ...(userCancelled
            ? { error: undefined }
            : { error: `浏览器保存中断（${errReason}）` }),
          updatedAt: nowFn(),
        });
      }
      outcome = userCancelled ? undefined : "failed";
    }

    if (record.blobUrl) {
      await sendReleaseBlobToOffscreen({
        taskId: record.taskId,
        blobUrl: record.blobUrl,
        opfsTempName: record.opfsTempName,
      });
    }

    updateBadge(outcome);
    await broadcastTasksUpdated(savedWorkUpdated);
    scheduleOffscreenIdleCloseIfIdle();
    notifyIfCompletelyIdle();
  };

  const onChromeDownloadChanged = (delta: ChromeDownloadDelta): void => {
    const state = delta?.state?.current;
    if (state !== "complete" && state !== "interrupted") {
      return;
    }
    const record = pendingBlobDownloads.get(delta.id);
    if (!record) {
      // Guard against synchronous onChanged firing before `await downloads.download()` resolves
      earlyDownloadDeltas.set(delta.id, delta);
      const earlyTimer = setTimeout(() => {
        earlyDownloadDeltas.delete(delta.id);
      }, 5_000);
      (earlyTimer as { unref?: () => void })?.unref?.();
      return;
    }
    void trackBackgroundJob(handleDownloadTerminalDelta(record, delta));
  };

  const handleHandoffBlobDownload = async (
    msg: Extract<OffscreenToBackgroundMessage, { type: "HANDOFF_BLOB_DOWNLOAD" }>,
  ): Promise<HandOffBlobDownloadResult> => {
    clearOffscreenIdleTimer();
    const task = tasks.get(msg.taskId);
    if (task?.status === "cancelled") {
      await sendReleaseBlobToOffscreen({
        taskId: msg.taskId,
        blobUrl: msg.blobUrl,
        opfsTempName: msg.opfsTempName,
      });
      throw new Error("任务已取消");
    }

    if (!chromeApi.downloads?.download) {
      await sendReleaseBlobToOffscreen({
        taskId: msg.taskId,
        blobUrl: msg.blobUrl,
        opfsTempName: msg.opfsTempName,
      });
      throw new Error("chrome.downloads API 不可用");
    }

    const safeFilename = sanitizeRelativeDownloadPath(msg.filename);
    let downloadId: number;
    try {
      downloadId = await chromeApi.downloads.download({
        url: msg.blobUrl,
        filename: safeFilename,
        saveAs: false,
        conflictAction: "uniquify",
      });
    } catch (err) {
      // Immediate rejection: immediately release Blob & OPFS in offscreen so nothing leaks!
      await sendReleaseBlobToOffscreen({
        taskId: msg.taskId,
        blobUrl: msg.blobUrl,
        opfsTempName: msg.opfsTempName,
      });
      if (task) {
        const errMsg =
          err instanceof Error && err.message
            ? err.message
            : "调用浏览器下载失败";
        tasks.set(msg.taskId, {
          ...task,
          status: "failed",
          statusText: "保存失败",
          speed: 0,
          error: errMsg,
          updatedAt: nowFn(),
        });
        updateBadge("failed");
        await broadcastTasksUpdated();
      }
      scheduleOffscreenIdleCloseIfIdle();
      throw err;
    }

    const record: PendingBlobDownloadRecord = {
      downloadId,
      taskId: msg.taskId,
      blobUrl: msg.blobUrl,
      filename: safeFilename,
      opfsTempName: msg.opfsTempName,
    };
    pendingBlobDownloads.set(downloadId, record);

    const latestTask = tasks.get(msg.taskId);
    if (latestTask && latestTask.status !== "cancelled") {
      tasks.set(msg.taskId, {
        ...latestTask,
        filename: safeFilename,
        status: "saving",
        statusText: "落盘中...",
        percent: Math.max(latestTask.percent, 99),
        loaded: msg.sizeBytes ?? latestTask.loaded,
        total: msg.sizeBytes ?? latestTask.total,
        speed: 0,
        chromeDownloadId: downloadId,
        updatedAt: nowFn(),
      });
      updateBadge();
      await broadcastTasksUpdated();
    }

    // Replay if `onChanged` fired synchronously during `downloads.download`
    const earlyDelta = earlyDownloadDeltas.get(downloadId);
    if (earlyDelta) {
      earlyDownloadDeltas.delete(downloadId);
      void trackBackgroundJob(handleDownloadTerminalDelta(record, earlyDelta));
    }

    return { chromeDownloadId: downloadId };
  };

  // ==========================================================================
  // 6. Privacy-Gated Active Tab Sync (`matchSupportedPlatformUrl` Locally Only!)
  // ==========================================================================

  const queryActiveTab = async (): Promise<ChromeTabLike | undefined> => {
    if (!chromeApi.tabs?.query) return undefined;
    try {
      const focused = await chromeApi.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (focused && focused.length > 0) {
        return focused[0];
      }
    } catch {
      // Fall through to currentWindow fallback
    }
    try {
      const current = await chromeApi.tabs.query({
        active: true,
        currentWindow: true,
      });
      return current?.[0];
    } catch {
      return undefined;
    }
  };

  const evaluateTabSyncState = (
    tabId: number,
    rawUrl: string | undefined,
  ): TabSyncState => {
    const cleanCandidate = typeof rawUrl === "string" ? rawUrl.trim() : "";
    const matched = cleanCandidate
      ? matchSupportedPlatformUrl(cleanCandidate)
      : null;
    return {
      tabId,
      // Never retain or broadcast non-supported browsing URLs
      rawUrl: matched ? matched.url : "",
      matched,
      updatedAt: nowFn(),
    };
  };

  const scheduleTabSyncEvaluation = (
    tabId: number,
    rawUrl: string | undefined,
    immediate = false,
  ): void => {
    if (disposed) return;
    const previewMatched =
      typeof rawUrl === "string" && rawUrl.trim()
        ? matchSupportedPlatformUrl(rawUrl.trim())
        : null;
    const syncKey = previewMatched
      ? `${tabId}:${previewMatched.dedupeKey}:${previewMatched.isLikelyFeedOrHome ? "feed" : "work"}`
      : `${tabId}:unsupported`;

    if (immediate) {
      if (tabSyncTimer !== null) {
        clearTimeout(tabSyncTimer);
        tabSyncTimer = null;
      }
      const nextSync = evaluateTabSyncState(tabId, rawUrl);
      currentTabSync = nextSync;
      if (sidePanelPorts.size > 0 && syncKey !== lastBroadcastTabKey) {
        lastBroadcastTabKey = syncKey;
        broadcastToSidePanels({
          type: "TAB_SYNC_UPDATED",
          tabSync: nextSync,
        });
      }
      return;
    }

    if (tabSyncTimer !== null) {
      clearTimeout(tabSyncTimer);
      tabSyncTimer = null;
    }

    const delayMs =
      previewMatched?.platform === "youtube"
        ? youtubeTabSyncDebounceMs
        : tabSyncDebounceMs;

    tabSyncTimer = setTimeout(() => {
      tabSyncTimer = null;
      if (disposed) return;
      const nextSync = evaluateTabSyncState(tabId, rawUrl);
      currentTabSync = nextSync;
      const nextKey = nextSync.matched
        ? `${nextSync.tabId}:${nextSync.matched.dedupeKey}:${nextSync.matched.isLikelyFeedOrHome ? "feed" : "work"}`
        : `${nextSync.tabId}:unsupported`;
      if (sidePanelPorts.size > 0 && nextKey !== lastBroadcastTabKey) {
        lastBroadcastTabKey = nextKey;
        broadcastToSidePanels({
          type: "TAB_SYNC_UPDATED",
          tabSync: nextSync,
        });
      }
    }, delayMs);
    (tabSyncTimer as { unref?: () => void })?.unref?.();
  };

  const ensureInitialTabSync = async (): Promise<void> => {
    if (currentTabSync !== null || disposed) return;
    if (!initialTabSyncPromise) {
      initialTabSyncPromise = (async () => {
        const first = await queryActiveTab();
        if (!disposed && currentTabSync === null && first?.id !== undefined) {
          scheduleTabSyncEvaluation(first.id, first.url, true);
        }
      })().finally(() => {
        initialTabSyncPromise = null;
      });
    }
    await initialTabSyncPromise;
  };

  // ==========================================================================
  // 7. Dual Context Menus & `Alt+Shift+D` (Strict Line-1 Synchronous Gesture!)
  // ==========================================================================

  const registerContextMenus = async (): Promise<void> => {
    if (!chromeApi.contextMenus) return;
    try {
      await chromeApi.contextMenus.removeAll();
    } catch {
      // Ignore
    }
    chromeApi.contextMenus.create({
      id: CONTEXT_MENU_INSPECT_ID,
      title: "用 DokiTool 解析此链接",
      contexts: ["link", "page", "video", "image"],
    });
    chromeApi.contextMenus.create({
      id: CONTEXT_MENU_QUICK_DOWNLOAD_ID,
      title: "用 DokiTool 极速下载（最高画质 / 全部图集）",
      contexts: ["link", "page", "video", "image"],
    });
  };

  const emitInspectIntent = async (rawUrl: string): Promise<void> => {
    const trimmed = rawUrl.trim();
    if (!trimmed) return;
    const intent: PendingPanelIntent = {
      intentId: nextId("intent"),
      url: trimmed,
      mode: "inspect",
      createdAt: nowFn(),
    };
    const saved = await storage.setPendingIntent(intent);
    broadcastToSidePanels({
      type: "PANEL_INTENT",
      intent: saved,
    });
  };

  const runSilentQuickDownload = async (rawCandidateUrl: string): Promise<void> => {
    const matched = matchActiveParseUrl(rawCandidateUrl);
    if (!matched) {
      const taskId = nextId("task");
      const ts = nowFn();
      insertOrUpdateTask({
        taskId,
        title: "不支持的链接",
        filename: "unsupported",
        platform: "unknown",
        status: "failed",
        statusText: "非有效媒体链接",
        percent: 0,
        loaded: 0,
        total: 0,
        speed: 0,
        error: "该链接格式无效或属于受保护的本地/内网地址（零外发请求）",
        createdAt: ts,
        updatedAt: ts,
      });
      updateBadge("failed");
      await broadcastTasksUpdated();
      return;
    }

    const settings = await storage.getSettings();
    const placeholderId = nextId("task");
    const ts = nowFn();
    insertOrUpdateTask({
      taskId: placeholderId,
      title: `${matched.platformLabel} 极速下载`,
      filename: matched.url,
      platform: matched.platform,
      status: "parsing",
      statusText: "后台极速解析中...",
      percent: 0,
      loaded: 0,
      total: 0,
      speed: 0,
      fallbackUrl: matched.url,
      createdAt: ts,
      updatedAt: ts,
      retryPayload: {
        kind: "url",
        url: matched.url,
        qualityPreference: settings.qualityPreference,
        batchSaveMode: settings.batchSaveMode,
        subfolderPrefix: settings.subfolderPrefix,
      },
    });
    updateBadge();
    await broadcastTasksUpdated();

    await executeUrlToDownloadFlow({
      placeholderTaskId: placeholderId,
      matched,
      qualityPreference: settings.qualityPreference,
      batchSaveMode: settings.batchSaveMode,
      subfolderPrefix: settings.subfolderPrefix,
      forceSubfolder: false,
    });
  };

  const onContextMenuClicked = (
    info: ChromeContextMenuClickInfo,
    tab?: ChromeTabLike,
  ): void => {
    if (info.menuItemId === CONTEXT_MENU_INSPECT_ID) {
      // STRICT LINE-1 USER-GESTURE COMPLIANCE: synchronous `sidePanel.open` BEFORE any `await`!
      if (tab?.id !== undefined) {
        void chromeApi.sidePanel?.open({ tabId: tab.id })?.catch?.(() => {});
      } else if (tab?.windowId !== undefined) {
        void chromeApi.sidePanel
          ?.open({ windowId: tab.windowId })
          ?.catch?.(() => {});
      }

      const rawTarget =
        info.linkUrl || info.srcUrl || info.pageUrl || tab?.url || "";
      void trackBackgroundJob(emitInspectIntent(rawTarget));
      return;
    }

    if (info.menuItemId === CONTEXT_MENU_QUICK_DOWNLOAD_ID) {
      // Quick-download MUST NOT open SidePanel!
      const rawTarget =
        info.linkUrl || info.srcUrl || info.pageUrl || tab?.url || "";
      void trackBackgroundJob(runSilentQuickDownload(rawTarget));
    }
  };

  const onCommandTriggered = (command: string, tab?: ChromeTabLike): void => {
    if (command !== COMMAND_OPEN_SIDEPANEL) return;

    // STRICT LINE-1 USER-GESTURE COMPLIANCE: synchronous `sidePanel.open` BEFORE any `await`!
    if (tab?.id !== undefined) {
      void chromeApi.sidePanel?.open({ tabId: tab.id })?.catch?.(() => {});
    } else if (tab?.windowId !== undefined) {
      void chromeApi.sidePanel
        ?.open({ windowId: tab.windowId })
        ?.catch?.(() => {});
    }

    void trackBackgroundJob(
      (async () => {
        let targetTab = tab;
        let candidateUrl = tab?.url?.trim() || "";
        if (!candidateUrl) {
          const activeTab = await queryActiveTab();
          if (activeTab) {
            targetTab = targetTab ?? activeTab;
            candidateUrl = activeTab.url?.trim() || "";
          }
        }
        const matched = candidateUrl
          ? matchSupportedPlatformUrl(candidateUrl)
          : null;
        if (targetTab?.id !== undefined) {
          scheduleTabSyncEvaluation(targetTab.id, candidateUrl, true);
        }
        if (matched && !matched.isLikelyFeedOrHome) {
          await emitInspectIntent(matched.url);
        }
      })(),
    );
  };

  // ==========================================================================
  // 8. Snapshot, SidePanel RPCs & Offscreen Messages
  // ==========================================================================

  const getSnapshot = async (): Promise<ExtensionStateSnapshot> => {
    if (currentTabSync === null) {
      await ensureInitialTabSync();
    }
    const [settings, savedWorks, pendingIntent] = await Promise.all([
      storage.getSettings(),
      storage.getSavedWorks(),
      storage.getPendingIntent(),
    ]);
    return {
      settings,
      tabSync: currentTabSync,
      tasks: getOrderedTasks(),
      savedWorkFingerprints: savedWorks.map((w) => w.fingerprint),
      pendingIntent,
      connection: lastConnectionCheck,
    };
  };

  const handleSidePanelRequest = async (
    req: SidePanelToBackgroundRequest,
  ): Promise<ExtensionRpcResponse<SidePanelResponseMap[SidePanelToBackgroundRequest["type"]]>> => {
    switch (req.type) {
      case "GET_INITIAL_STATE": {
        const snapshot = await getSnapshot();
        return okRpc(snapshot);
      }

      case "UPDATE_SETTINGS": {
        const settings = await storage.updateSettings(req.patch);
        await syncDynamicDnrRules();
        const snapshot = await getSnapshot();
        broadcastToSidePanels({ type: "STATE_SNAPSHOT", snapshot });
        return okRpc({ settings });
      }

      case "TEST_CONNECTION": {
        const result = await runTestConnection({
          apiBaseUrl: req.apiBaseUrl,
          bearerToken: req.bearerToken,
        });
        return okRpc(result);
      }

      case "FETCH_OWNER_STATS": {
        return fetchOwnerStats();
      }

      case "PARSE_URL": {
        const matched = matchActiveParseUrl(req.url);
        if (!matched) {
          return errRpc("请输入有效的公开媒体链接（已本地拦截内网、IP 与浏览器内部地址）", {
            code: "UNSUPPORTED_PLATFORM",
            status: 400,
          });
        }
        const settings = await storage.getSettings();
        const media = await parseSupportedUrlInternal(matched, settings);
        const resolvedPlatform = media.platform?.trim() || matched.platform;
        const enrichedMatched: MatchedPlatformUrl = {
          ...matched,
          platform: resolvedPlatform,
          platformLabel:
            (media.platform?.trim()
              ? formatPlatformDisplayName(media.platform.trim())
              : "") || matched.platformLabel,
        };
        const workFingerprint = buildWorkFingerprint(media);
        const isSaved = workFingerprint
          ? await storage.isWorkSaved(workFingerprint)
          : false;
        return okRpc({
          media,
          matched: enrichedMatched,
          workFingerprint,
          isSaved,
        });
      }

      case "RESOLVE_LAZY_ITEM": {
        const settings = await storage.getSettings();
        const media = await resolveLazyItemInternal(req.resolveUrl, settings);
        return okRpc({ media });
      }

      case "ENQUEUE_DOWNLOADS": {
        const res = await enqueueDownloadItems(req.items, req.groupBatchId);
        return okRpc(res);
      }

      case "ENQUEUE_BATCH_URLS": {
        const res = await enqueueBatchUrls(req);
        return okRpc(res);
      }

      case "CANCEL_TASK": {
        const task = tasks.get(req.taskId);
        if (!task) {
          return okRpc({ taskId: req.taskId, cancelled: false });
        }
        parseAbortControllers.get(req.taskId)?.abort();
        parseAbortControllers.delete(req.taskId);

        tasks.set(req.taskId, {
          ...task,
          status: "cancelled",
          statusText: "已取消",
          speed: 0,
          error: undefined,
          updatedAt: nowFn(),
        });

        if (typeof task.chromeDownloadId === "number") {
          const pendingRec = pendingBlobDownloads.get(task.chromeDownloadId);
          if (pendingRec && !pendingRec.blobUrl) {
            pendingBlobDownloads.delete(task.chromeDownloadId);
          }
          if (chromeApi.downloads?.cancel) {
            void chromeApi.downloads
              .cancel(task.chromeDownloadId)
              .catch(() => {});
          }
        }
        if (offscreenDocumentOpen) {
          void sendToOffscreen(
            { type: "OFFSCREEN_CANCEL_TASK", taskId: req.taskId },
            { skipEnsure: true },
          ).catch(() => {});
        }

        updateBadge(countActiveTasks() === 0 ? "clear" : undefined);
        await broadcastTasksUpdated();
        scheduleOffscreenIdleCloseIfIdle();
        notifyIfCompletelyIdle();
        return okRpc({ taskId: req.taskId, cancelled: true });
      }

      case "RETRY_TASK": {
        const task = tasks.get(req.taskId);
        if (!task || !task.retryPayload) {
          return errRpc("未找到可重试的任务记录", { code: "TASK_NOT_FOUND" });
        }
        const retryPayload = task.retryPayload;
        if (retryPayload.kind === "spec") {
          const refreshCtx = retryPayload.spec.refreshContext;
          const isExpired = isSpecExpiredForDispatch(retryPayload.spec);
          const failedByExpiry = task.lastErrorCode === "MEDIA_URL_EXPIRED";
          const needsManualRefresh = Boolean(
            refreshCtx && (isExpired || failedByExpiry),
          );
          const resetTask: ExtensionDownloadTask = {
            ...task,
            status: needsManualRefresh ? "parsing" : "queued",
            statusText: needsManualRefresh
              ? "签名链接已过期，正在自动重新解析..."
              : "重新排队下载...",
            percent: 0,
            loaded: 0,
            speed: 0,
            chromeDownloadId: undefined,
            error: undefined,
            lastErrorCode: undefined,
            lastErrorHttpStatus: undefined,
            autoRefreshCount: needsManualRefresh ? 1 : 0,
            unwhitelistedHost: undefined,
            updatedAt: nowFn(),
          };
          tasks.set(req.taskId, resetTask);
          updateBadge();
          await broadcastTasksUpdated();
          void trackBackgroundJob(
            dispatchSpecTaskToOffscreen(
              req.taskId,
              retryPayload.spec,
              needsManualRefresh
                ? { forceRefresh: true, skipAutoRefresh: true }
                : undefined,
            ),
          );
          return okRpc({ task: resetTask });
        }

        const matched = matchActiveParseUrl(retryPayload.url);
        if (!matched) {
          return errRpc("重试链接无效", { code: "UNSUPPORTED_URL" });
        }
        const settings = await storage.getSettings();
        const resetUrlTask: ExtensionDownloadTask = {
          ...task,
          status: "parsing",
          statusText: "重新解析中...",
          percent: 0,
          loaded: 0,
          speed: 0,
          chromeDownloadId: undefined,
          error: undefined,
          unwhitelistedHost: undefined,
          updatedAt: nowFn(),
        };
        tasks.set(req.taskId, resetUrlTask);
        updateBadge();
        await broadcastTasksUpdated();

        void trackBackgroundJob(
          executeUrlToDownloadFlow({
            placeholderTaskId: req.taskId,
            matched,
            qualityPreference:
              retryPayload.qualityPreference ?? settings.qualityPreference,
            batchSaveMode: retryPayload.batchSaveMode ?? settings.batchSaveMode,
            subfolderPrefix:
              retryPayload.subfolderPrefix ?? settings.subfolderPrefix,
            forceSubfolder: Boolean(task.groupBatchId),
            groupBatchId: task.groupBatchId,
          }),
        );
        return okRpc({ task: resetUrlTask });
      }

      case "CLEAR_FINISHED_TASKS": {
        for (const [id, task] of Array.from(tasks.entries())) {
          if (FINISHED_TASK_STATUSES.has(task.status)) {
            tasks.delete(id);
            const idx = taskOrder.indexOf(id);
            if (idx >= 0) taskOrder.splice(idx, 1);
          }
        }
        if (countActiveTasks() === 0) {
          updateBadge("clear");
        }
        await broadcastTasksUpdated();
        return okRpc({ remainingCount: tasks.size });
      }

      case "OPEN_DOWNLOAD_FOLDER": {
        const downloadId =
          req.chromeDownloadId ??
          (req.taskId ? tasks.get(req.taskId)?.chromeDownloadId : undefined);
        if (typeof downloadId === "number" && chromeApi.downloads?.show) {
          chromeApi.downloads.show(downloadId);
          return okRpc({ opened: true });
        }
        return okRpc({ opened: false });
      }

      case "CONSUME_INTENT": {
        const intent = await storage.consumePendingIntent(req.intentId);
        return okRpc({ intent });
      }
    }
  };

  const handleOffscreenMessage = async (
    msg: OffscreenToBackgroundMessage,
  ): Promise<ExtensionRpcResponse<unknown>> => {
    switch (msg.type) {
      case "HANDOFF_BLOB_DOWNLOAD": {
        const res = await handleHandoffBlobDownload(msg);
        return okRpc(res);
      }

      case "OFFSCREEN_TASK_PROGRESS": {
        clearOffscreenIdleTimer();
        const task = tasks.get(msg.taskId);
        if (task && !FINISHED_TASK_STATUSES.has(task.status)) {
          tasks.set(msg.taskId, {
            ...task,
            status: msg.status,
            statusText: msg.statusText,
            percent: msg.percent,
            loaded: msg.loaded,
            total: msg.total,
            speed: msg.speed,
            updatedAt: nowFn(),
          });
          updateBadge();
          await broadcastTasksUpdated();
        }
        return okRpc({ received: true });
      }

      case "OFFSCREEN_TASK_ERROR": {
        const task = tasks.get(msg.taskId);
        if (task && task.status !== "completed" && task.status !== "cancelled") {
          const isCancelled = msg.cancelled === true;
          const isExpiredError =
            !isCancelled && msg.code === "MEDIA_URL_EXPIRED";
          const specPayload =
            task.retryPayload?.kind === "spec"
              ? task.retryPayload.spec
              : undefined;
          if (
            isExpiredError &&
            specPayload?.refreshContext &&
            (task.autoRefreshCount ?? 0) < 1
          ) {
            const nextRefreshCount = (task.autoRefreshCount ?? 0) + 1;
            tasks.set(msg.taskId, {
              ...task,
              status: "parsing",
              statusText: "签名链接已过期，正在自动重新解析...",
              percent: 0,
              loaded: 0,
              speed: 0,
              error: undefined,
              lastErrorCode: msg.code ?? "MEDIA_URL_EXPIRED",
              ...(msg.httpStatus !== undefined
                ? { lastErrorHttpStatus: msg.httpStatus }
                : {}),
              autoRefreshCount: nextRefreshCount,
              updatedAt: nowFn(),
            });
            updateBadge();
            await broadcastTasksUpdated();
            void trackBackgroundJob(
              dispatchSpecTaskToOffscreen(msg.taskId, specPayload, {
                forceRefresh: true,
                skipAutoRefresh: true,
              }),
            );
            return okRpc({ received: true });
          }

          tasks.set(msg.taskId, {
            ...task,
            status: isCancelled ? "cancelled" : "failed",
            statusText: isCancelled
              ? "已取消"
              : msg.code === "UNWHITELISTED_CDN"
                ? "未授权媒体域名"
                : msg.code === "OPFS_QUOTA_EXCEEDED"
                  ? "存储空间不足"
                  : "下载失败",
            speed: 0,
            error: isCancelled ? undefined : msg.error,
            lastErrorCode: isCancelled ? undefined : msg.code,
            lastErrorHttpStatus: isCancelled ? undefined : msg.httpStatus,
            ...(msg.unwhitelistedHost
              ? { unwhitelistedHost: msg.unwhitelistedHost }
              : {}),
            ...(msg.fallbackUrl ? { fallbackUrl: msg.fallbackUrl } : {}),
            updatedAt: nowFn(),
          });
          updateBadge(isCancelled ? undefined : "failed");
          await broadcastTasksUpdated();
        }
        scheduleOffscreenIdleCloseIfIdle();
        notifyIfCompletelyIdle();
        return okRpc({ received: true });
      }

      case "OFFSCREEN_HEARTBEAT": {
        if (msg.activeTaskCount > 0 || msg.pendingBlobCount > 0) {
          clearOffscreenIdleTimer();
        } else {
          scheduleOffscreenIdleCloseIfIdle();
        }
        return okRpc({ alive: true });
      }
    }
  };

  // STRICT MV3 IPC CONTRACT:
  // ONLY return `true` / call `sendResponse` when `isSidePanelRequest(msg)`
  // or `isOffscreenToBackgroundMessage(msg)`!
  // Immediately return `false` for `isBackgroundToOffscreenRequest` or `isBackgroundBroadcast`!
  const handleRuntimeMessage: ChromeRuntimeMessageListener = (
    msg: unknown,
    _sender: unknown,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    if (isSidePanelRequest(msg)) {
      void handleSidePanelRequest(msg)
        .then((resp) => {
          sendResponse(resp);
        })
        .catch((err: unknown) => {
          const status =
            err instanceof HttpStatusError
              ? err.status
              : typeof (err as { status?: unknown })?.status === "number"
                ? (err as { status: number }).status
                : undefined;
          const code =
            err instanceof HttpStatusError
              ? err.code
              : typeof (err as { code?: unknown })?.code === "string"
                ? (err as { code: string }).code
                : undefined;
          const message =
            err instanceof Error && err.message ? err.message : "后台处理失败";
          sendResponse(errRpc(message, { code, status }));
        });
      return true;
    }

    if (isOffscreenToBackgroundMessage(msg)) {
      void handleOffscreenMessage(msg)
        .then((resp) => {
          sendResponse(resp);
        })
        .catch((err: unknown) => {
          const code =
            typeof (err as { code?: unknown })?.code === "string"
              ? (err as { code: string }).code
              : undefined;
          const message =
            err instanceof Error && err.message ? err.message : "后台交接失败";
          sendResponse(errRpc(message, { code }));
        });
      return true;
    }

    return false;
  };

  // ==========================================================================
  // 9. Listener Registration & Boot
  // ==========================================================================

  chromeApi.runtime.onMessage.addListener(handleRuntimeMessage);

  chromeApi.runtime.onConnect?.addListener((port) => {
    if (port.name === SIDEPANEL_PORT_NAME) {
      sidePanelPorts.add(port);
      port.onDisconnect?.addListener(() => {
        sidePanelPorts.delete(port);
      });
      void getSnapshot()
        .then((snapshot) => {
          if (sidePanelPorts.has(port)) {
            port.postMessage({
              type: "STATE_SNAPSHOT",
              snapshot,
            } satisfies BackgroundToSidePanelBroadcast);
          }
        })
        .catch(() => {});
      return;
    }

    if (port.name === OFFSCREEN_PORT_NAME) {
      offscreenPort = port;
      offscreenDocumentOpen = true;
      port.onMessage?.addListener((msg) => {
        if (isOffscreenToBackgroundMessage(msg)) {
          void handleOffscreenMessage(msg).catch(() => {});
        }
      });
      port.onDisconnect?.addListener(() => {
        if (offscreenPort === port) {
          offscreenPort = null;
        }
      });
    }
  });

  chromeApi.contextMenus?.onClicked.addListener(onContextMenuClicked);
  chromeApi.commands?.onCommand.addListener(onCommandTriggered);
  chromeApi.downloads?.onChanged.addListener(onChromeDownloadChanged);

  chromeApi.tabs?.onActivated?.addListener((activeInfo) => {
    if (!chromeApi.tabs?.get) return;
    void chromeApi.tabs
      .get(activeInfo.tabId)
      .then((tab) => {
        scheduleTabSyncEvaluation(activeInfo.tabId, tab?.url);
      })
      .catch(() => {});
  });

  chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (tab?.active === false) return;
    if (changeInfo.url === undefined && changeInfo.status !== "complete") {
      return;
    }
    scheduleTabSyncEvaluation(tabId, changeInfo.url ?? tab?.url);
  });

  chromeApi.permissions?.onAdded?.addListener(() => {
    void syncDynamicDnrRules().catch(() => {});
  });

  chromeApi.runtime.onInstalled?.addListener(() => {
    void init().catch(() => {});
  });

  chromeApi.runtime.onStartup?.addListener(() => {
    void init().catch(() => {});
  });

  const init = async (): Promise<void> => {
    try {
      await chromeApi.sidePanel?.setPanelBehavior?.({
        openPanelOnActionClick: true,
      });
    } catch {
      // Ignore if sidePanel unavailable in unit test stub
    }
    await Promise.all([
      syncDynamicDnrRules().catch(() => []),
      registerContextMenus().catch(() => {}),
    ]);
    const first = await queryActiveTab();
    if (first?.id !== undefined) {
      scheduleTabSyncEvaluation(first.id, first.url, true);
    }
    updateBadge(countActiveTasks() === 0 ? "clear" : undefined);
  };

  return {
    init,
    syncDynamicDnrRules,
    ensureOffscreenDocument,
    getSnapshot,
    handleRuntimeMessage,
    waitForIdle(): Promise<void> {
      const hasActiveTask = Array.from(tasks.values()).some((t) =>
        ACTIVE_TASK_STATUSES.has(t.status),
      );
      if (
        !hasActiveTask &&
        pendingBlobDownloads.size === 0 &&
        backgroundAsyncJobs === 0
      ) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearOffscreenIdleTimer();
      if (badgeClearTimer !== null) {
        clearTimeout(badgeClearTimer);
        badgeClearTimer = null;
      }
      if (tabSyncTimer !== null) {
        clearTimeout(tabSyncTimer);
        tabSyncTimer = null;
      }
      for (const [, ctrl] of Array.from(parseAbortControllers.entries())) {
        ctrl.abort();
      }
      parseAbortControllers.clear();
      chromeApi.runtime.onMessage.removeListener?.(handleRuntimeMessage);
      for (const port of Array.from(sidePanelPorts)) {
        try {
          port.disconnect();
        } catch {
          // Ignore
        }
      }
      sidePanelPorts.clear();
      notifyIfCompletelyIdle();
    },
  };
}

const maybeSwChrome = (
  globalThis as unknown as {
    chrome?: ChromeBackgroundApi;
    __DOKITOOL_EXT_TEST__?: boolean;
  }
).chrome;

if (
  typeof document === "undefined" &&
  typeof window === "undefined" &&
  maybeSwChrome?.runtime?.id &&
  !(globalThis as unknown as { __DOKITOOL_EXT_TEST__?: boolean })
    .__DOKITOOL_EXT_TEST__
) {
  const controller = createBackgroundController({ chrome: maybeSwChrome });
  void controller.init();
}
