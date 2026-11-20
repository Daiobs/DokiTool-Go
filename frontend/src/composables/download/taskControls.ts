import type { DownloadTask, ToastType } from "../../types/media";
import type { HlsSegment } from "../../utils/segmentDownload";
import type { useVideoStore } from "../../stores/video";
import {
  clearable,
  clearableUnknown,
  isToutiaovodVideoUrl,
  triggerBrowserDownload,
  type SourceContext,
  type StreamingLoader,
} from "./helpers";

export function createTaskControls(deps: {
  videoStore: ReturnType<typeof useVideoStore>;
  showToast: (message: string, type?: ToastType, duration?: number) => unknown;
  loadStreaming: StreamingLoader;
  taskFor: (id: number) => DownloadTask | undefined;
  pendingTaskActions: Set<number>;
  deliveryTasks: Map<string, number>;
  archiveRetries: Map<number, () => Promise<void>>;
  videoRetries: Map<number, (refresh?: boolean) => Promise<boolean>>;
  fileTaskSelections: Map<number, string>;
  sourceContexts: Map<number, SourceContext>;
  selectionInFlight: (key: string | undefined, exceptId?: number) => boolean;
  selectionBusyNotice: () => void;
  downloadFile: (
    url: string,
    filename: string,
    downloadId: number,
  ) => Promise<void>;
  downloadSegments: (
    segments: (HlsSegment | string)[],
    filename: string,
    downloadId: number,
  ) => Promise<void>;
}) {
  const {
    videoStore,
    showToast,
    loadStreaming,
    taskFor,
    pendingTaskActions,
    deliveryTasks,
    archiveRetries,
    videoRetries,
    fileTaskSelections,
    sourceContexts,
    selectionInFlight,
    selectionBusyNotice,
    downloadFile,
    downloadSegments,
  } = deps;

  const matchesSettledAttempt = (snapshot: DownloadTask) => {
    const current = taskFor(snapshot.id);
    return (
      current &&
      clearable(current) &&
      current.deliveryId === snapshot.deliveryId &&
      current.abortController === snapshot.abortController &&
      current.status === snapshot.status &&
      current.transport === snapshot.transport
    );
  };

  async function handleCancelDownload(id: number): Promise<void> {
    const task = taskFor(id);
    if (!task) return;
    const { deliveryId, abortController } = task;
    const currentAttempt = () => {
      const current = taskFor(id);
      return current &&
        current.deliveryId === deliveryId &&
        current.abortController === abortController &&
        (["queued", "preparing", "downloading"].includes(current.status) ||
          current.observation === "unknown")
        ? current
        : undefined;
    };
    if (!currentAttempt()) return;
    if (task.transport === "browser_streaming" && deliveryId) {
      videoStore.updateDownload(id, { statusText: "正在确认取消..." });
      try {
        const { cancelStreaming, hasStreamingTask } = await loadStreaming();
        const current = currentAttempt();
        if (!current) return;
        if (
          current.transport !== "browser_streaming" ||
          (current.abortController && !hasStreamingTask(deliveryId))
        ) {
          videoStore.cancelDownload(id);
          return;
        }
        await cancelStreaming(deliveryId);
      } catch (error) {
        if (currentAttempt())
          videoStore.updateDownload(id, {
            observation: "unknown",
            speed: 0,
            statusText: "无法确认取消结果",
            error:
              error instanceof Error ? error.message : "请检查浏览器下载列表",
          });
        return;
      }
    }
    if (currentAttempt()) videoStore.cancelDownload(id);
  }

  function handleRefreshDownload(id: number): Promise<void> {
    return handleRetryDownload(id, true);
  }

  async function handleRetryDownload(
    id: number,
    refresh = false,
  ): Promise<void> {
    const current = taskFor(id);
    if (
      !current ||
      current.observation ||
      pendingTaskActions.has(id) ||
      ["queued", "preparing", "downloading"].includes(current.status)
    )
      return;
    if (
      refresh &&
      (!current.refreshAvailable ||
        !videoRetries.has(id) ||
        !["failed", "interrupted"].includes(current.status))
    )
      return;
    if (selectionInFlight(fileTaskSelections.get(id), id)) {
      selectionBusyNotice();
      return;
    }
    const task = { ...current };
    pendingTaskActions.add(id);
    try {
      if (task.deliveryId && task.transport === "browser_streaming") {
        try {
          const { forgetStreaming } = await loadStreaming();
          if (!matchesSettledAttempt(task)) return;
          await forgetStreaming(task.deliveryId);
        } catch (error) {
          if (matchesSettledAttempt(task))
            showToast(
              error instanceof Error
                ? error.message
                : "原任务状态未知，请先检查浏览器下载列表",
              "warning",
            );
          return;
        }
      }
      if (!matchesSettledAttempt(task)) return;
      if (task.deliveryId) deliveryTasks.delete(task.deliveryId);
      const retryArchive = archiveRetries.get(id);
      if (!refresh && retryArchive) {
        await retryArchive();
        return;
      }
      const retryVideo = videoRetries.get(id);
      if (retryVideo) {
        await retryVideo(refresh);
        return;
      }
      if (refresh) return;
      const rawSegments = task.segments;
      if (Array.isArray(rawSegments) && rawSegments.length > 0) {
        const segments = rawSegments.map((s) =>
          typeof s === "string" ? s : (s as HlsSegment),
        );
        await downloadSegments(segments, task.filename, id);
        return;
      }
      if (task.url) await downloadFile(task.url, task.filename, id);
    } finally {
      pendingTaskActions.delete(id);
    }
  }

  async function handleQueryDownload(id: number): Promise<void> {
    const task = taskFor(id);
    if (
      !task?.deliveryId ||
      task.transport !== "browser_streaming" ||
      !task.recoveryExpired
    )
      return;
    const { queryStreaming } = await loadStreaming();
    if (taskFor(id)?.deliveryId !== task.deliveryId) return;
    await queryStreaming(task.deliveryId);
  }

  /** Called synchronously by a real user click. Browser-owned progress is unknowable here. */
  function handleBrowserDownload(id: number): void {
    if (pendingTaskActions.has(id)) return;
    const task = taskFor(id);
    if (
      !task?.nativeAvailable ||
      !task.url ||
      !/^(?:https?:\/\/|\/(?!\/))/i.test(task.url)
    )
      return;
    if (
      task.observation ||
      !["failed", "cancelled", "interrupted", "manual"].includes(task.status)
    )
      return;
    task.abortController?.abort();
    if (!triggerBrowserDownload(task.url, task.filename, true)) {
      videoStore.updateDownload(id, {
        status: "manual",
        statusText: "打开源链接",
        abortController: null,
        speed: 0,
        averageSpeed: 0,
        percent: 0,
        error: null,
        nativeAvailable: true,
      });
      showToast(
        "浏览器限制了新标签页打开，请允许弹窗后再次点击“打开源链接”",
        "warning",
        6000,
      );
      return;
    }
    if (isToutiaovodVideoUrl(task.url)) {
      videoStore.updateDownload(id, {
        status: "manual",
        statusText: "打开源链接",
        abortController: null,
        speed: 0,
        averageSpeed: 0,
        percent: 0,
        error: null,
        nativeAvailable: true,
      });
      showToast(
        "已在新标签页打开源视频，请右键选择「视频另存为」（手机端长按保存）",
        "info",
        6000,
      );
      return;
    }
    videoStore.updateDownload(id, {
      status: "handed-off",
      statusText: "已交给浏览器",
      abortController: null,
      speed: 0,
      averageSpeed: 0,
      percent: 0,
      error: null,
    });
    showToast(
      "请在打开的页面或浏览器下载列表查看进度；本站无法确认下载是否完成",
      "info",
      6000,
    );
  }

  async function handleClearCompleted(id: number | "all"): Promise<void> {
    const tasks = videoStore.downloads
      .filter(
        (task) =>
          clearable(task) &&
          !pendingTaskActions.has(task.id) &&
          (id === "all" || task.id === id),
      )
      .map((task) => ({ ...task }));
    tasks.forEach((task) => pendingTaskActions.add(task.id));
    try {
      for (const task of tasks) {
        if (!matchesSettledAttempt(task)) continue;
        if (task.deliveryId && task.transport === "browser_streaming") {
          try {
            const { forgetStreaming } = await loadStreaming();
            if (!matchesSettledAttempt(task)) continue;
            await forgetStreaming(task.deliveryId);
          } catch (error) {
            if (matchesSettledAttempt(task))
              showToast(
                error instanceof Error
                  ? error.message
                  : "原任务状态未知，暂不能清除",
                "warning",
              );
            continue;
          }
        }
        if (!matchesSettledAttempt(task)) continue;
        if (task.deliveryId) deliveryTasks.delete(task.deliveryId);
        archiveRetries.delete(task.id);
        videoRetries.delete(task.id);
        fileTaskSelections.delete(task.id);
        sourceContexts.delete(task.id);
        if (clearableUnknown(task))
          videoStore.updateDownload(task.id, { abortController: null });
        videoStore.removeDownload(task.id);
      }
    } finally {
      tasks.forEach((task) => pendingTaskActions.delete(task.id));
    }
  }

  return {
    handleCancelDownload,
    handleRetryDownload,
    handleRefreshDownload,
    handleQueryDownload,
    handleBrowserDownload,
    handleClearCompleted,
  };
}
