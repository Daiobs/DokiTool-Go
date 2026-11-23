import extensionReleaseMeta from "./extensionReleaseMeta.json";

/**
 * Unified Client Capability Routing Hub (Single Source of Truth).
 *
 * Strictly capability-driven (zero DOM, zero `chrome.*`, zero platform-name
 * branching). Enforces the canonical execution priority:
 *   1. Connected DokiTool Extension (`dash_mux` / `youtube_mux` / `youtube_parse` / `direct_download`)
 *   2. Legacy Userscript Helper (non-Chromium or extension-disconnected fallback)
 *   3. Web Service Worker Multi-Range Stream
 *   4. Native Browser Direct Download / External Link
 */

export const LATEST_EXTENSION_VERSION: string = String(
  extensionReleaseMeta.version || "4.1.0",
);

export type KnownExtensionCapability =
  | "dash_mux"
  | "direct_download"
  | "youtube_parse"
  | "youtube_mux";

export interface ClientCapabilityEnvironment {
  extensionConnected: boolean;
  extensionVersion: string;
  extensionCapabilities: ReadonlyArray<string>;
  userscriptReady: boolean;
  userscriptVersion?: string;
  swMultiRangeAvailable?: boolean;
}

export interface ExecutionPlanInput {
  /** Delivery kind from unified-v1 contract (`file`, `mux`, `hls`, `segments`, `pair`, etc.) */
  deliveryKind: string;
  /** True when the variant is a silent split video (`has_audio === false`) with a compatible audio pair */
  hasSplitMuxPair?: boolean;
  /** True when the media requires a client-side session/helper (e.g. `extra.youtube_helper`) */
  requiresClientSession?: boolean;
  /** True when the option's routes are covered by the extension's static host whitelist */
  whitelistedForExtension?: boolean;
  /** True when upstream requires Referer/Origin header injection or blocks browser fetch */
  requiresRefererOrBlockedFetch?: boolean;
  /** True when the item carries `item.tbvideo` browser-only download hints */
  hasTbvideo?: boolean;
  /** True when upstream CDN blocks cross-origin browser fetch (e.g. CORS-blocked direct URL) */
  corsBlockedDirect?: boolean;
  /** True when direct progressive stream is known to benefit from extension 4-way OPFS acceleration */
  preferExtensionDirectAcceleration?: boolean;
}

export type ExecutionChannel =
  | "extension_youtube_mux"
  | "extension_mux"
  | "extension_direct"
  | "userscript_mux"
  | "userscript_direct"
  | "web_sw_stream"
  | "browser_direct"
  | "external_link"
  | "blocked";

export interface ExecutionPlan {
  channel: ExecutionChannel;
  canDownload: boolean;
  usesExtension: boolean;
  usesUserscript: boolean;
  requiresUpgradeNotice: boolean;
  reason?: string;
}

export interface ClientParseRoute {
  channel: "extension_client_parse" | "userscript_client_parse" | "server_api";
}

function parseSemverTuple(raw: string): [number, number, number] | null {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^v/i, "")
    .split("-")[0];
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cleaned);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compares two `major.minor.patch` SemVer strings.
 * Returns `-1` if `a < b`, `0` if equal, `1` if `a > b`, or `0` if either is unparseable.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemverTuple(a);
  const pb = parseSemverTuple(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * True when an installed extension reports a valid version strictly older than
 * `latestVersion` (defaults to the build-injected `LATEST_EXTENSION_VERSION`).
 */
export function isExtensionVersionOutdated(
  installedVersion: string | null | undefined,
  latestVersion: string = LATEST_EXTENSION_VERSION,
): boolean {
  if (!installedVersion || !parseSemverTuple(installedVersion)) return false;
  return compareSemver(installedVersion, latestVersion) < 0;
}

export function hasClientExtensionCapability(
  env: ClientCapabilityEnvironment,
  cap: KnownExtensionCapability,
): boolean {
  return Boolean(
    env.extensionConnected && env.extensionCapabilities.includes(cap),
  );
}

/**
 * Decides how a client-session-required URL should be parsed:
 * Priority: Connected Extension (`youtube_parse`) > Userscript Helper > Server API.
 */
export function resolveClientParseRoute(
  requiresClientSession: boolean,
  env: ClientCapabilityEnvironment,
): ClientParseRoute {
  if (!requiresClientSession) {
    return { channel: "server_api" };
  }
  if (hasClientExtensionCapability(env, "youtube_parse")) {
    return { channel: "extension_client_parse" };
  }
  if (env.userscriptReady) {
    return { channel: "userscript_client_parse" };
  }
  return { channel: "server_api" };
}

/**
 * Unified execution plan resolver for any media option across all platforms.
 * Priority: Connected Extension > Userscript Helper > Web SW Stream > Native Direct.
 */
export function resolveExecutionPlan(
  option: ExecutionPlanInput,
  env: ClientCapabilityEnvironment,
): ExecutionPlan {
  const extDashMux = hasClientExtensionCapability(env, "dash_mux");
  const extYouTubeMux = hasClientExtensionCapability(env, "youtube_mux");
  const extDirect = hasClientExtensionCapability(env, "direct_download");

  // 1. Standard `delivery.kind === "mux"` (any platform: Bilibili, Vimeo, Reddit, Tier-2)
  if (option.deliveryKind === "mux") {
    if (extDashMux && option.whitelistedForExtension !== false) {
      return {
        channel: "extension_mux",
        canDownload: true,
        usesExtension: true,
        usesUserscript: false,
        requiresUpgradeNotice: false,
      };
    }
    return {
      channel: "blocked",
      canDownload: false,
      usesExtension: false,
      usesUserscript: false,
      requiresUpgradeNotice: true,
      reason: "extension_mux_required",
    };
  }

  // 2. Split silent video + audio pair (e.g. YouTube 4K60/1080p adaptive streams)
  if (option.hasSplitMuxPair) {
    if (extYouTubeMux && option.whitelistedForExtension !== false) {
      return {
        channel: "extension_youtube_mux",
        canDownload: true,
        usesExtension: true,
        usesUserscript: false,
        requiresUpgradeNotice: false,
      };
    }
    if (env.userscriptReady) {
      return {
        channel: "userscript_mux",
        canDownload: true,
        usesExtension: false,
        usesUserscript: true,
        requiresUpgradeNotice: false,
      };
    }
    if (option.requiresClientSession) {
      return {
        channel: "blocked",
        canDownload: false,
        usesExtension: false,
        usesUserscript: false,
        requiresUpgradeNotice: true,
        reason: "client_mux_required",
      };
    }
  }

  // 3. Client-session-only direct files (e.g. YouTube audio-only / progressive 360p)
  if (option.requiresClientSession) {
    if (extDirect && option.whitelistedForExtension !== false) {
      return {
        channel: "extension_direct",
        canDownload: true,
        usesExtension: true,
        usesUserscript: false,
        requiresUpgradeNotice: false,
      };
    }
    if (env.userscriptReady) {
      return {
        channel: "userscript_direct",
        canDownload: true,
        usesExtension: false,
        usesUserscript: true,
        requiresUpgradeNotice: false,
      };
    }
    return {
      channel: "blocked",
      canDownload: false,
      usesExtension: false,
      usesUserscript: false,
      requiresUpgradeNotice: true,
      reason: "client_session_required",
    };
  }

  // 4. Protected or slow whitelisted direct files accelerated via connected extension
  if (
    option.deliveryKind === "file" &&
    extDirect &&
    option.whitelistedForExtension !== false &&
    (option.requiresRefererOrBlockedFetch ||
      option.preferExtensionDirectAcceleration)
  ) {
    return {
      channel: "extension_direct",
      canDownload: true,
      usesExtension: true,
      usesUserscript: false,
      requiresUpgradeNotice: false,
    };
  }

  // 5. Web Service Worker multi-Range stream vs browser direct / external link
  if (
    option.deliveryKind === "file" ||
    option.deliveryKind === "hls" ||
    option.deliveryKind === "segments" ||
    option.deliveryKind === "pair"
  ) {
    if (option.corsBlockedDirect && !option.hasTbvideo) {
      return {
        channel: "browser_direct",
        canDownload: true,
        usesExtension: false,
        usesUserscript: false,
        requiresUpgradeNotice: false,
      };
    }
    if (env.swMultiRangeAvailable !== false && option.deliveryKind === "file") {
      return {
        channel: "web_sw_stream",
        canDownload: true,
        usesExtension: false,
        usesUserscript: false,
        requiresUpgradeNotice: false,
      };
    }
    return {
      channel: "browser_direct",
      canDownload: true,
      usesExtension: false,
      usesUserscript: false,
      requiresUpgradeNotice: false,
    };
  }

  return {
    channel: "external_link",
    canDownload: false,
    usesExtension: false,
    usesUserscript: false,
    requiresUpgradeNotice: false,
  };
}
