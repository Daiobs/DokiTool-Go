import type { ExtensionDnrRule } from "../dnrRules";
import type {
  BackgroundToOffscreenRequest,
  ExtensionRpcResponse,
  OffscreenResponseMap,
} from "../protocol";
import type { ChromeBackgroundApi } from "./types";

export interface OffscreenLifecycleDeps {
  chromeApi: ChromeBackgroundApi;
  offscreenIdleCloseMs: number;
  isDisposed: () => boolean;
  countActiveTasks: () => number;
  getPendingBlobCount: () => number;
  syncDynamicDnrRules: (extraOrigins?: string[]) => Promise<ExtensionDnrRule[]>;
}

export interface OffscreenLifecycle {
  isOffscreenDocumentOpen(): boolean;
  setOffscreenDocumentOpen(open: boolean): void;
  isOffscreenIdle(): boolean;
  clearOffscreenIdleTimer(): void;
  hasOpenOffscreenContext(): Promise<boolean>;
  scheduleOffscreenIdleCloseIfIdle(): void;
  ensureOffscreenDocument(): Promise<void>;
  sendToOffscreen<T extends BackgroundToOffscreenRequest["type"]>(
    req: Extract<BackgroundToOffscreenRequest, { type: T }>,
    options?: { skipEnsure?: boolean },
  ): Promise<OffscreenResponseMap[T]>;
  sendReleaseBlobToOffscreen(params: {
    taskId: string;
    blobUrl: string;
    opfsTempName?: string;
  }): Promise<void>;
  dispose(): void;
}

/**
 * Manages the MV3 Offscreen document singleton mutex, non-task RPC accounting,
 * idle close timer, and Blob release messaging.
 */
export function createOffscreenLifecycle(
  deps: OffscreenLifecycleDeps,
): OffscreenLifecycle {
  const {
    chromeApi,
    offscreenIdleCloseMs,
    isDisposed,
    countActiveTasks,
    getPendingBlobCount,
    syncDynamicDnrRules,
  } = deps;

  let offscreenDocumentOpen = false;
  let inFlightOffscreenRpcs = 0;
  let offscreenIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let offscreenMutex: Promise<void> = Promise.resolve();

  const clearOffscreenIdleTimer = (): void => {
    if (offscreenIdleTimer !== null) {
      clearTimeout(offscreenIdleTimer);
      offscreenIdleTimer = null;
    }
  };

  const isOffscreenIdle = (): boolean =>
    countActiveTasks() === 0 &&
    getPendingBlobCount() === 0 &&
    inFlightOffscreenRpcs === 0;

  const hasOpenOffscreenContext = async (): Promise<boolean> => {
    if (typeof chromeApi.runtime.getContexts === "function") {
      try {
        const contexts = await chromeApi.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
        });
        return contexts.length > 0;
      } catch {
        // Fall through
      }
    }
    if (typeof chromeApi.offscreen?.hasDocument === "function") {
      try {
        return await chromeApi.offscreen.hasDocument();
      } catch {
        // Fall through
      }
    }
    return offscreenDocumentOpen;
  };

  const scheduleOffscreenIdleCloseIfIdle = (): void => {
    clearOffscreenIdleTimer();
    if (isDisposed() || !isOffscreenIdle()) return;
    offscreenIdleTimer = setTimeout(() => {
      offscreenIdleTimer = null;
      if (isDisposed() || !isOffscreenIdle()) return;
      void (async () => {
        try {
          if (offscreenDocumentOpen || (await hasOpenOffscreenContext())) {
            await chromeApi.offscreen?.closeDocument();
          }
        } catch {
          // Ignore if already closed
        } finally {
          offscreenDocumentOpen = false;
        }
      })();
    }, offscreenIdleCloseMs);
    (offscreenIdleTimer as { unref?: () => void })?.unref?.();
  };

  const ensureOffscreenDocument = (): Promise<void> => {
    const run = async (): Promise<void> => {
      clearOffscreenIdleTimer();
      await syncDynamicDnrRules();
      if (
        (await hasOpenOffscreenContext()) ||
        !chromeApi.offscreen?.createDocument
      ) {
        offscreenDocumentOpen = true;
        return;
      }
      try {
        await chromeApi.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["BLOBS"],
          justification:
            "Stream media to OPFS and create Blob URLs for cookie-free downloads",
        });
        offscreenDocumentOpen = true;
      } catch (err) {
        if (
          /single offscreen document/i.test(
            err instanceof Error ? err.message : String(err),
          )
        ) {
          offscreenDocumentOpen = true;
          return;
        }
        throw err;
      }
    };
    const next = offscreenMutex.then(run, run);
    offscreenMutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const sendToOffscreen = async <
    T extends BackgroundToOffscreenRequest["type"],
  >(
    req: Extract<BackgroundToOffscreenRequest, { type: T }>,
    options?: { skipEnsure?: boolean },
  ): Promise<OffscreenResponseMap[T]> => {
    clearOffscreenIdleTimer();
    const isNonTaskRpc =
      req.type === "OFFSCREEN_YOUTUBE_PLAYER" || req.type === "OFFSCREEN_PING";
    if (isNonTaskRpc) inFlightOffscreenRpcs += 1;
    try {
      if (!options?.skipEnsure) await ensureOffscreenDocument();
      const raw = (await chromeApi.runtime.sendMessage(req)) as
        | ExtensionRpcResponse<OffscreenResponseMap[T]>
        | undefined;
      if (!raw || typeof raw !== "object" || !("ok" in raw)) {
        throw new Error("Offscreen 执行器未响应");
      }
      if (!raw.ok) {
        const err = new Error(raw.error || "Offscreen 请求失败") as Error & {
          code?: string;
          status?: number;
        };
        err.code = raw.code;
        err.status = raw.status;
        throw err;
      }
      return raw.data;
    } finally {
      if (isNonTaskRpc) {
        inFlightOffscreenRpcs = Math.max(0, inFlightOffscreenRpcs - 1);
        scheduleOffscreenIdleCloseIfIdle();
      }
    }
  };

  const sendReleaseBlobToOffscreen = async (params: {
    taskId: string;
    blobUrl: string;
    opfsTempName?: string;
  }): Promise<void> => {
    try {
      await chromeApi.runtime.sendMessage({
        type: "RELEASE_BLOB",
        taskId: params.taskId,
        blobUrl: params.blobUrl,
        ...(params.opfsTempName ? { opfsTempName: params.opfsTempName } : {}),
      } satisfies BackgroundToOffscreenRequest);
    } catch {
      // Ignore if offscreen already closed
    }
  };

  return {
    isOffscreenDocumentOpen: () => offscreenDocumentOpen,
    setOffscreenDocumentOpen(open: boolean) {
      offscreenDocumentOpen = open;
    },
    isOffscreenIdle,
    clearOffscreenIdleTimer,
    hasOpenOffscreenContext,
    scheduleOffscreenIdleCloseIfIdle,
    ensureOffscreenDocument,
    sendToOffscreen,
    sendReleaseBlobToOffscreen,
    dispose() {
      clearOffscreenIdleTimer();
    },
  };
}
