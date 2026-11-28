import {
  LATEST_EXTENSION_VERSION,
  MIN_EXTENSION_YOUTUBE_VERSION,
} from "../../core/capabilityHub";
import { projectYouTubeCaptionsForFinalize } from "../../core/media/subtitleEngine";
import { isValidStatsSnapshot } from "../../monitor/statsTypes";
import { withTbvideoItems } from "../../services/tbvideo";
import type {
  Attachment,
  MediaItem,
  UnifiedMedia,
  YouTubeHelperState,
} from "../../types/media";
import { readyItem, validateMediaEnvelope } from "../../utils/mediaContract";
import type { YouTubeHelperContextResponse } from "../../utils/youtubeHelperCore";
import type { ExtensionDnrRule } from "../dnrRules";
import { validateApiBaseUrl } from "../hostWhitelist";
import {
  errRpc,
  okRpc,
  type AuthMode,
  type BackgroundToOffscreenRequest,
  type ConnectionCheckResult,
  type ExtensionRpcResponse,
  type ExtensionSettings,
  type MatchedPlatformUrl,
  type OffscreenResponseMap,
  type OwnerStatsResult,
} from "../protocol";
import {
  buildApiAuthHeaders,
  type ExtensionStorageController,
} from "../storage";
import { matchSupportedPlatformUrl } from "../urlMatcher";
import type { ChromeBackgroundApi } from "./types";

export class HttpStatusError extends Error {
  status: number;
  retry_after_seconds?: number;
  rateLimitRetried?: boolean;
  code?: string;

  constructor(
    message: string,
    status: number,
    retryAfterSeconds?: number,
    code?: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
    if (
      typeof retryAfterSeconds === "number" &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds > 0
    ) {
      this.retry_after_seconds = Math.ceil(retryAfterSeconds);
    }
    this.code = code;
  }
}

export async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  onRateLimitWait?: (seconds: number) => void,
): Promise<T> {
  const abortErr = () =>
    signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortErr();
    try {
      return await operation();
    } catch (err) {
      const statusErr = err as HttpStatusError | undefined;
      if (statusErr?.rateLimitRetried) throw err;
      const wait = statusErr?.retry_after_seconds;
      if (
        statusErr?.status !== 429 ||
        !(typeof wait === "number" && wait > 0 && wait <= 15) ||
        attempt >= 2
      ) {
        if (statusErr?.status === 429 && !Object.isFrozen(statusErr)) {
          statusErr.rateLimitRetried = true;
        }
        throw err;
      }
      for (let sec = Math.ceil(wait); sec > 0; sec--) {
        if (signal?.aborted) throw abortErr();
        onRateLimitWait?.(sec);
        await new Promise<void>((res, rej) => {
          const stop = () => {
            clearTimeout(timer);
            rej(abortErr());
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", stop);
            res();
          }, 1000);
          (timer as { unref?: () => void })?.unref?.();
          signal?.addEventListener("abort", stop, { once: true });
          if (signal?.aborted) stop();
        });
      }
    }
  }
}

function parseRetryAfterHeader(
  response: Response,
  payload?: unknown,
): number | undefined {
  if (response.status !== 429) return undefined;
  const bodyRetry = (
    payload as { error?: { retry_after_seconds?: unknown } } | null
  )?.error?.retry_after_seconds;
  for (const candidate of [bodyRetry, response.headers.get("Retry-After")]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) {
      return Math.ceil(n);
    }
  }
  return undefined;
}

function extractApiErrorMessage(
  payload: unknown,
  fallbackStatus: number,
): { message: string; code?: string } {
  if (payload && typeof payload === "object") {
    const rec = payload as {
      code?: unknown;
      msg?: unknown;
      message?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    const errMsg =
      (typeof rec.error?.message === "string" && rec.error.message.trim()) ||
      (typeof rec.msg === "string" && rec.msg.trim()) ||
      (typeof rec.message === "string" && rec.message.trim()) ||
      "";
    const errCode =
      (typeof rec.error?.code === "string" && rec.error.code.trim()) ||
      (typeof rec.code === "string" && rec.code.trim()) ||
      undefined;
    if (errMsg) {
      return { message: errMsg, code: errCode };
    }
  }
  if (fallbackStatus === 401) {
    return { message: "认证凭据无效", code: "UNAUTHORIZED" };
  }
  return { message: `请求失败（HTTP ${fallbackStatus}）` };
}

export interface ParseYouTubeViaOffscreenParams {
  videoId: string;
  apiOrigin: string;
  authSettings: Pick<ExtensionSettings, "bearerToken">;
  helperVersion: string;
  extensionVersion?: string;
  signal?: AbortSignal;
  onContextNotFound?: () => Promise<UnifiedMedia>;
}

export interface ParseTikTokViaOffscreenParams {
  url: string;
  apiOrigin: string;
  authSettings: Pick<ExtensionSettings, "bearerToken">;
  extraAllowedOrigins?: string[];
  signal?: AbortSignal;
  onFinalizeNotFound?: () => Promise<UnifiedMedia>;
}

export interface ApiClientDeps {
  chromeApi: ChromeBackgroundApi;
  storage: ExtensionStorageController;
  fetchFn: typeof fetch;
  nowFn: () => number;
  syncDynamicDnrRules: (extraOrigins?: string[]) => Promise<ExtensionDnrRule[]>;
  sendToOffscreen: <T extends BackgroundToOffscreenRequest["type"]>(
    req: Extract<BackgroundToOffscreenRequest, { type: T }>,
    options?: { skipEnsure?: boolean },
  ) => Promise<OffscreenResponseMap[T]>;
  onParseProgress?: (stage: 1 | 2 | 3, statusText: string) => void;
}

export interface BackgroundApiClient {
  getLastConnectionCheck(): ConnectionCheckResult | null;
  fetchApiJson(
    url: string,
    settings: Pick<ExtensionSettings, "bearerToken">,
    init?: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown>;
  runTestConnection(params?: {
    apiBaseUrl?: string;
    bearerToken?: string;
  }): Promise<ConnectionCheckResult>;
  fetchOwnerStats(): Promise<ExtensionRpcResponse<OwnerStatsResult>>;
  parseYouTubeViaOffscreen(
    params: ParseYouTubeViaOffscreenParams,
  ): Promise<UnifiedMedia>;
  parseTikTokViaOffscreen(
    params: ParseTikTokViaOffscreenParams,
  ): Promise<UnifiedMedia>;
  parseSupportedUrlInternal(
    matched: MatchedPlatformUrl,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<UnifiedMedia>;
  resolveLazyItemInternal(
    rawResolveUrl: string,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<UnifiedMedia>;
  hydrateDeferredMediaItems(
    media: UnifiedMedia,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<UnifiedMedia>;
}

export function createApiClient(deps: ApiClientDeps): BackgroundApiClient {
  const {
    chromeApi,
    storage,
    fetchFn,
    nowFn,
    syncDynamicDnrRules,
    sendToOffscreen,
    onParseProgress,
  } = deps;

  const CONTEXT_CACHE_SAFETY_MARGIN_MS = 5 * 60_000;
  const youtubeContextCache = new Map<
    string,
    { data: YouTubeHelperContextResponse; usableUntilMs: number }
  >();

  const readCachedYouTubeContext = (
    originKey: string,
  ): YouTubeHelperContextResponse | null => {
    const hit = youtubeContextCache.get(originKey);
    if (!hit) return null;
    if (nowFn() >= hit.usableUntilMs) {
      youtubeContextCache.delete(originKey);
      return null;
    }
    return hit.data;
  };

  const writeCachedYouTubeContext = (
    originKey: string,
    data: YouTubeHelperContextResponse,
  ): void => {
    const parsedExp = Date.parse(data.expires_at || "");
    if (!Number.isFinite(parsedExp)) return;
    const usableUntilMs = parsedExp - CONTEXT_CACHE_SAFETY_MARGIN_MS;
    if (usableUntilMs > nowFn()) {
      youtubeContextCache.set(originKey, { data, usableUntilMs });
    }
  };

  const isPlayerIdInvalidError = (err: unknown): boolean => {
    if (err instanceof HttpStatusError) {
      return (
        err.status === 400 &&
        (err.code === "INVALID_INPUT" || /player_id/i.test(err.message))
      );
    }
    return err instanceof Error && /player_id/i.test(err.message);
  };

  let lastConnectionCheck: ConnectionCheckResult | null = null;

  const fetchApiJson = async (
    url: string,
    settings: Pick<ExtensionSettings, "bearerToken">,
    init?: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const extraHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers = buildApiAuthHeaders(settings, {
      Accept: "application/json",
      ...extraHeaders,
    });

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    const timeout = setTimeout(
      () => controller.abort(new Error("请求后端超时，请稍后重试")),
      55_000,
    );
    (timeout as { unref?: () => void })?.unref?.();

    try {
      const resp = await fetchFn(url, {
        ...init,
        headers,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });

      const payload = await resp.json().catch(() => null);
      if (!resp.ok) {
        const extracted = extractApiErrorMessage(payload, resp.status);
        throw new HttpStatusError(
          extracted.message,
          resp.status,
          parseRetryAfterHeader(resp, payload),
          extracted.code,
        );
      }
      if (payload === null) {
        throw new HttpStatusError(
          `接口返回无效 JSON（HTTP ${resp.status}）`,
          resp.status,
        );
      }
      return payload;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  const runTestConnection = async (params?: {
    apiBaseUrl?: string;
    bearerToken?: string;
  }): Promise<ConnectionCheckResult> => {
    const saved = await storage.getSettings();
    const candidateUrl =
      params?.apiBaseUrl !== undefined ? params.apiBaseUrl : saved.apiBaseUrl;
    const candidateToken =
      params?.bearerToken !== undefined
        ? params.bearerToken.trim()
        : saved.bearerToken;
    const authMode: AuthMode =
      candidateToken.length > 0 ? "authenticated" : "anonymous";

    const validated = validateApiBaseUrl(candidateUrl);
    if (!validated.ok) {
      const invalidRes: ConnectionCheckResult = {
        ok: false,
        status: 0,
        authMode,
        message: validated.error || "后端地址格式无效",
        checkedAt: nowFn(),
      };
      lastConnectionCheck = invalidRes;
      return invalidRes;
    }

    if (!validated.isLoopback && chromeApi.declarativeNetRequest) {
      await syncDynamicDnrRules([validated.origin]).catch(() => []);
    }

    const endpoint = `${validated.origin}/api/platforms?schema_version=1.0`;
    try {
      const headers = buildApiAuthHeaders(
        { bearerToken: candidateToken },
        { Accept: "application/json" },
      );
      const resp = await fetchFn(endpoint, {
        method: "GET",
        headers,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      const payload = await resp.json().catch(() => null);

      if (resp.status === 200 && (payload as { code?: unknown })?.code === "OK") {
        const platforms = Array.isArray(
          (payload as { data?: { platforms?: unknown[] } })?.data?.platforms,
        )
          ? (payload as { data: { platforms: unknown[] } }).data.platforms
          : [];
        const platformCount = platforms.length;
        const message =
          authMode === "authenticated"
            ? `200 已就绪（已加载 ${platformCount} 个平台）`
            : `200 匿名模式已连通（已加载 ${platformCount} 个平台）`;
        const okRes: ConnectionCheckResult = {
          ok: true,
          status: 200,
          authMode,
          platformCount,
          message,
          checkedAt: nowFn(),
        };
        lastConnectionCheck = okRes;
        return okRes;
      }

      const extracted = extractApiErrorMessage(payload, resp.status);
      const formattedMessage = extracted.message.startsWith(String(resp.status))
        ? extracted.message
        : `${resp.status} ${extracted.message}`;
      const failRes: ConnectionCheckResult = {
        ok: false,
        status: resp.status,
        authMode,
        message: formattedMessage,
        checkedAt: nowFn(),
      };
      lastConnectionCheck = failRes;
      return failRes;
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : "无法连接后端服务";
      const netFail: ConnectionCheckResult = {
        ok: false,
        status: 0,
        authMode,
        message: msg,
        checkedAt: nowFn(),
      };
      lastConnectionCheck = netFail;
      return netFail;
    }
  };

  const fetchOwnerStats = async (): Promise<
    ExtensionRpcResponse<OwnerStatsResult>
  > => {
    const saved = await storage.getSettings();
    const token = saved.bearerToken.trim();
    if (!token) {
      return errRpc("未配置凭据", { status: 401, code: "NO_TOKEN" });
    }

    const validated = validateApiBaseUrl(saved.apiBaseUrl);
    if (!validated.ok) {
      return errRpc(validated.error || "后端地址格式无效", {
        status: 400,
        code: "STATS_FAILED",
      });
    }

    if (!validated.isLoopback && chromeApi.declarativeNetRequest) {
      await syncDynamicDnrRules([validated.origin]).catch(() => []);
    }

    const endpoint = `${validated.origin}/api/stats?schema_version=1.0`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("获取监控统计超时，请稍后重试")),
      15_000,
    );
    (timeout as { unref?: () => void })?.unref?.();

    try {
      const headers = buildApiAuthHeaders(
        { bearerToken: token },
        { Accept: "application/json" },
      );
      const resp = await fetchFn(endpoint, {
        method: "GET",
        headers,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await resp.json().catch(() => null);

      if (
        resp.status === 200 &&
        payload &&
        typeof payload === "object" &&
        (payload as { code?: unknown }).code === "OK" &&
        isValidStatsSnapshot((payload as { data?: unknown }).data)
      ) {
        return okRpc({
          stats: (payload as { data: OwnerStatsResult["stats"] }).data,
          apiOrigin: validated.origin,
          fetchedAt: nowFn(),
        });
      }

      if (resp.status === 200) {
        return errRpc("监控接口返回数据格式无效", {
          status: 502,
          code: "STATS_FAILED",
        });
      }

      const extracted = extractApiErrorMessage(payload, resp.status);
      return errRpc(extracted.message, {
        status: resp.status,
        code: resp.status === 401 ? "UNAUTHORIZED" : "STATS_FAILED",
      });
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : "无法获取监控统计";
      return errRpc(msg, { status: 0, code: "STATS_FAILED" });
    } finally {
      clearTimeout(timeout);
    }
  };

  const parseYouTubeViaOffscreen = async (
    params: ParseYouTubeViaOffscreenParams,
  ): Promise<UnifiedMedia> => {
    const {
      videoId,
      apiOrigin,
      authSettings,
      helperVersion,
      extensionVersion,
      signal,
      onContextNotFound,
    } = params;

    await syncDynamicDnrRules();

    const fetchFreshContext = async (): Promise<YouTubeHelperContextResponse> => {
      const contextPayload = (await withRateLimitRetry(
        () =>
          fetchApiJson(
            `${apiOrigin}/api/youtube/context?schema_version=1.0`,
            authSettings,
            { method: "GET" },
            signal,
          ),
        signal,
      )) as {
        schema_version?: string;
        code?: string;
        data?: YouTubeHelperContextResponse;
      };
      if (
        !contextPayload ||
        contextPayload.schema_version !== "1.0" ||
        contextPayload.code !== "OK" ||
        !contextPayload.data?.player_id
      ) {
        throw new Error("获取 YouTube 解析上下文失败");
      }
      writeCachedYouTubeContext(apiOrigin, contextPayload.data);
      return contextPayload.data;
    };

    const runAttempt = async (allowCachedContext: boolean): Promise<UnifiedMedia> => {
      onParseProgress?.(1, "正在准备解析上下文 (1/3)…");
      const cachedContext = allowCachedContext
        ? readCachedYouTubeContext(apiOrigin)
        : null;
      const usedCachedContext = cachedContext !== null;

      // Spec B.1 Tier-1: 3-way parallel prefetch (`GET /api/youtube/context` +
      // Offscreen `sw.js_data` visitorData + `www.youtube.com/oembed`).
      let contextData: YouTubeHelperContextResponse;
      let prefetchData: {
        visitorData?: string;
        oembed?: { title?: string; author?: string; thumbnail?: string } | null;
      } | null = null;
      try {
        const [ctxRes, prefetchRes] = await Promise.all([
          cachedContext ? Promise.resolve(cachedContext) : fetchFreshContext(),
          sendToOffscreen({
            type: "OFFSCREEN_YOUTUBE_PREFETCH",
            payload: { video_id: videoId },
            timeoutMs: 8_000,
          })
            .then((res) => res?.prefetch ?? null)
            .catch(() => null),
        ]);
        contextData = ctxRes;
        prefetchData = prefetchRes;
      } catch (err) {
        if (
          err instanceof HttpStatusError &&
          err.status === 404 &&
          onContextNotFound
        ) {
          return onContextNotFound();
        }
        throw err;
      }

      onParseProgress?.(2, "正在获取视频流清单 (2/3)…");
      const { player: playerResult } = await sendToOffscreen({
        type: "OFFSCREEN_YOUTUBE_PLAYER",
        payload: {
          video_id: videoId,
          signature_timestamp: contextData.signature_timestamp,
          client: contextData.client,
          ...(prefetchData?.visitorData
            ? { visitor_data: prefetchData.visitorData }
            : {}),
          ...(prefetchData?.oembed ? { oembed: prefetchData.oembed } : {}),
        },
        timeoutMs: 20_000,
      });

      const playStatus = playerResult?.playabilityStatus?.status || "ERROR";
      if (playStatus === "LOGIN_REQUIRED") {
        const err = new Error(
          "当前网络出口被 YouTube 要求验证，请更换节点后重试",
        ) as Error & { code?: string };
        err.code = "LOGIN_REQUIRED";
        throw err;
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

      onParseProgress?.(3, "正在解密高画质签名 (3/3)…");
      let finalizePayload: unknown;
      try {
        finalizePayload = await withRateLimitRetry(
          () =>
            fetchApiJson(
              `${apiOrigin}/api/youtube/finalize?schema_version=1.0`,
              authSettings,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(finalizeBody),
              },
              signal,
            ),
          signal,
        );
      } catch (err) {
        if (usedCachedContext && isPlayerIdInvalidError(err)) {
          youtubeContextCache.delete(apiOrigin);
          return runAttempt(false);
        }
        throw err;
      }

      const finalized = withTbvideoItems(
        validateMediaEnvelope(finalizePayload, { apiOrigin }),
      );
      const readyState: YouTubeHelperState = {
        status: "ready",
        provider: "extension",
        version: extensionVersion || helperVersion,
        ...(extensionVersion ? { extensionVersion } : {}),
        min_version: MIN_EXTENSION_YOUTUBE_VERSION,
      };
      return {
        ...finalized,
        extra: {
          ...(finalized.extra || {}),
          youtube_helper: readyState,
        },
      };
    };

    return runAttempt(true);
  };

  const isTikTokFinalizeRouteNotFound = (err: unknown): boolean =>
    err instanceof HttpStatusError &&
    err.status === 404 &&
    err.code === "INVALID_INPUT" &&
    /接口不存在/.test(err.message);

  const parseTikTokViaOffscreen = async (
    params: ParseTikTokViaOffscreenParams,
  ): Promise<UnifiedMedia> => {
    const {
      url,
      apiOrigin,
      authSettings,
      extraAllowedOrigins,
      signal,
      onFinalizeNotFound,
    } = params;

    await syncDynamicDnrRules();

    onParseProgress?.(1, "正在获取 TikTok 作品数据 (1/2)…");
    const { result } = await sendToOffscreen({
      type: "OFFSCREEN_TIKTOK_FETCH",
      payload: {
        url,
        ...(extraAllowedOrigins?.length ? { extraAllowedOrigins } : {}),
      },
      timeoutMs: 25_000,
    });

    onParseProgress?.(2, "正在校验并生成下载方案 (2/2)…");
    let finalizePayload: unknown;
    try {
      finalizePayload = await withRateLimitRetry(
        () =>
          fetchApiJson(
            `${apiOrigin}/api/tiktok/finalize?schema_version=1.0`,
            authSettings,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(result),
            },
            signal,
          ),
        signal,
      );
    } catch (err) {
      if (isTikTokFinalizeRouteNotFound(err) && onFinalizeNotFound) {
        return onFinalizeNotFound();
      }
      throw err;
    }

    return withTbvideoItems(
      validateMediaEnvelope(finalizePayload, { apiOrigin }),
    );
  };

  const parseSupportedUrlInternal = async (
    matched: MatchedPlatformUrl,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<UnifiedMedia> => {
    const validated = validateApiBaseUrl(settings.apiBaseUrl);
    if (!validated.ok) {
      throw new Error(validated.error || "后端地址无效");
    }
    const apiOrigin = validated.origin;
    await syncDynamicDnrRules();

    const requestStandardParse = async (): Promise<UnifiedMedia> => {
      const parseEndpoint = `${apiOrigin}/api/parse?schema_version=1.0&platform=all&url=${encodeURIComponent(matched.url)}`;
      const payload = await withRateLimitRetry(
        () => fetchApiJson(parseEndpoint, settings, { method: "GET" }, signal),
        signal,
      );
      return withTbvideoItems(validateMediaEnvelope(payload, { apiOrigin }));
    };

    if (matched.platform === "youtube" && matched.youtubeVideoId) {
      const manifestVersion = String(chromeApi.runtime.getManifest?.()?.version || "");
      return parseYouTubeViaOffscreen({
        videoId: matched.youtubeVideoId,
        apiOrigin,
        authSettings: settings,
        helperVersion: manifestVersion || LATEST_EXTENSION_VERSION,
        ...(manifestVersion ? { extensionVersion: manifestVersion } : {}),
        signal,
        onContextNotFound: requestStandardParse,
      });
    }

    if (matched.platform === "tiktok") {
      return parseTikTokViaOffscreen({
        url: matched.url,
        apiOrigin,
        authSettings: settings,
        ...(validated.isLoopback ? { extraAllowedOrigins: [apiOrigin] } : {}),
        signal,
        onFinalizeNotFound: requestStandardParse,
      });
    }

    return requestStandardParse();
  };

  const resolveLazyItemInternal = async (
    rawResolveUrl: string,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<UnifiedMedia> => {
    if (
      typeof rawResolveUrl !== "string" ||
      !rawResolveUrl.startsWith("/api/resolve?") ||
      /[\\\s#]/.test(rawResolveUrl)
    ) {
      throw new Error("条目解析地址无效");
    }

    const queryPart = rawResolveUrl.slice("/api/resolve?".length);
    const params = new URLSearchParams(queryPart);
    const innerSourceUrl = params.get("url") || "";
    if (!matchSupportedPlatformUrl(innerSourceUrl)) {
      throw new Error("条目源链接不在受支持的 16 个平台白名单内");
    }

    const validated = validateApiBaseUrl(settings.apiBaseUrl);
    if (!validated.ok) {
      throw new Error(validated.error || "后端地址无效");
    }
    await syncDynamicDnrRules();

    const fullUrl =
      validated.origin +
      rawResolveUrl +
      (params.has("schema_version") ? "" : "&schema_version=1.0");

    const payload = await withRateLimitRetry(
      () => fetchApiJson(fullUrl, settings, { method: "GET" }, signal),
      signal,
    );
    return withTbvideoItems(
      validateMediaEnvelope(payload, { apiOrigin: validated.origin }),
    );
  };

  const hydrateDeferredMediaItems = async (
    media: UnifiedMedia,
    settings: ExtensionSettings,
    signal?: AbortSignal,
  ): Promise<UnifiedMedia> => {
    if (!media.items.some((item) => item.state === "deferred" && item.resolve_url)) {
      return media;
    }
    const hydratedItems: MediaItem[] = [];
    const mergedAttachments: Attachment[] = [...(media.attachments ?? [])];
    const attachmentIdxById = new Map<string, number>();
    for (let i = 0; i < mergedAttachments.length; i++) {
      const id =
        typeof mergedAttachments[i]?.id === "string"
          ? mergedAttachments[i].id
          : "";
      if (id) attachmentIdxById.set(id, i);
    }
    for (const item of media.items) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (item.state === "deferred" && item.resolve_url) {
        const resolvedMedia = await resolveLazyItemInternal(
          item.resolve_url,
          settings,
          signal,
        );
        const matchedItem = resolvedMedia.items.find((c) => c.id === item.id);
        hydratedItems.push(
          matchedItem && readyItem(matchedItem)
            ? matchedItem.resolve_url
              ? matchedItem
              : { ...matchedItem, resolve_url: item.resolve_url }
            : item,
        );
        for (const att of resolvedMedia.attachments ?? []) {
          if (!att) continue;
          const id = typeof att.id === "string" ? att.id : "";
          if (id && attachmentIdxById.has(id)) {
            mergedAttachments[attachmentIdxById.get(id)!] = att;
          } else {
            if (id) attachmentIdxById.set(id, mergedAttachments.length);
            mergedAttachments.push(att);
          }
        }
      } else {
        hydratedItems.push(item);
      }
    }
    return {
      ...media,
      items: hydratedItems,
      ...(mergedAttachments.length ? { attachments: mergedAttachments } : {}),
    };
  };

  return {
    getLastConnectionCheck: () => lastConnectionCheck,
    fetchApiJson,
    runTestConnection,
    fetchOwnerStats,
    parseYouTubeViaOffscreen,
    parseTikTokViaOffscreen,
    parseSupportedUrlInternal,
    resolveLazyItemInternal,
    hydrateDeferredMediaItems,
  };
}
