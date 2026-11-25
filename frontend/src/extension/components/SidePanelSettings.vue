<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  buildSafeDownloadPath,
  sanitizeSubfolderPrefix,
} from "../filenameSanitizer";
import { PROD_API_ORIGIN, validateApiBaseUrl } from "../hostWhitelist";
import type {
  BatchSaveMode,
  ConnectionCheckResult,
  ExtensionSettings,
  ExtensionSettingsPatch,
  ExtensionThemeMode,
  QualityPreference,
} from "../protocol";
import { normalizeExtensionThemeMode } from "../storage";
import {
  applyExtensionTheme,
  requestLoopbackOriginPermissionOnGesture,
  sendSidePanelRequest,
} from "../uiTargetHelpers";

const props = defineProps<{
  open: boolean;
  settings: ExtensionSettings;
  connection: ConnectionCheckResult | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "saved", next: ExtensionSettings): void;
  (e: "connection-checked", result: ConnectionCheckResult): void;
  (
    e: "notify",
    payload: { message: string; tone?: "success" | "error" | "info" },
  ): void;
}>();

const draftApiBaseUrl = ref<string>(PROD_API_ORIGIN);
const draftBearerToken = ref<string>("");
const draftSubfolderPrefix = ref<string>("");
const draftBatchSaveMode = ref<BatchSaveMode>("subfolder");
const draftQualityPreference = ref<QualityPreference>("best");
const draftAutoFollowTab = ref<boolean>(false);
const draftUseSaveFilePicker = ref<boolean>(false);
const draftTheme = ref<ExtensionThemeMode>("system");
const autoFollowExplicitlyTouched = ref<boolean>(false);
let themePreviewActive = false;

const showToken = ref<boolean>(false);
const testingConnection = ref<boolean>(false);
const savingSettings = ref<boolean>(false);
const localError = ref<string>("");
const testBanner = ref<{
  tone: "ok" | "err";
  text: string;
} | null>(null);

function syncDraftFromProps() {
  draftApiBaseUrl.value = props.settings.apiBaseUrl || PROD_API_ORIGIN;
  draftBearerToken.value = props.settings.bearerToken || "";
  draftSubfolderPrefix.value = props.settings.subfolderPrefix || "";
  draftBatchSaveMode.value = props.settings.batchSaveMode || "subfolder";
  draftQualityPreference.value = props.settings.qualityPreference || "best";
  draftAutoFollowTab.value = Boolean(props.settings.autoFollowTab);
  draftUseSaveFilePicker.value = Boolean(props.settings.useSaveFilePicker);
  draftTheme.value = normalizeExtensionThemeMode(props.settings.theme);
  themePreviewActive = false;
  autoFollowExplicitlyTouched.value = false;
  localError.value = "";
  if (props.connection) {
    testBanner.value = formatConnectionBanner(props.connection);
  } else {
    testBanner.value = null;
  }
}

function restoreThemeIfPreviewed() {
  if (!themePreviewActive) return;
  themePreviewActive = false;
  applyExtensionTheme(normalizeExtensionThemeMode(props.settings.theme), {
    persistCache: false,
  });
}

function handleSelectTheme(mode: ExtensionThemeMode) {
  draftTheme.value = mode;
  themePreviewActive = true;
  applyExtensionTheme(mode, { persistCache: false });
}

function handleRequestClose() {
  restoreThemeIfPreviewed();
  emit("close");
}

watch(
  () => props.open,
  (isOpen, wasOpen) => {
    if (isOpen) {
      syncDraftFromProps();
    } else if (wasOpen) {
      restoreThemeIfPreviewed();
    }
  },
  { immediate: true },
);

// Preview automatic auto-follow default when transitioning between anonymous <-> token mode
watch(draftBearerToken, (nextToken) => {
  if (autoFollowExplicitlyTouched.value) return;
  const trimmed = nextToken.trim();
  if (!trimmed) {
    draftAutoFollowTab.value = false;
  } else if (!props.settings.bearerToken.trim()) {
    draftAutoFollowTab.value = true;
  }
});

const urlValidation = computed(() => validateApiBaseUrl(draftApiBaseUrl.value));

const sanitizedPrefixPreview = computed(() =>
  sanitizeSubfolderPrefix(draftSubfolderPrefix.value),
);

const livePathPreview = computed(() => {
  const rel = buildSafeDownloadPath({
    prefix: draftSubfolderPrefix.value,
    subfolder: "作品标题",
    index: 1,
    ext: "jpg",
  });
  return `Downloads/${rel}`;
});

function formatConnectionBanner(res: ConnectionCheckResult): {
  tone: "ok" | "err";
  text: string;
} {
  if (res.ok) {
    const count = res.platformCount ?? 14;
    const modeLabel =
      res.authMode === "authenticated" ? "Bearer 专属鉴权" : "匿名模式";
    return {
      tone: "ok",
      text: `${res.status || 200} 已就绪（已加载 ${count} 个平台 · ${modeLabel}）`,
    };
  }
  if (res.status === 401) {
    const msg = res.message?.includes("401")
      ? res.message
      : `401 ${res.message || "认证凭据无效"}`;
    return { tone: "err", text: msg };
  }
  const codePrefix = res.status > 0 ? `${res.status} ` : "";
  return {
    tone: "err",
    text: `${codePrefix}${res.message || "无法连接后端服务"}`,
  };
}

function handleToggleAutoFollow() {
  draftAutoFollowTab.value = !draftAutoFollowTab.value;
  autoFollowExplicitlyTouched.value = true;
}

function handleClearTokenToAnonymous() {
  draftBearerToken.value = "";
  if (!autoFollowExplicitlyTouched.value) {
    draftAutoFollowTab.value = false;
  }
  testBanner.value = null;
}

/**
 * Click handler for "测试连通性".
 * Calls `requestLoopbackOriginPermissionOnGesture` synchronously on line 1 before any `await`!
 */
async function handleTestConnectionClick() {
  localError.value = "";
  const validated = validateApiBaseUrl(draftApiBaseUrl.value);
  if (!validated.ok) {
    localError.value = validated.error || "后端地址格式无效";
    return;
  }

  // Must execute synchronously inside user gesture before any await!
  const grantedPromise = requestLoopbackOriginPermissionOnGesture(validated);
  testingConnection.value = true;
  testBanner.value = null;

  try {
    const granted = await grantedPromise;
    if (!granted) {
      localError.value = `未授予本地回环访问权限（${validated.origin}/*），无法连接本地后端`;
      return;
    }

    const rpc = await sendSidePanelRequest({
      type: "TEST_CONNECTION",
      apiBaseUrl: validated.origin,
      bearerToken: draftBearerToken.value.trim(),
    });

    if (!rpc.ok) {
      const statusPrefix = rpc.status ? `${rpc.status} ` : "";
      testBanner.value = {
        tone: "err",
        text: `${statusPrefix}${rpc.error}`,
      };
      return;
    }

    testBanner.value = formatConnectionBanner(rpc.data);
    emit("connection-checked", rpc.data);
  } finally {
    testingConnection.value = false;
  }
}

/**
 * Click handler for "保存设置".
 * Calls `requestLoopbackOriginPermissionOnGesture` synchronously on line 1 before any `await`!
 */
async function handleSaveSettingsClick() {
  localError.value = "";
  const validated = validateApiBaseUrl(draftApiBaseUrl.value);
  if (!validated.ok) {
    localError.value = validated.error || "后端地址格式无效";
    return;
  }

  // Must execute synchronously inside user gesture before any await!
  const grantedPromise = requestLoopbackOriginPermissionOnGesture(validated);
  savingSettings.value = true;

  try {
    const granted = await grantedPromise;
    if (!granted) {
      localError.value = `未授予本地回环访问权限（${validated.origin}/*），请允许权限后再保存`;
      return;
    }

    const patch: ExtensionSettingsPatch = {
      apiBaseUrl: validated.origin,
      bearerToken: draftBearerToken.value.trim(),
      subfolderPrefix: draftSubfolderPrefix.value,
      batchSaveMode: draftBatchSaveMode.value,
      qualityPreference: draftQualityPreference.value,
      theme: draftTheme.value,
      useSaveFilePicker: draftUseSaveFilePicker.value,
      ...(autoFollowExplicitlyTouched.value
        ? { autoFollowTab: draftAutoFollowTab.value }
        : {}),
    };

    const rpc = await sendSidePanelRequest({
      type: "UPDATE_SETTINGS",
      patch,
    });

    if (!rpc.ok) {
      localError.value = rpc.error || "保存设置失败";
      return;
    }

    // Verify connection silently after saving so header status dot stays authoritative
    void sendSidePanelRequest({
      type: "TEST_CONNECTION",
      apiBaseUrl: rpc.data.settings.apiBaseUrl,
      bearerToken: rpc.data.settings.bearerToken,
    }).then((connRes) => {
      if (connRes.ok) {
        emit("connection-checked", connRes.data);
      }
    });

    themePreviewActive = false;
    applyExtensionTheme(rpc.data.settings.theme);
    emit("saved", rpc.data.settings);
    emit("notify", { message: "扩展偏好与凭据已保存", tone: "success" });
    emit("close");
  } finally {
    savingSettings.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (props.open && event.key === "Escape") {
    handleRequestClose();
  }
}

onMounted(() => {
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKeydown);
  }
});

onUnmounted(() => {
  restoreThemeIfPreviewed();
  if (typeof window !== "undefined") {
    window.removeEventListener("keydown", onKeydown);
  }
});
</script>

<template>
  <Transition name="sp-drawer">
    <div
      v-if="open"
      class="sp-drawer-mask"
      role="dialog"
      aria-modal="true"
      aria-label="扩展设置与鉴权配置"
      @click.self="handleRequestClose"
    >
      <div class="sp-drawer-panel">
        <div class="sp-drawer-hd">
          <div class="sp-drawer-hd__left">
            <span class="sp-drawer-hd__title">设置与专属鉴权</span>
            <span class="sp-drawer-hd__sub">仅存于本机扩展隔离存储</span>
          </div>
          <button
            type="button"
            class="sp-drawer-close"
            aria-label="关闭设置抽屉"
            @click="handleRequestClose"
          >
            ✕
          </button>
        </div>

        <div class="sp-drawer-body">
          <!-- Backend API URL -->
          <div class="sp-field">
            <div class="sp-field__label-row">
              <label class="sp-field__label" for="sp-api-url-input">
                后端服务地址
              </label>
              <button
                v-if="draftApiBaseUrl.trim() !== PROD_API_ORIGIN"
                type="button"
                class="sp-field__reset"
                @click="draftApiBaseUrl = PROD_API_ORIGIN"
              >
                恢复默认
              </button>
            </div>
            <input
              id="sp-api-url-input"
              v-model="draftApiBaseUrl"
              type="url"
              spellcheck="false"
              autocomplete="off"
              class="sp-input"
              placeholder="https://snap.dokitool.com"
            />
            <span
              v-if="!urlValidation.ok"
              class="sp-field__hint sp-field__hint--err"
            >
              {{ urlValidation.error }}
            </span>
            <span
              v-else-if="urlValidation.isLoopback"
              class="sp-field__hint sp-field__hint--warn"
            >
              本地回环模式：点击测试或保存时将按需请求 {{ urlValidation.origin }}/* 权限
            </span>
            <span v-else class="sp-field__hint">
              仅支持 HTTPS 公开域名或本机 http://127.0.0.1 / localhost
            </span>
          </div>

          <!-- Bearer Token -->
          <div class="sp-field">
            <div class="sp-field__label-row">
              <label class="sp-field__label" for="sp-bearer-input">
                专属 Bearer Token
              </label>
              <button
                v-if="draftBearerToken.length > 0"
                type="button"
                class="sp-field__reset"
                @click="handleClearTokenToAnonymous"
              >
                清空切回匿名
              </button>
            </div>

            <div class="sp-token-box">
              <input
                id="sp-bearer-input"
                v-model="draftBearerToken"
                :type="showToken ? 'text' : 'password'"
                spellcheck="false"
                autocomplete="off"
                class="sp-input sp-token-box__input"
                placeholder="留空则为匿名模式（不发送 Authorization 头）"
              />
              <button
                type="button"
                class="sp-token-box__eye"
                :title="showToken ? '隐藏凭据' : '显示凭据'"
                @click="showToken = !showToken"
              >
                {{ showToken ? "隐藏" : "显示" }}
              </button>
            </div>

            <div class="sp-conn-row">
              <button
                type="button"
                class="sp-btn sp-btn--secondary sp-btn--sm"
                :disabled="testingConnection || !urlValidation.ok"
                @click="handleTestConnectionClick"
              >
                {{ testingConnection ? "检测中..." : "测试连通性" }}
              </button>
              <span class="sp-field__hint">
                {{ draftBearerToken.trim() ? "已填凭据（解锁高频缓存与直链）" : "当前匿名模式" }}
              </span>
            </div>

            <div
              v-if="testBanner"
              class="sp-conn-banner"
              :class="`sp-conn-banner--${testBanner.tone}`"
            >
              {{ testBanner.text }}
            </div>
          </div>

          <div class="sp-divider" />

          <!-- Theme Appearance -->
          <div class="sp-field">
            <span class="sp-field__label">外观主题</span>
            <div
              class="sp-choice-grid sp-choice-grid--3"
              role="radiogroup"
              aria-label="外观主题"
            >
              <button
                type="button"
                role="radio"
                :aria-checked="draftTheme === 'system'"
                class="sp-choice-btn sp-theme-choice"
                :class="{ 'sp-choice-btn--on': draftTheme === 'system' }"
                @click="handleSelectTheme('system')"
              >
                跟随系统
              </button>
              <button
                type="button"
                role="radio"
                :aria-checked="draftTheme === 'light'"
                class="sp-choice-btn sp-theme-choice"
                :class="{ 'sp-choice-btn--on': draftTheme === 'light' }"
                @click="handleSelectTheme('light')"
              >
                浅色
              </button>
              <button
                type="button"
                role="radio"
                :aria-checked="draftTheme === 'dark'"
                class="sp-choice-btn sp-theme-choice"
                :class="{ 'sp-choice-btn--on': draftTheme === 'dark' }"
                @click="handleSelectTheme('dark')"
              >
                深色
              </button>
            </div>
          </div>

          <!-- Subfolder Prefix -->
          <div class="sp-field">
            <label class="sp-field__label" for="sp-prefix-input">
              默认子目录前缀（可选）
            </label>
            <input
              id="sp-prefix-input"
              v-model="draftSubfolderPrefix"
              type="text"
              spellcheck="false"
              class="sp-input"
              placeholder="例如 DokiTool（留空则直接存下载根目录）"
            />
            <span class="sp-field__hint sp-field__hint--mono" :title="livePathPreview">
              预览：{{ livePathPreview }}
              <template v-if="draftSubfolderPrefix && !sanitizedPrefixPreview">
                （非法路径字符已自动剥离）
              </template>
            </span>
          </div>

          <!-- Quality Preference -->
          <div class="sp-field">
            <span class="sp-field__label">默认画质偏好（自动记忆预选）</span>
            <div class="sp-choice-grid sp-choice-grid--3">
              <button
                type="button"
                class="sp-choice-btn"
                :class="{ 'sp-choice-btn--on': draftQualityPreference === 'best' }"
                @click="draftQualityPreference = 'best'"
              >
                最高画质
              </button>
              <button
                type="button"
                class="sp-choice-btn"
                :class="{ 'sp-choice-btn--on': draftQualityPreference === '1080p' }"
                @click="draftQualityPreference = '1080p'"
              >
                1080p 优先
              </button>
              <button
                type="button"
                class="sp-choice-btn"
                :class="{ 'sp-choice-btn--on': draftQualityPreference === 'audio' }"
                @click="draftQualityPreference = 'audio'"
              >
                仅音频 M4A
              </button>
            </div>
          </div>

          <!-- Default Batch Save Mode -->
          <div class="sp-field">
            <span class="sp-field__label">图集与多P默认保存方式</span>
            <div class="sp-choice-grid sp-choice-grid--2">
              <button
                type="button"
                class="sp-choice-btn"
                :class="{ 'sp-choice-btn--on': draftBatchSaveMode === 'subfolder' }"
                @click="draftBatchSaveMode = 'subfolder'"
              >
                子文件夹逐个保存
              </button>
              <button
                type="button"
                class="sp-choice-btn"
                :class="{ 'sp-choice-btn--on': draftBatchSaveMode === 'zip' }"
                @click="draftBatchSaveMode = 'zip'"
              >
                打包 ZIP
              </button>
            </div>
          </div>

          <!-- Auto-Follow Active Tab Switch -->
          <div class="sp-switch-row">
            <div class="sp-switch-row__info">
              <span class="sp-field__label">自动跟随当前标签页</span>
              <span class="sp-field__hint">
                仅本地匹配 14 个支持平台作品页时自动解析；其它网站零外发请求
              </span>
            </div>
            <button
              type="button"
              role="switch"
              :aria-checked="draftAutoFollowTab"
              class="sp-switch"
              :class="{ 'sp-switch--on': draftAutoFollowTab }"
              @click="handleToggleAutoFollow"
            >
              <span class="sp-switch__thumb" />
            </button>
          </div>

          <!-- Optional System Save-As Streaming Direct Write (Spec B.3 §4) -->
          <div class="sp-switch-row">
            <div class="sp-switch-row__info">
              <span class="sp-field__label">系统另存为流式直写（防其他插件改名）</span>
              <span class="sp-field__hint">
                单文件下载弹出系统保存框直接写盘，物理绕过冲突下载扩展的文件名劫持
              </span>
            </div>
            <button
              type="button"
              role="switch"
              data-testid="save-file-picker-toggle"
              :aria-checked="draftUseSaveFilePicker"
              class="sp-switch"
              :class="{ 'sp-switch--on': draftUseSaveFilePicker }"
              @click="draftUseSaveFilePicker = !draftUseSaveFilePicker"
            >
              <span class="sp-switch__thumb" />
            </button>
          </div>

          <div v-if="localError" class="sp-conn-banner sp-conn-banner--err">
            {{ localError }}
          </div>
        </div>

        <div class="sp-drawer-ft">
          <button
            type="button"
            class="sp-btn sp-btn--ghost"
            @click="handleRequestClose"
          >
            取消
          </button>
          <button
            type="button"
            class="sp-btn sp-btn--primary sp-drawer-ft__save"
            :disabled="savingSettings || !urlValidation.ok"
            @click="handleSaveSettingsClick"
          >
            {{ savingSettings ? "保存中..." : "保存设置" }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.sp-drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: var(--sp-backdrop);
  backdrop-filter: blur(5px);
  -webkit-backdrop-filter: blur(5px);
  display: flex;
  justify-content: flex-end;
}

.sp-drawer-panel {
  width: 100%;
  max-width: 390px;
  height: 100%;
  background: var(--sp-bg-surface);
  border-left: 1px solid var(--sp-border-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--sp-shadow-drawer);
}

.sp-drawer-hd {
  padding: 12px;
  border-bottom: 1px solid var(--sp-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sp-drawer-hd__left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sp-drawer-hd__title {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--sp-text-primary);
}

.sp-drawer-hd__sub {
  font-size: 10.5px;
  color: var(--sp-text-muted);
}

.sp-drawer-close {
  width: 28px;
  height: 28px;
  border-radius: var(--sp-radius-sm);
  border: 1px solid var(--sp-border);
  background: var(--sp-ghost-bg);
  color: var(--sp-text-secondary);
  cursor: pointer;
  transition: all 140ms ease;
}

.sp-drawer-close:hover {
  background: var(--sp-ghost-bg-hover);
  color: var(--sp-text-primary);
  border-color: var(--sp-border-strong);
}

.sp-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sp-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.sp-field__label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.sp-field__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--sp-text-primary);
}

.sp-field__reset {
  border: none;
  background: transparent;
  color: var(--sp-accent-text);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}

.sp-field__reset:hover {
  text-decoration: underline;
}

.sp-field__hint {
  font-size: 10.5px;
  color: var(--sp-text-muted);
  line-height: 1.35;
  word-break: break-all;
}

.sp-field__hint--mono {
  font-family: var(--sp-font-mono);
  color: var(--sp-text-secondary);
}

.sp-field__hint--err {
  color: var(--sp-danger-text);
}

.sp-field__hint--warn {
  color: var(--sp-warning-text);
}

.sp-token-box {
  position: relative;
  display: flex;
  align-items: center;
}

.sp-token-box__input {
  padding-right: 48px;
  font-family: var(--sp-font-mono);
}

.sp-token-box__eye {
  position: absolute;
  right: 6px;
  border: 1px solid var(--sp-border);
  background: var(--sp-bg-elevated);
  color: var(--sp-text-secondary);
  border-radius: 5px;
  padding: 2px 6px;
  font-family: inherit;
  font-size: 10.5px;
  cursor: pointer;
}

.sp-token-box__eye:hover {
  color: var(--sp-text-primary);
  border-color: var(--sp-border-strong);
}

.sp-conn-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 2px;
}

.sp-conn-banner {
  padding: 7px 9px;
  border-radius: var(--sp-radius-sm);
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.4;
  word-break: break-word;
}

.sp-conn-banner--ok {
  background: var(--sp-success-soft);
  border: 1px solid var(--sp-success-border);
  color: var(--sp-success-text);
}

.sp-conn-banner--err {
  background: var(--sp-danger-soft);
  border: 1px solid var(--sp-danger-border);
  color: var(--sp-danger-text);
}

.sp-divider {
  height: 1px;
  background: var(--sp-border);
}

.sp-choice-grid {
  display: grid;
  gap: 5px;
}

.sp-choice-grid--2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.sp-choice-grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.sp-choice-btn {
  padding: 7px 6px;
  border-radius: var(--sp-radius-sm);
  border: 1px solid var(--sp-border-strong);
  background: var(--sp-bg-base);
  color: var(--sp-text-secondary);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 140ms ease;
}

.sp-choice-btn:hover {
  border-color: var(--sp-border-accent);
  color: var(--sp-text-primary);
}

.sp-choice-btn--on {
  background: var(--sp-accent-soft-strong);
  border-color: var(--sp-accent-start);
  color: var(--sp-accent-text-strong);
}

.sp-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--sp-radius-md);
  background: var(--sp-bg-base);
  border: 1px solid var(--sp-border);
}

.sp-switch-row__info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.sp-switch {
  width: 38px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid var(--sp-border-strong);
  background: var(--sp-switch-off-bg);
  padding: 2px;
  cursor: pointer;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  transition: background-color 160ms ease, border-color 160ms ease;
}

.sp-switch--on {
  background: linear-gradient(135deg, var(--sp-accent-start), var(--sp-accent-end));
  border-color: var(--sp-accent-start);
}

.sp-switch__thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.25);
  transform: translateX(0);
  transition: transform 160ms var(--sp-ease);
}

.sp-switch--on .sp-switch__thumb {
  transform: translateX(16px);
}

.sp-drawer-ft {
  padding: 10px 12px;
  border-top: 1px solid var(--sp-border);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.sp-drawer-ft__save {
  flex: 1;
}

.sp-drawer-enter-active,
.sp-drawer-leave-active {
  transition: opacity 180ms ease;
}

.sp-drawer-enter-active .sp-drawer-panel,
.sp-drawer-leave-active .sp-drawer-panel {
  transition: transform 200ms var(--sp-ease);
}

.sp-drawer-enter-from,
.sp-drawer-leave-to {
  opacity: 0;
}

.sp-drawer-enter-from .sp-drawer-panel,
.sp-drawer-leave-to .sp-drawer-panel {
  transform: translateX(100%);
}
</style>
