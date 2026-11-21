<script setup lang="ts">
import { computed, ref } from "vue";
import { buildSafeDownloadPath } from "../filenameSanitizer";
import type {
  ExtensionDownloadTask,
  ExtensionSettings,
  MatchedPlatformUrl,
} from "../protocol";
import { extractSupportedUrlsFromText } from "../urlMatcher";

const props = defineProps<{
  modelValue: string;
  settings: ExtensionSettings;
  tasks: ExtensionDownloadTask[];
  activeBatchGroupId: string;
  submitting: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", val: string): void;
  (e: "submit-batch", urls: string[]): void;
  (e: "retry-failed-batch", taskIds: string[]): void;
  (e: "open-settings"): void;
  (
    e: "notify",
    payload: { message: string; tone?: "success" | "error" | "info" },
  ): void;
}>();

const excludedDedupeKeys = ref<Set<string>>(new Set());

function onTextInput(event: Event) {
  const target = event.target as HTMLTextAreaElement;
  excludedDedupeKeys.value = new Set();
  emit("update:modelValue", target.value);
}

async function handlePasteClipboard() {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      const clip = (await navigator.clipboard.readText()).trim();
      if (!clip) {
        emit("notify", { message: "剪贴板为空", tone: "info" });
        return;
      }
      excludedDedupeKeys.value = new Set();
      const current = props.modelValue.trim();
      emit("update:modelValue", current ? `${current}\n${clip}` : clip);
      return;
    }
  } catch {
    // Clipboard read blocked
  }
  emit("notify", {
    message: "请直接在输入框内按 Cmd+V / Ctrl+V 粘贴",
    tone: "info",
  });
}

function handleClearText() {
  excludedDedupeKeys.value = new Set();
  emit("update:modelValue", "");
}

function removeExtractedItem(dedupeKey: string) {
  const next = new Set(excludedDedupeKeys.value);
  next.add(dedupeKey);
  excludedDedupeKeys.value = next;
}

const rawExtraction = computed(() =>
  extractSupportedUrlsFromText(props.modelValue),
);

const effectiveItems = computed<MatchedPlatformUrl[]>(() =>
  rawExtraction.value.items.filter(
    (item) => !excludedDedupeKeys.value.has(item.dedupeKey),
  ),
);

const platformCounts = computed(() => {
  const counts = new Map<string, { label: string; count: number }>();
  for (const item of effectiveItems.value) {
    const prev = counts.get(item.platform);
    if (prev) {
      prev.count += 1;
    } else {
      counts.set(item.platform, { label: item.platformLabel, count: 1 });
    }
  }
  return Array.from(counts.values());
});

const qualityLabel = computed(() => {
  if (props.settings.qualityPreference === "1080p") return "1080p 优先";
  if (props.settings.qualityPreference === "audio") return "仅音频 M4A";
  return "最高画质";
});

const sampleSavePath = computed(() =>
  buildSafeDownloadPath({
    prefix: props.settings.subfolderPrefix,
    subfolder: "各作品标题",
    index: 1,
    ext: "mp4",
  }),
);

// Track batch tasks belonging to activeBatchGroupId (or most recent groupBatchId)
const trackedBatchTasks = computed<ExtensionDownloadTask[]>(() => {
  if (props.activeBatchGroupId) {
    return props.tasks.filter(
      (t) => t.groupBatchId === props.activeBatchGroupId,
    );
  }
  const latestBatchTask = props.tasks.find((t) =>
    Boolean(t.groupBatchId?.startsWith("batch-")),
  );
  if (!latestBatchTask?.groupBatchId) return [];
  return props.tasks.filter(
    (t) => t.groupBatchId === latestBatchTask.groupBatchId,
  );
});

const batchSummary = computed(() => {
  const list = trackedBatchTasks.value;
  const total = list.length;
  let active = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const t of list) {
    if (t.status === "completed") completed++;
    else if (t.status === "failed") failed++;
    else if (t.status === "cancelled") cancelled++;
    else active++;
  }
  const donePercent =
    total > 0 ? Math.round(((completed + failed + cancelled) / total) * 100) : 0;
  return { total, active, completed, failed, cancelled, donePercent };
});

const failedBatchTaskIds = computed(() =>
  trackedBatchTasks.value
    .filter((t) => t.status === "failed")
    .map((t) => t.taskId),
);

function handleDispatchBatch() {
  if (!effectiveItems.value.length || props.submitting) return;
  emit(
    "submit-batch",
    effectiveItems.value.map((item) => item.url),
  );
}

function handleRetryFailed() {
  if (!failedBatchTaskIds.value.length) return;
  emit("retry-failed-batch", failedBatchTaskIds.value);
}
</script>

<template>
  <section class="sp-batch">
    <!-- Input Card -->
    <div class="sp-batch-card">
      <div class="sp-batch-card__hd">
        <span class="sp-batch-card__title">多链接 / 分享文案批量提取</span>
        <div class="sp-batch-card__tools">
          <button
            type="button"
            class="sp-btn sp-btn--ghost sp-btn--xs"
            @click="handlePasteClipboard"
          >
            粘贴剪贴板
          </button>
          <button
            v-if="modelValue"
            type="button"
            class="sp-btn sp-btn--ghost sp-btn--xs"
            @click="handleClearText"
          >
            清空
          </button>
        </div>
      </div>

      <textarea
        :value="modelValue"
        rows="5"
        class="sp-textarea sp-batch-textarea"
        placeholder="粘贴整段分享口令或多行链接（支持抖音/小红书/B站/微博/YouTube/X/快手等 14 平台混贴，本地自动去重并忽略无关文字）..."
        @input="onTextInput"
      />

      <!-- Live Extraction Stats & Platform Pills -->
      <div class="sp-batch-stats">
        <div class="sp-batch-stats__row">
          <span class="sp-badge sp-badge--accent">
            识别有效链接 {{ effectiveItems.length }} 条
          </span>
          <span
            v-if="rawExtraction.duplicateCount > 0"
            class="sp-badge sp-badge--muted"
          >
            已去重 {{ rawExtraction.duplicateCount }} 条
          </span>
          <span
            v-if="rawExtraction.ignoredLineCount > 0"
            class="sp-badge sp-badge--muted"
            title="非支持平台域名或纯文字说明已在本地过滤，绝不外发"
          >
            已忽略 {{ rawExtraction.ignoredLineCount }} 行无关内容
          </span>
        </div>

        <div v-if="platformCounts.length > 0" class="sp-batch-platforms">
          <span
            v-for="plat in platformCounts"
            :key="plat.label"
            class="sp-plat-pill"
          >
            {{ plat.label }} ×{{ plat.count }}
          </span>
        </div>
      </div>

      <!-- Compact Extracted URL Preview List -->
      <div v-if="effectiveItems.length > 0" class="sp-extracted-list">
        <div
          v-for="(item, idx) in effectiveItems"
          :key="item.dedupeKey"
          class="sp-extracted-row"
        >
          <span class="sp-extracted-row__idx">
            {{ String(idx + 1).padStart(2, "0") }}
          </span>
          <span class="sp-extracted-row__plat">{{ item.platformLabel }}</span>
          <span class="sp-extracted-row__url sp-truncate-1" :title="item.url">
            {{ item.url }}
          </span>
          <button
            type="button"
            class="sp-extracted-row__rm"
            title="从本次队列移除"
            aria-label="移除此链接"
            @click="removeExtractedItem(item.dedupeKey)"
          >
            ✕
          </button>
        </div>
      </div>

      <!-- Active Preference Hint -->
      <div class="sp-pref-hint">
        <span class="sp-pref-hint__text sp-truncate-1" :title="`Downloads/${sampleSavePath}`">
          策略：{{ qualityLabel }} · 落盘至 Downloads/{{ sampleSavePath }}
        </span>
        <button
          type="button"
          class="sp-pref-hint__edit"
          @click="emit('open-settings')"
        >
          修改偏好
        </button>
      </div>

      <!-- Primary One-Click Enqueue CTA -->
      <button
        type="button"
        class="sp-btn sp-btn--primary sp-batch-submit"
        :disabled="effectiveItems.length === 0 || submitting"
        @click="handleDispatchBatch"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span>
          {{
            submitting
              ? "正在提交批量队列..."
              : `全部解析并按偏好下载 (${effectiveItems.length})`
          }}
        </span>
      </button>
    </div>

    <!-- Live Batch Queue Summary & One-Click Retry Failed -->
    <div v-if="batchSummary.total > 0" class="sp-batch-card sp-batch-summary">
      <div class="sp-batch-summary__hd">
        <span class="sp-batch-card__title">当前批次进度</span>
        <span class="sp-batch-summary__nums">
          进行中 {{ batchSummary.active }} · 完成 {{ batchSummary.completed }} · 失败 {{ batchSummary.failed }}
        </span>
      </div>

      <div class="sp-batch-progress">
        <div
          class="sp-batch-progress__bar"
          :style="{ width: `${batchSummary.donePercent}%` }"
        />
      </div>

      <div v-if="failedBatchTaskIds.length > 0" class="sp-batch-summary__retry">
        <span class="sp-batch-summary__err-note">
          单条失败不影响其余任务继续落盘
        </span>
        <button
          type="button"
          class="sp-btn sp-btn--danger-ghost sp-btn--sm"
          @click="handleRetryFailed"
        >
          一键重试失败项 ({{ failedBatchTaskIds.length }})
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sp-batch {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.sp-batch-card {
  background: var(--sp-bg-surface);
  border: 1px solid var(--sp-border);
  border-radius: var(--sp-radius-lg);
  box-shadow: var(--sp-shadow-card);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.sp-batch-card__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.sp-batch-card__title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--sp-text-primary);
}

.sp-batch-card__tools {
  display: flex;
  align-items: center;
  gap: 5px;
}

.sp-batch-textarea {
  resize: vertical;
  min-height: 98px;
  max-height: 210px;
  font-size: 12px;
  line-height: 1.45;
}

.sp-batch-stats {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sp-batch-stats__row {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.sp-batch-platforms {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.sp-plat-pill {
  padding: 1.5px 6px;
  border-radius: 5px;
  background: var(--sp-accent-soft);
  border: 1px solid var(--sp-accent-border);
  color: var(--sp-accent-text-strong);
  font-size: 10.5px;
  font-weight: 600;
}

.sp-extracted-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 150px;
  overflow-y: auto;
  padding-right: 2px;
}

.sp-extracted-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 6px;
  border-radius: var(--sp-radius-xs);
  background: var(--sp-bg-base);
  border: 1px solid var(--sp-border);
  min-width: 0;
}

.sp-extracted-row__idx {
  font-family: var(--sp-font-mono);
  font-size: 10px;
  color: var(--sp-text-muted);
  flex-shrink: 0;
}

.sp-extracted-row__plat {
  font-size: 10px;
  font-weight: 600;
  color: var(--sp-accent-text);
  background: var(--sp-accent-soft);
  padding: 1px 5px;
  border-radius: 4px;
  flex-shrink: 0;
}

.sp-extracted-row__url {
  flex: 1;
  min-width: 0;
  font-family: var(--sp-font-mono);
  font-size: 10.5px;
  color: var(--sp-text-secondary);
}

.sp-extracted-row__rm {
  border: none;
  background: transparent;
  color: var(--sp-text-muted);
  font-size: 10.5px;
  padding: 2px 4px;
  cursor: pointer;
  flex-shrink: 0;
}

.sp-extracted-row__rm:hover {
  color: var(--sp-danger-text);
}

.sp-pref-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--sp-radius-sm);
  background: var(--sp-subtle-bg);
  border: 1px dashed var(--sp-border-strong);
  min-width: 0;
}

.sp-pref-hint__text {
  font-size: 11px;
  color: var(--sp-text-secondary);
  min-width: 0;
}

.sp-pref-hint__edit {
  border: none;
  background: transparent;
  color: var(--sp-accent-text);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
}

.sp-pref-hint__edit:hover {
  text-decoration: underline;
}

.sp-batch-submit {
  width: 100%;
}

.sp-batch-summary__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex-wrap: wrap;
}

.sp-batch-summary__nums {
  font-family: var(--sp-font-mono);
  font-size: 11px;
  color: var(--sp-text-secondary);
}

.sp-batch-progress {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: var(--sp-track-bg);
  overflow: hidden;
}

.sp-batch-progress__bar {
  height: 100%;
  background: linear-gradient(90deg, var(--sp-accent-start), var(--sp-success));
  border-radius: 999px;
  transition: width 220ms ease;
}

.sp-batch-summary__retry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 2px;
}

.sp-batch-summary__err-note {
  font-size: 11px;
  color: var(--sp-text-muted);
}
</style>
