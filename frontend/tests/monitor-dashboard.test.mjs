import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import * as vue from "vue";
import { loadSfc } from "./helpers/loadSfc.mjs";

const { createRenderer, h, markRaw, nextTick, ref } = vue;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(__dirname, "..");

const VALID_OWNER_TOKEN = "owner_token_1234567890_abcdefghijklmnopqrstuvwxyz";
const VALID_FRIEND_TOKEN = "friend_token_1234567890_abcdefghijklmnopqrstuvwxyz";
const STALE_LOCAL_TOKEN = "stale_local_token_1234567890_abcdefghijklmnopqrst";

let tmpBundleDir = "";
let statsTypes;
let monitorStorage;
let MonitorApp;

async function bundleMonitorModules() {
  tmpBundleDir = mkdtempSync(join(tmpdir(), "dokitool-web-monitor-test-"));
  const outfile = join(tmpBundleDir, "suite.mjs");
  await build({
    stdin: {
      contents: `
        export * as statsTypes from "./src/monitor/statsTypes.ts";
        export * as monitorStorage from "./src/monitor/monitorStorage.ts";
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

const PassthroughTransition = {
  inheritAttrs: false,
  setup: (_props, { slots }) => () => slots.default?.(),
};

async function loadMonitorSfc(relPathFromTests) {
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

function createMemoryWebStorage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    key(index) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key) {
      data.delete(key);
    },
    setItem(key, value) {
      data.set(String(key), String(value));
    },
    _dump() {
      return Object.fromEntries(data.entries());
    },
  };
}

function createMockDocument() {
  const docListeners = new Map();
  const attrs = new Map();
  let visibilityState = "visible";
  const dataset = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "string") {
          return attrs.get(`data-${prop}`);
        }
        return undefined;
      },
      set(_target, prop, value) {
        if (typeof prop === "string") {
          attrs.set(`data-${prop}`, String(value));
        }
        return true;
      },
      deleteProperty(_target, prop) {
        if (typeof prop === "string") {
          attrs.delete(`data-${prop}`);
        }
        return true;
      },
    },
  );

  return {
    documentElement: {
      dataset,
      setAttribute(name, value) {
        attrs.set(name, String(value));
      },
      getAttribute(name) {
        return attrs.has(name) ? attrs.get(name) : null;
      },
      removeAttribute(name) {
        attrs.delete(name);
      },
    },
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(evt, fn) {
      if (!docListeners.has(evt)) docListeners.set(evt, new Set());
      docListeners.get(evt).add(fn);
    },
    removeEventListener(evt, fn) {
      docListeners.get(evt)?.delete(fn);
    },
    emitVisibility(nextState) {
      visibilityState = nextState;
      for (const fn of [...(docListeners.get("visibilitychange") ?? [])]) {
        fn({ type: "visibilitychange" });
      }
    },
  };
}

function createMockWindow(initial = {}) {
  const replaceCalls = [];
  const location = {
    origin: initial.origin ?? "https://snap.dokitool.com",
    pathname: initial.pathname ?? "/monitor",
    search: initial.search ?? "",
    hash: initial.hash ?? "",
  };
  return {
    location,
    history: {
      replaceState(state, unused, url) {
        replaceCalls.push({ state, unused, url });
        if (typeof url === "string") {
          const hashIdx = url.indexOf("#");
          const beforeHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
          const qIdx = beforeHash.indexOf("?");
          location.pathname = qIdx >= 0 ? beforeHash.slice(0, qIdx) : beforeHash;
          location.search = qIdx >= 0 ? beforeHash.slice(qIdx) : "";
          location.hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
        }
      },
    },
    _replaceCalls: replaceCalls,
  };
}

function mountSfcTree(Component, initialProps = {}, listeners = {}) {
  const element = (type, text = "") => {
    const domListeners = new Map();
    return markRaw({
      type,
      text,
      value: "",
      checked: false,
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
      if (key === "checked") node.checked = Boolean(value);
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
  const setInputValue = async (node, value) => {
    assert.ok(node, "Expected input node");
    node.value = value;
    if (node.props["onUpdate:modelValue"]) {
      for (const fn of [node.props["onUpdate:modelValue"]].flat()) {
        await fn(value);
      }
    } else if (node.props.onInput) {
      for (const fn of [node.props.onInput].flat()) {
        await fn({ target: { value } });
      }
    }
    await flush();
  };
  const setCheckboxValue = async (node, checked) => {
    assert.ok(node, "Expected checkbox node");
    node.checked = Boolean(checked);
    if (node.props["onUpdate:modelValue"]) {
      for (const fn of [node.props["onUpdate:modelValue"]].flat()) {
        await fn(Boolean(checked));
      }
    } else if (node.props.onChange) {
      for (const fn of [node.props.onChange].flat()) {
        await fn({ target: { checked: Boolean(checked) } });
      }
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
    setInputValue,
    setCheckboxValue,
    unmount() {
      app.unmount();
    },
  };
}

// ============================================================================
// Shared Rich Stats Fixture (with generic_slow & ytdlp_generic + excluded codes)
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
    const baseMs = Date.UTC(2026, 10, 22, 0, 0, 0);
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
      // Today: total=120, ok=108, failed=12
      // Full success rate = 108/120 = 90.0%
      // Excluded codes: bilibili RATE_LIMITED(4) + unknown INVALID_INPUT(3) + ytdlp_other UNSUPPORTED_PLATFORM(1) = 8
      // Effective total = 120 - 8 = 112 -> Effective success rate = 108/112 = 96.4285...% (96.4%)
      daily.push({
        date,
        total: 120,
        ok: 108,
        failed: 12,
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
            ok: 34,
            failed: 6,
            by_code: { OK: 34, UPSTREAM_BLOCKED: 2, RATE_LIMITED: 4 },
            p95_ms: 910,
          },
          vimeo: {
            total: 17,
            ok: 17,
            failed: 0,
            by_code: { OK: 17 },
            p95_ms: 650,
          },
          ytdlp_other: {
            total: 10,
            ok: 8,
            failed: 2,
            by_code: { OK: 8, NO_MEDIA: 1, UNSUPPORTED_PLATFORM: 1 },
            p95_ms: 1200,
          },
          unknown: {
            total: 3,
            ok: 0,
            failed: 3,
            by_code: { INVALID_INPUT: 3 },
            p95_ms: 12,
          },
        },
      });
    } else if (i === 1) {
      daily.push({
        date,
        total: 100,
        ok: 88,
        failed: 12,
        cache_hits: 22,
        shanghai_hits: 15,
        latency_ms: { p50_ms: 180, p95_ms: 980, max_ms: 3500 },
        by_platform: {
          xiaohongshu: {
            total: 60,
            ok: 50,
            failed: 10,
            by_code: { OK: 50, UPSTREAM_BLOCKED: 6, UPSTREAM_TIMEOUT: 4 },
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
        { platform: "bilibili", code: "UPSTREAM_BLOCKED", channel: "anonymous", count: 5 },
        { platform: "bilibili", code: "UNAUTHORIZED", channel: "anonymous", count: 5 },
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
      generic_slow: {
        active: 1,
        queued: 2,
        concurrency_limit: 2,
        queue_limit: 8,
        waited: 5,
        granted: 18,
        timeout: 0,
        full: 1,
        canceled: 0,
        wait_ms_total: 900,
        wait_ms_max: 340,
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
    ytdlp_generic: {
      enabled: true,
      concurrency_limit: 2,
      active: 1,
      waiting: 1,
      total: {
        acquired_count: 19,
        wait_count: 3,
        canceled_count: 0,
        wait_ms_total: 750,
        wait_ms_max: 310,
        wait_ms: emptyHist,
      },
      by_channel: {
        anonymous: {
          acquired_count: 9,
          wait_count: 2,
          canceled_count: 0,
          wait_ms_total: 500,
          wait_ms_max: 310,
          wait_ms: emptyHist,
        },
        owner: {
          acquired_count: 10,
          wait_count: 1,
          canceled_count: 0,
          wait_ms_total: 250,
          wait_ms_max: 180,
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
      version: "v4.1.0-prc",
      shanghai_mode: "pull",
      shanghai_bilibili: true,
      bilibili_dash: true,
      youtube_helper: true,
      xhs_transport: "chrome131",
      ytdlp_enabled: true,
      ytdlp_generic_enabled: true,
      tbvideo_pipigx: true,
      tbvideo_zuiyou: true,
      stats_persistence_enabled: true,
    },
    daily,
    hourly,
    ...overrides,
  };
}

let savedGlobals = {};

before(async () => {
  const suite = await bundleMonitorModules();
  statsTypes = suite.statsTypes;
  monitorStorage = suite.monitorStorage;
  MonitorApp = await loadMonitorSfc("../src/monitor/MonitorApp.vue");
});

beforeEach(() => {
  savedGlobals = {
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  globalThis.localStorage = createMemoryWebStorage();
  globalThis.sessionStorage = createMemoryWebStorage();
  globalThis.document = createMockDocument();
  globalThis.window = createMockWindow();
});

after(() => {
  stop();
  if (tmpBundleDir) {
    rmSync(tmpBundleDir, { recursive: true, force: true });
  }
  for (const [k, v] of Object.entries(savedGlobals)) {
    if (v === undefined) delete globalThis[k];
    else globalThis[k] = v;
  }
});

// ============================================================================
// 1. statsTypes.ts Unit Tests (Backward Compatibility + Dual Success Rate)
// ============================================================================

test("statsTypes: validation guard supports both new (generic_slow/ytdlp_generic) and legacy snapshots, computes dual success rates & 5-window health", () => {
  const rich = createRichStatsSnapshot();
  assert.equal(statsTypes.isValidStatsSnapshot(rich), true);

  // Backward compatibility: older snapshot WITHOUT generic_slow / ytdlp_generic
  const legacy = createRichStatsSnapshot();
  delete legacy.admission.generic_slow;
  delete legacy.ytdlp_generic;
  assert.equal(statsTypes.isValidStatsSnapshot(legacy), true);

  // Reject malformed optional pools when present
  const badGenericSlow = createRichStatsSnapshot();
  badGenericSlow.admission.generic_slow = { active: "bad" };
  assert.equal(statsTypes.isValidStatsSnapshot(badGenericSlow), false);

  const badYtdlpGeneric = createRichStatsSnapshot();
  badYtdlpGeneric.ytdlp_generic = { active: NaN, concurrency_limit: 2 };
  assert.equal(statsTypes.isValidStatsSnapshot(badYtdlpGeneric), false);

  assert.equal(statsTypes.isValidStatsSnapshot(null), false);
  assert.equal(statsTypes.isValidStatsSnapshot({ ...rich, runtime: undefined }), false);
  assert.equal(statsTypes.isValidStatsSnapshot({ ...rich, daily: "bad" }), false);
  assert.equal(statsTypes.isValidStatsSnapshot({ ...rich, hourly: [{ bad: true }] }), false);

  // Excluded non-upstream codes contract
  assert.deepEqual(
    [...statsTypes.EXCLUDED_NON_UPSTREAM_CODES].sort(),
    ["INVALID_INPUT", "RATE_LIMITED", "UNAUTHORIZED", "UNSUPPORTED_PLATFORM"],
  );

  // computeEffectiveSuccessRate unit tests (Record & Map)
  const eff1 = statsTypes.computeEffectiveSuccessRate(90, 100, {
    OK: 90,
    RATE_LIMITED: 4,
    INVALID_INPUT: 2,
    UNSUPPORTED_PLATFORM: 1,
    UNAUTHORIZED: 1,
    UPSTREAM_BLOCKED: 2,
  });
  assert.equal(eff1.excludedCount, 8);
  assert.equal(eff1.effectiveTotal, 92);
  assert.equal(Number(eff1.effectiveSuccessRate.toFixed(2)), 97.83);

  const effMap = statsTypes.computeEffectiveSuccessRate(
    0,
    5,
    new Map([["INVALID_INPUT", 5]]),
  );
  assert.equal(effMap.excludedCount, 5);
  assert.equal(effMap.effectiveTotal, 0);
  assert.equal(effMap.effectiveSuccessRate, null);

  // Today vs Yesterday dual success rate
  const tv = statsTypes.computeTodayVsYesterday(rich);
  assert.equal(tv.date, "2026-11-22");
  assert.equal(tv.yesterdayDate, "2026-11-21");
  assert.equal(tv.total, 120);
  assert.equal(tv.ok, 108);
  assert.equal(tv.failed, 12);
  assert.equal(tv.successRate, 90);
  assert.equal(tv.excludedCount, 8); // 4 + 3 + 1
  assert.equal(tv.effectiveTotal, 112); // 120 - 8
  assert.equal(Number(tv.effectiveSuccessRate.toFixed(1)), 96.4);
  assert.equal(tv.deltaTotal, 20);
  assert.equal(tv.deltaRatePct, 2); // 90.0 - 88.0

  // 5-window platform health aggregation + per-platform effective rate
  const todayRows = statsTypes.aggregatePlatformHealth(rich, "today");
  assert.deepEqual(
    todayRows.map((r) => r.platform),
    ["douyin", "bilibili", "vimeo", "ytdlp_other", "unknown"],
  );
  const biliRow = todayRows.find((r) => r.platform === "bilibili");
  assert.ok(biliRow);
  assert.equal(biliRow.label, "B站");
  assert.equal(biliRow.successRate, 85); // 34 / 40
  assert.equal(biliRow.excludedCount, 4); // RATE_LIMITED: 4
  assert.equal(biliRow.effectiveTotal, 36); // 40 - 4
  assert.equal(Number(biliRow.effectiveSuccessRate.toFixed(1)), 94.4); // 34 / 36

  const unknownToday = todayRows.find((r) => r.platform === "unknown");
  assert.ok(unknownToday);
  assert.equal(unknownToday.label, "未识别 / 无效输入");
  assert.equal(unknownToday.excludedCount, 3);
  assert.equal(unknownToday.effectiveTotal, 0);
  assert.equal(unknownToday.effectiveSuccessRate, null);

  // 14 core platform labels (self-contained, zero extension import)
  assert.equal(statsTypes.formatStatsPlatformLabel("douyin"), "抖音");
  assert.equal(statsTypes.formatStatsPlatformLabel("bilibili"), "B站");
  assert.equal(statsTypes.formatStatsPlatformLabel("weibo"), "微博");
  assert.equal(statsTypes.formatStatsPlatformLabel("toutiao"), "今日头条");
  assert.equal(statsTypes.formatStatsPlatformLabel("kuaishou"), "快手");
  assert.equal(statsTypes.formatStatsPlatformLabel("pipixia"), "皮皮虾");
  assert.equal(statsTypes.formatStatsPlatformLabel("pipigx"), "皮皮搞笑");
  assert.equal(statsTypes.formatStatsPlatformLabel("zuiyou"), "最右");
  assert.equal(statsTypes.formatStatsPlatformLabel("xiaohongshu"), "小红书");
  assert.equal(statsTypes.formatStatsPlatformLabel("x"), "X / Twitter");
  assert.equal(statsTypes.formatStatsPlatformLabel("youtube"), "YouTube");
  assert.equal(statsTypes.formatStatsPlatformLabel("instagram"), "Instagram");
  assert.equal(statsTypes.formatStatsPlatformLabel("facebook"), "Facebook");
  assert.equal(statsTypes.formatStatsPlatformLabel("tumblr"), "Tumblr");
  assert.equal(statsTypes.formatStatsPlatformLabel("ytdlp_other"), "其他站点 (yt-dlp)");
  assert.equal(statsTypes.formatStatsPlatformLabel("vimeo"), "vimeo");

  // since_start window effective rate excludes UNAUTHORIZED & INVALID_INPUT
  const sinceStartRows = statsTypes.aggregatePlatformHealth(rich, "since_start");
  const biliSinceStart = sinceStartRows.find((r) => r.platform === "bilibili");
  assert.ok(biliSinceStart);
  assert.equal(biliSinceStart.total, 90);
  assert.equal(biliSinceStart.excludedCount, 5); // UNAUTHORIZED: 5
  assert.equal(biliSinceStart.effectiveTotal, 85);
  assert.equal(Number(biliSinceStart.effectiveSuccessRate.toFixed(1)), 94.1);

  // Formatters & SVG charts
  assert.equal(statsTypes.formatUptimeDuration(0), "0秒");
  assert.equal(statsTypes.formatUptimeDuration(199_800), "2天 7小时 30分");
  assert.equal(statsTypes.formatPercent(0, 0), "—");
  assert.equal(statsTypes.formatPercent(108, 120), "90.0%");
  assert.equal(statsTypes.formatBytesCompact(2_621_440), "2.5 MB");
  assert.equal(statsTypes.formatShanghaiHourLabel("2026-11-22T00:00:00Z"), "08:00");
  assert.equal(statsTypes.resolveYtdlpQueuedCount(rich.ytdlp_generic), 1);

  const chart7 = statsTypes.buildDailyChartPoints(rich.daily, 7);
  assert.equal(chart7.points.length, 7);
  assert.ok(chart7.ratePathD.includes("M"));
  const chart30 = statsTypes.buildDailyChartPoints(rich.daily, 30);
  assert.equal(chart30.points.length, 30);
  const hourlyGeom = statsTypes.buildHourlyChartPoints(rich.hourly);
  assert.equal(hourlyGeom.points.length, 24);
});

// ============================================================================
// 2. monitorStorage.ts Unit Tests (Dual-Tier Storage, Validation, Fetch)
// ============================================================================

test("monitorStorage: dual-tier storage semantics, theme sync, URL strip, token validation, and cookie-free same-origin fetch", async () => {
  // Theme cycle & DOM attribute sync
  assert.equal(monitorStorage.readMonitorTheme(), "system");
  assert.equal(monitorStorage.getNextMonitorTheme("system"), "light");
  assert.equal(monitorStorage.getNextMonitorTheme("light"), "dark");
  assert.equal(monitorStorage.getNextMonitorTheme("dark"), "system");

  monitorStorage.writeMonitorTheme("dark");
  assert.equal(monitorStorage.readMonitorTheme(), "dark");
  monitorStorage.applyMonitorTheme("dark");
  assert.equal(globalThis.document.documentElement.getAttribute("data-theme"), "dark");
  monitorStorage.applyMonitorTheme("system");
  assert.equal(globalThis.document.documentElement.getAttribute("data-theme"), null);

  // Dual-tier token storage: session default clears stale localStorage
  globalThis.localStorage.setItem(monitorStorage.OWNER_TOKEN_LOCAL_KEY, STALE_LOCAL_TOKEN);
  assert.deepEqual(monitorStorage.readStoredOwnerToken(), {
    token: STALE_LOCAL_TOKEN,
    source: "local",
  });

  const savedSession = monitorStorage.saveOwnerToken(VALID_OWNER_TOKEN, false);
  assert.equal(savedSession, "session");
  assert.equal(
    globalThis.sessionStorage.getItem(monitorStorage.OWNER_TOKEN_SESSION_KEY),
    VALID_OWNER_TOKEN,
  );
  assert.equal(
    globalThis.localStorage.getItem(monitorStorage.OWNER_TOKEN_LOCAL_KEY),
    null,
    "remember=false must actively wipe stale localStorage credential",
  );
  assert.deepEqual(monitorStorage.readStoredOwnerToken(), {
    token: VALID_OWNER_TOKEN,
    source: "session",
  });

  // Opt-in remember=true writes localStorage & wipes sessionStorage
  const savedLocal = monitorStorage.saveOwnerToken(VALID_OWNER_TOKEN, true);
  assert.equal(savedLocal, "local");
  assert.equal(
    globalThis.localStorage.getItem(monitorStorage.OWNER_TOKEN_LOCAL_KEY),
    VALID_OWNER_TOKEN,
  );
  assert.equal(
    globalThis.sessionStorage.getItem(monitorStorage.OWNER_TOKEN_SESSION_KEY),
    null,
    "remember=true must wipe sessionStorage so source unambiguously reports local",
  );
  assert.deepEqual(monitorStorage.readStoredOwnerToken(), {
    token: VALID_OWNER_TOKEN,
    source: "local",
  });

  // Priority: if both somehow exist, session wins over local
  globalThis.sessionStorage.setItem(
    monitorStorage.OWNER_TOKEN_SESSION_KEY,
    VALID_FRIEND_TOKEN,
  );
  assert.deepEqual(monitorStorage.readStoredOwnerToken(), {
    token: VALID_FRIEND_TOKEN,
    source: "session",
  });

  // Clear wipes BOTH
  monitorStorage.clearStoredOwnerToken();
  assert.equal(
    globalThis.sessionStorage.getItem(monitorStorage.OWNER_TOKEN_SESSION_KEY),
    null,
  );
  assert.equal(
    globalThis.localStorage.getItem(monitorStorage.OWNER_TOKEN_LOCAL_KEY),
    null,
  );
  assert.deepEqual(monitorStorage.readStoredOwnerToken(), {
    token: "",
    source: null,
  });

  // URL strip query & hash
  globalThis.window = createMockWindow({
    pathname: "/monitor",
    search: "?token=leak",
    hash: "#secret",
  });
  assert.equal(monitorStorage.stripUrlQueryAndHash(), true);
  assert.equal(globalThis.window.location.pathname, "/monitor");
  assert.equal(globalThis.window.location.search, "");
  assert.equal(globalThis.window.location.hash, "");
  assert.equal(monitorStorage.stripUrlQueryAndHash(), false);

  // Token validation (32..512 printable ASCII 33..126, trims leading/trailing whitespace)
  assert.equal(monitorStorage.validateOwnerBearerToken("").ok, false);
  assert.equal(monitorStorage.validateOwnerBearerToken("a".repeat(31)).ok, false);
  assert.equal(monitorStorage.validateOwnerBearerToken("a".repeat(513)).ok, false);
  assert.equal(
    monitorStorage.validateOwnerBearerToken("a".repeat(16) + " " + "b".repeat(16)).ok,
    false,
  );
  assert.equal(
    monitorStorage.validateOwnerBearerToken("a".repeat(31) + "\n").ok,
    false,
  );
  assert.equal(
    monitorStorage.validateOwnerBearerToken("a".repeat(32) + "中").ok,
    false,
  );
  const validTrimmed = monitorStorage.validateOwnerBearerToken(
    `  ${"A".repeat(32)}  `,
  );
  assert.equal(validTrimmed.ok, true);
  assert.equal(validTrimmed.token, "A".repeat(32));
  assert.equal(monitorStorage.validateOwnerBearerToken("z".repeat(512)).ok, true);

  // Same-origin fetch contract (200 / 401 / 500 / malformed)
  const sampleStats = createRichStatsSnapshot();
  const fetchCalls = [];
  const mockFetch = async (url, init) => {
    fetchCalls.push({ url, init });
    const auth = init?.headers?.Authorization || "";
    if (auth === `Bearer ${VALID_OWNER_TOKEN}`) {
      return new Response(
        JSON.stringify({ schema_version: "1.0", code: "OK", data: sampleStats }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (auth === `Bearer ${VALID_FRIEND_TOKEN}`) {
      return new Response(
        JSON.stringify({ schema_version: "1.0", code: "UNAUTHORIZED" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }
    if (auth === "Bearer malformed_token_1234567890_abcdefghijklmnop") {
      return new Response(
        JSON.stringify({ schema_version: "1.0", code: "OK", data: { invalid: 1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("server error", { status: 500 });
  };

  const okRes = await monitorStorage.fetchSameOriginOwnerStats(
    VALID_OWNER_TOKEN,
    mockFetch,
  );
  assert.equal(okRes.ok, true);
  assert.equal(okRes.stats.runtime.version, "v4.1.0-prc");
  assert.equal(fetchCalls[0].url, "/api/stats?schema_version=1.0");
  assert.equal(fetchCalls[0].init.method, "GET");
  assert.equal(fetchCalls[0].init.credentials, "omit");
  assert.equal(fetchCalls[0].init.cache, "no-store");
  assert.equal(fetchCalls[0].init.referrerPolicy, "no-referrer");
  assert.equal(fetchCalls[0].init.headers.Authorization, `Bearer ${VALID_OWNER_TOKEN}`);
  assert.equal(fetchCalls[0].init.headers.Accept, "application/json");

  const unauthRes = await monitorStorage.fetchSameOriginOwnerStats(
    VALID_FRIEND_TOKEN,
    mockFetch,
  );
  assert.equal(unauthRes.ok, false);
  assert.equal(unauthRes.kind, "unauthorized");
  assert.equal(unauthRes.status, 401);
  assert.equal(
    unauthRes.message,
    "HTTP 401：当前凭据无效或非 owner 角色（/api/stats 仅对 owner 开放）",
  );

  const badShapeRes = await monitorStorage.fetchSameOriginOwnerStats(
    "malformed_token_1234567890_abcdefghijklmnop",
    mockFetch,
  );
  assert.equal(badShapeRes.ok, false);
  assert.equal(badShapeRes.kind, "error");

  const err500Res = await monitorStorage.fetchSameOriginOwnerStats(
    "server_error_token_1234567890_abcdefghijklmno",
    mockFetch,
  );
  assert.equal(err500Res.ok, false);
  assert.equal(err500Res.kind, "error");
  assert.equal(err500Res.status, 500);
});

// ============================================================================
// 3. Static CSP, Security & Isolation Audit
// ============================================================================

test("static CSP & isolation audit: zero inline script/style/v-show/v-html and zero ../extension imports", () => {
  const monitorHtml = readFileSync(resolve(FRONTEND_DIR, "monitor.html"), "utf8");
  const monitorVue = readFileSync(
    resolve(FRONTEND_DIR, "src/monitor/MonitorApp.vue"),
    "utf8",
  );
  const monitorCss = readFileSync(
    resolve(FRONTEND_DIR, "src/monitor/monitor.css"),
    "utf8",
  );
  const statsTs = readFileSync(
    resolve(FRONTEND_DIR, "src/monitor/statsTypes.ts"),
    "utf8",
  );
  const storageTs = readFileSync(
    resolve(FRONTEND_DIR, "src/monitor/monitorStorage.ts"),
    "utf8",
  );
  const mainTs = readFileSync(
    resolve(FRONTEND_DIR, "src/monitor/main.ts"),
    "utf8",
  );

  // monitor.html meta hardening
  assert.match(
    monitorHtml,
    /<meta\s+name="robots"\s+content="noindex,\s*nofollow,\s*noarchive"\s*\/>/i,
  );
  assert.match(
    monitorHtml,
    /<meta\s+name="referrer"\s+content="no-referrer"\s*\/>/i,
  );
  assert.match(monitorHtml, /http-equiv="Content-Security-Policy"/i);
  assert.match(monitorHtml, /default-src 'none'/);
  assert.match(monitorHtml, /script-src 'self'/);
  assert.match(monitorHtml, /style-src 'self'/);
  assert.match(monitorHtml, /connect-src 'self'/);
  assert.match(monitorHtml, /base-uri 'none'/);
  assert.match(monitorHtml, /form-action 'none'/);
  assert.equal(
    monitorHtml.includes("frame-ancestors"),
    false,
    "<meta> CSP must NOT include frame-ancestors (triggers Chrome console warning)",
  );
  assert.equal(monitorHtml.includes("unsafe-inline"), false);
  assert.equal(/\bstyle\s*=/i.test(monitorHtml), false);

  // Every <script> in monitor.html must reference external src=
  const scriptTags = monitorHtml.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  assert.equal(scriptTags.length, 1);
  assert.match(scriptTags[0], /\bsrc="\/src\/monitor\/main\.ts"/);
  assert.match(scriptTags[0], />\s*<\/script>/);

  // MonitorApp.vue: ZERO inline style, :style, v-show, v-html, innerHTML, extension settings copy
  assert.equal(/\bstyle\s*=/i.test(monitorVue), false, "zero inline style=");
  assert.equal(/:style\s*=/i.test(monitorVue), false, "zero dynamic :style=");
  assert.equal(/v-bind:style/i.test(monitorVue), false, "zero v-bind:style");
  assert.equal(/\bv-show\b/i.test(monitorVue), false, "zero v-show (violates strict CSP style-src 'self')");
  assert.equal(/\bv-html\b/i.test(monitorVue), false, "zero v-html");
  assert.equal(/\binnerHTML\b/.test(monitorVue), false, "zero innerHTML");
  assert.equal(monitorVue.includes("扩展侧边栏"), false);
  assert.equal(monitorVue.includes("点击右上角「设置」"), false);
  assert.equal(monitorVue.includes("chrome-extension://"), false);

  // ZERO imports from ../extension/* anywhere in src/monitor/
  for (const [name, content] of [
    ["MonitorApp.vue", monitorVue],
    ["monitor.css", monitorCss],
    ["statsTypes.ts", statsTs],
    ["monitorStorage.ts", storageTs],
    ["main.ts", mainTs],
  ]) {
    assert.equal(
      content.includes("../extension"),
      false,
      `${name} must not import anything from ../extension/*`,
    );
  }
});

// ============================================================================
// 4. Mounted MonitorApp.vue Full Flow (Locked, 401, 200 Dual Rate, 6 Pools, Lock)
// ============================================================================

test("MonitorApp.vue: locked state machine, 401 exact banner, 200 session unlock, dual rate, 6 pools, sorting, visibility pause, and lock wipe", async () => {
  const sampleStats = createRichStatsSnapshot();
  const fetchCalls = [];
  let forceRefresh401 = false;

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    const auth = init?.headers?.Authorization || "";
    if (!forceRefresh401 && auth === `Bearer ${VALID_OWNER_TOKEN}`) {
      return new Response(
        JSON.stringify({ schema_version: "1.0", code: "OK", data: sampleStats }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ schema_version: "1.0", code: "UNAUTHORIZED" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  };

  // Pre-seed stale localStorage token? No — first verify completely cold locked state!
  const mounted = mountSfcTree(MonitorApp);
  try {
    await mounted.flush();

    // A. Locked state: 0 fetches, neutral badge, NO owner badge, NO refresh/auto-refresh/lock buttons, 0 stats
    assert.equal(fetchCalls.length, 0);
    assert.equal(mounted.findByTestId("monitor-unlock-form").length, 1);
    assert.equal(mounted.findByTestId("monitor-locked-badge").length, 1);
    assert.match(
      mounted.textOf(mounted.findByTestId("monitor-locked-badge")[0]),
      /未解锁 · 需 Owner 鉴权/,
    );
    assert.equal(mounted.findByTestId("monitor-owner-badge").length, 0);
    assert.equal(mounted.findByTestId("monitor-refresh-btn").length, 0);
    assert.equal(mounted.findByTestId("monitor-auto-refresh-toggle").length, 0);
    assert.equal(mounted.findByTestId("monitor-lock-btn").length, 0);
    assert.equal(mounted.findByTestId("monitor-theme-toggle").length, 1);
    assert.equal(mounted.findByTestId("section-kpi-cards").length, 0);
    assert.equal(mounted.findByTestId("section-runtime-pools").length, 0);
    assert.equal(mounted.findByTestId("section-charts").length, 0);
    assert.equal(mounted.findByTestId("section-platform-health").length, 0);
    assert.equal(mounted.findByTestId("section-api-keys").length, 0);

    // Input starts masked (password) & remember checkbox defaults to unchecked
    const tokenInput = mounted.findByTestId("monitor-token-input")[0];
    const visBtn = mounted.findByTestId("monitor-token-visibility-btn")[0];
    const rememberBox = mounted.findByTestId("monitor-remember-checkbox")[0];
    const form = mounted.findByTestId("monitor-unlock-form")[0];

    assert.equal(tokenInput.props.type, "password");
    assert.equal(Boolean(rememberBox.checked), false);
    await mounted.fire(visBtn, "onClick");
    assert.equal(mounted.findByTestId("monitor-token-input")[0].props.type, "text");
    await mounted.fire(visBtn, "onClick");
    assert.equal(mounted.findByTestId("monitor-token-input")[0].props.type, "password");

    // Client-side validation rejects short token with ZERO network fetch
    await mounted.setInputValue(tokenInput, "too-short");
    await mounted.fire(form, "onSubmit", { preventDefault() {} });
    assert.equal(fetchCalls.length, 0);
    assert.equal(mounted.findByTestId("monitor-auth-error").length, 1);

    // B. 401 unlock failure with valid-length friend token
    await mounted.setInputValue(tokenInput, VALID_FRIEND_TOKEN);
    await mounted.fire(form, "onSubmit", { preventDefault() {} });
    await new Promise((r) => setTimeout(r, 20));
    await mounted.flush();

    assert.equal(fetchCalls.length, 1);
    assert.equal(mounted.findByTestId("section-kpi-cards").length, 0);
    assert.equal(mounted.findByTestId("monitor-owner-badge").length, 0);
    const errEl = mounted.findByTestId("monitor-auth-error")[0];
    assert.ok(errEl);
    assert.equal(
      mounted.textOf(errEl).trim(),
      "HTTP 401：当前凭据无效或非 owner 角色（/api/stats 仅对 owner 开放）",
    );
    assert.equal(mounted.textOf().includes(VALID_FRIEND_TOKEN), false);
    assert.equal(
      globalThis.sessionStorage.getItem(monitorStorage.OWNER_TOKEN_SESSION_KEY),
      null,
    );
    assert.equal(
      globalThis.localStorage.getItem(monitorStorage.OWNER_TOKEN_LOCAL_KEY),
      null,
    );

    // C. 200 unlock with remember UNCHECKED -> sessionStorage only + wipes stale localStorage
    globalThis.localStorage.setItem(
      monitorStorage.OWNER_TOKEN_LOCAL_KEY,
      STALE_LOCAL_TOKEN,
    );
    await mounted.setInputValue(tokenInput, VALID_OWNER_TOKEN);
    await mounted.fire(form, "onSubmit", { preventDefault() {} });
    await new Promise((r) => setTimeout(r, 20));
    await mounted.flush();

    assert.equal(
      globalThis.sessionStorage.getItem(monitorStorage.OWNER_TOKEN_SESSION_KEY),
      VALID_OWNER_TOKEN,
    );
    assert.equal(
      globalThis.localStorage.getItem(monitorStorage.OWNER_TOKEN_LOCAL_KEY),
      null,
      "unlocking with remember=false must wipe stale localStorage key",
    );

    // Topbar transitioned cleanly to unlocked state
    assert.equal(mounted.findByTestId("monitor-locked-badge").length, 0);
    assert.equal(mounted.findByTestId("monitor-owner-badge").length, 1);
    assert.match(
      mounted.textOf(mounted.findByTestId("monitor-credential-source")[0]),
      /会话级凭据/,
    );
    assert.equal(mounted.findByTestId("monitor-refresh-btn").length, 1);
    assert.equal(mounted.findByTestId("monitor-auto-refresh-toggle").length, 1);
    assert.equal(mounted.findByTestId("monitor-lock-btn").length, 1);

    // Raw owner token NEVER appears in rendered DOM text
    assert.equal(mounted.textOf().includes(VALID_OWNER_TOKEN), false);

    // Zero inline style props on any rendered element
    const nodesWithInlineStyle = mounted.findAll(
      (n) => n.props && ("style" in n.props || Object.keys(n.style || {}).length > 0),
    );
    assert.equal(
      nodesWithInlineStyle.length,
      0,
      "strict CSP requires zero inline style mutations on rendered nodes",
    );

    // All 5 sections rendered
    assert.equal(mounted.findByTestId("section-kpi-cards").length, 1);
    assert.equal(mounted.findByTestId("section-runtime-pools").length, 1);
    assert.equal(mounted.findByTestId("section-charts").length, 1);
    assert.equal(mounted.findByTestId("section-platform-health").length, 1);
    assert.equal(mounted.findByTestId("section-api-keys").length, 1);

    // Dual success rate KPI check (Full 90.0% + Effective 96.4% excluding 8)
    const rateCardText = mounted.textOf(mounted.findByTestId("kpi-success-rate")[0]);
    assert.match(rateCardText, /全量口径/);
    assert.match(rateCardText, /90\.0%/);
    const effRateText = mounted.textOf(
      mounted.findByTestId("kpi-effective-success-rate")[0],
    );
    assert.match(effRateText, /有效解析成功率/);
    assert.match(effRateText, /96\.4%/);
    assert.match(effRateText, /8 次/);

    // All 6 concurrency pools rendered (including generic_slow & ytdlp_generic)
    const poolIds = mounted
      .findAll((n) => Boolean(n.props?.["data-pool-id"]))
      .map((n) => n.props["data-pool-id"]);
    assert.deepEqual(poolIds, [
      "fast",
      "slow",
      "generic_slow",
      "owner",
      "ytdlp",
      "ytdlp_generic",
    ]);

    // SVG charts 7d / 30d & 24h
    assert.equal(mounted.findByTestId("daily-bar-group").length, 7);
    assert.equal(mounted.findByTestId("hourly-bar-group").length, 24);
    await mounted.fire(mounted.findByTestId("daily-range-30d")[0], "onClick");
    assert.equal(mounted.findByTestId("daily-bar-group").length, 30);

    // Platform health effective rate column & sorting
    const biliRowNode = mounted
      .findByTestId("platform-health-row")
      .find((n) => n.props["data-platform"] === "bilibili");
    assert.ok(biliRowNode);
    assert.match(mounted.textOf(biliRowNode), /85\.0%/); // full rate
    assert.match(mounted.textOf(biliRowNode), /94\.4%/); // effective rate

    const sortEffBtn = mounted.findByTestId("sort-effective-success-rate")[0];
    await mounted.fire(sortEffBtn, "onClick");
    const sortedPlatformsDesc = mounted
      .findByTestId("platform-health-row")
      .map((n) => n.props["data-platform"]);
    assert.equal(sortedPlatformsDesc[0], "vimeo"); // 100.0%
    assert.equal(sortedPlatformsDesc[sortedPlatformsDesc.length - 1], "unknown"); // null

    // Visibility pause/resume on 30s auto-refresh
    const autoBtn = mounted.findByTestId("monitor-auto-refresh-toggle")[0];
    await mounted.fire(autoBtn, "onClick");
    assert.match(mounted.textOf(autoBtn), /30s 自动刷新：开/);

    const callsBeforeHide = fetchCalls.length;
    globalThis.document.emitVisibility("hidden");
    await mounted.flush();
    assert.match(mounted.textOf(autoBtn), /30s 自动刷新：已暂停/);
    assert.equal(fetchCalls.length, callsBeforeHide);

    globalThis.document.emitVisibility("visible");
    await new Promise((r) => setTimeout(r, 20));
    await mounted.flush();
    assert.equal(fetchCalls.length, callsBeforeHide + 1);

    // D. 401 during manual refresh while unlocked -> auto-locks & wipes storage
    forceRefresh401 = true;
    await mounted.fire(mounted.findByTestId("monitor-refresh-btn")[0], "onClick");
    await new Promise((r) => setTimeout(r, 20));
    await mounted.flush();

    assert.equal(mounted.findByTestId("monitor-unlock-form").length, 1);
    assert.equal(mounted.findByTestId("section-kpi-cards").length, 0);
    assert.equal(
      mounted.textOf(mounted.findByTestId("monitor-auth-error")[0]).trim(),
      "HTTP 401：当前凭据无效或非 owner 角色（/api/stats 仅对 owner 开放）",
    );
    assert.equal(
      globalThis.sessionStorage.getItem(monitorStorage.OWNER_TOKEN_SESSION_KEY),
      null,
    );
  } finally {
    mounted.unmount();
  }
});

test("MonitorApp.vue: remember-device unlock stores in localStorage, manual lock wipes both storages, and legacy snapshots without generic pools still render 6 pools safely", async () => {
  const legacyStats = createRichStatsSnapshot();
  delete legacyStats.admission.generic_slow;
  delete legacyStats.ytdlp_generic;

  globalThis.fetch = async (_url, init) => {
    if (init?.headers?.Authorization === `Bearer ${VALID_OWNER_TOKEN}`) {
      return new Response(
        JSON.stringify({ schema_version: "1.0", code: "OK", data: legacyStats }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 401 });
  };

  const mounted = mountSfcTree(MonitorApp);
  try {
    await mounted.flush();

    const tokenInput = mounted.findByTestId("monitor-token-input")[0];
    const rememberBox = mounted.findByTestId("monitor-remember-checkbox")[0];
    const form = mounted.findByTestId("monitor-unlock-form")[0];

    await mounted.setInputValue(tokenInput, VALID_OWNER_TOKEN);
    await mounted.setCheckboxValue(rememberBox, true);
    await mounted.fire(form, "onSubmit", { preventDefault() {} });
    await new Promise((r) => setTimeout(r, 20));
    await mounted.flush();

    assert.equal(
      globalThis.localStorage.getItem(monitorStorage.OWNER_TOKEN_LOCAL_KEY),
      VALID_OWNER_TOKEN,
    );
    assert.equal(
      globalThis.sessionStorage.getItem(monitorStorage.OWNER_TOKEN_SESSION_KEY),
      null,
    );
    assert.match(
      mounted.textOf(mounted.findByTestId("monitor-credential-source")[0]),
      /本机已记住/,
    );

    // Legacy snapshot without generic_slow / ytdlp_generic renders 6 pool rows cleanly with 0 fallback
    const poolNodes = mounted.findAll((n) => Boolean(n.props?.["data-pool-id"]));
    assert.equal(poolNodes.length, 6);
    const genericSlowNode = poolNodes.find(
      (n) => n.props["data-pool-id"] === "generic_slow",
    );
    assert.ok(genericSlowNode);
    assert.match(mounted.textOf(genericSlowNode), /活跃 0 \/ 0/);

    // Click "锁定 / 清除凭据" -> wipes both storages, clears stats, returns to unlock card
    await mounted.fire(mounted.findByTestId("monitor-lock-btn")[0], "onClick");

    assert.equal(
      globalThis.localStorage.getItem(monitorStorage.OWNER_TOKEN_LOCAL_KEY),
      null,
    );
    assert.equal(
      globalThis.sessionStorage.getItem(monitorStorage.OWNER_TOKEN_SESSION_KEY),
      null,
    );
    assert.equal(mounted.findByTestId("monitor-unlock-form").length, 1);
    assert.equal(mounted.findByTestId("monitor-locked-badge").length, 1);
    assert.equal(mounted.findByTestId("monitor-owner-badge").length, 0);
    assert.equal(mounted.findByTestId("monitor-refresh-btn").length, 0);
    assert.equal(mounted.findByTestId("section-kpi-cards").length, 0);
  } finally {
    mounted.unmount();
  }
});

test("MonitorApp.vue: auto-unlocks from pre-stored localStorage token and strips URL query/hash on mount", async () => {
  const sampleStats = createRichStatsSnapshot();
  globalThis.window = createMockWindow({
    pathname: "/monitor",
    search: "?token=should_be_stripped",
    hash: "#frag",
  });
  globalThis.localStorage.setItem(
    monitorStorage.OWNER_TOKEN_LOCAL_KEY,
    VALID_OWNER_TOKEN,
  );
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ schema_version: "1.0", code: "OK", data: sampleStats }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const mounted = mountSfcTree(MonitorApp);
  try {
    await new Promise((r) => setTimeout(r, 25));
    await mounted.flush();

    assert.equal(globalThis.window.location.search, "");
    assert.equal(globalThis.window.location.hash, "");
    assert.equal(mounted.findByTestId("section-kpi-cards").length, 1);
    assert.match(
      mounted.textOf(mounted.findByTestId("monitor-credential-source")[0]),
      /本机已记住/,
    );
  } finally {
    mounted.unmount();
  }
});
