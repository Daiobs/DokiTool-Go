<script setup lang="ts">
import { computed } from "vue";
import {
  formatCircuitBreakerBadge,
  formatShanghaiTimestamp,
  formatStatsPlatformLabel,
  type CircuitBreakerBadgeView,
  type CircuitBreakerPlatformSnapshot,
  type RuntimePolicySummary,
} from "../statsTypes";

const props = defineProps<{
  circuitBreakers?: CircuitBreakerPlatformSnapshot[];
  genericCircuitBreaker?: CircuitBreakerPlatformSnapshot;
  runtimePolicy?: RuntimePolicySummary;
}>();

interface CircuitBreakerRow {
  platform: string;
  label: string;
  state: "closed" | "open" | "half_open";
  disabledByConfig: boolean;
  badge: CircuitBreakerBadgeView;
  consecutiveFailures: number;
  windowFailures: number;
  windowTotal: number;
  openUntilLabel: string;
}

interface RuntimePolicyRow {
  key: string;
  label: string;
  valueText: string;
  subText?: string;
  tone: "on" | "off" | "accent" | "warn" | "danger";
}

function toCircuitBreakerRow(
  item: CircuitBreakerPlatformSnapshot,
): CircuitBreakerRow {
  return {
    platform: item.platform,
    label: formatStatsPlatformLabel(item.platform),
    state: item.state,
    disabledByConfig: Boolean(item.disabled_by_config),
    badge: formatCircuitBreakerBadge(item),
    consecutiveFailures: Math.max(0, item.consecutive_failures || 0),
    windowFailures: Math.max(0, item.window_failures || 0),
    windowTotal: Math.max(0, item.window_total || 0),
    openUntilLabel: formatShanghaiTimestamp(item.open_until),
  };
}

function summaryBadgeToneClass(tone: CircuitBreakerBadgeView["tone"]): string {
  if (tone === "danger") return "mon-badge--danger";
  if (tone === "warn") return "sp-badge--warn";
  return "sp-badge--saved";
}

const circuitBreakerRows = computed<CircuitBreakerRow[]>(() => {
  const list = props.circuitBreakers;
  if (!Array.isArray(list) || list.length === 0) return [];
  return list.map(toCircuitBreakerRow);
});

const genericBreakerRow = computed<CircuitBreakerRow | null>(() => {
  if (!props.genericCircuitBreaker) return null;
  return toCircuitBreakerRow(props.genericCircuitBreaker);
});

const circuitBreakerSummary = computed(() => {
  const rows = circuitBreakerRows.value;
  let open = 0;
  let halfOpen = 0;
  let ok = 0;
  for (const row of rows) {
    if (row.disabledByConfig || row.state === "open") open += 1;
    else if (row.state === "half_open") halfOpen += 1;
    else ok += 1;
  }
  return { total: rows.length, ok, halfOpen, open };
});

const runtimePolicyRows = computed<RuntimePolicyRow[]>(() => {
  const p = props.runtimePolicy;
  if (!p) return [];
  const disabledList = Array.isArray(p.disabled_platforms)
    ? p.disabled_platforms
    : [];
  const disabledDisplay =
    disabledList.length > 0
      ? disabledList.map((id) => formatStatsPlatformLabel(id)).join("、")
      : "无";
  const reloadedAt = formatShanghaiTimestamp(p.last_reloaded_at);
  return [
    {
      key: "config_file_active",
      label: "热配置来源",
      valueText: p.config_file_active ? "热配置文件 (SIGHUP)" : "环境变量默认",
      tone: p.config_file_active ? "on" : "off",
    },
    {
      key: "reload_count",
      label: "热重载次数",
      valueText: `${Math.max(0, p.reload_count || 0)} 次`,
      subText: reloadedAt ? `最近：${reloadedAt}` : "启动后尚未重载",
      tone: p.reload_count > 0 ? "accent" : "off",
    },
    {
      key: "compartment_slots",
      label: "分舱槽位配额",
      valueText: `YT ${p.youtube_slots} · 社交 ${p.social_slots} · 通用 ${p.generic_slots} · EJS ${p.youtube_ejs_concurrency}`,
      tone: "accent",
    },
    {
      key: "fast_per_platform_max_concurrency",
      label: "单平台快池上限",
      valueText: `${p.fast_per_platform_max_concurrency} 并发`,
      tone: "accent",
    },
    {
      key: "circuit_breaker_enabled",
      label: "平台熔断保护",
      valueText: p.circuit_breaker_enabled ? "ON" : "OFF",
      tone: p.circuit_breaker_enabled ? "on" : "warn",
    },
    {
      key: "disabled_platforms",
      label: "运维禁用平台",
      valueText: disabledDisplay,
      tone: disabledList.length > 0 ? "danger" : "off",
    },
    {
      key: "youtube_parse_ttl_seconds",
      label: "YouTube 解析缓存 TTL",
      valueText:
        p.youtube_parse_ttl_seconds > 0
          ? `${p.youtube_parse_ttl_seconds}s`
          : "0s (已关闭)",
      tone: p.youtube_parse_ttl_seconds > 0 ? "on" : "off",
    },
    {
      key: "stale_if_error_ttl_seconds",
      label: "过期兜底缓存 TTL",
      valueText:
        p.stale_if_error_ttl_seconds > 0
          ? `${p.stale_if_error_ttl_seconds}s`
          : "0s (已关闭)",
      tone: p.stale_if_error_ttl_seconds > 0 ? "on" : "off",
    },
    {
      key: "upstream_blocked_neg_ttl_seconds",
      label: "拦截短负缓存 TTL",
      valueText: `${Math.max(0, p.upstream_blocked_neg_ttl_seconds || 0)}s`,
      tone: p.upstream_blocked_neg_ttl_seconds > 0 ? "accent" : "off",
    },
  ];
});
</script>

<template>
  <section
    v-if="
      circuitBreakerRows.length > 0 ||
      genericBreakerRow !== null ||
      runtimePolicyRows.length > 0
    "
    class="mon-split-grid"
    aria-label="平台熔断状态与运行时热策略摘要"
    data-testid="section-protection-policy"
  >
    <!-- Read-Only Circuit Breaker Status Grid (16 Core + Dedicated Tier-2 Generic) -->
    <article
      v-if="circuitBreakerRows.length > 0 || genericBreakerRow !== null"
      class="mon-card"
      data-testid="card-circuit-breakers"
    >
      <div class="mon-card__header">
        <div class="mon-card__title-group">
          <h2 class="mon-card__title">平台熔断状态（只读）</h2>
          <span class="mon-card__subtitle">
            仅实时展示 16 核心平台及长尾链路的上游故障保护状态，公网零写接口
          </span>
        </div>
        <div class="mon-cb-summary">
          <template v-if="circuitBreakerRows.length > 0">
            <span class="sp-badge sp-badge--saved">
              正常 {{ circuitBreakerSummary.ok }}
            </span>
            <span
              v-if="circuitBreakerSummary.halfOpen > 0"
              class="sp-badge sp-badge--warn"
            >
              半开 {{ circuitBreakerSummary.halfOpen }}
            </span>
            <span
              v-if="circuitBreakerSummary.open > 0"
              class="sp-badge mon-badge--danger"
            >
              熔断 {{ circuitBreakerSummary.open }}
            </span>
          </template>
          <span
            v-if="genericBreakerRow"
            class="sp-badge"
            :class="summaryBadgeToneClass(genericBreakerRow.badge.tone)"
            data-testid="generic-cb-summary-badge"
          >
            长尾：{{ genericBreakerRow.badge.label }}
          </span>
        </div>
      </div>

      <div
        v-if="circuitBreakerRows.length > 0"
        class="mon-cb-grid"
        data-testid="circuit-breakers-grid"
      >
        <div
          v-for="cb in circuitBreakerRows"
          :key="cb.platform"
          class="mon-cb-item"
          :class="`mon-cb-item--${cb.badge.tone}`"
          data-testid="circuit-breaker-item"
          :data-platform="cb.platform"
          :data-cb-state="cb.state"
        >
          <div class="mon-cb-item__top">
            <div class="mon-cb-item__title">
              <span class="mon-cb-item__name">{{ cb.label }}</span>
              <span class="mon-cb-item__id">{{ cb.platform }}</span>
            </div>
            <span
              class="mon-cb-pill"
              :class="`mon-cb-pill--${cb.badge.tone}`"
              data-testid="circuit-breaker-badge"
            >
              {{ cb.badge.label }}
            </span>
          </div>
          <div class="mon-cb-item__meta">
            <span>连续失败 {{ cb.consecutiveFailures }}</span>
            <span>窗口 {{ cb.windowFailures }}/{{ cb.windowTotal }}</span>
            <span v-if="cb.openUntilLabel">恢复 {{ cb.openUntilLabel }}</span>
          </div>
        </div>
      </div>

      <!-- Guardrail G3: Dedicated Tier-2 Generic Circuit Breaker Subsection -->
      <div
        v-if="genericBreakerRow"
        class="mon-cb-generic-wrap"
        data-testid="generic-circuit-breaker-section"
      >
        <div class="mon-cb-generic-head">
          <h3 class="mon-cb-generic-title">通用长尾独立熔断器（Tier-2）</h3>
          <span class="sp-badge sp-badge--muted">独立隔离链路</span>
        </div>
        <div
          class="mon-cb-item mon-cb-generic-item"
          :class="`mon-cb-item--${genericBreakerRow.badge.tone}`"
          data-testid="generic-circuit-breaker-item"
          :data-platform="genericBreakerRow.platform"
          :data-cb-state="genericBreakerRow.state"
        >
          <div class="mon-cb-item__top">
            <div class="mon-cb-item__title">
              <span class="mon-cb-item__name">{{ genericBreakerRow.label }}</span>
              <span class="mon-cb-item__id">{{ genericBreakerRow.platform }}</span>
            </div>
            <span
              class="mon-cb-pill"
              :class="`mon-cb-pill--${genericBreakerRow.badge.tone}`"
              data-testid="generic-circuit-breaker-badge"
            >
              {{ genericBreakerRow.badge.label }}
            </span>
          </div>
          <div class="mon-cb-item__meta">
            <span>连续失败 {{ genericBreakerRow.consecutiveFailures }}</span>
            <span>
              窗口 {{ genericBreakerRow.windowFailures }}/{{
                genericBreakerRow.windowTotal
              }}
            </span>
            <span v-if="genericBreakerRow.openUntilLabel">
              恢复 {{ genericBreakerRow.openUntilLabel }}
            </span>
          </div>
        </div>
      </div>
    </article>

    <!-- Read-Only Runtime Policy Summary -->
    <article
      v-if="runtimePolicyRows.length > 0"
      class="mon-card"
      data-testid="card-runtime-policy"
    >
      <div class="mon-card__header">
        <div class="mon-card__title-group">
          <h2 class="mon-card__title">运行时热策略摘要（只读）</h2>
          <span class="mon-card__subtitle">
            仅展示当前内存生效的 SIGHUP 热配置槽位与缓存 TTL，不暴露文件路径或密钥
          </span>
        </div>
        <span
          class="sp-badge"
          :class="
            props.runtimePolicy?.config_file_active
              ? 'sp-badge--saved'
              : 'sp-badge--muted'
          "
        >
          {{
            props.runtimePolicy?.config_file_active ? "热配置已激活" : "默认策略"
          }}
        </span>
      </div>

      <div class="mon-policy-grid" data-testid="runtime-policy-grid">
        <div
          v-for="item in runtimePolicyRows"
          :key="item.key"
          class="mon-policy-item"
          :data-policy-key="item.key"
        >
          <div class="mon-policy-item__head">
            <span class="mon-policy-item__label">{{ item.label }}</span>
            <span
              class="mon-policy-pill"
              :class="`mon-policy-pill--${item.tone}`"
            >
              {{ item.valueText }}
            </span>
          </div>
          <span v-if="item.subText" class="mon-policy-item__sub">
            {{ item.subText }}
          </span>
        </div>
      </div>
    </article>
  </section>
</template>
