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

export async function streamRoutesToFileHandle(params: {
  handle: SaveFileHandleLike;
  routes: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
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
  const candidates = Array.from(
    new Set(
      (params.routes || [])
        .map((r) => (typeof r === "string" ? r.trim() : ""))
        .filter((r) => /^https?:\/\//i.test(r) || r.startsWith("/")),
    ),
  );
  if (!candidates.length) {
    throw new Error("缺少可直写的媒体地址");
  }

  let response: Response | null = null;
  let lastErr: unknown = null;
  for (const url of candidates) {
    params.signal?.throwIfAborted();
    try {
      const resp = await fetchFn(url, {
        method: "GET",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: params.signal,
      });
      if (!resp.ok) {
        lastErr = new Error(`HTTP ${resp.status}`);
        try {
          await resp.body?.cancel?.();
        } catch {
          // Ignore
        }
        continue;
      }
      response = resp;
      break;
    } catch (err) {
      if (params.signal?.aborted) throw err;
      lastErr = err;
    }
  }
  if (!response) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error("直写拉取媒体失败，请回退默认下载");
  }

  const contentLength = Number(response.headers.get("content-length") || "0");
  const total =
    Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
  const writable = await params.handle.createWritable();
  let loaded = 0;
  let closed = false;
  try {
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      try {
        while (true) {
          params.signal?.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await writable.write(value);
            loaded += value.byteLength;
            const percent =
              total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
            params.onProgress?.({ loaded, total, percent });
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Ignore
        }
      }
    } else {
      const buf = await response.arrayBuffer();
      loaded = buf.byteLength;
      await writable.write(buf);
      params.onProgress?.({ loaded, total: total || loaded, percent: 99 });
    }
    await writable.close();
    closed = true;
    params.onProgress?.({ loaded, total: total || loaded, percent: 100 });
    return { loaded, total: total || loaded };
  } catch (err) {
    if (!closed) {
      try {
        await writable.abort?.(err);
      } catch {
        // Ignore cleanup failure
      }
    }
    throw err;
  }
}
