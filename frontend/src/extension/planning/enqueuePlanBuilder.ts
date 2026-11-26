import type {
  Chunk,
  LeafDelivery,
  MediaItem,
  MediaSelection,
  ReadyVariant,
  Resource,
  Source,
  UnifiedMedia,
} from "../../types/media";
import {
  availableSources,
  deliveryRoutes,
  getDownloadTarget,
  readyItem,
  readyVariant,
  sourceUrl,
  type DownloadTarget,
  type TargetContext,
} from "../../utils/mediaContract";
import { mediaExtension } from "../../utils/mediaDelivery";
import {
  isValidGooglevideoPlaybackUrl,
  selectYouTubeMuxPair,
} from "../../utils/youtubeHelperCore";
import { isPlaceholderPartTitle } from "../../core/media";
import {
  computeEarliestExpiresAtMs,
  extractDashMuxSpec,
  extractVariantEarliestExpiresAtMs,
} from "../dashMuxSpec";
import {
  MAX_FOLDER_CODE_POINTS,
  buildSafeDownloadPath,
  sanitizeFilenameSegment,
} from "../filenameSanitizer";
import { isWhitelistedMediaUrl, validateApiBaseUrl } from "../hostWhitelist";
import type {
  BatchSaveMode,
  EnqueueDownloadItem,
  MediaRefreshContext,
  OffscreenDownloadSpec,
  OffscreenSegmentSpec,
  OffscreenZipEntrySpec,
  QualityPreference,
} from "../protocol";
import { buildWorkFingerprint } from "../storage";
import { extractParseUrlFromRefreshUrl } from "../targetSpecBuilder";
import { buildExtensionTargetContext } from "../uiTargetHelpers";
import {
  buildEffectiveExtraOrigins,
  isStandaloneAudioVariant,
  resolveExtensionForTarget,
  selectVariantByPreference,
  type LivePhotoSaveMode,
  type SelectedVariantPlan,
} from "./variantSelection";

export const MAX_BATCH_ZIP_BYTES = 500 * 1024 * 1024;
export const ARCHIVE_LIMIT_ERROR =
  "打包总大小超过 500 MB 上限，请分批或单文件下载";

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

  const resourceRole =
    resource.role === "image" ||
    resource.role === "motion" ||
    resource.role === "video"
      ? resource.role
      : undefined;
  const withExpiry = (sources: Source[]): MediaRefreshContext | undefined => {
    if (!baseRefreshContext) return undefined;
    const expiresAtMs = computeEarliestExpiresAtMs(sources);
    return {
      ...baseRefreshContext,
      ...(resourceRole ? { resourceRole } : {}),
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
  const context: TargetContext = buildExtensionTargetContext(
    apiOrigin,
    options.now,
  );
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
    (media.content_id?.trim()
      ? `${media.platform}_${media.content_id.trim()}`
      : media.platform || "download");

  const workFingerprint = buildWorkFingerprint(media) || undefined;
  const allGroups = media.groups ?? [];
  const hasMultiGroups =
    allGroups.length > 1 ||
    allGroups.some(
      (g) => (g.total_count ?? 0) > 1 || (g.item_ids?.length ?? 0) > 1,
    );
  const isMultiItemCollection =
    media.items.length > 1 ||
    candidateItems.length > 1 ||
    hasMultiGroups;

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
        extraAllowedOrigins,
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
    const cleanEpisodeTitle =
      item.title?.trim() && !isPlaceholderPartTitle(item.title)
        ? item.title.trim()
        : undefined;
    const distinctEpisodeTitle =
      cleanEpisodeTitle && cleanEpisodeTitle !== media.title?.trim()
        ? cleanEpisodeTitle
        : undefined;
    const singleItemStem =
      media.title?.trim() ||
      item.title?.trim() ||
      media.author?.name?.trim() ||
      (media.content_id?.trim()
        ? `${media.platform}_${media.content_id.trim()}`
        : media.platform || "download");
    const itemDisplayTitle = isMultiItemCollection
      ? cleanEpisodeTitle || rawWorkTitle
      : singleItemStem;
    const fallbackUrl = item.source_url || media.source_url;
    const resolveUrlForItem = item.resolve_url?.trim() || undefined;
    const rawRefreshUrl = media.refresh_url?.trim() || "";
    const refreshUrlForItem =
      !resolveUrlForItem &&
      rawRefreshUrl.startsWith("/api/parse?") &&
      !/[\\\s#]/.test(rawRefreshUrl)
        ? rawRefreshUrl
        : undefined;
    const parseUrlForItem =
      item.source_url?.trim() ||
      media.source_url?.trim() ||
      options.sourceUrl?.trim() ||
      extractParseUrlFromRefreshUrl(refreshUrlForItem) ||
      "";
    const baseRefreshContext: Omit<MediaRefreshContext, "expiresAtMs"> | undefined =
      parseUrlForItem || resolveUrlForItem || refreshUrlForItem
        ? {
            parseUrl: parseUrlForItem,
            platform: media.platform,
            itemId: item.id,
            ...(plan.attachmentId
              ? { attachmentId: plan.attachmentId }
              : { variantId: plan.variant.id }),
            ...(resolveUrlForItem ? { resolveUrl: resolveUrlForItem } : {}),
            ...(refreshUrlForItem ? { refreshUrl: refreshUrlForItem } : {}),
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
            entryStem: isMultiItemCollection ? distinctEpisodeTitle : singleItemStem,
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
            entryStem: isMultiItemCollection ? distinctEpisodeTitle : singleItemStem,
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

  const allLeavesWhitelistedForZip = leaves.every((leaf) => {
    const primaryWhitelisted = leaf.routes.some(
      (r) => isWhitelistedMediaUrl(r, extraAllowedOrigins).allowed,
    );
    if (!primaryWhitelisted) return false;
    if (leaf.segments && leaf.segments.length > 0) {
      return leaf.segments.every((seg) => {
        const segRoutes = seg.routes?.length
          ? seg.routes
          : seg.url
            ? [seg.url]
            : [];
        return segRoutes.some(
          (r) => isWhitelistedMediaUrl(r, extraAllowedOrigins).allowed,
        );
      });
    }
    return true;
  });

  const canPackAsZip =
    batchSaveMode === "zip" &&
    (leaves.length > 1 || isMultiItemCollection) &&
    leaves.every(
      (leaf) =>
        leaf.specKind === "direct_file" || leaf.specKind === "segments",
    ) &&
    allLeavesWhitelistedForZip;

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
