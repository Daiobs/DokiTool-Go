// Pure View-Model Derivations for `/monitor` Dashboard (zero Vue/DOM/browser side effects).

import {
  aggregatePlatformHealth, buildDailyChartPoints, buildHourlyChartPoints,
  computeTodayVsYesterday, formatMonitorVersionBadge, formatPercent,
  formatUptimeDuration, resolveYtdlpQueuedCount,
  type AdmissionPoolSnapshot, type DailyChartGeometry, type DailyChartPoint,
  type DailyStatsBucket, type HourlyChartGeometry, type HourlyChartPoint,
  type MonitorVersionBadge, type PlatformHealthRange, type PlatformHealthRow,
  type StatsSnapshot, type TodayVsYesterdaySummary,
  type YTDLPCompartmentPoolSnapshot, type YTDLPStatsSnapshot,
} from "./statsTypes";

export type MonitorThemeOption = "system" | "light" | "dark";
export type MonitorTokenSource = "session" | "local" | null;
export type SortDirection = "asc" | "desc";
export type PoolWatermarkTone = "normal" | "warn" | "danger";
export type ShanghaiNodeStatus = "off" | "online" | "degraded" | "offline";
export type PrimaryNodeStatus = "unknown" | "online" | "degraded" | "offline";
export type MonitorOverallHealthLevel = "empty" | "healthy" | "degraded" | "critical";
export type PlatformSortKey =
  | "platform" | "total" | "ok" | "failed" | "successRate" | "effectiveSuccessRate" | "p95Ms";

export interface RuntimeSwitchRow {
  key: string; label: string; valueText: string;
  fullValue?: string; copyable?: boolean; tone: "on" | "off" | "accent";
}

export interface PoolWatermarkRow {
  id: string; label: string; kind: "admission" | "slot"; kindLabel: string;
  active: number; limit: number; queued: number; queueLimit: number | null;
  ratioPct: number; tone: PoolWatermarkTone; footSummary: string;
}

export interface CompartmentPoolRow {
  id: "youtube" | "social" | "generic" | "youtube_ejs"; label: string; enabled: boolean;
  active: number; limit: number; queued: number; queueLimit: number;
  ratioPct: number; tone: PoolWatermarkTone; footSummary: string;
}

export interface PoolQueueSeverity {
  ratioPct: number; queueRatioPct: number | null;
  activeTone: PoolWatermarkTone; queueTone: PoolWatermarkTone; overallTone: PoolWatermarkTone;
}

export interface ShanghaiPlatformBreakdown {
  douyinHits: number; douyinFallbacks: number; bilibiliHits: number; bilibiliFallbacks: number;
}

export interface ShanghaiNodeHealthSummary {
  mode: string; modeLabel: string; status: ShanghaiNodeStatus;
  waitingWorkers: number; queuedTasks: number; pendingTasks: number; queueTimeouts: number;
  totalHits: number; totalFallbacks: number; hitRateText: string; fallbackRatePct: number | null;
  breakdown: ShanghaiPlatformBreakdown; summaryText: string;
}

export interface MonitorKpiViewModel {
  themeButtonLabel: string; credentialSourceLabel: string; formattedFetchedTime: string;
  todaySummary: TodayVsYesterdaySummary | null; effectiveSuccessRateText: string;
  todayDeltaTotalText: string; todayDeltaTotalTone: "up" | "down" | "flat";
  todayDeltaRateText: string; todayDeltaRateTone: "up" | "down" | "flat";
  cacheHitRateText: string; cacheStaleHits: number;
  shanghaiHitRateText: string; shanghaiModeLabel: string;
  shanghaiPlatformBreakdown: ShanghaiPlatformBreakdown; shanghaiHealth: ShanghaiNodeHealthSummary;
  versionInfo: MonitorVersionBadge; uptimeText: string;
}

export interface MonitorDailyChartView {
  chart: DailyChartGeometry;
  ratePoints: Array<DailyChartPoint & { rateY: number }>;
  activePoint: DailyChartPoint | null;
}

export interface MonitorHourlyChartView {
  chart: HourlyChartGeometry;
  activePoint: HourlyChartPoint | null;
}

export interface MonitorAlertItem {
  code: string; severity: "warn" | "danger"; title: string; detail: string;
}

export interface MonitorHealthSummary {
  level: MonitorOverallHealthLevel; primaryNodeStatus: PrimaryNodeStatus;
  shanghaiNodeStatus: ShanghaiNodeStatus; dualNodeDegraded: boolean;
  summaryText: string; alerts: MonitorAlertItem[];
}

export const HEALTH_RANGE_OPTIONS: ReadonlyArray<{ key: PlatformHealthRange; label: string }> = [
  { key: "today", label: "今日" },
  { key: "yesterday", label: "昨日" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "since_start", label: "启动以来" },
];

const ZERO_ADMISSION_POOL: AdmissionPoolSnapshot = {
  active: 0, queued: 0, concurrency_limit: 0, queue_limit: 0, waited: 0,
  granted: 0, timeout: 0, full: 0, canceled: 0, wait_ms_total: 0, wait_ms_max: 0,
};
const ZERO_YTDLP_POOL = {
  active: 0, concurrency_limit: 0, waiting: 0,
  total: { acquired_count: 0, wait_count: 0, wait_ms_max: 0 },
};

const safeNonNegInt = (raw: unknown): number =>
  typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;

const calcRatioPct = (active: number, limit: number): number =>
  limit > 0 ? Math.min(100, Math.round((active / limit) * 100)) : 0;

const maxTone = (a: PoolWatermarkTone, b: PoolWatermarkTone): PoolWatermarkTone =>
  a === "danger" || b === "danger" ? "danger" : a === "warn" || b === "warn" ? "warn" : "normal";

export const formatMonitorThemeLabel = (theme: MonitorThemeOption): string =>
  theme === "light" ? "浅色" : theme === "dark" ? "深色" : "跟随系统";

export const formatCredentialSourceLabel = (source: MonitorTokenSource): string =>
  source === "local" ? "本机已记住" : "会话级凭据";

export function formatFetchedTimeShanghai(fetchedAtMs: number | null): string {
  if (fetchedAtMs === null || !Number.isFinite(fetchedAtMs)) return "尚未同步";
  const d = new Date(fetchedAtMs + 8 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} (UTC+8)`;
}

export function buildPoolWatermarkTone(ratioPct: number): PoolWatermarkTone {
  if (!Number.isFinite(ratioPct)) return "normal";
  return ratioPct >= 90 ? "danger" : ratioPct >= 70 ? "warn" : "normal";
}

export function classifyPoolQueueSeverity(params: {
  active: number; limit: number; queued: number; queueLimit: number | null;
  timeout?: number; full?: number;
}): PoolQueueSeverity {
  const limit = safeNonNegInt(params.limit);
  const active = safeNonNegInt(params.active);
  const queued = safeNonNegInt(params.queued);
  const queueLimit = params.queueLimit === null ? null : safeNonNegInt(params.queueLimit);
  const ratioPct = calcRatioPct(active, limit);
  const activeTone = buildPoolWatermarkTone(ratioPct);
  let queueRatioPct: number | null = null;
  let queueTone: PoolWatermarkTone = "normal";

  if (queueLimit !== null && queueLimit > 0) {
    queueRatioPct = calcRatioPct(queued, queueLimit);
    queueTone = queueRatioPct >= 80 ? "danger" : queueRatioPct >= 50 || queued > 0 ? "warn" : "normal";
  } else if (queued > 0) {
    queueTone = limit > 0 && queued >= limit ? "danger" : "warn";
  }
  if (safeNonNegInt(params.full) > 0 || safeNonNegInt(params.timeout) > 0) queueTone = "danger";

  return { ratioPct, queueRatioPct, activeTone, queueTone, overallTone: maxTone(activeTone, queueTone) };
}

export function summarizeShanghaiNodeHealth(stats: StatsSnapshot | null): ShanghaiNodeHealthSummary {
  const mode = stats?.shanghai?.mode || stats?.runtime?.shanghai_mode || "off";
  const modeLabel = mode === "pull" ? "Pull 拉取模式" : mode === "direct" ? "Direct 直连模式" : "未启用 (off)";
  const sh = stats?.shanghai;
  const waitingWorkers = safeNonNegInt(sh?.waiting_workers);
  const queuedTasks = safeNonNegInt(sh?.queued_tasks);
  const pendingTasks = safeNonNegInt(sh?.pending_tasks);
  const queueTimeouts = safeNonNegInt(sh?.total?.queue_timeouts);
  const totalHits = safeNonNegInt(sh?.total?.hits);
  const totalFallbacks = safeNonNegInt(sh?.total?.fallbacks);
  const totalAttempts = totalHits + totalFallbacks;
  const hitRateText = sh?.total ? formatPercent(totalHits, totalAttempts, 1) : "—";
  const fallbackRatePct = totalAttempts > 0 ? Number(((totalFallbacks / totalAttempts) * 100).toFixed(1)) : null;
  const byPlat = sh?.by_platform;
  const breakdown: ShanghaiPlatformBreakdown = {
    douyinHits: safeNonNegInt(byPlat?.douyin?.hits),
    douyinFallbacks: safeNonNegInt(byPlat?.douyin?.fallbacks),
    bilibiliHits: safeNonNegInt(byPlat?.bilibili?.hits),
    bilibiliFallbacks: safeNonNegInt(byPlat?.bilibili?.fallbacks),
  };

  let status: ShanghaiNodeStatus = "off";
  let summaryText = "上海出口未启用";
  if (stats && mode !== "off") {
    if (mode === "pull" && waitingWorkers <= 0) {
      status = "offline";
      summaryText = `上海出口无在线节点（排队 ${queuedTasks}，回退 ${totalFallbacks}）`;
    } else if (queueTimeouts > 0 || (fallbackRatePct !== null && fallbackRatePct >= 50)) {
      status = "degraded";
      summaryText = `上海出口降级（${waitingWorkers} 节点在线，回退率 ${fallbackRatePct ?? 0}%，超时 ${queueTimeouts}）`;
    } else {
      status = "online";
      summaryText = `上海出口正常（${waitingWorkers} 节点在线，命中率 ${hitRateText}）`;
    }
  }
  return {
    mode, modeLabel, status, waitingWorkers, queuedTasks, pendingTasks,
    queueTimeouts, totalHits, totalFallbacks, hitRateText, fallbackRatePct, breakdown, summaryText,
  };
}

export function buildMonitorKpiViewModel(
  stats: StatsSnapshot | null,
  lastFetchedAt: number | null,
  tokenSource: MonitorTokenSource,
  currentTheme: MonitorThemeOption,
): MonitorKpiViewModel {
  const todaySummary = stats ? computeTodayVsYesterday(stats) : null;
  const effectiveSuccessRateText =
    !todaySummary || todaySummary.effectiveSuccessRate === null ? "—" : `${todaySummary.effectiveSuccessRate.toFixed(1)}%`;

  let todayDeltaTotalText = "较昨日 —";
  let todayDeltaTotalTone: "up" | "down" | "flat" = "flat";
  if (todaySummary?.yesterdayDate) {
    if (todaySummary.deltaTotal > 0) {
      todayDeltaTotalText = `较昨日 +${todaySummary.deltaTotal}`;
      todayDeltaTotalTone = "up";
    } else if (todaySummary.deltaTotal < 0) {
      todayDeltaTotalText = `较昨日 ${todaySummary.deltaTotal}`;
      todayDeltaTotalTone = "down";
    } else {
      todayDeltaTotalText = "较昨日持平";
    }
  }

  let todayDeltaRateText = "成功率变化 —";
  let todayDeltaRateTone: "up" | "down" | "flat" = "flat";
  if (todaySummary && todaySummary.deltaRatePct !== null) {
    const sign = todaySummary.deltaRatePct > 0 ? "+" : "";
    todayDeltaRateText = `较昨日 ${sign}${todaySummary.deltaRatePct.toFixed(1)}pp`;
    todayDeltaRateTone = todaySummary.deltaRatePct > 0 ? "up" : todaySummary.deltaRatePct < 0 ? "down" : "flat";
  }

  const cacheTotal = stats?.cache?.total;
  const shanghaiHealth = summarizeShanghaiNodeHealth(stats);
  return {
    themeButtonLabel: formatMonitorThemeLabel(currentTheme),
    credentialSourceLabel: formatCredentialSourceLabel(tokenSource),
    formattedFetchedTime: formatFetchedTimeShanghai(lastFetchedAt),
    todaySummary, effectiveSuccessRateText, todayDeltaTotalText, todayDeltaTotalTone,
    todayDeltaRateText, todayDeltaRateTone,
    cacheHitRateText: cacheTotal ? formatPercent(cacheTotal.hits, cacheTotal.hits + cacheTotal.misses, 1) : "—",
    cacheStaleHits: safeNonNegInt(cacheTotal?.stale_hits),
    shanghaiHitRateText: shanghaiHealth.hitRateText,
    shanghaiModeLabel: shanghaiHealth.modeLabel,
    shanghaiPlatformBreakdown: shanghaiHealth.breakdown,
    shanghaiHealth,
    versionInfo: formatMonitorVersionBadge(stats?.runtime?.version),
    uptimeText: stats ? formatUptimeDuration(stats.uptime_seconds) : "—",
  };
}

export function buildRuntimeSwitchRows(stats: StatsSnapshot | null): RuntimeSwitchRow[] {
  const rt = stats?.runtime;
  if (!rt) return [];
  const ver = formatMonitorVersionBadge(rt.version);
  const flag = (key: string, label: string, on: boolean): RuntimeSwitchRow => ({
    key, label, valueText: on ? "ON" : "OFF", tone: on ? "on" : "off",
  });
  return [
    { key: "version", label: "后端版本", valueText: ver.display, fullValue: ver.full, copyable: true, tone: "accent" },
    { key: "shanghai_mode", label: "上海出口模式", valueText: rt.shanghai_mode || "off", tone: rt.shanghai_mode && rt.shanghai_mode !== "off" ? "on" : "off" },
    flag("shanghai_bilibili", "上海 B 站代理", rt.shanghai_bilibili),
    flag("bilibili_dash", "B 站 DASH 合流", rt.bilibili_dash),
    flag("youtube_helper", "YouTube 客户端助手", rt.youtube_helper),
    { key: "xhs_transport", label: "小红书传输栈", valueText: rt.xhs_transport || "standard", tone: rt.xhs_transport === "chrome131" ? "accent" : "off" },
    flag("ytdlp_enabled", "yt-dlp 引擎", rt.ytdlp_enabled),
    flag("ytdlp_generic_enabled", "yt-dlp 通用长尾", rt.ytdlp_generic_enabled),
    flag("tbvideo_pipigx", "皮皮搞笑省流直链", rt.tbvideo_pipigx),
    flag("tbvideo_zuiyou", "最右省流直链", rt.tbvideo_zuiyou),
    flag("stats_persistence_enabled", "统计原子落盘", rt.stats_persistence_enabled),
  ];
}

export function buildConcurrencyPoolRows(stats: StatsSnapshot | null): PoolWatermarkRow[] {
  if (!stats) return [];
  const makeAdmission = (id: string, label: string, pool?: AdmissionPoolSnapshot): PoolWatermarkRow => {
    const p = pool ?? ZERO_ADMISSION_POOL;
    const limit = Math.max(0, p.concurrency_limit || 0);
    const active = Math.max(0, p.active || 0);
    const ratioPct = calcRatioPct(active, limit);
    return {
      id, label, kind: "admission", kindLabel: "排队放行", active, limit,
      queued: Math.max(0, p.queued || 0), queueLimit: Math.max(0, p.queue_limit || 0),
      ratioPct, tone: buildPoolWatermarkTone(ratioPct),
      footSummary: `排队放行 · 本次启动等待 ${p.waited ?? 0} · 放行 ${p.granted ?? 0} · 超时 ${p.timeout ?? 0} · 满载 ${p.full ?? 0}`,
    };
  };
  const makeYtdlp = (id: string, label: string, slot?: YTDLPStatsSnapshot): PoolWatermarkRow => {
    const s = slot ?? ZERO_YTDLP_POOL;
    const limit = Math.max(0, s.concurrency_limit || 0);
    const active = Math.max(0, s.active || 0);
    const ratioPct = calcRatioPct(active, limit);
    return {
      id, label, kind: "slot", kindLabel: "共享总网关槽位", active, limit,
      queued: resolveYtdlpQueuedCount(slot ?? (ZERO_YTDLP_POOL as YTDLPStatsSnapshot)),
      queueLimit: null, ratioPct, tone: buildPoolWatermarkTone(ratioPct),
      footSummary: `共享总网关槽位 · 本次启动获取 ${s.total?.acquired_count ?? 0} · 等待 ${s.total?.wait_count ?? 0} · 最大等待 ${s.total?.wait_ms_max ?? 0} ms`,
    };
  };
  return [
    makeAdmission("fast", "快速池 (fast)", stats.admission?.fast),
    makeAdmission("slow", "慢速池 (slow)", stats.admission?.slow),
    makeAdmission("generic_slow", "通用长尾慢池 (generic_slow)", stats.admission?.generic_slow),
    makeAdmission("owner", "Owner 专属池 (owner)", stats.admission?.owner),
    makeYtdlp("ytdlp", "yt-dlp 并发槽位 (ytdlp)", stats.ytdlp),
    makeYtdlp("ytdlp_generic", "yt-dlp 通用长尾槽位 (ytdlp_generic)", stats.ytdlp_generic),
  ];
}

export function buildYtdlpCompartmentPoolRows(stats: StatsSnapshot | null): CompartmentPoolRow[] {
  const pools = stats?.ytdlp_pools;
  if (!pools) return [];
  const makeRow = (id: CompartmentPoolRow["id"], label: string, pool?: YTDLPCompartmentPoolSnapshot): CompartmentPoolRow => {
    const limit = Math.max(0, pool?.concurrency_limit || 0);
    const active = Math.max(0, pool?.active || 0);
    const ratioPct = calcRatioPct(active, limit);
    return {
      id, label, enabled: Boolean(pool?.enabled), active, limit,
      queued: Math.max(0, pool?.queued || 0), queueLimit: Math.max(0, pool?.queue_limit || 0),
      ratioPct, tone: buildPoolWatermarkTone(ratioPct),
      footSummary: `本次启动等待 ${pool?.waited ?? 0} · 放行 ${pool?.granted ?? 0} · 超时 ${pool?.timeout ?? 0} · 满载 ${pool?.full ?? 0} · 最大等待 ${pool?.wait_ms_max ?? 0} ms`,
    };
  };
  return [
    makeRow("youtube", "YouTube 舱", pools.youtube),
    makeRow("social", "社交慢链舱", pools.social),
    makeRow("generic", "长尾 Generic 舱", pools.generic),
    makeRow("youtube_ejs", "YouTube EJS 池", pools.youtube_ejs),
  ];
}

export function normalizeDailyTrendBuckets(
  daily: readonly DailyStatsBucket[] | null | undefined,
  days: 7 | 30,
): DailyStatsBucket[] {
  if (!Array.isArray(daily) || daily.length === 0) return [];
  return daily
    .filter((b): b is DailyStatsBucket => Boolean(b && typeof b.date === "string"))
    .slice(-days)
    .map((b) => ({
      ...b,
      total: safeNonNegInt(b.total), ok: safeNonNegInt(b.ok), failed: safeNonNegInt(b.failed),
      cache_hits: safeNonNegInt(b.cache_hits), shanghai_hits: safeNonNegInt(b.shanghai_hits),
    }));
}

const pickActivePoint = <T>(points: readonly T[], hoveredIndex: number | null): T | null =>
  points.length === 0 ? null : hoveredIndex !== null && hoveredIndex >= 0 && hoveredIndex < points.length ? points[hoveredIndex] : points[points.length - 1];

export function buildMonitorDailyChartView(stats: StatsSnapshot | null, days: 7 | 30, hoveredIndex: number | null): MonitorDailyChartView {
  const chart = buildDailyChartPoints(normalizeDailyTrendBuckets(stats?.daily, days), days);
  const ratePoints = chart.points.filter((pt): pt is DailyChartPoint & { rateY: number } => pt.rateY !== null);
  return { chart, ratePoints, activePoint: pickActivePoint(chart.points, hoveredIndex) };
}

export function buildMonitorHourlyChartView(stats: StatsSnapshot | null, hoveredIndex: number | null): MonitorHourlyChartView {
  const chart = buildHourlyChartPoints(stats?.hourly ?? []);
  return { chart, activePoint: pickActivePoint(chart.points, hoveredIndex) };
}

export function sortPlatformHealthRows(rows: readonly PlatformHealthRow[], sortKey: PlatformSortKey, sortDir: SortDirection): PlatformHealthRow[] {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sortKey === "platform") return a.label.localeCompare(b.label, "zh-CN") * dir;
    if (sortKey === "successRate") return ((a.successRate ?? -1) - (b.successRate ?? -1)) * dir || b.total - a.total;
    if (sortKey === "effectiveSuccessRate") return ((a.effectiveSuccessRate ?? -1) - (b.effectiveSuccessRate ?? -1)) * dir || b.effectiveTotal - a.effectiveTotal;
    if (sortKey === "p95Ms") return ((a.p95Ms ?? -1) - (b.p95Ms ?? -1)) * dir || b.total - a.total;
    return ((a[sortKey] as number) - (b[sortKey] as number)) * dir || a.platform.localeCompare(b.platform);
  });
}

export const buildSortedPlatformHealthRows = (
  stats: StatsSnapshot | null, range: PlatformHealthRange, sortKey: PlatformSortKey, sortDir: SortDirection,
): PlatformHealthRow[] => (stats ? sortPlatformHealthRows(aggregatePlatformHealth(stats, range), sortKey, sortDir) : []);

export const computeNextPlatformSort = (
  currentKey: PlatformSortKey, currentDir: SortDirection, clickedKey: PlatformSortKey,
): { sortKey: PlatformSortKey; sortDir: SortDirection } =>
  currentKey === clickedKey
    ? { sortKey: currentKey, sortDir: currentDir === "desc" ? "asc" : "desc" }
    : { sortKey: clickedKey, sortDir: clickedKey === "platform" ? "asc" : "desc" };

export const getPlatformSortIndicator = (currentKey: PlatformSortKey, currentDir: SortDirection, key: PlatformSortKey): string =>
  currentKey !== key ? "" : currentDir === "asc" ? "▲" : "▼";

export const rateToneClass = (rate: number | null): "ok" | "warn" | "danger" =>
  rate === null || rate >= 95 ? "ok" : rate >= 80 ? "warn" : "danger";

export const formatRateValue = (rate: number | null): string =>
  rate === null || !Number.isFinite(rate) ? "—" : `${Math.max(0, Math.min(100, rate)).toFixed(1)}%`;

export function roleBadgeClass(role: string): string {
  const r = (role || "").trim().toLowerCase();
  return r === "owner" ? "mon-role-badge--owner" : r === "friend" ? "mon-role-badge--friend" : r === "agent" ? "mon-role-badge--agent" : "mon-role-badge--other";
}

export function evaluateMonitorHealthAndAlerts(stats: StatsSnapshot | null): MonitorHealthSummary {
  if (!stats) {
    return { level: "empty", primaryNodeStatus: "unknown", shanghaiNodeStatus: "off", dualNodeDegraded: false, summaryText: "暂无监控快照", alerts: [] };
  }
  const alerts: MonitorAlertItem[] = [];
  const push = (code: string, severity: "warn" | "danger", title: string, detail: string) => alerts.push({ code, severity, title, detail });
  const shanghai = summarizeShanghaiNodeHealth(stats);
  const today = computeTodayVsYesterday(stats);

  const poolChecks = [
    ...buildConcurrencyPoolRows(stats).map((p) => ({ prefix: "POOL", id: p.id, label: p.label, titleSuffix: "水位告急", active: p.active, limit: p.limit, queued: p.queued, queueLimit: p.queueLimit })),
    ...buildYtdlpCompartmentPoolRows(stats).filter((c) => c.enabled).map((c) => ({ prefix: "COMPARTMENT", id: c.id, label: c.label, titleSuffix: "拥塞", active: c.active, limit: c.limit, queued: c.queued, queueLimit: c.queueLimit as number | null })),
  ];
  for (const p of poolChecks) {
    const sev = classifyPoolQueueSeverity(p);
    if (sev.overallTone !== "normal") {
      push(`${p.prefix}_${p.id.toUpperCase()}_${sev.overallTone.toUpperCase()}`, sev.overallTone, `${p.label} ${p.titleSuffix}`,
        `活跃 ${p.active}/${p.limit} (${sev.ratioPct}%)，排队 ${p.queued}${p.queueLimit !== null ? `/${p.queueLimit}` : ""}`);
    }
  }

  const breakers = stats.circuit_breakers ?? [];
  const openBreakers = breakers.filter((b) => b.state === "open" || b.disabled_by_config);
  const halfOpenBreakers = breakers.filter((b) => b.state === "half_open" && !b.disabled_by_config);
  for (const b of openBreakers) {
    push(`BREAKER_OPEN_${b.platform.toUpperCase()}`, "danger", `${b.platform} 平台熔断保护中`,
      b.disabled_by_config ? "运维配置已禁用该平台" : `连续失败 ${b.consecutive_failures} 次`);
  }
  for (const b of halfOpenBreakers) {
    push(`BREAKER_HALF_OPEN_${b.platform.toUpperCase()}`, "warn", `${b.platform} 平台半开探活`, `最近失败 ${b.consecutive_failures} 次`);
  }
  const gb = stats.generic_circuit_breaker;
  if (gb && (gb.state === "open" || gb.disabled_by_config || gb.state === "half_open")) {
    push("GENERIC_BREAKER_DEGRADED", gb.state === "open" || gb.disabled_by_config ? "danger" : "warn",
      "长尾通用熔断器异常", gb.disabled_by_config ? "运维已禁用通用长尾解析" : `状态 ${gb.state}，连续失败 ${gb.consecutive_failures} 次`);
  }

  const effRate = today.effectiveSuccessRate;
  if (effRate !== null && today.effectiveTotal >= 5 && effRate < 95) {
    push(effRate < 80 ? "EFFECTIVE_RATE_CRITICAL" : "EFFECTIVE_RATE_WARN", effRate < 80 ? "danger" : "warn",
      "今日有效成功率偏低", `有效成功率 ${effRate.toFixed(1)}%（有效样本 ${today.effectiveTotal}）`);
  }

  let primaryNodeStatus: PrimaryNodeStatus = "online";
  if ((breakers.length > 0 && openBreakers.length === breakers.length) || (effRate !== null && today.effectiveTotal >= 5 && effRate < 50)) {
    primaryNodeStatus = "offline";
  } else if (openBreakers.length > 0 || halfOpenBreakers.length > 0 || gb?.state === "open" || (effRate !== null && today.effectiveTotal >= 5 && effRate < 95)) {
    primaryNodeStatus = "degraded";
  }

  if (shanghai.status === "offline") push("SHANGHAI_NODE_OFFLINE", "danger", "上海出口节点全部离线", shanghai.summaryText);
  else if (shanghai.status === "degraded") push("SHANGHAI_NODE_DEGRADED", "warn", "上海出口节点降级", shanghai.summaryText);

  const dualNodeDegraded = shanghai.status === "offline" && primaryNodeStatus !== "online";
  if (dualNodeDegraded) {
    alerts.unshift({ code: "DUAL_NODE_DEGRADED", severity: "danger", title: "上海 / 主节点双节点同时异常", detail: `上海节点离线且主节点状态为 ${primaryNodeStatus}` });
  }

  const dangerCount = alerts.filter((a) => a.severity === "danger").length;
  const level: MonitorOverallHealthLevel = dangerCount > 0 ? "critical" : alerts.length > 0 ? "degraded" : "healthy";
  const summaryText = dualNodeDegraded
    ? "严重降级：上海与主节点同时异常"
    : level === "critical" ? `发现 ${dangerCount} 项高危告警`
      : level === "degraded" ? `发现 ${alerts.length} 项预警` : "全部节点与并发池运行健康";

  return { level, primaryNodeStatus, shanghaiNodeStatus: shanghai.status, dualNodeDegraded, summaryText, alerts };
}
