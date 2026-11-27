import { ref, type Ref } from "vue";
import {
  EXTENSION_VERSION_PATH,
  LATEST_EXTENSION_VERSION,
  parseExtensionVersionPayload,
  resolveEffectiveLatestExtensionVersion,
} from "../core/capabilityHub";
import type { ExtensionBridgeState } from "../services/extensionBridge";

export const MODAL_VERSION_CHECK_COOLDOWN_MS = 60_000 as const;
export const VISIBILITY_VERSION_CHECK_COOLDOWN_MS = 300_000 as const;
export const WEB_VERSION_CHECK_TIMEOUT_MS = 3500 as const;

export interface WebExtensionRuntimeState {
  connected: boolean;
  version: string;
  extensionId: string;
  capabilities: string[];
  useSaveFilePicker: boolean;
}

export function createEmptyExtensionRuntimeState(): WebExtensionRuntimeState {
  return {
    connected: false,
    version: "",
    extensionId: "",
    capabilities: [],
    useSaveFilePicker: false,
  };
}

export interface UseExtensionRuntimeOptions {
  fetchImpl?: typeof fetch;
  pingImpl?: () => Promise<ExtensionBridgeState>;
  now?: () => number;
  onStateChange?: (state: WebExtensionRuntimeState) => void;
}

export interface UseExtensionRuntimeReturn {
  extensionState: Ref<WebExtensionRuntimeState>;
  latestExtensionVersion: Ref<string>;
  probeExtension: () => Promise<WebExtensionRuntimeState>;
  refreshLatestExtensionVersion: (opts?: {
    force?: boolean;
    cooldownMs?: number;
  }) => Promise<string>;
  scheduleIdleVersionCheck: () => void;
  dispose: () => void;
}

/**
 * Single source of truth for Web SPA extension runtime state & live
 * `/helper/extension-version.json` version synchronization.
 *
 * - Zero `setInterval` polling.
 * - Coalesces concurrent `WEB_EXT_PING` probes and version checks via in-flight
 *   Promise locks (prevents double pings on rapid `visibilitychange` + `focus`).
 * - Monotonically raises `latestExtensionVersion` only when same-origin
 *   `/helper/extension-version.json` returns a strictly newer SemVer.
 */
export function useExtensionRuntime(
  options: UseExtensionRuntimeOptions = {},
): UseExtensionRuntimeReturn {
  const nowFn = options.now ?? (() => Date.now());
  const extensionState = ref<WebExtensionRuntimeState>(
    createEmptyExtensionRuntimeState(),
  );
  const latestExtensionVersion = ref<string>(LATEST_EXTENSION_VERSION);

  let disposed = false;
  let probeInFlight: Promise<WebExtensionRuntimeState> | null = null;
  let versionFetchInFlight: Promise<string> | null = null;
  let lastVersionCheckAt = 0;
  let versionAbortController: AbortController | null = null;
  let idleHandle: number | ReturnType<typeof setTimeout> | null = null;
  let idleUsesRic = false;

  const applyState = (next: Partial<WebExtensionRuntimeState> | null | undefined) => {
    const normalized: WebExtensionRuntimeState = {
      connected: Boolean(next?.connected),
      version: typeof next?.version === "string" ? next.version : "",
      extensionId: typeof next?.extensionId === "string" ? next.extensionId : "",
      capabilities: Array.isArray(next?.capabilities)
        ? [...next.capabilities]
        : [],
      useSaveFilePicker: Boolean(next?.connected && next?.useSaveFilePicker),
    };
    extensionState.value = normalized;
    options.onStateChange?.(normalized);
    return normalized;
  };

  const probeExtension = async (): Promise<WebExtensionRuntimeState> => {
    if (disposed) return extensionState.value;
    if (probeInFlight) return probeInFlight;

    probeInFlight = (async () => {
      try {
        const state = options.pingImpl
          ? await options.pingImpl()
          : await import("../services/extensionBridge").then(
              ({ pingInstalledExtension }) => pingInstalledExtension(),
            );
        if (disposed) return extensionState.value;
        return applyState(state);
      } catch {
        if (disposed) return extensionState.value;
        return applyState(createEmptyExtensionRuntimeState());
      } finally {
        probeInFlight = null;
      }
    })();

    return probeInFlight;
  };

  const refreshLatestExtensionVersion = async (opts?: {
    force?: boolean;
    cooldownMs?: number;
  }): Promise<string> => {
    if (disposed) return latestExtensionVersion.value;
    const fetchFn = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchFn !== "function") return latestExtensionVersion.value;

    const currentOrigin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "";
    if (!currentOrigin || !/^https?:\/\//i.test(currentOrigin)) {
      return latestExtensionVersion.value;
    }

    const cooldownMs = opts?.cooldownMs ?? MODAL_VERSION_CHECK_COOLDOWN_MS;
    const now = nowFn();
    if (
      !opts?.force &&
      lastVersionCheckAt > 0 &&
      now - lastVersionCheckAt < cooldownMs
    ) {
      return latestExtensionVersion.value;
    }
    if (versionFetchInFlight) return versionFetchInFlight;

    lastVersionCheckAt = now;
    versionFetchInFlight = (async () => {
      const controller = new AbortController();
      versionAbortController = controller;
      const timer = setTimeout(
        () => controller.abort(),
        WEB_VERSION_CHECK_TIMEOUT_MS,
      );
      try {
        const resp = await fetchFn(EXTENSION_VERSION_PATH, {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!resp.ok) return latestExtensionVersion.value;
        if (resp.url) {
          const finalUrl = new URL(resp.url, currentOrigin);
          if (
            finalUrl.origin !== currentOrigin ||
            finalUrl.pathname !== EXTENSION_VERSION_PATH
          ) {
            return latestExtensionVersion.value;
          }
        }
        const parsed = parseExtensionVersionPayload(
          await resp.json(),
          currentOrigin,
        );
        if (!disposed && parsed) {
          latestExtensionVersion.value = resolveEffectiveLatestExtensionVersion(
            latestExtensionVersion.value,
            parsed.version,
          );
        }
      } catch {
        // Silent fail-safe: retain compile-time LATEST_EXTENSION_VERSION
      } finally {
        clearTimeout(timer);
        if (versionAbortController === controller) {
          versionAbortController = null;
        }
        versionFetchInFlight = null;
      }
      return latestExtensionVersion.value;
    })();

    return versionFetchInFlight;
  };

  const scheduleIdleVersionCheck = () => {
    if (disposed || idleHandle !== null || typeof window === "undefined") return;
    const ric = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      }
    ).requestIdleCallback;
    if (typeof ric === "function") {
      idleUsesRic = true;
      idleHandle = ric(
        () => {
          idleHandle = null;
          void refreshLatestExtensionVersion({ cooldownMs: 0 });
        },
        { timeout: 3000 },
      );
      return;
    }
    idleUsesRic = false;
    idleHandle = setTimeout(() => {
      idleHandle = null;
      void refreshLatestExtensionVersion({ cooldownMs: 0 });
    }, 1500);
  };

  const dispose = () => {
    disposed = true;
    versionAbortController?.abort();
    versionAbortController = null;
    if (idleHandle !== null) {
      if (idleUsesRic && typeof window !== "undefined") {
        const cic = (
          window as unknown as { cancelIdleCallback?: (id: number) => void }
        ).cancelIdleCallback;
        cic?.(idleHandle as number);
      } else {
        clearTimeout(idleHandle as ReturnType<typeof setTimeout>);
      }
      idleHandle = null;
    }
  };

  return {
    extensionState,
    latestExtensionVersion,
    probeExtension,
    refreshLatestExtensionVersion,
    scheduleIdleVersionCheck,
    dispose,
  };
}
