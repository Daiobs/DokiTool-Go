<script setup lang="ts">
import { computed } from "vue";
import {
  YOUTUBE_HELPER_CHALLENGE_LRU_CAPACITY,
  formatPercent,
  formatYouTubeHelperBadge,
  formatYouTubeHelperVariant,
  type YouTubeHelperBadgeView,
  type YouTubeHelperStatsSnapshot,
  type YouTubeHelperVariantView,
} from "../statsTypes";

const props = defineProps<{
  helper: YouTubeHelperStatsSnapshot;
}>();

type BadgeTone = YouTubeHelperBadgeView["tone"];

interface HelperStatusRow {
  field:
    | "enabled"
    | "disabled_by_config"
    | "active_player_cached"
    | "active_variant"
    | "in_cooldown";
  label: string;
  valueText: string;
  subText: string;
  isKeySub: boolean;
  tone: BadgeTone;
}

function safeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function headerBadgeToneClass(tone: BadgeTone): string {
  if (tone === "ok") return "sp-badge--saved";
  if (tone === "warn") return "sp-badge--warn";
  if (tone === "danger") return "mon-badge--danger";
  return "sp-badge--muted";
}

function valueToneTextClass(tone: "ok" | "warn" | "danger"): string {
  if (tone === "danger") return "mon-text-danger";
  if (tone === "warn") return "mon-text-warn";
  return "";
}

const statusBadge = computed<YouTubeHelperBadgeView>(() =>
  formatYouTubeHelperBadge(props.helper),
);

const variantView = computed<YouTubeHelperVariantView>(() =>
  formatYouTubeHelperVariant(props.helper.active_variant),
);

const showDegradedBanner = computed(
  () => !props.helper.disabled_by_config && variantView.value.isDegraded,
);

const showAnyBanner = computed(
  () =>
    props.helper.disabled_by_config ||
    props.helper.in_cooldown ||
    showDegradedBanner.value,
);

const refreshAttempts = computed(() => safeCount(props.helper.refresh_attempts));
const refreshSuccesses = computed(() =>
  safeCount(props.helper.refresh_successes),
);
const refreshFailures = computed(() => safeCount(props.helper.refresh_failures));
const consecutiveFailures = computed(() =>
  safeCount(props.helper.consecutive_failures),
);
const cooldownSkips = computed(() => safeCount(props.helper.cooldown_skips));

const challengeLruEntries = computed(() =>
  safeCount(props.helper.challenge_lru_entries),
);
const challengeLruHits = computed(() =>
  safeCount(props.helper.challenge_lru_hits),
);
const challengeLruMisses = computed(() =>
  safeCount(props.helper.challenge_lru_misses),
);
const challengeLruQueries = computed(
  () => challengeLruHits.value + challengeLruMisses.value,
);

const refreshSuccessRateLabel = computed(() =>
  formatPercent(refreshSuccesses.value, refreshAttempts.value, 1),
);

const lruOccupancyLabel = computed(() =>
  formatPercent(
    challengeLruEntries.value,
    YOUTUBE_HELPER_CHALLENGE_LRU_CAPACITY,
    1,
  ),
);

const lruHitRateLabel = computed(() =>
  formatPercent(challengeLruHits.value, challengeLruQueries.value, 1),
);

const lruRatioPct = computed(() => {
  if (YOUTUBE_HELPER_CHALLENGE_LRU_CAPACITY <= 0) return 0;
  const pct =
    (challengeLruEntries.value / YOUTUBE_HELPER_CHALLENGE_LRU_CAPACITY) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
});

const lruBarToneClass = computed(() => {
  if (lruRatioPct.value >= 90) return "mon-bar-fill--danger";
  if (lruRatioPct.value >= 75) return "mon-bar-fill--warn";
  return "mon-bar-fill--ok";
});

const consecutiveFailuresTone = computed<"ok" | "warn" | "danger">(() => {
  if (consecutiveFailures.value >= 3 || props.helper.in_cooldown) {
    return "danger";
  }
  if (consecutiveFailures.value > 0) return "warn";
  return "ok";
});

const refreshFailuresTone = computed<"ok" | "warn" | "danger">(() => {
  if (refreshFailures.value <= 0) return "ok";
  if (props.helper.in_cooldown || refreshSuccesses.value === 0) return "danger";
  return "warn";
});

const statusFlagRows = computed<HelperStatusRow[]>(() => {
  const h = props.helper;
  const variant = variantView.value;
  return [
    {
      field: "enabled",
      label: "助手开关",
      valueText: h.enabled ? "ON" : "OFF",
      subText: "enabled",
      isKeySub: true,
      tone: h.enabled ? "ok" : "muted",
    },
    {
      field: "disabled_by_config",
      label: "运维配置禁用",
      valueText: h.disabled_by_config ? "是（运维禁用）" : "否",
      subText: "disabled_by_config",
      isKeySub: true,
      tone: h.disabled_by_config ? "danger" : "muted",
    },
    {
      field: "active_player_cached",
      label: "Player 预热缓存",
      valueText: h.active_player_cached ? "已缓存" : "未缓存",
      subText: "active_player_cached",
      isKeySub: true,
      tone: h.active_player_cached
        ? "ok"
        : h.enabled && !h.disabled_by_config
          ? "warn"
          : "muted",
    },
    {
      field: "active_variant",
      label: "当前 Player 变体",
      valueText: variant.label,
      subText: variant.detail,
      isKeySub: false,
      tone: variant.tone,
    },
    {
      field: "in_cooldown",
      label: "刷新冷却状态",
      valueText: h.in_cooldown ? "冷却退避中" : "正常",
      subText: "in_cooldown",
      isKeySub: true,
      tone: h.in_cooldown ? (h.active_player_cached ? "warn" : "danger") : "ok",
    },
  ];
});
</script>

<template>
  <section
    class="mon-card"
    aria-label="YouTube 客户端助手遥测"
    data-testid="card-youtube-helper"
  >
    <div class="mon-card__header">
      <div class="mon-card__title-group">
        <h2 class="mon-card__title">YouTube 客户端助手遥测（只读）</h2>
        <span class="mon-card__subtitle">
          脱敏展示服务端 Player 预热、tv/main 变体降级、刷新冷却与 EJS Challenge
          LRU 命中状态（不含任何 URL 或令牌）
        </span>
      </div>
      <div class="mon-yth-badges">
        <span
          class="sp-badge"
          :class="headerBadgeToneClass(statusBadge.tone)"
          data-testid="yt-helper-status-badge"
        >
          {{ statusBadge.label }}
        </span>
        <span
          class="sp-badge mon-yth-variant-badge"
          :class="[
            headerBadgeToneClass(variantView.tone),
            variantView.isDegraded ? 'mon-yth-variant-badge--degraded' : '',
          ]"
          :data-variant="helper.active_variant"
          :title="variantView.detail"
          data-testid="yt-helper-variant-badge"
        >
          {{ variantView.label }}
        </span>
      </div>
    </div>

    <!-- Conditional status & degradation alert banners -->
    <div v-if="showAnyBanner" class="mon-yth-banners">
      <div
        v-if="helper.disabled_by_config"
        class="mon-yth-banner mon-yth-banner--danger"
        role="status"
        data-testid="yt-helper-disabled-banner"
      >
        <strong>运维配置已禁用 YouTube 客户端助手（kill-switch 生效）：</strong>
        <span>当前暂停服务端 Player 预热与 EJS Challenge 加速，相关解析请求将按回退链路处理。</span>
      </div>
      <div
        v-else-if="helper.in_cooldown"
        class="mon-yth-banner"
        :class="
          statusBadge.tone === 'danger'
            ? 'mon-yth-banner--danger'
            : 'mon-yth-banner--warn'
        "
        role="status"
        data-testid="yt-helper-cooldown-banner"
      >
        <strong>Player 刷新处于上游冷却退避中：</strong>
        <span>
          已连续失败 {{ consecutiveFailures }} 次，冷却期内已跳过刷新
          {{ cooldownSkips }} 次。
        </span>
      </div>

      <div
        v-if="showDegradedBanner"
        class="mon-yth-banner mon-yth-banner--warn"
        role="status"
        data-testid="yt-helper-degraded-banner"
      >
        <strong>Player 变体已降级回退：</strong>
        <span>
          首选 tv 变体不可用，当前回退至 {{ variantView.label }}（{{
            variantView.detail
          }}）。
        </span>
      </div>
    </div>

    <!-- Core Status & Variant Flags (5 fields) -->
    <div class="mon-yth-status-grid">
      <div
        v-for="row in statusFlagRows"
        :key="row.field"
        class="mon-yth-item"
        :class="`mon-yth-item--${row.tone}`"
        :data-yt-helper-field="row.field"
      >
        <div class="mon-yth-item__head">
          <span class="mon-yth-item__label">{{ row.label }}</span>
          <span class="mon-yth-pill" :class="`mon-yth-pill--${row.tone}`">
            {{ row.valueText }}
          </span>
        </div>
        <span :class="row.isKeySub ? 'mon-yth-item__key' : 'mon-yth-item__sub'">
          {{ row.subText }}
        </span>
      </div>
    </div>

    <!-- Refresh Counters & EJS Challenge LRU Breakdown (8 fields) -->
    <div class="mon-yth-body-grid">
      <div class="mon-yth-panel">
        <div class="mon-yth-panel__head">
          <h3 class="mon-yth-panel__title">Player 刷新与退避计数</h3>
          <span class="sp-badge sp-badge--muted">
            成功率 {{ refreshSuccessRateLabel }}
          </span>
        </div>
        <div class="mon-yth-metrics-grid">
          <div class="mon-yth-stat" data-yt-helper-field="refresh_attempts">
            <span class="mon-yth-stat__label">刷新尝试</span>
            <span class="mon-yth-stat__value">{{ refreshAttempts }}</span>
            <span class="mon-yth-stat__sub">refresh_attempts</span>
          </div>

          <div class="mon-yth-stat" data-yt-helper-field="refresh_successes">
            <span class="mon-yth-stat__label">刷新成功</span>
            <span class="mon-yth-stat__value mon-text-ok">
              {{ refreshSuccesses }}
            </span>
            <span class="mon-yth-stat__sub">
              成功率 {{ refreshSuccessRateLabel }}
            </span>
          </div>

          <div
            class="mon-yth-stat"
            :class="
              refreshFailuresTone === 'ok'
                ? ''
                : `mon-yth-stat--${refreshFailuresTone}`
            "
            data-yt-helper-field="refresh_failures"
          >
            <span class="mon-yth-stat__label">刷新失败</span>
            <span
              class="mon-yth-stat__value"
              :class="valueToneTextClass(refreshFailuresTone)"
            >
              {{ refreshFailures }}
            </span>
            <span class="mon-yth-stat__sub">refresh_failures</span>
          </div>

          <div
            class="mon-yth-stat"
            :class="
              consecutiveFailuresTone === 'ok'
                ? ''
                : `mon-yth-stat--${consecutiveFailuresTone}`
            "
            data-yt-helper-field="consecutive_failures"
          >
            <span class="mon-yth-stat__label">连续失败</span>
            <span
              class="mon-yth-stat__value"
              :class="valueToneTextClass(consecutiveFailuresTone)"
            >
              {{ consecutiveFailures }}
            </span>
            <span class="mon-yth-stat__sub">consecutive_failures</span>
          </div>

          <div class="mon-yth-stat" data-yt-helper-field="cooldown_skips">
            <span class="mon-yth-stat__label">冷却跳过</span>
            <span class="mon-yth-stat__value">{{ cooldownSkips }}</span>
            <span class="mon-yth-stat__sub">cooldown_skips</span>
          </div>
        </div>
      </div>

      <div class="mon-yth-panel">
        <div class="mon-yth-panel__head">
          <h3 class="mon-yth-panel__title">EJS Challenge LRU 缓存</h3>
          <span class="sp-badge sp-badge--accent">
            命中率 {{ lruHitRateLabel }}
          </span>
        </div>

        <div
          class="mon-yth-lru-usage"
          data-yt-helper-field="challenge_lru_entries"
        >
          <div class="mon-yth-lru-top">
            <span class="mon-yth-lru-label">缓存条目占用</span>
            <span class="mon-yth-lru-nums">
              {{ challengeLruEntries }} /
              {{ YOUTUBE_HELPER_CHALLENGE_LRU_CAPACITY }}（{{
                lruOccupancyLabel
              }}）
            </span>
          </div>
          <svg
            class="mon-pool-bar-svg"
            viewBox="0 0 100 8"
            preserveAspectRatio="none"
            aria-hidden="true"
            data-testid="yt-helper-lru-bar"
          >
            <rect class="mon-bar-track" x="0" y="0" width="100" height="8" rx="4" />
            <rect
              class="mon-bar-fill"
              :class="lruBarToneClass"
              x="0"
              y="0"
              :width="lruRatioPct"
              height="8"
              rx="4"
            />
          </svg>
        </div>

        <div class="mon-yth-lru-stats">
          <div class="mon-yth-stat" data-yt-helper-field="challenge_lru_hits">
            <span class="mon-yth-stat__label">LRU 命中</span>
            <span class="mon-yth-stat__value mon-text-ok">
              {{ challengeLruHits }}
            </span>
            <span class="mon-yth-stat__sub">命中率 {{ lruHitRateLabel }}</span>
          </div>

          <div class="mon-yth-stat" data-yt-helper-field="challenge_lru_misses">
            <span class="mon-yth-stat__label">LRU 未命中</span>
            <span class="mon-yth-stat__value">{{ challengeLruMisses }}</span>
            <span class="mon-yth-stat__sub">
              累计查询 {{ challengeLruQueries }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
