import { supportedPlatforms } from "./platforms";
import { withTbvideoItems } from "../services/tbvideo";
import {
  MIN_EXTENSION_YOUTUBE_VERSION,
  resolveClientParseRoute,
  type ClientCapabilityEnvironment,
} from "../core/capabilityHub";
import type {
  parseYouTubeViaExtension as parseYouTubeViaExtensionFn,
  pingInstalledExtension,
} from "../services/extensionBridge";
import { readyItem, readyVariant } from "./mediaContract";
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
  "douyin:iesdouyin.com bilibili:b23.tv xiaohongshu:xhslink.com,rednote.com toutiao:toutiaoimg.com weibo:weibo.cn pipigx:ippzone.com zuiyou:share.xiaochuankeji.cn x:twitter.com,t.co youtube:youtu.be instagram:instagr.am facebook:fb.watch";

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
            "安装 DokiTool Chrome 官方扩展即可本地解析并无损下载 YouTube",
        },
      },
    ],
    extra: {
      youtube_helper: helperState,
    },
  };
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

export async function runYouTubeHelperParse(ctx: {
  videoId: string;
  locale: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  pingExtension?: typeof pingInstalledExtension;
  parseYouTubeViaExtension?: typeof parseYouTubeViaExtensionFn;
  onHelperReady: () => void;
  onStageChange?: (stage: 1 | 2 | 3, statusText: string) => void;
  setResult: (media: UnifiedMedia) => void;
  setError: (message: string, duration?: number) => void;
}): Promise<void> {
  const { videoId, isCurrent } = ctx;
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

  // Single-path Chrome MV3 Extension parsing (`youtube_parse`).
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
        min_version: MIN_EXTENSION_YOUTUBE_VERSION,
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
        min_version: MIN_EXTENSION_YOUTUBE_VERSION,
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
      // Bridge transport or unsupported action error -> show extension install/reconnect fallback with ZERO /api/parse calls.
    } else {
      throw new Error("通过扩展解析 YouTube 失败");
    }
  }

  const hasOutdatedExtension =
    Boolean(extState?.connected) &&
    !extEnv.extensionCapabilities.includes("youtube_parse");
  const isEn = ctx.locale === "en";
  if (!hasOutdatedExtension && isMobileBrowser()) {
    ctx.setError(
      isEn
        ? "YouTube requires the desktop Chrome/Edge DokiTool extension. Using a computer is recommended on mobile."
        : "YouTube 需要桌面端 Chrome/Edge 的 DokiTool 官方扩展，手机上建议改用电脑",
    );
    return;
  }

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
        message: isEn
          ? `Connected DokiTool extension (${extVerDisplay}) is outdated. Upgrade to v${MIN_EXTENSION_YOUTUBE_VERSION}+ to parse and download YouTube.`
          : `检测到已连接的扩展版本（${extVerDisplay}）较低，升级至 v${MIN_EXTENSION_YOUTUBE_VERSION}+ 即可解析下载 YouTube`,
      }
    : {
        status: "missing",
        provider: "extension",
        version: null,
        min_version: MIN_EXTENSION_YOUTUBE_VERSION,
        message: isEn
          ? "DokiTool Chrome extension not detected. Please install and enable the official extension to parse and download YouTube."
          : "当前未检测到 DokiTool Chrome 官方扩展，请先安装并启用扩展后重试",
      };
  if (isCurrent()) {
    ctx.setResult(buildFallbackYouTubeMedia(videoId, helperState));
  }
}
