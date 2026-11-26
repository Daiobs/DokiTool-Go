import type { UnifiedMedia } from "../../types/media";
import {
  buildSafeDownloadPath,
  sanitizeFilenameSegment,
} from "../filenameSanitizer";
import { PROD_API_ORIGIN, isWhitelistedMediaUrl } from "../hostWhitelist";
import {
  DOKITOOL_EXTENSION_ID,
  errRpc,
  isWebToExtensionRequest,
  okRpc,
  type EnqueueDownloadItem,
  type ExtensionDownloadTask,
  type ExtensionRpcResponse,
  type OffscreenDownloadSpec,
  type WebBridgeCapability,
  type WebExtTaskPhase,
  type WebToExtensionRequest,
} from "../protocol";
import type { ExtensionStorageController } from "../storage";
import { HttpStatusError, type ParseYouTubeViaOffscreenParams } from "./apiClient";
import type {
  ChromeBackgroundApi,
  ChromeRuntimeMessageListener,
  ExternalWebSenderCheckResult,
} from "./types";

const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const WEB_BRIDGE_CAPABILITIES: readonly WebBridgeCapability[] = [
  "dash_mux",
  "direct_download",
  "youtube_parse",
  "youtube_mux",
];

const ALLOWED_WEB_BRIDGE_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "webm",
  "mov",
  "mkv",
  "m4a",
  "mp3",
  "aac",
  "ogg",
  "opus",
  "wav",
  "flac",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "ts",
  "bin",
]);

const ALLOWED_YOUTUBE_DIRECT_EXTENSIONS = new Set(["mp4", "m4a", "webm"]);

export const WEB_EXT_PING_SETTINGS_TIMEOUT_MS = 200;

/**
 * Reads `useSaveFilePicker` from extension storage with a strict upper time bound
 * so `WEB_EXT_PING` never stalls or fails when `chrome.storage` is slow or broken.
 * Always falls back to `false` on error, non-boolean value, or timeout, clearing
 * its timer in `finally` and swallowing late rejections.
 */
export async function readSaveFilePickerPrefBounded(
  storage: Pick<ExtensionStorageController, "getSettings">,
  timeoutMs: number = WEB_EXT_PING_SETTINGS_TIMEOUT_MS,
): Promise<boolean> {
  const safeTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : WEB_EXT_PING_SETTINGS_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settingsPromise: Promise<boolean> = Promise.resolve()
    .then(() => storage.getSettings())
    .then((settings) =>
      Boolean(
        settings &&
          typeof settings === "object" &&
          settings.useSaveFilePicker === true,
      ),
    )
    .catch(() => false);
  const timeoutPromise = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), safeTimeoutMs);
  });
  try {
    return await Promise.race([settingsPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Strictly validates an external `onMessageExternal` sender origin.
 * Production builds ONLY accept exact `https://snap.dokitool.com`.
 * Dev loopback builds additionally accept `http://127.0.0.1` / `http://localhost`
 * ONLY when the runtime manifest's own `externally_connectable.matches` declares them.
 */
export function validateExternalWebSender(
  sender: unknown,
  manifest?: {
    externally_connectable?: { matches?: string[] };
  } | null,
): ExternalWebSenderCheckResult {
  if (!sender || typeof sender !== "object") {
    return {
      allowed: false,
      origin: "",
      isLoopback: false,
      reason: "缺少外部消息发送方信息",
    };
  }
  const rec = sender as {
    origin?: unknown;
    url?: unknown;
    tab?: { url?: unknown };
    id?: unknown;
  };
  if (typeof rec.id === "string" && rec.id.trim().length > 0) {
    return {
      allowed: false,
      origin: "",
      isLoopback: false,
      reason: "不允许其他扩展调用外部 Web 桥接接口",
    };
  }

  const rawOrigin = typeof rec.origin === "string" ? rec.origin.trim() : "";
  const rawUrl =
    typeof rec.url === "string" && rec.url.trim()
      ? rec.url.trim()
      : typeof rec.tab?.url === "string" && rec.tab.url.trim()
        ? rec.tab.url.trim()
        : "";
  const candidate = rawOrigin || rawUrl;
  if (!candidate) {
    return {
      allowed: false,
      origin: "",
      isLoopback: false,
      reason: "外部消息缺少发送方来源",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      allowed: false,
      origin: "",
      isLoopback: false,
      reason: "外部消息发送方来源格式无效",
    };
  }

  if (parsed.username || parsed.password) {
    return {
      allowed: false,
      origin: "",
      isLoopback: false,
      reason: "外部消息发送方不允许包含凭据",
    };
  }

  if (rawOrigin && rawUrl) {
    try {
      const parsedUrl = new URL(rawUrl);
      if (parsedUrl.origin !== parsed.origin) {
        return {
          allowed: false,
          origin: "",
          isLoopback: false,
          reason: "外部消息发送方 origin 与 url 不一致",
        };
      }
    } catch {
      return {
        allowed: false,
        origin: "",
        isLoopback: false,
        reason: "外部消息发送方 url 格式无效",
      };
    }
  }

  if (parsed.origin === PROD_API_ORIGIN) {
    return { allowed: true, origin: PROD_API_ORIGIN, isLoopback: false };
  }

  const matches = Array.isArray(manifest?.externally_connectable?.matches)
    ? manifest.externally_connectable.matches
    : [];
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "http:") {
    if (host === "127.0.0.1" && matches.includes("http://127.0.0.1/*")) {
      return { allowed: true, origin: parsed.origin, isLoopback: true };
    }
    if (host === "localhost" && matches.includes("http://localhost/*")) {
      return { allowed: true, origin: parsed.origin, isLoopback: true };
    }
  }

  return {
    allowed: false,
    origin: parsed.origin,
    isLoopback: false,
    reason: `未授权的外部调用来源：${parsed.origin}`,
  };
}

export function mapTaskStatusToWebPhase(
  status: ExtensionDownloadTask["status"],
): WebExtTaskPhase {
  switch (status) {
    case "queued":
    case "parsing":
      return "queued";
    case "downloading":
      return "downloading";
    case "muxing":
      return "muxing";
    case "saving":
      return "saving";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

export function sanitizeWebBridgeFilename(
  rawFilename: unknown,
  defaultExt: string,
  subfolderPrefix: string,
  forceExt?: string,
  allowedExtensions: ReadonlySet<string> = ALLOWED_WEB_BRIDGE_EXTENSIONS,
): string {
  const trimmed = typeof rawFilename === "string" ? rawFilename.trim() : "";
  const flatLeaf = sanitizeFilenameSegment(trimmed, {
    fallback: "download",
  });
  const dotIdx = flatLeaf.lastIndexOf(".");
  const rawSuffix =
    dotIdx > 0 && dotIdx < flatLeaf.length - 1
      ? flatLeaf.slice(dotIdx + 1).toLowerCase()
      : "";
  const hasAllowedExt = allowedExtensions.has(rawSuffix);
  const stem = hasAllowedExt ? flatLeaf.slice(0, dotIdx) : flatLeaf;
  const ext = forceExt || (hasAllowedExt ? rawSuffix : defaultExt);
  return buildSafeDownloadPath({
    prefix: subfolderPrefix,
    stem,
    ext: ext || defaultExt,
  });
}

function parseOptionalPositiveSafeInt(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
    ? raw
    : undefined;
}

function validateWebBridgeRoutes(
  rawRoutes: unknown,
  fieldLabel: string,
  allowedExtraOrigins?: string[],
): { ok: true; routes: string[] } | { ok: false; error: string; code: string } {
  if (!Array.isArray(rawRoutes) || rawRoutes.length === 0) {
    return {
      ok: false,
      error: `${fieldLabel}不能为空`,
      code: "INVALID_PAYLOAD",
    };
  }
  if (rawRoutes.length > 8) {
    return {
      ok: false,
      error: `${fieldLabel}数量超出限制`,
      code: "INVALID_PAYLOAD",
    };
  }
  const routes: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawRoutes) {
    if (typeof raw !== "string" || !raw.trim()) {
      return {
        ok: false,
        error: `${fieldLabel}包含无效链接`,
        code: "INVALID_PAYLOAD",
      };
    }
    const trimmed = raw.trim();
    const check = isWhitelistedMediaUrl(trimmed, allowedExtraOrigins);
    if (!check.allowed) {
      return {
        ok: false,
        error: check.reason || `域名 ${check.hostname} 不在扩展安全白名单内`,
        code: "UNWHITELISTED_CDN",
      };
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      routes.push(trimmed);
    }
  }
  return { ok: true, routes };
}

function validateYouTubeMediaUrl(
  rawUrl: unknown,
  fieldLabel: string,
  senderCheck: ExternalWebSenderCheckResult,
  allowedExtraOrigins?: string[],
): { ok: true; url: string } | { ok: false; error: string; code: string } {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return {
      ok: false,
      error: `${fieldLabel}不能为空`,
      code: "INVALID_PAYLOAD",
    };
  }
  const trimmed = rawUrl.trim();
  const check = isWhitelistedMediaUrl(trimmed, allowedExtraOrigins);
  if (!check.allowed) {
    return {
      ok: false,
      error: check.reason || `域名 ${check.hostname} 不在扩展安全白名单内`,
      code: "UNWHITELISTED_CDN",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: `${fieldLabel}格式无效`,
      code: "INVALID_PAYLOAD",
    };
  }

  const host = parsed.hostname.toLowerCase();
  const isStrictGoogleVideo =
    parsed.protocol === "https:" &&
    host.endsWith(".googlevideo.com") &&
    host.length > ".googlevideo.com".length;
  const isDevLoopbackOrigin =
    senderCheck.isLoopback &&
    parsed.protocol === "http:" &&
    parsed.origin === senderCheck.origin;

  if (!isStrictGoogleVideo && !isDevLoopbackOrigin) {
    return {
      ok: false,
      error: `${fieldLabel}仅允许 https://*.googlevideo.com 媒体域名`,
      code: "UNWHITELISTED_CDN",
    };
  }

  return { ok: true, url: trimmed };
}

function inferYouTubeDirectDefaultExt(safeMimeType?: string): "mp4" | "m4a" | "webm" {
  if (safeMimeType === "video/webm" || safeMimeType === "audio/webm") {
    return "webm";
  }
  if (safeMimeType === "audio/mp4" || safeMimeType === "audio/m4a") {
    return "m4a";
  }
  return "mp4";
}

function inferYouTubeDirectMime(filename: string, safeMimeType?: string): string {
  if (safeMimeType) return safeMimeType;
  const lower = filename.toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  return "video/mp4";
}

export interface WebExternalBridgeDeps {
  chromeApi: ChromeBackgroundApi;
  storage: ExtensionStorageController;
  tasks: Map<string, ExtensionDownloadTask>;
  webBridgeTaskIds: Set<string>;
  parseYouTubeViaOffscreen: (
    params: ParseYouTubeViaOffscreenParams,
  ) => Promise<UnifiedMedia>;
  enqueueDownloadItems: (
    items: EnqueueDownloadItem[],
    groupBatchId?: string,
  ) => Promise<{ taskIds: string[]; tasks: ExtensionDownloadTask[] }>;
  cancelTaskById: (
    taskId: string,
  ) => Promise<{ taskId: string; cancelled: boolean }>;
}

export interface WebExternalBridge {
  handleExternalRuntimeMessage: ChromeRuntimeMessageListener;
}

export function createWebExternalBridge(
  deps: WebExternalBridgeDeps,
): WebExternalBridge {
  const {
    chromeApi,
    storage,
    tasks,
    webBridgeTaskIds,
    parseYouTubeViaOffscreen,
    enqueueDownloadItems,
    cancelTaskById,
  } = deps;

  const handleWebExternalRequest = async (
    req: WebToExtensionRequest,
    senderCheck: ExternalWebSenderCheckResult,
  ): Promise<ExtensionRpcResponse<unknown>> => {
    const manifest = chromeApi.runtime.getManifest?.();
    const manifestVersion = String(manifest?.version || "0.0.0");

    switch (req.type) {
      case "WEB_EXT_PING": {
        const useSaveFilePicker = await readSaveFilePickerPrefBounded(storage);
        return okRpc({
          version: manifestVersion,
          extensionId: chromeApi.runtime.id || DOKITOOL_EXTENSION_ID,
          capabilities: [...WEB_BRIDGE_CAPABILITIES],
          useSaveFilePicker,
        });
      }

      case "WEB_EXT_PARSE_YOUTUBE": {
        const videoId = typeof req.videoId === "string" ? req.videoId.trim() : "";
        if (!YOUTUBE_VIDEO_ID_RE.test(videoId)) {
          return errRpc("YouTube 视频 ID 格式无效", { code: "INVALID_PAYLOAD" });
        }
        const apiOrigin = senderCheck.isLoopback
          ? senderCheck.origin
          : PROD_API_ORIGIN;
        const media = await parseYouTubeViaOffscreen({
          videoId,
          apiOrigin,
          // Strictly zero-secret: NEVER attach owner's stored bearerToken for external web bridge!
          authSettings: { bearerToken: "" },
          helperVersion: manifestVersion,
          extensionVersion: manifestVersion,
        });
        return okRpc({ media });
      }

      case "WEB_EXT_ENQUEUE_MEDIA": {
        const payload = req.payload as unknown;
        if (!payload || typeof payload !== "object") {
          return errRpc("缺少下载任务参数", { code: "INVALID_PAYLOAD" });
        }
        const rec = payload as Record<string, unknown>;
        const kind = rec.kind;
        if (
          kind !== "dash_mux" &&
          kind !== "direct_download" &&
          kind !== "youtube_mux" &&
          kind !== "youtube_direct"
        ) {
          return errRpc("不支持的外部下载任务类型", { code: "INVALID_PAYLOAD" });
        }
        const platform =
          typeof rec.platform === "string" ? rec.platform.trim().slice(0, 64) : "";
        if (!platform) {
          return errRpc("缺少平台标识", { code: "INVALID_PAYLOAD" });
        }

        const settings = await storage.getSettings();
        const webBridgeExtraOrigins = senderCheck.isLoopback
          ? [senderCheck.origin]
          : undefined;
        const apiOrigin = senderCheck.isLoopback
          ? senderCheck.origin
          : PROD_API_ORIGIN;
        const rawTitle =
          typeof rec.title === "string" && rec.title.trim()
            ? rec.title.trim().slice(0, 120)
            : typeof rec.filename === "string" && rec.filename.trim()
              ? rec.filename.trim().slice(0, 120)
              : "媒体下载";
        const safeMimeType =
          typeof rec.mimeType === "string" &&
          /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(rec.mimeType.trim())
            ? rec.mimeType.trim().toLowerCase()
            : undefined;

        let spec: OffscreenDownloadSpec;
        if (kind === "dash_mux") {
          const dashMuxRaw = rec.dashMux as Record<string, unknown> | undefined;
          if (!dashMuxRaw || typeof dashMuxRaw !== "object") {
            return errRpc("缺少 DASH 合流轨参数", { code: "INVALID_PAYLOAD" });
          }
          const outputContainer =
            dashMuxRaw.outputContainer === undefined
              ? "mp4"
              : dashMuxRaw.outputContainer;
          if (outputContainer !== "mp4") {
            return errRpc("仅支持 MP4 无损合流输出", { code: "INVALID_PAYLOAD" });
          }
          const vRoutesCheck = validateWebBridgeRoutes(
            dashMuxRaw.videoRoutes,
            "视频轨线路",
            webBridgeExtraOrigins,
          );
          if (!vRoutesCheck.ok) {
            return errRpc(vRoutesCheck.error, { code: vRoutesCheck.code });
          }
          const aRoutesCheck = validateWebBridgeRoutes(
            dashMuxRaw.audioRoutes,
            "音频轨线路",
            webBridgeExtraOrigins,
          );
          if (!aRoutesCheck.ok) {
            return errRpc(aRoutesCheck.error, { code: aRoutesCheck.code });
          }
          const videoSize = parseOptionalPositiveSafeInt(dashMuxRaw.videoSize);
          const audioSize = parseOptionalPositiveSafeInt(dashMuxRaw.audioSize);
          const declaredTotal =
            parseOptionalPositiveSafeInt(rec.sizeBytes) ??
            (videoSize && audioSize ? videoSize + audioSize : undefined);
          const safeFilename = sanitizeWebBridgeFilename(
            rec.filename,
            "mp4",
            settings.subfolderPrefix,
            "mp4",
          );
          spec = {
            kind: "dash_mux",
            apiOrigin,
            routes: vRoutesCheck.routes,
            filename: safeFilename,
            mimeType: "video/mp4",
            ...(declaredTotal ? { sizeBytes: declaredTotal } : {}),
            ...(webBridgeExtraOrigins
              ? { extraAllowedOrigins: webBridgeExtraOrigins }
              : {}),
            dashMux: {
              videoRoutes: vRoutesCheck.routes,
              audioRoutes: aRoutesCheck.routes,
              ...(videoSize ? { videoSize } : {}),
              ...(audioSize ? { audioSize } : {}),
              outputContainer: "mp4",
            },
          };
        } else if (kind === "youtube_mux") {
          const ytMuxRaw = rec.youtubeMux as Record<string, unknown> | undefined;
          if (!ytMuxRaw || typeof ytMuxRaw !== "object") {
            return errRpc("缺少 YouTube 合流轨参数", { code: "INVALID_PAYLOAD" });
          }
          const outputContainer = ytMuxRaw.outputContainer;
          if (outputContainer !== "mp4" && outputContainer !== "webm") {
            return errRpc("YouTube 合流仅支持 MP4 或 WebM 输出格式", {
              code: "INVALID_PAYLOAD",
            });
          }
          const vCheck = validateYouTubeMediaUrl(
            ytMuxRaw.videoUrl,
            "YouTube 视频轨链接",
            senderCheck,
            webBridgeExtraOrigins,
          );
          if (!vCheck.ok) {
            return errRpc(vCheck.error, { code: vCheck.code });
          }
          const aCheck = validateYouTubeMediaUrl(
            ytMuxRaw.audioUrl,
            "YouTube 音频轨链接",
            senderCheck,
            webBridgeExtraOrigins,
          );
          if (!aCheck.ok) {
            return errRpc(aCheck.error, { code: aCheck.code });
          }
          const videoSize = parseOptionalPositiveSafeInt(ytMuxRaw.videoSize);
          const audioSize = parseOptionalPositiveSafeInt(ytMuxRaw.audioSize);
          const declaredTotal =
            parseOptionalPositiveSafeInt(rec.sizeBytes) ??
            (videoSize && audioSize ? videoSize + audioSize : undefined);
          const safeFilename = sanitizeWebBridgeFilename(
            rec.filename,
            outputContainer,
            settings.subfolderPrefix,
            outputContainer,
          );
          spec = {
            kind: "youtube_mux",
            apiOrigin,
            routes: [vCheck.url],
            filename: safeFilename,
            mimeType: outputContainer === "webm" ? "video/webm" : "video/mp4",
            ...(declaredTotal ? { sizeBytes: declaredTotal } : {}),
            ...(webBridgeExtraOrigins
              ? { extraAllowedOrigins: webBridgeExtraOrigins }
              : {}),
            youtubeMux: {
              videoUrl: vCheck.url,
              audioUrl: aCheck.url,
              ...(videoSize ? { videoSize } : {}),
              ...(audioSize ? { audioSize } : {}),
              outputContainer,
            },
          };
        } else if (kind === "youtube_direct") {
          const urlCheck = validateYouTubeMediaUrl(
            rec.url,
            "YouTube 下载链接",
            senderCheck,
            webBridgeExtraOrigins,
          );
          if (!urlCheck.ok) {
            return errRpc(urlCheck.error, { code: urlCheck.code });
          }
          const sizeBytes = parseOptionalPositiveSafeInt(rec.sizeBytes);
          const defaultExt = inferYouTubeDirectDefaultExt(safeMimeType);
          const safeFilename = sanitizeWebBridgeFilename(
            rec.filename,
            defaultExt,
            settings.subfolderPrefix,
            undefined,
            ALLOWED_YOUTUBE_DIRECT_EXTENSIONS,
          );
          spec = {
            kind: "youtube_direct",
            apiOrigin,
            routes: [urlCheck.url],
            filename: safeFilename,
            mimeType: inferYouTubeDirectMime(safeFilename, safeMimeType),
            ...(sizeBytes ? { sizeBytes } : {}),
            ...(webBridgeExtraOrigins
              ? { extraAllowedOrigins: webBridgeExtraOrigins }
              : {}),
          };
        } else {
          const routesCheck = validateWebBridgeRoutes(
            rec.routes,
            "下载线路",
            webBridgeExtraOrigins,
          );
          if (!routesCheck.ok) {
            return errRpc(routesCheck.error, { code: routesCheck.code });
          }
          const sizeBytes = parseOptionalPositiveSafeInt(rec.sizeBytes);
          const safeFilename = sanitizeWebBridgeFilename(
            rec.filename,
            "mp4",
            settings.subfolderPrefix,
          );
          spec = {
            kind: "direct_file",
            apiOrigin,
            routes: routesCheck.routes,
            filename: safeFilename,
            ...(safeMimeType ? { mimeType: safeMimeType } : {}),
            ...(sizeBytes ? { sizeBytes } : {}),
            ...(webBridgeExtraOrigins
              ? { extraAllowedOrigins: webBridgeExtraOrigins }
              : {}),
          };
        }

        const enqueued = await enqueueDownloadItems([
          {
            title: rawTitle,
            platform,
            spec,
          },
        ]);
        const createdTask = enqueued.tasks[0];
        if (!createdTask) {
          return errRpc("创建下载任务失败", { code: "ENQUEUE_FAILED" });
        }
        webBridgeTaskIds.add(createdTask.taskId);
        return okRpc({
          taskId: createdTask.taskId,
          status: createdTask.status,
        });
      }

      case "WEB_EXT_GET_TASK_STATUS": {
        const taskId = typeof req.taskId === "string" ? req.taskId.trim() : "";
        if (!taskId || !webBridgeTaskIds.has(taskId)) {
          return errRpc("未找到该桥接下载任务", { code: "TASK_NOT_FOUND" });
        }
        const task = tasks.get(taskId);
        if (!task) {
          webBridgeTaskIds.delete(taskId);
          return errRpc("未找到该桥接下载任务", { code: "TASK_NOT_FOUND" });
        }
        return okRpc({
          taskId: task.taskId,
          status: task.status,
          phase: mapTaskStatusToWebPhase(task.status),
          ...(typeof task.statusText === "string" &&
          task.statusText.trim() &&
          !/https?:\/\//i.test(task.statusText)
            ? { statusText: task.statusText.trim().slice(0, 120) }
            : {}),
          progress: task.percent,
          loadedBytes: task.loaded,
          totalBytes: task.total,
          speedBytesPerSec: task.speed,
          filename: task.filename,
          ...(typeof task.filenameWarning === "string" &&
          task.filenameWarning.trim() &&
          !/https?:\/\//i.test(task.filenameWarning)
            ? { filenameWarning: task.filenameWarning.trim().slice(0, 160) }
            : {}),
          ...(task.error ? { error: task.error } : {}),
        });
      }

      case "WEB_EXT_CANCEL_TASK": {
        const taskId = typeof req.taskId === "string" ? req.taskId.trim() : "";
        if (!taskId || !webBridgeTaskIds.has(taskId)) {
          return errRpc("未找到该桥接下载任务", { code: "TASK_NOT_FOUND" });
        }
        const task = tasks.get(taskId);
        if (!task) {
          webBridgeTaskIds.delete(taskId);
          return errRpc("未找到该桥接下载任务", { code: "TASK_NOT_FOUND" });
        }
        const res = await cancelTaskById(taskId);
        return okRpc(res);
      }
    }
  };

  const handleExternalRuntimeMessage: ChromeRuntimeMessageListener = (
    msg: unknown,
    sender: unknown,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    const senderCheck = validateExternalWebSender(
      sender,
      chromeApi.runtime.getManifest?.(),
    );
    if (!senderCheck.allowed) {
      sendResponse(
        errRpc(senderCheck.reason || "未授权的外部调用来源", {
          code: "FORBIDDEN_ORIGIN",
        }),
      );
      return false;
    }
    if (!isWebToExtensionRequest(msg)) {
      sendResponse(
        errRpc("不支持的外部消息类型", { code: "UNSUPPORTED_ACTION" }),
      );
      return false;
    }
    void handleWebExternalRequest(msg, senderCheck)
      .then((resp) => {
        sendResponse(resp);
      })
      .catch((err: unknown) => {
        const status =
          err instanceof HttpStatusError
            ? err.status
            : typeof (err as { status?: unknown })?.status === "number"
              ? (err as { status: number }).status
              : undefined;
        const code =
          err instanceof HttpStatusError
            ? err.code
            : typeof (err as { code?: unknown })?.code === "string"
              ? (err as { code: string }).code
              : undefined;
        const message =
          err instanceof Error && err.message ? err.message : "外部桥接处理失败";
        sendResponse(errRpc(message, { code, status }));
      });
    return true;
  };

  return {
    handleExternalRuntimeMessage,
  };
}
