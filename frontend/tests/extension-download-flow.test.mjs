import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { build, stop } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(__dirname, "..");

let tmpBundleDir = "";
let protocol;
let storage;
let youtubeBridgeMod;
let extensionDownloadMod;
let offscreenMod;
let backgroundMod;
let mediabunny;
let JSZip;

async function bundleExtensionSuite() {
  tmpBundleDir = mkdtempSync(join(tmpdir(), "dokitool-ext-test-"));
  const outfile = join(tmpBundleDir, "suite.mjs");
  await build({
    stdin: {
      contents: `
        import JSZipDefault from "jszip";
        export * as mediabunny from "mediabunny";
        export const JSZip = JSZipDefault;
        export * as protocol from "./src/extension/protocol.ts";
        export * as storage from "./src/extension/storage.ts";
        export * as youtubeBridgeMod from "./src/extension/youtubeExtensionBridge.ts";
        export * as extensionDownloadMod from "./src/extension/extensionDownload.ts";
        export * as offscreenMod from "./src/extension/offscreen.ts";
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
  const suite = await bundleExtensionSuite();
  protocol = suite.protocol;
  storage = suite.storage;
  youtubeBridgeMod = suite.youtubeBridgeMod;
  extensionDownloadMod = suite.extensionDownloadMod;
  offscreenMod = suite.offscreenMod;
  backgroundMod = suite.backgroundMod;
  mediabunny = suite.mediabunny;
  JSZip = suite.JSZip;
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
// Mock Web Locks, OPFS, URL Object Registry & MV3 Chrome Runtime Bus
// ============================================================================

function createMockWebLocks() {
  const held = new Map();
  const queues = new Map();

  function pump(name) {
    if (held.has(name)) return;
    const q = queues.get(name);
    if (!q || q.length === 0) {
      queues.delete(name);
      return;
    }
    const next = q.shift();
    if (q.length === 0) queues.delete(name);
    next();
  }

  return {
    held,
    request(name, optionsOrCallback, maybeCallback) {
      const opts =
        typeof optionsOrCallback === "function" ? {} : optionsOrCallback || {};
      const callback =
        typeof optionsOrCallback === "function"
          ? optionsOrCallback
          : maybeCallback;
      const mode = opts.mode || "exclusive";
      if (opts.ifAvailable) {
        if (held.has(name)) {
          return Promise.resolve().then(() => callback(null));
        }
        const lockObj = { name, mode };
        held.set(name, lockObj);
        return Promise.resolve()
          .then(() => callback(lockObj))
          .finally(() => {
            if (held.get(name) === lockObj) held.delete(name);
            pump(name);
          });
      }
      return new Promise((resolvePromise, rejectPromise) => {
        const grant = () => {
          const lockObj = { name, mode };
          held.set(name, lockObj);
          Promise.resolve()
            .then(() => callback(lockObj))
            .then(resolvePromise, rejectPromise)
            .finally(() => {
              if (held.get(name) === lockObj) held.delete(name);
              pump(name);
            });
        };
        if (!held.has(name)) {
          grant();
        } else {
          if (!queues.has(name)) queues.set(name, []);
          queues.get(name).push(grant);
        }
      });
    },
  };
}

function createMockOpfs({
  quota = 500_000_000,
  initialFiles = {},
  now = () => Date.now(),
} = {}) {
  const files = new Map();
  const lastModifiedMap = new Map();
  const activeWriteLocks = new Set();
  const locks = createMockWebLocks();

  for (const [name, content] of Object.entries(initialFiles)) {
    files.set(
      name,
      content instanceof Uint8Array
        ? content
        : new TextEncoder().encode(String(content)),
    );
    lastModifiedMap.set(name, now() - 120_000);
  }

  const root = {
    async *entries() {
      for (const name of [...files.keys()]) {
        yield [name, { kind: "file", name }];
      }
    },
    async getFileHandle(name, opts = {}) {
      if (!files.has(name)) {
        if (!opts?.create) {
          throw new DOMException("File not found", "NotFoundError");
        }
        files.set(name, new Uint8Array(0));
        lastModifiedMap.set(name, now());
      }
      return {
        kind: "file",
        name,
        async createWritable() {
          if (activeWriteLocks.has(name)) {
            throw new DOMException("Locked", "NoModificationAllowedError");
          }
          activeWriteLocks.add(name);
          const chunks = [];
          let cursor = 0;
          let closed = false;
          return {
            async write(chunk) {
              if (closed) throw new Error("Writable already closed");
              if (chunk && typeof chunk === "object" && chunk.type === "write") {
                if (typeof chunk.position === "number") cursor = chunk.position;
                const bytes =
                  chunk.data instanceof Uint8Array
                    ? chunk.data
                    : new Uint8Array(chunk.data);
                chunks.push({ pos: cursor, bytes: bytes.slice() });
                cursor += bytes.byteLength;
                return;
              }
              const bytes =
                chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
              chunks.push({ pos: cursor, bytes: bytes.slice() });
              cursor += bytes.byteLength;
            },
            async seek(pos) {
              cursor = Number(pos) || 0;
            },
            async close() {
              if (closed) return;
              closed = true;
              activeWriteLocks.delete(name);
              let maxLen = 0;
              for (const c of chunks) {
                maxLen = Math.max(maxLen, c.pos + c.bytes.byteLength);
              }
              const out = new Uint8Array(maxLen);
              for (const c of chunks) {
                out.set(c.bytes, c.pos);
              }
              files.set(name, out);
              lastModifiedMap.set(name, now());
            },
            async abort() {
              closed = true;
              activeWriteLocks.delete(name);
            },
          };
        },
        async getFile() {
          if (!files.has(name)) {
            throw new DOMException("File not found", "NotFoundError");
          }
          const bytes = files.get(name);
          const blob = new Blob([bytes]);
          Object.defineProperty(blob, "name", { value: name });
          Object.defineProperty(blob, "lastModified", {
            value: lastModifiedMap.get(name) ?? now(),
          });
          return blob;
        },
      };
    },
    async removeEntry(name) {
      if (activeWriteLocks.has(name)) {
        throw new DOMException("Locked", "InvalidModificationError");
      }
      if (!files.has(name)) {
        throw new DOMException("File not found", "NotFoundError");
      }
      files.delete(name);
      lastModifiedMap.delete(name);
    },
  };

  return {
    files,
    locks,
    storage: {
      async estimate() {
        let usage = 0;
        for (const b of files.values()) usage += b.byteLength;
        return { quota, usage };
      },
      async getDirectory() {
        return root;
      },
    },
  };
}

function createTrackedUrlApi() {
  let seq = 0;
  const activeBlobs = new Map();
  const createdUrls = [];
  const revokedUrls = [];

  return {
    activeBlobs,
    createdUrls,
    revokedUrls,
    createObjectURL(blob) {
      const url = `blob:chrome-extension://dokitooltestext/${++seq}`;
      activeBlobs.set(url, blob);
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL(url) {
      activeBlobs.delete(url);
      revokedUrls.push(url);
    },
  };
}

/**
 * Full MV3 Chrome broadcast bus simulating `background`, `offscreen`, and `sidepanel`
 * sharing `chrome.runtime.onMessage` (so any listener returning `true` for someone else's
 * message would break RPCs — testing our MV3 IPC contract!).
 */
function createMockMv3Environment({
  extensionId = "abcdefghijklmnopabcdefghijklmnop",
  autoCompleteDownloads = false,
  rejectDownloadWith = null,
  spawnOffscreenHook = null,
} = {}) {
  const messageListeners = new Set();
  const connectListeners = new Set();
  const contextMenuListeners = new Set();
  const commandListeners = new Set();
  const downloadChangedListeners = new Set();
  const tabActivatedListeners = new Set();
  const tabUpdatedListeners = new Set();

  const dnrRulesState = new Map();
  const createdMenus = [];
  const badgeHistory = [];
  const sidePanelOpenCalls = [];
  const shownDownloads = [];
  const cancelledDownloads = [];
  const downloadCalls = [];
  const tabsById = new Map([[1, { id: 1, windowId: 10, active: true, url: "https://example.com/" }]]);

  let offscreenOpen = false;
  let offscreenCloseCount = 0;
  let offscreenCreateCount = 0;
  let nextDownloadId = 100;

  const runtime = {
    id: extensionId,
    getManifest() {
      return {
        host_permissions: ["https://snap.dokitool.com/*"],
        optional_host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
      };
    },
    async getContexts({ contextTypes } = {}) {
      if (
        offscreenOpen &&
        (!contextTypes || contextTypes.includes("OFFSCREEN_DOCUMENT"))
      ) {
        return [{ contextType: "OFFSCREEN_DOCUMENT", documentUrl: `chrome-extension://${extensionId}/offscreen.html` }];
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
    sendMessage(message) {
      return new Promise((resolvePromise) => {
        let responded = false;
        let asyncResponderCount = 0;
        const sendResponse = (resp) => {
          if (responded) {
            throw new Error(
              `MV3 IPC race: multiple listeners called sendResponse for ${message?.type}`,
            );
          }
          responded = true;
          resolvePromise(resp);
        };
        for (const listener of [...messageListeners]) {
          const ret = listener(message, { id: extensionId }, sendResponse);
          if (ret === true) {
            asyncResponderCount += 1;
          }
        }
        if (asyncResponderCount > 1) {
          throw new Error(
            `MV3 IPC violation: ${asyncResponderCount} listeners returned true for ${message?.type}`,
          );
        }
        if (asyncResponderCount === 0 && !responded) {
          resolvePromise(undefined);
        }
      });
    },
    connect({ name } = {}) {
      const clientMsgListeners = new Set();
      const serverMsgListeners = new Set();
      const clientDiscListeners = new Set();
      const serverDiscListeners = new Set();

      const clientPort = {
        name,
        postMessage(msg) {
          for (const fn of [...serverMsgListeners]) fn(structuredClone(msg));
        },
        disconnect() {
          for (const fn of [...serverDiscListeners]) fn();
        },
        onMessage: {
          addListener(fn) {
            clientMsgListeners.add(fn);
          },
        },
        onDisconnect: {
          addListener(fn) {
            clientDiscListeners.add(fn);
          },
        },
      };

      const serverPort = {
        name,
        postMessage(msg) {
          for (const fn of [...clientMsgListeners]) fn(structuredClone(msg));
        },
        disconnect() {
          for (const fn of [...clientDiscListeners]) fn();
        },
        onMessage: {
          addListener(fn) {
            serverMsgListeners.add(fn);
          },
        },
        onDisconnect: {
          addListener(fn) {
            serverDiscListeners.add(fn);
          },
        },
      };

      for (const fn of [...connectListeners]) {
        fn(serverPort);
      }
      return clientPort;
    },
  };

  const chrome = {
    runtime,
    declarativeNetRequest: {
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        for (const id of removeRuleIds) dnrRulesState.delete(id);
        for (const rule of addRules) dnrRulesState.set(rule.id, rule);
      },
      async getDynamicRules() {
        return [...dnrRulesState.values()];
      },
    },
    sidePanel: {
      async setPanelBehavior() {},
      open(opts) {
        sidePanelOpenCalls.push({ opts });
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
    commands: {
      onCommand: {
        addListener(fn) {
          commandListeners.add(fn);
        },
      },
    },
    tabs: {
      async query() {
        return [...tabsById.values()].filter((t) => t.active);
      },
      async get(tabId) {
        return tabsById.get(tabId);
      },
      onActivated: {
        addListener(fn) {
          tabActivatedListeners.add(fn);
        },
      },
      onUpdated: {
        addListener(fn) {
          tabUpdatedListeners.add(fn);
        },
      },
    },
    offscreen: {
      async createDocument(params) {
        offscreenCreateCount += 1;
        offscreenOpen = true;
        if (typeof spawnOffscreenHook === "function") {
          await spawnOffscreenHook(params);
        }
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
        if (rejectDownloadWith) {
          throw rejectDownloadWith;
        }
        const id = ++nextDownloadId;
        downloadCalls.push({ id, ...opts });
        if (autoCompleteDownloads) {
          queueMicrotask(() => {
            for (const fn of [...downloadChangedListeners]) {
              fn({ id, state: { current: "complete" } });
            }
          });
        }
        return id;
      },
      async cancel(id) {
        cancelledDownloads.push(id);
      },
      show(id) {
        shownDownloads.push(id);
      },
      onChanged: {
        addListener(fn) {
          downloadChangedListeners.add(fn);
        },
      },
    },
    action: {
      setBadgeText({ text }) {
        badgeHistory.push({ kind: "text", text });
      },
      setBadgeBackgroundColor({ color }) {
        badgeHistory.push({ kind: "color", color });
      },
    },
    permissions: {
      async contains() {
        return false;
      },
      onAdded: {
        addListener() {},
      },
    },
  };

  return {
    chrome,
    dnrRulesState,
    createdMenus,
    badgeHistory,
    sidePanelOpenCalls,
    shownDownloads,
    cancelledDownloads,
    downloadCalls,
    tabsById,
    isOffscreenOpen: () => offscreenOpen,
    getOffscreenCreateCount: () => offscreenCreateCount,
    getOffscreenCloseCount: () => offscreenCloseCount,
    emitDownloadChanged(delta) {
      for (const fn of [...downloadChangedListeners]) fn(delta);
    },
    emitContextMenuClick(info, tab) {
      for (const fn of [...contextMenuListeners]) fn(info, tab);
    },
    emitCommand(command, tab) {
      for (const fn of [...commandListeners]) fn(command, tab);
    },
    emitTabUpdated(tabId, changeInfo, tab) {
      tabsById.set(tabId, tab);
      for (const fn of [...tabUpdatedListeners]) fn(tabId, changeInfo, tab);
    },
    emitTabActivated(tabId, windowId = 10) {
      for (const t of tabsById.values()) t.active = t.id === tabId;
      for (const fn of [...tabActivatedListeners]) fn({ tabId, windowId });
    },
  };
}

async function createSyntheticMp4MuxStreams() {
  const avcC = new Uint8Array([
    1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x09, 0x67, 0x42, 0xc0, 0x1e, 0xd9,
    0x03, 0xc8, 0x40, 0x00, 0x01, 0x00, 0x04, 0x68, 0xcb, 0x83, 0xcb,
  ]);
  const videoTarget = new mediabunny.BufferTarget();
  const videoOut = new mediabunny.Output({
    format: new mediabunny.Mp4OutputFormat({ fastStart: "fragmented" }),
    target: videoTarget,
  });
  const videoSrc = new mediabunny.EncodedVideoPacketSource("avc");
  videoOut.addVideoTrack(videoSrc);
  await videoOut.start();
  for (let i = 0; i < 4; i++) {
    const nal = new Uint8Array(1024);
    new DataView(nal.buffer).setUint32(0, 1020);
    nal[4] = i === 0 ? 0x65 : 0x41;
    await videoSrc.add(
      new mediabunny.EncodedPacket(
        nal,
        i === 0 ? "key" : "delta",
        i * 0.04,
        0.04,
      ),
      i === 0
        ? {
            decoderConfig: {
              codec: "avc1.42c01e",
              codedWidth: 1920,
              codedHeight: 1080,
              description: avcC,
            },
          }
        : undefined,
    );
  }
  videoSrc.close();
  await videoOut.finalize();

  const audioTarget = new mediabunny.BufferTarget();
  const audioOut = new mediabunny.Output({
    format: new mediabunny.Mp4OutputFormat({ fastStart: "fragmented" }),
    target: audioTarget,
  });
  const audioSrc = new mediabunny.EncodedAudioPacketSource("aac");
  audioOut.addAudioTrack(audioSrc);
  await audioOut.start();
  for (let i = 0; i < 4; i++) {
    const frame = new Uint8Array(512);
    frame[0] = 0xde;
    await audioSrc.add(
      new mediabunny.EncodedPacket(frame, "key", i * 0.04, 0.04),
      i === 0
        ? {
            decoderConfig: {
              codec: "mp4a.40.2",
              numberOfChannels: 2,
              sampleRate: 48000,
              description: new Uint8Array([0x11, 0x90]),
            },
          }
        : undefined,
    );
  }
  audioSrc.close();
  await audioOut.finalize();

  return {
    videoBytes: new Uint8Array(videoTarget.buffer),
    audioBytes: new Uint8Array(audioTarget.buffer),
  };
}

// ============================================================================
// Test 1: Authoritative HANDOFF_BLOB_DOWNLOAD -> onChanged("complete" | "interrupted")
//         RELEASE_BLOB, OPFS cleanup, MV3 IPC non-interference, and idle close
// ============================================================================

test("Offscreen <-> Background: authoritative RELEASE_BLOB only after downloads.onChanged(complete|interrupted), zero premature revokes, zero leaked OPFS files", async () => {
  const opfs = createMockOpfs({
    initialFiles: {
      "dokitool-ext-crashed-old.tmp": "stale-ext-bytes",
      "dokitool-yt-tmp-crashed-old.part": "stale-yt-bytes",
    },
  });
  const urlApi = createTrackedUrlApi();
  const fetchCalls = [];
  const mediaPayload = new TextEncoder().encode("hello-4k-video-stream-bytes-1234567890");

  const mockFetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return new Response(mediaPayload, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(mediaPayload.byteLength),
      },
    });
  };

  let offscreenCtrl = null;
  const env = createMockMv3Environment({
    autoCompleteDownloads: false,
    async spawnOffscreenHook() {
      if (!offscreenCtrl) {
        offscreenCtrl = offscreenMod.createOffscreenController({
          chrome: env.chrome,
          fetchImpl: mockFetch,
          opfsStorage: opfs.storage,
          webLocks: opfs.locks,
          urlApi,
          progressThrottleMs: 0,
        });
        await offscreenCtrl.cleanupBootPromise;
      }
    },
  });

  // Attach a simulated SidePanel fallback listener to verify zero MV3 sendMessage collision
  env.chrome.runtime.onMessage.addListener((msg) => {
    if (protocol.isBackgroundBroadcast(msg)) {
      return false;
    }
    return false;
  });

  const extStorage = storage.createExtensionStorage();
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    fetchImpl: mockFetch,
    offscreenIdleCloseMs: 60,
    badgeSuccessDurationMs: 60,
  });
  await bg.init();

  // Verify dynamic DNR rules synced on init
  assert.equal(env.dnrRulesState.size, 5);

  // Connect SidePanel Port and verify immediate STATE_SNAPSHOT
  const spMessages = [];
  const spPort = env.chrome.runtime.connect({
    name: protocol.SIDEPANEL_PORT_NAME,
  });
  spPort.onMessage.addListener((m) => spMessages.push(m));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(spMessages[0]?.type, "STATE_SNAPSHOT");

  // Enqueue a direct_file download
  const enqueueResp = await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "测试B站视频",
        platform: "bilibili",
        workFingerprint: "bilibili:BV1xx411c7mD",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/test.mp4"],
          filename: "DokiTool/测试B站视频.mp4",
          mimeType: "video/mp4",
          sizeBytes: mediaPayload.byteLength,
        },
      },
    ],
  });
  assert.equal(enqueueResp.ok, true);
  const taskId = enqueueResp.data.taskIds[0];

  // Wait until chrome.downloads.download has been called (handoff reached background)
  for (let i = 0; i < 50 && env.downloadCalls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(env.downloadCalls.length, 1);
  const dlCall = env.downloadCalls[0];
  assert.equal(dlCall.filename, "DokiTool/测试B站视频.mp4");
  assert.equal(dlCall.saveAs, false);
  assert.equal(dlCall.conflictAction, "uniquify");

  // Stale crash leftovers were swept on offscreen boot, while the active OPFS file is STILL held!
  assert.equal(opfs.files.has("dokitool-ext-crashed-old.tmp"), false);
  assert.equal(opfs.files.has("dokitool-yt-tmp-crashed-old.part"), false);
  assert.equal(opfs.files.size, 1, "active OPFS temp file must remain alive during download");
  assert.equal(urlApi.activeBlobs.size, 1, "Blob URL must NOT be prematurely revoked");
  assert.equal(
    [...urlApi.activeBlobs.values()][0].type,
    "video/mp4",
    "OPFS temp file must be wrapped with authoritative media MIME type so Chrome never rewrites .mp4 to .txt",
  );
  assert.equal(urlApi.revokedUrls.length, 0);

  // Non-terminal `in_progress` delta MUST NOT revoke Blob URL or delete OPFS file!
  env.emitDownloadChanged({
    id: dlCall.id,
    state: { previous: "in_progress", current: "in_progress" },
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(urlApi.activeBlobs.size, 1);
  assert.equal(opfs.files.size, 1);

  // Running cleanup sweep while lock is held MUST NOT delete the locked in-flight OPFS file!
  await extensionDownloadMod.cleanupStaleExtensionOpfsFiles({
    storage: opfs.storage,
    locks: opfs.locks,
  });
  assert.equal(opfs.files.size, 1);

  // Now emit authoritative `complete` from chrome.downloads.onChanged!
  env.emitDownloadChanged({
    id: dlCall.id,
    state: { previous: "in_progress", current: "complete" },
  });
  await bg.waitForIdle();
  await offscreenCtrl.executor.waitForIdle();

  assert.equal(urlApi.activeBlobs.size, 0, "Blob URL revoked immediately after complete");
  assert.equal(urlApi.revokedUrls.length, 1);
  assert.equal(opfs.files.size, 0, "OPFS temp file deleted with 0 leaks");

  const snap = await bg.getSnapshot();
  assert.equal(snap.tasks[0].status, "completed");
  assert.equal(snap.tasks[0].chromeDownloadId, dlCall.id);
  assert.ok(snap.savedWorkFingerprints.includes("bilibili:BV1xx411c7mD"));

  // Verify OPEN_DOWNLOAD_FOLDER triggers chrome.downloads.show(dlCall.id)
  const openResp = await env.chrome.runtime.sendMessage({
    type: "OPEN_DOWNLOAD_FOLDER",
    taskId,
  });
  assert.equal(openResp.ok, true);
  assert.equal(openResp.data.opened, true);
  assert.deepEqual(env.shownDownloads, [dlCall.id]);

  // Verify fetch strictly enforced credentials: "omit" & referrerPolicy: "no-referrer"
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.credentials, "omit");
  assert.equal(fetchCalls[0].init.referrerPolicy, "no-referrer");

  // Wait for idle offscreen auto-close timer (60ms in test)
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(env.isOffscreenOpen(), false);
  assert.ok(env.getOffscreenCloseCount() >= 1);

  offscreenCtrl?.dispose();
  bg.dispose();
});

test("Offscreen <-> Background: interrupted download and immediate downloads.download rejection both release Blob & OPFS cleanly", async () => {
  const opfs = createMockOpfs();
  const urlApi = createTrackedUrlApi();
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const mockFetch = async () =>
    new Response(payload, {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    });

  let shouldRejectDownload = false;
  let offscreenCtrl = null;
  const env = createMockMv3Environment({
    autoCompleteDownloads: false,
    async spawnOffscreenHook() {
      if (!offscreenCtrl) {
        offscreenCtrl = offscreenMod.createOffscreenController({
          chrome: env.chrome,
          fetchImpl: mockFetch,
          opfsStorage: opfs.storage,
          webLocks: opfs.locks,
          urlApi,
        });
      }
    },
  });

  const origDownload = env.chrome.downloads.download;
  env.chrome.downloads.download = async (opts) => {
    if (shouldRejectDownload) {
      throw new Error("Download blocked by user policy");
    }
    return origDownload(opts);
  };

  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: storage.createExtensionStorage(),
    fetchImpl: mockFetch,
  });
  await bg.init();

  // Case A: interrupted via onChanged
  await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "图1",
        platform: "weibo",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://wx1.sinaimg.cn/large/pic1.jpg"],
          filename: "pic1.jpg",
          mimeType: "image/jpeg",
        },
      },
    ],
  });

  for (let i = 0; i < 50 && env.downloadCalls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  env.emitDownloadChanged({
    id: env.downloadCalls[0].id,
    state: { current: "interrupted" },
    error: { current: "NETWORK_FAILED" },
  });
  await bg.waitForIdle();
  await offscreenCtrl.executor.waitForIdle();

  assert.equal(urlApi.activeBlobs.size, 0);
  assert.equal(opfs.files.size, 0);
  assert.equal((await bg.getSnapshot()).tasks[0].status, "failed");

  // Case B: immediate rejection from chrome.downloads.download
  shouldRejectDownload = true;
  await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "图2",
        platform: "weibo",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://wx2.sinaimg.cn/large/pic2.jpg"],
          filename: "pic2.jpg",
          mimeType: "image/jpeg",
        },
      },
    ],
  });
  await bg.waitForIdle();
  await offscreenCtrl.executor.waitForIdle();

  assert.equal(urlApi.activeBlobs.size, 0);
  assert.equal(opfs.files.size, 0);

  offscreenCtrl?.dispose();
  bg.dispose();
});

test("extensionDownload: multi-route sequential fallback, UNWHITELISTED_CDN block without fetching, HLS BYTERANGE & ZIP STORE", async () => {
  const opfs = createMockOpfs();
  const urlApi = createTrackedUrlApi();
  const fetchedUrls = [];
  const fetchedCredentials = [];
  const handedOffFiles = [];

  const mockFetch = async (url, init) => {
    fetchedUrls.push(url);
    fetchedCredentials.push({
      credentials: init?.credentials,
      referrerPolicy: init?.referrerPolicy,
      range: init?.headers?.Range,
    });

    if (url.includes("fail-mirror.bilivideo.com")) {
      return new Response("upstream bad gateway", { status: 502 });
    }
    if (url.includes("good-mirror.bilivideo.com")) {
      return new Response(new Uint8Array([10, 20, 30, 40]), {
        status: 200,
        headers: { "Content-Type": "video/mp4" },
      });
    }
    if (url === "https://v.douyinvod.com/hls/master.m3u8") {
      const m3u8 = [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="4@0"',
        "#EXT-X-BYTERANGE:4@4",
        "init.mp4",
        "#EXT-X-ENDLIST",
      ].join("\n");
      return new Response(m3u8, {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl" },
      });
    }
    if (url === "https://v.douyinvod.com/hls/init.mp4") {
      const full = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      if (init?.headers?.Range === "bytes=0-3") {
        return new Response(full.slice(0, 4), {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Range": "bytes 0-3/8",
          },
        });
      }
      if (init?.headers?.Range === "bytes=4-7") {
        return new Response(full.slice(4, 8), {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Range": "bytes 4-7/8",
          },
        });
      }
    }
    if (url.startsWith("https://wx1.sinaimg.cn/large/")) {
      return new Response(new TextEncoder().encode(`img:${url}`), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const errors = [];
  const executor = extensionDownloadMod.createOffscreenDownloadExecutor({
    fetchImpl: mockFetch,
    opfsStorage: opfs.storage,
    webLocks: opfs.locks,
    urlApi,
    onError: (err) => errors.push(err),
    async handoffBlobDownload(msg) {
      const blob = urlApi.activeBlobs.get(msg.blobUrl);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      handedOffFiles.push({ filename: msg.filename, bytes });
      queueMicrotask(() => {
        executor.releaseBlob({
          taskId: msg.taskId,
          blobUrl: msg.blobUrl,
          opfsTempName: msg.opfsTempName,
        });
      });
      return { chromeDownloadId: 1 };
    },
  });

  // 1) Multi-route fallback: route 1 fails (502), route 2 succeeds
  executor.startTask("t-fallback", {
    kind: "direct_file",
    apiOrigin: "https://snap.dokitool.com",
    routes: [
      "https://fail-mirror.bilivideo.com/v.mp4",
      "https://good-mirror.bilivideo.com/v.mp4",
    ],
    filename: "fallback.mp4",
    mimeType: "video/mp4",
  });
  await executor.waitForIdle();
  assert.equal(handedOffFiles.length, 1);
  assert.deepEqual([...handedOffFiles[0].bytes], [10, 20, 30, 40]);

  // 2) Unwhitelisted CDN blocked BEFORE fetch is ever invoked!
  executor.startTask("t-unwhitelisted", {
    kind: "direct_file",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://rogue-cdn.evil.example/steal.mp4"],
    filename: "blocked.mp4",
  });
  await executor.waitForIdle();
  assert.equal(
    fetchedUrls.some((u) => u.includes("evil.example")),
    false,
    "must NEVER call fetch for unwhitelisted domain",
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "UNWHITELISTED_CDN");
  assert.equal(errors[0].unwhitelistedHost, "rogue-cdn.evil.example");
  assert.equal(errors[0].fallbackUrl, "https://rogue-cdn.evil.example/steal.mp4");

  // 3) HLS VOD with EXT-X-MAP + BYTERANGE concatenated into single OPFS file
  executor.startTask("t-hls", {
    kind: "hls",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://v.douyinvod.com/hls/master.m3u8"],
    filename: "hls-merged.mp4",
    mimeType: "video/mp4",
  });
  await executor.waitForIdle();
  assert.equal(handedOffFiles.length, 2);
  assert.deepEqual([...handedOffFiles[1].bytes], [1, 2, 3, 4, 5, 6, 7, 8]);

  // 4) Batch ZIP (STORE compression) + OPFS cleanup
  executor.startTask("t-zip", {
    kind: "batch_zip",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://wx1.sinaimg.cn/large/1.jpg"],
    filename: "DokiTool/微博图集.zip",
    zipEntries: [
      { entryName: "001.jpg", routes: ["https://wx1.sinaimg.cn/large/1.jpg"] },
      { entryName: "002.jpg", routes: ["https://wx1.sinaimg.cn/large/2.jpg"] },
    ],
  });
  await executor.waitForIdle();
  assert.equal(handedOffFiles.length, 3);
  const loadedZip = await JSZip.loadAsync(handedOffFiles[2].bytes);
  assert.deepEqual(Object.keys(loadedZip.files).sort(), ["001.jpg", "002.jpg"]);
  assert.equal(
    await loadedZip.file("001.jpg").async("string"),
    "img:https://wx1.sinaimg.cn/large/1.jpg",
  );

  // Every fetch call enforced credentials: "omit" and referrerPolicy: "no-referrer"
  for (const call of fetchedCredentials) {
    assert.equal(call.credentials, "omit");
    assert.equal(call.referrerPolicy, "no-referrer");
  }
  assert.equal(opfs.files.size, 0);
  assert.equal(urlApi.activeBlobs.size, 0);

  // 5) Verify Weibo anonymous relay + Bearer direct URL resolution in buildEnqueueItemsForMedia
  const weiboRelayMedia = {
    platform: "weibo",
    content_id: "5001",
    title: "微博匿名视频",
    items: [
      {
        id: "v1",
        type: "video",
        variants: [
          {
            id: "1080p",
            label: "mp4_1080p_mp4",
            metadata: { width: 1920, height: 1080, extension: "mp4", has_audio: true },
            delivery: {
              kind: "file",
              sources: [{ url: "/api/media/weibo?ticket=tok123", access: "relay" }],
            },
          },
        ],
        default: {
          variant_id: "1080p",
          url: "/api/media/weibo?ticket=tok123",
          access: "relay",
        },
      },
    ],
  };
  const relayItems = extensionDownloadMod.buildEnqueueItemsForMedia(
    weiboRelayMedia,
    { apiOrigin: "http://127.0.0.1:18080" },
  );
  assert.equal(
    relayItems[0].spec.routes[0],
    "http://127.0.0.1:18080/api/media/weibo?ticket=tok123",
  );
  assert.ok(relayItems[0].spec.extraAllowedOrigins.includes("http://127.0.0.1:18080"));

  executor.dispose();
});

// ============================================================================
// Test 3: Zero-diff youtubeHelperCore.js adapter (TVHTML5 player + 4K MP4/M4A mux)
// ============================================================================

test("YouTube zero-diff adapter: 0 git diff on protected files, strips forbidden headers, runs 3-step TVHTML5 parse & Mediabunny OPFS mux into subfolder", async () => {
  // 1) Verify strict 0 diff on protected YouTube helper files!
  const diffOutput = execFileSync(
    "git",
    [
      "diff",
      "--",
      "src/utils/youtubeHelperCore.js",
      "src/utils/youtubeHelperEntry.js",
      "public/helper/dokitool-youtube.user.js",
    ],
    { cwd: FRONTEND_DIR, encoding: "utf8" },
  );
  assert.equal(diffOutput, "", "Protected YouTube helper files MUST have 0 diff");

  const { videoBytes, audioBytes } = await createSyntheticMp4MuxStreams();
  const opfs = createMockOpfs();
  const urlApi = createTrackedUrlApi();
  const observedRequests = [];
  const savedFiles = new Map();

  const videoUrl = `https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=9999999999&itag=137&clen=${videoBytes.byteLength}`;
  const audioUrl = `https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=9999999999&itag=140&clen=${audioBytes.byteLength}`;

  const mockFetch = async (url, init) => {
    observedRequests.push({
      url,
      method: init?.method || "GET",
      headers: init?.headers || {},
      credentials: init?.credentials,
      referrerPolicy: init?.referrerPolicy,
    });

    if (url === "https://snap.dokitool.com/api/youtube/context?schema_version=1.0") {
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            player_id: "abcd1234",
            signature_timestamp: 20123,
            client: { name: "TVHTML5", version: "7.20260101.00.00" },
            expires_at: "2099-01-01T00:00:00Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://www.youtube.com/sw.js_data") {
      return new Response(`)]}'\n[[null,null,[null,null,null,null,null,null,"CgtnVmlzaXRvckRhdGE%3D"]]]`, {
        status: 200,
      });
    }

    if (url.startsWith("https://www.youtube.com/youtubei/v1/player")) {
      return new Response(
        JSON.stringify({
          playabilityStatus: { status: "OK" },
          videoDetails: {
            title: "4K Tizen Mux Test",
            author: "DokiChannel",
            lengthSeconds: "12",
            thumbnail: {
              thumbnails: [{ url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg", width: 1280, height: 720 }],
            },
          },
          streamingData: {
            formats: [],
            adaptiveFormats: [
              {
                itag: 137,
                url: videoUrl,
                mimeType: 'video/mp4; codecs="avc1.42c01e"',
                width: 3840,
                height: 2160,
                fps: 60,
                contentLength: String(videoBytes.byteLength),
              },
              {
                itag: 140,
                url: audioUrl,
                mimeType: 'audio/mp4; codecs="mp4a.40.2"',
                contentLength: String(audioBytes.byteLength),
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://snap.dokitool.com/api/youtube/finalize?schema_version=1.0") {
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            platform: "youtube",
            content_id: "dQw4w9WgXcQ",
            source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            title: "4K Tizen Mux Test",
            generated_at: "2026-11-21T00:00:00Z",
            items: [
              {
                id: "yt-main",
                type: "video",
                variants: [
                  {
                    id: "2160p60",
                    label: "2160p60",
                    metadata: {
                      width: 3840,
                      height: 2160,
                      fps: 60,
                      video_codec: "avc1.42c01e",
                      container: "mp4",
                      extension: "mp4",
                      has_audio: false,
                    },
                    delivery: {
                      kind: "file",
                      sources: [{ id: "v", url: videoUrl, size_bytes: videoBytes.byteLength }],
                    },
                  },
                  {
                    id: "audio-140",
                    label: "M4A 128kbps",
                    metadata: {
                      audio_codec: "mp4a.40.2",
                      container: "m4a",
                      extension: "m4a",
                      mime_type: "audio/mp4",
                      has_audio: true,
                    },
                    delivery: {
                      kind: "file",
                      sources: [{ id: "a", url: audioUrl, size_bytes: audioBytes.byteLength }],
                    },
                  },
                ],
                default: { variant_id: "audio-140", source_id: "a", url: audioUrl },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.startsWith("https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback")) {
      const u = new URL(url);
      const isVideo = u.searchParams.get("itag") === "137";
      const fullBuf = isVideo ? videoBytes : audioBytes;
      const rangeParam = u.searchParams.get("range");
      if (rangeParam) {
        const [s, e] = rangeParam.split("-").map(Number);
        const slice = fullBuf.slice(s, e + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Type": isVideo ? "video/mp4" : "audio/mp4",
            "Content-Range": `bytes ${s}-${s + slice.byteLength - 1}/${fullBuf.byteLength}`,
          },
        });
      }
      return new Response(fullBuf, { status: 200 });
    }

    throw new Error(`Unhandled URL in YouTube test: ${url}`);
  };

  let offscreenCtrl = null;
  const env = createMockMv3Environment({
    autoCompleteDownloads: false,
    async spawnOffscreenHook() {
      if (!offscreenCtrl) {
        offscreenCtrl = offscreenMod.createOffscreenController({
          chrome: env.chrome,
          fetchImpl: mockFetch,
          opfsStorage: opfs.storage,
          webLocks: opfs.locks,
          urlApi,
          youtubeMuxConfig: { chunkSize: 1024 },
        });
      }
    },
  });

  const extStorage = storage.createExtensionStorage();
  await extStorage.updateSettings({
    bearerToken: "test-owner-token-123",
    subfolderPrefix: "DokiTool",
  });

  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    fetchImpl: mockFetch,
  });
  await bg.init();

  // 2) Execute 3-step YouTube PARSE_URL
  const parseRpc = await env.chrome.runtime.sendMessage({
    type: "PARSE_URL",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  assert.equal(parseRpc.ok, true);
  assert.equal(parseRpc.data.media.title, "4K Tizen Mux Test");
  assert.equal(parseRpc.data.media.extra?.youtube_helper?.status, "ready");

  // Verify player request stripped forbidden headers while keeping X-YouTube-Client-* & X-Goog-Visitor-Id
  const playerCall = observedRequests.find((r) =>
    r.url.startsWith("https://www.youtube.com/youtubei/v1/player"),
  );
  assert.ok(playerCall);
  assert.equal(playerCall.credentials, "omit");
  assert.equal(playerCall.referrerPolicy, "no-referrer");
  const lowerHeaderKeys = Object.keys(playerCall.headers).map((k) => k.toLowerCase());
  assert.equal(lowerHeaderKeys.includes("user-agent"), false);
  assert.equal(lowerHeaderKeys.includes("origin"), false);
  assert.equal(lowerHeaderKeys.includes("referer"), false);
  assert.equal(lowerHeaderKeys.includes("cookie"), false);
  assert.equal(playerCall.headers["X-YouTube-Client-Name"], "7");
  assert.equal(playerCall.headers["X-YouTube-Client-Version"], "7.20260101.00.00");
  assert.equal(playerCall.headers["X-Goog-Visitor-Id"], "CgtnVmlzaXRvckRhdGE%3D");

  // 3) Build "best" enqueue item (should pick 2160p60 + M4A -> youtube_mux!) and execute
  const items = extensionDownloadMod.buildEnqueueItemsForMedia(
    parseRpc.data.media,
    {
      apiOrigin: "https://snap.dokitool.com",
      qualityPreference: "best",
      subfolderPrefix: "DokiTool/YouTube 4K",
    },
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].spec.kind, "youtube_mux");
  assert.equal(items[0].spec.filename, "DokiTool/YouTube 4K/4K Tizen Mux Test.mp4");

  await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items,
  });

  for (let i = 0; i < 80 && env.downloadCalls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(env.downloadCalls.length, 1);
  const dl = env.downloadCalls[0];
  // Subfolder path preserved intact despite youtubeHelperCore's sanitizeHelperFilename!
  assert.equal(dl.filename, "DokiTool/YouTube 4K/4K Tizen Mux Test.mp4");
  assert.equal(opfs.files.size, 1, "dokitool-yt-tmp-* held in OPFS until RELEASE_BLOB");

  // Read muxed MP4 bytes before completing download
  const muxedBlob = urlApi.activeBlobs.get(dl.url);
  const muxedBytes = new Uint8Array(await muxedBlob.arrayBuffer());
  savedFiles.set(dl.filename, muxedBytes);

  // Fire authoritative `complete`
  env.emitDownloadChanged({ id: dl.id, state: { current: "complete" } });
  await bg.waitForIdle();
  await offscreenCtrl.executor.waitForIdle();

  assert.equal(opfs.files.size, 0, "dokitool-yt-tmp-* cleaned up immediately after RELEASE_BLOB");
  assert.equal(urlApi.activeBlobs.size, 0);

  // Verify the muxed output is a valid MP4 containing BOTH video and audio tracks!
  const verifyInput = new mediabunny.Input({
    source: new mediabunny.BufferSource(muxedBytes),
    formats: [mediabunny.MP4],
  });
  const [vTrack, aTrack] = await Promise.all([
    verifyInput.getPrimaryVideoTrack(),
    verifyInput.getPrimaryAudioTrack(),
  ]);
  assert.ok(vTrack, "muxed MP4 contains video track");
  assert.ok(aTrack, "muxed MP4 contains audio track");
  verifyInput.dispose();

  offscreenCtrl?.dispose();
  bg.dispose();
});

test("Background SW: synchronous sidePanel.open before await, silent quick-download subfolder + badge, auth/privacy firewall, and batch queue fault isolation + retry", async () => {
  const opfs = createMockOpfs();
  const urlApi = createTrackedUrlApi();
  const apiRequests = [];
  let failSecondBatchUrl = true;

  const mockFetch = async (url, init) => {
    apiRequests.push({ url, headers: init?.headers || {}, credentials: init?.credentials });

    if (url.startsWith("https://snap.dokitool.com/api/platforms")) {
      const auth = init?.headers?.Authorization;
      if (auth === "Bearer bad-token") {
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "INVALID_INPUT",
            error: { code: "INVALID_INPUT", message: "认证凭据无效" },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: { platforms: new Array(14).fill({ id: "douyin" }) },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.startsWith("https://snap.dokitool.com/api/parse")) {
      const targetUrl = new URL(url).searchParams.get("url") || "";
      if (targetUrl.includes("x.com/restricted")) {
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "INVALID_INPUT",
            error: { code: "INVALID_INPUT", message: "当前凭据无权访问该平台" },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      if (targetUrl.includes("weibo.com/11111/GalleryPost")) {
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "OK",
            data: {
              platform: "weibo",
              content_id: "GalleryPost",
              title: "秋日摄影集",
              items: [
                {
                  id: "img1",
                  type: "image",
                  index: 1,
                  variants: [
                    {
                      id: "orig",
                      metadata: { extension: "jpg" },
                      delivery: { kind: "file", sources: [{ url: "https://wx1.sinaimg.cn/large/a.jpg" }] },
                    },
                  ],
                  default: { variant_id: "orig", url: "https://wx1.sinaimg.cn/large/a.jpg" },
                },
                {
                  id: "img2",
                  type: "image",
                  index: 2,
                  variants: [
                    {
                      id: "orig",
                      metadata: { extension: "jpg" },
                      delivery: { kind: "file", sources: [{ url: "https://wx2.sinaimg.cn/large/b.jpg" }] },
                    },
                  ],
                  default: { variant_id: "orig", url: "https://wx2.sinaimg.cn/large/b.jpg" },
                },
              ],
              default_item_id: "img1",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (targetUrl.includes("douyin.com/video/7002") && failSecondBatchUrl) {
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "UPSTREAM_INVALID_RESPONSE",
            error: { code: "UPSTREAM_INVALID_RESPONSE", message: "作品暂时无法访问" },
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
      // Generic single video parse response for batch items
      const idMatch = /(\d+)$/.exec(targetUrl);
      const vid = idMatch ? idMatch[1] : "1";
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            platform: "douyin",
            content_id: vid,
            title: `作品_${vid}`,
            items: [
              {
                id: `v-${vid}`,
                type: "video",
                variants: [
                  {
                    id: "1080p",
                    metadata: { width: 1080, height: 1920, extension: "mp4", has_audio: true },
                    delivery: {
                      kind: "file",
                      sources: [{ url: `https://v3-web.douyinvod.com/${vid}.mp4` }],
                    },
                  },
                ],
                default: {
                  variant_id: "1080p",
                  url: `https://v3-web.douyinvod.com/${vid}.mp4`,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (
      url.startsWith("https://wx1.sinaimg.cn/") ||
      url.startsWith("https://wx2.sinaimg.cn/") ||
      url.startsWith("https://v3-web.douyinvod.com/")
    ) {
      return new Response(new Uint8Array([9, 8, 7, 6]), {
        status: 200,
        headers: { "Content-Type": url.endsWith(".jpg") ? "image/jpeg" : "video/mp4" },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  let offscreenCtrl = null;
  const env = createMockMv3Environment({
    autoCompleteDownloads: true,
    async spawnOffscreenHook() {
      if (!offscreenCtrl) {
        offscreenCtrl = offscreenMod.createOffscreenController({
          chrome: env.chrome,
          fetchImpl: mockFetch,
          opfsStorage: opfs.storage,
          webLocks: opfs.locks,
          urlApi,
        });
      }
    },
  });

  const extStorage = storage.createExtensionStorage();
  await extStorage.updateSettings({ subfolderPrefix: "Collect" });

  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    fetchImpl: mockFetch,
    tabSyncDebounceMs: 20,
    badgeSuccessDurationMs: 50,
  });
  await bg.init();

  // Verify dual context menus registered
  assert.deepEqual(
    env.createdMenus.map((m) => m.id),
    [protocol.CONTEXT_MENU_INSPECT_ID, protocol.CONTEXT_MENU_QUICK_DOWNLOAD_ID],
  );

  // 1) Anonymous TEST_CONNECTION omits Authorization header completely; bad token returns 401 认证凭据无效
  const anonCheck = await env.chrome.runtime.sendMessage({
    type: "TEST_CONNECTION",
  });
  assert.equal(anonCheck.ok, true);
  assert.equal(anonCheck.data.ok, true);
  assert.equal(anonCheck.data.authMode, "anonymous");
  assert.equal(anonCheck.data.platformCount, 14);
  assert.equal("Authorization" in apiRequests[0].headers, false);

  const badCheck = await env.chrome.runtime.sendMessage({
    type: "TEST_CONNECTION",
    bearerToken: "bad-token",
  });
  assert.equal(badCheck.data.ok, false);
  assert.equal(badCheck.data.status, 401);
  assert.match(badCheck.data.message, /401.*认证凭据无效/);

  // 401 platform-allowlist error preserved verbatim
  await extStorage.updateSettings({ bearerToken: "friend-limited-token" });
  const restrictedParse = await env.chrome.runtime.sendMessage({
    type: "PARSE_URL",
    url: "https://x.com/restricted/status/1234567890",
  });
  assert.equal(restrictedParse.ok, false);
  assert.equal(restrictedParse.status, 401);
  assert.equal(restrictedParse.error, "当前凭据无权访问该平台");

  // 2) Privacy firewall on tab navigation: non-supported URLs make ZERO network calls!
  const countBeforeTab = apiRequests.length;
  env.emitTabUpdated(
    1,
    { status: "complete", url: "https://online-banking.example.com/secret?token=xyz" },
    { id: 1, windowId: 10, active: true, url: "https://online-banking.example.com/secret?token=xyz" },
  );
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(apiRequests.length, countBeforeTab, "0 network requests for non-supported tab");
  const snapAfterTab = await bg.getSnapshot();
  assert.equal(snapAfterTab.tabSync?.matched, null);
  assert.equal(snapAfterTab.tabSync?.rawUrl, "", "non-supported rawUrl redacted");

  // 3) Inspect context menu & Alt+Shift+D call chrome.sidePanel.open SYNCHRONOUSLY before any microtask!
  let microtaskElapsed = false;
  let openCalledBeforeMicrotask = false;
  const origOpen = env.chrome.sidePanel.open;
  env.chrome.sidePanel.open = (opts) => {
    openCalledBeforeMicrotask = !microtaskElapsed;
    return origOpen(opts);
  };

  microtaskElapsed = false;
  queueMicrotask(() => {
    microtaskElapsed = true;
  });
  env.emitContextMenuClick(
    {
      menuItemId: protocol.CONTEXT_MENU_INSPECT_ID,
      linkUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
    },
    { id: 42, windowId: 10 },
  );
  assert.equal(
    openCalledBeforeMicrotask,
    true,
    "CONTEXT_MENU_INSPECT_ID must invoke sidePanel.open synchronously on line 1 before any await",
  );
  await bg.waitForIdle();
  const inspectIntent = await extStorage.consumePendingIntent();
  assert.equal(inspectIntent?.mode, "inspect");
  assert.equal(inspectIntent?.url, "https://www.bilibili.com/video/BV1xx411c7mD");

  openCalledBeforeMicrotask = false;
  microtaskElapsed = false;
  queueMicrotask(() => {
    microtaskElapsed = true;
  });
  env.emitCommand(protocol.COMMAND_OPEN_SIDEPANEL, {
    id: 55,
    windowId: 10,
    url: "https://www.douyin.com/video/7001",
  });
  assert.equal(
    openCalledBeforeMicrotask,
    true,
    "Alt+Shift+D must invoke sidePanel.open synchronously on line 1 before any await",
  );
  await bg.waitForIdle();
  const cmdIntent = await extStorage.consumePendingIntent();
  assert.equal(cmdIntent?.url, "https://www.douyin.com/video/7001");

  // 4) Quick-Download context menu: MUST NOT open SidePanel, saves gallery into subfolder, updates Badge `1 -> ✓`!
  const openCountBeforeQuick = env.sidePanelOpenCalls.length;
  env.badgeHistory.length = 0;
  env.downloadCalls.length = 0;

  env.emitContextMenuClick(
    {
      menuItemId: protocol.CONTEXT_MENU_QUICK_DOWNLOAD_ID,
      linkUrl: "https://weibo.com/11111/GalleryPost",
    },
    { id: 42, windowId: 10 },
  );
  await bg.waitForIdle();
  await offscreenCtrl.executor.waitForIdle();

  assert.equal(
    env.sidePanelOpenCalls.length,
    openCountBeforeQuick,
    "Quick-download MUST NOT open SidePanel",
  );
  assert.deepEqual(
    env.downloadCalls.map((d) => d.filename).sort(),
    ["Collect/秋日摄影集/001.jpg", "Collect/秋日摄影集/002.jpg"],
  );
  const badgeTexts = env.badgeHistory
    .filter((b) => b.kind === "text")
    .map((b) => b.text);
  assert.ok(badgeTexts.includes("1"), "Badge showed active count");
  assert.equal(badgeTexts[badgeTexts.length - 1], "✓", "Badge transitioned to ✓ on completion");

  // Clear finished before testing batch queue
  await env.chrome.runtime.sendMessage({ type: "CLEAR_FINISHED_TASKS" });

  // 5) Batch URL Queue: fault isolation when URL #2 fails, then 1-click RETRY_TASK succeeds!
  env.downloadCalls.length = 0;
  const batchResp = await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_BATCH_URLS",
    urls: [
      "https://www.douyin.com/video/7001",
      "https://www.douyin.com/video/7002",
      "https://www.douyin.com/video/7003",
    ],
  });
  assert.equal(batchResp.ok, true);
  assert.equal(batchResp.data.taskIds.length, 3);

  await bg.waitForIdle();
  await offscreenCtrl.executor.waitForIdle();

  let batchSnap = await bg.getSnapshot();
  const completedInBatch = batchSnap.tasks.filter((t) => t.status === "completed");
  const failedInBatch = batchSnap.tasks.filter((t) => t.status === "failed");
  assert.equal(completedInBatch.length, 2, "URL #1 and #3 completed despite URL #2 failure");
  assert.equal(failedInBatch.length, 1, "URL #2 isolated as failed");
  assert.equal(failedInBatch[0].retryPayload?.kind, "url");
  assert.deepEqual(
    env.downloadCalls.map((d) => d.filename).sort(),
    ["Collect/作品_7001/作品_7001.mp4", "Collect/作品_7003/作品_7003.mp4"],
  );

  // Fix upstream for URL #2 and retry in 1 click!
  failSecondBatchUrl = false;
  const retryResp = await env.chrome.runtime.sendMessage({
    type: "RETRY_TASK",
    taskId: failedInBatch[0].taskId,
  });
  assert.equal(retryResp.ok, true);

  await bg.waitForIdle();
  await offscreenCtrl.executor.waitForIdle();

  batchSnap = await bg.getSnapshot();
  assert.equal(
    batchSnap.tasks.every((t) => t.status === "completed"),
    true,
    "All 3 batch tasks completed after 1-click retry",
  );
  assert.ok(
    env.downloadCalls.some((d) => d.filename === "Collect/作品_7002/作品_7002.mp4"),
  );
  assert.equal(opfs.files.size, 0);
  assert.equal(urlApi.activeBlobs.size, 0);

  offscreenCtrl?.dispose();
  bg.dispose();
});

test("selectVariantByPreference & buildEnqueueItemsForMedia: honors best / 1080p / audio preferences, LivePhoto pair modes, and 500 MiB ZIP guard", () => {
  const sampleItem = {
    id: "v1",
    type: "video",
    variants: [
      {
        id: "4k",
        label: "2160p",
        metadata: { width: 3840, height: 2160, fps: 60, extension: "mp4", has_audio: true },
        delivery: { kind: "file", sources: [{ url: "https://upos-sz-mirrorcos.bilivideo.com/4k.mp4" }] },
      },
      {
        id: "1080p",
        label: "1080p",
        metadata: { width: 1920, height: 1080, fps: 60, extension: "mp4", has_audio: true },
        delivery: { kind: "file", sources: [{ url: "https://upos-sz-mirrorcos.bilivideo.com/1080.mp4" }] },
      },
      {
        id: "720p",
        label: "720p",
        metadata: { width: 1280, height: 720, fps: 30, extension: "mp4", has_audio: true },
        delivery: { kind: "file", sources: [{ url: "https://upos-sz-mirrorcos.bilivideo.com/720.mp4" }] },
      },
    ],
    default: {
      variant_id: "720p",
      url: "https://upos-sz-mirrorcos.bilivideo.com/720.mp4",
    },
  };
  const attachments = [
    {
      id: "bgm",
      role: "background_audio",
      title: "原声配乐",
      resource: {
        id: "bgm-res",
        role: "audio",
        metadata: { extension: "m4a", mime_type: "audio/mp4", audio_bitrate_bps: 192000 },
        delivery: {
          kind: "file",
          sources: [{ url: "https://sf3-cdn-tos.douyinstatic.com/obj/bgm.m4a" }],
        },
      },
    },
  ];

  const bestPlan = extensionDownloadMod.selectVariantByPreference(
    sampleItem,
    attachments,
    "best",
    "https://snap.dokitool.com",
  );
  assert.equal(bestPlan.variant.id, "4k");

  const p1080Plan = extensionDownloadMod.selectVariantByPreference(
    sampleItem,
    attachments,
    "1080p",
    "https://snap.dokitool.com",
  );
  assert.equal(p1080Plan.variant.id, "1080p");

  const audioPlan = extensionDownloadMod.selectVariantByPreference(
    sampleItem,
    attachments,
    "audio",
    "https://snap.dokitool.com",
  );
  assert.equal(audioPlan.isAudioOnly, true);
  assert.equal(
    audioPlan.target.url,
    "https://sf3-cdn-tos.douyinstatic.com/obj/bgm.m4a",
  );

  // LivePhoto pair modes ("both", "video", "image")
  const liveMedia = {
    platform: "xiaohongshu",
    content_id: "xhs-live-1",
    title: "小红书实况笔记",
    items: [
      {
        id: "lp-1",
        type: "live_photo",
        index: 1,
        variants: [
          {
            id: "pair-1",
            delivery: {
              kind: "pair",
              resources: [
                {
                  id: "r-img",
                  role: "image",
                  metadata: { extension: "webp" },
                  delivery: {
                    kind: "file",
                    sources: [{ url: "https://sns-webpic-qc.xhscdn.com/1.webp" }],
                  },
                },
                {
                  id: "r-vid",
                  role: "motion",
                  metadata: { extension: "mp4" },
                  delivery: {
                    kind: "file",
                    sources: [{ url: "https://sns-video-bd.xhscdn.com/1.mp4" }],
                  },
                },
              ],
            },
          },
        ],
        default: null,
        default_unavailable_reason: "processing_required",
      },
    ],
  };

  const bothItems = extensionDownloadMod.buildEnqueueItemsForMedia(liveMedia, {
    apiOrigin: "https://snap.dokitool.com",
    livePhotoMode: "both",
    subfolderPrefix: "XHS",
  });
  assert.equal(bothItems.length, 2);
  assert.deepEqual(
    bothItems.map((i) => i.spec.filename),
    [
      "XHS/小红书实况笔记/001_motion.mp4",
      "XHS/小红书实况笔记/001_cover.webp",
    ],
  );

  const onlyVideoItems = extensionDownloadMod.buildEnqueueItemsForMedia(liveMedia, {
    apiOrigin: "https://snap.dokitool.com",
    livePhotoMode: "video",
  });
  assert.equal(onlyVideoItems.length, 1);
  assert.equal(onlyVideoItems[0].spec.filename, "小红书实况笔记.mp4");

  // 500 MiB ZIP guard
  const hugeAlbum = {
    platform: "weibo",
    content_id: "huge",
    title: "超大相册",
    default_item_id: "i1",
    items: [
      {
        id: "i1",
        type: "image",
        variants: [
          {
            id: "o",
            metadata: { extension: "jpg" },
            delivery: {
              kind: "file",
              sources: [{ url: "https://wx1.sinaimg.cn/large/1.jpg", size_bytes: 300 * 1024 * 1024 }],
            },
          },
        ],
        default: { variant_id: "o", url: "https://wx1.sinaimg.cn/large/1.jpg" },
      },
      {
        id: "i2",
        type: "image",
        variants: [
          {
            id: "o",
            metadata: { extension: "jpg" },
            delivery: {
              kind: "file",
              sources: [{ url: "https://wx1.sinaimg.cn/large/2.jpg", size_bytes: 250 * 1024 * 1024 }],
            },
          },
        ],
        default: { variant_id: "o", url: "https://wx1.sinaimg.cn/large/2.jpg" },
      },
    ],
  };
  assert.throws(
    () =>
      extensionDownloadMod.buildEnqueueItemsForMedia(hugeAlbum, {
        apiOrigin: "https://snap.dokitool.com",
        batchSaveMode: "zip",
      }),
    /500 MB/,
  );
});

test("Background SW & Offscreen: youtube_direct chunked download, RESOLVE_LAZY_ITEM multipart hydration, and CANCEL_TASK cleanup", async () => {
  const opfs = createMockOpfs();
  const urlApi = createTrackedUrlApi();
  const ytDirectBytes = new Uint8Array(2500).fill(0x5a);
  const ytDirectUrl = `https://rr1---sn-a5mekn6s.googlevideo.com/videoplayback?expire=9999999999&itag=140&clen=${ytDirectBytes.byteLength}`;

  let hangCancelStream = null;
  const mockFetch = async (url) => {
    if (url.startsWith("https://rr1---sn-a5mekn6s.googlevideo.com/videoplayback")) {
      const u = new URL(url);
      const [s, e] = (u.searchParams.get("range") || `0-${ytDirectBytes.byteLength - 1}`)
        .split("-")
        .map(Number);
      const slice = ytDirectBytes.slice(s, e + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Type": "audio/mp4",
          "Content-Range": `bytes ${s}-${s + slice.byteLength - 1}/${ytDirectBytes.byteLength}`,
        },
      });
    }
    if (url.startsWith("https://snap.dokitool.com/api/resolve?")) {
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            platform: "bilibili",
            content_id: "BV1multi",
            title: "B站分P课程",
            default_item_id: "p2",
            items: [
              {
                id: "p2",
                type: "video",
                index: 2,
                title: "第二节",
                variants: [
                  {
                    id: "1080p",
                    metadata: { extension: "mp4", has_audio: true },
                    delivery: {
                      kind: "file",
                      sources: [{ url: "https://upos-sz-mirrorcos.bilivideo.com/p2.mp4" }],
                    },
                  },
                ],
                default: {
                  variant_id: "1080p",
                  url: "https://upos-sz-mirrorcos.bilivideo.com/p2.mp4",
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "https://upos-sz-mirrorcos.bilivideo.com/slow-cancel.mp4") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            hangCancelStream = controller;
          },
        }),
        { status: 200, headers: { "Content-Type": "video/mp4", "Content-Length": "999999" } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  let offscreenCtrl = null;
  const env = createMockMv3Environment({
    autoCompleteDownloads: true,
    async spawnOffscreenHook() {
      if (!offscreenCtrl) {
        offscreenCtrl = offscreenMod.createOffscreenController({
          chrome: env.chrome,
          fetchImpl: mockFetch,
          opfsStorage: opfs.storage,
          webLocks: opfs.locks,
          urlApi,
          youtubeMuxConfig: { chunkSize: 1024 },
        });
      }
    },
  });

  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: storage.createExtensionStorage(),
    fetchImpl: mockFetch,
  });
  await bg.init();

  // 1) RESOLVE_LAZY_ITEM RPC + privacy check rejecting non-supported inner URL
  const badResolve = await env.chrome.runtime.sendMessage({
    type: "RESOLVE_LAZY_ITEM",
    platform: "bilibili",
    resolveUrl: "/api/resolve?item_id=p2&url=https%3A%2F%2Fevil.example.com%2F1",
  });
  assert.equal(badResolve.ok, false);

  const okResolve = await env.chrome.runtime.sendMessage({
    type: "RESOLVE_LAZY_ITEM",
    platform: "bilibili",
    resolveUrl:
      "/api/resolve?item_id=p2&url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1xx411c7mD",
  });
  assert.equal(okResolve.ok, true);
  assert.equal(okResolve.data.media.items[0].id, "p2");

  // 2) youtube_direct chunked OPFS download
  await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "YT Audio",
        platform: "youtube",
        spec: {
          kind: "youtube_direct",
          apiOrigin: "https://snap.dokitool.com",
          routes: [ytDirectUrl],
          filename: "DokiTool/YT Audio.m4a",
          mimeType: "audio/mp4",
          sizeBytes: ytDirectBytes.byteLength,
        },
      },
    ],
  });
  await bg.waitForIdle();
  await offscreenCtrl.executor.waitForIdle();
  assert.equal(env.downloadCalls[0].filename, "DokiTool/YT Audio.m4a");
  assert.equal(opfs.files.size, 0);

  // 3) Mid-stream CANCEL_TASK aborts stream and cleans up OPFS temp file!
  const slowEnq = await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "Slow Video",
        platform: "bilibili",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://upos-sz-mirrorcos.bilivideo.com/slow-cancel.mp4"],
          filename: "slow.mp4",
          mimeType: "video/mp4",
        },
      },
    ],
  });
  const slowTaskId = slowEnq.data.taskIds[0];
  for (let i = 0; i < 50 && !hangCancelStream; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const cancelRpc = await env.chrome.runtime.sendMessage({
    type: "CANCEL_TASK",
    taskId: slowTaskId,
  });
  assert.equal(cancelRpc.ok, true);
  assert.equal(cancelRpc.data.cancelled, true);

  await bg.waitForIdle();
  await offscreenCtrl.executor.waitForIdle();
  assert.equal(opfs.files.size, 0, "cancelled stream OPFS temp file cleaned up");
  assert.equal(
    (await bg.getSnapshot()).tasks.find((t) => t.taskId === slowTaskId)?.status,
    "cancelled",
  );

  offscreenCtrl?.dispose();
  bg.dispose();
});
