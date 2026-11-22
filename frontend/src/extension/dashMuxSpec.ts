import type { ReadyVariant, Source } from "../types/media";
import {
  availableSources,
  deliveryRoutes,
  sourcesOf,
  type TargetContext,
} from "../utils/mediaContract";
import type { OffscreenDashMuxSpec } from "./protocol";

function parsePositiveSafeByteSize(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
    ? raw
    : undefined;
}

/**
 * Pure, authoritative DASH mux spec extractor shared by SidePanel, Background,
 * and Offscreen without importing `mediabunny` or any Offscreen runtime code.
 *
 * Extracts a lossless MP4 `OffscreenDashMuxSpec` from a `delivery.kind === "mux"`
 * variant whose resources contain exactly 1 `video` (`kind: "file"`) and
 * 1 `audio` (`kind: "file"`) leaf stream with unexpired available routes.
 */
export function extractDashMuxSpec(
  variant: ReadyVariant,
  context: TargetContext = {},
): OffscreenDashMuxSpec | null {
  if (variant.delivery.kind !== "mux") return null;
  const outputContainer = (
    variant.delivery.output?.container ||
    variant.delivery.output?.extension ||
    variant.metadata?.container ||
    variant.metadata?.extension ||
    "mp4"
  )
    .trim()
    .toLowerCase();
  if (outputContainer !== "mp4") {
    return null;
  }

  const videoResources = variant.delivery.resources.filter(
    (r) => r.role === "video",
  );
  const audioResources = variant.delivery.resources.filter(
    (r) => r.role === "audio",
  );
  if (videoResources.length !== 1 || audioResources.length !== 1) {
    return null;
  }
  const videoRes = videoResources[0];
  const audioRes = audioResources[0];
  if (
    videoRes.delivery.kind !== "file" ||
    audioRes.delivery.kind !== "file"
  ) {
    return null;
  }

  const availVideo = availableSources(videoRes.delivery.sources, context.now);
  const availAudio = availableSources(audioRes.delivery.sources, context.now);
  if (!availVideo.length || !availAudio.length) {
    return null;
  }

  let videoRoutes: string[];
  let audioRoutes: string[];
  try {
    videoRoutes = deliveryRoutes(availVideo, context);
    audioRoutes = deliveryRoutes(availAudio, context);
  } catch {
    return null;
  }
  if (!videoRoutes.length || !audioRoutes.length) {
    return null;
  }

  const videoSize = parsePositiveSafeByteSize(availVideo[0]?.size_bytes);
  const audioSize = parsePositiveSafeByteSize(availAudio[0]?.size_bytes);

  return {
    videoRoutes,
    audioRoutes,
    ...(videoSize ? { videoSize } : {}),
    ...(audioSize ? { audioSize } : {}),
    outputContainer: "mp4",
  };
}

/**
 * Returns the earliest finite `expires_at` epoch timestamp (ms) across a set of
 * candidate sources, ignoring unavailable or missing expiration fields.
 */
export function computeEarliestExpiresAtMs(
  sources: ReadonlyArray<Source | null | undefined>,
): number | undefined {
  let earliest: number | undefined;
  for (const src of sources) {
    if (!src || src.availability === "unavailable" || !src.expires_at) {
      continue;
    }
    const ms = Date.parse(src.expires_at);
    if (!Number.isFinite(ms)) continue;
    if (earliest === undefined || ms < earliest) {
      earliest = ms;
    }
  }
  return earliest;
}

/**
 * Computes the earliest candidate `expires_at` timestamp (ms) for a variant's
 * active delivery sources (honoring `now` when unexpired sources exist).
 */
export function extractVariantEarliestExpiresAtMs(
  variant: ReadyVariant,
  now?: number,
): number | undefined {
  const delivery = variant.delivery;
  if (delivery.kind === "mux") {
    const candidates: Source[] = [];
    for (const res of delivery.resources) {
      if (
        (res.role === "video" || res.role === "audio") &&
        res.delivery.kind === "file"
      ) {
        const avail = availableSources(res.delivery.sources, now);
        candidates.push(...(avail.length ? avail : res.delivery.sources));
      }
    }
    return computeEarliestExpiresAtMs(candidates);
  }
  const allSources = sourcesOf(delivery);
  const avail = availableSources(allSources, now);
  return computeEarliestExpiresAtMs(avail.length ? avail : allSources);
}
