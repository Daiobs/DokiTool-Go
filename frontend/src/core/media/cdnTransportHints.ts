import type { MediaItem, Source } from "../../types/media";

/**
 * Pure URL & item transport capability hints shared by Web and Extension layers.
 * Uses declarative host-suffix / URL-shape rules and item data traits (e.g.
 * `item.tbvideo`) rather than platform-name branching.
 */

const EXTENSIONLESS_MP4_HOST_SUFFIXES = [".toutiaovod.com"] as const;

const CORS_BLOCKED_DIRECT_HOST_SUFFIXES = [
  ".toutiaovod.com",
  ".googlevideo.com",
] as const;

const CORS_BLOCKED_DIRECT_EXACT_HOSTS = new Set(["googlevideo.com"]);

const SIGNED_ATTACHMENT_HOST_SUFFIXES = [".googlevideo.com"] as const;
const SIGNED_ATTACHMENT_EXACT_HOSTS = new Set(["googlevideo.com"]);

const REFERER_PROTECTED_AUDIO_HOST_SUFFIXES = [
  ".bilivideo.com",
  ".bilivideo.cn",
  ".akamaized.net",
] as const;

const SLOW_PROGRESSIVE_DIRECT_HOST_SUFFIXES = [
  ".bilivideo.com",
  ".bilivideo.cn",
  ".akamaized.net",
] as const;

const TBVIDEO_FALLBACK_EXACT_HOSTS = new Set([
  "web-v01.izuiyou.com",
  "tbvideo.ixiaochuan.cn",
  "video01.szsttkj.com",
  "video03.szsttkj.com",
  "xlal-ppvideo.szsttkj.com",
]);

function normalizeHost(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/\.$/, "");
}

function matchesHostSuffix(
  host: string,
  suffixes: readonly string[],
  exactHosts?: ReadonlySet<string>,
): boolean {
  if (exactHosts?.has(host)) return true;
  return suffixes.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );
}

export type TbvideoPlatform = "pipigx" | "zuiyou";
const TBVIDEO_PLATFORM_IDS = new Set<string>(["pipigx", "zuiyou"]);

/**
 * Pure declarative catalog check for Xiaochuan tbvideo download-hint platforms.
 * Lives in the zero-DOM / zero-Vite-env core module so both Web and MV3
 * esbuild extension bundles can import it without pulling in `apiConfig`.
 */
export function platformUsesTbvideo(
  platform?: string,
): platform is TbvideoPlatform {
  return Boolean(platform && TBVIDEO_PLATFORM_IDS.has(platform));
}

/**
 * Data-feature predicate replacing scattered `platform === "pipigx" || platform === "zuiyou"` checks.
 */
export function hasTbvideoPayload(
  item: Pick<MediaItem, "tbvideo"> | { tbvideo?: unknown } | null | undefined,
): boolean {
  return Boolean(item && typeof item.tbvideo === "object" && item.tbvideo !== null);
}

export function isTbvideoVideoItem(
  item: Pick<MediaItem, "type" | "tbvideo"> | { type?: string; tbvideo?: unknown } | null | undefined,
): boolean {
  return Boolean(item?.type === "video" && hasTbvideoPayload(item));
}

/**
 * Identifies HTTPS extensionless MP4 direct video streams whose CDN omits CORS
 * headers and path extensions, requiring manual browser-save hints & `.mp4` inference.
 */
export function isExtensionlessDirectMp4Url(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return false;
    }
    const host = normalizeHost(parsed);
    if (!matchesHostSuffix(host, EXTENSIONLESS_MP4_HOST_SUFFIXES)) {
      return false;
    }
    return parsed.pathname.length > 1;
  } catch {
    return false;
  }
}

/**
 * Identifies direct media URLs whose upstream CDN blocks cross-origin browser fetch.
 */
export function isCorsBlockedDirectUrl(rawUrl: string): boolean {
  if (isExtensionlessDirectMp4Url(rawUrl)) {
    return true;
  }
  try {
    const parsed = new URL(rawUrl);
    const host = normalizeHost(parsed);
    return matchesHostSuffix(
      host,
      CORS_BLOCKED_DIRECT_HOST_SUFFIXES,
      CORS_BLOCKED_DIRECT_EXACT_HOSTS,
    );
  } catch {
    return false;
  }
}

/**
 * URL parameters only indicate that a direct attachment attempt can be made;
 * they never prove that the actual upstream HTTP response is a verified attachment.
 */
export function canAttemptSignedDirectAttachment(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = normalizeHost(parsed);
    if (
      !matchesHostSuffix(
        host,
        SIGNED_ATTACHMENT_HOST_SUFFIXES,
        SIGNED_ATTACHMENT_EXACT_HOSTS,
      )
    ) {
      return false;
    }
    if (parsed.pathname.replace(/\/+$/, "") !== "/videoplayback") {
      return false;
    }
    const itag = parsed.searchParams.get("itag")?.trim() ?? "";
    const title = parsed.searchParams.get("title")?.trim() ?? "";
    if (itag !== "18" || !title) {
      return false;
    }
    const sparams = (parsed.searchParams.get("sparams") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase());
    return !sparams.includes("title");
  } catch {
    return false;
  }
}

/**
 * Infers video file extension from query MIME, URL pathname suffix, or known
 * extensionless MP4 transport characteristics.
 */
export function inferDirectVideoExtension(
  rawUrl: string,
  hasTbvideo = false,
): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    const queryMime = (parsed.searchParams.get("mime_type") || "")
      .trim()
      .toLowerCase();
    if (queryMime === "video_mp4" || queryMime === "video/mp4") {
      return "mp4";
    }
    if (queryMime === "video_webm" || queryMime === "video/webm") {
      return "webm";
    }
    if (queryMime === "video_quicktime" || queryMime === "video/quicktime") {
      return "mov";
    }
    if (queryMime) {
      return undefined;
    }
    const pathLower = parsed.pathname.toLowerCase();
    const pathExtMatch = /\.([a-z0-9]{2,5})$/.exec(pathLower);
    if (pathExtMatch) {
      const pathExt = pathExtMatch[1];
      if (pathExt === "mp4" || pathExt === "m4v") return "mp4";
      if (pathExt === "webm" || pathExt === "mov" || pathExt === "mkv") {
        return pathExt;
      }
      return undefined;
    }
    const host = normalizeHost(parsed);
    if (isExtensionlessDirectMp4Url(rawUrl)) {
      return "mp4";
    }
    if (hasTbvideo || TBVIDEO_FALLBACK_EXACT_HOSTS.has(host)) {
      return "mp4";
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Identifies direct audio/media routes whose upstream enforces Referer/Origin
 * protection and therefore requires an extension-side DNR-capable transfer
 * rather than direct browser fetch.
 */
export function isRefererProtectedMediaRoute(
  rawUrl: string,
  source?: Pick<Source, "access" | "browser_fetch"> | null,
): boolean {
  if (source?.browser_fetch === "blocked") {
    return true;
  }
  try {
    const parsed = new URL(rawUrl);
    const host = normalizeHost(parsed);
    return matchesHostSuffix(host, REFERER_PROTECTED_AUDIO_HOST_SUFFIXES);
  } catch {
    return false;
  }
}

/**
 * Identifies progressive direct media routes hosted on CDNs known to throttle
 * single-connection browser downloads (e.g. ~800 KB/s), where routing through
 * a connected extension's 4-way OPFS Range engine accelerates transfer.
 */
export function prefersExtensionDirectAcceleration(
  rawUrl: string,
  source?: Pick<Source, "access" | "browser_fetch"> | null,
): boolean {
  if (source?.access === "relay") {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return false;
    }
    const host = normalizeHost(parsed);
    return matchesHostSuffix(host, SLOW_PROGRESSIVE_DIRECT_HOST_SUFFIXES);
  } catch {
    return false;
  }
}
