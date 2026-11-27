import {
  OFFSCREEN_IDLE_CLOSE_MS,
  OFFSCREEN_PORT_NAME,
  SIDEPANEL_PORT_NAME,
  TAB_SYNC_DEBOUNCE_MS,
  YOUTUBE_TAB_SYNC_DEBOUNCE_MS,
  errRpc,
  isOffscreenToBackgroundMessage,
  isSidePanelRequest,
  okRpc,
  type BackgroundToSidePanelBroadcast,
  type ExtensionDownloadTask,
  type ExtensionRpcResponse,
  type ExtensionStateSnapshot,
  type MatchedPlatformUrl,
  type SidePanelResponseMap,
  type SidePanelToBackgroundRequest,
} from "./protocol";
import {
  buildWorkFingerprint,
  createExtensionStorage,
  type StorageAreaLike,
} from "./storage";
import { formatPlatformDisplayName } from "./uiTargetHelpers";
import { matchActiveParseUrl } from "./urlMatcher";
import {
  HttpStatusError,
  createApiClient,
  withRateLimitRetry,
} from "./bg/apiClient";
import { createDnrRulesManager } from "./bg/dnrRules";
import {
  createDownloadCoordinator,
  type DownloadCoordinator,
} from "./bg/downloadCoordinator";
import { createMultiPartQueue } from "./bg/multiPartQueue";
import { createSpecRefresher } from "./bg/specRefresher";
import { createTabSyncPrivacyFirewall } from "./bg/tabSyncPrivacyFirewall";
import { createTaskHistoryStore } from "./bg/taskHistoryStore";
import {
  ACTIVE_TASK_STATUSES,
  DEFAULT_ACTION_TITLE,
  DEFAULT_BADGE_PROGRESS_THROTTLE_MS,
  FINISHED_TASK_STATUSES,
  computeActionIndicator,
  createActionBadgeController,
  type ActionIndicatorState,
  type BackgroundController,
  type BackgroundControllerDeps,
  type ChromeActionLike,
  type ChromeBackgroundApi,
  type ChromeContextMenuClickInfo,
  type ChromeDeterminingFilenameListener,
  type ChromeDownloadDelta,
  type ChromeDownloadFilenameSuggestion,
  type ChromeDownloadItemLike,
  type ChromePortLike,
  type ChromeRuntimeMessageListener,
  type ChromeTabLike,
  type ExternalWebSenderCheckResult,
  type PendingBlobDownloadRecord,
} from "./bg/types";
import {
  createWebExternalBridge,
  mapTaskStatusToWebPhase,
  sanitizeWebBridgeFilename,
  validateExternalWebSender,
} from "./bg/webExternalBridge";

export {
  DEFAULT_ACTION_TITLE,
  DEFAULT_BADGE_PROGRESS_THROTTLE_MS,
  HttpStatusError,
  computeActionIndicator,
  mapTaskStatusToWebPhase,
  sanitizeWebBridgeFilename,
  validateExternalWebSender,
  withRateLimitRetry,
  type ActionIndicatorState,
  type BackgroundController,
  type BackgroundControllerDeps,
  type ChromeActionLike,
  type ChromeBackgroundApi,
  type ChromeContextMenuClickInfo,
  type ChromeDeterminingFilenameListener,
  type ChromeDownloadDelta,
  type ChromeDownloadFilenameSuggestion,
  type ChromeDownloadItemLike,
  type ChromePortLike,
  type ChromeRuntimeMessageListener,
  type ChromeTabLike,
  type ExternalWebSenderCheckResult,
};

export function createBackgroundController(
  deps?: BackgroundControllerDeps & { historyStorage?: StorageAreaLike },
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
  const badgeProgressThrottleMs = Math.max(
    0,
    deps?.badgeProgressThrottleMs ?? DEFAULT_BADGE_PROGRESS_THROTTLE_MS,
  );
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

  const tasks = new Map<string, ExtensionDownloadTask>();
  const taskOrder: string[] = [];
  const webBridgeTaskIds = new Set<string>();
  const parseAbortControllers = new Map<string, AbortController>();
  const pendingBlobDownloads = new Map<number, PendingBlobDownloadRecord>();

  let backgroundAsyncJobs = 0;
  const idleWaiters: Array<() => void> = [];
  const taskSettledWaiters = new Map<string, Array<() => void>>();

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

  const insertOrUpdateTask = (task: ExtensionDownloadTask): void => {
    if (!tasks.has(task.taskId)) {
      taskOrder.unshift(task.taskId);
    }
    tasks.set(task.taskId, task);
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
      if (ACTIVE_TASK_STATUSES.has(task.status)) count += 1;
    }
    return count;
  };

  const waitTaskSettled = (taskId: string): Promise<void> => {
    const current = tasks.get(taskId);
    if (disposed || !current || FINISHED_TASK_STATUSES.has(current.status)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const list = taskSettledWaiters.get(taskId);
      if (list) list.push(resolve);
      else taskSettledWaiters.set(taskId, [resolve]);
    });
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

  const badgeController = createActionBadgeController({
    chromeApi,
    nowFn,
    badgeSuccessDurationMs,
    badgeProgressThrottleMs,
    isDisposed: () => disposed,
    hasOpenSidePanel: () => sidePanelPorts.size > 0,
    getOrderedTasks,
    countActiveTasks,
  });

  // ==========================================================================
  // Sub-Module Wiring (`bg/*`)
  // ==========================================================================

  const dnrManager = createDnrRulesManager({ chromeApi, storage });
  const taskHistoryStore = createTaskHistoryStore({
    chromeApi,
    storageArea: deps?.historyStorage,
    tasks,
    taskOrder,
    isDisposed: () => disposed,
  });
  const onTaskHistoryChange = (options?: { immediate?: boolean }) =>
    options?.immediate
      ? taskHistoryStore.syncNow()
      : taskHistoryStore.scheduleSync();

  let downloadCoordinator!: DownloadCoordinator;
  const apiClient = createApiClient({
    chromeApi,
    storage,
    fetchFn,
    nowFn,
    syncDynamicDnrRules: dnrManager.syncDynamicDnrRules,
    sendToOffscreen: (req, options) =>
      downloadCoordinator.sendToOffscreen(req, options),
    onParseProgress: (stage, statusText) => {
      broadcastToSidePanels({
        type: "PARSE_PROGRESS",
        stage,
        statusText,
      });
    },
  });

  const specRefresher = createSpecRefresher({
    nowFn,
    parseSupportedUrlInternal: apiClient.parseSupportedUrlInternal,
    resolveLazyItemInternal: apiClient.resolveLazyItemInternal,
  });

  downloadCoordinator = createDownloadCoordinator({
    chromeApi,
    storage,
    nowFn,
    offscreenIdleCloseMs,
    isDisposed: () => disposed,
    nextId,
    tasks,
    parseAbortControllers,
    pendingBlobDownloads,
    insertOrUpdateTask,
    countActiveTasks,
    trackBackgroundJob,
    notifyIfCompletelyIdle,
    updateBadge: badgeController.updateBadge,
    broadcastTasksUpdated,
    onTaskHistoryChange,
    syncDynamicDnrRules: dnrManager.syncDynamicDnrRules,
    resolveExtraAllowedMediaOrigins: dnrManager.resolveExtraAllowedMediaOrigins,
    prepareSpecForDispatch: specRefresher.prepareSpecForDispatch,
  });

  const tabSyncFirewall = createTabSyncPrivacyFirewall({
    chromeApi,
    storage,
    nowFn,
    tabSyncDebounceMs,
    youtubeTabSyncDebounceMs,
    maxBatchDownloadConcurrency,
    isDisposed: () => disposed,
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
    updateBadge: badgeController.updateBadge,
    scheduleOffscreenIdleCloseIfIdle:
      downloadCoordinator.scheduleOffscreenIdleCloseIfIdle,
    resolveExtraAllowedMediaOrigins: dnrManager.resolveExtraAllowedMediaOrigins,
    parseSupportedUrlInternal: apiClient.parseSupportedUrlInternal,
    resolveLazyItemInternal: apiClient.resolveLazyItemInternal,
    hydrateDeferredMediaItems: apiClient.hydrateDeferredMediaItems,
    enrichSpecAllowedOrigins: downloadCoordinator.enrichSpecAllowedOrigins,
    dispatchSpecTaskToOffscreen: downloadCoordinator.dispatchSpecTaskToOffscreen,
  });

  const multiPartQueue = createMultiPartQueue({
    storage,
    nowFn,
    maxBatchDownloadConcurrency,
    isDisposed: () => disposed,
    nextId,
    tasks,
    parseAbortControllers,
    insertOrUpdateTask,
    waitTaskSettled,
    trackBackgroundJob,
    broadcastTasksUpdated,
    onTaskHistoryChange,
    updateBadge: badgeController.updateBadge,
    scheduleOffscreenIdleCloseIfIdle:
      downloadCoordinator.scheduleOffscreenIdleCloseIfIdle,
    resolveExtraAllowedMediaOrigins: dnrManager.resolveExtraAllowedMediaOrigins,
    parseSupportedUrlInternal: apiClient.parseSupportedUrlInternal,
    resolveLazyItemInternal: apiClient.resolveLazyItemInternal,
    enrichSpecAllowedOrigins: downloadCoordinator.enrichSpecAllowedOrigins,
    dispatchSpecTaskToOffscreen: downloadCoordinator.dispatchSpecTaskToOffscreen,
  });

  const webExternalBridge = createWebExternalBridge({
    chromeApi,
    storage,
    tasks,
    webBridgeTaskIds,
    parseYouTubeViaOffscreen: apiClient.parseYouTubeViaOffscreen,
    enqueueDownloadItems: downloadCoordinator.enqueueDownloadItems,
    cancelTaskById: downloadCoordinator.cancelTaskById,
  });

  // ==========================================================================
  // Snapshot, SidePanel RPCs & Runtime Message Router
  // ==========================================================================

  const getSnapshot = async (): Promise<ExtensionStateSnapshot> => {
    await taskHistoryStore.ensureHydrated();
    if (tabSyncFirewall.getCurrentTabSync() === null) {
      await tabSyncFirewall.ensureInitialTabSync();
    }
    const [settings, savedWorks, pendingIntent] = await Promise.all([
      storage.getSettings(),
      storage.getSavedWorks(),
      storage.getPendingIntent(),
    ]);
    return {
      settings,
      tabSync: tabSyncFirewall.getCurrentTabSync(),
      tasks: getOrderedTasks(),
      savedWorkFingerprints: savedWorks.map((w) => w.fingerprint),
      pendingIntent,
      connection: apiClient.getLastConnectionCheck(),
    };
  };

  const handleSidePanelRequest = async (
    req: SidePanelToBackgroundRequest,
  ): Promise<
    ExtensionRpcResponse<SidePanelResponseMap[SidePanelToBackgroundRequest["type"]]>
  > => {
    switch (req.type) {
      case "GET_INITIAL_STATE":
        return okRpc(await getSnapshot());

      case "UPDATE_SETTINGS": {
        const settings = await storage.updateSettings(req.patch);
        await dnrManager.syncDynamicDnrRules();
        const snapshot = await getSnapshot();
        broadcastToSidePanels({ type: "STATE_SNAPSHOT", snapshot });
        return okRpc({ settings });
      }

      case "TEST_CONNECTION":
        return okRpc(
          await apiClient.runTestConnection({
            apiBaseUrl: req.apiBaseUrl,
            bearerToken: req.bearerToken,
          }),
        );

      case "FETCH_OWNER_STATS":
        return apiClient.fetchOwnerStats();

      case "PARSE_URL": {
        const matched = matchActiveParseUrl(req.url);
        if (!matched) {
          return errRpc(
            "请输入有效的公开媒体链接（已本地拦截内网、IP 与浏览器内部地址）",
            { code: "UNSUPPORTED_PLATFORM", status: 400 },
          );
        }
        const settings = await storage.getSettings();
        const media = await apiClient.parseSupportedUrlInternal(matched, settings);
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
        const media = await apiClient.resolveLazyItemInternal(
          req.resolveUrl,
          settings,
        );
        return okRpc({ media });
      }

      case "ENQUEUE_DOWNLOADS":
        await taskHistoryStore.ensureHydrated();
        return okRpc(
          await downloadCoordinator.enqueueDownloadItems(
            req.items,
            req.groupBatchId,
          ),
        );

      case "ENQUEUE_BATCH_URLS":
        await taskHistoryStore.ensureHydrated();
        return okRpc(await tabSyncFirewall.enqueueBatchUrls(req));

      case "ENQUEUE_MULTIPART_ITEMS":
        await taskHistoryStore.ensureHydrated();
        return okRpc(await multiPartQueue.enqueueMultiPartItems(req));

      case "CANCEL_TASK":
        await taskHistoryStore.ensureHydrated();
        return okRpc(await downloadCoordinator.cancelTaskById(req.taskId));

      case "RETRY_TASK": {
        await taskHistoryStore.ensureHydrated();
        const task = tasks.get(req.taskId);
        if (!task || !task.retryPayload) {
          return errRpc("未找到可重试的任务记录", { code: "TASK_NOT_FOUND" });
        }
        const retryPayload = task.retryPayload;
        if (retryPayload.kind === "spec") {
          const refreshCtx = retryPayload.spec.refreshContext;
          const isExpired = specRefresher.isSpecExpiredForDispatch(
            retryPayload.spec,
          );
          const failedByExpiry = task.lastErrorCode === "MEDIA_URL_EXPIRED";
          const needsManualRefresh = Boolean(
            refreshCtx && (isExpired || failedByExpiry),
          );
          const resetTask: ExtensionDownloadTask = {
            ...task,
            persistedFromHistory: undefined,
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
          badgeController.updateBadge();
          await broadcastTasksUpdated();
          void trackBackgroundJob(
            downloadCoordinator.dispatchSpecTaskToOffscreen(
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
          persistedFromHistory: undefined,
          status: "parsing",
          statusText: "重新解析中...",
          percent: 0,
          loaded: 0,
          speed: 0,
          chromeDownloadId: undefined,
          error: undefined,
          lastErrorCode: undefined,
          lastErrorHttpStatus: undefined,
          unwhitelistedHost: undefined,
          updatedAt: nowFn(),
        };
        tasks.set(req.taskId, resetUrlTask);
        badgeController.updateBadge();
        await broadcastTasksUpdated();

        void trackBackgroundJob(
          tabSyncFirewall.executeUrlToDownloadFlow({
            placeholderTaskId: req.taskId,
            matched,
            qualityPreference:
              retryPayload.qualityPreference ?? settings.qualityPreference,
            batchSaveMode: retryPayload.batchSaveMode ?? settings.batchSaveMode,
            subfolderPrefix:
              retryPayload.subfolderPrefix ?? settings.subfolderPrefix,
            forceSubfolder: Boolean(task.groupBatchId),
            groupBatchId: task.groupBatchId,
            ...(retryPayload.itemId ? { itemId: retryPayload.itemId } : {}),
            ...(retryPayload.variantId ? { variantId: retryPayload.variantId } : {}),
          }),
        );
        return okRpc({ task: resetUrlTask });
      }

      case "CLEAR_FINISHED_TASKS": {
        await taskHistoryStore.ensureHydrated();
        for (const [id, task] of Array.from(tasks.entries())) {
          if (FINISHED_TASK_STATUSES.has(task.status)) {
            tasks.delete(id);
            webBridgeTaskIds.delete(id);
            const idx = taskOrder.indexOf(id);
            if (idx >= 0) taskOrder.splice(idx, 1);
          }
        }
        await taskHistoryStore.clearFinished();
        if (countActiveTasks() === 0) {
          badgeController.updateBadge("clear");
        }
        await broadcastTasksUpdated();
        return okRpc({ remainingCount: tasks.size });
      }

      case "OPEN_DOWNLOAD_FOLDER": {
        if (req.taskId && !tasks.has(req.taskId)) {
          await taskHistoryStore.ensureHydrated();
        }
        const downloadId =
          req.chromeDownloadId ??
          (req.taskId ? tasks.get(req.taskId)?.chromeDownloadId : undefined);
        if (typeof downloadId === "number" && chromeApi.downloads?.show) {
          chromeApi.downloads.show(downloadId);
          return okRpc({ opened: true });
        }
        return okRpc({ opened: false });
      }

      case "CONSUME_INTENT":
        return okRpc({ intent: await storage.consumePendingIntent(req.intentId) });
    }
  };

  const isTrustedInternalSender = (
    sender: unknown,
    expectedPagePath: "/sidepanel.html" | "/offscreen.html",
  ): boolean => {
    if (!sender || typeof sender !== "object") return true;
    const s = sender as { id?: unknown; url?: unknown; tab?: unknown };
    const selfId = chromeApi.runtime.id;
    if (typeof s.id === "string" && s.id && selfId && s.id !== selfId) {
      return false;
    }
    const rawUrl = typeof s.url === "string" ? s.url.trim() : "";
    if (s.tab !== undefined) {
      // Offscreen documents never run in browser tabs; a tab sender is only
      // accepted for sidepanel.html when Chrome reports the exact extension URL.
      if (expectedPagePath !== "/sidepanel.html" || !rawUrl) {
        return false;
      }
    }
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== "chrome-extension:") return false;
        if (selfId && parsed.hostname !== selfId) return false;
        return parsed.pathname === expectedPagePath;
      } catch {
        return false;
      }
    }
    return true;
  };

  // STRICT MV3 IPC CONTRACT:
  // ONLY return `true` / call `sendResponse` when `isSidePanelRequest(msg)`
  // or `isOffscreenToBackgroundMessage(msg)` from the matching internal page!
  const handleRuntimeMessage: ChromeRuntimeMessageListener = (
    msg: unknown,
    sender: unknown,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    if (isSidePanelRequest(msg)) {
      if (!isTrustedInternalSender(sender, "/sidepanel.html")) {
        sendResponse(errRpc("拒绝来自非侧边栏上下文的内部调用", { code: "FORBIDDEN_SENDER" }));
        return false;
      }
      void handleSidePanelRequest(msg)
        .then((resp) => sendResponse(resp))
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
      if (!isTrustedInternalSender(sender, "/offscreen.html")) {
        sendResponse(errRpc("拒绝来自非离屏文档上下文的内部调用", { code: "FORBIDDEN_SENDER" }));
        return false;
      }
      void downloadCoordinator
        .handleOffscreenMessage(msg)
        .then((resp) => sendResponse(resp))
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

  const handleExternalRuntimeMessage =
    webExternalBridge.handleExternalRuntimeMessage;

  // ==========================================================================
  // Listener Registration & Boot
  // ==========================================================================

  chromeApi.runtime.onMessage.addListener(handleRuntimeMessage);
  chromeApi.runtime.onMessageExternal?.addListener(handleExternalRuntimeMessage);

  chromeApi.runtime.onConnect?.addListener((port) => {
    if (port.name === SIDEPANEL_PORT_NAME) {
      sidePanelPorts.add(port);
      badgeController.flushIfThrottled();
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
      downloadCoordinator.setOffscreenDocumentOpen(true);
      port.onMessage?.addListener((msg) => {
        if (isOffscreenToBackgroundMessage(msg)) {
          void downloadCoordinator.handleOffscreenMessage(msg).catch(() => {});
        }
      });
      port.onDisconnect?.addListener(() => {
        if (offscreenPort === port) offscreenPort = null;
      });
    }
  });

  chromeApi.contextMenus?.onClicked.addListener(
    tabSyncFirewall.onContextMenuClicked,
  );
  chromeApi.commands?.onCommand.addListener(tabSyncFirewall.onCommandTriggered);
  chromeApi.downloads?.onChanged.addListener(
    downloadCoordinator.onChromeDownloadChanged,
  );
  chromeApi.downloads?.onDeterminingFilename?.addListener(
    downloadCoordinator.onChromeDeterminingFilename,
  );

  chromeApi.tabs?.onActivated?.addListener((activeInfo) => {
    if (!chromeApi.tabs?.get) return;
    void chromeApi.tabs
      .get(activeInfo.tabId)
      .then((tab) => {
        tabSyncFirewall.scheduleTabSyncEvaluation(activeInfo.tabId, tab?.url);
      })
      .catch(() => {});
  });

  chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (tab?.active === false) return;
    if (changeInfo.url === undefined && changeInfo.status !== "complete") return;
    tabSyncFirewall.scheduleTabSyncEvaluation(tabId, changeInfo.url ?? tab?.url);
  });

  chromeApi.permissions?.onAdded?.addListener(() => {
    void dnrManager.syncDynamicDnrRules().catch(() => {});
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
      dnrManager.syncDynamicDnrRules().catch(() => []),
      tabSyncFirewall.registerContextMenus().catch(() => {}),
      taskHistoryStore.ensureHydrated().catch(() => []),
    ]);
    const first = await tabSyncFirewall.queryActiveTab();
    if (first?.id !== undefined) {
      tabSyncFirewall.scheduleTabSyncEvaluation(first.id, first.url, true);
    }
    badgeController.updateBadge(countActiveTasks() === 0 ? "clear" : undefined);
  };

  return {
    init,
    syncDynamicDnrRules: dnrManager.syncDynamicDnrRules,
    ensureOffscreenDocument: downloadCoordinator.ensureOffscreenDocument,
    getSnapshot,
    handleRuntimeMessage,
    handleExternalRuntimeMessage,
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
      downloadCoordinator.dispose();
      tabSyncFirewall.dispose();
      taskHistoryStore.dispose();
      badgeController.dispose();
      for (const [, ctrl] of Array.from(parseAbortControllers.entries())) {
        ctrl.abort();
      }
      parseAbortControllers.clear();
      chromeApi.runtime.onMessage.removeListener?.(handleRuntimeMessage);
      chromeApi.runtime.onMessageExternal?.removeListener?.(
        handleExternalRuntimeMessage,
      );
      chromeApi.downloads?.onChanged.removeListener?.(
        downloadCoordinator.onChromeDownloadChanged,
      );
      chromeApi.downloads?.onDeterminingFilename?.removeListener?.(
        downloadCoordinator.onChromeDeterminingFilename,
      );
      webBridgeTaskIds.clear();
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
