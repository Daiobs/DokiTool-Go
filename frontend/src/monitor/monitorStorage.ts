import { isValidStatsSnapshot, type StatsSnapshot } from "./statsTypes";

// ============================================================================
// Constants & Types
// ============================================================================

export type MonitorThemeMode = "system" | "light" | "dark";
export type OwnerTokenSource = "session" | "local" | null;

export const MONITOR_THEME_STORAGE_KEY = "dokitool_monitor_theme";
export const OWNER_TOKEN_SESSION_KEY = "dokitool_monitor_owner_token_session";
export const OWNER_TOKEN_LOCAL_KEY = "dokitool_monitor_owner_token_local";

export const SAME_ORIGIN_STATS_URL = "/api/stats?schema_version=1.0";
export const MONITOR_UNAUTHORIZED_MESSAGE =
  "HTTP 401：当前凭据无效或非 owner 角色（/api/stats 仅对 owner 开放）";

export interface StoredOwnerToken {
  token: string;
  source: OwnerTokenSource;
}

export type OwnerTokenValidationResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

export type FetchSameOriginOwnerStatsResult =
  | { ok: true; stats: StatsSnapshot; fetchedAt: number }
  | {
      ok: false;
      kind: "unauthorized" | "error";
      status: number;
      message: string;
    };

// ============================================================================
// Storage Access Helpers (Safe under Private / Restricted Browsing)
// ============================================================================

function safeStorageGet(storage: Storage | undefined, key: string): string {
  if (!storage) return "";
  try {
    const val = storage.getItem(key);
    return typeof val === "string" ? val : "";
  } catch {
    return "";
  }
}

function safeStorageSet(
  storage: Storage | undefined,
  key: string,
  value: string,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeStorageRemove(storage: Storage | undefined, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage quota/security errors
  }
}

function getLocalStorage(): Storage | undefined {
  try {
    return typeof globalThis.localStorage !== "undefined"
      ? globalThis.localStorage
      : undefined;
  } catch {
    return undefined;
  }
}

function getSessionStorage(): Storage | undefined {
  try {
    return typeof globalThis.sessionStorage !== "undefined"
      ? globalThis.sessionStorage
      : undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Theme Persistence & DOM Sync
// ============================================================================

export function normalizeMonitorTheme(value: unknown): MonitorThemeMode {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return "system";
}

export function readMonitorTheme(): MonitorThemeMode {
  return normalizeMonitorTheme(
    safeStorageGet(getLocalStorage(), MONITOR_THEME_STORAGE_KEY),
  );
}

export function writeMonitorTheme(mode: MonitorThemeMode): void {
  safeStorageSet(
    getLocalStorage(),
    MONITOR_THEME_STORAGE_KEY,
    normalizeMonitorTheme(mode),
  );
}

export function applyMonitorTheme(mode: MonitorThemeMode): void {
  if (typeof document === "undefined" || !document.documentElement) return;
  const root = document.documentElement;
  const normalized = normalizeMonitorTheme(mode);
  if (normalized === "light" || normalized === "dark") {
    if (typeof root.setAttribute === "function") {
      root.setAttribute("data-theme", normalized);
    }
    if (root.dataset) {
      root.dataset.theme = normalized;
    }
  } else {
    if (typeof root.removeAttribute === "function") {
      root.removeAttribute("data-theme");
    }
    if (root.dataset) {
      delete root.dataset.theme;
    }
  }
}

export function getNextMonitorTheme(mode: MonitorThemeMode): MonitorThemeMode {
  const normalized = normalizeMonitorTheme(mode);
  if (normalized === "system") return "light";
  if (normalized === "light") return "dark";
  return "system";
}

// ============================================================================
// Dual-Tier Owner Token Storage (sessionStorage default > localStorage opt-in)
// ============================================================================

export function readStoredOwnerToken(): StoredOwnerToken {
  const sessionToken = safeStorageGet(
    getSessionStorage(),
    OWNER_TOKEN_SESSION_KEY,
  ).trim();
  if (sessionToken) {
    return { token: sessionToken, source: "session" };
  }

  const localToken = safeStorageGet(
    getLocalStorage(),
    OWNER_TOKEN_LOCAL_KEY,
  ).trim();
  if (localToken) {
    return { token: localToken, source: "local" };
  }

  return { token: "", source: null };
}

export function saveOwnerToken(
  token: string,
  remember: boolean,
): "session" | "local" {
  const normalized = token.trim();
  if (remember) {
    safeStorageSet(getLocalStorage(), OWNER_TOKEN_LOCAL_KEY, normalized);
    safeStorageRemove(getSessionStorage(), OWNER_TOKEN_SESSION_KEY);
    return "local";
  }
  safeStorageSet(getSessionStorage(), OWNER_TOKEN_SESSION_KEY, normalized);
  safeStorageRemove(getLocalStorage(), OWNER_TOKEN_LOCAL_KEY);
  return "session";
}

export function clearStoredOwnerToken(): void {
  safeStorageRemove(getSessionStorage(), OWNER_TOKEN_SESSION_KEY);
  safeStorageRemove(getLocalStorage(), OWNER_TOKEN_LOCAL_KEY);
}

// ============================================================================
// URL Hygiene & Owner Bearer Token Validation
// ============================================================================

export function stripUrlQueryAndHash(): boolean {
  if (typeof window === "undefined" || !window.location) return false;
  if (!window.location.search && !window.location.hash) return false;
  try {
    const cleanPath = window.location.pathname || "/";
    window.history?.replaceState?.(null, "", cleanPath);
    return true;
  } catch {
    return false;
  }
}

export function validateOwnerBearerToken(
  raw: string,
): OwnerTokenValidationResult {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token) {
    return {
      ok: false,
      error: "请输入管理员（owner）Bearer Token",
    };
  }
  if (token.length < 32 || token.length > 512) {
    return {
      ok: false,
      error: "Owner Bearer Token 长度须为 32～512 个可见 ASCII 字符",
    };
  }
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (code < 33 || code > 126) {
      return {
        ok: false,
        error: "Owner Bearer Token 仅允许可见非空白 ASCII 字符（禁止空格、换行或控制字符）",
      };
    }
  }
  return { ok: true, token };
}

// ============================================================================
// Same-Origin Cookie-Free Read-Only `/api/stats` Client
// ============================================================================

export async function fetchSameOriginOwnerStats(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<FetchSameOriginOwnerStatsResult> {
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      kind: "error",
      status: 0,
      message: "当前运行环境不支持 fetch 请求",
    };
  }

  try {
    const resp = await fetchImpl(SAME_ORIGIN_STATS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
        Accept: "application/json",
      },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });

    const payload = await resp.json().catch(() => null);

    if (
      resp.status === 200 &&
      payload &&
      typeof payload === "object" &&
      (payload as { code?: unknown }).code === "OK" &&
      isValidStatsSnapshot((payload as { data?: unknown }).data)
    ) {
      return {
        ok: true,
        stats: (payload as { data: StatsSnapshot }).data,
        fetchedAt: Date.now(),
      };
    }

    if (resp.status === 401) {
      return {
        ok: false,
        kind: "unauthorized",
        status: 401,
        message: MONITOR_UNAUTHORIZED_MESSAGE,
      };
    }

    if (resp.status === 200) {
      return {
        ok: false,
        kind: "error",
        status: 200,
        message: "监控快照响应结构异常，请检查服务端版本",
      };
    }

    return {
      ok: false,
      kind: "error",
      status: resp.status,
      message: `监控接口请求失败（HTTP ${resp.status}）`,
    };
  } catch (err) {
    return {
      ok: false,
      kind: "error",
      status: 0,
      message:
        err instanceof Error && err.message
          ? err.message
          : "无法连接监控接口，请检查网络或服务状态",
    };
  }
}
