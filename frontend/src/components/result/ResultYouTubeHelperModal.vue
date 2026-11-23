<script setup>
import { onMounted, onUnmounted } from "vue";
import AppIcon from "../AppIcon.vue";
import { t } from "./resultI18n";

const props = defineProps({
  open: Boolean,
  isClientMounted: Boolean,
  youtubeHelper: Object,
  youtubeHelperScriptUrl: String,
  needsManualHelperRefresh: Boolean,
  locale: String,
});

const emit = defineEmits([
  "close",
  "install-youtube-helper",
  "refresh-youtube-helper-page",
]);

const handleKeydown = (event) => {
  if (event.key === "Escape" && props.open) {
    emit("close");
  }
};

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <Teleport to="body" :disabled="!isClientMounted"
    ><Transition name="rs-modal"
      ><div
        v-if="open && youtubeHelper"
        data-yt-helper-modal
        class="rs-yt-modal-backdrop"
        @click.self="emit('close')"
        role="dialog"
        aria-modal="true"
        aria-label="YouTube 下载助手安装说明"
      >
        <div class="rs-yt-modal-dialog">
          <div class="rs-yt-helper-card-hd">
            <div class="rs-yt-helper-card-hd-main">
              <AppIcon class="fas fa-download" />
              <span>{{
                youtubeHelper.status === "outdated"
                  ? `YouTube 下载助手脚本需要更新（当前 v${youtubeHelper.version || "未知"}，要求 v${youtubeHelper.min_version || "1.3.1"}+）`
                  : "需要安装 YouTube 下载助手脚本"
              }}</span>
            </div>
            <button
              type="button"
              data-yt-helper-modal-close
              class="rs-yt-modal-close"
              :aria-label="t(locale, 'close')"
              @click="emit('close')"
            >
              <AppIcon class="fas fa-times" />
            </button>
          </div>
          <p class="rs-yt-helper-card-intro">
            YouTube 媒体直链绑定请求方网络出口 IP，本站不再提供绑定服务器 IP 的下载链接。请按以下步骤在浏览器中安装并启用用户脚本：
          </p>
          <ol class="rs-yt-helper-steps">
            <li>
              <strong>安装脚本管理器扩展：</strong>Chrome / Edge 请安装
              <strong>Tampermonkey（篡改猴）</strong>，Firefox 请安装
              <strong>Violentmonkey（暴力猴）</strong>。
            </li>
            <li>
              <strong>在 Chrome 中打开「允许用户脚本」：</strong>在 Chrome / Edge
              地址栏打开 <code>chrome://extensions</code>，点击 Tampermonkey 的「详情」，开启<strong>「允许用户脚本」</strong>（Allow User Scripts）开关（或开启右上角开发者模式）。
            </li>
            <li>
              <strong>{{
                youtubeHelper.status === "outdated"
                  ? "更新本站助手脚本："
                  : "安装本站助手脚本："
              }}</strong>点击下方按钮打开脚本地址完成安装或更新；安装完成后切回本标签页将自动识别并重新解析。
            </li>
          </ol>
          <div class="rs-yt-helper-actions">
            <a
              :href="youtubeHelperScriptUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="rs-btn rs-btn--primary rs-yt-helper-install-link"
              @click="emit('install-youtube-helper')"
            >
              <AppIcon class="fas fa-download" />
              <span>{{
                youtubeHelper.status === "outdated"
                  ? "更新 YouTube 助手脚本 (/helper/dokitool-youtube.user.js)"
                  : "安装 YouTube 助手脚本 (/helper/dokitool-youtube.user.js)"
              }}</span>
            </a>
            <button
              v-if="needsManualHelperRefresh"
              type="button"
              data-yt-helper-manual-refresh
              class="rs-btn rs-btn--ghost rs-yt-helper-refresh-btn"
              @click="emit('refresh-youtube-helper-page')"
            >
              <AppIcon class="fas fa-redo" />
              <span>{{ locale === "en" ? "Refresh Page" : "刷新页面" }}</span>
            </button>
          </div>
        </div>
      </div></Transition
    ></Teleport
  >
</template>

<style scoped>
.rs-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.65rem 1.25rem;
  font-size: 0.7875rem;
  font-weight: 600;
  border-radius: 1rem;
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: all 220ms cubic-bezier(0.4, 0, 0.2, 1);
  line-height: 1.4;
  position: relative;
  overflow: hidden;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
  text-align: center;
  max-width: 100%;
  box-sizing: border-box;
  height: auto;
}
.rs-btn::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, transparent 50%);
  opacity: 0;
  transition: opacity 220ms cubic-bezier(0.4, 0, 0.2, 1);
}
.rs-btn:hover::before {
  opacity: 1;
}
.rs-btn:active {
  transform: scale(0.96);
}
.rs-btn--primary {
  background-color: #4f46e5;
  background-image: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: #fff;
  box-shadow: 0 4px 16px rgba(108, 92, 231, 0.35), 0 1px 3px rgba(0, 0, 0, 0.1);
}
.rs-btn--primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 28px rgba(108, 92, 231, 0.45),
    0 2px 6px rgba(0, 0, 0, 0.12);
}
.rs-btn--ghost {
  background: var(--ytm-bg-subtle);
  color: var(--ytm-fg);
  border: 1px solid var(--ytm-border);
}

.rs-yt-modal-backdrop {
  --ytm-bg: #ffffff;
  --ytm-bg-subtle: #f1f5f9;
  --ytm-fg: #0f172a;
  --ytm-fg-2: #475569;
  --ytm-border: #e2e8f0;
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  box-sizing: border-box;
  background: rgba(15, 23, 42, 0.62);
  backdrop-filter: blur(6px);
  overflow-y: auto;
}
.dark .rs-yt-modal-backdrop {
  --ytm-bg: #1e293b;
  --ytm-bg-subtle: #334155;
  --ytm-fg: #f1f5f9;
  --ytm-fg-2: #cbd5e1;
  --ytm-border: #334155;
}
.rs-yt-modal-dialog {
  width: 100%;
  max-width: 34rem;
  max-height: calc(100vh - 2rem);
  max-height: calc(100dvh - 2rem);
  overflow-y: auto;
  overflow-x: hidden;
  box-sizing: border-box;
  padding: 1.25rem 1.375rem;
  border-radius: 1.25rem;
  background: var(--ytm-bg);
  color: var(--ytm-fg);
  border: 1px solid var(--ytm-border);
  box-shadow: 0 24px 72px rgba(0, 0, 0, 0.28);
}
.rs-yt-helper-card-hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 1rem;
  font-weight: 700;
  color: var(--ytm-fg);
  margin-bottom: 0.625rem;
}
.rs-yt-helper-card-hd-main {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  min-width: 0;
  line-height: 1.45;
}
.rs-yt-helper-card-hd-main :deep(svg) {
  flex-shrink: 0;
  margin-top: 0.2rem;
  color: #6366f1;
}
.rs-yt-modal-close {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 9999px;
  border: 1px solid var(--ytm-border);
  background: var(--ytm-bg-subtle);
  color: var(--ytm-fg-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transition: background 150ms ease, color 150ms ease;
}
.rs-yt-modal-close:hover {
  color: var(--ytm-fg);
}
.rs-yt-helper-card-intro {
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
  color: var(--ytm-fg-2);
  line-height: 1.6;
}
.rs-yt-helper-steps {
  margin: 0 0 1rem;
  padding-left: 1.25rem;
  font-size: 0.875rem;
  color: var(--ytm-fg-2);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.rs-yt-helper-steps code {
  padding: 0.125rem 0.375rem;
  border-radius: 0.375rem;
  background: var(--ytm-bg-subtle);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.8125rem;
  word-break: break-all;
  overflow-wrap: anywhere;
}
.rs-yt-helper-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.625rem;
}
.rs-yt-helper-install-link {
  text-decoration: none;
  flex: 1 1 auto;
}
.rs-yt-helper-refresh-btn {
  background: var(--ytm-bg-subtle);
  color: var(--ytm-fg);
  border: 1px solid var(--ytm-border);
}
.rs-modal-enter-active {
  transition: opacity 0.25s ease;
}
.rs-modal-leave-active {
  transition: opacity 0.18s ease;
}
.rs-modal-enter-from,
.rs-modal-leave-to {
  opacity: 0;
}
@media (max-width: 480px) {
  .rs-yt-modal-backdrop {
    padding: 0.75rem;
  }
  .rs-yt-modal-dialog {
    padding: 1rem;
    border-radius: 1rem;
  }
  .rs-yt-helper-card-hd {
    font-size: 0.9375rem;
  }
  .rs-yt-helper-card-intro,
  .rs-yt-helper-steps {
    font-size: 0.8125rem;
  }
  .rs-yt-helper-actions .rs-btn {
    width: 100%;
  }
}
</style>
