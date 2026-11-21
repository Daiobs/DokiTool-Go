import { PROD_API_ORIGIN, validateApiBaseUrl } from "./hostWhitelist";
import { sanitizeSubfolderPrefix } from "./filenameSanitizer";

export type BatchSaveMode = "subfolder" | "zip";
export type QualityPreference = "best" | "1080p" | "audio";
export type PanelIntentMode = "inspect" | "quick-download";

export interface ExtensionSettings {
  apiBaseUrl: string;
  bearerToken: string;
  subfolderPrefix: string;
  batchSaveMode: BatchSaveMode;
  qualityPreference: QualityPreference;
  autoFollowTab: boolean;
}

export type ExtensionSettingsPatch = Partial<ExtensionSettings>;

export interface SavedWorkRecord {
  fingerprint: string;
  platform: string;
  title?: string;
  filename?: string;
  savedAt: number;
}

export interface PendingPanelIntent {
  intentId: string;
  url: string;
  mode: PanelIntentMode;
  createdAt: number;
}

export const DEFAULT_EXTENSION_SETTINGS: Readonly<ExtensionSettings> =
  Object.freeze({
    apiBaseUrl: PROD_API_ORIGIN,
    bearerToken: "",
    subfolderPrefix: "",
    batchSaveMode: "subfolder",
    qualityPreference: "best",
    autoFollowTab: false,
  });

export const SAVED_WORK_LRU_LIMIT = 200 as const;

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: "dokitool_ext_settings_v1",
  SAVED_WORKS: "dokitool_ext_saved_works_v1",
  PENDING_INTENT: "dokitool_ext_pending_intent_v1",
});

export interface StorageAreaLike {
  get(
    keys?: string | string[] | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear?(): Promise<void>;
}

interface StoredSettingsInternal extends ExtensionSettings {
  autoFollowExplicitlySet?: boolean;
}

export function createMemoryStorageArea(): StorageAreaLike & {
  dump(): Record<string, unknown>;
} {
  const store = new Map<string, unknown>();
  const clone = <T>(val: T): T =>
    val === undefined ? val : (structuredClone(val) as T);

  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of store.entries()) {
          out[k] = clone(v);
        }
        return out;
      }
      if (typeof keys === "string") {
        if (store.has(keys)) {
          out[keys] = clone(store.get(keys));
        }
        return out;
      }
      if (Array.isArray(keys)) {
        for (const k of keys) {
          if (store.has(k)) {
            out[k] = clone(store.get(k));
          }
        }
        return out;
      }
      for (const [k, fallbackVal] of Object.entries(keys)) {
        out[k] = store.has(k) ? clone(store.get(k)) : clone(fallbackVal);
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        if (v === undefined) {
          store.delete(k);
        } else {
          store.set(k, clone(v));
        }
      }
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        store.delete(k);
      }
    },
    async clear() {
      store.clear();
    },
    dump() {
      const out: Record<string, unknown> = {};
      for (const [k, v] of store.entries()) {
        out[k] = clone(v);
      }
      return out;
    },
  };
}

let fallbackLocalArea = createMemoryStorageArea();
let fallbackSessionArea = createMemoryStorageArea();

export function resetInMemoryExtensionStorage(): void {
  fallbackLocalArea = createMemoryStorageArea();
  fallbackSessionArea = createMemoryStorageArea();
}

function getRuntimeChromeStorage(): {
  local?: StorageAreaLike;
  session?: StorageAreaLike;
} {
  const g = globalThis as unknown as {
    chrome?: {
      storage?: {
        local?: StorageAreaLike;
        session?: StorageAreaLike;
      };
    };
  };
  return {
    local: g.chrome?.storage?.local,
    session: g.chrome?.storage?.session,
  };
}

function isBatchSaveMode(value: unknown): value is BatchSaveMode {
  return value === "subfolder" || value === "zip";
}

function isQualityPreference(value: unknown): value is QualityPreference {
  return value === "best" || value === "1080p" || value === "audio";
}

function isPanelIntentMode(value: unknown): value is PanelIntentMode {
  return value === "inspect" || value === "quick-download";
}

function normalizeStoredSettings(raw: unknown): StoredSettingsInternal {
  const obj =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};

  const rawBaseUrl =
    typeof obj.apiBaseUrl === "string" ? obj.apiBaseUrl : PROD_API_ORIGIN;
  const validatedUrl = validateApiBaseUrl(rawBaseUrl);
  const apiBaseUrl = validatedUrl.ok ? validatedUrl.origin : PROD_API_ORIGIN;

  const bearerToken =
    typeof obj.bearerToken === "string" ? obj.bearerToken.trim() : "";

  const subfolderPrefix =
    typeof obj.subfolderPrefix === "string"
      ? sanitizeSubfolderPrefix(obj.subfolderPrefix)
      : "";

  const batchSaveMode: BatchSaveMode = isBatchSaveMode(obj.batchSaveMode)
    ? obj.batchSaveMode
    : "subfolder";

  const qualityPreference: QualityPreference = isQualityPreference(
    obj.qualityPreference,
  )
    ? obj.qualityPreference
    : "best";

  const autoFollowExplicitlySet = obj.autoFollowExplicitlySet === true;
  let autoFollowTab: boolean;
  if (typeof obj.autoFollowTab === "boolean" && autoFollowExplicitlySet) {
    autoFollowTab = obj.autoFollowTab;
  } else if (bearerToken.length > 0) {
    autoFollowTab =
      typeof obj.autoFollowTab === "boolean" ? obj.autoFollowTab : true;
  } else {
    autoFollowTab = false;
  }

  return {
    apiBaseUrl,
    bearerToken,
    subfolderPrefix,
    batchSaveMode,
    qualityPreference,
    autoFollowTab,
    autoFollowExplicitlySet,
  };
}

function toPublicSettings(internal: StoredSettingsInternal): ExtensionSettings {
  return {
    apiBaseUrl: internal.apiBaseUrl,
    bearerToken: internal.bearerToken,
    subfolderPrefix: internal.subfolderPrefix,
    batchSaveMode: internal.batchSaveMode,
    qualityPreference: internal.qualityPreference,
    autoFollowTab: internal.autoFollowTab,
  };
}

/**
 * Builds request headers for DokiTool API calls.
 * Strictly omits `Authorization` in anonymous mode (`bearerToken` empty) and
 * never leaks credentials when blank.
 */
export function buildApiAuthHeaders(
  settings: Pick<ExtensionSettings, "bearerToken">,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  const token =
    typeof settings.bearerToken === "string" ? settings.bearerToken.trim() : "";
  if (token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    delete headers.Authorization;
    delete headers.authorization;
  }
  return headers;
}

/**
 * Builds a deterministic work deduplication fingerprint (`${platform}:${content_id || source_url}`).
 */
export function buildWorkFingerprint(media: {
  platform: string;
  content_id?: string;
  source_url?: string;
}): string {
  if (!media || typeof media !== "object") return "";
  const platform =
    typeof media.platform === "string"
      ? media.platform.trim().toLowerCase()
      : "";
  const idOrUrl =
    (typeof media.content_id === "string" && media.content_id.trim()) ||
    (typeof media.source_url === "string" && media.source_url.trim()) ||
    "";
  if (!platform || !idOrUrl) return "";
  return `${platform}:${idOrUrl}`;
}

function normalizeSavedWorkList(raw: unknown): SavedWorkRecord[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SavedWorkRecord[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const fingerprint =
      typeof rec.fingerprint === "string" ? rec.fingerprint.trim() : "";
    const platform =
      typeof rec.platform === "string"
        ? rec.platform.trim().toLowerCase()
        : "";
    const savedAt =
      typeof rec.savedAt === "number" && Number.isFinite(rec.savedAt)
        ? rec.savedAt
        : 0;
    if (!fingerprint || !platform || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push({
      fingerprint,
      platform,
      ...(typeof rec.title === "string" && rec.title
        ? { title: rec.title }
        : {}),
      ...(typeof rec.filename === "string" && rec.filename
        ? { filename: rec.filename }
        : {}),
      savedAt,
    });
    if (out.length >= SAVED_WORK_LRU_LIMIT) break;
  }
  return out;
}

function normalizePendingIntent(raw: unknown): PendingPanelIntent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const intentId =
    typeof obj.intentId === "string" ? obj.intentId.trim() : "";
  const url = typeof obj.url === "string" ? obj.url.trim() : "";
  const mode = obj.mode;
  const createdAt =
    typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt)
      ? obj.createdAt
      : 0;
  if (!intentId || !url || !isPanelIntentMode(mode)) {
    return null;
  }
  return { intentId, url, mode, createdAt };
}

export interface CreateExtensionStorageOptions {
  local?: StorageAreaLike;
  session?: StorageAreaLike;
  now?: () => number;
}

export interface ExtensionStorageController {
  getSettings(): Promise<ExtensionSettings>;
  updateSettings(patch: ExtensionSettingsPatch): Promise<ExtensionSettings>;
  getSavedWorks(): Promise<SavedWorkRecord[]>;
  isWorkSaved(fingerprint: string): Promise<boolean>;
  recordSavedWork(input: {
    fingerprint: string;
    platform: string;
    title?: string;
    filename?: string;
    savedAt?: number;
  }): Promise<SavedWorkRecord[]>;
  clearSavedWorks(): Promise<void>;
  setPendingIntent(intent: PendingPanelIntent): Promise<PendingPanelIntent>;
  getPendingIntent(): Promise<PendingPanelIntent | null>;
  consumePendingIntent(intentId?: string): Promise<PendingPanelIntent | null>;
}

export function createExtensionStorage(
  options?: CreateExtensionStorageOptions,
): ExtensionStorageController {
  const resolveLocal = (): StorageAreaLike =>
    options?.local ?? getRuntimeChromeStorage().local ?? fallbackLocalArea;
  const resolveSession = (): StorageAreaLike =>
    options?.session ??
    getRuntimeChromeStorage().session ??
    fallbackSessionArea;
  const nowFn = options?.now ?? (() => Date.now());

  // Serialize mutations within the same JS context to prevent read-modify-write races
  let settingsMutex: Promise<unknown> = Promise.resolve();
  let savedWorksMutex: Promise<unknown> = Promise.resolve();
  let intentMutex: Promise<unknown> = Promise.resolve();

  const withLock = <T>(
    getChain: () => Promise<unknown>,
    setChain: (p: Promise<unknown>) => void,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const next = getChain().then(fn, fn);
    setChain(next.then(() => undefined, () => undefined));
    return next;
  };

  return {
    async getSettings(): Promise<ExtensionSettings> {
      const local = resolveLocal();
      const rawMap = await local.get(STORAGE_KEYS.SETTINGS);
      return toPublicSettings(
        normalizeStoredSettings(rawMap[STORAGE_KEYS.SETTINGS]),
      );
    },

    updateSettings(patch: ExtensionSettingsPatch): Promise<ExtensionSettings> {
      return withLock(
        () => settingsMutex,
        (p) => {
          settingsMutex = p;
        },
        async () => {
          const local = resolveLocal();
          const rawMap = await local.get(STORAGE_KEYS.SETTINGS);
          const current = normalizeStoredSettings(
            rawMap[STORAGE_KEYS.SETTINGS],
          );

          let nextApiBaseUrl = current.apiBaseUrl;
          if (patch.apiBaseUrl !== undefined) {
            const check = validateApiBaseUrl(patch.apiBaseUrl);
            if (!check.ok) {
              throw new Error(check.error || "后端地址无效");
            }
            nextApiBaseUrl = check.origin;
          }

          const nextToken =
            patch.bearerToken !== undefined
              ? patch.bearerToken.trim()
              : current.bearerToken;

          const nextPrefix =
            patch.subfolderPrefix !== undefined
              ? sanitizeSubfolderPrefix(patch.subfolderPrefix)
              : current.subfolderPrefix;

          const nextBatchMode: BatchSaveMode =
            patch.batchSaveMode !== undefined
              ? isBatchSaveMode(patch.batchSaveMode)
                ? patch.batchSaveMode
                : current.batchSaveMode
              : current.batchSaveMode;

          const nextQuality: QualityPreference =
            patch.qualityPreference !== undefined
              ? isQualityPreference(patch.qualityPreference)
                ? patch.qualityPreference
                : current.qualityPreference
              : current.qualityPreference;

          let nextAutoFollow = current.autoFollowTab;
          let nextExplicit = current.autoFollowExplicitlySet === true;

          if (typeof patch.autoFollowTab === "boolean") {
            nextAutoFollow = patch.autoFollowTab;
            nextExplicit = true;
          } else if (patch.bearerToken !== undefined) {
            if (nextToken.length === 0) {
              // Returning to anonymous mode resets auto-follow to false to protect 0.2 RPS
              nextAutoFollow = false;
              nextExplicit = false;
            } else if (!nextExplicit) {
              // Saving a non-empty token enables auto-follow by default unless user explicitly toggled it
              nextAutoFollow = true;
            }
          }

          const updated: StoredSettingsInternal = {
            apiBaseUrl: nextApiBaseUrl,
            bearerToken: nextToken,
            subfolderPrefix: nextPrefix,
            batchSaveMode: nextBatchMode,
            qualityPreference: nextQuality,
            autoFollowTab: nextAutoFollow,
            autoFollowExplicitlySet: nextExplicit,
          };

          await local.set({ [STORAGE_KEYS.SETTINGS]: updated });
          return toPublicSettings(updated);
        },
      );
    },

    async getSavedWorks(): Promise<SavedWorkRecord[]> {
      const local = resolveLocal();
      const rawMap = await local.get(STORAGE_KEYS.SAVED_WORKS);
      return normalizeSavedWorkList(rawMap[STORAGE_KEYS.SAVED_WORKS]);
    },

    async isWorkSaved(fingerprint: string): Promise<boolean> {
      const clean = typeof fingerprint === "string" ? fingerprint.trim() : "";
      if (!clean) return false;
      const list = await this.getSavedWorks();
      return list.some((entry) => entry.fingerprint === clean);
    },

    recordSavedWork(input): Promise<SavedWorkRecord[]> {
      return withLock(
        () => savedWorksMutex,
        (p) => {
          savedWorksMutex = p;
        },
        async () => {
          const fingerprint =
            typeof input.fingerprint === "string"
              ? input.fingerprint.trim()
              : "";
          const platform =
            typeof input.platform === "string"
              ? input.platform.trim().toLowerCase()
              : "";
          const local = resolveLocal();
          const rawMap = await local.get(STORAGE_KEYS.SAVED_WORKS);
          const current = normalizeSavedWorkList(
            rawMap[STORAGE_KEYS.SAVED_WORKS],
          );
          if (!fingerprint || !platform) {
            return current;
          }

          const entry: SavedWorkRecord = {
            fingerprint,
            platform,
            ...(typeof input.title === "string" && input.title.trim()
              ? { title: input.title.trim() }
              : {}),
            ...(typeof input.filename === "string" && input.filename.trim()
              ? { filename: input.filename.trim() }
              : {}),
            savedAt:
              typeof input.savedAt === "number" &&
              Number.isFinite(input.savedAt)
                ? input.savedAt
                : nowFn(),
          };

          const filtered = current.filter(
            (item) => item.fingerprint !== fingerprint,
          );
          const next = [entry, ...filtered].slice(0, SAVED_WORK_LRU_LIMIT);
          await local.set({ [STORAGE_KEYS.SAVED_WORKS]: next });
          return next;
        },
      );
    },

    clearSavedWorks(): Promise<void> {
      return withLock(
        () => savedWorksMutex,
        (p) => {
          savedWorksMutex = p;
        },
        async () => {
          const local = resolveLocal();
          await local.remove(STORAGE_KEYS.SAVED_WORKS);
        },
      );
    },

    setPendingIntent(intent: PendingPanelIntent): Promise<PendingPanelIntent> {
      return withLock(
        () => intentMutex,
        (p) => {
          intentMutex = p;
        },
        async () => {
          const normalized = normalizePendingIntent({
            ...intent,
            createdAt:
              typeof intent.createdAt === "number" &&
              Number.isFinite(intent.createdAt)
                ? intent.createdAt
                : nowFn(),
          });
          if (!normalized) {
            throw new Error("Invalid PendingPanelIntent");
          }
          const session = resolveSession();
          await session.set({ [STORAGE_KEYS.PENDING_INTENT]: normalized });
          return normalized;
        },
      );
    },

    async getPendingIntent(): Promise<PendingPanelIntent | null> {
      const session = resolveSession();
      const rawMap = await session.get(STORAGE_KEYS.PENDING_INTENT);
      return normalizePendingIntent(rawMap[STORAGE_KEYS.PENDING_INTENT]);
    },

    consumePendingIntent(
      intentId?: string,
    ): Promise<PendingPanelIntent | null> {
      return withLock(
        () => intentMutex,
        (p) => {
          intentMutex = p;
        },
        async () => {
          const session = resolveSession();
          const rawMap = await session.get(STORAGE_KEYS.PENDING_INTENT);
          const current = normalizePendingIntent(
            rawMap[STORAGE_KEYS.PENDING_INTENT],
          );
          if (!current) {
            return null;
          }
          if (
            intentId !== undefined &&
            intentId.trim() !== "" &&
            current.intentId !== intentId
          ) {
            return null;
          }
          await session.remove(STORAGE_KEYS.PENDING_INTENT);
          return current;
        },
      );
    },
  };
}

const defaultStorage = createExtensionStorage();

export const getSettings = (): Promise<ExtensionSettings> =>
  defaultStorage.getSettings();

export const updateSettings = (
  patch: ExtensionSettingsPatch,
): Promise<ExtensionSettings> => defaultStorage.updateSettings(patch);

export const getSavedWorks = (): Promise<SavedWorkRecord[]> =>
  defaultStorage.getSavedWorks();

export const isWorkSaved = (fingerprint: string): Promise<boolean> =>
  defaultStorage.isWorkSaved(fingerprint);

export const recordSavedWork = (input: {
  fingerprint: string;
  platform: string;
  title?: string;
  filename?: string;
  savedAt?: number;
}): Promise<SavedWorkRecord[]> => defaultStorage.recordSavedWork(input);

export const clearSavedWorks = (): Promise<void> =>
  defaultStorage.clearSavedWorks();

export const setPendingIntent = (
  intent: PendingPanelIntent,
): Promise<PendingPanelIntent> => defaultStorage.setPendingIntent(intent);

export const getPendingIntent = (): Promise<PendingPanelIntent | null> =>
  defaultStorage.getPendingIntent();

export const consumePendingIntent = (
  intentId?: string,
): Promise<PendingPanelIntent | null> =>
  defaultStorage.consumePendingIntent(intentId);
