import { confirmedFormatMime, extensionsFor } from "../../downloads/file";
import type { WebExtEnqueuePayload } from "../../extension/protocol";
import type {
  Attachment,
  MediaItem,
  ReadyVariant,
  ToastType,
  YouTubeHelperState,
} from "../../types/media";
import {
  isValidGooglevideoPlaybackUrl,
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
  filenameFor,
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
  sourceContexts: Map<number, SourceContext>;
  videoRetries: Map<number, (refresh?: boolean) => Promise<boolean>>;
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
  runExtensionBridgeDownload?: (params: {
    snapshot?: ItemSnapshot;
    retryId?: number;
    controller?: AbortController;
    filename: string;
    payload: WebExtEnqueuePayload;
    savePathLabel: string;
    startStatusText: string;
    selectionKey: string;
  }) => Promise<boolean>;
}) {
  const {
    videoStore,
    showToast,
    apiContext,
    currentYouTubeHelper,
    sourceContexts,
    videoRetries,
    snapshotTarget,
    fileSelectionKey,
    selectionInFlight,
    selectionBusyNotice,
    downloadFile,
  } = deps;

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
    const ytHelper = currentYouTubeHelper();
    if (!ytHelper) return null;
    if (ytHelper.status !== "ready") {
      showToast(
        ytHelper.message || "请先安装并启用 DokiTool Chrome 官方扩展后再下载",
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
    const estTotal =
      (syncTarget.source.size_bytes || 0) + (pair.audioSource.size_bytes || 0);

    if (deps.runExtensionBridgeDownload) {
      return deps.runExtensionBridgeDownload({
        snapshot,
        retryId,
        filename: mergedFilename,
        payload: {
          kind: "youtube_mux",
          platform: snapshot.platform || "media",
          title: snapshot.title || snapshot.item.title || mergedFilename,
          filename: mergedFilename,
          youtubeMux: {
            videoUrl: syncTarget.url,
            audioUrl: sourceUrl(pair.audioSource, apiContext),
            ...(syncTarget.source.size_bytes
              ? { videoSize: syncTarget.source.size_bytes }
              : {}),
            ...(pair.audioSource.size_bytes
              ? { audioSize: pair.audioSource.size_bytes }
              : {}),
            outputContainer: pair.outputContainer,
          },
          ...(estTotal > 0 ? { sizeBytes: estTotal } : {}),
          mimeType:
            pair.outputContainer === "webm" ? "video/webm" : "video/mp4",
        },
        savePathLabel: "保存路径：Chrome 扩展后台无损合流",
        startStatusText: "扩展已接管，正在无损合流...",
        selectionKey:
          selectedKey ||
          JSON.stringify([
            snapshot.version,
            snapshot.item.id,
            syncTarget.variant.id,
            "ext-yt-mux",
          ]),
      });
    }

    showToast(
      "请先安装并启用 DokiTool Chrome 官方扩展以进行无损合流下载",
      "warning",
      5000,
    );
    return Promise.resolve(false);
  }

  return {
    runYouTubeSeparateTrackSave,
    tryHandleYouTubeSplitEnqueue,
  };
}
