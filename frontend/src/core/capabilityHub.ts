import extensionReleaseMeta from "./extensionReleaseMeta.json";

/**
 * Unified Client Capability Routing Hub (Single Source of Truth).
 *
 * Strictly capability-driven (zero DOM, zero `chrome.*`, zero platform-name
 * branching). Enforces the canonical execution priority:
 *   1. Connected DokiTool Chrome Extension (`dash_mux` / `youtube_mux` / `youtube_parse` / `direct_download`)
 *   2. Web Service Worker Multi-Range Stream
 *   3. Native Browser Direct Download / External Link
 */

const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+$/;
const STRICT_EXTENSION_ID_RE = /^[a-p]{32}$/;

const rawReleaseVersion = String(extensionReleaseMeta.version ?? "").trim();
if (!STRICT_SEMVER_RE.test(rawReleaseVersion)) {
  throw new Error(
    `Invalid extensionReleaseMeta.json version: ${JSON.stringify(extensionReleaseMeta.version)}`,
  );
}
const rawReleaseExtensionId = String(
  extensionReleaseMeta.extensionId ?? "",
).trim();
if (!STRICT_EXTENSION_ID_RE.test(rawReleaseExtensionId)) {
  throw new Error(
    `Invalid extensionReleaseMeta.json extensionId: ${JSON.stringify(extensionReleaseMeta.extensionId)}`,
  );
}

export const LATEST_EXTENSION_VERSION: string = rawReleaseVersion;
export const EXTENSION_RELEASE_ID: string = rawReleaseExtensionId;
export const EXTENSION_VERSION_PATH = "/helper/extension-version.json" as const;
export const EXTENSION_ZIP_PATH =
  "/helper/dokitool-chrome-extension.zip" as const;

export interface ParsedExtensionVersionPayload {
  version: string;
  downloadUrl: string;
  sha256?: string;
}

/**
 * Minimum DokiTool extension version that supports built-in zero-userscript
 * YouTube parsing & lossless muxing (`youtube_parse` / `youtube_mux`).
 * Keeping this at `"4.3.0"` allows v4.3.0+ users to parse YouTube seamlessly
 * while still receiving update notifications when newer releases ship.
 */
export const MIN_EXTENSION_YOUTUBE_VERSION = "4.3.0" as const;

export type KnownExtensionCapability =
  | "dash_mux"
  | "direct_download"
  | "youtube_parse"
  | "youtube_mux";

export interface ClientCapabilityEnvironment {
  extensionConnected: boolean;
  extensionVersion: string;
  extensionCapabilities: ReadonlyArray<string>;
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
  /** True when the unified-v1 source explicitly marks `browser_fetch: "blocked"` (hard Referer/anti-hotlink protection) */
  browserFetchBlocked?: boolean;
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
  | "web_sw_stream"
  | "browser_direct"
  | "external_link"
  | "blocked";

export interface ExecutionPlan {
  channel: ExecutionChannel;
  canDownload: boolean;
  usesExtension: boolean;
  requiresUpgradeNotice: boolean;
  reason?: string;
}

export interface ClientParseRoute {
  channel: "extension_client_parse" | "server_api";
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

export function isValidSameOriginExtensionDownloadUrl(
  raw: unknown,
  origin: string,
): boolean {
  if (raw === undefined) return true;
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("@")) return false;
  try {
    const u = new URL(trimmed, origin);
    return (
      u.origin === origin &&
      u.pathname === EXTENSION_ZIP_PATH &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

export function parseExtensionVersionPayload(
  rawBody: unknown,
  origin: string,
): ParsedExtensionVersionPayload | null {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return null;
  }
  const body = rawBody as Record<string, unknown>;
  const version = typeof body.version === "string" ? body.version.trim() : "";
  if (!STRICT_SEMVER_RE.test(version)) return null;
  if (!isValidSameOriginExtensionDownloadUrl(body.download_url, origin)) {
    return null;
  }
  const rawSha = typeof body.sha256 === "string" ? body.sha256.trim() : "";
  const sha256 = /^[a-f0-9]{64}$/i.test(rawSha) ? rawSha.toLowerCase() : undefined;
  return {
    version,
    downloadUrl: `${origin}${EXTENSION_ZIP_PATH}`,
    ...(sha256 ? { sha256 } : {}),
  };
}

/**
 * Monotonically raises the runtime latest extension version only when a valid
 * remote `/helper/extension-version.json` reports a version strictly newer than
 * the compile-time `compiledVersion` (prevents downgrade or stale-cache flicker).
 */
export function resolveEffectiveLatestExtensionVersion(
  compiledVersion: string,
  remoteVersion: string | null | undefined,
): string {
  const base = STRICT_SEMVER_RE.test(String(compiledVersion || "").trim())
    ? String(compiledVersion).trim()
    : LATEST_EXTENSION_VERSION;
  const candidate = String(remoteVersion || "").trim();
  if (!STRICT_SEMVER_RE.test(candidate)) return base;
  return compareSemver(candidate, base) > 0 ? candidate : base;
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
 * Priority: Connected Extension (`youtube_parse`) > Server API.
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
  return { channel: "server_api" };
}

/**
 * Unified execution plan resolver for any media option across all platforms.
 * Priority: Connected Extension > Web SW Stream > Native Direct.
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
        requiresUpgradeNotice: false,
      };
    }
    return {
      channel: "blocked",
      canDownload: false,
      usesExtension: false,
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
        requiresUpgradeNotice: false,
      };
    }
    if (option.requiresClientSession) {
      return {
        channel: "blocked",
        canDownload: false,
        usesExtension: false,
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
        requiresUpgradeNotice: false,
      };
    }
    return {
      channel: "blocked",
      canDownload: false,
      usesExtension: false,
      requiresUpgradeNotice: true,
      reason: "client_session_required",
    };
  }

  // 4. Protected, CORS-blocked, tbvideo, slow-CDN, or SW-unavailable whitelisted direct files via connected extension
  if (
    option.deliveryKind === "file" &&
    extDirect &&
    option.whitelistedForExtension !== false &&
    (option.browserFetchBlocked ||
      option.requiresRefererOrBlockedFetch ||
      option.preferExtensionDirectAcceleration ||
      option.corsBlockedDirect ||
      option.hasTbvideo ||
      env.swMultiRangeAvailable === false)
  ) {
    return {
      channel: "extension_direct",
      canDownload: true,
      usesExtension: true,
      requiresUpgradeNotice: false,
    };
  }

  // 4b. Hard referer-protected (`browser_fetch: "blocked"`) direct files cannot be fetched in a Web tab without the extension
  if (option.deliveryKind === "file" && option.browserFetchBlocked === true) {
    return {
      channel: "blocked",
      canDownload: false,
      usesExtension: false,
      requiresUpgradeNotice: true,
      reason: "extension_direct_required",
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
        requiresUpgradeNotice: false,
      };
    }
    if (env.swMultiRangeAvailable !== false && option.deliveryKind === "file") {
      return {
        channel: "web_sw_stream",
        canDownload: true,
        usesExtension: false,
        requiresUpgradeNotice: false,
      };
    }
    return {
      channel: "browser_direct",
      canDownload: true,
      usesExtension: false,
      requiresUpgradeNotice: false,
    };
  }

  return {
    channel: "external_link",
    canDownload: false,
    usesExtension: false,
    requiresUpgradeNotice: false,
  };
}
