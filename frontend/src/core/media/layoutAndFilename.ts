import type { MediaGroup, MediaItem, UnifiedMedia } from "../../types/media";

/**
 * Shared layout classification & single-video title hygiene helpers consumed by
 * both Web SPA and Chrome Extension. Zero DOM, zero `chrome.*`, zero platform
 * name hardcoding.
 */

export type CoreMediaLayoutKind =
  | "empty"
  | "single_video"
  | "single_audio"
  | "single_image"
  | "live_photo"
  | "album"
  | "multi_video";

export function nonAlbumGroupsOf(
  media: Pick<UnifiedMedia, "groups"> | null | undefined,
): MediaGroup[] {
  return (media?.groups ?? []).filter((group) => group.kind !== "album");
}

/**
 * True only when the media genuinely has >1 collection groups or any group with
 * >1 total/listed items. Prevents single-P works returning `total_count: 1` from
 * entering multi-episode/collection layouts.
 */
export function hasMultiCollectionGroups(
  media: Pick<UnifiedMedia, "groups"> | null | undefined,
): boolean {
  const collections = nonAlbumGroupsOf(media);
  return (
    collections.length > 1 ||
    collections.some(
      (group) =>
        (group.total_count ?? 0) > 1 || (group.item_ids?.length ?? 0) > 1,
    )
  );
}

export function classifyMediaCollectionLayout(
  media: Pick<UnifiedMedia, "items" | "groups"> | null | undefined,
): CoreMediaLayoutKind {
  if (!media || !Array.isArray(media.items) || media.items.length === 0) {
    return "empty";
  }
  const items: MediaItem[] = media.items;
  const groups = media.groups ?? [];
  const hasExplicitMultiGroup = groups.some(
    (group) =>
      (group.kind === "multipart" || group.kind === "collection") &&
      ((group.total_count ?? group.item_ids.length) > 1 ||
        group.item_ids.length > 1),
  );
  if (hasExplicitMultiGroup) {
    return "multi_video";
  }
  if (items.length === 1) {
    const only = items[0];
    if (only.type === "video") return "single_video";
    if (only.type === "audio") return "single_audio";
    if (only.type === "image") return "single_image";
    if (only.type === "live_photo") return "live_photo";
    return "single_video";
  }
  const hasImageOrLive = items.some(
    (item) => item.type === "image" || item.type === "live_photo",
  );
  const allAudioOrVideo = items.every(
    (item) => item.type === "video" || item.type === "audio",
  );
  if (allAudioOrVideo) {
    return "multi_video";
  }
  if (hasImageOrLive) {
    return "album";
  }
  return "multi_video";
}

export function isSingleVideoWork(
  media: Pick<UnifiedMedia, "items" | "groups"> | null | undefined,
): boolean {
  const kind = classifyMediaCollectionLayout(media);
  return kind === "single_video" || kind === "single_audio";
}

/**
 * Resolves the cleanest human title for download filenames:
 * - For single-item works, strictly prioritizes work title (`media.title`) over
 *   raw single-part `item.title` (preventing `mmexport*.mp4` / `序列 01` pollution).
 * - For audio-only client-session items, strips trailing container hints before
 *   falling back to work title.
 * - For multi-item works, prioritizes episode `item.title` with work title fallback.
 */
export function resolvePreferredMediaTitle(params: {
  isSingleItem: boolean;
  isAttachment?: boolean;
  isStandaloneAudioItem?: boolean;
  workTitle?: string | null;
  itemTitle?: string | null;
  authorName?: string | null;
  fallback?: string | null;
}): string {
  const workTitle = (params.workTitle ?? "").trim();
  const itemTitle = (params.itemTitle ?? "").trim();
  const authorName = (params.authorName ?? "").trim();
  const fallback = (params.fallback ?? "").trim();

  if (params.isStandaloneAudioItem) {
    return (
      workTitle ||
      itemTitle.replace(/\s*\((?:M4A|WEBM)[^)]*\)$/i, "").trim() ||
      authorName ||
      fallback
    );
  }
  if (params.isSingleItem) {
    return (
      (params.isAttachment && itemTitle ? itemTitle : "") ||
      workTitle ||
      itemTitle ||
      authorName ||
      fallback
    );
  }
  return itemTitle || workTitle || authorName || fallback;
}

/**
 * Computes an optional resolution / audio tag suffix for filenames when a work
 * carries client-session/multi-tier adaptive variants (e.g. `1080p`, `audio`).
 */
export function resolveAdaptiveQualityFilenameTag(params: {
  enabled: boolean;
  itemType?: string;
  extension?: string;
  variant?: {
    label?: string;
    metadata?: {
      mime_type?: string;
      width?: number;
      height?: number;
      has_audio?: boolean;
      video_codec?: string;
    };
  };
}): string | undefined {
  if (!params.enabled) return undefined;
  const variant = params.variant;
  const mime = String(variant?.metadata?.mime_type || "").toLowerCase();
  if (
    params.itemType === "audio" ||
    params.extension === "m4a" ||
    mime.startsWith("audio/") ||
    (variant?.metadata?.has_audio === true &&
      !variant?.metadata?.video_codec &&
      !variant?.metadata?.width &&
      !variant?.metadata?.height)
  ) {
    return "audio";
  }
  const w = Number(variant?.metadata?.width);
  const h = Number(variant?.metadata?.height);
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
    return `${Math.min(w, h)}p`;
  }
  const labelMatch = String(variant?.label || "").match(/(\d{3,4}p)/i);
  if (labelMatch) {
    return labelMatch[1].toLowerCase();
  }
  return undefined;
}
