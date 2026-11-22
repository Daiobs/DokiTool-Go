import {
  parsePositiveSafeBytes,
  resolveVariantDimensions,
  resolveYouTubeAudioFormatLabel,
  resolveYouTubeDownloadTier,
  stripSilentOnlyNotice,
} from "../components/result/resultI18n";
import { formatYouTubeMuxOptionSize } from "../components/result/resultPresentation";
import { confirmedFormatMime, extensionsFor } from "../downloads/file";
import type {
  Attachment,
  Chunk,
  LeafDelivery,
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
import { buildSafeDownloadPath } from "./filenameSanitizer";
import {
  PROD_API_ORIGIN,
  validateApiBaseUrl,
  type ApiBaseUrlValidationResult,
} from "./hostWhitelist";
import {
  SIDEPANEL_PORT_NAME,
  errRpc,
  isBackgroundBroadcast,
  type BackgroundToSidePanelBroadcast,
  type EnqueueDownloadItem,
  type ExtensionDownloadTask,
  type ExtensionRpcResponse,
  type ExtensionSettings,
  type ExtensionThemeMode,
  type OffscreenDashMuxSpec,
  type OffscreenDownloadSpec,
  type OffscreenSegmentSpec,
  type OffscreenZipEntrySpec,
  type QualityPreference,
  type SidePanelResponseMap,
  type SidePanelToBackgroundRequest,
} from "./protocol";
import { normalizeExtensionThemeMode } from "./storage";
import { PLATFORM_DOMAIN_SPECS } from "./urlMatcher";

export const MAX_EXTENSION_ZIP_BYTES = 500 * 1024 * 1024;
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

interface ChromeTabsLike {
  create?: (createProperties: { url: string; active?: boolean }) => Promise<unknown> | void;
}

function getChromeNamespace(): {
  runtime?: ChromeRuntimeLike;
  permissions?: ChromePermissionsLike;
  tabs?: ChromeTabsLike;
} {
  const g = globalThis as unknown as {
    chrome?: {
      runtime?: ChromeRuntimeLike;
      permissions?: ChromePermissionsLike;
      tabs?: ChromeTabsLike;
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

export function formatPlatformDisplayName(platform?: string): string {
  if (!platform) return "未知平台";
  const key = platform.trim().toLowerCase();
  return PLATFORM_LABEL_MAP.get(key) || platform;
}

export function resolveSafeApiOrigin(rawApiBaseUrl?: string): string {
  const check = validateApiBaseUrl(rawApiBaseUrl || PROD_API_ORIGIN);
  return check.ok ? check.origin : PROD_API_ORIGIN;
}

export function buildExtraAllowedOrigins(apiOrigin: string): string[] | undefined {
  return apiOrigin && apiOrigin !== PROD_API_ORIGIN ? [apiOrigin] : undefined;
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

export interface SidePanelQualityOption {
  key: string;
  kind: "variant" | "attachment";
  variant: ReadyVariant;
  attachment?: Attachment;
  source: Source | null;
  downloadTarget: DownloadTarget;
  downloadable: boolean;
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

function extractUiDashMuxSpec(
  variant: ReadyVariant,
  ctx: { apiOrigin: string },
): OffscreenDashMuxSpec | null {
  if (variant.delivery.kind !== "mux") return null;
  const container = (
    variant.delivery.output?.container ||
    variant.delivery.output?.extension ||
    variant.metadata?.container ||
    variant.metadata?.extension ||
    "mp4"
  )
    .trim()
    .toLowerCase();
  if (container !== "mp4") return null;

  const videoResources = variant.delivery.resources.filter(
    (r) => r.role === "video",
  );
  const audioResources = variant.delivery.resources.filter(
    (r) => r.role === "audio",
  );
  if (videoResources.length !== 1 || audioResources.length !== 1) return null;
  const videoRes = videoResources[0];
  const audioRes = audioResources[0];
  if (
    videoRes.delivery.kind !== "file" ||
    audioRes.delivery.kind !== "file"
  ) {
    return null;
  }

  const availVideo = availableSources(videoRes.delivery.sources);
  const availAudio = availableSources(audioRes.delivery.sources);
  if (!availVideo.length || !availAudio.length) return null;

  let videoRoutes: string[];
  let audioRoutes: string[];
  try {
    videoRoutes = deliveryRoutes(availVideo, ctx);
    audioRoutes = deliveryRoutes(availAudio, ctx);
  } catch {
    return null;
  }
  if (!videoRoutes.length || !audioRoutes.length) return null;

  const videoSize = parsePositiveSafeBytes(availVideo[0]?.size_bytes);
  const audioSize = parsePositiveSafeBytes(availAudio[0]?.size_bytes);
  return {
    videoRoutes,
    audioRoutes,
    ...(videoSize > 0 ? { videoSize } : {}),
    ...(audioSize > 0 ? { audioSize } : {}),
    outputContainer: "mp4",
  };
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
      if (["webm", "mov", "mkv", "m4a", "mp3", "jpg", "jpeg", "png", "webp", "gif", "avif"].includes(ext)) {
        return ext === "jpeg" ? "jpg" : ext;
      }
    }
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith(".toutiaovod.com")) return "mp4";
    if (
      hasTbvideo ||
      platform === "zuiyou" ||
      platform === "pipigx"
    ) {
      return "mp4";
    }
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

function isStandaloneAudioMetadata(
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
      ext === "opus")
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
  const ctx = { apiOrigin: resolveSafeApiOrigin(apiOrigin) };
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

export function buildSidePanelQualityOptions(
  media: UnifiedMedia,
  item: MediaItem | null | undefined,
  rawApiOrigin: string,
): SidePanelQualityOption[] {
  if (!item || !readyItem(item)) return [];
  const apiOrigin = resolveSafeApiOrigin(rawApiOrigin);
  const ctx = { apiOrigin };
  const attachments = media.attachments ?? [];
  const isYouTube = media.platform === "youtube";

  const muxPairsByVariantId = new Map<string, ExtractedYouTubeMuxPair>();
  if (isYouTube && item.type === "video") {
    for (const v of item.variants) {
      if (readyVariant(v) && v.metadata?.has_audio === false) {
        const pair = selectYouTubeMuxPair(v, item.variants, attachments);
        if (pair.ok) {
          muxPairsByVariantId.set(v.id, pair);
        }
      }
    }
  }

  const options: SidePanelQualityOption[] = [];

  for (const variant of item.variants) {
    if (!readyVariant(variant)) continue;
    const primarySource =
      variant.delivery.kind === "file"
        ? availableSources(variant.delivery.sources)[0] ??
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
    const dashMux = extractUiDashMuxSpec(variant, ctx);
    const isDashMux = Boolean(dashMux);
    const downloadable =
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
    let routes: string[] = [];
    if (isDashMux && dashMux) {
      // Do NOT expose a broken video-only .m4s URL as directUrl
      directUrl = "";
      routes = dashMux.videoRoutes;
    } else if (target.kind === "file") {
      directUrl = target.url;
      const tbCandidate =
        item.type === "video" &&
        (media.platform === "pipigx" || media.platform === "zuiyou") &&
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
      variant.delivery.kind === "hls" &&
      variant.delivery.scope === "single"
    ) {
      routes = deliveryRoutes(variant.delivery.sources, ctx);
      directUrl = routes[0] ?? "";
    } else if (variant.delivery.kind === "segments") {
      const firstPiece = variant.delivery.init ?? variant.delivery.pieces[0];
      routes = firstPiece ? deliveryRoutes(firstPiece.sources, ctx) : [];
      directUrl = routes[0] ?? "";
    } else if (variant.delivery.kind === "pair") {
      const motionRes = variant.delivery.resources.find(
        (r) => r.role === "motion" || r.role === "video",
      );
      const motionSrc = motionRes ? resourceSource(motionRes, ctx) : undefined;
      if (motionSrc) {
        try {
          routes = sourceRoutes(motionSrc, ctx);
          directUrl = routes[0] ?? "";
        } catch {
          directUrl = "";
        }
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
      sizeLabel = isYouTube
        ? formatYouTubeMuxOptionSize(
            { variant, source: resolvedSource },
            muxPairsByVariantId,
            "zh-CN",
          )
        : formatMediaSize(sizeBytes, "zh-CN");
    } else {
      sizeBytes = parsePositiveSafeBytes(resolvedSource?.size_bytes);
      sizeLabel = isYouTube
        ? formatYouTubeMuxOptionSize(
            { variant, source: resolvedSource },
            muxPairsByVariantId,
            "zh-CN",
          )
        : formatMediaSize(resolvedSource?.size_bytes, "zh-CN");
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

    options.push({
      key: `variant:${variant.id}`,
      kind: "variant",
      variant,
      source: resolvedSource,
      downloadTarget: target,
      downloadable,
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
      routes,
    });
  }

  // Surface standalone audio attachments on video/audio items (e.g., Bilibili 30280 AAC M4A, Douyin/Kuaishou BGM, or YouTube audio track)
  const hasVariantAudioOption = options.some(
    (opt) => opt.downloadable && opt.isAudioOnly,
  );
  if (item.type === "video" || item.type === "audio") {
    for (const att of attachments) {
      if (
        (att.role === "background_audio" || att.resource?.role === "audio") &&
        att.resource?.delivery?.kind === "file"
      ) {
        // Avoid duplicating an identical YouTube audio source URL already listed in variants
        const avail = availableSources(att.resource.delivery.sources);
        const primarySrc = avail[0] ?? att.resource.delivery.sources[0];
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
        if (hasVariantAudioOption && options.some((o) => o.directUrl === attUrl)) {
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

        options.push({
          key: `attachment:${att.id}`,
          kind: "attachment",
          variant: syntheticVariant,
          attachment: att,
          source: primarySrc,
          downloadTarget: attTarget,
          downloadable: true,
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
          routes: attRoutes,
        });
      }
    }
  }

  return options;
}

function compareVideoQualityDesc(
  a: SidePanelQualityOption,
  b: SidePanelQualityOption,
  defaultVariantId?: string,
): number {
  if (a.effectiveHasAudio !== b.effectiveHasAudio) {
    return a.effectiveHasAudio ? -1 : 1;
  }
  if (a.shortEdge !== b.shortEdge) {
    return b.shortEdge - a.shortEdge;
  }
  if (a.pixelArea !== b.pixelArea) {
    return b.pixelArea - a.pixelArea;
  }
  if (a.fps !== b.fps) {
    return b.fps - a.fps;
  }
  // Prefer MP4 container on identical resolution & FPS for maximum player compatibility
  const aMp4 = a.resolvedExt === "mp4" ? 1 : 0;
  const bMp4 = b.resolvedExt === "mp4" ? 1 : 0;
  if (aMp4 !== bMp4) {
    return bMp4 - aMp4;
  }
  // Prefer H.264 (AVC) > HEVC > AV1 > other codecs at identical resolution, FPS & container
  const aCodecRank = uiVideoCodecPreferenceRank(a.videoCodec);
  const bCodecRank = uiVideoCodecPreferenceRank(b.videoCodec);
  if (aCodecRank !== bCodecRank) {
    return bCodecRank - aCodecRank;
  }
  if (a.bitrateBps !== b.bitrateBps) {
    return b.bitrateBps - a.bitrateBps;
  }
  if (a.sizeBytes !== b.sizeBytes) {
    return b.sizeBytes - a.sizeBytes;
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
  const downloadable = options.filter((opt) => opt.downloadable);
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
    return "暂无可用下载源";
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

  if (option.isDashMux) {
    const labelTier =
      option.titleLabel && /1080p\+/i.test(option.titleLabel)
        ? option.titleLabel
        : tierWithFps;
    return labelTier && labelTier !== "画质未知"
      ? `下载 ${labelTier} 无损合流 (${extUpper})`
      : `下载无损合流 (${extUpper})`;
  }

  if (option.muxPair || option.effectiveHasAudio) {
    return tierWithFps && tierWithFps !== "画质未知"
      ? `下载 ${tierWithFps} 有声视频 (${extUpper})`
      : `下载有声视频 (${extUpper})`;
  }
  return tierWithFps && tierWithFps !== "画质未知"
    ? `下载 ${tierWithFps} 视频 (${extUpper})`
    : `下载视频 (${extUpper})`;
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
  const nonAlbumGroups = (media.groups ?? []).filter((g) => g.kind !== "album");
  if (videoOrAudioItems.length > 1 || nonAlbumGroups.length > 0) {
    return "multi_video";
  }
  return "single";
}

function resolveWorkBaseTitle(media: UnifiedMedia): string {
  return (
    media.title?.trim() ||
    media.author?.name?.trim() ||
    `${media.platform}_${media.content_id || "media"}`
  );
}

function buildSegmentsSpecFromDelivery(
  delivery: Extract<LeafDelivery, { kind: "segments" }>,
  apiOrigin: string,
): OffscreenSegmentSpec[] {
  const ctx = { apiOrigin };
  const chunks: Chunk[] = [
    ...(delivery.init ? [delivery.init] : []),
    ...delivery.pieces,
  ];
  return chunks.map((chunk) => {
    const routes = deliveryRoutes(chunk.sources, ctx);
    if (!routes.length) {
      throw new Error("分段媒体缺少可用下载线路");
    }
    return {
      url: routes[0],
      ...(routes.length > 1 ? { routes } : {}),
      ...(chunk.byte_range
        ? {
            start: chunk.byte_range.start,
            length: chunk.byte_range.end_inclusive - chunk.byte_range.start + 1,
          }
        : {}),
    };
  });
}

export function buildSpecFromOption(params: {
  media: UnifiedMedia;
  option: SidePanelQualityOption;
  filename: string;
  apiOrigin: string;
}): OffscreenDownloadSpec {
  const { media, option, filename } = params;
  const apiOrigin = resolveSafeApiOrigin(params.apiOrigin);
  const extraAllowedOrigins = buildExtraAllowedOrigins(apiOrigin);

  if (option.muxPair) {
    const videoUrl = sourceUrl(option.muxPair.videoSource, { apiOrigin });
    const audioUrl = sourceUrl(option.muxPair.audioSource, { apiOrigin });
    const totalSize =
      parsePositiveSafeBytes(option.muxPair.videoSource.size_bytes) +
      parsePositiveSafeBytes(option.muxPair.audioSource.size_bytes);
    return {
      kind: "youtube_mux",
      apiOrigin,
      routes: [videoUrl],
      filename,
      mimeType: option.muxPair.outputMimeType,
      ...(totalSize > 0 ? { sizeBytes: totalSize } : {}),
      ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
      youtubeMux: {
        videoUrl,
        audioUrl,
        ...(option.muxPair.videoSource.size_bytes
          ? { videoSize: option.muxPair.videoSource.size_bytes }
          : {}),
        ...(option.muxPair.audioSource.size_bytes
          ? { audioSize: option.muxPair.audioSource.size_bytes }
          : {}),
        outputContainer: option.muxPair.outputContainer,
      },
    };
  }

  if (option.dashMux) {
    const exactDashBytes =
      parsePositiveSafeBytes(option.dashMux.videoSize) +
      parsePositiveSafeBytes(option.dashMux.audioSize);
    return {
      kind: "dash_mux",
      apiOrigin,
      routes: option.dashMux.videoRoutes,
      filename,
      mimeType: "video/mp4",
      ...(exactDashBytes > 0 ? { sizeBytes: exactDashBytes } : {}),
      ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
      dashMux: option.dashMux,
    };
  }

  const delivery = option.variant.delivery;

  if (delivery.kind === "hls") {
    const routes = deliveryRoutes(delivery.sources, { apiOrigin });
    if (!routes.length) throw new Error("HLS 清单缺少可用来源");
    return {
      kind: "hls",
      apiOrigin,
      routes,
      filename,
      ...(option.formatMime ? { mimeType: option.formatMime } : {}),
      ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
    };
  }

  if (delivery.kind === "segments") {
    const segments = buildSegmentsSpecFromDelivery(delivery, apiOrigin);
    const firstRoutes =
      segments[0]?.routes ?? (segments[0]?.url ? [segments[0].url] : []);
    return {
      kind: "segments",
      apiOrigin,
      routes: firstRoutes,
      filename,
      segments,
      ...(option.formatMime ? { mimeType: option.formatMime } : {}),
      ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
    };
  }

  if (!option.routes.length) {
    throw new Error("所选画质当前无可用下载线路");
  }

  const isYouTubeDirect =
    media.platform === "youtube" &&
    isValidGooglevideoPlaybackUrl(option.routes[0]);

  return {
    kind: isYouTubeDirect ? "youtube_direct" : "direct_file",
    apiOrigin,
    routes: option.routes,
    filename,
    ...(option.formatMime ? { mimeType: option.formatMime } : {}),
    ...(option.sizeBytes > 0 ? { sizeBytes: option.sizeBytes } : {}),
    ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
  };
}

export function buildSingleDownloadEnqueueItem(params: {
  media: UnifiedMedia;
  item: MediaItem;
  option: SidePanelQualityOption;
  settings: ExtensionSettings;
  workFingerprint?: string;
}): EnqueueDownloadItem {
  const { media, item, option, settings, workFingerprint } = params;
  const apiOrigin = resolveSafeApiOrigin(settings.apiBaseUrl);
  const workTitle = resolveWorkBaseTitle(media);
  const stem =
    option.kind === "attachment" && option.attachment?.title?.trim()
      ? `${workTitle}_${option.attachment.title.trim()}`
      : item.title?.trim() || workTitle;

  const filename = buildSafeDownloadPath({
    prefix: settings.subfolderPrefix,
    stem,
    ext: option.resolvedExt,
  });

  const spec = buildSpecFromOption({
    media,
    option,
    filename,
    apiOrigin,
  });

  return {
    title: stem,
    platform: media.platform,
    ...(workFingerprint ? { workFingerprint } : {}),
    fallbackUrl: option.directUrl || media.source_url,
    spec,
  };
}

function buildLeafResourceSpec(params: {
  media: UnifiedMedia;
  resource: Resource;
  filename: string;
  apiOrigin: string;
}): { spec: OffscreenDownloadSpec; ext: string; primaryUrl: string; sizeBytes?: number } {
  const { media, resource, filename } = params;
  const apiOrigin = resolveSafeApiOrigin(params.apiOrigin);
  const ctx = { apiOrigin };
  const extraAllowedOrigins = buildExtraAllowedOrigins(apiOrigin);
  const delivery = resource.delivery;

  if (delivery.kind === "file") {
    const avail = availableSources(delivery.sources);
    const src = avail[0] ?? delivery.sources[0];
    if (!src) throw new Error("实况资源缺少可用来源");
    const routes = deliveryRoutes(avail.length ? avail : delivery.sources, ctx);
    const primaryUrl = routes[0] || sourceUrl(src, ctx);
    const ext = resolveVariantExtension({
      variant: {
        id: resource.id,
        state: "ready",
        metadata: resource.metadata,
        delivery,
      },
      itemType: resource.role === "image" ? "image" : "video",
      primaryUrl,
      platform: media.platform,
    }).ext;
    return {
      ext,
      primaryUrl,
      sizeBytes: src.size_bytes,
      spec: {
        kind: "direct_file",
        apiOrigin,
        routes,
        filename,
        ...(confirmedFormatMime(resource.metadata)
          ? { mimeType: confirmedFormatMime(resource.metadata) }
          : {}),
        ...(src.size_bytes ? { sizeBytes: src.size_bytes } : {}),
        ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
      },
    };
  }

  if (delivery.kind === "hls") {
    const routes = deliveryRoutes(delivery.sources, ctx);
    if (!routes.length) throw new Error("实况 HLS 缺少可用来源");
    const ext = mediaExtension(resource.metadata, delivery);
    return {
      ext: ext === "bin" ? "mp4" : ext,
      primaryUrl: routes[0],
      spec: {
        kind: "hls",
        apiOrigin,
        routes,
        filename,
        ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
      },
    };
  }

  if (delivery.kind !== "segments") {
    throw new Error("该资源需要 DASH 处理能力，当前暂不支持");
  }

  const segments = buildSegmentsSpecFromDelivery(delivery, apiOrigin);
  const firstRoutes =
    segments[0]?.routes ?? (segments[0]?.url ? [segments[0].url] : []);
  const ext = mediaExtension(resource.metadata, delivery);
  return {
    ext: ext === "bin" ? "mp4" : ext,
    primaryUrl: firstRoutes[0] ?? "",
    spec: {
      kind: "segments",
      apiOrigin,
      routes: firstRoutes,
      filename,
      segments,
      ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
    },
  };
}

export interface ChecklistItemSelectionEntry {
  item: MediaItem;
  /** 1-based display index in the full album/episode list so numbering matches user expectation (`001`, `003`, ...). */
  ordinalIndex: number;
  /** Optional explicit option override (e.g. if user chose a specific variant on the active episode). */
  explicitOption?: SidePanelQualityOption | null;
}

export function buildChecklistSubfolderEnqueueItems(params: {
  media: UnifiedMedia;
  entries: ChecklistItemSelectionEntry[];
  totalCount: number;
  settings: ExtensionSettings;
  livePhotoFilter: LivePhotoSaveFilter;
  workFingerprint?: string;
}): EnqueueDownloadItem[] {
  const {
    media,
    entries,
    totalCount,
    settings,
    livePhotoFilter,
    workFingerprint,
  } = params;
  const apiOrigin = resolveSafeApiOrigin(settings.apiBaseUrl);
  const subfolder = resolveWorkBaseTitle(media);
  const out: EnqueueDownloadItem[] = [];

  for (const { item, ordinalIndex, explicitOption } of entries) {
    if (!readyItem(item)) continue;

    if (item.type === "live_photo") {
      const pairVariant = item.variants.find(
        (v): v is ReadyVariant => readyVariant(v) && v.delivery.kind === "pair",
      );
      if (pairVariant && pairVariant.delivery.kind === "pair") {
        const motionRes = pairVariant.delivery.resources.find(
          (r) => r.role === "motion" || r.role === "video",
        );
        const imageRes = pairVariant.delivery.resources.find(
          (r) => r.role === "image",
        );

        if (
          (livePhotoFilter === "both" ||
            livePhotoFilter === "motion" ||
            livePhotoFilter === "video") &&
          motionRes
        ) {
          const probe = buildLeafResourceSpec({
            media,
            resource: motionRes,
            filename: "probe.mp4",
            apiOrigin,
          });
          const motionFilename = buildSafeDownloadPath({
            prefix: settings.subfolderPrefix,
            subfolder,
            index: ordinalIndex,
            totalCount,
            stem: livePhotoFilter === "both" ? "live" : undefined,
            ext: probe.ext,
          });
          out.push({
            title: `${subfolder} #${ordinalIndex} (实况视频)`,
            platform: media.platform,
            ...(workFingerprint ? { workFingerprint } : {}),
            fallbackUrl: probe.primaryUrl || media.source_url,
            spec: { ...probe.spec, filename: motionFilename },
          });
        }

        if (
          (livePhotoFilter === "both" || livePhotoFilter === "image") &&
          imageRes
        ) {
          const probe = buildLeafResourceSpec({
            media,
            resource: imageRes,
            filename: "probe.jpg",
            apiOrigin,
          });
          const imageFilename = buildSafeDownloadPath({
            prefix: settings.subfolderPrefix,
            subfolder,
            index: ordinalIndex,
            totalCount,
            stem: livePhotoFilter === "both" ? "cover" : undefined,
            ext: probe.ext,
          });
          out.push({
            title: `${subfolder} #${ordinalIndex} (实况封面)`,
            platform: media.platform,
            ...(workFingerprint ? { workFingerprint } : {}),
            fallbackUrl: probe.primaryUrl || media.source_url,
            spec: { ...probe.spec, filename: imageFilename },
          });
        }
        continue;
      }
    }

    const itemOptions = buildSidePanelQualityOptions(media, item, apiOrigin);
    const chosen =
      (explicitOption && explicitOption.downloadable ? explicitOption : null) ??
      selectPreferredQualityOption(
        itemOptions,
        item,
        settings.qualityPreference,
        media,
        apiOrigin,
      );
    if (!chosen || !chosen.downloadable) continue;

    // Images use clean `001.jpg` numbering; multi-P episodes include clean episode title `001_第一集.mp4`
    const episodeStem =
      item.type === "image"
        ? undefined
        : item.title?.trim() && item.title.trim() !== subfolder
          ? item.title.trim()
          : undefined;

    const filename = buildSafeDownloadPath({
      prefix: settings.subfolderPrefix,
      subfolder,
      index: ordinalIndex,
      totalCount,
      stem: episodeStem,
      ext: chosen.resolvedExt,
    });

    const spec = buildSpecFromOption({
      media,
      option: chosen,
      filename,
      apiOrigin,
    });

    out.push({
      title: episodeStem ? `${subfolder} - ${episodeStem}` : `${subfolder} #${ordinalIndex}`,
      platform: media.platform,
      ...(workFingerprint ? { workFingerprint } : {}),
      fallbackUrl: chosen.directUrl || media.source_url,
      spec,
    });
  }

  return out;
}

export function buildChecklistZipEnqueueItem(params: {
  media: UnifiedMedia;
  entries: ChecklistItemSelectionEntry[];
  totalCount: number;
  settings: ExtensionSettings;
  livePhotoFilter: LivePhotoSaveFilter;
  workFingerprint?: string;
}): { ok: true; item: EnqueueDownloadItem } | { ok: false; reason: string } {
  const { media, entries, totalCount, settings, livePhotoFilter, workFingerprint } =
    params;

  if (
    (media.platform === "pipigx" || media.platform === "zuiyou") &&
    entries.some((e) => e.item.type === "video")
  ) {
    return {
      ok: false,
      reason: "该平台视频不支持内存打包 ZIP，请使用「按标题存子文件夹」直接落盘",
    };
  }

  const subfolderItems = buildChecklistSubfolderEnqueueItems({
    media,
    entries,
    totalCount,
    settings: { ...settings, subfolderPrefix: "" },
    livePhotoFilter,
    workFingerprint,
  });

  if (!subfolderItems.length) {
    return { ok: false, reason: "没有可打包的已就绪条目" };
  }

  let knownBytes = 0;
  const zipEntries: OffscreenZipEntrySpec[] = [];

  for (const sub of subfolderItems) {
    if (sub.spec.kind === "youtube_mux") {
      return {
        ok: false,
        reason:
          "YouTube 4K/高画质分离流需使用「按标题存子文件夹」逐集无损合流（零内存上限）",
      };
    }
    if (sub.spec.kind === "dash_mux") {
      return {
        ok: false,
        reason:
          "DASH 音视频分离流需使用「按标题存子文件夹」逐集无损合流（零内存上限）",
      };
    }
    if (sub.spec.kind === "hls") {
      return {
        ok: false,
        reason: "HLS 流媒体分片条目请使用「按标题存子文件夹」流式落盘",
      };
    }
    const size = parsePositiveSafeBytes(sub.spec.sizeBytes);
    knownBytes += size;
    if (knownBytes > MAX_EXTENSION_ZIP_BYTES) {
      return {
        ok: false,
        reason: "已选文件体积超过 500 MB 打包上限，请使用「按标题存子文件夹」（无体积限制）",
      };
    }

    // Strip leading `<SafeTitle>/` so files sit cleanly inside `<SafeTitle>.zip` (or keep flat `001.jpg`)
    const slashIdx = sub.spec.filename.indexOf("/");
    const entryName =
      slashIdx >= 0 ? sub.spec.filename.slice(slashIdx + 1) : sub.spec.filename;

    zipEntries.push({
      entryName,
      routes: sub.spec.routes,
      ...(sub.spec.mimeType ? { mimeType: sub.spec.mimeType } : {}),
      ...(size > 0 ? { sizeBytes: size } : {}),
      ...(sub.spec.segments ? { segments: sub.spec.segments } : {}),
    });
  }

  const apiOrigin = resolveSafeApiOrigin(settings.apiBaseUrl);
  const extraAllowedOrigins = buildExtraAllowedOrigins(apiOrigin);
  const workTitle = resolveWorkBaseTitle(media);
  const zipFilename = buildSafeDownloadPath({
    prefix: settings.subfolderPrefix,
    stem: workTitle,
    ext: "zip",
  });

  return {
    ok: true,
    item: {
      title: `${workTitle} (${zipEntries.length}项打包)`,
      platform: media.platform,
      ...(workFingerprint ? { workFingerprint } : {}),
      fallbackUrl: media.source_url,
      spec: {
        kind: "batch_zip",
        apiOrigin,
        routes: zipEntries[0]?.routes ?? [],
        filename: zipFilename,
        mimeType: "application/zip",
        ...(knownBytes > 0 ? { sizeBytes: knownBytes } : {}),
        ...(extraAllowedOrigins ? { extraAllowedOrigins } : {}),
        zipEntries,
      },
    },
  };
}
