<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ExtensionDownloadTask, ExtensionTaskStatus } from "../protocol";
import {
  copyTextToClipboard,
  formatByteProgress,
  formatPlatformDisplayName,
  formatTransferSpeed,
  openSafeHttpTab,
} from "../uiTargetHelpers";

const props = defineProps<{
  tasks: ExtensionDownloadTask[];
  expanded: boolean;
}>();

const emit = defineEmits<{
  (e: "update:expanded", val: boolean): void;
  (e: "cancel-task", taskId: string): void;
  (e: "retry-task", taskId: string): void;
  (e: "clear-finished"): void;
  (
    e: "open-folder",
    payload: { taskId: string; chromeDownloadId?: number },
  ): void;
  (
    e: "notify",
    payload: { message: string; tone?: "success" | "error" | "info" },
  ): void;
}>();

const copiedTaskId = ref<string>("");

function isActiveStatus(status: ExtensionTaskStatus): boolean {
  return (
    status === "queued" ||
    status === "parsing" ||
    status === "downloading" ||
    status === "muxing" ||
    status === "saving"
  );
}

const activeCount = computed(
  () => props.tasks.filter((t) => isActiveStatus(t.status)).length,
);

const finishedCount = computed(
  () => props.tasks.filter((t) => !isActiveStatus(t.status)).length,
);

const failedCount = computed(
  () => props.tasks.filter((t) => t.status === "failed").length,
);

const totalSpeedLabel = computed(() => {
  const sum = props.tasks.reduce(
    (acc, t) =>
      acc + (isActiveStatus(t.status) && t.speed > 0 ? t.speed : 0),
    0,
  );
  return formatTransferSpeed(sum);
});

// Display newest / active tasks first
const sortedTasks = computed<ExtensionDownloadTask[]>(() => {
  return [...props.tasks].sort((a, b) => {
    const aAct = isActiveStatus(a.status) ? 1 : 0;
    const bAct = isActiveStatus(b.status) ? 1 : 0;
    if (aAct !== bAct) return bAct - aAct;
    return b.createdAt - a.createdAt;
  });
});

watch(
  () => props.tasks.length,
  (nextLen, prevLen) => {
    if (prevLen === 0 && nextLen > 0 && !props.expanded) {
      emit("update:expanded", true);
    }
  },
);

function formatStatusChip(task: ExtensionDownloadTask): {
  label: string;
  tone: "active" | "mux" | "done" | "err" | "muted";
} {
  switch (task.status) {
    case "queued":
      return { label: "排队中", tone: "muted" };
    case "parsing":
      return { label: "解析中", tone: "active" };
    case "downloading":
      return { label: "下载中", tone: "active" };
    case "muxing":
      return {
        label: "无损合流中",
        tone: "mux",
      };
    case "saving":
      return { label: "落盘中", tone: "active" };
    case "completed":
      return { label: "已完成", tone: "done" };
    case "failed":
      return { label: "失败", tone: "err" };
    case "cancelled":
      return { label: "已取消", tone: "muted" };
  }
}

async function handleCopyFallback(task: ExtensionDownloadTask) {
  if (!task.fallbackUrl) return;
  const ok = await copyTextToClipboard(task.fallbackUrl);
  if (ok) {
    copiedTaskId.value = task.taskId;
    setTimeout(() => {
      if (copiedTaskId.value === task.taskId) {
        copiedTaskId.value = "";
      }
    }, 1600);
    emit("notify", { message: "备用源链接已复制到剪贴板", tone: "success" });
  } else {
    emit("notify", { message: "复制失败", tone: "error" });
  }
}
</script>

<template>
  <aside
    class="sp-downloads"
    :class="{ 'sp-downloads--open': expanded && tasks.length > 0 }"
    aria-label="后台下载任务栏"
  >
    <div class="sp-downloads__bar">
      <button
        type="button"
        class="sp-downloads__toggle"
        :disabled="tasks.length === 0"
        :aria-expanded="expanded && tasks.length > 0"
        @click="tasks.length > 0 && emit('update:expanded', !expanded)"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span class="sp-downloads__title">后台任务</span>

        <span
          v-if="activeCount > 0"
          class="sp-dl-count sp-dl-count--active"
        >
          {{ activeCount }} 进行中
        </span>
        <span
          v-else-if="failedCount > 0"
          class="sp-dl-count sp-dl-count--err"
        >
          {{ failedCount }} 失败
        </span>
        <span
          v-else-if="tasks.length > 0"
          class="sp-dl-count sp-dl-count--done"
        >
          {{ tasks.length }} 已完成
        </span>
        <span v-else class="sp-downloads__idle-note sp-truncate-1">
          关闭侧边栏不断流
        </span>

        <span v-if="totalSpeedLabel" class="sp-downloads__speed">
          {{ totalSpeedLabel }}
        </span>
      </button>

      <div class="sp-downloads__bar-right">
        <button
          v-if="finishedCount > 0"
          type="button"
          class="sp-clear-btn"
          title="清除已完成、失败或已取消的记录"
          @click="emit('clear-finished')"
        >
          清空已完成
        </button>

        <button
          v-if="tasks.length > 0"
          type="button"
          class="sp-chevron-btn"
          :aria-label="expanded ? '收起任务抽屉' : '展开任务抽屉'"
          @click="emit('update:expanded', !expanded)"
        >
          <svg
            viewBox="0 0 20 20"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            :style="{
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 160ms ease',
            }"
          >
            <polyline points="5 12 10 7 15 12" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="expanded && tasks.length > 0" class="sp-downloads__list">
      <div
        v-for="task in sortedTasks"
        :key="task.taskId"
        class="sp-task"
        :class="{
          'sp-task--failed': task.status === 'failed',
          'sp-task--done': task.status === 'completed',
        }"
      >
        <div class="sp-task__row1">
          <span class="sp-task__plat">
            {{ formatPlatformDisplayName(task.platform) }}
          </span>
          <span
            v-if="task.persistedFromHistory"
            class="sp-task__history"
            data-testid="task-history-badge"
            title="从本地历史记录恢复（点击重试将重新解析最新直链）"
          >
            历史
          </span>
          <span
            class="sp-task__name sp-truncate-1"
            :title="task.filename || task.title"
          >
            {{ task.filename || task.title }}
          </span>
          <span
            class="sp-task__chip"
            :class="`sp-task__chip--${formatStatusChip(task).tone}`"
          >
            {{ formatStatusChip(task).label }}
          </span>
        </div>

        <!-- Progress Bar -->
        <div
          v-if="isActiveStatus(task.status) || task.status === 'completed'"
          class="sp-task__progress"
        >
          <div
            class="sp-task__progress-fill"
            :class="{
              'sp-task__progress-fill--indeterminate':
                isActiveStatus(task.status) &&
                task.percent <= 0 &&
                task.total <= 0,
              'sp-task__progress-fill--done': task.status === 'completed',
            }"
            :style="{
              width:
                task.status === 'completed'
                  ? '100%'
                  : `${Math.max(4, Math.min(100, Math.round(task.percent || 0)))}%`,
            }"
          />
        </div>

        <!-- Non-blocking Filename Tampering Warning (Spec B.3 §3) -->
        <div
          v-if="task.filenameWarning"
          data-testid="task-filename-warning"
          role="alert"
          class="sp-task__warning"
        >
          {{ task.filenameWarning }}
        </div>

        <!-- Meta & Speed & Actions Row -->
        <div class="sp-task__row2">
          <div class="sp-task__meta sp-truncate-1">
            <template v-if="task.status === 'failed'">
              <span class="sp-task__err-text" :title="task.error || '下载失败'">
                <template v-if="task.unwhitelistedHost">
                  域名 {{ task.unwhitelistedHost }} 未在白名单：{{ task.error || "已拦截直连" }}
                </template>
                <template v-else>
                  {{ task.error || task.statusText || "下载失败" }}
                </template>
              </span>
            </template>
            <template v-else>
              <span>{{ task.statusText }}</span>
              <span v-if="formatByteProgress(task.loaded, task.total)">
                · {{ formatByteProgress(task.loaded, task.total) }}
              </span>
              <span v-if="isActiveStatus(task.status) && formatTransferSpeed(task.speed)">
                · {{ formatTransferSpeed(task.speed) }}
              </span>
            </template>
          </div>

          <div class="sp-task__actions">
            <!-- Cancel active task -->
            <button
              v-if="isActiveStatus(task.status)"
              type="button"
              class="sp-btn sp-btn--ghost sp-btn--xs"
              @click="emit('cancel-task', task.taskId)"
            >
              取消
            </button>

            <!-- Completed -> Open Download Folder -->
            <button
              v-if="
                task.status === 'completed' &&
                typeof task.chromeDownloadId === 'number'
              "
              type="button"
              class="sp-btn sp-btn--secondary sp-btn--xs"
              title="在系统文件管理器中定位该文件"
              @click="
                emit('open-folder', {
                  taskId: task.taskId,
                  chromeDownloadId: task.chromeDownloadId,
                })
              "
            >
              打开文件夹
            </button>

            <!-- Retry Failed / Cancelled -->
            <button
              v-if="
                (task.status === 'failed' || task.status === 'cancelled') &&
                !task.unwhitelistedHost &&
                (!task.persistedFromHistory || Boolean(task.retryPayload))
              "
              type="button"
              class="sp-btn sp-btn--secondary sp-btn--xs"
              @click="emit('retry-task', task.taskId)"
            >
              重试
            </button>

            <!-- Graceful Fallback Actions for unwhitelisted CDN or failed direct transfer -->
            <template
              v-if="
                task.status === 'failed' &&
                (task.fallbackUrl || task.unwhitelistedHost)
              "
            >
              <button
                v-if="task.fallbackUrl"
                type="button"
                class="sp-btn sp-btn--ghost sp-btn--xs"
                title="在新标签页直接打开源链接另存"
                @click="openSafeHttpTab(task.fallbackUrl)"
              >
                打开源链接
              </button>
              <button
                v-if="task.fallbackUrl"
                type="button"
                class="sp-btn sp-btn--ghost sp-btn--xs"
                @click="handleCopyFallback(task)"
              >
                {{ copiedTaskId === task.taskId ? "已复制" : "复制直链" }}
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sp-downloads {
  flex-shrink: 0;
  background: var(--sp-bg-drawer-bar);
  border-top: 1px solid var(--sp-border-strong);
  box-shadow: var(--sp-shadow-drawer-bar);
  display: flex;
  flex-direction: column;
  z-index: 25;
}

.sp-downloads__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 10px;
  min-height: 36px;
  min-width: 0;
}

.sp-downloads__toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--sp-text-primary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
  text-align: left;
}

.sp-downloads__toggle:disabled {
  cursor: default;
  color: var(--sp-text-secondary);
}

.sp-downloads__title {
  white-space: nowrap;
}

.sp-downloads__idle-note {
  font-size: 11px;
  font-weight: 400;
  color: var(--sp-text-muted);
}

.sp-dl-count {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 700;
  white-space: nowrap;
}

.sp-dl-count--active {
  background: var(--sp-accent-soft-strong);
  color: var(--sp-accent-text-strong);
  border: 1px solid var(--sp-accent-border);
}

.sp-dl-count--done {
  background: var(--sp-success-soft);
  color: var(--sp-success-text);
}

.sp-dl-count--err {
  background: var(--sp-danger-soft);
  color: var(--sp-danger-text);
}

.sp-downloads__speed {
  font-family: var(--sp-font-mono);
  font-size: 10.5px;
  color: var(--sp-accent-text);
  white-space: nowrap;
}

.sp-downloads__bar-right {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.sp-clear-btn {
  border: 1px solid var(--sp-border);
  background: var(--sp-ghost-bg);
  color: var(--sp-text-secondary);
  border-radius: var(--sp-radius-xs);
  padding: 2px 7px;
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 140ms ease;
}

.sp-clear-btn:hover {
  color: var(--sp-text-primary);
  background: var(--sp-ghost-bg-hover);
  border-color: var(--sp-border-strong);
}

.sp-chevron-btn {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: none;
  background: var(--sp-ghost-bg);
  color: var(--sp-text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 140ms ease;
}

.sp-chevron-btn:hover {
  background: var(--sp-ghost-bg-hover);
  color: var(--sp-text-primary);
}

.sp-downloads__list {
  max-height: 42vh;
  overflow-y: auto;
  padding: 4px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--sp-border);
}

.sp-task {
  background: var(--sp-bg-surface);
  border: 1px solid var(--sp-border);
  border-radius: var(--sp-radius-sm);
  padding: 7px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.sp-task--failed {
  border-color: var(--sp-danger-border);
}

.sp-task__row1 {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.sp-task__plat {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--sp-muted-pill-bg);
  color: var(--sp-text-secondary);
  flex-shrink: 0;
}

.sp-task__history {
  font-size: 9.5px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--sp-accent-soft);
  color: var(--sp-accent-text);
  border: 1px solid var(--sp-accent-border);
  flex-shrink: 0;
}

.sp-task__name {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sp-text-primary);
}

.sp-task__chip {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  flex-shrink: 0;
}

.sp-task__chip--active {
  background: var(--sp-accent-soft);
  color: var(--sp-accent-text);
}

.sp-task__chip--mux {
  background: var(--sp-violet-soft);
  color: var(--sp-violet-text);
}

.sp-task__chip--done {
  background: var(--sp-success-soft);
  color: var(--sp-success-text);
}

.sp-task__chip--err {
  background: var(--sp-danger-soft);
  color: var(--sp-danger-text);
}

.sp-task__chip--muted {
  background: var(--sp-muted-pill-bg);
  color: var(--sp-text-muted);
}

.sp-task__progress {
  width: 100%;
  height: 4px;
  border-radius: 999px;
  background: var(--sp-track-bg);
  overflow: hidden;
}

.sp-task__progress-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--sp-accent-start), var(--sp-accent-end));
  transition: width 160ms linear;
}

.sp-task__progress-fill--done {
  background: var(--sp-success);
}

.sp-task__progress-fill--indeterminate {
  width: 100% !important;
  background: linear-gradient(
    90deg,
    var(--sp-accent-soft) 0%,
    var(--sp-accent-solid) 50%,
    var(--sp-accent-soft) 100%
  );
  background-size: 200% 100%;
  animation: spShimmer 1.3s linear infinite;
}

.sp-task__row2 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}

.sp-task__meta {
  flex: 1;
  min-width: 110px;
  font-size: 10.5px;
  color: var(--sp-text-muted);
}

.sp-task__err-text {
  color: var(--sp-danger-text);
  white-space: normal;
  word-break: break-word;
}

.sp-task__warning {
  font-size: 11px;
  line-height: 1.4;
  padding: 5px 8px;
  border-radius: 7px;
  background: rgba(245, 158, 11, 0.14);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: var(--sp-warning-text, #b45309);
  word-break: break-word;
}

.sp-task__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
</style>
