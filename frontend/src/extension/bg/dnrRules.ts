import {
  EXTENSION_DNR_RULE_IDS,
  buildExtensionDnrRules,
  type ExtensionDnrRule,
} from "../dnrRules";
import { LOOPBACK_HOST_PERMISSIONS, validateApiBaseUrl } from "../hostWhitelist";
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
    const allowed = new Set<string>();
    const validated = validateApiBaseUrl(settings.apiBaseUrl);
    if (validated.ok) {
      allowed.add(validated.origin);
    }

    const manifestHosts =
      chromeApi.runtime.getManifest?.()?.host_permissions ?? [];
    for (const pattern of LOOPBACK_HOST_PERMISSIONS) {
      if (manifestHosts.includes(pattern)) {
        allowed.add(pattern);
        continue;
      }
      if (chromeApi.permissions?.contains) {
        try {
          const granted = await chromeApi.permissions.contains({
            origins: [pattern],
          });
          if (granted) {
            allowed.add(pattern);
          }
        } catch {
          // Ignore permission check errors
        }
      }
    }
    return Array.from(allowed);
  };

  return {
    syncDynamicDnrRules,
    resolveExtraAllowedMediaOrigins,
  };
}
