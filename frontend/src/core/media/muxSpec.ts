import type {
  Attachment,
  MediaItem,
  ReadyVariant,
  Resource,
  Variant,
} from "../../types/media";
import {
  availableSources,
  deliveryRoutes,
  readyItem,
  readyVariant,
  sourceRoutes,
  type TargetContext,
} from "../../utils/mediaContract";
import { formatCodecLabel } from "../../utils/mediaSources";
import { extractDashMuxSpec } from "../../extension/dashMuxSpec";
import {
  isWhitelistedMediaUrl,
  validateApiBaseUrl,
} from "../../extension/hostWhitelist";
import {
  isRefererProtectedMediaRoute,
  prefersExtensionDirectAcceleration,
} from "./cdnTransportHints";
import {
  resolveVariantResolution,
  videoCodecCompatibilityRank,
} from "./variantSort";

/**
 * Unified, capability-driven mux specification shared by Web and Extension.
 * Normalizes both `delivery.kind === "mux"` variants (any platform, including
 * Bilibili and Tier-2 yt-dlp sites) and split video-only + standalone audio
 * streams (e.g. YouTube 4K60/1080p) into a single structural representation.
 */
export interface UnifiedMuxSpec {
  kind: "dash_mux" | "split_mux";
  videoRoutes: string[];
  audioRoutes: string[];
  videoSize?: number;
  audioSize?: number;
  outputContainer: "mp4" | "webm";
  videoVariantId?: string;
  audioVariantId?: string;
  audioAttachmentId?: string;
}

export interface MuxTierSummary {
  tierCount: number;
  maxResolution: string;
  videoCodecs: string[];
  audioCodec: string;
  specText: string;
}

function parsePositiveSafeBytes(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
    ? raw
    : undefined;
}

/**
 * Pure metadata capability predicate identifying audio-only variants
 * (zero platform-name branching).
 */
export function isAudioOnlyVariant(
  variant: Variant | null | undefined,
): boolean {
  if (!variant || variant.state === "deferred") return false;
  const meta = variant.metadata;
  if (!meta) return false;
  if (typeof meta.mime_type === "string" && meta.mime_type.toLowerCase().startsWith("audio/")) {
    return true;
  }
  return (
    meta.has_audio === true &&
    !meta.video_codec &&
    !meta.width &&
    !meta.height
  );
}

/**
 * Pure metadata capability predicate identifying split silent video streams
 * (`has_audio === false`) on a video item that benefit from lossless audio muxing.
 */
export function isSplitSilentVideoVariant(
  item: Pick<MediaItem, "type"> | null | undefined,
  variant: Variant | null | undefined,
): boolean {
  if (!item || item.type !== "video" || !variant || variant.state === "deferred") {
    return false;
  }
  return variant.metadata?.has_audio === false;
}

/**
 * Extracts a normalized `UnifiedMuxSpec` from any ready `delivery.kind === "mux"`
 * variant across ALL platforms (no platform-name guard).
 */
export function extractMuxSpec(
  variant: ReadyVariant,
  context: TargetContext = {},
): UnifiedMuxSpec | null {
  const dash = extractDashMuxSpec(variant, context);
  if (!dash) return null;
  return {
    kind: "dash_mux",
    videoRoutes: dash.videoRoutes,
    audioRoutes: dash.audioRoutes,
    ...(dash.videoSize ? { videoSize: dash.videoSize } : {}),
    ...(dash.audioSize ? { audioSize: dash.audioSize } : {}),
    outputContainer: dash.outputContainer,
    videoVariantId: variant.id,
  };
}

/**
 * Resolves effective extra allowed origins for extension media whitelist checks.
 * - Explicit `extraAllowedOrigins` always takes precedence.
 * - Otherwise, ONLY when `context.apiOrigin` (or same-origin browser `location.origin`
 *   when `apiOrigin` is empty) passes `validateApiBaseUrl` with `isLoopback === true`
 *   (`http://127.0.0.1[:port]` / `http://localhost[:port]`), returns `[validated.origin]`.
 * - Public HTTPS origins NEVER inject extra allowed origins (100% fail-closed).
 */
export function resolveAllowedOriginsFromContext(
  context?: TargetContext,
  extraAllowedOrigins?: string[],
): string[] | undefined {
  if (extraAllowedOrigins !== undefined) {
    return extraAllowedOrigins;
  }
  const candidate =
    context?.apiOrigin ||
    (typeof location !== "undefined" && typeof location.origin === "string"
      ? location.origin
      : "");
  if (!candidate) {
    return undefined;
  }
  const validated = validateApiBaseUrl(candidate);
  return validated.ok && validated.isLoopback ? [validated.origin] : undefined;
}

/**
 * Extracts a `UnifiedMuxSpec` from a ready `delivery.kind === "mux"` variant
 * and filters both `videoRoutes` and `audioRoutes` down to the subset allowed
 * by the extension's strict host whitelist (including loopback `context.apiOrigin`
 * when applicable). Returns `null` unless at least one video route AND one audio
 * route pass the whitelist.
 */
export function resolveWhitelistedExtensionMuxSpec(
  variant: ReadyVariant,
  context: TargetContext = {},
  extraAllowedOrigins?: string[],
): UnifiedMuxSpec | null {
  const spec = extractMuxSpec(variant, context);
  if (!spec) return null;
  const allowedOrigins = resolveAllowedOriginsFromContext(
    context,
    extraAllowedOrigins,
  );
  const allowed = (url: string) =>
    isWhitelistedMediaUrl(url, allowedOrigins).allowed;
  const videoRoutes = spec.videoRoutes.filter(allowed);
  const audioRoutes = spec.audioRoutes.filter(allowed);
  if (!videoRoutes.length || !audioRoutes.length) {
    return null;
  }
  return {
    ...spec,
    videoRoutes,
    audioRoutes,
  };
}

/**
 * Returns true iff at least one video route AND at least one audio route of a
 * `UnifiedMuxSpec` fall within the extension's strict host whitelist (never
 * promising extension muxing for unwhitelisted third-party origins).
 */
export function isMuxSpecWhitelistedForExtension(
  spec: UnifiedMuxSpec | null | undefined,
  contextOrOrigins?: TargetContext | string[],
  extraAllowedOrigins?: string[],
): boolean {
  if (!spec || !spec.videoRoutes.length || !spec.audioRoutes.length) {
    return false;
  }
  const allowedOrigins = Array.isArray(contextOrOrigins)
    ? contextOrOrigins
    : resolveAllowedOriginsFromContext(contextOrOrigins, extraAllowedOrigins);
  const allowed = (url: string) =>
    isWhitelistedMediaUrl(url, allowedOrigins).allowed;
  return spec.videoRoutes.some(allowed) && spec.audioRoutes.some(allowed);
}

/**
 * Extracts ALL ready `delivery.kind === "mux"` variants from an item regardless
 * of platform name (removes the legacy `platform !== "bilibili"` blocker).
 */
export function extractAllMuxVariants(
  currentItem: MediaItem | null | undefined,
): ReadyVariant[] {
  if (!readyItem(currentItem)) return [];
  return currentItem.variants.filter(
    (variant): variant is ReadyVariant =>
      readyVariant(variant) && variant.delivery.kind === "mux",
  );
}

/**
 * Extracts ready `delivery.kind === "mux"` variants whose video & audio routes
 * are covered by the extension's strict host whitelist (capability-driven, zero
 * platform-name checks).
 */
export function extractWhitelistedMuxVariants(
  currentItem: MediaItem | null | undefined,
  context: TargetContext = {},
  extraAllowedOrigins?: string[],
): ReadyVariant[] {
  return extractAllMuxVariants(currentItem).filter(
    (variant) =>
      resolveWhitelistedExtensionMuxSpec(
        variant,
        context,
        extraAllowedOrigins,
      ) !== null,
  );
}

/**
 * Checks whether any available route of a file-delivered audio resource requires
 * Referer/Origin header protection (e.g. `browser_fetch === "blocked"` or a
 * protected audio host suffix), accurately pairing each `Source` with its own
 * expanded URLs.
 */
export function hasRefererProtectedAudioSource(
  resource: Pick<Resource, "delivery"> | null | undefined,
  context: TargetContext = {},
): boolean {
  if (!resource || resource.delivery.kind !== "file") {
    return false;
  }
  for (const src of availableSources(resource.delivery.sources, context.now)) {
    for (const url of sourceRoutes(src, context)) {
      if (isRefererProtectedMediaRoute(url, src)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolves the pre-filtered whitelisted routes for a Referer-protected standalone
 * audio resource that must be downloaded via the Chrome extension.
 *
 * - Pairs each available `Source` with its own `sourceRoutes(src, context)` so
 *   `fallback_urls` expansion can never cause index drift.
 * - Returns `null` when the audio does NOT require extension header protection
 *   OR when zero available routes pass the extension host whitelist.
 */
export function resolveProtectedExtensionAudioRoutes(
  resource: Pick<Resource, "delivery"> | null | undefined,
  context: TargetContext = {},
  extraAllowedOrigins?: string[],
): string[] | null {
  if (!resource || resource.delivery.kind !== "file") {
    return null;
  }
  const allowedOrigins = resolveAllowedOriginsFromContext(
    context,
    extraAllowedOrigins,
  );
  let needsProtection = false;
  const seen = new Set<string>();
  const whitelistedRoutes: string[] = [];

  for (const src of availableSources(resource.delivery.sources, context.now)) {
    for (const url of sourceRoutes(src, context)) {
      if (isRefererProtectedMediaRoute(url, src)) {
        needsProtection = true;
      }
      if (
        !seen.has(url) &&
        isWhitelistedMediaUrl(url, allowedOrigins).allowed
      ) {
        seen.add(url);
        whitelistedRoutes.push(url);
      }
    }
  }

  return needsProtection && whitelistedRoutes.length > 0
    ? whitelistedRoutes
    : null;
}

/**
 * Resolves pre-filtered whitelisted routes for a progressive direct file hosted
 * on a slow single-connection CDN that benefits from connected-extension 4-way
 * OPFS Range acceleration. Returns `null` when no route requests acceleration
 * or zero available routes pass the extension host whitelist.
 */
export function resolveAcceleratedExtensionDirectRoutes(
  resource: Pick<Resource, "delivery"> | null | undefined,
  context: TargetContext = {},
  extraAllowedOrigins?: string[],
): string[] | null {
  if (!resource || resource.delivery.kind !== "file") {
    return null;
  }
  const allowedOrigins = resolveAllowedOriginsFromContext(
    context,
    extraAllowedOrigins,
  );
  let wantsAcceleration = false;
  const seen = new Set<string>();
  const whitelistedRoutes: string[] = [];

  for (const src of availableSources(resource.delivery.sources, context.now)) {
    for (const url of sourceRoutes(src, context)) {
      if (prefersExtensionDirectAcceleration(url, src)) {
        wantsAcceleration = true;
      }
      if (
        !seen.has(url) &&
        isWhitelistedMediaUrl(url, allowedOrigins).allowed
      ) {
        seen.add(url);
        whitelistedRoutes.push(url);
      }
    }
  }

  return wantsAcceleration && whitelistedRoutes.length > 0
    ? whitelistedRoutes
    : null;
}

function isAlternateAudioTrack(
  metadata?: { audio_language_role?: string },
  label?: string,
): boolean {
  const role = String(metadata?.audio_language_role || "").toLowerCase();
  if (role === "alternate" || role === "descriptive") return true;
  return /dubbed|auto-dubbed|配音|descriptive|description/i.test(
    String(label || ""),
  );
}

function inferContainerFromVariant(variant: ReadyVariant): "mp4" | "webm" {
  const ext = String(
    variant.metadata?.container || variant.metadata?.extension || "",
  )
    .trim()
    .toLowerCase();
  const mime = String(variant.metadata?.mime_type || "").toLowerCase();
  const codec = String(variant.metadata?.video_codec || "").toLowerCase();
  if (
    ext === "webm" ||
    mime.includes("webm") ||
    codec.startsWith("vp9") ||
    codec.startsWith("vp09")
  ) {
    return "webm";
  }
  return "mp4";
}

/**
 * Pairs a split silent video variant (`has_audio === false`) with the best
 * compatible audio variant or attachment into a standard `UnifiedMuxSpec`.
 */
export function normalizeSplitMuxSpec(
  variant: ReadyVariant,
  itemVariants: ReadonlyArray<Variant>,
  attachments: ReadonlyArray<Attachment> = [],
  context: TargetContext = {},
): UnifiedMuxSpec | null {
  if (variant.delivery.kind !== "file" || variant.metadata?.has_audio !== false) {
    return null;
  }
  const availVideo = availableSources(variant.delivery.sources, context.now);
  if (!availVideo.length) return null;
  let videoRoutes: string[];
  try {
    videoRoutes = deliveryRoutes(availVideo, context);
  } catch {
    return null;
  }
  if (!videoRoutes.length) return null;

  const outputContainer = inferContainerFromVariant(variant);
  const preferAac = outputContainer === "mp4";

  interface AudioCandidate {
    routes: string[];
    size?: number;
    compatible: boolean;
    alternate: boolean;
    bitrate: number;
    variantId?: string;
    attachmentId?: string;
  }

  const candidates: AudioCandidate[] = [];

  for (const v of itemVariants) {
    if (!readyVariant(v) || v.delivery.kind !== "file" || !isAudioOnlyVariant(v)) {
      continue;
    }
    const srcs = availableSources(v.delivery.sources, context.now);
    if (!srcs.length) continue;
    let routes: string[];
    try {
      routes = deliveryRoutes(srcs, context);
    } catch {
      continue;
    }
    if (!routes.length) continue;
    const codec = formatCodecLabel(v.metadata?.audio_codec).toLowerCase();
    const mime = String(v.metadata?.mime_type || "").toLowerCase();
    const ext = String(v.metadata?.extension || v.metadata?.container || "").toLowerCase();
    const isAac = codec === "aac" || mime.includes("mp4") || ext === "m4a";
    const isOpus = codec === "opus" || mime.includes("webm") || ext === "webm";
    candidates.push({
      routes,
      size: parsePositiveSafeBytes(srcs[0]?.size_bytes),
      compatible: preferAac ? isAac : isOpus || isAac,
      alternate: isAlternateAudioTrack(v.metadata, v.label),
      bitrate: Number(v.metadata?.audio_bitrate_bps || v.metadata?.bitrate_bps || 0) || 0,
      variantId: v.id,
    });
  }

  for (const att of attachments) {
    if (att.role !== "background_audio" || att.resource.delivery.kind !== "file") {
      continue;
    }
    const srcs = availableSources(att.resource.delivery.sources, context.now);
    if (!srcs.length) continue;
    let routes: string[];
    try {
      routes = deliveryRoutes(srcs, context);
    } catch {
      continue;
    }
    if (!routes.length) continue;
    const attMeta = att.resource.metadata;
    const codec = formatCodecLabel(attMeta?.audio_codec).toLowerCase();
    const mime = String(attMeta?.mime_type || "").toLowerCase();
    const ext = String(attMeta?.extension || attMeta?.container || "").toLowerCase();
    const isAac = codec === "aac" || mime.includes("mp4") || ext === "m4a";
    const isOpus = codec === "opus" || mime.includes("webm") || ext === "webm";
    candidates.push({
      routes,
      size: parsePositiveSafeBytes(srcs[0]?.size_bytes),
      compatible: preferAac ? isAac : isOpus || isAac,
      alternate: isAlternateAudioTrack(attMeta, att.title),
      bitrate: Number(attMeta?.audio_bitrate_bps || attMeta?.bitrate_bps || 0) || 0,
      attachmentId: att.id,
    });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (a.compatible !== b.compatible) return a.compatible ? -1 : 1;
    if (a.alternate !== b.alternate) return a.alternate ? 1 : -1;
    if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
    return (b.size || 0) - (a.size || 0);
  });

  const bestAudio = candidates[0];
  const videoSize = parsePositiveSafeBytes(availVideo[0]?.size_bytes);
  return {
    kind: "split_mux",
    videoRoutes,
    audioRoutes: bestAudio.routes,
    ...(videoSize ? { videoSize } : {}),
    ...(bestAudio.size ? { audioSize: bestAudio.size } : {}),
    outputContainer,
    videoVariantId: variant.id,
    ...(bestAudio.variantId ? { audioVariantId: bestAudio.variantId } : {}),
    ...(bestAudio.attachmentId
      ? { audioAttachmentId: bestAudio.attachmentId }
      : {}),
  };
}

/**
 * Summarizes a list of `delivery.kind === "mux"` variants into display-friendly
 * resolution + codec metadata (platform-agnostic).
 */
export function summarizeMuxVariants(
  variants: ReadonlyArray<ReadyVariant>,
): MuxTierSummary | null {
  if (!Array.isArray(variants) || variants.length === 0) return null;

  let best = { pixels: -1, fpsRank: -1, label: "" };
  const videoCodecSet = new Set<string>();
  const audioCodecSet = new Set<string>();

  for (const variant of variants) {
    const rank = resolveVariantResolution(variant);
    if (
      rank.shortEdge > best.pixels ||
      (rank.shortEdge === best.pixels && rank.fpsRank > best.fpsRank)
    ) {
      best = {
        pixels: rank.shortEdge,
        fpsRank: rank.fpsRank,
        label: rank.tierLabel,
      };
    }

    const resources: ReadonlyArray<Resource> =
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
    const ra = videoCodecCompatibilityRank(a);
    const rb = videoCodecCompatibilityRank(b);
    return ra !== rb ? rb - ra : a.localeCompare(b);
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
