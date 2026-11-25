/**
 * Optional File System Access API (`showSaveFilePicker`) streaming direct-write
 * helper shared by Web SPA and Chrome Extension SidePanel (Issue #48 Spec B.3 §4).
 * Physically bypasses `chrome.downloads` third-party extension interception while
 * remaining 100% opt-in and anonymous (`credentials: "omit"`).
 */

export const WEB_SAVE_FILE_PICKER_PREF_KEY = "dokitool:save-file-picker";

export interface SaveFileWritableStreamLike {
  write(data: Uint8Array | ArrayBuffer | Blob): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface SaveFileHandleLike {
  name?: string;
  createWritable(): Promise<SaveFileWritableStreamLike>;
}

interface SaveFilePickerWindowLike {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<SaveFileHandleLike>;
}

export function isSaveFilePickerSupported(): boolean {
  const g = globalThis as unknown as SaveFilePickerWindowLike;
  return typeof g.showSaveFilePicker === "function";
}

export function readWebSaveFilePickerPreference(): boolean {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    return window.localStorage.getItem(WEB_SAVE_FILE_PICKER_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeWebSaveFilePickerPreference(enabled: boolean): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    if (enabled) {
      window.localStorage.setItem(WEB_SAVE_FILE_PICKER_PREF_KEY, "1");
    } else {
      window.localStorage.removeItem(WEB_SAVE_FILE_PICKER_PREF_KEY);
    }
  } catch {
    // Storage access is optional in private browsing.
  }
}

function normalizeLeafSuggestedName(rawFilename: string): string {
  const normalized = (rawFilename || "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  const leaf = (idx >= 0 ? normalized.slice(idx + 1) : normalized).trim();
  return leaf || "download.mp4";
}

function buildPickerTypes(
  leafFilename: string,
  mimeType?: string,
): Array<{ description: string; accept: Record<string, string[]> }> | undefined {
  const dot = leafFilename.lastIndexOf(".");
  const ext = dot > 0 ? leafFilename.slice(dot).toLowerCase() : "";
  if (!/^\.[a-z0-9]{2,6}$/.test(ext)) return undefined;
  const normalizedMime = (mimeType || "").split(";")[0].trim().toLowerCase();
  const mime =
    normalizedMime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalizedMime)
      ? normalizedMime
      : ext === ".mp4"
        ? "video/mp4"
        : ext === ".webm"
          ? "video/webm"
          : ext === ".m4a"
            ? "audio/mp4"
            : ext === ".jpg" || ext === ".jpeg"
              ? "image/jpeg"
              : ext === ".png"
                ? "image/png"
                : ext === ".webp"
                  ? "image/webp"
                  : ext === ".zip"
                    ? "application/zip"
                    : "application/octet-stream";
  return [{ description: "Media file", accept: { [mime]: [ext] } }];
}

export type SaveFilePickerPromptResult =
  | { status: "granted"; handle: SaveFileHandleLike; suggestedName: string }
  | { status: "cancelled" }
  | { status: "unsupported" };

/**
 * Prompts the OS save dialog immediately under the current user click gesture.
 * Must be invoked synchronously before unrelated `await` calls.
 */
export async function promptSaveFileHandle(
  rawFilename: string,
  mimeType?: string,
): Promise<SaveFilePickerPromptResult> {
  const g = globalThis as unknown as SaveFilePickerWindowLike;
  if (typeof g.showSaveFilePicker !== "function") {
    return { status: "unsupported" };
  }
  const suggestedName = normalizeLeafSuggestedName(rawFilename);
  const types = buildPickerTypes(suggestedName, mimeType);
  try {
    const handle = await g.showSaveFilePicker({
      suggestedName,
      ...(types ? { types } : {}),
    });
    return { status: "granted", handle, suggestedName };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || /cancel|abort/i.test(err.message))
    ) {
      return { status: "cancelled" };
    }
    return { status: "unsupported" };
  }
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const POISONED_MEDIA_PREFIX_RE = /^(?:<!doctype|<html|#EXTM3U|\{"|\[\{)/i;
const MANIFEST_PATH_RE = /\.(?:m3u8|mpd)(?:$|[?#])/i;

function isSafeDirectPickerUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.includes("#") || MANIFEST_PATH_RE.test(trimmed)) {
    return false;
  }
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f || code === 0x5c) {
      return false;
    }
  }
  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//")) return false;
    const loc = globalThis.location;
    if (
      !loc ||
      (loc.protocol !== "http:" && loc.protocol !== "https:") ||
      typeof loc.origin !== "string" ||
      !/^https?:\/\//i.test(loc.origin)
    ) {
      return false;
    }
    try {
      const parsed = new URL(trimmed, loc.origin);
      return (
        !parsed.username &&
        !parsed.password &&
        !parsed.hash &&
        !MANIFEST_PATH_RE.test(parsed.pathname)
      );
    } catch {
      return false;
    }
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    const schemeEnd = trimmed.indexOf("://") + 3;
    const pathStart = trimmed.indexOf("/", schemeEnd);
    const authority =
      pathStart >= 0 ? trimmed.slice(schemeEnd, pathStart) : trimmed.slice(schemeEnd);
    if (parsed.username || parsed.password || authority.includes("@")) {
      return false;
    }
    if (parsed.hash || MANIFEST_PATH_RE.test(parsed.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function withIdleTimeout<T>(
  promise: Promise<T>,
  controller: AbortController,
  idleTimeoutMs: number,
): Promise<T> {
  if (!(idleTimeoutMs > 0) || !Number.isFinite(idleTimeoutMs)) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error("直写连接空闲超时");
      try {
        controller.abort(err);
      } catch {
        // Ignore abort errors
      }
      reject(err);
    }, idleTimeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function streamRoutesToFileHandle(params: {
  handle: SaveFileHandleLike;
  routes: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  validateUrl?: (url: string) => boolean;
  idleTimeoutMs?: number;
  onProgress?: (progress: {
    loaded: number;
    total: number;
    percent: number;
  }) => void;
}): Promise<{ loaded: number; total: number }> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("当前环境不支持 fetch");
  }
  const idleTimeoutMs =
    typeof params.idleTimeoutMs === "number" &&
    Number.isFinite(params.idleTimeoutMs) &&
    params.idleTimeoutMs > 0
      ? params.idleTimeoutMs
      : DEFAULT_IDLE_TIMEOUT_MS;

  const candidates = Array.from(
    new Set(
      (params.routes || [])
        .map((r) => (typeof r === "string" ? r.trim() : ""))
        .filter(
          (r) =>
            Boolean(r) &&
            isSafeDirectPickerUrl(r) &&
            (!params.validateUrl || params.validateUrl(r)),
        ),
    ),
  );
  if (!candidates.length) {
    throw new Error("缺少符合安全规则的可直写媒体地址");
  }

  let response: Response | null = null;
  let activeController: AbortController | null = null;
  let activeCleanup: (() => void) | null = null;
  let lastErr: unknown = null;
  try {
    for (const url of candidates) {
      params.signal?.throwIfAborted();
      if (params.validateUrl && !params.validateUrl(url)) {
        lastErr = new Error("下载域名不在允许白名单内，已拦截直写");
        continue;
      }
      const routeController = new AbortController();
      const onRouteAbort = () => {
        try {
          routeController.abort(params.signal?.reason);
        } catch {
          // Ignore
        }
      };
      if (params.signal) {
        if (params.signal.aborted) {
          onRouteAbort();
        } else {
          params.signal.addEventListener("abort", onRouteAbort, { once: true });
        }
      }
      const cleanupRouteListener = () => {
        params.signal?.removeEventListener("abort", onRouteAbort);
      };
      try {
        const resp = await withIdleTimeout(
          fetchFn(url, {
            method: "GET",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: routeController.signal,
          }),
          routeController,
          idleTimeoutMs,
        );
        params.signal?.throwIfAborted();
        if (resp.url) {
          const redirectSafe =
            isSafeDirectPickerUrl(resp.url) &&
            (!params.validateUrl || params.validateUrl(resp.url));
          if (!redirectSafe) {
            lastErr = new Error("重定向目标不在安全白名单内，已拦截直写");
            try {
              await resp.body?.cancel?.();
            } catch {
              // Ignore
            }
            cleanupRouteListener();
            continue;
          }
        }
        if (
          resp.status !== 200 ||
          resp.type === "opaque" ||
          resp.headers.has("content-range") ||
          !resp.body
        ) {
          lastErr = new Error(`资源不是完整文件响应（HTTP ${resp.status}）`);
          try {
            await resp.body?.cancel?.();
          } catch {
            // Ignore
          }
          cleanupRouteListener();
          continue;
        }
        response = resp;
        activeController = routeController;
        activeCleanup = cleanupRouteListener;
        break;
      } catch (err) {
        cleanupRouteListener();
        if (params.signal?.aborted) throw err;
        lastErr = err;
      }
    }
    if (!response || !response.body || !activeController) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error("直写拉取媒体失败，请回退默认下载");
    }

    const contentEncoding = (
      response.headers.get("content-encoding") || ""
    )
      .trim()
      .toLowerCase();
    const contentLength = Number(response.headers.get("content-length") || "0");
    const total =
      (!contentEncoding || contentEncoding === "identity") &&
      Number.isFinite(contentLength) &&
      contentLength > 0
        ? contentLength
        : 0;
    const writable = await params.handle.createWritable();
    let loaded = 0;
    let closed = false;
    const reader = response.body.getReader();
    try {
      while (true) {
        params.signal?.throwIfAborted();
        const { done, value } = await withIdleTimeout(
          reader.read(),
          activeController,
          idleTimeoutMs,
        );
        if (done) break;
        if (value && value.byteLength > 0) {
          if (loaded === 0) {
            const prefix = new TextDecoder()
              .decode(value.subarray(0, 100))
              .trimStart();
            if (POISONED_MEDIA_PREFIX_RE.test(prefix)) {
              throw new Error(
                "资源返回了页面或播放清单，不能作为完整媒体保存",
              );
            }
          }
          if (total > 0 && loaded + value.byteLength > total) {
            throw new Error("下载内容超过声明大小，文件不完整或响应异常");
          }
          await writable.write(value);
          loaded += value.byteLength;
          const percent =
            total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
          params.onProgress?.({ loaded, total, percent });
        }
      }
      params.signal?.throwIfAborted();
      if (loaded === 0 || (total > 0 && loaded !== total)) {
        throw new Error(
          `下载不完整：期望 ${total || "未知"} 字节，实际 ${loaded} 字节`,
        );
      }
      await writable.close();
      closed = true;
      params.onProgress?.({ loaded, total: total || loaded, percent: 100 });
      return { loaded, total: total || loaded };
    } catch (err) {
      try {
        await reader.cancel(err);
      } catch {
        // Ignore cancel failure
      }
      if (!closed) {
        try {
          await writable.abort?.(err);
        } catch {
          // Ignore cleanup failure
        }
      }
      throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore
      }
    }
  } finally {
    activeCleanup?.();
  }
}
