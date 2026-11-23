import { PLATFORM_DOMAIN_SPECS } from "./urlMatcher";

// ============================================================================
// Backend `/api/stats?schema_version=1.0` Read-Only Data Contract
// ============================================================================

export interface HistogramBuckets {
  "<=10": number;
  "<=50": number;
  "<=100": number;
  "<=250": number;
  "<=500": number;
  "<=1000": number;
  "<=2500": number;
  "<=5000": number;
  "<=10000": number;
  "<=30000": number;
  "+Inf": number;
}

export interface HistogramSnapshot {
  count: number;
  sum_ms: number;
  max_ms: number;
  buckets: HistogramBuckets;
}

export interface PlatformOutcomeCount {
  platform: string;
  code: string;
  channel: string;
  count: number;
}

export interface RequestChannelBreakdown {
  anonymous: number;
  owner: number;
}

export interface RequestStatsSnapshot {
  total: number;
  by_channel: RequestChannelBreakdown;
  by_platform_code_channel: PlatformOutcomeCount[];
}

export interface CacheChannelCounts {
  hits: number;
  misses: number;
  singleflight_shared: number;
  uncacheable: number;
}

export interface CacheChannelBreakdown {
  anonymous: CacheChannelCounts;
  owner: CacheChannelCounts;
}

export interface CacheStatsSnapshot {
  enabled: boolean;
  entries: number;
  bytes: number;
  max_entries: number;
  max_bytes: number;
  total: CacheChannelCounts;
  by_channel: CacheChannelBreakdown;
}

export interface AdmissionPoolSnapshot {
  active: number;
  queued: number;
  concurrency_limit: number;
  queue_limit: number;
  waited: number;
  granted: number;
  timeout: number;
  full: number;
  canceled: number;
  wait_ms_total: number;
  wait_ms_max: number;
}

export interface AdmissionStatsSnapshot {
  fast: AdmissionPoolSnapshot;
  slow: AdmissionPoolSnapshot;
  owner: AdmissionPoolSnapshot;
}

export interface APIKeyStatsSnapshot {
  id: string;
  role: string;
  enabled: boolean;
  active: number;
  slow_active: number;
  queued: number;
  concurrency_limit: number;
  slow_concurrency_limit: number;
  queue_limit: number;
  requests_total: number;
  ok: number;
  errors: number;
  cache_hits: number;
  rate_limited: number;
  unauthorized: number;
  waited: number;
  granted: number;
  timeout: number;
  full: number;
  canceled: number;
  wait_ms_total: number;
  wait_ms_max: number;
}

export interface ChannelSlotStatsSnapshot {
  acquired_count: number;
  wait_count: number;
  canceled_count: number;
  wait_ms_total: number;
  wait_ms_max: number;
  wait_ms: HistogramSnapshot;
}

export interface YTDLPChannelBreakdown {
  anonymous: ChannelSlotStatsSnapshot;
  owner: ChannelSlotStatsSnapshot;
}

export interface YTDLPStatsSnapshot {
  enabled?: boolean;
  concurrency_limit: number;
  active: number;
  waiting?: number;
  queued?: number;
  total: ChannelSlotStatsSnapshot;
  by_channel: YTDLPChannelBreakdown;
}

export interface ShanghaiChannelStats {
  hits: number;
  fallbacks: number;
  canceled: number;
  queue_waits: number;
  queue_granted: number;
  queue_timeouts: number;
  queue_wait_ms_total: number;
  queue_wait_ms_max: number;
}

export interface ShanghaiChannelBreakdown {
  anonymous: ShanghaiChannelStats;
  owner: ShanghaiChannelStats;
}

export interface ShanghaiPlatformBreakdown {
  douyin: ShanghaiChannelStats;
  bilibili: ShanghaiChannelStats;
}

export interface ShanghaiStatsSnapshot {
  enabled: boolean;
  mode: string;
  waiting_workers: number;
  queued_tasks: number;
  pending_tasks: number;
  total: ShanghaiChannelStats;
  by_channel: ShanghaiChannelBreakdown;
  by_platform: ShanghaiPlatformBreakdown;
}

export interface LatencyChannelBreakdown {
  anonymous: HistogramSnapshot;
  owner: HistogramSnapshot;
}

export interface LatencyStatsSnapshot {
  total: HistogramSnapshot;
  by_channel: LatencyChannelBreakdown;
}

export interface RuntimeConfigSnapshot {
  version: string;
  shanghai_mode: string;
  shanghai_bilibili: boolean;
  bilibili_dash: boolean;
  youtube_helper: boolean;
  xhs_transport: string;
  ytdlp_enabled: boolean;
  ytdlp_generic_enabled: boolean;
  tbvideo_pipigx: boolean;
  tbvideo_zuiyou: boolean;
  stats_persistence_enabled: boolean;
}

export interface DailyLatencySummary {
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
}

export interface DailyPlatformStats {
  total: number;
  ok: number;
  failed: number;
  by_code: Record<string, number>;
  p95_ms: number;
}

export interface DailyStatsBucket {
  date: string;
  total: number;
  ok: number;
  failed: number;
  cache_hits: number;
  shanghai_hits: number;
  latency_ms: DailyLatencySummary;
  by_platform: Record<string, DailyPlatformStats>;
}

export interface HourlyStatsBucket {
  hour_start: string;
  total: number;
  ok: number;
  failed: number;
  cache_hits: number;
}

export interface StatsSnapshot {
  started_at: string;
  generated_at: string;
  uptime_seconds: number;
  requests: RequestStatsSnapshot;
  cache: CacheStatsSnapshot;
  admission: AdmissionStatsSnapshot;
  api_keys: APIKeyStatsSnapshot[];
  ytdlp: YTDLPStatsSnapshot;
  shanghai: ShanghaiStatsSnapshot;
  parse_latency_ms: LatencyStatsSnapshot;
  runtime: RuntimeConfigSnapshot;
  daily: DailyStatsBucket[];
  hourly: HourlyStatsBucket[];
}

export interface OwnerStatsResult {
  stats: StatsSnapshot;
  apiOrigin: string;
  fetchedAt: number;
}

// ============================================================================
// Runtime Validation Guard
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidRuntimeConfig(raw: unknown): raw is RuntimeConfigSnapshot {
  if (!isRecord(raw)) return false;
  return (
    typeof raw.version === "string" &&
    typeof raw.shanghai_mode === "string" &&
    typeof raw.shanghai_bilibili === "boolean" &&
    typeof raw.bilibili_dash === "boolean" &&
    typeof raw.youtube_helper === "boolean" &&
    typeof raw.xhs_transport === "string" &&
    typeof raw.ytdlp_enabled === "boolean" &&
    typeof raw.ytdlp_generic_enabled === "boolean" &&
    typeof raw.tbvideo_pipigx === "boolean" &&
    typeof raw.tbvideo_zuiyou === "boolean" &&
    typeof raw.stats_persistence_enabled === "boolean"
  );
}

function isValidDailyBucket(raw: unknown): raw is DailyStatsBucket {
  if (!isRecord(raw)) return false;
  if (
    typeof raw.date !== "string" ||
    !isFiniteNum(raw.total) ||
    !isFiniteNum(raw.ok) ||
    !isFiniteNum(raw.failed) ||
    !isFiniteNum(raw.cache_hits) ||
    !isFiniteNum(raw.shanghai_hits)
  ) {
    return false;
  }
  if (!isRecord(raw.latency_ms)) return false;
  if (
    !isFiniteNum(raw.latency_ms.p50_ms) ||
    !isFiniteNum(raw.latency_ms.p95_ms) ||
    !isFiniteNum(raw.latency_ms.max_ms)
  ) {
    return false;
  }
  return isRecord(raw.by_platform);
}

function isValidHourlyBucket(raw: unknown): raw is HourlyStatsBucket {
  if (!isRecord(raw)) return false;
  return (
    typeof raw.hour_start === "string" &&
    isFiniteNum(raw.total) &&
    isFiniteNum(raw.ok) &&
    isFiniteNum(raw.failed) &&
    isFiniteNum(raw.cache_hits)
  );
}

export function isValidStatsSnapshot(raw: unknown): raw is StatsSnapshot {
  if (!isRecord(raw)) return false;
  if (
    typeof raw.started_at !== "string" ||
    typeof raw.generated_at !== "string" ||
    !isFiniteNum(raw.uptime_seconds)
  ) {
    return false;
  }

  if (
    !isRecord(raw.requests) ||
    !isFiniteNum(raw.requests.total) ||
    !isRecord(raw.requests.by_channel) ||
    !Array.isArray(raw.requests.by_platform_code_channel)
  ) {
    return false;
  }

  if (
    !isRecord(raw.cache) ||
    typeof raw.cache.enabled !== "boolean" ||
    !isFiniteNum(raw.cache.entries) ||
    !isFiniteNum(raw.cache.bytes) ||
    !isRecord(raw.cache.total)
  ) {
    return false;
  }

  if (
    !isRecord(raw.admission) ||
    !isRecord(raw.admission.fast) ||
    !isRecord(raw.admission.slow) ||
    !isRecord(raw.admission.owner)
  ) {
    return false;
  }

  if (!Array.isArray(raw.api_keys)) {
    return false;
  }

  if (
    !isRecord(raw.ytdlp) ||
    !isFiniteNum(raw.ytdlp.active) ||
    !isFiniteNum(raw.ytdlp.concurrency_limit)
  ) {
    return false;
  }

  if (
    !isRecord(raw.shanghai) ||
    typeof raw.shanghai.enabled !== "boolean" ||
    typeof raw.shanghai.mode !== "string" ||
    !isFiniteNum(raw.shanghai.waiting_workers)
  ) {
    return false;
  }

  if (
    !isRecord(raw.parse_latency_ms) ||
    !isRecord(raw.parse_latency_ms.total)
  ) {
    return false;
  }

  if (!isValidRuntimeConfig(raw.runtime)) {
    return false;
  }

  if (!Array.isArray(raw.daily) || !raw.daily.every(isValidDailyBucket)) {
    return false;
  }

  if (!Array.isArray(raw.hourly) || !raw.hourly.every(isValidHourlyBucket)) {
    return false;
  }

  return true;
}

// ============================================================================
// Pure Data Aggregations & Formatters (Zero DOM / Chrome Dependency)
// ============================================================================

const CORE_PLATFORM_LABEL_MAP = new Map<string, string>(
  PLATFORM_DOMAIN_SPECS.map((spec) => [spec.id, spec.label]),
);

export function formatStatsPlatformLabel(platform: string): string {
  const key = typeof platform === "string" ? platform.trim().toLowerCase() : "";
  if (!key || key === "unknown") return "未识别 / 无效输入";
  if (key === "ytdlp_other") return "其他站点 (yt-dlp)";
  return CORE_PLATFORM_LABEL_MAP.get(key) || key;
}

export type PlatformHealthRange =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "since_start";

export type ErrorCodeSeverity = "danger" | "warning" | "muted";

export interface PlatformErrorBadge {
  code: string;
  count: number;
  severity: ErrorCodeSeverity;
}

export interface PlatformHealthRow {
  platform: string;
  label: string;
  total: number;
  ok: number;
  failed: number;
  successRate: number | null;
  topErrors: PlatformErrorBadge[];
  p95Ms: number | null;
}

export interface TodayVsYesterdaySummary {
  date: string;
  yesterdayDate: string | null;
  total: number;
  ok: number;
  failed: number;
  successRate: number | null;
  cacheHits: number;
  shanghaiHits: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  yesterdayTotal: number;
  yesterdaySuccessRate: number | null;
  deltaTotal: number;
  deltaRatePct: number | null;
}

const DANGER_ERROR_CODES = new Set([
  "UPSTREAM_BLOCKED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_INVALID_RESPONSE",
  "INTERNAL_ERROR",
  "SERVICE_NOT_CONFIGURED",
]);

const WARNING_ERROR_CODES = new Set([
  "RATE_LIMITED",
  "UNAUTHORIZED",
  "CONTENT_UNAVAILABLE",
  "NO_MEDIA",
]);

export function classifyErrorCodeSeverity(code: string): ErrorCodeSeverity {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (DANGER_ERROR_CODES.has(normalized)) return "danger";
  if (WARNING_ERROR_CODES.has(normalized)) return "warning";
  return "muted";
}

function safeRatePct(ok: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const pct = (Math.max(0, ok) / total) * 100;
  return Math.max(0, Math.min(100, pct));
}

export function computeTodayVsYesterday(
  stats: StatsSnapshot,
): TodayVsYesterdaySummary {
  const daily = Array.isArray(stats.daily) ? stats.daily : [];
  const today = daily.length > 0 ? daily[daily.length - 1] : undefined;
  const yesterday = daily.length > 1 ? daily[daily.length - 2] : undefined;

  const total = today?.total ?? 0;
  const ok = today?.ok ?? 0;
  const failed = today?.failed ?? 0;
  const successRate = safeRatePct(ok, total);

  const yesterdayTotal = yesterday?.total ?? 0;
  const yesterdaySuccessRate = yesterday
    ? safeRatePct(yesterday.ok, yesterday.total)
    : null;

  const deltaTotal = total - yesterdayTotal;
  const deltaRatePct =
    successRate !== null && yesterdaySuccessRate !== null
      ? Number((successRate - yesterdaySuccessRate).toFixed(1))
      : null;

  return {
    date: today?.date ?? "",
    yesterdayDate: yesterday?.date ?? null,
    total,
    ok,
    failed,
    successRate,
    cacheHits: today?.cache_hits ?? 0,
    shanghaiHits: today?.shanghai_hits ?? 0,
    p50Ms: today?.latency_ms?.p50_ms ?? 0,
    p95Ms: today?.latency_ms?.p95_ms ?? 0,
    maxMs: today?.latency_ms?.max_ms ?? 0,
    yesterdayTotal,
    yesterdaySuccessRate,
    deltaTotal,
    deltaRatePct,
  };
}

export function aggregatePlatformHealth(
  stats: StatsSnapshot,
  range: PlatformHealthRange,
): PlatformHealthRow[] {
  const acc = new Map<
    string,
    {
      total: number;
      ok: number;
      failed: number;
      byCode: Map<string, number>;
      maxP95Ms: number;
      hasP95: boolean;
    }
  >();

  const ensureEntry = (platform: string) => {
    const key = platform.trim().toLowerCase() || "unknown";
    let entry = acc.get(key);
    if (!entry) {
      entry = {
        total: 0,
        ok: 0,
        failed: 0,
        byCode: new Map<string, number>(),
        maxP95Ms: 0,
        hasP95: false,
      };
      acc.set(key, entry);
    }
    return entry;
  };

  if (range === "since_start") {
    const cells = stats.requests?.by_platform_code_channel ?? [];
    for (const cell of cells) {
      if (!cell || !Number.isFinite(cell.count) || cell.count <= 0) continue;
      const entry = ensureEntry(cell.platform);
      entry.total += cell.count;
      const code = (cell.code || "INTERNAL_ERROR").trim().toUpperCase();
      if (code === "OK") {
        entry.ok += cell.count;
      } else {
        entry.failed += cell.count;
        entry.byCode.set(code, (entry.byCode.get(code) ?? 0) + cell.count);
      }
    }
  } else {
    const daily = Array.isArray(stats.daily) ? stats.daily : [];
    let selected: DailyStatsBucket[] = [];
    if (range === "today") {
      selected = daily.length > 0 ? [daily[daily.length - 1]] : [];
    } else if (range === "yesterday") {
      selected = daily.length > 1 ? [daily[daily.length - 2]] : [];
    } else if (range === "7d") {
      selected = daily.slice(-7);
    } else {
      selected = daily.slice(-30);
    }

    for (const bucket of selected) {
      const byPlat = bucket?.by_platform;
      if (!byPlat || typeof byPlat !== "object") continue;
      for (const [platform, pStats] of Object.entries(byPlat)) {
        if (!pStats || !Number.isFinite(pStats.total) || pStats.total <= 0) {
          continue;
        }
        const entry = ensureEntry(platform);
        entry.total += pStats.total;
        entry.ok += pStats.ok || 0;
        entry.failed += pStats.failed || 0;
        if (Number.isFinite(pStats.p95_ms)) {
          entry.hasP95 = true;
          if (pStats.p95_ms > entry.maxP95Ms) {
            entry.maxP95Ms = pStats.p95_ms;
          }
        }
        if (pStats.by_code && typeof pStats.by_code === "object") {
          for (const [rawCode, count] of Object.entries(pStats.by_code)) {
            if (!Number.isFinite(count) || count <= 0) continue;
            const code = rawCode.trim().toUpperCase();
            if (code === "OK") continue;
            entry.byCode.set(code, (entry.byCode.get(code) ?? 0) + count);
          }
        }
      }
    }
  }

  const rows: PlatformHealthRow[] = [];
  for (const [platform, entry] of acc.entries()) {
    if (entry.total <= 0) continue;
    const topErrors: PlatformErrorBadge[] = Array.from(entry.byCode.entries())
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([code, count]) => ({
        code,
        count,
        severity: classifyErrorCodeSeverity(code),
      }));

    rows.push({
      platform,
      label: formatStatsPlatformLabel(platform),
      total: entry.total,
      ok: entry.ok,
      failed: entry.failed,
      successRate: safeRatePct(entry.ok, entry.total),
      topErrors,
      p95Ms: entry.hasP95 ? entry.maxP95Ms : null,
    });
  }

  rows.sort(
    (a, b) =>
      b.total - a.total ||
      b.failed - a.failed ||
      a.platform.localeCompare(b.platform),
  );
  return rows;
}

export function formatUptimeDuration(seconds: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "0秒";
  }
  const totalSec = Math.floor(seconds);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const minutes = Math.floor((totalSec % 3_600) / 60);
  const secs = totalSec % 60;

  if (days > 0) {
    return `${days}天 ${hours}小时 ${minutes}分`;
  }
  if (hours > 0) {
    return `${hours}小时 ${minutes}分`;
  }
  if (minutes > 0) {
    return secs > 0 ? `${minutes}分 ${secs}秒` : `${minutes}分`;
  }
  return `${secs}秒`;
}

export function formatPercent(
  numerator: number,
  denominator: number,
  digits = 1,
): string {
  if (
    typeof numerator !== "number" ||
    typeof denominator !== "number" ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return "—";
  }
  const pct = Math.max(0, Math.min(100, (numerator / denominator) * 100));
  return `${pct.toFixed(digits)}%`;
}

export function formatBytesCompact(bytes: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

export function formatShanghaiHourLabel(hourStart: string): string {
  if (typeof hourStart !== "string" || !hourStart.trim()) return "--:--";
  const trimmed = hourStart.trim();
  const explicitOffsetMatch = /T(\d{2}):(\d{2})(?::\d{2})?\+08:00$/.exec(
    trimmed,
  );
  if (explicitOffsetMatch) {
    return `${explicitOffsetMatch[1]}:${explicitOffsetMatch[2]}`;
  }
  const parsedMs = Date.parse(trimmed);
  if (Number.isFinite(parsedMs)) {
    const shanghaiDate = new Date(parsedMs + 8 * 3_600_000);
    const hh = String(shanghaiDate.getUTCHours()).padStart(2, "0");
    const mm = String(shanghaiDate.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const fallbackMatch = /T(\d{2}):(\d{2})/.exec(trimmed);
  return fallbackMatch ? `${fallbackMatch[1]}:${fallbackMatch[2]}` : trimmed;
}

export function resolveYtdlpQueuedCount(ytdlp?: YTDLPStatsSnapshot | null): number {
  if (!ytdlp) return 0;
  if (typeof ytdlp.waiting === "number" && Number.isFinite(ytdlp.waiting)) {
    return Math.max(0, ytdlp.waiting);
  }
  if (typeof ytdlp.queued === "number" && Number.isFinite(ytdlp.queued)) {
    return Math.max(0, ytdlp.queued);
  }
  return 0;
}

// ============================================================================
// Pure Native SVG Chart Geometry Builders
// ============================================================================

export interface ChartYAxisTick {
  value: number;
  y: number;
  label: string;
}

export interface DailyChartPoint {
  index: number;
  date: string;
  shortDate: string;
  total: number;
  ok: number;
  failed: number;
  cacheHits: number;
  shanghaiHits: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  successRate: number | null;
  x: number;
  barWidth: number;
  centerX: number;
  okY: number;
  okHeight: number;
  failedY: number;
  failedHeight: number;
  totalY: number;
  totalHeight: number;
  rateY: number | null;
  showXLabel: boolean;
}

export interface DailyChartGeometry {
  days: 7 | 30;
  width: number;
  height: number;
  plotLeft: number;
  plotTop: number;
  plotRight: number;
  plotBottom: number;
  plotWidth: number;
  plotHeight: number;
  maxTotal: number;
  yTicks: ChartYAxisTick[];
  points: DailyChartPoint[];
  ratePathD: string;
  ratePolylinePoints: string;
}

export interface HourlyChartPoint {
  index: number;
  hourStart: string;
  hourLabel: string;
  total: number;
  ok: number;
  failed: number;
  cacheHits: number;
  successRate: number | null;
  x: number;
  barWidth: number;
  centerX: number;
  okY: number;
  okHeight: number;
  failedY: number;
  failedHeight: number;
  totalY: number;
  totalHeight: number;
  showXLabel: boolean;
}

export interface HourlyChartGeometry {
  width: number;
  height: number;
  plotLeft: number;
  plotTop: number;
  plotRight: number;
  plotBottom: number;
  plotWidth: number;
  plotHeight: number;
  maxTotal: number;
  yTicks: ChartYAxisTick[];
  points: HourlyChartPoint[];
}

function niceAxisCeiling(rawMax: number): number {
  if (!Number.isFinite(rawMax) || rawMax <= 0) return 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const normalized = rawMax / magnitude;
  let niceNorm: number;
  if (normalized <= 1) niceNorm = 1;
  else if (normalized <= 2) niceNorm = 2;
  else if (normalized <= 4) niceNorm = 4;
  else if (normalized <= 5) niceNorm = 5;
  else if (normalized <= 8) niceNorm = 8;
  else niceNorm = 10;
  return Math.max(4, Math.ceil(niceNorm * magnitude));
}

function roundCoord(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatCompactAxisTick(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 10_000) return `${Math.round(val / 1_000)}k`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(val % 1000 === 0 ? 0 : 1)}k`;
  return String(Math.round(val));
}

export function buildDailyChartPoints(
  daily: readonly DailyStatsBucket[],
  days: 7 | 30,
  options?: { width?: number; height?: number },
): DailyChartGeometry {
  const width = options?.width ?? 640;
  const height = options?.height ?? 240;
  const plotLeft = 44;
  const plotRight = width - 44;
  const plotTop = 18;
  const plotBottom = height - 30;
  const plotWidth = Math.max(10, plotRight - plotLeft);
  const plotHeight = Math.max(10, plotBottom - plotTop);

  const sliced = Array.isArray(daily) ? daily.slice(-days) : [];
  const rawMax = sliced.reduce((m, b) => Math.max(m, b.total || 0), 0);
  const maxTotal = niceAxisCeiling(rawMax);

  const tickCount = 4;
  const yTicks: ChartYAxisTick[] = [];
  for (let i = 0; i <= tickCount; i++) {
    const ratio = i / tickCount;
    const value = Math.round(maxTotal * ratio);
    const y = roundCoord(plotBottom - ratio * plotHeight);
    yTicks.push({ value, y, label: formatCompactAxisTick(value) });
  }

  const count = sliced.length;
  const step = count > 0 ? plotWidth / count : plotWidth;
  const barRatio = days === 7 ? 0.46 : 0.64;
  const barWidth = roundCoord(Math.max(4, Math.min(36, step * barRatio)));

  const points: DailyChartPoint[] = [];
  const ratePathSegments: string[] = [];
  const ratePolylinePairs: string[] = [];
  let inSegment = false;

  for (let i = 0; i < count; i++) {
    const b = sliced[i];
    const total = Math.max(0, b.total || 0);
    const ok = Math.max(0, b.ok || 0);
    const failed = Math.max(0, b.failed || 0);
    const stackedTotal = Math.max(total, ok + failed);

    const centerX = roundCoord(plotLeft + step * (i + 0.5));
    const x = roundCoord(centerX - barWidth / 2);

    const okHeight = roundCoord((ok / maxTotal) * plotHeight);
    const failedHeight = roundCoord((failed / maxTotal) * plotHeight);
    const totalHeight = roundCoord((stackedTotal / maxTotal) * plotHeight);

    const okY = roundCoord(plotBottom - okHeight);
    const failedY = roundCoord(okY - failedHeight);
    const totalY = roundCoord(plotBottom - totalHeight);

    const successRate = safeRatePct(ok, total);
    const rateY =
      successRate !== null
        ? roundCoord(plotBottom - (successRate / 100) * plotHeight)
        : null;

    if (rateY !== null) {
      ratePathSegments.push(`${inSegment ? "L" : "M"}${centerX} ${rateY}`);
      ratePolylinePairs.push(`${centerX},${rateY}`);
      inSegment = true;
    } else {
      inSegment = false;
    }

    const shortDate =
      typeof b.date === "string" && b.date.length >= 10
        ? b.date.slice(5, 10)
        : b.date;

    const showXLabel =
      days === 7
        ? true
        : i === 0 || i === count - 1 || i % 5 === 0;

    points.push({
      index: i,
      date: b.date,
      shortDate,
      total,
      ok,
      failed,
      cacheHits: b.cache_hits || 0,
      shanghaiHits: b.shanghai_hits || 0,
      p50Ms: b.latency_ms?.p50_ms || 0,
      p95Ms: b.latency_ms?.p95_ms || 0,
      maxMs: b.latency_ms?.max_ms || 0,
      successRate,
      x,
      barWidth,
      centerX,
      okY,
      okHeight,
      failedY,
      failedHeight,
      totalY,
      totalHeight,
      rateY,
      showXLabel,
    });
  }

  return {
    days,
    width,
    height,
    plotLeft,
    plotTop,
    plotRight,
    plotBottom,
    plotWidth,
    plotHeight,
    maxTotal,
    yTicks,
    points,
    ratePathD: ratePathSegments.join(" "),
    ratePolylinePoints: ratePolylinePairs.join(" "),
  };
}

export function buildHourlyChartPoints(
  hourly: readonly HourlyStatsBucket[],
  options?: { width?: number; height?: number },
): HourlyChartGeometry {
  const width = options?.width ?? 560;
  const height = options?.height ?? 240;
  const plotLeft = 40;
  const plotRight = width - 16;
  const plotTop = 18;
  const plotBottom = height - 30;
  const plotWidth = Math.max(10, plotRight - plotLeft);
  const plotHeight = Math.max(10, plotBottom - plotTop);

  const sliced = Array.isArray(hourly) ? hourly.slice(-24) : [];
  const rawMax = sliced.reduce((m, b) => Math.max(m, b.total || 0), 0);
  const maxTotal = niceAxisCeiling(rawMax);

  const tickCount = 4;
  const yTicks: ChartYAxisTick[] = [];
  for (let i = 0; i <= tickCount; i++) {
    const ratio = i / tickCount;
    const value = Math.round(maxTotal * ratio);
    const y = roundCoord(plotBottom - ratio * plotHeight);
    yTicks.push({ value, y, label: formatCompactAxisTick(value) });
  }

  const count = sliced.length;
  const step = count > 0 ? plotWidth / count : plotWidth;
  const barWidth = roundCoord(Math.max(4, Math.min(20, step * 0.62)));

  const points: HourlyChartPoint[] = [];
  for (let i = 0; i < count; i++) {
    const b = sliced[i];
    const total = Math.max(0, b.total || 0);
    const ok = Math.max(0, b.ok || 0);
    const failed = Math.max(0, b.failed || 0);
    const stackedTotal = Math.max(total, ok + failed);

    const centerX = roundCoord(plotLeft + step * (i + 0.5));
    const x = roundCoord(centerX - barWidth / 2);

    const okHeight = roundCoord((ok / maxTotal) * plotHeight);
    const failedHeight = roundCoord((failed / maxTotal) * plotHeight);
    const totalHeight = roundCoord((stackedTotal / maxTotal) * plotHeight);

    const okY = roundCoord(plotBottom - okHeight);
    const failedY = roundCoord(okY - failedHeight);
    const totalY = roundCoord(plotBottom - totalHeight);

    const showXLabel = i === 0 || i === count - 1 || i % 4 === 0;

    points.push({
      index: i,
      hourStart: b.hour_start,
      hourLabel: formatShanghaiHourLabel(b.hour_start),
      total,
      ok,
      failed,
      cacheHits: b.cache_hits || 0,
      successRate: safeRatePct(ok, total),
      x,
      barWidth,
      centerX,
      okY,
      okHeight,
      failedY,
      failedHeight,
      totalY,
      totalHeight,
      showXLabel,
    });
  }

  return {
    width,
    height,
    plotLeft,
    plotTop,
    plotRight,
    plotBottom,
    plotWidth,
    plotHeight,
    maxTotal,
    yTicks,
    points,
  };
}
