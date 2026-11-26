import { syncWebSaveFilePickerPreference } from "../downloads/saveFilePicker";
import {
  DOKITOOL_EXTENSION_ID,
  errRpc,
  type ExtensionRpcResponse,
  type WebBridgeCapability,
  type WebExtCancelTaskData,
  type WebExtEnqueueMediaData,
  type WebExtEnqueuePayload,
  type WebExtParseYouTubeData,
  type WebExtPingData,
  type WebExtTaskStatusData,
  type WebToExtensionRequest,
  type WebToExtensionResponseMap,
} from "../extension/protocol";

export { DOKITOOL_EXTENSION_ID };

export const EXTENSION_BRIDGE_PING_TIMEOUT_MS = 800 as const;
export const EXTENSION_BRIDGE_RPC_TIMEOUT_MS = 5000 as const;
export const EXTENSION_BRIDGE_YOUTUBE_PARSE_TIMEOUT_MS = 30000 as const;

const KNOWN_WEB_BRIDGE_CAPABILITIES = new Set<string>([
  "dash_mux",
  "direct_download",
  "youtube_parse",
  "youtube_mux",
]);

export interface ExtensionBridgeState {
  connected: boolean;
  version: string;
  extensionId: string;
  capabilities: WebBridgeCapability[];
  useSaveFilePicker: boolean;
}

export const DISCONNECTED_EXTENSION_STATE: Readonly<ExtensionBridgeState> =
  Object.freeze({
    connected: false,
    version: "",
    extensionId: "",
    capabilities: [],
    useSaveFilePicker: false,
  });

interface ChromeExternalRuntimeLike {
  lastError?: { message?: string };
  sendMessage?: (
    extensionId: string,
    message: unknown,
    callback?: (response: unknown) => void,
  ) => Promise<unknown> | void;
}

function getChromeExternalRuntime(): ChromeExternalRuntimeLike | null {
  const g = globalThis as unknown as {
    chrome?: { runtime?: ChromeExternalRuntimeLike };
  };
  const runtime = g.chrome?.runtime;
  if (!runtime || typeof runtime.sendMessage !== "function") {
    return null;
  }
  return runtime;
}

export async function sendExternalExtensionMessage<
  T extends WebToExtensionRequest["type"],
>(
  request: Extract<WebToExtensionRequest, { type: T }>,
  options?: {
    timeoutMs?: number;
    extensionId?: string;
  },
): Promise<ExtensionRpcResponse<WebToExtensionResponseMap[T]>> {
  const runtime = getChromeExternalRuntime();
  if (!runtime?.sendMessage) {
    return errRpc("未检测到 Chrome 扩展运行环境", { code: "NO_CHROME_RUNTIME" });
  }

  const extensionId = options?.extensionId || DOKITOOL_EXTENSION_ID;
  const timeoutMs = Math.max(
    50,
    options?.timeoutMs ?? EXTENSION_BRIDGE_RPC_TIMEOUT_MS,
  );

  return new Promise<ExtensionRpcResponse<WebToExtensionResponseMap[T]>>(
    (resolve) => {
      let settled = false;
      const finish = (
        response: ExtensionRpcResponse<WebToExtensionResponseMap[T]>,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      };

      const timer = setTimeout(() => {
        finish(errRpc("连接 Chrome 扩展超时", { code: "BRIDGE_TIMEOUT" }));
      }, timeoutMs);

      const normalizeRawResponse = (raw: unknown) => {
        if (
          raw &&
          typeof raw === "object" &&
          typeof (raw as { ok?: unknown }).ok === "boolean"
        ) {
          finish(raw as ExtensionRpcResponse<WebToExtensionResponseMap[T]>);
          return;
        }
        finish(
          errRpc("Chrome 扩展未返回有效响应", { code: "EMPTY_RESPONSE" }),
        );
      };

      try {
        const maybePromise = runtime.sendMessage!(
          extensionId,
          request,
          (response) => {
            const lastErr = runtime.lastError;
            if (lastErr) {
              finish(
                errRpc(lastErr.message || "无法连接到 Chrome 扩展", {
                  code: "EXTENSION_UNAVAILABLE",
                }),
              );
              return;
            }
            normalizeRawResponse(response);
          },
        );
        if (
          maybePromise &&
          typeof (maybePromise as Promise<unknown>).then === "function"
        ) {
          (maybePromise as Promise<unknown>).then(
            (val) => normalizeRawResponse(val),
            (err) =>
              finish(
                errRpc(
                  err instanceof Error && err.message
                    ? err.message
                    : "与 Chrome 扩展通信失败",
                  { code: "EXTENSION_UNAVAILABLE" },
                ),
              ),
          );
        }
      } catch (err) {
        finish(
          errRpc(
            err instanceof Error && err.message
              ? err.message
              : "调用 Chrome 扩展失败",
            { code: "BRIDGE_ERROR" },
          ),
        );
      }
    },
  );
}

export async function pingInstalledExtension(options?: {
  timeoutMs?: number;
  extensionId?: string;
}): Promise<ExtensionBridgeState> {
  const resp = await sendExternalExtensionMessage(
    { type: "WEB_EXT_PING" },
    {
      timeoutMs: options?.timeoutMs ?? EXTENSION_BRIDGE_PING_TIMEOUT_MS,
      extensionId: options?.extensionId,
    },
  );

  if (!resp.ok) {
    syncWebSaveFilePickerPreference(false);
    return { ...DISCONNECTED_EXTENSION_STATE, capabilities: [] };
  }

  const data = resp.data as WebExtPingData | undefined;
  const capabilities = Array.isArray(data?.capabilities)
    ? data.capabilities.filter((cap): cap is WebBridgeCapability =>
        KNOWN_WEB_BRIDGE_CAPABILITIES.has(cap),
      )
    : [];
  const useSaveFilePicker = data?.useSaveFilePicker === true;
  syncWebSaveFilePickerPreference(useSaveFilePicker);

  return {
    connected: true,
    version: typeof data?.version === "string" ? data.version : "",
    extensionId:
      typeof data?.extensionId === "string" && data.extensionId
        ? data.extensionId
        : options?.extensionId || DOKITOOL_EXTENSION_ID,
    capabilities,
    useSaveFilePicker,
  };
}

export async function parseYouTubeViaExtension(
  videoId: string,
  options?: {
    locale?: "zh-CN" | "en";
    timeoutMs?: number;
    extensionId?: string;
  },
): Promise<ExtensionRpcResponse<WebExtParseYouTubeData>> {
  return sendExternalExtensionMessage(
    {
      type: "WEB_EXT_PARSE_YOUTUBE",
      videoId,
      ...(options?.locale ? { locale: options.locale } : {}),
    },
    {
      timeoutMs: options?.timeoutMs ?? EXTENSION_BRIDGE_YOUTUBE_PARSE_TIMEOUT_MS,
      extensionId: options?.extensionId,
    },
  );
}

export async function enqueueMediaViaExtension(
  payload: WebExtEnqueuePayload,
  options?: {
    timeoutMs?: number;
    extensionId?: string;
  },
): Promise<ExtensionRpcResponse<WebExtEnqueueMediaData>> {
  return sendExternalExtensionMessage(
    {
      type: "WEB_EXT_ENQUEUE_MEDIA",
      payload,
    },
    options,
  );
}

export async function getExtensionTaskStatus(
  taskId: string,
  options?: {
    timeoutMs?: number;
    extensionId?: string;
  },
): Promise<ExtensionRpcResponse<WebExtTaskStatusData>> {
  return sendExternalExtensionMessage(
    {
      type: "WEB_EXT_GET_TASK_STATUS",
      taskId,
    },
    options,
  );
}

export async function cancelExtensionTask(
  taskId: string,
  options?: {
    timeoutMs?: number;
    extensionId?: string;
  },
): Promise<ExtensionRpcResponse<WebExtCancelTaskData>> {
  return sendExternalExtensionMessage(
    {
      type: "WEB_EXT_CANCEL_TASK",
      taskId,
    },
    options,
  );
}

export function hasExtensionCapability(
  state: ExtensionBridgeState | null | undefined,
  capability: WebBridgeCapability,
): boolean {
  return Boolean(state?.connected && state.capabilities.includes(capability));
}
