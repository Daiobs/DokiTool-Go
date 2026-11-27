import {
  deliveryRoutes,
  readyItem,
  readyVariant,
  getDownloadTarget,
  requiredCapabilities,
  sourceAvailable,
  sourceUrl,
} from "../../utils/mediaContract";
import {
  buildCanonicalVariantDescriptor,
  extractWhitelistedMuxVariants,
  resolveWhitelistedExtensionMuxSpec,
  sortVariantsCanonical,
  summarizeMuxVariants,
  type MuxTierSummary,
} from "../../core/media";
import { formatMediaSize } from "../../utils/mediaSources";
import type { ReadyVariant } from "../../types/media";
import {
  t,
  parsePositiveSafeBytes,
  resolveYouTubeHighResTier,
  resolveYouTubeDownloadTier,
  resolveYouTubeAudioFormatLabel,
} from "./resultI18n";

export function buildAllQualityOptions(
  currentItem: any,
  currentSelection: any,
  currentTarget: any,
  context: { apiOrigin: string },
  options?: {
    allowExtensionDashMux?: boolean;
    muxPairsByVariantId?: ReadonlyMap<string, unknown>;
  },
) {
  if (!readyItem(currentItem)) return [];
  const allowExtensionDashMux = Boolean(options?.allowExtensionDashMux);
  const muxPairs = options?.muxPairsByVariantId;
  const rawOptions = currentItem.variants.map((variant: any) => {
    const active =
      (currentSelection?.variant_id || currentItem.default?.variant_id) ===
      variant.id;
    const source =
      readyVariant(variant) && variant.delivery.kind === "file"
        ? variant.delivery.sources.find(
            (src: any) =>
              active &&
              sourceAvailable(src) &&
              src.id ===
                (currentSelection
                  ? currentSelection.source_id
                  : currentItem.default?.source_id),
          ) ||
          variant.delivery.sources.find((src: any) => sourceAvailable(src)) ||
          variant.delivery.sources[0]
        : null;
    const downloadTarget = getDownloadTarget(
      currentItem,
      {
        variant_id: variant.id,
        ...(source?.id ? { source_id: source.id } : {}),
      },
      context,
    );
    const dashMux = readyVariant(variant)
      ? resolveWhitelistedExtensionMuxSpec(variant, context)
      : null;
    const extensionMux = Boolean(allowExtensionDashMux && dashMux);
    const clientSplitMux = Boolean(variant?.id && muxPairs?.has(variant.id));
    const isActive = extensionMux
      ? active
      : active &&
        currentTarget?.kind === downloadTarget.kind &&
        (downloadTarget.kind !== "file" ||
          currentTarget.url === downloadTarget.url);
    const downloadable =
      ["file", "hls", "segments", "pair"].includes(downloadTarget.kind) ||
      extensionMux;
    let streamCopyUrl = "";
    if (
      !downloadable &&
      readyVariant(variant) &&
      (variant.delivery.kind === "hls" || variant.delivery.kind === "dash")
    ) {
      try {
        const routes = deliveryRoutes(variant.delivery.sources, context);
        if (routes.length > 0) {
          streamCopyUrl = routes[0];
        } else {
          const fallbackSource = variant.delivery.sources.find(
            (src: any) => src?.availability !== "unavailable",
          );
          if (fallbackSource) {
            streamCopyUrl = sourceUrl(fallbackSource, context);
          }
        }
      } catch {
        streamCopyUrl = "";
      }
    }
    return {
      variant,
      source: downloadTarget.kind === "file" ? downloadTarget.source : source,
      active: isActive,
      downloadTarget,
      dashMux,
      extensionMux,
      clientSplitMux,
      downloadable,
      ...(streamCopyUrl ? { streamCopyUrl } : {}),
      capabilities: readyVariant(variant)
        ? requiredCapabilities(variant.delivery)
        : [],
    };
  });

  return sortVariantsCanonical(rawOptions, (option, originalIndex) => {
    const hasActiveMuxPair = Boolean(
      option.extensionMux ||
        (option.variant?.id && muxPairs?.has(option.variant.id)),
    );
    const meta =
      option.variant?.state !== "deferred" ? option.variant?.metadata : undefined;
    const isAudioOnly = Boolean(
      meta &&
        ((typeof meta.mime_type === "string" &&
          meta.mime_type.toLowerCase().startsWith("audio/")) ||
          (meta.has_audio === true &&
            !meta.video_codec &&
            !meta.width &&
            !meta.height)),
    );
    const effectiveHasAudio = isAudioOnly
      ? true
      : hasActiveMuxPair
        ? true
        : meta?.has_audio !== false;
    return buildCanonicalVariantDescriptor({
      variant: option.variant,
      downloadable: option.downloadable,
      isAudioOnly,
      effectiveHasAudio,
      sizeBytes: option.source?.size_bytes,
      originalIndex,
    });
  });
}

function estimateDashOptionSizeLabel(
  option: any,
  locale?: string,
  itemDurationMs?: number,
): string {
  const dashMux = option?.dashMux;
  if (!dashMux) return formatMediaSize(undefined, locale);
  const vExact = parsePositiveSafeBytes(dashMux.videoSize);
  const aExact = parsePositiveSafeBytes(dashMux.audioSize);
  if (vExact > 0 && aExact > 0 && Number.isSafeInteger(vExact + aExact)) {
    return formatMediaSize(vExact + aExact, locale);
  }
  const variant = option.variant;
  const resources =
    variant?.state !== "deferred" && variant?.delivery?.kind === "mux"
      ? variant.delivery.resources
      : [];
  const vMeta = resources.find((r: any) => r?.role === "video")?.metadata;
  const aMeta = resources.find((r: any) => r?.role === "audio")?.metadata;
  const durationMs =
    Number(
      variant?.metadata?.duration_ms ||
        vMeta?.duration_ms ||
        aMeta?.duration_ms ||
        itemDurationMs ||
        0,
    ) || 0;
  const videoBps =
    Number(
      variant?.metadata?.video_bitrate_bps ||
        vMeta?.video_bitrate_bps ||
        vMeta?.bitrate_bps ||
        0,
    ) || 0;
  const audioBps =
    Number(
      variant?.metadata?.audio_bitrate_bps ||
        aMeta?.audio_bitrate_bps ||
        aMeta?.bitrate_bps ||
        0,
    ) || 0;
  const combinedBps =
    videoBps + audioBps || Number(variant?.metadata?.bitrate_bps || 0) || 0;
  const estimatedBytes =
    combinedBps > 0 && durationMs > 0
      ? Math.round((combinedBps * durationMs) / 8000)
      : 0;
  if (estimatedBytes > 0) {
    const base = formatMediaSize(estimatedBytes, locale);
    if (locale === "en") {
      return base.startsWith("<") ? base : `~${base}`;
    }
    return `约 ${base}`;
  }
  if (vExact + aExact > 0) {
    return formatMediaSize(vExact + aExact, locale);
  }
  return formatMediaSize(undefined, locale);
}

export function formatYouTubeMuxOptionSize(
  option: any,
  muxPairsByVariantId: Map<string, any>,
  locale?: string,
  itemDurationMs?: number,
): string {
  if (option?.extensionMux && option?.dashMux) {
    return estimateDashOptionSizeLabel(option, locale, itemDurationMs);
  }
  const pair = option?.variant?.id
    ? muxPairsByVariantId.get(option.variant.id)
    : null;
  if (pair) {
    const videoBytes = parsePositiveSafeBytes(
      option.source?.size_bytes ?? pair.videoSource?.size_bytes,
    );
    const audioBytes = parsePositiveSafeBytes(pair.audioSource?.size_bytes);
    if (
      videoBytes > 0 &&
      audioBytes > 0 &&
      Number.isSafeInteger(videoBytes + audioBytes)
    ) {
      const base = formatMediaSize(videoBytes + audioBytes, locale);
      if (locale === "en") {
        return base.startsWith("<") ? base : `~${base}`;
      }
      return `约 ${base}`;
    }
    if (videoBytes > 0) return formatMediaSize(videoBytes, locale);
    return formatMediaSize(undefined, locale);
  }
  return formatMediaSize(option?.source?.size_bytes, locale);
}

export function formatHeaderReadyStatus(
  version: string | null | undefined,
  locale?: string,
  _provider?: "extension",
): string {
  const ver = version ? `v${version}` : "";
  if (locale === "en") {
    return ver
      ? `Extension ${ver} Ready · Lossless Mux`
      : "Extension Ready · Lossless Mux";
  }
  return ver
    ? `扩展 ${ver} 已就绪 · 无损合流`
    : "扩展已就绪 · 无损合流";
}

export function formatHeaderReadyTitle(
  version: string | null | undefined,
  locale?: string,
  _provider?: "extension",
): string {
  const ver = version ? ` (v${version})` : "";
  return locale === "en"
    ? `DokiTool Extension${ver} is ready: zero-cookie local parsing & background lossless audio/video muxing.`
    : `DokiTool 扩展${ver}已就绪：零 Cookie 本地解析，高画质下载自动后台无损合流原声至浏览器默认下载目录。`;
}

export function buildPlayerQualityTagText(
  activeVariant: any,
  baseLabel: string,
  hasActiveMuxPair: boolean,
  locale?: string,
): string {
  if (!activeVariant) return "";
  if (!hasActiveMuxPair) return baseLabel;
  const tokens: string[] = [];
  const addToken = (tok: string) => {
    const tVal = String(tok || "").trim();
    if (!tVal) return;
    if (
      !tokens.some((existing) => existing.toLowerCase() === tVal.toLowerCase())
    ) {
      tokens.push(tVal);
    }
  };
  const parenParts: string[] = [];
  const outside = baseLabel
    .replace(/\s*[（(]([^()（）]*)[)）]/g, (_m, inner) => {
      for (const part of String(inner).split(/\s*[·•,，]\s*/)) {
        parenParts.push(part);
      }
      return "";
    })
    .trim();
  for (const part of outside.split(/\s*[·•]\s*/)) addToken(part);
  for (const part of parenParts) addToken(part);
  const highTier = resolveYouTubeHighResTier(activeVariant);
  if (highTier) {
    // Deduplicate stale/conflicting resolution tier badges (e.g. `4K` + `8K` on 4320p60).
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (/^[248]k$/i.test(tokens[i]) && tokens[i].toUpperCase() !== highTier) {
        tokens.splice(i, 1);
      }
    }
    addToken(highTier);
  }
  const specPrefix = tokens.join(" · ") || baseLabel;
  return locale === "en"
    ? `${specPrefix} (Silent preview · Audio included on download)`
    : `${specPrefix}（预览无声 · 下载含音频）`;
}

export function resolvePrimaryDownloadCtaLabel(params: {
  locale?: string;
  needsQualitySelection: boolean;
  isActiveYouTubeSplitVideo: boolean;
  hasActiveYouTubeMuxPair: boolean;
  isActiveYouTubeAudioOnly: boolean;
  activeVariant: any;
}): string {
  if (params.needsQualitySelection) {
    return t(params.locale, "selectQualityFirst");
  }
  if (params.isActiveYouTubeSplitVideo && params.hasActiveYouTubeMuxPair) {
    const tier = resolveYouTubeDownloadTier(params.activeVariant);
    if (tier) {
      return t(params.locale, "downloadTierWithAudio").replace("{tier}", tier);
    }
    return t(params.locale, "downloadWithAudio");
  }
  if (params.isActiveYouTubeAudioOnly) {
    const fmt = resolveYouTubeAudioFormatLabel(params.activeVariant);
    if (fmt) {
      return t(params.locale, "downloadAudioFormat").replace("{format}", fmt);
    }
    return t(params.locale, "downloadAudio");
  }
  return t(params.locale, "downloadSingle");
}

export type BilibiliDashSummary = MuxTierSummary;

export function extractMuxVariants(
  currentItem: any,
  context?: { apiOrigin?: string },
): ReadyVariant[] {
  return extractWhitelistedMuxVariants(currentItem, context);
}

export function summarizeMuxTiers(
  variants: ReadyVariant[],
): MuxTierSummary | null {
  return summarizeMuxVariants(variants);
}

/**
 * Capability-driven mux variant extractor (retained alias for backwards compatibility;
 * no longer restricts to any single platform name).
 */
export function extractBilibiliDashMuxVariants(
  _platform: string | undefined,
  currentItem: any,
  context?: { apiOrigin?: string },
): ReadyVariant[] {
  return extractWhitelistedMuxVariants(currentItem, context);
}

export function summarizeBilibiliDashMuxVariants(
  variants: ReadyVariant[],
): MuxTierSummary | null {
  return summarizeMuxVariants(variants);
}
