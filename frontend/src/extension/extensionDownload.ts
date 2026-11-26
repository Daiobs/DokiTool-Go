import JSZip from "jszip";
import { sourceUrl } from "../utils/mediaContract";
import {
  YOUTUBE_OPFS_TEMP_PREFIX,
  cleanupLeftoverYouTubeOpfsTempFiles,
  type YouTubeHelperPlayerPayload,
  type YouTubeHelperPlayerResult,
  type YouTubeHelperPrefetchPayload,
  type YouTubeHelperPrefetchResult,
} from "../utils/youtubeHelperCore";
import { executeDashMux } from "./dashMuxDownload";
import { buildSafeDownloadPath, formatBatchItemIndex } from "./filenameSanitizer";
import {
  DEFAULT_DIRECT_FILE_MAX_CONCURRENCY,
  ExtensionDownloadError,
  assertWhitelistedUrl,
  buildEffectiveExtraOrigins,
  ensureOpfsQuotaAvailable,
  hasIsoBmffBoxHeader,
  isAbortLikeError,
  resolveBlobMimeType,
  streamResponseBodyToWriter,
  streamResumableRouteToOpfs,
  throwIfAborted,
  whitelistedFetch,
  type OpfsDirectoryLike,
  type OpfsSinkLike,
  type OpfsStorageLike,
  type OpfsWritableLike,
  type WebLocksLike,
} from "./opfsStreamTransfer";
import {
  ARCHIVE_LIMIT_ERROR,
  MAX_BATCH_ZIP_BYTES,
} from "./planning/enqueuePlanBuilder";
import {
  EXTENSION_OPFS_TEMP_PREFIX,
  type HandOffBlobDownloadResult,
  type OffscreenDownloadSpec,
  type OffscreenSegmentSpec,
  type OffscreenToBackgroundMessage,
  type OffscreenZipEntrySpec,
} from "./protocol";
import {
  createYouTubeExtensionBridge,
  type UrlObjectApiLike,
} from "./youtubeExtensionBridge";

export {
  extractDashMuxSpec,
  extractDashMuxSpec as extractFileMuxSpec,
} from "./dashMuxSpec";
export {
  ExtensionDownloadError,
  ensureOpfsQuotaAvailable,
  hasIsoBmffBoxHeader,
  resolveBlobMimeType,
  streamResumableRouteToOpfs,
  whitelistedFetch,
  type OpfsStorageLike,
  type WebLocksLike,
} from "./opfsStreamTransfer";
export {
  selectVariantByPreference,
  videoCodecPreferenceRank,
  type LivePhotoSaveMode,
  type SelectedVariantPlan,
} from "./planning/variantSelection";
export {
  ARCHIVE_LIMIT_ERROR,
  MAX_BATCH_ZIP_BYTES,
  buildEnqueueItemsForMedia,
  type BuildEnqueueItemsOptions,
} from "./planning/enqueuePlanBuilder";

export const DEFAULT_OFFSCREEN_CONCURRENCY = 3;
export const DEFAULT_PROGRESS_THROTTLE_MS = 150;

// ============================================================================
// OPFS Cleanup & Streaming Download/Mux Executor
// ============================================================================

async function acquireExclusiveWebLock(
  locks: WebLocksLike | LockManager | null | undefined,
  lockName: string,
): Promise<() => void> {
  if (!locks || typeof locks.request !== "function") {
    return () => {};
  }
  let releaseHold!: () => void;
  const holdPromise = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseHold();
  };

  let onGranted!: () => void;
  let onFailed!: (err: unknown) => void;
  const granted = new Promise<void>((resolve, reject) => {
    onGranted = resolve;
    onFailed = reject;
  });

  try {
    const req = (locks as WebLocksLike).request(
      lockName,
      { mode: "exclusive" },
      () => {
        onGranted();
        return holdPromise;
      },
    );
    req.catch(onFailed);
    await granted;
    if (released) {
      releaseHold();
    }
    return release;
  } catch {
    release();
    return () => {};
  }
}

export async function cleanupStaleExtensionOpfsFiles(options?: {
  storage?: OpfsStorageLike | StorageManager | null;
  locks?: WebLocksLike | LockManager | null;
  activeNames?: ReadonlySet<string>;
  now?: () => number;
}): Promise<number> {
  const storage =
    options?.storage !== undefined
      ? options.storage
      : typeof navigator !== "undefined"
        ? navigator.storage
        : null;
  const locks =
    options?.locks !== undefined
      ? options.locks
      : typeof navigator !== "undefined"
        ? navigator.locks
        : null;
  const activeNames = options?.activeNames;

  let removed = 0;

  if (storage && typeof storage.getDirectory === "function") {
    try {
      const root = (await storage.getDirectory()) as OpfsDirectoryLike;
      if (root && typeof root.removeEntry === "function") {
        const candidates: string[] = [];
        const iter =
          (typeof root.keys === "function" && root.keys()) ||
          (typeof root.entries === "function" && root.entries()) ||
          (typeof root.values === "function" && root.values());
        if (iter) {
          for await (const entry of iter as AsyncIterable<unknown>) {
            const name =
              typeof entry === "string"
                ? entry
                : Array.isArray(entry)
                  ? String(entry[0] ?? "")
                  : typeof entry === "object" && entry !== null
                    ? String((entry as { name?: unknown }).name ?? "")
                    : "";
            if (
              name.startsWith(EXTENSION_OPFS_TEMP_PREFIX) &&
              !(activeNames && activeNames.has(name))
            ) {
              candidates.push(name);
            }
          }
        }

        for (const name of candidates) {
          const baseLockName = name.endsWith(".crswap")
            ? name.slice(0, -7)
            : name;
          if (
            activeNames &&
            (activeNames.has(name) || activeNames.has(baseLockName))
          ) {
            continue;
          }
          if (locks && typeof locks.request === "function") {
            await (locks as WebLocksLike).request(
              baseLockName,
              { mode: "exclusive", ifAvailable: true },
              async (lock) => {
                if (!lock) return;
                try {
                  await root.removeEntry(name);
                  removed += 1;
                } catch {
                  // Ignore already removed
                }
              },
            );
          } else {
            try {
              await root.removeEntry(name);
              removed += 1;
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch {
      // Ignore OPFS access errors in restricted environments
    }
  }

  try {
    removed += await cleanupLeftoverYouTubeOpfsTempFiles({
      storage: storage as StorageManager | null,
      locks: locks as LockManager | null,
      now: options?.now,
      maxAgeMs: 0,
      activeNames: activeNames
        ? new Set(
            Array.from(activeNames).filter((n) =>
              n.startsWith(YOUTUBE_OPFS_TEMP_PREFIX),
            ),
          )
        : null,
    });
  } catch {
    // Ignore
  }

  return removed;
}

function parseByteRangeDirective(
  value: string,
  previousEndExclusive: number | null,
): { start: number; length: number } | null {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const length = Number(match[1]);
  const start =
    match[2] !== undefined ? Number(match[2]) : (previousEndExclusive ?? 0);
  return Number.isSafeInteger(start) &&
    start >= 0 &&
    Number.isSafeInteger(length) &&
    length > 0
    ? { start, length }
    : null;
}

function sanitizeOpfsTaskSlug(taskId: string): string {
  const cleaned = taskId
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned || "task";
}

function sanitizeZipEntryPath(rawEntryName: string, fallbackIdx: number): string {
  const parts = rawEntryName
    .split(/[/\\]+/)
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..");
  if (parts.length === 0) {
    return `${formatBatchItemIndex(fallbackIdx + 1)}.bin`;
  }
  const last = parts[parts.length - 1];
  const dot = last.lastIndexOf(".");
  const ext = dot > 0 ? last.slice(dot + 1) : "";
  const stem = dot > 0 ? last.slice(0, dot) : last;
  const folderPrefix = parts.slice(0, -1).join("/");
  return buildSafeDownloadPath({
    prefix: folderPrefix,
    stem,
    ext,
  });
}

export interface CreateOffscreenDownloadExecutorOptions {
  handoffBlobDownload: (
    message: Extract<
      OffscreenToBackgroundMessage,
      { type: "HANDOFF_BLOB_DOWNLOAD" }
    >,
  ) => Promise<HandOffBlobDownloadResult | void>;
  onProgress?: (
    message: Extract<
      OffscreenToBackgroundMessage,
      { type: "OFFSCREEN_TASK_PROGRESS" }
    >,
  ) => void;
  onError?: (
    message: Extract<
      OffscreenToBackgroundMessage,
      { type: "OFFSCREEN_TASK_ERROR" }
    >,
  ) => void;
  fetchImpl?: typeof fetch;
  opfsStorage?: OpfsStorageLike | StorageManager | null;
  webLocks?: WebLocksLike | LockManager | null;
  urlApi?: UrlObjectApiLike;
  now?: () => number;
  maxConcurrentTasks?: number;
  progressThrottleMs?: number;
  mediabunnyImpl?: Record<string, unknown> | null;
  youtubeMuxConfig?: {
    chunkSize?: number;
    audioChunkSize?: number;
    initialChunkSize?: number;
    progressThrottleMs?: number;
    videoConcurrency?: number;
    audioConcurrency?: number;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    chunkTimeoutMs?: number;
    maxBufferBytes?: number;
  };
}

interface PendingBlobRelease {
  taskId: string;
  blobUrl: string;
  opfsTempName?: string;
  resolve: () => void;
}

interface QueuedTaskEntry {
  taskId: string;
  spec: OffscreenDownloadSpec;
  controller: AbortController;
  started: boolean;
}

export interface OffscreenDownloadExecutor {
  startTask(taskId: string, spec: OffscreenDownloadSpec): { accepted: boolean };
  cancelTask(taskId: string): { cancelled: boolean };
  releaseBlob(params: {
    taskId: string;
    blobUrl: string;
    opfsTempName?: string;
  }): { released: boolean };
  requestYouTubePrefetch(
    payload: YouTubeHelperPrefetchPayload,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<YouTubeHelperPrefetchResult>;
  requestYouTubePlayer(
    payload: YouTubeHelperPlayerPayload,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<YouTubeHelperPlayerResult>;
  getHelperVersion(): string;
  getActiveTaskCount(): number;
  getPendingBlobCount(): number;
  getActiveOpfsTempNames(): ReadonlySet<string>;
  getActiveDynamicAllowedOrigins(): string[] | undefined;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

export const SPEED_WINDOW_MS = 2500;
export const SPEED_EWMA_TAU_MS = 1200;
export const SPEED_STALE_ZERO_MS = 2500;

/**
 * Sliding 2.5s time-window + continuous-time EWMA (tau ≈ 1.2s) speed estimator.
 * Holds smoothed speed across brief chunk transitions and only decays to 0
 * when no new bytes arrive for >= 2500ms, eliminating sawtooth zero flicker.
 */
export function createSmoothedSpeedEstimator(options?: {
  startedAt?: number;
  windowMs?: number;
  tauMs?: number;
  staleZeroMs?: number;
}) {
  const windowMs = options?.windowMs ?? SPEED_WINDOW_MS;
  const tauMs = options?.tauMs ?? SPEED_EWMA_TAU_MS;
  const staleZeroMs = options?.staleZeroMs ?? SPEED_STALE_ZERO_MS;
  const startAt = options?.startedAt ?? Date.now();
  const samples: Array<{ t: number; bytes: number }> = [{ t: startAt, bytes: 0 }];
  let lastProgressAt = startAt;
  let lastBytes = 0;
  let lastUpdateAt = startAt;
  let ewmaSpeed = 0;
  let hasSpeed = false;

  return {
    update(loadedBytes: number, now: number): number {
      const bytes = Math.max(
        lastBytes,
        Number.isFinite(loadedBytes) && loadedBytes > 0 ? loadedBytes : 0,
      );
      if (bytes > lastBytes) {
        const tail = samples[samples.length - 1];
        if (tail && tail.t === now) {
          tail.bytes = bytes;
        } else {
          samples.push({ t: now, bytes });
        }
        const cutoff = now - windowMs;
        while (samples.length > 2 && samples[1].t <= cutoff) {
          samples.shift();
        }
        const anchor = samples[0];
        const spanSec = (now - anchor.t) / 1000;
        if (spanSec >= 0.05) {
          const windowRate = (bytes - anchor.bytes) / spanSec;
          if (!hasSpeed) {
            ewmaSpeed = windowRate;
            hasSpeed = true;
          } else {
            const dtMs = Math.max(1, now - lastUpdateAt);
            const alpha = 1 - Math.exp(-dtMs / tauMs);
            ewmaSpeed += alpha * (windowRate - ewmaSpeed);
          }
        }
        lastProgressAt = now;
        lastBytes = bytes;
        lastUpdateAt = now;
      } else if (now - lastProgressAt >= staleZeroMs) {
        ewmaSpeed = 0;
        hasSpeed = false;
        samples.length = 0;
        samples.push({ t: now, bytes });
        lastUpdateAt = now;
      }
      return Math.max(0, Math.round(ewmaSpeed));
    },
    current(): number {
      return Math.max(0, Math.round(ewmaSpeed));
    },
  };
}

export function createOffscreenDownloadExecutor(
  options: CreateOffscreenDownloadExecutorOptions,
): OffscreenDownloadExecutor {
  const fetchFn: typeof fetch =
    options.fetchImpl ??
    ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const opfsStorage =
    options.opfsStorage !== undefined
      ? options.opfsStorage
      : typeof navigator !== "undefined"
        ? (navigator.storage as unknown as OpfsStorageLike)
        : null;
  const webLocks =
    options.webLocks !== undefined
      ? options.webLocks
      : typeof navigator !== "undefined"
        ? (navigator.locks as unknown as WebLocksLike)
        : null;
  const urlApi: UrlObjectApiLike = options.urlApi ?? globalThis.URL;
  const nowFn = options.now ?? (() => Date.now());
  const maxConcurrentTasks = Math.max(
    1,
    options.maxConcurrentTasks ?? DEFAULT_OFFSCREEN_CONCURRENCY,
  );
  const progressThrottleMs = Math.max(
    0,
    options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS,
  );

  let tempSeq = 0;
  let activeRunningCount = 0;
  const activeDynamicAllowedOriginsByTask = new Map<string, string[]>();

  const getUnionDynamicAllowedOrigins = (): string[] | undefined => {
    if (activeDynamicAllowedOriginsByTask.size === 0) {
      return undefined;
    }
    const merged = new Set<string>();
    for (const origins of activeDynamicAllowedOriginsByTask.values()) {
      for (const origin of origins) {
        if (origin) merged.add(origin);
      }
    }
    return merged.size > 0 ? Array.from(merged) : undefined;
  };

  const waitQueue: QueuedTaskEntry[] = [];
  const activeTaskEntries = new Map<string, QueuedTaskEntry>();
  const pendingBlobs = new Map<string, PendingBlobRelease>();
  const activeOpfsNames = new Set<string>();
  const idleWaiters: Array<() => void> = [];

  const youtubeBridge = createYouTubeExtensionBridge({
    handoffBlobDownload: options.handoffBlobDownload,
    fetchImpl: fetchFn,
    opfsStorage: opfsStorage as Record<string, unknown> | null,
    webLocks: webLocks as Record<string, unknown> | null,
    urlApi,
    now: nowFn,
    mediabunnyImpl: options.mediabunnyImpl,
    muxConfig: options.youtubeMuxConfig,
    extraAllowedOrigins: getUnionDynamicAllowedOrigins,
  });

  const notifyIfIdle = () => {
    if (
      activeRunningCount === 0 &&
      waitQueue.length === 0 &&
      pendingBlobs.size === 0 &&
      youtubeBridge.getPendingBlobCount() === 0
    ) {
      for (const resolve of idleWaiters.splice(0)) {
        resolve();
      }
    }
  };

  const getAllowedOriginsForSpec = (spec: OffscreenDownloadSpec): string[] =>
    buildEffectiveExtraOrigins(spec.apiOrigin, spec.extraAllowedOrigins);

  const assertWhitelisted = (
    rawUrl: string,
    spec: OffscreenDownloadSpec,
  ): void => {
    assertWhitelistedUrl(rawUrl, spec);
  };

  const fetchWhitelisted = (
    rawUrl: string,
    spec: OffscreenDownloadSpec,
    init: RequestInit | undefined,
    signal: AbortSignal,
  ): Promise<Response> =>
    whitelistedFetch(fetchFn, rawUrl, spec, init, signal);

  const createProgressReporter = (
    taskId: string,
    defaultStatus: "downloading" | "muxing" | "saving" = "downloading",
  ) => {
    const startedAt = nowFn();
    const speedEstimator = createSmoothedSpeedEstimator({ startedAt });
    let lastEmitAt = 0;

    return (
      update: {
        status?: "downloading" | "muxing" | "saving";
        statusText: string;
        loaded: number;
        total: number;
        percent?: number;
        speed?: number;
      },
      force = false,
    ) => {
      const now = nowFn();
      if (!force && progressThrottleMs > 0 && now - lastEmitAt < progressThrottleMs) {
        return;
      }
      const smoothedSpeed = speedEstimator.update(update.loaded, now);
      lastEmitAt = now;
      const computedPercent =
        update.percent !== undefined
          ? update.percent
          : update.total > 0
            ? Math.min(99, Math.floor((update.loaded / update.total) * 100))
            : 0;

      options.onProgress?.({
        type: "OFFSCREEN_TASK_PROGRESS",
        taskId,
        status: update.status ?? defaultStatus,
        statusText: update.statusText,
        percent: Math.max(0, Math.min(99, computedPercent)),
        loaded: update.loaded,
        total: update.total,
        speed:
          update.speed !== undefined
            ? Math.max(0, update.speed)
            : update.status === "saving"
              ? 0
              : smoothedSpeed,
      });
    };
  };

  const openOpfsSink = async (
    taskId: string,
    mimeType?: string,
    tag?: string,
  ): Promise<OpfsSinkLike> => {
    if (opfsStorage && typeof opfsStorage.getDirectory === "function") {
      const cleanTag =
        typeof tag === "string" && tag.trim()
          ? `${sanitizeOpfsTaskSlug(tag)}-`
          : "";
      const tempName = `${EXTENSION_OPFS_TEMP_PREFIX}${cleanTag}${sanitizeOpfsTaskSlug(taskId)}-${nowFn()}-${++tempSeq}.tmp`;
      activeOpfsNames.add(tempName);
      const releaseLock = await acquireExclusiveWebLock(webLocks, tempName);
      let root: OpfsDirectoryLike | null = null;
      let writable: OpfsWritableLike | null = null;
      let closed = false;
      let cleaned = false;
      let writeQueue: Promise<void> = Promise.resolve();
      let writeQueueError: unknown = null;
      let cleanupPromise: Promise<void> | null = null;

      try {
        const dir = (await opfsStorage.getDirectory()) as unknown as OpfsDirectoryLike;
        root = dir;
        const handle = await dir.getFileHandle(tempName, { create: true });
        writable = await handle.createWritable();

        const enqueueWrite = (op: () => Promise<void>): Promise<void> => {
          const task = writeQueue.then(async () => {
            if (closed || cleaned) {
              throw new ExtensionDownloadError("临时文件写入流已关闭");
            }
            await op();
          });
          // Keep writeQueue chain settled so close/cleanup can safely drain it
          // without causing unhandled rejections.
          writeQueue = task.catch((err) => {
            if (writeQueueError === null) {
              writeQueueError = err;
            }
          });
          return task;
        };

        const cleanup = (reason?: unknown): Promise<void> => {
          if (cleanupPromise) return cleanupPromise;
          cleaned = true;
          cleanupPromise = (async () => {
            try {
              await writeQueue;
            } catch {
              // Ignore write queue errors during teardown
            }
            if (!closed && writable) {
              closed = true;
              try {
                await writable.abort?.(reason);
              } catch {
                // Ignore
              }
            }
            try {
              await root?.removeEntry(tempName);
            } catch {
              // Ignore NotFound
            }
            activeOpfsNames.delete(tempName);
            releaseLock();
          })();
          return cleanupPromise;
        };

        return {
          tempName,
          rawWritable: writable,
          write(chunk: Uint8Array) {
            return enqueueWrite(() => writable!.write(chunk));
          },
          writeAt(position: number, chunk: Uint8Array) {
            if (!Number.isSafeInteger(position) || position < 0) {
              return Promise.reject(
                new ExtensionDownloadError(`无效的 OPFS 写入偏移：${position}`),
              );
            }
            return enqueueWrite(() =>
              writable!.write({ type: "write", position, data: chunk }),
            );
          },
          markWritableClosed() {
            closed = true;
          },
          async closeAndGetBlob(): Promise<Blob | File> {
            await writeQueue;
            if (cleaned) {
              throw new ExtensionDownloadError("临时文件已被清理");
            }
            if (writeQueueError !== null) {
              throw writeQueueError;
            }
            if (!closed) {
              closed = true;
              await writable!.close();
            }
            const rawFile = await handle.getFile();
            if (!rawFile || rawFile.size === 0) {
              await cleanup();
              throw new ExtensionDownloadError("下载产物为空");
            }
            return rawFile;
          },
          cleanup,
        };
      } catch (err) {
        try {
          await root?.removeEntry(tempName);
        } catch {
          // Ignore
        }
        activeOpfsNames.delete(tempName);
        releaseLock();
        throw err;
      }
    }

    // Fallback when OPFS is absent in a stripped test environment
    const segments: Array<{ position: number; data: Uint8Array }> = [];
    let seqCursor = 0;
    let maxEnd = 0;
    let memWriteQueue: Promise<void> = Promise.resolve();
    let memWriteError: unknown = null;
    let memClosed = false;
    let memCleaned = false;

    const enqueueMemWrite = (op: () => void): Promise<void> => {
      const task = memWriteQueue.then(() => {
        if (memClosed || memCleaned) {
          throw new ExtensionDownloadError("临时文件写入流已关闭");
        }
        op();
      });
      memWriteQueue = task.catch((err) => {
        if (memWriteError === null) {
          memWriteError = err;
        }
      });
      return task;
    };

    return {
      tempName: undefined as string | undefined,
      write(chunk: Uint8Array) {
        const copy = chunk.slice();
        return enqueueMemWrite(() => {
          segments.push({ position: seqCursor, data: copy });
          seqCursor += copy.byteLength;
          if (seqCursor > maxEnd) maxEnd = seqCursor;
        });
      },
      writeAt(position: number, chunk: Uint8Array) {
        if (!Number.isSafeInteger(position) || position < 0) {
          return Promise.reject(
            new ExtensionDownloadError(`无效的写入偏移：${position}`),
          );
        }
        const copy = chunk.slice();
        return enqueueMemWrite(() => {
          segments.push({ position, data: copy });
          const end = position + copy.byteLength;
          if (end > maxEnd) maxEnd = end;
        });
      },
      async closeAndGetBlob(): Promise<Blob> {
        await memWriteQueue;
        if (memCleaned) {
          throw new ExtensionDownloadError("临时文件已被清理");
        }
        if (memWriteError !== null) {
          throw memWriteError;
        }
        memClosed = true;
        if (maxEnd === 0) {
          segments.length = 0;
          throw new ExtensionDownloadError("下载产物为空");
        }
        let strictlySequential = true;
        let expectedPos = 0;
        for (const seg of segments) {
          if (seg.position !== expectedPos) {
            strictlySequential = false;
            break;
          }
          expectedPos += seg.data.byteLength;
        }
        let blob: Blob;
        if (strictlySequential && expectedPos === maxEnd) {
          blob = new Blob(
            segments.map((s) => s.data) as BlobPart[],
            { type: mimeType || "application/octet-stream" },
          );
        } else {
          const assembled = new Uint8Array(maxEnd);
          for (const seg of segments) {
            assembled.set(seg.data, seg.position);
          }
          blob = new Blob([assembled], {
            type: mimeType || "application/octet-stream",
          });
        }
        segments.length = 0;
        if (blob.size === 0) {
          throw new ExtensionDownloadError("下载产物为空");
        }
        return blob;
      },
      async cleanup() {
        memCleaned = true;
        try {
          await memWriteQueue;
        } catch {
          // Ignore
        }
        segments.length = 0;
        seqCursor = 0;
        maxEnd = 0;
      },
    };
  };

  const handoffSinkAndWaitRelease = async (params: {
    taskId: string;
    spec: OffscreenDownloadSpec;
    sink: OpfsSinkLike;
    signal: AbortSignal;
    reportProgress: ReturnType<typeof createProgressReporter>;
  }): Promise<void> => {
    const { taskId, spec, sink, signal, reportProgress } = params;
    throwIfAborted(signal);
    const fileBlob = await sink.closeAndGetBlob();
    throwIfAborted(signal);

    // OPFS temporary files (`*.tmp`) report `fileBlob.type === ""` and temp names,
    // which Chromium's DownloadTargetDeterminer can turn into `.txt` or UUID filenames.
    // Wrapping `[fileBlob]` in a `File` with the leaf filename & authoritative MIME preserves
    // zero-copy OPFS disk backing in Blink while giving `chrome.downloads` both name and type.
    const effectiveMime = resolveBlobMimeType(spec.filename, spec.mimeType);
    const leafFilename =
      (spec.filename || "")
        .split(/[/\\]+/)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .pop() || "download.bin";
    const isMatchingFile =
      typeof File === "function" &&
      fileBlob instanceof File &&
      fileBlob.name === leafFilename &&
      fileBlob.type === effectiveMime;
    const typedBlob: Blob = isMatchingFile
      ? fileBlob
      : typeof File === "function"
        ? new File([fileBlob], leafFilename, { type: effectiveMime })
        : fileBlob.type === effectiveMime
          ? fileBlob
          : new Blob([fileBlob], { type: effectiveMime });
    const blobUrl = urlApi.createObjectURL(typedBlob);
    let resolveRelease!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });

    pendingBlobs.set(blobUrl, {
      taskId,
      blobUrl,
      opfsTempName: sink.tempName,
      resolve: resolveRelease,
    });

    reportProgress(
      {
        status: "saving",
        statusText: "正在交接浏览器落盘...",
        loaded: fileBlob.size,
        total: fileBlob.size,
        percent: 99,
      },
      true,
    );

    try {
      await options.handoffBlobDownload({
        type: "HANDOFF_BLOB_DOWNLOAD",
        taskId,
        blobUrl,
        filename: spec.filename,
        mimeType: spec.mimeType,
        sizeBytes: fileBlob.size,
        ...(sink.tempName ? { opfsTempName: sink.tempName } : {}),
      });
      await releasePromise;
    } finally {
      pendingBlobs.delete(blobUrl);
      try {
        urlApi.revokeObjectURL(blobUrl);
      } catch {
        // Ignore
      }
      await sink.cleanup();
      notifyIfIdle();
    }
  };

  const executeDirectFile = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<void> => {
    const reportProgress = createProgressReporter(taskId, "downloading");
    const result = await streamResumableRouteToOpfs({
      taskId,
      routes: spec.routes,
      spec,
      fetchFn,
      openOpfsSink,
      signal,
      estimatedSize: spec.sizeBytes,
      sinkMimeType: spec.mimeType,
      errorLabel: "媒体源",
      maxConcurrency: DEFAULT_DIRECT_FILE_MAX_CONCURRENCY,
      apiOrigin: spec.apiOrigin,
      onRouteStart({ routeIndex, routeCount, total, isFreshRetry }) {
        reportProgress(
          {
            status: "downloading",
            statusText: isFreshRetry
              ? "正在重新流式下载..."
              : routeCount > 1 && routeIndex > 0
                ? `备用线路 ${routeIndex + 1}/${routeCount} 下载中...`
                : "正在流式下载...",
            loaded: 0,
            total,
            percent: 0,
          },
          true,
        );
      },
      onProgress({ loaded, total, resumed }) {
        reportProgress({
          status: "downloading",
          statusText: resumed ? "断点续传下载中..." : "正在流式下载...",
          loaded,
          total,
        });
      },
    });

    try {
      await handoffSinkAndWaitRelease({
        taskId,
        spec,
        sink: result.sink,
        signal,
        reportProgress,
      });
    } catch (err) {
      await result.sink.cleanup(err);
      throw err;
    }
  };

  const resolveHlsVodSegments = async (
    manifestUrl: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<OffscreenSegmentSpec[]> => {
    const resp = await fetchWhitelisted(
      manifestUrl,
      spec,
      { method: "GET" },
      signal,
    );
    if (resp.status !== 200) {
      void resp.body?.cancel?.().catch(() => {});
      throw new ExtensionDownloadError(`HLS 清单返回 HTTP ${resp.status}`);
    }
    const text = await resp.text();
    if (text.length > 2 * 1024 * 1024) {
      throw new ExtensionDownloadError("HLS 清单体积超过安全上限");
    }
    if (
      !text.trimStart().startsWith("#EXTM3U") ||
      !text.includes("#EXT-X-ENDLIST") ||
      /#EXT-X-STREAM-INF|#EXT-X-MEDIA:|#EXT-X-KEY|#EXT-X-DISCONTINUITY/.test(
        text,
      )
    ) {
      throw new ExtensionDownloadError(
        "当前 HLS 清单包含加密、多轨或非完整点播流，暂不支持直接拼接",
      );
    }

    const segments: OffscreenSegmentSpec[] = [];
    let previousEnd: number | null = null;
    let previousUrl = "";
    let pendingRange: string | null = null;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-MAP:")) {
        const uri = /URI="([^"]+)"/.exec(line)?.[1];
        if (!uri || segments.length > 0) {
          throw new ExtensionDownloadError("HLS 初始化段格式无效");
        }
        const resolvedUrl = sourceUrl({ url: new URL(uri, manifestUrl).href });
        assertWhitelisted(resolvedUrl, spec);
        const rawRange = /BYTERANGE="([^"]+)"/.exec(line)?.[1];
        const range = rawRange ? parseByteRangeDirective(rawRange, null) : null;
        if (rawRange && !range) {
          throw new ExtensionDownloadError("HLS 初始化段字节范围无效");
        }
        segments.push({ url: resolvedUrl, ...(range || {}) });
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        if (pendingRange !== null) {
          throw new ExtensionDownloadError("HLS 连续 BYTERANGE 指令无效");
        }
        pendingRange = line.slice("#EXT-X-BYTERANGE:".length);
      } else if (!line.startsWith("#")) {
        const resolvedUrl = sourceUrl({ url: new URL(line, manifestUrl).href });
        assertWhitelisted(resolvedUrl, spec);
        if (
          pendingRange &&
          !pendingRange.includes("@") &&
          (previousEnd === null || resolvedUrl !== previousUrl)
        ) {
          throw new ExtensionDownloadError("HLS 隐式连续字节区间缺少前置偏移");
        }
        const range: { start: number; length: number } | null = pendingRange
          ? parseByteRangeDirective(pendingRange, previousEnd)
          : null;
        if (pendingRange && !range) {
          throw new ExtensionDownloadError("HLS 分片字节范围无效");
        }
        segments.push({ url: resolvedUrl, ...(range || {}) });
        previousEnd = range ? range.start + range.length : null;
        previousUrl = resolvedUrl;
        pendingRange = null;
        if (segments.length > 2000) {
          throw new ExtensionDownloadError("HLS 分片数量超过 2000 上限");
        }
      }
    }

    if (segments.length === 0 || pendingRange !== null) {
      throw new ExtensionDownloadError("HLS 清单未解析出有效分片");
    }
    return segments;
  };

  const streamSingleSegment = async (params: {
    seg: OffscreenSegmentSpec;
    spec: OffscreenDownloadSpec;
    signal: AbortSignal;
    write: (chunk: Uint8Array) => Promise<void>;
    onChunkBytes?: (bytes: number) => void;
    maxBytes?: number;
    maxBytesError?: string;
  }): Promise<number> => {
    const { seg, spec, signal, write, onChunkBytes, maxBytes, maxBytesError } =
      params;
    const candidates = Array.from(
      new Set([seg.url, ...(seg.routes ?? [])].map((u) => u.trim()).filter(Boolean)),
    );
    if (candidates.length === 0) {
      throw new ExtensionDownloadError("分片缺少下载链接");
    }

    const hasRange =
      typeof seg.start === "number" &&
      typeof seg.length === "number" &&
      seg.start >= 0 &&
      seg.length > 0;
    const headers: Record<string, string> = {};
    if (hasRange) {
      headers.Range = `bytes=${seg.start!}-${seg.start! + seg.length! - 1}`;
    }

    let lastErr: unknown;
    const attempts = candidates.length > 1 ? candidates : [candidates[0], candidates[0]];

    for (let i = 0; i < attempts.length; i++) {
      throwIfAborted(signal);
      const url = attempts[i];
      const bufferedChunks: Uint8Array[] = [];
      try {
        const resp = await fetchWhitelisted(
          url,
          spec,
          { method: "GET", headers },
          signal,
        );
        if (hasRange) {
          const cr = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(
            resp.headers.get("Content-Range") || "",
          );
          const expectedEnd = seg.start! + seg.length! - 1;
          if (
            resp.status !== 206 ||
            !cr ||
            Number(cr[1]) !== seg.start ||
            Number(cr[2]) !== expectedEnd
          ) {
            void resp.body?.cancel?.().catch(() => {});
            throw new ExtensionDownloadError("分片服务器未返回预期字节区间");
          }
        } else if (resp.status !== 200) {
          void resp.body?.cancel?.().catch(() => {});
          throw new ExtensionDownloadError(
            `分片请求失败（HTTP ${resp.status}）`,
          );
        }

        // Buffer single segment in memory before committing to sink so a mid-segment
        // failure on attempt 1 never corrupts the concatenated OPFS file before retry!
        const bytesRead = await streamResponseBodyToWriter({
          response: resp,
          write: async (chunk) => {
            bufferedChunks.push(chunk.slice());
          },
          signal,
          maxBytes,
          maxBytesError,
        });

        if (hasRange && bytesRead !== seg.length) {
          throw new ExtensionDownloadError("分片字节长度与声明区间不符");
        }

        for (const chunk of bufferedChunks) {
          await write(chunk);
          onChunkBytes?.(chunk.byteLength);
        }
        return bytesRead;
      } catch (err) {
        if (isAbortLikeError(err, signal)) throw err;
        if (
          err instanceof ExtensionDownloadError &&
          (err.code === "UNWHITELISTED_CDN" ||
            err.message === ARCHIVE_LIMIT_ERROR)
        ) {
          if (candidates.length === 1) throw err;
        }
        lastErr = err;
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new ExtensionDownloadError("分片下载失败");
  };

  const executeSegmentsList = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    segments: OffscreenSegmentSpec[],
    signal: AbortSignal,
  ): Promise<void> => {
    if (segments.length === 0 || segments.length > 2000) {
      throw new ExtensionDownloadError("分片数量无效");
    }

    const reportProgress = createProgressReporter(taskId, "downloading");
    const knownTotal = segments.every((s) => typeof s.length === "number" && s.length > 0)
      ? segments.reduce((sum, s) => sum + (s.length || 0), 0)
      : spec.sizeBytes || 0;

    const sink = await openOpfsSink(taskId, spec.mimeType);
    let totalLoaded = 0;

    try {
      for (let i = 0; i < segments.length; i++) {
        throwIfAborted(signal);
        const seg = segments[i];
        await streamSingleSegment({
          seg,
          spec,
          signal,
          write: (chunk) => sink.write(chunk),
          onChunkBytes: (bytes) => {
            totalLoaded += bytes;
            const pct =
              knownTotal > 0
                ? Math.min(99, Math.floor((totalLoaded / knownTotal) * 100))
                : Math.min(99, Math.floor(((i + 0.5) / segments.length) * 100));
            reportProgress({
              status: "downloading",
              statusText: `正在下载分片 ${i + 1}/${segments.length}...`,
              loaded: totalLoaded,
              total: knownTotal,
              percent: pct,
            });
          },
        });
        const donePct = Math.min(
          99,
          Math.floor(((i + 1) / segments.length) * 100),
        );
        reportProgress(
          {
            status: "downloading",
            statusText: `已合并分片 ${i + 1}/${segments.length}...`,
            loaded: totalLoaded,
            total: knownTotal,
            percent: donePct,
          },
          i === segments.length - 1,
        );
      }

      await handoffSinkAndWaitRelease({
        taskId,
        spec,
        sink,
        signal,
        reportProgress,
      });
    } catch (err) {
      await sink.cleanup(err);
      throw err;
    }
  };

  const executeHls = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<void> => {
    const manifestRoutes = spec.routes.map((r) => r.trim()).filter(Boolean);
    if (manifestRoutes.length === 0) {
      throw new ExtensionDownloadError("缺少 HLS 清单地址");
    }

    let resolvedSegments: OffscreenSegmentSpec[] | null = null;
    let lastErr: unknown;
    for (const route of manifestRoutes) {
      throwIfAborted(signal);
      try {
        resolvedSegments = await resolveHlsVodSegments(route, spec, signal);
        break;
      } catch (err) {
        if (isAbortLikeError(err, signal)) throw err;
        lastErr = err;
      }
    }

    if (!resolvedSegments) {
      throw lastErr instanceof Error
        ? lastErr
        : new ExtensionDownloadError("HLS 清单解析失败");
    }

    await executeSegmentsList(taskId, spec, resolvedSegments, signal);
  };

  const executeBatchZip = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<void> => {
    const entries = spec.zipEntries ?? [];
    if (entries.length === 0) {
      throw new ExtensionDownloadError("ZIP 打包列表为空");
    }

    let upfrontBytes = 0;
    for (const entry of entries) {
      upfrontBytes += entry.sizeBytes || 0;
      if (upfrontBytes > MAX_BATCH_ZIP_BYTES) {
        throw new ExtensionDownloadError(ARCHIVE_LIMIT_ERROR);
      }
    }

    const reportProgress = createProgressReporter(taskId, "downloading");
    const zip = new JSZip();
    let totalBytes = 0;

    for (let i = 0; i < entries.length; i++) {
      throwIfAborted(signal);
      const entry = entries[i];
      const safeEntryPath = sanitizeZipEntryPath(entry.entryName, i);
      const remaining = MAX_BATCH_ZIP_BYTES - totalBytes;
      if (remaining <= 0) {
        throw new ExtensionDownloadError(ARCHIVE_LIMIT_ERROR);
      }

      if (entry.segments && entry.segments.length > 0) {
        const segParts: Uint8Array[] = [];
        let segBytes = 0;
        for (const seg of entry.segments) {
          const left = remaining - segBytes;
          if (left <= 0) {
            throw new ExtensionDownloadError(ARCHIVE_LIMIT_ERROR);
          }
          await streamSingleSegment({
            seg,
            spec,
            signal,
            write: async (chunk) => {
              segParts.push(chunk);
              segBytes += chunk.byteLength;
            },
            maxBytes: left,
            maxBytesError: ARCHIVE_LIMIT_ERROR,
          });
        }
        const merged = new Uint8Array(segBytes);
        let offset = 0;
        for (const p of segParts) {
          merged.set(p, offset);
          offset += p.byteLength;
        }
        totalBytes += merged.byteLength;
        zip.file(safeEntryPath, merged, { compression: "STORE" });
      } else {
        const routes = entry.routes.map((r) => r.trim()).filter(Boolean);
        if (routes.length === 0) {
          throw new ExtensionDownloadError(`打包条目 #${i + 1} 缺少下载线路`);
        }
        let fetchedBytes: Uint8Array | null = null;
        let lastRouteErr: unknown;
        for (const route of routes) {
          throwIfAborted(signal);
          try {
            const resp = await fetchWhitelisted(
              route,
              spec,
              { method: "GET" },
              signal,
            );
            if (resp.status !== 200) {
              void resp.body?.cancel?.().catch(() => {});
              throw new ExtensionDownloadError(`条目返回 HTTP ${resp.status}`);
            }
            const contentType = String(
              resp.headers?.get?.("content-type") || "",
            )
              .split(";")[0]
              .trim()
              .toLowerCase();
            if (
              contentType === "text/html" ||
              contentType === "application/xhtml+xml" ||
              contentType === "image/svg+xml"
            ) {
              void resp.body?.cancel?.().catch(() => {});
              throw new ExtensionDownloadError(
                `打包条目 #${i + 1} 返回非媒体内容类型（${contentType}）`,
              );
            }
            const parts: Uint8Array[] = [];
            let len = 0;
            await streamResponseBodyToWriter({
              response: resp,
              write: async (chunk) => {
                parts.push(chunk.slice());
                len += chunk.byteLength;
              },
              signal,
              maxBytes: remaining,
              maxBytesError: ARCHIVE_LIMIT_ERROR,
            });
            const combined = new Uint8Array(len);
            let offset = 0;
            for (const p of parts) {
              combined.set(p, offset);
              offset += p.byteLength;
            }
            fetchedBytes = combined;
            break;
          } catch (err) {
            if (isAbortLikeError(err, signal)) throw err;
            if (
              err instanceof Error &&
              err.message === ARCHIVE_LIMIT_ERROR
            ) {
              throw err;
            }
            lastRouteErr = err;
          }
        }
        if (!fetchedBytes) {
          throw lastRouteErr instanceof Error
            ? lastRouteErr
            : new ExtensionDownloadError(`打包条目 #${i + 1} 下载失败`);
        }
        totalBytes += fetchedBytes.byteLength;
        zip.file(safeEntryPath, fetchedBytes, { compression: "STORE" });
      }

      reportProgress(
        {
          status: "downloading",
          statusText: `正在收集打包文件 ${i + 1}/${entries.length}...`,
          loaded: totalBytes,
          total: upfrontBytes || totalBytes,
          percent: Math.round(((i + 1) / entries.length) * 85),
        },
        true,
      );
    }

    const sink = await openOpfsSink(taskId, "application/zip");
    try {
      throwIfAborted(signal);
      const zipBytes = await zip.generateAsync(
        { type: "uint8array", compression: "STORE" },
        (meta) => {
          reportProgress({
            status: "downloading",
            statusText: "正在写入 ZIP 压缩包...",
            loaded: totalBytes,
            total: totalBytes,
            percent: Math.min(98, 85 + Math.round(meta.percent * 0.13)),
          });
        },
      );
      throwIfAborted(signal);
      await sink.write(zipBytes);

      await handoffSinkAndWaitRelease({
        taskId,
        spec: { ...spec, mimeType: "application/zip" },
        sink,
        signal,
        reportProgress,
      });
    } catch (err) {
      await sink.cleanup(err);
      throw err;
    }
  };

  const executeYouTubeDirect = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<void> => {
    const url = spec.routes[0]?.trim() || "";
    if (!url) {
      throw new ExtensionDownloadError("缺少 YouTube 媒体流地址");
    }
    assertWhitelisted(url, spec);
    activeDynamicAllowedOriginsByTask.set(
      taskId,
      getAllowedOriginsForSpec(spec),
    );
    const reportProgress = createProgressReporter(taskId, "downloading");

    try {
      await youtubeBridge.downloadDirect({
        taskId,
        url,
        filename: spec.filename,
        sizeBytes: spec.sizeBytes,
        signal,
        onProgress(detail) {
          reportProgress(
            {
              status: "downloading",
              statusText:
                detail.statusText ||
                `YouTube 分块并发下载中（${detail.percent}%）...`,
              loaded: detail.loaded,
              total: detail.total,
              percent: detail.percent,
            },
            Boolean(detail.statusText),
          );
        },
      });
    } finally {
      activeDynamicAllowedOriginsByTask.delete(taskId);
      notifyIfIdle();
    }
  };

  const executeYouTubeMux = async (
    taskId: string,
    spec: OffscreenDownloadSpec,
    signal: AbortSignal,
  ): Promise<void> => {
    const mux = spec.youtubeMux;
    if (!mux) {
      throw new ExtensionDownloadError("缺少 YouTube 音视频合流参数");
    }
    assertWhitelisted(mux.videoUrl, spec);
    assertWhitelisted(mux.audioUrl, spec);

    activeDynamicAllowedOriginsByTask.set(
      taskId,
      getAllowedOriginsForSpec(spec),
    );
    const reportProgress = createProgressReporter(taskId, "muxing");

    try {
      await youtubeBridge.downloadMux({
        taskId,
        videoUrl: mux.videoUrl,
        audioUrl: mux.audioUrl,
        videoSize: mux.videoSize,
        audioSize: mux.audioSize,
        filename: spec.filename,
        outputContainer: mux.outputContainer,
        signal,
        onProgress(detail) {
          reportProgress(
            {
              status: "muxing",
              statusText:
                detail.statusText ||
                `YouTube 无损合流中（${detail.percent}%）...`,
              loaded: detail.loaded,
              total: detail.total,
              percent: detail.percent,
            },
            Boolean(detail.statusText),
          );
        },
      });
    } finally {
      activeDynamicAllowedOriginsByTask.delete(taskId);
      notifyIfIdle();
    }
  };

  // Module boundary: each independent download `kind` added in the future (e.g.
  // `dash_mux` -> `./dashMuxDownload.ts`) MUST live in its own dedicated module
  // file rather than appending new transport implementations into
  // `extensionDownload.ts`. Keep `runSingleTask` as a lightweight dispatcher.
  const runSingleTask = async (entry: QueuedTaskEntry): Promise<void> => {
    const { taskId, spec, controller } = entry;
    const { signal } = controller;

    try {
      throwIfAborted(signal);
      switch (spec.kind) {
        case "direct_file":
          await executeDirectFile(taskId, spec, signal);
          break;
        case "youtube_direct":
          await executeYouTubeDirect(taskId, spec, signal);
          break;
        case "youtube_mux":
          await executeYouTubeMux(taskId, spec, signal);
          break;
        case "dash_mux":
          await executeDashMux({
            taskId,
            spec,
            signal,
            fetchFn,
            opfsStorage,
            openOpfsSink,
            reportProgress: createProgressReporter(taskId, "downloading"),
            handoffSinkAndWaitRelease,
            mediabunnyMod: options.mediabunnyImpl,
            onEnterTask: () => {
              activeDynamicAllowedOriginsByTask.set(
                taskId,
                getAllowedOriginsForSpec(spec),
              );
            },
            onExitTask: () => {
              activeDynamicAllowedOriginsByTask.delete(taskId);
              notifyIfIdle();
            },
          });
          break;
        case "hls":
          await executeHls(taskId, spec, signal);
          break;
        case "segments":
          await executeSegmentsList(taskId, spec, spec.segments ?? [], signal);
          break;
        case "batch_zip":
          await executeBatchZip(taskId, spec, signal);
          break;
        default:
          throw new ExtensionDownloadError("未知的下载任务类型");
      }
    } catch (err) {
      const cancelled = isAbortLikeError(err, signal);
      const extErr = err instanceof ExtensionDownloadError ? err : null;
      const errCode =
        extErr?.code ||
        (typeof (err as { code?: unknown })?.code === "string"
          ? ((err as { code: string }).code as string)
          : undefined);
      const httpStatus =
        extErr?.httpStatus ??
        (typeof (err as { httpStatus?: unknown })?.httpStatus === "number"
          ? (err as { httpStatus: number }).httpStatus
          : undefined);
      options.onError?.({
        type: "OFFSCREEN_TASK_ERROR",
        taskId,
        error: cancelled
          ? "已取消"
          : err instanceof Error && err.message
            ? err.message
            : "下载执行失败",
        ...(errCode ? { code: errCode } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(cancelled ? { cancelled: true } : {}),
        ...(extErr?.unwhitelistedHost
          ? { unwhitelistedHost: extErr.unwhitelistedHost }
          : {}),
        ...(extErr?.fallbackUrl
          ? { fallbackUrl: extErr.fallbackUrl }
          : spec.routes[0]
            ? { fallbackUrl: spec.routes[0] }
            : {}),
      });
    }
  };

  const pumpQueue = () => {
    while (activeRunningCount < maxConcurrentTasks && waitQueue.length > 0) {
      const next = waitQueue.shift()!;
      if (next.controller.signal.aborted) {
        activeTaskEntries.delete(next.taskId);
        continue;
      }
      next.started = true;
      activeRunningCount += 1;
      void runSingleTask(next).finally(() => {
        activeRunningCount = Math.max(0, activeRunningCount - 1);
        activeTaskEntries.delete(next.taskId);
        pumpQueue();
        notifyIfIdle();
      });
    }
    notifyIfIdle();
  };

  return {
    startTask(taskId: string, spec: OffscreenDownloadSpec): { accepted: boolean } {
      const existing = activeTaskEntries.get(taskId);
      if (existing) {
        existing.controller.abort();
        activeTaskEntries.delete(taskId);
      }
      const entry: QueuedTaskEntry = {
        taskId,
        spec,
        controller: new AbortController(),
        started: false,
      };
      activeTaskEntries.set(taskId, entry);
      waitQueue.push(entry);
      pumpQueue();
      return { accepted: true };
    },

    cancelTask(taskId: string): { cancelled: boolean } {
      let found = false;
      const entry = activeTaskEntries.get(taskId);
      if (entry) {
        found = true;
        entry.controller.abort();
        if (!entry.started) {
          const idx = waitQueue.indexOf(entry);
          if (idx >= 0) {
            waitQueue.splice(idx, 1);
          }
          activeTaskEntries.delete(taskId);
          options.onError?.({
            type: "OFFSCREEN_TASK_ERROR",
            taskId,
            error: "已取消",
            code: "USER_CANCELLED",
            cancelled: true,
          });
        }
      }
      // Also release any orphaned blob wait for this task if cancelled
      for (const [blobUrl, pending] of Array.from(pendingBlobs.entries())) {
        if (pending.taskId === taskId) {
          pendingBlobs.delete(blobUrl);
          pending.resolve();
          found = true;
        }
      }
      if (youtubeBridge.releaseBlobsForTask(taskId) > 0) {
        found = true;
      }
      notifyIfIdle();
      return { cancelled: found };
    },

    releaseBlob(params: {
      taskId: string;
      blobUrl: string;
      opfsTempName?: string;
    }): { released: boolean } {
      let released = false;
      const own = pendingBlobs.get(params.blobUrl);
      if (own) {
        pendingBlobs.delete(params.blobUrl);
        own.resolve();
        released = true;
      }
      if (
        youtubeBridge.releaseBlob({
          taskId: params.taskId,
          blobUrl: params.blobUrl,
        })
      ) {
        released = true;
      }
      notifyIfIdle();
      return { released };
    },

    requestYouTubePrefetch(
      payload: YouTubeHelperPrefetchPayload,
      reqOpts?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<YouTubeHelperPrefetchResult> {
      return youtubeBridge.requestPrefetch(payload, reqOpts);
    },

    requestYouTubePlayer(
      payload: YouTubeHelperPlayerPayload,
      reqOpts?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<YouTubeHelperPlayerResult> {
      return youtubeBridge.requestPlayer(payload, reqOpts);
    },

    getHelperVersion(): string {
      return youtubeBridge.getHelperVersion();
    },

    getActiveTaskCount(): number {
      return activeRunningCount + waitQueue.length;
    },

    getPendingBlobCount(): number {
      return pendingBlobs.size + youtubeBridge.getPendingBlobCount();
    },

    getActiveOpfsTempNames(): ReadonlySet<string> {
      return activeOpfsNames;
    },

    getActiveDynamicAllowedOrigins(): string[] | undefined {
      return getUnionDynamicAllowedOrigins();
    },

    waitForIdle(): Promise<void> {
      if (
        activeRunningCount === 0 &&
        waitQueue.length === 0 &&
        pendingBlobs.size === 0 &&
        youtubeBridge.getPendingBlobCount() === 0
      ) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    dispose(): void {
      for (const entry of waitQueue.splice(0)) {
        entry.controller.abort();
      }
      for (const [, entry] of Array.from(activeTaskEntries.entries())) {
        entry.controller.abort();
      }
      activeTaskEntries.clear();
      for (const [, pending] of Array.from(pendingBlobs.entries())) {
        pending.resolve();
      }
      pendingBlobs.clear();
      activeDynamicAllowedOriginsByTask.clear();
      youtubeBridge.dispose();
      notifyIfIdle();
    },
  };
}
