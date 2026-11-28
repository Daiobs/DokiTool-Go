import { computed, ref, shallowRef, watch, type Ref } from "vue";
import { apiConfig } from "../services/apiConfig";
import type {
  parseTikTokViaExtension as parseTikTokViaExtensionFn,
  parseYouTubeViaExtension as parseYouTubeViaExtensionFn,
  pingInstalledExtension,
} from "../services/extensionBridge";
import type { useVideoStore } from "../stores/video";
import type {
  MediaItem,
  ToastType,
  UnifiedMedia,
} from "../types/media";

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
    this.status = status;
    if (retryAfterSeconds! > 0 && Number.isFinite(retryAfterSeconds)) {
      this.retry_after_seconds = Math.ceil(retryAfterSeconds!);
    }
    this.code = code;
  }
}

function parseRetryAfterSeconds(
  response: Response,
  payload?: unknown,
): number | undefined {
  if (response.status !== 429) return undefined;
  for (const v of [
    (payload as any)?.error?.retry_after_seconds,
    response.headers.get("Retry-After"),
  ]) {
    const n = Number(v);
    if (n > 0 && Number.isFinite(n)) return Math.ceil(n);
  }
  return undefined;
}

export async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  onRateLimitWait?: (seconds: number) => void,
): Promise<T> {
  const abortErr = () =>
    signal?.reason ?? new DOMException("Aborted", "AbortError");
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortErr();
    try {
      return await operation();
    } catch (error: any) {
      if (error?.rateLimitRetried) throw error;
      const wait = error?.retry_after_seconds;
      if (error?.status !== 429 || !(wait > 0 && wait <= 15) || attempt >= 2) {
        if (error?.status === 429 && !Object.isFrozen(error)) {
          error.rateLimitRetried = true;
        }
        throw error;
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
          signal?.addEventListener("abort", stop, { once: true });
          if (signal?.aborted) stop();
        });
      }
    }
  }
}

export async function fetchJSON(
  url: string,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("解析请求超时，请重试")),
    75000,
  );
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => {
      throw new HttpStatusError(
        `接口返回无效数据（HTTP ${response.status}）`,
        response.status,
        parseRetryAfterSeconds(response),
      );
    });
    if (!response.ok)
      throw new HttpStatusError(
        (payload as any)?.error?.message || `解析失败（HTTP ${response.status}）`,
        response.status,
        parseRetryAfterSeconds(response, payload),
        (payload as any)?.error?.code || (payload as any)?.code,
      );
    return payload;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function resolveApiUrl(raw: string): string {
  if (!raw.startsWith("/api/resolve?") || /[\\\s#]/.test(raw))
    throw new Error("条目解析地址无效");
  return (
    apiConfig.baseUrl +
    raw +
    (new URLSearchParams(raw.split("?")[1]).has("schema_version")
      ? ""
      : "&schema_version=1.0")
  );
}

export function resolveRefreshApiUrl(raw: string): string {
  if (
    typeof raw !== "string" ||
    (!raw.startsWith("/api/resolve?") && !raw.startsWith("/api/parse?")) ||
    /[\\\s#]/.test(raw) ||
    raw.includes("..")
  ) {
    throw new Error("条目刷新地址无效");
  }
  const queryPart = raw.slice(raw.indexOf("?") + 1);
  return (
    apiConfig.baseUrl +
    raw +
    (new URLSearchParams(queryPart).has("schema_version")
      ? ""
      : "&schema_version=1.0")
  );
}
export function useVideoParser(options: {
  videoStore: ReturnType<typeof useVideoStore>;
  locale: Ref<string>;
  showToast: (message: string, type?: ToastType, duration?: number) => unknown;
  pingExtension?: typeof pingInstalledExtension;
  parseYouTubeViaExtension?: typeof parseYouTubeViaExtensionFn;
  parseTikTokViaExtension?: typeof parseTikTokViaExtensionFn;
}) {
  const { videoStore, showToast } = options;
  const pingExtension: typeof pingInstalledExtension =
    options.pingExtension ??
    (async (...args) => {
      const { pingInstalledExtension: ping } = await import(
        "../services/extensionBridge"
      );
      return ping(...args);
    });
  const parseYouTubeViaExtension: typeof parseYouTubeViaExtensionFn =
    options.parseYouTubeViaExtension ??
    (async (...args) => {
      const { parseYouTubeViaExtension: parse } = await import(
        "../services/extensionBridge"
      );
      return parse(...args);
    });
  const parseTikTokViaExtension: typeof parseTikTokViaExtensionFn =
    options.parseTikTokViaExtension ??
    (async (...args) => {
      const { parseTikTokViaExtension: parse } = await import(
        "../services/extensionBridge"
      );
      return parse(...args);
    });

  const inputUrl = shallowRef(""),
    parseError = shallowRef(""),
    parseStatusText = shallowRef(""),
    currentPlatform = shallowRef("all"),
    platformMismatchDetected = shallowRef(false),
    extensionErrorAction = shallowRef<"" | "install" | "upgrade">("");
  const parseButtonState = ref<string>("idle");
  const parseButtonError = ref<Error | null>(null);
  const parseButton = {
    state: parseButtonState,
    error: parseButtonError,
    isLoading: computed(() => parseButtonState.value === "loading"),
    isDisabled: computed(
      () =>
        parseButtonState.value === "loading" ||
        parseButtonState.value === "disabled",
    ),
    canClick: computed(
      () =>
        parseButtonState.value === "idle" || parseButtonState.value === "error",
    ),
    reset: () => {
      parseButtonState.value = "idle";
      parseButtonError.value = null;
    },
    setLoading: (loading: boolean) => {
      parseButtonState.value = loading ? "loading" : "idle";
    },
  };
  let generation = 0,
    active: AbortController | null = null;
  const invalidate = () => {
    generation++;
    active?.abort();
    active = null;
    parseButton.reset();
    parseError.value = "";
    parseStatusText.value = "";
    platformMismatchDetected.value = false;
    extensionErrorAction.value = "";
    videoStore.clearResult();
  };
  watch([inputUrl, currentPlatform], invalidate, { flush: "sync" });

  async function requestStandardParse(
    url: string,
    signal: AbortSignal,
  ): Promise<UnifiedMedia> {
    const payloadPromise =
      apiConfig.mode === "secure"
        ? import("../services/secureApiClient").then(({ secureApiClient }) =>
            secureApiClient!.parse(
              {
                url,
                platform: currentPlatform.value,
                locale: options.locale.value === "en" ? "en" : "zh-CN",
                schema_version: "1.0",
              },
              { signal },
            ),
          )
        : fetchJSON(
            `${apiConfig.parseUrl}?schema_version=1.0&platform=${encodeURIComponent(currentPlatform.value)}&url=${encodeURIComponent(url)}`,
            signal,
          );
    const [payload, { validateMediaEnvelope }, { withTbvideoItems }] =
      await Promise.all([
        payloadPromise,
        import("../utils/mediaContract"),
        import("../services/tbvideo"),
      ]);
    return withTbvideoItems(validateMediaEnvelope(payload));
  }

  async function parseYouTubeWithHelper(
    _url: string,
    videoId: string,
    run: number,
    controller: AbortController,
  ): Promise<void> {
    const { runYouTubeHelperParse } = await import("../utils/parseHelpers");
    if (run !== generation || controller.signal.aborted) return;
    await runYouTubeHelperParse({
      videoId,
      locale: options.locale.value,
      signal: controller.signal,
      isCurrent: () => run === generation && !controller.signal.aborted,
      pingExtension,
      parseYouTubeViaExtension,
      onHelperReady: () => {},
      onStageChange: (_stage, statusText) => {
        if (run === generation && !controller.signal.aborted) {
          parseStatusText.value = statusText;
        }
      },
      setResult: (media) => videoStore.setResult(media),
      setError: (msg, duration) => {
        parseError.value = msg;
        showToast(msg, "error", duration);
      },
    });
  }

  async function parseTikTokWithHelper(
    url: string,
    run: number,
    controller: AbortController,
  ): Promise<void> {
    const { runTikTokHelperParse } = await import("../utils/parseHelpers");
    if (run !== generation || controller.signal.aborted) return;
    await runTikTokHelperParse({
      url,
      locale: options.locale.value,
      signal: controller.signal,
      isCurrent: () => run === generation && !controller.signal.aborted,
      pingExtension,
      parseTikTokViaExtension,
      requestStandardParse,
      onStageChange: (_stage, statusText) => {
        if (run === generation && !controller.signal.aborted) {
          parseStatusText.value = statusText;
        }
      },
      onExtensionAction: (action) => {
        if (run === generation && !controller.signal.aborted) {
          extensionErrorAction.value = action;
        }
      },
      setResult: (media) => videoStore.setResult(media),
      setError: (msg, duration) => {
        parseError.value = msg;
        showToast(msg, "error", duration);
      },
    });
  }

  async function parseVideo() {
    if (active) return;
    const extracted = (
      inputUrl.value
        .match(
          /https?:\/\/[^\s<>"'\p{Script=Han}\u2014\u2018-\u201D\u2026\u203B\u3000-\u303F\uFE10-\uFE1F\uFE30-\uFE6F\uFF00-\uFFEF]+/iu,
        )?.[0]
        .replace(/[.,;!?]+$/, "") || inputUrl.value
    ).trim();
    const hashIdx = extracted.indexOf("#");
    const url = (hashIdx >= 0 ? extracted.slice(0, hashIdx) : extracted)
      .replace(/[.,;!?]+$/, "")
      .trim();
    let parsedHost = "";
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname)
        throw new Error();
      parsedHost = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    } catch {
      invalidate();
      parseError.value = "请输入有效分享链接";
      return;
    }
    if (url !== inputUrl.value) inputUrl.value = url;
    const isEn = options.locale.value === "en";
    const mismatchMsg = isEn
      ? 'Link does not match the selected platform. Please switch back to "All".'
      : "链接与所选平台不匹配，请切回「所有平台」再试";
    const run = ++generation,
      controller = new AbortController();
    active = controller;
    videoStore.clearResult();
    parseError.value = "";
    parseStatusText.value = "";
    platformMismatchDetected.value = false;
    extensionErrorAction.value = "";
    parseButton.setLoading(true);
    try {
      if (currentPlatform.value !== "all") {
        const { detectUrlPlatform } = await import("../utils/parseHelpers");
        if (run !== generation || controller.signal.aborted) return;
        const detected = detectUrlPlatform(url);
        if (detected && detected !== currentPlatform.value) {
          invalidate();
          parseError.value = mismatchMsg;
          platformMismatchDetected.value = true;
          showToast(mismatchMsg, "error");
          return;
        }
      }
      let youtubeVideoId = "";
      if (
        (currentPlatform.value === "all" ||
          currentPlatform.value === "youtube") &&
        /(?:youtube\.com|youtu\.be)/i.test(url)
      ) {
        const { extractYouTubeVideoId } = await import(
          "../utils/youtubeHelperCore"
        );
        if (run !== generation || controller.signal.aborted) return;
        youtubeVideoId = extractYouTubeVideoId(url);
      }
      if (youtubeVideoId) {
        await parseYouTubeWithHelper(url, youtubeVideoId, run, controller);
      } else if (
        (currentPlatform.value === "all" ||
          currentPlatform.value === "tiktok") &&
        (parsedHost === "tiktok.com" || parsedHost.endsWith(".tiktok.com"))
      ) {
        await parseTikTokWithHelper(url, run, controller);
      } else {
        const data = await requestStandardParse(url, controller.signal);
        if (run === generation && !controller.signal.aborted)
          videoStore.setResult(data);
      }
    } catch (error) {
      if (run !== generation || controller.signal.aborted) return;
      const rawMsg = error instanceof Error ? error.message : "解析失败";
      const isMismatch =
        currentPlatform.value !== "all" &&
        ((error instanceof HttpStatusError &&
          error.code === "PLATFORM_MISMATCH") ||
          /对应平台|平台不匹配|platform mismatch/i.test(rawMsg));
      platformMismatchDetected.value = isMismatch;
      parseError.value =
        isMismatch && (isEn || !rawMsg.includes("所有平台"))
          ? mismatchMsg
          : rawMsg;
      showToast(parseError.value, "error");
    } finally {
      if (run === generation) {
        active = null;
        parseStatusText.value = "";
        parseButton.reset();
      }
    }
  }
  async function switchToAllAndRetry(): Promise<void> {
    const preservedUrl = inputUrl.value;
    currentPlatform.value = "all";
    if (inputUrl.value !== preservedUrl) {
      inputUrl.value = preservedUrl;
    }
    platformMismatchDetected.value = false;
    if (inputUrl.value.trim()) {
      await parseVideo();
    }
  }
  function cancelParse(): void {
    if (active) invalidate();
  }
  async function resolveItem(
    item: MediaItem,
    signal?: AbortSignal,
    options?: {
      onRateLimitWait?: (seconds: number) => void;
      refreshUrl?: string;
    },
  ): Promise<MediaItem> {
    if (item.state === "unavailable") throw new Error(item.error.message);
    const rawResolveUrl = item.resolve_url?.trim() || "";
    const rawRefreshUrl = !rawResolveUrl
      ? options?.refreshUrl?.trim() || ""
      : "";
    if (!rawResolveUrl && !rawRefreshUrl) {
      const { readyItem } = await import("../utils/mediaContract");
      if (readyItem(item)) return item;
      throw new Error("条目缺少解析入口");
    }
    const url = rawResolveUrl
      ? resolveApiUrl(rawResolveUrl)
      : resolveRefreshApiUrl(rawRefreshUrl);
    const [rawPayload, { validateMediaEnvelope }, { withTbvideoItems }] =
      await Promise.all([
        withRateLimitRetry(
          () => fetchJSON(url, signal),
          signal,
          options?.onRateLimitWait,
        ),
        import("../utils/mediaContract"),
        import("../services/tbvideo"),
      ]);
    const data = withTbvideoItems(validateMediaEnvelope(rawPayload));
    const exactMatch = data.items.find((candidate) => candidate.id === item.id);
    const resolved =
      exactMatch ??
      (!rawResolveUrl &&
      data.items.length === 1 &&
      data.items[0].type === item.type
        ? { ...data.items[0], id: item.id }
        : undefined);
    if (!resolved) throw new Error("解析响应缺少所请求条目");
    return resolved;
  }
  return {
    inputUrl,
    parseError,
    parseStatusText,
    currentPlatform,
    platformMismatchDetected,
    extensionErrorAction,
    parseButton,
    parseVideo,
    switchToAllAndRetry,
    cancelParse,
    resolveItem,
    selectPlatform: (platform: string) => {
      currentPlatform.value = platform;
    },
  };
}
