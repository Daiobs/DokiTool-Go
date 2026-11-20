import { confirmedFormatMime, extensionsFor } from "../../downloads/file";
import type {
  Attachment,
  DownloadTask,
  MediaItem,
  ReadyVariant,
  ToastType,
  YouTubeHelperState,
} from "../../types/media";
import {
  downloadViaYouTubeHelper,
  isValidGooglevideoPlaybackUrl,
  muxDownloadViaYouTubeHelper,
  selectYouTubeMuxPair,
} from "../../utils/youtubeHelperCore";
import {
  readyItem,
  readyVariant,
  sourceUrl,
  type DownloadTarget,
} from "../../utils/mediaContract";
import { mediaExtension } from "../../utils/mediaDelivery";
import type { useVideoStore } from "../../stores/video";
import {
  comparableUrl,
  filenameFor,
  formatYouTubeSavePathLabel,
  freeze,
  inferredVideoFileExtension,
  type ItemSnapshot,
  type SourceContext,
} from "./helpers";

export function resolveYouTubeVideoExt(
  variant: ReadyVariant,
  rawUrl: string,
): string {
  const delivery = variant.delivery;
  const extension = mediaExtension(
    variant.metadata,
    delivery.kind === "mux" || delivery.kind === "pair" ? undefined : delivery,
  );
  const formatMime = confirmedFormatMime(variant.metadata);
  const suffixes = extensionsFor(formatMime || "");
  let resolvedExt =
    suffixes.length && !suffixes.includes(extension) ? suffixes[0] : extension;
  if (resolvedExt === "bin") {
    resolvedExt = inferredVideoFileExtension(rawUrl, "youtube", false) || "mp4";
  }
  return resolvedExt === "webm" ? "webm" : "mp4";
}

export function findBestYouTubeAudioCandidate(
  item: MediaItem,
  attachments: Attachment[],
  apiContext: { apiOrigin: string },
  preferredAudioVariant?: ReadyVariant,
): { variant: ReadyVariant; url: string; ext: "m4a" | "webm" } | null {
  const candidates: ReadyVariant[] = [];
  if (preferredAudioVariant) {
    candidates.push(preferredAudioVariant);
  }
  if (readyItem(item)) {
    for (const v of item.variants) {
      if (readyVariant(v) && v.delivery.kind === "file") {
        candidates.push(v);
      }
    }
  }
  for (const att of attachments) {
    if (
      att?.resource?.role === "audio" &&
      att.resource.delivery.kind === "file"
    ) {
      candidates.push({
        id: att.id || `att-${att.resource.id || "audio"}`,
        state: "ready",
        label: att.title || "原声轨",
        metadata: att.resource.metadata,
        delivery: att.resource.delivery,
      });
    }
  }
  const seen = new Set<string>();
  for (const cand of candidates) {
    if (seen.has(cand.id) || cand.delivery.kind !== "file") continue;
    seen.add(cand.id);
    const meta = cand.metadata || {};
    const mime = String(meta.mime_type || "").toLowerCase();
    const rawExt = String(meta.extension || meta.container || "").toLowerCase();
    const isStandaloneAudio =
      meta.has_audio === true &&
      !meta.video_codec &&
      !meta.width &&
      !meta.height &&
      (mime.startsWith("audio/") ||
        rawExt === "m4a" ||
        rawExt === "webm" ||
        rawExt === "mp4");
    if (!isStandaloneAudio) continue;
    const src =
      cand.delivery.sources.find(
        (s) =>
          s.availability !== "unavailable" &&
          isValidGooglevideoPlaybackUrl(sourceUrl(s, apiContext)),
      ) ||
      cand.delivery.sources.find((s) =>
        isValidGooglevideoPlaybackUrl(sourceUrl(s, apiContext)),
      );
    if (!src) continue;
    const ext: "m4a" | "webm" =
      rawExt === "webm" || mime === "audio/webm" ? "webm" : "m4a";
    return {
      variant: cand,
      url: sourceUrl(src, apiContext),
      ext,
    };
  }
  return null;
}

export function createYouTubeDownloadController(deps: {
  videoStore: ReturnType<typeof useVideoStore>;
  showToast: (message: string, type?: ToastType, duration?: number) => unknown;
  apiContext: { apiOrigin: string };
  currentYouTubeHelper: () => YouTubeHelperState | undefined;
  taskFor: (id: number) => DownloadTask | undefined;
  ownsTask: (id: number, controller: AbortController) => boolean;
  sourceContexts: Map<number, SourceContext>;
  videoRetries: Map<number, (refresh?: boolean) => Promise<boolean>>;
  fileTaskSelections: Map<number, string>;
  deliveryTasks: Map<string, number>;
  nextMuxDeliveryId: () => string;
  snapshotTarget: (snapshot: ItemSnapshot, item: MediaItem) => DownloadTarget;
  fileSelectionKey: (snapshot: ItemSnapshot) => string | undefined;
  selectionInFlight: (key: string | undefined, exceptId?: number) => boolean;
  selectionBusyNotice: () => void;
  downloadFile: (
    url: string,
    filename: string,
    downloadId: number,
    controller?: AbortController,
    startedAt?: number,
  ) => Promise<void>;
}) {
  const {
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
    nextMuxDeliveryId,
    snapshotTarget,
    fileSelectionKey,
    selectionInFlight,
    selectionBusyNotice,
    downloadFile,
  } = deps;

  async function runYouTubeDirectHelperDownload(params: {
    url: string;
    filename: string;
    downloadId: number;
    deliveryId: string;
    controller: AbortController;
    startedAt: number;
  }): Promise<void> {
    const { url, filename, downloadId, deliveryId, controller, startedAt } =
      params;
    let lastBytes = 0;
    let lastSampleAt = startedAt;
    const ctxSources = sourceContexts.get(downloadId)?.sources ?? [];
    const matchedSource = ctxSources.find(
      (s) => comparableUrl(sourceUrl(s, apiContext)) === comparableUrl(url),
    );
    const knownSize = matchedSource?.size_bytes || 0;
    videoStore.updateDownload(downloadId, {
      deliveryId,
      abortController: controller,
      status: "downloading",
      statusText: "通过助手分块并发保存中...",
      percent: 0,
      loaded: 0,
      total: knownSize,
      speed: 0,
      elapsed: 0,
      averageSpeed: 0,
      transferred: 0,
      error: null,
      progressKind: "bytes",
      nativeAvailable: false,
      observation: undefined,
      transferElapsed: undefined,
      timing: undefined,
      workerBuild: undefined,
    });
    try {
      const saved = await downloadViaYouTubeHelper({
        url,
        filename,
        size: knownSize || undefined,
        taskId: deliveryId,
        signal: controller.signal,
        onProgress(detail) {
          if (!ownsTask(downloadId, controller)) return;
          const now = Date.now();
          const elapsed = Math.max(0.001, (now - startedAt) / 1000);
          const dt = Math.max(0.001, (now - lastSampleAt) / 1000);
          const speed = Math.max(0, (detail.loaded - lastBytes) / dt);
          lastBytes = detail.loaded;
          lastSampleAt = now;
          videoStore.updateDownload(downloadId, {
            loaded: detail.loaded,
            total: detail.total,
            transferred: detail.loaded,
            percent: detail.percent,
            elapsed,
            speed,
            averageSpeed: detail.loaded / elapsed,
            ...(detail.mode
              ? {
                  savePath: detail.mode,
                  savePathLabel: formatYouTubeSavePathLabel(detail.mode),
                }
              : {}),
            statusText: `通过助手分块并发保存中（${detail.percent}%）...`,
          });
        },
      });
      if (!ownsTask(downloadId, controller)) return;
      const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
      const finalMode = saved?.mode || taskFor(downloadId)?.savePath;
      videoStore.updateDownload(downloadId, {
        filename: saved?.filename || filename,
        status: "completed",
        statusText: "已完成",
        ...(finalMode
          ? {
              savePath: finalMode,
              savePathLabel: formatYouTubeSavePathLabel(finalMode),
            }
          : {}),
        percent: 100,
        speed: 0,
        elapsed,
        abortController: null,
      });
      showToast(`已通过助手保存：${saved?.filename || filename}`);
    } catch (error) {
      if (!ownsTask(downloadId, controller)) return;
      const cancelled =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      const message =
        error instanceof Error ? error.message : "通过助手保存失败";
      videoStore.updateDownload(downloadId, {
        status: cancelled ? "cancelled" : "failed",
        statusText: cancelled ? "已取消" : "下载失败",
        speed: 0,
        error: cancelled ? null : message,
        abortController: null,
      });
      if (!cancelled) {
        showToast(message, "error");
      }
    }
  }

  async function runYouTubeSeparateTrackSave(params: {
    snapshot: ItemSnapshot;
    item: MediaItem;
    videoTarget: Extract<DownloadTarget, { kind: "file" }>;
    preferredAudioVariant?: ReadyVariant;
    primaryTaskId?: number;
    fallbackReason: string | null;
    startedAt: number;
  }): Promise<boolean> {
    const {
      snapshot,
      item,
      videoTarget,
      preferredAudioVariant,
      primaryTaskId,
      fallbackReason,
      startedAt,
    } = params;
    const videoExt = resolveYouTubeVideoExt(
      videoTarget.variant,
      videoTarget.url,
    );
    const videoFilename = filenameFor(snapshot, videoExt, videoTarget.variant);
    const audioCand = findBestYouTubeAudioCandidate(
      item,
      videoStore.resultData?.attachments ?? [],
      apiContext,
      preferredAudioVariant,
    );
    const effectiveReason =
      !audioCand && fallbackReason
        ? `${fallbackReason}（未找到独立音轨，仅保存视频轨）`
        : !audioCand
          ? "未找到独立音轨，仅保存视频轨"
          : fallbackReason;

    const videoTaskId =
      primaryTaskId ??
      videoStore.addDownload({
        filename: videoFilename,
        url: videoTarget.url,
        fallbackReason: effectiveReason,
        statusText: "准备下载视频轨...",
      });
    const videoController = new AbortController();
    videoStore.updateDownload(videoTaskId, {
      filename: videoFilename,
      url: videoTarget.url,
      fallbackReason: effectiveReason,
      abortController: videoController,
      error: null,
      refreshAvailable: false,
    });
    sourceContexts.set(videoTaskId, {
      routes: videoTarget.routes,
      selectedUrl: videoTarget.url,
      resultVersion: snapshot.version,
      itemId: item.id,
      variantId: videoTarget.variant.id,
      sources:
        videoTarget.variant.delivery.kind === "file"
          ? videoTarget.variant.delivery.sources
          : [],
    });
    videoRetries.set(videoTaskId, async () => {
      await downloadFile(
        videoTarget.url,
        videoFilename,
        videoTaskId,
        new AbortController(),
        Date.now(),
      );
      return true;
    });
    const videoPromise = downloadFile(
      videoTarget.url,
      videoFilename,
      videoTaskId,
      videoController,
      startedAt,
    );

    if (!audioCand) {
      await videoPromise;
      return true;
    }

    const audioSnapshot = freeze({
      ...snapshot,
      item: { ...item, type: "audio" } as MediaItem,
    });
    const audioFilename = filenameFor(
      audioSnapshot,
      audioCand.ext,
      audioCand.variant,
    );
    const audioController = new AbortController();
    const audioTaskId = videoStore.addDownload({
      filename: audioFilename,
      url: audioCand.url,
      fallbackReason: effectiveReason,
      statusText: "准备下载音轨...",
      abortController: audioController,
    });
    sourceContexts.set(audioTaskId, {
      routes: [audioCand.url],
      selectedUrl: audioCand.url,
      resultVersion: snapshot.version,
      itemId: item.id,
      variantId: audioCand.variant.id,
      sources:
        audioCand.variant.delivery.kind === "file"
          ? audioCand.variant.delivery.sources
          : [],
    });
    videoRetries.set(audioTaskId, async () => {
      await downloadFile(
        audioCand.url,
        audioFilename,
        audioTaskId,
        new AbortController(),
        Date.now(),
      );
      return true;
    });
    const audioPromise = downloadFile(
      audioCand.url,
      audioFilename,
      audioTaskId,
      audioController,
      Date.now(),
    );
    await Promise.all([videoPromise, audioPromise]);
    return true;
  }

  function tryHandleYouTubeSplitEnqueue(params: {
    snapshot: ItemSnapshot;
    retryId?: number;
    refresh: boolean;
    separateOnly?: boolean;
    enqueueItem: (
      snapshot: ItemSnapshot,
      retryId?: number,
      refresh?: boolean,
      options?: { separateOnly?: boolean },
    ) => Promise<boolean>;
  }): Promise<boolean> | null {
    const { snapshot, retryId, refresh, separateOnly, enqueueItem } = params;
    if (snapshot.platform !== "youtube") return null;
    const ytHelper = currentYouTubeHelper();
    if (ytHelper && ytHelper.status !== "ready") {
      showToast(
        ytHelper.message || "请先安装并启用 YouTube 下载助手脚本后再下载",
        "warning",
        5000,
      );
      return Promise.resolve(false);
    }
    if (
      ytHelper?.status !== "ready" ||
      refresh ||
      snapshot.item.type !== "video"
    ) {
      return null;
    }

    const syncTarget = snapshotTarget(snapshot, snapshot.item);
    if (
      syncTarget.kind !== "file" ||
      syncTarget.variant.metadata?.has_audio !== false
    ) {
      return null;
    }

    const selectedKey = fileSelectionKey(snapshot);
    if (selectionInFlight(selectedKey, retryId)) {
      selectionBusyNotice();
      return Promise.resolve(false);
    }
    const pair = selectYouTubeMuxPair(
      syncTarget.variant,
      readyItem(snapshot.item) ? snapshot.item.variants : [],
      videoStore.resultData?.attachments ?? [],
    );
    if (separateOnly) {
      return runYouTubeSeparateTrackSave({
        snapshot,
        item: snapshot.item,
        videoTarget: syncTarget,
        preferredAudioVariant: pair.ok ? pair.audioVariant : undefined,
        primaryTaskId: retryId,
        fallbackReason: null,
        startedAt: Date.now(),
      });
    }
    if (!pair.ok) {
      const fallbackReason = `合并保存不可用（${pair.reason}），已自动回退为音视频分开保存`;
      showToast(fallbackReason, "warning", 6000);
      return runYouTubeSeparateTrackSave({
        snapshot,
        item: snapshot.item,
        videoTarget: syncTarget,
        preferredAudioVariant: undefined,
        primaryTaskId: retryId,
        fallbackReason,
        startedAt: Date.now(),
      });
    }

    const mergedFilename = filenameFor(
      snapshot,
      pair.outputExtension,
      syncTarget.variant,
    );
    const id =
      retryId ??
      videoStore.addDownload({
        filename: mergedFilename,
        url: syncTarget.url,
        statusText: "准备浏览器内无损合流...",
      });
    if (selectedKey) fileTaskSelections.set(id, selectedKey);
    const controller = new AbortController();
    const startedAt = Date.now();
    let lastBytes = 0;
    let lastSampleAt = startedAt;
    const estTotal =
      (syncTarget.source.size_bytes || 0) + (pair.audioSource.size_bytes || 0);
    const deliveryId = nextMuxDeliveryId();
    deliveryTasks.set(deliveryId, id);
    videoStore.updateDownload(id, {
      deliveryId,
      filename: mergedFilename,
      url: syncTarget.url,
      abortController: controller,
      status: "downloading",
      statusText: "浏览器内无损合流保存中...",
      error: null,
      fallbackReason: null,
      savePath: undefined,
      savePathLabel: undefined,
      nativeAvailable: false,
      refreshAvailable: false,
      loaded: 0,
      total: estTotal,
      transferred: 0,
      progressKind: "bytes",
      elapsed: 0,
      speed: 0,
      averageSpeed: 0,
      percent: 0,
      observation: undefined,
      transferElapsed: undefined,
      timing: undefined,
      workerBuild: undefined,
    });
    videoRetries.set(id, (forceRefresh = false) =>
      enqueueItem(snapshot, id, forceRefresh),
    );

    const muxPromise = muxDownloadViaYouTubeHelper({
      videoUrl: syncTarget.url,
      audioUrl: sourceUrl(pair.audioSource, apiContext),
      videoSize: syncTarget.source.size_bytes,
      audioSize: pair.audioSource.size_bytes,
      filename: mergedFilename,
      outputContainer: pair.outputContainer,
      taskId: deliveryId,
      signal: controller.signal,
      onProgress(detail) {
        if (!ownsTask(id, controller)) return;
        const now = Date.now();
        const elapsed = Math.max(0.001, (now - startedAt) / 1000);
        const dt = Math.max(0.001, (now - lastSampleAt) / 1000);
        const speed = Math.max(0, (detail.loaded - lastBytes) / dt);
        lastBytes = detail.loaded;
        lastSampleAt = now;
        videoStore.updateDownload(id, {
          loaded: detail.loaded,
          total: detail.total,
          transferred: detail.loaded,
          percent: detail.percent,
          elapsed,
          speed,
          averageSpeed: detail.loaded / elapsed,
          ...(detail.mode
            ? {
                savePath: detail.mode,
                savePathLabel: formatYouTubeSavePathLabel(detail.mode),
              }
            : {}),
          statusText: `浏览器内无损合流保存中（${detail.percent}%）...`,
        });
      },
    });

    return (async () => {
      try {
        const saved = await muxPromise;
        if (!ownsTask(id, controller)) return false;
        const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
        const finalMode = saved?.mode || taskFor(id)?.savePath;
        videoStore.updateDownload(id, {
          filename: saved?.filename || mergedFilename,
          status: "completed",
          statusText: "已完成",
          ...(finalMode
            ? {
                savePath: finalMode,
                savePathLabel: formatYouTubeSavePathLabel(finalMode),
              }
            : {}),
          percent: 100,
          speed: 0,
          elapsed,
          abortController: null,
        });
        showToast(`已合并保存：${saved?.filename || mergedFilename}`);
        return true;
      } catch (error) {
        if (!ownsTask(id, controller)) return false;
        const cancelled =
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError") ||
          (error as { code?: string })?.code === "USER_CANCELLED";
        if (cancelled) {
          videoStore.updateDownload(id, {
            status: "cancelled",
            statusText: "已取消",
            speed: 0,
            error: null,
            abortController: null,
          });
          return false;
        }
        const errMsg =
          error instanceof Error && error.message
            ? error.message
            : "合流过程异常";
        const fallbackReason = `合并保存未完成（${errMsg}），已自动回退为音视频分开保存`;
        fileTaskSelections.delete(id);
        videoStore.updateDownload(id, {
          abortController: null,
          fallbackReason,
        });
        showToast(fallbackReason, "warning", 6000);
        return runYouTubeSeparateTrackSave({
          snapshot,
          item: snapshot.item,
          videoTarget: syncTarget,
          preferredAudioVariant: pair.audioVariant,
          primaryTaskId: id,
          fallbackReason,
          startedAt: Date.now(),
        });
      }
    })();
  }

  return {
    runYouTubeDirectHelperDownload,
    runYouTubeSeparateTrackSave,
    tryHandleYouTubeSplitEnqueue,
  };
}
