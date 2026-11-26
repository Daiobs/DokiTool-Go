<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  LATEST_EXTENSION_VERSION,
  isExtensionVersionOutdated,
} from "../core/capabilityHub";

const props = withDefaults(
  defineProps<{
    locale?: string;
    extensionConnected?: boolean;
    extensionVersion?: string;
    latestExtensionVersion?: string;
  }>(),
  {
    locale: "zh-CN",
    extensionConnected: false,
    extensionVersion: "",
    latestExtensionVersion: "",
  },
);

const emit = defineEmits<{
  (e: "close"): void;
}>();

const CHROME_EXTENSIONS_URL = "chrome://extensions";
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const effectiveLatestVersion = computed(
  () => (props.latestExtensionVersion || "").trim() || LATEST_EXTENSION_VERSION,
);

const isUpgradeMode = computed(
  () =>
    Boolean(props.extensionConnected) &&
    isExtensionVersionOutdated(
      props.extensionVersion,
      effectiveLatestVersion.value,
    ),
);

const copy = computed(() => {
  const upgrade = isUpgradeMode.value;
  const latestVer = effectiveLatestVersion.value;
  const currentVersion = props.extensionVersion || "";
  if (props.locale === "en") {
    return {
      badge: upgrade
        ? `Upgrade v${currentVersion} → v${latestVer} (keeps history & settings)`
        : `Chrome MV3 Native Side Panel v${latestVer} · Anonymous Ready`,
      title: "DokiTool Chrome Extension",
      subtitle:
        "Watermark-free downloads across 14 core platforms + 1,000+ long-tail sites, built-in Bilibili 1080P & YouTube 4K60 lossless local muxing without Tampermonkey, pure-client VTT/SRT bilingual subtitle export, multi-P background streaming & sanitized task history, automatic Web page handshake, background downloads that keep running when the side panel closes, zero cookies & zero page script injection.",
      closeLabel: "Close dialog",
      ctaLabel: upgrade
        ? `Download Latest Extension v${latestVer} (.zip)`
        : "Download Extension (.zip)",
      ctaHint:
        "Ready to use anonymously with no login or token (optional personal key in extension settings) · Desktop Chrome 116+ / Edge",
      guideTitle: upgrade
        ? "2-Step Overwrite Upgrade"
        : "3-Step Quick Install",
      step1Title: upgrade
        ? "Download & Overwrite Existing Folder"
        : "Download & Extract ZIP",
      step1Prefix: upgrade
        ? "Click the button above to download the latest "
        : "Click the button above to download ",
      step1Suffix: upgrade
        ? " and extract it overwriting the existing extension folder."
        : ', then double-click (macOS) or right-click "Extract All" (Windows) to get the extension folder.',
      step2Title: upgrade
        ? "Reload in Extensions Page to Apply"
        : "Open Extensions & Enable Developer Mode",
      step2Prefix: "Open ",
      step2Suffix: upgrade
        ? " and click the Reload button on the DokiTool card to apply immediately without losing task history or settings."
        : ' in your browser address bar, then toggle on "Developer mode" in the top-right corner.',
      copyUrl: "Copy URL",
      copiedUrl: "Copied",
      step3Title: "Drag & Drop Folder to Load",
      step3Prefix: "Drag the extracted folder from Step 1 ",
      step3Strong: "directly onto the chrome://extensions page",
      step3Suffix:
        ' (or click "Load unpacked" in the top-left and select it), then pin the extension icon to your toolbar for one-click side panel access.',
      updateLabel: "Updates:",
      updateNote:
        "Extract the newer ZIP over the original folder and click the refresh icon on the extension card in chrome://extensions — your saved preferences and settings stay intact. If you previously installed an early random-ID test build, remove the old card in chrome://extensions once before dragging the new folder; future updates only require overwriting and refreshing.",
      privacyLabel: "Privacy:",
      privacyNote:
        "Zero cookies, zero page script injection, and zero <all_urls> wildcard: auto-sync only matches the 14 core platforms; non-whitelisted long-tail direct links are handed off directly to Chrome's native downloader (the extension does not proxy requests, read response bodies, or attach cookies); Bilibili Referer DNR rules (1004, 1006–1008) are strictly scoped to extension-initiated Bilibili CDN and overseas Akamai UPOS requests without affecting other sites.",
    };
  }
  return {
    badge: upgrade
      ? `从 v${currentVersion} 升级至 v${latestVer}（保留任务历史与设置）`
      : `Chrome MV3 侧边栏原生扩展 v${latestVer} · 匿名直用`,
    title: "DokiTool Chrome 扩展",
    subtitle:
      "支持 14 核心平台 + 1000+ 长尾站点无水印视频、图集与实况照片下载，内置 B 站 1080P & YouTube 4K60 免油猴本地无损合流、纯客户端 VTT/SRT 双语字幕导出、多 P 后台流式队列与脱敏任务历史，支持网页端自动联动与关闭侧边栏后台持续落盘不断流，零 Cookie、零网页脚本注入。",
    closeLabel: "关闭弹窗",
    ctaLabel: upgrade
      ? `下载新版 Chrome 扩展包 v${latestVer}（.zip）`
      : "下载 Chrome 扩展包（.zip）",
    ctaHint:
      "匿名开箱即用，无需登录或配置 Token（可选在扩展设置中绑定专属 Key）· 支持桌面 Chrome 116+ / Edge",
    guideTitle: upgrade ? "2 步覆盖升级" : "3 步快速安装",
    step1Title: upgrade ? "下载最新 ZIP 并解压覆盖原扩展文件夹" : "下载并解压 ZIP",
    step1Prefix: upgrade ? "点击上方按钮下载最新 " : "点击上方按钮下载 ",
    step1Suffix: upgrade
      ? " 并解压覆盖原扩展文件夹。"
      : "，双击（macOS）或右键「全部解压缩」（Windows）得到文件夹。",
    step2Title: upgrade
      ? "在扩展管理页点击「刷新」立即生效"
      : "打开扩展页并开启开发者模式",
    step2Prefix: upgrade ? "打开 " : "在浏览器地址栏打开 ",
    step2Suffix: upgrade
      ? "，点击 DokiTool 卡片上的「刷新」按钮即可立即生效，任务历史与设置不会丢失。"
      : "，打开右上角「开发者模式」开关。",
    copyUrl: "复制地址",
    copiedUrl: "已复制",
    step3Title: "直接拖入文件夹完成加载",
    step3Prefix: "把第 1 步解压出的文件夹",
    step3Strong: "直接拖进 chrome://extensions 页面",
    step3Suffix:
      "（或点左上角「加载已解压的扩展程序」选中该文件夹），然后把扩展图标固定到工具栏即可一键打开侧边栏。",
    updateLabel: "后续更新：",
    updateNote:
      "解压覆盖原文件夹，在 chrome://extensions 点击扩展卡片刷新按钮即可（已保存偏好与设置不会丢失）。如之前安装过早期随机 ID 测试版，请先在 chrome://extensions 移除旧卡片再拖入一次；此后均可直接覆盖刷新升级。",
    privacyLabel: "隐私边界：",
    privacyNote:
      "零 Cookie、零网页脚本注入、零 <all_urls> 通配权限：自动跟随仅匹配 14 核心平台；非白名单长尾渐进直链直接移交浏览器原生下载器（扩展不代理请求、不读取响应体、不附加 Cookie）；B 站防盗链 DNR 规则（1004、1006–1008）仅作用于扩展自身的 B 站及海外 Akamai UPOS 请求，不影响其他站点与正常浏览。",
  };
});

const copyExtensionsUrl = async () => {
  let ok = false;
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(CHROME_EXTENSIONS_URL);
      ok = true;
    }
  } catch {
    ok = false;
  }

  if (!ok && typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.value = CHROME_EXTENSIONS_URL;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    } finally {
      document.body.removeChild(textarea);
    }
  }

  if (ok) {
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
      copiedTimer = undefined;
    }, 2000);
  }
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    emit("close");
  }
};

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown);
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="ext-modal" appear>
      <div
        class="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-modal-title"
        @click.self="emit('close')"
      >
        <div
          :data-extension-modal-mode="isUpgradeMode ? 'upgrade' : 'install'"
          class="theme-colors relative w-full max-w-xl max-h-[92vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        >
          <div class="p-5 sm:p-6">
            <div class="flex items-start justify-between gap-4">
              <div class="space-y-1.5">
                <span
                  :class="[
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium',
                    isUpgradeMode
                      ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-400/35 dark:bg-amber-500/15 dark:text-amber-300'
                      : 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300',
                  ]"
                >
                  <svg
                    class="h-3.5 w-3.5 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path
                      d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 2c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"
                    />
                  </svg>
                  <span>{{ copy.badge }}</span>
                </span>
                <h2
                  id="extension-modal-title"
                  class="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight"
                >
                  {{ copy.title }}
                </h2>
              </div>

              <button
                type="button"
                @click="emit('close')"
                :aria-label="copy.closeLabel"
                class="shrink-0 rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <svg
                  class="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>

            <p class="mt-2.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              {{ copy.subtitle }}
            </p>

            <div class="mt-4 rounded-xl border border-indigo-200/70 bg-indigo-50/60 p-3.5 dark:border-indigo-500/25 dark:bg-indigo-950/30">
              <a
                href="/helper/dokitool-chrome-extension.zip"
                download="dokitool-chrome-extension.zip"
                data-extension-zip-link
                class="btn-primary-gradient flex w-full items-center justify-center gap-2.5 text-center text-sm sm:text-base shadow-md shadow-indigo-500/20"
              >
                <svg
                  class="h-4 w-4 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" x2="12" y1="15" y2="3" />
                </svg>
                <span>{{ copy.ctaLabel }}</span>
              </a>
              <p class="mt-2.5 text-center text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {{ copy.ctaHint }}
              </p>
            </div>

            <div class="mt-4">
              <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {{ copy.guideTitle }}
              </h3>

              <ol class="mt-2.5 space-y-2.5">
                <li class="flex gap-3 rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50">
                  <span
                    :class="[
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white',
                      isUpgradeMode ? 'bg-amber-600' : 'bg-indigo-500',
                    ]"
                  >
                    1
                  </span>
                  <div class="min-w-0 flex-1 text-sm">
                    <p class="font-semibold text-slate-800 dark:text-slate-100">
                      {{ copy.step1Title }}
                    </p>
                    <p class="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                      {{ copy.step1Prefix }}<code class="rounded bg-slate-200/80 px-1.5 py-0.5 font-mono text-[11px] text-slate-800 dark:bg-slate-700 dark:text-slate-100">dokitool-chrome-extension.zip</code>{{ copy.step1Suffix }}
                    </p>
                  </div>
                </li>

                <li class="flex gap-3 rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50">
                  <span
                    :class="[
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white',
                      isUpgradeMode ? 'bg-amber-600' : 'bg-indigo-500',
                    ]"
                  >
                    2
                  </span>
                  <div class="min-w-0 flex-1 text-sm">
                    <p class="font-semibold text-slate-800 dark:text-slate-100">
                      {{ copy.step2Title }}
                    </p>
                    <p class="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                      {{ copy.step2Prefix }}<code class="rounded bg-slate-200/80 px-1.5 py-0.5 font-mono text-[11px] text-slate-800 dark:bg-slate-700 dark:text-slate-100">{{ CHROME_EXTENSIONS_URL }}</code>{{ copy.step2Suffix }}
                    </p>
                    <div class="mt-2 flex flex-wrap items-center gap-2">
                      <code class="rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                        {{ CHROME_EXTENSIONS_URL }}
                      </code>
                      <button
                        type="button"
                        data-copy-chrome-extensions-url
                        @click="copyExtensionsUrl"
                        class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        :class="
                          copied
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-600/50 dark:bg-emerald-500/15 dark:text-emerald-300'
                            : 'border-slate-300 bg-white text-slate-700 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:text-indigo-300'
                        "
                      >
                        <svg
                          v-if="copied"
                          class="h-3.5 w-3.5 shrink-0"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2.2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        <svg
                          v-else
                          class="h-3.5 w-3.5 shrink-0"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                        </svg>
                        <span>{{ copied ? copy.copiedUrl : copy.copyUrl }}</span>
                      </button>
                    </div>
                  </div>
                </li>

                <li
                  v-if="!isUpgradeMode"
                  class="flex gap-3 rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50"
                >
                  <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-xs font-bold text-white">
                    3
                  </span>
                  <div class="min-w-0 flex-1 text-sm">
                    <p class="font-semibold text-slate-800 dark:text-slate-100">
                      {{ copy.step3Title }}
                    </p>
                    <p class="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                      {{ copy.step3Prefix }}<strong class="font-semibold text-slate-800 dark:text-slate-100">{{ copy.step3Strong }}</strong>{{ copy.step3Suffix }}
                    </p>
                  </div>
                </li>
              </ol>
            </div>

            <div class="mt-4 space-y-1 border-t border-slate-200 pt-3 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <p>
                <span class="font-medium text-slate-700 dark:text-slate-300">{{ copy.updateLabel }}</span>
                {{ copy.updateNote }}
              </p>
              <p>
                <span class="font-medium text-slate-700 dark:text-slate-300">{{ copy.privacyLabel }}</span>
                {{ copy.privacyNote }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ext-modal-enter-active,
.ext-modal-leave-active {
  transition: opacity 0.2s ease;
}

.ext-modal-enter-from,
.ext-modal-leave-to {
  opacity: 0;
}
</style>
