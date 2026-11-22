import JSZip from "jszip";
import { confirmedFormatMime, extensionsFor } from "../downloads/file";
import type {
  Attachment,
  Chunk,
  LeafDelivery,
  MediaItem,
  MediaSelection,
  ReadyVariant,
  Resource,
  Source,
  UnifiedMedia,
} from "../types/media";
import {
  availableSources,
  deliveryRoutes,
  getDefaultDownloadTarget,
  getDownloadTarget,
  readyItem,
  readyVariant,
  sourceRoutes,
  sourceUrl,
  type DownloadTarget,
  type TargetContext,
} from "../utils/mediaContract";
import { mediaExtension } from "../utils/mediaDelivery";
import {
  YOUTUBE_OPFS_TEMP_PREFIX,
  cleanupLeftoverYouTubeOpfsTempFiles,
  isValidGooglevideoPlaybackUrl,
  selectYouTubeMuxPair,
  type YouTubeHelperPlayerPayload,
  type YouTubeHelperPlayerResult,
} from "../utils/youtubeHelperCore";
import { executeDashMux } from "./dashMuxDownload";
import {
  computeEarliestExpiresAtMs,
  extractDashMuxSpec,
  extractVariantEarliestExpiresAtMs,
} from "./dashMuxSpec";
import {
  MAX_FOLDER_CODE_POINTS,
  buildSafeDownloadPath,
  formatBatchItemIndex,
  sanitizeFilenameSegment,
} from "./filenameSanitizer";
import { validateApiBaseUrl } from "./hostWhitelist";
import {
  ExtensionDownloadError,
  assertWhitelistedUrl,
  buildEffectiveExtraOrigins,
  ensureOpfsQuotaAvailable,
  hasIsoBmffBoxHeader,
  isAbortLikeError,
  resolveBlobMimeType,
  streamResponseBodyToWriter,
  streamResumableRouteToOpfs,
  throwIfAborted,
  whitelistedFetch,
  type OpfsDirectoryLike,
  type OpfsSinkLike,
  type OpfsStorageLike,
  type OpfsWritableLike,
  type WebLocksLike,
} from "./opfsStreamTransfer";
import {
  EXTENSION_OPFS_TEMP_PREFIX,
  type BatchSaveMode,
  type EnqueueDownloadItem,
  type HandOffBlobDownloadResult,
  type MediaRefreshContext,
  type OffscreenDashMuxSpec,
  type OffscreenDownloadSpec,
  type OffscreenSegmentSpec,
  type OffscreenToBackgroundMessage,
  type OffscreenZipEntrySpec,
  type QualityPreference,
} from "./protocol";
import { buildWorkFingerprint } from "./storage";
import {
  createYouTubeExtensionBridge,
  type UrlObjectApiLike,
} from "./youtubeExtensionBridge";

export {
  extractDashMuxSpec,
  extractDashMuxSpec as extractFileMuxSpec,
} from "./dashMuxSpec";
export {
  ExtensionDownloadError,
  ensureOpfsQuotaAvailable,
  hasIsoBmffBoxHeader,
  resolveBlobMimeType,
  streamResumableRouteToOpfs,
  whitelistedFetch,
  type OpfsStorageLike,
  type WebLocksLike,
} from "./opfsStreamTransfer";

export const MAX_BATCH_ZIP_BYTES = 500 * 1024 * 1024;
export const ARCHIVE_LIMIT_ERROR =
  "打包总大小超过 500 MB 上限，请分批或单文件下载";
export const DEFAULT_OFFSCREEN_CONCURRENCY = 3;
export const DEFAULT_PROGRESS_THROTTLE_MS = 150;

export type LivePhotoSaveMode = "both" | "video" | "motion" | "image";

export interface SelectedVariantPlan {
  variant: ReadyVariant;
  target: DownloadTarget;
  isAudioOnly: boolean;
  attachmentId?: string;
  youtubeMux?: {
    videoUrl: string;
    audioUrl: string;
    videoSize?: number;
    audioSize?: number;
    videoSource?: Source;
    audioSource?: Source;
    outputContainer: "mp4" | "webm";
  };
  dashMux?: OffscreenDashMuxSpec;
}

export function videoCodecPreferenceRank(rawCodec: unknown): number {
  if (typeof rawCodec !== "string") return 0;
  const lower = rawCodec.trim().toLowerCase();
  if (!lower) return 0;
  if (
    lower === "h264" ||
    lower === "h.264" ||
    lower === "avc" ||
    lower === "avc1" ||
    lower.startsWith("avc1.") ||
    lower === "avc3" ||
    lower.startsWith("avc3.")
  ) {
    return 3;
  }
  if (
    lower === "hevc" ||
    lower === "h265" ||
    lower === "h.265" ||
    lower === "hev1" ||
    lower.startsWith("hev1.") ||
    lower === "hvc1" ||
    lower.startsWith("hvc1.")
  ) {
    return 2;
  }
  if (lower === "av1" || lower === "av01" || lower.startsWith("av01.")) {
    return 1;
  }
  return 0;
}

function resolveVariantVideoCodec(variant: ReadyVariant): string {
  const top = variant.metadata?.video_codec;
  if (typeof top === "string" && top.trim()) return top.trim();
  if (variant.delivery.kind === "mux") {
    const vRes = variant.delivery.resources.find((r) => r.role === "video");
    if (vRes?.metadata?.video_codec?.trim()) {
      return vRes.metadata.video_codec.trim();
    }
  }
  return "";
}

function inferShortEdgeFromLabel(label?: string): number {
  if (typeof label !== "string" || !label.trim()) return 0;
  const lower = label.trim().toLowerCase();
  if (lower.includes("8k") || lower.includes("4320")) return 4320;
  if (lower.includes("4k") || lower.includes("2160")) return 2160;
  if (lower.includes("2k") || lower.includes("1440")) return 1440;
  const pMatch = /(\d{3,4})p\b/i.exec(lower);
  if (pMatch) return Number(pMatch[1]) || 0;
  if (lower.includes("hd") || lower.includes("高清")) return 720;
  if (lower.includes("sd") || lower.includes("标清")) return 480;
  if (lower.includes("ld") || lower.includes("流畅")) return 360;
  return 0;
}

function isStandaloneAudioVariant(variant: ReadyVariant): boolean {
  const meta = variant.metadata;
  if (!meta) return false;
  const mime = (meta.mime_type || "").trim().toLowerCase();
  const ext = (meta.extension || meta.container || "").trim().toLowerCase();
  return (
    meta.has_audio === true &&
    !meta.video_codec &&
    !meta.width &&
    !meta.height &&
    (mime.startsWith("audio/") ||
      ext === "m4a" ||
      ext === "mp3" ||
      ext === "webm")
  );
}

function isDubbedAudioVariant(variant: ReadyVariant): boolean {
  const role = (variant.metadata?.audio_language_role || "").toLowerCase();
  const label = variant.label || "";
  return (
    role === "alternate" ||
    /dubbed|auto-dubbed|配音|descriptive|description/i.test(label)
  );
}

interface ScoredCandidate {
  plan: SelectedVariantPlan;
  shortEdge: number;
  pixelArea: number;
  fps: number;
  codecRank: number;
  bitrate: number;
  hasPlayableAudio: boolean;
  isOriginalProvenance: boolean;
  isDirectFile: boolean;
  isDefault: boolean;
}

function compareScoredCandidatesDesc(
  a: ScoredCandidate,
  b: ScoredCandidate,
): number {
  if (a.hasPlayableAudio !== b.hasPlayableAudio) {
    return a.hasPlayableAudio ? -1 : 1;
  }
  if (a.shortEdge !== b.shortEdge) {
    return b.shortEdge - a.shortEdge;
  }
  if (a.pixelArea !== b.pixelArea) {
    return b.pixelArea - a.pixelArea;
  }
  if (a.fps !== b.fps) {
    return b.fps - a.fps;
  }
  if (a.isOriginalProvenance !== b.isOriginalProvenance) {
    return a.isOriginalProvenance ? -1 : 1;
  }
  if (a.codecRank !== b.codecRank) {
    return b.codecRank - a.codecRank;
  }
  if (a.bitrate !== b.bitrate) {
    return b.bitrate - a.bitrate;
  }
  if (a.isDirectFile !== b.isDirectFile) {
    return a.isDirectFile ? -1 : 1;
  }
  if (a.isDefault !== b.isDefault) {
    return a.isDefault ? -1 : 1;
  }
  return 0;
}

/**
 * Selects the optimal playable/downloadable variant for a `MediaItem` according
 * to the user's `QualityPreference` (`"best" | "1080p" | "audio"`), including
 * YouTube 4K60 video+audio mux pair resolution and attachment audio fallback.
 */
export function selectVariantByPreference(
  item: MediaItem,
  attachments: Attachment[] | undefined,
  qualityPreference: QualityPreference,
  apiOrigin: string,
  now?: number,
): SelectedVariantPlan | null {
  if (!readyItem(item)) {
    return null;
  }
  const context: TargetContext = now !== undefined ? { apiOrigin, now } : { apiOrigin };
  const readyVariants = item.variants.filter(readyVariant);

  // 1. Image / LivePhoto items always resolve as visual items even when qualityPreference === "audio"
  if (item.type === "live_photo") {
    for (const variant of readyVariants) {
      if (variant.delivery.kind === "pair") {
        const target = getDownloadTarget(
          item,
          { variant_id: variant.id },
          context,
        );
        if ("variant" in target) {
          return { variant, target, isAudioOnly: false };
        }
      }
    }
  }

  if (item.type === "image" || item.type === "live_photo") {
    const defTarget = getDefaultDownloadTarget(item, context);
    if ("variant" in defTarget) {
      return {
        variant: defTarget.variant,
        target: defTarget,
        isAudioOnly: false,
      };
    }
    for (const variant of readyVariants) {
      const target = getDownloadTarget(
        item,
        { variant_id: variant.id },
        context,
      );
      if ("variant" in target) {
        return { variant, target, isAudioOnly: false };
      }
    }
    return null;
  }

  // 2. Standalone audio preference ("audio")
  if (qualityPreference === "audio") {
    const audioPlans: Array<{
      plan: SelectedVariantPlan;
      prefersM4a: boolean;
      notDubbed: boolean;
      bitrate: number;
    }> = [];

    for (const variant of readyVariants) {
      if (item.type !== "audio" && !isStandaloneAudioVariant(variant)) {
        continue;
      }
      const target = getDownloadTarget(
        item,
        { variant_id: variant.id },
        context,
      );
      if (!("variant" in target)) continue;
      const ext = (
        variant.metadata?.extension ||
        variant.metadata?.container ||
        ""
      ).toLowerCase();
      const mime = (variant.metadata?.mime_type || "").toLowerCase();
      audioPlans.push({
        plan: { variant, target, isAudioOnly: true },
        prefersM4a:
          ext === "m4a" ||
          mime === "audio/mp4" ||
          (variant.metadata?.audio_codec || "").toLowerCase().startsWith("mp4a") ||
          (variant.metadata?.audio_codec || "").toLowerCase() === "aac",
        notDubbed: !isDubbedAudioVariant(variant),
        bitrate:
          variant.metadata?.audio_bitrate_bps ||
          variant.metadata?.bitrate_bps ||
          0,
      });
    }

    const seenAttachmentAudioUrls = new Set<string>();
    const appendAttachmentAudioPlan = (att: Attachment) => {
      if (
        (att?.role === "background_audio" || att?.resource?.role === "audio") &&
        att.resource?.delivery?.kind === "file"
      ) {
        const avail = availableSources(att.resource.delivery.sources, context.now);
        if (!avail.length) return;
        const syntheticVariant: ReadyVariant = {
          id: att.id || `att-${att.resource.id || "audio"}`,
          state: "ready",
          label: att.title || "原声轨",
          metadata: att.resource.metadata,
          delivery: att.resource.delivery,
        };
        const syntheticItem: MediaItem = {
          id: item.id,
          type: "audio",
          title: att.title || item.title,
          variants: [syntheticVariant],
          default: null,
          default_unavailable_reason: "processing_required",
        };
        const target = getDownloadTarget(
          syntheticItem,
          { variant_id: syntheticVariant.id },
          context,
        );
        if (!("variant" in target)) return;
        if (target.kind === "file" && target.url) {
          if (seenAttachmentAudioUrls.has(target.url)) return;
          seenAttachmentAudioUrls.add(target.url);
        }
        const ext = (
          syntheticVariant.metadata?.extension ||
          syntheticVariant.metadata?.container ||
          ""
        ).toLowerCase();
        const mime = (syntheticVariant.metadata?.mime_type || "").toLowerCase();
        audioPlans.push({
          plan: {
            variant: syntheticVariant,
            target,
            isAudioOnly: true,
            ...(att.id ? { attachmentId: att.id } : {}),
          },
          prefersM4a: ext === "m4a" || mime === "audio/mp4" || ext === "mp3",
          notDubbed: true,
          bitrate:
            syntheticVariant.metadata?.audio_bitrate_bps ||
            syntheticVariant.metadata?.bitrate_bps ||
            0,
        });
      }
    };

    for (const att of attachments ?? []) {
      const attId = typeof att?.id === "string" ? att.id.trim() : "";
      // Part-scoped Bilibili DASH audio attachments must strictly match this episode's item.id
      if (
        attId.startsWith("bilibili-audio-") &&
        attId !== `bilibili-audio-${item.id}`
      ) {
        continue;
      }
      appendAttachmentAudioPlan(att);
    }

    // Authoritative fallback: also inspect this episode's own ready mux variants'
    // audio leaf so multi-P Bilibili (or any DASH mux episode) always picks its own
    // part-specific audio stream even if media.attachments only holds another part.
    for (const variant of readyVariants) {
      if (variant.delivery.kind !== "mux") continue;
      for (const res of variant.delivery.resources) {
        if (res.role !== "audio" || res.delivery.kind !== "file") continue;
        appendAttachmentAudioPlan({
          id: `mux-audio-${item.id}`,
          role: "background_audio",
          title: "原声音频 (M4A)",
          resource: res,
        });
      }
    }

    if (audioPlans.length > 0) {
      audioPlans.sort((a, b) => {
        if (a.notDubbed !== b.notDubbed) return a.notDubbed ? -1 : 1;
        if (a.prefersM4a !== b.prefersM4a) return a.prefersM4a ? -1 : 1;
        return b.bitrate - a.bitrate;
      });
      return audioPlans[0].plan;
    }
    // Fall through to default/best when the work has no standalone audio stream
  }

  // 3. Video (and fallback audio) ranking for "best" and "1080p"
  const candidates: ScoredCandidate[] = [];
  for (const variant of readyVariants) {
    if (item.type !== "audio" && isStandaloneAudioVariant(variant)) {
      continue;
    }
    const dashMux = extractDashMuxSpec(variant, context);
    const target = getDownloadTarget(item, { variant_id: variant.id }, context);
    if (!("variant" in target) && !dashMux) {
      continue;
    }

    const videoLeafMeta =
      variant.delivery.kind === "mux"
        ? variant.delivery.resources.find((r) => r.role === "video")?.metadata
        : undefined;
    const meta = variant.metadata;
    const rawW = meta?.width || videoLeafMeta?.width || 0;
    const rawH = meta?.height || videoLeafMeta?.height || 0;
    const w = rawW > 0 ? rawW : 0;
    const h = rawH > 0 ? rawH : 0;
    const shortEdge =
      w > 0 && h > 0
        ? Math.min(w, h)
        : h || w || inferShortEdgeFromLabel(variant.label);
    const pixelArea = w > 0 && h > 0 ? w * h : shortEdge * shortEdge;
    const rawFps = meta?.fps || videoLeafMeta?.fps || 0;
    const fps = rawFps > 0 ? rawFps : 0;
    const bitrate =
      meta?.bitrate_bps ||
      meta?.video_bitrate_bps ||
      videoLeafMeta?.video_bitrate_bps ||
      videoLeafMeta?.bitrate_bps ||
      0;
    const codecRank = videoCodecPreferenceRank(
      resolveVariantVideoCodec(variant),
    );

    let hasPlayableAudio = dashMux ? true : meta?.has_audio !== false;
    let youtubeMux: SelectedVariantPlan["youtubeMux"];

    if (
      !dashMux &&
      meta?.has_audio === false &&
      target.kind === "file" &&
      isValidGooglevideoPlaybackUrl(target.url)
    ) {
      const pair = selectYouTubeMuxPair(variant, item.variants, attachments);
      if (pair.ok) {
        hasPlayableAudio = true;
        youtubeMux = {
          videoUrl: target.url,
          audioUrl: sourceUrl(pair.audioSource, context),
          videoSize: target.source.size_bytes,
          audioSize: pair.audioSource.size_bytes,
          videoSource: target.source,
          audioSource: pair.audioSource,
          outputContainer: pair.outputContainer,
        };
      }
    }

    candidates.push({
      plan: {
        variant,
        target,
        isAudioOnly: item.type === "audio",
        ...(youtubeMux ? { youtubeMux } : {}),
        ...(dashMux ? { dashMux } : {}),
      },
      shortEdge,
      pixelArea,
      fps,
      codecRank,
      bitrate,
      hasPlayableAudio,
      isOriginalProvenance: variant.provenance === "original_endpoint",
      isDirectFile: variant.delivery.kind === "file",
      isDefault: item.default?.variant_id === variant.id,
    });
  }

  if (candidates.length === 0) {
    const defTarget = getDefaultDownloadTarget(item, context);
    if ("variant" in defTarget) {
      return {
        variant: defTarget.variant,
        target: defTarget,
        isAudioOnly: item.type === "audio",
      };
    }
    return null;
  }

  if (qualityPreference === "1080p") {
    const within1080 = candidates.filter(
      (c) => c.shortEdge > 0 && c.shortEdge <= 1080,
    );
    if (within1080.length > 0) {
      within1080.sort(compareScoredCandidatesDesc);
      return within1080[0].plan;
    }
    const unknownRes = candidates.filter((c) => c.shortEdge === 0);
    if (unknownRes.length > 0) {
      unknownRes.sort(compareScoredCandidatesDesc);
      return unknownRes[0].plan;
    }
    // All variants are > 1080p: pick the closest one above 1080p with playable audio
    const above = [...candidates].sort((a, b) => {
      if (a.hasPlayableAudio !== b.hasPlayableAudio) {
        return a.hasPlayableAudio ? -1 : 1;
      }
      if (a.shortEdge !== b.shortEdge) {
        return a.shortEdge - b.shortEdge;
      }
      return compareScoredCandidatesDesc(a, b);
    });
    return above[0].plan;
  }

  candidates.sort(compareScoredCandidatesDesc);
  return candidates[0].plan;
}

function inferExtensionVideoExtFromUrl(
  rawUrl: string,
  platform?: string,
  hasTbvideo = false,
): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    const queryMime = (parsed.searchParams.get("mime_type") || "")
      .trim()
      .toLowerCase();
    if (queryMime === "video_mp4" || queryMime === "video/mp4") return "mp4";
    if (queryMime === "video_webm" || queryMime === "video/webm") return "webm";
    if (queryMime === "video_quicktime" || queryMime === "video/quicktime") {
      return "mov";
    }
    if (queryMime) return undefined;

    const pathMatch = /\.([a-z0-9]{2,5})$/i.exec(parsed.pathname);
    if (pathMatch) {
      const ext = pathMatch[1].toLowerCase();
      if (ext === "mp4" || ext === "m4v") return "mp4";
      if (ext === "webm" || ext === "mov" || ext === "mkv") return ext;
      return undefined;
    }

    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (host.endsWith(".toutiaovod.com") && parsed.pathname.length > 1) {
      return "mp4";
    }
    if (
      hasTbvideo ||
      ((platform === "zuiyou" || platform === "pipigx") &&
        (host.endsWith(".izuiyou.com") ||
          host === "tbvideo.ixiaochuan.cn" ||
          host.endsWith(".szsttkj.com")))
    ) {
      return "mp4";
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveExtensionForTarget(
  target: Extract<DownloadTarget, { variant: ReadyVariant }>,
  item: MediaItem,
  platform: string,
  isAudioOnly: boolean,
): { ext: string; mimeType?: string } {
  const delivery = target.variant.delivery;
  const baseExt = mediaExtension(
    target.variant.metadata,
    delivery.kind === "mux" || delivery.kind === "pair" ? undefined : delivery,
  );
  const formatMime =
    target.kind === "file"
      ? confirmedFormatMime(target.variant.metadata)
      : undefined;
  const suffixes = extensionsFor(formatMime || "");
  let resolvedExt =
    suffixes.length && !suffixes.includes(baseExt) ? suffixes[0] : baseExt;

  if (resolvedExt === "bin") {
    if (isAudioOnly || item.type === "audio") {
      resolvedExt = "m4a";
    } else if (item.type === "image") {
      resolvedExt = "jpg";
    } else if (target.kind === "file") {
      resolvedExt =
        inferExtensionVideoExtFromUrl(
          target.url,
          platform,
          Boolean(item.tbvideo?.vid),
        ) || "mp4";
    } else {
      resolvedExt = "mp4";
    }
  }

  const mimeType =
    formatMime ||
    target.variant.metadata?.mime_type ||
    (delivery.kind !== "file" &&
    delivery.kind !== "pair" &&
    "output" in delivery
      ? delivery.output?.mime_type
      : undefined);

  return { ext: resolvedExt, mimeType };
}

function buildFileRoutesWithTbvideoFallback(
  target: Extract<DownloadTarget, { kind: "file" }>,
  item: MediaItem,
  platform: string,
): string[] {
  const routes = [...target.routes];
  const tbvideo = item.tbvideo;
  if (
    item.type === "video" &&
    (platform === "zuiyou" || platform === "pipigx") &&
    tbvideo?.platform === platform
  ) {
    const sourceId = target.source.id;
    const candidate =
      sourceId && Object.hasOwn(tbvideo.sources, sourceId)
        ? tbvideo.sources[sourceId]
        : Object.values(tbvideo.sources)[0];
    if (candidate && !routes.includes(candidate)) {
      routes.push(candidate);
    }
  }
  return routes;
}

function buildSegmentSpecsFromDelivery(
  delivery: Extract<LeafDelivery, { kind: "segments" }>,
  context: TargetContext,
): OffscreenSegmentSpec[] {
  if (
    delivery.join !== "byte_concat" ||
    delivery.join_evidence !== "validated_fragment_layout"
  ) {
    throw new Error("该分段版本需要重封装，当前暂不支持");
  }
  const chunks: Chunk[] = [
    ...(delivery.init ? [delivery.init] : []),
    ...delivery.pieces,
  ];
  return chunks.map((chunk) => {
    const routes = deliveryRoutes(chunk.sources, context);
    if (!routes.length) {
      throw new Error("分段资源缺少可用下载线路");
    }
    return {
      url: routes[0],
      ...(routes.length > 1 ? { routes } : {}),
      ...(chunk.byte_range
        ? {
            start: chunk.byte_range.start,
            length: chunk.byte_range.end_inclusive - chunk.byte_range.start + 1,
          }
        : {}),
    };
  });
}

export interface BuildEnqueueItemsOptions {
  apiOrigin: string;
  qualityPreference?: QualityPreference;
  subfolderPrefix?: string;
  batchSaveMode?: BatchSaveMode;
  itemIds?: string[];
  variantSelections?: Record<string, MediaSelection>;
  livePhotoMode?: LivePhotoSaveMode;
  forceSubfolder?: boolean;
  extraAllowedOrigins?: string[];
  sourceUrl?: string;
  now?: number;
}

interface PreparedLeafItem {
  title: string;
  entryStem?: string;
  index?: number;
  totalCount: number;
  ext: string;
  mimeType?: string;
  sizeBytes?: number;
  fallbackUrl?: string;
  specKind: Exclude<OffscreenDownloadSpec["kind"], "batch_zip">;
  routes: string[];
  segments?: OffscreenSegmentSpec[];
  youtubeMux?: OffscreenDownloadSpec["youtubeMux"];
  dashMux?: OffscreenDownloadSpec["dashMux"];
  refreshContext?: MediaRefreshContext;
}

function prepareResourceLeaf(params: {
  resource: Resource;
  context: TargetContext;
  title: string;
  entryStem?: string;
  index?: number;
  totalCount: number;
  fallbackUrl?: string;
  baseRefreshContext?: Omit<MediaRefreshContext, "expiresAtMs">;
}): PreparedLeafItem {
  const { resource, context, baseRefreshContext } = params;
  const delivery = resource.delivery;
  const ext =
    mediaExtension(resource.metadata, delivery) !== "bin"
      ? mediaExtension(resource.metadata, delivery)
      : resource.role === "image"
        ? "jpg"
        : resource.role === "audio"
          ? "m4a"
          : "mp4";
  const mimeType = resource.metadata?.mime_type;

  const withExpiry = (sources: Source[]): MediaRefreshContext | undefined => {
    if (!baseRefreshContext) return undefined;
    const expiresAtMs = computeEarliestExpiresAtMs(sources);
    return {
      ...baseRefreshContext,
      ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    };
  };

  if (delivery.kind === "file") {
    const avail = availableSources(delivery.sources, context.now);
    const routes = deliveryRoutes(avail, context);
    if (!routes.length) {
      throw new Error("实况资源没有可用来源");
    }
    return {
      title: params.title,
      entryStem: params.entryStem,
      index: params.index,
      totalCount: params.totalCount,
      ext,
      mimeType,
      sizeBytes: avail[0]?.size_bytes,
      fallbackUrl: params.fallbackUrl || routes[0],
      specKind: "direct_file",
      routes,
      refreshContext: withExpiry(avail),
    };
  }

  if (delivery.kind === "hls") {
    if (delivery.scope !== "single") {
      throw new Error("自适应 HLS 暂不支持直接合并");
    }
    const avail = availableSources(delivery.sources, context.now);
    const routes = deliveryRoutes(avail, context);
    if (!routes.length) {
      throw new Error("HLS 资源没有可用来源");
    }
    return {
      title: params.title,
      entryStem: params.entryStem,
      index: params.index,
      totalCount: params.totalCount,
      ext,
      mimeType,
      fallbackUrl: params.fallbackUrl || routes[0],
      specKind: "hls",
      routes,
      refreshContext: withExpiry(avail),
    };
  }

  if (delivery.kind === "segments") {
    const segments = buildSegmentSpecsFromDelivery(delivery, context);
    const segSources: Source[] = [
      ...(delivery.init?.sources ?? []),
      ...delivery.pieces.flatMap((p) => p.sources),
    ];
    return {
      title: params.title,
      entryStem: params.entryStem,
      index: params.index,
      totalCount: params.totalCount,
      ext,
      mimeType,
      fallbackUrl: params.fallbackUrl || segments[0]?.url,
      specKind: "segments",
      routes: segments[0]?.routes ?? (segments[0]?.url ? [segments[0].url] : []),
      segments,
      refreshContext: withExpiry(availableSources(segSources, context.now)),
    };
  }

  throw new Error("当前暂不支持 DASH 实况流下载");
}

/**
 * Converts a parsed `UnifiedMedia` response into one or more `EnqueueDownloadItem`s
 * ready for `ENQUEUE_DOWNLOADS` / `OFFSCREEN_START_TASK`.
 */
export function buildEnqueueItemsForMedia(
  media: UnifiedMedia,
  options: BuildEnqueueItemsOptions,
): EnqueueDownloadItem[] {
  const validatedApi = validateApiBaseUrl(options.apiOrigin);
  const apiOrigin = validatedApi.ok ? validatedApi.origin : options.apiOrigin;
  const context: TargetContext =
    options.now !== undefined ? { apiOrigin, now: options.now } : { apiOrigin };
  const qualityPreference = options.qualityPreference ?? "best";
  const batchSaveMode = options.batchSaveMode ?? "subfolder";
  const livePhotoMode = options.livePhotoMode ?? "both";
  const extraAllowedOrigins = buildEffectiveExtraOrigins(
    apiOrigin,
    options.extraAllowedOrigins,
  );

  const selectedIdSet =
    options.itemIds && options.itemIds.length > 0
      ? new Set(options.itemIds)
      : null;

  const candidateItems = media.items.filter((item) =>
    selectedIdSet ? selectedIdSet.has(item.id) : readyItem(item),
  );

  if (candidateItems.length === 0) {
    const firstUnavailable = media.items.find(
      (item) => item.state === "unavailable",
    );
    if (firstUnavailable && firstUnavailable.state === "unavailable") {
      throw new Error(firstUnavailable.error.message || "当前作品暂无可下载资源");
    }
    throw new Error("当前作品没有可下载的就绪条目");
  }

  const rawWorkTitle =
    media.title?.trim() ||
    candidateItems.find((i) => i.title?.trim())?.title?.trim() ||
    media.author?.name?.trim() ||
    media.content_id?.trim() ||
    media.platform ||
    "download";

  const workFingerprint = buildWorkFingerprint(media) || undefined;
  const isMultiItemCollection =
    media.items.length > 1 ||
    candidateItems.length > 1 ||
    Boolean(media.groups && media.groups.length > 0);

  const leaves: PreparedLeafItem[] = [];
  const totalCount = Math.max(media.items.length, candidateItems.length);
  const usedItemNumbers = new Set<number>();

  for (let i = 0; i < candidateItems.length; i++) {
    const item = candidateItems[i];
    if (!readyItem(item)) {
      if (item.state === "unavailable") {
        throw new Error(item.error.message);
      }
      throw new Error("部分分P或条目尚未完成解析，请先解析该条目");
    }

    const explicitChoice = options.variantSelections?.[item.id];
    let plan: SelectedVariantPlan | null = null;

    if (explicitChoice) {
      const target = getDownloadTarget(item, explicitChoice, context);
      const explicitVariant = item.variants.find(
        (v): v is ReadyVariant =>
          readyVariant(v) && v.id === explicitChoice.variant_id,
      );
      const explicitDashMux = explicitVariant
        ? extractDashMuxSpec(explicitVariant, context)
        : null;

      if (!("variant" in target)) {
        if (explicitVariant && explicitDashMux) {
          plan = {
            variant: explicitVariant,
            target,
            isAudioOnly: false,
            dashMux: explicitDashMux,
          };
        } else {
          throw new Error(target.message);
        }
      } else {
        const isAudioOnly =
          item.type === "audio" || isStandaloneAudioVariant(target.variant);
        let youtubeMux: SelectedVariantPlan["youtubeMux"];
        if (
          target.variant.metadata?.has_audio === false &&
          target.kind === "file" &&
          isValidGooglevideoPlaybackUrl(target.url)
        ) {
          const pair = selectYouTubeMuxPair(
            target.variant,
            item.variants,
            media.attachments,
          );
          if (pair.ok) {
            youtubeMux = {
              videoUrl: target.url,
              audioUrl: sourceUrl(pair.audioSource, context),
              videoSize: target.source.size_bytes,
              audioSize: pair.audioSource.size_bytes,
              videoSource: target.source,
              audioSource: pair.audioSource,
              outputContainer: pair.outputContainer,
            };
          }
        }
        plan = {
          variant: target.variant,
          target,
          isAudioOnly,
          ...(youtubeMux ? { youtubeMux } : {}),
        };
      }
    } else {
      plan = selectVariantByPreference(
        item,
        media.attachments,
        qualityPreference,
        apiOrigin,
        options.now,
      );
    }

    if (!plan) {
      throw new Error("未找到可下载的清晰度或媒体来源");
    }

    const rawIndex =
      typeof item.index === "number" &&
      Number.isInteger(item.index) &&
      item.index >= 1
        ? item.index
        : i + 1;
    let itemNumber = rawIndex;
    if (usedItemNumbers.has(itemNumber)) {
      itemNumber = i + 1;
      while (usedItemNumbers.has(itemNumber)) {
        itemNumber += 1;
      }
    }
    usedItemNumbers.add(itemNumber);
    const distinctEpisodeTitle =
      item.title?.trim() && item.title.trim() !== media.title?.trim()
        ? item.title.trim()
        : undefined;
    const itemDisplayTitle = item.title?.trim() || rawWorkTitle;
    const fallbackUrl = item.source_url || media.source_url;
    const parseUrlForItem =
      item.source_url?.trim() ||
      media.source_url?.trim() ||
      options.sourceUrl?.trim() ||
      "";
    const resolveUrlForItem = item.resolve_url?.trim() || undefined;
    const baseRefreshContext: Omit<MediaRefreshContext, "expiresAtMs"> | undefined =
      parseUrlForItem || resolveUrlForItem
        ? {
            parseUrl: parseUrlForItem,
            platform: media.platform,
            itemId: item.id,
            ...(plan.attachmentId
              ? { attachmentId: plan.attachmentId }
              : { variantId: plan.variant.id }),
            ...(resolveUrlForItem ? { resolveUrl: resolveUrlForItem } : {}),
          }
        : undefined;
    const buildLeafRefreshContext = (
      expiresAtMs?: number,
    ): MediaRefreshContext | undefined =>
      baseRefreshContext
        ? {
            ...baseRefreshContext,
            ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
          }
        : undefined;

    // Live Photo pair handling
    if (
      plan.target.kind === "pair" &&
      plan.variant.delivery.kind === "pair"
    ) {
      const motionRes = plan.variant.delivery.resources.find(
        (r) => r.role === "motion" || r.role === "video",
      );
      const imageRes = plan.variant.delivery.resources.find(
        (r) => r.role === "image",
      );
      if (livePhotoMode === "both") {
        if (motionRes) {
          leaves.push(
            prepareResourceLeaf({
              resource: motionRes,
              context,
              title: `${itemDisplayTitle} (实况视频)`,
              entryStem: "motion",
              index: itemNumber,
              totalCount,
              fallbackUrl,
              baseRefreshContext,
            }),
          );
        }
        if (imageRes) {
          leaves.push(
            prepareResourceLeaf({
              resource: imageRes,
              context,
              title: `${itemDisplayTitle} (实况封面)`,
              entryStem: "cover",
              index: itemNumber,
              totalCount,
              fallbackUrl,
              baseRefreshContext,
            }),
          );
        }
      } else if (
        (livePhotoMode === "video" || livePhotoMode === "motion") &&
        motionRes
      ) {
        leaves.push(
          prepareResourceLeaf({
            resource: motionRes,
            context,
            title: itemDisplayTitle,
            entryStem: distinctEpisodeTitle,
            index: isMultiItemCollection ? itemNumber : undefined,
            totalCount,
            fallbackUrl,
            baseRefreshContext,
          }),
        );
      } else if (livePhotoMode === "image" && imageRes) {
        leaves.push(
          prepareResourceLeaf({
            resource: imageRes,
            context,
            title: itemDisplayTitle,
            entryStem: distinctEpisodeTitle,
            index: isMultiItemCollection ? itemNumber : undefined,
            totalCount,
            fallbackUrl,
            baseRefreshContext,
          }),
        );
      }
      continue;
    }

    // YouTube 4K60 video+audio mux pair
    if (plan.youtubeMux) {
      const totalBytes =
        (plan.youtubeMux.videoSize || 0) + (plan.youtubeMux.audioSize || 0) ||
        undefined;
      const ytExpiresAtMs = computeEarliestExpiresAtMs([
        plan.youtubeMux.videoSource,
        plan.youtubeMux.audioSource,
      ]);
      leaves.push({
        title: itemDisplayTitle,
        entryStem: isMultiItemCollection ? distinctEpisodeTitle : rawWorkTitle,
        index: isMultiItemCollection ? itemNumber : undefined,
        totalCount,
        ext: plan.youtubeMux.outputContainer,
        mimeType: `video/${plan.youtubeMux.outputContainer}`,
        sizeBytes: totalBytes,
        fallbackUrl: fallbackUrl || plan.youtubeMux.videoUrl,
        specKind: "youtube_mux",
        routes: [plan.youtubeMux.videoUrl],
        youtubeMux: {
          videoUrl: plan.youtubeMux.videoUrl,
          audioUrl: plan.youtubeMux.audioUrl,
          ...(plan.youtubeMux.videoSize
            ? { videoSize: plan.youtubeMux.videoSize }
            : {}),
          ...(plan.youtubeMux.audioSize
            ? { audioSize: plan.youtubeMux.audioSize }
            : {}),
          outputContainer: plan.youtubeMux.outputContainer,
        },
        refreshContext: buildLeafRefreshContext(ytExpiresAtMs),
      });
      continue;
    }

    // Generic lossless DASH video+audio mux (e.g. Bilibili 1080p/4K AVC/HEVC/AV1 + AAC)
    if (plan.dashMux) {
      const exactTotalBytes =
        (plan.dashMux.videoSize || 0) + (plan.dashMux.audioSize || 0) ||
        undefined;
      const dashExpiresAtMs = extractVariantEarliestExpiresAtMs(
        plan.variant,
        context.now,
      );
      leaves.push({
        title: itemDisplayTitle,
        entryStem: isMultiItemCollection ? distinctEpisodeTitle : rawWorkTitle,
        index: isMultiItemCollection ? itemNumber : undefined,
        totalCount,
        ext: plan.dashMux.outputContainer,
        mimeType: "video/mp4",
        sizeBytes: exactTotalBytes,
        fallbackUrl: fallbackUrl || media.source_url,
        specKind: "dash_mux",
        routes: plan.dashMux.videoRoutes,
        dashMux: plan.dashMux,
        refreshContext: buildLeafRefreshContext(dashExpiresAtMs),
      });
      continue;
    }

    if (!("variant" in plan.target)) {
      throw new Error("当前暂不支持该媒体交付类型");
    }

    const { ext, mimeType } = resolveExtensionForTarget(
      plan.target,
      item,
      media.platform,
      plan.isAudioOnly,
    );
    const variantExpiresAtMs = extractVariantEarliestExpiresAtMs(
      plan.variant,
      context.now,
    );

    if (plan.target.kind === "file") {
      const routes = buildFileRoutesWithTbvideoFallback(
        plan.target,
        item,
        media.platform,
      );
      const isYtDirect =
        media.platform === "youtube" &&
        isValidGooglevideoPlaybackUrl(routes[0]);
      leaves.push({
        title: itemDisplayTitle,
        entryStem: isMultiItemCollection
          ? item.type === "image"
            ? undefined
            : distinctEpisodeTitle
          : itemDisplayTitle,
        index: isMultiItemCollection ? itemNumber : undefined,
        totalCount,
        ext: isYtDirect && !["mp4", "m4a", "webm"].includes(ext) ? "mp4" : ext,
        mimeType,
        sizeBytes: plan.target.source.size_bytes,
        fallbackUrl: fallbackUrl || routes[0],
        specKind: isYtDirect ? "youtube_direct" : "direct_file",
        routes,
        refreshContext: buildLeafRefreshContext(variantExpiresAtMs),
      });
      continue;
    }

    if (
      plan.target.kind === "hls" &&
      plan.variant.delivery.kind === "hls"
    ) {
      const routes = deliveryRoutes(plan.variant.delivery.sources, context);
      if (!routes.length) {
        throw new Error("HLS 资源缺少可用下载线路");
      }
      leaves.push({
        title: itemDisplayTitle,
        entryStem: isMultiItemCollection ? distinctEpisodeTitle : itemDisplayTitle,
        index: isMultiItemCollection ? itemNumber : undefined,
        totalCount,
        ext,
        mimeType,
        fallbackUrl: fallbackUrl || routes[0],
        specKind: "hls",
        routes,
        refreshContext: buildLeafRefreshContext(variantExpiresAtMs),
      });
      continue;
    }

    if (
      plan.target.kind === "segments" &&
      plan.variant.delivery.kind === "segments"
    ) {
      const segments = buildSegmentSpecsFromDelivery(
        plan.variant.delivery,
        context,
      );
      leaves.push({
        title: itemDisplayTitle,
        entryStem: isMultiItemCollection ? distinctEpisodeTitle : itemDisplayTitle,
        index: isMultiItemCollection ? itemNumber : undefined,
        totalCount,
        ext,
        mimeType,
        fallbackUrl: fallbackUrl || segments[0]?.url,
        specKind: "segments",
        routes:
          segments[0]?.routes ?? (segments[0]?.url ? [segments[0].url] : []),
        segments,
        refreshContext: buildLeafRefreshContext(variantExpiresAtMs),
      });
      continue;
    }

    throw new Error("当前暂不支持该媒体交付类型");
  }

  if (leaves.length === 0) {
    throw new Error("没有可下载的资源条目");
  }

  const useSubfolder =
    options.forceSubfolder === true ||
    isMultiItemCollection ||
    leaves.length > 1;

  const canPackAsZip =
    batchSaveMode === "zip" &&
    (leaves.length > 1 || isMultiItemCollection) &&
    leaves.every(
      (leaf) =>
        leaf.specKind === "direct_file" || leaf.specKind === "segments",
    );

  if (canPackAsZip) {
    let knownTotalBytes = 0;
    for (const leaf of leaves) {
      knownTotalBytes += leaf.sizeBytes || 0;
      if (knownTotalBytes > MAX_BATCH_ZIP_BYTES) {
        throw new Error(ARCHIVE_LIMIT_ERROR);
      }
    }

    const zipFilename = buildSafeDownloadPath({
      prefix: options.subfolderPrefix,
      stem: rawWorkTitle,
      ext: "zip",
    });

    const zipEntries: OffscreenZipEntrySpec[] = leaves.map((leaf, idx) => {
      const entryPath = buildSafeDownloadPath({
        index: leaf.index ?? idx + 1,
        totalCount: Math.max(totalCount, leaves.length),
        stem: leaf.entryStem,
        ext: leaf.ext,
      });
      return {
        entryName: entryPath,
        routes: leaf.routes,
        ...(leaf.mimeType ? { mimeType: leaf.mimeType } : {}),
        ...(leaf.sizeBytes ? { sizeBytes: leaf.sizeBytes } : {}),
        ...(leaf.segments ? { segments: leaf.segments } : {}),
      };
    });

    return [
      {
        title: `${rawWorkTitle} (${leaves.length} 项打包)`,
        platform: media.platform,
        ...(workFingerprint ? { workFingerprint } : {}),
        ...(media.source_url ? { fallbackUrl: media.source_url } : {}),
        spec: {
          kind: "batch_zip",
          apiOrigin,
          routes: zipEntries[0]?.routes ?? [],
          filename: zipFilename,
          mimeType: "application/zip",
          ...(knownTotalBytes > 0 ? { sizeBytes: knownTotalBytes } : {}),
          ...(extraAllowedOrigins.length
            ? { extraAllowedOrigins }
            : {}),
          zipEntries,
        },
      },
    ];
  }

  const subfolderName = useSubfolder
    ? sanitizeFilenameSegment(rawWorkTitle, {
        maxCodePoints: MAX_FOLDER_CODE_POINTS,
        fallback: media.platform || "collection",
      })
    : undefined;

  return leaves.map((leaf) => {
    const filename = buildSafeDownloadPath({
      prefix: options.subfolderPrefix,
      subfolder: subfolderName,
      index: useSubfolder ? leaf.index : undefined,
      totalCount: useSubfolder ? Math.max(totalCount, leaves.length) : undefined,
      stem:
        useSubfolder && leaf.index !== undefined
          ? leaf.entryStem
          : leaf.entryStem || rawWorkTitle,
      ext: leaf.ext,
    });

    return {
      title: leaf.title,
      platform: media.platform,
      ...(workFingerprint ? { workFingerprint } : {}),
      ...(leaf.fallbackUrl ? { fallbackUrl: leaf.fallbackUrl } : {}),
      ...(leaf.refreshContext ? { refreshContext: leaf.refreshContext } : {}),
      spec: {
        kind: leaf.specKind,
        apiOrigin,
        routes: leaf.routes,
        filename,
        ...(leaf.mimeType ? { mimeType: leaf.mimeType } : {}),
        ...(leaf.sizeBytes ? { sizeBytes: leaf.sizeBytes } : {}),
        ...(extraAllowedOrigins.length ? { extraAllowedOrigins } : {}),
        ...(leaf.segments ? { segments: leaf.segments } : {}),
        ...(leaf.youtubeMux ? { youtubeMux: leaf.youtubeMux } : {}),
        ...(leaf.dashMux ? { dashMux: leaf.dashMux } : {}),
        ...(leaf.refreshContext ? { refreshContext: leaf.refreshContext } : {}),
      },
    };
  });
}

// ============================================================================
// OPFS Cleanup & Streaming Download/Mux Executor
// ============================================================================

async function acquireExclusiveWebLock(
  locks: WebLocksLike | LockManager | null | undefined,
  lockName: string,
): Promise<() => void> {
  if (!locks || typeof locks.request !== "function") {
    return () => {};
  }
  let releaseHold!: () => void;
  const holdPromise = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseHold();
  };

  let onGranted!: () => void;
  let onFailed!: (err: unknown) => void;
  const granted = new Promise<void>((resolve, reject) => {
    onGranted = resolve;
    onFailed = reject;
  });

  try {
    const req = (locks as WebLocksLike).request(
      lockName,
      { mode: "exclusive" },
      () => {
        onGranted();
        return holdPromise;
      },
    );
    req.catch(onFailed);
    await granted;
    if (released) {
      releaseHold();
    }
    return release;
  } catch {
    release();
    return () => {};
  }
}

export async function cleanupStaleExtensionOpfsFiles(options?: {
  storage?: OpfsStorageLike | StorageManager | null;
  locks?: WebLocksLike | LockManager | null;
  activeNames?: ReadonlySet<string>;
  now?: () => number;
}): Promise<number> {
  const storage =
    options?.storage !== undefined
      ? options.storage
      : typeof navigator !== "undefined"
        ? navigator.storage
        : null;
  const locks =
    options?.locks !== undefined
      ? options.locks
      : typeof navigator !== "undefined"
        ? navigator.locks
        : null;
  const activeNames = options?.activeNames;

  let removed = 0;

  if (storage && typeof storage.getDirectory === "function") {
    try {
      const root = (await storage.getDirectory()) as OpfsDirectoryLike;
      if (root && typeof root.removeEntry === "function") {
        const candidates: string[] = [];
        const iter =
          (typeof root.keys === "function" && root.keys()) ||
          (typeof root.entries === "function" && root.entries()) ||
          (typeof root.values === "function" && root.values());
        if (iter) {
          for await (const entry of iter as AsyncIterable<unknown>) {
            const name =
              typeof entry === "string"
                ? entry
                : Array.isArray(entry)
                  ? String(entry[0] ?? "")
                  : typeof entry === "object" && entry !== null
                    ? String((entry as { name?: unknown }).name ?? "")
                    : "";
            if (
              name.startsWith(EXTENSION_OPFS_TEMP_PREFIX) &&
              !(activeNames && activeNames.has(name))
            ) {
              candidates.push(name);
            }
          }
        }

        for (const name of candidates) {
          const baseLockName = name.endsWith(".crswap")
            ? name.slice(0, -7)
            : name;
          if (
            activeNames &&
            (activeNames.has(name) || activeNames.has(baseLockName))
          ) {
            continue;
          }
          if (locks && typeof locks.request === "function") {
            await (locks as WebLocksLike).request(
              baseLockName,
              { mode: "exclusive", ifAvailable: true },
              async (lock) => {
                if (!lock) return;
                try {
                  await root.removeEntry(name);
                  removed += 1;
                } catch {
                  // Ignore already removed
                }
              },
            );
          } else {
            try {
              await root.removeEntry(name);
              removed += 1;
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch {
      // Ignore OPFS access errors in restricted environments
    }
  }

  try {
    removed += await cleanupLeftoverYouTubeOpfsTempFiles({
      storage: storage as StorageManager | null,
      locks: locks as LockManager | null,
      now: options?.now,
      maxAgeMs: 0,
      activeNames: activeNames
        ? new Set(
            Array.from(activeNames).filter((n) =>
              n.startsWith(YOUTUBE_OPFS_TEMP_PREFIX),
            ),
          )
        : null,
    });
  } catch {
    // Ignore
  }

  return removed;
}

function parseByteRangeDirective(
  value: string,
  previousEndExclusive: number | null,
): { start: number; length: number } | null {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const length = Number(match[1]);
  const start =
    match[2] !== undefined ? Number(match[2]) : (previousEndExclusive ?? 0);
  return Number.isSafeInteger(start) &&
    start >= 0 &&
    Number.isSafeInteger(length) &&
    length > 0
    ? { start, length }
    : null;
}

function sanitizeOpfsTaskSlug(taskId: string): string {
  const cleaned = taskId
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned || "task";
}

function sanitizeZipEntryPath(rawEntryName: string, fallbackIdx: number): string {
  const parts = rawEntryName
    .split(/[/\\]+/)
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..");
  if (parts.length === 0) {
    return `${formatBatchItemIndex(fallbackIdx + 1)}.bin`;
  }
  const last = parts[parts.length - 1];
  const dot = last.lastIndexOf(".");
  const ext = dot > 0 ? last.slice(dot + 1) : "";
  const stem = dot > 0 ? last.slice(0, dot) : last;
  const folderPrefix = parts.slice(0, -1).join("/");
  return buildSafeDownloadPath({
    prefix: folderPrefix,
    stem,
    ext,
  });
}

export interface CreateOffscreenDownloadExecutorOptions {
  handoffBlobDownload: (
    message: Extract<
      OffscreenToBackgroundMessage,
      { type: "HANDOFF_BLOB_DOWNLOAD" }
    >,
  ) => Promise<HandOffBlobDownloadResult | void>;
  onProgress?: (
    message: Extract<
      OffscreenToBackgroundMessage,
      { type: "OFFSCREEN_TASK_PROGRESS" }
    >,
  ) => void;
  onError?: (
    message: Extract<
      OffscreenToBackgroundMessage,
      { type: "OFFSCREEN_TASK_ERROR" }
    >,
  ) => void;
  fetchImpl?: typeof fetch;
  opfsStorage?: OpfsStorageLike | StorageManager | null;
  webLocks?: WebLocksLike | LockManager | null;
  urlApi?: UrlObjectApiLike;
  now?: () => number;
  maxConcurrentTasks?: number;
  progressThrottleMs?: number;
  mediabunnyImpl?: Record<string, unknown> | null;
  youtubeMuxConfig?: {
    chunkSize?: number;
    videoConcurrency?: number;
    audioConcurrency?: number;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    chunkTimeoutMs?: number;
    maxBufferBytes?: number;
  };
}

interface PendingBlobRelease {
  taskId: string;
  blobUrl: string;
  opfsTempName?: string;
  resolve: () => void;
}

interface QueuedTaskEntry {
  taskId: string;
  spec: OffscreenDownloadSpec;
  controller: AbortController;
  started: boolean;
}

export interface OffscreenDownloadExecutor {
  startTask(taskId: string, spec: OffscreenDownloadSpec): { accepted: boolean };
  cancelTask(taskId: string): { cancelled: boolean };
  releaseBlob(params: {
    taskId: string;
    blobUrl: string;
    opfsTempName?: string;
  }): { released: boolean };
  requestYouTubePlayer(
    payload: YouTubeHelperPlayerPayload,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<YouTubeHelperPlayerResult>;
  getHelperVersion(): string;
  getActiveTaskCount(): number;
  getPendingBlobCount(): number;
  getActiveOpfsTempNames(): ReadonlySet<string>;
  getActiveDynamicAllowedOrigins(): string[] | undefined;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

export function createOffscreenDownloadExecutor(
  options: CreateOffscreenDownloadExecutorOptions,
): OffscreenDownloadExecutor {
  const fetchFn: typeof fetch =
    options.fetchImpl ??
    ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const opfsStorage =
    options.opfsStorage !== undefined
      ? options.opfsStorage
      : typeof navigator !== "undefined"
        ? (navigator.storage as unknown as OpfsStorageLike)
        : null;
  const webLocks =
    options.webLocks !== undefined
      ? options.webLocks
      : typeof navigator !== "undefined"
        ? (navigator.locks as unknown as WebLocksLike)
        : null;
  const urlApi: UrlObjectApiLike = options.urlApi ?? globalThis.URL;
  const nowFn = options.now ?? (() => Date.now());
  const maxConcurrentTasks = Math.max(
    1,
    options.maxConcurrentTasks ?? DEFAULT_OFFSCREEN_CONCURRENCY,
  );
  const progressThrottleMs = Math.max(
    0,
    options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS,
  );

  let tempSeq = 0;
  let activeRunningCount = 0;
  const activeDynamicAllowedOriginsByTask = new Map<string, string[]>();

  const getUnionDynamicAllowedOrigins = (): string[] | undefined => {
    if (activeDynamicAllowedOriginsByTask.size === 0) {
      return undefined;
    }
    const merged = new Set<string>();
    for (const origins of activeDynamicAllowedOriginsByTask.values()) {
      for (const origin of origins) {
        if (origin) merged.add(origin);
      }
    }
    return merged.size > 0 ? Array.from(merged) : undefined;
  };

  const waitQueue: QueuedTaskEntry[] = [];
  const activeTaskEntries = new Map<string, QueuedTaskEntry>();
  const pendingBlobs = new Map<string, PendingBlobRelease>();
  const activeOpfsNames = new Set<string>();
  const idleWaiters: Array<() => void> = [];

  const youtubeBridge = createYouTubeExtensionBridge({
    handoffBlobDownload: options.handoffBlobDownload,
    fetchImpl: fetchFn,
    opfsStorage: opfsStorage as Record<string, unknown> | null,
    webLocks: webLocks as Record<string, unknown> | null,
    urlApi,
    now: nowFn,
    mediabunnyImpl: options.mediabunnyImpl,
    muxConfig: options.youtubeMuxConfig,
    extraAllowedOrigins: getUnionDynamicAllowedOrigins,
  });

  const notifyIfIdle = () => {
    if (
      activeRunningCount === 0 &&
      waitQueue.length === 0 &&
      pendingBlobs.size === 0 &&
      youtubeBridge.getPendingBlobCount() === 0
    ) {
      for (const resolve of idleWaiters.splice(0)) {
        resolve();
      }
    }
  };

  const getAllowedOriginsForSpec = (spec: OffscreenDownloadSpec): string[] =>
    buildEffectiveExtraOrigins(spec.apiOrigin, spec.extraAllowedOrigins);

  const assertWhitelisted = (
    rawUrl: string,
    spec: OffscreenDownloadSpec,
  ): void => {
    assertWhitelistedUrl(rawUrl, spec);
  };

  const fetchWhitelisted = (
    rawUrl: string,
    spec: OffscreenDownloadSpec,
    init: RequestInit | undefined,
    signal: AbortSignal,
  ): Promise<Response> =>
    whitelistedFetch(fetchFn, rawUrl, spec, init, signal);

  const createProgressReporter = (
    taskId: string,
    defaultStatus: "downloading" | "muxing" | "saving" = "downloading",
  ) => {
    const startedAt = nowFn();
    let lastEmitAt = 0;
    let lastSampleAt = startedAt;
    let lastSampleBytes = 0;
    let currentSpeed = 0;

    return (
      update: {
        status?: "downloading" | "muxing" | "saving";
        statusText: string;
        loaded: number;
        total: number;
        percent?: number;
        speed?: number;
      },
      force = false,
    ) => {
      const now = nowFn();
      if (!force && progressThrottleMs > 0 && now - lastEmitAt < progressThrottleMs) {
        return;
      }
      const dt = (now - lastSampleAt) / 1000;
      if (dt >= 0.05 && update.loaded >= lastSampleBytes) {
        currentSpeed = Math.round((update.loaded - lastSampleBytes) / dt);
        lastSampleAt = now;
        lastSampleBytes = update.loaded;
      }
      lastEmitAt = now;
      const computedPercent =
        update.percent !== undefined
          ? update.percent
          : update.total > 0
            ? Math.min(99, Math.floor((update.loaded / update.total) * 100))
            : 0;

      options.onProgress?.({
        type: "OFFSCREEN_TASK_PROGRESS",
        taskId,
        status: update.status ?? defaultStatus,
        statusText: update.statusText,
        percent: Math.max(0, Math.min(99, computedPercent)),
        loaded: update.loaded,
        total: update.total,
        speed:
          update.speed !== undefined
            ? Math.max(0, update.speed)
            : update.status === "saving"
              ? 0
              : Math.max(0, currentSpeed),
      });
    };
  };

  const openOpfsSink = async (
    taskId: string,
    mimeType?: string,
    tag?: string,
  ): Promise<OpfsSinkLike> => {
    if (opfsStorage && typeof opfsStorage.getDirectory === "function") {
      const cleanTag =
        typeof tag === "string" && tag.trim()
          ? `${sanitizeOpfsTaskSlug(tag)}-`
          : "";
      const tempName = `${EXTENSION_OPFS_TEMP_PREFIX}${cleanTag}${sanitizeOpfsTaskSlug(taskId)}-${nowFn()}-${++tempSeq}.tmp`;
      activeOpfsNames.add(tempName);
      const releaseLock = await acquireExclusiveWebLock(webLocks, tempName);
      let root: OpfsDirectoryLike | null = null;
      let writable: OpfsWritableLike | null = null;
      let closed = false;
      let cleaned = false;

      try {
        const dir = (await opfsStorage.getDirectory()) as unknown as OpfsDirectoryLike;
        root = dir;
        const handle = await dir.getFileHandle(tempName, { create: true });
        writable = await handle.createWritable();

        const cleanup = async (reason?: unknown) => {
          if (cleaned) return;
          cleaned = true;
          if (!closed && writable) {
            try {
              await writable.abort?.(reason);
            } catch {
              // Ignore
            }
          }
          try {
            await root?.removeEntry(tempName);
          } catch {
            // Ignore NotFound
          }
          activeOpfsNames.delete(tempName);
          releaseLock();
        };

        return {
          tempName,
          rawWritable: writable,
          async write(chunk: Uint8Array) {
            await writable!.write(chunk);
          },
          markWritableClosed() {
            closed = true;
          },
          async closeAndGetBlob(): Promise<Blob | File> {
            if (!closed) {
              closed = true;
              await writable!.close();
            }
            const rawFile = await handle.getFile();
            if (!rawFile || rawFile.size === 0) {
              await cleanup();
              throw new ExtensionDownloadError("下载产物为空");
            }
            return rawFile;
          },
          cleanup,
        };
      } catch (err) {
        try {
          await root?.removeEntry(tempName);
        } catch {
          // Ignore
        }
        activeOpfsNames.delete(tempName);
        releaseLock();
        throw err;
      }
    }

    // Fallback when OPFS is absent in a stripped test environment
    const chunks: Uint8Array[] = [];
    return {
      tempName: undefined as string | undefined,
      async write(chunk: Uint8Array) {
        chunks.push(chunk.slice());
      },
      async closeAndGetBlob(): Promise<Blob> {
        const blob = new Blob(chunks as BlobPart[], {
          type: mimeType || "application/octet-stream",
        });
        chunks.length = 0;
        if (blob.size === 0) {
          throw new ExtensionDownloadError("下载产物为空");
        }
        return blob;
      },
      async cleanup() {
        chunks.length = 0;
      },
    };
  };

  const handoffSinkAndWaitRelease = async (params: {
    taskId: string;
    spec: OffscreenDownloadSpec;
    sink: OpfsSinkLike;
    signal: AbortSignal;
    reportProgress: ReturnType<typeof createProgressReporter>;
  }): Promise<void> => {
    const { taskId, spec, sink, signal, reportProgress } = params;
    throwIfAborted(signal);
    const fileBlob = await sink.closeAndGetBlob();
    throwIfAborted(signal);

    // OPFS temporary files (`*.tmp`) report `fileBlob.type === ""`, which Chromium's
    // DownloadTargetDeterminer defaults to `text/plain` and rewrites to `.txt`!
    // Wrapping `[fileBlob]` in a typed `Blob` preserves zero-copy OPFS disk backing in Blink
    // while giving `chrome.downloads` the authoritative media MIME type.
    const effectiveMime = resolveBlobMimeType(spec.filename, spec.mimeType);
    const typedBlob =
      fileBlob.type === effectiveMime
        ? fileBlob
        : new Blob([fileBlob], { type: effectiveMime });
    const blobUrl = urlApi.createObjectURL(typedBlob);
    let resolveRelease!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });

    pendingBlobs.set(blobUrl, {
      taskId,
      blobUrl,
      opfsTempName: sink.tempName,
      resolve: resolveRelease,
    });

    reportProgress(
      {
        status: "saving",
        statusText: "正在交接浏览器落盘...",
        loaded: fileBlob.size,
        total: fileBlob.size,
        percent: 99,
      },
      true,
    );

    try {
      await options.handoffBlobDownload({
        type: "HANDOFF_BLOB_DOWNLOAD",
        taskId,
        blobUrl,
        filename: spec.filename,
        mimeType: spec.mimeType,
        sizeBytes: fileBlob.size,
        ...(sink.tempName ? { opfsTempName: sink.tempName } : {}),
      });
      await releasePromise;
    } finally {
      pendingBlobs.delete(blobUrl);
      try {
        urlApi.revokeObjectURL(blobUrl);
      } catch {
        // Ignore
      }
      await sink.cleanup();
      notifyIfIdle();
    }
  };

  const executeDirectFile = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<void> => {
    const reportProgress = createProgressReporter(taskId, "downloading");
    const result = await streamResumableRouteToOpfs({
      taskId,
      routes: spec.routes,
      spec,
      fetchFn,
      openOpfsSink,
      signal,
      estimatedSize: spec.sizeBytes,
      sinkMimeType: spec.mimeType,
      errorLabel: "媒体源",
      onRouteStart({ routeIndex, routeCount, total, isFreshRetry }) {
        reportProgress(
          {
            status: "downloading",
            statusText: isFreshRetry
              ? "正在重新流式下载..."
              : routeCount > 1 && routeIndex > 0
                ? `备用线路 ${routeIndex + 1}/${routeCount} 下载中...`
                : "正在流式下载...",
            loaded: 0,
            total,
            percent: 0,
          },
          true,
        );
      },
      onProgress({ loaded, total, resumed }) {
        reportProgress({
          status: "downloading",
          statusText: resumed ? "断点续传下载中..." : "正在流式下载...",
          loaded,
          total,
        });
      },
    });

    try {
      await handoffSinkAndWaitRelease({
        taskId,
        spec,
        sink: result.sink,
        signal,
        reportProgress,
      });
    } catch (err) {
      await result.sink.cleanup(err);
      throw err;
    }
  };

  const resolveHlsVodSegments = async (
    manifestUrl: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<OffscreenSegmentSpec[]> => {
    const resp = await fetchWhitelisted(
      manifestUrl,
      spec,
      { method: "GET" },
      signal,
    );
    if (resp.status !== 200) {
      void resp.body?.cancel?.().catch(() => {});
      throw new ExtensionDownloadError(`HLS 清单返回 HTTP ${resp.status}`);
    }
    const text = await resp.text();
    if (text.length > 2 * 1024 * 1024) {
      throw new ExtensionDownloadError("HLS 清单体积超过安全上限");
    }
    if (
      !text.trimStart().startsWith("#EXTM3U") ||
      !text.includes("#EXT-X-ENDLIST") ||
      /#EXT-X-STREAM-INF|#EXT-X-MEDIA:|#EXT-X-KEY|#EXT-X-DISCONTINUITY/.test(
        text,
      )
    ) {
      throw new ExtensionDownloadError(
        "当前 HLS 清单包含加密、多轨或非完整点播流，暂不支持直接拼接",
      );
    }

    const segments: OffscreenSegmentSpec[] = [];
    let previousEnd: number | null = null;
    let previousUrl = "";
    let pendingRange: string | null = null;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-MAP:")) {
        const uri = /URI="([^"]+)"/.exec(line)?.[1];
        if (!uri || segments.length > 0) {
          throw new ExtensionDownloadError("HLS 初始化段格式无效");
        }
        const resolvedUrl = sourceUrl({ url: new URL(uri, manifestUrl).href });
        assertWhitelisted(resolvedUrl, spec);
        const rawRange = /BYTERANGE="([^"]+)"/.exec(line)?.[1];
        const range = rawRange ? parseByteRangeDirective(rawRange, null) : null;
        if (rawRange && !range) {
          throw new ExtensionDownloadError("HLS 初始化段字节范围无效");
        }
        segments.push({ url: resolvedUrl, ...(range || {}) });
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        if (pendingRange !== null) {
          throw new ExtensionDownloadError("HLS 连续 BYTERANGE 指令无效");
        }
        pendingRange = line.slice("#EXT-X-BYTERANGE:".length);
      } else if (!line.startsWith("#")) {
        const resolvedUrl = sourceUrl({ url: new URL(line, manifestUrl).href });
        assertWhitelisted(resolvedUrl, spec);
        if (
          pendingRange &&
          !pendingRange.includes("@") &&
          (previousEnd === null || resolvedUrl !== previousUrl)
        ) {
          throw new ExtensionDownloadError("HLS 隐式连续字节区间缺少前置偏移");
        }
        const range: { start: number; length: number } | null = pendingRange
          ? parseByteRangeDirective(pendingRange, previousEnd)
          : null;
        if (pendingRange && !range) {
          throw new ExtensionDownloadError("HLS 分片字节范围无效");
        }
        segments.push({ url: resolvedUrl, ...(range || {}) });
        previousEnd = range ? range.start + range.length : null;
        previousUrl = resolvedUrl;
        pendingRange = null;
        if (segments.length > 2000) {
          throw new ExtensionDownloadError("HLS 分片数量超过 2000 上限");
        }
      }
    }

    if (segments.length === 0 || pendingRange !== null) {
      throw new ExtensionDownloadError("HLS 清单未解析出有效分片");
    }
    return segments;
  };

  const streamSingleSegment = async (params: {
    seg: OffscreenSegmentSpec;
    spec: OffscreenDownloadSpec;
    signal: AbortSignal;
    write: (chunk: Uint8Array) => Promise<void>;
    onChunkBytes?: (bytes: number) => void;
    maxBytes?: number;
    maxBytesError?: string;
  }): Promise<number> => {
    const { seg, spec, signal, write, onChunkBytes, maxBytes, maxBytesError } =
      params;
    const candidates = Array.from(
      new Set([seg.url, ...(seg.routes ?? [])].map((u) => u.trim()).filter(Boolean)),
    );
    if (candidates.length === 0) {
      throw new ExtensionDownloadError("分片缺少下载链接");
    }

    const hasRange =
      typeof seg.start === "number" &&
      typeof seg.length === "number" &&
      seg.start >= 0 &&
      seg.length > 0;
    const headers: Record<string, string> = {};
    if (hasRange) {
      headers.Range = `bytes=${seg.start!}-${seg.start! + seg.length! - 1}`;
    }

    let lastErr: unknown;
    const attempts = candidates.length > 1 ? candidates : [candidates[0], candidates[0]];

    for (let i = 0; i < attempts.length; i++) {
      throwIfAborted(signal);
      const url = attempts[i];
      const bufferedChunks: Uint8Array[] = [];
      try {
        const resp = await fetchWhitelisted(
          url,
          spec,
          { method: "GET", headers },
          signal,
        );
        if (hasRange) {
          const cr = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(
            resp.headers.get("Content-Range") || "",
          );
          const expectedEnd = seg.start! + seg.length! - 1;
          if (
            resp.status !== 206 ||
            !cr ||
            Number(cr[1]) !== seg.start ||
            Number(cr[2]) !== expectedEnd
          ) {
            void resp.body?.cancel?.().catch(() => {});
            throw new ExtensionDownloadError("分片服务器未返回预期字节区间");
          }
        } else if (resp.status !== 200) {
          void resp.body?.cancel?.().catch(() => {});
          throw new ExtensionDownloadError(
            `分片请求失败（HTTP ${resp.status}）`,
          );
        }

        // Buffer single segment in memory before committing to sink so a mid-segment
        // failure on attempt 1 never corrupts the concatenated OPFS file before retry!
        const bytesRead = await streamResponseBodyToWriter({
          response: resp,
          write: async (chunk) => {
            bufferedChunks.push(chunk.slice());
          },
          signal,
          maxBytes,
          maxBytesError,
        });

        if (hasRange && bytesRead !== seg.length) {
          throw new ExtensionDownloadError("分片字节长度与声明区间不符");
        }

        for (const chunk of bufferedChunks) {
          await write(chunk);
          onChunkBytes?.(chunk.byteLength);
        }
        return bytesRead;
      } catch (err) {
        if (isAbortLikeError(err, signal)) throw err;
        if (
          err instanceof ExtensionDownloadError &&
          (err.code === "UNWHITELISTED_CDN" ||
            err.message === ARCHIVE_LIMIT_ERROR)
        ) {
          if (candidates.length === 1) throw err;
        }
        lastErr = err;
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new ExtensionDownloadError("分片下载失败");
  };

  const executeSegmentsList = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    segments: OffscreenSegmentSpec[],
    signal: AbortSignal,
  ): Promise<void> => {
    if (segments.length === 0 || segments.length > 2000) {
      throw new ExtensionDownloadError("分片数量无效");
    }

    const reportProgress = createProgressReporter(taskId, "downloading");
    const knownTotal = segments.every((s) => typeof s.length === "number" && s.length > 0)
      ? segments.reduce((sum, s) => sum + (s.length || 0), 0)
      : spec.sizeBytes || 0;

    const sink = await openOpfsSink(taskId, spec.mimeType);
    let totalLoaded = 0;

    try {
      for (let i = 0; i < segments.length; i++) {
        throwIfAborted(signal);
        const seg = segments[i];
        await streamSingleSegment({
          seg,
          spec,
          signal,
          write: (chunk) => sink.write(chunk),
          onChunkBytes: (bytes) => {
            totalLoaded += bytes;
            const pct =
              knownTotal > 0
                ? Math.min(99, Math.floor((totalLoaded / knownTotal) * 100))
                : Math.min(99, Math.floor(((i + 0.5) / segments.length) * 100));
            reportProgress({
              status: "downloading",
              statusText: `正在下载分片 ${i + 1}/${segments.length}...`,
              loaded: totalLoaded,
              total: knownTotal,
              percent: pct,
            });
          },
        });
        const donePct = Math.min(
          99,
          Math.floor(((i + 1) / segments.length) * 100),
        );
        reportProgress(
          {
            status: "downloading",
            statusText: `已合并分片 ${i + 1}/${segments.length}...`,
            loaded: totalLoaded,
            total: knownTotal,
            percent: donePct,
          },
          i === segments.length - 1,
        );
      }

      await handoffSinkAndWaitRelease({
        taskId,
        spec,
        sink,
        signal,
        reportProgress,
      });
    } catch (err) {
      await sink.cleanup(err);
      throw err;
    }
  };

  const executeHls = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<void> => {
    const manifestRoutes = spec.routes.map((r) => r.trim()).filter(Boolean);
    if (manifestRoutes.length === 0) {
      throw new ExtensionDownloadError("缺少 HLS 清单地址");
    }

    let resolvedSegments: OffscreenSegmentSpec[] | null = null;
    let lastErr: unknown;
    for (const route of manifestRoutes) {
      throwIfAborted(signal);
      try {
        resolvedSegments = await resolveHlsVodSegments(route, spec, signal);
        break;
      } catch (err) {
        if (isAbortLikeError(err, signal)) throw err;
        lastErr = err;
      }
    }

    if (!resolvedSegments) {
      throw lastErr instanceof Error
        ? lastErr
        : new ExtensionDownloadError("HLS 清单解析失败");
    }

    await executeSegmentsList(taskId, spec, resolvedSegments, signal);
  };

  const executeBatchZip = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<void> => {
    const entries = spec.zipEntries ?? [];
    if (entries.length === 0) {
      throw new ExtensionDownloadError("ZIP 打包列表为空");
    }

    let upfrontBytes = 0;
    for (const entry of entries) {
      upfrontBytes += entry.sizeBytes || 0;
      if (upfrontBytes > MAX_BATCH_ZIP_BYTES) {
        throw new ExtensionDownloadError(ARCHIVE_LIMIT_ERROR);
      }
    }

    const reportProgress = createProgressReporter(taskId, "downloading");
    const zip = new JSZip();
    let totalBytes = 0;

    for (let i = 0; i < entries.length; i++) {
      throwIfAborted(signal);
      const entry = entries[i];
      const safeEntryPath = sanitizeZipEntryPath(entry.entryName, i);
      const remaining = MAX_BATCH_ZIP_BYTES - totalBytes;
      if (remaining <= 0) {
        throw new ExtensionDownloadError(ARCHIVE_LIMIT_ERROR);
      }

      if (entry.segments && entry.segments.length > 0) {
        const segParts: Uint8Array[] = [];
        let segBytes = 0;
        for (const seg of entry.segments) {
          const left = remaining - segBytes;
          if (left <= 0) {
            throw new ExtensionDownloadError(ARCHIVE_LIMIT_ERROR);
          }
          await streamSingleSegment({
            seg,
            spec,
            signal,
            write: async (chunk) => {
              segParts.push(chunk);
              segBytes += chunk.byteLength;
            },
            maxBytes: left,
            maxBytesError: ARCHIVE_LIMIT_ERROR,
          });
        }
        const merged = new Uint8Array(segBytes);
        let offset = 0;
        for (const p of segParts) {
          merged.set(p, offset);
          offset += p.byteLength;
        }
        totalBytes += merged.byteLength;
        zip.file(safeEntryPath, merged, { compression: "STORE" });
      } else {
        const routes = entry.routes.map((r) => r.trim()).filter(Boolean);
        if (routes.length === 0) {
          throw new ExtensionDownloadError(`打包条目 #${i + 1} 缺少下载线路`);
        }
        let fetchedBytes: Uint8Array | null = null;
        let lastRouteErr: unknown;
        for (const route of routes) {
          throwIfAborted(signal);
          try {
            const resp = await fetchWhitelisted(
              route,
              spec,
              { method: "GET" },
              signal,
            );
            if (resp.status !== 200) {
              void resp.body?.cancel?.().catch(() => {});
              throw new ExtensionDownloadError(`条目返回 HTTP ${resp.status}`);
            }
            const parts: Uint8Array[] = [];
            let len = 0;
            await streamResponseBodyToWriter({
              response: resp,
              write: async (chunk) => {
                parts.push(chunk.slice());
                len += chunk.byteLength;
              },
              signal,
              maxBytes: remaining,
              maxBytesError: ARCHIVE_LIMIT_ERROR,
            });
            const combined = new Uint8Array(len);
            let offset = 0;
            for (const p of parts) {
              combined.set(p, offset);
              offset += p.byteLength;
            }
            fetchedBytes = combined;
            break;
          } catch (err) {
            if (isAbortLikeError(err, signal)) throw err;
            if (
              err instanceof Error &&
              err.message === ARCHIVE_LIMIT_ERROR
            ) {
              throw err;
            }
            lastRouteErr = err;
          }
        }
        if (!fetchedBytes) {
          throw lastRouteErr instanceof Error
            ? lastRouteErr
            : new ExtensionDownloadError(`打包条目 #${i + 1} 下载失败`);
        }
        totalBytes += fetchedBytes.byteLength;
        zip.file(safeEntryPath, fetchedBytes, { compression: "STORE" });
      }

      reportProgress(
        {
          status: "downloading",
          statusText: `正在收集打包文件 ${i + 1}/${entries.length}...`,
          loaded: totalBytes,
          total: upfrontBytes || totalBytes,
          percent: Math.round(((i + 1) / entries.length) * 85),
        },
        true,
      );
    }

    const sink = await openOpfsSink(taskId, "application/zip");
    try {
      throwIfAborted(signal);
      const zipBytes = await zip.generateAsync(
        { type: "uint8array", compression: "STORE" },
        (meta) => {
          reportProgress({
            status: "downloading",
            statusText: "正在写入 ZIP 压缩包...",
            loaded: totalBytes,
            total: totalBytes,
            percent: Math.min(98, 85 + Math.round(meta.percent * 0.13)),
          });
        },
      );
      throwIfAborted(signal);
      await sink.write(zipBytes);

      await handoffSinkAndWaitRelease({
        taskId,
        spec: { ...spec, mimeType: "application/zip" },
        sink,
        signal,
        reportProgress,
      });
    } catch (err) {
      await sink.cleanup(err);
      throw err;
    }
  };

  const executeYouTubeDirect = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<void> => {
    const url = spec.routes[0]?.trim() || "";
    if (!url) {
      throw new ExtensionDownloadError("缺少 YouTube 媒体流地址");
    }
    assertWhitelisted(url, spec);
    activeDynamicAllowedOriginsByTask.set(
      taskId,
      getAllowedOriginsForSpec(spec),
    );
    const reportProgress = createProgressReporter(taskId, "downloading");

    try {
      await youtubeBridge.downloadDirect({
        taskId,
        url,
        filename: spec.filename,
        sizeBytes: spec.sizeBytes,
        signal,
        onProgress(detail) {
          reportProgress({
            status: "downloading",
            statusText: `YouTube 分块并发下载中（${detail.percent}%）...`,
            loaded: detail.loaded,
            total: detail.total,
            percent: detail.percent,
          });
        },
      });
    } finally {
      activeDynamicAllowedOriginsByTask.delete(taskId);
      notifyIfIdle();
    }
  };

  const executeYouTubeMux = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<void> => {
    const mux = spec.youtubeMux;
    if (!mux) {
      throw new ExtensionDownloadError("缺少 YouTube 音视频合流参数");
    }
    assertWhitelisted(mux.videoUrl, spec);
    assertWhitelisted(mux.audioUrl, spec);

    activeDynamicAllowedOriginsByTask.set(
      taskId,
      getAllowedOriginsForSpec(spec),
    );
    const reportProgress = createProgressReporter(taskId, "muxing");

    try {
      await youtubeBridge.downloadMux({
        taskId,
        videoUrl: mux.videoUrl,
        audioUrl: mux.audioUrl,
        videoSize: mux.videoSize,
        audioSize: mux.audioSize,
        filename: spec.filename,
        outputContainer: mux.outputContainer,
        signal,
        onProgress(detail) {
          reportProgress({
            status: "muxing",
            statusText: `YouTube 4K 无损合流中（${detail.percent}%）...`,
            loaded: detail.loaded,
            total: detail.total,
            percent: detail.percent,
          });
        },
      });
    } finally {
      activeDynamicAllowedOriginsByTask.delete(taskId);
      notifyIfIdle();
    }
  };

  // Module boundary: each independent download `kind` added in the future (e.g.
  // `dash_mux` -> `./dashMuxDownload.ts`) MUST live in its own dedicated module
  // file rather than appending new transport implementations into
  // `extensionDownload.ts`. Keep `runSingleTask` as a lightweight dispatcher.
  const runSingleTask = async (entry: QueuedTaskEntry): Promise<void> => {
    const { taskId, spec, controller } = entry;
    const { signal } = controller;

    try {
      throwIfAborted(signal);
      switch (spec.kind) {
        case "direct_file":
          await executeDirectFile(taskId, spec, signal);
          break;
        case "youtube_direct":
          await executeYouTubeDirect(taskId, spec, signal);
          break;
        case "youtube_mux":
          await executeYouTubeMux(taskId, spec, signal);
          break;
        case "dash_mux":
          await executeDashMux({
            taskId,
            spec,
            signal,
            fetchFn,
            opfsStorage,
            openOpfsSink,
            reportProgress: createProgressReporter(taskId, "downloading"),
            handoffSinkAndWaitRelease,
            mediabunnyMod: options.mediabunnyImpl,
            onEnterTask: () => {
              activeDynamicAllowedOriginsByTask.set(
                taskId,
                getAllowedOriginsForSpec(spec),
              );
            },
            onExitTask: () => {
              activeDynamicAllowedOriginsByTask.delete(taskId);
              notifyIfIdle();
            },
          });
          break;
        case "hls":
          await executeHls(taskId, spec, signal);
          break;
        case "segments":
          await executeSegmentsList(taskId, spec, spec.segments ?? [], signal);
          break;
        case "batch_zip":
          await executeBatchZip(taskId, spec, signal);
          break;
        default:
          throw new ExtensionDownloadError("未知的下载任务类型");
      }
    } catch (err) {
      const cancelled = isAbortLikeError(err, signal);
      const extErr = err instanceof ExtensionDownloadError ? err : null;
      const errCode =
        extErr?.code ||
        (typeof (err as { code?: unknown })?.code === "string"
          ? ((err as { code: string }).code as string)
          : undefined);
      const httpStatus =
        extErr?.httpStatus ??
        (typeof (err as { httpStatus?: unknown })?.httpStatus === "number"
          ? (err as { httpStatus: number }).httpStatus
          : undefined);
      options.onError?.({
        type: "OFFSCREEN_TASK_ERROR",
        taskId,
        error: cancelled
          ? "已取消"
          : err instanceof Error && err.message
            ? err.message
            : "下载执行失败",
        ...(errCode ? { code: errCode } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(cancelled ? { cancelled: true } : {}),
        ...(extErr?.unwhitelistedHost
          ? { unwhitelistedHost: extErr.unwhitelistedHost }
          : {}),
        ...(extErr?.fallbackUrl
          ? { fallbackUrl: extErr.fallbackUrl }
          : spec.routes[0]
            ? { fallbackUrl: spec.routes[0] }
            : {}),
      });
    }
  };

  const pumpQueue = () => {
    while (activeRunningCount < maxConcurrentTasks && waitQueue.length > 0) {
      const next = waitQueue.shift()!;
      if (next.controller.signal.aborted) {
        activeTaskEntries.delete(next.taskId);
        continue;
      }
      next.started = true;
      activeRunningCount += 1;
      void runSingleTask(next).finally(() => {
        activeRunningCount = Math.max(0, activeRunningCount - 1);
        activeTaskEntries.delete(next.taskId);
        pumpQueue();
        notifyIfIdle();
      });
    }
    notifyIfIdle();
  };

  return {
    startTask(taskId: string, spec: OffscreenDownloadSpec): { accepted: boolean } {
      const existing = activeTaskEntries.get(taskId);
      if (existing) {
        existing.controller.abort();
        activeTaskEntries.delete(taskId);
      }
      const entry: QueuedTaskEntry = {
        taskId,
        spec,
        controller: new AbortController(),
        started: false,
      };
      activeTaskEntries.set(taskId, entry);
      waitQueue.push(entry);
      pumpQueue();
      return { accepted: true };
    },

    cancelTask(taskId: string): { cancelled: boolean } {
      let found = false;
      const entry = activeTaskEntries.get(taskId);
      if (entry) {
        found = true;
        entry.controller.abort();
        if (!entry.started) {
          const idx = waitQueue.indexOf(entry);
          if (idx >= 0) {
            waitQueue.splice(idx, 1);
          }
          activeTaskEntries.delete(taskId);
          options.onError?.({
            type: "OFFSCREEN_TASK_ERROR",
            taskId,
            error: "已取消",
            code: "USER_CANCELLED",
            cancelled: true,
          });
        }
      }
      // Also release any orphaned blob wait for this task if cancelled
      for (const [blobUrl, pending] of Array.from(pendingBlobs.entries())) {
        if (pending.taskId === taskId) {
          pendingBlobs.delete(blobUrl);
          pending.resolve();
          found = true;
        }
      }
      if (youtubeBridge.releaseBlobsForTask(taskId) > 0) {
        found = true;
      }
      notifyIfIdle();
      return { cancelled: found };
    },

    releaseBlob(params: {
      taskId: string;
      blobUrl: string;
      opfsTempName?: string;
    }): { released: boolean } {
      let released = false;
      const own = pendingBlobs.get(params.blobUrl);
      if (own) {
        pendingBlobs.delete(params.blobUrl);
        own.resolve();
        released = true;
      }
      if (
        youtubeBridge.releaseBlob({
          taskId: params.taskId,
          blobUrl: params.blobUrl,
        })
      ) {
        released = true;
      }
      notifyIfIdle();
      return { released };
    },

    requestYouTubePlayer(
      payload: YouTubeHelperPlayerPayload,
      reqOpts?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<YouTubeHelperPlayerResult> {
      return youtubeBridge.requestPlayer(payload, reqOpts);
    },

    getHelperVersion(): string {
      return youtubeBridge.getHelperVersion();
    },

    getActiveTaskCount(): number {
      return activeRunningCount + waitQueue.length;
    },

    getPendingBlobCount(): number {
      return pendingBlobs.size + youtubeBridge.getPendingBlobCount();
    },

    getActiveOpfsTempNames(): ReadonlySet<string> {
      return activeOpfsNames;
    },

    getActiveDynamicAllowedOrigins(): string[] | undefined {
      return getUnionDynamicAllowedOrigins();
    },

    waitForIdle(): Promise<void> {
      if (
        activeRunningCount === 0 &&
        waitQueue.length === 0 &&
        pendingBlobs.size === 0 &&
        youtubeBridge.getPendingBlobCount() === 0
      ) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    dispose(): void {
      for (const entry of waitQueue.splice(0)) {
        entry.controller.abort();
      }
      for (const [, entry] of Array.from(activeTaskEntries.entries())) {
        entry.controller.abort();
      }
      activeTaskEntries.clear();
      for (const [, pending] of Array.from(pendingBlobs.entries())) {
        pending.resolve();
      }
      pendingBlobs.clear();
      activeDynamicAllowedOriginsByTask.clear();
      youtubeBridge.dispose();
      notifyIfIdle();
    },
  };
}
