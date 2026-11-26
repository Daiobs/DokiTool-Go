import {
  EXTENSION_VERSION_PATH,
  EXTENSION_ZIP_PATH,
  isExtensionVersionOutdated,
  parseExtensionVersionPayload,
} from "../core/capabilityHub";
import { PROD_API_ORIGIN, isWhitelistedMediaUrl, validateApiBaseUrl } from "./hostWhitelist";

export { EXTENSION_VERSION_PATH, EXTENSION_ZIP_PATH };
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

export function resolveAllowedVersionCheckOrigin(rawApiBaseUrl?: string): string | null {
  const v = typeof rawApiBaseUrl === "string" && rawApiBaseUrl.trim()
    ? validateApiBaseUrl(rawApiBaseUrl)
    : null;
  const loopback = v?.ok && v.isLoopback ? v.origin : null;
  const origin = loopback ?? PROD_API_ORIGIN;
  return isWhitelistedMediaUrl(`${origin}${EXTENSION_VERSION_PATH}`, loopback ? [loopback] : undefined).allowed
    ? origin
    : null;
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
    const parsed = parseExtensionVersionPayload(await resp.json(), origin);
    if (!parsed || !isExtensionVersionOutdated(installed, parsed.version)) return null;
    return { latestVersion: parsed.version, downloadUrl: parsed.downloadUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
