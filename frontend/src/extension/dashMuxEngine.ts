import * as defaultMediabunny from "mediabunny";
import type { OffscreenDashMuxSpec } from "./protocol";

export interface DashMuxWritableChunk {
  type: "write";
  data: Uint8Array;
  position?: number;
}

export interface DashMuxWritableLike {
  write(chunk: Uint8Array | DashMuxWritableChunk): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
  getWriter?(): WritableStreamDefaultWriter<unknown>;
}

export interface DashMuxOpfsSink {
  tempName?: string;
  rawWritable?: DashMuxWritableLike;
  write(chunk: Uint8Array): Promise<void>;
  markWritableClosed?(): void;
  closeAndGetBlob(): Promise<Blob | File>;
  cleanup(reason?: unknown): Promise<void>;
}

export type DashMuxTrackRole = "video" | "audio";

export interface DashMuxTrackFetchParams {
  role: DashMuxTrackRole;
  routes: string[];
  estimatedSize?: number;
  signal: AbortSignal;
  onProgress: (update: { loaded: number; total: number }) => void;
}

export interface DashMuxTrackFetchResult {
  blob: Blob | File;
  sink: DashMuxOpfsSink;
  byteLength: number;
}

export interface DashMuxProgressUpdate {
  status: "downloading" | "muxing";
  statusText: string;
  percent: number;
  loaded: number;
  total: number;
  force?: boolean;
}

export interface RunDashMuxToOpfsParams {
  taskId: string;
  spec: OffscreenDashMuxSpec;
  fetchTrackToOpfs: (
    params: DashMuxTrackFetchParams,
  ) => Promise<DashMuxTrackFetchResult>;
  openOpfsSink: (
    taskId: string,
    mimeType?: string,
    tag?: string,
  ) => Promise<DashMuxOpfsSink>;
  beforeOpenOutputSink?: (info: {
    videoBytes: number;
    audioBytes: number;
    totalInputBytes: number;
  }) => Promise<void> | void;
  signal: AbortSignal;
  onProgress?: (update: DashMuxProgressUpdate) => void;
  mediabunnyMod?: Record<string, unknown> | null;
}

interface CodedMuxError extends Error {
  code?: string;
  cancelled?: boolean;
}

function makeCodedMuxError(
  code: string,
  message: string,
  cancelled = false,
): CodedMuxError {
  const err = new Error(message) as CodedMuxError;
  err.name = cancelled ? "AbortError" : "DashMuxError";
  err.code = code;
  if (cancelled) {
    err.cancelled = true;
  }
  return err;
}

function makeUserCancelledError(): CodedMuxError {
  return makeCodedMuxError("USER_CANCELLED", "已取消", true);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw makeUserCancelledError();
  }
}

interface WrappedWritableStream {
  stream: WritableStream<unknown>;
  forceAbort(reason?: unknown): Promise<void>;
}

/**
 * Wraps an OPFS `FileSystemWritableFileStream` (or mock writable object supporting
 * `{ type: "write", data, position }`) into a standard `WritableStream` instance
 * required by `mediabunny`'s `StreamTarget`, while keeping an unlocked `forceAbort`
 * escape hatch for deterministic cleanup on cancellation or failure.
 */
function wrapWritableForStreamTarget(
  rawWritable: DashMuxWritableLike,
): WrappedWritableStream {
  const hasWrite = typeof rawWritable.write === "function";
  const hasGetWriter = typeof rawWritable.getWriter === "function";
  let underlyingWriter: WritableStreamDefaultWriter<unknown> | null = null;

  const stream = new WritableStream<unknown>({
    start() {
      if (hasGetWriter && !hasWrite) {
        underlyingWriter = rawWritable.getWriter!();
      }
    },
    async write(chunk) {
      if (underlyingWriter) {
        await underlyingWriter.write(chunk);
      } else {
        await rawWritable.write(chunk as Uint8Array | DashMuxWritableChunk);
      }
    },
    async close() {
      if (underlyingWriter) {
        await underlyingWriter.close();
        try {
          underlyingWriter.releaseLock();
        } catch {
          // Ignore
        }
        underlyingWriter = null;
      } else if (typeof rawWritable.close === "function") {
        await rawWritable.close();
      }
    },
    async abort(reason) {
      if (underlyingWriter) {
        await underlyingWriter.abort(reason);
        try {
          underlyingWriter.releaseLock();
        } catch {
          // Ignore
        }
        underlyingWriter = null;
      } else if (typeof rawWritable.abort === "function") {
        await rawWritable.abort(reason);
      }
    },
  });

  return {
    stream,
    async forceAbort(reason?: unknown) {
      try {
        await stream.abort(reason);
      } catch {
        // Stream may still be locked by StreamTarget's internal writer
      }
      if (underlyingWriter) {
        try {
          await underlyingWriter.abort(reason);
        } catch {
          // Ignore
        }
        try {
          underlyingWriter.releaseLock();
        } catch {
          // Ignore
        }
        underlyingWriter = null;
      }
      if (typeof rawWritable.abort === "function") {
        try {
          await rawWritable.abort(reason);
        } catch {
          // Ignore
        }
      } else if (typeof rawWritable.close === "function") {
        try {
          await rawWritable.close();
        } catch {
          // Ignore
        }
      }
    },
  };
}

interface MediabunnyLike {
  ALL_FORMATS?: unknown[];
  MP4?: unknown;
  Input: new (options: { source: unknown; formats: unknown[] }) => {
    getPrimaryVideoTrack(): Promise<{
      rotation?: number;
      getCodec(): Promise<string | null>;
      getDecoderConfig(): Promise<unknown>;
    } | null>;
    getPrimaryAudioTrack(): Promise<{
      getCodec(): Promise<string | null>;
      getDecoderConfig(): Promise<unknown>;
    } | null>;
    dispose?(): void;
  };
  BlobSource?: new (blob: Blob) => unknown;
  BufferSource?: new (buffer: ArrayBuffer | Uint8Array) => unknown;
  Output: new (options: { format: unknown; target: unknown }) => {
    addVideoTrack(source: unknown, metadata?: Record<string, unknown>): void;
    addAudioTrack(source: unknown, metadata?: Record<string, unknown>): void;
    start(): Promise<void>;
    finalize(): Promise<void>;
    cancel?(): Promise<void>;
  };
  Mp4OutputFormat: new (options?: {
    fastStart?: false | "in-memory" | "reserve" | "fragmented";
  }) => unknown;
  StreamTarget?: new (
    writable: WritableStream<unknown>,
    options?: { chunked?: boolean; chunkSize?: number },
  ) => unknown;
  BufferTarget: new () => { buffer: ArrayBuffer | null };
  EncodedVideoPacketSource: new (codec: string) => {
    add(packet: unknown, meta?: { decoderConfig?: unknown }): Promise<void>;
    close(): void;
  };
  EncodedAudioPacketSource: new (codec: string) => {
    add(packet: unknown, meta?: { decoderConfig?: unknown }): Promise<void>;
    close(): void;
  };
  EncodedPacketSink: new (track: unknown) => {
    packets(): AsyncIterable<{
      timestamp: number;
      data?: { byteLength?: number };
    }>;
  };
}

/**
 * Downloads separate DASH video + audio tracks concurrently into 2 OPFS temp files,
 * performs lossless MP4 stream-copy muxing via `mediabunny@1.65.2` (zero re-encoding,
 * supports H.264 / HEVC / AV1 + AAC) directly into a 3rd OPFS output sink, and
 * deterministically removes both intermediate OPFS track files in `finally`.
 */
export async function runDashMuxToOpfs(
  params: RunDashMuxToOpfsParams,
): Promise<DashMuxOpfsSink> {
  const {
    taskId,
    spec,
    fetchTrackToOpfs,
    openOpfsSink,
    signal,
    onProgress,
    mediabunnyMod,
  } = params;

  assertNotAborted(signal);

  const videoRoutes = Array.isArray(spec?.videoRoutes)
    ? spec.videoRoutes.map((u) => u.trim()).filter(Boolean)
    : [];
  const audioRoutes = Array.isArray(spec?.audioRoutes)
    ? spec.audioRoutes.map((u) => u.trim()).filter(Boolean)
    : [];
  if (videoRoutes.length === 0 || audioRoutes.length === 0) {
    throw makeCodedMuxError(
      "MUX_INVALID_SPEC",
      "DASH 无损合流缺少视频轨或音频轨下载地址",
    );
  }
  if (spec.outputContainer !== "mp4") {
    throw makeCodedMuxError(
      "MUX_UNSUPPORTED_CONTAINER",
      `不支持的 DASH 合流输出容器：${String(spec.outputContainer)}`,
    );
  }

  const mb = (
    mediabunnyMod !== undefined ? mediabunnyMod : defaultMediabunny
  ) as MediabunnyLike | null;
  if (
    !mb ||
    typeof mb.Input !== "function" ||
    typeof mb.Output !== "function" ||
    typeof mb.Mp4OutputFormat !== "function" ||
    typeof mb.EncodedVideoPacketSource !== "function" ||
    typeof mb.EncodedAudioPacketSource !== "function" ||
    typeof mb.EncodedPacketSink !== "function"
  ) {
    throw makeCodedMuxError("MEDIABUNNY_UNAVAILABLE", "无损合流引擎尚未加载");
  }

  // Phase 1: Concurrent video + audio download into 2 separate OPFS temp files (0% - 82%)
  let videoLoaded = 0;
  let audioLoaded = 0;
  let videoTotal =
    typeof spec.videoSize === "number" &&
    Number.isFinite(spec.videoSize) &&
    spec.videoSize > 0
      ? spec.videoSize
      : 0;
  let audioTotal =
    typeof spec.audioSize === "number" &&
    Number.isFinite(spec.audioSize) &&
    spec.audioSize > 0
      ? spec.audioSize
      : 0;

  const emitDownloadProgress = (force = false) => {
    if (signal.aborted) return;
    const loaded = videoLoaded + audioLoaded;
    const bothKnown = videoTotal > 0 && audioTotal > 0;
    const anyKnown = videoTotal > 0 || audioTotal > 0;
    const total = bothKnown
      ? videoTotal + audioTotal
      : anyKnown
        ? Math.max(videoTotal, videoLoaded) + Math.max(audioTotal, audioLoaded)
        : 0;
    const maxPct = bothKnown ? 82 : 80;
    const percent =
      total > 0 ? Math.min(maxPct, Math.floor((loaded / total) * maxPct)) : 0;
    onProgress?.({
      status: "downloading",
      statusText: "正在下载音视频轨道...",
      percent,
      loaded,
      total,
      force,
    });
  };

  emitDownloadProgress(true);

  const tracksController = new AbortController();
  const onParentAbortForTracks = () => {
    if (!tracksController.signal.aborted) {
      tracksController.abort();
    }
  };
  signal.addEventListener("abort", onParentAbortForTracks, { once: true });

  const trackResults: {
    video: DashMuxTrackFetchResult | null;
    audio: DashMuxTrackFetchResult | null;
  } = {
    video: null,
    audio: null,
  };
  let firstTrackError: unknown = null;

  const downloadTrack = async (role: DashMuxTrackRole): Promise<void> => {
    try {
      const result = await fetchTrackToOpfs({
        role,
        routes: role === "video" ? videoRoutes : audioRoutes,
        estimatedSize: role === "video" ? spec.videoSize : spec.audioSize,
        signal: tracksController.signal,
        onProgress({ loaded, total }) {
          if (tracksController.signal.aborted || signal.aborted) return;
          if (role === "video") {
            videoLoaded = loaded;
            if (total > 0) videoTotal = total;
          } else {
            audioLoaded = loaded;
            if (total > 0) audioTotal = total;
          }
          emitDownloadProgress(false);
        },
      });
      if (role === "video") {
        trackResults.video = result;
        videoLoaded = result.byteLength;
        videoTotal = Math.max(videoTotal, result.byteLength);
      } else {
        trackResults.audio = result;
        audioLoaded = result.byteLength;
        audioTotal = Math.max(audioTotal, result.byteLength);
      }
      emitDownloadProgress(false);
    } catch (err) {
      if (firstTrackError === null) {
        firstTrackError = err;
      }
      if (!tracksController.signal.aborted) {
        tracksController.abort();
      }
      throw err;
    }
  };

  let vInput: InstanceType<MediabunnyLike["Input"]> | null = null;
  let aInput: InstanceType<MediabunnyLike["Input"]> | null = null;
  let output: InstanceType<MediabunnyLike["Output"]> | null = null;
  let outputSink: DashMuxOpfsSink | null = null;
  let wrappedWritable: WrappedWritableStream | null = null;
  let outputFinalized = false;
  let onParentAbortForMux: (() => void) | null = null;

  try {
    await Promise.allSettled([
      downloadTrack("video"),
      downloadTrack("audio"),
    ]);
    signal.removeEventListener("abort", onParentAbortForTracks);

    assertNotAborted(signal);
    if (firstTrackError !== null) {
      throw firstTrackError;
    }
    const videoResult = trackResults.video;
    const audioResult = trackResults.audio;
    if (!videoResult || !audioResult) {
      throw makeCodedMuxError(
        "MUX_TRACK_MISSING",
        "音视频轨道下载未完成，无法合流",
      );
    }

    const totalInputBytes = videoResult.byteLength + audioResult.byteLength;
    onProgress?.({
      status: "muxing",
      statusText: "无损合流中...",
      percent: 82,
      loaded: totalInputBytes,
      total: totalInputBytes,
      force: true,
    });

    // Phase 2: Lossless MP4 stream copy via mediabunny@1.65.2 (82% - 98%)
    const createInputSource = async (blob: Blob | File): Promise<unknown> => {
      if (
        typeof mb.BlobSource === "function" &&
        typeof Blob !== "undefined" &&
        blob instanceof Blob
      ) {
        return new mb.BlobSource(blob);
      }
      if (typeof mb.BufferSource === "function") {
        const buf = await blob.arrayBuffer();
        return new mb.BufferSource(buf);
      }
      throw makeCodedMuxError(
        "MEDIABUNNY_UNAVAILABLE",
        "合流引擎缺少有效的输入源构造器",
      );
    };

    const [vSource, aSource] = await Promise.all([
      createInputSource(videoResult.blob),
      createInputSource(audioResult.blob),
    ]);
    assertNotAborted(signal);

    const inputFormats =
      Array.isArray(mb.ALL_FORMATS) && mb.ALL_FORMATS.length > 0
        ? mb.ALL_FORMATS
        : mb.MP4
          ? [mb.MP4]
          : [];

    vInput = new mb.Input({ source: vSource, formats: inputFormats });
    aInput = new mb.Input({ source: aSource, formats: inputFormats });

    const [vTrack, aTrack] = await Promise.all([
      vInput.getPrimaryVideoTrack(),
      aInput.getPrimaryAudioTrack(),
    ]);
    assertNotAborted(signal);

    if (!vTrack) {
      throw makeCodedMuxError("MUX_NO_VIDEO_TRACK", "视频流中未找到主视频轨");
    }
    if (!aTrack) {
      throw makeCodedMuxError("MUX_NO_AUDIO_TRACK", "音频流中未找到主音轨");
    }

    const [vCodec, aCodec, vDecoderConfig, aDecoderConfig] = await Promise.all([
      vTrack.getCodec(),
      aTrack.getCodec(),
      vTrack.getDecoderConfig(),
      aTrack.getDecoderConfig(),
    ]);
    assertNotAborted(signal);

    if (!vCodec || !aCodec) {
      throw makeCodedMuxError(
        "MUX_CODEC_UNSUPPORTED",
        `音视频编码不支持无损封装（video=${vCodec || "未知"}, audio=${aCodec || "未知"}）`,
      );
    }

    if (params.beforeOpenOutputSink) {
      await params.beforeOpenOutputSink({
        videoBytes: videoResult.byteLength,
        audioBytes: audioResult.byteLength,
        totalInputBytes,
      });
      assertNotAborted(signal);
    }

    outputSink = await openOpfsSink(taskId, "video/mp4");
    assertNotAborted(signal);

    const useStreamTarget = Boolean(
      outputSink.rawWritable &&
        typeof WritableStream === "function" &&
        typeof mb.StreamTarget === "function",
    );

    let bufferTarget: { buffer: ArrayBuffer | null } | null = null;
    let target: unknown;
    if (useStreamTarget && outputSink.rawWritable && mb.StreamTarget) {
      wrappedWritable = wrapWritableForStreamTarget(outputSink.rawWritable);
      target = new mb.StreamTarget(wrappedWritable.stream, {
        chunked: true,
        chunkSize: 8 * 1024 * 1024,
      });
    } else {
      bufferTarget = new mb.BufferTarget();
      target = bufferTarget;
    }

    const format = new mb.Mp4OutputFormat({ fastStart: false });
    output = new mb.Output({ format, target });

    const vOut = new mb.EncodedVideoPacketSource(vCodec);
    const aOut = new mb.EncodedAudioPacketSource(aCodec);
    output.addVideoTrack(
      vOut,
      vTrack.rotation ? { rotation: vTrack.rotation } : undefined,
    );
    output.addAudioTrack(aOut);

    onParentAbortForMux = () => {
      try {
        void output?.cancel?.().catch(() => {});
      } catch {
        // Ignore
      }
      try {
        vInput?.dispose?.();
      } catch {
        // Ignore
      }
      try {
        aInput?.dispose?.();
      } catch {
        // Ignore
      }
    };
    signal.addEventListener("abort", onParentAbortForMux, { once: true });

    await output.start();
    assertNotAborted(signal);

    const vSink = new mb.EncodedPacketSink(vTrack);
    const aSink = new mb.EncodedPacketSink(aTrack);
    const vIter = vSink.packets()[Symbol.asyncIterator]();
    const aIter = aSink.packets()[Symbol.asyncIterator]();

    let [vNext, aNext] = await Promise.all([vIter.next(), aIter.next()]);
    let vFirst = true;
    let aFirst = true;
    let muxedBytes = 0;

    while (!vNext.done || !aNext.done) {
      assertNotAborted(signal);
      const takeVideo =
        !vNext.done &&
        (aNext.done || vNext.value.timestamp <= aNext.value.timestamp);
      if (takeVideo) {
        const pkt = vNext.value;
        await vOut.add(
          pkt,
          vFirst && vDecoderConfig
            ? { decoderConfig: vDecoderConfig }
            : undefined,
        );
        vFirst = false;
        muxedBytes += pkt.data?.byteLength ?? 0;
        vNext = await vIter.next();
      } else {
        const pkt = aNext.value;
        await aOut.add(
          pkt,
          aFirst && aDecoderConfig
            ? { decoderConfig: aDecoderConfig }
            : undefined,
        );
        aFirst = false;
        muxedBytes += pkt.data?.byteLength ?? 0;
        aNext = await aIter.next();
      }

      const ratio =
        totalInputBytes > 0 ? Math.min(1, muxedBytes / totalInputBytes) : 0;
      const muxPct = Math.min(97, 82 + Math.floor(ratio * 15));
      onProgress?.({
        status: "muxing",
        statusText: "无损合流中...",
        percent: muxPct,
        loaded: totalInputBytes,
        total: totalInputBytes,
      });
    }

    assertNotAborted(signal);
    vOut.close();
    aOut.close();
    await output.finalize();
    outputFinalized = true;
    if (useStreamTarget) {
      // StreamTarget._finalize() already closed the wrapped OPFS writable
      outputSink.markWritableClosed?.();
    }
    assertNotAborted(signal);

    if (!useStreamTarget) {
      const outBuf = bufferTarget?.buffer;
      if (!outBuf || outBuf.byteLength === 0) {
        throw makeCodedMuxError("MUX_EMPTY_OUTPUT", "无损合流输出为空");
      }
      await outputSink.write(new Uint8Array(outBuf));
    }

    onProgress?.({
      status: "muxing",
      statusText: "无损合流中...",
      percent: 98,
      loaded: totalInputBytes,
      total: totalInputBytes,
      force: true,
    });

    return outputSink;
  } catch (err) {
    if (!outputFinalized) {
      try {
        await output?.cancel?.();
      } catch {
        // Ignore cancel errors during teardown
      }
      if (wrappedWritable) {
        await wrappedWritable.forceAbort(err);
      }
    }
    if (outputSink) {
      await outputSink.cleanup(err);
    }
    if (signal.aborted) {
      throw makeUserCancelledError();
    }
    throw err;
  } finally {
    signal.removeEventListener("abort", onParentAbortForTracks);
    if (onParentAbortForMux) {
      signal.removeEventListener("abort", onParentAbortForMux);
    }
    try {
      vInput?.dispose?.();
    } catch {
      // Ignore
    }
    try {
      aInput?.dispose?.();
    } catch {
      // Ignore
    }
    // Always remove the 2 intermediate video/audio OPFS temp files immediately
    await Promise.allSettled([
      trackResults.video?.sink?.cleanup?.(),
      trackResults.audio?.sink?.cleanup?.(),
    ]);
  }
}
