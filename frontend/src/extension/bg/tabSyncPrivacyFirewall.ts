import type { UnifiedMedia } from "../../types/media";
import { readyItem, readyVariant } from "../../utils/mediaContract";
import { buildEnqueueItemsForMedia } from "../planning/enqueuePlanBuilder";
import {
  COMMAND_OPEN_SIDEPANEL,
  CONTEXT_MENU_INSPECT_ID,
  CONTEXT_MENU_PARSE_SELECTION_ID,
  CONTEXT_MENU_QUICK_DOWNLOAD_ID,
  type BackgroundToSidePanelBroadcast,
  type BatchSaveMode,
  type ExtensionDownloadTask,
  type ExtensionSettings,
  type MatchedPlatformUrl,
  type OffscreenDownloadSpec,
  type PendingPanelIntent,
  type QualityPreference,
  type TabSyncState,
} from "../protocol";
import type { ExtensionStorageController } from "../storage";
import {
  matchActiveParseUrl,
  matchSupportedPlatformUrl,
} from "../urlMatcher";
import type {
  ChromeBackgroundApi,
  ChromeContextMenuClickInfo,
  ChromePortLike,
  ChromeTabLike,
} from "./types";

const SELECTION_URL_TOKEN_RE =
  /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;
const SELECTION_TRAILING_PUNCT_RE = /[.,;:!?'"\]}>]+$/;

function trimSelectionUrlCandidate(rawToken: string): string {
  let candidate = rawToken.replace(SELECTION_TRAILING_PUNCT_RE, "");
  while (candidate.endsWith(")")) {
    const opens = (candidate.match(/\(/g) ?? []).length;
    const closes = (candidate.match(/\)/g) ?? []).length;
    if (closes > opens) {
      candidate = candidate
        .slice(0, -1)
        .replace(SELECTION_TRAILING_PUNCT_RE, "");
    } else {
      break;
    }
  }
  return candidate;
}

/**
 * Extracts the first valid public HTTP(S) link from right-clicked selected text,
 * stripping trailing punctuation and fragments while rejecting non-http(s) schemes
 * (`javascript:`, `file:`, `chrome:`) and private/internal hosts.
 */
export function extractFirstValidSelectionUrl(
  selectionText: unknown,
): string | null {
  if (typeof selectionText !== "string") return null;
  const bounded = selectionText.slice(0, 8_192);
  if (!bounded.trim()) return null;
  const tokens = bounded.match(SELECTION_URL_TOKEN_RE);
  if (!tokens || tokens.length === 0) return null;
  for (const rawToken of tokens) {
    const candidate = trimSelectionUrlCandidate(rawToken);
    const matched = matchActiveParseUrl(candidate);
    if (matched?.url) {
      return matched.url;
    }
  }
  return null;
}

export interface TabSyncPrivacyFirewallDeps {
  chromeApi: ChromeBackgroundApi;
  storage: ExtensionStorageController;
  nowFn: () => number;
  tabSyncDebounceMs: number;
  youtubeTabSyncDebounceMs: number;
  maxBatchDownloadConcurrency: number;
  isDisposed: () => boolean;
  nextId: (prefix: string) => string;
  sidePanelPorts: Set<ChromePortLike>;
  tasks: Map<string, ExtensionDownloadTask>;
  taskOrder: string[];
  parseAbortControllers: Map<string, AbortController>;
  insertOrUpdateTask: (task: ExtensionDownloadTask) => void;
  waitTaskSettled: (taskId: string) => Promise<void>;
  trackBackgroundJob: <T>(promise: Promise<T>) => Promise<T>;
  broadcastToSidePanels: (msg: BackgroundToSidePanelBroadcast) => void;
  broadcastTasksUpdated: (includeSavedFingerprints?: boolean) => Promise<void>;
  onTaskHistoryChange?: (options?: { immediate?: boolean }) => Promise<void> | void;
  updateBadge: (
    terminalOutcome?: "completed" | "failed" | "clear",
    options?: { progressOnly?: boolean },
  ) => void;
  scheduleOffscreenIdleCloseIfIdle: () => void;
  resolveExtraAllowedMediaOrigins: (
    settings: ExtensionSettings,
  ) => Promise<string[]>;
  parseSupportedUrlInternal: (
    matched: MatchedPlatformUrl,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ) => Promise<UnifiedMedia>;
  resolveLazyItemInternal?: (
    rawResolveUrl: string,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ) => Promise<UnifiedMedia>;
  hydrateDeferredMediaItems: (
    media: UnifiedMedia,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ) => Promise<UnifiedMedia>;
  enrichSpecAllowedOrigins: (
    spec: OffscreenDownloadSpec,
    settings: ExtensionSettings,
  ) => Promise<OffscreenDownloadSpec>;
  dispatchSpecTaskToOffscreen: (
    taskId: string,
    spec: OffscreenDownloadSpec,
    dispatchOpts?: { forceRefresh?: boolean; skipAutoRefresh?: boolean },
  ) => Promise<void>;
}

export interface TabSyncPrivacyFirewall {
  getCurrentTabSync(): TabSyncState | null;
  queryActiveTab(): Promise<ChromeTabLike | undefined>;
  scheduleTabSyncEvaluation(
    tabId: number,
    rawUrl: string | undefined,
    immediate?: boolean,
  ): void;
  ensureInitialTabSync(): Promise<void>;
  registerContextMenus(): Promise<void>;
  onContextMenuClicked(
    info: ChromeContextMenuClickInfo & { selectionText?: string },
    tab?: ChromeTabLike,
  ): void;
  onCommandTriggered(command: string, tab?: ChromeTabLike): void;
  executeUrlToDownloadFlow(params: {
    placeholderTaskId: string;
    matched: MatchedPlatformUrl;
    qualityPreference: QualityPreference;
    batchSaveMode: BatchSaveMode;
    subfolderPrefix: string;
    forceSubfolder: boolean;
    groupBatchId?: string;
    itemId?: string;
    variantId?: string;
  }): Promise<string[]>;
  enqueueBatchUrls(req: {
    urls: string[];
    qualityPreference?: QualityPreference;
    batchSaveMode?: BatchSaveMode;
    subfolderPrefix?: string;
  }): Promise<{
    groupBatchId: string;
    taskIds: string[];
    tasks: ExtensionDownloadTask[];
  }>;
  dispose(): void;
}

export function createTabSyncPrivacyFirewall(
  deps: TabSyncPrivacyFirewallDeps,
): TabSyncPrivacyFirewall {
  const {
    chromeApi,
    storage,
    nowFn,
    tabSyncDebounceMs,
    youtubeTabSyncDebounceMs,
    maxBatchDownloadConcurrency,
    isDisposed,
    nextId,
    sidePanelPorts,
    tasks,
    taskOrder,
    parseAbortControllers,
    insertOrUpdateTask,
    waitTaskSettled,
    trackBackgroundJob,
    broadcastToSidePanels,
    broadcastTasksUpdated,
    onTaskHistoryChange,
    updateBadge,
    scheduleOffscreenIdleCloseIfIdle,
    resolveExtraAllowedMediaOrigins,
    parseSupportedUrlInternal,
    resolveLazyItemInternal,
    hydrateDeferredMediaItems,
    enrichSpecAllowedOrigins,
    dispatchSpecTaskToOffscreen,
  } = deps;

  let tabSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let currentTabSync: TabSyncState | null = null;
  let initialTabSyncPromise: Promise<void> | null = null;
  let lastBroadcastTabKey = "";

  // ==========================================================================
  // 1. Privacy-Gated Active Tab Sync (`matchSupportedPlatformUrl` Locally Only!)
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
    if (isDisposed()) return;
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
      if (isDisposed()) return;
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
    if (currentTabSync !== null || isDisposed()) return;
    if (!initialTabSyncPromise) {
      initialTabSyncPromise = (async () => {
        const first = await queryActiveTab();
        if (!isDisposed() && currentTabSync === null && first?.id !== undefined) {
          scheduleTabSyncEvaluation(first.id, first.url, true);
        }
      })().finally(() => {
        initialTabSyncPromise = null;
      });
    }
    await initialTabSyncPromise;
  };

  // ==========================================================================
  // 2. URL-to-Download Pipeline & Bounded Batch Queue
  // ==========================================================================

  const executeUrlToDownloadFlow = async (params: {
    placeholderTaskId: string;
    matched: MatchedPlatformUrl;
    qualityPreference: QualityPreference;
    batchSaveMode: BatchSaveMode;
    subfolderPrefix: string;
    forceSubfolder: boolean;
    groupBatchId?: string;
    itemId?: string;
    variantId?: string;
  }): Promise<string[]> => {
    const {
      placeholderTaskId,
      matched,
      qualityPreference,
      batchSaveMode,
      subfolderPrefix,
      forceSubfolder,
      groupBatchId,
      itemId,
      variantId,
    } = params;

    const existing = tasks.get(placeholderTaskId);
    if (!existing || existing.status === "cancelled") {
      return [];
    }

    const parseController = new AbortController();
    parseAbortControllers.set(placeholderTaskId, parseController);

    tasks.set(placeholderTaskId, {
      ...existing,
      persistedFromHistory: undefined,
      status: "parsing",
      statusText: "正在解析链接...",
      error: undefined,
      unwhitelistedHost: undefined,
      updatedAt: nowFn(),
    });
    updateBadge();
    await onTaskHistoryChange?.({ immediate: true });
    await broadcastTasksUpdated();

    try {
      const settings = await storage.getSettings();
      const rawMedia = await parseSupportedUrlInternal(
        matched,
        settings,
        parseController.signal,
      );

      let hydratedMedia: UnifiedMedia = rawMedia;
      const requestedItem = itemId
        ? rawMedia.items.find((it) => it.id === itemId)
        : undefined;
      if (requestedItem) {
        if (requestedItem.state === "deferred" && requestedItem.resolve_url && resolveLazyItemInternal) {
          const part = await resolveLazyItemInternal(requestedItem.resolve_url, settings, parseController.signal);
          const match = part.items.find((it) => it.id === itemId);
          if (match && readyItem(match)) {
            hydratedMedia = {
              ...rawMedia,
              items: rawMedia.items.map((it) =>
                it.id === itemId
                  ? match.resolve_url ? match : { ...match, resolve_url: requestedItem.resolve_url }
                  : it,
              ),
              attachments: [...(rawMedia.attachments ?? []), ...(part.attachments ?? [])],
            };
          }
        }
      } else {
        hydratedMedia = await hydrateDeferredMediaItems(rawMedia, settings, parseController.signal);
      }

      if (tasks.get(placeholderTaskId)?.status === "cancelled") return [];

      const extraAllowedOrigins = await resolveExtraAllowedMediaOrigins(settings);
      const targetReady = itemId
        ? hydratedMedia.items.find((it) => it.id === itemId && readyItem(it))
        : undefined;
      const matchedVariant =
        targetReady && readyItem(targetReady) && variantId
          ? targetReady.variants.find((v) => readyVariant(v) && v.id === variantId)
          : undefined;
      const baseOpts = {
        apiOrigin: settings.apiBaseUrl, qualityPreference, batchSaveMode,
        subfolderPrefix, forceSubfolder, extraAllowedOrigins, sourceUrl: matched.url, now: nowFn(),
      };
      let enqueueItems;
      if (targetReady && matchedVariant) {
        try {
          enqueueItems = buildEnqueueItemsForMedia(hydratedMedia, {
            ...baseOpts, itemIds: [targetReady.id],
            variantSelections: { [targetReady.id]: { variant_id: matchedVariant.id } },
          });
        } catch {
          enqueueItems = buildEnqueueItemsForMedia(hydratedMedia, { ...baseOpts, itemIds: [targetReady.id] });
        }
      } else {
        enqueueItems = buildEnqueueItemsForMedia(
          hydratedMedia,
          targetReady ? { ...baseOpts, itemIds: [targetReady.id] } : baseOpts,
        );
      }

      const spawnedIds: string[] = [];
      const first = enqueueItems[0];
      const currentPlaceholder = tasks.get(placeholderTaskId);
      if (!currentPlaceholder || currentPlaceholder.status === "cancelled") {
        return [];
      }

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
            ...(itemId ? { itemId } : {}),
            ...(variantId ? { variantId } : {}),
            qualityPreference,
            batchSaveMode,
            subfolderPrefix,
          },
        });
        updateBadge("failed");
      }
      await onTaskHistoryChange?.({ immediate: true });
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
    await onTaskHistoryChange?.({ immediate: true });
    await broadcastTasksUpdated();

    void trackBackgroundJob(
      (async () => {
        const inFlightSettles: Set<Promise<void>> = new Set();

        for (let idx = 0; idx < matchedList.length; idx++) {
          if (isDisposed()) break;
          const taskId = createdIds[idx];
          const matched = matchedList[idx];
          const current = tasks.get(taskId);
          if (!current || current.status === "cancelled") continue;

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
  // 3. Dual Context Menus & `Alt+Shift+D` (Strict Line-1 Synchronous Gesture!)
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
    chromeApi.contextMenus.create({
      id: CONTEXT_MENU_PARSE_SELECTION_ID,
      title: "用 DokiTool 解析选中链接",
      contexts: ["selection"],
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
    await onTaskHistoryChange?.({ immediate: true });
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

  const openSidePanelSync = (tab?: ChromeTabLike): void => {
    // STRICT LINE-1 USER-GESTURE COMPLIANCE: synchronous `sidePanel.open` BEFORE any `await`!
    if (tab?.id !== undefined) {
      void chromeApi.sidePanel?.open({ tabId: tab.id })?.catch?.(() => {});
    } else if (tab?.windowId !== undefined) {
      void chromeApi.sidePanel?.open({ windowId: tab.windowId })?.catch?.(() => {});
    }
  };

  const onContextMenuClicked = (
    info: ChromeContextMenuClickInfo & { selectionText?: string },
    tab?: ChromeTabLike,
  ): void => {
    if (info.menuItemId === CONTEXT_MENU_INSPECT_ID) {
      openSidePanelSync(tab);
      const rawTarget =
        info.linkUrl || info.srcUrl || info.pageUrl || tab?.url || "";
      void trackBackgroundJob(emitInspectIntent(rawTarget));
      return;
    }

    if (info.menuItemId === CONTEXT_MENU_PARSE_SELECTION_ID) {
      const extractedUrl = extractFirstValidSelectionUrl(info.selectionText);
      if (!extractedUrl) return;
      openSidePanelSync(tab);
      void trackBackgroundJob(emitInspectIntent(extractedUrl));
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
    openSidePanelSync(tab);

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

  const dispose = (): void => {
    if (tabSyncTimer !== null) {
      clearTimeout(tabSyncTimer);
      tabSyncTimer = null;
    }
  };

  return {
    getCurrentTabSync: () => currentTabSync,
    queryActiveTab,
    scheduleTabSyncEvaluation,
    ensureInitialTabSync,
    registerContextMenus,
    onContextMenuClicked,
    onCommandTriggered,
    executeUrlToDownloadFlow,
    enqueueBatchUrls,
    dispose,
  };
}
