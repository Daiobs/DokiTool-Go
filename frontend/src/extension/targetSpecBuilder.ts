import { parsePositiveSafeBytes } from "../components/result/resultI18n";
import { confirmedFormatMime } from "../downloads/file";
import type {
  Chunk,
  LeafDelivery,
  MediaItem,
  ReadyVariant,
  Resource,
  UnifiedMedia,
} from "../types/media";
import {
  availableSources,
  deliveryRoutes,
  readyItem,
  readyVariant,
  sourceUrl,
} from "../utils/mediaContract";
import { mediaExtension } from "../utils/mediaDelivery";
import { isValidGooglevideoPlaybackUrl } from "../utils/youtubeHelperCore";
import {
  computeEarliestExpiresAtMs,
  extractVariantEarliestExpiresAtMs,
} from "./dashMuxSpec";
import {
  appendCanonicalQualitySuffix,
  buildCanonicalArchiveStem,
  isPlaceholderPartTitle,
  resolveAdaptiveQualityFilenameTag,
} from "../core/media";
import { buildSafeDownloadPath } from "./filenameSanitizer";
import type {
  EnqueueDownloadItem,
  ExtensionSettings,
  MediaRefreshContext,
  OffscreenDownloadSpec,
  OffscreenSegmentSpec,
  OffscreenZipEntrySpec,
} from "./protocol";
import {
  buildExtensionTargetContext,
  buildExtraAllowedOrigins,
  buildSidePanelQualityOptions,
  hasWhitelistedRoute,
  isStandaloneAudioMetadata,
  resolveItemBaseName,
  resolveSafeApiOrigin,
  resolveVariantExtension,
  resolveWorkBaseTitle,
  selectPreferredQualityOption,
  type LivePhotoSaveFilter,
  type SidePanelQualityOption,
} from "./uiTargetHelpers";

export const MAX_EXTENSION_ZIP_BYTES = 500 * 1024 * 1024;

/**
 * Extracts the target HTTP(S) share URL from a same-origin `/api/parse?...`
 * `refresh_url` emitted by the backend for Tier-2 items that omit `resolve_url`.
 */
export function extractParseUrlFromRefreshUrl(
  rawRefreshUrl?: string | null,
): string {
  if (typeof rawRefreshUrl !== "string") return "";
  const trimmed = rawRefreshUrl.trim();
  if (!trimmed.startsWith("/api/parse?") || /[\\\s#]/.test(trimmed)) {
    return "";
  }
  try {
    const params = new URLSearchParams(trimmed.slice("/api/parse?".length));
    const innerUrl = (params.get("url") || "").trim();
    if (!/^https?:\/\//i.test(innerUrl)) return "";
    return innerUrl;
  } catch {
    return "";
  }
}

function normalizeRefreshUrlPath(rawRefreshUrl?: string | null): string | undefined {
  if (typeof rawRefreshUrl !== "string") return undefined;
  const trimmed = rawRefreshUrl.trim();
  if (!trimmed.startsWith("/api/parse?") || /[\\\s#]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function buildSegmentsSpecFromDelivery(
  delivery: Extract<LeafDelivery, { kind: "segments" }>,
  apiOrigin: string,
): OffscreenSegmentSpec[] {
  const ctx = buildExtensionTargetContext(apiOrigin);
  const chunks: Chunk[] = [
    ...(delivery.init ? [delivery.init] : []),
    ...delivery.pieces,
  ];
  return chunks.map((chunk) => {
    const routes = deliveryRoutes(chunk.sources, ctx);
    if (!routes.length) {
      throw new Error("分段媒体缺少可用下载线路");
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

export function buildRefreshContextForOption(params: {
  media: UnifiedMedia;
  item: MediaItem;
  option: SidePanelQualityOption;
  now?: number;
}): MediaRefreshContext | undefined {
  const { media, item, option, now } = params;
  const resolveUrl =
    item.state !== "unavailable" && item.resolve_url?.trim()
      ? item.resolve_url.trim()
      : undefined;
  const refreshUrl = !resolveUrl
    ? normalizeRefreshUrlPath(media.refresh_url)
    : undefined;
  const parseUrl =
    item.source_url?.trim() ||
    media.source_url?.trim() ||
    extractParseUrlFromRefreshUrl(refreshUrl) ||
    "";
  if (!parseUrl && !resolveUrl && !refreshUrl) {
    return undefined;
  }

  let expiresAtMs: number | undefined;
  if (option.muxPair) {
    expiresAtMs = computeEarliestExpiresAtMs([
      option.muxPair.videoSource,
      option.muxPair.audioSource,
    ]);
  } else if (
    option.kind === "attachment" &&
    option.attachment?.resource.delivery.kind === "file"
  ) {
    const avail = availableSources(option.attachment.resource.delivery.sources, now);
    expiresAtMs = computeEarliestExpiresAtMs(
      avail.length ? avail : option.attachment.resource.delivery.sources,
    );
  } else {
    expiresAtMs = extractVariantEarliestExpiresAtMs(option.variant, now);
  }

  return {
    parseUrl,
    platform: media.platform,
    itemId: item.id,
    ...(option.kind === "attachment" && option.attachment?.id
      ? { attachmentId: option.attachment.id }
      : { variantId: option.variant.id }),
    ...(resolveUrl ? { resolveUrl } : {}),
    ...(refreshUrl ? { refreshUrl } : {}),
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
  };
}

export function buildRefreshContextForResource(params: {
  media: UnifiedMedia;
  item: MediaItem;
  variantId?: string;
  resource: Resource;
  now?: number;
}): MediaRefreshContext | undefined {
  const { media, item, variantId, resource, now } = params;
  const resolveUrl =
    item.state !== "unavailable" && item.resolve_url?.trim()
      ? item.resolve_url.trim()
      : undefined;
  const refreshUrl = !resolveUrl
    ? normalizeRefreshUrlPath(media.refresh_url)
    : undefined;
  const parseUrl =
    item.source_url?.trim() ||
    media.source_url?.trim() ||
    extractParseUrlFromRefreshUrl(refreshUrl) ||
    "";
  if (!parseUrl && !resolveUrl && !refreshUrl) {
    return undefined;
  }
  const delivery = resource.delivery;
  const sources =
    delivery.kind === "segments"
      ? [
          ...(delivery.init?.sources ?? []),
          ...delivery.pieces.flatMap((p) => p.sources),
        ]
      : delivery.sources;
  const avail = availableSources(sources, now);
  const expiresAtMs = computeEarliestExpiresAtMs(avail.length ? avail : sources);
  const resourceRole =
    resource.role === "image" ||
    resource.role === "motion" ||
    resource.role === "video"
      ? resource.role
      : undefined;
  return {
    parseUrl,
    platform: media.platform,
    itemId: item.id,
    ...(variantId ? { variantId } : {}),
    ...(resourceRole ? { resourceRole } : {}),
    ...(resolveUrl ? { resolveUrl } : {}),
    ...(refreshUrl ? { refreshUrl } : {}),
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
  };
}

export function buildSpecFromOption(params: {
  media: UnifiedMedia;
  option: SidePanelQualityOption;
  filename: string;
  apiOrigin: string;
  refreshContext?: MediaRefreshContext;
}): OffscreenDownloadSpec {
  const { media, option, filename, refreshContext } = params;
  const apiOrigin = resolveSafeApiOrigin(params.apiOrigin);
  const ctx = buildExtensionTargetContext(apiOrigin);
  const extraAllowedOrigins = buildExtraAllowedOrigins(apiOrigin);
  const refreshField = refreshContext ? { refreshContext } : {};

  if (option.muxPair) {
    const videoUrl = sourceUrl(option.muxPair.videoSource, ctx);
    const audioUrl = sourceUrl(option.muxPair.audioSource, ctx);
    const totalSize =
      parsePositiveSafeBytes(option.muxPair.videoSource.size_bytes) +
      parsePositiveSafeBytes(option.muxPair.audioSource.size_bytes);
    return {
      kind: "youtube_mux",
      apiOrigin,
      routes: [videoUrl],
      filename,
      mimeType: option.muxPair.outputMimeType,
      ...(totalSize > 0 ? { sizeBytes: totalSize } : {}),
      ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
      ...refreshField,
      youtubeMux: {
        videoUrl,
        audioUrl,
        ...(option.muxPair.videoSource.size_bytes
          ? { videoSize: option.muxPair.videoSource.size_bytes }
          : {}),
        ...(option.muxPair.audioSource.size_bytes
          ? { audioSize: option.muxPair.audioSource.size_bytes }
          : {}),
        outputContainer: option.muxPair.outputContainer,
      },
    };
  }

  if (option.dashMux) {
    const exactDashBytes =
      parsePositiveSafeBytes(option.dashMux.videoSize) +
      parsePositiveSafeBytes(option.dashMux.audioSize);
    return {
      kind: "dash_mux",
      apiOrigin,
      routes: option.dashMux.videoRoutes,
      filename,
      mimeType: "video/mp4",
      ...(exactDashBytes > 0 ? { sizeBytes: exactDashBytes } : {}),
      ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
      ...refreshField,
      dashMux: option.dashMux,
    };
  }

  const delivery = option.variant.delivery;

  if (delivery.kind === "hls") {
    const routes = deliveryRoutes(delivery.sources, ctx);
    if (!routes.length) throw new Error("HLS 清单缺少可用来源");
    return {
      kind: "hls",
      apiOrigin,
      routes,
      filename,
      ...(option.formatMime ? { mimeType: option.formatMime } : {}),
      ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
      ...refreshField,
    };
  }

  if (delivery.kind === "segments") {
    const segments = buildSegmentsSpecFromDelivery(delivery, apiOrigin);
    const firstRoutes =
      segments[0]?.routes ?? (segments[0]?.url ? [segments[0].url] : []);
    return {
      kind: "segments",
      apiOrigin,
      routes: firstRoutes,
      filename,
      segments,
      ...(option.formatMime ? { mimeType: option.formatMime } : {}),
      ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
      ...refreshField,
    };
  }

  if (!option.routes.length) {
    throw new Error("所选画质当前无可用下载线路");
  }

  const isYouTubeDirect =
    media.platform === "youtube" &&
    isValidGooglevideoPlaybackUrl(option.routes[0]);

  return {
    kind: isYouTubeDirect ? "youtube_direct" : "direct_file",
    apiOrigin,
    routes: option.routes,
    filename,
    ...(option.formatMime ? { mimeType: option.formatMime } : {}),
    ...(option.sizeBytes > 0 ? { sizeBytes: option.sizeBytes } : {}),
    ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
    ...refreshField,
  };
}

export function buildSingleDownloadEnqueueItem(params: {
  media: UnifiedMedia;
  item: MediaItem;
  option: SidePanelQualityOption;
  settings: ExtensionSettings;
  workFingerprint?: string;
}): EnqueueDownloadItem {
  const { media, item, option, settings, workFingerprint } = params;
  const apiOrigin = resolveSafeApiOrigin(settings.apiBaseUrl);
  const baseName = resolveItemBaseName(media, item);
  const qualitySuffix =
    option.kind === "variant" && option.variant
      ? resolveAdaptiveQualityFilenameTag({
          enabled: Boolean(
            media.extra?.youtube_helper ||
              option.muxPair ||
              option.variant.metadata?.has_audio === false ||
              (item.type === "video" &&
                isStandaloneAudioMetadata(option.variant.metadata, item.type)),
          ),
          itemType: item.type,
          extension: option.resolvedExt,
          variant: option.variant,
        })
      : undefined;
  const stem =
    option.kind === "attachment" && option.attachment?.title?.trim()
      ? `${baseName}_${option.attachment.title.trim()}`
      : appendCanonicalQualitySuffix(baseName, qualitySuffix);

  const filename = buildSafeDownloadPath({
    prefix: settings.subfolderPrefix,
    stem,
    ext: option.resolvedExt,
  });

  const refreshContext = buildRefreshContextForOption({
    media,
    item,
    option,
  });

  const spec = buildSpecFromOption({
    media,
    option,
    filename,
    apiOrigin,
    refreshContext,
  });

  return {
    title: stem,
    platform: media.platform,
    ...(workFingerprint ? { workFingerprint } : {}),
    fallbackUrl: option.copyUrl || option.directUrl || media.source_url,
    ...(refreshContext ? { refreshContext } : {}),
    spec,
  };
}

function buildLeafResourceSpec(params: {
  media: UnifiedMedia;
  resource: Resource;
  filename: string;
  apiOrigin: string;
}): { spec: OffscreenDownloadSpec; ext: string; primaryUrl: string; sizeBytes?: number } {
  const { media, resource, filename } = params;
  const apiOrigin = resolveSafeApiOrigin(params.apiOrigin);
  const ctx = buildExtensionTargetContext(apiOrigin);
  const extraAllowedOrigins = buildExtraAllowedOrigins(apiOrigin);
  const delivery = resource.delivery;

  if (delivery.kind === "file") {
    const avail = availableSources(delivery.sources);
    const src = avail[0] ?? delivery.sources[0];
    if (!src) throw new Error("实况资源缺少可用来源");
    const routes = deliveryRoutes(avail.length ? avail : delivery.sources, ctx);
    const primaryUrl = routes[0] || sourceUrl(src, ctx);
    const ext = resolveVariantExtension({
      variant: {
        id: resource.id,
        state: "ready",
        metadata: resource.metadata,
        delivery,
      },
      itemType: resource.role === "image" ? "image" : "video",
      primaryUrl,
      platform: media.platform,
    }).ext;
    return {
      ext,
      primaryUrl,
      sizeBytes: src.size_bytes,
      spec: {
        kind: "direct_file",
        apiOrigin,
        routes,
        filename,
        ...(confirmedFormatMime(resource.metadata)
          ? { mimeType: confirmedFormatMime(resource.metadata) }
          : {}),
        ...(src.size_bytes ? { sizeBytes: src.size_bytes } : {}),
        ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
      },
    };
  }

  if (delivery.kind === "hls") {
    const routes = deliveryRoutes(delivery.sources, ctx);
    if (!routes.length) throw new Error("实况 HLS 缺少可用来源");
    const ext = mediaExtension(resource.metadata, delivery);
    return {
      ext: ext === "bin" ? "mp4" : ext,
      primaryUrl: routes[0],
      spec: {
        kind: "hls",
        apiOrigin,
        routes,
        filename,
        ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
      },
    };
  }

  if (delivery.kind !== "segments") {
    throw new Error("该资源需要 DASH 处理能力，当前暂不支持");
  }

  const segments = buildSegmentsSpecFromDelivery(delivery, apiOrigin);
  const firstRoutes =
    segments[0]?.routes ?? (segments[0]?.url ? [segments[0].url] : []);
  const ext = mediaExtension(resource.metadata, delivery);
  return {
    ext: ext === "bin" ? "mp4" : ext,
    primaryUrl: firstRoutes[0] ?? "",
    spec: {
      kind: "segments",
      apiOrigin,
      routes: firstRoutes,
      filename,
      segments,
      ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
    },
  };
}

export interface ChecklistItemSelectionEntry {
  item: MediaItem;
  /** 1-based display index in the full album/episode list so numbering matches user expectation (`001`, `003`, ...). */
  ordinalIndex: number;
  /** Optional explicit option override (e.g. if user chose a specific variant on the active episode). */
  explicitOption?: SidePanelQualityOption | null;
}

export function buildChecklistSubfolderEnqueueItems(params: {
  media: UnifiedMedia;
  entries: ChecklistItemSelectionEntry[];
  totalCount: number;
  settings: ExtensionSettings;
  livePhotoFilter: LivePhotoSaveFilter;
  workFingerprint?: string;
}): EnqueueDownloadItem[] {
  const {
    media,
    entries,
    totalCount,
    settings,
    livePhotoFilter,
    workFingerprint,
  } = params;
  const apiOrigin = resolveSafeApiOrigin(settings.apiBaseUrl);
  const subfolder = resolveWorkBaseTitle(media);
  const out: EnqueueDownloadItem[] = [];

  for (const { item, ordinalIndex, explicitOption } of entries) {
    if (!readyItem(item)) continue;

    if (item.type === "live_photo") {
      const pairVariant = item.variants.find(
        (v): v is ReadyVariant => readyVariant(v) && v.delivery.kind === "pair",
      );
      if (pairVariant && pairVariant.delivery.kind === "pair") {
        const motionRes = pairVariant.delivery.resources.find(
          (r) => r.role === "motion" || r.role === "video",
        );
        const imageRes = pairVariant.delivery.resources.find(
          (r) => r.role === "image",
        );

        if (
          (livePhotoFilter === "both" ||
            livePhotoFilter === "motion" ||
            livePhotoFilter === "video") &&
          motionRes
        ) {
          const probe = buildLeafResourceSpec({
            media,
            resource: motionRes,
            filename: "probe.mp4",
            apiOrigin,
          });
          const motionFilename = buildSafeDownloadPath({
            prefix: settings.subfolderPrefix,
            subfolder,
            index: ordinalIndex,
            totalCount,
            stem: livePhotoFilter === "both" ? "live" : undefined,
            ext: probe.ext,
          });
          const motionRefreshContext = buildRefreshContextForResource({
            media,
            item,
            variantId: pairVariant.id,
            resource: motionRes,
          });
          out.push({
            title: `${subfolder} #${ordinalIndex} (实况视频)`,
            platform: media.platform,
            ...(workFingerprint ? { workFingerprint } : {}),
            fallbackUrl: probe.primaryUrl || media.source_url,
            ...(motionRefreshContext ? { refreshContext: motionRefreshContext } : {}),
            spec: {
              ...probe.spec,
              filename: motionFilename,
              ...(motionRefreshContext
                ? { refreshContext: motionRefreshContext }
                : {}),
            },
          });
        }

        if (
          (livePhotoFilter === "both" || livePhotoFilter === "image") &&
          imageRes
        ) {
          const probe = buildLeafResourceSpec({
            media,
            resource: imageRes,
            filename: "probe.jpg",
            apiOrigin,
          });
          const imageFilename = buildSafeDownloadPath({
            prefix: settings.subfolderPrefix,
            subfolder,
            index: ordinalIndex,
            totalCount,
            stem: livePhotoFilter === "both" ? "cover" : undefined,
            ext: probe.ext,
          });
          const imageRefreshContext = buildRefreshContextForResource({
            media,
            item,
            variantId: pairVariant.id,
            resource: imageRes,
          });
          out.push({
            title: `${subfolder} #${ordinalIndex} (实况封面)`,
            platform: media.platform,
            ...(workFingerprint ? { workFingerprint } : {}),
            fallbackUrl: probe.primaryUrl || media.source_url,
            ...(imageRefreshContext ? { refreshContext: imageRefreshContext } : {}),
            spec: {
              ...probe.spec,
              filename: imageFilename,
              ...(imageRefreshContext
                ? { refreshContext: imageRefreshContext }
                : {}),
            },
          });
        }
        continue;
      }
    }

    const itemOptions = buildSidePanelQualityOptions(media, item, apiOrigin);
    const chosen =
      (explicitOption && explicitOption.downloadable ? explicitOption : null) ??
      selectPreferredQualityOption(
        itemOptions,
        item,
        settings.qualityPreference,
        media,
        apiOrigin,
      );
    if (!chosen || !chosen.downloadable) continue;

    // Images use clean `001.jpg` numbering; multi-P episodes include clean episode title `001_第一集.mp4`
    const episodeStem =
      item.type === "image"
        ? undefined
        : item.title?.trim() &&
            !isPlaceholderPartTitle(item.title) &&
            item.title.trim() !== subfolder
          ? item.title.trim()
          : undefined;

    const filename = buildSafeDownloadPath({
      prefix: settings.subfolderPrefix,
      subfolder,
      index: ordinalIndex,
      totalCount,
      stem: episodeStem,
      ext: chosen.resolvedExt,
    });

    const refreshContext = buildRefreshContextForOption({
      media,
      item,
      option: chosen,
    });

    const spec = buildSpecFromOption({
      media,
      option: chosen,
      filename,
      apiOrigin,
      refreshContext,
    });

    out.push({
      title: episodeStem ? `${subfolder} - ${episodeStem}` : `${subfolder} #${ordinalIndex}`,
      platform: media.platform,
      ...(workFingerprint ? { workFingerprint } : {}),
      fallbackUrl: chosen.copyUrl || chosen.directUrl || media.source_url,
      ...(refreshContext ? { refreshContext } : {}),
      spec,
    });
  }

  return out;
}

export function buildChecklistZipEnqueueItem(params: {
  media: UnifiedMedia;
  entries: ChecklistItemSelectionEntry[];
  totalCount: number;
  settings: ExtensionSettings;
  livePhotoFilter: LivePhotoSaveFilter;
  workFingerprint?: string;
}): { ok: true; item: EnqueueDownloadItem } | { ok: false; reason: string } {
  const { media, entries, totalCount, settings, livePhotoFilter, workFingerprint } =
    params;

  if (
    (media.platform === "pipigx" || media.platform === "zuiyou") &&
    entries.some((e) => e.item.type === "video")
  ) {
    return {
      ok: false,
      reason: "该平台视频不支持内存打包 ZIP，请使用「存子文件夹」直接落盘",
    };
  }

  const subfolderItems = buildChecklistSubfolderEnqueueItems({
    media,
    entries,
    totalCount,
    settings: { ...settings, subfolderPrefix: "" },
    livePhotoFilter,
    workFingerprint,
  });

  if (!subfolderItems.length) {
    return { ok: false, reason: "没有可打包的已就绪条目" };
  }

  const apiOrigin = resolveSafeApiOrigin(settings.apiBaseUrl);
  const extraAllowedOrigins = buildExtraAllowedOrigins(apiOrigin);

  let knownBytes = 0;
  const zipEntries: OffscreenZipEntrySpec[] = [];

  for (const sub of subfolderItems) {
    if (sub.spec.kind === "youtube_mux") {
      return {
        ok: false,
        reason:
          "YouTube 4K/高画质分离流需使用「存子文件夹」逐集无损合流（零内存上限）",
      };
    }
    if (sub.spec.kind === "dash_mux") {
      return {
        ok: false,
        reason:
          "DASH 音视频分离流需使用「存子文件夹」逐集无损合流（零内存上限）",
      };
    }
    if (sub.spec.kind === "hls") {
      return {
        ok: false,
        reason: "HLS 流媒体分片条目请使用「存子文件夹」流式落盘",
      };
    }
    if (!hasWhitelistedRoute(sub.spec.routes, extraAllowedOrigins)) {
      return {
        ok: false,
        reason:
          "该长尾站点媒体域名不在扩展打包白名单内，请使用「存子文件夹」直接通过浏览器原生保存",
      };
    }
    if (
      sub.spec.segments?.some((seg) => {
        const segRoutes = seg.routes?.length
          ? seg.routes
          : seg.url
            ? [seg.url]
            : [];
        return !hasWhitelistedRoute(segRoutes, extraAllowedOrigins);
      })
    ) {
      return {
        ok: false,
        reason:
          "该长尾站点媒体域名不在扩展打包白名单内，请使用「存子文件夹」直接通过浏览器原生保存",
      };
    }
    const size = parsePositiveSafeBytes(sub.spec.sizeBytes);
    knownBytes += size;
    if (knownBytes > MAX_EXTENSION_ZIP_BYTES) {
      return {
        ok: false,
        reason: "已选文件体积超过 500 MB 打包上限，请使用「存子文件夹」（无体积限制）",
      };
    }

    // Strip leading `<SafeTitle>/` so files sit cleanly inside `<SafeTitle>.zip` (or keep flat `001.jpg`)
    const slashIdx = sub.spec.filename.indexOf("/");
    const entryName =
      slashIdx >= 0 ? sub.spec.filename.slice(slashIdx + 1) : sub.spec.filename;

    zipEntries.push({
      entryName,
      routes: sub.spec.routes,
      ...(sub.spec.mimeType ? { mimeType: sub.spec.mimeType } : {}),
      ...(size > 0 ? { sizeBytes: size } : {}),
      ...(sub.spec.segments ? { segments: sub.spec.segments } : {}),
    });
  }

  const workTitle = resolveWorkBaseTitle(media);
  const zipFilename = buildSafeDownloadPath({
    prefix: settings.subfolderPrefix,
    stem: buildCanonicalArchiveStem(workTitle, zipEntries.length),
    ext: "zip",
  });

  return {
    ok: true,
    item: {
      title: `${workTitle} (${zipEntries.length}项打包)`,
      platform: media.platform,
      ...(workFingerprint ? { workFingerprint } : {}),
      fallbackUrl: media.source_url,
      spec: {
        kind: "batch_zip",
        apiOrigin,
        routes: zipEntries[0]?.routes ?? [],
        filename: zipFilename,
        mimeType: "application/zip",
        ...(knownBytes > 0 ? { sizeBytes: knownBytes } : {}),
        ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
        zipEntries,
      },
    },
  };
}
