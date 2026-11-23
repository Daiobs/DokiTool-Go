import { isWhitelistedMediaUrl, validateApiBaseUrl } from "./hostWhitelist";
import type { OffscreenDownloadSpec } from "./protocol";

export const OPFS_QUOTA_EXCEEDED_MESSAGE =
  "浏览器临时存储空间不足（无损合流约需 2 倍文件体积的可用空间），请清理磁盘空间后重试";

export const DEFAULT_MAX_RANGE_RESUME_ATTEMPTS = 3;
export const DEFAULT_RANGE_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_RANGE_CONCURRENCY_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const DEFAULT_DIRECT_FILE_MAX_CONCURRENCY = 4;
export const DEFAULT_DASH_VIDEO_MAX_CONCURRENCY = 3;
export const DEFAULT_DASH_AUDIO_MAX_CONCURRENCY = 1;
export const DEFAULT_MAX_CHUNK_RETRIES = 3;

export class ExtensionDownloadError extends Error {
  code?: string;
  httpStatus?: number;
  cancelled?: boolean;
  unwhitelistedHost?: string;
  fallbackUrl?: string;

  constructor(
    message: string,
    extra?: {
      code?: string;
      httpStatus?: number;
      cancelled?: boolean;
      unwhitelistedHost?: string;
      fallbackUrl?: string;
    },
  ) {
    super(message);
    this.name = extra?.cancelled ? "AbortError" : "ExtensionDownloadError";
    this.code = extra?.code;
    this.httpStatus = extra?.httpStatus;
    this.cancelled = extra?.cancelled;
    this.unwhitelistedHost = extra?.unwhitelistedHost;
    this.fallbackUrl = extra?.fallbackUrl;
  }
}

export interface OpfsWritableChunk {
  type: "write";
  data: Uint8Array;
  position?: number;
}

export interface OpfsWritableLike {
  write(chunk: Uint8Array | OpfsWritableChunk): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
  getWriter?(): WritableStreamDefaultWriter<unknown>;
}

export interface OpfsFileHandleLike {
  getFile(): Promise<File | Blob>;
  createWritable(): Promise<OpfsWritableLike>;
}

export interface OpfsDirectoryLike {
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsFileHandleLike>;
  removeEntry(name: string): Promise<void>;
  keys?(): AsyncIterable<string>;
  entries?(): AsyncIterable<[string, unknown]>;
  values?(): AsyncIterable<{ name?: string }>;
}

export interface OpfsStorageLike {
  getDirectory(): Promise<OpfsDirectoryLike>;
  estimate?(): Promise<{ quota?: number; usage?: number }>;
}

export interface WebLocksLike {
  request<T>(
    name: string,
    options: { mode?: "exclusive" | "shared"; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T> | T,
  ): Promise<T>;
}

export interface OpfsSinkLike {
  tempName?: string;
  rawWritable?: OpfsWritableLike;
  write(chunk: Uint8Array): Promise<void>;
  writeAt?(position: number, chunk: Uint8Array): Promise<void>;
  markWritableClosed?(): void;
  closeAndGetBlob(): Promise<Blob | File>;
  cleanup(reason?: unknown): Promise<void>;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ExtensionDownloadError("已取消", {
      code: "USER_CANCELLED",
      cancelled: true,
    });
  }
}

export function isAbortLikeError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string; cancelled?: boolean };
  return (
    e.cancelled === true ||
    e.name === "AbortError" ||
    e.code === "USER_CANCELLED"
  );
}

/**
 * Checks OPFS quota headroom via `storage.estimate()` before allocating
 * multi-file OPFS temp artifacts (e.g. 2x peak footprint during DASH muxing).
 */
export async function ensureOpfsQuotaAvailable(
  opfsStorage: OpfsStorageLike | StorageManager | null | undefined,
  requiredBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal) throwIfAborted(signal);
  if (
    !opfsStorage ||
    typeof opfsStorage.estimate !== "function" ||
    !Number.isFinite(requiredBytes) ||
    requiredBytes <= 0
  ) {
    return;
  }

  let est: { quota?: number; usage?: number } | null | undefined;
  try {
    est = await opfsStorage.estimate();
  } catch {
    return;
  }
  if (signal) throwIfAborted(signal);

  const quota = est?.quota;
  if (typeof quota !== "number" || !Number.isFinite(quota) || quota <= 0) {
    return;
  }
  const rawUsage = est?.usage;
  const usage =
    typeof rawUsage === "number" && Number.isFinite(rawUsage) && rawUsage > 0
      ? rawUsage
      : 0;
  const available = Math.max(0, quota - usage);
  if (available < requiredBytes) {
    throw new ExtensionDownloadError(OPFS_QUOTA_EXCEEDED_MESSAGE, {
      code: "OPFS_QUOTA_EXCEEDED",
    });
  }
}

export function buildEffectiveExtraOrigins(
  apiOrigin: string,
  extraAllowedOrigins?: string[],
): string[] {
  const set = new Set<string>();
  const validated = validateApiBaseUrl(apiOrigin);
  if (validated.ok) {
    set.add(validated.origin);
  }
  for (const extra of extraAllowedOrigins ?? []) {
    if (typeof extra === "string" && extra.trim()) {
      set.add(extra.trim());
    }
  }
  return Array.from(set);
}

export function assertWhitelistedUrl(
  rawUrl: string,
  spec: OffscreenDownloadSpec,
): void {
  const allowedOrigins = buildEffectiveExtraOrigins(
    spec.apiOrigin,
    spec.extraAllowedOrigins,
  );
  const check = isWhitelistedMediaUrl(rawUrl, allowedOrigins);
  if (!check.allowed) {
    throw new ExtensionDownloadError(
      check.reason || `媒体域名 ${check.hostname || "未知"} 未收录于扩展白名单`,
      {
        code: "UNWHITELISTED_CDN",
        unwhitelistedHost: check.hostname || undefined,
        fallbackUrl: rawUrl,
      },
    );
  }
}

export async function whitelistedFetch(
  fetchFn: typeof fetch,
  rawUrl: string,
  spec: OffscreenDownloadSpec,
  init: RequestInit | undefined,
  signal: AbortSignal,
): Promise<Response> {
  throwIfAborted(signal);
  assertWhitelistedUrl(rawUrl, spec);

  const resp = await fetchFn(rawUrl, {
    ...init,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });

  const finalUrl =
    typeof resp.url === "string" && resp.url.trim()
      ? resp.url.trim()
      : rawUrl;
  if (finalUrl !== rawUrl) {
    const allowedOrigins = buildEffectiveExtraOrigins(
      spec.apiOrigin,
      spec.extraAllowedOrigins,
    );
    const redirectCheck = isWhitelistedMediaUrl(finalUrl, allowedOrigins);
    if (!redirectCheck.allowed) {
      void resp.body?.cancel?.().catch(() => {});
      throw new ExtensionDownloadError(
        redirectCheck.reason ||
          `重定向媒体域名 ${redirectCheck.hostname || "未知"} 未收录于扩展白名单`,
        {
          code: "UNWHITELISTED_CDN",
          unwhitelistedHost: redirectCheck.hostname || undefined,
          fallbackUrl: rawUrl,
        },
      );
    }
  }

  return resp;
}

const EXT_TO_BLOB_MIME: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  ts: "video/mp2t",
  m4a: "audio/x-m4a",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  zip: "application/zip",
};

export function resolveBlobMimeType(
  filename: string,
  explicitMime?: string,
): string {
  const dotIdx = filename.lastIndexOf(".");
  const ext =
    dotIdx >= 0 ? filename.slice(dotIdx + 1).trim().toLowerCase() : "";
  const cleanExplicit =
    typeof explicitMime === "string" ? explicitMime.trim().toLowerCase() : "";
  // Chromium's DownloadTargetDeterminer maps `audio/mp4` to `.mp4` on macOS
  // and silently rewrites `.m4a` downloads to `.mp4`. Using `audio/x-m4a`
  // preserves the `.m4a` extension cleanly across macOS/Linux/Windows.
  if (ext === "m4a" && (!cleanExplicit || cleanExplicit === "audio/mp4")) {
    return "audio/x-m4a";
  }
  if (
    cleanExplicit &&
    cleanExplicit !== "text/plain" &&
    cleanExplicit !== "application/octet-stream"
  ) {
    return cleanExplicit;
  }
  return EXT_TO_BLOB_MIME[ext] || cleanExplicit || "application/octet-stream";
}

/**
 * Validates that a response prefix begins with a genuine ISO BMFF box header
 * (for Huawei OBS / Bilibili CDN `.m4s` streams mislabeled as `application/json`),
 * while strictly rejecting JSON/HTML text payloads even if crafted with `ftyp` at bytes 4..7.
 */
export function hasIsoBmffBoxHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  // Reject obvious JSON/HTML/whitespace leading bytes before reading big-endian boxSize
  const first = bytes[0];
  if (
    first === 0x7b || // '{'
    first === 0x5b || // '['
    first === 0x22 || // '"'
    first === 0x3c || // '<'
    first === 0x20 || // ' '
    first === 0x09 || // '\t'
    first === 0x0a || // '\n'
    first === 0x0d // '\r'
  ) {
    return false;
  }
  const boxSize =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (boxSize !== 1 && boxSize < 8) return false;
  const boxType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  // Structural header boxes (ftyp/styp/sidx/free/skip/wide) never exceed 64 MiB
  if (
    boxType !== "mdat" &&
    boxType !== "moov" &&
    boxType !== "moof" &&
    boxSize > 64 * 1024 * 1024
  ) {
    return false;
  }
  return (
    boxType === "ftyp" ||
    boxType === "styp" ||
    boxType === "moov" ||
    boxType === "moof" ||
    boxType === "sidx" ||
    boxType === "free" ||
    boxType === "skip" ||
    boxType === "wide" ||
    boxType === "mdat"
  );
}

export interface ParsedContentRange {
  start: number;
  end: number;
  total: number;
}

/**
 * Strictly parses an HTTP `Content-Range: bytes <start>-<end>/<total>` header
 * with an exact numeric `<total>` (rejecting `*` or invalid spans).
 */
export function parseContentRangeHeader(
  rawHeader: string | null | undefined,
): ParsedContentRange | null {
  if (typeof rawHeader !== "string") return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(rawHeader.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= 0 ||
    end >= total
  ) {
    return null;
  }
  return { start, end, total };
}

function hasNonIdentityContentEncoding(headers: Headers): boolean {
  const raw = headers.get("Content-Encoding")?.trim().toLowerCase() ?? "";
  return raw !== "" && raw !== "identity";
}

function parseContentLengthHeader(
  headers: Headers,
  hasNonIdentityEncoding: boolean,
): number {
  if (hasNonIdentityEncoding) return 0;
  const raw = headers.get("Content-Length")?.trim() ?? "";
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * Returns true when `routeUrl` points to a `/api/` relay endpoint on the same
 * origin as `apiOrigin` (so multi-Range concurrency is strictly capped at `1`
 * to protect Tokyo's bounded `MediaRelay` pool).
 */
export function isSameOriginApiRoute(
  routeUrl: string,
  apiOrigin?: string | null,
): boolean {
  if (typeof routeUrl !== "string") return false;
  const trimmedRoute = routeUrl.trim();
  if (!trimmedRoute) return false;
  if (trimmedRoute.startsWith("/api/") || trimmedRoute === "/api") {
    return true;
  }
  if (typeof apiOrigin !== "string" || !apiOrigin.trim()) {
    return false;
  }
  let parsedRoute: URL;
  let parsedApi: URL;
  try {
    parsedRoute = new URL(trimmedRoute);
    parsedApi = new URL(apiOrigin.trim());
  } catch {
    return false;
  }
  if (parsedRoute.origin.toLowerCase() !== parsedApi.origin.toLowerCase()) {
    return false;
  }
  const path = parsedRoute.pathname.toLowerCase();
  return path.startsWith("/api/") || path === "/api";
}

function normalizeMaxConcurrency(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    return 1;
  }
  return Math.max(1, Math.min(4, Math.floor(raw)));
}

function normalizePositiveInt(
  raw: number | undefined,
  fallback: number,
): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    return Math.floor(raw);
  }
  return fallback;
}

function normalizeNonNegativeInt(
  raw: number | undefined,
  fallback: number,
): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return fallback;
}

export interface StreamResponseBodyParams {
  response: Response;
  write: (chunk: Uint8Array) => Promise<void>;
  signal: AbortSignal;
  onBytes?: (chunkBytes: number, totalLoadedForStream: number) => void;
  onFirstBytesVerified?: () => void;
  onSinkWriteError?: () => void;
  expectedBytes?: number;
  maxBytes?: number;
  maxBytesError?: string;
  verifyFirstBytes?: (prefix: Uint8Array) => void;
}

export async function streamResponseBodyToWriter(
  params: StreamResponseBodyParams,
): Promise<number> {
  const {
    response,
    write,
    signal,
    onBytes,
    onFirstBytesVerified,
    onSinkWriteError,
    expectedBytes,
    maxBytes,
    maxBytesError,
    verifyFirstBytes,
  } = params;
  const hasContentEncoding = hasNonIdentityContentEncoding(response.headers);
  const headerDeclaredLen = parseContentLengthHeader(
    response.headers,
    hasContentEncoding,
  );
  const declaredLen =
    typeof expectedBytes === "number" &&
    Number.isSafeInteger(expectedBytes) &&
    expectedBytes > 0
      ? expectedBytes
      : headerDeclaredLen;

  if (maxBytes !== undefined && declaredLen > maxBytes) {
    void response.body?.cancel?.().catch(() => {});
    throw new ExtensionDownloadError(maxBytesError || "文件大小超出上限");
  }

  const safeWrite = async (chunk: Uint8Array) => {
    try {
      await write(chunk);
    } catch (writeErr) {
      onSinkWriteError?.();
      throw writeErr;
    }
  };

  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    throwIfAborted(signal);
    if (maxBytes !== undefined && buf.byteLength > maxBytes) {
      throw new ExtensionDownloadError(maxBytesError || "文件大小超出上限");
    }
    if (buf.byteLength === 0) {
      throw new ExtensionDownloadError("媒体响应内容为空");
    }
    if (verifyFirstBytes) {
      verifyFirstBytes(buf.subarray(0, Math.min(16, buf.byteLength)));
      onFirstBytesVerified?.();
    }
    await safeWrite(buf);
    onBytes?.(buf.byteLength, buf.byteLength);
    if (declaredLen > 0 && buf.byteLength !== declaredLen) {
      throw new ExtensionDownloadError(
        `媒体流提前中断（已收 ${buf.byteLength} / 预期 ${declaredLen} 字节）`,
        {
          code:
            buf.byteLength > declaredLen
              ? "STREAM_OVERFLOW"
              : "STREAM_TRUNCATED",
        },
      );
    }
    return buf.byteLength;
  }

  const reader = response.body.getReader();
  let streamLoaded = 0;
  let writtenBytes = 0;
  let finishedCleanly = false;
  let verifiedFirstBytes = !verifyFirstBytes;
  const sniffChunks: Uint8Array[] = [];
  let sniffBytes = 0;
  let rejectOnAbort: (() => void) | null = null;
  const abortRace = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => {
      void reader.cancel().catch(() => {});
      reject(
        new ExtensionDownloadError("已取消", {
          code: "USER_CANCELLED",
          cancelled: true,
        }),
      );
    };
    if (signal.aborted) {
      rejectOnAbort();
    } else {
      signal.addEventListener("abort", rejectOnAbort, { once: true });
    }
  });
  // Prevent unhandled rejection when stream finishes normally without abort
  void abortRace.catch(() => {});

  const flushSniffedChunks = async () => {
    if (verifiedFirstBytes) return;
    verifiedFirstBytes = true;
    const sampleLen = Math.min(16, sniffBytes);
    const sample = new Uint8Array(sampleLen);
    let off = 0;
    for (const part of sniffChunks) {
      if (off >= sampleLen) break;
      const take = Math.min(part.byteLength, sampleLen - off);
      sample.set(part.subarray(0, take), off);
      off += take;
    }
    verifyFirstBytes!(sample);
    onFirstBytesVerified?.();
    for (const part of sniffChunks) {
      await safeWrite(part);
      writtenBytes += part.byteLength;
      onBytes?.(part.byteLength, writtenBytes);
    }
    sniffChunks.length = 0;
  };

  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await Promise.race([reader.read(), abortRace]);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      throwIfAborted(signal);
      streamLoaded += value.byteLength;
      if (maxBytes !== undefined && streamLoaded > maxBytes) {
        throw new ExtensionDownloadError(maxBytesError || "文件大小超出上限");
      }
      if (declaredLen > 0 && streamLoaded > declaredLen) {
        throw new ExtensionDownloadError(
          `媒体流字节数超出预期（已收 ${streamLoaded} / 预期 ${declaredLen} 字节）`,
          { code: "STREAM_OVERFLOW" },
        );
      }
      if (!verifiedFirstBytes) {
        sniffChunks.push(value);
        sniffBytes += value.byteLength;
        if (sniffBytes >= 16) {
          await flushSniffedChunks();
        }
      } else {
        await safeWrite(value);
        writtenBytes += value.byteLength;
        onBytes?.(value.byteLength, writtenBytes);
      }
    }
    throwIfAborted(signal);
    if (streamLoaded === 0) {
      throw new ExtensionDownloadError("媒体流返回 0 字节");
    }
    if (!verifiedFirstBytes) {
      await flushSniffedChunks();
    }
    if (declaredLen > 0 && writtenBytes !== declaredLen) {
      throw new ExtensionDownloadError(
        `媒体流提前中断（已收 ${writtenBytes} / 预期 ${declaredLen} 字节）`,
        {
          code:
            writtenBytes > declaredLen
              ? "STREAM_OVERFLOW"
              : "STREAM_TRUNCATED",
        },
      );
    }
    finishedCleanly = true;
    return writtenBytes;
  } finally {
    if (rejectOnAbort) {
      signal.removeEventListener("abort", rejectOnAbort);
    }
    if (!finishedCleanly) {
      void reader.cancel().catch(() => {});
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore
    }
  }
}

export interface StreamResumableRouteToOpfsParams {
  taskId: string;
  routes: string[];
  spec: OffscreenDownloadSpec;
  fetchFn: typeof fetch;
  openOpfsSink: (
    taskId: string,
    mimeType?: string,
    tag?: string,
  ) => Promise<OpfsSinkLike>;
  signal: AbortSignal;
  estimatedSize?: number;
  sinkMimeType?: string;
  sinkTag?: string;
  errorLabel?: string;
  maxResumeAttempts?: number;
  maxConcurrency?: number;
  rangeChunkSizeBytes?: number;
  minParallelRangeBytes?: number;
  maxChunkRetries?: number;
  apiOrigin?: string;
  onRouteStart?: (info: {
    routeIndex: number;
    routeCount: number;
    total: number;
    isFreshRetry: boolean;
  }) => void;
  onProgress?: (info: {
    loaded: number;
    total: number;
    resumed: boolean;
  }) => void;
}

export interface StreamResumableRouteToOpfsResult {
  sink: OpfsSinkLike;
  byteLength: number;
  total: number;
  contentType: string;
  route: string;
  resumedCount: number;
  parallelUsed?: boolean;
  chunkCount?: number;
}

function isExpiredHttpStatusError(err: unknown): err is ExtensionDownloadError {
  return (
    err instanceof ExtensionDownloadError &&
    (err.httpStatus === 403 || err.httpStatus === 410)
  );
}

/**
 * Streams a media resource from ordered candidate routes into a single OPFS sink,
 * supporting:
 * - Zero-waste initial HTTP `206` Range probing + bounded multi-Range concurrent
 *   chunk downloads (`writeAt`) for large files (`>= minParallelRangeBytes`) on
 *   non-relay CDN routes (`<= 4` connections, `/api/` relay strictly capped at `1`),
 * - Seamless `1x` fallback when a server ignores `Range` (`200 OK`), returns
 *   `total < minParallelRangeBytes`, or responds with `416` / malformed `206`,
 * - Bounded in-place HTTP `206` `Range` resume on mid-stream network drops or
 *   premature EOF (with strict `Content-Range` start + total validation and safe
 *   0-byte cleanup fallback on non-`206` / mismatched responses).
 *
 * Shared by both `direct_file` and `dash_mux` track downloads.
 */
export async function streamResumableRouteToOpfs(
  params: StreamResumableRouteToOpfsParams,
): Promise<StreamResumableRouteToOpfsResult> {
  const {
    taskId,
    routes,
    spec,
    fetchFn,
    openOpfsSink,
    signal,
    estimatedSize,
    sinkMimeType,
    sinkTag,
    errorLabel = "媒体源",
    maxResumeAttempts = DEFAULT_MAX_RANGE_RESUME_ATTEMPTS,
    maxConcurrency,
    rangeChunkSizeBytes,
    minParallelRangeBytes,
    maxChunkRetries,
    apiOrigin,
    onRouteStart,
    onProgress,
  } = params;

  const cleanRoutes = routes.map((r) => r.trim()).filter(Boolean);
  if (cleanRoutes.length === 0) {
    throw new ExtensionDownloadError("缺少可用的下载线路");
  }

  const clampedMaxConcurrency = normalizeMaxConcurrency(maxConcurrency);
  const effectiveChunkSize = normalizePositiveInt(
    rangeChunkSizeBytes,
    DEFAULT_RANGE_CHUNK_SIZE_BYTES,
  );
  const effectiveMinParallelBytes = normalizeNonNegativeInt(
    minParallelRangeBytes,
    DEFAULT_RANGE_CONCURRENCY_THRESHOLD_BYTES,
  );
  const effectiveMaxChunkRetries = normalizeNonNegativeInt(
    maxChunkRetries,
    DEFAULT_MAX_CHUNK_RETRIES,
  );
  const effectiveApiOrigin = apiOrigin ?? spec.apiOrigin;
  const knownSmall =
    typeof estimatedSize === "number" &&
    Number.isFinite(estimatedSize) &&
    estimatedSize > 0 &&
    estimatedSize < effectiveMinParallelBytes;

  let lastError: unknown;
  const routeErrors: unknown[] = [];
  const knownExpiredRoutes = new Set<string>();
  const allRoutesExpired = (): boolean =>
    cleanRoutes.length > 0 && cleanRoutes.every((r) => knownExpiredRoutes.has(r));

  for (let idx = 0; idx < cleanRoutes.length; idx++) {
    throwIfAborted(signal);
    const route = cleanRoutes[idx];
    const routeEffectiveConcurrency = isSameOriginApiRoute(
      route,
      effectiveApiOrigin,
    )
      ? 1
      : clampedMaxConcurrency;

    const runRouteDownload = async (
      allowRangeResume: boolean,
      isFreshRetry: boolean,
      forcePlainGet = false,
    ): Promise<StreamResumableRouteToOpfsResult> => {
      let sink: OpfsSinkLike | null = null;
      try {
        const streamInitial200Response = async (
          resp: Response,
        ): Promise<StreamResumableRouteToOpfsResult> => {
          const contentType = resp.headers.get("Content-Type") || "";
          if (/text\/html/i.test(contentType)) {
            void resp.body?.cancel?.().catch(() => {});
            throw new ExtensionDownloadError(`${errorLabel}返回了非媒体错误页`);
          }
          const isJsonLabeled = /application\/json/i.test(contentType);

          const hasEncoding = hasNonIdentityContentEncoding(resp.headers);
          const declaredLen = parseContentLengthHeader(
            resp.headers,
            hasEncoding,
          );
          const total = declaredLen || estimatedSize || 0;

          sink = await openOpfsSink(
            taskId,
            sinkMimeType || (isJsonLabeled ? undefined : contentType),
            sinkTag,
          );
          onRouteStart?.({
            routeIndex: idx,
            routeCount: cleanRoutes.length,
            total,
            isFreshRetry,
          });
          onProgress?.({ loaded: 0, total, resumed: false });

          let sinkWrittenBytes = 0;
          let firstBytesVerified = !isJsonLabeled;
          let sinkWriteFailed = false;
          let resumedCount = 0;

          try {
            const bytesRead = await streamResponseBodyToWriter({
              response: resp,
              write: (chunk) => sink!.write(chunk),
              signal,
              onFirstBytesVerified: () => {
                firstBytesVerified = true;
              },
              onSinkWriteError: () => {
                sinkWriteFailed = true;
              },
              ...(isJsonLabeled
                ? {
                    verifyFirstBytes: (prefix: Uint8Array) => {
                      if (!hasIsoBmffBoxHeader(prefix)) {
                        throw new ExtensionDownloadError(
                          `${errorLabel}返回了非媒体错误页`,
                        );
                      }
                    },
                  }
                : {}),
              onBytes: (_chunkLen, loaded) => {
                sinkWrittenBytes = loaded;
                onProgress?.({ loaded, total, resumed: false });
              },
            });

            return {
              sink,
              byteLength: bytesRead,
              total: total || bytesRead,
              contentType,
              route,
              resumedCount: 0,
              parallelUsed: false,
              chunkCount: 1,
            };
          } catch (initialErr) {
            const canResumeInPlace =
              allowRangeResume &&
              maxResumeAttempts > 0 &&
              !isAbortLikeError(initialErr, signal) &&
              !sinkWriteFailed &&
              firstBytesVerified &&
              sinkWrittenBytes > 0 &&
              declaredLen > sinkWrittenBytes &&
              !(
                initialErr instanceof ExtensionDownloadError &&
                initialErr.code === "STREAM_OVERFLOW"
              );

            if (!canResumeInPlace) {
              throw initialErr;
            }

            // Keep the existing OPFS sink with its `sinkWrittenBytes` intact and try
            // bounded Range resume attempts (current route first, then alternates).
            const resumeRoutes = [
              cleanRoutes[idx],
              ...cleanRoutes.slice(idx + 1),
              ...cleanRoutes.slice(0, idx),
            ];
            let resumeRouteCursor = 0;
            let lastResumeErr: unknown = initialErr;
            let shouldFallbackToFresh = false;
            let activeRoute = route;

            for (
              let attempt = 0;
              attempt < maxResumeAttempts && sinkWrittenBytes < declaredLen;
              attempt++
            ) {
              throwIfAborted(signal);
              const resumeRoute =
                resumeRoutes[resumeRouteCursor % resumeRoutes.length];
              const expectedStart = sinkWrittenBytes;

              try {
                const resumeResp = await whitelistedFetch(
                  fetchFn,
                  resumeRoute,
                  spec,
                  {
                    method: "GET",
                    headers: { Range: `bytes=${expectedStart}-` },
                  },
                  signal,
                );

                if (resumeResp.status === 200 || resumeResp.status === 416) {
                  void resumeResp.body?.cancel?.().catch(() => {});
                  shouldFallbackToFresh = true;
                  break;
                }
                if (resumeResp.status !== 206) {
                  void resumeResp.body?.cancel?.().catch(() => {});
                  if (resumeResp.status === 403 || resumeResp.status === 410) {
                    knownExpiredRoutes.add(resumeRoute);
                  }
                  lastResumeErr = new ExtensionDownloadError(
                    `${errorLabel}续传返回 HTTP ${resumeResp.status}`,
                    { httpStatus: resumeResp.status },
                  );
                  if (
                    resumeRoutes.length === 1 &&
                    (resumeResp.status === 403 || resumeResp.status === 410)
                  ) {
                    break;
                  }
                  resumeRouteCursor += 1;
                  continue;
                }

                const resumeContentType =
                  resumeResp.headers.get("Content-Type") || "";
                const resumeHasEncoding = hasNonIdentityContentEncoding(
                  resumeResp.headers,
                );
                const parsedRange = parseContentRangeHeader(
                  resumeResp.headers.get("Content-Range"),
                );
                const resumeHeaderLen = parseContentLengthHeader(
                  resumeResp.headers,
                  resumeHasEncoding,
                );
                const expectedSegmentLen = parsedRange
                  ? parsedRange.end - parsedRange.start + 1
                  : 0;

                const valid206Range =
                  !/text\/html/i.test(resumeContentType) &&
                  !resumeHasEncoding &&
                  parsedRange !== null &&
                  parsedRange.start === expectedStart &&
                  parsedRange.total === declaredLen &&
                  expectedSegmentLen > 0 &&
                  (resumeHeaderLen === 0 ||
                    resumeHeaderLen === expectedSegmentLen);

                if (!valid206Range) {
                  void resumeResp.body?.cancel?.().catch(() => {});
                  shouldFallbackToFresh = true;
                  break;
                }

                const baseOffset = sinkWrittenBytes;
                resumedCount += 1;
                activeRoute = resumeRoute;

                await streamResponseBodyToWriter({
                  response: resumeResp,
                  write: (chunk) => sink!.write(chunk),
                  signal,
                  expectedBytes: expectedSegmentLen,
                  onSinkWriteError: () => {
                    sinkWriteFailed = true;
                  },
                  onBytes: (_chunkLen, segWritten) => {
                    sinkWrittenBytes = baseOffset + segWritten;
                    onProgress?.({
                      loaded: sinkWrittenBytes,
                      total: declaredLen,
                      resumed: true,
                    });
                  },
                });

                if (sinkWrittenBytes === declaredLen) {
                  return {
                    sink,
                    byteLength: sinkWrittenBytes,
                    total: declaredLen,
                    contentType,
                    route: activeRoute,
                    resumedCount,
                    parallelUsed: false,
                    chunkCount: 1,
                  };
                }
                if (sinkWrittenBytes > declaredLen) {
                  shouldFallbackToFresh = true;
                  break;
                }
              } catch (resumeErr) {
                if (isAbortLikeError(resumeErr, signal) || sinkWriteFailed) {
                  throw resumeErr;
                }
                if (
                  resumeErr instanceof ExtensionDownloadError &&
                  resumeErr.code === "STREAM_OVERFLOW"
                ) {
                  shouldFallbackToFresh = true;
                  break;
                }
                lastResumeErr = resumeErr;
                if (sinkWrittenBytes === expectedStart) {
                  resumeRouteCursor += 1;
                }
              }
            }

            if (sinkWrittenBytes === declaredLen) {
              return {
                sink,
                byteLength: sinkWrittenBytes,
                total: declaredLen,
                contentType,
                route: activeRoute,
                resumedCount,
                parallelUsed: false,
                chunkCount: 1,
              };
            }

            if (shouldFallbackToFresh) {
              // Clean up partial sink FIRST, then fall back to a clean 0-byte download
              // so misaligned bytes are never concatenated.
              await sink.cleanup();
              sink = null;
              return await runRouteDownload(false, true, true);
            }

            throw lastResumeErr;
          }
        };

        const shouldProbeRange =
          !forcePlainGet &&
          allowRangeResume &&
          routeEffectiveConcurrency > 1 &&
          !knownSmall;

        if (!shouldProbeRange) {
          const resp = await whitelistedFetch(
            fetchFn,
            route,
            spec,
            { method: "GET" },
            signal,
          );
          if (resp.status !== 200) {
            void resp.body?.cancel?.().catch(() => {});
            if (resp.status === 403 || resp.status === 410) {
              knownExpiredRoutes.add(route);
            }
            throw new ExtensionDownloadError(
              `${errorLabel}返回 HTTP ${resp.status}`,
              { httpStatus: resp.status },
            );
          }
          return await streamInitial200Response(resp);
        }

        // Zero-waste initial Range probe: request Chunk 0 [0 .. chunkSize - 1]
        const probeResp = await whitelistedFetch(
          fetchFn,
          route,
          spec,
          {
            method: "GET",
            headers: { Range: `bytes=0-${effectiveChunkSize - 1}` },
          },
          signal,
        );

        if (probeResp.status === 403 || probeResp.status === 410) {
          void probeResp.body?.cancel?.().catch(() => {});
          knownExpiredRoutes.add(route);
          throw new ExtensionDownloadError(
            `${errorLabel}返回 HTTP ${probeResp.status}`,
            { httpStatus: probeResp.status },
          );
        }

        if (probeResp.status === 200) {
          // Server ignored Range header -> seamlessly stream full body at 1x
          // (preserving mid-stream Range resume if it drops partway), 0 wasted bytes!
          return await streamInitial200Response(probeResp);
        }

        if (probeResp.status === 416) {
          void probeResp.body?.cancel?.().catch(() => {});
          return await runRouteDownload(false, isFreshRetry, true);
        }

        if (probeResp.status !== 206) {
          void probeResp.body?.cancel?.().catch(() => {});
          throw new ExtensionDownloadError(
            `${errorLabel}返回 HTTP ${probeResp.status}`,
            { httpStatus: probeResp.status },
          );
        }

        const contentType = probeResp.headers.get("Content-Type") || "";
        if (/text\/html/i.test(contentType)) {
          void probeResp.body?.cancel?.().catch(() => {});
          throw new ExtensionDownloadError(`${errorLabel}返回了非媒体错误页`);
        }

        const hasEncoding = hasNonIdentityContentEncoding(probeResp.headers);
        const parsedProbeRange = parseContentRangeHeader(
          probeResp.headers.get("Content-Range"),
        );
        const chunk0ExpectedLen = parsedProbeRange
          ? parsedProbeRange.end - parsedProbeRange.start + 1
          : 0;
        const probeHeaderLen = parseContentLengthHeader(
          probeResp.headers,
          hasEncoding,
        );

        const validProbe206 =
          !hasEncoding &&
          parsedProbeRange !== null &&
          parsedProbeRange.start === 0 &&
          parsedProbeRange.end >= 0 &&
          parsedProbeRange.end < parsedProbeRange.total &&
          chunk0ExpectedLen > 0 &&
          (probeHeaderLen === 0 || probeHeaderLen === chunk0ExpectedLen);

        if (!validProbe206) {
          void probeResp.body?.cancel?.().catch(() => {});
          return await runRouteDownload(false, isFreshRetry, true);
        }

        const expectedTotal = parsedProbeRange.total;
        const chunk0End = parsedProbeRange.end;
        const isJsonLabeled = /application\/json/i.test(contentType);
        const finalProbeUrl =
          typeof probeResp.url === "string" && probeResp.url.trim()
            ? probeResp.url.trim()
            : route;
        const probeEffectiveConcurrency = isSameOriginApiRoute(
          finalProbeUrl,
          effectiveApiOrigin,
        )
          ? 1
          : routeEffectiveConcurrency;

        sink = await openOpfsSink(
          taskId,
          sinkMimeType || (isJsonLabeled ? undefined : contentType),
          sinkTag,
        );
        const sinkHasWriteAt = typeof sink.writeAt === "function";

        onRouteStart?.({
          routeIndex: idx,
          routeCount: cleanRoutes.length,
          total: expectedTotal,
          isFreshRetry,
        });
        onProgress?.({ loaded: 0, total: expectedTotal, resumed: false });

        let totalBytesWritten = 0;
        let lastReportedLoaded = 0;
        let anyResumed = false;
        let resumedCount = 0;
        let sinkWriteFailed = false;
        let firstBytesVerified = !isJsonLabeled;
        let activeRoute = route;

        const emitMonotonicProgress = (resumed: boolean) => {
          if (resumed) anyResumed = true;
          if (totalBytesWritten > lastReportedLoaded) {
            lastReportedLoaded = totalBytesWritten;
            onProgress?.({
              loaded: lastReportedLoaded,
              total: expectedTotal,
              resumed: anyResumed,
            });
          }
        };

        // Always stream & verify Chunk 0 FIRST (including application/json ISO BMFF sniff)
        // BEFORE spawning any sibling Range workers!
        let chunk0Cursor = 0;
        let chunk0DroppedMidStream = false;
        try {
          await streamResponseBodyToWriter({
            response: probeResp,
            write: async (chunk) => {
              throwIfAborted(signal);
              const writePos = chunk0Cursor;
              if (sinkHasWriteAt) {
                await sink!.writeAt!(writePos, chunk);
              } else {
                await sink!.write(chunk);
              }
              chunk0Cursor += chunk.byteLength;
              totalBytesWritten += chunk.byteLength;
              emitMonotonicProgress(false);
            },
            signal,
            expectedBytes: chunk0ExpectedLen,
            onFirstBytesVerified: () => {
              firstBytesVerified = true;
            },
            onSinkWriteError: () => {
              sinkWriteFailed = true;
            },
            ...(isJsonLabeled
              ? {
                  verifyFirstBytes: (prefix: Uint8Array) => {
                    if (!hasIsoBmffBoxHeader(prefix)) {
                      throw new ExtensionDownloadError(
                        `${errorLabel}返回了非媒体错误页`,
                      );
                    }
                  },
                }
              : {}),
          });
        } catch (chunk0Err) {
          const canResumeChunk0 =
            !isAbortLikeError(chunk0Err, signal) &&
            !sinkWriteFailed &&
            firstBytesVerified &&
            chunk0Cursor > 0 &&
            chunk0Cursor <= chunk0End &&
            effectiveMaxChunkRetries > 0 &&
            !(
              chunk0Err instanceof ExtensionDownloadError &&
              chunk0Err.code === "STREAM_OVERFLOW"
            );
          if (!canResumeChunk0) {
            throw chunk0Err;
          }
          chunk0DroppedMidStream = true;
        }

        // Direct CDN candidates for parallel/subsequent Range chunks:
        // NEVER fan out parallel chunks onto a same-origin `/api/` relay backup.
        const orderedRoutes = [
          cleanRoutes[idx],
          ...cleanRoutes.slice(idx + 1),
          ...cleanRoutes.slice(0, idx),
        ];
        const directCandidateRoutes = orderedRoutes.filter(
          (r) => !isSameOriginApiRoute(r, effectiveApiOrigin),
        );
        const rejectedMismatchRoutes = new Set<string>();

        const pickChunkRoute = (
          startCursor: number,
        ): { route: string; nextCursor: number } | null => {
          const n = directCandidateRoutes.length;
          for (let step = 0; step < n; step++) {
            const candidateIdx = (startCursor + step) % n;
            const candidate = directCandidateRoutes[candidateIdx];
            if (
              !knownExpiredRoutes.has(candidate) &&
              !rejectedMismatchRoutes.has(candidate)
            ) {
              return { route: candidate, nextCursor: candidateIdx + 1 };
            }
          }
          return null;
        };

        const downloadChunkRange = async (
          chunk: { start: number; end: number },
          initialRetriesUsed: number,
          poolSignal: AbortSignal,
          useWriteAt: boolean,
        ): Promise<void> => {
          let cursor = chunk.start;
          const chunkEnd = chunk.end;
          let retriesUsed = initialRetriesUsed;
          let routeCursor = 0;
          let lastChunkErr: unknown = null;
          const maxSubResponses = Math.max(
            16,
            Math.ceil((chunkEnd - chunk.start + 1) / 65536) +
              effectiveMaxChunkRetries +
              8,
          );
          let subResponses = 0;

          while (cursor <= chunkEnd) {
            throwIfAborted(poolSignal);
            subResponses += 1;
            if (subResponses > maxSubResponses) {
              throw (
                lastChunkErr ??
                new ExtensionDownloadError(`${errorLabel}分块响应次数超出上限`)
              );
            }

            const picked = pickChunkRoute(routeCursor);
            if (!picked) {
              if (allRoutesExpired()) {
                const status =
                  lastChunkErr instanceof ExtensionDownloadError &&
                  (lastChunkErr.httpStatus === 403 ||
                    lastChunkErr.httpStatus === 410)
                    ? lastChunkErr.httpStatus
                    : 403;
                throw new ExtensionDownloadError(
                  `${errorLabel}签名链接已过期（HTTP ${status}）`,
                  { code: "MEDIA_URL_EXPIRED", httpStatus: status },
                );
              }
              throw (
                lastChunkErr ??
                new ExtensionDownloadError(`${errorLabel}分块下载缺少可用线路`)
              );
            }
            const chunkRoute = picked.route;
            routeCursor = picked.nextCursor;

            try {
              const chunkResp = await whitelistedFetch(
                fetchFn,
                chunkRoute,
                spec,
                {
                  method: "GET",
                  headers: { Range: `bytes=${cursor}-${chunkEnd}` },
                },
                poolSignal,
              );

              if (chunkResp.status === 403 || chunkResp.status === 410) {
                void chunkResp.body?.cancel?.().catch(() => {});
                knownExpiredRoutes.add(chunkRoute);
                const expErr = new ExtensionDownloadError(
                  `${errorLabel}分块返回 HTTP ${chunkResp.status}`,
                  { httpStatus: chunkResp.status },
                );
                lastChunkErr = expErr;
                if (allRoutesExpired()) {
                  throw new ExtensionDownloadError(
                    `${errorLabel}签名链接已过期（HTTP ${chunkResp.status}）`,
                    {
                      code: "MEDIA_URL_EXPIRED",
                      httpStatus: chunkResp.status,
                    },
                  );
                }
                if (!pickChunkRoute(routeCursor)) {
                  throw expErr;
                }
                retriesUsed += 1;
                if (retriesUsed > effectiveMaxChunkRetries) {
                  throw expErr;
                }
                anyResumed = true;
                resumedCount += 1;
                continue;
              }

              if (chunkResp.status !== 206) {
                void chunkResp.body?.cancel?.().catch(() => {});
                throw new ExtensionDownloadError(
                  `${errorLabel}分块返回 HTTP ${chunkResp.status}`,
                  { httpStatus: chunkResp.status },
                );
              }

              const chunkContentType =
                chunkResp.headers.get("Content-Type") || "";
              const chunkHasEncoding = hasNonIdentityContentEncoding(
                chunkResp.headers,
              );
              const chunkParsedRange = parseContentRangeHeader(
                chunkResp.headers.get("Content-Range"),
              );
              const expectedSegLen = chunkParsedRange
                ? chunkParsedRange.end - chunkParsedRange.start + 1
                : 0;
              const chunkHeaderLen = parseContentLengthHeader(
                chunkResp.headers,
                chunkHasEncoding,
              );

              if (/text\/html/i.test(chunkContentType)) {
                void chunkResp.body?.cancel?.().catch(() => {});
                throw new ExtensionDownloadError(
                  `${errorLabel}分块返回了非媒体错误页`,
                );
              }
              if (chunkHasEncoding) {
                void chunkResp.body?.cancel?.().catch(() => {});
                throw new ExtensionDownloadError(
                  `${errorLabel}分块返回了非 identity 压缩编码`,
                );
              }
              if (!chunkParsedRange) {
                void chunkResp.body?.cancel?.().catch(() => {});
                throw new ExtensionDownloadError(
                  `${errorLabel}分块缺少有效的 Content-Range 响应头`,
                );
              }
              if (chunkParsedRange.total !== expectedTotal) {
                void chunkResp.body?.cancel?.().catch(() => {});
                rejectedMismatchRoutes.add(chunkRoute);
                throw new ExtensionDownloadError(
                  `${errorLabel}分块总长度不一致（${chunkParsedRange.total} != ${expectedTotal}）`,
                  { code: "RANGE_TOTAL_MISMATCH" },
                );
              }
              if (
                chunkParsedRange.start !== cursor ||
                chunkParsedRange.end < cursor ||
                chunkParsedRange.end > chunkEnd ||
                expectedSegLen <= 0 ||
                (chunkHeaderLen > 0 && chunkHeaderLen !== expectedSegLen)
              ) {
                void chunkResp.body?.cancel?.().catch(() => {});
                throw new ExtensionDownloadError(
                  `${errorLabel}分块返回了不匹配的字节区间`,
                  { code: "RANGE_SPAN_MISMATCH" },
                );
              }

              activeRoute = chunkRoute;
              let segCursor = cursor;
              const expectedAfterSeg = chunkParsedRange.end + 1;

              await streamResponseBodyToWriter({
                response: chunkResp,
                write: async (buf) => {
                  throwIfAborted(poolSignal);
                  const writePos = segCursor;
                  if (useWriteAt) {
                    await sink!.writeAt!(writePos, buf);
                  } else {
                    await sink!.write(buf);
                  }
                  segCursor += buf.byteLength;
                  cursor = segCursor;
                  totalBytesWritten += buf.byteLength;
                  emitMonotonicProgress(retriesUsed > 0);
                },
                signal: poolSignal,
                expectedBytes: expectedSegLen,
                onSinkWriteError: () => {
                  sinkWriteFailed = true;
                },
              });

              if (cursor !== expectedAfterSeg) {
                throw new ExtensionDownloadError(
                  `${errorLabel}分块写入字节数不完整`,
                  { code: "STREAM_TRUNCATED" },
                );
              }
            } catch (chunkErr) {
              if (
                isAbortLikeError(chunkErr, poolSignal) ||
                isAbortLikeError(chunkErr, signal) ||
                sinkWriteFailed
              ) {
                throw chunkErr;
              }
              if (
                chunkErr instanceof ExtensionDownloadError &&
                (chunkErr.code === "MEDIA_URL_EXPIRED" ||
                  chunkErr.code === "STREAM_OVERFLOW")
              ) {
                throw chunkErr;
              }
              lastChunkErr = chunkErr;
              if (!pickChunkRoute(routeCursor)) {
                throw chunkErr;
              }
              retriesUsed += 1;
              if (retriesUsed > effectiveMaxChunkRetries) {
                throw chunkErr;
              }
              anyResumed = true;
              resumedCount += 1;
            }
          }

          if (cursor !== chunkEnd + 1) {
            throw new ExtensionDownloadError(`${errorLabel}分块未完整写入`);
          }
        };

        if (chunk0DroppedMidStream) {
          anyResumed = true;
          resumedCount += 1;
          await downloadChunkRange(
            { start: chunk0Cursor, end: chunk0End },
            1,
            signal,
            sinkHasWriteAt,
          );
          chunk0Cursor = chunk0End + 1;
        }

        // Case 1: Entire file fit inside Chunk 0 -> done in 1 request!
        if (chunk0End === expectedTotal - 1) {
          if (totalBytesWritten !== expectedTotal) {
            throw new ExtensionDownloadError(
              `${errorLabel}下载字节数不完整（${totalBytesWritten} / ${expectedTotal}）`,
              { code: "STREAM_TRUNCATED" },
            );
          }
          if (lastReportedLoaded < expectedTotal) {
            lastReportedLoaded = expectedTotal;
            onProgress?.({
              loaded: expectedTotal,
              total: expectedTotal,
              resumed: anyResumed,
            });
          }
          return {
            sink,
            byteLength: totalBytesWritten,
            total: expectedTotal,
            contentType,
            route: activeRoute,
            resumedCount,
            parallelUsed: false,
            chunkCount: 1,
          };
        }

        // Case 2: Total < minParallelRangeBytes, or sink lacks writeAt, or concurrency <= 1 ->
        // continue sequentially (concurrency = 1) with zero wasted bytes and no parallel fanout.
        if (
          expectedTotal < effectiveMinParallelBytes ||
          !sinkHasWriteAt ||
          probeEffectiveConcurrency <= 1
        ) {
          await downloadChunkRange(
            { start: chunk0End + 1, end: expectedTotal - 1 },
            0,
            signal,
            sinkHasWriteAt,
          );
          if (totalBytesWritten !== expectedTotal) {
            throw new ExtensionDownloadError(
              `${errorLabel}下载字节数不完整（${totalBytesWritten} / ${expectedTotal}）`,
              { code: "STREAM_TRUNCATED" },
            );
          }
          if (lastReportedLoaded < expectedTotal) {
            lastReportedLoaded = expectedTotal;
            onProgress?.({
              loaded: expectedTotal,
              total: expectedTotal,
              resumed: anyResumed,
            });
          }
          return {
            sink,
            byteLength: totalBytesWritten,
            total: expectedTotal,
            contentType,
            route: activeRoute,
            resumedCount,
            parallelUsed: false,
            chunkCount: 2,
          };
        }

        // Case 3: Total >= minParallelRangeBytes -> partition [chunk0End + 1 .. expectedTotal - 1]
        // into fixed `effectiveChunkSize` chunks and execute with bounded worker pool.
        const remainingChunks: Array<{ start: number; end: number }> = [];
        let offset = chunk0End + 1;
        while (offset < expectedTotal) {
          const end = Math.min(
            expectedTotal - 1,
            offset + effectiveChunkSize - 1,
          );
          remainingChunks.push({ start: offset, end });
          offset = end + 1;
        }

        const workerCount = Math.min(
          probeEffectiveConcurrency,
          remainingChunks.length,
        );
        const poolAbort = new AbortController();
        const onParentAbort = () => {
          if (!poolAbort.signal.aborted) {
            poolAbort.abort();
          }
        };
        if (signal.aborted) {
          poolAbort.abort();
        } else {
          signal.addEventListener("abort", onParentAbort, { once: true });
        }

        let nextChunkIdx = 0;
        let fatalError: unknown = null;

        const recordFatalError = (err: unknown): void => {
          const isExpired =
            err instanceof ExtensionDownloadError &&
            err.code === "MEDIA_URL_EXPIRED";
          const isSecondaryAbort =
            !signal.aborted && isAbortLikeError(err, poolAbort.signal);
          const currentFatal: unknown = fatalError;
          const currentIsExpired =
            currentFatal instanceof ExtensionDownloadError &&
            currentFatal.code === "MEDIA_URL_EXPIRED";
          if (
            currentFatal === null ||
            (isExpired && !currentIsExpired) ||
            (!isSecondaryAbort &&
              isAbortLikeError(currentFatal, poolAbort.signal))
          ) {
            fatalError = err;
          }
        };

        const runWorker = async (): Promise<void> => {
          for (;;) {
            if (
              poolAbort.signal.aborted ||
              signal.aborted ||
              fatalError !== null
            ) {
              return;
            }
            const myIdx = nextChunkIdx;
            if (myIdx >= remainingChunks.length) {
              return;
            }
            nextChunkIdx += 1;
            const chunk = remainingChunks[myIdx];
            try {
              await downloadChunkRange(chunk, 0, poolAbort.signal, true);
            } catch (err) {
              recordFatalError(err);
              if (!poolAbort.signal.aborted) {
                poolAbort.abort();
              }
              return;
            }
          }
        };

        const workers: Array<Promise<void>> = [];
        for (let w = 0; w < workerCount; w++) {
          workers.push(runWorker());
        }

        try {
          await Promise.allSettled(workers);
        } finally {
          signal.removeEventListener("abort", onParentAbort);
        }

        throwIfAborted(signal);
        if (fatalError !== null) {
          throw fatalError;
        }
        if (totalBytesWritten !== expectedTotal) {
          throw new ExtensionDownloadError(
            `${errorLabel}分块下载总字节数不完整（${totalBytesWritten} / ${expectedTotal}）`,
            { code: "STREAM_TRUNCATED" },
          );
        }
        if (lastReportedLoaded < expectedTotal) {
          lastReportedLoaded = expectedTotal;
          onProgress?.({
            loaded: expectedTotal,
            total: expectedTotal,
            resumed: anyResumed,
          });
        }

        return {
          sink,
          byteLength: totalBytesWritten,
          total: expectedTotal,
          contentType,
          route: activeRoute,
          resumedCount,
          parallelUsed: workerCount > 1,
          chunkCount: 1 + remainingChunks.length,
        };
      } catch (err) {
        await sink?.cleanup(err);
        throw err;
      }
    };

    try {
      return await runRouteDownload(true, false);
    } catch (err) {
      if (isAbortLikeError(err, signal)) {
        throw err;
      }
      if (
        err instanceof ExtensionDownloadError &&
        err.code === "MEDIA_URL_EXPIRED"
      ) {
        throw err;
      }
      lastError = err;
      routeErrors.push(err);
    }
  }

  if (routeErrors.length > 0 && routeErrors.every(isExpiredHttpStatusError)) {
    const lastStatus = (
      routeErrors[routeErrors.length - 1] as ExtensionDownloadError
    ).httpStatus as number;
    throw new ExtensionDownloadError(
      `${errorLabel}签名链接已过期（HTTP ${lastStatus}）`,
      {
        code: "MEDIA_URL_EXPIRED",
        httpStatus: lastStatus,
      },
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new ExtensionDownloadError(`${errorLabel}所有下载线路均失败`);
}
