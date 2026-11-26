import type { ExtensionDnrRule } from "../dnrRules";
import {
  okRpc,
  type EnqueueDownloadItem,
  type ExtensionDownloadTask,
  type ExtensionRpcResponse,
  type ExtensionSettings,
  type HandOffBlobDownloadResult,
  type OffscreenDownloadSpec,
  type OffscreenToBackgroundMessage,
} from "../protocol";
import type { ExtensionStorageController } from "../storage";
import { auditCompletedDownloadFilename } from "./filenameAudit";
import { createOffscreenLifecycle } from "./offscreenLifecycle";
import {
  classifySpecDispatchRoute,
  type PrepareSpecForDispatchParams,
  type PrepareSpecForDispatchResult,
} from "./specRefresher";
import {
  FINISHED_TASK_STATUSES,
  sanitizeRelativeDownloadPath,
  type ChromeBackgroundApi,
  type ChromeDeterminingFilenameListener,
  type ChromeDownloadDelta,
  type PendingBlobDownloadRecord,
} from "./types";

export interface DownloadCoordinatorDeps {
  chromeApi: ChromeBackgroundApi;
  storage: ExtensionStorageController;
  nowFn: () => number;
  offscreenIdleCloseMs: number;
  isDisposed: () => boolean;
  nextId: (prefix: string) => string;
  tasks: Map<string, ExtensionDownloadTask>;
  parseAbortControllers: Map<string, AbortController>;
  pendingBlobDownloads: Map<number, PendingBlobDownloadRecord>;
  insertOrUpdateTask: (task: ExtensionDownloadTask) => void;
  countActiveTasks: () => number;
  trackBackgroundJob: <T>(promise: Promise<T>) => Promise<T>;
  notifyIfCompletelyIdle: () => void;
  updateBadge: (
    terminalOutcome?: "completed" | "failed" | "clear",
    options?: { progressOnly?: boolean },
  ) => void;
  broadcastTasksUpdated: (includeSavedFingerprints?: boolean) => Promise<void>;
  onTaskHistoryChange?: (options?: { immediate?: boolean }) => Promise<void> | void;
  syncDynamicDnrRules: (extraOrigins?: string[]) => Promise<ExtensionDnrRule[]>;
  resolveExtraAllowedMediaOrigins: (settings: ExtensionSettings) => Promise<string[]>;
  prepareSpecForDispatch: (
    params: PrepareSpecForDispatchParams,
  ) => Promise<PrepareSpecForDispatchResult>;
}

export type DownloadCoordinator = ReturnType<typeof createDownloadCoordinator>;

export function createDownloadCoordinator(deps: DownloadCoordinatorDeps) {
  const {
    chromeApi,
    storage,
    nowFn,
    offscreenIdleCloseMs,
    isDisposed,
    nextId,
    tasks,
    parseAbortControllers,
    pendingBlobDownloads,
    insertOrUpdateTask,
    countActiveTasks,
    trackBackgroundJob,
    notifyIfCompletelyIdle,
    updateBadge,
    broadcastTasksUpdated,
    onTaskHistoryChange,
    syncDynamicDnrRules,
    resolveExtraAllowedMediaOrigins,
    prepareSpecForDispatch,
  } = deps;

  const offscreenLifecycle = createOffscreenLifecycle({
    chromeApi,
    offscreenIdleCloseMs,
    isDisposed,
    countActiveTasks,
    getPendingBlobCount: () => pendingBlobDownloads.size,
    syncDynamicDnrRules,
  });

  const {
    clearOffscreenIdleTimer,
    scheduleOffscreenIdleCloseIfIdle,
    ensureOffscreenDocument,
    sendToOffscreen,
    sendReleaseBlobToOffscreen,
  } = offscreenLifecycle;

  const earlyDownloadDeltas = new Map<number, ChromeDownloadDelta>();
  const observedDownloadFilenames = new Map<number, string>();
  const authoritativeFilenamesByUrl = new Map<string, string>();
  const authoritativeFilenamesByDownloadId = new Map<number, string>();
  const authoritativeUrlByDownloadId = new Map<number, string>();

  // 1. Authoritative Filename Gatekeeper (`onDeterminingFilename`)
  const cleanupAuthoritativeFilenameByUrl = (url: string | undefined, excludeDownloadId?: number): void => {
    if (!url) return;
    for (const [id, rec] of pendingBlobDownloads.entries()) {
      if (id !== excludeDownloadId && (rec.downloadUrl === url || rec.blobUrl === url)) return;
    }
    for (const [id, mappedUrl] of authoritativeUrlByDownloadId.entries()) {
      if (id !== excludeDownloadId && mappedUrl === url) return;
    }
    authoritativeFilenamesByUrl.delete(url);
  };
  const cleanupAuthoritativeFilenameByDownloadId = (downloadId: number, fallbackUrl?: string): void => {
    const mappedUrl = authoritativeUrlByDownloadId.get(downloadId) || fallbackUrl;
    authoritativeFilenamesByDownloadId.delete(downloadId);
    authoritativeUrlByDownloadId.delete(downloadId);
    cleanupAuthoritativeFilenameByUrl(mappedUrl, downloadId);
  };

  const onChromeDeterminingFilename: ChromeDeterminingFilenameListener = (
    item,
    suggest,
  ) => {
    if (!item || typeof item.id !== "number") return;
    let authoritativeFilename = authoritativeFilenamesByDownloadId.get(item.id);
    let matchedUrl = authoritativeUrlByDownloadId.get(item.id);
    if (!authoritativeFilename) {
      const selfId = chromeApi.runtime.id;
      const ownedBySelf =
        !item.byExtensionId || !selfId || item.byExtensionId === selfId;
      if (ownedBySelf) {
        for (const candidate of [item.url, item.finalUrl]) {
          if (typeof candidate === "string" && candidate) {
            const found = authoritativeFilenamesByUrl.get(candidate);
            if (found) {
              authoritativeFilename = found;
              matchedUrl = candidate;
              break;
            }
          }
        }
      }
    }
    if (!authoritativeFilename) return;
    authoritativeFilenamesByDownloadId.set(item.id, authoritativeFilename);
    if (matchedUrl) authoritativeUrlByDownloadId.set(item.id, matchedUrl);
    suggest({ filename: authoritativeFilename, conflictAction: "uniquify" });
  };

  // ==========================================================================
  // 2. Authoritative Downloads Lifecycle & Blob Handoff
  // ==========================================================================

  const failActiveTask = async (
    taskId: string,
    patch: Partial<ExtensionDownloadTask> & { statusText: string; error: string },
    notifyIdle = true,
  ): Promise<void> => {
    const current = tasks.get(taskId);
    if (current && current.status !== "cancelled") {
      tasks.set(taskId, {
        ...current,
        ...patch,
        status: "failed",
        speed: 0,
        updatedAt: nowFn(),
      });
      updateBadge("failed");
      await onTaskHistoryChange?.({ immediate: true });
      await broadcastTasksUpdated();
    }
    scheduleOffscreenIdleCloseIfIdle();
    if (notifyIdle) notifyIfCompletelyIdle();
  };

  const handleDownloadTerminalDelta = async (
    record: PendingBlobDownloadRecord,
    delta: ChromeDownloadDelta,
  ): Promise<void> => {
    const state = delta.state?.current;
    if (state !== "complete" && state !== "interrupted") return;

    pendingBlobDownloads.delete(record.downloadId);
    cleanupAuthoritativeFilenameByDownloadId(
      record.downloadId,
      record.downloadUrl || record.blobUrl,
    );

    const task = tasks.get(record.taskId);
    let savedWorkUpdated = false;
    let outcome: "completed" | "failed" | undefined;

    if (state === "complete") {
      const filenameWarning = await auditCompletedDownloadFilename({
        downloadId: record.downloadId,
        expectedFilename: record.filename,
        deltaFilename: delta.filename?.current,
        observedFilenames: observedDownloadFilenames,
        searchDownloads: chromeApi.downloads?.search,
      });
      if (task) {
        tasks.set(record.taskId, {
          ...task,
          status: "completed",
          statusText: "已完成",
          percent: 100,
          loaded: task.total > 0 ? task.total : task.loaded,
          speed: 0,
          chromeDownloadId: record.downloadId,
          ...(filenameWarning ? { filenameWarning } : {}),
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
      observedDownloadFilenames.delete(record.downloadId);
      const errReason = delta.error?.current || "DOWNLOAD_INTERRUPTED";
      const userCancelled =
        task?.status === "cancelled" || /USER_CANCELED|USER_SHUTDOWN/i.test(errReason);
      if (task) {
        tasks.set(record.taskId, {
          ...task,
          status: userCancelled ? "cancelled" : "failed",
          statusText: userCancelled ? "已取消" : "保存中断",
          speed: 0,
          error: userCancelled ? undefined : `浏览器保存中断（${errReason}）`,
          updatedAt: nowFn(),
        });
      }
      outcome = userCancelled ? undefined : "failed";
    }

    if (record.blobUrl) {
      await sendReleaseBlobToOffscreen(record);
    }

    updateBadge(outcome);
    await onTaskHistoryChange?.({ immediate: true });
    await broadcastTasksUpdated(savedWorkUpdated);
    scheduleOffscreenIdleCloseIfIdle();
    notifyIfCompletelyIdle();
  };

  const replayEarlyDownloadDelta = (record: PendingBlobDownloadRecord): void => {
    const earlyDelta = earlyDownloadDeltas.get(record.downloadId);
    if (earlyDelta) {
      earlyDownloadDeltas.delete(record.downloadId);
      void trackBackgroundJob(handleDownloadTerminalDelta(record, earlyDelta));
    }
  };

  const onChromeDownloadChanged = (delta: ChromeDownloadDelta): void => {
    if (typeof delta?.id === "number" && typeof delta.filename?.current === "string" && delta.filename.current.trim()) {
      observedDownloadFilenames.set(delta.id, delta.filename.current.trim());
    }
    const state = delta?.state?.current;
    if (state !== "complete" && state !== "interrupted") return;
    const record = pendingBlobDownloads.get(delta.id);
    if (!record) {
      earlyDownloadDeltas.set(delta.id, delta);
      const earlyTimer = setTimeout(() => {
        earlyDownloadDeltas.delete(delta.id);
      }, 5_000);
      (earlyTimer as { unref?: () => void })?.unref?.();
      return;
    }
    void trackBackgroundJob(handleDownloadTerminalDelta(record, delta));
  };

  const startChromeDownloadWithGate = async (
    url: string,
    rawFilename: string,
  ): Promise<{ downloadId: number; safeFilename: string }> => {
    const safeFilename = sanitizeRelativeDownloadPath(rawFilename);
    if (url && safeFilename) authoritativeFilenamesByUrl.set(url, safeFilename);
    try {
      const downloadId = await chromeApi.downloads!.download({
        url,
        filename: safeFilename,
        saveAs: false,
        conflictAction: "uniquify",
      });
      authoritativeFilenamesByDownloadId.set(downloadId, safeFilename);
      if (url) authoritativeUrlByDownloadId.set(downloadId, url);
      return { downloadId, safeFilename };
    } catch (err) {
      cleanupAuthoritativeFilenameByUrl(url);
      throw err;
    }
  };

  const handleHandoffBlobDownload = async (
    msg: Extract<OffscreenToBackgroundMessage, { type: "HANDOFF_BLOB_DOWNLOAD" }>,
  ): Promise<HandOffBlobDownloadResult> => {
    clearOffscreenIdleTimer();
    const task = tasks.get(msg.taskId);
    if (task?.status === "cancelled") {
      await sendReleaseBlobToOffscreen(msg);
      throw new Error("任务已取消");
    }
    if (!chromeApi.downloads?.download) {
      await sendReleaseBlobToOffscreen(msg);
      throw new Error("chrome.downloads API 不可用");
    }

    let downloadId: number;
    let safeFilename: string;
    try {
      ({ downloadId, safeFilename } = await startChromeDownloadWithGate(
        msg.blobUrl,
        msg.filename,
      ));
    } catch (err) {
      await sendReleaseBlobToOffscreen(msg);
      const errMsg =
        err instanceof Error && err.message ? err.message : "调用浏览器下载失败";
      await failActiveTask(msg.taskId, { statusText: "保存失败", error: errMsg }, false);
      throw err;
    }

    const record: PendingBlobDownloadRecord = {
      downloadId,
      taskId: msg.taskId,
      blobUrl: msg.blobUrl,
      downloadUrl: msg.blobUrl,
      filename: safeFilename,
      opfsTempName: msg.opfsTempName,
    };
    pendingBlobDownloads.set(downloadId, record);

    const latestTask = tasks.get(msg.taskId);
    if (!latestTask || latestTask.status === "cancelled") {
      cleanupAuthoritativeFilenameByDownloadId(downloadId, msg.blobUrl);
      if (chromeApi.downloads?.cancel) {
        void chromeApi.downloads.cancel(downloadId).catch(() => {});
      }
      replayEarlyDownloadDelta(record);
      return { chromeDownloadId: downloadId };
    }
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
    void onTaskHistoryChange?.({ immediate: false });
    await broadcastTasksUpdated();

    replayEarlyDownloadDelta(record);
    return { chromeDownloadId: downloadId };
  };

  // ==========================================================================
  // 4. Spec Enrichment, Task Dispatch, Enqueue, Cancel & Offscreen Events
  // ==========================================================================

  const enrichSpecAllowedOrigins = async (
    spec: OffscreenDownloadSpec,
    settings: ExtensionSettings,
  ): Promise<OffscreenDownloadSpec> => {
    const extra = await resolveExtraAllowedMediaOrigins(settings);
    return {
      ...spec,
      extraAllowedOrigins: Array.from(
        new Set([...(spec.extraAllowedOrigins ?? []), ...extra]),
      ),
    };
  };

  const dispatchSpecTaskToOffscreen = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    dispatchOpts?: { forceRefresh?: boolean; skipAutoRefresh?: boolean },
  ): Promise<void> => {
    const settings = await storage.getSettings();
    const prepared = await prepareSpecForDispatch({
      taskId,
      spec,
      settings,
      dispatchOpts,
      tasks,
      parseAbortControllers,
      resolveExtraAllowedMediaOrigins,
      updateBadge,
      broadcastTasksUpdated,
      scheduleOffscreenIdleCloseIfIdle,
      notifyIfCompletelyIdle,
    });
    if (!prepared.ok) return;

    const { enrichedSpec, effectiveAllowedOrigins, latestTask: latestBeforeStart } =
      prepared;
    const routeDecision = classifySpecDispatchRoute(
      enrichedSpec,
      effectiveAllowedOrigins,
      latestBeforeStart.fallbackUrl,
    );

    if (routeDecision.mode === "blocked") {
      await failActiveTask(taskId, {
        statusText: "未授权媒体域名",
        error: routeDecision.message,
        lastErrorCode: "UNWHITELISTED_CDN",
        ...(routeDecision.unwhitelistedHost
          ? { unwhitelistedHost: routeDecision.unwhitelistedHost }
          : {}),
        ...(routeDecision.fallbackUrl
          ? { fallbackUrl: routeDecision.fallbackUrl }
          : {}),
        retryPayload: { kind: "spec", spec: enrichedSpec },
      });
      return;
    }

    if (routeDecision.mode === "native") {
      const nativeUrl = routeDecision.url;
      if (!chromeApi.downloads?.download) {
        await failActiveTask(taskId, {
          statusText: "保存失败",
          error: "chrome.downloads API 不可用",
          fallbackUrl: nativeUrl,
          retryPayload: { kind: "spec", spec: enrichedSpec },
        });
        return;
      }

      let downloadId: number;
      let safeFilename: string;
      try {
        ({ downloadId, safeFilename } = await startChromeDownloadWithGate(
          nativeUrl,
          enrichedSpec.filename,
        ));
      } catch (err) {
        await failActiveTask(taskId, {
          statusText: "保存失败",
          error:
            err instanceof Error && err.message
              ? err.message
              : "调用浏览器原生下载失败",
          fallbackUrl: nativeUrl,
          retryPayload: { kind: "spec", spec: enrichedSpec },
        });
        return;
      }

      const afterDownloadStart = tasks.get(taskId);
      if (!afterDownloadStart || afterDownloadStart.status === "cancelled") {
        cleanupAuthoritativeFilenameByDownloadId(downloadId, nativeUrl);
        void chromeApi.downloads?.cancel?.(downloadId)?.catch?.(() => {});
        scheduleOffscreenIdleCloseIfIdle();
        notifyIfCompletelyIdle();
        return;
      }

      const record: PendingBlobDownloadRecord = {
        downloadId,
        taskId,
        blobUrl: "",
        downloadUrl: nativeUrl,
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
      void onTaskHistoryChange?.({ immediate: false });
      await broadcastTasksUpdated();
      replayEarlyDownloadDelta(record);
      return;
    }

    tasks.set(taskId, {
      ...latestBeforeStart,
      status: enrichedSpec.kind === "youtube_mux" ? "muxing" : "downloading",
      statusText:
        enrichedSpec.kind === "youtube_mux"
          ? "正在准备 YouTube 无损合流..."
          : enrichedSpec.kind === "dash_mux"
            ? "正在准备音视频无损合流..."
            : "正在准备下载...",
      total: enrichedSpec.sizeBytes ?? latestBeforeStart.total,
      updatedAt: nowFn(),
      retryPayload: { kind: "spec", spec: enrichedSpec },
    });
    updateBadge();
    void onTaskHistoryChange?.({ immediate: false });
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
      const msg =
        err instanceof Error && err.message ? err.message : "启动后台下载失败";
      await failActiveTask(taskId, { statusText: "启动失败", error: msg }, false);
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
        ...(item.workFingerprint ? { workFingerprint: item.workFingerprint } : {}),
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
    await onTaskHistoryChange?.({ immediate: true });
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

  const cancelTaskById = async (
    taskId: string,
  ): Promise<{ taskId: string; cancelled: boolean }> => {
    const task = tasks.get(taskId);
    if (!task) return { taskId, cancelled: false };
    parseAbortControllers.get(taskId)?.abort();
    parseAbortControllers.delete(taskId);

    tasks.set(taskId, {
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
      cleanupAuthoritativeFilenameByDownloadId(
        task.chromeDownloadId,
        pendingRec?.downloadUrl || pendingRec?.blobUrl,
      );
      if (chromeApi.downloads?.cancel) {
        void chromeApi.downloads.cancel(task.chromeDownloadId).catch(() => {});
      }
    }
    if (offscreenLifecycle.isOffscreenDocumentOpen()) {
      void sendToOffscreen(
        { type: "OFFSCREEN_CANCEL_TASK", taskId },
        { skipEnsure: true },
      ).catch(() => {});
    }

    updateBadge(countActiveTasks() === 0 ? "clear" : undefined);
    await onTaskHistoryChange?.({ immediate: true });
    await broadcastTasksUpdated();
    scheduleOffscreenIdleCloseIfIdle();
    notifyIfCompletelyIdle();
    return { taskId, cancelled: true };
  };

  const handleOffscreenMessage = async (
    msg: OffscreenToBackgroundMessage,
  ): Promise<ExtensionRpcResponse<unknown>> => {
    switch (msg.type) {
      case "HANDOFF_BLOB_DOWNLOAD":
        return okRpc(await handleHandoffBlobDownload(msg));

      case "OFFSCREEN_TASK_PROGRESS": {
        clearOffscreenIdleTimer();
        const task = tasks.get(msg.taskId);
        if (task && !FINISHED_TASK_STATUSES.has(task.status)) {
          const prevStatus = task.status;
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
          updateBadge(undefined, { progressOnly: prevStatus === msg.status });
          await broadcastTasksUpdated();
        }
        return okRpc({ received: true });
      }

      case "OFFSCREEN_TASK_ERROR": {
        const task = tasks.get(msg.taskId);
        if (task && task.status !== "completed" && task.status !== "cancelled") {
          const isCancelled = msg.cancelled === true;
          const specPayload =
            task.retryPayload?.kind === "spec" ? task.retryPayload.spec : undefined;
          if (
            !isCancelled &&
            msg.code === "MEDIA_URL_EXPIRED" &&
            specPayload?.refreshContext &&
            (task.autoRefreshCount ?? 0) < 1
          ) {
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
              autoRefreshCount: (task.autoRefreshCount ?? 0) + 1,
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
            ...(msg.unwhitelistedHost ? { unwhitelistedHost: msg.unwhitelistedHost } : {}),
            ...(msg.fallbackUrl ? { fallbackUrl: msg.fallbackUrl } : {}),
            updatedAt: nowFn(),
          });
          updateBadge(isCancelled ? undefined : "failed");
          await onTaskHistoryChange?.({ immediate: true });
          await broadcastTasksUpdated();
        }
        scheduleOffscreenIdleCloseIfIdle();
        notifyIfCompletelyIdle();
        return okRpc({ received: true });
      }

      case "OFFSCREEN_HEARTBEAT":
        if (msg.activeTaskCount > 0 || msg.pendingBlobCount > 0) {
          clearOffscreenIdleTimer();
        } else {
          scheduleOffscreenIdleCloseIfIdle();
        }
        return okRpc({ alive: true });
    }
  };

  return {
    ensureOffscreenDocument,
    sendToOffscreen,
    setOffscreenDocumentOpen: offscreenLifecycle.setOffscreenDocumentOpen,
    scheduleOffscreenIdleCloseIfIdle,
    enrichSpecAllowedOrigins,
    dispatchSpecTaskToOffscreen,
    enqueueDownloadItems,
    cancelTaskById,
    handleHandoffBlobDownload,
    handleOffscreenMessage,
    onChromeDownloadChanged,
    onChromeDeterminingFilename,
    dispose() {
      offscreenLifecycle.dispose();
      authoritativeFilenamesByUrl.clear();
      authoritativeFilenamesByDownloadId.clear();
      authoritativeUrlByDownloadId.clear();
      earlyDownloadDeltas.clear();
      observedDownloadFilenames.clear();
    },
  };
}
