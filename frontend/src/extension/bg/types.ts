import type { ExtensionDnrRule } from "../dnrRules";
import {
  buildSafeDownloadPath,
  sanitizeFileExtension,
  sanitizeSubfolderPrefix,
} from "../filenameSanitizer";
import type {
  ExtensionDownloadTask,
  ExtensionStateSnapshot,
} from "../protocol";
import type { ExtensionStorageController } from "../storage";

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
  filename?: {
    previous?: string;
    current?: string;
  };
  state?: {
    previous?: string;
    current?: string;
  };
  error?: {
    previous?: string;
    current?: string;
  };
}

export interface ChromeDownloadItemLike {
  id: number;
  url?: string;
  finalUrl?: string;
  filename?: string;
  mime?: string;
  byExtensionId?: string;
  byExtensionName?: string;
}

export interface ChromeDownloadFilenameSuggestion {
  filename: string;
  conflictAction?: "uniquify" | "overwrite" | "prompt";
}

export type ChromeDeterminingFilenameListener = (
  downloadItem: ChromeDownloadItemLike,
  suggest: (suggestion?: ChromeDownloadFilenameSuggestion) => void,
) => boolean | void;

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
      version?: string;
      host_permissions?: string[];
      optional_host_permissions?: string[];
      externally_connectable?: {
        matches?: string[];
      };
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
    onMessageExternal?: {
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
    search?(query: { id?: number }): Promise<ChromeDownloadItemLike[]>;
    onChanged: {
      addListener(listener: (delta: ChromeDownloadDelta) => void): void;
      removeListener?(listener: (delta: ChromeDownloadDelta) => void): void;
    };
    onDeterminingFilename?: {
      addListener(listener: ChromeDeterminingFilenameListener): void;
      removeListener?(listener: ChromeDeterminingFilenameListener): void;
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
  badgeProgressThrottleMs?: number;
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
  handleExternalRuntimeMessage: ChromeRuntimeMessageListener;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

export interface ExternalWebSenderCheckResult {
  allowed: boolean;
  origin: string;
  isLoopback: boolean;
  reason?: string;
}

export interface PendingBlobDownloadRecord {
  downloadId: number;
  taskId: string;
  blobUrl: string;
  downloadUrl: string;
  filename: string;
  opfsTempName?: string;
}

export const DEFAULT_ACTION_TITLE = "打开 DokiTool 侧边栏" as const;
export const DEFAULT_BADGE_PROGRESS_THROTTLE_MS = 1_000 as const;

export const ACTIVE_TASK_STATUSES = new Set<ExtensionDownloadTask["status"]>([
  "queued",
  "parsing",
  "downloading",
  "muxing",
  "saving",
]);

export const FINISHED_TASK_STATUSES = new Set<ExtensionDownloadTask["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

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

export function sanitizeRelativeDownloadPath(rawPath: string): string {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) return "download.bin";
  const segments = trimmed
    .split(/[/\\]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..");
  if (segments.length === 0) return "download.bin";
  const leaf = segments[segments.length - 1];
  const dotIdx = leaf.lastIndexOf(".");
  const rawExt = dotIdx > 0 ? leaf.slice(dotIdx + 1) : "";
  const ext = rawExt ? sanitizeFileExtension(rawExt, "bin") : "";
  const stem = dotIdx > 0 ? leaf.slice(0, dotIdx) : leaf;
  const folderPrefix = sanitizeSubfolderPrefix(segments.slice(0, -1).join("/"));
  return buildSafeDownloadPath({
    prefix: folderPrefix,
    stem,
    ext,
  });
}

export interface ActionBadgeControllerDeps {
  chromeApi: ChromeBackgroundApi;
  nowFn: () => number;
  badgeSuccessDurationMs: number;
  badgeProgressThrottleMs: number;
  isDisposed: () => boolean;
  hasOpenSidePanel: () => boolean;
  getOrderedTasks: () => ExtensionDownloadTask[];
  countActiveTasks: () => number;
}

export interface ActionBadgeController {
  updateBadge(
    terminalOutcome?: "completed" | "failed" | "clear",
    options?: { progressOnly?: boolean },
  ): void;
  flushIfThrottled(): void;
  dispose(): void;
}

export function createActionBadgeController(
  deps: ActionBadgeControllerDeps,
): ActionBadgeController {
  const {
    chromeApi,
    nowFn,
    badgeSuccessDurationMs,
    badgeProgressThrottleMs,
    isDisposed,
    hasOpenSidePanel,
    getOrderedTasks,
    countActiveTasks,
  } = deps;

  let badgeClearTimer: ReturnType<typeof setTimeout> | null = null;
  let badgeThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  let hasProgressBadgeFlushed = false;
  let lastProgressBadgeFlushAt = 0;
  let lastActionBadgeText: string | null = null;
  let lastActionBadgeColor: string | null = null;
  let lastActionTitle: string | null = null;

  const clearBadgeThrottleTimer = (): void => {
    if (badgeThrottleTimer !== null) {
      clearTimeout(badgeThrottleTimer);
      badgeThrottleTimer = null;
    }
  };

  const applyBadge = (
    terminalOutcome?: "completed" | "failed" | "clear",
  ): boolean => {
    if (isDisposed() || !chromeApi.action) return false;
    // Preserve terminal "!" / "✓" indicators when a late cancel/abort callback
    // invokes `updateBadge()` without an explicit terminal outcome while idle.
    if (
      countActiveTasks() === 0 &&
      terminalOutcome === undefined &&
      (lastActionBadgeText === "!" || lastActionBadgeText === "✓")
    ) {
      return false;
    }
    const indicator = computeActionIndicator(getOrderedTasks(), terminalOutcome);

    if (badgeClearTimer !== null) {
      clearTimeout(badgeClearTimer);
      badgeClearTimer = null;
    }

    let emitted = false;
    if (
      indicator.badgeColor !== undefined &&
      indicator.badgeColor !== lastActionBadgeColor
    ) {
      lastActionBadgeColor = indicator.badgeColor;
      emitted = true;
      void chromeApi.action.setBadgeBackgroundColor({
        color: indicator.badgeColor,
      });
    }
    if (indicator.badgeText !== lastActionBadgeText) {
      lastActionBadgeText = indicator.badgeText;
      emitted = true;
      void chromeApi.action.setBadgeText({ text: indicator.badgeText });
    }
    if (indicator.title !== lastActionTitle) {
      lastActionTitle = indicator.title;
      emitted = true;
      void chromeApi.action.setTitle?.({ title: indicator.title });
    }
    if (indicator.shouldScheduleClear) {
      badgeClearTimer = setTimeout(() => {
        badgeClearTimer = null;
        if (!isDisposed() && countActiveTasks() === 0) {
          updateBadge("clear");
        }
      }, badgeSuccessDurationMs);
      (badgeClearTimer as { unref?: () => void })?.unref?.();
    }
    return emitted;
  };

  const updateBadge = (
    terminalOutcome?: "completed" | "failed" | "clear",
    options?: { progressOnly?: boolean },
  ): void => {
    if (isDisposed() || !chromeApi.action) return;
    const isProgressOnly =
      options?.progressOnly === true && terminalOutcome === undefined;
    if (isProgressOnly && !hasOpenSidePanel() && badgeProgressThrottleMs > 0) {
      const now = nowFn();
      const elapsed = hasProgressBadgeFlushed
        ? Math.max(0, now - lastProgressBadgeFlushAt)
        : Number.POSITIVE_INFINITY;
      if (elapsed < badgeProgressThrottleMs) {
        if (badgeThrottleTimer === null) {
          const waitMs = Math.max(1, badgeProgressThrottleMs - elapsed);
          badgeThrottleTimer = setTimeout(() => {
            badgeThrottleTimer = null;
            if (isDisposed()) return;
            const emitted = applyBadge(undefined);
            if (emitted) {
              hasProgressBadgeFlushed = true;
              lastProgressBadgeFlushAt = nowFn();
            }
          }, waitMs);
          (badgeThrottleTimer as { unref?: () => void })?.unref?.();
        }
        return;
      }
      clearBadgeThrottleTimer();
      const emitted = applyBadge(undefined);
      if (emitted) {
        hasProgressBadgeFlushed = true;
        lastProgressBadgeFlushAt = now;
      }
      return;
    }

    clearBadgeThrottleTimer();
    if (!isProgressOnly) {
      hasProgressBadgeFlushed = false;
      lastProgressBadgeFlushAt = 0;
      applyBadge(terminalOutcome);
    } else {
      const emitted = applyBadge(undefined);
      if (emitted) {
        hasProgressBadgeFlushed = true;
        lastProgressBadgeFlushAt = nowFn();
      }
    }
  };

  return {
    updateBadge,
    flushIfThrottled() {
      if (badgeThrottleTimer !== null) {
        updateBadge();
      }
    },
    dispose() {
      clearBadgeThrottleTimer();
      if (badgeClearTimer !== null) {
        clearTimeout(badgeClearTimer);
        badgeClearTimer = null;
      }
    },
  };
}
