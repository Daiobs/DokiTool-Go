import {
  readyItem,
  readyVariant,
  getDownloadTarget,
  requiredCapabilities,
  sourceAvailable,
} from "../../utils/mediaContract";
import { formatMediaSize } from "../../utils/mediaSources";
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
) {
  if (!readyItem(currentItem)) return [];
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
    return {
      variant,
      source: downloadTarget.kind === "file" ? downloadTarget.source : source,
      active:
        active &&
        currentTarget?.kind === downloadTarget.kind &&
        (downloadTarget.kind !== "file" ||
          currentTarget.url === downloadTarget.url),
      downloadTarget,
      downloadable: ["file", "hls", "segments", "pair"].includes(
        downloadTarget.kind,
      ),
      capabilities: readyVariant(variant)
        ? requiredCapabilities(variant.delivery)
        : [],
    };
  });
}

export function formatYouTubeMuxOptionSize(
  option: any,
  muxPairsByVariantId: Map<string, any>,
  locale?: string,
): string {
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
