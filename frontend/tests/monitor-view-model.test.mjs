import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as vm from "../src/monitor/monitorViewModel.ts";
import { collectTransitiveImportGraph } from "./helpers/staticImportGraph.mjs";

const MODEL_PATH = fileURLToPath(
  new URL("../src/monitor/monitorViewModel.ts", import.meta.url),
);
const bundleInputs = collectTransitiveImportGraph(MODEL_PATH);

function makeBaseSnapshot(overrides = {}) {
  return {
    schema_version: "1.0",
    uptime_seconds: 90_061,
    runtime: {
      version: "abcdef1234567890abcdef1234567890abcdef12",
      shanghai_mode: "pull",
      shanghai_bilibili: true,
      bilibili_dash: true,
      youtube_helper: true,
      xhs_transport: "chrome131",
      ytdlp_enabled: true,
      ytdlp_generic_enabled: true,
      tbvideo_pipigx: false,
      tbvideo_zuiyou: true,
      stats_persistence_enabled: true,
    },
    requests: {
      total: 1000,
      by_channel: { anonymous: 700, owner: 300 },
      by_platform_code_channel: [
        { platform: "bilibili", code: "OK", channel: "anonymous", count: 400 },
        { platform: "bilibili", code: "UPSTREAM_TIMEOUT", channel: "anonymous", count: 10 },
        { platform: "douyin", code: "OK", channel: "owner", count: 290 },
        { platform: "douyin", code: "RATE_LIMITED", channel: "anonymous", count: 20 },
      ],
    },
    parse_latency_ms: { total: { p50_ms: 120, p95_ms: 480, max_ms: 1800 } },
    cache: {
      enabled: true,
      entries: 42,
      max_entries: 1000,
      bytes: 2 * 1024 * 1024,
      max_bytes: 64 * 1024 * 1024,
      total: {
        hits: 300,
        misses: 100,
        stale_hits: 7,
        singleflight_shared: 15,
        uncacheable: 4,
      },
    },
    shanghai: {
      mode: "pull",
      waiting_workers: 2,
      queued_tasks: 0,
      pending_tasks: 1,
      total: { hits: 180, fallbacks: 20, queue_timeouts: 0 },
      by_platform: {
        douyin: { hits: 100, fallbacks: 12 },
        bilibili: { hits: 80, fallbacks: 8 },
      },
    },
    admission: {
      fast: { active: 2, queued: 0, concurrency_limit: 16, queue_limit: 64, waited: 3, granted: 500, timeout: 0, full: 0, canceled: 0, wait_ms_total: 100, wait_ms_max: 40 },
      slow: { active: 1, queued: 0, concurrency_limit: 8, queue_limit: 32, waited: 1, granted: 200, timeout: 0, full: 0, canceled: 0, wait_ms_total: 50, wait_ms_max: 30 },
      generic_slow: { active: 0, queued: 0, concurrency_limit: 4, queue_limit: 16, waited: 0, granted: 40, timeout: 0, full: 0, canceled: 0, wait_ms_total: 0, wait_ms_max: 0 },
      owner: { active: 1, queued: 0, concurrency_limit: 10, queue_limit: 20, waited: 0, granted: 100, timeout: 0, full: 0, canceled: 0, wait_ms_total: 0, wait_ms_max: 0 },
    },
    ytdlp: { active: 1, concurrency_limit: 4, waiting: 0, total: { acquired_count: 50, wait_count: 2, wait_ms_max: 120 } },
    ytdlp_generic: { active: 0, concurrency_limit: 2, waiting: 0, total: { acquired_count: 10, wait_count: 0, wait_ms_max: 0 } },
    ytdlp_pools: {
      youtube: { enabled: true, active: 1, concurrency_limit: 4, queued: 0, queue_limit: 12, waited: 1, granted: 40, timeout: 0, full: 0, wait_ms_max: 80 },
      social: { enabled: true, active: 0, concurrency_limit: 3, queued: 0, queue_limit: 10, waited: 0, granted: 15, timeout: 0, full: 0, wait_ms_max: 0 },
      generic: { enabled: false, active: 0, concurrency_limit: 2, queued: 0, queue_limit: 6, waited: 0, granted: 0, timeout: 0, full: 0, wait_ms_max: 0 },
      youtube_ejs: { enabled: true, active: 0, concurrency_limit: 2, queued: 0, queue_limit: 8, waited: 0, granted: 12, timeout: 0, full: 0, wait_ms_max: 0 },
    },
    circuit_breakers: [
      { platform: "bilibili", state: "closed", consecutive_failures: 0, disabled_by_config: false },
      { platform: "youtube", state: "closed", consecutive_failures: 0, disabled_by_config: false },
    ],
    generic_circuit_breaker: { state: "closed", consecutive_failures: 0, disabled_by_config: false },
    daily: [
      {
        date: "2026-11-25",
        total: 100,
        ok: 90,
        failed: 10,
        cache_hits: 30,
        shanghai_hits: 20,
        latency_ms: { p50_ms: 100, p95_ms: 400, max_ms: 1200 },
        by_platform: {
          bilibili: { total: 60, ok: 56, failed: 4, p95_ms: 320, by_code: { UPSTREAM_TIMEOUT: 4 } },
          douyin: { total: 40, ok: 34, failed: 6, p95_ms: 410, by_code: { RATE_LIMITED: 6 } },
        },
      },
      {
        date: "2026-11-26",
        total: 150,
        ok: 141,
        failed: 9,
        cache_hits: 55,
        shanghai_hits: 35,
        latency_ms: { p50_ms: 95, p95_ms: 360, max_ms: 980 },
        by_platform: {
          bilibili: { total: 90, ok: 87, failed: 3, p95_ms: 280, by_code: { UPSTREAM_TIMEOUT: 3 } },
          douyin: { total: 60, ok: 54, failed: 6, p95_ms: 350, by_code: { RATE_LIMITED: 5, UPSTREAM_BLOCKED: 1 } },
        },
      },
    ],
    hourly: [
      { hour_start: "2026-11-26T08:00:00+08:00", total: 20, ok: 19, failed: 1, cache_hits: 5 },
      { hour_start: "2026-11-26T09:00:00+08:00", total: 35, ok: 34, failed: 1, cache_hits: 12 },
    ],
    api_keys: [],
    ...overrides,
  };
}

test("monitorViewModel purity: zero Vue/DOM/storage/fetch/chrome imports or globals", () => {
  const raw = readFileSync(MODEL_PATH, "utf8");
  for (const forbidden of [
    /from\s+["']vue["']/,
    /\.vue["']/,
    /monitorStorage/,
    /\bwindow\./,
    /\bdocument\./,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bfetch\s*\(/,
    /\bchrome\./,
  ]) {
    assert.equal(forbidden.test(raw), false, `monitorViewModel.ts must not match ${forbidden}`);
  }
  for (const inp of bundleInputs) {
    assert.equal(inp.endsWith(".vue"), false, `bundle must not include .vue: ${inp}`);
    assert.equal(inp.includes("monitorStorage"), false, `bundle must not include monitorStorage: ${inp}`);
    assert.equal(inp.includes("/extension/"), false, `bundle must not include extension modules: ${inp}`);
  }
});

test("empty & null snapshot handling returns safe defaults without throwing", () => {
  const kpi = vm.buildMonitorKpiViewModel(null, null, null, "system");
  assert.equal(kpi.todaySummary, null);
  assert.equal(kpi.effectiveSuccessRateText, "—");
  assert.equal(kpi.todayDeltaTotalText, "较昨日 —");
  assert.equal(kpi.todayDeltaTotalTone, "flat");
  assert.equal(kpi.todayDeltaRateText, "成功率变化 —");
  assert.equal(kpi.todayDeltaRateTone, "flat");
  assert.equal(kpi.cacheHitRateText, "—");
  assert.equal(kpi.cacheStaleHits, 0);
  assert.equal(kpi.shanghaiHitRateText, "—");
  assert.equal(kpi.shanghaiModeLabel, "未启用 (off)");
  assert.equal(kpi.formattedFetchedTime, "尚未同步");
  assert.equal(kpi.themeButtonLabel, "跟随系统");
  assert.equal(kpi.credentialSourceLabel, "会话级凭据");
  assert.equal(kpi.uptimeText, "—");
  assert.equal(kpi.versionInfo.display, "unknown");

  assert.deepEqual(vm.buildRuntimeSwitchRows(null), []);
  assert.deepEqual(vm.buildConcurrencyPoolRows(null), []);
  assert.deepEqual(vm.buildYtdlpCompartmentPoolRows(null), []);
  assert.deepEqual(vm.buildSortedPlatformHealthRows(null, "today", "total", "desc"), []);

  const dailyView = vm.buildMonitorDailyChartView(null, 7, 0);
  assert.equal(dailyView.chart.points.length, 0);
  assert.equal(dailyView.ratePoints.length, 0);
  assert.equal(dailyView.activePoint, null);

  const hourlyView = vm.buildMonitorHourlyChartView(null, null);
  assert.equal(hourlyView.chart.points.length, 0);
  assert.equal(hourlyView.activePoint, null);

  const health = vm.evaluateMonitorHealthAndAlerts(null);
  assert.equal(health.level, "empty");
  assert.equal(health.primaryNodeStatus, "unknown");
  assert.equal(health.shanghaiNodeStatus, "off");
  assert.equal(health.dualNodeDegraded, false);
  assert.deepEqual(health.alerts, []);
});

test("pool saturation & extreme high-load queueing severity classification", () => {
  const toneCases = [
    [0, "normal"],
    [69, "normal"],
    [70, "warn"],
    [89, "warn"],
    [90, "danger"],
    [100, "danger"],
    [Number.NaN, "normal"],
  ];
  for (const [ratio, expected] of toneCases) {
    assert.equal(vm.buildPoolWatermarkTone(ratio), expected, `ratio=${ratio}`);
  }

  // Extreme queue backpressure with normal active ratio still escalates overallTone to danger
  const queueFull = vm.classifyPoolQueueSeverity({
    active: 4,
    limit: 16,
    queued: 56,
    queueLimit: 64,
    timeout: 0,
    full: 0,
  });
  assert.equal(queueFull.ratioPct, 25);
  assert.equal(queueFull.queueRatioPct, 88);
  assert.equal(queueFull.activeTone, "normal");
  assert.equal(queueFull.queueTone, "danger");
  assert.equal(queueFull.overallTone, "danger");

  // Unbounded slot pool (queueLimit: null) with heavy waiters >= limit escalates to danger
  const slotBacklog = vm.classifyPoolQueueSeverity({
    active: 3,
    limit: 4,
    queued: 5,
    queueLimit: null,
  });
  assert.equal(slotBacklog.activeTone, "warn");
  assert.equal(slotBacklog.queueTone, "danger");
  assert.equal(slotBacklog.overallTone, "danger");

  // Timeout/full counters force danger even when current queue drained
  const pastTimeouts = vm.classifyPoolQueueSeverity({
    active: 1,
    limit: 8,
    queued: 0,
    queueLimit: 32,
    timeout: 2,
    full: 0,
  });
  assert.equal(pastTimeouts.queueTone, "danger");
  assert.equal(pastTimeouts.overallTone, "danger");

  // Full snapshot under extreme high load across admission + ytdlp + compartments
  const overloaded = makeBaseSnapshot({
    admission: {
      fast: { active: 16, queued: 64, concurrency_limit: 16, queue_limit: 64, waited: 200, granted: 800, timeout: 12, full: 5 },
      slow: { active: 6, queued: 20, concurrency_limit: 8, queue_limit: 32, waited: 50, granted: 100, timeout: 0, full: 0 },
      generic_slow: { active: 0, queued: 0, concurrency_limit: 4, queue_limit: 16, waited: 0, granted: 0, timeout: 0, full: 0 },
      owner: { active: 0, queued: 0, concurrency_limit: 10, queue_limit: 20, waited: 0, granted: 0, timeout: 0, full: 0 },
    },
    ytdlp: { active: 4, concurrency_limit: 4, waiting: 9, total: { acquired_count: 80, wait_count: 30, wait_ms_max: 5000 } },
    ytdlp_pools: {
      youtube: { enabled: true, active: 4, concurrency_limit: 4, queued: 11, queue_limit: 12, waited: 40, granted: 70, timeout: 3, full: 1, wait_ms_max: 4200 },
      social: { enabled: true, active: 0, concurrency_limit: 3, queued: 0, queue_limit: 10, waited: 0, granted: 0, timeout: 0, full: 0, wait_ms_max: 0 },
      generic: { enabled: false, active: 2, concurrency_limit: 2, queued: 6, queue_limit: 6, waited: 0, granted: 0, timeout: 0, full: 0, wait_ms_max: 0 },
      youtube_ejs: { enabled: true, active: 0, concurrency_limit: 2, queued: 0, queue_limit: 8, waited: 0, granted: 0, timeout: 0, full: 0, wait_ms_max: 0 },
    },
  });

  const poolRows = vm.buildConcurrencyPoolRows(overloaded);
  assert.equal(poolRows.length, 6);
  assert.equal(poolRows[0].tone, "danger");
  assert.equal(poolRows[0].ratioPct, 100);
  assert.equal(poolRows[1].tone, "warn");
  assert.equal(poolRows[4].queued, 9);

  const compRows = vm.buildYtdlpCompartmentPoolRows(overloaded);
  assert.equal(compRows.length, 4);
  assert.equal(compRows[0].tone, "danger");

  const summary = vm.evaluateMonitorHealthAndAlerts(overloaded);
  assert.equal(summary.level, "critical");
  assert.ok(summary.alerts.some((a) => a.code === "POOL_FAST_DANGER"));
  assert.ok(summary.alerts.some((a) => a.code === "POOL_SLOW_WARN"));
  assert.ok(summary.alerts.some((a) => a.code === "POOL_YTDLP_DANGER"));
  assert.ok(summary.alerts.some((a) => a.code === "COMPARTMENT_YOUTUBE_DANGER"));
  // Disabled generic compartment must NOT emit congestion alerts
  assert.equal(summary.alerts.some((a) => a.code.startsWith("COMPARTMENT_GENERIC_")), false);
});

test("Shanghai/Tokyo dual-node offline degradation vs single-node degradation vs healthy", () => {
  // 1. Fully healthy baseline
  const healthy = vm.evaluateMonitorHealthAndAlerts(makeBaseSnapshot());
  assert.equal(healthy.level, "healthy");
  assert.equal(healthy.primaryNodeStatus, "online");
  assert.equal(healthy.shanghaiNodeStatus, "online");
  assert.equal(healthy.dualNodeDegraded, false);
  assert.equal(healthy.alerts.length, 0);

  // 2. Shanghai pull mode degraded (high fallback rate >= 50%)
  const shDegradedSnap = makeBaseSnapshot({
    shanghai: {
      mode: "pull",
      waiting_workers: 1,
      queued_tasks: 2,
      pending_tasks: 1,
      total: { hits: 20, fallbacks: 30, queue_timeouts: 0 },
      by_platform: { douyin: { hits: 10, fallbacks: 20 }, bilibili: { hits: 10, fallbacks: 10 } },
    },
  });
  const shDegraded = vm.evaluateMonitorHealthAndAlerts(shDegradedSnap);
  assert.equal(shDegraded.shanghaiNodeStatus, "degraded");
  assert.equal(shDegraded.level, "degraded");
  assert.equal(shDegraded.dualNodeDegraded, false);
  assert.ok(shDegraded.alerts.some((a) => a.code === "SHANGHAI_NODE_DEGRADED"));

  // 3. Shanghai offline alone (0 waiting workers, primary healthy)
  const shOfflineOnly = vm.evaluateMonitorHealthAndAlerts(
    makeBaseSnapshot({
      shanghai: {
        mode: "pull",
        waiting_workers: 0,
        queued_tasks: 5,
        pending_tasks: 0,
        total: { hits: 10, fallbacks: 40, queue_timeouts: 3 },
      },
    }),
  );
  assert.equal(shOfflineOnly.shanghaiNodeStatus, "offline");
  assert.equal(shOfflineOnly.primaryNodeStatus, "online");
  assert.equal(shOfflineOnly.dualNodeDegraded, false);
  assert.equal(shOfflineOnly.level, "critical");
  assert.ok(shOfflineOnly.alerts.some((a) => a.code === "SHANGHAI_NODE_OFFLINE"));

  // 4. Shanghai + Tokyo/Primary dual-node offline degradation
  const dualOffline = vm.evaluateMonitorHealthAndAlerts(
    makeBaseSnapshot({
      shanghai: {
        mode: "pull",
        waiting_workers: 0,
        queued_tasks: 12,
        pending_tasks: 0,
        total: { hits: 0, fallbacks: 90, queue_timeouts: 8 },
      },
      circuit_breakers: [
        { platform: "bilibili", state: "open", consecutive_failures: 15, disabled_by_config: false },
        { platform: "youtube", state: "open", consecutive_failures: 12, disabled_by_config: false },
      ],
      generic_circuit_breaker: { state: "open", consecutive_failures: 9, disabled_by_config: false },
      daily: [
        {
          date: "2026-11-26",
          total: 50,
          ok: 10,
          failed: 40,
          cache_hits: 0,
          shanghai_hits: 0,
          latency_ms: { p50_ms: 900, p95_ms: 4000, max_ms: 9000 },
          by_platform: {
            youtube: { total: 50, ok: 10, failed: 40, p95_ms: 4000, by_code: { UPSTREAM_UNAVAILABLE: 40 } },
          },
        },
      ],
    }),
  );
  assert.equal(dualOffline.shanghaiNodeStatus, "offline");
  assert.equal(dualOffline.primaryNodeStatus, "offline");
  assert.equal(dualOffline.dualNodeDegraded, true);
  assert.equal(dualOffline.level, "critical");
  assert.equal(dualOffline.alerts[0].code, "DUAL_NODE_DEGRADED");
  assert.match(dualOffline.summaryText, /上海与主节点同时异常/);
});

test("trend chart normalization, KPI derivations, runtime switches & platform sorting", () => {
  const snap = makeBaseSnapshot({
    daily: [
      { date: "2026-11-24", total: 0, ok: 0, failed: 0, cache_hits: 0, shanghai_hits: 0 },
      { date: "2026-11-25", total: -5, ok: Number.NaN, failed: 2, cache_hits: -1, shanghai_hits: 0 },
      {
        date: "2026-11-26",
        total: 100,
        ok: 92,
        failed: 8,
        cache_hits: 40,
        shanghai_hits: 18,
        latency_ms: { p50_ms: 88, p95_ms: 310, max_ms: 900 },
        by_platform: {
          bilibili: { total: 60, ok: 58, failed: 2, p95_ms: 210, by_code: { UPSTREAM_TIMEOUT: 2 } },
          douyin: { total: 40, ok: 34, failed: 6, p95_ms: 410, by_code: { RATE_LIMITED: 6 } },
        },
      },
    ],
  });

  const normalized = vm.normalizeDailyTrendBuckets(snap.daily, 7);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[1].total, 0);
  assert.equal(normalized[1].ok, 0);

  const dailyViewDefault = vm.buildMonitorDailyChartView(snap, 7, null);
  assert.equal(dailyViewDefault.activePoint?.date, "2026-11-26");
  // Zero-total days have rateY === null and are filtered out of ratePoints
  assert.equal(dailyViewDefault.ratePoints.length, 1);

  const dailyViewHover = vm.buildMonitorDailyChartView(snap, 7, 0);
  assert.equal(dailyViewHover.activePoint?.date, "2026-11-24");

  const hourlyHover = vm.buildMonitorHourlyChartView(snap, 0);
  assert.equal(hourlyHover.activePoint?.hourStart, "2026-11-26T08:00:00+08:00");

  // KPI formatting & UTC+8 time
  const kpi = vm.buildMonitorKpiViewModel(
    snap,
    Date.UTC(2026, 10, 26, 1, 2, 3),
    "local",
    "dark",
  );
  assert.equal(kpi.formattedFetchedTime, "09:02:03 (UTC+8)");
  assert.equal(kpi.credentialSourceLabel, "本机已记住");
  assert.equal(kpi.themeButtonLabel, "深色");
  assert.equal(kpi.versionInfo.display, "abcdef1");
  assert.equal(kpi.cacheHitRateText, "75.0%");
  assert.equal(kpi.cacheStaleHits, 7);

  // Runtime switches matrix (11 flags)
  const switches = vm.buildRuntimeSwitchRows(snap);
  assert.equal(switches.length, 11);
  assert.equal(switches[0].copyable, true);
  assert.equal(switches[5].tone, "accent");

  // Platform sorting & helpers
  const byEffDesc = vm.buildSortedPlatformHealthRows(snap, "today", "effectiveSuccessRate", "desc");
  assert.equal(byEffDesc[0].platform, "douyin"); // 34/34 = 100% effective vs bilibili 58/60 = 96.7%
  const byP95Asc = vm.buildSortedPlatformHealthRows(snap, "today", "p95Ms", "asc");
  assert.equal(byP95Asc[0].platform, "bilibili");

  assert.deepEqual(vm.computeNextPlatformSort("total", "desc", "total"), { sortKey: "total", sortDir: "asc" });
  assert.deepEqual(vm.computeNextPlatformSort("total", "desc", "platform"), { sortKey: "platform", sortDir: "asc" });
  assert.equal(vm.getPlatformSortIndicator("total", "desc", "total"), "▼");
  assert.equal(vm.getPlatformSortIndicator("total", "desc", "ok"), "");
  assert.equal(vm.rateToneClass(96), "ok");
  assert.equal(vm.rateToneClass(85), "warn");
  assert.equal(vm.rateToneClass(72), "danger");
  assert.equal(vm.formatRateValue(99.94), "99.9%");
  assert.equal(vm.formatRateValue(null), "—");
  assert.equal(vm.roleBadgeClass("Owner"), "mon-role-badge--owner");
  assert.equal(vm.roleBadgeClass("agent"), "mon-role-badge--agent");
  assert.equal(vm.roleBadgeClass("guest"), "mon-role-badge--other");
});
