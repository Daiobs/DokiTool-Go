import type { DownloadSnapshot, SourceProbe } from "../downloads/types";
import {
  isSaveFilePickerSupported,
  promptSaveFileHandle,
  readWebSaveFilePickerPreference,
  streamRoutesToFileHandle,
} from "../downloads/saveFilePicker";
import type { DownloadTask, YouTubeHelperState } from "../types/media";
import {
  availableSources,
  readyItem,
  readyVariant,
  sourceRoutes,
  sourceUrl,
} from "../utils/mediaContract";
import {
  buildDirectFileRoutesWithTbvideo,
  filterWhitelistedExtensionRoutes,
  inspectDirectFileExtensionTraits,
  isTbvideoVideoItem,
  resolveProtectedExtensionAudioRoutes,
  resolveWhitelistedExtensionMuxSpec,
} from "../core/media";
import { resolveExecutionPlan } from "../core/capabilityHub";
import type {
  WebExtEnqueuePayload,
  WebExtTaskPhase,
} from "../extension/protocol";
import { reportTbvideo } from "../../public/downloads/tbvideo.js";
import { apiConfig } from "../services/apiConfig";
import {
  canAttemptDirectAttachment,
  checkAbort,
  comparableUrl,
  createSnapshotHelpers,
  createTransferMonitor,
  deliveryStatusText,
  filenameFor,
  formatYouTubeSavePathLabel,
  isCorsBlockedDirectCdn,
  isToutiaovodVideoUrl,
  MAX_ARCHIVE_BYTES,
  resolveFinalMediaExtension,
  triggerBrowserDownload,
  type ItemSnapshot,
  type SourceContext,
  type UseMediaDownloadOptions,
} from "./download/helpers";
import {
  createArchiveController,
  createPublicDownloadActions,
} from "./download/archive";
import { createYouTubeDownloadController } from "./download/youtubeMux";
import { createTaskControls } from "./download/taskControls";

export { MAX_ARCHIVE_BYTES };

const loadStreaming = () => import("../downloads/streaming");
const loadDownloadManager = () => import("../downloads/manager");
const loadExtensionBridge = () => import("../services/extensionBridge");

function hasExternalExtensionRuntime(): boolean {
  const g = globalThis as unknown as {
    chrome?: { runtime?: { sendMessage?: unknown } };
  };
  return typeof g.chrome?.runtime?.sendMessage === "function";
}

const EXTENSION_DIRECT_FALLBACK_CODES = new Set<string>([
  "NO_CHROME_RUNTIME",
  "BRIDGE_TIMEOUT",
  "EXTENSION_UNAVAILABLE",
  "EMPTY_RESPONSE",
  "BRIDGE_ERROR",
  "UNSUPPORTED_ACTION",
  "FORBIDDEN_ORIGIN",
]);

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    (timer as { unref?: () => void })?.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function extensionPhaseStatusText(phase: WebExtTaskPhase): string {
  switch (phase) {
    case "queued":
      return "扩展排队中...";
    case "downloading":
      return "扩展下载中...";
    case "muxing":
      return "扩展无损合流中...";
    case "saving":
      return "扩展写盘保存中...";
    case "completed":
      return "已通过扩展保存";
    case "cancelled":
      return "已取消";
    default:
      return "扩展下载失败";
  }
}

export function useMediaDownload({
  videoStore,
  showToast,
  selection,
  resolveItem,
}: UseMediaDownloadOptions) {
  const apiContext = { apiOrigin: apiConfig.baseUrl };
  const currentYouTubeHelper = (): YouTubeHelperState | undefined =>
    (videoStore.resultData?.extra as Record<string, unknown> | undefined)
      ?.youtube_helper as YouTubeHelperState | undefined;
  const effectiveSelectedUrl = () => selection.currentVideoUrl.value;
  const archiveRetries = new Map<number, () => Promise<void>>();
  const videoRetries = new Map<
    number,
    (refresh?: boolean) => Promise<boolean>
  >();
  const pendingTaskActions = new Set<number>();
  const fileTaskSelections = new Map<number, string>();
  const sourceContexts = new Map<number, SourceContext>();

  const taskFor = (id: number) =>
    videoStore.downloads.find((task) => task.id === id);
  const ownsTask = (id: number, controller: AbortController) =>
    taskFor(id)?.abortController === controller;
  const monitorTransfer = createTransferMonitor(videoStore, taskFor, ownsTask);

  let pageTaskSequence = 0;
  const deliveryTasks = new Map<string, number>();

  function applyDelivery(snapshot: DownloadSnapshot, restore = false): void {
    let id = deliveryTasks.get(snapshot.id);
    if (id === undefined && restore) {
      id = videoStore.addDownload({
        filename: snapshot.filename,
        url: snapshot.url,
      });
      deliveryTasks.set(snapshot.id, id);
    }
    if (id === undefined) return;
    const task = taskFor(id);
    if (
      !task ||
      (task.deliveryId !== undefined && task.deliveryId !== snapshot.id)
    )
      return;
    const url = snapshot.url || task.url || "";
    videoStore.updateDownload(id, {
      deliveryId: snapshot.id,
      transport: snapshot.transport,
      filename: snapshot.filename,
      url,
      status: snapshot.status,
      statusText: deliveryStatusText[snapshot.status],
      loaded: snapshot.loaded,
      total: snapshot.total,
      speed: snapshot.speed,
      elapsed: snapshot.elapsed,
      averageSpeed: snapshot.averageSpeed,
      transferElapsed: snapshot.transferElapsed,
      timing: snapshot.timing,
      observation: snapshot.observation,
      workerBuild: snapshot.workerBuild,
      workerInstance: snapshot.workerInstance,
      recoveryDeadline: snapshot.recoveryDeadline,
      recoveryExpired: snapshot.recoveryExpired,
      ownerGone: snapshot.ownerGone,
      transferred: snapshot.loaded,
      error: snapshot.error || null,
      progressKind: "bytes",
      percent:
        snapshot.status === "completed"
          ? 100
          : snapshot.total > 0
            ? Math.min(99, Math.round((snapshot.loaded / snapshot.total) * 100))
            : 0,
      nativeAvailable: Boolean(url) && true,
    });
  }

  /** Called on client mount only; the homepage and SSR never register a Worker. */
  async function restoreDownloads(): Promise<void> {
    try {
      if (!sessionStorage.getItem("dokitool-downloads-v1")) return;
      const { reconnectStreaming } = await loadStreaming();
      await reconnectStreaming((snapshot) => applyDelivery(snapshot, true));
    } catch {
      /* Restricted storage must not prevent the parser from starting. */
    }
  }

  function selectionInFlight(
    key: string | undefined,
    exceptId?: number,
  ): boolean {
    if (!key) return false;
    for (const [id, selected] of fileTaskSelections) {
      const task = taskFor(id);
      if (!task) {
        fileTaskSelections.delete(id);
        continue;
      }
      if (
        id !== exceptId &&
        selected === key &&
        (pendingTaskActions.has(id) ||
          task.observation === "unknown" ||
          ["queued", "preparing", "downloading"].includes(task.status))
      )
        return true;
    }
    return false;
  }

  function selectionBusyNotice(): void {
    showToast("该版本和来源已有任务正在处理，请在下载列表查看进度", "info");
  }

  const {
    snapshotItem,
    refreshable,
    fileSelectionKey,
    snapshotTarget,
    preparedSnapshot,
    resolvedTarget,
  } = createSnapshotHelpers({
    videoStore,
    selection,
    resolveItem,
    apiContext,
  });

  const { archiveItems, downloadSegments } = createArchiveController({
    videoStore,
    showToast,
    apiContext,
    archiveRetries,
    ownsTask,
    monitorTransfer,
    snapshotTarget,
    preparedSnapshot,
    resolvedTarget,
  });

  const ytController = createYouTubeDownloadController({
    videoStore,
    showToast,
    apiContext,
    currentYouTubeHelper,
    taskFor,
    ownsTask,
    sourceContexts,
    videoRetries,
    fileTaskSelections,
    deliveryTasks,
    nextMuxDeliveryId: () =>
      globalThis.crypto?.randomUUID?.() ??
      `yt-mux-${Date.now()}-${++pageTaskSequence}`,
    snapshotTarget,
    fileSelectionKey,
    selectionInFlight,
    selectionBusyNotice,
    downloadFile,
    runExtensionBridgeDownload,
  });

  async function downloadFile(
    url: string,
    filename: string,
    downloadId: number,
    controller = new AbortController(),
    startedAt = Date.now(),
    probe?: SourceProbe,
  ): Promise<void> {
    if (!url) return;
    const matchingTasks = () =>
      videoStore.downloads.filter(
        (task) =>
          task.id !== downloadId &&
          [task.url, sourceContexts.get(task.id)?.selectedUrl].some(
            (source) => source && comparableUrl(source) === comparableUrl(url),
          ),
      );
    const active = (status: string) =>
      ["queued", "preparing", "downloading"].includes(status);
    const isCorsBlockedManualTask = (task: DownloadTask) =>
      task.status === "manual" &&
      typeof task.url === "string" &&
      task.url.length > 0 &&
      isCorsBlockedDirectCdn(task.url);
    let duplicate = matchingTasks().some(
      (task) =>
        (active(task.status) && !task.ownerGone) ||
        isCorsBlockedManualTask(task),
    );
    if (
      !duplicate &&
      matchingTasks().some(
        (task) => task.status === "interrupted" && task.deliveryId,
      )
    ) {
      try {
        const { hasStreamingTask } = await loadStreaming();
        duplicate = matchingTasks().some(
          (task) =>
            (active(task.status) && !task.ownerGone) ||
            isCorsBlockedManualTask(task) ||
            (task.status === "interrupted" &&
              task.deliveryId &&
              hasStreamingTask(task.deliveryId)),
        );
      } catch {
        duplicate = true;
      }
    }
    if (duplicate) {
      videoStore.removeDownload(downloadId);
      archiveRetries.delete(downloadId);
      videoRetries.delete(downloadId);
      fileTaskSelections.delete(downloadId);
      sourceContexts.delete(downloadId);
      showToast("该资源已有下载任务", "info");
      return;
    }
    const deliveryId =
      globalThis.crypto?.randomUUID?.() ??
      `page-${Date.now()}-${++pageTaskSequence}`;
    deliveryTasks.set(deliveryId, downloadId);
    if (isCorsBlockedDirectCdn(url)) {
      if (controller.signal.aborted) {
        videoStore.updateDownload(downloadId, {
          deliveryId,
          status: "cancelled",
          statusText: "已取消",
          abortController: null,
          error: "用户取消下载",
          nativeAvailable: true,
        });
        return;
      }
      const ytHelper = currentYouTubeHelper();
      if (ytHelper && ytHelper.status !== "ready") {
        videoStore.removeDownload(downloadId);
        showToast(
          ytHelper.message || "请先安装并启用 YouTube 下载助手脚本后再下载",
          "warning",
          5000,
        );
        return;
      }
      if (ytHelper?.status === "ready" && ytHelper.provider === "extension") {
        const ctx = sourceContexts.get(downloadId);
        const matchedSource = (ctx?.sources ?? []).find(
          (s) =>
            comparableUrl(sourceUrl(s, apiContext)) === comparableUrl(url),
        );
        const knownSize = matchedSource?.size_bytes || 0;
        const formatMime = ctx?.formatMime;
        const selectionKey =
          fileTaskSelections.get(downloadId) ||
          JSON.stringify([
            videoStore.resultVersion,
            comparableUrl(url),
            "ext-yt-direct",
          ]);
        let fellBackToBrowser = false;
        await runExtensionBridgeDownload({
          retryId: downloadId,
          controller,
          filename,
          payload: {
            kind: "youtube_direct",
            platform: videoStore.resultData?.platform || "media",
            title: videoStore.resultData?.title || filename,
            filename,
            url,
            ...(knownSize ? { sizeBytes: knownSize } : {}),
            ...(formatMime ? { mimeType: formatMime } : {}),
          },
          savePathLabel: "保存路径：Chrome 扩展后台下载",
          startStatusText: "扩展后台保存中...",
          selectionKey,
          onBridgeUnavailable: () => {
            fellBackToBrowser = true;
            return false;
          },
        });
        if (!fellBackToBrowser) {
          deliveryTasks.delete(deliveryId);
          return;
        }
        if (!ownsTask(downloadId, controller)) return;
        videoStore.updateDownload(downloadId, {
          savePath: undefined,
          savePathLabel: undefined,
        });
      }
      if (canAttemptDirectAttachment(url)) {
        if (triggerBrowserDownload(url, filename, true)) {
          videoStore.updateDownload(downloadId, {
            deliveryId,
            transport: "browser_native",
            status: "handed-off",
            statusText: "已交给浏览器",
            savePath: "browser_native",
            savePathLabel: formatYouTubeSavePathLabel("browser_native"),
            abortController: null,
            percent: 0,
            loaded: 0,
            total: 0,
            speed: 0,
            elapsed: 0,
            averageSpeed: 0,
            transferred: 0,
            error: null,
            progressKind: "bytes",
            nativeAvailable: true,
            observation: undefined,
            transferElapsed: undefined,
            timing: undefined,
            workerBuild: undefined,
          });
          showToast(
            "已在新标签页尝试浏览器附件下载，请在浏览器下载列表或打开的标签页查看",
            "info",
            6000,
          );
          return;
        }
        videoStore.updateDownload(downloadId, {
          deliveryId,
          transport: undefined,
          status: "manual",
          statusText: "打开源链接",
          abortController: null,
          percent: 0,
          loaded: 0,
          total: 0,
          speed: 0,
          elapsed: 0,
          averageSpeed: 0,
          transferred: 0,
          error: null,
          progressKind: "bytes",
          nativeAvailable: true,
          observation: undefined,
          transferElapsed: undefined,
          timing: undefined,
          workerBuild: undefined,
        });
        showToast(
          "浏览器限制了新标签页打开，请点击下载卡片中的“打开源链接”继续",
          "info",
          6000,
        );
        return;
      }
      if (ytHelper?.status === "ready" && ytHelper.provider !== "extension") {
        await ytController.runYouTubeDirectHelperDownload({
          url,
          filename,
          downloadId,
          deliveryId,
          controller,
          startedAt,
        });
        return;
      }
      if (!ytHelper && hasExternalExtensionRuntime()) {
        const ctx = sourceContexts.get(downloadId);
        const whitelistedRoutes = filterWhitelistedExtensionRoutes(
          [url, ...(ctx?.routes ?? [])],
          apiContext,
        );
        if (whitelistedRoutes.length > 0) {
          const bridge = await loadExtensionBridge();
          if (controller.signal.aborted || !ownsTask(downloadId, controller)) {
            return;
          }
          const extState = await bridge.pingInstalledExtension();
          if (controller.signal.aborted || !ownsTask(downloadId, controller)) {
            return;
          }
          const plan = resolveExecutionPlan(
            {
              deliveryKind: "file",
              whitelistedForExtension: true,
              corsBlockedDirect: true,
            },
            {
              extensionConnected: extState.connected,
              extensionVersion: extState.version,
              extensionCapabilities: extState.capabilities,
              userscriptReady: false,
            },
          );
          if (plan.channel === "extension_direct") {
            const matchedSource = (ctx?.sources ?? []).find(
              (s) =>
                comparableUrl(sourceUrl(s, apiContext)) ===
                comparableUrl(whitelistedRoutes[0]),
            );
            const knownSize = matchedSource?.size_bytes || 0;
            const formatMime = ctx?.formatMime;
            const selectionKey =
              fileTaskSelections.get(downloadId) ||
              JSON.stringify([
                videoStore.resultVersion,
                comparableUrl(whitelistedRoutes[0]),
                "ext-cors-direct",
              ]);
            let fellBackToManual = false;
            await runExtensionBridgeDownload({
              retryId: downloadId,
              controller,
              filename,
              payload: {
                kind: "direct_download",
                platform: videoStore.resultData?.platform || "media",
                title: videoStore.resultData?.title || filename,
                filename,
                routes: whitelistedRoutes,
                ...(knownSize ? { sizeBytes: knownSize } : {}),
                ...(formatMime ? { mimeType: formatMime } : {}),
              },
              savePathLabel: "保存路径：Chrome 扩展后台下载",
              startStatusText: "扩展后台保存中...",
              selectionKey,
              onBridgeUnavailable: () => {
                fellBackToManual = true;
                return false;
              },
            });
            if (!fellBackToManual) {
              deliveryTasks.delete(deliveryId);
              return;
            }
            if (!ownsTask(downloadId, controller)) return;
            videoStore.updateDownload(downloadId, {
              savePath: undefined,
              savePathLabel: undefined,
            });
          }
        }
      }
      const isToutiaoManual = isToutiaovodVideoUrl(url);
      const openedToutiaoTab = isToutiaoManual
        ? triggerBrowserDownload(url, filename, true)
        : false;
      const nonToutiaoManualHint =
        "该源站受浏览器跨域（CORS）或附件下载头限制，请点击下载卡片中的「打开源链接」并在新标签页右键选择「视频另存为」（手机端长按保存），或安装 Chrome 扩展一键下载";
      videoStore.updateDownload(downloadId, {
        deliveryId,
        transport: undefined,
        status: "manual",
        statusText: "打开源链接",
        abortController: null,
        percent: 0,
        loaded: 0,
        total: 0,
        speed: 0,
        elapsed: 0,
        averageSpeed: 0,
        transferred: 0,
        error: null,
        fallbackReason: isToutiaoManual ? null : nonToutiaoManualHint,
        progressKind: "bytes",
        nativeAvailable: true,
        observation: undefined,
        transferElapsed: undefined,
        timing: undefined,
        workerBuild: undefined,
      });
      showToast(
        isToutiaoManual
          ? openedToutiaoTab
            ? "因头条 CDN 限制跨域直下，已切换为打开源链接，请在新标签页右键选择「视频另存为」（手机端长按保存）"
            : "因头条 CDN 限制跨域直下，已切换为打开源链接；请点击下载卡片中的「打开源链接」，在新标签页右键选择「视频另存为」（手机端长按保存）"
          : nonToutiaoManualHint,
        "info",
        6000,
      );
      return;
    }
    const savePickerCtx = sourceContexts.get(downloadId);
    if (
      !savePickerCtx?.tbvideo &&
      !isCorsBlockedDirectCdn(url) &&
      readWebSaveFilePickerPreference() &&
      isSaveFilePickerSupported()
    ) {
      const promptRes = await promptSaveFileHandle(
        filename,
        savePickerCtx?.formatMime,
      );
      if (!ownsTask(downloadId, controller)) return;
      if (promptRes.status === "cancelled") {
        deliveryTasks.delete(deliveryId);
        videoStore.updateDownload(downloadId, {
          status: "cancelled",
          statusText: "已取消",
          error: null,
          speed: 0,
          abortController: null,
        });
        return;
      }
      if (promptRes.status === "granted") {
        const directRoutes = Array.from(
          new Set([url, ...(savePickerCtx?.routes ?? [])]),
        ).slice(0, 3);
        const startedAt = Date.now();
        videoStore.updateDownload(downloadId, {
          filename: promptRes.suggestedName,
          status: "downloading",
          statusText: "系统另存为直写中...",
          savePath: "save_picker",
          savePathLabel: "保存路径：系统另存为流式直写",
          progressKind: "bytes",
          percent: 0,
          loaded: 0,
          total: savePickerCtx?.sources?.[0]?.size_bytes ?? 0,
        });
        try {
          const result = await streamRoutesToFileHandle({
            handle: promptRes.handle,
            routes: directRoutes,
            signal: controller.signal,
            onProgress: ({ loaded, total, percent }) => {
              if (!ownsTask(downloadId, controller)) return;
              const elapsed = Math.max(0.05, (Date.now() - startedAt) / 1000);
              videoStore.updateDownload(downloadId, {
                status: "downloading",
                statusText: "系统另存为直写中...",
                loaded,
                total,
                transferred: loaded,
                percent,
                elapsed,
                speed: loaded / elapsed,
                averageSpeed: loaded / elapsed,
              });
            },
          });
          if (!ownsTask(downloadId, controller)) return;
          const elapsed = Math.max(0.05, (Date.now() - startedAt) / 1000);
          deliveryTasks.delete(deliveryId);
          videoStore.updateDownload(downloadId, {
            filename: promptRes.suggestedName,
            status: "completed",
            statusText: "已通过系统另存为直写保存",
            percent: 100,
            loaded: result.loaded,
            total: result.total,
            transferred: result.loaded,
            speed: 0,
            elapsed,
            averageSpeed: result.loaded / elapsed,
            abortController: null,
          });
          showToast(`已直写保存：${promptRes.suggestedName}`);
          return;
        } catch (err) {
          if (!ownsTask(downloadId, controller)) return;
          if (
            controller.signal.aborted ||
            (err instanceof Error && err.name === "AbortError")
          ) {
            deliveryTasks.delete(deliveryId);
            videoStore.updateDownload(downloadId, {
              status: "cancelled",
              statusText: "已取消",
              error: null,
              speed: 0,
              abortController: null,
            });
            return;
          }
          // Fall back cleanly to standard SW/Blob download if direct fetch is CORS-blocked.
          videoStore.updateDownload(downloadId, {
            savePath: undefined,
            savePathLabel: undefined,
          });
        }
      }
    }
    videoStore.updateDownload(downloadId, {
      deliveryId,
      abortController: controller,
      status: "queued",
      statusText: "排队中...",
      percent: 0,
      loaded: 0,
      total: 0,
      speed: 0,
      elapsed: 0,
      averageSpeed: 0,
      transferred: 0,
      error: null,
      progressKind: "bytes",
      nativeAvailable: true,
      observation: undefined,
      transferElapsed: undefined,
      timing: undefined,
      workerBuild: undefined,
    });
    const context = sourceContexts.get(downloadId);
    const routes = Array.from(new Set([url, ...(context?.routes ?? [])])).slice(
      0,
      3,
    );
    const sourceSizes: Record<string, number> = {};
    for (const source of context?.sources ?? []) {
      if (!source.size_bytes) continue;
      const address = sourceUrl(source, apiContext);
      if (!routes.includes(address)) continue;
      const key = comparableUrl(address);
      const previous = sourceSizes[key];
      sourceSizes[key] =
        previous === undefined || previous === source.size_bytes
          ? source.size_bytes
          : 0;
    }
    let cancellationReason: string | undefined;
    try {
      const { downloadManager } = await loadDownloadManager();
      checkAbort(controller.signal);
      const metadata = context?.tbvideo?.item;
      const tbvideoEvent = metadata && {
        platform: metadata.platform,
        pid: metadata.pid,
        vid: metadata.vid,
      };
      let delegatedToExtension = false;
      const result = await downloadManager.run(
        context?.tbvideo
          ? {
              id: deliveryId,
              url: context.tbvideo.candidate,
              routes: [],
              filename,
              startedAt,
              formatMime: context.formatMime,
              tbvideo: true,
              tbvideoEvent,
            }
          : {
              id: deliveryId,
              url,
              filename,
              routes,
              sourceSizes,
              startedAt,
              probe,
              formatMime: context?.formatMime,
            },
        controller.signal,
        (snapshot) => {
          if (
            taskFor(downloadId)?.deliveryId === deliveryId &&
            taskFor(downloadId)?.status !== "handed-off"
          ) {
            cancellationReason =
              snapshot.status === "cancelled" && !snapshot.observation
                ? snapshot.error
                : undefined;
            applyDelivery(context?.tbvideo ? { ...snapshot, url } : snapshot);
          }
        },
        {
          async onStreamingUnavailable() {
            if (!hasExternalExtensionRuntime()) return false;
            const fallbackCandidates = context?.tbvideo?.candidate
              ? [...routes, context.tbvideo.candidate]
              : routes;
            const whitelistedRoutes = filterWhitelistedExtensionRoutes(
              fallbackCandidates,
              apiContext,
            );
            if (whitelistedRoutes.length === 0) return false;
            const bridge = await loadExtensionBridge();
            checkAbort(controller.signal);
            if (!ownsTask(downloadId, controller)) return false;
            const extState = await bridge.pingInstalledExtension();
            checkAbort(controller.signal);
            if (!ownsTask(downloadId, controller)) return false;
            const plan = resolveExecutionPlan(
              {
                deliveryKind: "file",
                whitelistedForExtension: true,
                hasTbvideo: Boolean(context?.tbvideo),
              },
              {
                extensionConnected: extState.connected,
                extensionVersion: extState.version,
                extensionCapabilities: extState.capabilities,
                userscriptReady: false,
                swMultiRangeAvailable: false,
              },
            );
            if (plan.channel !== "extension_direct") return false;
            const matchedSource = (context?.sources ?? []).find(
              (s) =>
                comparableUrl(sourceUrl(s, apiContext)) ===
                comparableUrl(whitelistedRoutes[0]),
            );
            const knownSize = matchedSource?.size_bytes || 0;
            const selectionKey =
              fileTaskSelections.get(downloadId) ||
              JSON.stringify([
                videoStore.resultVersion,
                comparableUrl(whitelistedRoutes[0]),
                "ext-sw-fallback",
              ]);
            let bridgeUnavailable = false;
            deliveryTasks.delete(deliveryId);
            await runExtensionBridgeDownload({
              retryId: downloadId,
              controller,
              filename,
              payload: {
                kind: "direct_download",
                platform: videoStore.resultData?.platform || "media",
                title: videoStore.resultData?.title || filename,
                filename,
                routes: whitelistedRoutes,
                ...(knownSize ? { sizeBytes: knownSize } : {}),
                ...(context?.formatMime ? { mimeType: context.formatMime } : {}),
              },
              savePathLabel: "保存路径：Chrome 扩展后台下载",
              startStatusText: "流式通道不可用，已切至扩展后台下载...",
              selectionKey,
              onBridgeUnavailable: () => {
                bridgeUnavailable = true;
                return false;
              },
            });
            if (bridgeUnavailable) {
              deliveryTasks.set(deliveryId, downloadId);
              if (ownsTask(downloadId, controller)) {
                videoStore.updateDownload(downloadId, {
                  savePath: undefined,
                  savePathLabel: undefined,
                });
              }
              return false;
            }
            delegatedToExtension = true;
            return true;
          },
        },
      );
      if (delegatedToExtension) return;
      if (!ownsTask(downloadId, controller)) return;
      if (context?.tbvideo) {
        if (result.status === "manual" && result.tbvideoAttempted === undefined)
          void reportTbvideo(tbvideoEvent, result);
        return;
      }
      if (
        result.status === "completed" &&
        comparableUrl(result.url) !== comparableUrl(url) &&
        context &&
        videoStore.resultVersion === context.resultVersion &&
        effectiveSelectedUrl() === context.selectedUrl &&
        JSON.stringify(selection.currentSelection.value) ===
          context.selectionKey
      ) {
        const source = context.sources?.find(
          (candidate) =>
            comparableUrl(sourceUrl(candidate, apiContext)) ===
            comparableUrl(result.url),
        );
        if (
          source &&
          context.itemId &&
          context.variantId &&
          selection.currentVideo.value?.id === context.itemId
        )
          selection.choose(
            {
              variant_id: context.variantId,
              ...(source.id ? { source_id: source.id } : {}),
            },
            context.itemId,
          );
        showToast("下载已切换到同画质可用线路，播放器与复制链接已同步", "info");
      }
    } catch (error) {
      if (!ownsTask(downloadId, controller)) return;
      if (
        error instanceof Error &&
        error.name === "StreamingStateUnknownError"
      ) {
        videoStore.updateDownload(downloadId, {
          observation: "unknown",
          speed: 0,
          statusText: "下载状态待确认",
          error: error.message,
        });
        return;
      }
      const cancelled =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      videoStore.updateDownload(downloadId, {
        status: cancelled ? "cancelled" : "failed",
        statusText: cancelled ? "已取消" : "下载失败",
        speed: 0,
        error: cancelled
          ? (cancellationReason ?? null)
          : error instanceof Error
            ? error.message
            : "下载失败",
      });
    } finally {
      if (ownsTask(downloadId, controller))
        videoStore.updateDownload(downloadId, { abortController: null });
    }
  }

  function runExtensionBridgeDownload(params: {
    snapshot?: ItemSnapshot;
    retryId?: number;
    controller?: AbortController;
    filename: string;
    payload: WebExtEnqueuePayload;
    savePathLabel: string;
    startStatusText: string;
    selectionKey: string;
    onBridgeUnavailable?: () => Promise<boolean> | boolean;
  }): Promise<boolean> {
    const {
      snapshot,
      retryId,
      filename,
      payload,
      savePathLabel,
      startStatusText,
      selectionKey,
    } = params;

    if (selectionInFlight(selectionKey, retryId)) {
      selectionBusyNotice();
      return Promise.resolve(false);
    }

    const id =
      retryId ??
      videoStore.addDownload({
        filename,
        statusText: "正在连接 Chrome 扩展...",
      });
    fileTaskSelections.set(id, selectionKey);
    const controller = params.controller ?? new AbortController();
    const startedAt = Date.now();
    videoStore.updateDownload(id, {
      filename,
      ...(payload.kind === "youtube_direct" ? { url: payload.url } : {}),
      abortController: controller,
      status: "preparing",
      statusText: "正在连接 Chrome 扩展...",
      savePath: "extension",
      savePathLabel,
      error: null,
      nativeAvailable: false,
      refreshAvailable: snapshot
        ? refreshable(snapshot)
        : Boolean(taskFor(id)?.refreshAvailable),
      filenameWarning: null,
      loaded: 0,
      total: payload.sizeBytes ?? 0,
      transferred: 0,
      progressKind: "bytes",
      elapsed: 0,
      speed: 0,
      averageSpeed: 0,
      percent: 0,
      observation: undefined,
      deliveryId: undefined,
      transport: undefined,
    });
    if (snapshot) {
      videoRetries.set(id, (forceRefresh = false) =>
        enqueueItem(snapshot, id, forceRefresh),
      );
    } else if (!videoRetries.has(id)) {
      videoRetries.set(id, async () => {
        const currentTask = taskFor(id);
        if (currentTask?.url) {
          await downloadFile(
            currentTask.url,
            currentTask.filename || filename,
            id,
            new AbortController(),
            Date.now(),
          );
          return true;
        }
        return false;
      });
    }

    return (async () => {
      let extTaskId: string | null = null;
      let cancelListener: (() => void) | null = null;
      try {
        const bridge = await loadExtensionBridge();
        checkAbort(controller.signal);
        if (!ownsTask(id, controller)) return false;

        const enq = await bridge.enqueueMediaViaExtension(payload);
        if (!enq.ok) {
          checkAbort(controller.signal);
          if (!ownsTask(id, controller)) return false;
          if (
            params.onBridgeUnavailable &&
            enq.code &&
            EXTENSION_DIRECT_FALLBACK_CODES.has(enq.code)
          ) {
            return await params.onBridgeUnavailable();
          }
          const errMsg = enq.error || "连接 Chrome 扩展失败，请确认扩展已启用";
          videoStore.updateDownload(id, {
            status: "failed",
            statusText: "扩展下载失败",
            error: errMsg,
            speed: 0,
            abortController: null,
          });
          showToast(errMsg, "error", 5000);
          return false;
        }

        extTaskId = enq.data.taskId;
        if (controller.signal.aborted || !ownsTask(id, controller)) {
          void bridge.cancelExtensionTask(extTaskId).catch(() => {});
          checkAbort(controller.signal);
          return false;
        }
        cancelListener = () => {
          if (extTaskId) {
            void bridge.cancelExtensionTask(extTaskId).catch(() => {});
          }
        };
        controller.signal.addEventListener("abort", cancelListener, {
          once: true,
        });

        videoStore.updateDownload(id, {
          status: "downloading",
          statusText: startStatusText,
          percent: 0,
        });

        let consecutiveErrors = 0;
        let pollAttempt = 0;
        while (!controller.signal.aborted && ownsTask(id, controller)) {
          await abortableDelay(pollAttempt === 0 ? 40 : 300, controller.signal);
          pollAttempt++;
          if (!ownsTask(id, controller)) return false;

          const statusResp = await bridge.getExtensionTaskStatus(extTaskId);
          if (!ownsTask(id, controller)) return false;
          checkAbort(controller.signal);

          if (!statusResp.ok) {
            consecutiveErrors++;
            if (consecutiveErrors >= 5) {
              const errMsg =
                statusResp.error || "与 Chrome 扩展通信中断，请检查扩展下载队列";
              videoStore.updateDownload(id, {
                status: "failed",
                statusText: "扩展下载失败",
                error: errMsg,
                speed: 0,
                abortController: null,
              });
              showToast(errMsg, "error", 5000);
              return false;
            }
            continue;
          }

          consecutiveErrors = 0;
          const st = statusResp.data;
          const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
          const displayName = st.filename || filename;

          if (st.status === "completed") {
            videoStore.updateDownload(id, {
              filename: displayName,
              status: "completed",
              statusText: "已通过扩展保存",
              ...(st.filenameWarning ? { filenameWarning: st.filenameWarning } : {}),
              percent: 100,
              loaded: st.loadedBytes || st.totalBytes,
              total: st.totalBytes || st.loadedBytes,
              transferred: st.loadedBytes || st.totalBytes,
              speed: 0,
              elapsed,
              averageSpeed:
                (st.loadedBytes || st.totalBytes) > 0
                  ? (st.loadedBytes || st.totalBytes) / elapsed
                  : 0,
              abortController: null,
            });
            showToast(`已通过 Chrome 扩展保存：${displayName}`);
            return true;
          }

          if (st.status === "failed") {
            const errMsg = st.error || "Chrome 扩展下载失败";
            videoStore.updateDownload(id, {
              filename: displayName,
              status: "failed",
              statusText: "扩展下载失败",
              error: errMsg,
              speed: 0,
              elapsed,
              abortController: null,
            });
            showToast(errMsg, "error", 5000);
            return false;
          }

          if (st.status === "cancelled") {
            videoStore.updateDownload(id, {
              filename: displayName,
              status: "cancelled",
              statusText: "已取消",
              error: null,
              speed: 0,
              elapsed,
              abortController: null,
            });
            return false;
          }

          videoStore.updateDownload(id, {
            filename: displayName,
            status: st.phase === "queued" ? "queued" : "downloading",
            statusText: st.statusText || extensionPhaseStatusText(st.phase),
            percent: Math.max(0, Math.min(99, Math.round(st.progress || 0))),
            loaded: st.loadedBytes || 0,
            total: st.totalBytes || payload.sizeBytes || 0,
            transferred: st.loadedBytes || 0,
            speed: st.speedBytesPerSec || 0,
            elapsed,
            averageSpeed:
              st.loadedBytes > 0 ? st.loadedBytes / elapsed : 0,
          });
        }
        return false;
      } catch (error) {
        if (!ownsTask(id, controller)) return false;
        const cancelled =
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError");
        videoStore.updateDownload(id, {
          status: cancelled ? "cancelled" : "failed",
          statusText: cancelled ? "已取消" : "扩展下载失败",
          error: cancelled
            ? null
            : error instanceof Error
              ? error.message
              : "扩展下载失败",
          speed: 0,
          abortController: null,
        });
        if (!cancelled && error instanceof Error && error.message) {
          showToast(error.message, "error", 5000);
        }
        return false;
      } finally {
        if (cancelListener) {
          controller.signal.removeEventListener("abort", cancelListener);
          cancelListener = null;
        }
      }
    })();
  }

  function tryHandleExtensionBridgeEnqueue(
    snapshot: ItemSnapshot,
    retryId?: number,
  ): Promise<boolean> | null {
    if (!readyItem(snapshot.item)) return null;
    const variantId =
      snapshot.choice?.variant_id || snapshot.item.default?.variant_id;
    const variant = variantId
      ? snapshot.item.variants.find((candidate) => candidate.id === variantId)
      : undefined;
    if (!readyVariant(variant)) return null;

    if (variant.delivery.kind === "mux") {
      const dashMux = resolveWhitelistedExtensionMuxSpec(variant, apiContext);
      if (!dashMux) return null;
      const filename = filenameFor(snapshot, dashMux.outputContainer, variant);
      const exactTotal =
        (dashMux.videoSize || 0) + (dashMux.audioSize || 0);
      return runExtensionBridgeDownload({
        snapshot,
        retryId,
        filename,
        payload: {
          kind: "dash_mux",
          platform: snapshot.platform || "media",
          title: snapshot.title || snapshot.item.title || filename,
          filename,
          dashMux: {
            videoRoutes: dashMux.videoRoutes,
            audioRoutes: dashMux.audioRoutes,
            ...(dashMux.videoSize ? { videoSize: dashMux.videoSize } : {}),
            ...(dashMux.audioSize ? { audioSize: dashMux.audioSize } : {}),
            outputContainer: "mp4",
          },
          ...(exactTotal > 0 ? { sizeBytes: exactTotal } : {}),
          mimeType: "video/mp4",
        },
        savePathLabel: "保存路径：Chrome 扩展后台无损合流",
        startStatusText: "扩展已接管，正在无损合流...",
        selectionKey: JSON.stringify([
          snapshot.version,
          snapshot.item.id,
          variant.id,
          "ext-dash-mux",
        ]),
      });
    }

    if (
      snapshot.isAttachment &&
      snapshot.item.type === "audio" &&
      variant.delivery.kind === "file"
    ) {
      const routes = resolveProtectedExtensionAudioRoutes(
        { delivery: variant.delivery },
        apiContext,
      );
      if (routes && routes.length > 0) {
        const audioBaseSnapshot: ItemSnapshot = {
          ...snapshot,
          isAttachment: false,
        };
        const filename = filenameFor(audioBaseSnapshot, "m4a", variant);
        const primaryRoute = routes[0];
        const matchedSource = availableSources(
          variant.delivery.sources,
        ).find((src) => sourceRoutes(src, apiContext).includes(primaryRoute));
        const sizeBytes =
          matchedSource?.size_bytes ?? variant.delivery.sources[0]?.size_bytes;
        return runExtensionBridgeDownload({
          snapshot,
          retryId,
          filename,
          payload: {
            kind: "direct_download",
            platform: snapshot.platform || "media",
            title: snapshot.title || snapshot.item.title || filename,
            filename,
            routes,
            ...(sizeBytes ? { sizeBytes } : {}),
            mimeType: "audio/mp4",
          },
          savePathLabel: "保存路径：Chrome 扩展后台下载",
          startStatusText: "扩展后台保存原声中...",
          selectionKey: JSON.stringify([
            snapshot.version,
            snapshot.item.id,
            variant.id,
            "ext-direct-audio",
          ]),
        });
      }
    }

    return null;
  }

  function enqueueItem(
    snapshot: ItemSnapshot,
    retryId?: number,
    refresh = false,
    options?: { separateOnly?: boolean },
  ): Promise<boolean> {
    const ytSplitTask = ytController.tryHandleYouTubeSplitEnqueue({
      snapshot,
      retryId,
      refresh,
      separateOnly: options?.separateOnly,
      enqueueItem,
    });
    if (ytSplitTask !== null) return ytSplitTask;

    const extBridgeTask = tryHandleExtensionBridgeEnqueue(snapshot, retryId);
    if (extBridgeTask !== null) return extBridgeTask;

    const selected = fileSelectionKey(snapshot);
    if (selectionInFlight(selected, retryId)) {
      selectionBusyNotice();
      return Promise.resolve(false);
    }
    const placeholderExt =
      snapshot.item.type === "image"
        ? "jpg"
        : snapshot.item.type === "audio"
          ? "m4a"
          : "mp4";
    const id =
      retryId ??
      videoStore.addDownload({
        filename: filenameFor(snapshot, placeholderExt),
        statusText: "准备下载...",
      });
    if (selected) fileTaskSelections.set(id, selected);
    const controller = new AbortController();
    const startedAt = Date.now();
    videoStore.updateDownload(id, {
      abortController: controller,
      status: "preparing",
      statusText: "准备下载...",
      error: null,
      nativeAvailable: false,
      loaded: 0,
      total: 0,
      transferred: 0,
      progressKind: undefined,
      elapsed: 0,
      speed: 0,
      averageSpeed: 0,
      percent: 0,
    });
    videoStore.updateDownload(id, { refreshAvailable: refreshable(snapshot) });
    if (refresh) {
      sourceContexts.delete(id);
      videoStore.updateDownload(id, {
        url: undefined,
        deliveryId: undefined,
        transport: undefined,
      });
    }
    videoRetries.set(id, (forceRefresh = false) =>
      enqueueItem(snapshot, id, forceRefresh),
    );
    return (async () => {
      try {
        let { item, target } = await resolvedTarget(
          snapshot,
          controller.signal,
          refresh,
          (sec) =>
            ownsTask(id, controller) &&
            videoStore.updateDownload(id, {
              statusText: `请求受限，等待 ${sec} 秒后重试...`,
            }),
        );
        if (!ownsTask(id, controller)) return false;
        const delivery = target.variant.delivery;
        if (
          target.kind === "file" &&
          delivery.kind === "file" &&
          !snapshot.hasClientHelper &&
          hasExternalExtensionRuntime()
        ) {
          const allDeliveryRoutes = [
            target.url,
            ...target.routes,
            ...availableSources(delivery.sources).flatMap((src) =>
              sourceRoutes(src, apiContext),
            ),
          ];
          const candidateRoutes = buildDirectFileRoutesWithTbvideo(
            allDeliveryRoutes,
            item,
            target.source.id,
          );
          const traits = inspectDirectFileExtensionTraits({
            routes: candidateRoutes,
            item,
            source: target.source,
            context: apiContext,
          });
          if (traits.wantsProactiveExtensionDirect) {
            const bridge = await loadExtensionBridge();
            checkAbort(controller.signal);
            if (!ownsTask(id, controller)) return false;
            const extState = await bridge.pingInstalledExtension();
            checkAbort(controller.signal);
            if (!ownsTask(id, controller)) return false;
            const plan = resolveExecutionPlan(
              {
                deliveryKind: "file",
                whitelistedForExtension: traits.whitelistedForExtension,
                preferExtensionDirectAcceleration:
                  traits.preferExtensionDirectAcceleration,
                corsBlockedDirect: traits.corsBlockedDirect,
                hasTbvideo: traits.hasTbvideo,
                requiresRefererOrBlockedFetch:
                  traits.requiresRefererOrBlockedFetch,
              },
              {
                extensionConnected: extState.connected,
                extensionVersion: extState.version,
                extensionCapabilities: extState.capabilities,
                userscriptReady: false,
              },
            );
            if (plan.channel === "extension_direct") {
              const prepared = preparedSnapshot(snapshot, item, target);
              videoRetries.set(id, (forceRefresh = false) =>
                enqueueItem(prepared, id, forceRefresh),
              );
              videoStore.updateDownload(id, {
                refreshAvailable: refreshable(prepared),
              });
              const { resolvedExt, formatMime } = resolveFinalMediaExtension(
                target,
                item,
                snapshot.platform,
              );
              const filename = filenameFor(
                snapshot,
                resolvedExt,
                target.variant,
              );
              videoStore.updateDownload(id, { filename });
              const orderedRoutes = traits.whitelistedRoutes;
              const knownSize =
                target.source.size_bytes ??
                delivery.sources.find((s) =>
                  sourceRoutes(s, apiContext).includes(orderedRoutes[0]),
                )?.size_bytes;
              const selectionKey =
                selected ||
                JSON.stringify([
                  snapshot.version,
                  item.id,
                  target.variant.id,
                  traits.preferExtensionDirectAcceleration
                    ? "ext-direct-accel"
                    : "ext-direct-delegated",
                ]);
              let fellBackToWeb = false;
              const bridgeOk = await runExtensionBridgeDownload({
                snapshot: prepared,
                retryId: id,
                controller,
                filename,
                payload: {
                  kind: "direct_download",
                  platform: snapshot.platform || "media",
                  title: snapshot.title || item.title || filename,
                  filename,
                  routes: orderedRoutes,
                  ...(knownSize ? { sizeBytes: knownSize } : {}),
                  ...(formatMime ? { mimeType: formatMime } : {}),
                },
                savePathLabel: traits.preferExtensionDirectAcceleration
                  ? "保存路径：Chrome 扩展后台加速下载"
                  : "保存路径：Chrome 扩展后台下载",
                startStatusText: traits.preferExtensionDirectAcceleration
                  ? "扩展 4 路并发高速下载中..."
                  : "扩展后台保存中...",
                selectionKey,
                onBridgeUnavailable: () => {
                  fellBackToWeb = true;
                  return false;
                },
              });
              if (!fellBackToWeb) {
                return bridgeOk;
              }
              if (!ownsTask(id, controller)) return false;
              videoStore.updateDownload(id, {
                savePath: undefined,
                savePathLabel: undefined,
              });
            }
          }
        }
        if (
          !refresh &&
          !snapshot.pinned &&
          target.kind === "file" &&
          delivery.kind === "file" &&
          delivery.sources.length > 1 &&
          delivery.sources.some((s) => s.browser_fetch === "allowed")
        ) {
          target = await (
            await import("../downloads/routeProbe")
          ).default(
            target,
            item,
            snapshot.platform,
            apiContext,
            controller.signal,
            (statusText) =>
              ownsTask(id, controller) &&
              videoStore.updateDownload(id, { statusText }),
          );
          if (!ownsTask(id, controller)) return false;
        }
        const prepared = preparedSnapshot(snapshot, item, target);
        videoRetries.set(id, (forceRefresh = false) =>
          enqueueItem(prepared, id, forceRefresh),
        );
        videoStore.updateDownload(id, {
          refreshAvailable: refreshable(prepared),
        });
        if (target.kind === "pair") {
          if (delivery.kind !== "pair") throw new Error("实况资源不完整");
          videoStore.updateDownload(id, { abortController: null });
          await archiveItems([prepared], filenameFor(snapshot, "zip"), id);
          return true;
        }
        const { resolvedExt, formatMime } = resolveFinalMediaExtension(
          target,
          item,
          snapshot.platform,
        );
        const filename = filenameFor(snapshot, resolvedExt, target.variant);
        videoStore.updateDownload(id, { filename });
        if (target.kind === "file") {
          const hints = item.tbvideo;
          const tbvideo =
            isTbvideoVideoItem(item) && hints ? hints : undefined;
          const sourceId = target.source.id;
          sourceContexts.set(id, {
            tbvideo: tbvideo && {
              item: tbvideo,
              candidate:
                sourceId && Object.hasOwn(tbvideo.sources, sourceId)
                  ? tbvideo.sources[sourceId]
                  : "",
            },
            routes: target.routes,
            selectedUrl: target.url,
            resultVersion: snapshot.version,
            itemId: item.id,
            variantId: target.variant.id,
            selectionKey: snapshot.selectionKey,
            sources: delivery.kind === "file" ? delivery.sources : [],
            formatMime,
          });
          videoStore.updateDownload(id, { url: target.url });
          void downloadFile(target.url, filename, id, controller, startedAt);
        } else {
          if (delivery.kind !== "hls" && delivery.kind !== "segments")
            throw new Error("该版本暂不支持");
          const { declaredSegments } = await import("../utils/segmentDownload");
          const segments = await declaredSegments(
            delivery,
            apiContext,
            controller.signal,
          );
          checkAbort(controller.signal);
          videoStore.updateDownload(id, { segments });
          void downloadSegments(segments, filename, id, controller, startedAt);
        }
        return true;
      } catch (error) {
        if (!ownsTask(id, controller)) return false;
        const cancelled =
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError");
        videoStore.updateDownload(id, {
          status: cancelled ? "cancelled" : "failed",
          statusText: cancelled ? "已取消" : "下载失败",
          error: cancelled
            ? null
            : error instanceof Error
              ? error.message
              : "下载失败",
          abortController: null,
          speed: 0,
        });
        return false;
      }
    })();
  }

  const publicActions = createPublicDownloadActions({
    videoStore,
    showToast,
    selection,
    apiContext,
    snapshotItem,
    enqueueItem,
    archiveItems,
  });

  const taskControls = createTaskControls({
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
  });

  return {
    restoreDownloads,
    downloadFile,
    ...publicActions,
    ...taskControls,
  };
}
