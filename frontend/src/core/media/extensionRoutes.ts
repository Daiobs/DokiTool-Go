import type { MediaItem, Source } from "../../types/media";
import type { TargetContext } from "../../utils/mediaContract";
import {
  isWhitelistedMediaUrl,
  PROD_API_ORIGIN,
} from "../../extension/hostWhitelist";
import {
  isCorsBlockedDirectUrl,
  isRefererProtectedMediaRoute,
  isTbvideoVideoItem,
  prefersExtensionDirectAcceleration,
} from "./cdnTransportHints";

const MAX_EXTENSION_DIRECT_ROUTES = 8;

function resolveAllowedOriginsFromContext(
  context: TargetContext,
  extraAllowedOrigins?: string[],
): string[] | undefined {
  const merged = new Set<string>();
  if (Array.isArray(extraAllowedOrigins)) {
    for (const raw of extraAllowedOrigins) {
      if (typeof raw === "string" && raw.trim()) {
        merged.add(raw.trim());
      }
    }
  }
  const apiOrigin = context.apiOrigin?.trim();
  if (apiOrigin && apiOrigin !== PROD_API_ORIGIN) {
    try {
      const parsed = new URL(apiOrigin);
      const host = parsed.hostname.toLowerCase();
      if (
        parsed.protocol === "http:" &&
        (host === "127.0.0.1" || host === "localhost")
      ) {
        merged.add(parsed.origin);
      }
    } catch {
      // Ignore invalid apiOrigin strings
    }
  }
  return merged.size > 0 ? Array.from(merged) : undefined;
}

/**
 * Deduplicates and filters candidate direct-download URLs strictly to routes
 * permitted by the extension's static host whitelist (plus optional loopback
 * dev/test origin when running against localhost).
 */
export function filterWhitelistedExtensionRoutes(
  rawRoutes: ReadonlyArray<string>,
  context: TargetContext = {},
  extraAllowedOrigins?: string[],
): string[] {
  const allowedOrigins = resolveAllowedOriginsFromContext(
    context,
    extraAllowedOrigins,
  );
  const seen = new Set<string>();
  const whitelisted: string[] = [];
  for (const raw of rawRoutes) {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url || seen.has(url)) continue;
    if (isWhitelistedMediaUrl(url, allowedOrigins).allowed) {
      seen.add(url);
      whitelisted.push(url);
      if (whitelisted.length >= MAX_EXTENSION_DIRECT_ROUTES) break;
    }
  }
  return whitelisted;
}

/**
 * Pure data-feature route expander: appends the item's matching `tbvideo`
 * candidate URL when present (`item.tbvideo`), aligning M2 Web delegation
 * with M3 SidePanel without any platform-name branching.
 */
export function buildDirectFileRoutesWithTbvideo(
  targetRoutes: ReadonlyArray<string>,
  item: Pick<MediaItem, "type" | "tbvideo"> | null | undefined,
  sourceId?: string | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };
  for (const route of targetRoutes) {
    push(route);
  }
  if (isTbvideoVideoItem(item) && item?.tbvideo?.sources) {
    const tbSources = item.tbvideo.sources;
    const matched =
      sourceId && Object.hasOwn(tbSources, sourceId)
        ? tbSources[sourceId]
        : Object.values(tbSources)[0];
    push(matched);
  }
  return out;
}

export interface DirectFileExtensionTraits {
  whitelistedRoutes: string[];
  whitelistedForExtension: boolean;
  hasTbvideo: boolean;
  corsBlockedDirect: boolean;
  preferExtensionDirectAcceleration: boolean;
  requiresRefererOrBlockedFetch: boolean;
  wantsProactiveExtensionDirect: boolean;
}

/**
 * Evaluates capability-driven extension direct delegation traits for any
 * `delivery.kind === "file"` target (zero platform-name branching).
 */
export function inspectDirectFileExtensionTraits(params: {
  routes: ReadonlyArray<string>;
  item?: Pick<MediaItem, "type" | "tbvideo"> | null;
  source?: Pick<Source, "access" | "browser_fetch"> | null;
  context?: TargetContext;
  extraAllowedOrigins?: string[];
}): DirectFileExtensionTraits {
  const { routes, item, source, context = {}, extraAllowedOrigins } = params;
  const whitelistedRoutes = filterWhitelistedExtensionRoutes(
    routes,
    context,
    extraAllowedOrigins,
  );
  const hasTbvideo = isTbvideoVideoItem(item);
  const corsBlockedDirect = routes.some((url) => isCorsBlockedDirectUrl(url));
  const preferExtensionDirectAcceleration = routes.some((url) =>
    prefersExtensionDirectAcceleration(url, source),
  );
  const requiresRefererOrBlockedFetch =
    source?.browser_fetch === "blocked" ||
    routes.some((url) => isRefererProtectedMediaRoute(url, source));
  const whitelistedForExtension = whitelistedRoutes.length > 0;
  const wantsProactiveExtensionDirect =
    whitelistedForExtension &&
    (preferExtensionDirectAcceleration ||
      corsBlockedDirect ||
      hasTbvideo ||
      requiresRefererOrBlockedFetch);

  return {
    whitelistedRoutes,
    whitelistedForExtension,
    hasTbvideo,
    corsBlockedDirect,
    preferExtensionDirectAcceleration,
    requiresRefererOrBlockedFetch,
    wantsProactiveExtensionDirect,
  };
}
