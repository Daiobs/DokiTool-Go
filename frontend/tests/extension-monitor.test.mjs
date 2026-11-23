import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import * as vue from "vue";
import { loadSfc } from "./helpers/loadSfc.mjs";

const { createRenderer, h, markRaw, nextTick, ref } = vue;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(__dirname, "..");

let tmpBundleDir = "";
let statsTypes;
let protocol;
let storage;
let uiTargetHelpers;
let backgroundMod;

async function bundleMonitorModules() {
  tmpBundleDir = mkdtempSync(join(tmpdir(), "dokitool-ext-monitor-test-"));
  const outfile = join(tmpBundleDir, "suite.mjs");
  await build({
    stdin: {
      contents: `
        export * as statsTypes from "./src/extension/statsTypes.ts";
        export * as protocol from "./src/extension/protocol.ts";
        export * as storage from "./src/extension/storage.ts";
        export * as uiTargetHelpers from "./src/extension/uiTargetHelpers.ts";
        export * as backgroundMod from "./src/extension/background.ts";
      `,
      resolveDir: FRONTEND_DIR,
      loader: "ts",
    },
    bundle: true,
    outfile,
    platform: "browser",
    format: "esm",
  });
  return import(pathToFileURL(outfile).href);
}

before(async () => {
  globalThis.__DOKITOOL_EXT_TEST__ = true;
  const suite = await bundleMonitorModules();
  statsTypes = suite.statsTypes;
  protocol = suite.protocol;
  storage = suite.storage;
  uiTargetHelpers = suite.uiTargetHelpers;
  backgroundMod = suite.backgroundMod;
});

beforeEach(() => {
  storage.resetInMemoryExtensionStorage();
});

after(() => {
  stop();
  if (tmpBundleDir) {
    rmSync(tmpBundleDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Shared Rich Stats Fixture (30d daily + 24h hourly + 11 runtime flags + keys)
// ============================================================================

function createRichStatsSnapshot(overrides = {}) {
  const emptyBuckets = {
    "<=10": 10,
    "<=50": 40,
    "<=100": 80,
    "<=250": 120,
    "<=500": 160,
    "<=1000": 190,
    "<=2500": 210,
    "<=5000": 218,
    "<=10000": 220,
    "<=30000": 220,
    "+Inf": 220,
  };
  const emptyHist = {
    count: 220,
    sum_ms: 48_000,
    max_ms: 4200,
    buckets: emptyBuckets,
  };
  const makeDailyDate = (daysAgo) => {
    const baseMs = Date.UTC(2026, 10, 22, 0, 0, 0); // 2026-11-22
    const d = new Date(baseMs - daysAgo * 86_400_000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const date = makeDailyDate(i);
    if (i === 0) {
      // Today (index 29)
      daily.push({
        date,
        total: 120,
        ok: 114,
        failed: 6,
        cache_hits: 38,
        shanghai_hits: 24,
        latency_ms: { p50_ms: 140, p95_ms: 820, max_ms: 3100 },
        by_platform: {
          douyin: {
            total: 50,
            ok: 49,
            failed: 1,
            by_code: { OK: 49, UPSTREAM_TIMEOUT: 1 },
            p95_ms: 420,
          },
          bilibili: {
            total: 40,
            ok: 36,
            failed: 4,
            by_code: { OK: 36, UPSTREAM_BLOCKED: 3, RATE_LIMITED: 1 },
            p95_ms: 910,
          },
          vimeo: {
            total: 20,
            ok: 20,
            failed: 0,
            by_code: { OK: 20 },
            p95_ms: 650,
          },
          ytdlp_other: {
            total: 10,
            ok: 9,
            failed: 1,
            by_code: { OK: 9, NO_MEDIA: 1 },
            p95_ms: 1200,
          },
        },
      });
    } else if (i === 1) {
      // Yesterday (index 28)
      daily.push({
        date,
        total: 100,
        ok: 90,
        failed: 10,
        cache_hits: 22,
        shanghai_hits: 15,
        latency_ms: { p50_ms: 180, p95_ms: 980, max_ms: 3500 },
        by_platform: {
          xiaohongshu: {
            total: 60,
            ok: 52,
            failed: 8,
            by_code: { OK: 52, UPSTREAM_BLOCKED: 6, UPSTREAM_TIMEOUT: 2 },
            p95_ms: 1100,
          },
          youtube: {
            total: 40,
            ok: 38,
            failed: 2,
            by_code: { OK: 38, CONTENT_UNAVAILABLE: 2 },
            p95_ms: 520,
          },
        },
      });
    } else if (i === 5) {
      // Inside 7d window
      daily.push({
        date,
        total: 40,
        ok: 38,
        failed: 2,
        cache_hits: 10,
        shanghai_hits: 4,
        latency_ms: { p50_ms: 160, p95_ms: 700, max_ms: 1900 },
        by_platform: {
          weibo: {
            total: 40,
            ok: 38,
            failed: 2,
            by_code: { OK: 38, UPSTREAM_UNAVAILABLE: 2 },
            p95_ms: 700,
          },
        },
      });
    } else if (i === 15) {
      // Inside 30d window ONLY (outside 7d)
      daily.push({
        date,
        total: 30,
        ok: 27,
        failed: 3,
        cache_hits: 5,
        shanghai_hits: 0,
        latency_ms: { p50_ms: 210, p95_ms: 1500, max_ms: 4100 },
        by_platform: {
          tumblr: {
            total: 30,
            ok: 27,
            failed: 3,
            by_code: { OK: 27, UPSTREAM_TIMEOUT: 3 },
            p95_ms: 1500,
          },
        },
      });
    } else {
      daily.push({
        date,
        total: 0,
        ok: 0,
        failed: 0,
        cache_hits: 0,
        shanghai_hits: 0,
        latency_ms: { p50_ms: 0, p95_ms: 0, max_ms: 0 },
        by_platform: {},
      });
    }
  }

  const hourly = [];
  for (let hIdx = 0; hIdx < 24; hIdx++) {
    const hh = String(hIdx).padStart(2, "0");
    hourly.push({
      hour_start: `2026-11-22T${hh}:00:00+08:00`,
      total: hIdx >= 20 ? 18 : hIdx % 3 === 0 ? 6 : 2,
      ok: hIdx >= 20 ? 17 : hIdx % 3 === 0 ? 5 : 2,
      failed: hIdx >= 20 ? 1 : hIdx % 3 === 0 ? 1 : 0,
      cache_hits: hIdx >= 20 ? 7 : 1,
    });
  }

  return {
    started_at: "2026-11-20T08:00:00Z",
    generated_at: "2026-11-22T15:30:00Z",
    uptime_seconds: 199_800,
    requests: {
      total: 315,
      by_channel: { anonymous: 115, owner: 200 },
      by_platform_code_channel: [
        { platform: "douyin", code: "OK", channel: "owner", count: 120 },
        { platform: "douyin", code: "UPSTREAM_TIMEOUT", channel: "anonymous", count: 5 },
        { platform: "bilibili", code: "OK", channel: "owner", count: 80 },
        { platform: "bilibili", code: "UPSTREAM_BLOCKED", channel: "anonymous", count: 10 },
        { platform: "vimeo", code: "OK", channel: "owner", count: 60 },
        { platform: "ytdlp_other", code: "OK", channel: "owner", count: 25 },
        { platform: "unknown", code: "INVALID_INPUT", channel: "anonymous", count: 15 },
      ],
    },
    cache: {
      enabled: true,
      entries: 64,
      bytes: 2_621_440,
      max_entries: 1000,
      max_bytes: 67_108_864,
      total: { hits: 140, misses: 60, singleflight_shared: 18, uncacheable: 12 },
      by_channel: {
        anonymous: { hits: 50, misses: 30, singleflight_shared: 6, uncacheable: 4 },
        owner: { hits: 90, misses: 30, singleflight_shared: 12, uncacheable: 8 },
      },
    },
    admission: {
      fast: {
        active: 3,
        queued: 1,
        concurrency_limit: 8,
        queue_limit: 32,
        waited: 12,
        granted: 200,
        timeout: 0,
        full: 0,
        canceled: 1,
        wait_ms_total: 420,
        wait_ms_max: 85,
      },
      slow: {
        active: 2,
        queued: 0,
        concurrency_limit: 4,
        queue_limit: 16,
        waited: 8,
        granted: 40,
        timeout: 1,
        full: 0,
        canceled: 0,
        wait_ms_total: 1200,
        wait_ms_max: 450,
      },
      owner: {
        active: 1,
        queued: 0,
        concurrency_limit: 6,
        queue_limit: 24,
        waited: 0,
        granted: 95,
        timeout: 0,
        full: 0,
        canceled: 0,
        wait_ms_total: 0,
        wait_ms_max: 0,
      },
    },
    api_keys: [
      {
        id: "owner-main",
        role: "owner",
        enabled: true,
        active: 1,
        slow_active: 0,
        queued: 0,
        concurrency_limit: 8,
        slow_concurrency_limit: 4,
        queue_limit: 20,
        requests_total: 200,
        ok: 196,
        errors: 4,
        cache_hits: 90,
        rate_limited: 0,
        unauthorized: 0,
        waited: 2,
        granted: 200,
        timeout: 0,
        full: 0,
        canceled: 0,
        wait_ms_total: 35,
        wait_ms_max: 20,
      },
      {
        id: "friend-alice",
        role: "friend",
        enabled: true,
        active: 0,
        slow_active: 0,
        queued: 0,
        concurrency_limit: 2,
        slow_concurrency_limit: 1,
        queue_limit: 4,
        requests_total: 42,
        ok: 39,
        errors: 3,
        cache_hits: 14,
        rate_limited: 2,
        unauthorized: 1,
        waited: 5,
        granted: 40,
        timeout: 0,
        full: 0,
        canceled: 0,
        wait_ms_total: 250,
        wait_ms_max: 110,
      },
    ],
    ytdlp: {
      enabled: true,
      concurrency_limit: 3,
      active: 1,
      waiting: 2,
      total: {
        acquired_count: 55,
        wait_count: 7,
        canceled_count: 1,
        wait_ms_total: 1800,
        wait_ms_max: 620,
        wait_ms: emptyHist,
      },
      by_channel: {
        anonymous: {
          acquired_count: 20,
          wait_count: 5,
          canceled_count: 1,
          wait_ms_total: 1400,
          wait_ms_max: 620,
          wait_ms: emptyHist,
        },
        owner: {
          acquired_count: 35,
          wait_count: 2,
          canceled_count: 0,
          wait_ms_total: 400,
          wait_ms_max: 250,
          wait_ms: emptyHist,
        },
      },
    },
    shanghai: {
      enabled: true,
      mode: "pull",
      waiting_workers: 2,
      queued_tasks: 0,
      pending_tasks: 1,
      total: {
        hits: 85,
        fallbacks: 15,
        canceled: 0,
        queue_waits: 10,
        queue_granted: 10,
        queue_timeouts: 0,
        queue_wait_ms_total: 320,
        queue_wait_ms_max: 60,
      },
      by_channel: {
        anonymous: {
          hits: 30,
          fallbacks: 8,
          canceled: 0,
          queue_waits: 6,
          queue_granted: 6,
          queue_timeouts: 0,
          queue_wait_ms_total: 200,
          queue_wait_ms_max: 60,
        },
        owner: {
          hits: 55,
          fallbacks: 7,
          canceled: 0,
          queue_waits: 4,
          queue_granted: 4,
          queue_timeouts: 0,
          queue_wait_ms_total: 120,
          queue_wait_ms_max: 45,
        },
      },
      by_platform: {
        douyin: {
          hits: 60,
          fallbacks: 10,
          canceled: 0,
          queue_waits: 6,
          queue_granted: 6,
          queue_timeouts: 0,
          queue_wait_ms_total: 180,
          queue_wait_ms_max: 50,
        },
        bilibili: {
          hits: 25,
          fallbacks: 5,
          canceled: 0,
          queue_waits: 4,
          queue_granted: 4,
          queue_timeouts: 0,
          queue_wait_ms_total: 140,
          queue_wait_ms_max: 60,
        },
      },
    },
    parse_latency_ms: {
      total: emptyHist,
      by_channel: { anonymous: emptyHist, owner: emptyHist },
    },
    runtime: {
      version: "v4.1.0-prb",
      shanghai_mode: "pull",
      shanghai_bilibili: true,
      bilibili_dash: true,
      youtube_helper: true,
      xhs_transport: "chrome131",
      ytdlp_enabled: true,
      ytdlp_generic_enabled: false,
      tbvideo_pipigx: true,
      tbvideo_zuiyou: true,
      stats_persistence_enabled: true,
    },
    daily,
    hourly,
    ...overrides,
  };
}

// ============================================================================
// SFC Test Harness Helpers (Matches extension-download-flow.test.mjs)
// ============================================================================

const PassthroughTransition = {
  inheritAttrs: false,
  setup: (_props, { slots }) => () => slots.default?.(),
};

async function loadExtensionSfc(relPathFromTests) {
  return loadSfc(new URL(relPathFromTests, import.meta.url), {
    resolve(spec) {
      if (spec === "vue") {
        return {
          ...vue,
          Transition: PassthroughTransition,
          TransitionGroup: PassthroughTransition,
        };
      }
      return undefined;
    },
  });
}

function mountSfcTree(Component, initialProps = {}, listeners = {}) {
  const element = (type, text = "") => {
    const domListeners = new Map();
    return markRaw({
      type,
      text,
      value: "",
      props: {},
      children: [],
      parent: null,
      style: {},
      addEventListener(evt, fn) {
        if (!domListeners.has(evt)) domListeners.set(evt, new Set());
        domListeners.get(evt).add(fn);
      },
      removeEventListener(evt, fn) {
        domListeners.get(evt)?.delete(fn);
      },
      dispatchEvent(evtObj) {
        const set = domListeners.get(evtObj?.type);
        if (set) {
          for (const fn of [...set]) fn(evtObj);
        }
      },
    });
  };
  const detach = (node) => {
    if (node.parent) {
      node.parent.children = node.parent.children.filter((c) => c !== node);
    }
    node.parent = null;
  };
  const renderer = createRenderer({
    createElement: element,
    createText: (text) => element("#text", text),
    createComment: (text) => element("#comment", text),
    setText(node, text) {
      node.text = text;
    },
    setElementText(node, text) {
      node.text = text;
      node.children = [];
    },
    parentNode: (node) => node.parent,
    nextSibling: (node) =>
      node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insert(node, parent, anchor) {
      detach(node);
      node.parent = parent;
      const idx = parent.children.indexOf(anchor);
      parent.children.splice(
        idx < 0 ? parent.children.length : idx,
        0,
        node,
      );
    },
    remove: detach,
    patchProp(node, key, _prev, value) {
      node.props[key] = value;
      if (key === "value") node.value = value ?? "";
      if (key === "style" && value && typeof value === "object") {
        Object.assign(node.style, value);
      }
    },
  });

  const propsRef = ref({ ...initialProps });
  const root = element("root");
  const app = renderer.createApp({
    render: () => h(Component, { ...propsRef.value, ...listeners }),
  });
  app.mount(root);

  const textOf = (node = root) =>
    [node.text || "", ...(node.children || []).map(textOf)].join("");
  const findAll = (predicate, node = root) => [
    ...(predicate(node) ? [node] : []),
    ...(node.children || []).flatMap((child) => findAll(predicate, child)),
  ];
  const findByTestId = (testId) =>
    findAll((n) => n.props?.["data-testid"] === testId);
  const flush = async () => {
    await nextTick();
    await nextTick();
  };
  const fire = async (node, eventProp, arg) => {
    assert.ok(node, `Expected target node for ${eventProp}`);
    const handler = node.props[eventProp];
    assert.ok(handler, `Expected ${eventProp} handler on <${node.type}>`);
    for (const fn of [handler].flat()) {
      await fn(arg);
    }
    await flush();
  };

  return {
    root,
    propsRef,
    textOf,
    findAll,
    findByTestId,
    flush,
    fire,
    unmount() {
      app.unmount();
    },
  };
}

function createMinimalChromeBus(storageCtrl, tabsMock = {}) {
  const messageListeners = new Set();
  const portConnectListeners = new Set();
  const storageListeners = new Set();

  const chrome = {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      getURL: (p) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}`,
      sendMessage(msg, cb) {
        const invoke = new Promise((resolvePromise) => {
          let handled = false;
          for (const listener of [...messageListeners]) {
            const ret = listener(msg, {}, (resp) => {
              handled = true;
              resolvePromise(resp);
            });
            if (ret === true) {
              handled = true;
            }
          }
          if (!handled) resolvePromise(undefined);
        });
        if (typeof cb === "function") {
          invoke.then((res) => cb(res));
          return undefined;
        }
        return invoke;
      },
      connect(info) {
        const clientListeners = new Set();
        const disconnectListeners = new Set();
        const serverPort = {
          name: info?.name || "",
          postMessage(msg) {
            for (const fn of [...clientListeners]) fn(msg);
          },
          disconnect() {
            for (const fn of [...disconnectListeners]) fn();
          },
          onMessage: { addListener() {} },
          onDisconnect: { addListener() {} },
        };
        for (const fn of [...portConnectListeners]) fn(serverPort);
        return {
          name: info?.name || "",
          postMessage() {},
          disconnect() {},
          onMessage: {
            addListener(fn) {
              clientListeners.add(fn);
            },
            removeListener(fn) {
              clientListeners.delete(fn);
            },
          },
          onDisconnect: {
            addListener(fn) {
              disconnectListeners.add(fn);
            },
            removeListener(fn) {
              disconnectListeners.delete(fn);
            },
          },
        };
      },
      onMessage: {
        addListener(fn) {
          messageListeners.add(fn);
        },
        removeListener(fn) {
          messageListeners.delete(fn);
        },
      },
      onConnect: {
        addListener(fn) {
          portConnectListeners.add(fn);
        },
      },
    },
    tabs: {
      query: tabsMock.query ?? (async () => []),
      create: tabsMock.create ?? (async () => ({ id: 99 })),
      update: tabsMock.update ?? (async () => ({})),
    },
    windows: {
      update: tabsMock.windowUpdate ?? (async () => ({})),
    },
    declarativeNetRequest: {
      updateDynamicRules: async () => {},
    },
    storage: {
      onChanged: {
        addListener(fn) {
          storageListeners.add(fn);
        },
        removeListener(fn) {
          storageListeners.delete(fn);
        },
      },
    },
    _emitStorageChange(changes, areaName = "local") {
      for (const fn of [...storageListeners]) fn(changes, areaName);
    },
    _storageCtrl: storageCtrl,
  };
  return chrome;
}

// ============================================================================
// 1. Pure statsTypes.ts unit tests
// ============================================================================

test("statsTypes: validation guard, today vs yesterday deltas, platform health 5-window aggregation, formatters, and SVG chart geometry", () => {
  const snap = createRichStatsSnapshot();
  assert.equal(statsTypes.isValidStatsSnapshot(snap), true);
  assert.equal(statsTypes.isValidStatsSnapshot(null), false);
  assert.equal(
    statsTypes.isValidStatsSnapshot({ ...snap, runtime: undefined }),
    false,
  );
  assert.equal(
    statsTypes.isValidStatsSnapshot({ ...snap, daily: "bad" }),
    false,
  );
  assert.equal(
    statsTypes.isValidStatsSnapshot({ ...snap, hourly: [{ bad: true }] }),
    false,
  );

  // Today vs Yesterday computation
  const tv = statsTypes.computeTodayVsYesterday(snap);
  assert.equal(tv.date, "2026-11-22");
  assert.equal(tv.yesterdayDate, "2026-11-21");
  assert.equal(tv.total, 120);
  assert.equal(tv.ok, 114);
  assert.equal(tv.failed, 6);
  assert.equal(tv.successRate, 95);
  assert.equal(tv.cacheHits, 38);
  assert.equal(tv.shanghaiHits, 24);
  assert.equal(tv.deltaTotal, 20); // 120 - 100
  assert.equal(tv.deltaRatePct, 5); // 95.0 - 90.0

  // 5-window platform health aggregation (core 14 + long-tail + ytdlp_other + unknown)
  const todayRows = statsTypes.aggregatePlatformHealth(snap, "today");
  assert.deepEqual(
    todayRows.map((r) => r.platform),
    ["douyin", "bilibili", "vimeo", "ytdlp_other"],
  );
  assert.equal(todayRows[0].label, "抖音");
  assert.equal(todayRows[1].label, "B站");
  assert.equal(todayRows[2].label, "vimeo");
  assert.equal(todayRows[3].label, "其他站点 (yt-dlp)");
  assert.deepEqual(todayRows[1].topErrors, [
    { code: "UPSTREAM_BLOCKED", count: 3, severity: "danger" },
    { code: "RATE_LIMITED", count: 1, severity: "warning" },
  ]);
  assert.equal(todayRows[1].p95Ms, 910);

  const yesterdayRows = statsTypes.aggregatePlatformHealth(snap, "yesterday");
  assert.deepEqual(
    yesterdayRows.map((r) => r.platform),
    ["xiaohongshu", "youtube"],
  );
  assert.equal(yesterdayRows[0].label, "小红书");

  const sevenDayRows = statsTypes.aggregatePlatformHealth(snap, "7d");
  const sevenPlatforms = new Set(sevenDayRows.map((r) => r.platform));
  assert.equal(sevenPlatforms.has("weibo"), true);
  assert.equal(sevenPlatforms.has("tumblr"), false); // 15 days ago -> excluded from 7d

  const thirtyDayRows = statsTypes.aggregatePlatformHealth(snap, "30d");
  const thirtyPlatforms = new Set(thirtyDayRows.map((r) => r.platform));
  assert.equal(thirtyPlatforms.has("tumblr"), true);

  const sinceStartRows = statsTypes.aggregatePlatformHealth(snap, "since_start");
  const unknownRow = sinceStartRows.find((r) => r.platform === "unknown");
  assert.ok(unknownRow);
  assert.equal(unknownRow.label, "未识别 / 无效输入");
  assert.equal(unknownRow.failed, 15);
  assert.equal(unknownRow.p95Ms, null);
  assert.deepEqual(unknownRow.topErrors, [
    { code: "INVALID_INPUT", count: 15, severity: "muted" },
  ]);

  // Formatters
  assert.equal(statsTypes.formatUptimeDuration(0), "0秒");
  assert.equal(statsTypes.formatUptimeDuration(45), "45秒");
  assert.equal(statsTypes.formatUptimeDuration(125), "2分 5秒");
  assert.equal(statsTypes.formatUptimeDuration(3720), "1小时 2分");
  assert.equal(statsTypes.formatUptimeDuration(199_800), "2天 7小时 30分");
  assert.equal(statsTypes.formatPercent(0, 0), "—");
  assert.equal(statsTypes.formatPercent(114, 120), "95.0%");
  assert.equal(
    statsTypes.formatShanghaiHourLabel("2026-11-22T16:00:00+08:00"),
    "16:00",
  );
  assert.equal(
    statsTypes.formatShanghaiHourLabel("2026-11-22T00:00:00Z"),
    "08:00",
  );

  // Pure SVG chart geometry (7d vs 30d + 24h)
  const chart7 = statsTypes.buildDailyChartPoints(snap.daily, 7);
  assert.equal(chart7.points.length, 7);
  assert.equal(chart7.points[6].date, "2026-11-22");
  assert.ok(chart7.points[6].okHeight > 0);
  assert.ok(chart7.points[6].failedHeight > 0);
  assert.ok(chart7.ratePathD.includes("M"));

  const chart30 = statsTypes.buildDailyChartPoints(snap.daily, 30);
  assert.equal(chart30.points.length, 30);
  assert.equal(chart30.points[0].date, "2026-10-24");

  const hourlyGeom = statsTypes.buildHourlyChartPoints(snap.hourly);
  assert.equal(hourlyGeom.points.length, 24);
  assert.equal(hourlyGeom.points[0].hourLabel, "00:00");
  assert.equal(hourlyGeom.points[23].hourLabel, "23:00");
});

// ============================================================================
// 2. openMonitorDashboardTab helper tests
// ============================================================================

test("uiTargetHelpers.openMonitorDashboardTab: reuses existing tab, creates new tab, and no-ops outside extension", async () => {
  const prevChrome = globalThis.chrome;
  try {
    // Outside extension -> false
    delete globalThis.chrome;
    assert.equal(await uiTargetHelpers.openMonitorDashboardTab(), false);

    // Existing tab found -> focus via tabs.update + windows.update without tabs.create
    const calls = { create: [], update: [], windowUpdate: [] };
    globalThis.chrome = {
      runtime: {
        getURL: (p) => `chrome-extension://testext/${p}`,
      },
      tabs: {
        query: async ({ url }) =>
          url === "chrome-extension://testext/monitor.html"
            ? [{ id: 42, windowId: 7, url }]
            : [],
        update: async (id, props) => {
          calls.update.push({ id, props });
        },
        create: async (props) => {
          calls.create.push(props);
        },
      },
      windows: {
        update: async (wid, props) => {
          calls.windowUpdate.push({ wid, props });
        },
      },
    };
    assert.equal(await uiTargetHelpers.openMonitorDashboardTab(), true);
    assert.deepEqual(calls.update, [{ id: 42, props: { active: true } }]);
    assert.deepEqual(calls.windowUpdate, [{ wid: 7, props: { focused: true } }]);
    assert.equal(calls.create.length, 0);

    // No existing tab -> calls tabs.create with monitor.html
    globalThis.chrome.tabs.query = async () => [];
    assert.equal(await uiTargetHelpers.openMonitorDashboardTab(), true);
    assert.deepEqual(calls.create, [
      { url: "chrome-extension://testext/monitor.html", active: true },
    ]);
  } finally {
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

// ============================================================================
// 3. background.ts FETCH_OWNER_STATS tests (no-token 0-fetch, 401, 200 OK)
// ============================================================================

test("background.ts FETCH_OWNER_STATS: zero fetch without token, 401 UNAUTHORIZED for friend key, 200 OK for owner key", async () => {
  assert.equal(
    protocol.isSidePanelRequest({ type: "FETCH_OWNER_STATS" }),
    true,
  );

  const fetchCalls = [];
  const sampleStats = createRichStatsSnapshot();
  const mockFetch = async (url, init) => {
    fetchCalls.push({ url, init });
    const auth = init?.headers?.Authorization || "";
    if (auth === "Bearer owner-secret-key") {
      return new Response(
        JSON.stringify({ schema_version: "1.0", code: "OK", data: sampleStats }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (auth === "Bearer bad-schema-key") {
      return new Response(
        JSON.stringify({ schema_version: "1.0", code: "OK", data: { broken: true } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        schema_version: "1.0",
        code: "INVALID_INPUT",
        error: { code: "UNAUTHORIZED", message: "owner token required" },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  };

  const store = storage.createExtensionStorage({
    local: storage.createMemoryStorageArea(),
    session: storage.createMemoryStorageArea(),
  });
  const chrome = createMinimalChromeBus(store);
  const bg = backgroundMod.createBackgroundController({
    chrome,
    storage: store,
    fetchImpl: mockFetch,
    now: () => 1_760_000_000_000,
  });
  await bg.init();

  const sendRpc = (msg) =>
    new Promise((resolvePromise) => {
      bg.handleRuntimeMessage(msg, {}, resolvePromise);
    });

  try {
    // A. Empty token -> 0 network calls, immediate NO_TOKEN 401
    const noTokenRes = await sendRpc({ type: "FETCH_OWNER_STATS" });
    assert.equal(noTokenRes.ok, false);
    assert.equal(noTokenRes.status, 401);
    assert.equal(noTokenRes.code, "NO_TOKEN");
    assert.equal(fetchCalls.length, 0, "anonymous mode must issue ZERO network requests");

    // B. friend token -> 401 UNAUTHORIZED, cookie-free & no-store fetch options
    await store.updateSettings({ bearerToken: "friend-secret-key" });
    const friendRes = await sendRpc({ type: "FETCH_OWNER_STATS" });
    assert.equal(friendRes.ok, false);
    assert.equal(friendRes.status, 401);
    assert.equal(friendRes.code, "UNAUTHORIZED");
    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0].url,
      "https://snap.dokitool.com/api/stats?schema_version=1.0",
    );
    assert.equal(fetchCalls[0].init.credentials, "omit");
    assert.equal(fetchCalls[0].init.referrerPolicy, "no-referrer");
    assert.equal(fetchCalls[0].init.cache, "no-store");
    assert.equal(
      fetchCalls[0].init.headers.Authorization,
      "Bearer friend-secret-key",
    );

    // C. owner token -> 200 OK with validated StatsSnapshot
    await store.updateSettings({ bearerToken: "owner-secret-key" });
    const ownerRes = await sendRpc({ type: "FETCH_OWNER_STATS" });
    assert.equal(ownerRes.ok, true);
    assert.equal(ownerRes.data.apiOrigin, "https://snap.dokitool.com");
    assert.equal(ownerRes.data.fetchedAt, 1_760_000_000_000);
    assert.equal(ownerRes.data.stats.runtime.version, "v4.1.0-prb");
    assert.equal(ownerRes.data.stats.daily.length, 30);
    assert.equal(ownerRes.data.stats.hourly.length, 24);

    // D. Malformed 200 payload rejected cleanly
    await store.updateSettings({ bearerToken: "bad-schema-key" });
    const badRes = await sendRpc({ type: "FETCH_OWNER_STATS" });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.code, "STATS_FAILED");
  } finally {
    bg.dispose();
  }
});

// ============================================================================
// 4. SidePanelApp.vue Owner Status Capsule Visibility Isolation Tests
// ============================================================================

test("SidePanelApp.vue: owner-stats-pill renders ONLY on owner 200 OK and stays strictly silent on anonymous / friend 401", async () => {
  const SidePanelApp = await loadExtensionSfc("../src/extension/SidePanelApp.vue");
  const prevChrome = globalThis.chrome;
  const sampleStats = createRichStatsSnapshot();

  async function runScenario(token) {
    const fetchUrls = [];
    const tabCreateCalls = [];
    const store = storage.createExtensionStorage({
      local: storage.createMemoryStorageArea(),
      session: storage.createMemoryStorageArea(),
    });
    if (token) {
      await store.updateSettings({ bearerToken: token });
    }
    const chrome = createMinimalChromeBus(store, {
      create: async (props) => {
        tabCreateCalls.push(props);
        return { id: 101 };
      },
    });
    const bg = backgroundMod.createBackgroundController({
      chrome,
      storage: store,
      fetchImpl: async (url, init) => {
        fetchUrls.push(url);
        if (
          url.includes("/api/stats") &&
          init?.headers?.Authorization === "Bearer owner-tok"
        ) {
          return new Response(
            JSON.stringify({ schema_version: "1.0", code: "OK", data: sampleStats }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "INVALID_INPUT",
            error: { code: "UNAUTHORIZED", message: "forbidden" },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    await bg.init();
    globalThis.chrome = chrome;

    const mounted = mountSfcTree(SidePanelApp);
    await new Promise((r) => setTimeout(r, 40));
    await mounted.flush();
    return {
      mounted,
      fetchUrls,
      tabCreateCalls,
      cleanup() {
        mounted.unmount();
        bg.dispose();
      },
    };
  }

  try {
    // A. Anonymous mode -> zero /api/stats fetch, zero pill, zero error banners/toasts
    const anon = await runScenario("");
    try {
      assert.equal(anon.mounted.findByTestId("owner-stats-pill").length, 0);
      assert.equal(
        anon.fetchUrls.some((u) => u.includes("/api/stats")),
        false,
        "anonymous SidePanel must never request /api/stats",
      );
      assert.equal(
        anon.mounted.findAll((n) => n.props?.role === "alert").length,
        0,
      );
      assert.equal(
        anon.mounted.findAll((n) => n.props?.role === "status").length,
        0,
      );
    } finally {
      anon.cleanup();
    }

    // B. friend role key -> /api/stats returns 401, pill hidden, ZERO error toast or banner
    const friend = await runScenario("friend-tok");
    try {
      assert.equal(friend.mounted.findByTestId("owner-stats-pill").length, 0);
      assert.equal(
        friend.fetchUrls.some((u) => u.includes("/api/stats")),
        true,
      );
      assert.equal(
        friend.mounted.findAll((n) => n.props?.role === "alert").length,
        0,
        "401 on /api/stats must not show error alert",
      );
      assert.equal(
        friend.mounted.findAll((n) => n.props?.role === "status").length,
        0,
        "401 on /api/stats must not show toast",
      );
    } finally {
      friend.cleanup();
    }

    // C. owner role key -> 200 OK -> owner-stats-pill visible with metrics & opens monitor.html
    const owner = await runScenario("owner-tok");
    try {
      const pills = owner.mounted.findByTestId("owner-stats-pill");
      assert.equal(pills.length, 1);
      const pillText = owner.mounted.textOf(pills[0]);
      assert.match(pillText, /今日 120 次/);
      assert.match(pillText, /95\.0%/);
      assert.match(pillText, /上海 2 节点/);
      assert.match(pillText, /解析监控大盘/);

      const openBtn = owner.mounted.findByTestId("open-monitor-dashboard-btn")[0];
      await owner.mounted.fire(openBtn, "onClick");
      assert.deepEqual(owner.tabCreateCalls, [
        {
          url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/monitor.html",
          active: true,
        },
      ]);
    } finally {
      owner.cleanup();
    }
  } finally {
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

// ============================================================================
// 5. MonitorApp.vue Full 5-Module Dashboard, Toggles, Visibility Pause & 401
// ============================================================================

test("MonitorApp.vue: renders all 5 modules, switches 7d/30d SVG chart & 5 health windows, pauses auto-refresh on visibilitychange, and guards 401 without token leak", async () => {
  const MonitorApp = await loadExtensionSfc("../src/extension/MonitorApp.vue");
  const prevChrome = globalThis.chrome;
  const prevDocument = globalThis.document;
  const sampleStats = createRichStatsSnapshot();

  // Lightweight mock document with controllable visibilityState & event listeners
  const docListeners = new Map();
  let mockVisibilityState = "visible";
  const mockDocument = {
    documentElement: { dataset: {} },
    get visibilityState() {
      return mockVisibilityState;
    },
    addEventListener(evt, fn) {
      if (!docListeners.has(evt)) docListeners.set(evt, new Set());
      docListeners.get(evt).add(fn);
    },
    removeEventListener(evt, fn) {
      docListeners.get(evt)?.delete(fn);
    },
    emitVisibility(nextState) {
      mockVisibilityState = nextState;
      for (const fn of [...(docListeners.get("visibilitychange") ?? [])]) {
        fn({ type: "visibilitychange" });
      }
    },
  };
  globalThis.document = mockDocument;

  const localArea = storage.createMemoryStorageArea();
  const sessionArea = storage.createMemoryStorageArea();
  const store = storage.createExtensionStorage({
    local: localArea,
    session: sessionArea,
  });
  await store.updateSettings({ bearerToken: "super-secret-owner-tok" });

  let statsFetchCount = 0;
  let force401 = false;
  const chrome = createMinimalChromeBus(store);
  chrome.storage.local = localArea;
  chrome.storage.session = sessionArea;

  const bg = backgroundMod.createBackgroundController({
    chrome,
    storage: store,
    fetchImpl: async (url) => {
      if (url.includes("/api/stats")) {
        statsFetchCount += 1;
        if (force401) {
          return new Response(
            JSON.stringify({
              schema_version: "1.0",
              code: "INVALID_INPUT",
              error: { code: "UNAUTHORIZED", message: "owner required" },
            }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ schema_version: "1.0", code: "OK", data: sampleStats }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    },
  });
  await bg.init();
  globalThis.chrome = chrome;

  let mounted = null;
  try {
    mounted = mountSfcTree(MonitorApp);
    await new Promise((r) => setTimeout(r, 40));
    await mounted.flush();

    // All 5 sections rendered
    assert.equal(mounted.findByTestId("section-kpi-cards").length, 1);
    assert.equal(mounted.findByTestId("section-runtime-pools").length, 1);
    assert.equal(mounted.findByTestId("section-charts").length, 1);
    assert.equal(mounted.findByTestId("section-platform-health").length, 1);
    assert.equal(mounted.findByTestId("section-api-keys").length, 1);

    const fullText = mounted.textOf();
    assert.equal(
      fullText.includes("super-secret-owner-tok"),
      false,
      "dashboard must never leak raw bearerToken in DOM",
    );

    // KPI Cards check (today total, yesterday delta, cache hit rate, Shanghai workers, version)
    const kpiText = mounted.textOf(mounted.findByTestId("section-kpi-cards")[0]);
    assert.match(kpiText, /120/);
    assert.match(kpiText, /较昨日 \+20/);
    assert.match(kpiText, /70\.0%/); // cache hit rate 140/200
    assert.match(kpiText, /2 节点/);
    assert.match(kpiText, /v4\.1\.0-prb/);

    // Runtime switches: all 11 flags present
    const switchNodes = mounted.findAll((n) => Boolean(n.props?.["data-runtime-key"]));
    assert.equal(switchNodes.length, 11);

    // Concurrency pools: 4 pools (fast, slow, owner, ytdlp)
    const poolNodes = mounted.findAll((n) => Boolean(n.props?.["data-pool-id"]));
    assert.deepEqual(
      poolNodes.map((n) => n.props["data-pool-id"]),
      ["fast", "slow", "owner", "ytdlp"],
    );

    // Native SVG daily chart: default 7d -> toggle to 30d -> back to 7d
    assert.equal(mounted.findByTestId("daily-bar-group").length, 7);
    assert.equal(mounted.findByTestId("hourly-bar-group").length, 24);
    await mounted.fire(mounted.findByTestId("daily-range-30d")[0], "onClick");
    assert.equal(mounted.findByTestId("daily-bar-group").length, 30);
    await mounted.fire(mounted.findByTestId("daily-range-7d")[0], "onClick");
    assert.equal(mounted.findByTestId("daily-bar-group").length, 7);

    // Platform health 5 time windows
    const getPlatforms = () =>
      mounted
        .findByTestId("platform-health-row")
        .map((n) => n.props["data-platform"]);

    assert.deepEqual(getPlatforms(), ["douyin", "bilibili", "vimeo", "ytdlp_other"]);
    assert.match(
      mounted.textOf(mounted.findByTestId("section-platform-health")[0]),
      /UPSTREAM_BLOCKED ×3/,
    );

    await mounted.fire(mounted.findByTestId("health-range-yesterday")[0], "onClick");
    assert.deepEqual(getPlatforms(), ["xiaohongshu", "youtube"]);

    await mounted.fire(mounted.findByTestId("health-range-7d")[0], "onClick");
    assert.ok(getPlatforms().includes("weibo"));
    assert.equal(getPlatforms().includes("tumblr"), false);

    await mounted.fire(mounted.findByTestId("health-range-30d")[0], "onClick");
    assert.ok(getPlatforms().includes("tumblr"));

    await mounted.fire(mounted.findByTestId("health-range-since_start")[0], "onClick");
    assert.ok(getPlatforms().includes("unknown"));

    // Multi-key redacted table
    const keyRows = mounted.findByTestId("api-key-row");
    assert.deepEqual(
      keyRows.map((n) => n.props["data-key-id"]),
      ["owner-main", "friend-alice"],
    );

    // Theme cycle toggle
    const themeBtn = mounted.findByTestId("monitor-theme-toggle")[0];
    await mounted.fire(themeBtn, "onClick");
    assert.equal(mockDocument.documentElement.dataset.theme, "light");
    await mounted.fire(themeBtn, "onClick");
    assert.equal(mockDocument.documentElement.dataset.theme, "dark");

    // Auto-refresh toggle + visibilitychange pause & resume
    const autoBtn = mounted.findByTestId("monitor-auto-refresh-toggle")[0];
    await mounted.fire(autoBtn, "onClick");
    assert.match(mounted.textOf(autoBtn), /30s 自动刷新：开/);

    const countBeforeHide = statsFetchCount;
    mockDocument.emitVisibility("hidden");
    await mounted.flush();
    assert.match(mounted.textOf(autoBtn), /30s 自动刷新：已暂停/);
    assert.equal(statsFetchCount, countBeforeHide);

    mockDocument.emitVisibility("visible");
    await new Promise((r) => setTimeout(r, 30));
    await mounted.flush();
    assert.match(mounted.textOf(autoBtn), /30s 自动刷新：开/);
    assert.equal(
      statsFetchCount,
      countBeforeHide + 1,
      "returning to visible tab must trigger immediate stats refresh",
    );

    // 401 unauthorized state renders guidance card and clears stats without token leak
    force401 = true;
    await mounted.fire(mounted.findByTestId("monitor-refresh-btn")[0], "onClick");
    await new Promise((r) => setTimeout(r, 30));
    await mounted.flush();
    assert.equal(mounted.findByTestId("monitor-auth-guard").length, 1);
    assert.equal(mounted.findByTestId("section-kpi-cards").length, 0);
    const guardText = mounted.textOf(mounted.findByTestId("monitor-auth-guard")[0]);
    assert.match(guardText, /401|权限不足/);
    assert.equal(guardText.includes("super-secret-owner-tok"), false);

    // Clearing token transitions cleanly to missing-token guidance
    await store.updateSettings({ bearerToken: "" });
    force401 = false;
    await mounted.fire(mounted.findByTestId("monitor-refresh-btn")[0], "onClick");
    await new Promise((r) => setTimeout(r, 30));
    await mounted.flush();
    assert.equal(mounted.findByTestId("monitor-auth-guard").length, 1);
    assert.match(
      mounted.textOf(mounted.findByTestId("monitor-auth-guard")[0]),
      /未配置凭据/,
    );
  } finally {
    mounted?.unmount();
    bg.dispose();
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});
