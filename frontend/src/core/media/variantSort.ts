import type { ReadyVariant, Variant } from "../../types/media";
import { formatCodecLabel } from "../../utils/mediaSources";

/**
 * Single Source of Truth for canonical variant sorting & default variant
 * resolution across Web SPA, Extension SidePanel, and Extension Quick Download.
 *
 * Pure module: zero DOM dependencies, zero `chrome.*` dependencies, zero
 * platform-name branching. Never mutates `variant.id` or caller arrays.
 */

export interface VariantResolutionMetrics {
  resolutionTier: number;
  shortEdge: number;
  pixelArea: number;
  fps: number;
  fpsRank: number;
  tierSubRank: number;
  tierLabel: string;
}

export interface CanonicalVariantDescriptor {
  downloadable: boolean;
  isAudioOnly: boolean;
  /**
   * True when the option delivers playable audio (either embedded audio or
   * via an active muxer/pair in the current client environment).
   */
  effectiveHasAudio: boolean;
  isOriginalProvenance: boolean;
  resolutionTier: number;
  shortEdge: number;
  pixelArea: number;
  fps: number;
  tierSubRank: number;
  codecRank: number;
  bitrateBps: number;
  sizeBytes: number;
  originalIndex: number;
}

/**
 * Codec compatibility rank (higher is preferred at identical resolution & fps):
 * H.264 (AVC) > HEVC (H.265) > AV1 > VP9 > other/unknown.
 */
export function videoCodecCompatibilityRank(rawCodec: unknown): number {
  const normalized = formatCodecLabel(rawCodec).toUpperCase();
  if (normalized === "H.264") return 4;
  if (normalized === "HEVC") return 3;
  if (normalized === "AV1") return 2;
  if (normalized === "VP9") return 1;
  return 0;
}

function parsePositiveFinite(raw: unknown): number {
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

const LABEL_60FPS_RE =
  /(?:^|[^0-9])(?:\d{3,4}p|2k|4k|8k)60(?=$|[^a-z0-9])|\b60\s*fps\b/i;
const LABEL_HIGH_BITRATE_PLUS_RE = /(?:^|[^0-9])\d{3,4}p\+(?=$|[^a-z0-9])/i;

function inferFpsFromLabel(rawLabel: string, metaFps: number): number {
  if (metaFps > 0) return metaFps;
  return LABEL_60FPS_RE.test(rawLabel) ? 60 : 0;
}

function inferTierSubRankFromLabel(rawLabel: string): number {
  return LABEL_HIGH_BITRATE_PLUS_RE.test(rawLabel) ? 1 : 0;
}

function parseLabelResolutionFallback(
  rawLabel: string,
  metaFps: number,
): VariantResolutionMetrics {
  const label = rawLabel.trim();
  const effectiveFps = inferFpsFromLabel(label, metaFps);
  const tierSubRank = inferTierSubRankFromLabel(label);
  if (/\b8k\b/i.test(label) || /(?:^|[^0-9])8k60(?=$|[^a-z0-9])/i.test(label)) {
    return {
      resolutionTier: 4320,
      shortEdge: 4320,
      pixelArea: 7680 * 4320,
      fps: effectiveFps,
      fpsRank: effectiveFps || 30,
      tierSubRank,
      tierLabel: effectiveFps >= 50 ? "8K60" : "8K",
    };
  }
  if (/\b4k\b/i.test(label) || /(?:^|[^0-9])4k60(?=$|[^a-z0-9])/i.test(label)) {
    return {
      resolutionTier: 2160,
      shortEdge: 2160,
      pixelArea: 3840 * 2160,
      fps: effectiveFps,
      fpsRank: effectiveFps || 30,
      tierSubRank,
      tierLabel: effectiveFps >= 50 ? "4K60" : "4K",
    };
  }
  if (/\b2k\b/i.test(label) || /(?:^|[^0-9])2k60(?=$|[^a-z0-9])/i.test(label)) {
    return {
      resolutionTier: 1440,
      shortEdge: 1440,
      pixelArea: 2560 * 1440,
      fps: effectiveFps,
      fpsRank: effectiveFps || 30,
      tierSubRank,
      tierLabel: effectiveFps >= 50 ? "2K60" : "2K",
    };
  }
  const pMatch = /(?:^|[^0-9])(\d{3,4})p(60|\+)?(?=$|[^a-z0-9])/i.exec(label);
  if (pMatch) {
    const shortEdge = Number(pMatch[1]);
    const suffix = pMatch[2] || "";
    const inferredFps =
      suffix === "60" ? Math.max(effectiveFps, 60) : effectiveFps;
    const fpsRank =
      suffix === "60" ? 60 : suffix === "+" ? 45 : effectiveFps || 30;
    const approxLong = Math.round((shortEdge * 16) / 9);
    return {
      resolutionTier:
        shortEdge >= 4320
          ? 4320
          : shortEdge >= 2160
            ? 2160
            : shortEdge >= 1440
              ? 1440
              : shortEdge >= 1080
                ? 1080
                : shortEdge >= 720
                  ? 720
                  : shortEdge,
      shortEdge,
      pixelArea: shortEdge * approxLong,
      fps: inferredFps,
      fpsRank,
      tierSubRank: suffix === "+" ? 1 : tierSubRank,
      tierLabel: `${shortEdge}p${suffix}`,
    };
  }
  const dimMatch = /(\d{3,5})\s*[x×*]\s*(\d{3,5})/i.exec(label);
  if (dimMatch) {
    const w = Number(dimMatch[1]);
    const h = Number(dimMatch[2]);
    if (w > 0 && h > 0) {
      const shortEdge = Math.min(w, h);
      const longEdge = Math.max(w, h);
      const resolutionTier =
        shortEdge >= 4320 || longEdge >= 7680
          ? 4320
          : shortEdge >= 2160 || longEdge >= 3840
            ? 2160
            : shortEdge >= 1440 || longEdge >= 2560
              ? 1440
              : shortEdge >= 1080 || longEdge >= 1920
                ? 1080
                : shortEdge >= 720 || longEdge >= 1280
                  ? 720
                  : shortEdge;
      return {
        resolutionTier,
        shortEdge,
        pixelArea: w * h,
        fps: effectiveFps,
        fpsRank: effectiveFps || 30,
        tierSubRank,
        tierLabel:
          resolutionTier >= 4320
            ? "8K"
            : resolutionTier >= 2160
              ? "4K"
              : resolutionTier >= 1440
                ? "2K"
                : `${shortEdge}p`,
      };
    }
  }
  return {
    resolutionTier: 0,
    shortEdge: 0,
    pixelArea: 0,
    fps: effectiveFps,
    fpsRank: effectiveFps || 0,
    tierSubRank,
    tierLabel: "",
  };
}

/**
 * Extracts deterministic resolution & frame-rate metrics from variant metadata,
 * mux video resource metadata, or label fallback.
 */
export function resolveVariantResolution(
  variant: Variant | null | undefined,
): VariantResolutionMetrics {
  if (!variant || variant.state === "deferred") {
    return parseLabelResolutionFallback(variant?.label || "", 0);
  }
  const videoRes =
    variant.delivery.kind === "mux"
      ? variant.delivery.resources.find((r) => r.role === "video")
      : undefined;
  const meta = variant.metadata || {};
  const resMeta = videoRes?.metadata || {};
  const width = parsePositiveFinite(meta.width ?? resMeta.width);
  const height = parsePositiveFinite(meta.height ?? resMeta.height);
  const rawLabel = typeof variant.label === "string" ? variant.label.trim() : "";
  const rawFps = parsePositiveFinite(meta.fps ?? resMeta.fps);
  const fps = inferFpsFromLabel(rawLabel, rawFps);
  const tierSubRank = inferTierSubRankFromLabel(rawLabel);

  const shortEdge =
    width > 0 && height > 0 ? Math.min(width, height) : height || width;
  const longEdge = Math.max(width, height);
  const pixelArea =
    width > 0 && height > 0 ? width * height : shortEdge * shortEdge;

  if (shortEdge <= 0) {
    return parseLabelResolutionFallback(rawLabel, rawFps);
  }

  let resolutionTier = shortEdge;
  let tierLabel: string;
  let fpsRank = fps || 30;
  if (shortEdge >= 4320 || longEdge >= 7680 || /\b8k\b/i.test(rawLabel)) {
    resolutionTier = 4320;
    tierLabel = "8K";
  } else if (shortEdge >= 2160 || longEdge >= 3840 || /\b4k\b/i.test(rawLabel)) {
    resolutionTier = 2160;
    tierLabel = "4K";
  } else if (shortEdge >= 1440 || longEdge >= 2560 || /\b2k\b/i.test(rawLabel)) {
    resolutionTier = 1440;
    tierLabel = "2K";
  } else if (shortEdge >= 1080 || longEdge >= 1920) {
    resolutionTier = 1080;
    if (fps >= 50 || /\b1080p60\b/i.test(rawLabel)) {
      fpsRank = 60;
      tierLabel = "1080p60";
    } else if (tierSubRank > 0) {
      fpsRank = 45;
      tierLabel = "1080p+";
    } else {
      tierLabel = "1080p";
    }
  } else if (shortEdge >= 720 || longEdge >= 1280) {
    resolutionTier = 720;
    if (fps >= 50 || /\b720p60\b/i.test(rawLabel)) {
      fpsRank = 60;
      tierLabel = "720p60";
    } else {
      tierLabel = "720p";
    }
  } else {
    tierLabel = `${shortEdge}p`;
  }

  return {
    resolutionTier,
    shortEdge,
    pixelArea,
    fps,
    fpsRank,
    tierSubRank,
    tierLabel,
  };
}

function parseLabelBitrateBps(rawLabel: unknown): number {
  if (typeof rawLabel !== "string") return 0;
  const match = /(\d+(?:\.\d+)?)\s*kbps\b/i.exec(rawLabel);
  if (!match) return 0;
  const kbps = Number(match[1]);
  return Number.isFinite(kbps) && kbps > 0 ? Math.round(kbps * 1000) : 0;
}

/**
 * Extracts a canonical sort descriptor from any `Variant` + environment flags.
 */
export function buildCanonicalVariantDescriptor(params: {
  variant: Variant;
  downloadable: boolean;
  isAudioOnly?: boolean;
  effectiveHasAudio?: boolean;
  sizeBytes?: number;
  originalIndex: number;
}): CanonicalVariantDescriptor {
  const { variant, downloadable, originalIndex } = params;
  const ready: ReadyVariant | null =
    variant.state !== "deferred" ? variant : null;
  const meta = ready?.metadata || {};
  const videoRes =
    ready?.delivery.kind === "mux"
      ? ready.delivery.resources.find((r) => r.role === "video")
      : undefined;
  const audioRes =
    ready?.delivery.kind === "mux"
      ? ready.delivery.resources.find((r) => r.role === "audio")
      : undefined;
  const resMeta = videoRes?.metadata || {};

  const inferredAudioOnly =
    params.isAudioOnly ??
    Boolean(
      ready &&
        ((typeof meta.mime_type === "string" &&
          meta.mime_type.toLowerCase().startsWith("audio/")) ||
          (meta.has_audio === true &&
            !meta.video_codec &&
            !meta.width &&
            !meta.height)),
    );

  const effectiveHasAudio =
    params.effectiveHasAudio ??
    (inferredAudioOnly
      ? true
      : ready?.delivery.kind === "mux"
        ? true
        : meta.has_audio !== false);

  const resolution = inferredAudioOnly
    ? {
        resolutionTier: 0,
        shortEdge: 0,
        pixelArea: 0,
        fps: 0,
        fpsRank: 0,
        tierSubRank: 0,
        tierLabel: "",
      }
    : resolveVariantResolution(variant);

  const rawCodec = meta.video_codec ?? resMeta.video_codec;
  const codecRank = inferredAudioOnly
    ? 0
    : videoCodecCompatibilityRank(rawCodec);

  const videoBitrate = parsePositiveFinite(
    meta.video_bitrate_bps ?? resMeta.video_bitrate_bps ?? resMeta.bitrate_bps,
  );
  const audioBitrate = parsePositiveFinite(
    meta.audio_bitrate_bps ??
      audioRes?.metadata?.audio_bitrate_bps ??
      audioRes?.metadata?.bitrate_bps,
  );
  const bitrateBps =
    parsePositiveFinite(meta.bitrate_bps) ||
    videoBitrate + audioBitrate ||
    (inferredAudioOnly ? parseLabelBitrateBps(variant.label) : 0);

  let inferredSize = parsePositiveFinite(params.sizeBytes);
  if (!inferredSize && ready) {
    if (ready.delivery.kind === "file") {
      inferredSize = parsePositiveFinite(ready.delivery.sources[0]?.size_bytes);
    } else if (ready.delivery.kind === "mux") {
      const vSize =
        videoRes?.delivery.kind === "file"
          ? parsePositiveFinite(videoRes.delivery.sources[0]?.size_bytes)
          : 0;
      const aSize =
        audioRes?.delivery.kind === "file"
          ? parsePositiveFinite(audioRes.delivery.sources[0]?.size_bytes)
          : 0;
      inferredSize = vSize + aSize;
    }
  }

  return {
    downloadable,
    isAudioOnly: inferredAudioOnly,
    effectiveHasAudio,
    isOriginalProvenance: variant.provenance === "original_endpoint",
    resolutionTier: resolution.resolutionTier,
    shortEdge: resolution.shortEdge,
    pixelArea: resolution.pixelArea,
    fps: resolution.fps,
    tierSubRank: resolution.tierSubRank,
    codecRank,
    bitrateBps,
    sizeBytes: inferredSize,
    originalIndex,
  };
}

/**
 * Deterministic canonical variant comparator (descending quality order):
 * 1. Downloadable in current client environment > unavailable
 * 2. Video > audio-only
 * 3. Playable audio (embedded or active mux) > silent-only without muxer
 * 4. Original endpoint provenance (`provenance === "original_endpoint"`)
 * 5. Resolution tier descending (8K > 4K > 2K > 1080p > 720p > 480p > 360p)
 * 6. Frame rate `fps` descending (60fps > 30fps, e.g. cinema 3840x2026@60 > 3840x2160@30)
 * 7. Tier high-bitrate sub-rank descending (e.g. 1080p+ > 1080p at equal resolution & fps)
 * 8. Exact short-edge & pixel area descending
 * 9. Video codec compatibility: H.264 (AVC) > HEVC (H.265) > AV1 > VP9 > other
 * 10. Bitrate descending, then exact size bytes descending
 * 11. Stable tie-breaker by original index ascending
 */
export function compareCanonicalVariantDesc(
  a: CanonicalVariantDescriptor,
  b: CanonicalVariantDescriptor,
): number {
  if (a.downloadable !== b.downloadable) {
    return a.downloadable ? -1 : 1;
  }
  if (a.isAudioOnly !== b.isAudioOnly) {
    return a.isAudioOnly ? 1 : -1;
  }
  if (!a.isAudioOnly && a.effectiveHasAudio !== b.effectiveHasAudio) {
    return a.effectiveHasAudio ? -1 : 1;
  }
  if (a.isOriginalProvenance !== b.isOriginalProvenance) {
    return a.isOriginalProvenance ? -1 : 1;
  }
  if (a.resolutionTier !== b.resolutionTier) {
    return b.resolutionTier - a.resolutionTier;
  }
  if (a.fps !== b.fps) {
    return b.fps - a.fps;
  }
  if (a.tierSubRank !== b.tierSubRank) {
    return b.tierSubRank - a.tierSubRank;
  }
  if (a.shortEdge !== b.shortEdge) {
    return b.shortEdge - a.shortEdge;
  }
  if (a.pixelArea !== b.pixelArea) {
    return b.pixelArea - a.pixelArea;
  }
  if (a.codecRank !== b.codecRank) {
    return b.codecRank - a.codecRank;
  }
  if (a.bitrateBps !== b.bitrateBps) {
    return b.bitrateBps - a.bitrateBps;
  }
  if (a.sizeBytes !== b.sizeBytes) {
    return b.sizeBytes - a.sizeBytes;
  }
  return a.originalIndex - b.originalIndex;
}

/**
 * Pure canonical variant sorter shared by Web and Extension.
 * Never mutates the input array or any `variant.id`.
 */
export function sortVariantsCanonical<T>(
  options: ReadonlyArray<T>,
  getDescriptor: (option: T, originalIndex: number) => CanonicalVariantDescriptor,
): T[] {
  if (options.length <= 1) {
    return [...options];
  }
  const decorated = options.map((option, index) => ({
    option,
    descriptor: getDescriptor(option, index),
  }));
  decorated.sort((a, b) =>
    compareCanonicalVariantDesc(a.descriptor, b.descriptor),
  );
  return decorated.map((entry) => entry.option);
}
