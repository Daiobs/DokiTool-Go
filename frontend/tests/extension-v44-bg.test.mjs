import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import * as vue from "vue";
import { loadSfc } from "./helpers/loadSfc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(__dirname, "..");

let tmpBundleDir = "";
let protocol;
let storage;
let backgroundMod;
let offscreenMod;
let taskHistoryMod;
let tabSyncMod;
let youtubeBridgeMod;
let offscreenLifecycleMod;

async function bundleSuite() {
  tmpBundleDir = mkdtempSync(join(tmpdir(), "dokitool-ext-v44-bg-"));
  const outfile = join(tmpBundleDir, "v44-bg-suite.mjs");
  await build({
    stdin: {
      contents: `
        export * as protocol from "./src/extension/protocol.ts";
        export * as storage from "./src/extension/storage.ts";
        export * as backgroundMod from "./src/extension/background.ts";
        export * as offscreenMod from "./src/extension/offscreen.ts";
        export * as taskHistoryMod from "./src/extension/bg/taskHistoryStore.ts";
        export * as tabSyncMod from "./src/extension/bg/tabSyncPrivacyFirewall.ts";
        export * as youtubeBridgeMod from "./src/extension/youtubeExtensionBridge.ts";
        export * as offscreenLifecycleMod from "./src/extension/bg/offscreenLifecycle.ts";
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
  const suite = await bundleSuite();
  protocol = suite.protocol;
  storage = suite.storage;
  backgroundMod = suite.backgroundMod;
  offscreenMod = suite.offscreenMod;
  taskHistoryMod = suite.taskHistoryMod;
  tabSyncMod = suite.tabSyncMod;
  youtubeBridgeMod = suite.youtubeBridgeMod;
  offscreenLifecycleMod = suite.offscreenLifecycleMod;
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

function createDeferred() {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function createMockMv3Env({
  localArea,
  sessionArea,
  autoCompleteDownloads = true,
  offscreenHandler = null,
} = {}) {
  const local = localArea ?? storage.createMemoryStorageArea();
  const session = sessionArea ?? storage.createMemoryStorageArea();
  const messageListeners = new Set();
  const connectListeners = new Set();
  const contextMenuListeners = new Set();
  const downloadChangedListeners = new Set();
  const createdMenus = [];
  const sidePanelOpenCalls = [];
  const shownDownloads = [];
  const downloadCalls = [];
  const offscreenStartedSpecs = [];
  const offscreenCancelledTaskIds = [];
  let offscreenOpen = false;
  let offscreenCreateCount = 0;
  let offscreenCloseCount = 0;
  let nextDownloadId = 500;

  const chrome = {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      getManifest: () => ({
        version: "4.4.1",
        host_permissions: ["https://snap.dokitool.com/*"],
        optional_host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
      }),
      async getContexts({ contextTypes } = {}) {
        if (offscreenOpen && (!contextTypes || contextTypes.includes("OFFSCREEN_DOCUMENT"))) {
          return [{ contextType: "OFFSCREEN_DOCUMENT" }];
        }
        return [];
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
          connectListeners.add(fn);
        },
      },
      connect({ name } = {}) {
        const clientMsg = new Set();
        const clientDisc = new Set();
        const serverMsg = new Set();
        const serverDisc = new Set();
        const clientPort = {
          name: name || "",
          onMessage: {
            addListener: (fn) => clientMsg.add(fn),
            removeListener: (fn) => clientMsg.delete(fn),
          },
          onDisconnect: {
            addListener: (fn) => clientDisc.add(fn),
            removeListener: (fn) => clientDisc.delete(fn),
          },
          postMessage(msg) {
            for (const fn of [...serverMsg]) fn(msg);
          },
          disconnect() {
            for (const fn of [...serverDisc]) fn();
          },
        };
        const serverPort = {
          name: name || "",
          onMessage: {
            addListener: (fn) => serverMsg.add(fn),
            removeListener: (fn) => serverMsg.delete(fn),
          },
          onDisconnect: {
            addListener: (fn) => serverDisc.add(fn),
            removeListener: (fn) => serverDisc.delete(fn),
          },
          postMessage(msg) {
            for (const fn of [...clientMsg]) fn(msg);
          },
          disconnect() {
            for (const fn of [...clientDisc]) fn();
          },
        };
        for (const fn of [...connectListeners]) fn(serverPort);
        return clientPort;
      },
      sendMessage(message) {
        if (
          protocol.isBackgroundToOffscreenRequest(message) &&
          typeof offscreenHandler === "function"
        ) {
          return Promise.resolve(offscreenHandler(message));
        }
        if (message?.type === "OFFSCREEN_START_TASK") {
          offscreenStartedSpecs.push({ taskId: message.taskId, spec: message.spec });
          if (autoCompleteDownloads) {
            queueMicrotask(async () => {
              const handoff = await chrome.runtime.sendMessage({
                type: "HANDOFF_BLOB_DOWNLOAD",
                taskId: message.taskId,
                blobUrl: `blob:chrome-extension://test/${message.taskId}`,
                filename: message.spec.filename,
                sizeBytes: message.spec.sizeBytes || 1024,
              });
              const dlId = handoff?.data?.chromeDownloadId;
              if (typeof dlId === "number") {
                for (const fn of [...downloadChangedListeners]) {
                  fn({ id: dlId, state: { current: "complete" } });
                }
              }
            });
          }
          return Promise.resolve({ ok: true, data: { accepted: true } });
        }
        if (message?.type === "OFFSCREEN_CANCEL_TASK") {
          offscreenCancelledTaskIds.push(message.taskId);
          return Promise.resolve({ ok: true, data: { cancelled: true } });
        }
        if (message?.type === "RELEASE_BLOB") {
          return Promise.resolve({ ok: true, data: { released: true } });
        }
        if (message?.type === "OFFSCREEN_PING") {
          return Promise.resolve({
            ok: true,
            data: { ready: true, activeTaskCount: 0, pendingBlobCount: 0 },
          });
        }
        return new Promise((resolvePromise) => {
          let responded = false;
          let asyncCount = 0;
          const sendResponse = (resp) => {
            if (responded) return;
            responded = true;
            resolvePromise(resp);
          };
          for (const listener of [...messageListeners]) {
            const ret = listener(message, { id: chrome.runtime.id }, sendResponse);
            if (ret === true) asyncCount += 1;
          }
          if (asyncCount === 0 && !responded) resolvePromise(undefined);
        });
      },
    },
    storage: { local, session },
    declarativeNetRequest: {
      async updateDynamicRules() {},
      async getDynamicRules() {
        return [];
      },
    },
    sidePanel: {
      async setPanelBehavior() {},
      open(opts) {
        sidePanelOpenCalls.push(opts);
        return Promise.resolve();
      },
    },
    contextMenus: {
      async removeAll() {
        createdMenus.length = 0;
      },
      create(props) {
        createdMenus.push(props);
      },
      onClicked: {
        addListener(fn) {
          contextMenuListeners.add(fn);
        },
      },
    },
    tabs: {
      async query() {
        return [{ id: 1, windowId: 10, active: true, url: "https://example.com/" }];
      },
    },
    offscreen: {
      async createDocument() {
        offscreenCreateCount += 1;
        offscreenOpen = true;
      },
      async closeDocument() {
        offscreenCloseCount += 1;
        offscreenOpen = false;
      },
      async hasDocument() {
        return offscreenOpen;
      },
    },
    downloads: {
      async download(opts) {
        const id = ++nextDownloadId;
        downloadCalls.push({ id, ...opts });
        return id;
      },
      async cancel() {},
      show(id) {
        shownDownloads.push(id);
      },
      onChanged: {
        addListener(fn) {
          downloadChangedListeners.add(fn);
        },
        removeListener(fn) {
          downloadChangedListeners.delete(fn);
        },
      },
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setTitle() {},
    },
    permissions: {
      async contains() {
        return false;
      },
      onAdded: { addListener() {} },
    },
  };

  return {
    chrome,
    local,
    session,
    createdMenus,
    sidePanelOpenCalls,
    shownDownloads,
    downloadCalls,
    offscreenStartedSpecs,
    offscreenCancelledTaskIds,
    getOffscreenCreateCount: () => offscreenCreateCount,
    getOffscreenCloseCount: () => offscreenCloseCount,
    emitDownloadChanged(delta) {
      for (const fn of [...downloadChangedListeners]) fn(delta);
    },
    emitContextMenuClick(info, tab) {
      for (const fn of [...contextMenuListeners]) fn(info, tab);
    },
  };
}

function makeReadyVideoMedia({
  platform = "bilibili",
  title = "合集测试",
  sourceUrl = "https://www.bilibili.com/video/BV1uv411q7Mv",
  items,
  refreshUrl,
}) {
  return {
    schema_version: "1.0",
    code: "OK",
    data: {
      platform,
      content_id: "BV1uv411q7Mv",
      title,
      source_url: sourceUrl,
      generated_at: "2026-11-25T00:00:00Z",
      ...(items.length > 1 ? { default_item_id: items[0].id } : {}),
      ...(refreshUrl ? { refresh_url: refreshUrl } : {}),
      items,
    },
  };
}

function makeReadyItem(id, index, title, videoUrl, variantId = "v-1080") {
  return {
    id,
    index,
    type: "video",
    state: "ready",
    title,
    default: { variant_id: variantId, source_id: `src-${id}`, url: videoUrl },
    variants: [
      {
        id: variantId,
        state: "ready",
        label: "1080P",
        metadata: {
          width: 1920,
          height: 1080,
          has_audio: true,
          container: "mp4",
          extension: "mp4",
          mime_type: "video/mp4",
        },
        delivery: {
          kind: "file",
          sources: [
            {
              id: `src-${id}`,
              url: videoUrl,
              size_bytes: 2048,
            },
          ],
        },
      },
    ],
  };
}

// ============================================================================
// 1. Guardrail G6: Sanitized Persisted Task History (Zero Signed CDN / Token Leaks)
// ============================================================================

test("Guardrail G6: taskHistoryStore strips signed CDN URLs, specs, query secrets, and Bearer tokens before writing chrome.storage.local", async () => {
  // Unit assertions on URL and text sanitizers
  assert.equal(
    taskHistoryMod.sanitizeCanonicalSourcePageUrl(
      "https://www.bilibili.com/video/BV1uv411q7Mv?p=2#reply",
    ),
    "https://www.bilibili.com/video/BV1uv411q7Mv?p=2",
  );
  assert.equal(
    taskHistoryMod.sanitizeCanonicalSourcePageUrl(
      "https://www.youtube.com/watch?v=I9JvDaciaFk",
    ),
    "https://www.youtube.com/watch?v=I9JvDaciaFk",
  );

  for (const unsafeUrl of [
    "https://rr1---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1799999999&ip=203.0.113.5&sig=YT_SECRET",
    "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/1.m4s?upsig=BILI_SECRET",
    "https://cn-sh.bilivideo.cn/upgcxcode/1.m4s?sign=BILI_CN",
    "https://f.video.weibocdn.com/000abc.mp4?ticket=WB_TICKET",
    "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/a.mp4",
    "https://www.youtube.com/watch?v=I9JvDaciaFk&token=LEAK_TOK",
    "https://www.bilibili.com/video/BV1uv411q7Mv?sig=LEAK_SIG",
    "https://www.bilibili.com/video/BV1uv411q7Mv?upsig=LEAK_UPSIG",
    "https://www.bilibili.com/video/BV1uv411q7Mv?ticket=LEAK_TICKET",
    "https://www.bilibili.com/video/BV1uv411q7Mv?ip=1.2.3.4",
    "https://www.bilibili.com/video/BV1uv411q7Mv?expire=1799999999",
    "https://www.bilibili.com/video/BV1uv411q7Mv?auth=SECRET",
    "javascript:alert(1)",
  ]) {
    assert.equal(
      taskHistoryMod.sanitizeCanonicalSourcePageUrl(unsafeUrl),
      undefined,
      `G6 must reject unsafe sourcePageUrl: ${unsafeUrl}`,
    );
  }

  const env = createMockMv3Env({ autoCompleteDownloads: false });
  const extStorage = storage.createExtensionStorage({
    local: env.local,
    session: env.session,
  });
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    historyStorage: env.local,
  });
  await bg.init();

  // Enqueue sensitive YouTube mux + Bilibili DASH specs
  const enqueueResp = await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "4K YouTube Demo",
        platform: "youtube",
        workFingerprint: "youtube:I9JvDaciaFk",
        spec: {
          kind: "youtube_mux",
          apiOrigin: "https://snap.dokitool.com",
          routes: [
            "https://rr1---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1799999999&ip=203.0.113.5&sig=YT_SIG_SECRET",
          ],
          filename: "DokiTool/4K YouTube Demo.mp4",
          sizeBytes: 4096,
          extraAllowedOrigins: ["https://snap.dokitool.com"],
          youtubeMux: {
            videoUrl:
              "https://rr1---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1799999999&ip=203.0.113.5&sig=YT_SIG_SECRET",
            audioUrl:
              "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1799999999&sig=YT_AUD_SECRET",
            outputContainer: "mp4",
          },
          refreshContext: {
            parseUrl: "https://www.youtube.com/watch?v=I9JvDaciaFk",
            platform: "youtube",
            itemId: "yt-main",
            variantId: "yt-2160p",
          },
        },
      },
      {
        title: "B站高码率视频",
        platform: "bilibili",
        spec: {
          kind: "dash_mux",
          apiOrigin: "https://snap.dokitool.com",
          routes: [
            "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/v.m4s?upsig=BILI_UPSIG_999",
          ],
          filename: "DokiTool/bili.mp4",
          dashMux: {
            videoRoutes: [
              "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/v.m4s?upsig=BILI_UPSIG_999",
            ],
            audioRoutes: [
              "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/a.m4s?upsig=BILI_AUD_888",
            ],
            outputContainer: "mp4",
          },
          refreshContext: {
            parseUrl: "https://www.bilibili.com/video/BV1uv411q7Mv?p=2",
            platform: "bilibili",
            itemId: "part-2",
            variantId: "dash-1080",
          },
        },
      },
    ],
  });
  assert.equal(enqueueResp.ok, true);
  const [ytTaskId, biliTaskId] = enqueueResp.data.taskIds;

  // Simulate an offscreen error containing Bearer token & signed Weibo/googlevideo URLs
  await env.chrome.runtime.sendMessage({
    type: "OFFSCREEN_TASK_ERROR",
    taskId: ytTaskId,
    error:
      "HTTP 403 Bearer super_secret_token_abc https://f.video.weibocdn.com/x.mp4?ticket=WB_SECRET_777 https://rr1---sn-x.googlevideo.com/videoplayback?sig=LEAK",
    code: "HTTP_403",
    httpStatus: 403,
  });

  const dumped = env.local.dump();
  const persisted = dumped[taskHistoryMod.TASK_HISTORY_STORAGE_KEY];
  assert.ok(Array.isArray(persisted));
  assert.equal(persisted.length, 2);

  const rawJson = JSON.stringify(persisted);
  for (const forbidden of [
    "googlevideo.com",
    "bilivideo.com",
    "weibocdn.com",
    "sig=",
    "upsig=",
    "ticket=",
    "super_secret_token_abc",
    "retryPayload",
    "youtubeMux",
    "dashMux",
    "routes",
    "segments",
    "extraAllowedOrigins",
  ]) {
    assert.equal(
      rawJson.includes(forbidden),
      false,
      `chrome.storage.local MUST NOT contain "${forbidden}" (G6 violation): ${rawJson}`,
    );
  }

  const ytRec = persisted.find((r) => r.taskId === ytTaskId);
  const biliRec = persisted.find((r) => r.taskId === biliTaskId);
  assert.equal(ytRec.sourcePageUrl, "https://www.youtube.com/watch?v=I9JvDaciaFk");
  assert.equal(ytRec.itemId, "yt-main");
  assert.equal(ytRec.variantId, "yt-2160p");
  assert.equal(ytRec.status, "failed");
  assert.ok(ytRec.error.includes("Bearer [REDACTED]"));
  assert.ok(ytRec.error.includes("[URL_REDACTED]"));

  // Active (queued/downloading) Bilibili task persisted as normalized failed-interrupted
  assert.equal(biliRec.sourcePageUrl, "https://www.bilibili.com/video/BV1uv411q7Mv?p=2");
  assert.equal(biliRec.itemId, "part-2");
  assert.equal(biliRec.variantId, "dash-1080");
  assert.equal(biliRec.status, "failed");
  assert.equal(biliRec.statusText, taskHistoryMod.SW_INTERRUPTED_STATUS_TEXT);

  bg.dispose();
});

// ============================================================================
// 2. SW-Wake Hydration, Canonical Re-Parse Retry (itemId/variantId), & Clear
// ============================================================================

test("SW-wake hydration normalizes active tasks, retries via canonical sourcePageUrl targeting itemId/variantId, and clears finished history", async () => {
  const sharedLocal = storage.createMemoryStorageArea();
  const sharedSession = storage.createMemoryStorageArea();

  // Seed persisted history as if an earlier SW instance slept mid-download
  await sharedLocal.set({
    [taskHistoryMod.TASK_HISTORY_STORAGE_KEY]: [
      {
        taskId: "hist-interrupted",
        title: "合集 P2",
        platform: "bilibili",
        filename: "DokiTool/合集 P2.mp4",
        status: "downloading", // raw non-terminal state must normalize to failed!
        statusText: "下载中 55%",
        total: 4096,
        createdAt: 1000,
        updatedAt: 2000,
        sourcePageUrl: "https://www.bilibili.com/video/BV1uv411q7Mv",
        itemId: "part-2",
        variantId: "v-1080",
        qualityPreference: "best",
        batchSaveMode: "subfolder",
        subfolderPrefix: "Collect",
      },
      {
        taskId: "hist-done",
        title: "已完成视频",
        platform: "douyin",
        filename: "DokiTool/done.mp4",
        status: "completed",
        statusText: "已完成",
        total: 1024,
        chromeDownloadId: 777,
        createdAt: 500,
        updatedAt: 900,
      },
    ],
  });

  const fetchedUrls = [];
  const mockFetch = async (url) => {
    fetchedUrls.push(String(url));
    if (String(url).includes("/api/parse?")) {
      return new Response(
        JSON.stringify(
          makeReadyVideoMedia({
            items: [
              makeReadyItem("part-1", 1, "第一集", "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/p1.mp4"),
              {
                id: "part-2",
                index: 2,
                type: "video",
                state: "deferred",
                title: "第二集",
                default: null,
                default_unavailable_reason: "needs_resolve",
                resolve_url:
                  "/api/resolve?platform=bilibili&url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1uv411q7Mv%3Fp%3D2",
              },
              {
                id: "part-3",
                index: 3,
                type: "video",
                state: "deferred",
                title: "第三集",
                default: null,
                default_unavailable_reason: "needs_resolve",
                resolve_url:
                  "/api/resolve?platform=bilibili&url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1uv411q7Mv%3Fp%3D3",
              },
            ],
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (String(url).includes("/api/resolve?")) {
      return new Response(
        JSON.stringify(
          makeReadyVideoMedia({
            items: [
              makeReadyItem(
                "part-2",
                2,
                "第二集",
                "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/p2-fresh.mp4",
                "v-1080",
              ),
            ],
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const env = createMockMv3Env({
    localArea: sharedLocal,
    sessionArea: sharedSession,
    autoCompleteDownloads: true,
  });
  const extStorage = storage.createExtensionStorage({
    local: sharedLocal,
    session: sharedSession,
  });
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    historyStorage: sharedLocal,
    fetchImpl: mockFetch,
  });

  // Hydrate via GET_INITIAL_STATE (simulating SW wake)
  const snapResp = await env.chrome.runtime.sendMessage({ type: "GET_INITIAL_STATE" });
  assert.equal(snapResp.ok, true);
  assert.equal(snapResp.data.tasks.length, 2);

  const hydratedInterrupted = snapResp.data.tasks.find((t) => t.taskId === "hist-interrupted");
  assert.equal(hydratedInterrupted.status, "failed");
  assert.equal(hydratedInterrupted.statusText, taskHistoryMod.SW_INTERRUPTED_STATUS_TEXT);
  assert.equal(hydratedInterrupted.persistedFromHistory, true);
  assert.deepEqual(hydratedInterrupted.retryPayload, {
    kind: "url",
    url: "https://www.bilibili.com/video/BV1uv411q7Mv",
    itemId: "part-2",
    variantId: "v-1080",
    qualityPreference: "best",
    batchSaveMode: "subfolder",
    subfolderPrefix: "Collect",
  });

  // OPEN_DOWNLOAD_FOLDER works on hydrated completed task
  const openRes = await env.chrome.runtime.sendMessage({
    type: "OPEN_DOWNLOAD_FOLDER",
    taskId: "hist-done",
  });
  assert.equal(openRes.ok, true);
  assert.equal(openRes.data.opened, true);
  assert.deepEqual(env.shownDownloads, [777]);

  // RETRY_TASK re-parses from canonical sourcePageUrl and lazily resolves ONLY part-2 (never part-3!)
  const retryResp = await env.chrome.runtime.sendMessage({
    type: "RETRY_TASK",
    taskId: "hist-interrupted",
  });
  assert.equal(retryResp.ok, true);
  await bg.waitForIdle();

  assert.equal(
    fetchedUrls.some((u) => u.includes("/api/parse?") && u.includes("BV1uv411q7Mv")),
    true,
  );
  assert.equal(
    fetchedUrls.filter((u) => u.includes("/api/resolve?")).length,
    1,
    "retry must resolve ONLY targeted part-2, not unrelated part-3",
  );
  assert.equal(env.offscreenStartedSpecs.length, 1);
  assert.equal(
    env.offscreenStartedSpecs[0].spec.routes[0],
    "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/p2-fresh.mp4",
  );

  // Task completed and updated in storage
  const afterRetrySnap = await bg.getSnapshot();
  assert.equal(
    afterRetrySnap.tasks.find((t) => t.taskId === "hist-interrupted")?.status,
    "completed",
  );

  // CLEAR_FINISHED_TASKS prunes persisted finished records from chrome.storage.local
  const clearResp = await env.chrome.runtime.sendMessage({
    type: "CLEAR_FINISHED_TASKS",
  });
  assert.equal(clearResp.ok, true);
  assert.equal(clearResp.data.remainingCount, 0);
  assert.equal(
    sharedLocal.dump()[taskHistoryMod.TASK_HISTORY_STORAGE_KEY],
    undefined,
    "persisted finished records must be removed on CLEAR_FINISHED_TASKS",
  );

  bg.dispose();

  // Cold SW wake non-clobber + 50-record cap check:
  // Enqueueing a new task BEFORE GET_INITIAL_STATE must hydrate & preserve prior persisted history capped at 50!
  const prior60 = Array.from({ length: 60 }, (_, idx) => ({
    taskId: `prior-${idx}`,
    title: `旧任务 ${idx}`,
    platform: "bilibili",
    filename: `old-${idx}.mp4`,
    status: "completed",
    statusText: "已完成",
    createdAt: 1000 - idx,
    updatedAt: 1000 - idx,
  }));
  await sharedLocal.set({ [taskHistoryMod.TASK_HISTORY_STORAGE_KEY]: prior60 });

  const env2 = createMockMv3Env({
    localArea: sharedLocal,
    sessionArea: sharedSession,
    autoCompleteDownloads: true,
  });
  const bg2 = backgroundMod.createBackgroundController({
    chrome: env2.chrome,
    storage: storage.createExtensionStorage({
      local: sharedLocal,
      session: sharedSession,
    }),
    historyStorage: sharedLocal,
  });
  const coldEnqueue = await env2.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "冷启动新任务",
        platform: "bilibili",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/new.mp4"],
          filename: "DokiTool/new.mp4",
        },
      },
    ],
  });
  assert.equal(coldEnqueue.ok, true);
  await bg2.waitForIdle();

  const storedAfterColdWake = sharedLocal.dump()[taskHistoryMod.TASK_HISTORY_STORAGE_KEY];
  assert.equal(storedAfterColdWake.length, taskHistoryMod.MAX_PERSISTED_TASK_HISTORY);
  assert.equal(storedAfterColdWake[0].taskId, coldEnqueue.data.taskIds[0]);
  assert.equal(storedAfterColdWake[1].taskId, "prior-0");
  bg2.dispose();
});

// ============================================================================
// 3. Right-Click `selection` Context Menu (`dokitool-parse-selection`)
// ============================================================================

test("Right-click selection menu registers contexts=['selection'], extracts valid http(s) URL safely, and ignores non-URL / unsafe schemes", async () => {
  // Pure extractor checks
  assert.equal(
    tabSyncMod.extractFirstValidSelectionUrl(
      "快来看这个视频（https://www.bilibili.com/video/BV1uv411q7Mv?p=2#reply），超赞！",
    ),
    "https://www.bilibili.com/video/BV1uv411q7Mv?p=2",
  );
  assert.equal(
    tabSyncMod.extractFirstValidSelectionUrl(
      "Skip http://127.0.0.1:8080/secret and parse (https://vimeo.com/987654321).",
    ),
    "https://vimeo.com/987654321",
  );
  for (const invalidSel of [
    "",
    "   ",
    "这是一段不含链接的普通中文文本",
    "javascript:alert(document.cookie)",
    "file:///etc/passwd",
    "chrome://extensions",
    "http://192.168.1.10/admin",
    "https://snap.dokitool.com/api/parse?url=x",
  ]) {
    assert.equal(
      tabSyncMod.extractFirstValidSelectionUrl(invalidSel),
      null,
      `selection extractor must reject: ${invalidSel}`,
    );
  }

  const env = createMockMv3Env();
  const extStorage = storage.createExtensionStorage({
    local: env.local,
    session: env.session,
  });
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    historyStorage: env.local,
  });
  await bg.init();

  const selMenu = env.createdMenus.find(
    (m) => m.id === protocol.CONTEXT_MENU_PARSE_SELECTION_ID,
  );
  assert.ok(selMenu, "dokitool-parse-selection menu must be registered");
  assert.equal(selMenu.id, "dokitool-parse-selection");
  assert.equal(selMenu.title, "用 DokiTool 解析选中链接");
  assert.deepEqual(selMenu.contexts, ["selection"]);

  // Invalid / unsafe selection text MUST NOT open SidePanel or store intent
  env.emitContextMenuClick(
    {
      menuItemId: protocol.CONTEXT_MENU_PARSE_SELECTION_ID,
      selectionText: "javascript:alert(1) 普通文字 file:///etc/passwd",
    },
    { id: 9, windowId: 10 },
  );
  await bg.waitForIdle();
  assert.equal(env.sidePanelOpenCalls.length, 0);
  assert.equal(await extStorage.getPendingIntent(), null);

  // Valid selection text opens SidePanel synchronously before microtask and stores clean URL only
  let microtaskRan = false;
  let openedSynchronously = false;
  const origOpen = env.chrome.sidePanel.open;
  env.chrome.sidePanel.open = (opts) => {
    openedSynchronously = !microtaskRan;
    return origOpen(opts);
  };
  queueMicrotask(() => {
    microtaskRan = true;
  });

  env.emitContextMenuClick(
    {
      menuItemId: protocol.CONTEXT_MENU_PARSE_SELECTION_ID,
      selectionText:
        "周围隐私备注不该发送 https://www.youtube.com/watch?v=I9JvDaciaFk#t=10s! 结尾文字",
    },
    { id: 9, windowId: 10 },
  );
  assert.equal(openedSynchronously, true);
  await bg.waitForIdle();

  const intent = await extStorage.consumePendingIntent();
  assert.equal(intent?.mode, "inspect");
  assert.equal(intent?.url, "https://www.youtube.com/watch?v=I9JvDaciaFk");

  bg.dispose();
});

// ============================================================================
// 4. Multi-P Background Streaming Queue (`ENQUEUE_MULTIPART_ITEMS`)
// ============================================================================

test("ENQUEUE_MULTIPART_ITEMS returns immediately with queued tasks, caps resolve concurrency at <= 2, supports Tier-2 refreshUrl fallback, and honors CANCEL_TASK", async () => {
  const resolveGates = new Map();
  let inFlightResolves = 0;
  let peakResolves = 0;
  let abortedPart3 = false;
  const parsedFallbackUrls = [];

  const mockFetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.includes("/api/resolve?")) {
      inFlightResolves += 1;
      peakResolves = Math.max(peakResolves, inFlightResolves);
      const partMatch = /p=(\d+)/.exec(decodeURIComponent(urlStr));
      const pNum = partMatch ? Number(partMatch[1]) : 0;
      const gate = createDeferred();
      resolveGates.set(pNum, gate);
      const signal = init?.signal;
      const onAbort = () => {
        if (pNum === 3) abortedPart3 = true;
        gate.reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      try {
        await gate.promise;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        inFlightResolves -= 1;
      }
      return new Response(
        JSON.stringify(
          makeReadyVideoMedia({
            items: [
              makeReadyItem(
                `p-${pNum}`,
                pNum,
                `第${pNum}集`,
                `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/p${pNum}.mp4`,
              ),
            ],
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (urlStr.includes("/api/parse?")) {
      parsedFallbackUrls.push(urlStr);
      return new Response(
        JSON.stringify(
          makeReadyVideoMedia({
            platform: "vimeo",
            title: "Vimeo Album",
            sourceUrl: "https://vimeo.com/showcase/12345",
            items: [
              makeReadyItem(
                "p-5",
                5,
                "Tier2 Part 5",
                "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/p5-tier2.mp4",
              ),
            ],
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch: ${urlStr}`);
  };

  const env = createMockMv3Env({ autoCompleteDownloads: true });
  const extStorage = storage.createExtensionStorage({
    local: env.local,
    session: env.session,
  });
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    historyStorage: env.local,
    fetchImpl: mockFetch,
    maxBatchDownloadConcurrency: 3,
  });
  await bg.init();

  const rpcResp = await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_MULTIPART_ITEMS",
    media: {
      platform: "bilibili",
      title: "多P课程合集",
      sourceUrl: "https://www.bilibili.com/video/BV1uv411q7Mv",
      refreshUrl: "/api/parse?schema_version=1.0&url=https%3A%2F%2Fvimeo.com%2Fshowcase%2F12345",
      totalItemCount: 5,
    },
    items: [
      {
        itemId: "p-1",
        index: 1,
        title: "第1集（已就绪）",
        state: "ready",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/p1-ready.mp4"],
          filename: "多P课程合集/001_第1集.mp4",
          sizeBytes: 1024,
        },
      },
      {
        itemId: "p-2",
        index: 2,
        title: "第2集",
        state: "deferred",
        resolveUrl:
          "/api/resolve?platform=bilibili&url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1uv411q7Mv%3Fp%3D2",
      },
      {
        itemId: "p-3",
        index: 3,
        title: "第3集（将被取消）",
        state: "deferred",
        resolveUrl:
          "/api/resolve?platform=bilibili&url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1uv411q7Mv%3Fp%3D3",
      },
      {
        itemId: "p-4",
        index: 4,
        title: "第4集",
        state: "deferred",
        resolveUrl:
          "/api/resolve?platform=bilibili&url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1uv411q7Mv%3Fp%3D4",
      },
      {
        itemId: "p-5",
        index: 5,
        title: "Tier2 无 resolveUrl 分集",
        state: "deferred",
        sourceUrl: "https://vimeo.com/showcase/12345",
      },
    ],
    qualityPreference: "best",
    subfolderPrefix: "Course",
  });

  // Returned immediately with all 5 queued tasks before any /api/resolve completed!
  assert.equal(rpcResp.ok, true);
  assert.equal(rpcResp.data.taskIds.length, 5);
  assert.equal(rpcResp.data.tasks.every((t) => t.status === "queued"), true);
  assert.equal(protocol.isEnqueueMultiPartItemsRequest({
    type: "ENQUEUE_MULTIPART_ITEMS",
    media: { platform: "bilibili" },
    items: [],
  }), true);

  // Wait for deferred items p-2 and p-3 to enter /api/resolve (concurrency capped at 2)
  for (let i = 0; i < 40 && (!resolveGates.has(2) || !resolveGates.has(3)); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(peakResolves <= 2, true, `expected peak resolve concurrency <= 2, got ${peakResolves}`);
  assert.equal(resolveGates.has(4), false, "p-4 must wait while 2 resolves are active");

  // Cancel p-3 while it is resolving!
  const p3TaskId = rpcResp.data.taskIds[2];
  const cancelRes = await env.chrome.runtime.sendMessage({
    type: "CANCEL_TASK",
    taskId: p3TaskId,
  });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.data.cancelled, true);
  assert.equal(abortedPart3, true, "CANCEL_TASK must abort in-flight /api/resolve");

  // Release p-2, wait for p-4 to start, then release p-4
  resolveGates.get(2).resolve();
  for (let i = 0; i < 40 && !resolveGates.has(4); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(resolveGates.has(4), "p-4 should start resolving after slot frees");
  resolveGates.get(4).resolve();

  await bg.waitForIdle();

  assert.equal(peakResolves <= 2, true, `final peak resolve concurrency <= 2, got ${peakResolves}`);
  assert.equal(parsedFallbackUrls.length, 1, "Tier-2 item without resolveUrl must fall back to /api/parse");

  const finalSnap = await bg.getSnapshot();
  const statusById = new Map(finalSnap.tasks.map((t) => [t.taskId, t.status]));
  assert.equal(statusById.get(rpcResp.data.taskIds[0]), "completed");
  assert.equal(statusById.get(rpcResp.data.taskIds[1]), "completed");
  assert.equal(statusById.get(rpcResp.data.taskIds[2]), "cancelled");
  assert.equal(statusById.get(rpcResp.data.taskIds[3]), "completed");
  assert.equal(statusById.get(rpcResp.data.taskIds[4]), "completed");
  assert.equal(
    env.offscreenStartedSpecs.some((s) => s.taskId === p3TaskId),
    false,
    "cancelled p-3 must never dispatch a download",
  );

  // Persisted history reflects settled batch cleanly without CDN URLs
  const persisted = env.local.dump()[taskHistoryMod.TASK_HISTORY_STORAGE_KEY];
  assert.equal(persisted.length, 5);
  assert.equal(JSON.stringify(persisted).includes("bilivideo.com"), false);

  bg.dispose();
});

// ============================================================================
// 5. Extension YouTube `captions` Minimal Projection (`youtubeExtensionBridge` + `apiClient`)
// ============================================================================

test("youtubeExtensionBridge & bg/apiClient project YouTube captions without translationLanguages and honor supports_captions !== false", async () => {
  // Part A: youtubeExtensionBridge.requestPlayer strips translationLanguages and bloated renderer fields
  const mockPlayerResponse = {
    playabilityStatus: { status: "OK" },
    videoDetails: { title: "Caption Test", author: "Chan", lengthSeconds: "120" },
    streamingData: {
      formats: [
        {
          itag: 18,
          url: "https://rr1---sn-abc.googlevideo.com/videoplayback?id=1",
          mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          width: 640,
          height: 360,
        },
      ],
      adaptiveFormats: [],
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en",
            name: { simpleText: "English" },
            vssId: ".en",
            languageCode: "en",
            kind: "asr",
            isTranslatable: true,
            bloatedField: "MUST_BE_STRIPPED",
          },
        ],
        translationLanguages: [
          { languageCode: "zh-Hans", languageName: { simpleText: "Chinese" } },
          { languageCode: "ja", languageName: { simpleText: "Japanese" } },
        ],
        audioTracks: [{ captionTrackIndices: [0] }],
      },
    },
  };

  const bridge = youtubeBridgeMod.createYouTubeExtensionBridge({
    handoffBlobDownload: async () => ({ chromeDownloadId: 1 }),
    fetchImpl: async () =>
      new Response(JSON.stringify(mockPlayerResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });
  try {
    const playerRes = await bridge.requestPlayer({
      video_id: "I9JvDaciaFk",
      signature_timestamp: 20123,
      client: { name: "TVHTML5", version: "7.20250101.00.00" },
    });
    assert.ok(playerRes.captions?.playerCaptionsTracklistRenderer?.captionTracks);
    assert.equal(
      playerRes.captions.playerCaptionsTracklistRenderer.captionTracks.length,
      1,
    );
    assert.equal(
      "translationLanguages" in playerRes.captions.playerCaptionsTracklistRenderer,
      false,
      "youtubeExtensionBridge must strip translationLanguages",
    );
    assert.equal(
      "bloatedField" in playerRes.captions.playerCaptionsTracklistRenderer.captionTracks[0],
      false,
    );
  } finally {
    bridge.dispose();
  }

  // Part B: bg/apiClient attaches projected captions when supports_captions !== false and omits when false
  const runYouTubeParse = async (supportsCaptions) => {
    const finalizeBodies = [];
    const env = createMockMv3Env({
      offscreenHandler(msg) {
        if (msg.type === "OFFSCREEN_YOUTUBE_PREFETCH") {
          return { ok: true, data: { prefetch: { visitorData: "", oembed: null } } };
        }
        if (msg.type === "OFFSCREEN_YOUTUBE_PLAYER") {
          return {
            ok: true,
            data: {
              player: {
                playabilityStatus: { status: "OK" },
                videoDetails: { title: "Caption Test", author: "Chan", lengthSeconds: 120 },
                streamingData: { formats: [], adaptiveFormats: [] },
                // Deliberately include translationLanguages to verify apiClient defense-in-depth
                captions: mockPlayerResponse.captions,
              },
            },
          };
        }
        return { ok: true, data: {} };
      },
    });
    const extStorage = storage.createExtensionStorage({
      local: env.local,
      session: env.session,
    });
    const mockFetch = async (url, init) => {
      const u = String(url);
      if (u.includes("/api/youtube/context")) {
        const ctxData = {
          player_id: "abc12345",
          signature_timestamp: 20123,
          client: { name: "TVHTML5", version: "7.20250101.00.00" },
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          ...(supportsCaptions !== undefined ? { supports_captions: supportsCaptions } : {}),
        };
        return new Response(
          JSON.stringify({ schema_version: "1.0", code: "OK", data: ctxData }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("/api/youtube/finalize")) {
        finalizeBodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify(
            makeReadyVideoMedia({
              platform: "youtube",
              title: "Caption Test",
              sourceUrl: "https://www.youtube.com/watch?v=I9JvDaciaFk",
              items: [
                makeReadyItem(
                  "yt-1",
                  1,
                  "Caption Test",
                  "https://rr1---sn-abc.googlevideo.com/videoplayback?id=1",
                ),
              ],
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${u}`);
    };
    const bg = backgroundMod.createBackgroundController({
      chrome: env.chrome,
      storage: extStorage,
      historyStorage: env.local,
      fetchImpl: mockFetch,
    });
    const res = await env.chrome.runtime.sendMessage({
      type: "PARSE_URL",
      url: "https://www.youtube.com/watch?v=I9JvDaciaFk",
    });
    bg.dispose();
    assert.equal(res.ok, true);
    return finalizeBodies[0];
  };

  const bodyWhenTrue = await runYouTubeParse(true);
  assert.ok(bodyWhenTrue.captions?.playerCaptionsTracklistRenderer?.captionTracks);
  assert.equal(
    "translationLanguages" in bodyWhenTrue.captions.playerCaptionsTracklistRenderer,
    false,
  );
  assert.equal(
    "bloatedField" in bodyWhenTrue.captions.playerCaptionsTracklistRenderer.captionTracks[0],
    false,
  );

  const bodyWhenOmitted = await runYouTubeParse(undefined);
  assert.ok(bodyWhenOmitted.captions?.playerCaptionsTracklistRenderer?.captionTracks);

  const bodyWhenFalse = await runYouTubeParse(false);
  assert.equal("captions" in bodyWhenFalse, false, "must omit captions when supports_captions === false");
});

// ============================================================================
// 6. Extracted offscreenLifecycle Mutex & Idle Close Regression Guard
// ============================================================================

test("offscreenLifecycle serializes concurrent ensureOffscreenDocument calls and closes after idle timeout", async () => {
  const env = createMockMv3Env();
  const lifecycle = offscreenLifecycleMod.createOffscreenLifecycle({
    chromeApi: env.chrome,
    offscreenIdleCloseMs: 25,
    isDisposed: () => false,
    countActiveTasks: () => 0,
    getPendingBlobCount: () => 0,
    syncDynamicDnrRules: async () => [],
  });

  await Promise.all([
    lifecycle.ensureOffscreenDocument(),
    lifecycle.ensureOffscreenDocument(),
    lifecycle.ensureOffscreenDocument(),
  ]);
  assert.equal(env.getOffscreenCreateCount(), 1, "offscreen mutex must prevent duplicate createDocument");

  const pingData = await lifecycle.sendToOffscreen({ type: "OFFSCREEN_PING" });
  assert.equal(pingData.ready, true);

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(env.getOffscreenCloseCount(), 1, "idle timer must close offscreen after non-task RPC completes");
  lifecycle.dispose();
});

// ============================================================================
// SidePanel SFC Test Harness (Suites 7-9: Subtitles, Multi-P Stream, History)
// ============================================================================

const PassthroughTransition = {
  inheritAttrs: false,
  setup(_props, { slots }) {
    return () => slots.default?.();
  },
};

async function loadSidePanelSfc(relPathFromTests) {
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
    return vue.markRaw({
      type,
      text,
      value: "",
      selected: false,
      props: {},
      children: [],
      parent: null,
      style: {},
      get options() {
        return this.children.filter((c) => c.type === "option");
      },
      getRootNode() {
        return null;
      },
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
  const renderer = vue.createRenderer({
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
      parent.children.splice(idx < 0 ? parent.children.length : idx, 0, node);
    },
    remove: detach,
    patchProp(node, key, _prev, value) {
      node.props[key] = value;
      if (key === "value") node.value = value ?? "";
    },
  });
  const propState = vue.ref({ ...initialProps });
  const root = element("root");
  const app = renderer.createApp({
    render: () => vue.h(Component, { ...propState.value, ...listeners }),
  });
  app.mount(root);
  const findAll = (pred, scope = root) => [
    ...(pred(scope) ? [scope] : []),
    ...scope.children.flatMap((child) => findAll(pred, child)),
  ];
  const textOf = (scope = root) =>
    [scope.text || "", ...scope.children.map(textOf)].join("");
  const flush = async (ms = 0) => {
    await vue.nextTick();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    await vue.nextTick();
  };
  const fire = async (node, eventProp, arg = {}) => {
    const fn = node?.props?.[eventProp];
    if (typeof fn === "function") await fn(arg);
    await flush(15);
  };
  return {
    root,
    propState,
    findAll,
    textOf,
    flush,
    fire,
    unmount: () => app.unmount(),
  };
}

// ============================================================================
// 7. SidePanelSubtitlePanel: Whitelist Enforcement, VTT/SRT/Bilingual & Q5A
// ============================================================================

test("SidePanelSubtitlePanel enforces hostWhitelist, downloads single/bilingual VTT+SRT via no-cookie fetch, rejects >5 MiB, and offers honest Q5A copy/open for non-whitelisted hosts", async () => {
  const SidePanelSubtitlePanel = await loadSidePanelSfc(
    "../src/extension/components/SidePanelSubtitlePanel.vue",
  );
  const fetchCalls = [];
  const createdBlobs = [];
  const clickedDownloads = [];
  const revokedUrls = [];
  const copiedTexts = [];
  const openedTabs = [];

  const origDoc = globalThis.document;
  const origNav = globalThis.navigator;
  const origChrome = globalThis.chrome;
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;
  const origSetTimeout = globalThis.setTimeout;

  try {
    let blobSeq = 0;
    URL.createObjectURL = (blob) => {
      const id = `blob:ext-sub-${++blobSeq}`;
      createdBlobs.push({ id, blob });
      return id;
    };
    URL.revokeObjectURL = (u) => revokedUrls.push(u);
    globalThis.setTimeout = (fn, delay) =>
      origSetTimeout(fn, delay >= 500 ? 5 : delay);
    globalThis.document = {
      body: { appendChild() {} },
      createElement(tag) {
        const el = {
          tag,
          href: "",
          download: "",
          rel: "",
          style: {},
          click() {
            clickedDownloads.push({
              href: el.href,
              download: el.download,
              rel: el.rel,
            });
          },
          remove() {},
        };
        return el;
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          async writeText(text) {
            copiedTexts.push(text);
          },
        },
      },
    });
    globalThis.chrome = {
      tabs: {
        create(opts) {
          openedTabs.push(opts.url);
        },
      },
    };

    const mockFetch = async (url, init) => {
      const u = String(url);
      fetchCalls.push({ url: u, init });
      if (u.includes("lang=zh-Hans")) {
        return new Response(
          "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n你好世界\n",
          { status: 200, headers: { "Content-Type": "text/vtt" } },
        );
      }
      if (u.includes("lang=en")) {
        return new Response(
          "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n",
          { status: 200, headers: { "Content-Type": "text/vtt" } },
        );
      }
      if (u.includes("huge=1")) {
        return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhuge\n", {
          status: 200,
          headers: { "Content-Length": String(6 * 1024 * 1024) },
        });
      }
      throw new Error(`Unexpected subtitle fetch: ${u}`);
    };

    const mediaWithSubtitles = {
      platform: "youtube",
      content_id: "sub-test-1",
      title: "YouTube 字幕测试",
      source_url: "https://www.youtube.com/watch?v=I9JvDaciaFk",
      items: [
        makeReadyItem(
          "yt-1",
          1,
          "YouTube 字幕测试",
          "https://rr1---sn-abc.googlevideo.com/videoplayback?id=1",
        ),
      ],
      attachments: [
        {
          id: "sub-zh",
          role: "subtitle",
          title: "中文（简体）",
          language: "zh-Hans",
          track_kind: "manual",
          resource: {
            id: "r-zh",
            role: "subtitle",
            metadata: { extension: "vtt", mime_type: "text/vtt" },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-zh",
                  url: "https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=zh-Hans&fmt=vtt",
                },
              ],
            },
          },
        },
        {
          id: "sub-en",
          role: "subtitle",
          title: "English",
          language: "en",
          track_kind: "auto",
          resource: {
            id: "r-en",
            role: "subtitle",
            metadata: { extension: "vtt", mime_type: "text/vtt" },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-en",
                  url: "https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en&fmt=vtt",
                },
              ],
            },
          },
        },
        {
          id: "sub-huge",
          role: "subtitle",
          title: "Oversized",
          language: "ja",
          track_kind: "auto",
          resource: {
            id: "r-huge",
            role: "subtitle",
            metadata: { extension: "vtt", mime_type: "text/vtt" },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-huge",
                  url: "https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&huge=1&fmt=vtt",
                },
              ],
            },
          },
        },
        {
          id: "sub-tier2",
          role: "subtitle",
          title: "Tier2 Sub",
          language: "fr",
          track_kind: "manual",
          resource: {
            id: "r-t2",
            role: "subtitle",
            metadata: { extension: "vtt", mime_type: "text/vtt" },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-t2",
                  url: "https://subs.thirdparty-longtail.example/fr.vtt",
                },
              ],
            },
          },
        },
      ],
    };

    const view = mountSfcTree(SidePanelSubtitlePanel, {
      media: mediaWithSubtitles,
      apiOrigin: "https://snap.dokitool.com",
      baseTitle: "YouTube 字幕测试",
      fetchImpl: mockFetch,
    });
    try {
      await view.flush();
      assert.equal(
        view.findAll((n) => n.props["data-testid"] === "sidepanel-subtitle-panel").length,
        1,
      );
      // Verify 人工 / 自动 badges + honest non-whitelisted notice & badge
      const manualBadges = view.findAll((n) => n.props["data-track-kind"] === "manual");
      const autoBadges = view.findAll((n) => n.props["data-track-kind"] === "auto");
      assert.ok(manualBadges.length >= 1 && view.textOf(manualBadges[0]).includes("人工"));
      assert.ok(autoBadges.length >= 1 && view.textOf(autoBadges[0]).includes("自动"));
      assert.equal(
        view.findAll((n) => n.props["data-testid"] === "subtitle-nonwhitelisted-badge").length,
        1,
      );
      assert.equal(
        view.findAll((n) => n.props["data-testid"] === "subtitle-nonwhitelisted-notice").length,
        1,
      );

      // Non-whitelisted track row offers 复制直链 + 打开, NEVER calls fetch!
      const tier2Row = view.findAll((n) => n.props["data-subtitle-id"] === "sub-tier2")[0];
      assert.ok(tier2Row);
      const tier2Buttons = view.findAll((n) => n.type === "button", tier2Row);
      assert.deepEqual(
        tier2Buttons.map((b) => view.textOf(b).trim()),
        ["复制直链", "打开"],
      );
      await view.fire(tier2Buttons[0], "onClick");
      await view.fire(tier2Buttons[1], "onClick");
      assert.equal(fetchCalls.length, 0, "non-whitelisted subtitle must make 0 fetch calls");
      assert.equal(copiedTexts[0], "https://subs.thirdparty-longtail.example/fr.vtt");
      assert.equal(openedTabs[0], "https://subs.thirdparty-longtail.example/fr.vtt");

      // Single-track SRT download on whitelisted YouTube timedtext enforces credentials:"omit" & referrerPolicy:"no-referrer"
      const zhRow = view.findAll((n) => n.props["data-subtitle-id"] === "sub-zh")[0];
      const zhSrtBtn = view.findAll(
        (n) => n.type === "button" && view.textOf(n).trim() === "SRT",
        zhRow,
      )[0];
      await view.fire(zhSrtBtn, "onClick");
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].init.credentials, "omit");
      assert.equal(fetchCalls[0].init.referrerPolicy, "no-referrer");
      assert.equal(clickedDownloads.length, 1);
      assert.match(clickedDownloads[0].download, /\.zh-Hans\.srt$/);
      const singleText = await createdBlobs[0].blob.text();
      assert.match(singleText, /00:00:01,000 --> 00:00:03,000/);
      assert.match(singleText, /你好世界/);
      await new Promise((r) => origSetTimeout(r, 20));
      assert.ok(revokedUrls.includes(createdBlobs[0].id), "Blob URL must be revoked cleanly");

      // Bilingual merge download (zh-Hans + en -> .vtt)
      const selects = view.findAll((n) => n.type === "select");
      assert.equal(selects.length, 2);
      selects[1].value = "sub-en";
      for (const opt of selects[1].options) opt.selected = opt.value === "sub-en";
      selects[1].dispatchEvent({ type: "change", target: selects[1] });
      await view.flush();
      const primaryBtn = view.findAll(
        (n) => n.props["data-testid"] === "sidepanel-subtitle-primary-download",
      )[0];
      await view.fire(primaryBtn, "onClick");
      assert.equal(clickedDownloads.length, 2);
      assert.match(clickedDownloads[1].download, /\.zh-Hans_en\.vtt$/);
      const biText = await createdBlobs[1].blob.text();
      assert.match(biText, /WEBVTT/);
      assert.match(biText, /你好世界\nHello world/);

      // Oversized > 5 MiB track fails cleanly with safety alert
      const hugeRow = view.findAll((n) => n.props["data-subtitle-id"] === "sub-huge")[0];
      const hugeVttBtn = view.findAll(
        (n) => n.type === "button" && view.textOf(n).trim() === "VTT",
        hugeRow,
      )[0];
      await view.fire(hugeVttBtn, "onClick");
      const errNode = view.findAll(
        (n) => n.props["data-testid"] === "sidepanel-subtitle-error",
      )[0];
      assert.ok(errNode && view.textOf(errNode).includes("5 MiB"));
    } finally {
      view.unmount();
    }
  } finally {
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    globalThis.setTimeout = origSetTimeout;
    if (origDoc === undefined) delete globalThis.document;
    else globalThis.document = origDoc;
    if (origNav === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", { configurable: true, value: origNav });
    if (origChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = origChrome;
  }
});

// ============================================================================
// 8. SidePanelResult + SidePanelApp: Multi-P Background Streaming Queue
// ============================================================================

test("SidePanelResult + SidePanelApp wire multi-P deferred checklists to ENQUEUE_MULTIPART_ITEMS immediately without SidePanel blocking, while keeping ZIP mode intact", async () => {
  const SidePanelApp = await loadSidePanelSfc("../src/extension/SidePanelApp.vue");
  const prevChrome = globalThis.chrome;
  const prevDoc = globalThis.document;
  globalThis.document = {
    activeElement: null,
    documentElement: { dataset: {} },
  };
  const resolveGate = createDeferred();
  const resolveCalls = [];
  const multiPartRpcPayloads = [];

  const env = createMockMv3Env({
    autoCompleteDownloads: true,
  });

  const multiPMedia = makeReadyVideoMedia({
    platform: "bilibili",
    title: "流式多P教程",
    sourceUrl: "https://www.bilibili.com/video/BV1uv411q7Mv",
    items: [
      makeReadyItem("p1", 1, "第一讲", "https://upos-sz-mirrorcos.bilivideo.com/p1.mp4"),
      {
        id: "p2",
        type: "video",
        index: 2,
        title: "第二讲",
        state: "deferred",
        default: null,
        default_unavailable_reason: "needs_resolve",
        resolve_url: "/api/resolve?schema_version=1.0&url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1uv411q7Mv&item_id=p2",
      },
      {
        id: "p3",
        type: "video",
        index: 3,
        title: "第三讲",
        state: "deferred",
        default: null,
        default_unavailable_reason: "needs_resolve",
        resolve_url: "/api/resolve?schema_version=1.0&url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1uv411q7Mv&item_id=p3",
      },
    ],
  });

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/parse")) {
      return new Response(JSON.stringify(multiPMedia), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/api/resolve?") && u.includes("item_id=p2")) {
      resolveCalls.push("p2");
      await resolveGate.promise;
      return new Response(
        JSON.stringify(
          makeReadyVideoMedia({
            platform: "bilibili",
            title: "流式多P教程",
            items: [makeReadyItem("p2", 2, "第二讲", "https://upos-sz-mirrorcos.bilivideo.com/p2.mp4")],
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/api/resolve?") && u.includes("item_id=p3")) {
      resolveCalls.push("p3");
      await resolveGate.promise;
      return new Response(
        JSON.stringify(
          makeReadyVideoMedia({
            platform: "bilibili",
            title: "流式多P教程",
            items: [makeReadyItem("p3", 3, "第三讲", "https://upos-sz-mirrorcos.bilivideo.com/p3.mp4")],
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${u}`);
  };

  const extStorage = storage.createExtensionStorage();
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    historyStorage: env.local,
    fetchImpl: mockFetch,
    maxBatchDownloadConcurrency: 3,
  });
  await bg.init();

  const origSend = env.chrome.runtime.sendMessage;
  env.chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === "ENQUEUE_MULTIPART_ITEMS") multiPartRpcPayloads.push(msg);
    if (msg?.type === "RESOLVE_LAZY_ITEM") {
      throw new Error("SidePanel must NOT block with RESOLVE_LAZY_ITEM on multi-P subfolder save");
    }
    return origSend(msg);
  };

  globalThis.chrome = env.chrome;
  const view = mountSfcTree(SidePanelApp);
  try {
    await view.flush(25);
    const input = view.findAll((n) => n.type === "input")[0];
    const form = view.findAll((n) => n.type === "form")[0];
    input.value = "https://www.bilibili.com/video/BV1uv411q7Mv";
    input.dispatchEvent({ type: "input", target: input });
    await view.flush();
    await view.fire(form, "onSubmit", { preventDefault() {} });
    await view.flush(25);

    const primaryBtn = view.findAll(
      (n) =>
        n.type === "button" &&
        typeof n.props.class === "string" &&
        n.props.class.includes("sp-batch-actions__primary"),
    )[0];
    assert.ok(primaryBtn, "expected multi-P primary download button");

    // Click subfolder download while p2/p3 resolveGate is STILL blocked -> returns immediately with 3 tasks!
    await view.fire(primaryBtn, "onClick");
    assert.equal(multiPartRpcPayloads.length, 1, "must dispatch ENQUEUE_MULTIPART_ITEMS");
    assert.equal(multiPartRpcPayloads[0].items.length, 3);
    assert.equal(multiPartRpcPayloads[0].items[0].state, "ready");
    assert.equal(multiPartRpcPayloads[0].items[1].state, "deferred");
    assert.equal(multiPartRpcPayloads[0].items[2].state, "deferred");
    const taskRows = view.findAll(
      (n) => typeof n.props.class === "string" && n.props.class.split(" ").includes("sp-task"),
    );
    assert.equal(taskRows.length, 3, "all 3 queued tasks must appear immediately in task drawer");

    // Release background lazy resolution -> all 3 complete in background!
    resolveGate.resolve();
    await bg.waitForIdle();
    await view.flush(25);
    assert.deepEqual(resolveCalls.sort(), ["p2", "p3"]);
    const finalSnap = await bg.getSnapshot();
    assert.equal(finalSnap.tasks.filter((t) => t.status === "completed").length, 3);
  } finally {
    resolveGate.resolve();
    view.unmount();
    bg.dispose();
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
});

// ============================================================================
// 9. SidePanelDownloads + SidePanelApp: Persisted History Badge & Actions
// ============================================================================

test("SidePanelDownloads renders task-history-badge for hydrated history tasks and wires Retry, Open Folder, and Clear Finished", async () => {
  const SidePanelApp = await loadSidePanelSfc("../src/extension/SidePanelApp.vue");
  const prevChrome = globalThis.chrome;
  const prevDoc = globalThis.document;
  globalThis.document = {
    activeElement: null,
    documentElement: { dataset: {} },
  };

  const sharedLocal = storage.createMemoryStorageArea();
  await sharedLocal.set({
    [taskHistoryMod.TASK_HISTORY_STORAGE_KEY]: [
      {
        taskId: "hist-done-1",
        title: "历史完成作品",
        platform: "bilibili",
        filename: "DokiTool/历史完成作品.mp4",
        status: "completed",
        statusText: "已完成",
        total: 4096,
        createdAt: 1000,
        updatedAt: 1100,
        chromeDownloadId: 777,
        sourcePageUrl: "https://www.bilibili.com/video/BV1DoneHist01",
      },
      {
        taskId: "hist-fail-2",
        title: "休眠中断作品",
        platform: "bilibili",
        filename: "DokiTool/休眠中断作品.mp4",
        status: "failed",
        statusText: taskHistoryMod.SW_INTERRUPTED_STATUS_TEXT,
        createdAt: 2000,
        updatedAt: 2100,
        sourcePageUrl: "https://www.bilibili.com/video/BV1RetryHist2",
        itemId: "p1",
      },
      {
        taskId: "hist-noretry-3",
        title: "无源页失败记录",
        platform: "unknown",
        filename: "unsupported",
        status: "failed",
        statusText: "不支持的链接",
        createdAt: 500,
        updatedAt: 500,
      },
    ],
  });

  const env = createMockMv3Env({
    localArea: sharedLocal,
    autoCompleteDownloads: true,
  });

  const retryParseUrls = [];
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/parse")) {
      retryParseUrls.push(u);
      return new Response(
        JSON.stringify(
          makeReadyVideoMedia({
            platform: "bilibili",
            contentId: "BV1RetryHist2",
            title: "休眠中断作品",
            sourceUrl: "https://www.bilibili.com/video/BV1RetryHist2",
            items: [
              makeReadyItem("p1", 1, "休眠中断作品", "https://upos-sz-mirrorcos.bilivideo.com/retry.mp4"),
            ],
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${u}`);
  };

  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: storage.createExtensionStorage(),
    historyStorage: sharedLocal,
    fetchImpl: mockFetch,
  });
  await bg.init();

  globalThis.chrome = env.chrome;
  const view = mountSfcTree(SidePanelApp);
  try {
    await view.flush(30);
    // Hydrated history tasks render task-history-badge
    const historyBadges = view.findAll(
      (n) => n.props["data-testid"] === "task-history-badge",
    );
    assert.equal(historyBadges.length, 3, "all 3 hydrated history tasks must render task-history-badge");
    assert.equal(view.textOf(historyBadges[0]).trim(), "历史");

    // Task without sourcePageUrl/retryPayload must NOT show a dead Retry button
    const retryButtons = view.findAll(
      (n) => n.type === "button" && view.textOf(n).trim() === "重试",
    );
    assert.equal(retryButtons.length, 1, "only retryable persisted history task should show 重试 button");

    // 1) Open Folder on completed history task calls chrome.downloads.show(777)
    const openFolderBtn = view.findAll(
      (n) => n.type === "button" && view.textOf(n).trim() === "打开文件夹",
    )[0];
    assert.ok(openFolderBtn, "completed history task with chromeDownloadId must show 打开文件夹");
    await view.fire(openFolderBtn, "onClick");
    assert.deepEqual(env.shownDownloads, [777]);

    // 2) Retry on SW-interrupted history task re-parses from sourcePageUrl & completes
    await view.fire(retryButtons[0], "onClick");
    await bg.waitForIdle();
    await view.flush(25);
    assert.equal(retryParseUrls.length, 1);
    assert.match(decodeURIComponent(retryParseUrls[0]), /BV1RetryHist2/);
    const afterRetrySnap = await bg.getSnapshot();
    const retried = afterRetrySnap.tasks.find((t) => t.taskId === "hist-fail-2");
    assert.equal(retried?.status, "completed");
    assert.equal(retried?.persistedFromHistory, undefined);

    // 3) Clear Finished removes all finished & persisted history tasks from memory and storage
    const clearBtn = view.findAll(
      (n) => n.type === "button" && view.textOf(n).trim() === "清空已完成",
    )[0];
    assert.ok(clearBtn, "expected 清空已完成 button");
    await view.fire(clearBtn, "onClick");
    await view.flush(25);
    const afterClearSnap = await bg.getSnapshot();
    assert.equal(afterClearSnap.tasks.length, 0);
    const storedAfterClear = await sharedLocal.get(taskHistoryMod.TASK_HISTORY_STORAGE_KEY);
    assert.equal(storedAfterClear[taskHistoryMod.TASK_HISTORY_STORAGE_KEY], undefined);
  } finally {
    view.unmount();
    bg.dispose();
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
});

// ============================================================================
// 10. Round 1 Red-Team Regressions (G6 Fingerprint/Text Scrub, Refresh Sync, Multi-P Title)
// ============================================================================

test("Round 1 red-team regressions: G6 workFingerprint & full CDN/sensitive-key text scrubbing, refresh-failure history sync, and no double-prefixed multi-P title", async () => {
  // 1) G6 sanitizeFingerprint strips signed URLs, blocked CDN hosts, Bearer tokens, and sensitive params while preserving clean IDs & canonical URLs
  const cleanIdRec = taskHistoryMod.projectTaskToPersistedHistoryRecord({
    taskId: "fp-clean-1",
    title: "Clean ID",
    filename: "clean.mp4",
    platform: "bilibili",
    workFingerprint: "bilibili:BV1uv411q7Mv",
    status: "completed",
    statusText: "已完成",
    percent: 100,
    loaded: 100,
    total: 100,
    speed: 0,
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(cleanIdRec.workFingerprint, "bilibili:BV1uv411q7Mv");

  const cleanUrlRec = taskHistoryMod.projectTaskToPersistedHistoryRecord({
    taskId: "fp-clean-2",
    title: "Clean URL",
    filename: "vimeo.mp4",
    platform: "vimeo",
    workFingerprint: "vimeo:https://vimeo.com/987654321",
    status: "completed",
    statusText: "已完成",
    percent: 100,
    loaded: 100,
    total: 100,
    speed: 0,
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(cleanUrlRec.workFingerprint, "vimeo:https://vimeo.com/987654321");

  const leakyFingerprints = [
    "xiaohongshu:https://www.xiaohongshu.com/explore/abc?xsec_token=SECRET_XSEC",
    "youtube:https://rr1---sn-abc.googlevideo.com/videoplayback?sig=LEAK",
    "douyin:https://v3.douyinstatic.com/asset/12345",
    "zuiyou:https://cdn.xiaochuankeji.cn/raw/item",
    "custom:id?sig=LEAK_SIG",
    "custom:x-amz-signature=AWS_SECRET",
    "custom:Bearer_token_leak Bearer abcdef",
  ];
  for (const fp of leakyFingerprints) {
    const rec = taskHistoryMod.projectTaskToPersistedHistoryRecord({
      taskId: `fp-bad-${fp.slice(0, 8)}`,
      title: "Bad FP",
      filename: "bad.mp4",
      platform: "douyin",
      workFingerprint: fp,
      status: "failed",
      statusText: "失败",
      percent: 0,
      loaded: 0,
      total: 0,
      speed: 0,
      createdAt: 1,
      updatedAt: 2,
    });
    assert.equal(rec.workFingerprint, undefined, `must drop unsafe workFingerprint: ${fp}`);
    const hydrated = taskHistoryMod.hydratePersistedHistoryRecord({
      ...rec,
      workFingerprint: fp,
    });
    assert.equal(hydrated?.workFingerprint, undefined, `hydration must also drop unsafe workFingerprint: ${fp}`);
  }

  // 2) G6 sanitizePersistedText scrubs ALL BLOCKED_CDN hosts (including douyinstatic, snssdk, cdn.xiaochuankeji.cn, media.tumblr.com, yximgs) & ALL SENSITIVE_QUERY_KEYS
  const scrubbedErr = taskHistoryMod.sanitizePersistedText(
    "Failed fetching https://v3.douyinstatic.com/plain/noext and https://cdn.xiaochuankeji.cn/path and https://media.tumblr.com/clip and https://tx.yximgs.com/v1 with xsec_token=SECRET_X auth_key=AK_1 x-amz-signature=AMZ_1 x-amz-credential=CRED_1 x-amz-security-token=SEC_1 x-goog-signature=GOOG_1 lsig=LS_1 sparams=SP_1 sapisid=SA_1",
    1000,
  );
  assert.ok(scrubbedErr);
  for (const leaked of [
    "douyinstatic.com",
    "cdn.xiaochuankeji.cn",
    "media.tumblr.com",
    "yximgs.com",
    "SECRET_X",
    "AK_1",
    "AMZ_1",
    "CRED_1",
    "SEC_1",
    "GOOG_1",
    "LS_1",
    "SP_1",
    "SA_1",
  ]) {
    assert.equal(scrubbedErr.includes(leaked), false, `must redact ${leaked} from persisted text: ${scrubbedErr}`);
  }
  assert.match(scrubbedErr, /\[URL_REDACTED\]/);
  assert.match(scrubbedErr, /xsec_token=\[REDACTED\]/);
  assert.match(scrubbedErr, /x-amz-signature=\[REDACTED\]/);

  // 3) downloadCoordinator persists terminal failure immediately when prepareSpecForDispatch fails refresh
  const refreshLocal = storage.createMemoryStorageArea();
  const refreshEnv = createMockMv3Env({ localArea: refreshLocal });
  const refreshBg = backgroundMod.createBackgroundController({
    chrome: refreshEnv.chrome,
    storage: storage.createExtensionStorage(),
    historyStorage: refreshLocal,
    now: () => Date.parse("2026-11-25T10:00:00Z"),
    fetchImpl: async () => new Response("upstream down", { status: 503 }),
  });
  await refreshBg.init();
  const expiredEnq = await refreshEnv.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "Expired Refresh Failure Sync",
        platform: "bilibili",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://upos-sz-mirrorcos.bilivideo.com/expired.mp4"],
          filename: "DokiTool/expired.mp4",
          refreshContext: {
            parseUrl: "https://www.bilibili.com/video/BV1uv411q7Mv",
            platform: "bilibili",
            itemId: "p1",
            expiresAtMs: Date.parse("2026-11-25T09:00:00Z"),
          },
        },
      },
    ],
  });
  assert.equal(expiredEnq.ok, true);
  await refreshBg.waitForIdle();
  const storedAfterRefreshFail = (await refreshLocal.get(taskHistoryMod.TASK_HISTORY_STORAGE_KEY))?.[
    taskHistoryMod.TASK_HISTORY_STORAGE_KEY
  ];
  assert.ok(Array.isArray(storedAfterRefreshFail) && storedAfterRefreshFail.length === 1);
  assert.equal(storedAfterRefreshFail[0].status, "failed");
  assert.notEqual(
    storedAfterRefreshFail[0].statusText,
    taskHistoryMod.SW_INTERRUPTED_STATUS_TEXT,
    "refresh failure must sync actual failed state to history instead of leaving stale queued/interrupted record",
  );
  refreshBg.dispose();

  // 4) multiPartQueue does NOT double-prefix workTitle when resolved item has empty title & inputItem.title already carries workTitle
  const mpLocal = storage.createMemoryStorageArea();
  const mpEnv = createMockMv3Env({ localArea: mpLocal, autoCompleteDownloads: true });
  const mpBg = backgroundMod.createBackgroundController({
    chrome: mpEnv.chrome,
    storage: storage.createExtensionStorage(),
    historyStorage: mpLocal,
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          makeReadyVideoMedia({
            platform: "bilibili",
            title: "合集主标题",
            items: [
              makeReadyItem("p2", 2, "", "https://upos-sz-mirrorcos.bilivideo.com/p2.mp4"),
            ],
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  await mpBg.init();
  const mpRes = await mpEnv.chrome.runtime.sendMessage({
    type: "ENQUEUE_MULTIPART_ITEMS",
    media: {
      platform: "bilibili",
      title: "合集主标题",
      sourceUrl: "https://www.bilibili.com/video/BV1uv411q7Mv",
      totalItemCount: 2,
    },
    items: [
      {
        itemId: "p2",
        index: 2,
        title: "合集主标题 #2",
        state: "deferred",
        resolveUrl:
          "/api/resolve?schema_version=1.0&url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1uv411q7Mv&item_id=p2",
      },
    ],
  });
  assert.equal(mpRes.ok, true);
  await mpBg.waitForIdle();
  const mpSnap = await mpBg.getSnapshot();
  assert.equal(mpSnap.tasks[0].title, "合集主标题 #2");
  assert.equal(mpSnap.tasks[0].title.includes("合集主标题 - 合集主标题"), false);
  assert.match(mpSnap.tasks[0].filename, /002\.mp4$/);
  mpBg.dispose();
});

// ============================================================================
// 11. Batch 1A (v4.4.1): SidePanelHeader Upgrade Pill & SidePanelSettings Copy
// ============================================================================

test("Batch 1A (v4.4.1): SidePanelHeader silent version check renders upgrade pill when outdated, opens same-origin zip via chrome.tabs.create, aborts on unmount; SidePanelSettings preserves toggle testid and de-jargonized copy", async () => {
  const [SidePanelHeader, SidePanelSettings] = await Promise.all([
    loadSidePanelSfc("../src/extension/components/SidePanelHeader.vue"),
    loadSidePanelSfc("../src/extension/components/SidePanelSettings.vue"),
  ]);

  const origChrome = globalThis.chrome;
  const openedTabs = [];
  const fetchCalls = [];
  try {
    globalThis.chrome = {
      runtime: {
        getManifest: () => ({ version: "4.4.0" }),
      },
      tabs: {
        create(opts) {
          openedTabs.push(opts.url);
        },
      },
    };

    const outdatedView = mountSfcTree(SidePanelHeader, {
      settings: { ...storage.DEFAULT_EXTENSION_SETTINGS },
      connection: null,
      mode: "single",
      batchUrlCount: 0,
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            version: "4.4.1",
            download_url: "/helper/dokitool-chrome-extension.zip",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    try {
      await outdatedView.flush(20);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, "https://snap.dokitool.com/helper/extension-version.json");
      assert.equal(fetchCalls[0].init.credentials, "omit");
      assert.equal(fetchCalls[0].init.cache, "no-cache");

      const pill = outdatedView.findAll(
        (n) => n.props["data-testid"] === "sidepanel-update-pill",
      )[0];
      assert.ok(pill, "expected sidepanel-update-pill when installed 4.4.0 < remote 4.4.1");
      assert.match(outdatedView.textOf(pill), /新版本 v4\.4\.1/);

      await outdatedView.fire(pill, "onClick");
      assert.deepEqual(openedTabs, [
        "https://snap.dokitool.com/helper/dokitool-chrome-extension.zip",
      ]);
    } finally {
      outdatedView.unmount();
    }

    // Up-to-date installed version (4.4.1 === 4.4.1) hides upgrade pill
    const upToDateView = mountSfcTree(SidePanelHeader, {
      settings: { ...storage.DEFAULT_EXTENSION_SETTINGS },
      connection: null,
      mode: "single",
      batchUrlCount: 0,
      installedVersion: "4.4.1",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            version: "4.4.1",
            download_url: "/helper/dokitool-chrome-extension.zip",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });
    try {
      await upToDateView.flush(20);
      assert.equal(
        upToDateView.findAll((n) => n.props["data-testid"] === "sidepanel-update-pill").length,
        0,
        "must hide upgrade pill when installed version is up to date",
      );
    } finally {
      upToDateView.unmount();
    }

    // Unmounting mid-flight aborts the single version-check request cleanly
    let abortedOnUnmount = false;
    const abortView = mountSfcTree(SidePanelHeader, {
      settings: { ...storage.DEFAULT_EXTENSION_SETTINGS },
      connection: null,
      mode: "single",
      batchUrlCount: 0,
      installedVersion: "4.4.0",
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            abortedOnUnmount = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    });
    await abortView.flush(10);
    abortView.unmount();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(abortedOnUnmount, true, "unmounting SidePanelHeader must abort in-flight version check");

    // SidePanelSettings preserves data-testid="save-file-picker-toggle" and updated copy
    const settingsView = mountSfcTree(SidePanelSettings, {
      open: true,
      settings: { ...storage.DEFAULT_EXTENSION_SETTINGS },
      connection: null,
    });
    try {
      await settingsView.flush();
      const toggle = settingsView.findAll(
        (n) => n.props["data-testid"] === "save-file-picker-toggle",
      )[0];
      assert.ok(toggle, 'SidePanelSettings must preserve data-testid="save-file-picker-toggle"');
      const fullText = settingsView.textOf();
      assert.ok(fullText.includes("下载时询问保存位置"));
      assert.ok(
        fullText.includes(
          "单文件直下时弹出系统“另存为”窗口自选保存目录（合流 / 批量 / ZIP 仍保存至默认下载目录），同时可避免其他下载插件篡改文件名",
        ),
      );
    } finally {
      settingsView.unmount();
    }
  } finally {
    if (origChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = origChrome;
  }
});
