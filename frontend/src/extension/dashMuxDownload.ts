import {
  runDashMuxToOpfs,
  type DashMuxOpfsSink,
  type DashMuxTrackFetchParams,
  type DashMuxTrackFetchResult,
} from "./dashMuxEngine";
import {
  DEFAULT_DASH_AUDIO_MAX_CONCURRENCY,
  DEFAULT_DASH_VIDEO_MAX_CONCURRENCY,
  ExtensionDownloadError,
  ensureOpfsQuotaAvailable,
  streamResumableRouteToOpfs,
  throwIfAborted,
  type OpfsSinkLike,
  type OpfsStorageLike,
} from "./opfsStreamTransfer";
import type { OffscreenDownloadSpec } from "./protocol";

export { extractDashMuxSpec } from "./dashMuxSpec";

/** Safety floor (64 MiB) when DASH track byte sizes are unknown up front. */
export const DEFAULT_UNKNOWN_DASH_QUOTA_BYTES = 64 * 1024 * 1024;

/**
 * Estimates required OPFS headroom before starting concurrent DASH track downloads.
 * Peak OPFS footprint during lossless muxing is ~2x `(videoSize + audioSize)`
 * because both intermediate tracks remain on disk until the 3rd output MP4 finishes.
 */
export function computePreDownloadDashQuotaBytes(
  spec: OffscreenDownloadSpec,
): number {
  const dashMux = spec.dashMux;
  const vSize =
    typeof dashMux?.videoSize === "number" &&
    Number.isFinite(dashMux.videoSize) &&
    dashMux.videoSize > 0
      ? dashMux.videoSize
      : 0;
  const aSize =
    typeof dashMux?.audioSize === "number" &&
    Number.isFinite(dashMux.audioSize) &&
    dashMux.audioSize > 0
      ? dashMux.audioSize
      : 0;
  const trackSum = vSize + aSize;
  const specSize =
    typeof spec.sizeBytes === "number" &&
    Number.isFinite(spec.sizeBytes) &&
    spec.sizeBytes > 0
      ? spec.sizeBytes
      : 0;
  const expectedTotal = trackSum > 0 ? trackSum : specSize;
  return expectedTotal > 0
    ? Math.ceil(expectedTotal * 2.15)
    : DEFAULT_UNKNOWN_DASH_QUOTA_BYTES;
}

export interface FetchDashTrackToOpfsParams {
  taskId: string;
  spec: OffscreenDownloadSpec;
  trackParams: DashMuxTrackFetchParams;
  fetchFn: typeof fetch;
  stallTimeoutMs?: number;
  openOpfsSink: (
    taskId: string,
    mimeType?: string,
    tag?: string,
  ) => Promise<OpfsSinkLike>;
}

/**
 * Downloads a single DASH video or audio track into an isolated OPFS temp sink
 * using the shared resumable streaming helper (with Range resume + 403/410 expiry detection).
 */
export async function fetchDashTrackToOpfs(
  params: FetchDashTrackToOpfsParams,
): Promise<DashMuxTrackFetchResult> {
  const { taskId, spec, trackParams, fetchFn, stallTimeoutMs, openOpfsSink } = params;
  const { role, routes, estimatedSize, signal: trackSignal, onProgress } =
    trackParams;
  const trackLabel = role === "video" ? "视频轨" : "音频轨";
  const trackTag = role === "video" ? "dash-v" : "dash-a";
  const trackMime = role === "video" ? "video/mp4" : "audio/mp4";
  const maxConcurrency =
    role === "video"
      ? DEFAULT_DASH_VIDEO_MAX_CONCURRENCY
      : DEFAULT_DASH_AUDIO_MAX_CONCURRENCY;

  const transferred = await streamResumableRouteToOpfs({
    taskId,
    routes,
    spec,
    fetchFn,
    openOpfsSink,
    signal: trackSignal,
    estimatedSize,
    sinkMimeType: trackMime,
    sinkTag: trackTag,
    errorLabel: trackLabel,
    maxConcurrency,
    stallTimeoutMs,
    apiOrigin: spec.apiOrigin,
    onProgress({ loaded, total }) {
      onProgress({ loaded, total });
    },
  });

  try {
    const blob = await transferred.sink.closeAndGetBlob();
    throwIfAborted(trackSignal);
    return {
      blob,
      sink: transferred.sink as DashMuxOpfsSink,
      byteLength: transferred.byteLength,
    };
  } catch (err) {
    await transferred.sink.cleanup(err);
    throw err;
  }
}

export interface DashMuxProgressReporter {
  (
    update: {
      status?: "downloading" | "muxing" | "saving";
      statusText: string;
      loaded: number;
      total: number;
      percent?: number;
      speed?: number;
    },
    force?: boolean,
  ): void;
}

export interface ExecuteDashMuxParams {
  taskId: string;
  spec: OffscreenDownloadSpec;
  signal: AbortSignal;
  fetchFn: typeof fetch;
  opfsStorage: OpfsStorageLike | StorageManager | null | undefined;
  openOpfsSink: (
    taskId: string,
    mimeType?: string,
    tag?: string,
  ) => Promise<OpfsSinkLike>;
  reportProgress: DashMuxProgressReporter;
  handoffSinkAndWaitRelease: (params: {
    taskId: string;
    spec: OffscreenDownloadSpec;
    sink: OpfsSinkLike;
    signal: AbortSignal;
    reportProgress: DashMuxProgressReporter;
  }) => Promise<void>;
  mediabunnyMod?: Record<string, unknown> | null;
  stallTimeoutMs?: number;
  onEnterTask?: () => void;
  onExitTask?: () => void;
}

/**
 * Dedicated download executor for `spec.kind === "dash_mux"`.
 * Performs:
 * 1. Pre-download OPFS quota precheck (~2.15x expected total or 64 MiB floor);
 * 2. Concurrent resumable video + audio track downloads into 2 OPFS temp files;
 * 3. Pre-mux OPFS quota precheck (~1.1x exact combined track bytes) right before
 *    opening the 3rd output MP4 sink;
 * 4. Lossless MP4 stream-copy mux via `mediabunny` and browser download handoff.
 */
export async function executeDashMux(
  params: ExecuteDashMuxParams,
): Promise<void> {
  const {
    taskId,
    spec,
    signal,
    fetchFn,
    opfsStorage,
    openOpfsSink,
    reportProgress,
    handoffSinkAndWaitRelease,
    mediabunnyMod,
    stallTimeoutMs,
    onEnterTask,
    onExitTask,
  } = params;

  const dashMux = spec.dashMux;
  if (
    !dashMux ||
    !Array.isArray(dashMux.videoRoutes) ||
    dashMux.videoRoutes.length === 0 ||
    !Array.isArray(dashMux.audioRoutes) ||
    dashMux.audioRoutes.length === 0
  ) {
    throw new ExtensionDownloadError("缺少 DASH 音视频合流参数");
  }

  // 1) Pre-download OPFS quota precheck BEFORE issuing any network fetch
  await ensureOpfsQuotaAvailable(
    opfsStorage,
    computePreDownloadDashQuotaBytes(spec),
    signal,
  );

  onEnterTask?.();
  try {
    const outputSink = await runDashMuxToOpfs({
      taskId,
      spec: dashMux,
      fetchTrackToOpfs: (trackParams) =>
        fetchDashTrackToOpfs({
          taskId,
          spec,
          trackParams,
          fetchFn,
          stallTimeoutMs,
          openOpfsSink,
        }),
      openOpfsSink: openOpfsSink as (
        tid: string,
        mimeType?: string,
        tag?: string,
      ) => Promise<DashMuxOpfsSink>,
      beforeOpenOutputSink: async ({ totalInputBytes }) => {
        // 2) Pre-mux OPFS quota precheck right before opening the 3rd output sink
        await ensureOpfsQuotaAvailable(
          opfsStorage,
          Math.ceil(totalInputBytes * 1.1),
          signal,
        );
      },
      signal,
      mediabunnyMod,
      onProgress(update) {
        reportProgress(
          {
            status: update.status,
            statusText: update.statusText,
            loaded: update.loaded,
            total: update.total,
            percent: update.percent,
            ...(update.status === "muxing" ? { speed: 0 } : {}),
          },
          Boolean(update.force),
        );
      },
    });

    try {
      await handoffSinkAndWaitRelease({
        taskId,
        spec: { ...spec, mimeType: spec.mimeType || "video/mp4" },
        sink: outputSink,
        signal,
        reportProgress,
      });
    } catch (err) {
      await outputSink.cleanup(err);
      throw err;
    }
  } finally {
    onExitTask?.();
  }
}
