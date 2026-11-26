import {
  parsePositiveSafeBytes,
  resolveVariantDimensions,
  resolveYouTubeAudioFormatLabel,
  resolveYouTubeDownloadTier,
  stripSilentOnlyNotice,
} from "../components/result/resultI18n";
import { formatYouTubeMuxOptionSize } from "../components/result/resultPresentation";
import { confirmedFormatMime, extensionsFor } from "../downloads/file";
import { isSafeDownloadExtension } from "./filenameSanitizer";
import type {
  Attachment,
  Chunk,
  MediaItem,
  MediaMetadata,
  ReadyItem,
  ReadyVariant,
  Resource,
  Source,
  UnifiedMedia,
} from "../types/media";
import {
  availableSources,
  deliveryRoutes,
  getDownloadTarget,
  readyItem,
  readyVariant,
  resourceSource,
  sourceRoutes,
  sourceUrl,
  type DownloadTarget,
  type TargetContext,
} from "../utils/mediaContract";
import { mediaExtension } from "../utils/mediaDelivery";
import {
  formatMediaSize,
  variantLabel,
  variantSpecifications,
} from "../utils/mediaSources";
import {
  isValidGooglevideoPlaybackUrl,
  selectYouTubeMuxPair,
  type YouTubeMuxPairResult,
} from "../utils/youtubeHelperCore";
import { extractDashMuxSpec } from "./dashMuxSpec";
import {
  buildCanonicalVariantDescriptor,
  compareCanonicalVariantDesc,
  hasMultiCollectionGroups,
  inferDirectVideoExtension,
  isTbvideoVideoItem,
  resolvePreferredMediaTitle,
  sortVariantsCanonical,
} from "../core/media";
import {
  PROD_API_ORIGIN,
  isSafeNativeBrowserDownloadUrl,
  isWhitelistedMediaUrl,
  validateApiBaseUrl,
  type ApiBaseUrlValidationResult,
} from "./hostWhitelist";
import {
  SIDEPANEL_PORT_NAME,
  errRpc,
  isBackgroundBroadcast,
  type BackgroundToSidePanelBroadcast,
  type ExtensionDownloadTask,
  type ExtensionRpcResponse,
  type ExtensionThemeMode,
  type OffscreenDashMuxSpec,
  type QualityPreference,
  type SidePanelResponseMap,
  type SidePanelToBackgroundRequest,
} from "./protocol";
import {
  DEFAULT_EXTENSION_SETTINGS,
  normalizeExtensionThemeMode,
} from "./storage";
import { PLATFORM_DOMAIN_SPECS } from "./urlMatcher";

export const PORT_RECONNECT_DELAY_MS = 250;
export const EXTENSION_THEME_CACHE_KEY = "dokitool_ext_theme_v1" as const;

export type LivePhotoSaveFilter = "both" | "motion" | "video" | "image";
export type MediaLayoutKind = "single" | "album" | "multi_video" | "mixed";

// ============================================================================
// SidePanel Theme Sync Helpers (Zero-Flash Boot + Authoritative Storage Sync)
// ============================================================================

export function readCachedExtensionTheme(): ExtensionThemeMode {
  try {
    if (typeof localStorage !== "undefined") {
      return normalizeExtensionThemeMode(
        localStorage.getItem(EXTENSION_THEME_CACHE_KEY),
      );
    }
  } catch {
    // Ignore storage access restrictions
  }
  return "system";
}

export function applyExtensionTheme(
  theme: ExtensionThemeMode | unknown,
  options?: {
    persistCache?: boolean;
    rootElement?: HTMLElement | null;
  },
): ExtensionThemeMode {
  const normalized = normalizeExtensionThemeMode(theme);
  const root =
    options?.rootElement !== undefined
      ? options.rootElement
      : typeof document !== "undefined"
        ? document.documentElement
        : null;

  if (root && root.dataset) {
    if (normalized === "light" || normalized === "dark") {
      root.dataset.theme = normalized;
    } else {
      delete root.dataset.theme;
    }
  }

  if (options?.persistCache !== false) {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(EXTENSION_THEME_CACHE_KEY, normalized);
      }
    } catch {
      // Ignore storage access restrictions
    }
  }

  return normalized;
}

export function applyCachedExtensionTheme(
  rootElement?: HTMLElement | null,
): ExtensionThemeMode {
  const cached = readCachedExtensionTheme();
  return applyExtensionTheme(cached, {
    persistCache: false,
    rootElement,
  });
}

export function getNextExtensionTheme(
  current: ExtensionThemeMode | unknown,
): ExtensionThemeMode {
  const normalized = normalizeExtensionThemeMode(current);
  if (normalized === "system") return "light";
  if (normalized === "light") return "dark";
  return "system";
}

// ============================================================================
// Minimal Chrome MV3 Runtime Facade (zero `@types/chrome` dependency)
// ============================================================================

interface ChromePortLike {
  name: string;
  onMessage: {
    addListener(cb: (msg: unknown) => void): void;
    removeListener(cb: (msg: unknown) => void): void;
  };
  onDisconnect: {
    addListener(cb: () => void): void;
    removeListener(cb: () => void): void;
  };
  postMessage(msg: unknown): void;
  disconnect(): void;
}

interface ChromeRuntimeLike {
  id?: string;
  lastError?: { message?: string };
  getURL?: (path: string) => string;
  sendMessage?: (
    message: unknown,
    callback?: (response: unknown) => void,
  ) => Promise<unknown> | void;
  connect?: (connectInfo?: { name?: string }) => ChromePortLike;
  onMessage?: {
    addListener(
      cb: (
        message: unknown,
        sender: unknown,
        sendResponse: (response?: unknown) => void,
      ) => boolean | void,
    ): void;
    removeListener(
      cb: (
        message: unknown,
        sender: unknown,
        sendResponse: (response?: unknown) => void,
      ) => boolean | void,
    ): void;
  };
}

interface ChromePermissionsLike {
  request?: (permissions: { origins: string[] }) => Promise<boolean>;
  contains?: (permissions: { origins: string[] }) => Promise<boolean>;
}

interface ChromeTabRecordLike {
  id?: number;
  windowId?: number;
  url?: string;
}

interface ChromeTabsLike {
  create?: (createProperties: {
    url: string;
    active?: boolean;
  }) => Promise<unknown> | void;
  query?: (queryInfo: {
    url?: string | string[];
  }) => Promise<ChromeTabRecordLike[]>;
  update?: (
    tabId: number,
    updateProperties: { active?: boolean },
  ) => Promise<unknown> | void;
}

interface ChromeWindowsLike {
  update?: (
    windowId: number,
    updateInfo: { focused?: boolean },
  ) => Promise<unknown> | void;
}

function getChromeNamespace(): {
  runtime?: ChromeRuntimeLike;
  permissions?: ChromePermissionsLike;
  tabs?: ChromeTabsLike;
  windows?: ChromeWindowsLike;
} {
  const g = globalThis as unknown as {
    chrome?: {
      runtime?: ChromeRuntimeLike;
      permissions?: ChromePermissionsLike;
      tabs?: ChromeTabsLike;
      windows?: ChromeWindowsLike;
    };
  };
  return g.chrome ?? {};
}

export async function sendSidePanelRequest<
  T extends SidePanelToBackgroundRequest["type"],
>(
  request: Extract<SidePanelToBackgroundRequest, { type: T }>,
): Promise<ExtensionRpcResponse<SidePanelResponseMap[T]>> {
  const runtime = getChromeNamespace().runtime;
  if (!runtime?.sendMessage) {
    return errRpc("扩展后台通信接口不可用（请在 Chrome 扩展环境中运行）", {
      code: "NO_RUNTIME",
    });
  }

  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const done = (val: unknown, err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(val);
      };

      try {
        const maybePromise = runtime.sendMessage!(request, (response) => {
          const lastErr = runtime.lastError;
          if (lastErr) {
            done(
              undefined,
              new Error(lastErr.message || "后台服务通信中断，请重试"),
            );
            return;
          }
          done(response);
        });
        if (
          maybePromise &&
          typeof (maybePromise as Promise<unknown>).then === "function"
        ) {
          (maybePromise as Promise<unknown>).then(
            (val) => done(val),
            (err) =>
              done(
                undefined,
                err instanceof Error ? err : new Error(String(err)),
              ),
          );
        }
      } catch (err) {
        done(undefined, err instanceof Error ? err : new Error(String(err)));
      }
    });

    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { ok?: unknown }).ok === "boolean"
    ) {
      return raw as ExtensionRpcResponse<SidePanelResponseMap[T]>;
    }
    return errRpc("后台未返回有效响应，请重试", { code: "EMPTY_RESPONSE" });
  } catch (error) {
    return errRpc(
      error instanceof Error ? error.message : "与扩展后台通信失败",
      { code: "IPC_ERROR" },
    );
  }
}

export function createSidePanelBroadcastBridge(
  onBroadcast: (msg: BackgroundToSidePanelBroadcast) => void,
): { dispose: () => void } {
  let disposed = false;
  let port: ChromePortLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const handleIncoming = (msg: unknown) => {
    if (disposed) return;
    if (isBackgroundBroadcast(msg)) {
      onBroadcast(msg);
    }
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectPort();
    }, PORT_RECONNECT_DELAY_MS);
  };

  const connectPort = () => {
    if (disposed) return;
    const runtime = getChromeNamespace().runtime;
    if (!runtime?.connect) return;
    try {
      const nextPort = runtime.connect({ name: SIDEPANEL_PORT_NAME });
      port = nextPort;
      nextPort.onMessage.addListener(handleIncoming);
      nextPort.onDisconnect.addListener(() => {
        // Touch runtime.lastError so Chrome doesn't log unchecked lastError on SW cycle
        void runtime.lastError;
        if (port === nextPort) {
          port = null;
        }
        scheduleReconnect();
      });
    } catch {
      port = null;
      scheduleReconnect();
    }
  };

  // Fallback runtime.onMessage listener: strictly inspects broadcasts ONLY and
  // ALWAYS returns `false` without calling `sendResponse` so it never races background/offscreen!
  const onRuntimeMessage = (msg: unknown): boolean => {
    if (!disposed && isBackgroundBroadcast(msg)) {
      onBroadcast(msg);
    }
    return false;
  };

  const runtime = getChromeNamespace().runtime;
  runtime?.onMessage?.addListener(onRuntimeMessage);
  connectPort();

  return {
    dispose() {
      disposed = true;
      clearReconnect();
      runtime?.onMessage?.removeListener(onRuntimeMessage);
      if (port) {
        try {
          port.disconnect();
        } catch {
          // Ignore disconnect errors on teardown
        }
        port = null;
      }
    },
  };
}

/**
 * Requests optional loopback host permission (`http://127.0.0.1/*` or `http://localhost/*`).
 * IMPORTANT: Calls `chrome.permissions.request({ origins: [validated.origin + "/*"] })`
 * synchronously on the very first line before any `await` to preserve Chrome's transient user gesture!
 */
export async function requestLoopbackOriginPermissionOnGesture(
  validated: ApiBaseUrlValidationResult,
): Promise<boolean> {
  if (!validated.ok || !validated.isLoopback) {
    return true;
  }
  const permissions = getChromeNamespace().permissions;
  if (!permissions?.request) {
    return true;
  }

  const exactOriginPattern = `${validated.origin}/*`;
  let hostWildcardPattern = exactOriginPattern;
  try {
    const parsed = new URL(validated.origin);
    hostWildcardPattern = `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    // Keep exactOriginPattern
  }

  try {
    // Synchronous call right inside the user click handler before any await!
    const granted = await permissions.request({
      origins: [exactOriginPattern],
    });
    if (granted) return true;
  } catch {
    if (hostWildcardPattern !== exactOriginPattern) {
      try {
        const grantedHost = await permissions.request({
          origins: [hostWildcardPattern],
        });
        if (grantedHost) return true;
      } catch {
        // Fall through to contains check (e.g. --dev-loopback already in host_permissions)
      }
    }
  }

  if (permissions.contains) {
    try {
      return await permissions.contains({ origins: [hostWildcardPattern] });
    } catch {
      return false;
    }
  }
  return false;
}

export function openSafeHttpTab(rawUrl: string): boolean {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }
  const safeHref = parsed.toString();
  const tabs = getChromeNamespace().tabs;
  if (tabs?.create) {
    try {
      void tabs.create({ url: safeHref, active: true });
      return true;
    } catch {
      // Fall back to window.open
    }
  }
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(safeHref, "_blank", "noopener,noreferrer");
    return true;
  }
  return false;
}

/**
 * Opens the Web Owner Parse Monitor Dashboard (`${apiOrigin}/monitor`) in a browser tab.
 * Validates `apiBaseUrl` (defaulting to `DEFAULT_EXTENSION_SETTINGS.apiBaseUrl`), NEVER
 * appends query params, `#hash`, or any Bearer token, and reuses an already-open
 * `/monitor` or `/monitor.html` tab for the same origin when `chrome.tabs.query` and
 * `chrome.tabs.update` are available; otherwise opens a new tab via `chrome.tabs.create`.
 * Safe no-op (`false`) on invalid URLs or outside a Chrome extension runtime.
 */
export async function openMonitorDashboardTab(
  apiBaseUrl?: string,
): Promise<boolean> {
  const validated = validateApiBaseUrl(
    apiBaseUrl || DEFAULT_EXTENSION_SETTINGS.apiBaseUrl,
  );
  if (!validated.ok) {
    return false;
  }

  const monitorUrl = `${validated.origin}/monitor`;
  const monitorHtmlUrl = `${validated.origin}/monitor.html`;
  const { tabs, windows } = getChromeNamespace();

  const findMatchingTab = (
    candidates: unknown,
    requireExplicitUrl: boolean,
  ): ChromeTabRecordLike | undefined => {
    if (!Array.isArray(candidates)) return undefined;
    return candidates.find((tab) => {
      if (typeof tab?.id !== "number" || !Number.isInteger(tab.id)) {
        return false;
      }
      if (typeof tab.url !== "string" || !tab.url) {
        return !requireExplicitUrl;
      }
      return (
        tab.url === monitorUrl ||
        tab.url === `${monitorUrl}/` ||
        tab.url === monitorHtmlUrl
      );
    });
  };

  const activateTab = async (existing: ChromeTabRecordLike): Promise<boolean> => {
    if (typeof existing.id !== "number" || !tabs?.update) return false;
    await tabs.update(existing.id, { active: true });
    if (typeof existing.windowId === "number" && windows?.update) {
      try {
        await windows.update(existing.windowId, { focused: true });
      } catch {
        // Best-effort window focus
      }
    }
    return true;
  };

  if (tabs?.query && tabs?.update) {
    try {
      const existingTabs = await tabs.query({
        url: [monitorUrl, monitorHtmlUrl],
      });
      const existing = findMatchingTab(existingTabs, false);
      if (existing) {
        return await activateTab(existing);
      }
    } catch {
      // Chrome MV3 match patterns forbid explicit ports (e.g. http://127.0.0.1:18080).
      // Retry with portless host patterns and strictly filter by exact tab.url.
      try {
        const parsedOrigin = new URL(validated.origin);
        if (parsedOrigin.port !== "") {
          const portlessOrigin = `${parsedOrigin.protocol}//${parsedOrigin.hostname}`;
          const fallbackTabs = await tabs.query({
            url: [`${portlessOrigin}/monitor`, `${portlessOrigin}/monitor.html`],
          });
          const existing = findMatchingTab(fallbackTabs, true);
          if (existing) {
            return await activateTab(existing);
          }
        }
      } catch {
        // Fall through to tabs.create
      }
    }
  }

  if (tabs?.create) {
    try {
      await tabs.create({ url: monitorUrl, active: true });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

// ============================================================================
// Formatting & Platform Helpers
// ============================================================================

const PLATFORM_LABEL_MAP = new Map<string, string>(
  PLATFORM_DOMAIN_SPECS.map((spec) => [spec.id, spec.label]),
);

const LONG_TAIL_PLATFORM_LABELS: Readonly<Record<string, string>> = {
  tiktok: "TikTok",
  vimeo: "Vimeo",
  reddit: "Reddit",
  twitch: "Twitch",
  twitchvod: "Twitch",
  twitchclips: "Twitch",
  soundcloud: "SoundCloud",
  niconico: "Niconico",
  pinterest: "Pinterest",
  dailymotion: "Dailymotion",
  vk: "VK",
  streamable: "Streamable",
  bandcamp: "Bandcamp",
  generic: "通用站点",
  unknown: "未知平台",
};

export function formatPlatformDisplayName(platform?: string): string {
  if (!platform || !platform.trim()) return "未知平台";
  const trimmed = platform.trim();
  const key = trimmed.toLowerCase();
  const mapped = PLATFORM_LABEL_MAP.get(key) ?? LONG_TAIL_PLATFORM_LABELS[key];
  if (mapped) return mapped;
  if (trimmed.includes(".")) return key;
  if (/^[a-z0-9_-]+$/.test(trimmed)) {
    return trimmed
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  return trimmed;
}

export function resolveSafeApiOrigin(rawApiBaseUrl?: string): string {
  const check = validateApiBaseUrl(rawApiBaseUrl || PROD_API_ORIGIN);
  return check.ok ? check.origin : PROD_API_ORIGIN;
}

export function buildExtraAllowedOrigins(apiOrigin: string): string[] | undefined {
  return apiOrigin && apiOrigin !== PROD_API_ORIGIN ? [apiOrigin] : undefined;
}

/**
 * Builds the extension's `TargetContext` with relay-direct opt-in strictly gated
 * to built-in whitelisted HTTPS media CDN hosts (never trusting custom API origins
 * or unwhitelisted hosts for `source.direct_url`).
 */
export function buildExtensionTargetContext(
  apiOrigin?: string | null,
  now?: number,
): TargetContext {
  const resolvedOrigin = resolveSafeApiOrigin(apiOrigin ?? undefined);
  return {
    apiOrigin: resolvedOrigin,
    ...(now !== undefined ? { now } : {}),
    preferRelayDirect: (directUrl: string) => {
      try {
        const parsed = new URL(directUrl);
        if (parsed.protocol !== "https:") return false;
        if (
          parsed.origin === PROD_API_ORIGIN ||
          parsed.origin === resolvedOrigin
        ) {
          return false;
        }
      } catch {
        return false;
      }
      return isWhitelistedMediaUrl(directUrl).allowed;
    },
  };
}

export function formatDurationMs(durationMs?: number): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return "";
  }
  const totalSec = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatTransferSpeed(bytesPerSecond?: number): string {
  if (
    typeof bytesPerSecond !== "number" ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond <= 0
  ) {
    return "";
  }
  if (bytesPerSecond >= 1_000_000) {
    return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;
  }
  if (bytesPerSecond >= 1_000) {
    return `${Math.round(bytesPerSecond / 1_000)} KB/s`;
  }
  return `${Math.round(bytesPerSecond)} B/s`;
}

export function formatByteProgress(loaded: number, total: number): string {
  const safeLoaded = Number.isFinite(loaded) && loaded > 0 ? loaded : 0;
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const fmt = (b: number) => {
    if (b >= 1_000_000_000) return `${(b / 1_000_000_000).toFixed(2)} GB`;
    if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
    if (b >= 1_000) return `${Math.round(b / 1_000)} KB`;
    return `${Math.round(b)} B`;
  };
  if (safeTotal > 0) {
    return `${fmt(safeLoaded)} / ${fmt(safeTotal)}`;
  }
  if (safeLoaded > 0) {
    return fmt(safeLoaded);
  }
  return "";
}

// ============================================================================
// Quality Preference Memory & Variant Card Presentation
// ============================================================================

export type ExtractedYouTubeMuxPair = Extract<YouTubeMuxPairResult, { ok: true }>;

export interface SidePanelAudioBadge {
  text: string;
  tone: "mux" | "audio" | "track" | "silent";
}

export type QualityDeliveryMode = "opfs" | "native_direct" | "external_only";

export const EXTERNAL_ONLY_STREAM_REASON =
  "该长尾流媒体域名不在扩展权限白名单内，支持复制直链或打开原帖" as const;

export interface SidePanelQualityOption {
  key: string;
  kind: "variant" | "attachment";
  variant: ReadyVariant;
  attachment?: Attachment;
  source: Source | null;
  downloadTarget: DownloadTarget;
  downloadable: boolean;
  deliveryMode: QualityDeliveryMode;
  externalOnlyReason?: string;
  titleLabel: string;
  specs: string[];
  audioBadge: SidePanelAudioBadge | null;
  sizeLabel: string;
  sizeBytes: number;
  isAudioOnly: boolean;
  effectiveHasAudio: boolean;
  shortEdge: number;
  pixelArea: number;
  fps: number;
  bitrateBps: number;
  videoCodec: string;
  muxPair: ExtractedYouTubeMuxPair | null;
  isDashMux: boolean;
  dashMux: OffscreenDashMuxSpec | null;
  resolvedExt: string;
  formatMime?: string;
  directUrl: string;
  /**
   * External/clipboard-safe URL for user-initiated "copy direct link" or
   * browser-tab fallback: preserves signed relay URLs for `access === "relay"`
   * sources (which would 403 outside extension DNR), while matching `directUrl`
   * for direct/owner sources.
   */
  copyUrl: string;
  routes: string[];
}

function uiVideoCodecPreferenceRank(rawCodec: unknown): number {
  if (typeof rawCodec !== "string") return 0;
  const lower = rawCodec.trim().toLowerCase();
  if (!lower) return 0;
  if (
    lower === "h264" ||
    lower === "h.264" ||
    lower === "avc" ||
    lower === "avc1" ||
    lower.startsWith("avc1.") ||
    lower === "avc3" ||
    lower.startsWith("avc3.")
  ) {
    return 3;
  }
  if (
    lower === "hevc" ||
    lower === "h265" ||
    lower === "h.265" ||
    lower === "hev1" ||
    lower.startsWith("hev1.") ||
    lower === "hvc1" ||
    lower.startsWith("hvc1.")
  ) {
    return 2;
  }
  if (lower === "av1" || lower === "av01" || lower.startsWith("av01.")) {
    return 1;
  }
  return 0;
}

function estimateDashMuxByteTotals(
  variant: ReadyVariant,
  dashMux: OffscreenDashMuxSpec,
  itemDurationMs?: number,
): { exactBytes: number; estimatedBytes: number } {
  const vExact = parsePositiveSafeBytes(dashMux.videoSize);
  const aExact = parsePositiveSafeBytes(dashMux.audioSize);
  if (vExact > 0 && aExact > 0) {
    return { exactBytes: vExact + aExact, estimatedBytes: 0 };
  }

  const vResMeta =
    variant.delivery.kind === "mux"
      ? variant.delivery.resources.find((r) => r.role === "video")?.metadata
      : undefined;
  const aResMeta =
    variant.delivery.kind === "mux"
      ? variant.delivery.resources.find((r) => r.role === "audio")?.metadata
      : undefined;

  const durationMs =
    Number(
      variant.metadata?.duration_ms ||
        vResMeta?.duration_ms ||
        aResMeta?.duration_ms ||
        itemDurationMs ||
        0,
    ) || 0;
  const videoBps =
    Number(
      variant.metadata?.video_bitrate_bps ||
        vResMeta?.video_bitrate_bps ||
        vResMeta?.bitrate_bps ||
        0,
    ) || 0;
  const audioBps =
    Number(
      variant.metadata?.audio_bitrate_bps ||
        aResMeta?.audio_bitrate_bps ||
        aResMeta?.bitrate_bps ||
        0,
    ) || 0;
  const combinedBps =
    videoBps + audioBps || Number(variant.metadata?.bitrate_bps || 0) || 0;

  const estimatedBytes =
    combinedBps > 0 && durationMs > 0
      ? Math.round((combinedBps * durationMs) / 8000)
      : 0;
  return {
    exactBytes: vExact + aExact,
    estimatedBytes,
  };
}

function formatApproxSizeLabel(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    return formatMediaSize(0, "zh-CN");
  }
  return `约 ${formatMediaSize(bytes, "zh-CN")}`;
}

function inferVideoExtFromUrl(
  rawUrl: string,
  platform?: string,
  hasTbvideo = false,
): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    const queryMime = (parsed.searchParams.get("mime_type") || "")
      .trim()
      .toLowerCase();
    if (queryMime === "video_mp4" || queryMime === "video/mp4") return "mp4";
    if (queryMime === "video_webm" || queryMime === "video/webm") return "webm";
    if (queryMime === "video_quicktime" || queryMime === "video/quicktime") {
      return "mov";
    }
    const pathExtMatch = /\.([a-z0-9]{2,5})$/i.exec(parsed.pathname);
    if (pathExtMatch) {
      const ext = pathExtMatch[1].toLowerCase();
      if (ext === "mp4" || ext === "m4v") return "mp4";
      if (
        [
          "webm",
          "mov",
          "mkv",
          "m4a",
          "mp3",
          "aac",
          "ogg",
          "opus",
          "wav",
          "flac",
          "jpg",
          "jpeg",
          "png",
          "webp",
          "gif",
          "avif",
        ].includes(ext)
      ) {
        return ext === "jpeg" ? "jpg" : ext;
      }
    }
    const inferred = inferDirectVideoExtension(rawUrl, hasTbvideo);
    if (inferred) return inferred;
    return undefined;
  } catch {
    return undefined;
  }
}

export function resolveVariantExtension(params: {
  variant: ReadyVariant;
  itemType: MediaItem["type"];
  primaryUrl: string;
  platform?: string;
  hasTbvideo?: boolean;
  muxPair?: ExtractedYouTubeMuxPair | null;
  dashMux?: OffscreenDashMuxSpec | null;
}): { ext: string; formatMime?: string } {
  const { variant, itemType, primaryUrl, platform, hasTbvideo, muxPair, dashMux } =
    params;
  if (muxPair) {
    return {
      ext: muxPair.outputExtension,
      formatMime: muxPair.outputMimeType,
    };
  }
  if (dashMux) {
    return {
      ext: dashMux.outputContainer,
      formatMime: "video/mp4",
    };
  }
  const delivery = variant.delivery;
  const leafDelivery =
    delivery.kind === "mux" || delivery.kind === "pair" ? undefined : delivery;
  const baseExt = mediaExtension(variant.metadata, leafDelivery);
  const formatMime =
    delivery.kind === "file" ? confirmedFormatMime(variant.metadata) : undefined;
  const suffixes = extensionsFor(formatMime || "");
  let resolvedExt =
    suffixes.length && !suffixes.includes(baseExt) ? suffixes[0] : baseExt;
  if (!isSafeDownloadExtension(resolvedExt)) {
    resolvedExt = "bin";
  }

  if (resolvedExt === "bin") {
    const fromUrl = inferVideoExtFromUrl(primaryUrl, platform, hasTbvideo);
    if (fromUrl) {
      resolvedExt = fromUrl;
    } else if (itemType === "image") {
      resolvedExt = "jpg";
    } else if (itemType === "audio") {
      resolvedExt = "m4a";
    } else if (itemType === "video") {
      resolvedExt = "mp4";
    }
  }
  return { ext: resolvedExt, formatMime };
}

export function isStandaloneAudioMetadata(
  meta: MediaMetadata | undefined,
  itemType: MediaItem["type"],
): boolean {
  if (itemType === "audio") return true;
  if (!meta) return false;
  const mime = String(meta.mime_type || "").toLowerCase();
  const ext = String(meta.extension || meta.container || "").toLowerCase();
  return (
    !meta.video_codec &&
    !meta.width &&
    !meta.height &&
    (meta.has_audio === true ||
      mime.startsWith("audio/") ||
      ext === "m4a" ||
      ext === "mp3" ||
      ext === "aac" ||
      ext === "opus" ||
      ext === "ogg" ||
      ext === "wav" ||
      ext === "flac")
  );
}

function inferEffectiveShortEdge(variant: ReadyVariant): number {
  const { shortEdge } = resolveVariantDimensions(variant);
  if (shortEdge > 0) return shortEdge;
  const raw = String(variant.label || "").trim().toLowerCase();
  if (!raw) return 0;
  if (/\b8k\b/.test(raw)) return 4320;
  if (/\b4k\b/.test(raw)) return 2160;
  if (/\b2k\b/.test(raw)) return 1440;
  const pMatch = /(\d{3,4})p/.exec(raw);
  if (pMatch) return Number(pMatch[1]) || 0;
  if (/(?:^|_)(?:hd|高清)(?:$|_)/i.test(raw)) return 720;
  if (/(?:^|_)(?:sd|标清)(?:$|_)/i.test(raw)) return 480;
  if (/(?:^|_)(?:ld|流畅)(?:$|_)/i.test(raw)) return 360;
  return 0;
}

export function findBestStandaloneAudioForYouTube(
  item: MediaItem,
  attachments: Attachment[],
  apiOrigin: string,
): { variantId: string; url: string; ext: "m4a" | "webm" } | null {
  const ctx = buildExtensionTargetContext(apiOrigin);
  const candidates: ReadyVariant[] = [];
  if (readyItem(item)) {
    for (const v of item.variants) {
      if (readyVariant(v) && v.delivery.kind === "file") {
        candidates.push(v);
      }
    }
  }
  for (const att of attachments) {
    if (att?.resource?.role === "audio" && att.resource.delivery.kind === "file") {
      candidates.push({
        id: `attachment:${att.id}`,
        state: "ready",
        label: att.title || "原声轨",
        metadata: att.resource.metadata,
        delivery: att.resource.delivery,
      });
    }
  }

  // Prefer M4A over WebM for universal player compatibility
  const scored = candidates
    .filter((cand) => isStandaloneAudioMetadata(cand.metadata, "video"))
    .map((cand) => {
      const meta = cand.metadata || {};
      const mime = String(meta.mime_type || "").toLowerCase();
      const rawExt = String(meta.extension || meta.container || "").toLowerCase();
      const isM4a = rawExt === "m4a" || rawExt === "mp4" || mime.includes("mp4");
      const src =
        cand.delivery.kind === "file"
          ? cand.delivery.sources.find((s) => {
              try {
                return (
                  s.availability !== "unavailable" &&
                  isValidGooglevideoPlaybackUrl(sourceUrl(s, ctx))
                );
              } catch {
                return false;
              }
            })
          : undefined;
      return {
        cand,
        src,
        isM4a,
        bitrate: Number(meta.audio_bitrate_bps || meta.bitrate_bps || 0),
      };
    })
    .filter((entry) => Boolean(entry.src))
    .sort((a, b) => {
      if (a.isM4a !== b.isM4a) return a.isM4a ? -1 : 1;
      return b.bitrate - a.bitrate;
    });

  const best = scored[0];
  if (!best || !best.src) return null;
  return {
    variantId: best.cand.id,
    url: sourceUrl(best.src, ctx),
    ext: best.isM4a ? "m4a" : "webm",
  };
}

export function mergeMediaAttachmentsById(
  existing: Attachment[] | undefined,
  incoming: Attachment[] | undefined,
): Attachment[] | undefined {
  const base = existing ?? [];
  const next = incoming ?? [];
  if (!base.length && !next.length) return undefined;
  if (!next.length) return existing;
  const merged = [...base];
  const indexById = new Map<string, number>();
  for (let i = 0; i < merged.length; i++) {
    const id = typeof merged[i]?.id === "string" ? merged[i].id : "";
    if (id) indexById.set(id, i);
  }
  for (const att of next) {
    if (!att) continue;
    const id = typeof att.id === "string" ? att.id : "";
    if (id && indexById.has(id)) {
      merged[indexById.get(id)!] = att;
    } else {
      if (id) indexById.set(id, merged.length);
      merged.push(att);
    }
  }
  return merged;
}

export function isAttachmentApplicableToItem(
  att: Attachment | null | undefined,
  item: Pick<MediaItem, "id">,
): boolean {
  const attId = typeof att?.id === "string" ? att.id.trim() : "";
  if (attId.startsWith("bilibili-audio-")) {
    return attId === `bilibili-audio-${item.id}`;
  }
  return true;
}

function resolveItemScopedAudioAttachments(
  media: Pick<UnifiedMedia, "platform" | "attachments">,
  item: ReadyItem,
  ctx: TargetContext,
): Attachment[] {
  const scoped: Attachment[] = [];
  const seenPrimaryUrls = new Set<string>();
  const expectedBiliAudioId = `bilibili-audio-${item.id}`;

  for (const att of media.attachments ?? []) {
    if (!isAttachmentApplicableToItem(att, item)) continue;
    if (
      (att.role === "background_audio" || att.resource?.role === "audio") &&
      att.resource?.delivery?.kind === "file"
    ) {
      scoped.push(att);
      const avail = availableSources(att.resource.delivery.sources, ctx.now);
      const primarySrc = avail[0] ?? att.resource.delivery.sources[0];
      if (primarySrc) {
        try {
          const url = sourceUrl(primarySrc, ctx);
          if (url) seenPrimaryUrls.add(url);
        } catch {
          // Ignore invalid source URL during dedupe check
        }
      }
    }
  }

  // Fallback / authoritative episode audio: if this item carries ready DASH mux
  // variants with a role:"audio" file leaf, surface the episode's own best M4A
  // audio leaf even when media.attachments hasn't been merged for this part yet.
  let bestMuxAudioLeaf: Resource | null = null;
  let bestMuxAudioBitrate = -1;
  let bestMuxAudioUrl = "";
  for (const variant of item.variants) {
    if (!readyVariant(variant) || variant.delivery.kind !== "mux") continue;
    for (const res of variant.delivery.resources) {
      if (res.role !== "audio" || res.delivery.kind !== "file") continue;
      const avail = availableSources(res.delivery.sources, ctx.now);
      const primarySrc = avail[0];
      if (!primarySrc) continue;
      let url = "";
      try {
        url = sourceUrl(primarySrc, ctx);
      } catch {
        continue;
      }
      if (!url) continue;
      const bitrate = Number(
        res.metadata?.audio_bitrate_bps || res.metadata?.bitrate_bps || 0,
      );
      if (!bestMuxAudioLeaf || bitrate > bestMuxAudioBitrate) {
        bestMuxAudioLeaf = res;
        bestMuxAudioBitrate = bitrate;
        bestMuxAudioUrl = url;
      }
    }
  }

  if (
    bestMuxAudioLeaf &&
    bestMuxAudioUrl &&
    !seenPrimaryUrls.has(bestMuxAudioUrl) &&
    !scoped.some((att) => att.id === expectedBiliAudioId)
  ) {
    scoped.push({
      id:
        media.platform === "bilibili"
          ? expectedBiliAudioId
          : `mux-audio-${item.id}`,
      role: "background_audio",
      title: "原声音频 (M4A)",
      resource: bestMuxAudioLeaf,
    });
  }

  return scoped;
}

export function hasWhitelistedRoute(
  routes: readonly string[],
  extraOrigins?: string[],
): boolean {
  return routes.some((r) => isWhitelistedMediaUrl(r, extraOrigins).allowed);
}

function classifyDirectFileDeliveryMode(
  routes: readonly string[],
  extraOrigins?: string[],
): {
  deliveryMode: QualityDeliveryMode;
  downloadable: boolean;
  externalOnlyReason?: string;
} {
  if (hasWhitelistedRoute(routes, extraOrigins)) {
    return { deliveryMode: "opfs", downloadable: true };
  }
  if (
    routes.some((r) => isSafeNativeBrowserDownloadUrl(r, extraOrigins).safe)
  ) {
    return { deliveryMode: "native_direct", downloadable: true };
  }
  return {
    deliveryMode: "external_only",
    downloadable: false,
    externalOnlyReason: "该媒体直链不符合扩展安全下载规则，请打开原帖查看",
  };
}

export function buildSidePanelQualityOptions(
  media: UnifiedMedia,
  item: MediaItem | null | undefined,
  rawApiOrigin: string,
  options?: { now?: number; extraAllowedOrigins?: string[] },
): SidePanelQualityOption[] {
  if (!item || !readyItem(item)) return [];
  const resolvedApiOrigin = resolveSafeApiOrigin(rawApiOrigin);
  const defaultExtraOrigins = buildExtraAllowedOrigins(resolvedApiOrigin) ?? [];
  const mergedExtraOrigins = Array.from(
    new Set([
      ...defaultExtraOrigins,
      ...(options?.extraAllowedOrigins ?? []),
    ]),
  );
  const extraOrigins =
    mergedExtraOrigins.length > 0 ? mergedExtraOrigins : undefined;
  const ctx = buildExtensionTargetContext(resolvedApiOrigin, options?.now);
  const copyCtx: TargetContext =
    options?.now !== undefined
      ? { apiOrigin: resolvedApiOrigin, now: options.now }
      : { apiOrigin: resolvedApiOrigin };
  const attachments = media.attachments ?? [];

  const muxPairsByVariantId = new Map<string, ExtractedYouTubeMuxPair>();
  if (item.type === "video") {
    for (const v of item.variants) {
      if (readyVariant(v) && v.metadata?.has_audio === false) {
        const pair = selectYouTubeMuxPair(v, item.variants, attachments);
        if (pair.ok) {
          muxPairsByVariantId.set(v.id, pair);
        }
      }
    }
  }

  const qualityOptions: SidePanelQualityOption[] = [];

  for (const variant of item.variants) {
    if (!readyVariant(variant)) continue;
    const primarySource =
      variant.delivery.kind === "file"
        ? availableSources(variant.delivery.sources, ctx.now)[0] ??
          variant.delivery.sources[0] ??
          null
        : null;

    const target = getDownloadTarget(
      item,
      {
        variant_id: variant.id,
        ...(primarySource?.id ? { source_id: primarySource.id } : {}),
      },
      ctx,
    );
    const dashMux = extractDashMuxSpec(variant, ctx);
    const isDashMux = Boolean(dashMux);
    const structurallyDownloadable =
      ["file", "hls", "segments", "pair"].includes(target.kind) || isDashMux;
    const resolvedSource = target.kind === "file" ? target.source : primarySource;
    const muxPair = muxPairsByVariantId.get(variant.id) ?? null;
    const videoLeafMeta =
      variant.delivery.kind === "mux"
        ? variant.delivery.resources.find((r) => r.role === "video")?.metadata
        : undefined;
    const meta = variant.metadata ?? {};
    const isAudioOnly = isStandaloneAudioMetadata(meta, item.type);
    const effectiveHasAudio =
      isAudioOnly ||
      Boolean(muxPair) ||
      isDashMux ||
      meta.has_audio === true ||
      (item.type === "video" && meta.has_audio !== false);

    let directUrl = "";
    let copyUrl = "";
    let routes: string[] = [];
    if (isDashMux && dashMux) {
      // Do NOT expose a broken video-only .m4s URL as directUrl
      directUrl = "";
      copyUrl = "";
      routes = dashMux.videoRoutes;
    } else if (target.kind === "file") {
      directUrl = target.url;
      copyUrl =
        target.source.access === "relay"
          ? sourceUrl(target.source, copyCtx)
          : directUrl;
      const tbCandidate =
        isTbvideoVideoItem(item) &&
        target.source.id &&
        item.tbvideo?.sources?.[target.source.id]
          ? item.tbvideo.sources[target.source.id]
          : "";
      routes = Array.from(
        new Set([
          ...target.routes,
          ...(tbCandidate ? [tbCandidate] : []),
        ]),
      );
    } else if (
      variant.delivery.kind === "hls" ||
      variant.delivery.kind === "dash"
    ) {
      routes = deliveryRoutes(variant.delivery.sources, ctx);
      directUrl = routes[0] ?? "";
      copyUrl = deliveryRoutes(variant.delivery.sources, copyCtx)[0] ?? directUrl;
    } else if (variant.delivery.kind === "segments") {
      const firstPiece = variant.delivery.init ?? variant.delivery.pieces[0];
      routes = firstPiece ? deliveryRoutes(firstPiece.sources, ctx) : [];
      directUrl = routes[0] ?? "";
      copyUrl =
        (firstPiece ? deliveryRoutes(firstPiece.sources, copyCtx)[0] : "") ||
        directUrl;
    } else if (variant.delivery.kind === "pair") {
      const motionRes = variant.delivery.resources.find(
        (r) => r.role === "motion" || r.role === "video",
      );
      const motionSrc = motionRes ? resourceSource(motionRes, ctx) : undefined;
      if (motionSrc) {
        try {
          routes = sourceRoutes(motionSrc, ctx);
          directUrl = routes[0] ?? "";
          copyUrl =
            motionSrc.access === "relay"
              ? sourceUrl(motionSrc, copyCtx)
              : directUrl;
        } catch {
          directUrl = "";
          copyUrl = "";
        }
      }
    }

    let deliveryMode: QualityDeliveryMode = "external_only";
    let downloadable = false;
    let externalOnlyReason: string | undefined;

    if (!structurallyDownloadable) {
      deliveryMode = "external_only";
      downloadable = false;
      if (
        (variant.delivery.kind === "hls" ||
          variant.delivery.kind === "dash" ||
          variant.delivery.kind === "mux") &&
        routes.length > 0 &&
        !hasWhitelistedRoute(routes, extraOrigins)
      ) {
        externalOnlyReason = EXTERNAL_ONLY_STREAM_REASON;
      } else if (target.kind === "unsupported" && target.message) {
        externalOnlyReason = target.message;
      }
    } else if (isDashMux && dashMux) {
      const videoOk = hasWhitelistedRoute(dashMux.videoRoutes, extraOrigins);
      const audioOk = hasWhitelistedRoute(dashMux.audioRoutes, extraOrigins);
      if (videoOk && audioOk) {
        deliveryMode = "opfs";
        downloadable = true;
      } else {
        deliveryMode = "external_only";
        downloadable = false;
        externalOnlyReason = EXTERNAL_ONLY_STREAM_REASON;
      }
    } else if (muxPair) {
      let videoOk = false;
      let audioOk = false;
      try {
        videoOk = isWhitelistedMediaUrl(
          sourceUrl(muxPair.videoSource, ctx),
          extraOrigins,
        ).allowed;
        audioOk = isWhitelistedMediaUrl(
          sourceUrl(muxPair.audioSource, ctx),
          extraOrigins,
        ).allowed;
      } catch {
        videoOk = false;
        audioOk = false;
      }
      if (videoOk && audioOk) {
        deliveryMode = "opfs";
        downloadable = true;
      } else {
        deliveryMode = "external_only";
        downloadable = false;
        externalOnlyReason = EXTERNAL_ONLY_STREAM_REASON;
      }
    } else if (target.kind === "file") {
      const classified = classifyDirectFileDeliveryMode(routes, extraOrigins);
      deliveryMode = classified.deliveryMode;
      downloadable = classified.downloadable;
      externalOnlyReason = classified.externalOnlyReason;
    } else if (target.kind === "hls") {
      if (hasWhitelistedRoute(routes, extraOrigins)) {
        deliveryMode = "opfs";
        downloadable = true;
      } else {
        deliveryMode = "external_only";
        downloadable = false;
        externalOnlyReason = EXTERNAL_ONLY_STREAM_REASON;
      }
    } else if (target.kind === "segments" && variant.delivery.kind === "segments") {
      const chunks: Chunk[] = [
        ...(variant.delivery.init ? [variant.delivery.init] : []),
        ...variant.delivery.pieces,
      ];
      const allChunksWhitelisted =
        chunks.length > 0 &&
        chunks.every((chunk) =>
          hasWhitelistedRoute(deliveryRoutes(chunk.sources, ctx), extraOrigins),
        );
      if (allChunksWhitelisted) {
        deliveryMode = "opfs";
        downloadable = true;
      } else {
        deliveryMode = "external_only";
        downloadable = false;
        externalOnlyReason = EXTERNAL_ONLY_STREAM_REASON;
      }
    } else if (target.kind === "pair" && variant.delivery.kind === "pair") {
      const allResourcesWhitelisted =
        variant.delivery.resources.length > 0 &&
        variant.delivery.resources.every((res) => {
          const del = res.delivery;
          if (del.kind === "segments") {
            const chunks: Chunk[] = [
              ...(del.init ? [del.init] : []),
              ...del.pieces,
            ];
            return (
              chunks.length > 0 &&
              chunks.every((chunk) =>
                hasWhitelistedRoute(
                  deliveryRoutes(chunk.sources, ctx),
                  extraOrigins,
                ),
              )
            );
          }
          return hasWhitelistedRoute(
            deliveryRoutes(del.sources, ctx),
            extraOrigins,
          );
        });
      if (allResourcesWhitelisted) {
        deliveryMode = "opfs";
        downloadable = true;
      } else {
        deliveryMode = "external_only";
        downloadable = false;
        externalOnlyReason = EXTERNAL_ONLY_STREAM_REASON;
      }
    }

    const { ext: resolvedExt, formatMime } = resolveVariantExtension({
      variant,
      itemType: item.type,
      primaryUrl: directUrl,
      platform: media.platform,
      hasTbvideo: Boolean(item.tbvideo?.vid),
      muxPair,
      dashMux,
    });

    const rawLabel = variantLabel(variant, "zh-CN");
    const titleLabel = muxPair
      ? stripSilentOnlyNotice(rawLabel) || rawLabel
      : rawLabel;

    let audioBadge: SidePanelAudioBadge | null = null;
    if (isAudioOnly) {
      audioBadge = {
        text: `独立音频 · ${resolvedExt.toUpperCase()}`,
        tone: "track",
      };
    } else if (isDashMux) {
      audioBadge = { text: "DASH 合流", tone: "mux" };
    } else if (muxPair) {
      audioBadge = { text: "4K/高画质自动合流原声", tone: "mux" };
    } else if (item.type === "video") {
      audioBadge =
        meta.has_audio === false
          ? { text: "仅视频无声", tone: "silent" }
          : { text: "音画合一", tone: "audio" };
    }

    let sizeBytes = 0;
    let sizeLabel = "";
    if (isDashMux && dashMux) {
      const { exactBytes, estimatedBytes } = estimateDashMuxByteTotals(
        variant,
        dashMux,
        item.duration_ms,
      );
      if (exactBytes > 0 && estimatedBytes === 0) {
        sizeBytes = exactBytes;
        sizeLabel = formatMediaSize(exactBytes, "zh-CN");
      } else if (estimatedBytes > 0) {
        sizeBytes = estimatedBytes;
        sizeLabel = formatApproxSizeLabel(estimatedBytes);
      } else if (exactBytes > 0) {
        sizeBytes = exactBytes;
        sizeLabel = formatMediaSize(exactBytes, "zh-CN");
      } else {
        sizeLabel = formatMediaSize(0, "zh-CN");
      }
    } else if (muxPair) {
      sizeBytes =
        parsePositiveSafeBytes(resolvedSource?.size_bytes) +
        parsePositiveSafeBytes(muxPair.audioSource.size_bytes);
      sizeLabel = formatYouTubeMuxOptionSize(
        { variant, source: resolvedSource },
        muxPairsByVariantId,
        "zh-CN",
      );
    } else {
      sizeBytes = parsePositiveSafeBytes(resolvedSource?.size_bytes);
      sizeLabel = formatMediaSize(resolvedSource?.size_bytes, "zh-CN");
    }

    const effW = Number(meta.width || videoLeafMeta?.width || 0) || 0;
    const effH = Number(meta.height || videoLeafMeta?.height || 0) || 0;
    const effShortEdge =
      effW > 0 && effH > 0
        ? Math.min(effW, effH)
        : inferEffectiveShortEdge(variant);
    const effPixelArea =
      effW > 0 && effH > 0 ? effW * effH : effShortEdge * effShortEdge;
    const effFps = Number(meta.fps || videoLeafMeta?.fps || 0) || 0;
    const effVideoCodec = String(
      meta.video_codec || videoLeafMeta?.video_codec || "",
    ).trim();

    qualityOptions.push({
      key: `variant:${variant.id}`,
      kind: "variant",
      variant,
      source: resolvedSource,
      downloadTarget: target,
      downloadable,
      deliveryMode,
      ...(externalOnlyReason ? { externalOnlyReason } : {}),
      titleLabel,
      specs: variantSpecifications(variant),
      audioBadge,
      sizeLabel,
      sizeBytes,
      isAudioOnly,
      effectiveHasAudio,
      shortEdge: effShortEdge,
      pixelArea: effPixelArea,
      fps: effFps,
      bitrateBps: Number(
        meta.bitrate_bps ||
          meta.video_bitrate_bps ||
          videoLeafMeta?.video_bitrate_bps ||
          videoLeafMeta?.bitrate_bps ||
          meta.audio_bitrate_bps ||
          0,
      ),
      videoCodec: effVideoCodec,
      muxPair,
      isDashMux,
      dashMux,
      resolvedExt,
      formatMime,
      directUrl,
      copyUrl,
      routes,
    });
  }

  // Surface standalone audio attachments on video/audio items (e.g., Bilibili 30280 AAC M4A, Douyin/Kuaishou BGM, or YouTube audio track)
  const hasVariantAudioOption = qualityOptions.some(
    (opt) => opt.downloadable && opt.isAudioOnly,
  );
  if (item.type === "video" || item.type === "audio") {
    const scopedAudioAttachments = resolveItemScopedAudioAttachments(
      media,
      item,
      ctx,
    );
    for (const att of scopedAudioAttachments) {
      if (
        (att.role === "background_audio" || att.resource?.role === "audio") &&
        att.resource?.delivery?.kind === "file"
      ) {
        // Avoid duplicating an identical YouTube audio source URL already listed in variants
        const avail = availableSources(att.resource.delivery.sources, ctx.now);
        const primarySrc = avail[0];
        if (!primarySrc) continue;
        let attUrl = "";
        let attRoutes: string[] = [];
        try {
          attRoutes = deliveryRoutes(att.resource.delivery.sources, ctx);
          attUrl = attRoutes[0] || sourceUrl(primarySrc, ctx);
        } catch {
          continue;
        }
        if (!attUrl) continue;
        if (
          hasVariantAudioOption &&
          qualityOptions.some((o) => o.directUrl === attUrl)
        ) {
          continue;
        }

        const rawAttTitle = att.title?.trim() || "";
        const attLabel = rawAttTitle
          ? rawAttTitle.startsWith("原声") || rawAttTitle.startsWith("仅音频")
            ? rawAttTitle
            : `原声 · ${rawAttTitle}`
          : "仅音频 (M4A)";

        const syntheticVariant: ReadyVariant = {
          id: `att-${att.id}`,
          state: "ready",
          label: attLabel,
          metadata: att.resource.metadata,
          delivery: att.resource.delivery,
        };
        const syntheticItem: ReadyItem = {
          id: `${item.id}-att-${att.id}`,
          type: "audio",
          title: att.title || media.title,
          variants: [syntheticVariant],
          default: null,
          default_unavailable_reason: "processing_required",
        };
        const attTarget = getDownloadTarget(
          syntheticItem,
          {
            variant_id: syntheticVariant.id,
            ...(primarySrc.id ? { source_id: primarySrc.id } : {}),
          },
          ctx,
        );
        if (attTarget.kind !== "file") continue;

        const { ext: resolvedExt, formatMime } = resolveVariantExtension({
          variant: syntheticVariant,
          itemType: "audio",
          primaryUrl: attUrl,
          platform: media.platform,
        });

        const attExactBytes = parsePositiveSafeBytes(primarySrc.size_bytes);
        const attBitrate = Number(
          att.resource.metadata?.audio_bitrate_bps ||
            att.resource.metadata?.bitrate_bps ||
            0,
        );
        const attDurationMs = Number(
          att.resource.metadata?.duration_ms || item.duration_ms || 0,
        );
        const attEstBytes =
          !attExactBytes && attBitrate > 0 && attDurationMs > 0
            ? Math.round((attBitrate * attDurationMs) / 8000)
            : 0;
        const attSizeLabel =
          attExactBytes > 0
            ? formatMediaSize(attExactBytes, "zh-CN")
            : attEstBytes > 0
              ? formatApproxSizeLabel(attEstBytes)
              : formatMediaSize(0, "zh-CN");

        const attClassified = classifyDirectFileDeliveryMode(
          attRoutes,
          extraOrigins,
        );

        qualityOptions.push({
          key: `attachment:${att.id}`,
          kind: "attachment",
          variant: syntheticVariant,
          attachment: att,
          source: primarySrc,
          downloadTarget: attTarget,
          downloadable: attClassified.downloadable,
          deliveryMode: attClassified.deliveryMode,
          ...(attClassified.externalOnlyReason
            ? { externalOnlyReason: attClassified.externalOnlyReason }
            : {}),
          titleLabel: syntheticVariant.label || "原声音频",
          specs: variantSpecifications(syntheticVariant),
          audioBadge: {
            text: `提取音频 · ${resolvedExt.toUpperCase()}`,
            tone: "track",
          },
          sizeLabel: attSizeLabel,
          sizeBytes: attExactBytes || attEstBytes,
          isAudioOnly: true,
          effectiveHasAudio: true,
          shortEdge: 0,
          pixelArea: 0,
          fps: 0,
          bitrateBps: attBitrate,
          videoCodec: "",
          muxPair: null,
          isDashMux: false,
          dashMux: null,
          resolvedExt,
          formatMime,
          directUrl: attUrl,
          copyUrl:
            primarySrc.access === "relay"
              ? sourceUrl(primarySrc, copyCtx)
              : attUrl,
          routes: attRoutes,
        });
      }
    }
  }

  return sortVariantsCanonical(qualityOptions, (opt, originalIndex) =>
    buildCanonicalVariantDescriptor({
      variant: opt.variant,
      downloadable: opt.downloadable && opt.deliveryMode !== "external_only",
      isAudioOnly: opt.isAudioOnly,
      effectiveHasAudio: opt.effectiveHasAudio,
      sizeBytes: opt.sizeBytes,
      originalIndex,
    }),
  );
}

function compareVideoQualityDesc(
  a: SidePanelQualityOption,
  b: SidePanelQualityOption,
  defaultVariantId?: string,
): number {
  const cmp = compareCanonicalVariantDesc(
    buildCanonicalVariantDescriptor({
      variant: a.variant,
      downloadable: a.downloadable && a.deliveryMode !== "external_only",
      isAudioOnly: a.isAudioOnly,
      effectiveHasAudio: a.effectiveHasAudio,
      sizeBytes: a.sizeBytes,
      originalIndex: 0,
    }),
    buildCanonicalVariantDescriptor({
      variant: b.variant,
      downloadable: b.downloadable && b.deliveryMode !== "external_only",
      isAudioOnly: b.isAudioOnly,
      effectiveHasAudio: b.effectiveHasAudio,
      sizeBytes: b.sizeBytes,
      originalIndex: 0,
    }),
  );
  if (cmp !== 0) return cmp;
  const aMp4 = a.resolvedExt === "mp4" ? 1 : 0;
  const bMp4 = b.resolvedExt === "mp4" ? 1 : 0;
  if (aMp4 !== bMp4) {
    return bMp4 - aMp4;
  }
  if (defaultVariantId) {
    const aDef = a.variant.id === defaultVariantId ? 1 : 0;
    const bDef = b.variant.id === defaultVariantId ? 1 : 0;
    if (aDef !== bDef) return bDef - aDef;
  }
  return 0;
}

export function selectPreferredQualityOption(
  options: SidePanelQualityOption[],
  item: MediaItem | null | undefined,
  preference: QualityPreference,
  media?: UnifiedMedia | null,
  apiOrigin?: string,
): SidePanelQualityOption | null {
  const downloadable = options.filter(
    (opt) => opt.downloadable && opt.deliveryMode !== "external_only",
  );
  if (!downloadable.length) return options[0] ?? null;

  const defaultVariantId =
    item && readyItem(item) ? item.default?.variant_id : undefined;
  const defaultOption =
    (defaultVariantId
      ? downloadable.find(
          (opt) =>
            opt.kind === "variant" && opt.variant.id === defaultVariantId,
        )
      : undefined) ?? null;

  if (preference === "audio") {
    if (media?.platform === "youtube" && item) {
      const ytAudio = findBestStandaloneAudioForYouTube(
        item,
        media.attachments ?? [],
        apiOrigin || PROD_API_ORIGIN,
      );
      if (ytAudio) {
        const matched = downloadable.find(
          (opt) =>
            opt.isAudioOnly &&
            (opt.variant.id === ytAudio.variantId ||
              opt.directUrl === ytAudio.url),
        );
        if (matched) return matched;
      }
    }

    const audioCandidates = downloadable
      .filter((opt) => opt.isAudioOnly)
      .sort((a, b) => {
        const extRank = (ext: string) =>
          ext === "m4a" ? 3 : ext === "mp3" ? 2 : ext === "webm" ? 1 : 0;
        const rDiff = extRank(b.resolvedExt) - extRank(a.resolvedExt);
        if (rDiff !== 0) return rDiff;
        if (b.bitrateBps !== a.bitrateBps) return b.bitrateBps - a.bitrateBps;
        return b.sizeBytes - a.sizeBytes;
      });

    if (audioCandidates.length > 0) {
      return audioCandidates[0];
    }
    return defaultOption ?? downloadable[0];
  }

  const nonAudioOptions = downloadable.filter((opt) => !opt.isAudioOnly);
  const pool = nonAudioOptions.length > 0 ? nonAudioOptions : downloadable;

  if (preference === "1080p") {
    const within1080 = pool
      .filter((opt) => opt.shortEdge > 0 && opt.shortEdge <= 1088)
      .sort((a, b) => compareVideoQualityDesc(a, b, defaultVariantId));
    if (within1080.length > 0) {
      return within1080[0];
    }
    if (defaultOption && !defaultOption.isAudioOnly) {
      return defaultOption;
    }
    // Fallback to lowest resolution above 1080p if all variants are >1080p, else highest
    const above1080 = pool
      .filter((opt) => opt.shortEdge > 1088)
      .sort((a, b) => a.shortEdge - b.shortEdge);
    return above1080[0] ?? pool[0];
  }

  // preference === "best"
  const sortedBest = [...pool].sort((a, b) =>
    compareVideoQualityDesc(a, b, defaultVariantId),
  );
  return sortedBest[0] ?? defaultOption ?? downloadable[0];
}

export function buildPrimarySingleCtaLabel(params: {
  item: MediaItem | null | undefined;
  option: SidePanelQualityOption | null | undefined;
}): string {
  const { item, option } = params;
  if (!item || !option || !option.downloadable) {
    return option?.deliveryMode === "external_only"
      ? "非白名单流（请复制直链或打开原帖）"
      : "暂无可用下载源";
  }
  const extUpper = (option.resolvedExt || "mp4").toUpperCase();

  if (option.isAudioOnly || item.type === "audio") {
    const fmt =
      resolveYouTubeAudioFormatLabel(option.variant) || extUpper || "M4A";
    return `下载音频 (${fmt})`;
  }

  if (item.type === "image") {
    return `下载原图 (${extUpper})`;
  }

  if (item.type === "live_photo") {
    return "下载实况照片";
  }

  const tier = resolveYouTubeDownloadTier(option.variant);
  const fpsSuffix =
    option.fps >= 50 ? `${Math.round(option.fps)}` : "";
  const tierWithFps =
    tier && fpsSuffix && !tier.endsWith(fpsSuffix)
      ? `${tier}${fpsSuffix}`
      : tier || option.titleLabel;

  const qualityTag =
    option.isDashMux && option.titleLabel && /1080p\+/i.test(option.titleLabel)
      ? option.titleLabel
      : tierWithFps;

  return qualityTag && qualityTag !== "画质未知"
    ? `下载视频 (${qualityTag})`
    : `下载视频 (${extUpper})`;
}

export function buildBatchPrimaryCtaLabel(params: {
  checkedCount: number;
  checkableTotalCount: number;
  preparing?: { current: number; total: number } | null;
}): string {
  if (params.preparing) {
    return `正在解析分P (${params.preparing.current}/${params.preparing.total})...`;
  }
  const selected = Math.max(0, Math.floor(params.checkedCount));
  const total = Math.max(0, Math.floor(params.checkableTotalCount));
  if (total > 0 && selected >= total) {
    return `下载全部 (${total})`;
  }
  return `下载已选 (${selected}/${total})`;
}

// ============================================================================
// Media Layout Classification & Enqueue Builders (Subfolder & Batch ZIP)
// ============================================================================

const TASK_STATUS_PROGRESSION: Readonly<
  Record<ExtensionDownloadTask["status"], number>
> = {
  queued: 0,
  parsing: 1,
  downloading: 2,
  muxing: 3,
  saving: 4,
  completed: 5,
  failed: 5,
  cancelled: 5,
};

function pickFresherTask(
  existingTask: ExtensionDownloadTask,
  addedTask: ExtensionDownloadTask,
): ExtensionDownloadTask {
  if (existingTask.updatedAt !== addedTask.updatedAt) {
    return existingTask.updatedAt > addedTask.updatedAt
      ? { ...existingTask }
      : { ...addedTask };
  }
  const existingRank = TASK_STATUS_PROGRESSION[existingTask.status] ?? 0;
  const addedRank = TASK_STATUS_PROGRESSION[addedTask.status] ?? 0;
  if (existingRank !== addedRank) {
    return existingRank > addedRank ? { ...existingTask } : { ...addedTask };
  }
  if (existingTask.loaded !== addedTask.loaded) {
    return existingTask.loaded > addedTask.loaded
      ? { ...existingTask }
      : { ...addedTask };
  }
  return { ...existingTask };
}

/**
 * Merges newly enqueued tasks returned by `ENQUEUE_DOWNLOADS` / `ENQUEUE_BATCH_URLS`
 * with the SidePanel's existing task list without clobbering active/completed tasks
 * or regressing tasks that already received a fresher `Port` `TASKS_UPDATED` broadcast.
 */
export function mergeEnqueuedTasks(
  existing: ExtensionDownloadTask[],
  added: ExtensionDownloadTask[],
): ExtensionDownloadTask[] {
  if (!Array.isArray(added) || added.length === 0) {
    return Array.isArray(existing) ? existing.map((t) => ({ ...t })) : [];
  }
  if (!Array.isArray(existing) || existing.length === 0) {
    const deduped: ExtensionDownloadTask[] = [];
    const seen = new Map<string, number>();
    for (const item of added) {
      const idx = seen.get(item.taskId);
      if (idx !== undefined) {
        deduped[idx] = pickFresherTask(deduped[idx], item);
      } else {
        seen.set(item.taskId, deduped.length);
        deduped.push({ ...item });
      }
    }
    return deduped;
  }

  const existingIds = new Set(existing.map((t) => t.taskId));
  const addedById = new Map<string, ExtensionDownloadTask>();
  const prepended: ExtensionDownloadTask[] = [];

  for (const candidate of added) {
    const prevAdded = addedById.get(candidate.taskId);
    if (prevAdded) {
      const fresher = pickFresherTask(prevAdded, candidate);
      addedById.set(candidate.taskId, fresher);
      const pIdx = prepended.findIndex((p) => p.taskId === candidate.taskId);
      if (pIdx >= 0) {
        prepended[pIdx] = fresher;
      }
      continue;
    }
    addedById.set(candidate.taskId, { ...candidate });
    if (!existingIds.has(candidate.taskId)) {
      prepended.push({ ...candidate });
    }
  }

  const mergedExisting = existing.map((task) => {
    const matchingAdded = addedById.get(task.taskId);
    return matchingAdded ? pickFresherTask(task, matchingAdded) : { ...task };
  });

  return [...prepended, ...mergedExisting];
}

export function classifyMediaLayout(media: UnifiedMedia | null): MediaLayoutKind {
  if (!media || !Array.isArray(media.items) || media.items.length === 0) {
    return "single";
  }
  const albumItems = media.items.filter(
    (it) => it.type === "image" || it.type === "live_photo",
  );
  const videoOrAudioItems = media.items.filter(
    (it) => it.type === "video" || it.type === "audio",
  );
  if (albumItems.length > 0 && videoOrAudioItems.length > 0) {
    return "mixed";
  }
  const hasLivePhoto = albumItems.some((it) => it.type === "live_photo");
  if (albumItems.length > 1 || hasLivePhoto) {
    return "album";
  }
  if (videoOrAudioItems.length > 1 || hasMultiCollectionGroups(media)) {
    return "multi_video";
  }
  return "single";
}

export function resolveWorkBaseTitle(media: UnifiedMedia): string {
  return (
    media.title?.trim() ||
    media.author?.name?.trim() ||
    `${media.platform}_${media.content_id || "media"}`
  );
}

/**
 * Resolves the clean base filename stem for a media item:
 * - Single-video/single-item layout (`classifyMediaLayout(media) === "single"`):
 *   ALWAYS prioritizes `media.title` over single-P `item.title` (preventing raw
 *   upload filenames like `mmexport1794208831102.mp4`), falling back to
 *   `item.title` -> `author.name` -> `platform_contentId`.
 * - Multi-P / multi-item layout: prioritizes distinct `item.title` -> `media.title`
 *   -> `author.name` -> `platform_contentId`.
 */
export function resolveItemBaseName(
  media: UnifiedMedia,
  item?: MediaItem | null,
): string {
  return resolvePreferredMediaTitle({
    isSingleItem: classifyMediaLayout(media) === "single",
    itemCount: media.items.length,
    workTitle: media.title,
    itemTitle: item?.title,
    authorName: media.author?.name,
    fallback: `${media.platform}_${media.content_id?.trim() || "media"}`,
  });
}

export {
  MAX_EXTENSION_ZIP_BYTES,
  extractParseUrlFromRefreshUrl,
  buildRefreshContextForOption,
  buildRefreshContextForResource,
  buildSpecFromOption,
  buildSingleDownloadEnqueueItem,
  buildChecklistSubfolderEnqueueItems,
  buildChecklistZipEnqueueItem,
  buildChecklistMultiPartRequest,
  type ChecklistItemSelectionEntry,
} from "./targetSpecBuilder";
