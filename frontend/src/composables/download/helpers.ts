import { confirmedFormatMime, extensionsFor } from "../../downloads/file";
import {
  canAttemptSignedDirectAttachment,
  inferDirectVideoExtension,
  isCorsBlockedDirectUrl,
  isExtensionlessDirectMp4Url,
  resolveAdaptiveQualityFilenameTag,
  resolvePreferredMediaTitle,
} from "../../core/media";
import type {
  DownloadTask,
  MediaItem,
  MediaSelection,
  Resource,
  Source,
  ToastType,
} from "../../types/media";
import { buildMediaFilename } from "../../utils/videoFilename";
import { linkAbortSignals } from "../../downloads/buffered";
import { withRateLimitRetry } from "../useVideoParser";
import {
  getDownloadTarget,
  readyItem,
  readyVariant,
  type DownloadTarget,
} from "../../utils/mediaContract";
import { mediaExtension } from "../../utils/mediaDelivery";
import type { TbvideoItem } from "../../services/tbvideo";
import type { DownloadSnapshot } from "../../downloads/types";
import type { useVideoStore } from "../../stores/video";
import type { VideoSelection } from "../useVideoSelection";

export const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

export interface UseMediaDownloadOptions {
  videoStore: ReturnType<typeof useVideoStore>;
  showToast: (message: string, type?: ToastType, duration?: number) => unknown;
  selection: VideoSelection;
  resolveItem: (
    item: MediaItem,
    signal?: AbortSignal,
    options?: { onRateLimitWait?: (seconds: number) => void },
  ) => Promise<MediaItem>;
}

export interface SourceContext {
  routes: string[];
  resultVersion: number;
  selectedUrl: string;
  itemId?: string;
  variantId?: string;
  sources?: Source[];
  formatMime?: string;
  tbvideo?: { item: TbvideoItem; candidate: string };
  selectionKey?: string;
}

export interface ItemSnapshot {
  item: MediaItem;
  choice: MediaSelection | null;
  pinned?: boolean;
  title?: string;
  author?: string;
  contentId?: string;
  total: number;
  version: number;
  selectionKey: string;
  platform?: string;
  hasClientHelper?: boolean;
  isAttachment?: boolean;
  resource?: {
    id: string;
    role: Resource["role"];
    source_id?: string;
  };
}

export type ArchiveEntry = {
  filename: string;
  data: Blob | Uint8Array<ArrayBuffer>;
};
export type SegmentArchiveModule = typeof import("../../utils/segmentDownload");
export type ArchiveBuilder = (
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
  setStatus: (statusText: string) => void,
  segmentMod: SegmentArchiveModule,
) => Promise<ArchiveEntry[]>;

export type StreamingLoader = () => Promise<
  typeof import("../../downloads/streaming")
>;

export const deliveryStatusText: Record<DownloadSnapshot["status"], string> = {
  queued: "排队中...",
  preparing: "准备下载...",
  downloading: "下载中...",
  completed: "传输完成，请在浏览器确认保存",
  failed: "下载失败",
  cancelled: "已取消",
  "handed-off": "已交给浏览器",
  interrupted: "下载连接已中断",
  manual: "打开源链接",
};

export function triggerBrowserDownload(
  url: string,
  filename: string,
  newTab = false,
): boolean {
  const isolate = newTab || !url.startsWith("blob:");
  if (isolate) {
    const activation =
      typeof navigator !== "undefined" ? navigator.userActivation : undefined;
    if (activation && !activation.isActive) {
      return false;
    }
    if (
      typeof window !== "undefined" &&
      "open" in window &&
      typeof window.open !== "function"
    ) {
      return false;
    }
  }
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  // 无 Referer 直连，降低 CDN 防盗链拒绝概率
  anchor.referrerPolicy = "no-referrer";
  if (isolate) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  let clickEvent: Event | undefined;
  let threw = false;
  const onClick = (event: Event) => {
    clickEvent = event;
  };
  anchor.addEventListener?.("click", onClick);
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } catch {
    threw = true;
  } finally {
    anchor.removeEventListener?.("click", onClick);
    anchor.remove();
  }
  return !threw && !clickEvent?.defaultPrevented;
}

export function isToutiaovodVideoUrl(rawUrl: string): boolean {
  return isExtensionlessDirectMp4Url(rawUrl);
}

export function inferredVideoFileExtension(
  rawUrl: string,
  _platform?: string,
  hasTbvideo = false,
): string | undefined {
  return inferDirectVideoExtension(rawUrl, hasTbvideo);
}

export function isCorsBlockedDirectCdn(rawUrl: string): boolean {
  return isCorsBlockedDirectUrl(rawUrl);
}

// URL parameters only indicate that a direct attachment attempt can be made;
// they never prove that the actual upstream HTTP response is a verified attachment.
export function canAttemptDirectAttachment(rawUrl: string): boolean {
  return canAttemptSignedDirectAttachment(rawUrl);
}

export function formatYouTubeSavePathLabel(mode?: string): string | undefined {
  switch (mode) {
    case "opfs":
      return "保存路径：默认下载目录（OPFS 流式写盘）";
    case "stream_picker":
      return "保存路径：保存对话框流式写盘";
    case "memory_buffer":
      return "保存路径：内存合成后浏览器下载";
    case "gm_download":
      return "保存路径：助手直接下载";
    case "browser_native":
      return "保存路径：默认下载目录（浏览器附件直下）";
    default:
      return undefined;
  }
}

export const freeze = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const comparableUrl = (url: string): string => {
  try {
    return new URL(
      url,
      typeof location === "undefined"
        ? "https://dokitool.invalid/"
        : location.href,
    ).href;
  } catch {
    return url;
  }
};

export const clearableUnknown = (task: DownloadTask): boolean =>
  task.transport === "browser_streaming" &&
  task.observation === "unknown" &&
  task.ownerGone === true &&
  task.recoveryExpired === true;

export const clearable = (task: DownloadTask): boolean =>
  clearableUnknown(task) ||
  (!task.observation &&
    [
      "completed",
      "cancelled",
      "failed",
      "handed-off",
      "interrupted",
      "manual",
    ].includes(task.status));

export const checkAbort = (signal: AbortSignal): void => {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
};

/** Settle immediately on cancellation even if a resolver ignores its signal. */
export function abortable<T>(
  request: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return request;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      void request.catch(() => {});
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createTransferMonitor(
  videoStore: ReturnType<typeof useVideoStore>,
  taskFor: (id: number) => DownloadTask | undefined,
  ownsTask: (id: number, controller: AbortController) => boolean,
) {
  return function monitorTransfer(
    id: number,
    controller: AbortController,
    startedAt = Date.now(),
    bytes = true,
  ) {
    let received = 0;
    let sampleBytes = 0;
    let sampleTime = startedAt;
    let lastReceivedAt = startedAt;
    let stopped = false;
    const publish = (finished = false) => {
      if (!ownsTask(id, controller)) return;
      const now = Date.now();
      const elapsed = Math.max(0, (now - startedAt) / 1000);
      const sampleElapsed = Math.max(0.001, (now - sampleTime) / 1000);
      const task = taskFor(id);
      videoStore.updateDownload(id, {
        elapsed,
        speed:
          bytes && !finished ? (received - sampleBytes) / sampleElapsed : 0,
        ...(bytes
          ? {
              transferred: received,
              averageSpeed: received / Math.max(elapsed, 0.001),
            }
          : {}),
        ...(!finished &&
        bytes &&
        task?.status === "downloading" &&
        now - lastReceivedAt >= 3000
          ? { statusText: received ? "等待数据..." : "等待服务器响应..." }
          : {}),
      });
      sampleBytes = received;
      sampleTime = now;
    };
    const timer = setInterval(publish, 500);
    return {
      receive(count: number) {
        received += count;
        lastReceivedAt = Date.now();
      },
      finish() {
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
          publish(true);
        }
      },
    };
  };
}

export function resolveAdaptiveTrackSuffix(
  snapshot: ItemSnapshot,
  variant?: {
    label?: string;
    metadata?: {
      mime_type?: string;
      width?: number;
      height?: number;
      has_audio?: boolean;
      video_codec?: string;
    };
  },
  ext?: string,
): string | undefined {
  return resolveAdaptiveQualityFilenameTag({
    enabled: Boolean(
      snapshot.hasClientHelper || variant?.metadata?.has_audio === false,
    ),
    itemType: snapshot.item.type,
    extension: ext,
    variant,
  });
}

export const filenameFor = (
  snapshot: ItemSnapshot,
  extension: string,
  variant?: {
    label?: string;
    metadata?: {
      mime_type?: string;
      width?: number;
      height?: number;
      has_audio?: boolean;
      video_codec?: string;
    };
  },
): string => {
  const platformFallback =
    snapshot.platform && snapshot.contentId
      ? `${snapshot.platform}_${snapshot.contentId}`
      : "";
  const isSingleItem = snapshot.total <= 1;
  const rawTitle = resolvePreferredMediaTitle({
    isSingleItem,
    isAttachment: snapshot.isAttachment,
    isStandaloneAudioItem: Boolean(
      snapshot.hasClientHelper && snapshot.item.type === "audio",
    ),
    workTitle: snapshot.title,
    itemTitle: snapshot.item.title,
    authorName: snapshot.author,
    fallback: platformFallback,
  });

  return buildMediaFilename({
    title: rawTitle,
    index: isSingleItem ? undefined : snapshot.item.index,
    total: snapshot.total,
    suffix: resolveAdaptiveTrackSuffix(snapshot, variant, extension),
    fallback: platformFallback || snapshot.item.id,
    extension,
  });
};

export function resolveFinalMediaExtension(
  target: Extract<DownloadTarget, { variant: unknown }>,
  item: MediaItem,
  platform?: string,
): { resolvedExt: string; formatMime?: string } {
  const delivery = target.variant.delivery;
  const extension = mediaExtension(
    target.variant.metadata,
    delivery.kind === "mux" || delivery.kind === "pair" ? undefined : delivery,
  );
  const formatMime =
    target.kind === "file"
      ? confirmedFormatMime(target.variant.metadata)
      : undefined;
  const suffixes = extensionsFor(formatMime || "");
  let resolvedExt =
    suffixes.length && !suffixes.includes(extension) ? suffixes[0] : extension;
  if (
    resolvedExt === "bin" &&
    target.kind === "file" &&
    item.type === "video"
  ) {
    resolvedExt =
      inferredVideoFileExtension(
        target.url,
        platform,
        Boolean(item.tbvideo?.vid),
      ) || resolvedExt;
  }
  return { resolvedExt, formatMime };
}

export function createSnapshotHelpers(deps: {
  videoStore: ReturnType<typeof useVideoStore>;
  selection: VideoSelection;
  resolveItem: UseMediaDownloadOptions["resolveItem"];
  apiContext: { apiOrigin: string };
}) {
  const { videoStore, selection, resolveItem, apiContext } = deps;

  const snapshotItem = (
    item: MediaItem,
    choice = selection.selectionFor(item.id),
  ): ItemSnapshot => {
    let pinnedChoice =
      choice ||
      (item.default
        ? {
            variant_id: item.default.variant_id,
            source_id: item.default.source_id,
          }
        : null);
    if (pinnedChoice && !pinnedChoice.source_id && readyItem(item)) {
      const variant = item.variants.find(
        (candidate) => candidate.id === pinnedChoice!.variant_id,
      );
      if (readyVariant(variant) && variant.delivery.kind === "file") {
        const sources = variant.delivery.sources;
        if ((choice || sources.length === 1) && sources[0]?.id) {
          pinnedChoice = { ...pinnedChoice, source_id: sources[0].id };
        }
      }
    }
    return freeze({
      item,
      choice: pinnedChoice,
      pinned: Boolean(choice?.source_id),
      selectionKey: JSON.stringify(choice),
      title: videoStore.resultData?.title,
      author: videoStore.resultData?.author?.name,
      contentId: videoStore.resultData?.content_id,
      total: videoStore.resultData?.items?.length ?? 1,
      platform: videoStore.resultData?.platform,
      hasClientHelper: Boolean(
        (videoStore.resultData?.extra as Record<string, unknown> | undefined)
          ?.youtube_helper,
      ),
      version: videoStore.resultVersion,
    });
  };

  function refreshable(snapshot: ItemSnapshot): boolean {
    if (
      snapshot.resource ||
      !readyItem(snapshot.item) ||
      !snapshot.item.resolve_url ||
      !snapshot.choice?.source_id
    )
      return false;
    const variant = snapshot.item.variants.find(
      (candidate) => candidate.id === snapshot.choice!.variant_id,
    );
    return (
      readyVariant(variant) &&
      variant.delivery.kind === "file" &&
      variant.delivery.sources.some(
        (source) => source.id === snapshot.choice!.source_id,
      )
    );
  }

  function fileSelectionKey(snapshot: ItemSnapshot): string | undefined {
    if (
      snapshot.resource ||
      !readyItem(snapshot.item) ||
      !snapshot.choice?.source_id
    )
      return;
    const variants = snapshot.item.variants.filter(
      (candidate) => candidate.id === snapshot.choice!.variant_id,
    );
    if (variants.length !== 1 || !readyVariant(variants[0])) return;
    const delivery = variants[0].delivery;
    if (
      delivery.kind !== "file" ||
      delivery.sources.filter(
        (source) => source.id === snapshot.choice!.source_id,
      ).length !== 1
    )
      return;
    return JSON.stringify([
      snapshot.version,
      snapshot.item.id,
      snapshot.item.type,
      snapshot.choice.variant_id,
      snapshot.choice.source_id,
    ]);
  }

  function snapshotTarget(
    snapshot: ItemSnapshot,
    item: MediaItem,
  ): DownloadTarget {
    if (!snapshot.resource || !readyItem(item))
      return getDownloadTarget(item, snapshot.choice, apiContext);
    const variant = item.variants.find(
      (candidate) => candidate.id === snapshot.choice?.variant_id,
    );
    if (!readyVariant(variant))
      return getDownloadTarget(item, snapshot.choice, apiContext);
    if (variant.delivery.kind !== "pair")
      return {
        kind: "invalid",
        message: "所选实况版本不再包含配对资源，请重新选择",
      };
    const resource = variant.delivery.resources.find(
      (candidate) =>
        candidate.id === snapshot.resource!.id &&
        candidate.role === snapshot.resource!.role,
    );
    if (!resource)
      return { kind: "invalid", message: "所选实况资源不存在，请重新选择" };
    return getDownloadTarget(
      {
        id: item.id,
        type: resource.role === "image" ? "image" : "video",
        variants: [
          {
            id: variant.id,
            metadata: resource.metadata,
            delivery: resource.delivery,
          },
        ],
        default: null,
        default_unavailable_reason: "processing_required",
      },
      { variant_id: variant.id, source_id: snapshot.resource.source_id },
      apiContext,
    );
  }

  function preparedSnapshot(
    snapshot: ItemSnapshot,
    item: MediaItem,
    target: Extract<DownloadTarget, { variant: unknown }>,
  ): ItemSnapshot {
    const source =
      target.kind === "file" && target.source.id
        ? { source_id: target.source.id }
        : {};
    return freeze({
      ...snapshot,
      item,
      choice: {
        variant_id: target.variant.id,
        ...(!snapshot.resource ? source : {}),
      },
      ...(snapshot.resource
        ? { resource: { ...snapshot.resource, ...source } }
        : {}),
    });
  }

  async function resolvedTarget(
    snapshot: ItemSnapshot,
    signal: AbortSignal,
    refresh = false,
    onRateLimitWait?: (seconds: number) => void,
  ) {
    checkAbort(signal);
    let item = snapshot.item;
    let target = snapshotTarget(snapshot, item);
    if (
      refresh ||
      target.kind === "needs_resolve" ||
      target.kind === "needs_refresh"
    ) {
      if (refresh && !refreshable(snapshot))
        throw new Error("原任务缺少可核对的刷新入口，请重新解析并选择");
      const deadline = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const resetDeadline = () => {
        clearTimeout(timeout);
        timeout = setTimeout(
          () => deadline.abort(new Error("解析准备超过 30 秒，请重试")),
          30000,
        );
      };
      resetDeadline();
      const linked = linkAbortSignals([signal, deadline.signal]);
      const combined = linked.signal;
      const notifyWait = (seconds: number) => {
        resetDeadline();
        onRateLimitWait?.(seconds);
      };
      try {
        item = await abortable(
          withRateLimitRetry(
            () => resolveItem(item, combined, { onRateLimitWait: notifyWait }),
            combined,
            notifyWait,
          ),
          combined,
        );
      } catch (error) {
        if (deadline.signal.aborted && !signal.aborted)
          throw deadline.signal.reason;
        throw error;
      } finally {
        clearTimeout(timeout);
        linked.dispose();
      }
      checkAbort(signal);
      if (item.id !== snapshot.item.id || item.type !== snapshot.item.type)
        throw new Error("刷新响应与原作品不一致，请重新解析并选择");
      target = snapshotTarget(snapshot, item);
      if (refresh && target.kind !== "file" && "variant" in target)
        throw new Error("原版本不再是完整文件，请重新选择");
    }
    if (!("variant" in target)) throw new Error(target.message);
    return { item, target };
  }

  return {
    snapshotItem,
    refreshable,
    fileSelectionKey,
    snapshotTarget,
    preparedSnapshot,
    resolvedTarget,
  };
}
