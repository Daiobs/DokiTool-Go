import { sanitizeSubfolderPrefix } from "../filenameSanitizer";
import type {
  BatchSaveMode,
  ExtensionDownloadTask,
  PersistedTaskHistoryRecord,
  PersistedTaskHistoryStatus,
  QualityPreference,
} from "../protocol";
import type { StorageAreaLike } from "../storage";
import { extractParseUrlFromRefreshUrl } from "../targetSpecBuilder";
import { matchActiveParseUrl } from "../urlMatcher";
import type { ChromeBackgroundApi } from "./types";

export const TASK_HISTORY_STORAGE_KEY = "dokitool_ext_task_history_v1" as const;
export const MAX_PERSISTED_TASK_HISTORY = 50 as const;
export const SW_INTERRUPTED_STATUS_TEXT =
  "后台休眠中断，点击重试将重新解析" as const;

const TERMINAL_HISTORY_STATUSES = new Set<PersistedTaskHistoryStatus>([
  "completed", "failed", "cancelled",
]);

/** Media CDN domains that MUST NEVER be persisted as `sourcePageUrl` (Guardrail G6). */
const BLOCKED_CDN_HOST_SUFFIXES: readonly string[] = [
  "googlevideo.com", "ytimg.com", "ggpht.com", "googleusercontent.com",
  "bilivideo.com", "bilivideo.cn", "hdslb.com", "akamaized.net",
  "weibocdn.com", "sinaimg.cn",
  "douyinvod.com", "douyinstatic.com", "douyinpic.com", "zjcdn.com", "byteimg.com",
  "toutiaovod.com", "toutiaoimg.com", "ppxvod.com", "ibytedtos.com", "pstatp.com",
  "snssdk.com", "amemv.com", "xhscdn.com", "rednotecdn.com",
  "kwimgs.com", "yximgs.com", "kwaicdn.com", "ixiaochuan.cn", "szsttkj.com",
  "twimg.com", "cdninstagram.com", "fbcdn.net", "media.tumblr.com",
];

const BLOCKED_CDN_EXACT_HOSTS = new Set<string>([
  "cdn.xiaochuankeji.cn", "img.xiaochuankeji.cn",
  "img.ixiaochuankeji.cn", "file.ippzone.com",
]);

const SENSITIVE_QUERY_KEYS = new Set<string>([
  "sig", "signature", "upsig", "ticket", "token", "access_token", "id_token",
  "refresh_token", "session_token", "auth_token", "xsec_token", "auth",
  "auth_key", "authorization", "ip", "expire", "expires", "sign", "lsig",
  "sparams", "cookie", "cookies", "session", "sapisid", "sid", "hsid",
  "ssid", "apisid", "secret", "x-amz-signature", "x-amz-credential",
  "x-amz-security-token", "x-goog-signature",
]);

const DIRECT_MEDIA_PATH_RE =
  /(?:^\/videoplayback$|\/upgcxcode\/|\.(?:mp4|m4s|m4a|webm|mp3|aac|ts|m3u8|flv|mov|mkv|jpg|jpeg|png|webp|gif|avif|zip)$)/i;

const isBlockedCdnHost = (host: string): boolean =>
  BLOCKED_CDN_EXACT_HOSTS.has(host) ||
  BLOCKED_CDN_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));

const isSensitiveQueryKey = (rawKey: string): boolean => {
  const lower = rawKey.trim().toLowerCase();
  return Boolean(
    lower &&
      (SENSITIVE_QUERY_KEYS.has(lower) ||
        /_(?:sig|sign|ticket|secret|token)$/.test(lower)),
  );
};

const isUnsafePersistedUrl = (rawUrl: string): boolean => {
  try {
    const parsed = new URL(rawUrl.replace(/[).,;!?]+$/, ""));
    const host = parsed.hostname.toLowerCase();
    return Boolean(
      parsed.search ||
        parsed.username ||
        parsed.password ||
        isBlockedCdnHost(host) ||
        DIRECT_MEDIA_PATH_RE.test(parsed.pathname),
    );
  } catch {
    return true;
  }
};

/** Validates a canonical public work-page URL safe for Guardrail G6 persistence. */
export function sanitizeCanonicalSourcePageUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return undefined;
  const matched = matchActiveParseUrl(trimmed);
  if (!matched) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(matched.url);
  } catch {
    return undefined;
  }
  if (isBlockedCdnHost(parsed.hostname.toLowerCase()) || DIRECT_MEDIA_PATH_RE.test(parsed.pathname)) {
    return undefined;
  }
  for (const [key] of parsed.searchParams.entries()) {
    if (isSensitiveQueryKey(key)) return undefined;
  }
  parsed.hash = "";
  return parsed.toString();
}

/** Strips Bearer tokens, signed/CDN URLs, and inline signing params from persisted text. */
export function sanitizePersistedText(raw: unknown, maxChars = 240): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const scrubbed = trimmed
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
      isUnsafePersistedUrl(url) ? "[URL_REDACTED]" : url,
    )
    .replace(/\b([A-Za-z0-9_-]+)=([^\s&;,"']+)/gi, (m, k: string) =>
      isSensitiveQueryKey(k) ? `${k}=[REDACTED]` : m,
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!scrubbed) return undefined;
  return scrubbed.length > maxChars ? `${scrubbed.slice(0, maxChars - 1)}…` : scrubbed;
}

const sanitizeOptionalId = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t && t.length <= 128 && !/\s|https?:\/\//i.test(t) ? t : undefined;
};
const sanitizeFingerprint = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t || t.length > 512 || /\s/.test(t) || /\bBearer\b/i.test(t)) return undefined;
  const urlMatch = /https?:\/\//i.exec(t);
  if (urlMatch) {
    const prefix = t.slice(0, urlMatch.index);
    const rawUrl = t.slice(urlMatch.index);
    if (prefix && !/^[a-z0-9_-]+:$/i.test(prefix)) return undefined;
    const safeUrl = sanitizeCanonicalSourcePageUrl(rawUrl);
    if (!safeUrl) return undefined;
    const combined = `${prefix}${safeUrl}`;
    return combined.length <= 200 ? combined : undefined;
  }
  const kvRe = /\b([A-Za-z0-9_-]+)=([^\s&;,"']+)/gi;
  for (let m = kvRe.exec(t); m; m = kvRe.exec(t)) {
    if (isSensitiveQueryKey(m[1])) return undefined;
  }
  const lower = t.toLowerCase();
  for (const host of BLOCKED_CDN_EXACT_HOSTS) {
    if (lower.includes(host)) return undefined;
  }
  for (const suffix of BLOCKED_CDN_HOST_SUFFIXES) {
    if (lower.includes(suffix)) return undefined;
  }
  return t.length <= 200 ? t : t.slice(0, 200);
};
const sanitizePlatform = (raw: unknown): string =>
  typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 64) : "unknown";
const isQualityPref = (v: unknown): v is QualityPreference =>
  v === "best" || v === "1080p" || v === "audio";
const isBatchMode = (v: unknown): v is BatchSaveMode =>
  v === "subfolder" || v === "zip";
const isTerminalStatus = (v: unknown): v is PersistedTaskHistoryStatus =>
  typeof v === "string" && TERMINAL_HISTORY_STATUSES.has(v as PersistedTaskHistoryStatus);
const defaultStatusText = (s: PersistedTaskHistoryStatus): string =>
  s === "completed" ? "已完成" : s === "cancelled" ? "已取消" : "下载失败";
const positiveInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

/** Projects an in-memory task into a strictly sanitized `PersistedTaskHistoryRecord` (G6). */
export function projectTaskToPersistedHistoryRecord(
  task: ExtensionDownloadTask,
): PersistedTaskHistoryRecord {
  const isTerminal = isTerminalStatus(task.status);
  const status: PersistedTaskHistoryStatus = isTerminalStatus(task.status) ? task.status : "failed";
  const statusText = isTerminal
    ? sanitizePersistedText(task.statusText, 120) || defaultStatusText(status)
    : SW_INTERRUPTED_STATUS_TEXT;

  let rawUrl: string | undefined = task.sourcePageUrl;
  let itemId: string | undefined;
  let variantId: string | undefined;
  let qualityPreference: QualityPreference | undefined;
  let batchSaveMode: BatchSaveMode | undefined;
  let subfolderPrefix: string | undefined;

  if (task.retryPayload?.kind === "url") {
    rawUrl = task.retryPayload.url || rawUrl;
    itemId = sanitizeOptionalId(task.retryPayload.itemId);
    variantId = sanitizeOptionalId(task.retryPayload.variantId);
    if (isQualityPref(task.retryPayload.qualityPreference)) qualityPreference = task.retryPayload.qualityPreference;
    if (isBatchMode(task.retryPayload.batchSaveMode)) batchSaveMode = task.retryPayload.batchSaveMode;
    if (typeof task.retryPayload.subfolderPrefix === "string") {
      subfolderPrefix = sanitizeSubfolderPrefix(task.retryPayload.subfolderPrefix);
    }
  } else if (task.retryPayload?.kind === "spec") {
    const rc = task.retryPayload.spec.refreshContext;
    rawUrl = rc?.parseUrl?.trim() || extractParseUrlFromRefreshUrl(rc?.refreshUrl) || rawUrl;
    itemId = sanitizeOptionalId(rc?.itemId);
    variantId = sanitizeOptionalId(rc?.variantId);
  }

  const sourcePageUrl = sanitizeCanonicalSourcePageUrl(rawUrl);
  const total = positiveInt(task.total);
  const error = isTerminal ? sanitizePersistedText(task.error, 240) : undefined;
  const lastErrorCode = isTerminal ? sanitizeOptionalId(task.lastErrorCode) : undefined;
  const groupBatchId = sanitizeOptionalId(task.groupBatchId);
  const workFingerprint = sanitizeFingerprint(task.workFingerprint);

  return {
    taskId: task.taskId,
    title: sanitizePersistedText(task.title, 160) || "下载任务",
    platform: sanitizePlatform(task.platform),
    filename: sanitizePersistedText(task.filename, 200) || "download",
    status,
    statusText,
    ...(total !== undefined ? { total } : {}),
    ...(error ? { error } : {}),
    ...(lastErrorCode ? { lastErrorCode } : {}),
    createdAt: Number.isFinite(task.createdAt) ? task.createdAt : 0,
    updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : 0,
    ...(typeof task.chromeDownloadId === "number" && Number.isInteger(task.chromeDownloadId)
      ? { chromeDownloadId: task.chromeDownloadId }
      : {}),
    ...(groupBatchId ? { groupBatchId } : {}),
    ...(workFingerprint ? { workFingerprint } : {}),
    ...(sourcePageUrl ? { sourcePageUrl } : {}),
    ...(itemId ? { itemId } : {}),
    ...(variantId ? { variantId } : {}),
    ...(qualityPreference ? { qualityPreference } : {}),
    ...(batchSaveMode ? { batchSaveMode } : {}),
    ...(subfolderPrefix !== undefined ? { subfolderPrefix } : {}),
  };
}

/** Rehydrates a persisted record; non-terminal statuses normalize to `"failed"` with SW-wake prompt. */
export function hydratePersistedHistoryRecord(raw: unknown): ExtensionDownloadTask | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const taskId = sanitizeOptionalId(rec.taskId);
  if (!taskId) return null;

  const isTerminal = isTerminalStatus(rec.status);
  const status: PersistedTaskHistoryStatus = isTerminalStatus(rec.status) ? rec.status : "failed";
  const statusText = isTerminal
    ? sanitizePersistedText(rec.statusText, 120) || defaultStatusText(status)
    : SW_INTERRUPTED_STATUS_TEXT;
  const total = positiveInt(rec.total) ?? 0;
  const createdAt = typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt) ? rec.createdAt : 0;
  const updatedAt = typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : createdAt;
  const sourcePageUrl = sanitizeCanonicalSourcePageUrl(rec.sourcePageUrl);
  const itemId = sanitizeOptionalId(rec.itemId);
  const variantId = sanitizeOptionalId(rec.variantId);
  const qualityPreference = isQualityPref(rec.qualityPreference) ? rec.qualityPreference : undefined;
  const batchSaveMode = isBatchMode(rec.batchSaveMode) ? rec.batchSaveMode : undefined;
  const subfolderPrefix =
    typeof rec.subfolderPrefix === "string" ? sanitizeSubfolderPrefix(rec.subfolderPrefix) : undefined;
  const error = isTerminal ? sanitizePersistedText(rec.error, 240) : undefined;
  const lastErrorCode = isTerminal ? sanitizeOptionalId(rec.lastErrorCode) : undefined;
  const groupBatchId = sanitizeOptionalId(rec.groupBatchId);
  const workFingerprint = sanitizeFingerprint(rec.workFingerprint);

  return {
    taskId,
    ...(groupBatchId ? { groupBatchId } : {}),
    title: sanitizePersistedText(rec.title, 160) || "下载任务",
    filename: sanitizePersistedText(rec.filename, 200) || "download",
    platform: sanitizePlatform(rec.platform),
    ...(workFingerprint ? { workFingerprint } : {}),
    ...(sourcePageUrl ? { sourcePageUrl } : {}),
    persistedFromHistory: true,
    status,
    statusText,
    percent: status === "completed" ? 100 : 0,
    loaded: status === "completed" ? total : 0,
    total,
    speed: 0,
    ...(error ? { error } : {}),
    ...(lastErrorCode ? { lastErrorCode } : {}),
    ...(typeof rec.chromeDownloadId === "number" && Number.isInteger(rec.chromeDownloadId)
      ? { chromeDownloadId: rec.chromeDownloadId }
      : {}),
    createdAt,
    updatedAt,
    ...(sourcePageUrl
      ? {
          retryPayload: {
            kind: "url",
            url: sourcePageUrl,
            ...(itemId ? { itemId } : {}),
            ...(variantId ? { variantId } : {}),
            ...(qualityPreference ? { qualityPreference } : {}),
            ...(batchSaveMode ? { batchSaveMode } : {}),
            ...(subfolderPrefix !== undefined ? { subfolderPrefix } : {}),
          },
        }
      : {}),
  };
}

export interface TaskHistoryStoreDeps {
  chromeApi: ChromeBackgroundApi;
  storageArea?: StorageAreaLike;
  tasks: Map<string, ExtensionDownloadTask>;
  taskOrder: string[];
  isDisposed: () => boolean;
  debounceMs?: number;
}

export interface TaskHistoryStore {
  ensureHydrated(): Promise<ExtensionDownloadTask[]>;
  syncNow(): Promise<void>;
  scheduleSync(): void;
  clearFinished(): Promise<void>;
  dispose(): void;
}

export function createTaskHistoryStore(deps: TaskHistoryStoreDeps): TaskHistoryStore {
  const { chromeApi, tasks, taskOrder, isDisposed } = deps;
  const debounceMs = Math.max(0, deps.debounceMs ?? 120);
  let hydrated = false;
  let hydrationPromise: Promise<ExtensionDownloadTask[]> | null = null;
  let writeMutex: Promise<void> = Promise.resolve();
  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  const resolveStorageArea = (): StorageAreaLike | undefined =>
    deps.storageArea ??
    (chromeApi as ChromeBackgroundApi & { storage?: { local?: StorageAreaLike } })?.storage?.local ??
    (globalThis as unknown as { chrome?: { storage?: { local?: StorageAreaLike } } }).chrome?.storage?.local;

  const clearSyncTimer = (): void => {
    if (syncTimer !== null) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
  };

  const ensureHydrated = (): Promise<ExtensionDownloadTask[]> => {
    if (hydrated || isDisposed()) return Promise.resolve([]);
    if (hydrationPromise) return hydrationPromise;
    hydrationPromise = (async () => {
      const area = resolveStorageArea();
      if (!area) return [];
      try {
        const rawList = (await area.get(TASK_HISTORY_STORAGE_KEY))?.[TASK_HISTORY_STORAGE_KEY];
        if (!Array.isArray(rawList)) return [];
        const added: ExtensionDownloadTask[] = [];
        const seen = new Set<string>();
        for (const item of rawList) {
          if (added.length >= MAX_PERSISTED_TASK_HISTORY) break;
          const task = hydratePersistedHistoryRecord(item);
          if (!task || seen.has(task.taskId) || tasks.has(task.taskId)) continue;
          seen.add(task.taskId);
          tasks.set(task.taskId, task);
          if (!taskOrder.includes(task.taskId)) taskOrder.push(task.taskId);
          added.push(task);
        }
        return added;
      } catch {
        return [];
      } finally {
        hydrated = true;
        hydrationPromise = null;
      }
    })();
    return hydrationPromise;
  };

  const syncNow = (): Promise<void> => {
    clearSyncTimer();
    const run = async (): Promise<void> => {
      if (isDisposed()) return;
      const area = resolveStorageArea();
      if (!area) return;
      if (!hydrated) await ensureHydrated();
      const records: PersistedTaskHistoryRecord[] = [];
      const seen = new Set<string>();
      for (const id of taskOrder) {
        if (records.length >= MAX_PERSISTED_TASK_HISTORY) break;
        if (seen.has(id)) continue;
        const task = tasks.get(id);
        if (!task) continue;
        seen.add(id);
        records.push(projectTaskToPersistedHistoryRecord(task));
      }
      try {
        if (records.length === 0) await area.remove(TASK_HISTORY_STORAGE_KEY);
        else await area.set({ [TASK_HISTORY_STORAGE_KEY]: records });
      } catch {
        // Ignore storage quota or shutdown errors gracefully
      }
    };
    const next = writeMutex.then(run, run);
    writeMutex = next.then(() => undefined, () => undefined);
    return next;
  };

  return {
    ensureHydrated,
    syncNow,
    scheduleSync() {
      if (isDisposed() || !resolveStorageArea()) return;
      clearSyncTimer();
      syncTimer = setTimeout(() => {
        syncTimer = null;
        void syncNow();
      }, debounceMs);
      (syncTimer as { unref?: () => void })?.unref?.();
    },
    async clearFinished() {
      await ensureHydrated();
      await syncNow();
    },
    dispose: clearSyncTimer,
  };
}
