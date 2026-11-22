import { withTbvideoItems } from "../services/tbvideo";
import type {
  Attachment,
  MediaItem,
  UnifiedMedia,
  YouTubeHelperState,
} from "../types/media";
import { readyItem, validateMediaEnvelope } from "../utils/mediaContract";
import {
  MIN_YOUTUBE_HELPER_VERSION,
  YOUTUBE_HELPER_SCRIPT_URL,
  YOUTUBE_HELPER_VERSION,
  type YouTubeHelperContextResponse,
} from "../utils/youtubeHelperCore";
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
  validateApiBaseUrl,
} from "./hostWhitelist";
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
  type OffscreenDownloadSpec,
  type OffscreenResponseMap,
  type OffscreenToBackgroundMessage,
  type PendingPanelIntent,
  type QualityPreference,
  type SidePanelResponseMap,
  type SidePanelToBackgroundRequest,
  type TabSyncState,
} from "./protocol";
import {
  buildApiAuthHeaders,
  buildWorkFingerprint,
  createExtensionStorage,
  type ExtensionStorageController,
} from "./storage";
import { matchSupportedPlatformUrl } from "./urlMatcher";

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
        hydratedItems.push(matchedItem && readyItem(matchedItem) ? matchedItem : item);
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

  const dispatchSpecTaskToOffscreen = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
  ): Promise<void> => {
    const task = tasks.get(taskId);
    if (!task || task.status === "cancelled") return;

    const settings = await storage.getSettings();
    const enrichedSpec = await enrichSpecAllowedOrigins(spec, settings);
    const latestBeforeStart = tasks.get(taskId);
    if (!latestBeforeStart || latestBeforeStart.status === "cancelled") {
      scheduleOffscreenIdleCloseIfIdle();
      return;
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
      const enrichedSpec: OffscreenDownloadSpec = {
        ...item.spec,
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
      const matched = matchSupportedPlatformUrl(rawUrl);
      if (!matched || seenKeys.has(matched.dedupeKey)) continue;
      seenKeys.add(matched.dedupeKey);
      matchedList.push(matched);
    }

    if (matchedList.length === 0) {
      throw new Error("未提取到受支持平台的有效分享链接");
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

    await sendReleaseBlobToOffscreen({
      taskId: record.taskId,
      blobUrl: record.blobUrl,
      opfsTempName: record.opfsTempName,
    });

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
    const matched = matchSupportedPlatformUrl(rawCandidateUrl);
    if (!matched) {
      const taskId = nextId("task");
      const ts = nowFn();
      insertOrUpdateTask({
        taskId,
        title: "不支持的链接",
        filename: "unsupported",
        platform: "unknown",
        status: "failed",
        statusText: "非支持平台",
        percent: 0,
        loaded: 0,
        total: 0,
        speed: 0,
        error: "该链接不属于受支持的 14 个平台（零外发请求）",
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

      case "PARSE_URL": {
        const matched = matchSupportedPlatformUrl(req.url);
        if (!matched) {
          return errRpc("仅支持解析 14 个白名单平台的有效分享链接", {
            code: "UNSUPPORTED_PLATFORM",
            status: 400,
          });
        }
        const settings = await storage.getSettings();
        const media = await parseSupportedUrlInternal(matched, settings);
        const workFingerprint = buildWorkFingerprint(media);
        const isSaved = workFingerprint
          ? await storage.isWorkSaved(workFingerprint)
          : false;
        return okRpc({
          media,
          matched,
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

        if (
          typeof task.chromeDownloadId === "number" &&
          chromeApi.downloads?.cancel
        ) {
          void chromeApi.downloads.cancel(task.chromeDownloadId).catch(() => {});
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
          const resetTask: ExtensionDownloadTask = {
            ...task,
            status: "queued",
            statusText: "重新排队下载...",
            percent: 0,
            loaded: 0,
            speed: 0,
            chromeDownloadId: undefined,
            error: undefined,
            unwhitelistedHost: undefined,
            updatedAt: nowFn(),
          };
          tasks.set(req.taskId, resetTask);
          updateBadge();
          await broadcastTasksUpdated();
          void trackBackgroundJob(
            dispatchSpecTaskToOffscreen(req.taskId, retryPayload.spec),
          );
          return okRpc({ task: resetTask });
        }

        const matched = matchSupportedPlatformUrl(retryPayload.url);
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
          tasks.set(msg.taskId, {
            ...task,
            status: isCancelled ? "cancelled" : "failed",
            statusText: isCancelled
              ? "已取消"
              : msg.code === "UNWHITELISTED_CDN"
                ? "未授权媒体域名"
                : "下载失败",
            speed: 0,
            error: isCancelled ? undefined : msg.error,
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
