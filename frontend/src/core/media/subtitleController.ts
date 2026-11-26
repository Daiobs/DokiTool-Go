import {
  MAX_SUBTITLE_TRACK_BYTES,
  buildSubtitleDownloadResult,
  type SubtitleDownloadResult,
  type SubtitleTrackOption,
} from "./subtitleEngine";

export type SubtitleTargetFormat = "vtt" | "srt";

export interface SubtitleBlobDownloadEnv {
  BlobCtor?: typeof Blob;
  urlApi?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  doc?: Document;
  scheduleRevoke?: (fn: () => void, delayMs: number) => unknown;
  revokeDelayMs?: number;
}

export interface SubtitleControllerState {
  readonly tracks: readonly SubtitleTrackOption[];
  readonly targetFormat: SubtitleTargetFormat;
  readonly primaryId: string;
  readonly secondaryId: string;
  readonly primaryTrack: SubtitleTrackOption | null;
  readonly secondaryCandidates: readonly SubtitleTrackOption[];
  readonly secondaryTrack: SubtitleTrackOption | null;
  readonly canMergeBilingual: boolean;
  readonly busyKey: string;
  readonly errorMessage: string;
  readonly statusMessage: string;
}

export interface SubtitleDownloadControllerOptions {
  getBaseTitle: () => string;
  isDisabled?: () => boolean;
  getFetchImpl?: () => typeof fetch | undefined;
  fetchTrackText?: (track: SubtitleTrackOption, signal: AbortSignal) => Promise<string>;
  validateBeforeDownload?: (primary: SubtitleTrackOption, secondary: SubtitleTrackOption | null) => void;
  maxBytes?: number;
  formatError: (err: unknown) => string;
  formatEmptyCuesError: () => string;
  formatSuccessStatus: (result: SubtitleDownloadResult) => string;
  deliverDownload?: (result: SubtitleDownloadResult) => void;
  onSuccess?: (result: SubtitleDownloadResult) => void;
  onStateChange?: (state: SubtitleControllerState) => void;
  blobDownloadEnv?: SubtitleBlobDownloadEnv;
}

export interface SubtitleDownloadController {
  getState(): SubtitleControllerState;
  syncTracks(tracks: readonly SubtitleTrackOption[] | null | undefined): void;
  setTargetFormat(format: SubtitleTargetFormat): void;
  setPrimaryId(id: string): void;
  setSecondaryId(id: string): void;
  runDownload(
    primary: SubtitleTrackOption | null,
    secondary: SubtitleTrackOption | null,
    format: SubtitleTargetFormat,
    key: string,
  ): Promise<void>;
  downloadConfigured(): Promise<void>;
  dispose(): void;
}

/**
 * Triggers a browser Blob download for converted subtitle text and schedules a
 * delayed `URL.revokeObjectURL` cleanup so exports never leak object URLs.
 */
export function triggerSubtitleBlobDownload(
  content: string,
  filename: string,
  mimeType: string,
  env?: SubtitleBlobDownloadEnv,
): boolean {
  const BlobCtor = env?.BlobCtor ?? (typeof Blob !== "undefined" ? Blob : undefined);
  const urlApi = env?.urlApi ?? (typeof URL !== "undefined" ? URL : undefined);
  const doc = env?.doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!BlobCtor || !urlApi || typeof urlApi.createObjectURL !== "function" || !doc) {
    return false;
  }
  const objectUrl = urlApi.createObjectURL(new BlobCtor([content], { type: mimeType }));
  const link = doc.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  doc.body?.appendChild?.(link);
  link.click?.();
  link.remove?.();
  (env?.scheduleRevoke ?? setTimeout)(() => {
    try {
      urlApi.revokeObjectURL?.(objectUrl);
    } catch {
      // Ignore revoke errors
    }
  }, env?.revokeDelayMs ?? 1000);
  return true;
}

/**
 * Framework-agnostic non-UI state and download workflow controller shared by
 * Web (`ResultSubtitlePanel.vue`) and Extension (`SidePanelSubtitlePanel.vue`).
 * Host security policies (whitelist checks, custom fetchers, i18n copy, toast
 * notifications) are injected via options so neither host leaks into the other.
 */
export function createSubtitleDownloadController(
  options: SubtitleDownloadControllerOptions,
): SubtitleDownloadController {
  let tracks: SubtitleTrackOption[] = [];
  let targetFormat: SubtitleTargetFormat = "vtt";
  let primaryId = "";
  let secondaryId = "";
  let busyKey = "";
  let errorMessage = "";
  let statusMessage = "";
  let activeController: AbortController | null = null;

  const buildSnapshot = (): SubtitleControllerState => {
    const primaryTrack = tracks.find((t) => t.id === primaryId) || tracks[0] || null;
    const secondaryCandidates = tracks.filter((t) => t.id !== primaryTrack?.id);
    const secondaryTrack = secondaryCandidates.find((t) => t.id === secondaryId) || null;
    return {
      tracks, targetFormat, primaryId, secondaryId,
      primaryTrack, secondaryCandidates, secondaryTrack,
      canMergeBilingual: tracks.length >= 2,
      busyKey, errorMessage, statusMessage,
    };
  };

  let state = buildSnapshot();
  const emitState = (): void => {
    state = buildSnapshot();
    options.onStateChange?.(state);
  };

  const syncTracks = (list: readonly SubtitleTrackOption[] | null | undefined): void => {
    tracks = Array.isArray(list) ? [...list] : [];
    if (!tracks.some((t) => t.id === primaryId)) primaryId = tracks[0]?.id || "";
    if (secondaryId && (!tracks.some((t) => t.id === secondaryId) || secondaryId === primaryId)) {
      secondaryId = "";
    }
    errorMessage = "";
    statusMessage = "";
    emitState();
  };

  const setTargetFormat = (format: SubtitleTargetFormat): void => {
    targetFormat = format === "srt" ? "srt" : "vtt";
    emitState();
  };

  const setPrimaryId = (nextPrimary: string): void => {
    primaryId = nextPrimary;
    if (secondaryId === nextPrimary) secondaryId = "";
    emitState();
  };

  const setSecondaryId = (nextSecondary: string): void => {
    secondaryId = nextSecondary === primaryId ? "" : nextSecondary;
    emitState();
  };

  const runDownload = async (
    primary: SubtitleTrackOption | null,
    secondary: SubtitleTrackOption | null,
    format: SubtitleTargetFormat,
    key: string,
  ): Promise<void> => {
    if (!primary || options.isDisabled?.() || busyKey) return;
    if (options.validateBeforeDownload) {
      try {
        options.validateBeforeDownload(primary, secondary);
      } catch (err: unknown) {
        errorMessage = options.formatError(err);
        statusMessage = "";
        emitState();
        return;
      }
    }

    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    busyKey = key;
    errorMessage = "";
    statusMessage = "";
    emitState();

    try {
      const result = await buildSubtitleDownloadResult({
        primaryTrack: primary,
        secondaryTrack: secondary,
        targetFormat: format,
        baseTitle: options.getBaseTitle() || "subtitle",
        fetchImpl: options.getFetchImpl?.(),
        signal: controller.signal,
        maxBytes: options.maxBytes ?? MAX_SUBTITLE_TRACK_BYTES,
        ...(options.fetchTrackText
          ? { fetchTrackText: (track) => options.fetchTrackText!(track, controller.signal) }
          : {}),
      });
      if (controller.signal.aborted) return;
      if (result.cueCount === 0) {
        errorMessage = options.formatEmptyCuesError();
        emitState();
        return;
      }
      if (options.deliverDownload) {
        options.deliverDownload(result);
      } else {
        triggerSubtitleBlobDownload(result.content, result.filename, result.mimeType, options.blobDownloadEnv);
      }
      statusMessage = options.formatSuccessStatus(result);
      emitState();
      options.onSuccess?.(result);
    } catch (err: unknown) {
      if (controller.signal.aborted || (err as { name?: string } | null)?.name === "AbortError") {
        return;
      }
      errorMessage = options.formatError(err);
      emitState();
    } finally {
      if (activeController === controller) activeController = null;
      if (busyKey === key) {
        busyKey = "";
        emitState();
      }
    }
  };

  const downloadConfigured = (): Promise<void> =>
    runDownload(state.primaryTrack, state.secondaryTrack, state.targetFormat, "configured");

  const dispose = (): void => {
    activeController?.abort();
    activeController = null;
  };

  return {
    getState: () => state,
    syncTracks, setTargetFormat, setPrimaryId, setSecondaryId,
    runDownload, downloadConfigured, dispose,
  };
}
