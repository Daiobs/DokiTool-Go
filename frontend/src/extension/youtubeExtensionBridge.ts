import * as mediabunny from "mediabunny";
import {
  YOUTUBE_HELPER_VERSION,
  YOUTUBE_OPFS_TEMP_PREFIX,
  createUserscriptController,
  downloadViaYouTubeHelper,
  muxDownloadViaYouTubeHelper,
  pingYouTubeHelper,
  requestYouTubePlayerViaHelper,
  type YouTubeHelperDownloadPayload,
  type YouTubeHelperMuxDownloadPayload,
  type YouTubeHelperPingResult,
  type YouTubeHelperPlayerPayload,
  type YouTubeHelperPlayerResult,
  type YouTubeHelperProgressDetail,
  type YouTubeHelperSaveMode,
} from "../utils/youtubeHelperCore";
import { isWhitelistedMediaUrl } from "./hostWhitelist";
import type {
  HandOffBlobDownloadResult,
  OffscreenToBackgroundMessage,
} from "./protocol";

/**
 * Browser-forbidden request header names that `fetch()` silently ignores or rejects,
 * and which Chrome MV3 Dynamic DNR Rules `1001` / `1002` inject or strip at the
 * network stack exclusively for `initiatorDomains: [chrome.runtime.id]`.
 */
export const FORBIDDEN_FETCH_HEADER_NAMES: ReadonlySet<string> = new Set([
  "user-agent",
  "origin",
  "referer",
  "cookie",
  "cookie2",
  "host",
  "connection",
  "content-length",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function sanitizeExtensionFetchHeaders(
  rawHeaders: unknown,
): Record<string, string> {
  const clean: Record<string, string> = {};
  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    return clean;
  }
  for (const [rawKey, rawVal] of Object.entries(
    rawHeaders as Record<string, unknown>,
  )) {
    if (typeof rawKey !== "string" || typeof rawVal !== "string") continue;
    const trimmedKey = rawKey.trim();
    if (!trimmedKey) continue;
    const lower = trimmedKey.toLowerCase();
    if (
      FORBIDDEN_FETCH_HEADER_NAMES.has(lower) ||
      lower.startsWith("sec-") ||
      lower.startsWith("proxy-")
    ) {
      continue;
    }
    clean[trimmedKey] = rawVal;
  }
  return clean;
}

export function serializeResponseHeaders(headers: Headers): string {
  const lines: string[] = [];
  headers.forEach((value, key) => {
    lines.push(`${key}: ${value}`);
  });
  return lines.join("\r\n");
}

export interface GmXhrDetailsLike {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  data?: BodyInit | null;
  responseType?: string;
  timeout?: number;
  anonymous?: boolean;
  onload?: (response: {
    status: number;
    statusText: string;
    finalUrl: string;
    responseHeaders: string;
    response: unknown;
    responseText: string;
  }) => void;
  onerror?: (error: unknown) => void;
  ontimeout?: () => void;
  onabort?: () => void;
}

export interface CreateFetchGmXhrAdapterOptions {
  fetchImpl?: typeof fetch;
  extraAllowedOrigins?: () => string[] | undefined;
}

/**
 * Adapts `GM_xmlhttpRequest` calls emitted by `youtubeHelperCore.js` into
 * cookie-free `fetch(..., { credentials: "omit", referrerPolicy: "no-referrer" })`
 * gated by `isWhitelistedMediaUrl`.
 */
export function createFetchGmXhrAdapter(
  options?: CreateFetchGmXhrAdapterOptions,
): (details: Record<string, unknown>) => { abort: () => void } {
  const resolveFetch = (): typeof fetch => {
    const fn = options?.fetchImpl ?? globalThis.fetch;
    if (typeof fn !== "function") {
      throw new Error("当前环境不支持 fetch");
    }
    return fn;
  };

  return (rawDetails: Record<string, unknown>) => {
    const details = rawDetails as unknown as GmXhrDetailsLike;
    const reqUrl = typeof details.url === "string" ? details.url.trim() : "";
    const method =
      typeof details.method === "string" && details.method.trim()
        ? details.method.trim().toUpperCase()
        : "GET";
    const responseType =
      typeof details.responseType === "string"
        ? details.responseType.trim().toLowerCase()
        : "text";
    const timeoutMs =
      typeof details.timeout === "number" &&
      Number.isFinite(details.timeout) &&
      details.timeout > 0
        ? Math.floor(details.timeout)
        : 0;

    const controller = new AbortController();
    let settled = false;
    let abortedByCaller = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        controller.abort(new Error("GM_XHR_TIMEOUT"));
      }, timeoutMs);
      (timeoutTimer as { unref?: () => void })?.unref?.();
    }

    void (async () => {
      try {
        const extraOrigins = options?.extraAllowedOrigins?.();
        const check = isWhitelistedMediaUrl(reqUrl, extraOrigins);
        if (!check.allowed) {
          throw new Error(
            check.reason || `请求目标不在扩展白名单内：${check.hostname || reqUrl}`,
          );
        }

        const cleanFetchHeaders = sanitizeExtensionFetchHeaders(details.headers);
        const hasBody =
          method !== "GET" &&
          method !== "HEAD" &&
          details.data !== undefined &&
          details.data !== null;

        const fetchFn = resolveFetch();
        const resp = await fetchFn(reqUrl, {
          method,
          headers: cleanFetchHeaders,
          ...(hasBody ? { body: details.data as BodyInit } : {}),
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });

        const finalUrl =
          typeof resp.url === "string" && resp.url.trim()
            ? resp.url.trim()
            : reqUrl;
        if (finalUrl !== reqUrl) {
          const redirectCheck = isWhitelistedMediaUrl(finalUrl, extraOrigins);
          if (!redirectCheck.allowed) {
            void resp.body?.cancel?.().catch(() => {});
            throw new Error(
              redirectCheck.reason ||
                `重定向地址不在扩展白名单内：${redirectCheck.hostname || finalUrl}`,
            );
          }
        }

        const serializedHeaders = serializeResponseHeaders(resp.headers);
        if (responseType === "arraybuffer") {
          const arrayBuffer = await resp.arrayBuffer();
          if (settled || abortedByCaller) return;
          settled = true;
          clearTimer();
          details.onload?.({
            status: resp.status,
            statusText: resp.statusText || "",
            finalUrl,
            responseHeaders: serializedHeaders,
            response: arrayBuffer,
            responseText: "",
          });
          return;
        }

        const text = await resp.text();
        if (settled || abortedByCaller) return;
        settled = true;
        clearTimer();
        details.onload?.({
          status: resp.status,
          statusText: resp.statusText || "",
          finalUrl,
          responseHeaders: serializedHeaders,
          response: text,
          responseText: text,
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimer();
        if (abortedByCaller) {
          details.onabort?.();
          return;
        }
        if (timedOut) {
          details.ontimeout?.();
          return;
        }
        details.onerror?.(err);
      }
    })();

    return {
      abort() {
        if (settled) return;
        abortedByCaller = true;
        clearTimer();
        controller.abort();
      },
    };
  };
}

export interface UrlObjectApiLike {
  createObjectURL(obj: Blob | File): string;
  revokeObjectURL(url: string): void;
}

export type HandoffBlobDownloadFn = (
  message: Extract<OffscreenToBackgroundMessage, { type: "HANDOFF_BLOB_DOWNLOAD" }>,
) => Promise<HandOffBlobDownloadResult | void>;

export interface YouTubeExtensionBridgeOptions {
  handoffBlobDownload: HandoffBlobDownloadFn;
  fetchImpl?: typeof fetch;
  opfsStorage?: StorageManager | Record<string, unknown> | null;
  webLocks?: LockManager | Record<string, unknown> | null;
  urlApi?: UrlObjectApiLike;
  now?: () => number;
  mediabunnyImpl?: Record<string, unknown> | null;
  muxConfig?: {
    chunkSize?: number;
    videoConcurrency?: number;
    audioConcurrency?: number;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    chunkTimeoutMs?: number;
    maxBufferBytes?: number;
  };
  extraAllowedOrigins?: () => string[] | undefined;
}

interface ActiveSlotMeta {
  slotKey: string;
  taskId: string;
  desiredRelativeFilename: string;
  signal?: AbortSignal;
}

interface PendingBlobEntry {
  taskId: string;
  blobUrl: string;
  opfsTempName?: string;
  resolve: () => void;
}

export interface YouTubeExtensionBridge {
  getHelperVersion(): string;
  ping(timeoutMs?: number): Promise<YouTubeHelperPingResult>;
  requestPlayer(
    payload: YouTubeHelperPlayerPayload,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<YouTubeHelperPlayerResult>;
  downloadDirect(params: {
    taskId: string;
    url: string;
    filename: string;
    sizeBytes?: number;
    signal?: AbortSignal;
    onProgress?: (detail: YouTubeHelperProgressDetail) => void;
  }): Promise<{ filename: string; mode?: YouTubeHelperSaveMode }>;
  downloadMux(params: {
    taskId: string;
    videoUrl: string;
    audioUrl: string;
    videoSize?: number;
    audioSize?: number;
    filename: string;
    outputContainer: "mp4" | "webm";
    signal?: AbortSignal;
    onProgress?: (detail: YouTubeHelperProgressDetail) => void;
  }): Promise<{ filename: string; mode: YouTubeHelperSaveMode }>;
  releaseBlob(params: { taskId?: string; blobUrl: string }): boolean;
  releaseBlobsForTask(taskId: string): number;
  getPendingBlobCount(): number;
  dispose(): void;
}

function extractYouTubeAllowedExtension(
  filename: string,
): ".mp4" | ".m4a" | ".webm" | null {
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith(".mp4")) return ".mp4";
  if (lower.endsWith(".m4a")) return ".m4a";
  if (lower.endsWith(".webm")) return ".webm";
  return null;
}

function parseSlotKeyFromCleanFilename(cleanFilename: string): string {
  const dotIdx = cleanFilename.lastIndexOf(".");
  return dotIdx > 0 ? cleanFilename.slice(0, dotIdx) : cleanFilename;
}

function parseSlotKeyFromTempName(tempName?: string): string {
  if (typeof tempName !== "string" || !tempName.startsWith(YOUTUBE_OPFS_TEMP_PREFIX)) {
    return "";
  }
  const rest = tempName.slice(YOUTUBE_OPFS_TEMP_PREFIX.length);
  const dashIdx = rest.indexOf("-");
  return dashIdx > 0 ? rest.slice(0, dashIdx) : "";
}

/**
 * Zero-diff extension bridge around `youtubeHelperCore.js` (`createUserscriptController`)
 * and `mediabunny`, wiring OPFS outputs directly to `HANDOFF_BLOB_DOWNLOAD` and waiting
 * for authoritative `RELEASE_BLOB` before revoking the Blob URL and deleting the OPFS temp file.
 */
export function createYouTubeExtensionBridge(
  options: YouTubeExtensionBridgeOptions,
): YouTubeExtensionBridge {
  const eventTarget = new EventTarget();
  const urlApi: UrlObjectApiLike = options.urlApi ?? globalThis.URL;
  const nowFn = options.now ?? (() => Date.now());

  const activeSlots = new Map<string, ActiveSlotMeta>();
  const pendingBlobs = new Map<string, PendingBlobEntry>();
  let slotCounter = 0;
  let disposed = false;

  const resolveSlotMeta = (
    cleanFilename: string,
    tempName?: string,
  ): ActiveSlotMeta | undefined => {
    const byTemp = parseSlotKeyFromTempName(tempName);
    if (byTemp && activeSlots.has(byTemp)) {
      return activeSlots.get(byTemp);
    }
    const byName = parseSlotKeyFromCleanFilename(cleanFilename);
    if (byName && activeSlots.has(byName)) {
      return activeSlots.get(byName);
    }
    return undefined;
  };

  const handoffAndAwaitAuthoritativeRelease = async (params: {
    blobOrFile: Blob | File;
    cleanFilename: string;
    mimeType: string;
    tempName?: string;
  }): Promise<void> => {
    if (disposed) {
      throw new Error("YouTube 扩展下载桥接器已释放");
    }
    const slotMeta = resolveSlotMeta(params.cleanFilename, params.tempName);
    if (!slotMeta) {
      throw new Error("未找到对应的 YouTube 下载任务上下文");
    }
    if (slotMeta.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const lowerDesired = slotMeta.desiredRelativeFilename.toLowerCase();
    const inferredMime = lowerDesired.endsWith(".webm")
      ? "video/webm"
      : lowerDesired.endsWith(".m4a")
        ? "audio/mp4"
        : "video/mp4";
    const rawMime =
      typeof params.mimeType === "string" ? params.mimeType.trim().toLowerCase() : "";
    const effectiveMime =
      rawMime && rawMime !== "text/plain" && rawMime !== "application/octet-stream"
        ? rawMime
        : inferredMime;
    const typedBlob =
      params.blobOrFile.type === effectiveMime
        ? params.blobOrFile
        : new Blob([params.blobOrFile], { type: effectiveMime });
    const blobUrl = urlApi.createObjectURL(typedBlob);
    let resolveRelease!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });

    pendingBlobs.set(blobUrl, {
      taskId: slotMeta.taskId,
      blobUrl,
      opfsTempName: params.tempName,
      resolve: resolveRelease,
    });

    try {
      await options.handoffBlobDownload({
        type: "HANDOFF_BLOB_DOWNLOAD",
        taskId: slotMeta.taskId,
        blobUrl,
        filename: slotMeta.desiredRelativeFilename,
        mimeType: params.mimeType,
        sizeBytes: params.blobOrFile.size,
        ...(params.tempName ? { opfsTempName: params.tempName } : {}),
      });
      await releasePromise;
    } finally {
      pendingBlobs.delete(blobUrl);
      try {
        urlApi.revokeObjectURL(blobUrl);
      } catch {
        // Ignore revoke errors
      }
    }
  };

  const gmXmlhttpRequest = createFetchGmXhrAdapter({
    fetchImpl: options.fetchImpl,
    extraAllowedOrigins: options.extraAllowedOrigins,
  });

  // Synthetic window facade that ensures `showSaveFilePicker` is never triggered in Offscreen
  // while providing standard `navigator.storage`, `navigator.locks`, `URL`, `Blob`, and `setTimeout`.
  const syntheticWindow = {
    navigator: {
      storage:
        options.opfsStorage ??
        (typeof navigator !== "undefined" ? navigator.storage : null),
      locks:
        options.webLocks ??
        (typeof navigator !== "undefined" ? navigator.locks : null),
    },
    URL: urlApi,
    Blob: globalThis.Blob,
    setTimeout: globalThis.setTimeout.bind(globalThis),
  };

  const controller = createUserscriptController({
    gmXmlhttpRequest,
    eventTarget,
    pageWindow: syntheticWindow as unknown as typeof globalThis,
    opfsStorage:
      options.opfsStorage ??
      (typeof navigator !== "undefined" ? navigator.storage : null),
    webLocks:
      options.webLocks ??
      (typeof navigator !== "undefined" ? navigator.locks : null),
    now: nowFn,
    version: YOUTUBE_HELPER_VERSION,
    mediabunny:
      options.mediabunnyImpl !== undefined
        ? options.mediabunnyImpl
        : (mediabunny as unknown as Record<string, unknown>),
    muxConfig: {
      ...options.muxConfig,
      // Authoritative cleanup: `saveOpfsFile` holds until `RELEASE_BLOB` arrives,
      // then `delayMs === 0` immediately removes the OPFS temp file and releases the Web Lock.
      opfsCleanupDelayMs: 0,
    },
    async saveOpfsFile(file, cleanFilename, mimeType, tempName) {
      await handoffAndAwaitAuthoritativeRelease({
        blobOrFile: file,
        cleanFilename,
        mimeType,
        tempName,
      });
    },
    async saveBuffer(arrayBuffer, cleanFilename, mimeType) {
      const blob = new Blob([arrayBuffer], { type: mimeType });
      await handoffAndAwaitAuthoritativeRelease({
        blobOrFile: blob,
        cleanFilename,
        mimeType,
      });
    },
  });

  const unmount = controller.mount();

  return {
    getHelperVersion(): string {
      return YOUTUBE_HELPER_VERSION;
    },

    ping(timeoutMs = 600): Promise<YouTubeHelperPingResult> {
      return pingYouTubeHelper({ timeoutMs, eventTarget });
    },

    requestPlayer(
      payload: YouTubeHelperPlayerPayload,
      reqOptions?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<YouTubeHelperPlayerResult> {
      return requestYouTubePlayerViaHelper(payload, {
        eventTarget,
        timeoutMs: reqOptions?.timeoutMs ?? 20_000,
        signal: reqOptions?.signal,
      });
    },

    async downloadDirect(params): Promise<{
      filename: string;
      mode?: YouTubeHelperSaveMode;
    }> {
      const desiredRelativeFilename = params.filename.trim();
      const ext = extractYouTubeAllowedExtension(desiredRelativeFilename);
      const slotKey = `ytk${++slotCounter}`;
      const internalFilename = ext
        ? `${slotKey}${ext}`
        : desiredRelativeFilename;

      activeSlots.set(slotKey, {
        slotKey,
        taskId: params.taskId,
        desiredRelativeFilename,
        signal: params.signal,
      });

      const payload: YouTubeHelperDownloadPayload = {
        url: params.url,
        filename: internalFilename,
        size: params.sizeBytes,
        taskId: slotKey,
        signal: params.signal,
        onProgress: params.onProgress,
      };

      try {
        const result = await downloadViaYouTubeHelper(payload, { eventTarget });
        return {
          filename: desiredRelativeFilename,
          mode: result.mode,
        };
      } finally {
        // Keep slot alive if a blob handoff is still waiting on RELEASE_BLOB after abort race
        const stillPending = Array.from(pendingBlobs.values()).some(
          (entry) => entry.taskId === params.taskId,
        );
        if (!stillPending) {
          activeSlots.delete(slotKey);
        } else {
          // Schedule deferred slot map cleanup once pending blobs for this task clear
          setTimeout(() => {
            const anyLeft = Array.from(pendingBlobs.values()).some(
              (entry) => entry.taskId === params.taskId,
            );
            if (!anyLeft) {
              activeSlots.delete(slotKey);
            }
          }, 0);
        }
      }
    },

    async downloadMux(params): Promise<{
      filename: string;
      mode: YouTubeHelperSaveMode;
    }> {
      const desiredRelativeFilename = params.filename.trim();
      const expectedExt = `.${params.outputContainer}` as ".mp4" | ".webm";
      const hasMatchingExt = desiredRelativeFilename
        .toLowerCase()
        .endsWith(expectedExt);
      const slotKey = `ytk${++slotCounter}`;
      const internalFilename = hasMatchingExt
        ? `${slotKey}${expectedExt}`
        : desiredRelativeFilename;

      activeSlots.set(slotKey, {
        slotKey,
        taskId: params.taskId,
        desiredRelativeFilename,
        signal: params.signal,
      });

      const payload: YouTubeHelperMuxDownloadPayload = {
        videoUrl: params.videoUrl,
        audioUrl: params.audioUrl,
        videoSize: params.videoSize,
        audioSize: params.audioSize,
        filename: internalFilename,
        outputContainer: params.outputContainer,
        taskId: slotKey,
        signal: params.signal,
        onProgress: params.onProgress,
      };

      try {
        const result = await muxDownloadViaYouTubeHelper(payload, {
          eventTarget,
        });
        return {
          filename: desiredRelativeFilename,
          mode: result.mode,
        };
      } finally {
        const stillPending = Array.from(pendingBlobs.values()).some(
          (entry) => entry.taskId === params.taskId,
        );
        if (!stillPending) {
          activeSlots.delete(slotKey);
        } else {
          setTimeout(() => {
            const anyLeft = Array.from(pendingBlobs.values()).some(
              (entry) => entry.taskId === params.taskId,
            );
            if (!anyLeft) {
              activeSlots.delete(slotKey);
            }
          }, 0);
        }
      }
    },

    releaseBlob(params: { taskId?: string; blobUrl: string }): boolean {
      const entry = pendingBlobs.get(params.blobUrl);
      if (!entry) {
        return false;
      }
      pendingBlobs.delete(params.blobUrl);
      entry.resolve();
      return true;
    },

    releaseBlobsForTask(taskId: string): number {
      let count = 0;
      for (const [blobUrl, entry] of Array.from(pendingBlobs.entries())) {
        if (entry.taskId === taskId) {
          pendingBlobs.delete(blobUrl);
          entry.resolve();
          count += 1;
        }
      }
      return count;
    },

    getPendingBlobCount(): number {
      return pendingBlobs.size;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [, entry] of Array.from(pendingBlobs.entries())) {
        entry.resolve();
      }
      pendingBlobs.clear();
      activeSlots.clear();
      unmount();
    },
  };
}
