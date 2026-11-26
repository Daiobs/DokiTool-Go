import { supportedPlatforms } from "./platforms";
import { withTbvideoItems } from "../services/tbvideo";
import {
  LATEST_EXTENSION_VERSION,
  MIN_EXTENSION_YOUTUBE_VERSION,
  resolveClientParseRoute,
  type ClientCapabilityEnvironment,
} from "../core/capabilityHub";
import { projectYouTubeCaptionsForFinalize } from "../core/media/subtitleEngine";
import type {
  parseYouTubeViaExtension as parseYouTubeViaExtensionFn,
  pingInstalledExtension,
} from "../services/extensionBridge";
import {
  validateMediaEnvelope,
  readyItem,
  readyVariant,
} from "./mediaContract";
import {
  MIN_YOUTUBE_HELPER_VERSION,
  YOUTUBE_HELPER_SCRIPT_URL,
  requestYouTubePlayerViaHelper,
  requestYouTubePrefetchViaHelper,
  type pingYouTubeHelper,
  type YouTubeHelperContextResponse,
} from "./youtubeHelperCore";
import type {
  MediaItem,
  UnifiedMedia,
  YouTubeHelperState,
} from "../types/media";

const EXTENSION_PARSE_FALLBACK_ERROR_CODES = new Set<string>([
  "NO_CHROME_RUNTIME",
  "BRIDGE_TIMEOUT",
  "EXTENSION_UNAVAILABLE",
  "EMPTY_RESPONSE",
  "BRIDGE_ERROR",
  "UNSUPPORTED_ACTION",
  "FORBIDDEN_ORIGIN",
]);

const ALIAS_PAIRS =
  "douyin:iesdouyin.com bilibili:b23.tv xiaohongshu:xhslink.com,rednote.com toutiao:toutiaoimg.com weibo:weibo.cn pipigx:ippzone.com x:twitter.com,t.co youtube:youtu.be instagram:instagr.am facebook:fb.watch";

export function detectUrlPlatform(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    const matchHost = (d: string) => host === d || host.endsWith(`.${d}`);
    for (const entry of ALIAS_PAIRS.split(" ")) {
      const [id, list] = entry.split(":");
      if (list.split(",").some(matchHost)) return id;
    }
    for (const p of supportedPlatforms.value) {
      const d = new URL(p.site_url)
        .hostname.replace(/^(?:www|h5)\./i, "")
        .toLowerCase();
      if (d && matchHost(d)) return p.id;
    }
  } catch {}
  return null;
}

export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  if ((navigator as any).userAgentData?.mobile === true) return true;
  const ua = navigator.userAgent || "";
  return (
    /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua) ||
    (/Macintosh/i.test(ua) && Number(navigator.maxTouchPoints) > 1)
  );
}

function isGooglevideoUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === "googlevideo.com" || host.endsWith(".googlevideo.com");
  } catch {
    return false;
  }
}

export function redactServerBoundYouTubeMedia(
  data: UnifiedMedia,
  helperState: YouTubeHelperState,
  videoId: string,
): UnifiedMedia {
  const safeBase = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  let counter = 0;
  const nextPlaceholder = (tag: string) =>
    `${safeBase}&helper_required=${encodeURIComponent(tag)}_${++counter}`;

  const items: MediaItem[] = data.items.map((item) => {
    if (!readyItem(item)) return item;
    const variants = item.variants.map((variant) => {
      if (!readyVariant(variant) || variant.delivery.kind !== "file") {
        return variant;
      }
      const sources = variant.delivery.sources.map((source) => {
        const redactedUrl = isGooglevideoUrl(source.url)
          ? nextPlaceholder(source.id || variant.id)
          : source.url;
        const { fallback_urls: _drop, direct_url: _dropDirect, ...rest } = source;
        return {
          ...rest,
          url: redactedUrl,
        };
      });
      return {
        ...variant,
        delivery: {
          ...variant.delivery,
          sources,
        },
      };
    });

    let nextDefault = item.default;
    if (nextDefault) {
      const matchedVariant = variants.find(
        (v) => v.id === nextDefault!.variant_id,
      );
      if (
        readyVariant(matchedVariant) &&
        matchedVariant.delivery.kind === "file"
      ) {
        const matchedSource = nextDefault.source_id
          ? matchedVariant.delivery.sources.find(
              (s) => s.id === nextDefault!.source_id,
            )
          : matchedVariant.delivery.sources[0];
        if (matchedSource) {
          nextDefault = {
            ...nextDefault,
            url: matchedSource.url,
          };
        }
      }
    }

    return {
      ...item,
      variants,
      default: nextDefault,
    };
  });

  const attachments = data.attachments?.map((att) => {
    if (att.resource.delivery.kind !== "file") return att;
    const sources = att.resource.delivery.sources.map((source) => {
      const redactedUrl = isGooglevideoUrl(source.url)
        ? nextPlaceholder(source.id || att.id)
        : source.url;
      const { fallback_urls: _drop, direct_url: _dropDirect, ...rest } = source;
      return {
        ...rest,
        url: redactedUrl,
      };
    });
    return {
      ...att,
      resource: {
        ...att.resource,
        delivery: {
          ...att.resource.delivery,
          sources,
        },
      },
    };
  });

  return {
    ...data,
    items,
    ...(attachments ? { attachments } : {}),
    extra: {
      ...(data.extra || {}),
      youtube_helper: helperState,
    },
  };
}

export function buildFallbackYouTubeMedia(
  videoId: string,
  helperState: YouTubeHelperState,
): UnifiedMedia {
  return {
    platform: "youtube",
    content_id: videoId,
    source_url: `https://www.youtube.com/watch?v=${videoId}`,
    title: `YouTube (${videoId})`,
    items: [
      {
        id: `video-${videoId}`,
        type: "video",
        state: "unavailable",
        default: null,
        default_unavailable_reason: "unavailable",
        error: {
          code:
            helperState.status === "login_required"
              ? "LOGIN_REQUIRED"
              : "HELPER_REQUIRED",
          message:
            helperState.message ||
            "安装 DokiTool Chrome 扩展即可免油猴解析下载 YouTube（Firefox 可使用油猴脚本）",
        },
      },
    ],
    extra: {
      youtube_helper: helperState,
    },
  };
}

const YOUTUBE_CONTEXT_CACHE_SAFETY_MARGIN_MS = 5 * 60_000;
const webYouTubeContextCache = new Map<
  string,
  { data: YouTubeHelperContextResponse; usableUntilMs: number }
>();

export function clearCachedYouTubeContext(baseUrl?: string): void {
  if (typeof baseUrl === "string") {
    webYouTubeContextCache.delete(baseUrl);
    return;
  }
  webYouTubeContextCache.clear();
}

function readCachedWebYouTubeContext(
  baseUrl: string,
  nowMs = Date.now(),
): YouTubeHelperContextResponse | null {
  const hit = webYouTubeContextCache.get(baseUrl);
  if (!hit) return null;
  if (nowMs >= hit.usableUntilMs) {
    webYouTubeContextCache.delete(baseUrl);
    return null;
  }
  return hit.data;
}

function writeCachedWebYouTubeContext(
  baseUrl: string,
  data: YouTubeHelperContextResponse,
  nowMs = Date.now(),
): void {
  const parsedExp = Date.parse(data.expires_at || "");
  if (!Number.isFinite(parsedExp)) return;
  const usableUntilMs = parsedExp - YOUTUBE_CONTEXT_CACHE_SAFETY_MARGIN_MS;
  if (usableUntilMs > nowMs) {
    webYouTubeContextCache.set(baseUrl, { data, usableUntilMs });
  }
}

export function formatYouTubeParseStageText(
  stage: 1 | 2 | 3,
  locale = "zh-CN",
): string {
  const isEn = locale === "en";
  if (stage === 1) {
    return isEn
      ? "Preparing parse context (1/3)…"
      : "正在准备解析上下文 (1/3)…";
  }
  if (stage === 2) {
    return isEn
      ? "Fetching video stream manifest (2/3)…"
      : "正在获取视频流清单 (2/3)…";
  }
  return isEn
    ? "Decrypting high-quality streams (3/3)…"
    : "正在解密高画质签名 (3/3)…";
}

function isPlayerIdExpiredError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { status?: number; code?: string; message?: string };
  if (
    rec.status === 400 &&
    (rec.code === "INVALID_INPUT" || /player_id/i.test(String(rec.message || "")))
  ) {
    return true;
  }
  return /player_id/i.test(String(rec.message || ""));
}

export async function runYouTubeHelperParse(ctx: {
  videoId: string;
  locale: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  pingHelper: typeof pingYouTubeHelper;
  pingExtension?: typeof pingInstalledExtension;
  parseYouTubeViaExtension?: typeof parseYouTubeViaExtensionFn;
  requestStandardParse: () => Promise<UnifiedMedia>;
  fetchJSON: (
    url: string,
    signal?: AbortSignal,
    init?: RequestInit,
  ) => Promise<unknown>;
  baseUrl: string;
  onHelperReady: () => void;
  onStageChange?: (stage: 1 | 2 | 3, statusText: string) => void;
  setResult: (media: UnifiedMedia) => void;
  setError: (message: string, duration?: number) => void;
}): Promise<void> {
  const { videoId, signal, isCurrent } = ctx;
  const emitStage = (stage: 1 | 2 | 3) => {
    ctx.onStageChange?.(stage, formatYouTubeParseStageText(stage, ctx.locale));
  };

  let bridgeMod: typeof import("../services/extensionBridge") | null = null;
  const loadBridge = async () => {
    if (!bridgeMod) {
      bridgeMod = await import("../services/extensionBridge");
    }
    return bridgeMod;
  };
  const pingExt: typeof pingInstalledExtension =
    ctx.pingExtension ??
    (async (...args) => (await loadBridge()).pingInstalledExtension(...args));
  const parseViaExt: typeof parseYouTubeViaExtensionFn =
    ctx.parseYouTubeViaExtension ??
    (async (...args) => (await loadBridge()).parseYouTubeViaExtension(...args));

  // Step 1: Prefer connected DokiTool Chrome extension (`youtube_parse`) — zero Tampermonkey.
  let extState: Awaited<ReturnType<typeof pingInstalledExtension>> | null =
    null;
  try {
    extState = await pingExt();
  } catch {
    extState = null;
  }
  if (!isCurrent()) return;

  const extEnv: ClientCapabilityEnvironment = {
    extensionConnected: Boolean(extState?.connected),
    extensionVersion: extState?.version || "",
    extensionCapabilities: extState?.capabilities ?? [],
    userscriptReady: false,
  };
  const parseRoute = resolveClientParseRoute(true, extEnv);
  if (parseRoute.channel === "extension_client_parse") {
    emitStage(1);
    const stage2Timer = setTimeout(() => {
      if (isCurrent()) emitStage(2);
    }, 350);
    const stage3Timer = setTimeout(() => {
      if (isCurrent()) emitStage(3);
    }, 1100);
    let resp: Awaited<ReturnType<typeof parseViaExt>>;
    try {
      resp = await parseViaExt(videoId, {
        locale: ctx.locale === "en" ? "en" : "zh-CN",
      });
    } finally {
      clearTimeout(stage2Timer);
      clearTimeout(stage3Timer);
    }
    if (!isCurrent()) return;

    if (resp.ok && resp.data?.media) {
      const normalized = withTbvideoItems(resp.data.media);
      const existingHelper = normalized.extra?.youtube_helper as
        | Partial<YouTubeHelperState>
        | undefined;
      const extVersion =
        extState?.version || existingHelper?.extensionVersion || undefined;
      const readyState: YouTubeHelperState = {
        status: "ready",
        provider: "extension",
        version: extState?.version || existingHelper?.version || null,
        ...(extVersion ? { extensionVersion: extVersion } : {}),
        min_version: MIN_YOUTUBE_HELPER_VERSION,
        script_url: YOUTUBE_HELPER_SCRIPT_URL,
      };
      const data: UnifiedMedia = {
        ...normalized,
        extra: {
          ...(normalized.extra || {}),
          youtube_helper: readyState,
        },
      };
      ctx.onHelperReady();
      ctx.setResult(data);
      return;
    }

    if (!resp.ok && resp.code === "LOGIN_REQUIRED") {
      const loginMsg =
        resp.error || "当前网络出口被 YouTube 要求验证，请更换节点后重试";
      const helperState: YouTubeHelperState = {
        status: "login_required",
        provider: "extension",
        version: extState?.version || null,
        ...(extState?.version ? { extensionVersion: extState.version } : {}),
        min_version: MIN_YOUTUBE_HELPER_VERSION,
        script_url: YOUTUBE_HELPER_SCRIPT_URL,
        message: loginMsg,
      };
      ctx.setResult(buildFallbackYouTubeMedia(videoId, helperState));
      ctx.setError(helperState.message!, 5000);
      return;
    }

    if (!resp.ok) {
      if (
        !resp.code ||
        !EXTENSION_PARSE_FALLBACK_ERROR_CODES.has(resp.code)
      ) {
        throw new Error(resp.error || "通过扩展解析 YouTube 失败");
      }
      // Bridge transport or unsupported action error -> fall through to legacy userscript check.
    } else {
      throw new Error("通过扩展解析 YouTube 失败");
    }
  }

  // Step 2: Legacy userscript helper fallback when extension is absent or lacks `youtube_parse`.
  const ping = await ctx.pingHelper();
  if (!isCurrent()) return;

  if (!ping.installed || !ping.supported) {
    const hasOutdatedExtension =
      Boolean(extState?.connected) &&
      !extEnv.extensionCapabilities.includes("youtube_parse");
    if (!ping.installed && !hasOutdatedExtension && isMobileBrowser()) {
      ctx.setError(
        ctx.locale === "en"
          ? "YouTube requires a browser with a userscript manager. Using a computer is recommended on mobile."
          : "YouTube 需要在装有用户脚本管理器的浏览器里使用，手机上建议改用电脑",
      );
      return;
    }
    const isEn = ctx.locale === "en";
    const normalizedExtVer = (extState?.version || "").trim().replace(/^v/i, "");
    const extVerDisplay = normalizedExtVer
      ? `v${normalizedExtVer}`
      : isEn
        ? "unknown"
        : "未知";
    const helperState: YouTubeHelperState = hasOutdatedExtension
      ? {
          status: "outdated",
          provider: "extension",
          version: normalizedExtVer || null,
          ...(normalizedExtVer ? { extensionVersion: normalizedExtVer } : {}),
          min_version: MIN_EXTENSION_YOUTUBE_VERSION,
          script_url: YOUTUBE_HELPER_SCRIPT_URL,
          message: isEn
            ? `Connected DokiTool extension (${extVerDisplay}) is outdated. Upgrade to v${MIN_EXTENSION_YOUTUBE_VERSION}+ to parse and download YouTube without a userscript.`
            : `检测到已连接的扩展版本（${extVerDisplay}）较低，升级至 v${MIN_EXTENSION_YOUTUBE_VERSION}+ 即可免油猴解析下载 YouTube`,
        }
      : {
          status: ping.installed ? "outdated" : "missing",
          ...(ping.installed ? { provider: "userscript" as const } : {}),
          version: ping.version,
          min_version: MIN_YOUTUBE_HELPER_VERSION,
          script_url: YOUTUBE_HELPER_SCRIPT_URL,
          message: ping.installed
            ? `当前已安装的 YouTube 助手版本（v${ping.version}）低于最低要求（v${MIN_YOUTUBE_HELPER_VERSION}），推荐安装 DokiTool 扩展或更新脚本后重试`
            : "当前未检测到 DokiTool 扩展或 YouTube 助手脚本，请按说明安装并启用后重试",
        };
    if (isCurrent()) {
      ctx.setResult(buildFallbackYouTubeMedia(videoId, helperState));
    }
    return;
  }

  ctx.onHelperReady();

  const fetchFreshWebContext = async (): Promise<YouTubeHelperContextResponse> => {
    const contextEnvelope = (await ctx.fetchJSON(
      `${ctx.baseUrl}/api/youtube/context?schema_version=1.0`,
      signal,
    )) as {
      schema_version?: string;
      code?: string;
      data?: YouTubeHelperContextResponse;
    };
    if (
      !contextEnvelope ||
      contextEnvelope.schema_version !== "1.0" ||
      contextEnvelope.code !== "OK" ||
      !contextEnvelope.data?.player_id
    ) {
      throw new Error("获取 YouTube 解析上下文失败");
    }
    writeCachedWebYouTubeContext(ctx.baseUrl, contextEnvelope.data);
    return contextEnvelope.data;
  };

  const runUserscriptAttempt = async (allowCachedContext: boolean): Promise<void> => {
    emitStage(1);
    const cachedContext = allowCachedContext
      ? readCachedWebYouTubeContext(ctx.baseUrl)
      : null;
    const usedCachedContext = cachedContext !== null;

    let contextData: YouTubeHelperContextResponse;
    let prefetchData: {
      visitorData?: string;
      oembed?: { title?: string; author?: string; thumbnail?: string } | null;
    } | null = null;
    try {
      const [ctxRes, prefetchRes] = await Promise.all([
        cachedContext ? Promise.resolve(cachedContext) : fetchFreshWebContext(),
        requestYouTubePrefetchViaHelper(
          { video_id: videoId },
          { signal, timeoutMs: 8000 },
        ).catch(() => null),
      ]);
      contextData = ctxRes;
      prefetchData = prefetchRes;
    } catch (error: any) {
      if (error?.status === 404) {
        const data = await ctx.requestStandardParse();
        if (isCurrent()) {
          ctx.setResult(data);
        }
        return;
      }
      throw error;
    }

    if (!isCurrent()) return;

    emitStage(2);
    const playerResult = await requestYouTubePlayerViaHelper(
      {
        video_id: videoId,
        signature_timestamp: contextData.signature_timestamp,
        client: contextData.client,
        ...(prefetchData?.visitorData
          ? { visitor_data: prefetchData.visitorData }
          : {}),
        ...(prefetchData?.oembed ? { oembed: prefetchData.oembed } : {}),
      },
      { signal },
    );

    if (!isCurrent()) return;

    const playStatus = playerResult?.playabilityStatus?.status || "ERROR";
    if (playStatus === "LOGIN_REQUIRED") {
      const loginMsg = "当前网络出口被 YouTube 要求验证，请更换节点后重试";
      const helperState: YouTubeHelperState = {
        status: "login_required",
        provider: "userscript",
        version: ping.version,
        min_version: MIN_YOUTUBE_HELPER_VERSION,
        script_url: YOUTUBE_HELPER_SCRIPT_URL,
        message: loginMsg,
      };
      ctx.setResult(buildFallbackYouTubeMedia(videoId, helperState));
      ctx.setError(loginMsg, 5000);
      return;
    }
    if (playStatus !== "OK") {
      throw new Error(
        playerResult?.playabilityStatus?.reason ||
          `YouTube 返回不可播放状态（${playStatus}）`,
      );
    }

    const vd = playerResult.videoDetails;
    const finalizeBody: Record<string, unknown> = {
      video_id: videoId,
      player_id: contextData.player_id,
      formats: playerResult.streamingData?.formats || [],
      adaptiveFormats: playerResult.streamingData?.adaptiveFormats || [],
    };
    if (typeof vd?.title === "string" && vd.title.trim()) {
      finalizeBody.title = vd.title.trim();
    }
    if (typeof vd?.author === "string" && vd.author.trim()) {
      finalizeBody.author = vd.author.trim();
    }
    if (
      typeof vd?.lengthSeconds === "number" &&
      Number.isInteger(vd.lengthSeconds) &&
      vd.lengthSeconds > 0
    ) {
      finalizeBody.duration_seconds = vd.lengthSeconds;
    }
    if (typeof vd?.thumbnail === "string" && vd.thumbnail.trim()) {
      finalizeBody.thumbnail = vd.thumbnail.trim();
    }
    if (contextData.supports_captions !== false && playerResult.captions) {
      const projectedCaptions = projectYouTubeCaptionsForFinalize(
        playerResult.captions,
      );
      if (projectedCaptions) {
        finalizeBody.captions = projectedCaptions;
      }
    }

    emitStage(3);
    let finalizePayload: unknown;
    try {
      finalizePayload = await ctx.fetchJSON(
        `${ctx.baseUrl}/api/youtube/finalize?schema_version=1.0`,
        signal,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(finalizeBody),
        },
      );
    } catch (err) {
      if (usedCachedContext && isPlayerIdExpiredError(err)) {
        clearCachedYouTubeContext(ctx.baseUrl);
        return runUserscriptAttempt(false);
      }
      throw err;
    }

    const finalized = withTbvideoItems(validateMediaEnvelope(finalizePayload));
    const readyState: YouTubeHelperState = {
      status: "ready",
      provider: "userscript",
      version: ping.version,
      min_version: MIN_YOUTUBE_HELPER_VERSION,
      script_url: YOUTUBE_HELPER_SCRIPT_URL,
    };
    const data: UnifiedMedia = {
      ...finalized,
      extra: {
        ...(finalized.extra || {}),
        youtube_helper: readyState,
      },
    };
    if (isCurrent()) {
      ctx.setResult(data);
    }
  };

  await runUserscriptAttempt(true);
}
