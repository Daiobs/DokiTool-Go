import {
  EXTENSION_DNR_RULE_IDS,
  buildExtensionDnrRules,
  type ExtensionDnrRule,
} from "../dnrRules";
import { validateApiBaseUrl } from "../hostWhitelist";
import type { ExtensionSettings } from "../protocol";
import type { ExtensionStorageController } from "../storage";
import type { ChromeBackgroundApi } from "./types";

export interface DnrRulesManagerDeps {
  chromeApi: ChromeBackgroundApi;
  storage: ExtensionStorageController;
}

export interface DnrRulesManager {
  syncDynamicDnrRules(extraOrigins?: string[]): Promise<ExtensionDnrRule[]>;
  resolveExtraAllowedMediaOrigins(settings: ExtensionSettings): Promise<string[]>;
}

export function createDnrRulesManager(deps: DnrRulesManagerDeps): DnrRulesManager {
  const { chromeApi, storage } = deps;
  let dnrMutex: Promise<unknown> = Promise.resolve();

  const syncDynamicDnrRules = (
    extraOrigins?: string[],
  ): Promise<ExtensionDnrRule[]> => {
    const run = async (): Promise<ExtensionDnrRule[]> => {
      const extensionId = chromeApi.runtime.id || "dokitool-ext";
      const settings = await storage.getSettings();
      const originsSet = new Set<string>();
      const validated = validateApiBaseUrl(settings.apiBaseUrl);
      if (validated.ok && !validated.isLoopback) {
        originsSet.add(validated.origin);
      }
      for (const candidate of extraOrigins ?? []) {
        const extraValidated = validateApiBaseUrl(candidate);
        if (extraValidated.ok && !extraValidated.isLoopback) {
          originsSet.add(extraValidated.origin);
        }
      }
      const rules = buildExtensionDnrRules(extensionId, {
        extraApiOrigins: Array.from(originsSet),
      });

      if (chromeApi.declarativeNetRequest?.updateDynamicRules) {
        await chromeApi.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [...EXTENSION_DNR_RULE_IDS],
          addRules: rules,
        });
      }
      return rules;
    };

    const chained = dnrMutex.then(run, run);
    dnrMutex = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  };

  const resolveExtraAllowedMediaOrigins = async (
    settings: ExtensionSettings,
  ): Promise<string[]> => {
    const validated = validateApiBaseUrl(settings.apiBaseUrl);
    if (!validated.ok) {
      return [];
    }
    if (!validated.isLoopback) {
      return [validated.origin];
    }
    // For loopback settings, scope strictly to the configured single-port origin
    // (never widen to port-wildcard `http://127.0.0.1/*` / `http://localhost/*`).
    const hostPattern = `http://${new URL(validated.origin).hostname.toLowerCase()}/*`;
    const manifestHosts =
      chromeApi.runtime.getManifest?.()?.host_permissions ?? [];
    if (manifestHosts.includes(hostPattern)) {
      return [validated.origin];
    }
    if (!chromeApi.permissions?.contains) {
      return [validated.origin];
    }
    try {
      const granted = await chromeApi.permissions.contains({
        origins: [hostPattern],
      });
      return granted ? [validated.origin] : [];
    } catch {
      return [];
    }
  };

  return {
    syncDynamicDnrRules,
    resolveExtraAllowedMediaOrigins,
  };
}
