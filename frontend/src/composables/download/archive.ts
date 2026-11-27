import { acquireBufferedSlot } from "../../downloads/buffered";
import { isCorsBlockedDirectUrl, isTbvideoVideoItem } from "../../core/media";
import type {
  Attachment,
  MediaItem,
  MediaSelection,
  Resource,
  ToastType,
  UnifiedMedia,
} from "../../types/media";
import {
  readyItem,
  readyVariant,
  resourceSource,
  type DownloadTarget,
} from "../../utils/mediaContract";
import type { HlsSegment } from "../../utils/segmentDownload";
import { buildArchiveFilename } from "../../utils/videoFilename";
import type { useVideoStore } from "../../stores/video";
import type { VideoSelection } from "../useVideoSelection";
import {
  abortable,
  checkAbort,
  filenameFor,
  freeze,
  MAX_ARCHIVE_BYTES,
  triggerBrowserDownload,
  type ArchiveBuilder,
  type ArchiveEntry,
  type ItemSnapshot,
} from "./helpers";

export function archiveFilenameFor(
  resultData: UnifiedMedia | null,
  snapshots: ItemSnapshot[],
): string {
  return buildArchiveFilename({
    title:
      resultData?.title?.trim() ||
      snapshots.find((s) => s.item.title?.trim())?.item.title?.trim(),
    author: resultData?.author?.name?.trim() || resultData?.author?.id?.trim(),
    count: snapshots.length,
    fallback:
      resultData?.content_id ||
      resultData?.source_url ||
      snapshots[0]?.item.id ||
      "archive",
  });
}

export function createArchiveController(deps: {
  videoStore: ReturnType<typeof useVideoStore>;
  showToast: (message: string, type?: ToastType, duration?: number) => unknown;
  apiContext: { apiOrigin: string };
  archiveRetries: Map<number, () => Promise<void>>;
  ownsTask: (id: number, controller: AbortController) => boolean;
  monitorTransfer: (
    id: number,
    controller: AbortController,
    startedAt?: number,
    bytes?: boolean,
  ) => { receive: (count: number) => void; finish: () => void };
  snapshotTarget: (snapshot: ItemSnapshot, item: MediaItem) => DownloadTarget;
  preparedSnapshot: (
    snapshot: ItemSnapshot,
    item: MediaItem,
    target: Extract<DownloadTarget, { variant: unknown }>,
  ) => ItemSnapshot;
  resolvedTarget: (
    snapshot: ItemSnapshot,
    signal: AbortSignal,
    refresh?: boolean,
    onRateLimitWait?: (seconds: number) => void,
  ) => Promise<{
    item: MediaItem;
    target: Extract<DownloadTarget, { variant: unknown }>;
  }>;
}) {
  const {
    videoStore,
    showToast,
    apiContext,
    archiveRetries,
    ownsTask,
    monitorTransfer,
    snapshotTarget,
    preparedSnapshot,
    resolvedTarget,
  } = deps;

  async function runArchive(
    filename: string,
    build: ArchiveBuilder,
    retryId?: number,
  ): Promise<void> {
    const id =
      retryId ??
      videoStore.addDownload({
        filename,
        status: "preparing",
        statusText: "准备中...",
      });
    const controller = new AbortController();
    archiveRetries.set(id, () => runArchive(filename, build, id));
    videoStore.updateDownload(id, {
      abortController: controller,
      status: "preparing",
      statusText: "准备打包...",
      percent: 0,
      error: null,
      progressKind: "archive",
      nativeAvailable: false,
      elapsed: 0,
      speed: 0,
      averageSpeed: 0,
    });
    const monitor = monitorTransfer(id, controller, Date.now(), false);
    let release: (() => void) | undefined;
    try {
      videoStore.updateDownload(id, {
        status: "queued",
        statusText: "等待分片或打包任务...",
      });
      release = await acquireBufferedSlot(controller.signal);
      checkAbort(controller.signal);
      videoStore.updateDownload(id, {
        status: "preparing",
        statusText: "准备打包...",
      });
      const [{ default: JSZip }, segmentMod] = await abortable(
        Promise.all([import("jszip"), import("../../utils/segmentDownload")]),
        controller.signal,
      );
      checkAbort(controller.signal);
      if (!ownsTask(id, controller)) return;
      videoStore.updateDownload(id, {
        status: "downloading",
        statusText: "正在打包...",
      });
      const entries = await build(
        controller.signal,
        (done, total) => {
          checkAbort(controller.signal);
          if (!ownsTask(id, controller)) return;
          videoStore.updateDownload(id, {
            percent: Math.round((done / total) * 85),
            statusText: `打包 ${done}/${total}...`,
          });
        },
        (statusText) => {
          if (ownsTask(id, controller)) {
            videoStore.updateDownload(id, { statusText });
          }
        },
        segmentMod,
      );
      checkAbort(controller.signal);
      if (!ownsTask(id, controller)) return;
      if (!entries.length) throw new Error("没有可打包的资源");
      const zip = new JSZip();
      const entryCount = entries.length;
      while (entries.length) {
        const entry = entries.shift()!;
        checkAbort(controller.signal);
        const data =
          entry.data instanceof Blob
            ? await entry.data.arrayBuffer()
            : entry.data;
        checkAbort(controller.signal);
        if (!ownsTask(id, controller)) return;
        zip.file(entry.filename, data);
      }
      const blob = await zip.generateAsync(
        { type: "blob", compression: "STORE" },
        (metadata) => {
          checkAbort(controller.signal);
          if (!ownsTask(id, controller)) return;
          videoStore.updateDownload(id, {
            percent: 85 + Math.round(metadata.percent * 0.14),
            statusText: "生成压缩包...",
          });
        },
      );
      checkAbort(controller.signal);
      if (!ownsTask(id, controller)) return;
      const blobUrl = URL.createObjectURL(blob);
      triggerBrowserDownload(blobUrl, filename);
      (
        setTimeout(() => URL.revokeObjectURL(blobUrl), 45_000) as {
          unref?: () => void;
        }
      )?.unref?.();
      monitor.finish();
      videoStore.updateDownload(id, {
        status: "completed",
        statusText: "已完成",
        percent: 100,
        abortController: null,
      });
      archiveRetries.delete(id);
      showToast(`已打包 ${entryCount} 个文件`);
    } catch (error) {
      if (
        videoStore.downloads.find((task) => task.id === id)?.abortController !==
        controller
      )
        return;
      monitor.finish();
      if (
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        videoStore.updateDownload(id, {
          status: "cancelled",
          statusText: "已取消",
          abortController: null,
        });
        return;
      }
      const message = error instanceof Error ? error.message : "打包失败";
      videoStore.updateDownload(id, {
        status: "failed",
        statusText: "打包失败",
        error: message,
        abortController: null,
      });
      showToast("打包失败：" + message, "error");
    } finally {
      release?.();
      monitor.finish();
    }
  }

  async function archiveItems(
    snapshots: ItemSnapshot[],
    filename: string,
    retryId?: number,
  ): Promise<void> {
    if (snapshots.some((s) => isTbvideoVideoItem(s.item))) return;
    const taskSnapshots = [...snapshots];
    await runArchive(
      filename,
      async (signal, progress, setStatus, segmentMod) => {
        segmentMod.assertArchiveKnownSizeLimit(
          taskSnapshots.map((s) => snapshotTarget(s, s.item)),
          apiContext,
          MAX_ARCHIVE_BYTES,
        );
        const entries: ArchiveEntry[] = [];
        let archiveBytes = 0;
        for (let index = 0; index < taskSnapshots.length; index++) {
          const snapshot = taskSnapshots[index];
          const { item, target } = await resolvedTarget(
            snapshot,
            signal,
            false,
            (sec) =>
              setStatus(
                `请求受限，等待 ${sec} 秒后重试（${index + 1}/${taskSnapshots.length}）...`,
              ),
          );
          taskSnapshots[index] = preparedSnapshot(snapshot, item, target);
          const base = `${String(index + 1).padStart(3, "0")}_${filenameFor(snapshot, "bin").replace(/\.bin$/, "")}`;
          const collected = await segmentMod.collectArchiveTargetEntries({
            itemId: snapshot.item.id,
            target,
            base,
            apiContext,
            signal,
            maxArchiveBytes: MAX_ARCHIVE_BYTES,
            currentBytes: archiveBytes,
          });
          archiveBytes = collected.totalBytes;
          entries.push(...collected.entries);
          checkAbort(signal);
          progress(index + 1, taskSnapshots.length);
        }
        return entries;
      },
      retryId,
    );
  }

  async function downloadSegments(
    segments: (HlsSegment | string)[],
    filename: string,
    downloadId: number,
    abortController = new AbortController(),
    startedAt = Date.now(),
  ): Promise<void> {
    videoStore.updateDownload(downloadId, {
      abortController,
      progressKind: "segments",
      nativeAvailable: false,
      error: null,
      speed: 0,
      averageSpeed: 0,
      elapsed: 0,
    });
    const monitor = monitorTransfer(
      downloadId,
      abortController,
      startedAt,
      false,
    );
    let release: (() => void) | undefined;
    try {
      videoStore.updateDownload(downloadId, {
        status: "queued",
        statusText: "等待分片或打包任务...",
      });
      release = await acquireBufferedSlot(abortController.signal);
      checkAbort(abortController.signal);
      videoStore.updateDownload(downloadId, {
        status: "downloading",
        statusText: "下载分片中...",
        percent: 0,
        loaded: 0,
        total: 0,
      });
      const { mergeAndDownload } = await import("../../utils/segmentDownload");
      checkAbort(abortController.signal);
      const ok = await mergeAndDownload(segments, {
        signal: abortController.signal,
        filename,
        onProgress: (p) =>
          videoStore.updateDownload(downloadId, {
            loaded: p.loaded,
            total: p.total,
            percent: p.percent,
            statusText: `下载分片 ${p.segment}/${p.segmentCount}（${p.percent}%）`,
          }),
      });
      if (!ok) throw new Error("没有可用的分片");
      if (!ownsTask(downloadId, abortController)) return;
      monitor.finish();
      videoStore.updateDownload(downloadId, {
        status: "completed",
        statusText: "已完成",
        percent: 100,
        loaded: 0,
        total: 0,
        abortController: null,
      });
    } catch (error) {
      if (!ownsTask(downloadId, abortController)) return;
      monitor.finish();
      if (
        abortController.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        videoStore.updateDownload(downloadId, {
          status: "cancelled",
          statusText: "已取消",
          abortController: null,
        });
        return;
      }
      const message = error instanceof Error ? error.message : "下载失败";
      videoStore.updateDownload(downloadId, {
        status: "failed",
        statusText: "下载失败",
        error: message,
        abortController: null,
      });
      showToast("分片下载失败：" + message, "error");
    } finally {
      release?.();
      monitor.finish();
    }
  }

  return {
    runArchive,
    archiveItems,
    downloadSegments,
  };
}

export function createPublicDownloadActions(deps: {
  videoStore: ReturnType<typeof useVideoStore>;
  showToast: (message: string, type?: ToastType, duration?: number) => unknown;
  selection: VideoSelection;
  apiContext: { apiOrigin: string };
  snapshotItem: (item: MediaItem, choice?: MediaSelection | null) => ItemSnapshot;
  snapshotTarget?: (snapshot: ItemSnapshot, item: MediaItem) => DownloadTarget;
  isExtensionConnected?: () => Promise<boolean>;
  enqueueItem: (
    snapshot: ItemSnapshot,
    retryId?: number,
    refresh?: boolean,
    options?: { separateOnly?: boolean },
  ) => Promise<boolean>;
  archiveItems: (
    snapshots: ItemSnapshot[],
    filename: string,
    retryId?: number,
  ) => Promise<void>;
}) {
  const {
    videoStore,
    showToast,
    selection,
    apiContext,
    snapshotItem,
    snapshotTarget,
    isExtensionConnected,
    enqueueItem,
    archiveItems,
  } = deps;

  async function downloadVideosAsZip(items: MediaItem[], zipName?: string) {
    if (!items.length) {
      showToast("没有可下载的条目", "warning");
      return;
    }
    const snapshots = items.map((item) => snapshotItem(item));
    await archiveItems(
      snapshots,
      zipName || archiveFilenameFor(videoStore.resultData, snapshots),
    );
  }
  async function downloadSelected() {
    const snapshots = selection
      .getBatchVideos()
      .map((item) => snapshotItem(item));
    for (const snapshot of snapshots) await enqueueItem(snapshot);
  }
  async function downloadAllVideos() {
    const snapshots = selection.list.value.map((item) => snapshotItem(item));
    for (const snapshot of snapshots) await enqueueItem(snapshot);
  }
  async function downloadMainVideo() {
    if (selection.currentVideo.value)
      await enqueueItem(snapshotItem(selection.currentVideo.value));
  }
  function downloadVideoByIndex(index: number) {
    const item = selection.visibleList.value[index];
    if (item) void enqueueItem(snapshotItem(item));
  }
  function downloadBackupVideo(choice: MediaSelection) {
    const item = selection.currentVideo.value;
    if (item) void enqueueItem(snapshotItem(item, choice));
  }
  async function downloadYouTubeSeparate(choice?: MediaSelection) {
    const item = selection.currentVideo.value;
    if (item) {
      await enqueueItem(snapshotItem(item, choice), undefined, false, {
        separateOnly: true,
      });
    }
  }
  function downloadImage(item: MediaItem) {
    void enqueueItem(snapshotItem(item));
  }
  async function enqueueResource(resource: Resource, title?: string) {
    const item: MediaItem = {
      id: resource.id,
      type: resource.role === "image" ? "image" : "audio",
      title,
      variants: [
        {
          id: "resource",
          metadata: resource.metadata,
          delivery: resource.delivery,
        },
      ],
      default: null,
      default_unavailable_reason: "processing_required",
    };
    await enqueueItem(
      freeze({
        ...snapshotItem(item, { variant_id: "resource" }),
        isAttachment: true,
      }),
    );
  }
  function downloadMusic(attachment: Attachment) {
    void enqueueResource(freeze(attachment.resource), attachment.title);
  }
  function pairResource(item: MediaItem, role: "image" | "motion") {
    if (!readyItem(item)) return;
    const choice = selection.selectionFor(item.id);
    const variant = choice
      ? item.variants.find((candidate) => candidate.id === choice.variant_id)
      : item.variants.length === 1
        ? item.variants[0]
        : undefined;
    if (!readyVariant(variant) || variant.delivery.kind !== "pair") {
      showToast(
        choice ? "所选实况版本已不可用，请重新选择" : "请先选择实况版本",
        "warning",
      );
      return;
    }
    const resource = variant.delivery.resources.find(
      (candidate) => candidate.role === role,
    );
    if (resource) {
      const source =
        resourceSource(resource, apiContext) ||
        ("sources" in resource.delivery
          ? resource.delivery.sources[0]
          : undefined);
      void enqueueItem(
        freeze({
          ...snapshotItem(item, { variant_id: variant.id }),
          resource: {
            id: resource.id,
            role: resource.role,
            ...(source?.id ? { source_id: source.id } : {}),
          },
        }),
      );
    }
  }
  const downloadLiveVideo = (item: MediaItem) => pairResource(item, "motion");
  const downloadLiveCover = (item: MediaItem) => pairResource(item, "image");
  async function downloadAllMedia(
    mode: "all" | "images" | "live" | "covers" = "all",
  ) {
    const items =
      videoStore.resultData?.items.filter(
        (item) =>
          mode === "all" ||
          (mode === "images" && item.type === "image") ||
          (["live", "covers"].includes(mode) && item.type === "live_photo"),
      ) || [];
    if (mode === "covers") {
      for (const item of items) downloadLiveCover(item);
      return;
    }
    const snapshots = items.map((item) =>
      snapshotItem(
        item,
        selection.selectionFor(item.id) ||
          (readyItem(item) &&
          item.variants.length === 1 &&
          readyVariant(item.variants[0]) &&
          item.variants[0].delivery.kind === "pair"
            ? { variant_id: item.variants[0].id }
            : null),
      ),
    );
    if (!snapshots.length) {
      showToast("没有可下载的条目", "warning");
      return;
    }
    if (snapshots.length === 1 && snapshots[0].item.type !== "live_photo") {
      await enqueueItem(snapshots[0]);
      return;
    }
    const hasCorsBlockedDirect =
      typeof snapshotTarget === "function" &&
      snapshots.some((s) => {
        const t = snapshotTarget(s, s.item);
        return (
          t.kind === "file" &&
          (isCorsBlockedDirectUrl(t.url) ||
            t.routes.some((route) => isCorsBlockedDirectUrl(route)))
        );
      });
    if (hasCorsBlockedDirect) {
      const extConnected = isExtensionConnected
        ? await isExtensionConnected()
        : false;
      if (extConnected) {
        for (const snapshot of snapshots) {
          await enqueueItem(snapshot);
        }
        return;
      }
      showToast(
        "该站点图片受浏览器 CORS 限制，暂不支持网页打包 ZIP；请单张打开保存，或安装 DokiTool 扩展一键批量下载",
        "warning",
        5000,
      );
      return;
    }
    await archiveItems(
      snapshots,
      archiveFilenameFor(videoStore.resultData, snapshots),
    );
  }
  const downloadAllImages = () => downloadAllMedia("images");

  return {
    downloadVideosAsZip,
    downloadSelected,
    downloadAllVideos,
    downloadMainVideo,
    downloadVideoByIndex,
    downloadBackupVideo,
    downloadYouTubeSeparate,
    downloadImage,
    downloadMusic,
    downloadLiveVideo,
    downloadLiveCover,
    downloadAllMedia,
    downloadAllImages,
  };
}
