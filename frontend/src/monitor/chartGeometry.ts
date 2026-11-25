// ============================================================================
// Pure Native SVG Chart Geometry Builders for `/monitor`
// Self-contained module (zero extension, DOM, or Chrome API dependencies)
// ============================================================================

import type {
  DailyStatsBucket,
  HourlyStatsBucket,
} from "./statsTypes.generated";

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

function safeRatePct(ok: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const pct = (Math.max(0, ok) / total) * 100;
  return Math.max(0, Math.min(100, pct));
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
