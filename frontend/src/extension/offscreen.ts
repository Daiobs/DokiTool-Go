import {
  cleanupStaleExtensionOpfsFiles,
  createOffscreenDownloadExecutor,
  type CreateOffscreenDownloadExecutorOptions,
  type OffscreenDownloadExecutor,
  type OpfsStorageLike,
  type WebLocksLike,
} from "./extensionDownload";
import {
  OFFSCREEN_HEARTBEAT_INTERVAL_MS,
  OFFSCREEN_PORT_NAME,
  errRpc,
  isBackgroundToOffscreenRequest,
  okRpc,
  type BackgroundToOffscreenRequest,
  type ExtensionRpcResponse,
  type HandOffBlobDownloadResult,
  type OffscreenResponseMap,
  type OffscreenToBackgroundMessage,
} from "./protocol";
import type { UrlObjectApiLike } from "./youtubeExtensionBridge";

export interface OffscreenPortLike {
  name?: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onDisconnect?: {
    addListener(listener: () => void): void;
  };
}

export type RuntimeMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

export interface ChromeOffscreenRuntimeApi {
  runtime: {
    id?: string;
    sendMessage(message: unknown): Promise<unknown>;
    connect(connectInfo?: { name?: string }): OffscreenPortLike;
    onMessage: {
      addListener(listener: RuntimeMessageListener): void;
      removeListener?(listener: RuntimeMessageListener): void;
    };
  };
}

export interface CreateOffscreenControllerOptions {
  chrome?: ChromeOffscreenRuntimeApi;
  fetchImpl?: typeof fetch;
  opfsStorage?: OpfsStorageLike | StorageManager | null;
  webLocks?: WebLocksLike | LockManager | null;
  urlApi?: UrlObjectApiLike;
  now?: () => number;
  heartbeatIntervalMs?: number;
  maxConcurrentTasks?: number;
  progressThrottleMs?: number;
  stallTimeoutMs?: number;
  mediabunnyImpl?: Record<string, unknown> | null;
  youtubeMuxConfig?: CreateOffscreenDownloadExecutorOptions["youtubeMuxConfig"];
}

export interface OffscreenController {
  executor: OffscreenDownloadExecutor;
  handleRuntimeMessage: RuntimeMessageListener;
  cleanupBootPromise: Promise<number>;
  dispose(): void;
}

export function createOffscreenController(
  options?: CreateOffscreenControllerOptions,
): OffscreenController {
  const chromeApi =
    options?.chrome ??
    (globalThis as unknown as { chrome?: ChromeOffscreenRuntimeApi }).chrome;
  if (!chromeApi?.runtime) {
    throw new Error("Offscreen runtime requires chrome.runtime API");
  }

  const nowFn = options?.now ?? (() => Date.now());
  const heartbeatIntervalMs =
    options?.heartbeatIntervalMs ?? OFFSCREEN_HEARTBEAT_INTERVAL_MS;

  let disposed = false;
  let port: OffscreenPortLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const sendToBackground = async <T = unknown>(
    msg: OffscreenToBackgroundMessage,
  ): Promise<ExtensionRpcResponse<T> | undefined> => {
    const raw = await chromeApi.runtime.sendMessage(msg);
    if (raw && typeof raw === "object" && "ok" in raw) {
      return raw as ExtensionRpcResponse<T>;
    }
    return undefined;
  };

  const executor = createOffscreenDownloadExecutor({
    fetchImpl: options?.fetchImpl,
    opfsStorage: options?.opfsStorage,
    webLocks: options?.webLocks,
    urlApi: options?.urlApi,
    now: nowFn,
    maxConcurrentTasks: options?.maxConcurrentTasks ?? 3,
    progressThrottleMs: options?.progressThrottleMs,
    stallTimeoutMs: options?.stallTimeoutMs,
    mediabunnyImpl: options?.mediabunnyImpl,
    youtubeMuxConfig: options?.youtubeMuxConfig,
    async handoffBlobDownload(msg) {
      ensureKeepalivePort();
      const resp = await sendToBackground<HandOffBlobDownloadResult>(msg);
      if (resp && !resp.ok) {
        throw new Error(resp.error || "交接浏览器下载失败");
      }
      return resp?.ok ? resp.data : undefined;
    },
    onProgress(msg) {
      ensureKeepalivePort();
      void chromeApi.runtime.sendMessage(msg).catch(() => {});
    },
    onError(msg) {
      void chromeApi.runtime.sendMessage(msg).catch(() => {});
    },
  });

  const ensureKeepalivePort = (): OffscreenPortLike | null => {
    if (disposed) return null;
    if (port) return port;
    try {
      const connected = chromeApi.runtime.connect({
        name: OFFSCREEN_PORT_NAME,
      });
      port = connected;
      connected.onDisconnect?.addListener(() => {
        if (port === connected) {
          port = null;
        }
        if (
          !disposed &&
          (executor.getActiveTaskCount() > 0 ||
            executor.getPendingBlobCount() > 0)
        ) {
          if (reconnectTimer !== null) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            ensureKeepalivePort();
          }, 250);
          (reconnectTimer as { unref?: () => void })?.unref?.();
        }
      });
      return connected;
    } catch {
      return null;
    }
  };

  ensureKeepalivePort();

  const cleanupBootPromise = cleanupStaleExtensionOpfsFiles({
    storage: options?.opfsStorage,
    locks: options?.webLocks,
    activeNames: executor.getActiveOpfsTempNames(),
    now: nowFn,
  }).catch(() => 0);

  const heartbeatTimer = setInterval(() => {
    if (disposed) return;
    const activeTaskCount = executor.getActiveTaskCount();
    const pendingBlobCount = executor.getPendingBlobCount();
    if (activeTaskCount <= 0 && pendingBlobCount <= 0) {
      return;
    }
    const heartbeat: Extract<
      OffscreenToBackgroundMessage,
      { type: "OFFSCREEN_HEARTBEAT" }
    > = {
      type: "OFFSCREEN_HEARTBEAT",
      activeTaskCount,
      pendingBlobCount,
      timestamp: nowFn(),
    };
    const activePort = ensureKeepalivePort();
    if (activePort) {
      try {
        activePort.postMessage(heartbeat);
        return;
      } catch {
        port = null;
      }
    }
    void chromeApi.runtime.sendMessage(heartbeat).catch(() => {});
  }, heartbeatIntervalMs);
  (heartbeatTimer as { unref?: () => void })?.unref?.();

  const dispatchRequest = async (
    req: BackgroundToOffscreenRequest,
  ): Promise<ExtensionRpcResponse<OffscreenResponseMap[BackgroundToOffscreenRequest["type"]]>> => {
    switch (req.type) {
      case "OFFSCREEN_PING":
        return okRpc({
          ready: true,
          activeTaskCount: executor.getActiveTaskCount(),
          pendingBlobCount: executor.getPendingBlobCount(),
          helperVersion: executor.getHelperVersion(),
        });

      case "OFFSCREEN_YOUTUBE_PREFETCH": {
        const prefetch = await executor.requestYouTubePrefetch(req.payload, {
          timeoutMs: req.timeoutMs,
        });
        return okRpc({ prefetch });
      }

      case "OFFSCREEN_YOUTUBE_PLAYER": {
        const player = await executor.requestYouTubePlayer(req.payload, {
          timeoutMs: req.timeoutMs,
        });
        return okRpc({ player });
      }

      case "OFFSCREEN_START_TASK": {
        ensureKeepalivePort();
        const res = executor.startTask(req.taskId, req.spec);
        return okRpc(res);
      }

      case "OFFSCREEN_CANCEL_TASK": {
        const res = executor.cancelTask(req.taskId);
        return okRpc(res);
      }

      case "RELEASE_BLOB": {
        const res = executor.releaseBlob({
          taskId: req.taskId,
          blobUrl: req.blobUrl,
          opfsTempName: req.opfsTempName,
        });
        return okRpc(res);
      }
    }
  };

  // STRICT MV3 IPC CONTRACT:
  // ONLY return `true` / call `sendResponse` when `isBackgroundToOffscreenRequest(msg)`!
  const handleRuntimeMessage: RuntimeMessageListener = (
    msg: unknown,
    _sender: unknown,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    if (!isBackgroundToOffscreenRequest(msg)) {
      return false;
    }

    void dispatchRequest(msg)
      .then((rpcResp) => {
        sendResponse(rpcResp);
      })
      .catch((err: unknown) => {
        const code =
          err &&
          typeof err === "object" &&
          typeof (err as { code?: unknown }).code === "string"
            ? (err as { code: string }).code
            : undefined;
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Offscreen 执行失败";
        sendResponse(errRpc(message, { code }));
      });

    return true;
  };

  chromeApi.runtime.onMessage.addListener(handleRuntimeMessage);

  return {
    executor,
    handleRuntimeMessage,
    cleanupBootPromise,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeatTimer);
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      chromeApi.runtime.onMessage.removeListener?.(handleRuntimeMessage);
      try {
        port?.disconnect();
      } catch {
        // Ignore
      }
      port = null;
      executor.dispose();
    },
  };
}

const maybeGlobalChrome = (
  globalThis as unknown as {
    chrome?: ChromeOffscreenRuntimeApi;
    __DOKITOOL_EXT_TEST__?: boolean;
  }
).chrome;

if (
  typeof document !== "undefined" &&
  maybeGlobalChrome?.runtime?.id &&
  !(globalThis as unknown as { __DOKITOOL_EXT_TEST__?: boolean })
    .__DOKITOOL_EXT_TEST__
) {
  createOffscreenController({ chrome: maybeGlobalChrome });
}
