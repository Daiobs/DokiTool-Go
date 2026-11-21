<script setup lang="ts">
import { computed } from "vue";
import type {
  ConnectionCheckResult,
  ExtensionSettings,
} from "../protocol";

export type PanelViewMode = "single" | "batch";

const props = defineProps<{
  settings: ExtensionSettings;
  connection: ConnectionCheckResult | null;
  mode: PanelViewMode;
  batchUrlCount?: number;
}>();

const emit = defineEmits<{
  (e: "update:mode", next: PanelViewMode): void;
  (e: "toggle-auto-follow"): void;
  (e: "open-settings"): void;
}>();

const authStatus = computed<{
  tone: "ready" | "anon" | "error";
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
          @click="emit('open-settings')"
        >
          <span class="sp-auth-pill__dot" />
          <span class="sp-auth-pill__text">{{ authStatus.label }}</span>
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
        title="仅在本地匹配 14 个支持平台作品页时自动同步解析，无关网页零外发请求"
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
  background: rgba(17, 25, 44, 0.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--sp-border);
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
  gap: 8px;
  min-width: 0;
}

.sp-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.sp-brand__logo {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  color: #ffffff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 3px 10px rgba(99, 102, 241, 0.4);
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
  gap: 6px;
  min-width: 0;
}

.sp-auth-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: var(--sp-radius-pill);
  border: 1px solid var(--sp-border);
  background: rgba(148, 163, 184, 0.08);
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
  background: rgba(148, 163, 184, 0.14);
}

.sp-auth-pill__dot {
  width: 6.5px;
  height: 6.5px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #94a3b8;
}

.sp-auth-pill--ready {
  background: rgba(16, 185, 129, 0.12);
  border-color: rgba(16, 185, 129, 0.28);
  color: #6ee7b7;
}

.sp-auth-pill--ready .sp-auth-pill__dot {
  background: #10b981;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.7);
}

.sp-auth-pill--error {
  background: rgba(239, 68, 68, 0.14);
  border-color: rgba(239, 68, 68, 0.34);
  color: #fca5a5;
}

.sp-auth-pill--error .sp-auth-pill__dot {
  background: #ef4444;
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.7);
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
  background: rgba(148, 163, 184, 0.08);
  color: var(--sp-text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 150ms ease;
}

.sp-icon-btn:hover {
  color: var(--sp-text-primary);
  background: rgba(148, 163, 184, 0.16);
  border-color: var(--sp-border-strong);
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
  background: var(--sp-bg-base);
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
  background: var(--sp-bg-elevated);
  color: var(--sp-text-primary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
}

.sp-seg__count {
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.25);
  color: #c7d2fe;
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
  background: rgba(148, 163, 184, 0.06);
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
  background: rgba(148, 163, 184, 0.45);
  transition: all 150ms ease;
}

.sp-follow-pill--on {
  background: rgba(99, 102, 241, 0.15);
  border-color: rgba(99, 102, 241, 0.42);
  color: #c7d2fe;
}

.sp-follow-pill--on .sp-follow-pill__indicator {
  background: #818cf8;
  box-shadow: 0 0 7px rgba(129, 140, 248, 0.85);
}
</style>
