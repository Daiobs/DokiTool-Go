import {
  readyItem,
  readyVariant,
  getDownloadTarget,
  requiredCapabilities,
  sourceAvailable,
} from "../../utils/mediaContract";
import { extractDashMuxSpec } from "../../extension/dashMuxSpec";
import { formatCodecLabel, formatMediaSize } from "../../utils/mediaSources";
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
  options?: { allowExtensionDashMux?: boolean },
) {
  if (!readyItem(currentItem)) return [];
  const allowExtensionDashMux = Boolean(options?.allowExtensionDashMux);
  return currentItem.variants.map((variant: any) => {
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
      ? extractDashMuxSpec(variant, context)
      : null;
    const extensionMux = Boolean(allowExtensionDashMux && dashMux);
    const isActive = extensionMux
      ? active
      : active &&
        currentTarget?.kind === downloadTarget.kind &&
        (downloadTarget.kind !== "file" ||
          currentTarget.url === downloadTarget.url);
    return {
      variant,
      source: downloadTarget.kind === "file" ? downloadTarget.source : source,
      active: isActive,
      downloadTarget,
      dashMux,
      extensionMux,
      downloadable:
        ["file", "hls", "segments", "pair"].includes(downloadTarget.kind) ||
        extensionMux,
      capabilities: readyVariant(variant)
        ? requiredCapabilities(variant.delivery)
        : [],
    };
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
): string {
  const ver = version ? `v${version}` : "";
  if (locale === "en") {
    return ver
      ? `Helper ${ver} Ready · Auto Audio Mux`
      : "Helper Ready · Auto Audio Mux";
  }
  return ver ? `助手 ${ver} 已就绪 · 自动合成原声` : "助手已就绪 · 自动合成原声";
}

export function formatHeaderReadyTitle(
  version: string | null | undefined,
  locale?: string,
): string {
  const ver = version ? ` (v${version})` : "";
  return locale === "en"
    ? `YouTube Helper${ver} is ready: high-quality downloads automatically mux original audio losslessly in the browser; 360p includes audio for inline preview and direct download.`
    : `YouTube 助手${ver}已就绪：高画质下载自动分块并发无损合成原声至浏览器默认下载目录；360p 音画合一支持在线预览与浏览器直下。`;
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
  if (highTier) addToken(highTier);
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

export interface BilibiliDashSummary {
  tierCount: number;
  maxResolution: string;
  videoCodecs: string[];
  audioCodec: string;
  specText: string;
}

const VIDEO_CODEC_ORDER: Record<string, number> = {
  "H.264": 0,
  HEVC: 1,
  AV1: 2,
  VP9: 3,
};

function resolveDashResolutionRank(variant: ReadyVariant): {
  pixels: number;
  fpsRank: number;
  label: string;
} {
  const videoRes =
    variant.delivery.kind === "mux"
      ? variant.delivery.resources.find((r) => r.role === "video")
      : undefined;
  const meta = variant.metadata || {};
  const resMeta = videoRes?.metadata || {};
  const width = Number(meta.width ?? resMeta.width) || 0;
  const height = Number(meta.height ?? resMeta.height) || 0;
  const fps = Number(meta.fps ?? resMeta.fps) || 0;
  const rawLabel = typeof variant.label === "string" ? variant.label.trim() : "";
  const shortEdge = width > 0 && height > 0 ? Math.min(width, height) : height || width;
  const longEdge = Math.max(width, height);

  if (shortEdge >= 4320 || longEdge >= 7680 || /\b8k\b/i.test(rawLabel)) {
    return { pixels: 4320, fpsRank: fps || 30, label: "8K" };
  }
  if (shortEdge >= 2160 || longEdge >= 3840 || /\b4k\b/i.test(rawLabel)) {
    return { pixels: 2160, fpsRank: fps || 30, label: "4K" };
  }
  if (shortEdge >= 1440 || longEdge >= 2560 || /\b2k\b/i.test(rawLabel)) {
    return { pixels: 1440, fpsRank: fps || 30, label: "2K" };
  }
  if (shortEdge >= 1080 || longEdge >= 1920) {
    if (fps >= 50 || /\b1080p60\b/i.test(rawLabel)) {
      return { pixels: 1080, fpsRank: 60, label: "1080p60" };
    }
    if (/\b1080p\+/i.test(rawLabel)) {
      return { pixels: 1080, fpsRank: 45, label: "1080p+" };
    }
    return { pixels: 1080, fpsRank: fps || 30, label: "1080p" };
  }
  if (shortEdge >= 720 || longEdge >= 1280) {
    if (fps >= 50 || /\b720p60\b/i.test(rawLabel)) {
      return { pixels: 720, fpsRank: 60, label: "720p60" };
    }
    return { pixels: 720, fpsRank: fps || 30, label: "720p" };
  }
  if (shortEdge > 0) {
    return { pixels: shortEdge, fpsRank: fps || 30, label: `${shortEdge}p` };
  }
  const pMatch = /\b(\d{3,4})p(60|\+)?(?=$|[\s·•(（/|,，])/i.exec(rawLabel);
  if (pMatch) {
    const pVal = Number(pMatch[1]);
    const suffix = pMatch[2] || "";
    const fpsRank = suffix === "60" ? 60 : suffix === "+" ? 45 : fps || 30;
    return { pixels: pVal, fpsRank, label: `${pVal}p${suffix}` };
  }
  return { pixels: 0, fpsRank: 0, label: "" };
}

export function extractBilibiliDashMuxVariants(
  platform: string | undefined,
  currentItem: any,
): ReadyVariant[] {
  if (platform !== "bilibili" || !readyItem(currentItem)) return [];
  return currentItem.variants.filter(
    (variant: any): variant is ReadyVariant =>
      readyVariant(variant) && variant.delivery.kind === "mux",
  );
}

export function summarizeBilibiliDashMuxVariants(
  variants: ReadyVariant[],
): BilibiliDashSummary | null {
  if (!Array.isArray(variants) || variants.length === 0) return null;

  let best = { pixels: -1, fpsRank: -1, label: "" };
  const videoCodecSet = new Set<string>();
  const audioCodecSet = new Set<string>();

  for (const variant of variants) {
    const rank = resolveDashResolutionRank(variant);
    if (
      rank.pixels > best.pixels ||
      (rank.pixels === best.pixels && rank.fpsRank > best.fpsRank)
    ) {
      best = rank;
    }

    const resources =
      variant.delivery.kind === "mux" ? variant.delivery.resources : [];
    const videoRes = resources.find((r) => r.role === "video");
    const audioRes = resources.find((r) => r.role === "audio");

    const vCodec = formatCodecLabel(
      variant.metadata?.video_codec || videoRes?.metadata?.video_codec,
    );
    if (vCodec) videoCodecSet.add(vCodec);

    const aCodec = formatCodecLabel(
      variant.metadata?.audio_codec || audioRes?.metadata?.audio_codec,
    );
    if (aCodec) audioCodecSet.add(aCodec);
  }

  const videoCodecs = [...videoCodecSet].sort((a, b) => {
    const oa = Object.prototype.hasOwnProperty.call(VIDEO_CODEC_ORDER, a)
      ? VIDEO_CODEC_ORDER[a]
      : 99;
    const ob = Object.prototype.hasOwnProperty.call(VIDEO_CODEC_ORDER, b)
      ? VIDEO_CODEC_ORDER[b]
      : 99;
    return oa !== ob ? oa - ob : a.localeCompare(b);
  });

  const audioCodec = audioCodecSet.has("AAC")
    ? "AAC"
    : [...audioCodecSet][0] || "";

  const codecPart =
    videoCodecs.length && audioCodec
      ? `${videoCodecs.join(" / ")} + ${audioCodec}`
      : videoCodecs.length
        ? videoCodecs.join(" / ")
        : audioCodec;
  const specText = [best.label, codecPart].filter(Boolean).join(" · ");

  return {
    tierCount: variants.length,
    maxResolution: best.label,
    videoCodecs,
    audioCodec,
    specText,
  };
}
