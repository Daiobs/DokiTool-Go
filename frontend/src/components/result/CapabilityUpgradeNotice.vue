<script setup>
import { computed } from "vue";
import AppIcon from "../AppIcon.vue";
import { LATEST_EXTENSION_VERSION } from "../../core/capabilityHub";
import { t } from "./resultI18n";

const props = defineProps({
  open: Boolean,
  isClientMounted: Boolean,
  mode: {
    type: String,
    default: "client_session",
  },
  youtubeHelper: Object,
  latestExtensionVersion: {
    type: String,
    default: "",
  },
  locale: {
    type: String,
    default: "zh-CN",
  },
});

const emit = defineEmits(["close", "open-extension"]);

const isOutdatedExtension = computed(
  () => props.youtubeHelper?.status === "outdated",
);
const upgradeReason = computed(() =>
  isOutdatedExtension.value ? "outdated_extension" : "missing",
);

const copy = computed(() => {
  const isEn = props.locale === "en";
  const rawExtVer = String(
    props.youtubeHelper?.extensionVersion || props.youtubeHelper?.version || "",
  )
    .trim()
    .replace(/^v/i, "");
  const extVerText = rawExtVer ? `v${rawExtVer}` : isEn ? "unknown" : "未知";
  const targetExtVer = String(
    props.youtubeHelper?.min_version ||
      props.latestExtensionVersion ||
      LATEST_EXTENSION_VERSION,
  )
    .trim()
    .replace(/^v/i, "");

  if (isEn) {
    return {
      ariaLabel: "Extension capability upgrade notice",
      title:
        props.mode === "extension_mux"
          ? "Unlock Lossless HD Mux with DokiTool Extension"
          : isOutdatedExtension.value
            ? `Upgrade DokiTool Extension to v${targetExtVer}+`
            : "Install DokiTool Chrome Extension",
      description: isOutdatedExtension.value
        ? `Connected DokiTool extension (${extVerText}) is outdated. Upgrade to v${targetExtVer}+ to parse and download YouTube 4K60 & Bilibili 1080P losslessly.`
        : "Zero-cookie local parsing and background lossless 4K60 / 1080P muxing directly in Chrome or Edge via the official DokiTool MV3 extension.",
      primaryCta: isOutdatedExtension.value
        ? `Upgrade DokiTool Extension to v${targetExtVer} (YouTube 4K60 & Bilibili 1080P)`
        : "Install DokiTool Extension (YouTube 4K60 & Bilibili 1080P)",
    };
  }
  return {
    ariaLabel: "扩展能力升级提示",
    title:
      props.mode === "extension_mux"
        ? "安装 DokiTool 扩展解锁高清无损合流"
        : isOutdatedExtension.value
          ? `升级 DokiTool 扩展至 v${targetExtVer}+`
          : "安装 DokiTool Chrome 官方扩展",
    description: isOutdatedExtension.value
      ? `检测到已连接的扩展版本（${extVerText}）较低，升级至 v${targetExtVer}+ 即可本地解析下载 YouTube 4K60 与 B 站 1080P 高清视频。`
      : "安装官方 Chrome MV3 扩展即可实现零 Cookie 本地解析，并支持后台无损合流 YouTube 4K60 与 B 站 1080P 高清视频。",
    primaryCta: isOutdatedExtension.value
      ? `升级 DokiTool 扩展至 v${targetExtVer}（解锁 YouTube 4K60）`
      : "安装 DokiTool 扩展（解锁 YouTube 4K60 & B 站 1080P）",
  };
});
</script>

<template>
  <Teleport to="body" :disabled="!isClientMounted"
    ><Transition name="rs-upgrade-notice"
      ><div
        v-if="open"
        data-capability-upgrade-notice
        :data-notice-mode="mode"
        :data-upgrade-reason="upgradeReason"
        class="rs-upgrade-notice"
        role="region"
        :aria-label="copy.ariaLabel"
      >
        <div class="rs-upgrade-notice-hd">
          <div class="rs-upgrade-notice-hd-main">
            <AppIcon class="fas fa-bolt rs-upgrade-notice-icon" />
            <span>{{ copy.title }}</span>
          </div>
          <button
            type="button"
            data-capability-upgrade-close
            class="rs-upgrade-notice-close"
            :aria-label="t(locale, 'close')"
            @click="emit('close')"
          >
            <AppIcon class="fas fa-times" />
          </button>
        </div>

        <p class="rs-upgrade-notice-desc">{{ copy.description }}</p>

        <div class="rs-upgrade-notice-actions">
          <button
            type="button"
            data-upgrade-open-extension
            class="rs-btn rs-btn--primary rs-upgrade-notice-cta"
            @click="emit('open-extension')"
          >
            <AppIcon class="fas fa-download" />
            <span>{{ copy.primaryCta }}</span>
          </button>
        </div>
      </div></Transition
    ></Teleport
  >
</template>

<style scoped>
.rs-upgrade-notice {
  --cun-bg: #ffffff;
  --cun-bg-subtle: #f1f5f9;
  --cun-fg: #0f172a;
  --cun-fg-2: #475569;
  --cun-border: #e2e8f0;
  --cun-accent: #4f46e5;
  position: fixed;
  right: 1.25rem;
  bottom: 1.25rem;
  z-index: 9500;
  width: calc(100vw - 2.5rem);
  max-width: 24.5rem;
  box-sizing: border-box;
  padding: 1rem 1.125rem;
  border-radius: 1.125rem;
  background: var(--cun-bg);
  color: var(--cun-fg);
  border: 1px solid var(--cun-border);
  box-shadow:
    0 18px 48px rgba(15, 23, 42, 0.18),
    0 4px 14px rgba(15, 23, 42, 0.08);
  font-family: inherit;
}

:global(.dark) .rs-upgrade-notice {
  --cun-bg: #1e293b;
  --cun-bg-subtle: #334155;
  --cun-fg: #f1f5f9;
  --cun-fg-2: #cbd5e1;
  --cun-border: #334155;
  --cun-accent: #818cf8;
  box-shadow:
    0 20px 54px rgba(0, 0, 0, 0.45),
    0 4px 16px rgba(0, 0, 0, 0.25);
}

.rs-upgrade-notice-hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.625rem;
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--cun-fg);
  margin-bottom: 0.5rem;
}

.rs-upgrade-notice-hd-main {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  min-width: 0;
  line-height: 1.4;
}

.rs-upgrade-notice-icon {
  flex-shrink: 0;
  margin-top: 0.2rem;
  color: var(--cun-accent);
}

.rs-upgrade-notice-close {
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 9999px;
  border: 1px solid var(--cun-border);
  background: var(--cun-bg-subtle);
  color: var(--cun-fg-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transition: background 150ms ease, color 150ms ease;
}

.rs-upgrade-notice-close:hover {
  color: var(--cun-fg);
}

.rs-upgrade-notice-close:focus-visible {
  outline: 2px solid var(--cun-accent);
  outline-offset: 2px;
}

.rs-upgrade-notice-desc {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
  color: var(--cun-fg-2);
  line-height: 1.55;
}

.rs-upgrade-notice-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.rs-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  padding: 0.625rem 1rem;
  font-size: 0.8125rem;
  font-weight: 600;
  border-radius: 0.875rem;
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
  line-height: 1.4;
  position: relative;
  overflow: hidden;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
  text-align: center;
  max-width: 100%;
  box-sizing: border-box;
}

.rs-btn::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, transparent 50%);
  opacity: 0;
  transition: opacity 200ms cubic-bezier(0.4, 0, 0.2, 1);
}

.rs-btn:hover::before {
  opacity: 1;
}

.rs-btn:active {
  transform: scale(0.98);
}

.rs-btn--primary {
  background-color: #4f46e5;
  background-image: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: #fff;
  box-shadow:
    0 4px 16px rgba(108, 92, 231, 0.35),
    0 1px 3px rgba(0, 0, 0, 0.1);
}

.rs-btn--primary:hover {
  transform: translateY(-1px);
  box-shadow:
    0 8px 24px rgba(108, 92, 231, 0.42),
    0 2px 6px rgba(0, 0, 0, 0.12);
}

.rs-btn--primary:focus-visible {
  outline: 2px solid #818cf8;
  outline-offset: 2px;
}

.rs-upgrade-notice-cta {
  width: 100%;
}

.rs-upgrade-notice-enter-active {
  transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.rs-upgrade-notice-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.rs-upgrade-notice-enter-from,
.rs-upgrade-notice-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

@media (max-width: 480px) {
  .rs-upgrade-notice {
    left: 0.75rem;
    right: 0.75rem;
    bottom: 0.75rem;
    width: auto;
    max-width: none;
    padding: 0.875rem 1rem;
    border-radius: 1rem;
  }

  .rs-upgrade-notice-hd {
    font-size: 0.875rem;
  }
}

@media (forced-colors: active) {
  .rs-btn--primary {
    forced-color-adjust: auto;
    background-image: none;
    background-color: Highlight;
    color: HighlightText;
    border: 1px solid ButtonText;
  }
}
</style>
