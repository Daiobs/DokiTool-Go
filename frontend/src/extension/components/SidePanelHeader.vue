<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { PROD_API_ORIGIN } from "../hostWhitelist";
import type {
  ConnectionCheckResult,
  ExtensionSettings,
  ExtensionThemeMode,
} from "../protocol";
import { normalizeExtensionThemeMode } from "../storage";
import { openSafeHttpTab } from "../uiTargetHelpers";
import {
  checkForExtensionUpdate,
  resolveAllowedVersionCheckOrigin,
  type ExtensionUpdateInfo,
} from "../versionCheck";

export type PanelViewMode = "single" | "batch";

const VERSION_RECHECK_COOLDOWN_MS = 10 * 60_000;

const props = withDefaults(
  defineProps<{
    settings: ExtensionSettings;
    connection: ConnectionCheckResult | null;
    mode: PanelViewMode;
    batchUrlCount?: number;
    ownerConfirmed?: boolean;
    installedVersion?: string;
    fetchImpl?: typeof fetch;
    initialStateReady?: boolean;
  }>(),
  {
    initialStateReady: true,
  },
);

const emit = defineEmits<{
  (e: "update:mode", next: PanelViewMode): void;
  (e: "toggle-auto-follow"): void;
  (e: "cycle-theme"): void;
  (e: "open-settings"): void;
}>();

const updateInfo = ref<ExtensionUpdateInfo | null>(null);
let versionCheckController: AbortController | null = null;
let lastCheckedAt = 0;
let lastCheckedOrigin = "";

function resolveInstalledVersion(): string {
  if (props.installedVersion) return props.installedVersion.trim();
  const g = globalThis as unknown as {
    chrome?: { runtime?: { getManifest?: () => { version?: string } } };
  };
  return String(g.chrome?.runtime?.getManifest?.()?.version || "").trim();
}

function handleOpenUpdateDownload() {
  if (!updateInfo.value?.downloadUrl) return;
  openSafeHttpTab(updateInfo.value.downloadUrl);
}

function runVersionCheck(force = false) {
  if (!props.initialStateReady) return;
  const isExtTest = Boolean(
    (globalThis as unknown as { __DOKITOOL_EXT_TEST__?: boolean })
      .__DOKITOOL_EXT_TEST__,
  );
  if (isExtTest && !props.fetchImpl) return;
  const installedVersion = resolveInstalledVersion();
  if (!installedVersion) return;

  const rawApiBase = props.settings.apiBaseUrl || PROD_API_ORIGIN;
  const resolvedOrigin = resolveAllowedVersionCheckOrigin(rawApiBase) || "";
  const now = Date.now();
  if (
    !force &&
    lastCheckedAt > 0 &&
    resolvedOrigin === lastCheckedOrigin &&
    now - lastCheckedAt < VERSION_RECHECK_COOLDOWN_MS
  ) {
    return;
  }
  if (resolvedOrigin !== lastCheckedOrigin) {
    updateInfo.value = null;
  }
  lastCheckedAt = now;
  lastCheckedOrigin = resolvedOrigin;

  versionCheckController?.abort();
  const controller = new AbortController();
  versionCheckController = controller;
  void checkForExtensionUpdate({
    installedVersion,
    apiBaseUrl: rawApiBase,
    signal: controller.signal,
    fetchImpl: props.fetchImpl,
  }).then((result) => {
    if (!controller.signal.aborted) {
      updateInfo.value = result;
    }
  });
}

function handleVisibilityChange() {
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "visible"
  ) {
    runVersionCheck(false);
  }
}

watch(
  () => [props.initialStateReady, props.settings.apiBaseUrl] as const,
  ([ready], [prevReady, prevApi]) => {
    if (!ready) return;
    const originChanged =
      resolveAllowedVersionCheckOrigin(props.settings.apiBaseUrl || PROD_API_ORIGIN) !==
      resolveAllowedVersionCheckOrigin(prevApi || PROD_API_ORIGIN);
    if (!prevReady || originChanged) {
      runVersionCheck(true);
    }
  },
);

onMounted(() => {
  runVersionCheck(true);
  if (typeof document !== "undefined") {
    document.addEventListener?.("visibilitychange", handleVisibilityChange);
  }
});

onUnmounted(() => {
  if (typeof document !== "undefined") {
    document.removeEventListener?.("visibilitychange", handleVisibilityChange);
  }
  versionCheckController?.abort();
  versionCheckController = null;
});

const currentTheme = computed<ExtensionThemeMode>(() =>
  normalizeExtensionThemeMode(props.settings.theme),
);

const themeToggleMeta = computed<{
  title: string;
  ariaLabel: string;
}>(() => {
  if (currentTheme.value === "light") {
    return {
      title: "主题：浅色（点击切换为深色）",
      ariaLabel: "切换主题，当前浅色",
    };
  }
  if (currentTheme.value === "dark") {
    return {
      title: "主题：深色（点击切换为跟随系统）",
      ariaLabel: "切换主题，当前深色",
    };
  }
  return {
    title: "主题：跟随系统（点击切换为浅色）",
    ariaLabel: "切换主题，当前跟随系统",
  };
});

const authStatus = computed<{
  tone: "owner" | "ready" | "anon" | "error";
  label: string;
  title: string;
}>(() => {
  const hasToken = props.settings.bearerToken.trim().length > 0;
  if (props.connection && !props.connection.ok) {
    return {
      tone: "error",
      label: "未连通",
      title: `${props.connection.message}（点击打开设置检查后端或凭据）`,
    };
  }
  if (hasToken && props.ownerConfirmed) {
    const countSuffix = props.connection?.platformCount
      ? ` · 已加载 ${props.connection.platformCount} 平台`
      : "";
    return {
      tone: "owner",
      label: "Owner 已就绪",
      title: `管理员（Owner）凭据已验证${countSuffix}（点击管理设置）`,
    };
  }
  if (hasToken) {
    const countSuffix = props.connection?.platformCount
      ? ` · 已加载 ${props.connection.platformCount} 平台`
      : "";
    return {
      tone: "ready",
      label: "Bearer 已就绪",
      title: `专属 Bearer 凭据已配置${countSuffix}（点击管理设置）`,
    };
  }
  return {
    tone: "anon",
    label: "匿名模式",
    title: "当前为匿名模式，不发送 Authorization 头（点击配置专属 Bearer Token）",
  };
});
</script>

<template>
  <header class="sp-header">
    <div class="sp-header__top">
      <div class="sp-brand">
        <span class="sp-brand__logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
            <path
              d="M7.5 5.6C7.5 4.72 8.47 4.19 9.21 4.66L18.42 10.56C19.1 11 19.1 12 18.42 12.44L9.21 18.34C8.47 18.81 7.5 18.28 7.5 17.4V5.6Z"
              fill="currentColor"
            />
            <path
              d="M5 19.5H19"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </span>
        <span class="sp-brand__name">DokiTool</span>
      </div>

      <div class="sp-header__actions">
        <button
          type="button"
          class="sp-auth-pill"
          :class="`sp-auth-pill--${authStatus.tone}`"
          :title="authStatus.title"
          data-testid="header-auth-pill"
          @click="emit('open-settings')"
        >
          <span class="sp-auth-pill__dot" />
          <span class="sp-auth-pill__text">{{ authStatus.label }}</span>
        </button>

        <button
          type="button"
          class="sp-icon-btn sp-theme-btn"
          :title="themeToggleMeta.title"
          :aria-label="themeToggleMeta.ariaLabel"
          @click="emit('cycle-theme')"
        >
          <!-- Light mode: Sun -->
          <svg
            v-if="currentTheme === 'light'"
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="4" />
            <line x1="12" y1="2.5" x2="12" y2="4.5" />
            <line x1="12" y1="19.5" x2="12" y2="21.5" />
            <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
            <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
            <line x1="2.5" y1="12" x2="4.5" y2="12" />
            <line x1="19.5" y1="12" x2="21.5" y2="12" />
            <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
            <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
          </svg>
          <!-- Dark mode: Moon -->
          <svg
            v-else-if="currentTheme === 'dark'"
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          <!-- System mode: Monitor -->
          <svg
            v-else
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
            <line x1="8" y1="20.5" x2="16" y2="20.5" />
            <line x1="12" y1="16.5" x2="12" y2="20.5" />
          </svg>
        </button>

        <button
          type="button"
          class="sp-icon-btn"
          title="打开扩展设置与鉴权配置"
          aria-label="打开设置"
          @click="emit('open-settings')"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="updateInfo" class="sp-header__update">
      <button
        type="button"
        class="sp-update-pill"
        data-testid="sidepanel-update-pill"
        :title="`点击下载 DokiTool 扩展 v${updateInfo.latestVersion}（解压覆盖原目录并在 chrome://extensions 刷新即可保留历史与设置）`"
        @click="handleOpenUpdateDownload"
      >
        <span class="sp-update-pill__left">
          <span class="sp-update-pill__dot" aria-hidden="true" />
          <span class="sp-update-pill__text">新版本 v{{ updateInfo.latestVersion }}</span>
        </span>
        <span class="sp-update-pill__action">下载更新 ↗</span>
      </button>
    </div>

    <div class="sp-header__bar">
      <div class="sp-seg" role="tablist" aria-label="解析模式切换">
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'single'"
          class="sp-seg__btn"
          :class="{ 'sp-seg__btn--active': mode === 'single' }"
          @click="emit('update:mode', 'single')"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <span>单链</span>
        </button>

        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'batch'"
          class="sp-seg__btn"
          :class="{ 'sp-seg__btn--active': mode === 'batch' }"
          @click="emit('update:mode', 'batch')"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
          <span>批量</span>
          <span v-if="batchUrlCount && batchUrlCount > 0" class="sp-seg__count">
            {{ batchUrlCount }}
          </span>
        </button>
      </div>

      <button
        type="button"
        class="sp-follow-pill"
        :class="{ 'sp-follow-pill--on': settings.autoFollowTab }"
        :aria-pressed="settings.autoFollowTab"
        title="仅在本地匹配 16 个支持平台作品页时自动同步解析，无关网页零外发请求"
        @click="emit('toggle-auto-follow')"
      >
        <span class="sp-follow-pill__indicator" />
        <span>跟随标签页</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
.sp-header {
  flex-shrink: 0;
  background: var(--sp-bg-header);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--sp-border);
  box-shadow: var(--sp-shadow-header);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  z-index: 20;
}

.sp-header__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  flex-wrap: nowrap;
}

.sp-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex-shrink: 0;
}

.sp-brand__logo {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background-color: #4f46e5;
  background-image: linear-gradient(
    135deg,
    var(--sp-accent-start) 0%,
    var(--sp-accent-end) 100%
  );
  color: #ffffff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: var(--sp-logo-shadow);
}

.sp-brand__name {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--sp-text-primary);
  white-space: nowrap;
}

.sp-header__actions {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex-shrink: 1;
}

.sp-auth-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: var(--sp-radius-pill);
  border: 1px solid var(--sp-border);
  background: var(--sp-ghost-bg);
  color: var(--sp-text-secondary);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 150ms ease;
  min-width: 0;
}

.sp-auth-pill:hover {
  border-color: var(--sp-border-strong);
  background: var(--sp-ghost-bg-hover);
}

.sp-auth-pill__dot {
  width: 6.5px;
  height: 6.5px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--sp-dot-idle);
}

.sp-auth-pill--owner {
  background: var(--sp-accent-soft);
  border-color: var(--sp-accent-border);
  color: var(--sp-accent-text-strong);
}

.sp-auth-pill--owner .sp-auth-pill__dot {
  background: var(--sp-accent-solid);
  box-shadow: var(--sp-accent-dot-glow);
}

.sp-auth-pill--ready {
  background: var(--sp-success-soft);
  border-color: var(--sp-success-border);
  color: var(--sp-success-text);
}

.sp-auth-pill--ready .sp-auth-pill__dot {
  background: var(--sp-success);
  box-shadow: 0 0 6px var(--sp-success-glow);
}

.sp-auth-pill--error {
  background: var(--sp-danger-soft);
  border-color: var(--sp-danger-border);
  color: var(--sp-danger-text);
}

.sp-auth-pill--error .sp-auth-pill__dot {
  background: var(--sp-danger);
  box-shadow: 0 0 6px var(--sp-danger-glow);
}

.sp-auth-pill__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sp-icon-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--sp-radius-sm);
  border: 1px solid var(--sp-border);
  background: var(--sp-ghost-bg);
  color: var(--sp-text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  transition: all 150ms ease;
}

.sp-icon-btn:hover {
  color: var(--sp-text-primary);
  background: var(--sp-ghost-bg-hover);
  border-color: var(--sp-border-strong);
}

.sp-icon-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--sp-focus-ring);
}

.sp-header__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.sp-seg {
  display: inline-flex;
  align-items: center;
  background: var(--sp-seg-bg);
  border: 1px solid var(--sp-border);
  border-radius: var(--sp-radius-sm);
  padding: 2px;
  flex: 1;
  min-width: 0;
}

.sp-seg__btn {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--sp-text-muted);
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 150ms ease;
  white-space: nowrap;
}

.sp-seg__btn:hover {
  color: var(--sp-text-secondary);
}

.sp-seg__btn--active {
  background: var(--sp-seg-active-bg);
  color: var(--sp-text-primary);
  box-shadow: var(--sp-shadow-xs);
}

.sp-seg__count {
  padding: 0 5px;
  border-radius: 999px;
  background: var(--sp-accent-soft-strong);
  color: var(--sp-accent-text-strong);
  font-size: 10px;
  font-weight: 700;
}

.sp-follow-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  border-radius: var(--sp-radius-sm);
  border: 1px solid var(--sp-border);
  background: var(--sp-subtle-bg);
  color: var(--sp-text-muted);
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: all 150ms ease;
}

.sp-follow-pill:hover {
  border-color: var(--sp-border-strong);
  color: var(--sp-text-secondary);
}

.sp-follow-pill__indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--sp-dot-idle);
  transition: all 150ms ease;
}

.sp-follow-pill--on {
  background: var(--sp-accent-soft);
  border-color: var(--sp-border-accent);
  color: var(--sp-accent-text-strong);
}

.sp-follow-pill--on .sp-follow-pill__indicator {
  background: var(--sp-accent-solid);
  box-shadow: var(--sp-accent-dot-glow);
}

.sp-header__update {
  display: flex;
  min-width: 0;
}

.sp-update-pill {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 9px;
  border-radius: var(--sp-radius-pill);
  border: 1px solid var(--sp-warning-border);
  background: var(--sp-warning-soft);
  color: var(--sp-warning-text);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
  cursor: pointer;
  transition: filter 150ms ease, border-color 150ms ease;
}

.sp-update-pill:hover {
  filter: brightness(0.97);
  border-color: var(--sp-warning);
}

.sp-update-pill:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--sp-focus-ring);
}

.sp-update-pill__left {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.sp-update-pill__dot {
  width: 6.5px;
  height: 6.5px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--sp-warning);
}

.sp-update-pill__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sp-update-pill__action {
  flex-shrink: 0;
  opacity: 0.9;
}
</style>
