import { isExtensionVersionOutdated } from "../core/capabilityHub";
import { PROD_API_ORIGIN, isWhitelistedMediaUrl, validateApiBaseUrl } from "./hostWhitelist";

export const EXTENSION_VERSION_PATH = "/helper/extension-version.json" as const;
export const EXTENSION_ZIP_PATH = "/helper/dokitool-chrome-extension.zip" as const;
export const VERSION_CHECK_TIMEOUT_MS = 3500 as const;

const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+$/;

export interface ExtensionUpdateInfo {
  latestVersion: string;
  downloadUrl: string;
}

export interface CheckExtensionUpdateOptions {
  installedVersion: string;
  apiBaseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function resolveAllowedVersionCheckOrigin(
  rawOrigin: string = PROD_API_ORIGIN,
): string | null {
  const validated = validateApiBaseUrl(rawOrigin);
  if (!validated.ok) return null;
  if (!validated.isLoopback && validated.origin !== PROD_API_ORIGIN) return null;
  const probeUrl = `${validated.origin}${EXTENSION_VERSION_PATH}`;
  const extra = validated.isLoopback ? [validated.origin] : undefined;
  return isWhitelistedMediaUrl(probeUrl, extra).allowed ? validated.origin : null;
}

function isValidSameOriginDownloadUrl(raw: unknown, origin: string): boolean {
  if (raw === undefined) return true;
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("@")) return false;
  try {
    const u = new URL(trimmed, origin);
    return (
      u.origin === origin &&
      u.pathname === EXTENSION_ZIP_PATH &&
      !u.search && !u.hash && !u.username && !u.password
    );
  } catch {
    return false;
  }
}

export async function checkForExtensionUpdate(
  options: CheckExtensionUpdateOptions,
): Promise<ExtensionUpdateInfo | null> {
  const installed = String(options.installedVersion || "").trim();
  if (!STRICT_SEMVER_RE.test(installed)) return null;
  const origin = resolveAllowedVersionCheckOrigin(options.apiBaseUrl);
  if (!origin) return null;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function" || options.signal?.aborted) return null;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? VERSION_CHECK_TIMEOUT_MS));
  try {
    const resp = await fetchFn(`${origin}${EXTENSION_VERSION_PATH}`, {
      method: "GET",
      credentials: "omit",
      cache: "no-cache",
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    if (resp.url) {
      const finalUrl = new URL(resp.url);
      if (finalUrl.origin !== origin || finalUrl.pathname !== EXTENSION_VERSION_PATH) return null;
    }
    const body = (await resp.json()) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const latest = typeof body.version === "string" ? body.version.trim() : "";
    if (!STRICT_SEMVER_RE.test(latest) || !isExtensionVersionOutdated(installed, latest)) return null;
    if (!isValidSameOriginDownloadUrl(body.download_url, origin)) return null;
    return { latestVersion: latest, downloadUrl: `${origin}${EXTENSION_ZIP_PATH}` };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
