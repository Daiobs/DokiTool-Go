<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  applyMonitorTheme,
  clearStoredOwnerToken,
  copyTextToClipboard,
  fetchSameOriginOwnerStats,
  getNextMonitorTheme,
  readMonitorAutoRefresh,
  readMonitorTheme,
  readStoredOwnerToken,
  saveOwnerToken,
  stripUrlQueryAndHash,
  validateOwnerBearerToken,
  writeMonitorAutoRefresh,
  writeMonitorTheme,
  type MonitorThemeMode,
  type OwnerTokenSource,
} from "./monitorStorage";
import {
  aggregatePlatformHealth,
  buildDailyChartPoints,
  buildHourlyChartPoints,
  computeTodayVsYesterday,
  formatBytesCompact,
  formatCircuitBreakerBadge,
  formatMonitorVersionBadge,
  formatPercent,
  formatShanghaiTimestamp,
  formatStatsPlatformLabel,
  formatUptimeDuration,
  resolveYtdlpQueuedCount,
  type AdmissionPoolSnapshot,
  type CircuitBreakerBadgeView,
  type DailyChartPoint,
  type HourlyChartPoint,
  type MonitorVersionBadge,
  type PlatformHealthRange,
  type PlatformHealthRow,
  type StatsSnapshot,
  type YTDLPCompartmentPoolSnapshot,
  type YTDLPStatsSnapshot,
} from "./statsTypes";

// ============================================================================
// Constants & Types
// ============================================================================

const AUTO_REFRESH_INTERVAL_MS = 30_000;

type PlatformSortKey =
  | "platform"
  | "total"
  | "ok"
  | "failed"
  | "successRate"
  | "effectiveSuccessRate"
  | "p95Ms";

interface RuntimeSwitchRow {
  key: string;
  label: string;
  valueText: string;
  fullValue?: string;
  copyable?: boolean;
  tone: "on" | "off" | "accent";
}

interface PoolWatermarkRow {
  id: string;
  label: string;
  kind: "admission" | "slot";
  kindLabel: string;
  active: number;
  limit: number;
  queued: number;
  queueLimit: number | null;
  ratioPct: number;
  tone: "normal" | "warn" | "danger";
  footSummary: string;
}

interface CompartmentPoolRow {
  id: "youtube" | "social" | "generic" | "youtube_ejs";
  label: string;
  enabled: boolean;
  active: number;
  limit: number;
  queued: number;
  queueLimit: number;
  ratioPct: number;
  tone: "normal" | "warn" | "danger";
  footSummary: string;
}

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

const HEALTH_RANGE_OPTIONS: ReadonlyArray<{
  key: PlatformHealthRange;
  label: string;
}> = [
  { key: "today", label: "今日" },
  { key: "yesterday", label: "昨日" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "since_start", label: "启动以来" },
];

const ZERO_ADMISSION_POOL: AdmissionPoolSnapshot = {
  active: 0,
  queued: 0,
  concurrency_limit: 0,
  queue_limit: 0,
  waited: 0,
  granted: 0,
  timeout: 0,
  full: 0,
  canceled: 0,
  wait_ms_total: 0,
  wait_ms_max: 0,
};

const ZERO_YTDLP_POOL: Pick<
  YTDLPStatsSnapshot,
  "active" | "concurrency_limit" | "waiting" | "queued"
> & {
  total?: { acquired_count?: number; wait_count?: number; wait_ms_max?: number };
} = {
  active: 0,
  concurrency_limit: 0,
  waiting: 0,
  total: { acquired_count: 0, wait_count: 0, wait_ms_max: 0 },
};

// ============================================================================
// Core Auth, Theme & Snapshot State
// ============================================================================

const currentTheme = ref<MonitorThemeMode>(readMonitorTheme());
const stats = ref<StatsSnapshot | null>(null);
const lastFetchedAt = ref<number | null>(null);
const initialLoading = ref<boolean>(false);
const refreshing = ref<boolean>(false);
const staleError = ref<string>("");

// Owner unlock form state (never persisted until 200 OK)
let activeToken = "";
const tokenSource = ref<OwnerTokenSource>(null);
const tokenInput = ref<string>("");
const showToken = ref<boolean>(false);
const rememberDevice = ref<boolean>(false);
const submitting = ref<boolean>(false);
const authError = ref<string>("");

// Auto-refresh (optional 30s toggle, persisted in localStorage, pauses on hidden tab & refreshes on return)
const autoRefreshEnabled = ref<boolean>(false);
const pausedByVisibility = ref<boolean>(false);
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let fetchGeneration = 0;

// Version copy feedback state
const copiedVersionSource = ref<"kpi" | "matrix" | null>(null);
let copiedVersionTimer: ReturnType<typeof setTimeout> | null = null;

// Chart state
const dailyChartDays = ref<7 | 30>(7);
const hoveredDailyIndex = ref<number | null>(null);
const hoveredHourlyIndex = ref<number | null>(null);

// Platform Health table state
const healthRange = ref<PlatformHealthRange>("today");
const sortKey = ref<PlatformSortKey>("total");
const sortDir = ref<"asc" | "desc">("desc");

// ============================================================================
// Derived Metrics & View Models
// ============================================================================

const currentOrigin = computed<string>(() => {
  if (
    typeof window !== "undefined" &&
    window.location?.origin &&
    window.location.origin !== "null"
  ) {
    return window.location.origin;
  }
  return "同源站点";
});

const themeButtonLabel = computed<string>(() => {
  if (currentTheme.value === "light") return "浅色";
  if (currentTheme.value === "dark") return "深色";
  return "跟随系统";
});

const credentialSourceLabel = computed<string>(() =>
  tokenSource.value === "local" ? "本机已记住" : "会话级凭据",
);

const formattedFetchedTime = computed<string>(() => {
  if (!lastFetchedAt.value) return "尚未同步";
  const d = new Date(lastFetchedAt.value + 8 * 3_600_000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} (UTC+8)`;
});

const todaySummary = computed(() =>
  stats.value ? computeTodayVsYesterday(stats.value) : null,
);

const effectiveSuccessRateText = computed<string>(() => {
  const s = todaySummary.value;
  if (!s || s.effectiveSuccessRate === null) return "—";
  return `${s.effectiveSuccessRate.toFixed(1)}%`;
});

const todayDeltaTotalText = computed<string>(() => {
  const s = todaySummary.value;
  if (!s || !s.yesterdayDate) return "较昨日 —";
  if (s.deltaTotal > 0) return `较昨日 +${s.deltaTotal}`;
  if (s.deltaTotal < 0) return `较昨日 ${s.deltaTotal}`;
  return "较昨日持平";
});

const todayDeltaTotalTone = computed<"up" | "down" | "flat">(() => {
  const s = todaySummary.value;
  if (!s || !s.yesterdayDate || s.deltaTotal === 0) return "flat";
  return s.deltaTotal > 0 ? "up" : "down";
});

const todayDeltaRateText = computed<string>(() => {
  const s = todaySummary.value;
  if (!s || s.deltaRatePct === null) return "成功率变化 —";
  const sign = s.deltaRatePct > 0 ? "+" : "";
  return `较昨日 ${sign}${s.deltaRatePct.toFixed(1)}pp`;
});

const todayDeltaRateTone = computed<"up" | "down" | "flat">(() => {
  const s = todaySummary.value;
  if (!s || s.deltaRatePct === null || s.deltaRatePct === 0) return "flat";
  return s.deltaRatePct > 0 ? "up" : "down";
});

const cacheHitRateText = computed<string>(() => {
  const c = stats.value?.cache?.total;
  if (!c) return "—";
  return formatPercent(c.hits, c.hits + c.misses, 1);
});

const cacheStaleHits = computed<number>(() => {
  const raw = stats.value?.cache?.total?.stale_hits;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : 0;
});

const shanghaiHitRateText = computed<string>(() => {
  const sh = stats.value?.shanghai?.total;
  if (!sh) return "—";
  return formatPercent(sh.hits, sh.hits + sh.fallbacks, 1);
});

const shanghaiModeLabel = computed<string>(() => {
  const mode =
    stats.value?.shanghai?.mode || stats.value?.runtime?.shanghai_mode || "off";
  if (mode === "pull") return "Pull 拉取模式";
  if (mode === "direct") return "Direct 直连模式";
  return "未启用 (off)";
});

const shanghaiPlatformBreakdown = computed(() => {
  const byPlat = stats.value?.shanghai?.by_platform;
  const safeCount = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  return {
    douyinHits: safeCount(byPlat?.douyin?.hits),
    douyinFallbacks: safeCount(byPlat?.douyin?.fallbacks),
    bilibiliHits: safeCount(byPlat?.bilibili?.hits),
    bilibiliFallbacks: safeCount(byPlat?.bilibili?.fallbacks),
  };
});

const versionInfo = computed<MonitorVersionBadge>(() =>
  formatMonitorVersionBadge(stats.value?.runtime?.version),
);

const uptimeText = computed<string>(() =>
  stats.value ? formatUptimeDuration(stats.value.uptime_seconds) : "—",
);

const runtimeSwitches = computed<RuntimeSwitchRow[]>(() => {
  const rt = stats.value?.runtime;
  if (!rt) return [];
  const ver = versionInfo.value;
  return [
    {
      key: "version",
      label: "后端版本",
      valueText: ver.display,
      fullValue: ver.full,
      copyable: true,
      tone: "accent",
    },
    {
      key: "shanghai_mode",
      label: "上海出口模式",
      valueText: rt.shanghai_mode || "off",
      tone: rt.shanghai_mode && rt.shanghai_mode !== "off" ? "on" : "off",
    },
    {
      key: "shanghai_bilibili",
      label: "上海 B 站代理",
      valueText: rt.shanghai_bilibili ? "ON" : "OFF",
      tone: rt.shanghai_bilibili ? "on" : "off",
    },
    {
      key: "bilibili_dash",
      label: "B 站 DASH 合流",
      valueText: rt.bilibili_dash ? "ON" : "OFF",
      tone: rt.bilibili_dash ? "on" : "off",
    },
    {
      key: "youtube_helper",
      label: "YouTube 客户端助手",
      valueText: rt.youtube_helper ? "ON" : "OFF",
      tone: rt.youtube_helper ? "on" : "off",
    },
    {
      key: "xhs_transport",
      label: "小红书传输栈",
      valueText: rt.xhs_transport || "standard",
      tone: rt.xhs_transport === "chrome131" ? "accent" : "off",
    },
    {
      key: "ytdlp_enabled",
      label: "yt-dlp 引擎",
      valueText: rt.ytdlp_enabled ? "ON" : "OFF",
      tone: rt.ytdlp_enabled ? "on" : "off",
    },
    {
      key: "ytdlp_generic_enabled",
      label: "yt-dlp 通用长尾",
      valueText: rt.ytdlp_generic_enabled ? "ON" : "OFF",
      tone: rt.ytdlp_generic_enabled ? "on" : "off",
    },
    {
      key: "tbvideo_pipigx",
      label: "皮皮搞笑省流直链",
      valueText: rt.tbvideo_pipigx ? "ON" : "OFF",
      tone: rt.tbvideo_pipigx ? "on" : "off",
    },
    {
      key: "tbvideo_zuiyou",
      label: "最右省流直链",
      valueText: rt.tbvideo_zuiyou ? "ON" : "OFF",
      tone: rt.tbvideo_zuiyou ? "on" : "off",
    },
    {
      key: "stats_persistence_enabled",
      label: "统计原子落盘",
      valueText: rt.stats_persistence_enabled ? "ON" : "OFF",
      tone: rt.stats_persistence_enabled ? "on" : "off",
    },
  ];
});

function buildPoolWatermarkTone(ratioPct: number): "normal" | "warn" | "danger" {
  if (ratioPct >= 90) return "danger";
  if (ratioPct >= 70) return "warn";
  return "normal";
}

const concurrencyPools = computed<PoolWatermarkRow[]>(() => {
  const s = stats.value;
  if (!s) return [];

  const makeAdmissionRow = (
    id: string,
    label: string,
    pool?: AdmissionPoolSnapshot,
  ): PoolWatermarkRow => {
    const safePool = pool ?? ZERO_ADMISSION_POOL;
    const limit = Math.max(0, safePool.concurrency_limit || 0);
    const active = Math.max(0, safePool.active || 0);
    const ratioPct =
      limit > 0 ? Math.min(100, Math.round((active / limit) * 100)) : 0;
    return {
      id,
      label,
      kind: "admission",
      kindLabel: "排队放行",
      active,
      limit,
      queued: Math.max(0, safePool.queued || 0),
      queueLimit: Math.max(0, safePool.queue_limit || 0),
      ratioPct,
      tone: buildPoolWatermarkTone(ratioPct),
      footSummary: `排队放行 · 本次启动等待 ${safePool.waited ?? 0} · 放行 ${safePool.granted ?? 0} · 超时 ${safePool.timeout ?? 0} · 满载 ${safePool.full ?? 0}`,
    };
  };

  const makeYtdlpRow = (
    id: string,
    label: string,
    slot?: YTDLPStatsSnapshot,
  ): PoolWatermarkRow => {
    const safeSlot = slot ?? ZERO_YTDLP_POOL;
    const limit = Math.max(0, safeSlot.concurrency_limit || 0);
    const active = Math.max(0, safeSlot.active || 0);
    const queued = resolveYtdlpQueuedCount(slot ?? (ZERO_YTDLP_POOL as YTDLPStatsSnapshot));
    const ratioPct =
      limit > 0 ? Math.min(100, Math.round((active / limit) * 100)) : 0;
    return {
      id,
      label,
      kind: "slot",
      kindLabel: "共享总网关槽位",
      active,
      limit,
      queued,
      queueLimit: null,
      ratioPct,
      tone: buildPoolWatermarkTone(ratioPct),
      footSummary: `共享总网关槽位 · 本次启动获取 ${safeSlot.total?.acquired_count ?? 0} · 等待 ${safeSlot.total?.wait_count ?? 0} · 最大等待 ${safeSlot.total?.wait_ms_max ?? 0} ms`,
    };
  };

  return [
    makeAdmissionRow("fast", "快速池 (fast)", s.admission.fast),
    makeAdmissionRow("slow", "慢速池 (slow)", s.admission.slow),
    makeAdmissionRow(
      "generic_slow",
      "通用长尾慢池 (generic_slow)",
      s.admission.generic_slow,
    ),
    makeAdmissionRow("owner", "Owner 专属池 (owner)", s.admission.owner),
    makeYtdlpRow("ytdlp", "yt-dlp 并发槽位 (ytdlp)", s.ytdlp),
    makeYtdlpRow(
      "ytdlp_generic",
      "yt-dlp 通用长尾槽位 (ytdlp_generic)",
      s.ytdlp_generic,
    ),
  ];
});

const ytdlpCompartmentPools = computed<CompartmentPoolRow[]>(() => {
  const pools = stats.value?.ytdlp_pools;
  if (!pools) return [];

  const makeRow = (
    id: CompartmentPoolRow["id"],
    label: string,
    pool: YTDLPCompartmentPoolSnapshot,
  ): CompartmentPoolRow => {
    const limit = Math.max(0, pool.concurrency_limit || 0);
    const active = Math.max(0, pool.active || 0);
    const queued = Math.max(0, pool.queued || 0);
    const queueLimit = Math.max(0, pool.queue_limit || 0);
    const ratioPct =
      limit > 0 ? Math.min(100, Math.round((active / limit) * 100)) : 0;
    return {
      id,
      label,
      enabled: Boolean(pool.enabled),
      active,
      limit,
      queued,
      queueLimit,
      ratioPct,
      tone: buildPoolWatermarkTone(ratioPct),
      footSummary: `本次启动等待 ${pool.waited ?? 0} · 放行 ${pool.granted ?? 0} · 超时 ${pool.timeout ?? 0} · 满载 ${pool.full ?? 0} · 最大等待 ${pool.wait_ms_max ?? 0} ms`,
    };
  };

  return [
    makeRow("youtube", "YouTube 舱", pools.youtube),
    makeRow("social", "社交慢链舱", pools.social),
    makeRow("generic", "长尾 Generic 舱", pools.generic),
    makeRow("youtube_ejs", "YouTube EJS 池", pools.youtube_ejs),
  ];
});

const circuitBreakerRows = computed<CircuitBreakerRow[]>(() => {
  const list = stats.value?.circuit_breakers;
  if (!Array.isArray(list) || list.length === 0) return [];
  return list.map((item) => ({
    platform: item.platform,
    label: formatStatsPlatformLabel(item.platform),
    state: item.state,
    disabledByConfig: Boolean(item.disabled_by_config),
    badge: formatCircuitBreakerBadge(item),
    consecutiveFailures: Math.max(0, item.consecutive_failures || 0),
    windowFailures: Math.max(0, item.window_failures || 0),
    windowTotal: Math.max(0, item.window_total || 0),
    openUntilLabel: formatShanghaiTimestamp(item.open_until),
  }));
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
  const p = stats.value?.runtime_policy;
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

// Charts
const dailyChart = computed(() =>
  buildDailyChartPoints(stats.value?.daily ?? [], dailyChartDays.value),
);

const dailyRatePoints = computed(() =>
  dailyChart.value.points.filter(
    (pt): pt is DailyChartPoint & { rateY: number } => pt.rateY !== null,
  ),
);

const activeDailyPoint = computed<DailyChartPoint | null>(() => {
  const pts = dailyChart.value.points;
  if (pts.length === 0) return null;
  if (
    hoveredDailyIndex.value !== null &&
    hoveredDailyIndex.value >= 0 &&
    hoveredDailyIndex.value < pts.length
  ) {
    return pts[hoveredDailyIndex.value];
  }
  return pts[pts.length - 1];
});

const hourlyChart = computed(() =>
  buildHourlyChartPoints(stats.value?.hourly ?? []),
);

const activeHourlyPoint = computed<HourlyChartPoint | null>(() => {
  const pts = hourlyChart.value.points;
  if (pts.length === 0) return null;
  if (
    hoveredHourlyIndex.value !== null &&
    hoveredHourlyIndex.value >= 0 &&
    hoveredHourlyIndex.value < pts.length
  ) {
    return pts[hoveredHourlyIndex.value];
  }
  return pts[pts.length - 1];
});

// Platform health table with sorting (includes effectiveSuccessRate)
const platformHealthRows = computed<PlatformHealthRow[]>(() => {
  if (!stats.value) return [];
  const base = aggregatePlatformHealth(stats.value, healthRange.value);
  const dir = sortDir.value === "asc" ? 1 : -1;
  const key = sortKey.value;
  return [...base].sort((a, b) => {
    if (key === "platform") {
      return a.label.localeCompare(b.label, "zh-CN") * dir;
    }
    if (key === "successRate") {
      const av = a.successRate ?? -1;
      const bv = b.successRate ?? -1;
      return (av - bv) * dir || b.total - a.total;
    }
    if (key === "effectiveSuccessRate") {
      const av = a.effectiveSuccessRate ?? -1;
      const bv = b.effectiveSuccessRate ?? -1;
      return (av - bv) * dir || b.effectiveTotal - a.effectiveTotal;
    }
    if (key === "p95Ms") {
      const av = a.p95Ms ?? -1;
      const bv = b.p95Ms ?? -1;
      return (av - bv) * dir || b.total - a.total;
    }
    return (
      ((a[key] as number) - (b[key] as number)) * dir ||
      a.platform.localeCompare(b.platform)
    );
  });
});

const apiKeyRows = computed(() => stats.value?.api_keys ?? []);

// ============================================================================
// Auth Unlock, Lock & Refresh State Machine
// ============================================================================

function clearCopiedVersionTimer() {
  if (copiedVersionTimer !== null) {
    clearTimeout(copiedVersionTimer);
    copiedVersionTimer = null;
  }
}

async function handleCopyVersion(source: "kpi" | "matrix") {
  const full = versionInfo.value.full;
  if (!full) return;
  const copied = await copyTextToClipboard(full);
  if (!copied) return;
  clearCopiedVersionTimer();
  copiedVersionSource.value = source;
  copiedVersionTimer = setTimeout(() => {
    copiedVersionSource.value = null;
    copiedVersionTimer = null;
  }, 1800);
  (copiedVersionTimer as { unref?: () => void })?.unref?.();
}

function clearAutoRefreshTimer() {
  if (autoRefreshTimer !== null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function lockDashboard(reasonError = "") {
  fetchGeneration += 1;
  clearAutoRefreshTimer();
  clearCopiedVersionTimer();
  clearStoredOwnerToken();
  copiedVersionSource.value = null;
  autoRefreshEnabled.value = false;
  pausedByVisibility.value = false;
  activeToken = "";
  tokenSource.value = null;
  tokenInput.value = "";
  showToken.value = false;
  rememberDevice.value = false;
  stats.value = null;
  lastFetchedAt.value = null;
  staleError.value = "";
  authError.value = reasonError;
  initialLoading.value = false;
  refreshing.value = false;
  submitting.value = false;
}

function handleLockClick() {
  lockDashboard("");
}

async function handleUnlock() {
  if (submitting.value) return;
  const validated = validateOwnerBearerToken(tokenInput.value);
  if (!validated.ok) {
    authError.value = validated.error;
    return;
  }

  const myGen = ++fetchGeneration;
  submitting.value = true;
  authError.value = "";

  try {
    const res = await fetchSameOriginOwnerStats(validated.token);
    if (myGen !== fetchGeneration) return;

    if (res.ok) {
      const savedSource = saveOwnerToken(validated.token, rememberDevice.value);
      activeToken = validated.token;
      tokenSource.value = savedSource;
      stats.value = res.stats;
      lastFetchedAt.value = res.fetchedAt;
      staleError.value = "";
      authError.value = "";
      tokenInput.value = "";
      showToken.value = false;
      autoRefreshEnabled.value = readMonitorAutoRefresh();
      syncAutoRefreshTimer();
      return;
    }

    if (res.kind === "unauthorized") {
      clearStoredOwnerToken();
      activeToken = "";
      tokenSource.value = null;
      stats.value = null;
      lastFetchedAt.value = null;
      authError.value = res.message;
      return;
    }

    stats.value = null;
    authError.value = res.message;
  } finally {
    if (myGen === fetchGeneration) {
      submitting.value = false;
    }
  }
}

async function refreshStats() {
  if (!activeToken) {
    lockDashboard("");
    return;
  }
  const myGen = ++fetchGeneration;
  refreshing.value = true;

  try {
    const res = await fetchSameOriginOwnerStats(activeToken);
    if (myGen !== fetchGeneration) return;

    if (res.ok) {
      stats.value = res.stats;
      lastFetchedAt.value = res.fetchedAt;
      staleError.value = "";
      return;
    }

    if (res.kind === "unauthorized") {
      lockDashboard(res.message);
      return;
    }

    staleError.value = res.message;
  } finally {
    if (myGen === fetchGeneration) {
      refreshing.value = false;
    }
  }
}

// ============================================================================
// Auto-Refresh & Visibility Pause/Resume
// ============================================================================

function syncAutoRefreshTimer() {
  clearAutoRefreshTimer();
  if (!autoRefreshEnabled.value || !stats.value || !activeToken) {
    pausedByVisibility.value = false;
    return;
  }
  const hidden =
    typeof document !== "undefined" && document.visibilityState === "hidden";
  if (hidden) {
    pausedByVisibility.value = true;
    return;
  }
  pausedByVisibility.value = false;
  autoRefreshTimer = setInterval(() => {
    if (!stats.value || !activeToken) {
      clearAutoRefreshTimer();
      return;
    }
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      pausedByVisibility.value = true;
      clearAutoRefreshTimer();
      return;
    }
    void refreshStats();
  }, AUTO_REFRESH_INTERVAL_MS);
  (autoRefreshTimer as { unref?: () => void })?.unref?.();
}

function handleToggleAutoRefresh() {
  if (!stats.value) return;
  autoRefreshEnabled.value = !autoRefreshEnabled.value;
  writeMonitorAutoRefresh(autoRefreshEnabled.value);
  syncAutoRefreshTimer();
}

function handleVisibilityChange() {
  if (!autoRefreshEnabled.value || !stats.value || !activeToken) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    pausedByVisibility.value = true;
    clearAutoRefreshTimer();
  } else {
    pausedByVisibility.value = false;
    void refreshStats();
    syncAutoRefreshTimer();
  }
}

// ============================================================================
// Theme, Chart & Table Helpers
// ============================================================================

function handleCycleTheme() {
  const next = getNextMonitorTheme(currentTheme.value);
  currentTheme.value = next;
  writeMonitorTheme(next);
  applyMonitorTheme(next);
}

function handleDailyRangeChange(days: 7 | 30) {
  dailyChartDays.value = days;
  hoveredDailyIndex.value = null;
}

function handleToggleSort(key: PlatformSortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === "desc" ? "asc" : "desc";
  } else {
    sortKey.value = key;
    sortDir.value = key === "platform" ? "asc" : "desc";
  }
}

function sortIndicator(key: PlatformSortKey): string {
  if (sortKey.value !== key) return "";
  return sortDir.value === "asc" ? "▲" : "▼";
}

function rateToneClass(rate: number | null): string {
  if (rate === null) return "ok";
  if (rate >= 95) return "ok";
  if (rate >= 80) return "warn";
  return "danger";
}

function formatRateValue(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${Math.max(0, Math.min(100, rate)).toFixed(1)}%`;
}

function roleBadgeClass(role: string): string {
  const r = (role || "").trim().toLowerCase();
  if (r === "owner") return "mon-role-badge--owner";
  if (r === "friend") return "mon-role-badge--friend";
  if (r === "agent") return "mon-role-badge--agent";
  return "mon-role-badge--other";
}

// ============================================================================
// Lifecycle
// ============================================================================

onMounted(async () => {
  stripUrlQueryAndHash();
  currentTheme.value = readMonitorTheme();
  applyMonitorTheme(currentTheme.value);

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  const stored = readStoredOwnerToken();
  if (!stored.token || !stored.source) {
    return;
  }

  const validated = validateOwnerBearerToken(stored.token);
  if (!validated.ok) {
    clearStoredOwnerToken();
    authError.value = validated.error;
    return;
  }

  const myGen = ++fetchGeneration;
  initialLoading.value = true;
  try {
    const res = await fetchSameOriginOwnerStats(validated.token);
    if (myGen !== fetchGeneration) return;

    if (res.ok) {
      activeToken = validated.token;
      tokenSource.value = stored.source;
      stats.value = res.stats;
      lastFetchedAt.value = res.fetchedAt;
      staleError.value = "";
      authError.value = "";
      autoRefreshEnabled.value = readMonitorAutoRefresh();
      syncAutoRefreshTimer();
      return;
    }

    if (res.kind === "unauthorized") {
      clearStoredOwnerToken();
      stats.value = null;
      authError.value = res.message;
      return;
    }

    stats.value = null;
    authError.value = res.message;
  } finally {
    if (myGen === fetchGeneration) {
      initialLoading.value = false;
    }
  }
});

onUnmounted(() => {
  clearAutoRefreshTimer();
  clearCopiedVersionTimer();
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }
});
</script>

<template>
  <div class="mon-page" data-testid="monitor-dashboard-root">
    <!-- Sticky Topbar -->
    <header class="mon-topbar">
      <div class="mon-topbar__inner">
        <div class="mon-brand">
          <span class="mon-brand__logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
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
          <div class="mon-brand__titles">
            <div class="mon-brand__title-row">
              <h1 class="mon-brand__title">DokiTool 解析监控大盘</h1>
              <span
                v-if="stats"
                class="sp-badge sp-badge--accent"
                data-testid="monitor-owner-badge"
              >
                Owner 只读遥测
              </span>
              <span
                v-else
                class="sp-badge sp-badge--muted"
                data-testid="monitor-locked-badge"
              >
                未解锁 · 需 Owner 鉴权
              </span>
              <span
                v-if="stats && tokenSource"
                class="sp-badge"
                :class="
                  tokenSource === 'local'
                    ? 'sp-badge--warn'
                    : 'sp-badge--saved'
                "
                data-testid="monitor-credential-source"
              >
                {{ credentialSourceLabel }}
              </span>
            </div>
            <div class="mon-brand__meta">
              <a
                href="/"
                class="mon-brand__origin mon-brand__origin-link"
                title="返回主站首页"
                data-testid="monitor-home-link"
              >
                {{ currentOrigin }}
              </a>
              <span v-if="stats">最后刷新：{{ formattedFetchedTime }}</span>
              <span>统计时区：Asia/Shanghai (UTC+8)</span>
            </div>
          </div>
        </div>

        <div class="mon-controls">
          <template v-if="stats">
            <button
              type="button"
              class="mon-auto-btn"
              :class="{
                'mon-auto-btn--on': autoRefreshEnabled && !pausedByVisibility,
                'mon-auto-btn--paused':
                  autoRefreshEnabled && pausedByVisibility,
              }"
              :aria-pressed="autoRefreshEnabled"
              data-testid="monitor-auto-refresh-toggle"
              @click="handleToggleAutoRefresh"
            >
              <span
                class="mon-status-dot"
                :class="{
                  'mon-status-dot--ok':
                    autoRefreshEnabled && !pausedByVisibility,
                  'mon-status-dot--warn':
                    autoRefreshEnabled && pausedByVisibility,
                }"
              />
              <span v-if="!autoRefreshEnabled">30s 自动刷新：关</span>
              <span v-else-if="pausedByVisibility">30s 自动刷新：已暂停</span>
              <span v-else>30s 自动刷新：开</span>
            </button>

            <button
              type="button"
              class="sp-btn sp-btn--secondary sp-btn--sm"
              :disabled="refreshing"
              data-testid="monitor-refresh-btn"
              @click="refreshStats()"
            >
              <span>{{ refreshing ? "刷新中..." : "立即刷新" }}</span>
            </button>
          </template>

          <button
            type="button"
            class="mon-theme-btn"
            data-testid="monitor-theme-toggle"
            :title="`切换界面主题（当前：${themeButtonLabel}）`"
            @click="handleCycleTheme"
          >
            <svg
              v-if="currentTheme === 'light'"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
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
            <svg
              v-else-if="currentTheme === 'dark'"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            <svg
              v-else
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
              <line x1="8" y1="20.5" x2="16" y2="20.5" />
              <line x1="12" y1="16.5" x2="12" y2="20.5" />
            </svg>
            <span>{{ themeButtonLabel }}</span>
          </button>

          <button
            v-if="stats"
            type="button"
            class="sp-btn sp-btn--danger-ghost sp-btn--sm"
            data-testid="monitor-lock-btn"
            @click="handleLockClick"
          >
            锁定 / 清除凭据
          </button>
        </div>
      </div>
    </header>

    <main class="mon-main">
      <!-- Auto-unlock Loading (Only when pre-stored token is being verified) -->
      <div
        v-if="initialLoading && !stats"
        class="mon-loading"
        data-testid="monitor-initial-loading"
      >
        <div class="mon-loading__spinner sp-spin" />
        <span>正在校验本地凭据并拉取实时监控快照...</span>
      </div>

      <!-- In-Page Owner Unlock Card (Shown whenever locked / 401) -->
      <section
        v-else-if="!stats"
        class="mon-unlock-card"
        data-testid="monitor-unlock-card"
      >
        <div class="mon-unlock-card__head">
          <span class="mon-unlock-card__badge">Owner 鉴权解锁</span>
          <h2 class="mon-unlock-card__title">验证管理员凭据以进入监控大盘</h2>
          <p class="mon-unlock-card__desc">
            本页面通过同源接口 <code class="mon-mono">/api/stats</code>
            拉取只读运行遥测，仅对 <strong>owner</strong> 角色开放；请求严格不携带
            Cookie，且凭据不会写入 URL 或 Cookie。
          </p>
        </div>

        <form
          class="mon-unlock-form"
          data-testid="monitor-unlock-form"
          @submit.prevent="handleUnlock"
        >
          <div class="mon-field">
            <label class="mon-field__label" for="monitor-owner-token">
              Owner Bearer Token
            </label>
            <div class="mon-input-row">
              <input
                id="monitor-owner-token"
                v-model="tokenInput"
                :type="showToken ? 'text' : 'password'"
                class="sp-input"
                autocomplete="current-password"
                spellcheck="false"
                autocapitalize="off"
                placeholder="输入管理员（owner）Bearer Token（32～512 位可见 ASCII）"
                :disabled="submitting"
                data-testid="monitor-token-input"
              />
              <button
                type="button"
                class="sp-btn sp-btn--secondary mon-token-toggle"
                :aria-pressed="showToken"
                data-testid="monitor-token-visibility-btn"
                @click="showToken = !showToken"
              >
                {{ showToken ? "隐藏" : "显示" }}
              </button>
            </div>
          </div>

          <div
            v-if="authError"
            class="mon-auth-alert"
            role="alert"
            data-testid="monitor-auth-error"
          >
            {{ authError }}
          </div>

          <div class="mon-checkbox-box">
            <label class="mon-checkbox-row">
              <input
                v-model="rememberDevice"
                type="checkbox"
                :disabled="submitting"
                data-testid="monitor-remember-checkbox"
              />
              <span>在此受信任设备记住凭据</span>
            </label>
            <p class="mon-checkbox-hint">
              勾选后存入本机浏览器 localStorage，公共或他人设备请勿勾选
            </p>
          </div>

          <button
            type="submit"
            class="sp-btn sp-btn--primary mon-unlock-submit"
            :disabled="submitting"
            data-testid="monitor-unlock-submit"
          >
            {{ submitting ? "正在验证凭据..." : "验证并进入监控大盘" }}
          </button>

          <p class="mon-unlock-footnote">
            默认仅保存在当前标签页会话（sessionStorage），关闭标签页后自动清除；解锁后可随时点击右上角「锁定 /
            清除凭据」一键销毁。
          </p>
        </form>
      </section>

      <!-- Main 5-Section Widescreen Dashboard -->
      <template v-else-if="stats && todaySummary">
        <!-- Non-blocking stale refresh warning -->
        <div
          v-if="staleError"
          class="mon-inline-banner"
          role="status"
          data-testid="monitor-stale-banner"
        >
          <span>最近一次刷新失败：{{ staleError }}（当前展示上次快照）</span>
          <button
            type="button"
            class="sp-btn sp-btn--ghost sp-btn--xs"
            @click="refreshStats()"
          >
            重试
          </button>
        </div>

        <!-- ================================================================ -->
        <!-- Section 1: 核心指标卡 (5-Column KPI Grid with Dual Success Rate)   -->
        <!-- ================================================================ -->
        <section
          class="mon-kpi-grid"
          aria-label="核心指标卡"
          data-testid="section-kpi-cards"
        >
          <!-- KPI 1: Today Total Parses -->
          <article class="mon-kpi mon-kpi--info" data-testid="kpi-today-total">
            <div class="mon-kpi__label">
              <span>今日解析总量</span>
              <span class="mon-mono">{{ todaySummary.date || "今日" }}</span>
            </div>
            <div class="mon-kpi__main">
              <span class="mon-kpi__value">{{ todaySummary.total }}</span>
              <span
                class="mon-delta-pill"
                :class="`mon-delta-pill--${todayDeltaTotalTone}`"
              >
                {{ todayDeltaTotalText }}
              </span>
            </div>
            <div class="mon-kpi__meta">
              <span>成功 {{ todaySummary.ok }} / 失败 {{ todaySummary.failed }}</span>
            </div>
            <div class="mon-kpi__meta">
              <span>P50 {{ todaySummary.p50Ms }}ms · P95 {{ todaySummary.p95Ms }}ms</span>
            </div>
          </article>

          <!-- KPI 2: Today Dual Success Rate (Full vs Effective) -->
          <article
            class="mon-kpi mon-kpi--success"
            data-testid="kpi-success-rate"
          >
            <div class="mon-kpi__label">
              <span>今日成功率</span>
              <span class="sp-badge sp-badge--muted">全量口径</span>
            </div>
            <div class="mon-kpi__main">
              <span class="mon-kpi__value">
                {{ formatPercent(todaySummary.ok, todaySummary.total, 1) }}
              </span>
              <span
                class="mon-delta-pill"
                :class="`mon-delta-pill--${todayDeltaRateTone}`"
              >
                {{ todayDeltaRateText }}
              </span>
            </div>
            <div
              class="mon-kpi__effective"
              data-testid="kpi-effective-success-rate"
            >
              有效解析成功率 <strong>{{ effectiveSuccessRateText }}</strong>（已剔除限流/无效输入
              {{ todaySummary.excludedCount }} 次）
            </div>
            <div class="mon-kpi__meta">
              <span>全量分母 {{ todaySummary.total }} · 有效分母 {{ todaySummary.effectiveTotal }}</span>
            </div>
          </article>

          <!-- KPI 3: Cache Hit Rate & Memory Occupancy -->
          <article class="mon-kpi mon-kpi--success" data-testid="kpi-cache">
            <div class="mon-kpi__label">
              <span>缓存命中率 &amp; 内存占用</span>
              <span
                class="sp-badge"
                :class="
                  stats.cache.enabled ? 'sp-badge--saved' : 'sp-badge--muted'
                "
              >
                {{ stats.cache.enabled ? "LRU 已启用" : "已关闭" }}
              </span>
            </div>
            <div class="mon-kpi__main">
              <span
                class="mon-kpi__value"
                title="按本次启动以来的内存缓存命中与未命中计算"
              >
                {{ cacheHitRateText }}
              </span>
              <span class="mon-text-muted mon-mono">
                {{ formatBytesCompact(stats.cache.bytes) }} /
                {{ formatBytesCompact(stats.cache.max_bytes) }}
              </span>
            </div>
            <div class="mon-kpi__meta">
              <span>条目 {{ stats.cache.entries }} / {{ stats.cache.max_entries }}</span>
              <span>今日命中 {{ todaySummary.cacheHits }}</span>
            </div>
            <div class="mon-kpi__meta">
              <span>本次启动命中 {{ stats.cache.total.hits }} / 未命中 {{ stats.cache.total.misses }}</span>
              <span>合流复用 {{ stats.cache.total.singleflight_shared }}</span>
            </div>
            <div class="mon-kpi__meta" data-testid="kpi-cache-stale-hits">
              <span>过期兜底命中 {{ cacheStaleHits }}</span>
              <span>不可缓存 {{ stats.cache.total.uncacheable }}</span>
            </div>
          </article>

          <!-- KPI 4: Shanghai Exit Nodes & Hit Rate -->
          <article class="mon-kpi mon-kpi--warn" data-testid="kpi-shanghai">
            <div class="mon-kpi__label">
              <span>上海出口节点 &amp; 命中率</span>
              <span class="sp-badge sp-badge--muted">{{ shanghaiModeLabel }}</span>
            </div>
            <div class="mon-kpi__main">
              <span class="mon-kpi__value">
                <span
                  class="mon-status-dot mon-status-dot--inline"
                  :class="
                    stats.shanghai.waiting_workers > 0
                      ? 'mon-status-dot--ok'
                      : ''
                  "
                />
                {{ stats.shanghai.waiting_workers }} 节点
              </span>
              <span
                class="sp-badge sp-badge--accent"
                title="按本次启动以来的上海出口命中与回退计算"
              >
                本次启动命中率 {{ shanghaiHitRateText }}
              </span>
            </div>
            <div class="mon-kpi__meta">
              <span>今日上海命中 {{ todaySummary.shanghaiHits }}</span>
              <span>本次启动命中 {{ stats.shanghai.total.hits }} / 回退 {{ stats.shanghai.total.fallbacks }}</span>
            </div>
            <div
              class="mon-shanghai-breakdown"
              data-testid="kpi-shanghai-platforms"
            >
              <span class="mon-shanghai-chip">
                <strong>抖音</strong> 命中 {{ shanghaiPlatformBreakdown.douyinHits }} / 回退 {{ shanghaiPlatformBreakdown.douyinFallbacks }}
              </span>
              <span class="mon-shanghai-chip">
                <strong>B 站</strong> 命中 {{ shanghaiPlatformBreakdown.bilibiliHits }} / 回退 {{ shanghaiPlatformBreakdown.bilibiliFallbacks }}
              </span>
            </div>
            <div class="mon-kpi__meta">
              <span>排队任务 {{ stats.shanghai.queued_tasks }} · 执行中 {{ stats.shanghai.pending_tasks }}</span>
              <span>本次启动超时 {{ stats.shanghai.total.queue_timeouts }}</span>
            </div>
          </article>

          <!-- KPI 5: Version & Uptime -->
          <article class="mon-kpi" data-testid="kpi-version-uptime">
            <div class="mon-kpi__label">
              <span>服务版本 &amp; 在线时长</span>
              <button
                type="button"
                class="sp-badge sp-badge--accent mon-mono mon-version-btn"
                :class="{
                  'mon-version-btn--copied': copiedVersionSource === 'kpi',
                }"
                :title="`点击复制完整版本: ${versionInfo.full}`"
                :aria-label="`复制完整后端版本 ${versionInfo.full}`"
                data-testid="kpi-version-badge"
                @click="handleCopyVersion('kpi')"
              >
                {{ copiedVersionSource === "kpi" ? "已复制" : versionInfo.display }}
              </button>
            </div>
            <div class="mon-kpi__main">
              <span class="mon-kpi__value mon-kpi__value--compact">
                {{ uptimeText }}
              </span>
            </div>
            <div class="mon-kpi__meta">
              <span>本次启动请求 {{ stats.requests.total }} 次</span>
              <span>匿名 {{ stats.requests.by_channel.anonymous }} · Owner {{ stats.requests.by_channel.owner }}</span>
            </div>
            <div class="mon-kpi__meta">
              <span>本次启动最大耗时 {{ stats.parse_latency_ms.total.max_ms }} ms</span>
              <span>持久化 {{ stats.runtime.stats_persistence_enabled ? "已开启" : "纯内存" }}</span>
            </div>
          </article>
        </section>

        <!-- ================================================================ -->
        <!-- Section 2: 运行时开关矩阵（只读） & 并发池水位                      -->
        <!-- ================================================================ -->
        <section
          class="mon-split-grid"
          aria-label="运行时开关矩阵与并发池水位"
          data-testid="section-runtime-pools"
        >
          <!-- Runtime Switches (all 11 read-only flags) -->
          <article class="mon-card">
            <div class="mon-card__header">
              <div class="mon-card__title-group">
                <h2 class="mon-card__title">运行时开关矩阵（只读）</h2>
                <span class="mon-card__subtitle">
                  脱敏展示服务端 11 项运行态特性开关，不含任何密钥、路径或内网地址
                </span>
              </div>
              <span class="sp-badge sp-badge--muted">
                {{ runtimeSwitches.length }} 项开关
              </span>
            </div>

            <div
              class="mon-switch-grid"
              data-testid="runtime-switches-grid"
            >
              <div
                v-for="item in runtimeSwitches"
                :key="item.key"
                class="mon-switch-item"
                :data-runtime-key="item.key"
              >
                <div class="mon-switch-item__label">
                  <span class="mon-switch-item__name">{{ item.label }}</span>
                  <span class="mon-switch-item__key">{{ item.key }}</span>
                </div>
                <button
                  v-if="item.copyable"
                  type="button"
                  class="mon-switch-pill mon-switch-pill--accent mon-version-btn"
                  :class="{
                    'mon-version-btn--copied': copiedVersionSource === 'matrix',
                  }"
                  :title="`点击复制完整版本: ${item.fullValue || item.valueText}`"
                  :aria-label="`复制完整后端版本 ${item.fullValue || item.valueText}`"
                  data-testid="runtime-version-pill"
                  @click="handleCopyVersion('matrix')"
                >
                  {{ copiedVersionSource === "matrix" ? "已复制" : item.valueText }}
                </button>
                <span
                  v-else
                  class="mon-switch-pill"
                  :class="`mon-switch-pill--${item.tone}`"
                >
                  {{ item.valueText }}
                </span>
              </div>
            </div>
          </article>

          <!-- Concurrency Pools Watermark (6 Pools incl. generic_slow & ytdlp_generic) -->
          <article class="mon-card">
            <div class="mon-card__header">
              <div class="mon-card__title-group">
                <h2 class="mon-card__title">并发池实时水位</h2>
                <span class="mon-card__subtitle">
                  准入排队放行池（fast / slow / generic_slow / owner）与 yt-dlp /
                  ytdlp_generic 共享总网关槽位实时水位
                </span>
              </div>
              <span class="sp-badge sp-badge--muted">
                {{ concurrencyPools.length }} 组资源池
              </span>
            </div>

            <div class="mon-pools-list" data-testid="concurrency-pools">
              <div
                v-for="pool in concurrencyPools"
                :key="pool.id"
                class="mon-pool-row"
                :data-pool-id="pool.id"
              >
                <div class="mon-pool-row__top">
                  <div class="mon-pool-row__title">
                    <span class="mon-pool-row__name">{{ pool.label }}</span>
                    <span
                      class="mon-pool-kind"
                      :class="
                        pool.kind === 'admission'
                          ? 'mon-pool-kind--admission'
                          : 'mon-pool-kind--slot'
                      "
                    >
                      {{ pool.kindLabel }}
                    </span>
                  </div>
                  <span class="mon-pool-row__usage">
                    活跃 {{ pool.active }} / {{ pool.limit }}
                    <template v-if="pool.queueLimit !== null">
                      · 排队 {{ pool.queued }} / {{ pool.queueLimit }}
                    </template>
                    <template v-else>
                      · 等待 {{ pool.queued }}
                    </template>
                  </span>
                </div>
                <svg
                  class="mon-pool-bar-svg"
                  viewBox="0 0 100 8"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <rect
                    class="mon-bar-track"
                    x="0"
                    y="0"
                    width="100"
                    height="8"
                    rx="4"
                  />
                  <rect
                    class="mon-bar-fill"
                    :class="
                      pool.tone === 'normal'
                        ? ''
                        : `mon-bar-fill--${pool.tone}`
                    "
                    x="0"
                    y="0"
                    :width="pool.ratioPct"
                    height="8"
                    rx="4"
                  />
                </svg>
                <div class="mon-pool-row__foot">
                  <span>{{ pool.footSummary }}</span>
                  <span>负载 {{ pool.ratioPct }}%</span>
                </div>
              </div>
            </div>

            <!-- 4-Compartment yt-dlp & YouTube EJS Pools (Read-Only) -->
            <div
              v-if="ytdlpCompartmentPools.length > 0"
              class="mon-compartment-wrap"
              data-testid="ytdlp-compartment-pools"
            >
              <div class="mon-compartment-head">
                <h3 class="mon-compartment-title">yt-dlp 分舱 &amp; YouTube EJS 池</h3>
                <span class="sp-badge sp-badge--accent">4 组独立分舱</span>
              </div>
              <div class="mon-pools-list">
                <div
                  v-for="cpool in ytdlpCompartmentPools"
                  :key="cpool.id"
                  class="mon-pool-row"
                  :data-compartment-pool-id="cpool.id"
                >
                  <div class="mon-pool-row__top">
                    <div class="mon-pool-row__title">
                      <span class="mon-pool-row__name">{{ cpool.label }}</span>
                      <span
                        class="mon-pool-kind"
                        :class="
                          cpool.enabled
                            ? 'mon-pool-kind--enabled'
                            : 'mon-pool-kind--disabled'
                        "
                      >
                        {{ cpool.enabled ? "已启用" : "未启用" }}
                      </span>
                    </div>
                    <span class="mon-pool-row__usage">
                      活跃 {{ cpool.active }} / {{ cpool.limit }} · 排队
                      {{ cpool.queued }} / {{ cpool.queueLimit }}
                    </span>
                  </div>
                  <svg
                    class="mon-pool-bar-svg"
                    viewBox="0 0 100 8"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <rect
                      class="mon-bar-track"
                      x="0"
                      y="0"
                      width="100"
                      height="8"
                      rx="4"
                    />
                    <rect
                      class="mon-bar-fill"
                      :class="
                        cpool.tone === 'normal'
                          ? ''
                          : `mon-bar-fill--${cpool.tone}`
                      "
                      x="0"
                      y="0"
                      :width="cpool.ratioPct"
                      height="8"
                      rx="4"
                    />
                  </svg>
                  <div class="mon-pool-row__foot">
                    <span>{{ cpool.footSummary }}</span>
                    <span>负载 {{ cpool.ratioPct }}%</span>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </section>

        <!-- ================================================================ -->
        <!-- Section 2.5: 平台熔断状态 & 运行时热策略摘要（严格只读）            -->
        <!-- ================================================================ -->
        <section
          v-if="circuitBreakerRows.length > 0 || runtimePolicyRows.length > 0"
          class="mon-split-grid"
          aria-label="平台熔断状态与运行时热策略摘要"
          data-testid="section-protection-policy"
        >
          <!-- Read-Only Circuit Breaker Status Grid -->
          <article
            v-if="circuitBreakerRows.length > 0"
            class="mon-card"
            data-testid="card-circuit-breakers"
          >
            <div class="mon-card__header">
              <div class="mon-card__title-group">
                <h2 class="mon-card__title">平台熔断状态（只读）</h2>
                <span class="mon-card__subtitle">
                  仅实时展示 14 核心平台及长尾链路的上游故障保护状态，公网零写接口
                </span>
              </div>
              <div class="mon-cb-summary">
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
              </div>
            </div>

            <div class="mon-cb-grid" data-testid="circuit-breakers-grid">
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
                  stats.runtime_policy?.config_file_active
                    ? 'sp-badge--saved'
                    : 'sp-badge--muted'
                "
              >
                {{
                  stats.runtime_policy?.config_file_active
                    ? "热配置已激活"
                    : "默认策略"
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

        <!-- ================================================================ -->
        <!-- Section 3: 原生 SVG 趋势图 (Daily 7d/30d + Hourly 24h)            -->
        <!-- ================================================================ -->
        <section
          class="mon-charts-grid"
          aria-label="解析趋势图表"
          data-testid="section-charts"
        >
          <!-- Daily Stacked Bar + Success Rate Line Chart -->
          <article class="mon-card" data-testid="chart-daily-trend">
            <div class="mon-card__header">
              <div class="mon-card__title-group">
                <h2 class="mon-card__title">日度解析趋势与成功率</h2>
                <span class="mon-card__subtitle">
                  按 Asia/Shanghai 自然日统计成功/失败堆叠量与成功率走势
                </span>
              </div>
              <div class="mon-chart-toolbar">
                <div class="mon-legend">
                  <span class="mon-legend__item">
                    <span class="mon-legend__swatch mon-legend__swatch--ok" />
                    成功
                  </span>
                  <span class="mon-legend__item">
                    <span class="mon-legend__swatch mon-legend__swatch--failed" />
                    失败
                  </span>
                  <span class="mon-legend__item">
                    <span class="mon-legend__swatch mon-legend__swatch--rate" />
                    成功率
                  </span>
                </div>
                <div class="mon-seg" role="tablist" aria-label="日趋势时间窗口">
                  <button
                    type="button"
                    role="tab"
                    :aria-selected="dailyChartDays === 7"
                    class="mon-seg__btn"
                    :class="{ 'mon-seg__btn--active': dailyChartDays === 7 }"
                    data-testid="daily-range-7d"
                    @click="handleDailyRangeChange(7)"
                  >
                    近 7 天
                  </button>
                  <button
                    type="button"
                    role="tab"
                    :aria-selected="dailyChartDays === 30"
                    class="mon-seg__btn"
                    :class="{ 'mon-seg__btn--active': dailyChartDays === 30 }"
                    data-testid="daily-range-30d"
                    @click="handleDailyRangeChange(30)"
                  >
                    近 30 天
                  </button>
                </div>
              </div>
            </div>

            <div class="mon-svg-wrap">
              <svg
                class="mon-svg"
                :viewBox="`0 0 ${dailyChart.width} ${dailyChart.height}`"
                role="img"
                :aria-label="`近 ${dailyChartDays} 天解析量与成功率趋势图`"
              >
                <!-- Horizontal Gridlines & Left/Right Axes -->
                <g v-for="tick in dailyChart.yTicks" :key="tick.value">
                  <line
                    class="mon-svg__grid"
                    :x1="dailyChart.plotLeft"
                    :x2="dailyChart.plotRight"
                    :y1="tick.y"
                    :y2="tick.y"
                  />
                  <text
                    class="mon-svg__axis-label"
                    :x="dailyChart.plotLeft - 6"
                    :y="tick.y + 3"
                    text-anchor="end"
                  >
                    {{ tick.label }}
                  </text>
                </g>

                <!-- Right Y-Axis Success Rate Labels (0%, 50%, 100%) -->
                <text
                  class="mon-svg__axis-label"
                  :x="dailyChart.plotRight + 6"
                  :y="dailyChart.plotTop + 3"
                  text-anchor="start"
                >
                  100%
                </text>
                <text
                  class="mon-svg__axis-label"
                  :x="dailyChart.plotRight + 6"
                  :y="dailyChart.plotTop + dailyChart.plotHeight / 2 + 3"
                  text-anchor="start"
                >
                  50%
                </text>
                <text
                  class="mon-svg__axis-label"
                  :x="dailyChart.plotRight + 6"
                  :y="dailyChart.plotBottom + 3"
                  text-anchor="start"
                >
                  0%
                </text>

                <!-- Stacked Bars (ok + failed) & Interactive Hover Columns -->
                <g
                  v-for="pt in dailyChart.points"
                  :key="pt.date"
                  :class="{
                    'mon-svg__bar-col--active': activeDailyPoint?.date === pt.date,
                  }"
                  data-testid="daily-bar-group"
                  @mouseenter="hoveredDailyIndex = pt.index"
                  @mouseleave="hoveredDailyIndex = null"
                >
                  <rect
                    v-if="activeDailyPoint?.date === pt.date"
                    class="mon-svg__hover-guide"
                    :x="pt.x - 3"
                    :y="dailyChart.plotTop"
                    :width="pt.barWidth + 6"
                    :height="dailyChart.plotHeight"
                    rx="3"
                  />
                  <rect
                    v-if="pt.okHeight > 0"
                    class="mon-svg__bar-ok"
                    :x="pt.x"
                    :y="pt.okY"
                    :width="pt.barWidth"
                    :height="pt.okHeight"
                    rx="2"
                  />
                  <rect
                    v-if="pt.failedHeight > 0"
                    class="mon-svg__bar-failed"
                    :x="pt.x"
                    :y="pt.failedY"
                    :width="pt.barWidth"
                    :height="pt.failedHeight"
                    rx="2"
                  />
                  <rect
                    class="mon-svg__bar-hit"
                    :x="pt.x - 4"
                    :y="dailyChart.plotTop"
                    :width="pt.barWidth + 8"
                    :height="dailyChart.plotHeight"
                  />
                  <text
                    v-if="pt.showXLabel"
                    class="mon-svg__axis-label"
                    :x="pt.centerX"
                    :y="dailyChart.plotBottom + 16"
                    text-anchor="middle"
                  >
                    {{ pt.shortDate }}
                  </text>
                </g>

                <!-- Success Rate Polyline Path -->
                <path
                  v-if="dailyChart.ratePathD"
                  class="mon-svg__rate-line"
                  :d="dailyChart.ratePathD"
                  data-testid="daily-rate-path"
                />

                <!-- Success Rate Dots (filtered computed array for strict CSP) -->
                <circle
                  v-for="pt in dailyRatePoints"
                  :key="`rate-${pt.date}`"
                  class="mon-svg__rate-dot"
                  :class="{
                    'mon-svg__rate-dot--active':
                      activeDailyPoint?.date === pt.date,
                  }"
                  :cx="pt.centerX"
                  :cy="pt.rateY"
                  :r="activeDailyPoint?.date === pt.date ? 4 : 2.6"
                />
              </svg>
            </div>

            <div
              v-if="activeDailyPoint"
              class="mon-chart-detail"
              data-testid="daily-chart-detail"
            >
              <span class="mon-chart-detail__date">
                {{ activeDailyPoint.date }}
              </span>
              <div class="mon-chart-detail__metrics">
                <span>总量 <strong>{{ activeDailyPoint.total }}</strong></span>
                <span class="mon-text-ok">成功 {{ activeDailyPoint.ok }}</span>
                <span class="mon-text-danger">失败 {{ activeDailyPoint.failed }}</span>
                <span>
                  成功率
                  <strong>{{
                    formatPercent(activeDailyPoint.ok, activeDailyPoint.total, 1)
                  }}</strong>
                </span>
                <span>缓存 {{ activeDailyPoint.cacheHits }}</span>
                <span>上海 {{ activeDailyPoint.shanghaiHits }}</span>
                <span>P95 {{ activeDailyPoint.p95Ms }}ms</span>
              </div>
            </div>
          </article>

          <!-- Hourly 24h Bar Chart -->
          <article class="mon-card" data-testid="chart-hourly-trend">
            <div class="mon-card__header">
              <div class="mon-card__title-group">
                <h2 class="mon-card__title">近 24 小时请求波动</h2>
                <span class="mon-card__subtitle">
                  按小时粒度追踪近期流量尖峰与错误爆发时段（+08:00）
                </span>
              </div>
              <div class="mon-legend">
                <span class="mon-legend__item">
                  <span class="mon-legend__swatch mon-legend__swatch--ok" />
                  成功
                </span>
                <span class="mon-legend__item">
                  <span class="mon-legend__swatch mon-legend__swatch--failed" />
                  失败
                </span>
              </div>
            </div>

            <div class="mon-svg-wrap">
              <svg
                class="mon-svg"
                :viewBox="`0 0 ${hourlyChart.width} ${hourlyChart.height}`"
                role="img"
                aria-label="近 24 小时请求波动柱状图"
              >
                <g v-for="tick in hourlyChart.yTicks" :key="tick.value">
                  <line
                    class="mon-svg__grid"
                    :x1="hourlyChart.plotLeft"
                    :x2="hourlyChart.plotRight"
                    :y1="tick.y"
                    :y2="tick.y"
                  />
                  <text
                    class="mon-svg__axis-label"
                    :x="hourlyChart.plotLeft - 6"
                    :y="tick.y + 3"
                    text-anchor="end"
                  >
                    {{ tick.label }}
                  </text>
                </g>

                <g
                  v-for="pt in hourlyChart.points"
                  :key="pt.hourStart"
                  :class="{
                    'mon-svg__bar-col--active':
                      activeHourlyPoint?.hourStart === pt.hourStart,
                  }"
                  data-testid="hourly-bar-group"
                  @mouseenter="hoveredHourlyIndex = pt.index"
                  @mouseleave="hoveredHourlyIndex = null"
                >
                  <rect
                    v-if="activeHourlyPoint?.hourStart === pt.hourStart"
                    class="mon-svg__hover-guide"
                    :x="pt.x - 2"
                    :y="hourlyChart.plotTop"
                    :width="pt.barWidth + 4"
                    :height="hourlyChart.plotHeight"
                    rx="3"
                  />
                  <rect
                    v-if="pt.okHeight > 0"
                    class="mon-svg__bar-ok"
                    :x="pt.x"
                    :y="pt.okY"
                    :width="pt.barWidth"
                    :height="pt.okHeight"
                    rx="2"
                  />
                  <rect
                    v-if="pt.failedHeight > 0"
                    class="mon-svg__bar-failed"
                    :x="pt.x"
                    :y="pt.failedY"
                    :width="pt.barWidth"
                    :height="pt.failedHeight"
                    rx="2"
                  />
                  <rect
                    class="mon-svg__bar-hit"
                    :x="pt.x - 3"
                    :y="hourlyChart.plotTop"
                    :width="pt.barWidth + 6"
                    :height="hourlyChart.plotHeight"
                  />
                  <text
                    v-if="pt.showXLabel"
                    class="mon-svg__axis-label"
                    :x="pt.centerX"
                    :y="hourlyChart.plotBottom + 16"
                    text-anchor="middle"
                  >
                    {{ pt.hourLabel }}
                  </text>
                </g>
              </svg>
            </div>

            <div
              v-if="activeHourlyPoint"
              class="mon-chart-detail"
              data-testid="hourly-chart-detail"
            >
              <span class="mon-chart-detail__date">
                {{ activeHourlyPoint.hourLabel }} 时段
              </span>
              <div class="mon-chart-detail__metrics">
                <span>总量 <strong>{{ activeHourlyPoint.total }}</strong></span>
                <span class="mon-text-ok">成功 {{ activeHourlyPoint.ok }}</span>
                <span class="mon-text-danger">失败 {{ activeHourlyPoint.failed }}</span>
                <span>
                  成功率
                  <strong>{{
                    formatPercent(activeHourlyPoint.ok, activeHourlyPoint.total, 1)
                  }}</strong>
                </span>
                <span>缓存命中 {{ activeHourlyPoint.cacheHits }}</span>
              </div>
            </div>
          </article>
        </section>

        <!-- ================================================================ -->
        <!-- Section 4: 平台每日解析健康度总览表 (5 Windows + Dual Rate + Sticky) -->
        <!-- ================================================================ -->
        <section class="mon-card" data-testid="section-platform-health">
          <div class="mon-card__header">
            <div class="mon-card__title-group">
              <h2 class="mon-card__title">平台解析健康度总览</h2>
              <span class="mon-card__subtitle">
                覆盖 14 个核心平台及长尾扩展平台，区分全量成功率与剔除限流/无效输入后的有效成功率
              </span>
            </div>

            <div class="mon-seg" role="tablist" aria-label="平台健康度时间窗口">
              <button
                v-for="opt in HEALTH_RANGE_OPTIONS"
                :key="opt.key"
                type="button"
                role="tab"
                :aria-selected="healthRange === opt.key"
                class="mon-seg__btn"
                :class="{ 'mon-seg__btn--active': healthRange === opt.key }"
                :data-testid="`health-range-${opt.key}`"
                @click="healthRange = opt.key"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>

          <div class="mon-table-wrap">
            <table class="mon-table mon-table--platform-health">
              <thead>
                <tr>
                  <th>
                    <button
                      type="button"
                      class="mon-sort-btn"
                      :class="{ 'mon-sort-btn--active': sortKey === 'platform' }"
                      @click="handleToggleSort('platform')"
                    >
                      <span>平台</span>
                      <span>{{ sortIndicator("platform") }}</span>
                    </button>
                  </th>
                  <th class="is-right">
                    <button
                      type="button"
                      class="mon-sort-btn"
                      :class="{ 'mon-sort-btn--active': sortKey === 'total' }"
                      @click="handleToggleSort('total')"
                    >
                      <span>总请求</span>
                      <span>{{ sortIndicator("total") }}</span>
                    </button>
                  </th>
                  <th class="is-right">
                    <button
                      type="button"
                      class="mon-sort-btn"
                      :class="{ 'mon-sort-btn--active': sortKey === 'ok' }"
                      @click="handleToggleSort('ok')"
                    >
                      <span>成功</span>
                      <span>{{ sortIndicator("ok") }}</span>
                    </button>
                  </th>
                  <th class="is-right">
                    <button
                      type="button"
                      class="mon-sort-btn"
                      :class="{ 'mon-sort-btn--active': sortKey === 'failed' }"
                      @click="handleToggleSort('failed')"
                    >
                      <span>失败</span>
                      <span>{{ sortIndicator("failed") }}</span>
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      class="mon-sort-btn"
                      :class="{
                        'mon-sort-btn--active': sortKey === 'successRate',
                      }"
                      @click="handleToggleSort('successRate')"
                    >
                      <span>成功率</span>
                      <span>{{ sortIndicator("successRate") }}</span>
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      class="mon-sort-btn"
                      :class="{
                        'mon-sort-btn--active':
                          sortKey === 'effectiveSuccessRate',
                      }"
                      data-testid="sort-effective-success-rate"
                      @click="handleToggleSort('effectiveSuccessRate')"
                    >
                      <span>有效成功率</span>
                      <span>{{ sortIndicator("effectiveSuccessRate") }}</span>
                    </button>
                  </th>
                  <th>主要错误码分布</th>
                  <th class="is-right">
                    <button
                      type="button"
                      class="mon-sort-btn"
                      :class="{ 'mon-sort-btn--active': sortKey === 'p95Ms' }"
                      @click="handleToggleSort('p95Ms')"
                    >
                      <span>P95 延迟</span>
                      <span>{{ sortIndicator("p95Ms") }}</span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="platformHealthRows.length === 0">
                  <td colspan="8" class="mon-empty-cell">
                    所选时间窗口内暂无平台解析记录
                  </td>
                </tr>
                <tr
                  v-for="row in platformHealthRows"
                  :key="row.platform"
                  data-testid="platform-health-row"
                  :data-platform="row.platform"
                >
                  <td>
                    <div class="mon-plat-cell">
                      <span class="mon-plat-cell__name">{{ row.label }}</span>
                      <span class="mon-plat-cell__id">{{ row.platform }}</span>
                    </div>
                  </td>
                  <td class="is-right mon-mono">{{ row.total }}</td>
                  <td class="is-right mon-mono mon-text-ok">{{ row.ok }}</td>
                  <td
                    class="is-right mon-mono"
                    :class="row.failed > 0 ? 'mon-text-danger' : 'mon-text-muted'"
                  >
                    {{ row.failed }}
                  </td>
                  <td>
                    <div class="mon-rate-cell">
                      <svg
                        class="mon-rate-bar-svg"
                        viewBox="0 0 100 8"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <rect
                          class="mon-bar-track"
                          x="0"
                          y="0"
                          width="100"
                          height="8"
                          rx="4"
                        />
                        <rect
                          class="mon-bar-fill"
                          :class="`mon-bar-fill--${rateToneClass(row.successRate)}`"
                          x="0"
                          y="0"
                          :width="
                            row.successRate !== null
                              ? Math.round(row.successRate)
                              : 0
                          "
                          height="8"
                          rx="4"
                        />
                      </svg>
                      <span class="mon-mono">
                        {{ formatPercent(row.ok, row.total, 1) }}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div class="mon-effective-cell">
                      <svg
                        class="mon-rate-bar-svg"
                        viewBox="0 0 100 8"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <rect
                          class="mon-bar-track"
                          x="0"
                          y="0"
                          width="100"
                          height="8"
                          rx="4"
                        />
                        <rect
                          class="mon-bar-fill"
                          :class="`mon-bar-fill--${rateToneClass(row.effectiveSuccessRate)}`"
                          x="0"
                          y="0"
                          :width="
                            row.effectiveSuccessRate !== null
                              ? Math.round(row.effectiveSuccessRate)
                              : 0
                          "
                          height="8"
                          rx="4"
                        />
                      </svg>
                      <span
                        class="mon-mono"
                        data-testid="platform-effective-rate"
                      >
                        {{ formatRateValue(row.effectiveSuccessRate) }}
                      </span>
                      <span
                        v-if="row.excludedCount > 0"
                        class="mon-effective-sub"
                      >
                        (-{{ row.excludedCount }})
                      </span>
                    </div>
                  </td>
                  <td>
                    <div
                      v-if="row.topErrors.length > 0"
                      class="mon-error-tags"
                    >
                      <span
                        v-for="err in row.topErrors"
                        :key="err.code"
                        class="mon-err-tag"
                        :class="`mon-err-tag--${err.severity}`"
                      >
                        {{ err.code }} ×{{ err.count }}
                      </span>
                    </div>
                    <span v-else class="mon-text-muted">—</span>
                  </td>
                  <td class="is-right mon-mono">
                    {{ row.p95Ms !== null ? `${row.p95Ms} ms` : "—" }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ================================================================ -->
        <!-- Section 5: 多 Key 调用统计表（严格脱敏）                            -->
        <!-- ================================================================ -->
        <section class="mon-card" data-testid="section-api-keys">
          <div class="mon-card__header">
            <div class="mon-card__title-group">
              <h2 class="mon-card__title">多 Key 调用统计（脱敏）</h2>
              <span class="mon-card__subtitle">
                仅展示 Key ID、角色、启停状态及实时配额消耗，不暴露任何令牌明文或哈希
              </span>
            </div>
            <span class="sp-badge sp-badge--muted">
              {{ apiKeyRows.length }} 个已注册 Key
            </span>
          </div>

          <div class="mon-table-wrap">
            <table class="mon-table">
              <thead>
                <tr>
                  <th>Key ID</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th class="is-right">总请求</th>
                  <th class="is-right">成功</th>
                  <th class="is-right">错误</th>
                  <th class="is-right">缓存命中</th>
                  <th class="is-right">限流 (429)</th>
                  <th class="is-right">越权 (401)</th>
                  <th class="is-right">并发水位</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="apiKeyRows.length === 0">
                  <td colspan="10" class="mon-empty-cell">
                    未配置多 Key 清单（当前为单 DOKITOOL_OWNER_TOKEN 模式）
                  </td>
                </tr>
                <tr
                  v-for="keyRow in apiKeyRows"
                  :key="keyRow.id"
                  data-testid="api-key-row"
                  :data-key-id="keyRow.id"
                >
                  <td class="mon-mono">
                    <strong>{{ keyRow.id }}</strong>
                  </td>
                  <td>
                    <span
                      class="mon-role-badge"
                      :class="roleBadgeClass(keyRow.role)"
                    >
                      {{ keyRow.role }}
                    </span>
                  </td>
                  <td>
                    <span
                      class="sp-badge"
                      :class="
                        keyRow.enabled ? 'sp-badge--saved' : 'sp-badge--muted'
                      "
                    >
                      {{ keyRow.enabled ? "启用" : "停用" }}
                    </span>
                  </td>
                  <td class="is-right mon-mono">{{ keyRow.requests_total }}</td>
                  <td class="is-right mon-mono mon-text-ok">{{ keyRow.ok }}</td>
                  <td
                    class="is-right mon-mono"
                    :class="
                      keyRow.errors > 0 ? 'mon-text-danger' : 'mon-text-muted'
                    "
                  >
                    {{ keyRow.errors }}
                  </td>
                  <td class="is-right mon-mono">{{ keyRow.cache_hits }}</td>
                  <td
                    class="is-right mon-mono"
                    :class="
                      keyRow.rate_limited > 0
                        ? 'mon-text-danger'
                        : 'mon-text-muted'
                    "
                  >
                    {{ keyRow.rate_limited }}
                  </td>
                  <td
                    class="is-right mon-mono"
                    :class="
                      keyRow.unauthorized > 0
                        ? 'mon-text-danger'
                        : 'mon-text-muted'
                    "
                  >
                    {{ keyRow.unauthorized }}
                  </td>
                  <td class="is-right mon-mono">
                    {{ keyRow.active }} / {{ keyRow.concurrency_limit }}
                    <span v-if="keyRow.queued > 0" class="mon-text-muted">
                      (排队 {{ keyRow.queued }})
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>
