<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { validateApiBaseUrl } from "./hostWhitelist";
import type { ExtensionSettings, ExtensionThemeMode } from "./protocol";
import {
  aggregatePlatformHealth,
  buildDailyChartPoints,
  buildHourlyChartPoints,
  computeTodayVsYesterday,
  formatBytesCompact,
  formatPercent,
  formatUptimeDuration,
  isValidStatsSnapshot,
  resolveYtdlpQueuedCount,
  type DailyChartPoint,
  type HourlyChartPoint,
  type PlatformHealthRange,
  type PlatformHealthRow,
  type StatsSnapshot,
} from "./statsTypes";
import {
  DEFAULT_EXTENSION_SETTINGS,
  STORAGE_KEYS,
  buildApiAuthHeaders,
  createExtensionStorage,
  normalizeExtensionThemeMode,
} from "./storage";
import {
  applyExtensionTheme,
  getNextExtensionTheme,
  readCachedExtensionTheme,
  sendSidePanelRequest,
} from "./uiTargetHelpers";

// ============================================================================
// Constants & Types
// ============================================================================

const AUTO_REFRESH_INTERVAL_MS = 30_000;

type MonitorErrorState = {
  kind: "no_token" | "unauthorized" | "error";
  message: string;
  status?: number;
};

type PlatformSortKey =
  | "platform"
  | "total"
  | "ok"
  | "failed"
  | "successRate"
  | "p95Ms";

interface RuntimeSwitchRow {
  key: string;
  label: string;
  valueText: string;
  tone: "on" | "off" | "accent";
}

interface PoolWatermarkRow {
  id: string;
  label: string;
  active: number;
  limit: number;
  queued: number;
  queueLimit: number | null;
  ratioPct: number;
  tone: "normal" | "warn" | "danger";
  footSummary: string;
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

// ============================================================================
// Core State
// ============================================================================

const storage = createExtensionStorage();
const settings = ref<ExtensionSettings>({
  ...DEFAULT_EXTENSION_SETTINGS,
  theme: readCachedExtensionTheme(),
});

const stats = ref<StatsSnapshot | null>(null);
const apiOrigin = ref<string>(DEFAULT_EXTENSION_SETTINGS.apiBaseUrl);
const lastFetchedAt = ref<number | null>(null);
const loading = ref<boolean>(true);
const refreshing = ref<boolean>(false);
const errorState = ref<MonitorErrorState | null>(null);

// Auto-refresh (optional 30s toggle, pauses on hidden tab & refreshes on return)
const autoRefreshEnabled = ref<boolean>(false);
const pausedByVisibility = ref<boolean>(false);
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let fetchGeneration = 0;

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

const currentTheme = computed<ExtensionThemeMode>(() =>
  normalizeExtensionThemeMode(settings.value.theme),
);

const themeButtonLabel = computed<string>(() => {
  if (currentTheme.value === "light") return "浅色";
  if (currentTheme.value === "dark") return "深色";
  return "跟随系统";
});

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

const shanghaiHitRateText = computed<string>(() => {
  const sh = stats.value?.shanghai?.total;
  if (!sh) return "—";
  return formatPercent(sh.hits, sh.hits + sh.fallbacks, 1);
});

const shanghaiModeLabel = computed<string>(() => {
  const mode = stats.value?.shanghai?.mode || stats.value?.runtime?.shanghai_mode || "off";
  if (mode === "pull") return "Pull 拉取模式";
  if (mode === "direct") return "Direct 直连模式";
  return "未启用 (off)";
});

const uptimeText = computed<string>(() =>
  stats.value ? formatUptimeDuration(stats.value.uptime_seconds) : "—",
);

const runtimeSwitches = computed<RuntimeSwitchRow[]>(() => {
  const rt = stats.value?.runtime;
  if (!rt) return [];
  return [
    {
      key: "version",
      label: "后端版本",
      valueText: rt.version || "unknown",
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
    pool: StatsSnapshot["admission"]["fast"],
  ): PoolWatermarkRow => {
    const limit = Math.max(0, pool.concurrency_limit || 0);
    const active = Math.max(0, pool.active || 0);
    const ratioPct = limit > 0 ? Math.min(100, Math.round((active / limit) * 100)) : 0;
    return {
      id,
      label,
      active,
      limit,
      queued: Math.max(0, pool.queued || 0),
      queueLimit: Math.max(0, pool.queue_limit || 0),
      ratioPct,
      tone: buildPoolWatermarkTone(ratioPct),
      footSummary: `等待 ${pool.waited} · 放行 ${pool.granted} · 超时 ${pool.timeout} · 满载 ${pool.full}`,
    };
  };

  const ytLimit = Math.max(0, s.ytdlp.concurrency_limit || 0);
  const ytActive = Math.max(0, s.ytdlp.active || 0);
  const ytQueued = resolveYtdlpQueuedCount(s.ytdlp);
  const ytRatio =
    ytLimit > 0 ? Math.min(100, Math.round((ytActive / ytLimit) * 100)) : 0;

  return [
    makeAdmissionRow("fast", "快速池 (fast)", s.admission.fast),
    makeAdmissionRow("slow", "慢速池 (slow)", s.admission.slow),
    makeAdmissionRow("owner", "Owner 专属池 (owner)", s.admission.owner),
    {
      id: "ytdlp",
      label: "yt-dlp 并发槽位",
      active: ytActive,
      limit: ytLimit,
      queued: ytQueued,
      queueLimit: null,
      ratioPct: ytRatio,
      tone: buildPoolWatermarkTone(ytRatio),
      footSummary: `累计获取 ${s.ytdlp.total?.acquired_count ?? 0} · 等待 ${s.ytdlp.total?.wait_count ?? 0} · 最大等待 ${s.ytdlp.total?.wait_ms_max ?? 0} ms`,
    },
  ];
});

// Charts
const dailyChart = computed(() =>
  buildDailyChartPoints(stats.value?.daily ?? [], dailyChartDays.value),
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

// Platform health table with sorting
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
      return (av - bv) * dir || (b.total - a.total);
    }
    if (key === "p95Ms") {
      const av = a.p95Ms ?? -1;
      const bv = b.p95Ms ?? -1;
      return (av - bv) * dir || (b.total - a.total);
    }
    return ((a[key] as number) - (b[key] as number)) * dir || a.platform.localeCompare(b.platform);
  });
});

const apiKeyRows = computed(() => stats.value?.api_keys ?? []);

// ============================================================================
// Data Loading (SW RPC with Direct Fetch Fallback)
// ============================================================================

async function fetchStatsDirectFallback(): Promise<
  | { ok: true; stats: StatsSnapshot; apiOrigin: string; fetchedAt: number }
  | { ok: false; error: MonitorErrorState }
> {
  const currentSettings = await storage.getSettings();
  settings.value = { ...currentSettings };
  apiOrigin.value = currentSettings.apiBaseUrl;

  const token = currentSettings.bearerToken.trim();
  if (!token) {
    return {
      ok: false,
      error: {
        kind: "no_token",
        message: "尚未配置管理员（owner）Bearer Token",
        status: 401,
      },
    };
  }

  const validated = validateApiBaseUrl(currentSettings.apiBaseUrl);
  if (!validated.ok) {
    return {
      ok: false,
      error: {
        kind: "error",
        message: validated.error || "后端地址配置无效",
        status: 400,
      },
    };
  }

  try {
    const resp = await fetch(`${validated.origin}/api/stats?schema_version=1.0`, {
      method: "GET",
      headers: buildApiAuthHeaders(
        { bearerToken: token },
        { Accept: "application/json" },
      ),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    const payload = await resp.json().catch(() => null);
    if (
      resp.status === 200 &&
      payload &&
      typeof payload === "object" &&
      (payload as { code?: unknown }).code === "OK" &&
      isValidStatsSnapshot((payload as { data?: unknown }).data)
    ) {
      return {
        ok: true,
        stats: (payload as { data: StatsSnapshot }).data,
        apiOrigin: validated.origin,
        fetchedAt: Date.now(),
      };
    }
    if (resp.status === 401) {
      return {
        ok: false,
        error: {
          kind: "unauthorized",
          message: "当前 Bearer 凭据无权访问监控接口（需要 owner 角色）",
          status: 401,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "error",
        message: `监控接口请求失败（HTTP ${resp.status}）`,
        status: resp.status,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "error",
        message:
          err instanceof Error && err.message
            ? err.message
            : "无法连接后端监控接口",
        status: 0,
      },
    };
  }
}

async function fetchStats(options?: { silent?: boolean }) {
  const myGen = ++fetchGeneration;
  if (options?.silent && stats.value) {
    refreshing.value = true;
  } else if (!stats.value) {
    loading.value = true;
  } else {
    refreshing.value = true;
  }

  try {
    const rpc = await sendSidePanelRequest({ type: "FETCH_OWNER_STATS" });
    if (myGen !== fetchGeneration) return;

    if (rpc.ok) {
      stats.value = rpc.data.stats;
      apiOrigin.value = rpc.data.apiOrigin;
      lastFetchedAt.value = rpc.data.fetchedAt;
      errorState.value = null;
      return;
    }

    if (
      rpc.code === "NO_RUNTIME" ||
      rpc.code === "IPC_ERROR" ||
      rpc.code === "EMPTY_RESPONSE"
    ) {
      const direct = await fetchStatsDirectFallback();
      if (myGen !== fetchGeneration) return;
      if (direct.ok) {
        stats.value = direct.stats;
        apiOrigin.value = direct.apiOrigin;
        lastFetchedAt.value = direct.fetchedAt;
        errorState.value = null;
      } else {
        if (direct.error.kind !== "error") {
          stats.value = null;
        }
        errorState.value = direct.error;
      }
      return;
    }

    if (rpc.code === "NO_TOKEN") {
      stats.value = null;
      errorState.value = {
        kind: "no_token",
        message: "尚未配置管理员（owner）Bearer Token",
        status: 401,
      };
      return;
    }

    if (rpc.status === 401 || rpc.code === "UNAUTHORIZED") {
      stats.value = null;
      errorState.value = {
        kind: "unauthorized",
        message: "当前 Bearer 凭据无权访问监控接口（仅 owner 角色可查看）",
        status: 401,
      };
      return;
    }

    errorState.value = {
      kind: "error",
      message: rpc.error || "获取监控数据失败，请稍后重试",
      status: rpc.status,
    };
  } finally {
    if (myGen === fetchGeneration) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

// ============================================================================
// Auto-Refresh & Visibility Pause/Resume
// ============================================================================

function clearAutoRefreshTimer() {
  if (autoRefreshTimer !== null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function syncAutoRefreshTimer() {
  clearAutoRefreshTimer();
  if (!autoRefreshEnabled.value) {
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
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      pausedByVisibility.value = true;
      clearAutoRefreshTimer();
      return;
    }
    void fetchStats({ silent: true });
  }, AUTO_REFRESH_INTERVAL_MS);
  (autoRefreshTimer as { unref?: () => void })?.unref?.();
}

function handleToggleAutoRefresh() {
  autoRefreshEnabled.value = !autoRefreshEnabled.value;
  syncAutoRefreshTimer();
}

function handleVisibilityChange() {
  if (!autoRefreshEnabled.value) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    pausedByVisibility.value = true;
    clearAutoRefreshTimer();
  } else {
    pausedByVisibility.value = false;
    void fetchStats({ silent: true });
    syncAutoRefreshTimer();
  }
}

// ============================================================================
// Theme, Sort, and Chrome Storage Sync
// ============================================================================

async function handleCycleTheme() {
  const nextTheme = getNextExtensionTheme(settings.value.theme);
  settings.value = { ...settings.value, theme: nextTheme };
  applyExtensionTheme(nextTheme);
  const rpc = await sendSidePanelRequest({
    type: "UPDATE_SETTINGS",
    patch: { theme: nextTheme },
  });
  if (rpc.ok) {
    settings.value = { ...rpc.data.settings };
    applyExtensionTheme(rpc.data.settings.theme);
  } else {
    try {
      const updated = await storage.updateSettings({ theme: nextTheme });
      settings.value = { ...updated };
      applyExtensionTheme(updated.theme);
    } catch {
      // Keep local theme applied
    }
  }
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

function roleBadgeClass(role: string): string {
  const r = (role || "").trim().toLowerCase();
  if (r === "owner") return "mon-role-badge--owner";
  if (r === "friend") return "mon-role-badge--friend";
  if (r === "agent") return "mon-role-badge--agent";
  return "mon-role-badge--other";
}

type ChromeStorageChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void;

let storageChangeListener: ChromeStorageChangeListener | null = null;

function getChromeStorageOnChanged():
  | {
      addListener(cb: ChromeStorageChangeListener): void;
      removeListener(cb: ChromeStorageChangeListener): void;
    }
  | undefined {
  const g = globalThis as unknown as {
    chrome?: {
      storage?: {
        onChanged?: {
          addListener(cb: ChromeStorageChangeListener): void;
          removeListener(cb: ChromeStorageChangeListener): void;
        };
      };
    };
  };
  return g.chrome?.storage?.onChanged;
}

onMounted(async () => {
  try {
    const initial = await storage.getSettings();
    settings.value = { ...initial };
    apiOrigin.value = initial.apiBaseUrl;
    applyExtensionTheme(initial.theme);
  } catch {
    // Keep defaults
  }

  storageChangeListener = (_changes, areaName) => {
    if (areaName !== "local") return;
    if (!(_changes && STORAGE_KEYS.SETTINGS in _changes)) return;
    const prevToken = settings.value.bearerToken.trim();
    const prevUrl = settings.value.apiBaseUrl.trim();
    void storage
      .getSettings()
      .then((next) => {
        settings.value = { ...next };
        apiOrigin.value = next.apiBaseUrl;
        applyExtensionTheme(next.theme);
        if (
          next.bearerToken.trim() !== prevToken ||
          next.apiBaseUrl.trim() !== prevUrl
        ) {
          void fetchStats();
        }
      })
      .catch(() => {});
  };
  getChromeStorageOnChanged()?.addListener(storageChangeListener);

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  await fetchStats();
});

onUnmounted(() => {
  clearAutoRefreshTimer();
  if (storageChangeListener) {
    getChromeStorageOnChanged()?.removeListener(storageChangeListener);
    storageChangeListener = null;
  }
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }
});
</script>

<template>
  <div class="mon-page" data-testid="monitor-dashboard-root">
    <!-- Sticky Widescreen Topbar -->
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
              <span class="sp-badge sp-badge--accent">Owner 只读遥测</span>
            </div>
            <div class="mon-brand__meta">
              <span class="mon-brand__origin">{{ apiOrigin }}</span>
              <span>最后刷新：{{ formattedFetchedTime }}</span>
              <span>统计时区：Asia/Shanghai (UTC+8)</span>
            </div>
          </div>
        </div>

        <div class="mon-controls">
          <button
            type="button"
            class="mon-auto-btn"
            :class="{
              'mon-auto-btn--on': autoRefreshEnabled && !pausedByVisibility,
              'mon-auto-btn--paused': autoRefreshEnabled && pausedByVisibility,
            }"
            :aria-pressed="autoRefreshEnabled"
            data-testid="monitor-auto-refresh-toggle"
            @click="handleToggleAutoRefresh"
          >
            <span
              class="mon-status-dot"
              :class="{
                'mon-status-dot--ok': autoRefreshEnabled && !pausedByVisibility,
                'mon-status-dot--warn': autoRefreshEnabled && pausedByVisibility,
              }"
            />
            <span v-if="!autoRefreshEnabled">30s 自动刷新：关</span>
            <span v-else-if="pausedByVisibility">30s 自动刷新：已暂停</span>
            <span v-else>30s 自动刷新：开</span>
          </button>

          <button
            type="button"
            class="sp-btn sp-btn--secondary sp-btn--sm"
            :disabled="loading || refreshing"
            data-testid="monitor-refresh-btn"
            @click="fetchStats()"
          >
            <span>{{ refreshing || loading ? "刷新中..." : "立即刷新" }}</span>
          </button>

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
        </div>
      </div>
    </header>

    <main class="mon-main">
      <!-- Initial Loading -->
      <div v-if="loading && !stats" class="mon-loading">
        <div class="mon-loading__spinner sp-spin" />
        <span>正在拉取实时解析监控快照...</span>
      </div>

      <!-- Missing Token / 401 Unauthorized Guidance Card (Never leaks token!) -->
      <section
        v-else-if="
          !stats &&
          errorState &&
          (errorState.kind === 'no_token' ||
            errorState.kind === 'unauthorized')
        "
        class="mon-guard-card"
        data-testid="monitor-auth-guard"
      >
        <span class="mon-guard-card__badge">
          {{
            errorState.kind === "no_token"
              ? "未配置凭据"
              : "HTTP 401 · 权限不足"
          }}
        </span>
        <h2 class="mon-guard-card__title">
          {{
            errorState.kind === "no_token"
              ? "请先配置管理员（owner）Bearer Token"
              : "当前凭据无权访问管理员监控大盘"
          }}
        </h2>
        <p class="mon-guard-card__desc">
          {{ errorState.message }}。<code>/api/stats</code>
          仅对 <strong>owner</strong> 角色开放，匿名访问与
          <code>friend</code> / <code>agent</code> 凭据均被后端拒绝。
        </p>
        <ol class="mon-guard-card__steps">
          <li>点击浏览器工具栏中的 DokiTool 扩展图标打开侧边栏。</li>
          <li>点击右上角「设置」按钮，检查后端服务地址并填入具有 owner 权限的 Bearer Token。</li>
          <li>保存设置后本页面会自动感知更新，或点击下方按钮立即重新拉取。</li>
        </ol>
        <div class="mon-guard-card__actions">
          <button
            type="button"
            class="sp-btn sp-btn--primary sp-btn--sm"
            @click="fetchStats()"
          >
            重新检测权限
          </button>
        </div>
      </section>

      <!-- Generic Load Error without Data -->
      <section
        v-else-if="!stats && errorState"
        class="mon-guard-card"
        data-testid="monitor-error-card"
      >
        <span class="mon-guard-card__badge">连接异常</span>
        <h2 class="mon-guard-card__title">暂时无法加载监控数据</h2>
        <p class="mon-guard-card__desc">{{ errorState.message }}</p>
        <div class="mon-guard-card__actions">
          <button
            type="button"
            class="sp-btn sp-btn--primary sp-btn--sm"
            @click="fetchStats()"
          >
            重试拉取
          </button>
        </div>
      </section>

      <!-- Main 5-Section Widescreen Dashboard -->
      <template v-else-if="stats && todaySummary">
        <!-- Non-blocking stale refresh warning -->
        <div
          v-if="errorState"
          class="mon-inline-banner"
          role="status"
          data-testid="monitor-stale-banner"
        >
          <span>最近一次刷新失败：{{ errorState.message }}（当前展示上次快照）</span>
          <button
            type="button"
            class="sp-btn sp-btn--ghost sp-btn--xs"
            @click="fetchStats()"
          >
            重试
          </button>
        </div>

        <!-- ================================================================ -->
        <!-- Section 1: 核心指标卡 (4-Column KPI Grid)                         -->
        <!-- ================================================================ -->
        <section
          class="mon-kpi-grid"
          aria-label="核心指标卡"
          data-testid="section-kpi-cards"
        >
          <!-- KPI 1: Today Parses & Success Rate + Yesterday Delta -->
          <article class="mon-kpi mon-kpi--info">
            <div class="mon-kpi__label">
              <span>今日解析总量 &amp; 成功率</span>
              <span class="mon-mono">{{ todaySummary.date || "今日" }}</span>
            </div>
            <div class="mon-kpi__main">
              <span class="mon-kpi__value">{{ todaySummary.total }}</span>
              <span
                class="sp-badge"
                :class="
                  todaySummary.successRate === null
                    ? 'sp-badge--muted'
                    : todaySummary.successRate >= 95
                      ? 'sp-badge--saved'
                      : 'sp-badge--warn'
                "
              >
                成功率
                {{ formatPercent(todaySummary.ok, todaySummary.total, 1) }}
              </span>
            </div>
            <div class="mon-kpi__deltas">
              <span
                class="mon-delta-pill"
                :class="`mon-delta-pill--${todayDeltaTotalTone}`"
              >
                {{ todayDeltaTotalText }}
              </span>
              <span
                class="mon-delta-pill"
                :class="`mon-delta-pill--${todayDeltaRateTone}`"
              >
                {{ todayDeltaRateText }}
              </span>
            </div>
            <div class="mon-kpi__meta">
              <span>成功 {{ todaySummary.ok }} / 失败 {{ todaySummary.failed }}</span>
              <span>P50 {{ todaySummary.p50Ms }}ms · P95 {{ todaySummary.p95Ms }}ms</span>
            </div>
          </article>

          <!-- KPI 2: Cache Hit Rate & Memory Occupancy -->
          <article class="mon-kpi mon-kpi--success">
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
              <span class="mon-kpi__value">{{ cacheHitRateText }}</span>
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
              <span>累计命中 {{ stats.cache.total.hits }} / 未中 {{ stats.cache.total.misses }}</span>
              <span>合流复用 {{ stats.cache.total.singleflight_shared }}</span>
            </div>
          </article>

          <!-- KPI 3: Shanghai Exit Nodes & Hit Rate -->
          <article class="mon-kpi mon-kpi--warn">
            <div class="mon-kpi__label">
              <span>上海出口节点 &amp; 命中率</span>
              <span class="sp-badge sp-badge--muted">{{ shanghaiModeLabel }}</span>
            </div>
            <div class="mon-kpi__main">
              <span class="mon-kpi__value">
                <span
                  class="mon-status-dot"
                  :class="
                    stats.shanghai.waiting_workers > 0
                      ? 'mon-status-dot--ok'
                      : ''
                  "
                  style="display: inline-block; margin-right: 6px; vertical-align: middle"
                />
                {{ stats.shanghai.waiting_workers }} 节点
              </span>
              <span class="sp-badge sp-badge--accent">
                命中率 {{ shanghaiHitRateText }}
              </span>
            </div>
            <div class="mon-kpi__meta">
              <span>今日上海命中 {{ todaySummary.shanghaiHits }}</span>
              <span>累计命中 {{ stats.shanghai.total.hits }} / 回退 {{ stats.shanghai.total.fallbacks }}</span>
            </div>
            <div class="mon-kpi__meta">
              <span>排队任务 {{ stats.shanghai.queued_tasks }} · 执行中 {{ stats.shanghai.pending_tasks }}</span>
              <span>超时 {{ stats.shanghai.total.queue_timeouts }}</span>
            </div>
          </article>

          <!-- KPI 4: Version & Uptime -->
          <article class="mon-kpi">
            <div class="mon-kpi__label">
              <span>服务版本 &amp; 在线时长</span>
              <span class="sp-badge sp-badge--accent mon-mono">
                {{ stats.runtime.version }}
              </span>
            </div>
            <div class="mon-kpi__main">
              <span class="mon-kpi__value mon-kpi__value--compact">
                {{ uptimeText }}
              </span>
            </div>
            <div class="mon-kpi__meta">
              <span>启动以来累计 {{ stats.requests.total }} 次</span>
              <span>匿名 {{ stats.requests.by_channel.anonymous }} · Owner {{ stats.requests.by_channel.owner }}</span>
            </div>
            <div class="mon-kpi__meta">
              <span>最大耗时 {{ stats.parse_latency_ms.total.max_ms }} ms</span>
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
                <span
                  class="mon-switch-pill"
                  :class="`mon-switch-pill--${item.tone}`"
                >
                  {{ item.valueText }}
                </span>
              </div>
            </div>
          </article>

          <!-- Concurrency Pools Watermark -->
          <article class="mon-card">
            <div class="mon-card__header">
              <div class="mon-card__title-group">
                <h2 class="mon-card__title">并发池实时水位</h2>
                <span class="mon-card__subtitle">
                  admission (fast / slow / owner) 与共享 yt-dlp 信号量活跃与排队状态
                </span>
              </div>
              <span class="sp-badge sp-badge--muted">4 组资源池</span>
            </div>

            <div class="mon-pools-list" data-testid="concurrency-pools">
              <div
                v-for="pool in concurrencyPools"
                :key="pool.id"
                class="mon-pool-row"
                :data-pool-id="pool.id"
              >
                <div class="mon-pool-row__top">
                  <span class="mon-pool-row__name">{{ pool.label }}</span>
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
                <div class="mon-pool-bar" aria-hidden="true">
                  <div
                    class="mon-pool-bar__fill"
                    :class="
                      pool.tone === 'normal'
                        ? ''
                        : `mon-pool-bar__fill--${pool.tone}`
                    "
                    :style="{ width: `${pool.ratioPct}%` }"
                  />
                </div>
                <div class="mon-pool-row__foot">
                  <span>{{ pool.footSummary }}</span>
                  <span>负载 {{ pool.ratioPct }}%</span>
                </div>
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

                <!-- Success Rate Dots -->
                <circle
                  v-for="pt in dailyChart.points"
                  v-show="pt.rateY !== null"
                  :key="`rate-${pt.date}`"
                  class="mon-svg__rate-dot"
                  :class="{
                    'mon-svg__rate-dot--active':
                      activeDailyPoint?.date === pt.date,
                  }"
                  :cx="pt.centerX"
                  :cy="pt.rateY ?? dailyChart.plotBottom"
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
        <!-- Section 4: 平台每日解析健康度总览表 (5 Time Windows + Sorting)     -->
        <!-- ================================================================ -->
        <section class="mon-card" data-testid="section-platform-health">
          <div class="mon-card__header">
            <div class="mon-card__title-group">
              <h2 class="mon-card__title">平台解析健康度总览</h2>
              <span class="mon-card__subtitle">
                覆盖 14 个核心平台及长尾扩展平台，支持按时间窗口切换与字段排序
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
            <table class="mon-table">
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
                  <td colspan="7" class="mon-empty-cell">
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
                      <div class="mon-rate-bar" aria-hidden="true">
                        <div
                          class="mon-rate-bar__fill"
                          :class="`mon-rate-bar__fill--${rateToneClass(row.successRate)}`"
                          :style="{
                            width: `${row.successRate !== null ? Math.round(row.successRate) : 0}%`,
                          }"
                        />
                      </div>
                      <span class="mon-mono">
                        {{ formatPercent(row.ok, row.total, 1) }}
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
