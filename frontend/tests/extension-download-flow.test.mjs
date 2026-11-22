import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { build, stop } from "esbuild";
import * as vue from "vue";
import { loadSfc } from "./helpers/loadSfc.mjs";

const { createRenderer, h, markRaw, nextTick, ref } = vue;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(__dirname, "..");
const REPO_ROOT_DIR = resolve(FRONTEND_DIR, "..");

let tmpBundleDir = "";
let protocol;
let storage;
let youtubeBridgeMod;
let dashMuxSpecMod;
let opfsStreamTransferMod;
let dashMuxDownloadMod;
let dashMuxEngineMod;
let extensionDownloadMod;
let uiTargetHelpersMod;
let offscreenMod;
let backgroundMod;
let mediaContractMod;
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
        export * as dashMuxSpecMod from "./src/extension/dashMuxSpec.ts";
        export * as opfsStreamTransferMod from "./src/extension/opfsStreamTransfer.ts";
        export * as dashMuxDownloadMod from "./src/extension/dashMuxDownload.ts";
        export * as dashMuxEngineMod from "./src/extension/dashMuxEngine.ts";
        export * as extensionDownloadMod from "./src/extension/extensionDownload.ts";
        export * as uiTargetHelpersMod from "./src/extension/uiTargetHelpers.ts";
        export * as offscreenMod from "./src/extension/offscreen.ts";
        export * as backgroundMod from "./src/extension/background.ts";
        export * as mediaContractMod from "./src/utils/mediaContract.ts";
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
  dashMuxSpecMod = suite.dashMuxSpecMod;
  opfsStreamTransferMod = suite.opfsStreamTransferMod;
  dashMuxDownloadMod = suite.dashMuxDownloadMod;
  dashMuxEngineMod = suite.dashMuxEngineMod;
  extensionDownloadMod = suite.extensionDownloadMod;
  uiTargetHelpersMod = suite.uiTargetHelpersMod;
  offscreenMod = suite.offscreenMod;
  backgroundMod = suite.backgroundMod;
  mediaContractMod = suite.mediaContractMod;
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
      setTitle({ title }) {
        badgeHistory.push({ kind: "title", title });
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

function verifyProtectedYoutubeHelperZeroDiff(repoRoot = REPO_ROOT_DIR) {
  if (!existsSync(join(repoRoot, ".git"))) {
    return { skipped: true, diffOutput: "" };
  }
  const diffOutput = execFileSync(
    "git",
    [
      "diff",
      "--",
      "frontend/src/utils/youtubeHelperCore.js",
      "frontend/src/utils/youtubeHelperEntry.js",
      "frontend/public/helper/dokitool-youtube.user.js",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(diffOutput, "", "Protected YouTube helper files MUST have 0 diff");
  return { skipped: false, diffOutput };
}

test("YouTube zero-diff adapter: 0 git diff on protected files, strips forbidden headers, runs 3-step TVHTML5 parse & Mediabunny OPFS mux into subfolder", async () => {
  // 1) Verify strict 0 diff on protected YouTube helper files (gracefully skipped in .git-less archives)!
  const gitCheck = verifyProtectedYoutubeHelperZeroDiff(REPO_ROOT_DIR);
  if (existsSync(join(REPO_ROOT_DIR, ".git"))) {
    assert.equal(gitCheck.skipped, false);
  }
  const archiveSnapshotDir = mkdtempSync(join(tmpdir(), "dokitool-gitless-"));
  try {
    assert.deepEqual(verifyProtectedYoutubeHelperZeroDiff(archiveSnapshotDir), {
      skipped: true,
      diffOutput: "",
    });
  } finally {
    rmSync(archiveSnapshotDir, { recursive: true, force: true });
  }

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
          youtubeMuxConfig: { chunkSize: 1024, audioConcurrency: 1, videoConcurrency: 1 },
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
          youtubeMuxConfig: { chunkSize: 1024, audioConcurrency: 1, videoConcurrency: 1 },
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

// ============================================================================
// Lightweight Vue SFC Tree Renderer for SidePanel Component Regression Tests
// ============================================================================

const PassthroughTransition = {
  inheritAttrs: false,
  setup: (_props, { slots }) => () => slots.default?.(),
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
      if (key === "value") {
        node.value = value ?? "";
      }
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
    flush,
    fire,
    unmount() {
      app.unmount();
    },
  };
}

// ============================================================================
// P1-1 Regression: MV3 SW Cold-Wake `tabSync` Race & `queryActiveTab()`
// ============================================================================

test("P1-1: MV3 Service Worker cold-wake populates tabSync before init() completes, prefers lastFocusedWindow with currentWindow fallback, and broadcasts TAB_SYNC_UPDATED", async () => {
  // Sub-case A: GET_INITIAL_STATE & Port onConnect race ahead of slow init()
  const envA = createMockMv3Environment();
  const queryCallsA = [];
  envA.chrome.tabs.query = async (queryInfo) => {
    queryCallsA.push({ ...queryInfo });
    if (queryInfo.lastFocusedWindow) {
      return [
        {
          id: 77,
          windowId: 20,
          active: true,
          url: "https://www.bilibili.com/video/BV1uv411q7Mv",
        },
      ];
    }
    return [];
  };

  let releaseSlowInit = () => {};
  const slowInitBarrier = new Promise((resolveBarrier) => {
    releaseSlowInit = resolveBarrier;
  });
  envA.chrome.sidePanel.setPanelBehavior = async () => {
    await slowInitBarrier;
  };

  const bgA = backgroundMod.createBackgroundController({
    chrome: envA.chrome,
    storage: storage.createExtensionStorage(),
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });

  // Start cold-wake init() (currently blocked inside setPanelBehavior before DNR / menus / tabs.query)
  let initFinished = false;
  const initPromise = bgA.init().then(() => {
    initFinished = true;
  });

  const portBroadcastsA = [];
  const portA = envA.chrome.runtime.connect({
    name: protocol.SIDEPANEL_PORT_NAME,
  });
  portA.onMessage.addListener((msg) => portBroadcastsA.push(msg));

  const initialResp = await envA.chrome.runtime.sendMessage({
    type: "GET_INITIAL_STATE",
  });
  assert.equal(
    initFinished,
    false,
    "GET_INITIAL_STATE must resolve while init() is still awaiting startup work",
  );
  assert.equal(initialResp.ok, true);
  assert.equal(initialResp.data.tabSync?.tabId, 77);
  assert.equal(initialResp.data.tabSync?.matched?.platform, "bilibili");
  assert.equal(
    initialResp.data.tabSync?.matched?.dedupeKey,
    "bilibili:video:BV1uv411q7Mv:p=1",
  );
  assert.equal(initialResp.data.tabSync?.matched?.isLikelyFeedOrHome, false);
  assert.deepEqual(queryCallsA[0], { active: true, lastFocusedWindow: true });

  await new Promise((r) => setTimeout(r, 15));
  assert.ok(
    portBroadcastsA.some(
      (m) =>
        m.type === "TAB_SYNC_UPDATED" &&
        m.tabSync?.matched?.dedupeKey === "bilibili:video:BV1uv411q7Mv:p=1",
    ),
    "Connected SidePanel port must receive TAB_SYNC_UPDATED during cold-wake",
  );
  assert.ok(
    portBroadcastsA.some(
      (m) =>
        m.type === "STATE_SNAPSHOT" &&
        m.snapshot?.tabSync?.matched?.platform === "bilibili",
    ),
    "Connected SidePanel port initial STATE_SNAPSHOT must carry populated tabSync",
  );

  releaseSlowInit();
  await initPromise;
  bgA.dispose();

  // Sub-case B: lastFocusedWindow empty -> falls back to currentWindow in init() & Alt+Shift+D, and init() broadcasts TAB_SYNC_UPDATED
  const envB = createMockMv3Environment();
  const queryCallsB = [];
  envB.chrome.tabs.query = async (queryInfo) => {
    queryCallsB.push({ ...queryInfo });
    if (queryInfo.lastFocusedWindow) {
      return [];
    }
    if (queryInfo.currentWindow) {
      return [
        {
          id: 88,
          windowId: 30,
          active: true,
          url: "https://v.kuaishou.com/abcXYZ",
        },
      ];
    }
    return [];
  };

  const extStorageB = storage.createExtensionStorage();
  const bgB = backgroundMod.createBackgroundController({
    chrome: envB.chrome,
    storage: extStorageB,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });

  const portBroadcastsB = [];
  const portB = envB.chrome.runtime.connect({
    name: protocol.SIDEPANEL_PORT_NAME,
  });
  portB.onMessage.addListener((msg) => portBroadcastsB.push(msg));
  // Wait for onConnect snapshot, then navigate active tab before init() runs
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(queryCallsB.slice(0, 2), [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
  ]);

  envB.chrome.tabs.query = async (queryInfo) => {
    queryCallsB.push({ ...queryInfo });
    if (queryInfo.lastFocusedWindow) return [];
    return [
      {
        id: 88,
        windowId: 30,
        active: true,
        url: "https://www.douyin.com/video/7704056737233449610",
      },
    ];
  };
  await bgB.init();
  assert.ok(
    portBroadcastsB.some(
      (m) =>
        m.type === "TAB_SYNC_UPDATED" &&
        m.tabSync?.matched?.dedupeKey === "douyin:item:7704056737233449610",
    ),
    "init() must broadcast TAB_SYNC_UPDATED to connected SidePanel ports",
  );

  // Alt+Shift+D with tab lacking url queries queryActiveTab() (lastFocusedWindow -> currentWindow fallback)
  queryCallsB.length = 0;
  envB.emitCommand(protocol.COMMAND_OPEN_SIDEPANEL, { id: 88, windowId: 30 });
  await bgB.waitForIdle();
  assert.deepEqual(queryCallsB.slice(0, 2), [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
  ]);
  const cmdIntent = await extStorageB.consumePendingIntent();
  assert.equal(
    cmdIntent?.url,
    "https://www.douyin.com/video/7704056737233449610",
  );

  bgB.dispose();
});

// ============================================================================
// P1-2 Regression: YouTube Parse-Only `offscreen.html` Idle Auto-Close
// ============================================================================

test("P1-2: YouTube PARSE_URL without downloading (both preview OK and LOGIN_REQUIRED / player error) closes offscreen.html after offscreenIdleCloseMs", async () => {
  const opfs = createMockOpfs();
  const urlApi = createTrackedUrlApi();
  let playerMode = "ok";

  const mockFetch = async (url) => {
    if (url === "https://snap.dokitool.com/api/youtube/context?schema_version=1.0") {
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            player_id: "ytplayer01",
            signature_timestamp: 20123,
            client: { name: "TVHTML5", version: "7.20260101.00.00" },
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
      if (playerMode === "login_required") {
        return new Response(
          JSON.stringify({
            playabilityStatus: {
              status: "LOGIN_REQUIRED",
              reason: "Sign in to confirm you’re not a bot",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (playerMode === "network_fail") {
        return new Response("upstream error", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          playabilityStatus: { status: "OK" },
          videoDetails: {
            title: "Preview Only YT",
            author: "Channel",
            lengthSeconds: "10",
          },
          streamingData: {
            formats: [
              {
                itag: 18,
                url: "https://rr1---sn-a5mekn6s.googlevideo.com/videoplayback?expire=9999999999&itag=18",
                mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
                width: 640,
                height: 360,
              },
            ],
            adaptiveFormats: [],
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
            content_id: "I9JvDaciaFk",
            source_url: "https://www.youtube.com/watch?v=I9JvDaciaFk",
            title: "Preview Only YT",
            items: [
              {
                id: "yt-1",
                type: "video",
                variants: [
                  {
                    id: "360p",
                    label: "360p",
                    metadata: { width: 640, height: 360, extension: "mp4", has_audio: true },
                    delivery: {
                      kind: "file",
                      sources: [
                        {
                          url: "https://rr1---sn-a5mekn6s.googlevideo.com/videoplayback?expire=9999999999&itag=18",
                        },
                      ],
                    },
                  },
                ],
                default: {
                  variant_id: "360p",
                  url: "https://rr1---sn-a5mekn6s.googlevideo.com/videoplayback?expire=9999999999&itag=18",
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  let offscreenCtrl = null;
  const env = createMockMv3Environment({
    async spawnOffscreenHook() {
      offscreenCtrl?.dispose();
      offscreenCtrl = offscreenMod.createOffscreenController({
        chrome: env.chrome,
        fetchImpl: mockFetch,
        opfsStorage: opfs.storage,
        webLocks: opfs.locks,
        urlApi,
      });
    },
  });
  const origCloseDoc = env.chrome.offscreen.closeDocument;
  env.chrome.offscreen.closeDocument = async () => {
    offscreenCtrl?.dispose();
    offscreenCtrl = null;
    return origCloseDoc();
  };

  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: storage.createExtensionStorage(),
    fetchImpl: mockFetch,
    offscreenIdleCloseMs: 40,
  });
  await bg.init();

  // 1) Parse-only success (user previews without clicking download)
  playerMode = "ok";
  const okParse = await env.chrome.runtime.sendMessage({
    type: "PARSE_URL",
    url: "https://www.youtube.com/watch?v=I9JvDaciaFk",
  });
  assert.equal(okParse.ok, true);
  assert.equal(env.isOffscreenOpen(), true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(env.isOffscreenOpen(), false, "offscreen closed after preview-only YouTube parse");
  assert.equal(env.getOffscreenCloseCount(), 1);

  // 2) LOGIN_REQUIRED error path
  playerMode = "login_required";
  const loginParse = await env.chrome.runtime.sendMessage({
    type: "PARSE_URL",
    url: "https://www.youtube.com/watch?v=I9JvDaciaFk",
  });
  assert.equal(loginParse.ok, false);
  assert.equal(loginParse.code, "LOGIN_REQUIRED");
  assert.equal(env.isOffscreenOpen(), true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(env.isOffscreenOpen(), false, "offscreen closed after LOGIN_REQUIRED");
  assert.equal(env.getOffscreenCloseCount(), 2);

  // 3) Offscreen player RPC rejection (503)
  playerMode = "network_fail";
  const errParse = await env.chrome.runtime.sendMessage({
    type: "PARSE_URL",
    url: "https://www.youtube.com/watch?v=I9JvDaciaFk",
  });
  assert.equal(errParse.ok, false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(env.isOffscreenOpen(), false, "offscreen closed after player RPC error");
  assert.equal(env.getOffscreenCloseCount(), 3);

  offscreenCtrl?.dispose();
  bg.dispose();
});

// ============================================================================
// P1-3 Regression: `mergeEnqueuedTasks` & `SidePanelApp.vue` Consecutive Enqueues
// ============================================================================

test("P1-3: mergeEnqueuedTasks and SidePanelApp.vue retain pre-existing active + completed tasks across consecutive ENQUEUE_DOWNLOADS and ENQUEUE_BATCH_URLS", async () => {
  const mkTask = (taskId, status, updatedAt, extra = {}) => ({
    taskId,
    title: `Title ${taskId}`,
    filename: `${taskId}.mp4`,
    platform: "bilibili",
    status,
    statusText: status,
    percent: status === "completed" ? 100 : 0,
    loaded: 0,
    total: 1000,
    speed: 0,
    createdAt: 100,
    updatedAt,
    ...extra,
  });

  // 1) Pure helper assertions: prepends new tasks in order & preserves existing active + completed tasks
  const existingTasks = [
    mkTask("task-active-1", "downloading", 150, { loaded: 400 }),
    mkTask("task-done-0", "completed", 120),
  ];
  const newlyCreated = [
    mkTask("task-new-2", "queued", 200),
    mkTask("task-new-3", "queued", 200),
  ];
  const merged1 = uiTargetHelpersMod.mergeEnqueuedTasks(
    existingTasks,
    newlyCreated,
  );
  assert.deepEqual(
    merged1.map((t) => t.taskId),
    ["task-new-2", "task-new-3", "task-active-1", "task-done-0"],
  );

  // Out-of-order Port TASKS_UPDATED arrived BEFORE RPC resolved: keep fresher downloading state!
  const portAlreadyUpdated = [
    mkTask("task-race", "downloading", 310, { loaded: 512, percent: 51 }),
    mkTask("task-same-ms", "muxing", 300, { loaded: 128 }),
    ...merged1,
  ];
  const staleRpcReturn = [
    mkTask("task-race", "queued", 300, { loaded: 0, percent: 0 }),
    mkTask("task-same-ms", "queued", 300, { loaded: 0, percent: 0 }),
  ];
  const mergedRace = uiTargetHelpersMod.mergeEnqueuedTasks(
    portAlreadyUpdated,
    staleRpcReturn,
  );
  assert.equal(mergedRace.length, portAlreadyUpdated.length);
  assert.equal(mergedRace[0].taskId, "task-race");
  assert.equal(mergedRace[0].status, "downloading");
  assert.equal(mergedRace[0].loaded, 512);
  assert.equal(mergedRace[1].taskId, "task-same-ms");
  assert.equal(mergedRace[1].status, "muxing");

  // 2) Live mounted SidePanelApp.vue test against BackgroundController
  const SidePanelApp = await loadSidePanelSfc("../src/extension/SidePanelApp.vue");
  const prevChrome = globalThis.chrome;
  let holdStreamCtrl = null;

  const mockFetch = async (url) => {
    if (url.startsWith("https://snap.dokitool.com/api/parse")) {
      const target = new URL(url).searchParams.get("url") || "";
      const id = target.split("/").pop() || "1";
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            platform: "douyin",
            content_id: id,
            title: `抖音作品_${id}`,
            items: [
              {
                id: `item-${id}`,
                type: "video",
                variants: [
                  {
                    id: "1080p",
                    label: "1080p",
                    metadata: { width: 1080, height: 1920, extension: "mp4", has_audio: true },
                    delivery: {
                      kind: "file",
                      sources: [{ url: `https://v3-web.douyinvod.com/${id}.mp4` }],
                    },
                  },
                ],
                default: {
                  variant_id: "1080p",
                  url: `https://v3-web.douyinvod.com/${id}.mp4`,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "https://v3-web.douyinvod.com/9002.mp4") {
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3, 4]));
            holdStreamCtrl = c;
          },
        }),
        { status: 200, headers: { "Content-Type": "video/mp4", "Content-Length": "100" } },
      );
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "Content-Type": "video/mp4" },
    });
  };

  let offscreenCtrl = null;
  const env = createMockMv3Environment({
    autoCompleteDownloads: true,
    async spawnOffscreenHook() {
      if (!offscreenCtrl) {
        const p13Opfs = createMockOpfs();
        offscreenCtrl = offscreenMod.createOffscreenController({
          chrome: env.chrome,
          fetchImpl: mockFetch,
          opfsStorage: p13Opfs.storage,
          webLocks: p13Opfs.locks,
          urlApi: createTrackedUrlApi(),
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

  globalThis.chrome = env.chrome;
  let mounted = null;
  try {
    mounted = mountSfcTree(SidePanelApp);
    await new Promise((r) => setTimeout(r, 30));
    await mounted.flush();

    const inputEl = mounted.findAll((n) => n.type === "input")[0];
    inputEl.value = "https://www.douyin.com/video/9001";
    inputEl.dispatchEvent({ type: "input", target: inputEl });
    await mounted.flush();
    const formEl = mounted.findAll((n) => n.type === "form")[0];
    await mounted.fire(formEl, "onSubmit", { preventDefault() {} });
    await new Promise((r) => setTimeout(r, 30));
    await mounted.flush();

    const dlBtn1 = mounted.findAll(
      (n) => n.type === "button" && mounted.textOf(n).includes("下载"),
    )[0];
    await mounted.fire(dlBtn1, "onClick");
    await bg.waitForIdle();
    await new Promise((r) => setTimeout(r, 20));
    await mounted.flush();
    assert.match(mounted.textOf(), /抖音作品_9001/);

    // Parse & enqueue #2 (9002 -> stays active/downloading while 9001 is completed)
    inputEl.value = "https://www.douyin.com/video/9002";
    inputEl.dispatchEvent({ type: "input", target: inputEl });
    await mounted.flush();
    await mounted.fire(formEl, "onSubmit", { preventDefault() {} });
    await new Promise((r) => setTimeout(r, 30));
    await mounted.flush();

    const dlBtn2 = mounted.findAll(
      (n) => n.type === "button" && mounted.textOf(n).includes("下载"),
    )[0];
    await mounted.fire(dlBtn2, "onClick");
    await new Promise((r) => setTimeout(r, 30));
    await mounted.flush();

    const afterSecondEnqueueText = mounted.textOf();
    assert.match(afterSecondEnqueueText, /抖音作品_9001/, "Completed task #1 must NOT be clobbered by 2nd ENQUEUE_DOWNLOADS");
    assert.match(afterSecondEnqueueText, /抖音作品_9002/, "Active task #2 must be prepended");

    // Switch to Batch mode and trigger ENQUEUE_BATCH_URLS (#3: 9003) -> all 3 tasks must coexist!
    const batchTabBtn = mounted.findAll(
      (n) =>
        n.type === "button" &&
        n.props.role === "tab" &&
        mounted.textOf(n).includes("批量"),
    )[0];
    await mounted.fire(batchTabBtn, "onClick");
    const textareaEl = mounted.findAll((n) => n.type === "textarea")[0];
    await mounted.fire(textareaEl, "onInput", {
      target: { value: "https://www.douyin.com/video/9003" },
    });
    const batchSubmitBtn = mounted.findAll(
      (n) =>
        n.type === "button" &&
        mounted.textOf(n).includes("全部解析并按偏好下载"),
    )[0];
    await mounted.fire(batchSubmitBtn, "onClick");
    await new Promise((r) => setTimeout(r, 40));
    await mounted.flush();

    const afterBatchText = mounted.textOf();
    assert.match(afterBatchText, /抖音作品_9001/, "Task #1 retained after ENQUEUE_BATCH_URLS");
    assert.match(afterBatchText, /抖音作品_9002/, "Task #2 retained after ENQUEUE_BATCH_URLS");
    assert.match(afterBatchText, /9003/, "Batch task #3 added at top");

    // Finish held stream cleanly
    holdStreamCtrl?.enqueue(new Uint8Array(96).fill(1));
    holdStreamCtrl?.close();
    await bg.waitForIdle();
    await offscreenCtrl?.executor.waitForIdle();
  } finally {
    mounted?.unmount();
    if (prevChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = prevChrome;
    }
    offscreenCtrl?.dispose();
    bg.dispose();
  }
});

// ============================================================================
// P1-4 (& P2-5 emit cleanup) Regression: Mixed Image + Video Posts
// ============================================================================

test("P1-4 & P2-5: Mixed image + video posts (1img+1vid, 2img+1vid, 2vid+1img, LivePhoto+vid) preserve every item in classifyMediaLayout, subfolder/ZIP builders, SidePanelResult.vue, and buildEnqueueItemsForMedia", async () => {
  const SidePanelResult = await loadSidePanelSfc(
    "../src/extension/components/SidePanelResult.vue",
  );

  // P2-5: unused "resolve-lazy-item" emit removed from SidePanelResult.vue
  const declaredEmits = Array.isArray(SidePanelResult.emits)
    ? SidePanelResult.emits
    : Object.keys(SidePanelResult.emits || {});
  assert.equal(
    declaredEmits.includes("resolve-lazy-item"),
    false,
    "Unused resolve-lazy-item emit must be removed from SidePanelResult.vue",
  );

  const mkImg = (id, idx, url = `https://scontent.cdninstagram.com/v/${id}.jpg`) => ({
    id,
    type: "image",
    index: idx,
    variants: [
      {
        id: `${id}-orig`,
        metadata: { extension: "jpg" },
        delivery: { kind: "file", sources: [{ url, size_bytes: 1024 }] },
      },
    ],
    default: { variant_id: `${id}-orig`, url },
  });

  const mkVid = (id, idx, base = `https://video.twimg.com/ext_tw_video/${id}`) => ({
    id,
    type: "video",
    index: idx,
    duration_ms: 15_000,
    cover: { url: "https://pbs.twimg.com/media/thumb.jpg" },
    variants: [
      {
        id: `${id}-1080p`,
        label: "1080p",
        metadata: { width: 1920, height: 1080, extension: "mp4", has_audio: true },
        delivery: {
          kind: "file",
          sources: [{ url: `${base}_1080.mp4`, size_bytes: 4096 }],
        },
      },
      {
        id: `${id}-720p`,
        label: "720p",
        metadata: { width: 1280, height: 720, extension: "mp4", has_audio: true },
        delivery: {
          kind: "file",
          sources: [{ url: `${base}_720.mp4`, size_bytes: 2048 }],
        },
      },
    ],
    default: { variant_id: `${id}-720p`, url: `${base}_720.mp4` },
  });

  const baseSettings = {
    apiBaseUrl: "https://snap.dokitool.com",
    bearerToken: "tok",
    subfolderPrefix: "DokiTool",
    batchSaveMode: "subfolder",
    qualityPreference: "best",
    autoFollowTab: true,
    theme: "system",
  };

  const mixedCases = [
    {
      name: "1 image + 1 video",
      media: {
        platform: "instagram",
        content_id: "mix-1i1v",
        title: "IG一图一视频",
        items: [mkImg("img1", 1), mkVid("vid2", 2)],
      },
      expectedSubfolderFiles: [
        "DokiTool/IG一图一视频/001.jpg",
        "DokiTool/IG一图一视频/002.mp4",
      ],
      expectedZipEntries: ["001.jpg", "002.mp4"],
    },
    {
      name: "2 images + 1 video",
      media: {
        platform: "instagram",
        content_id: "mix-2i1v",
        title: "IG两图一视频",
        items: [mkImg("img1", 1), mkImg("img2", 2), mkVid("vid3", 3)],
      },
      expectedSubfolderFiles: [
        "DokiTool/IG两图一视频/001.jpg",
        "DokiTool/IG两图一视频/002.jpg",
        "DokiTool/IG两图一视频/003.mp4",
      ],
      expectedZipEntries: ["001.jpg", "002.jpg", "003.mp4"],
    },
    {
      name: "2 videos + 1 image",
      media: {
        platform: "x",
        content_id: "mix-2v1i",
        title: "X两视频一图",
        items: [mkVid("vid1", 1), mkVid("vid2", 2), mkImg("img3", 3)],
      },
      expectedSubfolderFiles: [
        "DokiTool/X两视频一图/001.mp4",
        "DokiTool/X两视频一图/002.mp4",
        "DokiTool/X两视频一图/003.jpg",
      ],
      expectedZipEntries: ["001.mp4", "002.mp4", "003.jpg"],
    },
  ];

  for (const tc of mixedCases) {
    assert.equal(
      uiTargetHelpersMod.classifyMediaLayout(tc.media),
      "mixed",
      `${tc.name} must classify as "mixed"`,
    );

    const entries = tc.media.items.map((item, idx) => ({
      item,
      ordinalIndex: idx + 1,
    }));

    // 1) UI checklist subfolder builder
    const subItems = uiTargetHelpersMod.buildChecklistSubfolderEnqueueItems({
      media: tc.media,
      entries,
      totalCount: tc.media.items.length,
      settings: baseSettings,
      livePhotoFilter: "both",
    });
    assert.deepEqual(
      subItems.map((i) => i.spec.filename),
      tc.expectedSubfolderFiles,
      `${tc.name} UI subfolder filenames`,
    );

    // 2) UI checklist ZIP builder
    const zipBuilt = uiTargetHelpersMod.buildChecklistZipEnqueueItem({
      media: tc.media,
      entries,
      totalCount: tc.media.items.length,
      settings: baseSettings,
      livePhotoFilter: "both",
    });
    assert.equal(zipBuilt.ok, true, `${tc.name} UI zip builder ok`);
    assert.deepEqual(
      zipBuilt.item.spec.zipEntries.map((z) => z.entryName),
      tc.expectedZipEntries,
      `${tc.name} UI zip entries`,
    );

    // 3) Background quick-download / batch-URL builder (extensionDownload.buildEnqueueItemsForMedia)
    const bgSubItems = extensionDownloadMod.buildEnqueueItemsForMedia(tc.media, {
      apiOrigin: "https://snap.dokitool.com",
      subfolderPrefix: "DokiTool",
      batchSaveMode: "subfolder",
      qualityPreference: "best",
    });
    assert.deepEqual(
      bgSubItems.map((i) => i.spec.filename),
      tc.expectedSubfolderFiles,
      `${tc.name} buildEnqueueItemsForMedia subfolder`,
    );

    const bgZipItems = extensionDownloadMod.buildEnqueueItemsForMedia(tc.media, {
      apiOrigin: "https://snap.dokitool.com",
      subfolderPrefix: "DokiTool",
      batchSaveMode: "zip",
      qualityPreference: "best",
    });
    assert.equal(bgZipItems.length, 1);
    assert.equal(bgZipItems[0].spec.kind, "batch_zip");
    assert.deepEqual(
      bgZipItems[0].spec.zipEntries.map((z) => z.entryName),
      tc.expectedZipEntries,
      `${tc.name} buildEnqueueItemsForMedia zip`,
    );

    // 4) Interactive SidePanelResult.vue mount verification
    const emittedEnqueues = [];
    const view = mountSfcTree(
      SidePanelResult,
      {
        media: tc.media,
        workFingerprint: `${tc.media.platform}:${tc.media.content_id}`,
        isSaved: false,
        settings: baseSettings,
        resolvingItemIds: new Set(),
      },
      {
        onEnqueueDownloads: (payload) => emittedEnqueues.push(payload),
      },
    );
    try {
      await view.flush();
      const renderedText = view.textOf();
      const n = tc.media.items.length;
      assert.match(renderedText, /图片/, `${tc.name} shows 图片 badge`);
      assert.match(renderedText, /视频/, `${tc.name} shows 视频 badge`);
      assert.ok(
        renderedText.includes(`按标题存子文件夹 · 已选条目 (${n}/${n})`),
        `${tc.name} renders mixed subfolder button count`,
      );
      assert.ok(
        renderedText.includes(`打包 ZIP (${n})`),
        `${tc.name} renders mixed ZIP button count`,
      );

      // Click the video item in the mixed list -> stage switches to <video> AND shows quality variant cards!
      const videoIdx = tc.media.items.findIndex((it) => it.type === "video");
      const rowBodies = view.findAll(
        (node) =>
          node.type === "button" &&
          typeof node.props.class === "string" &&
          node.props.class.includes("sp-mixed-row__body"),
      );
      assert.equal(rowBodies.length, n);
      await view.fire(rowBodies[videoIdx], "onClick");

      const stageVideos = view.findAll((node) => node.type === "video");
      assert.equal(stageVideos.length, 1, `${tc.name} renders <video> stage when video item selected`);
      assert.match(stageVideos[0].props.src, /_1080\.mp4$/);
      assert.match(view.textOf(), /画质与音轨选择/, `${tc.name} shows quality selector for video item`);

      // Switch video item's quality variant to 720p and click Subfolder + ZIP buttons!
      const variant720Btn = view.findAll(
        (node) =>
          node.type === "button" &&
          typeof node.props.class === "string" &&
          node.props.class.includes("sp-variant-card") &&
          view.textOf(node).includes("720p"),
      )[0];
      assert.ok(variant720Btn, `${tc.name} renders 720p variant card`);
      await view.fire(variant720Btn, "onClick");
      assert.match(view.findAll((node) => node.type === "video")[0].props.src, /_720\.mp4$/);

      const subfolderBtn = view.findAll(
        (node) =>
          node.type === "button" &&
          typeof node.props.class === "string" &&
          node.props.class.includes("sp-batch-actions__subfolder"),
      )[0];
      await view.fire(subfolderBtn, "onClick");
      assert.equal(emittedEnqueues.length, 1);
      assert.equal(emittedEnqueues[0].items.length, n);
      assert.match(
        emittedEnqueues[0].items[videoIdx].spec.routes[0],
        /_720\.mp4$/,
        "Chosen 720p variant honored in mixed subfolder download",
      );

      // Test 全选 / 反选 checkboxes
      const invertBtn = view.findAll(
        (node) => node.type === "button" && view.textOf(node).trim() === "反选",
      )[0];
      await view.fire(invertBtn, "onClick");
      assert.ok(view.textOf().includes(`按标题存子文件夹 · 已选条目 (0/${n})`));
      const selectAllBtn = view.findAll(
        (node) => node.type === "button" && view.textOf(node).trim() === "全选",
      )[0];
      await view.fire(selectAllBtn, "onClick");
      assert.ok(view.textOf().includes(`按标题存子文件夹 · 已选条目 (${n}/${n})`));
    } finally {
      view.unmount();
    }
  }

  // Also verify LivePhoto + Video mixed post 3-way filter ("both" | "video" | "image")
  const livePlusVideoMedia = {
    platform: "xiaohongshu",
    content_id: "xhs-live-mix",
    title: "小红书实况加视频混排",
    items: [
      {
        id: "lp1",
        type: "live_photo",
        index: 1,
        variants: [
          {
            id: "pair",
            delivery: {
              kind: "pair",
              resources: [
                {
                  id: "img",
                  role: "image",
                  metadata: { extension: "jpg" },
                  delivery: {
                    kind: "file",
                    sources: [{ url: "https://sns-webpic-qc.xhscdn.com/lp1.jpg" }],
                  },
                },
                {
                  id: "mot",
                  role: "motion",
                  metadata: { extension: "mp4" },
                  delivery: {
                    kind: "file",
                    sources: [{ url: "https://sns-video-bd.xhscdn.com/lp1.mp4" }],
                  },
                },
              ],
            },
          },
        ],
        default: null,
        default_unavailable_reason: "processing_required",
      },
      mkVid("vid2", 2, "https://sns-video-bd.xhscdn.com/v2"),
    ],
  };
  assert.equal(uiTargetHelpersMod.classifyMediaLayout(livePlusVideoMedia), "mixed");
  const lpEntries = livePlusVideoMedia.items.map((item, idx) => ({
    item,
    ordinalIndex: idx + 1,
  }));
  assert.equal(
    uiTargetHelpersMod.buildChecklistSubfolderEnqueueItems({
      media: livePlusVideoMedia,
      entries: lpEntries,
      totalCount: 2,
      settings: baseSettings,
      livePhotoFilter: "both",
    }).length,
    3,
  );
  assert.equal(
    uiTargetHelpersMod.buildChecklistSubfolderEnqueueItems({
      media: livePlusVideoMedia,
      entries: lpEntries,
      totalCount: 2,
      settings: baseSettings,
      livePhotoFilter: "video",
    }).length,
    2,
  );
  assert.equal(
    uiTargetHelpersMod.buildChecklistSubfolderEnqueueItems({
      media: livePlusVideoMedia,
      entries: lpEntries,
      totalCount: 2,
      settings: baseSettings,
      livePhotoFilter: "image",
    }).length,
    2,
  );
});

// ============================================================================
// P2-2, P2-3, P2-4 & P2-5 Hardening Regression Suite
// ============================================================================

test("P2-2, P2-3, P2-4 & P2-5: quick-download batchSaveMode=zip, concurrent YouTube extraAllowedOrigins Map, serialized runTestConnection DNR & RETRY_TASK chromeDownloadId clear, SidePanelBatchQueue batch- filter, and deterministic YouTube activeSlots cleanup", async () => {
  // 1) P2-2: Right-click CONTEXT_MENU_QUICK_DOWNLOAD_ID honors settings.batchSaveMode ("zip" vs "subfolder")
  const opfs = createMockOpfs();
  const urlApi = createTrackedUrlApi();
  const mockFetch = async (url) => {
    if (url.startsWith("https://snap.dokitool.com/api/parse")) {
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            platform: "weibo",
            content_id: "ZipGallery",
            title: "右键打包测试图集",
            items: [
              {
                id: "i1",
                type: "image",
                index: 1,
                variants: [
                  {
                    id: "o",
                    metadata: { extension: "jpg" },
                    delivery: {
                      kind: "file",
                      sources: [{ url: "https://wx1.sinaimg.cn/large/1.jpg" }],
                    },
                  },
                ],
                default: { variant_id: "o", url: "https://wx1.sinaimg.cn/large/1.jpg" },
              },
              {
                id: "i2",
                type: "image",
                index: 2,
                variants: [
                  {
                    id: "o",
                    metadata: { extension: "jpg" },
                    delivery: {
                      kind: "file",
                      sources: [{ url: "https://wx2.sinaimg.cn/large/2.jpg" }],
                    },
                  },
                ],
                default: { variant_id: "o", url: "https://wx2.sinaimg.cn/large/2.jpg" },
              },
            ],
            default_item_id: "i1",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/platforms")) {
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: { platforms: [{ id: "weibo" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    });
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

  // Instrument updateDynamicRules to verify P2-4 dnrMutex serialization!
  let inFlightDnr = 0;
  let maxConcurrentDnr = 0;
  const origUpdateDnr = env.chrome.declarativeNetRequest.updateDynamicRules;
  env.chrome.declarativeNetRequest.updateDynamicRules = async (opts) => {
    inFlightDnr += 1;
    maxConcurrentDnr = Math.max(maxConcurrentDnr, inFlightDnr);
    await new Promise((r) => setTimeout(r, 20));
    try {
      return await origUpdateDnr(opts);
    } finally {
      inFlightDnr -= 1;
    }
  };

  const extStorage = storage.createExtensionStorage();
  await extStorage.updateSettings({
    subfolderPrefix: "Collect",
    batchSaveMode: "zip",
  });

  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    fetchImpl: mockFetch,
  });
  await bg.init();

  env.emitContextMenuClick(
    {
      menuItemId: protocol.CONTEXT_MENU_QUICK_DOWNLOAD_ID,
      linkUrl: "https://weibo.com/11111/ZipGallery",
    },
    { id: 10, windowId: 1 },
  );
  await bg.waitForIdle();
  await offscreenCtrl.executor.waitForIdle();
  assert.deepEqual(
    env.downloadCalls.map((d) => d.filename),
    ["Collect/右键打包测试图集.zip"],
    "Quick-download must pack gallery into ZIP when settings.batchSaveMode === 'zip'",
  );

  // 2) P2-4a: Concurrent runTestConnection + UPDATE_SETTINGS + syncDynamicDnrRules serialize through dnrMutex
  maxConcurrentDnr = 0;
  await Promise.all([
    env.chrome.runtime.sendMessage({
      type: "TEST_CONNECTION",
      apiBaseUrl: "https://mirror-one.dokitool.example",
    }),
    env.chrome.runtime.sendMessage({
      type: "UPDATE_SETTINGS",
      patch: { apiBaseUrl: "https://mirror-two.dokitool.example" },
    }),
    bg.syncDynamicDnrRules(["https://mirror-three.dokitool.example"]),
  ]);
  assert.equal(
    maxConcurrentDnr,
    1,
    "All dynamic DNR updates (including runTestConnection) must serialize through dnrMutex",
  );

  // 3) P2-4b: RETRY_TASK clears stale chromeDownloadId so cancelling before handoff never cancels old downloadId
  const envRetry = createMockMv3Environment({ autoCompleteDownloads: false });
  let hangSecondDispatch = false;
  let releaseSecondDispatch = () => {};
  const secondDispatchGate = new Promise((r) => {
    releaseSecondDispatch = r;
  });
  const retryFetch = async () => {
    if (hangSecondDispatch) {
      await secondDispatchGate;
    }
    return new Response(new Uint8Array([7, 8, 9]), {
      status: 200,
      headers: { "Content-Type": "video/mp4" },
    });
  };
  let offRetry = null;
  const envRetryWithHook = createMockMv3Environment({
    autoCompleteDownloads: false,
    async spawnOffscreenHook() {
      if (!offRetry) {
        const retryOpfs = createMockOpfs();
        offRetry = offscreenMod.createOffscreenController({
          chrome: envRetryWithHook.chrome,
          fetchImpl: retryFetch,
          opfsStorage: retryOpfs.storage,
          webLocks: retryOpfs.locks,
          urlApi: createTrackedUrlApi(),
        });
      }
    },
  });
  Object.assign(envRetry, envRetryWithHook);
  const bgRetry = backgroundMod.createBackgroundController({
    chrome: envRetryWithHook.chrome,
    storage: storage.createExtensionStorage(),
    fetchImpl: retryFetch,
  });
  await bgRetry.init();

  const enq1 = await envRetryWithHook.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "RetryIdTest",
        platform: "bilibili",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://upos-sz-mirrorcos.bilivideo.com/retry.mp4"],
          filename: "retry.mp4",
          mimeType: "video/mp4",
        },
      },
    ],
  });
  const retryTaskId = enq1.data.taskIds[0];
  for (let i = 0; i < 50 && envRetryWithHook.downloadCalls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const firstDlId = envRetryWithHook.downloadCalls[0].id;
  envRetryWithHook.emitDownloadChanged({
    id: firstDlId,
    state: { current: "interrupted" },
    error: { current: "NETWORK_FAILED" },
  });
  await bgRetry.waitForIdle();
  assert.equal((await bgRetry.getSnapshot()).tasks[0].chromeDownloadId, firstDlId);

  hangSecondDispatch = true;
  const retriedRpc = await envRetryWithHook.chrome.runtime.sendMessage({
    type: "RETRY_TASK",
    taskId: retryTaskId,
  });
  assert.equal(retriedRpc.ok, true);
  assert.equal(
    retriedRpc.data.task.chromeDownloadId,
    undefined,
    "RETRY_TASK must clear stale chromeDownloadId",
  );
  await envRetryWithHook.chrome.runtime.sendMessage({
    type: "CANCEL_TASK",
    taskId: retryTaskId,
  });
  assert.deepEqual(
    envRetryWithHook.cancelledDownloads,
    [],
    "Cancelling retried task before new handoff must NOT cancel previous chromeDownloadId",
  );
  releaseSecondDispatch();
  await bgRetry.waitForIdle();
  offRetry?.dispose();
  bgRetry.dispose();

  // 4) P2-3: Concurrent YouTube downloads keep per-task extraAllowedOrigins Map without clobbering on out-of-order completion
  const payloadA = new Uint8Array(512).fill(0xaa);
  const payloadB = new Uint8Array(2048).fill(0xbb);
  const ytUrlA = `https://rr1---sn-a5mekn6s.googlevideo.com/videoplayback?expire=9999999999&itag=140&id=taskA&clen=${payloadA.byteLength}`;
  const ytUrlB = `https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=9999999999&itag=140&id=taskB&clen=${payloadB.byteLength}`;

  let releaseTaskBGate = () => {};
  const taskBGate = new Promise((r) => {
    releaseTaskBGate = r;
  });
  let taskBStarted = false;
  const observedAllowedSnapshots = [];

  const interleavingFetch = async (url) => {
    const u = new URL(url);
    if (url.includes("id=taskA")) {
      const [s, e] = (u.searchParams.get("range") || `0-${payloadA.byteLength - 1}`)
        .split("-")
        .map(Number);
      const slice = payloadA.slice(s, e + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Type": "audio/mp4",
          "Content-Range": `bytes ${s}-${s + slice.byteLength - 1}/${payloadA.byteLength}`,
        },
      });
    }
    if (url.includes("id=taskB")) {
      const [s, e] = (u.searchParams.get("range") || `0-${payloadB.byteLength - 1}`)
        .split("-")
        .map(Number);
      if (s === 0) {
        taskBStarted = true;
        observedAllowedSnapshots.push({
          phase: "both-active",
          origins: concExec.getActiveDynamicAllowedOrigins(),
        });
        await taskBGate;
      } else {
        observedAllowedSnapshots.push({
          phase: "after-task-a-finished",
          origins: concExec.getActiveDynamicAllowedOrigins(),
        });
      }
      const slice = payloadB.slice(s, e + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Type": "audio/mp4",
          "Content-Range": `bytes ${s}-${s + slice.byteLength - 1}/${payloadB.byteLength}`,
        },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const concErrors = [];
  const concCompleted = [];
  const concUrlApi = createTrackedUrlApi();
  const concOpfs = createMockOpfs();
  const concExec = extensionDownloadMod.createOffscreenDownloadExecutor({
    fetchImpl: interleavingFetch,
    opfsStorage: concOpfs.storage,
    webLocks: concOpfs.locks,
    urlApi: concUrlApi,
    maxConcurrentTasks: 3,
    youtubeMuxConfig: { chunkSize: 1024, audioConcurrency: 1, videoConcurrency: 1 },
    onError: (e) => concErrors.push(e),
    async handoffBlobDownload(msg) {
      concCompleted.push(msg.taskId);
      queueMicrotask(() => {
        concExec.releaseBlob({
          taskId: msg.taskId,
          blobUrl: msg.blobUrl,
          opfsTempName: msg.opfsTempName,
        });
      });
      return { chromeDownloadId: 1 };
    },
  });

  concExec.startTask("yt-conc-a", {
    kind: "youtube_direct",
    apiOrigin: "https://api-a.dokitool.example",
    extraAllowedOrigins: ["https://api-a.dokitool.example"],
    routes: [ytUrlA],
    filename: "a.m4a",
    sizeBytes: payloadA.byteLength,
  });
  concExec.startTask("yt-conc-b", {
    kind: "youtube_direct",
    apiOrigin: "https://api-b.dokitool.example",
    extraAllowedOrigins: ["https://api-b.dokitool.example"],
    routes: [ytUrlB],
    filename: "b.m4a",
    sizeBytes: payloadB.byteLength,
  });

  // Wait until Task A finishes completely (including its `finally` deleting yt-conc-a) while Task B is still in-flight!
  for (let i = 0; i < 50 && (!concCompleted.includes("yt-conc-a") || !taskBStarted); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(concCompleted.includes("yt-conc-a"), true, "Task A finished first");
  assert.deepEqual(concExec.getActiveDynamicAllowedOrigins(), [
    "https://api-b.dokitool.example",
  ]);
  releaseTaskBGate();
  await concExec.waitForIdle();
  assert.deepEqual(concErrors, [], "Task B extraAllowedOrigins must NOT be wiped by Task A finishing");
  assert.deepEqual(concCompleted, ["yt-conc-a", "yt-conc-b"]);
  assert.equal(concExec.getActiveDynamicAllowedOrigins(), undefined);
  assert.deepEqual(
    observedAllowedSnapshots.find((s) => s.phase === "both-active")?.origins?.sort(),
    ["https://api-a.dokitool.example", "https://api-b.dokitool.example"],
  );
  assert.deepEqual(
    observedAllowedSnapshots.find((s) => s.phase === "after-task-a-finished")?.origins,
    ["https://api-b.dokitool.example"],
  );
  concExec.dispose();

  // 5) P2-5a: SidePanelBatchQueue.vue ignores `subfolder-...` tasks when activeBatchGroupId is empty
  const SidePanelBatchQueue = await loadSidePanelSfc(
    "../src/extension/components/SidePanelBatchQueue.vue",
  );
  const batchView = mountSfcTree(SidePanelBatchQueue, {
    modelValue: "",
    settings: await extStorage.getSettings(),
    tasks: [
      {
        taskId: "sub-1",
        groupBatchId: "subfolder-1700000001",
        title: "图集 #1",
        filename: "001.jpg",
        platform: "weibo",
        status: "completed",
        statusText: "已完成",
        percent: 100,
        loaded: 10,
        total: 10,
        speed: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    activeBatchGroupId: "",
    submitting: false,
  });
  try {
    await batchView.flush();
    assert.equal(
      batchView.textOf().includes("当前批次进度"),
      false,
      "subfolder-... tasks must NOT appear in SidePanelBatchQueue current-batch card",
    );
    batchView.propsRef.value = {
      ...batchView.propsRef.value,
      tasks: [
        ...batchView.propsRef.value.tasks,
        {
          taskId: "b-1",
          groupBatchId: "batch-1700000002-1",
          title: "批量 #1",
          filename: "b1.mp4",
          platform: "douyin",
          status: "downloading",
          statusText: "下载中",
          percent: 50,
          loaded: 5,
          total: 10,
          speed: 100,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    };
    await batchView.flush();
    assert.equal(
      batchView.textOf().includes("当前批次进度"),
      true,
      "batch-... tasks DO appear in SidePanelBatchQueue current-batch card",
    );
    assert.match(batchView.textOf(), /进行中 1 · 完成 0 · 失败 0/);
  } finally {
    batchView.unmount();
  }

  // 6) P2-5b: youtubeExtensionBridge cleans activeSlots deterministically even when releaseBlob arrives well after abort
  let pendingHandoffMsg = null;
  const abortCtrl = new AbortController();
  const bridgeOpfs = createMockOpfs();
  const bridge = youtubeBridgeMod.createYouTubeExtensionBridge({
    urlApi: createTrackedUrlApi(),
    opfsStorage: bridgeOpfs.storage,
    webLocks: bridgeOpfs.locks,
    fetchImpl: async () =>
      new Response(payloadA, {
        status: 206,
        headers: {
          "Content-Type": "audio/mp4",
          "Content-Range": `bytes 0-${payloadA.byteLength - 1}/${payloadA.byteLength}`,
        },
      }),
    async handoffBlobDownload(msg) {
      pendingHandoffMsg = msg;
      // Trigger abort WHILE blob is already registered in pendingBlobs!
      abortCtrl.abort();
      return { chromeDownloadId: 77 };
    },
  });

  const directPromise = bridge
    .downloadDirect({
      taskId: "slot-race-task",
      url: ytUrlA,
      filename: "slot-race.m4a",
      sizeBytes: payloadA.byteLength,
      signal: abortCtrl.signal,
    })
    .catch(() => null);

  for (let i = 0; i < 50 && !pendingHandoffMsg; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(pendingHandoffMsg, "handoffBlobDownload reached before abort");
  // Wait 30ms (long past any 0ms setTimeout!) while pendingBlob is still held
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(bridge.getPendingBlobCount(), 1);
  assert.equal(bridge.getActiveSlotCount(), 1);
  // Now release the blob -> activeSlots MUST deterministically drop to 0!
  bridge.releaseBlob({
    taskId: "slot-race-task",
    blobUrl: pendingHandoffMsg.blobUrl,
  });
  await directPromise;
  assert.equal(bridge.getPendingBlobCount(), 0);
  assert.equal(
    bridge.getActiveSlotCount(),
    0,
    "activeSlots must be cleaned deterministically once pending blob releases",
  );
  bridge.dispose();

  offscreenCtrl?.dispose();
  bg.dispose();
});

// ============================================================================
// Theme Persistence, Migration, Zero-Flash Sync & SidePanel UI Controls
// ============================================================================

test("SidePanel Theme: storage defaults, persistence, migration fallback, zero-flash cache helper, and Header/Settings UI", async () => {
  const localArea = storage.createMemoryStorageArea();
  const extStorage = storage.createExtensionStorage({ local: localArea });

  // 1) Default theme is "system"
  assert.equal(storage.DEFAULT_EXTENSION_SETTINGS.theme, "system");
  const initial = await extStorage.getSettings();
  assert.equal(initial.theme, "system");

  // 2) Persist light -> dark -> system via updateSettings
  for (const mode of ["light", "dark", "system"]) {
    const saved = await extStorage.updateSettings({ theme: mode });
    assert.equal(saved.theme, mode);
    const reloaded = await extStorage.getSettings();
    assert.equal(reloaded.theme, mode);
  }

  // 3) Seamless migration: missing or corrupt stored theme falls back to "system"
  //    without losing existing bearerToken, apiBaseUrl, subfolderPrefix, or autoFollowTab!
  await localArea.set({
    [storage.STORAGE_KEYS.SETTINGS]: {
      apiBaseUrl: "https://api.example.com",
      bearerToken: "doki_existing_token_999",
      subfolderPrefix: "MyClips",
      batchSaveMode: "zip",
      qualityPreference: "1080p",
      autoFollowTab: true,
      autoFollowExplicitlySet: true,
    },
  });
  const migratedMissing = await extStorage.getSettings();
  assert.equal(migratedMissing.theme, "system");
  assert.equal(migratedMissing.bearerToken, "doki_existing_token_999");
  assert.equal(migratedMissing.apiBaseUrl, "https://api.example.com");
  assert.equal(migratedMissing.subfolderPrefix, "MyClips");
  assert.equal(migratedMissing.batchSaveMode, "zip");
  assert.equal(migratedMissing.qualityPreference, "1080p");
  assert.equal(migratedMissing.autoFollowTab, true);

  await localArea.set({
    [storage.STORAGE_KEYS.SETTINGS]: {
      apiBaseUrl: "https://api.example.com",
      bearerToken: "doki_existing_token_999",
      theme: "neon-corrupt",
    },
  });
  const migratedCorrupt = await extStorage.getSettings();
  assert.equal(migratedCorrupt.theme, "system");
  assert.equal(migratedCorrupt.bearerToken, "doki_existing_token_999");
  assert.equal(migratedCorrupt.apiBaseUrl, "https://api.example.com");

  const sanitizedPatch = await extStorage.updateSettings({ theme: "invalid-mode" });
  assert.equal(sanitizedPatch.theme, "system");
  assert.equal(sanitizedPatch.bearerToken, "doki_existing_token_999");

  // 4) Zero-flash HTML & MV3 CSP contract: sidepanel.html has no hardcoded dark class and zero inline <script>
  const sidepanelHtml = readFileSync(
    join(FRONTEND_DIR, "src", "extension", "sidepanel.html"),
    "utf8",
  );
  assert.match(sidepanelHtml, /<html lang="zh-CN">/);
  assert.equal(sidepanelHtml.includes('class="dark"'), false);
  assert.equal(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(sidepanelHtml), false);

  // 5) applyExtensionTheme / applyCachedExtensionTheme / getNextExtensionTheme
  const fakeStorage = new Map();
  const origLocalStorage = globalThis.localStorage;
  const origDocument = globalThis.document;
  const fakeRoot = { dataset: {} };
  globalThis.localStorage = {
    getItem: (k) => (fakeStorage.has(k) ? fakeStorage.get(k) : null),
    setItem: (k, v) => {
      fakeStorage.set(k, String(v));
    },
    removeItem: (k) => fakeStorage.delete(k),
  };
  globalThis.document = { documentElement: fakeRoot };

  try {
    assert.equal(uiTargetHelpersMod.getNextExtensionTheme("system"), "light");
    assert.equal(uiTargetHelpersMod.getNextExtensionTheme("light"), "dark");
    assert.equal(uiTargetHelpersMod.getNextExtensionTheme("dark"), "system");

    uiTargetHelpersMod.applyExtensionTheme("light");
    assert.equal(fakeRoot.dataset.theme, "light");
    assert.equal(
      fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
      "light",
    );

    uiTargetHelpersMod.applyExtensionTheme("dark");
    assert.equal(fakeRoot.dataset.theme, "dark");
    assert.equal(
      fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
      "dark",
    );

    // Preview with persistCache:false does NOT overwrite localStorage cache
    uiTargetHelpersMod.applyExtensionTheme("light", { persistCache: false });
    assert.equal(fakeRoot.dataset.theme, "light");
    assert.equal(
      fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
      "dark",
    );

    // applyCachedExtensionTheme restores cached "dark" synchronously on boot
    delete fakeRoot.dataset.theme;
    const restored = uiTargetHelpersMod.applyCachedExtensionTheme();
    assert.equal(restored, "dark");
    assert.equal(fakeRoot.dataset.theme, "dark");

    // "system" deletes data-theme attribute so live prefers-color-scheme takes over
    uiTargetHelpersMod.applyExtensionTheme("system");
    assert.equal("theme" in fakeRoot.dataset, false);
    assert.equal(
      fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
      "system",
    );

    // 6) SidePanelHeader quick theme cycle button tooltips & emit
    const SidePanelHeader = await loadSidePanelSfc(
      "../src/extension/components/SidePanelHeader.vue",
    );
    let cycleEmits = 0;
    const headerView = mountSfcTree(
      SidePanelHeader,
      {
        settings: { ...storage.DEFAULT_EXTENSION_SETTINGS, theme: "system" },
        connection: null,
        mode: "single",
        batchUrlCount: 0,
      },
      {
        onCycleTheme: () => {
          cycleEmits += 1;
        },
      },
    );
    try {
      await headerView.flush();
      const findThemeBtn = () =>
        headerView.findAll(
          (node) =>
            node.type === "button" &&
            typeof node.props.class === "string" &&
            node.props.class.includes("sp-theme-btn"),
        )[0];

      assert.equal(
        findThemeBtn()?.props.title,
        "主题：跟随系统（点击切换为浅色）",
      );
      await headerView.fire(findThemeBtn(), "onClick");
      assert.equal(cycleEmits, 1);

      headerView.propsRef.value = {
        ...headerView.propsRef.value,
        settings: { ...storage.DEFAULT_EXTENSION_SETTINGS, theme: "light" },
      };
      await headerView.flush();
      assert.equal(findThemeBtn()?.props.title, "主题：浅色（点击切换为深色）");

      headerView.propsRef.value = {
        ...headerView.propsRef.value,
        settings: { ...storage.DEFAULT_EXTENSION_SETTINGS, theme: "dark" },
      };
      await headerView.flush();
      assert.equal(
        findThemeBtn()?.props.title,
        "主题：深色（点击切换为跟随系统）",
      );
    } finally {
      headerView.unmount();
    }

    // 7) SidePanelSettings 3-way segmented control: live preview, restore on cancel, persist on save
    const SidePanelSettings = await loadSidePanelSfc(
      "../src/extension/components/SidePanelSettings.vue",
    );
    const savedPatches = [];
    const savedEvents = [];
    const origChrome = globalThis.chrome;
    globalThis.chrome = {
      runtime: {
        sendMessage(req, cb) {
          if (req?.type === "UPDATE_SETTINGS") {
            savedPatches.push(req.patch);
            cb?.({
              ok: true,
              data: {
                settings: {
                  ...storage.DEFAULT_EXTENSION_SETTINGS,
                  ...req.patch,
                },
              },
            });
            return;
          }
          cb?.({
            ok: true,
            data: {
              ok: true,
              status: 200,
              authMode: "anonymous",
              platformCount: 14,
              message: "200 OK",
              checkedAt: Date.now(),
            },
          });
        },
      },
    };

    uiTargetHelpersMod.applyExtensionTheme("dark");
    const settingsView = mountSfcTree(
      SidePanelSettings,
      {
        open: true,
        settings: { ...storage.DEFAULT_EXTENSION_SETTINGS, theme: "dark" },
        connection: null,
      },
      {
        onSaved: (next) => savedEvents.push(next),
        onClose: () => {
          settingsView.propsRef.value = {
            ...settingsView.propsRef.value,
            open: false,
          };
        },
      },
    );
    try {
      await settingsView.flush();
      assert.match(settingsView.textOf(), /外观主题/);
      const lightChoice = settingsView.findAll(
        (node) =>
          node.type === "button" &&
          typeof node.props.class === "string" &&
          node.props.class.includes("sp-theme-choice") &&
          settingsView.textOf(node).trim() === "浅色",
      )[0];
      assert.ok(lightChoice, "renders 浅色 theme option");

      // Click 浅色 -> live previews light theme without persisting cache yet
      await settingsView.fire(lightChoice, "onClick");
      assert.equal(fakeRoot.dataset.theme, "light");
      assert.equal(
        fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
        "dark",
      );

      // Click 取消 -> closes and restores saved "dark" theme
      const cancelBtn = settingsView.findAll(
        (node) =>
          node.type === "button" && settingsView.textOf(node).trim() === "取消",
      )[0];
      await settingsView.fire(cancelBtn, "onClick");
      assert.equal(fakeRoot.dataset.theme, "dark");

      // Reopen, select 浅色, click 保存设置 -> sends UPDATE_SETTINGS { theme: "light" } and persists cache
      settingsView.propsRef.value = {
        ...settingsView.propsRef.value,
        open: true,
      };
      await settingsView.flush();
      const lightChoice2 = settingsView.findAll(
        (node) =>
          node.type === "button" &&
          typeof node.props.class === "string" &&
          node.props.class.includes("sp-theme-choice") &&
          settingsView.textOf(node).trim() === "浅色",
      )[0];
      await settingsView.fire(lightChoice2, "onClick");
      const saveBtn = settingsView.findAll(
        (node) =>
          node.type === "button" &&
          settingsView.textOf(node).trim() === "保存设置",
      )[0];
      await settingsView.fire(saveBtn, "onClick");
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(savedPatches.length, 1);
      assert.equal(savedPatches[0].theme, "light");
      assert.equal(savedEvents[0]?.theme, "light");
      assert.equal(fakeRoot.dataset.theme, "light");
      assert.equal(
        fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
        "light",
      );
    } finally {
      settingsView.unmount();
      globalThis.chrome = origChrome;
    }
  } finally {
    globalThis.localStorage = origLocalStorage;
    globalThis.document = origDocument;
  }
});

// ============================================================================
// Dynamic Action Tooltip (chrome.action.setTitle) & Percentage Badge Tests
// ============================================================================

test("computeActionIndicator: pure state computation for single, multi-task aggregate, and terminal outcomes", () => {
  const mkTask = (overrides) => ({
    taskId: "t1",
    title: "测试视频标题",
    filename: "test.mp4",
    platform: "bilibili",
    status: "downloading",
    statusText: "下载中",
    percent: 0,
    loaded: 0,
    total: 0,
    speed: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

  // Idle / clear
  const idle = backgroundMod.computeActionIndicator([]);
  assert.deepEqual(idle, {
    badgeText: "",
    title: backgroundMod.DEFAULT_ACTION_TITLE,
    shouldScheduleClear: false,
  });

  // Single task: queued / parsing / 0% downloading -> badge "1"
  const parsing = backgroundMod.computeActionIndicator([
    mkTask({ status: "parsing", percent: 0, title: "抖音极速解析任务" }),
  ]);
  assert.equal(parsing.badgeText, "1");
  assert.equal(parsing.badgeColor, "#6366f1");
  assert.equal(parsing.title, "DokiTool · 解析中\n抖音极速解析任务");
  assert.equal(parsing.shouldScheduleClear, false);

  // Single task: downloading 64% at 4.2 MB/s
  const downloading = backgroundMod.computeActionIndicator([
    mkTask({
      status: "downloading",
      percent: 64,
      speed: 4_200_000,
      title: "超清晰4K航拍风景纪录片",
    }),
  ]);
  assert.equal(downloading.badgeText, "64%");
  assert.equal(downloading.badgeColor, "#6366f1");
  assert.equal(
    downloading.title,
    "DokiTool · 下载中 64% (4.2 MB/s)\n超清晰4K航拍风景纪录片",
  );

  // Single task: KB/s speed formatting, 100% clamped to 99%, long title truncated <= 28 chars
  const longTitle =
    "这是一个非常非常非常非常非常非常非常非常长的视频标题超过二十八个字符";
  const savingLong = backgroundMod.computeActionIndicator([
    mkTask({
      status: "saving",
      percent: 100,
      speed: 680_000,
      title: longTitle,
    }),
  ]);
  assert.equal(savingLong.badgeText, "99%");
  assert.match(savingLong.title, /^DokiTool · 保存中 99% \(680 KB\/s\)\n/);
  const secondLine = savingLong.title.split("\n")[1];
  assert.ok(Array.from(secondLine).length <= 28, "truncated title <= 28 chars");
  assert.ok(secondLine.endsWith("…"));

  // Multi-task byte-weighted aggregate (all active tasks have total > 0)
  // Task 1: 10 MB / 100 MB (10%), speed 2 MB/s; Task 2: 200 MB / 300 MB (67%), speed 3 MB/s
  // Byte-weighted: 210 / 400 = 52.5% -> 53%, total speed 5.0 MB/s
  const multiByteWeighted = backgroundMod.computeActionIndicator([
    mkTask({
      taskId: "t1",
      title: "第一集",
      status: "downloading",
      percent: 10,
      loaded: 10_000_000,
      total: 100_000_000,
      speed: 2_000_000,
    }),
    mkTask({
      taskId: "t2",
      title: "第二集",
      status: "downloading",
      percent: 67,
      loaded: 200_000_000,
      total: 300_000_000,
      speed: 3_000_000,
    }),
  ]);
  assert.equal(multiByteWeighted.badgeText, "53%");
  assert.equal(multiByteWeighted.badgeColor, "#6366f1");
  assert.equal(
    multiByteWeighted.title,
    "DokiTool · 后台下载中 2 个任务 · 总进度 53% (5.0 MB/s)\n当前：第一集 (10%)",
  );

  // Multi-task arithmetic mean fallback when any active task lacks total > 0
  const multiMean = backgroundMod.computeActionIndicator([
    mkTask({
      taskId: "t1",
      title: "分片流A",
      status: "downloading",
      percent: 20,
      total: 0,
      speed: 500_000,
    }),
    mkTask({
      taskId: "t2",
      title: "合流B",
      status: "muxing",
      percent: 60,
      total: 1000,
      loaded: 600,
      speed: 0,
    }),
  ]);
  assert.equal(multiMean.badgeText, "40%");
  assert.equal(
    multiMean.title,
    "DokiTool · 后台下载中 2 个任务 · 总进度 40% (500 KB/s)\n当前：分片流A (20%)",
  );

  // Multi-task indeterminate 0% shows active count
  const multiZero = backgroundMod.computeActionIndicator([
    mkTask({ taskId: "t1", status: "queued", percent: 0, total: 0 }),
    mkTask({ taskId: "t2", status: "parsing", percent: 0, total: 0 }),
  ]);
  assert.equal(multiZero.badgeText, "2");

  // Terminal completed / failed / clear
  const done = backgroundMod.computeActionIndicator(
    [mkTask({ status: "completed", percent: 100 })],
    "completed",
  );
  assert.deepEqual(done, {
    badgeText: "✓",
    badgeColor: "#10b981",
    title: "DokiTool · 后台下载已完成（点击打开侧边栏查看）",
    shouldScheduleClear: true,
  });

  const failed = backgroundMod.computeActionIndicator(
    [mkTask({ status: "failed" })],
    "failed",
  );
  assert.deepEqual(failed, {
    badgeText: "!",
    badgeColor: "#ef4444",
    title: "DokiTool · 有后台任务失败（点击打开侧边栏查看或重试）",
    shouldScheduleClear: false,
  });

  const cleared = backgroundMod.computeActionIndicator([], "clear");
  assert.deepEqual(cleared, {
    badgeText: "",
    title: backgroundMod.DEFAULT_ACTION_TITLE,
    shouldScheduleClear: false,
  });
});

test("Background Controller lifecycle: dynamic setBadgeText & setTitle across parsing -> downloading -> muxing -> saving -> completed -> idle reset, multi-task, deduplication, and failed", async () => {
  const env = createMockMv3Environment({ autoCompleteDownloads: false });

  // Gate parse API response so we can observe the real "parsing" badge ("1") + tooltip before download starts
  let releaseParseGate = () => {};
  const parseGate = new Promise((r) => {
    releaseParseGate = r;
  });
  let parseStarted = false;
  let startedTaskId = "";

  const mockFetch = async (url) => {
    if (String(url).includes("/api/parse")) {
      parseStarted = true;
      await parseGate;
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            platform: "bilibili",
            content_id: "BV1actionTest",
            title: "B站4K测试视频",
            source_url: "https://www.bilibili.com/video/BV1actionTest",
            items: [
              {
                id: "v1",
                type: "video",
                title: "B站4K测试视频",
                variants: [
                  {
                    id: "var-4k",
                    label: "4K",
                    metadata: {
                      extension: "mp4",
                      width: 3840,
                      height: 2160,
                      has_audio: true,
                    },
                    delivery: {
                      kind: "file",
                      sources: [
                        {
                          url: "https://upos-sz-mirrorcos.bilivideo.com/4k.mp4",
                          size_bytes: 100_000_000,
                        },
                      ],
                    },
                  },
                ],
                default: {
                  variant_id: "var-4k",
                  url: "https://upos-sz-mirrorcos.bilivideo.com/4k.mp4",
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  // Stub offscreen message responder so we drive exact OFFSCREEN_TASK_PROGRESS / HANDOFF_BLOB_DOWNLOAD ticks deterministically
  env.chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "OFFSCREEN_START_TASK") {
      startedTaskId = msg.taskId;
      sendResponse({ ok: true, data: { accepted: true } });
      return true;
    }
    if (msg?.type === "RELEASE_BLOB") {
      sendResponse({ ok: true, data: { released: true } });
      return true;
    }
    return false;
  });

  const extStorage = storage.createExtensionStorage();
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    fetchImpl: mockFetch,
    badgeSuccessDurationMs: 45,
  });

  try {
    // 1) init() sets idle badge "" & DEFAULT_ACTION_TITLE
    await bg.init();
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      backgroundMod.DEFAULT_ACTION_TITLE,
    );

    // 2) Single-task full lifecycle: parsing ("1") -> downloading ("42%" + speed) -> dedup -> muxing ("85%") -> saving ("99%") -> completed ("✓") -> idle reset
    env.badgeHistory.length = 0;
    env.emitContextMenuClick(
      {
        menuItemId: protocol.CONTEXT_MENU_QUICK_DOWNLOAD_ID,
        linkUrl: "https://www.bilibili.com/video/BV1actionTest",
      },
      { id: 1, windowId: 10 },
    );

    for (let i = 0; i < 50 && !parseStarted; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(parseStarted, true, "quick-download entered parsing phase");
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "1",
      "parsing phase displays badge '1'",
    );
    assert.match(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title ?? "",
      /^DokiTool · 解析中\n/,
      "parsing phase displays 解析中 tooltip",
    );

    // Release parse gate -> task starts downloading in offscreen
    releaseParseGate();
    for (let i = 0; i < 50 && !startedTaskId; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const taskId = startedTaskId;
    assert.ok(taskId, "offscreen task started");

    // Progress: downloading 42% at 4.2 MB/s
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "downloading",
      statusText: "正在下载...",
      percent: 42,
      loaded: 42_000_000,
      total: 100_000_000,
      speed: 4_200_000,
    });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "42%",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 下载中 42% (4.2 MB/s)\nB站4K测试视频",
    );

    // Identical rapid progress tick MUST NOT spam setBadgeText / setBadgeBackgroundColor / setTitle!
    const historyLenBeforeDup = env.badgeHistory.length;
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "downloading",
      statusText: "正在下载...",
      percent: 42,
      loaded: 42_050_000,
      total: 100_000_000,
      speed: 4_200_000,
    });
    assert.equal(
      env.badgeHistory.length,
      historyLenBeforeDup,
      "Identical indicator values must be deduplicated without spamming Chrome IPC",
    );

    // Progress: muxing 85%
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "muxing",
      statusText: "正在无损合流...",
      percent: 85,
      loaded: 85_000_000,
      total: 100_000_000,
      speed: 0,
    });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "85%",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 合流中 85%\nB站4K测试视频",
    );

    // Handoff -> saving 99%
    const handoff = await env.chrome.runtime.sendMessage({
      type: "HANDOFF_BLOB_DOWNLOAD",
      taskId,
      blobUrl: "blob:chrome-extension://test/1",
      filename: "B站4K测试视频.mp4",
      sizeBytes: 100_000_000,
    });
    assert.equal(handoff.ok, true);
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "99%",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 保存中 99%\nB站4K测试视频",
    );

    // Complete -> badge "✓", color "#10b981", completed title
    env.emitDownloadChanged({
      id: handoff.data.chromeDownloadId,
      state: { current: "complete" },
    });
    await bg.waitForIdle();
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "✓",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "color").at(-1)?.color,
      "#10b981",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 后台下载已完成（点击打开侧边栏查看）",
    );

    // After badgeSuccessDurationMs, BOTH badge "" and title DEFAULT_ACTION_TITLE reset!
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      backgroundMod.DEFAULT_ACTION_TITLE,
    );

    // 3) Multi-task concurrent aggregate percentage & total speed tooltip + failed state
    env.badgeHistory.length = 0;
    const multiEnq = await env.chrome.runtime.sendMessage({
      type: "ENQUEUE_DOWNLOADS",
      items: [
        {
          title: "多任务一",
          platform: "bilibili",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://upos-sz-mirrorcos.bilivideo.com/a.mp4"],
            filename: "a.mp4",
            sizeBytes: 10_000_000,
          },
        },
        {
          title: "多任务二",
          platform: "bilibili",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://upos-sz-mirrorcos.bilivideo.com/b.mp4"],
            filename: "b.mp4",
            sizeBytes: 30_000_000,
          },
        },
      ],
    });
    const [m1, m2] = multiEnq.data.taskIds;
    await new Promise((r) => setTimeout(r, 15));

    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId: m1,
      status: "downloading",
      statusText: "正在下载...",
      percent: 50,
      loaded: 5_000_000,
      total: 10_000_000,
      speed: 1_500_000,
    });
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId: m2,
      status: "downloading",
      statusText: "正在下载...",
      percent: 50,
      loaded: 15_000_000,
      total: 30_000_000,
      speed: 2_500_000,
    });

    // Aggregate: 20MB / 40MB = 50%, total speed 4.0 MB/s
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "50%",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 后台下载中 2 个任务 · 总进度 50% (4.0 MB/s)\n当前：多任务一 (50%)",
    );

    // Fail both tasks -> badge "!", color "#ef4444", failed title
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_ERROR",
      taskId: m1,
      error: "network error 1",
    });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "50%",
    );

    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_ERROR",
      taskId: m2,
      error: "network error 2",
    });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "!",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "color").at(-1)?.color,
      "#ef4444",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 有后台任务失败（点击打开侧边栏查看或重试）",
    );

    // CLEAR_FINISHED_TASKS resets BOTH badge "" and title DEFAULT_ACTION_TITLE
    await env.chrome.runtime.sendMessage({ type: "CLEAR_FINISHED_TASKS" });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      backgroundMod.DEFAULT_ACTION_TITLE,
    );
  } finally {
    bg.dispose();
  }
});

test("MV3 Weibo relay regression: validateMediaEnvelope & background PARSE_URL/RESOLVE_LAZY_ITEM succeed when location.origin is chrome-extension://", async () => {
  const prevLocationDesc = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    value: { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    configurable: true,
    writable: true,
  });

  const weiboRelayEnvelope = {
    schema_version: "1.0",
    code: "OK",
    data: {
      platform: "weibo",
      content_id: "1034:5339966948180025",
      title: "微博中转测试视频",
      source_url:
        "https://weibo.com/tv/show/1034:5339966948180025?from=old_pc_videoshow",
      generated_at: "2026-11-21T15:00:00Z",
      cover: {
        url: "https://wx4.sinaimg.cn/orj480/test-cover.jpg",
        access: "direct",
      },
      author: {
        name: "测试博主",
        avatar: {
          url: "https://tvax2.sinaimg.cn/crop.0.0.100.100/test-avatar.jpg",
          access: "direct",
        },
      },
      items: [
        {
          id: "video-1",
          type: "video",
          state: "ready",
          cover: {
            url: "/api/media/weibo?ticket=cover-relay-test",
            access: "relay",
          },
          default: {
            variant_id: "mp4_1080p",
            url: "/api/media/weibo?ticket=test",
            access: "relay",
          },
          variants: [
            {
              id: "mp4_1080p",
              label: "1080P",
              delivery: {
                kind: "file",
                sources: [
                  {
                    url: "/api/media/weibo?ticket=test",
                    access: "relay",
                    size_bytes: 1234567,
                  },
                ],
              },
              metadata: {
                width: 1920,
                height: 1080,
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
              },
            },
          ],
        },
      ],
      attachments: [
        {
          id: "att-1",
          kind: "audio",
          label: "伴音",
          resource: {
            id: "att-res-1",
            role: "audio",
            delivery: {
              kind: "file",
              sources: [
                {
                  url: "/api/media/weibo?ticket=audio-test",
                  access: "relay",
                },
              ],
            },
          },
        },
      ],
    },
  };

  let bg = null;
  try {
    // 1. Without apiOrigin context, chrome-extension:// location.origin must still fail closed
    assert.throws(
      () => mediaContractMod.validateMediaEnvelope(weiboRelayEnvelope),
      /API origin 无效/,
    );

    // 2. With explicit apiOrigin context, validateMediaEnvelope succeeds across variants, default, cover & attachments
    const validated = mediaContractMod.validateMediaEnvelope(
      weiboRelayEnvelope,
      { apiOrigin: "https://snap.dokitool.com" },
    );
    assert.equal(validated.platform, "weibo");
    assert.equal(
      validated.items[0].default?.url,
      "/api/media/weibo?ticket=test",
    );

    // 3. Full background controller PARSE_URL & RESOLVE_ITEM with chrome-extension:// location.origin
    const env = createMockMv3Environment();
    const fetchCalls = [];
    const mockFetch = async (url) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify(weiboRelayEnvelope), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const extStorage = storage.createExtensionStorage();
    bg = backgroundMod.createBackgroundController({
      chrome: env.chrome,
      storage: extStorage,
      fetchImpl: mockFetch,
    });
    await bg.init();

    const parseResp = await env.chrome.runtime.sendMessage({
      type: "PARSE_URL",
      url: "https://weibo.com/tv/show/1034:5339966948180025?from=old_pc_videoshow",
    });
    assert.equal(
      parseResp.ok,
      true,
      `PARSE_URL failed: ${parseResp.error || ""}`,
    );
    assert.equal(parseResp.data.media.platform, "weibo");
    assert.equal(
      parseResp.data.media.items[0].default?.url,
      "/api/media/weibo?ticket=test",
    );

    const resolveResp = await env.chrome.runtime.sendMessage({
      type: "RESOLVE_LAZY_ITEM",
      resolveUrl:
        "/api/resolve?platform=weibo&url=https%3A%2F%2Fweibo.com%2Ftv%2Fshow%2F1034%3A5339966948180025&item=video-1",
    });
    assert.equal(
      resolveResp.ok,
      true,
      `RESOLVE_LAZY_ITEM failed: ${resolveResp.error || ""}`,
    );
    assert.equal(resolveResp.data.media.platform, "weibo");
    assert.equal(fetchCalls.length, 2);
  } finally {
    bg?.dispose();
    if (prevLocationDesc) {
      Object.defineProperty(globalThis, "location", prevLocationDesc);
    } else {
      delete globalThis.location;
    }
  }
});

test("background badge & tooltip: late cancelled callback does not wipe terminal failed '!' or completed '✓' indicators", async () => {
  const env = createMockMv3Environment({ autoCompleteDownloads: false });
  env.chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "OFFSCREEN_START_TASK") {
      sendResponse({ ok: true, data: { accepted: true } });
      return true;
    }
    if (msg?.type === "OFFSCREEN_CANCEL_TASK") {
      sendResponse({ ok: true, data: { cancelled: true } });
      return true;
    }
    if (msg?.type === "RELEASE_BLOB") {
      sendResponse({ ok: true, data: { released: true } });
      return true;
    }
    return false;
  });
  const extStorage = storage.createExtensionStorage();
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    badgeSuccessDurationMs: 60,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });

  const lastBadgeText = () =>
    [...env.badgeHistory].reverse().find((e) => e.kind === "text")?.text;
  const lastBadgeTitle = () =>
    [...env.badgeHistory].reverse().find((e) => e.kind === "title")?.title;

  try {
    await bg.init();

    // Case 1: Task 2 cancelled while Task 1 fails -> delayed OFFSCREEN_TASK_ERROR(cancelled) must NOT wipe "!"
    const enq1 = await env.chrome.runtime.sendMessage({
      type: "ENQUEUE_DOWNLOADS",
      items: [
        {
          title: "视频 A",
          platform: "douyin",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://v26-cold.douyinvod.com/a.mp4"],
            filename: "a.mp4",
            mimeType: "video/mp4",
          },
        },
        {
          title: "视频 B",
          platform: "douyin",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://v26-cold.douyinvod.com/b.mp4"],
            filename: "b.mp4",
            mimeType: "video/mp4",
          },
        },
      ],
    });
    assert.equal(enq1.ok, true);
    const [taskA, taskB] = enq1.data.taskIds;

    // Cancel Task B first
    const cancelRes = await env.chrome.runtime.sendMessage({
      type: "CANCEL_TASK",
      taskId: taskB,
    });
    assert.equal(cancelRes.ok, true);

    // Task A fails -> badge="!" and failed tooltip
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_ERROR",
      taskId: taskA,
      error: "CDN 403",
    });
    assert.equal(lastBadgeText(), "!");
    assert.match(lastBadgeTitle() || "", /失败/);

    // Delayed Offscreen cancelled error for Task B arrives -> must NOT wipe "!" or title!
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_ERROR",
      taskId: taskB,
      error: "已取消",
      cancelled: true,
    });
    assert.equal(lastBadgeText(), "!");
    assert.match(lastBadgeTitle() || "", /失败/);

    // Explicit clear MUST still reset badge & title cleanly
    await env.chrome.runtime.sendMessage({ type: "CLEAR_FINISHED_TASKS" });
    assert.equal(lastBadgeText(), "");
    assert.equal(lastBadgeTitle(), backgroundMod.DEFAULT_ACTION_TITLE);

    // Case 2: Task C completes ("✓") while cancelled Task D sends late OFFSCREEN_TASK_ERROR(cancelled)
    const enq2 = await env.chrome.runtime.sendMessage({
      type: "ENQUEUE_DOWNLOADS",
      items: [
        {
          title: "视频 C",
          platform: "x",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://video.twimg.com/c.mp4"],
            filename: "c.mp4",
            mimeType: "video/mp4",
          },
        },
        {
          title: "视频 D",
          platform: "x",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://video.twimg.com/d.mp4"],
            filename: "d.mp4",
            mimeType: "video/mp4",
          },
        },
      ],
    });
    const [taskC, taskD] = enq2.data.taskIds;
    await env.chrome.runtime.sendMessage({ type: "CANCEL_TASK", taskId: taskD });

    const handoff = await env.chrome.runtime.sendMessage({
      type: "HANDOFF_BLOB_DOWNLOAD",
      taskId: taskC,
      blobUrl: "blob:chrome-extension://ext/c",
      filename: "c.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1024,
    });
    assert.equal(handoff.ok, true);
    env.emitDownloadChanged({
      id: handoff.data.chromeDownloadId,
      state: { current: "complete" },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(lastBadgeText(), "✓");
    assert.match(lastBadgeTitle() || "", /已完成/);

    // Delayed cancel callback for Task D must preserve "✓" and its auto-clear timer
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_ERROR",
      taskId: taskD,
      error: "已取消",
      cancelled: true,
    });
    assert.equal(lastBadgeText(), "✓");
    assert.match(lastBadgeTitle() || "", /已完成/);

    // Wait for scheduled auto-clear timer to reset cleanly to idle
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(lastBadgeText(), "");
    assert.equal(lastBadgeTitle(), backgroundMod.DEFAULT_ACTION_TITLE);
  } finally {
    bg.dispose();
  }
});

// ============================================================================
// Generic Lossless DASH Mux Engine (Bilibili 1080p AVC/HEVC/AV1 + AAC + M4A)
// ============================================================================

async function createSyntheticDashTrackBuffers(codec = "avc") {
  let videoCfg;
  if (codec === "avc") {
    const avcC = new Uint8Array([
      1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x09, 0x67, 0x42, 0xc0, 0x1e, 0xd9,
      0x03, 0xc8, 0x40, 0x00, 0x01, 0x00, 0x04, 0x68, 0xcb, 0x83, 0xcb,
    ]);
    videoCfg = {
      codec: "avc1.42c01e",
      codedWidth: 1920,
      codedHeight: 1080,
      description: avcC,
    };
  } else if (codec === "hevc") {
    const hvcC = new Uint8Array(23);
    hvcC[0] = 1;
    hvcC[1] = 1;
    hvcC[12] = 93;
    hvcC[21] = 0xff;
    videoCfg = {
      codec: "hvc1.1.6.L93.B0",
      codedWidth: 1920,
      codedHeight: 1080,
      description: hvcC,
    };
  } else {
    videoCfg = {
      codec: "av01.0.08M.08",
      codedWidth: 1920,
      codedHeight: 1080,
      description: new Uint8Array([0x81, 0x08, 0x0c, 0x00]),
    };
  }

  const videoTarget = new mediabunny.BufferTarget();
  const videoOut = new mediabunny.Output({
    format: new mediabunny.Mp4OutputFormat({ fastStart: "fragmented" }),
    target: videoTarget,
  });
  const videoSrc = new mediabunny.EncodedVideoPacketSource(codec);
  videoOut.addVideoTrack(videoSrc);
  await videoOut.start();
  for (let i = 0; i < 6; i++) {
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
      i === 0 ? { decoderConfig: videoCfg } : undefined,
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
  for (let i = 0; i < 6; i++) {
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

function buildSampleBilibiliDashMedia({ multiP = false } = {}) {
  const makeDashVariant = ({
    id,
    label,
    width,
    height,
    fps,
    videoCodec,
    videoBitrate,
    audioBitrate = 200_000,
    videoUrls,
    audioUrls,
  }) => ({
    id,
    label,
    metadata: {
      width,
      height,
      fps,
      video_codec: videoCodec,
      video_bitrate_bps: videoBitrate,
      audio_codec: "mp4a.40.2",
      audio_bitrate_bps: audioBitrate,
      has_audio: true,
      container: "mp4",
      extension: "mp4",
      mime_type: "video/mp4",
      evidence: "upstream",
    },
    delivery: {
      kind: "mux",
      output: { container: "mp4", extension: "mp4", mime_type: "video/mp4" },
      resources: [
        {
          id: "video",
          role: "video",
          metadata: {
            width,
            height,
            fps,
            video_codec: videoCodec,
            video_bitrate_bps: videoBitrate,
            evidence: "upstream",
          },
          delivery: {
            kind: "file",
            sources: videoUrls.map((url, idx) => ({
              id: `v-${idx + 1}`,
              url,
            })),
          },
        },
        {
          id: "audio",
          role: "audio",
          metadata: {
            has_audio: true,
            audio_codec: "mp4a.40.2",
            audio_bitrate_bps: audioBitrate,
            container: "m4a",
            extension: "m4a",
            mime_type: "audio/mp4",
            evidence: "upstream",
          },
          delivery: {
            kind: "file",
            sources: audioUrls.map((url, idx) => ({
              id: `a-${idx + 1}`,
              url,
            })),
          },
        },
      ],
    },
  });

  const makeItem = (index, titleSuffix) => ({
    id: `p${index}`,
    index,
    type: "video",
    title: titleSuffix,
    duration_ms: 120_000,
    source_url: `https://www.bilibili.com/video/BV1GJ411x7h7?p=${index}`,
    variants: [
      // Deliberately put AV1 and HEVC BEFORE H.264 to verify codec ranking (H.264 > HEVC > AV1)!
      makeDashVariant({
        id: "dash-80-av1",
        label: "1080p",
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: "av01.0.08M.08",
        videoBitrate: 1_800_000,
        videoUrls: [
          `https://upos-sz-mirrorcos.bilivideo.com/p${index}-1080-av1.m4s`,
        ],
        audioUrls: [
          `https://upos-sz-mirrorcos.bilivideo.com/p${index}-30280.m4s`,
        ],
      }),
      makeDashVariant({
        id: "dash-80-hevc",
        label: "1080p",
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: "hev1.1.6.L120.90",
        videoBitrate: 2_200_000,
        videoUrls: [
          `https://upos-sz-mirrorcos.bilivideo.com/p${index}-1080-hevc.m4s`,
        ],
        audioUrls: [
          `https://upos-sz-mirrorcos.bilivideo.com/p${index}-30280.m4s`,
        ],
      }),
      makeDashVariant({
        id: "dash-80-avc",
        label: "1080p",
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: "avc1.640032",
        videoBitrate: 2_600_000,
        videoUrls: [
          `https://upos-sz-mirrorcos.bilivideo.com/p${index}-1080-avc-1.m4s`,
          `https://upos-sz-mirrorali.bilivideo.com/p${index}-1080-avc-2.m4s`,
        ],
        audioUrls: [
          `https://upos-sz-mirrorcos.bilivideo.com/p${index}-30280-1.m4s`,
          `https://upos-sz-mirrorali.bilivideo.com/p${index}-30280-2.m4s`,
        ],
      }),
      {
        id: "durl-64",
        label: "720p",
        metadata: {
          width: 1280,
          height: 720,
          has_audio: true,
          container: "mp4",
          extension: "mp4",
          mime_type: "video/mp4",
        },
        delivery: {
          kind: "file",
          sources: [
            {
              id: "durl-1",
              url: `https://upos-sz-mirrorcos.bilivideo.com/p${index}-durl-720p.mp4`,
              size_bytes: 51_900_000,
            },
          ],
        },
      },
    ],
    default: {
      variant_id: "durl-64",
      source_id: "durl-1",
      url: `https://upos-sz-mirrorcos.bilivideo.com/p${index}-durl-720p.mp4`,
    },
    higher_quality_variants: [
      { variant_id: "dash-80-av1", requires: ["mux"] },
      { variant_id: "dash-80-hevc", requires: ["mux"] },
      { variant_id: "dash-80-avc", requires: ["mux"] },
    ],
  });

  const items = multiP
    ? [makeItem(1, "第一集 序幕"), makeItem(2, "第二集 正片")]
    : [makeItem(1, "B站1080P DASH无损合流测试")];

  return {
    platform: "bilibili",
    content_id: "BV1GJ411x7h7",
    title: "B站1080P DASH无损合流测试",
    source_url: "https://www.bilibili.com/video/BV1GJ411x7h7",
    default_item_id: "p1",
    items,
    attachments: [
      {
        id: "bilibili-audio-BV1GJ411x7h7-p1",
        role: "background_audio",
        title: "原声音频 (M4A)",
        resource: {
          id: "audio",
          role: "audio",
          metadata: {
            has_audio: true,
            audio_codec: "mp4a.40.2",
            audio_bitrate_bps: 200_000,
            container: "m4a",
            extension: "m4a",
            mime_type: "audio/mp4",
            evidence: "upstream",
          },
          delivery: {
            kind: "file",
            sources: [
              {
                id: "aud-1",
                url: "https://upos-sz-mirrorcos.bilivideo.com/p1-30280-1.m4s",
              },
              {
                id: "aud-2",
                url: "https://upos-sz-mirrorali.bilivideo.com/p1-30280-2.m4s",
              },
            ],
          },
        },
      },
    ],
  };
}

test("Bilibili DASH ranking & enqueue builders: best/1080p prefer H.264 > HEVC > AV1 DASH mux, audio picks M4A, multi-P subfolder & ZIP fallback", () => {
  const media = buildSampleBilibiliDashMedia();
  const item = media.items[0];
  const apiOrigin = "https://snap.dokitool.com";

  // 1) "best" picks 1080p H.264 DASH mux over HEVC/AV1 and over 720p durl
  const bestPlan = extensionDownloadMod.selectVariantByPreference(
    item,
    media.attachments,
    "best",
    apiOrigin,
  );
  assert.ok(bestPlan);
  assert.equal(bestPlan.variant.id, "dash-80-avc");
  assert.ok(bestPlan.dashMux);
  assert.equal(bestPlan.dashMux.outputContainer, "mp4");
  assert.deepEqual(bestPlan.dashMux.videoRoutes, [
    "https://upos-sz-mirrorcos.bilivideo.com/p1-1080-avc-1.m4s",
    "https://upos-sz-mirrorali.bilivideo.com/p1-1080-avc-2.m4s",
  ]);
  assert.deepEqual(bestPlan.dashMux.audioRoutes, [
    "https://upos-sz-mirrorcos.bilivideo.com/p1-30280-1.m4s",
    "https://upos-sz-mirrorali.bilivideo.com/p1-30280-2.m4s",
  ]);

  // 2) "1080p" also picks 1080p H.264 DASH mux (even if a 4K DASH variant exists)
  const itemWith4k = {
    ...item,
    variants: [
      {
        ...item.variants[2],
        id: "dash-120-avc",
        label: "4K",
        metadata: {
          ...item.variants[2].metadata,
          width: 3840,
          height: 2160,
          video_bitrate_bps: 8_000_000,
        },
      },
      ...item.variants,
    ],
  };
  assert.equal(
    extensionDownloadMod.selectVariantByPreference(
      itemWith4k,
      media.attachments,
      "best",
      apiOrigin,
    )?.variant.id,
    "dash-120-avc",
  );
  assert.equal(
    extensionDownloadMod.selectVariantByPreference(
      itemWith4k,
      media.attachments,
      "1080p",
      apiOrigin,
    )?.variant.id,
    "dash-80-avc",
  );

  // 3) Codec tiebreaker when H.264 absent: HEVC beats AV1 even when AV1 appears first
  const noH264Item = {
    ...item,
    variants: item.variants.filter((v) => v.id !== "dash-80-avc"),
  };
  assert.equal(
    extensionDownloadMod.selectVariantByPreference(
      noH264Item,
      media.attachments,
      "best",
      apiOrigin,
    )?.variant.id,
    "dash-80-hevc",
  );

  // 4) Equal resolution & fps: 1080p DASH H.264 beats 1080p durl (isDirectFile must not block 1080p no-login DASH)
  const equalResItem = {
    ...item,
    variants: [
      {
        id: "durl-80",
        label: "1080p",
        metadata: {
          width: 1920,
          height: 1080,
          fps: 30,
          has_audio: true,
          container: "mp4",
          extension: "mp4",
          mime_type: "video/mp4",
        },
        delivery: {
          kind: "file",
          sources: [
            {
              id: "d80",
              url: "https://upos-sz-mirrorcos.bilivideo.com/p1-durl-1080p.mp4",
            },
          ],
        },
      },
      item.variants[2], // dash-80-avc (2.6 Mbps)
    ],
    default: {
      variant_id: "durl-80",
      source_id: "d80",
      url: "https://upos-sz-mirrorcos.bilivideo.com/p1-durl-1080p.mp4",
    },
  };
  assert.equal(
    extensionDownloadMod.selectVariantByPreference(
      equalResItem,
      media.attachments,
      "best",
      apiOrigin,
    )?.variant.id,
    "dash-80-avc",
  );

  // 5) "audio" preference picks background_audio M4A attachment -> direct_file .m4a
  const audioPlan = extensionDownloadMod.selectVariantByPreference(
    item,
    media.attachments,
    "audio",
    apiOrigin,
  );
  assert.ok(audioPlan);
  assert.equal(audioPlan.isAudioOnly, true);
  assert.equal(audioPlan.target.kind, "file");
  const audioEnqueue = extensionDownloadMod.buildEnqueueItemsForMedia(media, {
    apiOrigin,
    qualityPreference: "audio",
  });
  assert.equal(audioEnqueue.length, 1);
  assert.equal(audioEnqueue[0].spec.kind, "direct_file");
  assert.ok(audioEnqueue[0].spec.filename.endsWith(".m4a"));

  // 6) Explicit variantSelection can target dash-80-av1 directly
  const explicitEnqueue = extensionDownloadMod.buildEnqueueItemsForMedia(media, {
    apiOrigin,
    variantSelections: { p1: { variant_id: "dash-80-av1" } },
  });
  assert.equal(explicitEnqueue.length, 1);
  assert.equal(explicitEnqueue[0].spec.kind, "dash_mux");
  assert.match(explicitEnqueue[0].spec.dashMux.videoRoutes[0], /1080-av1\.m4s/);

  // 7) Multi-P Bilibili with batchSaveMode="zip" falls back safely to subfolder dash_mux items (never crashes!)
  const multiPMedia = buildSampleBilibiliDashMedia({ multiP: true });
  const multiEnqueue = extensionDownloadMod.buildEnqueueItemsForMedia(
    multiPMedia,
    {
      apiOrigin,
      qualityPreference: "best",
      batchSaveMode: "zip",
      subfolderPrefix: "DokiTool",
    },
  );
  assert.equal(multiEnqueue.length, 2);
  assert.equal(multiEnqueue[0].spec.kind, "dash_mux");
  assert.equal(multiEnqueue[1].spec.kind, "dash_mux");
  assert.match(multiEnqueue[0].spec.filename, /^DokiTool\/.*\/001_.*\.mp4$/);
  assert.match(multiEnqueue[1].spec.filename, /^DokiTool\/.*\/002_.*\.mp4$/);

  // 8) Checklist subfolder builder produces dash_mux items & checklist ZIP builder declines gracefully
  const settings = {
    ...storage.DEFAULT_EXTENSION_SETTINGS,
    apiBaseUrl: apiOrigin,
    qualityPreference: "best",
  };
  const checklistEntries = multiPMedia.items.map((it, idx) => ({
    item: it,
    ordinalIndex: idx + 1,
  }));
  const subItems = uiTargetHelpersMod.buildChecklistSubfolderEnqueueItems({
    media: multiPMedia,
    entries: checklistEntries,
    totalCount: 2,
    settings,
    livePhotoFilter: "both",
  });
  assert.equal(subItems.length, 2);
  assert.equal(subItems[0].spec.kind, "dash_mux");
  assert.equal(subItems[1].spec.kind, "dash_mux");

  const zipDecision = uiTargetHelpersMod.buildChecklistZipEnqueueItem({
    media: multiPMedia,
    entries: checklistEntries,
    totalCount: 2,
    settings,
    livePhotoFilter: "both",
  });
  assert.equal(zipDecision.ok, false);
  assert.match(zipDecision.reason, /DASH/);
});

test("Bilibili DASH SidePanel UI: buildSidePanelQualityOptions & SidePanelResult.vue render DASH 合流 badge, H.264/HEVC/AV1, 约 XX MB, keep durl <video> preview, disable 复制直链, and enqueue dash_mux", async () => {
  const SidePanelResult = await loadSidePanelSfc(
    "../src/extension/components/SidePanelResult.vue",
  );
  const media = buildSampleBilibiliDashMedia();
  const apiOrigin = "https://snap.dokitool.com";
  const settings = {
    ...storage.DEFAULT_EXTENSION_SETTINGS,
    apiBaseUrl: apiOrigin,
    qualityPreference: "best",
  };

  // Verify buildSidePanelQualityOptions details first
  const options = uiTargetHelpersMod.buildSidePanelQualityOptions(
    media,
    media.items[0],
    apiOrigin,
  );
  const avcOpt = options.find((o) => o.variant.id === "dash-80-avc");
  const hevcOpt = options.find((o) => o.variant.id === "dash-80-hevc");
  const av1Opt = options.find((o) => o.variant.id === "dash-80-av1");
  const durlOpt = options.find((o) => o.variant.id === "durl-64");
  const audioOpt = options.find((o) => o.kind === "attachment");

  assert.ok(avcOpt && avcOpt.downloadable && avcOpt.isDashMux);
  assert.ok(hevcOpt && hevcOpt.downloadable && hevcOpt.isDashMux);
  assert.ok(av1Opt && av1Opt.downloadable && av1Opt.isDashMux);
  assert.ok(durlOpt && durlOpt.downloadable && !durlOpt.isDashMux);
  assert.ok(audioOpt && audioOpt.downloadable && audioOpt.isAudioOnly);

  // Estimated size = Math.round(((2_600_000 + 200_000) * 120_000) / 8000) = 42_000_000 -> "约 42.0 MB"
  assert.equal(avcOpt.sizeBytes, 42_000_000);
  assert.equal(avcOpt.sizeLabel, "约 42.0 MB");
  assert.equal(avcOpt.audioBadge?.text, "DASH 合流");
  assert.equal(avcOpt.directUrl, "");
  assert.equal(audioOpt.sizeLabel, "约 3.0 MB");

  // Preferred option under "best" & "1080p" is H.264 DASH; under "audio" is M4A attachment
  assert.equal(
    uiTargetHelpersMod.selectPreferredQualityOption(
      options,
      media.items[0],
      "best",
      media,
      apiOrigin,
    )?.variant.id,
    "dash-80-avc",
  );
  assert.equal(
    uiTargetHelpersMod.selectPreferredQualityOption(
      options,
      media.items[0],
      "audio",
      media,
      apiOrigin,
    )?.kind,
    "attachment",
  );

  // Mount real SidePanelResult.vue SFC
  const emittedEnqueues = [];
  const view = mountSfcTree(
    SidePanelResult,
    {
      media,
      workFingerprint: "bilibili:BV1GJ411x7h7",
      isSaved: false,
      settings,
      resolvingItemIds: new Set(),
    },
    {
      onEnqueueDownloads: (payload) => emittedEnqueues.push(payload),
    },
  );

  try {
    await view.flush();
    const text = view.textOf();

    // Renders DASH 合流 badge, H.264 / HEVC / AV1, 30 fps, 约 42.0 MB estimated size, and audio attachment
    assert.ok(text.includes("DASH 合流"), "renders DASH 合流 badge");
    assert.ok(text.includes("H.264"), "renders H.264 codec chip");
    assert.ok(text.includes("HEVC"), "renders HEVC codec chip");
    assert.ok(text.includes("AV1"), "renders AV1 codec chip");
    assert.ok(text.includes("30 fps"), "renders fps chip");
    assert.ok(text.includes("约 42.0 MB"), "renders estimated DASH size");
    assert.ok(text.includes("原声音频 (M4A)"), "renders standalone M4A audio option");

    // Top <video> stage stays bound to playable durl MP4 URL while 1080p DASH is selected!
    const stageVideos = view.findAll((n) => n.type === "video");
    assert.equal(stageVideos.length, 1);
    assert.equal(
      stageVideos[0].props.src,
      "https://upos-sz-mirrorcos.bilivideo.com/p1-durl-720p.mp4",
    );

    // Primary CTA clearly says "下载 1080p 无损合流 (MP4)"
    const mainBtn = view.findAll(
      (n) =>
        n.type === "button" &&
        typeof n.props.class === "string" &&
        n.props.class.includes("sp-cta-row__main"),
    )[0];
    assert.ok(mainBtn);
    assert.ok(
      view.textOf(mainBtn).includes("下载 1080p 无损合流 (MP4)"),
      `expected primary CTA label, got: ${view.textOf(mainBtn)}`,
    );

    // 复制直链 button is disabled with explanatory tooltip for dash_mux
    const copyBtn = view.findAll(
      (n) =>
        n.type === "button" &&
        typeof n.props.class === "string" &&
        n.props.class.includes("sp-cta-row__copy"),
    )[0];
    assert.ok(copyBtn);
    assert.equal(copyBtn.props.disabled, true);
    assert.equal(copyBtn.props.title, "音视频分离流需经扩展无损合流");

    // Clicking primary CTA enqueues kind: "dash_mux" with H.264 video + 30280 audio routes
    await view.fire(mainBtn, "onClick");
    assert.equal(emittedEnqueues.length, 1);
    assert.equal(emittedEnqueues[0].items.length, 1);
    assert.equal(emittedEnqueues[0].items[0].spec.kind, "dash_mux");
    assert.deepEqual(emittedEnqueues[0].items[0].spec.dashMux.videoRoutes, [
      "https://upos-sz-mirrorcos.bilivideo.com/p1-1080-avc-1.m4s",
      "https://upos-sz-mirrorali.bilivideo.com/p1-1080-avc-2.m4s",
    ]);

    // Switching to 720p durl re-enables 复制直链
    const durlBtn = view.findAll(
      (n) =>
        n.type === "button" &&
        typeof n.props.class === "string" &&
        n.props.class.includes("sp-variant-card") &&
        view.textOf(n).includes("720p"),
    )[0];
    await view.fire(durlBtn, "onClick");
    const copyBtnAfterDurl = view.findAll(
      (n) =>
        n.type === "button" &&
        typeof n.props.class === "string" &&
        n.props.class.includes("sp-cta-row__copy"),
    )[0];
    assert.equal(copyBtnAfterDurl.props.disabled, false);

    // Switching to standalone M4A audio attachment updates CTA and enqueues direct_file .m4a
    const audioBtn = view.findAll(
      (n) =>
        n.type === "button" &&
        typeof n.props.class === "string" &&
        n.props.class.includes("sp-variant-card") &&
        view.textOf(n).includes("原声音频 (M4A)"),
    )[0];
    await view.fire(audioBtn, "onClick");
    const mainBtnAfterAudio = view.findAll(
      (n) =>
        n.type === "button" &&
        typeof n.props.class === "string" &&
        n.props.class.includes("sp-cta-row__main"),
    )[0];
    assert.ok(
      view.textOf(mainBtnAfterAudio).includes("下载音频 (M4A)"),
      `expected audio CTA label, got: ${view.textOf(mainBtnAfterAudio)}`,
    );
    await view.fire(mainBtnAfterAudio, "onClick");
    assert.equal(emittedEnqueues.length, 2);
    assert.equal(emittedEnqueues[1].items[0].spec.kind, "direct_file");
    assert.ok(emittedEnqueues[1].items[0].spec.filename.endsWith(".m4a"));
  } finally {
    view.unmount();
  }
});

test("executeDashMux & runDashMuxToOpfs: real mediabunny lossless MP4 mux (H.264/HEVC/AV1 + AAC), multi-route fallback, UNWHITELISTED_CDN PCDN rejection, abort cleanup, and 0 OPFS residue", async () => {
  // 1) Test H.264 (with multi-route fallback + truncation recovery), HEVC, and AV1 real lossless muxing
  for (const codec of ["avc", "hevc", "av1"]) {
    const { videoBytes, audioBytes } =
      await createSyntheticDashTrackBuffers(codec);
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const progressEvents = [];
    const errors = [];
    const handoffs = [];
    const observedFetches = [];
    const opfsSnapshotAtHandoff = [];

    const mockFetch = async (url, init) => {
      observedFetches.push({
        url: String(url),
        credentials: init?.credentials,
        referrerPolicy: init?.referrerPolicy,
      });
      if (String(url).includes("video-bad-403.m4s")) {
        return new Response("Forbidden", { status: 403 });
      }
      if (String(url).includes("audio-truncated.m4s")) {
        // Declares Content-Length larger than actual body -> triggers truncation guard & fallback!
        const partial = audioBytes.slice(0, Math.floor(audioBytes.length / 2));
        return new Response(partial, {
          status: 200,
          headers: {
            "Content-Type": "audio/mp4",
            "Content-Length": String(audioBytes.length + 500),
          },
        });
      }
      if (String(url).includes(`video-${codec}.m4s`)) {
        return new Response(videoBytes, {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(videoBytes.length),
          },
        });
      }
      if (String(url).includes("audio-ok.m4s")) {
        return new Response(audioBytes, {
          status: 200,
          headers: {
            "Content-Type": "audio/mp4",
            "Content-Length": String(audioBytes.length),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: mockFetch,
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      progressThrottleMs: 0,
      mediabunnyImpl: mediabunny,
      onProgress(msg) {
        progressEvents.push(msg);
      },
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload(msg) {
        handoffs.push(msg);
        opfsSnapshotAtHandoff.push(...opfs.files.keys());
        // Read muxed MP4 right before releasing
        const blob = urlApi.activeBlobs.get(msg.blobUrl);
        assert.ok(blob, `${codec}: blob present during handoff`);
        assert.equal(blob.type, "video/mp4");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        // Release authoritatively
        setTimeout(() => {
          executor.releaseBlob({
            taskId: msg.taskId,
            blobUrl: msg.blobUrl,
            opfsTempName: msg.opfsTempName,
          });
        }, 0);
        // Attach bytes for outer assertion
        msg._verifiedBytes = bytes;
        return { chromeDownloadId: 101 };
      },
    });

    try {
      executor.startTask(`dash-${codec}`, {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        routes: [
          `https://upos-sz-mirrorcos.bilivideo.com/video-${codec}.m4s`,
        ],
        filename: `DokiTool/bili-${codec}.mp4`,
        mimeType: "video/mp4",
        dashMux: {
          videoRoutes:
            codec === "avc"
              ? [
                  "https://upos-sz-mirrorcos.bilivideo.com/video-bad-403.m4s",
                  `https://upos-sz-mirrorali.bilivideo.com/video-${codec}.m4s`,
                ]
              : [`https://upos-sz-mirrorcos.bilivideo.com/video-${codec}.m4s`],
          audioRoutes:
            codec === "avc"
              ? [
                  "https://upos-sz-mirrorcos.bilivideo.com/audio-truncated.m4s",
                  "https://upos-sz-mirrorali.bilivideo.com/audio-ok.m4s",
                ]
              : ["https://upos-sz-mirrorcos.bilivideo.com/audio-ok.m4s"],
          outputContainer: "mp4",
        },
      });

      await executor.waitForIdle();

      assert.equal(errors.length, 0, `${codec}: zero errors`);
      assert.equal(handoffs.length, 1, `${codec}: single handoff`);

      // All fetches strictly omit credentials & referrer
      for (const req of observedFetches) {
        assert.equal(req.credentials, "omit");
        assert.equal(req.referrerPolicy, "no-referrer");
      }

      // Intermediate dokitool-ext-dash-v-* and dokitool-ext-dash-a-* MUST ALREADY be deleted before handoff!
      assert.equal(
        opfsSnapshotAtHandoff.length,
        1,
        `${codec}: only 1 output OPFS temp file exists during handoff (both intermediate track files cleaned)`,
      );
      assert.equal(
        opfsSnapshotAtHandoff.some((n) => n.includes("-dash-v-") || n.includes("-dash-a-")),
        false,
        `${codec}: no intermediate dash-v/dash-a temp files remain at handoff`,
      );

      // After RELEASE_BLOB, ZERO OPFS files and ZERO Blob URLs remain!
      assert.equal(opfs.files.size, 0, `${codec}: 0 OPFS residue after release`);
      assert.equal(executor.getActiveOpfsTempNames().size, 0);
      assert.equal(urlApi.activeBlobs.size, 0);

      // Verify progress lifecycle: downloading (0-82%) -> muxing (82-98%, speed=0) -> saving (99%)
      const statuses = progressEvents.map((e) => e.status);
      const firstDl = statuses.indexOf("downloading");
      const firstMux = statuses.indexOf("muxing");
      const firstSave = statuses.indexOf("saving");
      assert.ok(firstDl >= 0 && firstMux > firstDl && firstSave > firstMux);
      const muxEvents = progressEvents.filter((e) => e.status === "muxing");
      assert.ok(muxEvents.every((e) => e.percent >= 82 && e.percent <= 98));
      assert.ok(muxEvents.every((e) => e.speed === 0));
      assert.equal(muxEvents[0].statusText, "无损合流中...");

      // Verify real MP4 container boxes (`ftyp` + `moov`) AND readable tracks via mediabunny!
      const mergedBytes = handoffs[0]._verifiedBytes;
      const latin1 = new TextDecoder("latin1").decode(mergedBytes);
      assert.ok(latin1.includes("ftyp"), `${codec}: output MP4 contains ftyp box`);
      assert.ok(latin1.includes("moov"), `${codec}: output MP4 contains moov box`);

      const verifyIn = new mediabunny.Input({
        source: new mediabunny.BufferSource(mergedBytes),
        formats: mediabunny.ALL_FORMATS,
      });
      const [vTrack, aTrack] = await Promise.all([
        verifyIn.getPrimaryVideoTrack(),
        verifyIn.getPrimaryAudioTrack(),
      ]);
      assert.ok(vTrack, `${codec}: output MP4 has video track`);
      assert.ok(aTrack, `${codec}: output MP4 has audio track`);
      assert.equal(await vTrack.getCodec(), codec);
      assert.equal(await aTrack.getCodec(), "aac");
      verifyIn.dispose();
    } finally {
      executor.dispose();
    }
  }

  // 2) BufferTarget fallback when OPFS is absent (opfsStorage: null)
  {
    const { videoBytes, audioBytes } =
      await createSyntheticDashTrackBuffers("avc");
    const urlApi = createTrackedUrlApi();
    const errors = [];
    let handoffBytes = null;
    let execNoOpfs;
    execNoOpfs = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (url) =>
        new Response(String(url).includes("v.m4s") ? videoBytes : audioBytes, {
          status: 200,
          headers: { "Content-Type": "video/mp4" },
        }),
      opfsStorage: null,
      webLocks: null,
      urlApi,
      mediabunnyImpl: mediabunny,
      onError(e) {
        errors.push(e);
      },
      async handoffBlobDownload(msg) {
        const blob = urlApi.activeBlobs.get(msg.blobUrl);
        handoffBytes = new Uint8Array(await blob.arrayBuffer());
        setTimeout(() => {
          execNoOpfs.releaseBlob({ taskId: msg.taskId, blobUrl: msg.blobUrl });
        }, 0);
      },
    });
    try {
      execNoOpfs.startTask("dash-no-opfs", {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/v.m4s"],
        filename: "no-opfs.mp4",
        mimeType: "video/mp4",
        dashMux: {
          videoRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/v.m4s"],
          audioRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/a.m4s"],
          outputContainer: "mp4",
        },
      });
      await execNoOpfs.waitForIdle();
      assert.equal(errors.length, 0);
      assert.ok(handoffBytes && handoffBytes.byteLength > 0);
      const ascii = new TextDecoder("latin1").decode(handoffBytes);
      assert.ok(ascii.includes("ftyp") && ascii.includes("moov"));
    } finally {
      execNoOpfs.dispose();
    }
  }

  // 3) Unwhitelisted third-party PCDN rejection (UNWHITELISTED_CDN) without network request & 0 OPFS residue
  {
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const errors = [];
    const fetchedUrls = [];
    const execPcdn = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (url, init) => {
        fetchedUrls.push(String(url));
        // Stall audio fetch until aborted by sibling video UNWHITELISTED_CDN failure
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      mediabunnyImpl: mediabunny,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload() {
        throw new Error("must not handoff unwhitelisted PCDN");
      },
    });
    try {
      execPcdn.startTask("dash-pcdn-reject", {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://w9e959o.edge.mountaintoys.cn/pcdn-video.m4s"],
        filename: "pcdn.mp4",
        dashMux: {
          videoRoutes: ["https://w9e959o.edge.mountaintoys.cn/pcdn-video.m4s"],
          audioRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/audio.m4s"],
          outputContainer: "mp4",
        },
      });
      await execPcdn.waitForIdle();
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "UNWHITELISTED_CDN");
      assert.equal(errors[0].unwhitelistedHost, "w9e959o.edge.mountaintoys.cn");
      assert.equal(
        fetchedUrls.some((u) => u.includes("mountaintoys.cn")),
        false,
        "unwhitelisted PCDN host must never be fetched",
      );
      assert.equal(opfs.files.size, 0, "0 OPFS temp files left after PCDN rejection");
      assert.equal(execPcdn.getActiveOpfsTempNames().size, 0);
    } finally {
      execPcdn.dispose();
    }
  }

  // 4) Abort during download AND abort mid-mux leave 0 OPFS temp files behind!
  {
    const { videoBytes, audioBytes } =
      await createSyntheticDashTrackBuffers("avc");
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const errors = [];
    const createdTempNames = [];

    // 4a) Mid-mux abort directly via runDashMuxToOpfs
    const abortCtrl = new AbortController();
    let muxErr = null;
    try {
      await dashMuxEngineMod.runDashMuxToOpfs({
        taskId: "dash-abort-mux",
        spec: {
          videoRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/v.m4s"],
          audioRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/a.m4s"],
          outputContainer: "mp4",
        },
        signal: abortCtrl.signal,
        mediabunnyMod: mediabunny,
        async openOpfsSink(tid, _mime, tag) {
          const dir = await opfs.storage.getDirectory();
          const name = `${protocol.EXTENSION_OPFS_TEMP_PREFIX}${tag ? `${tag}-` : ""}${tid}-${createdTempNames.length}.tmp`;
          createdTempNames.push(name);
          const handle = await dir.getFileHandle(name, { create: true });
          const rawWritable = await handle.createWritable();
          let closed = false;
          return {
            tempName: name,
            rawWritable,
            async write(chunk) {
              await rawWritable.write(chunk);
            },
            markWritableClosed() {
              closed = true;
            },
            async closeAndGetBlob() {
              if (!closed) {
                closed = true;
                await rawWritable.close();
              }
              return handle.getFile();
            },
            async cleanup() {
              if (!closed) {
                await rawWritable.abort?.();
              }
              await dir.removeEntry(name).catch(() => {});
            },
          };
        },
        async fetchTrackToOpfs({ role }) {
          const dir = await opfs.storage.getDirectory();
          const tag = role === "video" ? "dash-v" : "dash-a";
          const name = `${protocol.EXTENSION_OPFS_TEMP_PREFIX}${tag}-abort-${createdTempNames.length}.tmp`;
          createdTempNames.push(name);
          const handle = await dir.getFileHandle(name, { create: true });
          const writable = await handle.createWritable();
          const data = role === "video" ? videoBytes : audioBytes;
          await writable.write(data);
          await writable.close();
          const blob = await handle.getFile();
          return {
            blob,
            byteLength: data.byteLength,
            sink: {
              tempName: name,
              async write() {},
              async closeAndGetBlob() {
                return blob;
              },
              async cleanup() {
                await dir.removeEntry(name).catch(() => {});
              },
            },
          };
        },
        onProgress(update) {
          if (update.status === "muxing" && !abortCtrl.signal.aborted) {
            abortCtrl.abort();
          }
        },
      });
    } catch (err) {
      muxErr = err;
    }
    assert.ok(muxErr, "mid-mux abort rejects cleanly");
    assert.equal(muxErr.code, "USER_CANCELLED");
    assert.equal(muxErr.cancelled, true);
    assert.ok(
      createdTempNames.some((n) => n.includes("dokitool-ext-dash-v-")) &&
        createdTempNames.some((n) => n.includes("dokitool-ext-dash-a-")),
      "intermediate track names use dokitool-ext-dash-v/a prefix",
    );
    assert.equal(opfs.files.size, 0, "0 OPFS files left after mid-mux abort");

    // 4b) Mid-download abort via executor.cancelTask
    let fetchStartedCount = 0;
    const execAbort = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (_url, init) => {
        fetchStartedCount += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      mediabunnyImpl: mediabunny,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload() {
        throw new Error("must not handoff cancelled task");
      },
    });
    try {
      execAbort.startTask("dash-cancel-dl", {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/v.m4s"],
        filename: "cancelled.mp4",
        dashMux: {
          videoRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/v.m4s"],
          audioRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/a.m4s"],
          outputContainer: "mp4",
        },
      });
      for (let i = 0; i < 40 && fetchStartedCount < 2; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(fetchStartedCount, 2, "video and audio download concurrently");
      execAbort.cancelTask("dash-cancel-dl");
      await execAbort.waitForIdle();
      assert.equal(errors.length, 1);
      assert.equal(errors[0].cancelled, true);
      assert.equal(errors[0].code, "USER_CANCELLED");
      assert.equal(opfs.files.size, 0, "0 OPFS files left after mid-download cancel");
      assert.equal(execAbort.getActiveOpfsTempNames().size, 0);
    } finally {
      execAbort.dispose();
    }
  }
});

test("Bilibili CDN quirks: allows ISOBMFF binary mislabeled as application/json, still rejects genuine JSON errors, and hands off .m4a blobs as audio/x-m4a", async () => {
  const { videoBytes, audioBytes } =
    await createSyntheticDashTrackBuffers("avc");

  // 1) dash_mux: primary route returns genuine JSON error (rejected -> fallback),
  //    secondary route (like Huawei OBS upos-sz-mirrorhwo1.bilivideo.com) returns valid ISOBMFF
  //    bytes mislabeled with Content-Type: application/json -> accepted & muxed losslessly!
  {
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const errors = [];
    const handoffs = [];
    const fetchedUrls = [];

    const mockFetch = async (url) => {
      const s = String(url);
      fetchedUrls.push(s);
      if (s.includes("json-error.m4s")) {
        return new Response(JSON.stringify({ code: -403, message: "denied" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (s.includes("huawei-obs-video.m4s")) {
        return new Response(videoBytes, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(videoBytes.byteLength),
          },
        });
      }
      if (s.includes("audio-ok.m4s")) {
        return new Response(audioBytes, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(audioBytes.byteLength),
          },
        });
      }
      throw new Error(`Unexpected URL: ${s}`);
    };

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: mockFetch,
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      progressThrottleMs: 0,
      mediabunnyImpl: mediabunny,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload(msg) {
        const blob = urlApi.activeBlobs.get(msg.blobUrl);
        assert.ok(blob);
        assert.equal(blob.type, "video/mp4");
        handoffs.push({ msg, blobType: blob.type, byteLength: blob.size });
        setTimeout(() => {
          executor.releaseBlob({
            taskId: msg.taskId,
            blobUrl: msg.blobUrl,
            opfsTempName: msg.opfsTempName,
          });
        }, 0);
        return { chromeDownloadId: 201 };
      },
    });

    try {
      executor.startTask("dash-json-ct-sniff", {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorhwo1.bilivideo.com/huawei-obs-video.m4s"],
        filename: "bili-avc.mp4",
        mimeType: "video/mp4",
        dashMux: {
          videoRoutes: [
            "https://upos-sz-mirrorcos.bilivideo.com/json-error.m4s",
            "https://upos-sz-mirrorhwo1.bilivideo.com/huawei-obs-video.m4s",
          ],
          audioRoutes: ["https://upos-sz-mirrorcoso1.bilivideo.com/audio-ok.m4s"],
          outputContainer: "mp4",
        },
      });
      await executor.waitForIdle();
      assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
      assert.equal(handoffs.length, 1);
      assert.ok(handoffs[0].byteLength > 0);
      assert.ok(fetchedUrls.some((u) => u.includes("json-error.m4s")));
      assert.ok(fetchedUrls.some((u) => u.includes("huawei-obs-video.m4s")));
      assert.equal(opfs.files.size, 0);
    } finally {
      executor.dispose();
    }
  }

  // 2) direct_file standalone .m4a: accepts mislabeled application/json ISOBMFF audio,
  //    still rejects genuine JSON error route, and wraps Blob as audio/x-m4a (not audio/mp4)
  //    so Chromium preserves the `.m4a` extension on disk.
  {
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const errors = [];
    const handoffs = [];

    const mockFetch = async (url) => {
      const s = String(url);
      if (s.includes("audio-json-error.m4s")) {
        return new Response('{"code":-403,"message":"forbidden"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (s.includes("audio-huawei-obs.m4s")) {
        return new Response(audioBytes, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(audioBytes.byteLength),
          },
        });
      }
      throw new Error(`Unexpected URL: ${s}`);
    };

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: mockFetch,
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      progressThrottleMs: 0,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload(msg) {
        const blob = urlApi.activeBlobs.get(msg.blobUrl);
        assert.ok(blob);
        handoffs.push({ filename: msg.filename, blobType: blob.type, size: blob.size });
        setTimeout(() => {
          executor.releaseBlob({
            taskId: msg.taskId,
            blobUrl: msg.blobUrl,
            opfsTempName: msg.opfsTempName,
          });
        }, 0);
        return { chromeDownloadId: 202 };
      },
    });

    try {
      executor.startTask("direct-m4a-mime", {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: [
          "https://upos-sz-mirrorcos.bilivideo.com/audio-json-error.m4s",
          "https://upos-sz-mirrorhwo1.bilivideo.com/audio-huawei-obs.m4s",
        ],
        filename: "track_原声音频 (M4A).m4a",
        mimeType: "audio/mp4",
      });
      await executor.waitForIdle();
      assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
      assert.equal(handoffs.length, 1);
      assert.equal(handoffs[0].filename, "track_原声音频 (M4A).m4a");
      assert.equal(handoffs[0].blobType, "audio/x-m4a");
      assert.equal(handoffs[0].size, audioBytes.byteLength);
      assert.equal(opfs.files.size, 0);
    } finally {
      executor.dispose();
    }
  }

  // 3) P2 hardening: crafted payload starting with '{' followed by 'ftyp' (e.g. '{"a"ftyp...')
  //    mislabeled as application/json must STILL be rejected and never treated as ISOBMFF.
  {
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const errors = [];
    const crafted = new TextEncoder().encode('{"a"ftypisom0000}');

    const executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async () =>
        new Response(crafted, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      progressThrottleMs: 0,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload() {
        throw new Error("crafted JSON payload must not be handed off");
      },
    });
    try {
      executor.startTask("reject-crafted-json-ftyp", {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/crafted-json.m4s"],
        filename: "crafted.m4a",
        mimeType: "audio/mp4",
      });
      await executor.waitForIdle();
      assert.equal(errors.length, 1);
      assert.equal(opfs.files.size, 0);
    } finally {
      executor.dispose();
    }
  }
});

test("Multi-P Bilibili audio isolation: scopes bilibili-audio-* strictly per episode, merges lazy-resolved attachments, and synthesizes episode M4A from mux audio leaf", async () => {
  const makePartMuxVariant = (partNum, audioUrl, videoUrl) => ({
    id: `dash-80-avc-p${partNum}`,
    label: "1080p",
    metadata: {
      width: 1920,
      height: 1080,
      fps: 30,
      video_codec: "avc1.640032",
      audio_codec: "mp4a.40.2",
      has_audio: true,
      container: "mp4",
      extension: "mp4",
      mime_type: "video/mp4",
    },
    delivery: {
      kind: "mux",
      output: { container: "mp4", extension: "mp4", mime_type: "video/mp4" },
      resources: [
        {
          id: `video-p${partNum}`,
          role: "video",
          metadata: { width: 1920, height: 1080, video_codec: "avc1.640032" },
          delivery: { kind: "file", sources: [{ id: `v${partNum}`, url: videoUrl }] },
        },
        {
          id: `audio-p${partNum}`,
          role: "audio",
          metadata: {
            audio_codec: "mp4a.40.2",
            audio_bitrate_bps: 315000,
            container: "m4a",
            extension: "m4a",
            mime_type: "audio/mp4",
            has_audio: true,
          },
          delivery: { kind: "file", sources: [{ id: `a${partNum}`, url: audioUrl }] },
        },
      ],
    },
  });

  const makePartDurlVariant = (partNum, durlUrl) => ({
    id: `durl-64-p${partNum}`,
    label: "720p",
    metadata: {
      width: 1280,
      height: 720,
      video_codec: "avc1.64001F",
      audio_codec: "mp4a.40.2",
      has_audio: true,
      container: "mp4",
      extension: "mp4",
      mime_type: "video/mp4",
    },
    delivery: { kind: "file", sources: [{ id: `d${partNum}`, url: durlUrl }] },
  });

  const p1AudioUrl = "https://upos-sz-mirrorcos.bilivideo.com/p1_audio_30280.m4s";
  const p2AudioUrl = "https://upos-sz-mirrorcos.bilivideo.com/p2_audio_30280.m4s";
  const p1DurlUrl = "https://upos-sz-mirrorcos.bilivideo.com/p1_720p.mp4";
  const p2DurlUrl = "https://upos-sz-mirrorcos.bilivideo.com/p2_720p.mp4";
  const p3DurlUrl = "https://upos-sz-mirrorcos.bilivideo.com/p3_720p.mp4";

  const p1Item = {
    id: "BV1MultiP001-p1",
    type: "video",
    index: 1,
    title: "第一集",
    default: { variant_id: "durl-64-p1", source_id: "d1", url: p1DurlUrl },
    variants: [
      makePartDurlVariant(1, p1DurlUrl),
      makePartMuxVariant(1, p1AudioUrl, "https://upos-sz-mirrorcos.bilivideo.com/p1_1080p.m4s"),
    ],
  };
  const p2Item = {
    id: "BV1MultiP001-p2",
    type: "video",
    index: 2,
    title: "第二集",
    default: { variant_id: "durl-64-p2", source_id: "d2", url: p2DurlUrl },
    variants: [
      makePartDurlVariant(2, p2DurlUrl),
      makePartMuxVariant(2, p2AudioUrl, "https://upos-sz-mirrorcos.bilivideo.com/p2_1080p.m4s"),
    ],
  };
  const p3DurlOnlyItem = {
    id: "BV1MultiP001-p3",
    type: "video",
    index: 3,
    title: "第三集无DASH",
    default: { variant_id: "durl-64-p3", source_id: "d3", url: p3DurlUrl },
    variants: [makePartDurlVariant(3, p3DurlUrl)],
  };

  const p1Attachment = {
    id: "bilibili-audio-BV1MultiP001-p1",
    role: "background_audio",
    title: "原声音频 (M4A)",
    resource: {
      id: "audio-p1",
      role: "audio",
      metadata: {
        audio_codec: "mp4a.40.2",
        audio_bitrate_bps: 315000,
        container: "m4a",
        extension: "m4a",
        mime_type: "audio/mp4",
        has_audio: true,
      },
      delivery: { kind: "file", sources: [{ id: "a1", url: p1AudioUrl }] },
    },
  };
  const p2Attachment = {
    id: "bilibili-audio-BV1MultiP001-p2",
    role: "background_audio",
    title: "原声音频 (M4A)",
    resource: {
      id: "audio-p2",
      role: "audio",
      metadata: {
        audio_codec: "mp4a.40.2",
        audio_bitrate_bps: 315000,
        container: "m4a",
        extension: "m4a",
        mime_type: "audio/mp4",
        has_audio: true,
      },
      delivery: { kind: "file", sources: [{ id: "a2", url: p2AudioUrl }] },
    },
  };

  // 1) Even BEFORE media.attachments merges P2's attachment (only P1's attachment is present),
  //    SidePanel quality options & audio preference MUST NEVER leak P1's audio into P2 or P3!
  const unmergedMedia = {
    platform: "bilibili",
    content_id: "BV1MultiP001",
    title: "多P测试合集",
    source_url: "https://www.bilibili.com/video/BV1MultiP001",
    default_item_id: p1Item.id,
    items: [p1Item, p2Item, p3DurlOnlyItem],
    attachments: [p1Attachment],
  };

  const p1Opts = uiTargetHelpersMod.buildSidePanelQualityOptions(
    unmergedMedia,
    p1Item,
    "https://snap.dokitool.com",
  );
  const p1AudioOpts = p1Opts.filter((o) => o.isAudioOnly);
  assert.equal(p1AudioOpts.length, 1);
  assert.equal(p1AudioOpts[0].directUrl, p1AudioUrl);

  const p2OptsUnmerged = uiTargetHelpersMod.buildSidePanelQualityOptions(
    unmergedMedia,
    p2Item,
    "https://snap.dokitool.com",
  );
  const p2AudioOptsUnmerged = p2OptsUnmerged.filter((o) => o.isAudioOnly);
  assert.equal(p2AudioOptsUnmerged.length, 1, "P2 synthesizes its own M4A from its mux audio leaf");
  assert.equal(p2AudioOptsUnmerged[0].directUrl, p2AudioUrl, "P2 must use P2 audio URL, never P1");
  assert.equal(p2AudioOptsUnmerged[0].key, "attachment:bilibili-audio-BV1MultiP001-p2");

  const p3Opts = uiTargetHelpersMod.buildSidePanelQualityOptions(
    unmergedMedia,
    p3DurlOnlyItem,
    "https://snap.dokitool.com",
  );
  assert.equal(
    p3Opts.filter((o) => o.isAudioOnly).length,
    0,
    "durl-only P3 must never inherit P1's bilibili-audio attachment",
  );

  // 2) After merging P2's attachment via mergeMediaAttachmentsById, keys remain identical & deduplicated
  const mergedAttachments = uiTargetHelpersMod.mergeMediaAttachmentsById(
    unmergedMedia.attachments,
    [p2Attachment],
  );
  assert.equal(mergedAttachments.length, 2);
  const mergedMedia = { ...unmergedMedia, attachments: mergedAttachments };
  const p2OptsMerged = uiTargetHelpersMod.buildSidePanelQualityOptions(
    mergedMedia,
    p2Item,
    "https://snap.dokitool.com",
  );
  const p2AudioOptsMerged = p2OptsMerged.filter((o) => o.isAudioOnly);
  assert.equal(p2AudioOptsMerged.length, 1, "merged P2 attachment must not duplicate synthesized audio");
  assert.equal(p2AudioOptsMerged[0].directUrl, p2AudioUrl);
  assert.equal(p2AudioOptsMerged[0].key, p2AudioOptsUnmerged[0].key);

  // 3) buildEnqueueItemsForMedia with qualityPreference === "audio" routes P1->p1Audio, P2->p2Audio, P3->p3Durl
  for (const mediaCandidate of [unmergedMedia, mergedMedia]) {
    const audioBatch = extensionDownloadMod.buildEnqueueItemsForMedia(mediaCandidate, {
      apiOrigin: "https://snap.dokitool.com",
      qualityPreference: "audio",
      batchSaveMode: "subfolder",
      subfolderPrefix: "DokiTool",
      forceSubfolder: true,
    });
    assert.equal(audioBatch.length, 3);
    assert.equal(audioBatch[0].spec.kind, "direct_file");
    assert.equal(audioBatch[0].spec.routes[0], p1AudioUrl);
    assert.match(audioBatch[0].spec.filename, /\.m4a$/);
    assert.equal(audioBatch[1].spec.kind, "direct_file");
    assert.equal(audioBatch[1].spec.routes[0], p2AudioUrl, "P2 batch audio must download P2 audio bytes, never P1");
    assert.match(audioBatch[1].spec.filename, /\.m4a$/);
    assert.equal(audioBatch[2].spec.kind, "direct_file");
    assert.equal(audioBatch[2].spec.routes[0], p3DurlUrl, "durl-only P3 must fall back to P3 video, never P1 audio");
    assert.match(audioBatch[2].spec.filename, /\.mp4$/);
  }

  // 4) Background SW hydrateDeferredMediaItems merges resolved P2 attachments and downloads P1 & P2 distinct audio URLs
  {
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const fetchedMediaUrls = [];
    const { audioBytes: p1Bytes } = await createSyntheticDashTrackBuffers("avc");
    const p2Bytes = new Uint8Array(p1Bytes.byteLength + 16);
    p2Bytes.set(p1Bytes, 0);

    const mockFetch = async (url) => {
      const s = String(url);
      if (s.includes("/api/resolve") && s.includes("item=BV1MultiP001-p2")) {
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "OK",
            data: {
              platform: "bilibili",
              content_id: "BV1MultiP001",
              title: "多P测试合集",
              source_url: "https://www.bilibili.com/video/BV1MultiP001/?p=2",
              default_item_id: p2Item.id,
              items: [
                { id: p1Item.id, type: "video", state: "deferred", index: 1, title: p1Item.title, default: null, default_unavailable_reason: "needs_resolve", resolve_url: "/api/resolve?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1MultiP001%2F%3Fp%3D1&item=BV1MultiP001-p1" },
                p2Item,
              ],
              attachments: [p2Attachment],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (s.includes("/api/parse")) {
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "OK",
            data: {
              platform: "bilibili",
              content_id: "BV1MultiP001",
              title: "多P测试合集",
              source_url: "https://www.bilibili.com/video/BV1MultiP001",
              default_item_id: p1Item.id,
              items: [
                p1Item,
                { id: p2Item.id, type: "video", state: "deferred", index: 2, title: p2Item.title, default: null, default_unavailable_reason: "needs_resolve", resolve_url: "/api/resolve?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1MultiP001%2F%3Fp%3D2&item=BV1MultiP001-p2" },
              ],
              attachments: [p1Attachment],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (s === p1AudioUrl) {
        fetchedMediaUrls.push(s);
        return new Response(p1Bytes, { status: 200, headers: { "Content-Type": "audio/mp4" } });
      }
      if (s === p2AudioUrl) {
        fetchedMediaUrls.push(s);
        return new Response(p2Bytes, { status: 200, headers: { "Content-Type": "audio/mp4" } });
      }
      throw new Error(`Unexpected URL in multi-P test: ${s}`);
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
    await extStorage.updateSettings({
      qualityPreference: "audio",
      batchSaveMode: "subfolder",
      subfolderPrefix: "DokiTool",
    });
    const bg = backgroundMod.createBackgroundController({
      chrome: env.chrome,
      storage: extStorage,
      fetchImpl: mockFetch,
    });
    await bg.init();
    try {
      const rpc = await env.chrome.runtime.sendMessage({
        type: "ENQUEUE_BATCH_URLS",
        urls: ["https://www.bilibili.com/video/BV1MultiP001"],
        qualityPreference: "audio",
        batchSaveMode: "subfolder",
      });
      assert.equal(rpc.ok, true);
      await bg.waitForIdle();
      await offscreenCtrl?.executor.waitForIdle();
      const stateRpc = await env.chrome.runtime.sendMessage({ type: "GET_INITIAL_STATE" });
      assert.deepEqual(
        fetchedMediaUrls.sort(),
        [p1AudioUrl, p2AudioUrl].sort(),
        `tasks=${JSON.stringify(stateRpc?.data?.tasks)}`,
      );
      assert.equal(env.downloadCalls.length, 2);
      assert.ok(env.downloadCalls.every((d) => d.filename.endsWith(".m4a")));
    } finally {
      offscreenCtrl?.dispose();
      bg.dispose();
    }
  }
});

test("[B4] Single authoritative extractDashMuxSpec filters expired expires_at sources in both extractDashMuxSpec and buildSidePanelQualityOptions", () => {
  // Single authoritative function shared across dashMuxSpec, dashMuxDownload, and extensionDownload
  assert.equal(
    extensionDownloadMod.extractDashMuxSpec,
    dashMuxSpecMod.extractDashMuxSpec,
  );
  assert.equal(
    dashMuxDownloadMod.extractDashMuxSpec,
    dashMuxSpecMod.extractDashMuxSpec,
  );

  const now = Date.parse("2026-11-22T12:00:00Z");
  const expiredIso = "2026-11-22T11:55:00Z";
  const freshIso = "2026-11-22T12:30:00Z";

  const fullyExpiredVariant = {
    id: "dash-80-expired",
    label: "1080p",
    metadata: {
      width: 1920,
      height: 1080,
      video_codec: "avc1.640032",
      audio_codec: "mp4a.40.2",
      has_audio: true,
      container: "mp4",
      extension: "mp4",
    },
    delivery: {
      kind: "mux",
      output: { container: "mp4", extension: "mp4", mime_type: "video/mp4" },
      resources: [
        {
          id: "v-exp",
          role: "video",
          delivery: {
            kind: "file",
            sources: [
              {
                id: "v1",
                url: "https://upos-sz-mirrorcos.bilivideo.com/expired-v.m4s",
                expires_at: expiredIso,
                size_bytes: 12_000_000,
              },
            ],
          },
        },
        {
          id: "a-ok",
          role: "audio",
          delivery: {
            kind: "file",
            sources: [
              {
                id: "a1",
                url: "https://upos-sz-mirrorcos.bilivideo.com/fresh-a.m4s",
                expires_at: freshIso,
                size_bytes: 2_000_000,
              },
            ],
          },
        },
      ],
    },
  };

  const partialExpiredVariant = {
    id: "dash-80-partial",
    label: "1080p",
    metadata: {
      width: 1920,
      height: 1080,
      video_codec: "avc1.640032",
      audio_codec: "mp4a.40.2",
      has_audio: true,
      container: "mp4",
      extension: "mp4",
    },
    delivery: {
      kind: "mux",
      output: { container: "mp4", extension: "mp4", mime_type: "video/mp4" },
      resources: [
        {
          id: "v-mix",
          role: "video",
          delivery: {
            kind: "file",
            sources: [
              {
                id: "v-old",
                url: "https://upos-sz-mirrorcos.bilivideo.com/old-v.m4s",
                expires_at: expiredIso,
                size_bytes: 12_000_000,
              },
              {
                id: "v-new",
                url: "https://upos-sz-mirrorali.bilivideo.com/new-v.m4s",
                expires_at: freshIso,
                size_bytes: 12_000_000,
              },
            ],
          },
        },
        {
          id: "a-mix",
          role: "audio",
          delivery: {
            kind: "file",
            sources: [
              {
                id: "a-old",
                url: "https://upos-sz-mirrorcos.bilivideo.com/old-a.m4s",
                expires_at: expiredIso,
                size_bytes: 2_000_000,
              },
              {
                id: "a-new",
                url: "https://upos-sz-mirrorali.bilivideo.com/new-a.m4s",
                expires_at: freshIso,
                size_bytes: 2_000_000,
              },
            ],
          },
        },
      ],
    },
  };

  const durlVariant = {
    id: "durl-64",
    label: "720p",
    metadata: {
      width: 1280,
      height: 720,
      video_codec: "avc1.64001F",
      audio_codec: "mp4a.40.2",
      has_audio: true,
      container: "mp4",
      extension: "mp4",
    },
    delivery: {
      kind: "file",
      sources: [
        {
          id: "d1",
          url: "https://upos-sz-mirrorcos.bilivideo.com/durl-720p.mp4",
          expires_at: freshIso,
          size_bytes: 8_000_000,
        },
      ],
    },
  };

  // Direct extractDashMuxSpec checks
  assert.equal(
    dashMuxSpecMod.extractDashMuxSpec(fullyExpiredVariant, {
      apiOrigin: "https://snap.dokitool.com",
      now,
    }),
    null,
    "expired video leaf must return null",
  );
  const partialSpec = dashMuxSpecMod.extractDashMuxSpec(partialExpiredVariant, {
    apiOrigin: "https://snap.dokitool.com",
    now,
  });
  assert.ok(partialSpec, "variant with unexpired fallback source remains valid");
  assert.deepEqual(partialSpec.videoRoutes, [
    "https://upos-sz-mirrorali.bilivideo.com/new-v.m4s",
  ]);
  assert.deepEqual(partialSpec.audioRoutes, [
    "https://upos-sz-mirrorali.bilivideo.com/new-a.m4s",
  ]);

  // buildSidePanelQualityOptions must honor expires_at via shared extractDashMuxSpec
  const item = {
    id: "BV1ExpireTest",
    type: "video",
    title: "过期 DASH 源过滤测试",
    default: { variant_id: "durl-64", source_id: "d1", url: durlVariant.delivery.sources[0].url },
    variants: [fullyExpiredVariant, partialExpiredVariant, durlVariant],
  };
  const media = {
    platform: "bilibili",
    content_id: "BV1ExpireTest",
    source_url: "https://www.bilibili.com/video/BV1ExpireTest",
    title: "过期 DASH 源过滤测试",
    default_item_id: item.id,
    items: [item],
  };

  const opts = uiTargetHelpersMod.buildSidePanelQualityOptions(
    media,
    item,
    "https://snap.dokitool.com",
    { now },
  );
  const expiredOpt = opts.find((o) => o.variant.id === "dash-80-expired");
  assert.ok(expiredOpt, "expired variant entry exists");
  assert.equal(
    expiredOpt.downloadable,
    false,
    "expired DASH variant must be marked non-downloadable",
  );
  assert.equal(expiredOpt.isDashMux, false);
  assert.equal(expiredOpt.dashMux, null);

  const partialOpt = opts.find((o) => o.variant.id === "dash-80-partial");
  assert.ok(partialOpt, "partially expired DASH variant entry exists");
  assert.equal(partialOpt.downloadable, true);
  assert.equal(partialOpt.isDashMux, true);
  assert.deepEqual(partialOpt.dashMux.videoRoutes, [
    "https://upos-sz-mirrorali.bilivideo.com/new-v.m4s",
  ]);
  assert.deepEqual(partialOpt.dashMux.audioRoutes, [
    "https://upos-sz-mirrorali.bilivideo.com/new-a.m4s",
  ]);
});

test("[M1] OPFS 2x quota precheck aborts before DASH download (0 fetches) and before opening 3rd mux output sink (0 OPFS residue)", async () => {
  const { videoBytes, audioBytes } =
    await createSyntheticDashTrackBuffers("avc");

  // 1) Pre-download quota failure with known track sizes: 0 fetches, OPFS_QUOTA_EXCEEDED, 0 OPFS residue
  {
    const opfs = createMockOpfs({ quota: 30_000_000 }); // 30 MB < Math.ceil(20 MB * 2.15) = 43 MB
    const urlApi = createTrackedUrlApi();
    const errors = [];
    let fetchCount = 0;

    const executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("must not fetch when OPFS quota is insufficient before download");
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      mediabunnyImpl: mediabunny,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload() {
        throw new Error("must not handoff on quota failure");
      },
    });
    try {
      executor.startTask("dash-quota-predownload-known", {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/v.m4s"],
        filename: "quota-known.mp4",
        mimeType: "video/mp4",
        dashMux: {
          videoRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/v.m4s"],
          audioRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/a.m4s"],
          videoSize: 16_000_000,
          audioSize: 4_000_000,
          outputContainer: "mp4",
        },
      });
      await executor.waitForIdle();
      assert.equal(fetchCount, 0, "pre-download quota check must fail before any fetch");
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "OPFS_QUOTA_EXCEEDED");
      assert.match(errors[0].error, /浏览器临时存储空间不足.*2 倍/);
      assert.equal(opfs.files.size, 0, "0 OPFS temp files left behind");
    } finally {
      executor.dispose();
    }
  }

  // 2) Pre-download quota failure with unknown track sizes (64 MiB default safety floor)
  {
    const opfs = createMockOpfs({ quota: 32 * 1024 * 1024 }); // 32 MiB < 64 MiB
    const urlApi = createTrackedUrlApi();
    const errors = [];
    let fetchCount = 0;

    const executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("must not fetch when OPFS quota is below 64 MiB unknown-size floor");
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      mediabunnyImpl: mediabunny,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload() {
        throw new Error("must not handoff on quota failure");
      },
    });
    try {
      executor.startTask("dash-quota-predownload-unknown", {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/v.m4s"],
        filename: "quota-unknown.mp4",
        mimeType: "video/mp4",
        dashMux: {
          videoRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/v.m4s"],
          audioRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/a.m4s"],
          outputContainer: "mp4",
        },
      });
      await executor.waitForIdle();
      assert.equal(fetchCount, 0);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "OPFS_QUOTA_EXCEEDED");
      assert.equal(opfs.files.size, 0);
    } finally {
      executor.dispose();
    }
  }

  // 3) Pre-mux quota failure right before opening 3rd output OPFS sink:
  //    both tracks download successfully, then remaining OPFS space < Math.ceil(total * 1.1) ->
  //    aborts cleanly with OPFS_QUOTA_EXCEEDED and finally removes BOTH intermediate track files (0 residue!).
  {
    const totalActual = videoBytes.byteLength + audioBytes.byteLength;
    // Pre-download sees underestimated sizes (totalActual / 4 * 2.15 < quota), so tracks download.
    // Once both tracks are written to OPFS, usage === totalActual, leaving available = 0.8 * totalActual
    // which is < Math.ceil(totalActual * 1.1) right before opening the 3rd mux output sink!
    const tightQuota = Math.floor(totalActual * 1.8);
    const opfs = createMockOpfs({ quota: tightQuota });
    const urlApi = createTrackedUrlApi();
    const errors = [];
    let fetchCount = 0;

    const executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (url) => {
        fetchCount += 1;
        const s = String(url);
        if (s.includes("v-premux.m4s")) {
          return new Response(videoBytes, {
            status: 200,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(videoBytes.byteLength),
            },
          });
        }
        if (s.includes("a-premux.m4s")) {
          return new Response(audioBytes, {
            status: 200,
            headers: {
              "Content-Type": "audio/mp4",
              "Content-Length": String(audioBytes.byteLength),
            },
          });
        }
        throw new Error(`Unexpected URL: ${s}`);
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      mediabunnyImpl: mediabunny,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload() {
        throw new Error("must not handoff when pre-mux quota check fails");
      },
    });
    try {
      executor.startTask("dash-quota-premux", {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/v-premux.m4s"],
        filename: "quota-premux.mp4",
        mimeType: "video/mp4",
        dashMux: {
          videoRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/v-premux.m4s"],
          audioRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/a-premux.m4s"],
          videoSize: Math.max(1, Math.floor(videoBytes.byteLength / 4)),
          audioSize: Math.max(1, Math.floor(audioBytes.byteLength / 4)),
          outputContainer: "mp4",
        },
      });
      await executor.waitForIdle();
      assert.equal(fetchCount, 2, "both tracks were fetched before pre-mux quota check");
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "OPFS_QUOTA_EXCEEDED");
      assert.match(errors[0].error, /浏览器临时存储空间不足.*2 倍/);
      assert.equal(
        opfs.files.size,
        0,
        "finally must remove BOTH intermediate OPFS track files with 0 residue",
      );
      assert.equal(executor.getActiveOpfsTempNames().size, 0);
    } finally {
      executor.dispose();
    }
  }
});

test("[M2 Part A] Mid-stream Range resume (206 + strict Content-Range) on direct_file & dash_mux, plus safe 0-byte fallback on 200/416/mismatched Content-Range", async () => {
  const makeDroppingStreamResponse = (
    slice,
    { status = 200, headers = {}, dropWithError = false } = {},
  ) => {
    let emitted = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (!emitted) {
          emitted = true;
          controller.enqueue(slice);
          return;
        }
        if (dropWithError) {
          controller.error(new TypeError("simulated mid-stream network reset"));
        } else {
          controller.close();
        }
      },
    });
    return new Response(stream, { status, headers });
  };

  // 1) direct_file: multi-hop mid-stream drop (drop at 8 KiB -> 206 drop at 16 KiB -> 206 completes 24 KiB)
  {
    const fullBytes = new Uint8Array(24_576);
    for (let i = 0; i < fullBytes.byteLength; i++) {
      fullBytes[i] = (i * 31 + 17) & 0xff;
    }
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const rangeHeadersSeen = [];
    const errors = [];
    let handedBytes = null;

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (_url, init) => {
        const range = init?.headers?.Range || null;
        rangeHeadersSeen.push(range);
        if (!range) {
          return makeDroppingStreamResponse(fullBytes.subarray(0, 8192), {
            status: 200,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(fullBytes.byteLength),
            },
            dropWithError: true,
          });
        }
        if (range === "bytes=8192-") {
          return makeDroppingStreamResponse(fullBytes.subarray(8192, 16384), {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": `bytes 8192-${fullBytes.byteLength - 1}/${fullBytes.byteLength}`,
              "Content-Length": String(fullBytes.byteLength - 8192),
            },
            dropWithError: false, // premature EOF after 8 KiB
          });
        }
        if (range === "bytes=16384-") {
          return new Response(fullBytes.subarray(16384), {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": `bytes 16384-${fullBytes.byteLength - 1}/${fullBytes.byteLength}`,
              "Content-Length": String(fullBytes.byteLength - 16384),
            },
          });
        }
        throw new Error(`Unexpected Range header: ${range}`);
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      progressThrottleMs: 0,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload(msg) {
        const blob = urlApi.activeBlobs.get(msg.blobUrl);
        handedBytes = new Uint8Array(await blob.arrayBuffer());
        setTimeout(() => {
          executor.releaseBlob({
            taskId: msg.taskId,
            blobUrl: msg.blobUrl,
            opfsTempName: msg.opfsTempName,
          });
        }, 0);
        return { chromeDownloadId: 301 };
      },
    });
    try {
      executor.startTask("direct-range-resume", {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/direct-resumable.mp4"],
        filename: "direct-resumed.mp4",
        mimeType: "video/mp4",
      });
      await executor.waitForIdle();
      assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
      assert.deepEqual(rangeHeadersSeen, [null, "bytes=8192-", "bytes=16384-"]);
      assert.ok(handedBytes);
      assert.equal(handedBytes.byteLength, fullBytes.byteLength);
      assert.deepEqual(handedBytes, fullBytes, "resumed direct_file bytes must match exact payload");
      assert.equal(opfs.files.size, 0);
    } finally {
      executor.dispose();
    }
  }

  // 2) dash_mux: BOTH video (mislabeled application/json like Huawei OBS) and audio drop mid-stream,
  //    resume via 206 + Content-Range, and mux via real mediabunny into a valid MP4 with video + audio tracks!
  {
    const { videoBytes, audioBytes } =
      await createSyntheticDashTrackBuffers("avc");
    const vCut = Math.max(64, Math.floor(videoBytes.byteLength * 0.4));
    const aCut = Math.max(64, Math.floor(audioBytes.byteLength * 0.5));
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const errors = [];
    const rangeRequests = [];
    let muxedMp4Bytes = null;

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (url, init) => {
        const s = String(url);
        const range = init?.headers?.Range || null;
        if (range) rangeRequests.push({ url: s, range });

        if (s.includes("dash-resume-v.m4s")) {
          if (!range) {
            return makeDroppingStreamResponse(videoBytes.subarray(0, vCut), {
              status: 200,
              headers: {
                "Content-Type": "application/json", // Huawei OBS quirk + ISOBMFF sniff!
                "Content-Length": String(videoBytes.byteLength),
              },
              dropWithError: true,
            });
          }
          assert.equal(range, `bytes=${vCut}-`);
          return new Response(videoBytes.subarray(vCut), {
            status: 206,
            headers: {
              "Content-Type": "application/json",
              "Content-Range": `bytes ${vCut}-${videoBytes.byteLength - 1}/${videoBytes.byteLength}`,
              "Content-Length": String(videoBytes.byteLength - vCut),
            },
          });
        }
        if (s.includes("dash-resume-a.m4s")) {
          if (!range) {
            return makeDroppingStreamResponse(audioBytes.subarray(0, aCut), {
              status: 200,
              headers: {
                "Content-Type": "audio/mp4",
                "Content-Length": String(audioBytes.byteLength),
              },
              dropWithError: false, // premature EOF
            });
          }
          assert.equal(range, `bytes=${aCut}-`);
          return new Response(audioBytes.subarray(aCut), {
            status: 206,
            headers: {
              "Content-Type": "audio/mp4",
              "Content-Range": `bytes ${aCut}-${audioBytes.byteLength - 1}/${audioBytes.byteLength}`,
              "Content-Length": String(audioBytes.byteLength - aCut),
            },
          });
        }
        throw new Error(`Unexpected URL: ${s}`);
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      progressThrottleMs: 0,
      mediabunnyImpl: mediabunny,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload(msg) {
        const blob = urlApi.activeBlobs.get(msg.blobUrl);
        muxedMp4Bytes = new Uint8Array(await blob.arrayBuffer());
        setTimeout(() => {
          executor.releaseBlob({
            taskId: msg.taskId,
            blobUrl: msg.blobUrl,
            opfsTempName: msg.opfsTempName,
          });
        }, 0);
        return { chromeDownloadId: 302 };
      },
    });
    try {
      executor.startTask("dash-range-resume", {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorhwo1.bilivideo.com/dash-resume-v.m4s"],
        filename: "dash-resumed.mp4",
        mimeType: "video/mp4",
        dashMux: {
          videoRoutes: ["https://upos-sz-mirrorhwo1.bilivideo.com/dash-resume-v.m4s"],
          audioRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/dash-resume-a.m4s"],
          videoSize: videoBytes.byteLength,
          audioSize: audioBytes.byteLength,
          outputContainer: "mp4",
        },
      });
      await executor.waitForIdle();
      assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
      assert.equal(rangeRequests.length, 2, "both video and audio tracks resumed via Range");
      assert.ok(muxedMp4Bytes && muxedMp4Bytes.byteLength > 0);
      // Verify output MP4 is a valid muxed container with BOTH video and audio tracks!
      const parsed = new mediabunny.Input({
        source: new mediabunny.BufferSource(muxedMp4Bytes),
        formats: mediabunny.ALL_FORMATS,
      });
      try {
        const vTrack = await parsed.getPrimaryVideoTrack();
        const aTrack = await parsed.getPrimaryAudioTrack();
        assert.ok(vTrack, "resumed DASH MP4 contains valid video track");
        assert.ok(aTrack, "resumed DASH MP4 contains valid audio track");
      } finally {
        parsed.dispose?.();
      }
      assert.equal(opfs.files.size, 0, "0 OPFS residue after resumed dash_mux");
    } finally {
      executor.dispose();
    }
  }

  // 3) Unsafe resume responses (HTTP 200, HTTP 416, mismatched Content-Range start, mismatched Content-Range total)
  //    MUST cleanly delete partial OPFS sink and fall back to fresh 0-byte download (zero corrupted concatenation!)
  for (const mode of ["status-200", "status-416", "bad-start", "bad-total"]) {
    const fullBytes = new Uint8Array(4096);
    for (let i = 0; i < fullBytes.byteLength; i++) {
      fullBytes[i] = (i * 13 + 7) & 0xff;
    }
    const cut = 1500;
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const errors = [];
    let callNum = 0;
    let handedBytes = null;

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (_url, init) => {
        callNum += 1;
        const range = init?.headers?.Range || null;
        if (callNum === 1) {
          assert.equal(range, null);
          return makeDroppingStreamResponse(fullBytes.subarray(0, cut), {
            status: 200,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(fullBytes.byteLength),
            },
            dropWithError: true,
          });
        }
        if (callNum === 2) {
          assert.equal(range, `bytes=${cut}-`);
          if (mode === "status-200") {
            return new Response(fullBytes, {
              status: 200,
              headers: {
                "Content-Type": "video/mp4",
                "Content-Length": String(fullBytes.byteLength),
              },
            });
          }
          if (mode === "status-416") {
            return new Response("Range Not Satisfiable", {
              status: 416,
              headers: { "Content-Range": `bytes */${fullBytes.byteLength}` },
            });
          }
          if (mode === "bad-start") {
            return new Response(fullBytes, {
              status: 206,
              headers: {
                "Content-Type": "video/mp4",
                "Content-Range": `bytes 0-${fullBytes.byteLength - 1}/${fullBytes.byteLength}`,
              },
            });
          }
          if (mode === "bad-total") {
            return new Response(fullBytes.subarray(cut), {
              status: 206,
              headers: {
                "Content-Type": "video/mp4",
                "Content-Range": `bytes ${cut}-${fullBytes.byteLength - 1}/${fullBytes.byteLength + 999}`,
              },
            });
          }
        }
        // Call 3: clean fresh 0-byte redownload (no Range header!)
        assert.equal(range, null, `${mode}: fresh fallback GET must not send Range`);
        return new Response(fullBytes, {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(fullBytes.byteLength),
          },
        });
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      progressThrottleMs: 0,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload(msg) {
        const blob = urlApi.activeBlobs.get(msg.blobUrl);
        handedBytes = new Uint8Array(await blob.arrayBuffer());
        setTimeout(() => {
          executor.releaseBlob({
            taskId: msg.taskId,
            blobUrl: msg.blobUrl,
            opfsTempName: msg.opfsTempName,
          });
        }, 0);
        return { chromeDownloadId: 310 };
      },
    });
    try {
      executor.startTask(`fallback-${mode}`, {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: [`https://upos-sz-mirrorcos.bilivideo.com/${mode}.mp4`],
        filename: `${mode}.mp4`,
        mimeType: "video/mp4",
      });
      await executor.waitForIdle();
      assert.equal(errors.length, 0, `${mode}: unexpected errors ${JSON.stringify(errors)}`);
      assert.equal(callNum, 3, `${mode}: initial drop -> rejected resume -> clean 0-byte redownload`);
      assert.deepEqual(
        handedBytes,
        fullBytes,
        `${mode}: fallback bytes must be exact 0-byte payload without corrupted concatenation`,
      );
      assert.equal(opfs.files.size, 0);
    } finally {
      executor.dispose();
    }
  }

  // 4) User cancellation mid-stream must NEVER issue any Range resume request!
  {
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const errors = [];
    let fetchCalls = 0;
    let chunkEmittedResolve;
    const chunkEmitted = new Promise((r) => {
      chunkEmittedResolve = r;
    });

    const executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async () => {
        fetchCalls += 1;
        let sent = false;
        const stream = new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(new Uint8Array(1024).fill(0x55));
              chunkEmittedResolve();
              return;
            }
            return new Promise(() => {}); // wait until cancelled
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "video/mp4", "Content-Length": "4096" },
        });
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload() {
        throw new Error("cancelled download must not handoff");
      },
    });
    try {
      executor.startTask("cancel-no-range-resume", {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/cancel-midstream.mp4"],
        filename: "cancelled-midstream.mp4",
        mimeType: "video/mp4",
      });
      await chunkEmitted;
      await new Promise((r) => setTimeout(r, 10));
      executor.cancelTask("cancel-no-range-resume");
      await executor.waitForIdle();
      assert.equal(fetchCalls, 1, "cancelled stream must NEVER attempt Range resume");
      assert.equal(errors.length, 1);
      assert.equal(errors[0].cancelled, true);
      assert.equal(errors[0].code, "USER_CANCELLED");
      assert.equal(opfs.files.size, 0);
    } finally {
      executor.dispose();
    }
  }
});

test("[M2 Part B] Expired signed URL auto re-parse refresh: pre-start expires_at, all-routes 403 (strictly max 1 auto-refresh), manual RETRY_TASK refresh, and multi-P resolveUrl", async () => {
  const { videoBytes, audioBytes } =
    await createSyntheticDashTrackBuffers("avc");

  const makeBiliMediaPayload = ({
    videoUrl,
    audioUrl,
    durlUrl,
    expiresAtIso,
    itemId = "BV1Refresh01-p1",
    parseUrl = "https://www.bilibili.com/video/BV1Refresh01",
    resolveUrl,
  }) => ({
    schema_version: "1.0",
    code: "OK",
    data: {
      platform: "bilibili",
      content_id: "BV1Refresh01",
      source_url: parseUrl,
      ...(expiresAtIso ? { generated_at: "2026-11-22T11:30:00Z" } : {}),
      title: "过期重解析测试",
      default_item_id: itemId,
      items: [
        {
          id: itemId,
          type: "video",
          title: "测试视频",
          ...(resolveUrl ? { resolve_url: resolveUrl } : {}),
          default: {
            variant_id: "durl-64",
            source_id: "d1",
            url: durlUrl,
            ...(expiresAtIso ? { expires_at: expiresAtIso } : {}),
          },
          variants: [
            {
              id: "durl-64",
              label: "720p",
              metadata: {
                width: 1280,
                height: 720,
                video_codec: "avc1.64001F",
                audio_codec: "mp4a.40.2",
                has_audio: true,
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
              },
              delivery: {
                kind: "file",
                sources: [
                  {
                    id: "d1",
                    url: durlUrl,
                    ...(expiresAtIso ? { expires_at: expiresAtIso } : {}),
                  },
                ],
              },
            },
            {
              id: "dash-80-avc",
              label: "1080p",
              metadata: {
                width: 1920,
                height: 1080,
                video_codec: "avc1.640032",
                audio_codec: "mp4a.40.2",
                has_audio: true,
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
              },
              delivery: {
                kind: "mux",
                output: { container: "mp4", extension: "mp4", mime_type: "video/mp4" },
                resources: [
                  {
                    id: "v-1080",
                    role: "video",
                    delivery: {
                      kind: "file",
                      sources: [
                        {
                          id: "v1",
                          url: videoUrl,
                          ...(expiresAtIso ? { expires_at: expiresAtIso } : {}),
                          size_bytes: videoBytes.byteLength,
                        },
                      ],
                    },
                  },
                  {
                    id: "a-30280",
                    role: "audio",
                    delivery: {
                      kind: "file",
                      sources: [
                        {
                          id: "a1",
                          url: audioUrl,
                          ...(expiresAtIso ? { expires_at: expiresAtIso } : {}),
                          size_bytes: audioBytes.byteLength,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  });

  // 1) Pre-dispatch expired expiresAtMs triggers automatic re-parse BEFORE fetching old expired URLs
  {
    let fakeNow = Date.parse("2026-11-22T12:00:00Z");
    const expiredIso = "2026-11-22T11:50:00Z";
    const freshIso = "2026-11-22T13:00:00Z";
    const oldVideoUrl = "https://upos-sz-mirrorcos.bilivideo.com/pre-old-v.m4s";
    const oldAudioUrl = "https://upos-sz-mirrorcos.bilivideo.com/pre-old-a.m4s";
    const freshVideoUrl = "https://upos-sz-mirrorcos.bilivideo.com/pre-fresh-v.m4s";
    const freshAudioUrl = "https://upos-sz-mirrorcos.bilivideo.com/pre-fresh-a.m4s";
    const durlUrl = "https://upos-sz-mirrorcos.bilivideo.com/pre-durl.mp4";

    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const fetchedUrls = [];
    let parseCount = 0;

    const mockFetch = async (url) => {
      const s = String(url);
      fetchedUrls.push(s);
      if (s.includes("/api/parse")) {
        parseCount += 1;
        return new Response(
          JSON.stringify(
            makeBiliMediaPayload({
              videoUrl: freshVideoUrl,
              audioUrl: freshAudioUrl,
              durlUrl,
              expiresAtIso: freshIso,
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (s === freshVideoUrl) {
        return new Response(videoBytes, {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(videoBytes.byteLength),
          },
        });
      }
      if (s === freshAudioUrl) {
        return new Response(audioBytes, {
          status: 200,
          headers: {
            "Content-Type": "audio/mp4",
            "Content-Length": String(audioBytes.byteLength),
          },
        });
      }
      throw new Error(`Unexpected URL fetched (must not hit expired media): ${s}`);
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
            mediabunnyImpl: mediabunny,
          });
        }
      },
    });
    const bg = backgroundMod.createBackgroundController({
      chrome: env.chrome,
      storage: storage.createExtensionStorage(),
      fetchImpl: mockFetch,
      now: () => fakeNow,
    });
    await bg.init();
    try {
      // Build enqueue item while clock was earlier (unexpired), then advance clock past expires_at!
      const initialMedia = makeBiliMediaPayload({
        videoUrl: oldVideoUrl,
        audioUrl: oldAudioUrl,
        durlUrl,
        expiresAtIso: expiredIso,
      }).data;
      const opts = uiTargetHelpersMod.buildSidePanelQualityOptions(
        initialMedia,
        initialMedia.items[0],
        "https://snap.dokitool.com",
        { now: Date.parse("2026-11-22T11:40:00Z") },
      );
      const dashOpt = opts.find((o) => o.variant.id === "dash-80-avc");
      assert.ok(dashOpt && dashOpt.isDashMux);
      const enqItem = uiTargetHelpersMod.buildSingleDownloadEnqueueItem({
        media: initialMedia,
        item: initialMedia.items[0],
        option: dashOpt,
        settings: storage.DEFAULT_EXTENSION_SETTINGS,
      });
      assert.equal(enqItem.refreshContext.itemId, "BV1Refresh01-p1");
      assert.equal(enqItem.refreshContext.variantId, "dash-80-avc");
      assert.equal(enqItem.refreshContext.expiresAtMs, Date.parse(expiredIso));

      const rpc = await env.chrome.runtime.sendMessage({
        type: "ENQUEUE_DOWNLOADS",
        items: [enqItem],
      });
      assert.equal(rpc.ok, true);
      await bg.waitForIdle();
      await offscreenCtrl?.executor.waitForIdle();

      assert.equal(parseCount, 1, "pre-start expiry triggered exactly 1 re-parse");
      assert.equal(
        fetchedUrls.some((u) => u.includes("pre-old-")),
        false,
        "expired URLs must never be fetched before refresh",
      );
      assert.ok(fetchedUrls.includes(freshVideoUrl));
      assert.ok(fetchedUrls.includes(freshAudioUrl));
      const snap = await bg.getSnapshot();
      assert.equal(snap.tasks[0].status, "completed");
      assert.equal(snap.tasks[0].autoRefreshCount, 1);
      assert.equal(snap.tasks[0].filename, enqItem.spec.filename);
      assert.equal(opfs.files.size, 0);
    } finally {
      offscreenCtrl?.dispose();
      bg.dispose();
    }
  }

  // 2) All-routes HTTP 403 on dash_mux triggers auto-refresh once and completes with preserved filename
  {
    const staleV1 = "https://upos-sz-mirrorcos.bilivideo.com/403-v1.m4s";
    const staleV2 = "https://upos-sz-mirrorali.bilivideo.com/403-v2.m4s";
    const staleA = "https://upos-sz-mirrorcos.bilivideo.com/403-a1.m4s";
    const freshV = "https://upos-sz-mirrorcos.bilivideo.com/403-fresh-v.m4s";
    const freshA = "https://upos-sz-mirrorcos.bilivideo.com/403-fresh-a.m4s";
    const durlUrl = "https://upos-sz-mirrorcos.bilivideo.com/403-durl.mp4";

    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const statusTextHistory = [];
    let parseCount = 0;

    const mockFetch = async (url) => {
      const s = String(url);
      if (s.includes("/api/parse")) {
        parseCount += 1;
        return new Response(
          JSON.stringify(
            makeBiliMediaPayload({
              videoUrl: freshV,
              audioUrl: freshA,
              durlUrl,
              expiresAtIso: "2099-01-01T00:00:00Z",
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (s === staleV1 || s === staleV2 || s === staleA) {
        return new Response("Forbidden", { status: 403 });
      }
      if (s === freshV) {
        return new Response(videoBytes, {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(videoBytes.byteLength),
          },
        });
      }
      if (s === freshA) {
        return new Response(audioBytes, {
          status: 200,
          headers: {
            "Content-Type": "audio/mp4",
            "Content-Length": String(audioBytes.byteLength),
          },
        });
      }
      throw new Error(`Unexpected URL: ${s}`);
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
            mediabunnyImpl: mediabunny,
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
    const spPort = env.chrome.runtime.connect({
      name: protocol.SIDEPANEL_PORT_NAME,
    });
    spPort.onMessage.addListener((msg) => {
      if (msg.type === "TASKS_UPDATED" && msg.tasks[0]) {
        statusTextHistory.push(msg.tasks[0].statusText);
      }
    });
    try {
      const rpc = await env.chrome.runtime.sendMessage({
        type: "ENQUEUE_DOWNLOADS",
        items: [
          {
            title: "403 自动重刷测试",
            platform: "bilibili",
            spec: {
              kind: "dash_mux",
              apiOrigin: "https://snap.dokitool.com",
              routes: [staleV1, staleV2],
              filename: "DokiTool/custom-preserved-name.mp4",
              mimeType: "video/mp4",
              dashMux: {
                videoRoutes: [staleV1, staleV2],
                audioRoutes: [staleA],
                videoSize: videoBytes.byteLength,
                audioSize: audioBytes.byteLength,
                outputContainer: "mp4",
              },
              refreshContext: {
                parseUrl: "https://www.bilibili.com/video/BV1Refresh01",
                platform: "bilibili",
                itemId: "BV1Refresh01-p1",
                variantId: "dash-80-avc",
              },
            },
          },
        ],
      });
      assert.equal(rpc.ok, true);
      await bg.waitForIdle();
      await offscreenCtrl?.executor.waitForIdle();

      assert.equal(parseCount, 1);
      assert.ok(
        statusTextHistory.some((t) => t.includes("签名链接已过期，正在自动重新解析")),
        `expected refresh status text, got ${JSON.stringify(statusTextHistory)}`,
      );
      const snap = await bg.getSnapshot();
      assert.equal(snap.tasks[0].status, "completed");
      assert.equal(snap.tasks[0].autoRefreshCount, 1);
      assert.equal(snap.tasks[0].filename, "DokiTool/custom-preserved-name.mp4");
      assert.equal(opfs.files.size, 0);
    } finally {
      spPort.disconnect();
      offscreenCtrl?.dispose();
      bg.dispose();
    }
  }

  // 3) Bounded max-1 auto-refresh (second 403 fails cleanly without infinite loop) +
  //    manual RETRY_TASK refreshes fresh URLs and succeeds!
  {
    const staleDurl = "https://upos-sz-mirrorcos.bilivideo.com/loop-403-v1.mp4";
    const still403Durl = "https://upos-sz-mirrorcos.bilivideo.com/loop-403-v2.mp4";
    const workingDurl = "https://upos-sz-mirrorcos.bilivideo.com/loop-ok-v3.mp4";
    const dummyV = "https://upos-sz-mirrorcos.bilivideo.com/dummy-v.m4s";
    const dummyA = "https://upos-sz-mirrorcos.bilivideo.com/dummy-a.m4s";

    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    let parseCalls = 0;

    const mockFetch = async (url) => {
      const s = String(url);
      if (s.includes("/api/parse")) {
        parseCalls += 1;
        const chosenDurl = parseCalls === 1 ? still403Durl : workingDurl;
        return new Response(
          JSON.stringify(
            makeBiliMediaPayload({
              videoUrl: dummyV,
              audioUrl: dummyA,
              durlUrl: chosenDurl,
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (s === staleDurl || s === still403Durl) {
        return new Response("Forbidden", { status: 403 });
      }
      if (s === workingDurl) {
        return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
          status: 200,
          headers: { "Content-Type": "video/mp4", "Content-Length": "8" },
        });
      }
      throw new Error(`Unexpected URL: ${s}`);
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
    const bg = backgroundMod.createBackgroundController({
      chrome: env.chrome,
      storage: storage.createExtensionStorage(),
      fetchImpl: mockFetch,
    });
    await bg.init();
    try {
      const rpc = await env.chrome.runtime.sendMessage({
        type: "ENQUEUE_DOWNLOADS",
        items: [
          {
            title: "防死循环与手动重试测试",
            platform: "bilibili",
            spec: {
              kind: "direct_file",
              apiOrigin: "https://snap.dokitool.com",
              routes: [staleDurl],
              filename: "DokiTool/retry-test.mp4",
              mimeType: "video/mp4",
              refreshContext: {
                parseUrl: "https://www.bilibili.com/video/BV1Refresh01",
                platform: "bilibili",
                itemId: "BV1Refresh01-p1",
                variantId: "durl-64",
              },
            },
          },
        ],
      });
      assert.equal(rpc.ok, true);
      const taskId = rpc.data.taskIds[0];
      await bg.waitForIdle();
      await offscreenCtrl?.executor.waitForIdle();

      assert.equal(
        parseCalls,
        1,
        "auto-refresh MUST stop strictly after 1 attempt (never infinite loop)",
      );
      const afterFail = (await bg.getSnapshot()).tasks.find((t) => t.taskId === taskId);
      assert.equal(afterFail.status, "failed");
      assert.equal(afterFail.autoRefreshCount, 1);
      assert.equal(afterFail.lastErrorCode, "MEDIA_URL_EXPIRED");
      assert.equal(afterFail.lastErrorHttpStatus, 403);

      // Now click manual RETRY_TASK -> must re-parse fresh URL (parseCalls -> 2) and succeed!
      const retryRpc = await env.chrome.runtime.sendMessage({
        type: "RETRY_TASK",
        taskId,
      });
      assert.equal(retryRpc.ok, true);
      await bg.waitForIdle();
      await offscreenCtrl?.executor.waitForIdle();

      assert.equal(parseCalls, 2, "manual RETRY_TASK after 403 must refresh URLs via re-parse");
      const afterRetry = (await bg.getSnapshot()).tasks.find((t) => t.taskId === taskId);
      assert.equal(afterRetry.status, "completed");
      assert.equal(afterRetry.filename, "DokiTool/retry-test.mp4");
      assert.equal(opfs.files.size, 0);
    } finally {
      offscreenCtrl?.dispose();
      bg.dispose();
    }
  }

  // 4) Multi-P episode with refreshContext.resolveUrl failing with HTTP 410 re-resolves via /api/resolve
  {
    const resolvePath =
      "/api/resolve?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1Refresh01%2F%3Fp%3D2&item=BV1Refresh01-p2";
    const goneUrl = "https://upos-sz-mirrorcos.bilivideo.com/p2-gone.mp4";
    const freshP2Url = "https://upos-sz-mirrorcos.bilivideo.com/p2-fresh.mp4";
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    let resolveCalls = 0;
    let parseCalls = 0;

    const mockFetch = async (url) => {
      const s = String(url);
      if (s.includes("/api/parse")) {
        parseCalls += 1;
        throw new Error("multi-P refreshContext with resolveUrl must call /api/resolve, not /api/parse");
      }
      if (s.includes("/api/resolve")) {
        resolveCalls += 1;
        return new Response(
          JSON.stringify(
            makeBiliMediaPayload({
              videoUrl: "https://upos-sz-mirrorcos.bilivideo.com/p2-v.m4s",
              audioUrl: "https://upos-sz-mirrorcos.bilivideo.com/p2-a.m4s",
              durlUrl: freshP2Url,
              itemId: "BV1Refresh01-p2",
              parseUrl: "https://www.bilibili.com/video/BV1Refresh01/?p=2",
              resolveUrl: resolvePath,
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (s === goneUrl) {
        return new Response("Gone", { status: 410 });
      }
      if (s === freshP2Url) {
        return new Response(new Uint8Array([9, 8, 7, 6]), {
          status: 200,
          headers: { "Content-Type": "video/mp4", "Content-Length": "4" },
        });
      }
      throw new Error(`Unexpected URL: ${s}`);
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
    const bg = backgroundMod.createBackgroundController({
      chrome: env.chrome,
      storage: storage.createExtensionStorage(),
      fetchImpl: mockFetch,
    });
    await bg.init();
    try {
      const rpc = await env.chrome.runtime.sendMessage({
        type: "ENQUEUE_DOWNLOADS",
        items: [
          {
            title: "多P分集 410 自动刷新",
            platform: "bilibili",
            spec: {
              kind: "direct_file",
              apiOrigin: "https://snap.dokitool.com",
              routes: [goneUrl],
              filename: "DokiTool/002_第二集.mp4",
              mimeType: "video/mp4",
              refreshContext: {
                parseUrl: "https://www.bilibili.com/video/BV1Refresh01",
                platform: "bilibili",
                itemId: "BV1Refresh01-p2",
                variantId: "durl-64",
                resolveUrl: resolvePath,
              },
            },
          },
        ],
      });
      assert.equal(rpc.ok, true);
      await bg.waitForIdle();
      await offscreenCtrl?.executor.waitForIdle();

      assert.equal(parseCalls, 0);
      assert.equal(resolveCalls, 1);
      const snap = await bg.getSnapshot();
      assert.equal(snap.tasks[0].status, "completed");
      assert.equal(snap.tasks[0].filename, "DokiTool/002_第二集.mp4");
      assert.equal(opfs.files.size, 0);
    } finally {
      offscreenCtrl?.dispose();
      bg.dispose();
    }
  }

  // 5) Mixed-route failure [HTTP 500, HTTP 403] must NOT be classified as MEDIA_URL_EXPIRED
  //    and must NOT falsely trigger automatic or manual /api/parse refresh
  {
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    let parseCalls = 0;
    const route500 = "https://upos-sz-mirrorcos.bilivideo.com/mixed-route-500.mp4";
    const route403 = "https://upos-sz-mirrorhw.bilivideo.com/mixed-route-403.mp4";

    const mockFetch = async (url) => {
      const s = String(url);
      if (s.includes("/api/parse")) {
        parseCalls += 1;
        throw new Error("mixed [500, 403] failure must never call /api/parse");
      }
      if (s === route500) {
        return new Response("Internal Error", { status: 500 });
      }
      if (s === route403) {
        return new Response("Forbidden", { status: 403 });
      }
      throw new Error(`Unexpected URL: ${s}`);
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
    const bg = backgroundMod.createBackgroundController({
      chrome: env.chrome,
      storage: storage.createExtensionStorage(),
      fetchImpl: mockFetch,
    });
    await bg.init();
    try {
      const rpc = await env.chrome.runtime.sendMessage({
        type: "ENQUEUE_DOWNLOADS",
        items: [
          {
            title: "混合错误路由不误触发重解析",
            platform: "bilibili",
            spec: {
              kind: "direct_file",
              apiOrigin: "https://snap.dokitool.com",
              routes: [route500, route403],
              filename: "DokiTool/mixed-err.mp4",
              mimeType: "video/mp4",
              refreshContext: {
                parseUrl: "https://www.bilibili.com/video/BV1Refresh01",
                platform: "bilibili",
                itemId: "BV1Refresh01-p1",
                variantId: "durl-64",
              },
            },
          },
        ],
      });
      assert.equal(rpc.ok, true);
      const taskId = rpc.data.taskIds[0];
      await bg.waitForIdle();
      await offscreenCtrl?.executor.waitForIdle();

      const snap1 = await bg.getSnapshot();
      assert.equal(parseCalls, 0, "mixed [500, 403] must not trigger auto-refresh");
      assert.equal(snap1.tasks[0].status, "failed");
      assert.notEqual(snap1.tasks[0].lastErrorCode, "MEDIA_URL_EXPIRED");

      // Manual RETRY_TASK must also NOT spuriously trigger /api/parse when not expired
      const retryRpc = await env.chrome.runtime.sendMessage({
        type: "RETRY_TASK",
        taskId,
      });
      assert.equal(retryRpc.ok, true);
      await bg.waitForIdle();
      await offscreenCtrl?.executor.waitForIdle();
      assert.equal(parseCalls, 0, "manual retry of mixed [500, 403] must not falsely re-parse");
      assert.equal(opfs.files.size, 0);
    } finally {
      offscreenCtrl?.dispose();
      bg.dispose();
    }
  }

  // 6) Expired live_photo (delivery.kind === "pair") cover image preserves resourceRole="image"
  //    on refresh and downloads fresh .jpg bytes rather than motion .mp4 bytes into .jpg filename
  {
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const fetchedUrls = [];
    const savedBlobs = new Map();
    let parseCalls = 0;

    const staleCoverUrl = "https://sns-webpic-qc.xhscdn.com/stale-cover.jpg";
    const freshCoverUrl = "https://sns-webpic-qc.xhscdn.com/fresh-cover.jpg";
    const freshMotionUrl = "https://sns-video-bd.xhscdn.com/fresh-motion.mp4";
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

    const liveMediaPayload = {
      schema_version: "1.0",
      code: "OK",
      data: {
        platform: "xiaohongshu",
        content_id: "66778899aabbccddeeff0011",
        title: "实况刷新测试",
        source_url: "https://www.xiaohongshu.com/explore/66778899aabbccddeeff0011",
        generated_at: "2026-11-22T00:00:00Z",
        default_item_id: "live-1",
        items: [
          {
            id: "live-1",
            type: "live_photo",
            index: 1,
            title: "实况1",
            default: null,
            default_unavailable_reason: "processing_required",
            variants: [
              {
                id: "live-pair-1",
                delivery: {
                  kind: "pair",
                  resources: [
                    {
                      id: "motion",
                      role: "motion",
                      metadata: { container: "mp4", extension: "mp4", mime_type: "video/mp4" },
                      delivery: {
                        kind: "file",
                        sources: [
                          {
                            id: "m1",
                            url: freshMotionUrl,
                            expires_at: "2099-01-01T00:00:00Z",
                          },
                        ],
                      },
                    },
                    {
                      id: "cover",
                      role: "image",
                      metadata: { container: "jpg", extension: "jpg", mime_type: "image/jpeg" },
                      delivery: {
                        kind: "file",
                        sources: [
                          {
                            id: "i1",
                            url: freshCoverUrl,
                            expires_at: "2099-01-01T00:00:00Z",
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    };

    // Confirm buildEnqueueItemsForMedia tags both live_photo leaves with distinct resourceRole
    const builtPairItems = extensionDownloadMod.buildEnqueueItemsForMedia(
      liveMediaPayload.data,
      {
        apiOrigin: "https://snap.dokitool.com",
        livePhotoMode: "both",
        subfolderPrefix: "DokiTool",
      },
    );
    assert.equal(builtPairItems.length, 2);
    assert.equal(builtPairItems[0].spec.refreshContext?.resourceRole, "motion");
    assert.equal(builtPairItems[1].spec.refreshContext?.resourceRole, "image");

    const mockFetch = async (url) => {
      const s = String(url);
      fetchedUrls.push(s);
      if (s.includes("/api/parse")) {
        parseCalls += 1;
        return new Response(JSON.stringify(liveMediaPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (s === freshCoverUrl) {
        return new Response(jpegBytes, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Content-Length": String(jpegBytes.byteLength) },
        });
      }
      throw new Error(`Unexpected URL in live_photo refresh test: ${s}`);
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
    const origDownload = env.chrome.downloads.download;
    env.chrome.downloads.download = async (opts) => {
      const blob = urlApi.activeBlobs.get(opts.url);
      if (blob) {
        savedBlobs.set(opts.filename, new Uint8Array(await blob.arrayBuffer()));
      }
      return origDownload(opts);
    };

    const bg = backgroundMod.createBackgroundController({
      chrome: env.chrome,
      storage: storage.createExtensionStorage(),
      fetchImpl: mockFetch,
    });
    await bg.init();
    try {
      const rpc = await env.chrome.runtime.sendMessage({
        type: "ENQUEUE_DOWNLOADS",
        items: [
          {
            title: "实况封面图",
            platform: "xiaohongshu",
            spec: {
              kind: "direct_file",
              apiOrigin: "https://snap.dokitool.com",
              routes: [staleCoverUrl],
              filename: "DokiTool/001_cover.jpg",
              mimeType: "image/jpeg",
              refreshContext: {
                parseUrl: "https://www.xiaohongshu.com/explore/66778899aabbccddeeff0011",
                platform: "xiaohongshu",
                itemId: "live-1",
                variantId: "live-pair-1",
                resourceRole: "image",
                expiresAtMs: Date.now() - 60_000,
              },
            },
          },
        ],
      });
      assert.equal(rpc.ok, true);
      await bg.waitForIdle();
      await offscreenCtrl?.executor.waitForIdle();

      const snap = await bg.getSnapshot();
      assert.equal(parseCalls, 1);
      assert.equal(
        fetchedUrls.includes(freshCoverUrl),
        true,
        `must download fresh cover image URL; task=${JSON.stringify(snap.tasks[0])}`,
      );
      assert.equal(fetchedUrls.includes(freshMotionUrl), false, "must NEVER download motion video into .jpg cover");
      assert.equal(fetchedUrls.includes(staleCoverUrl), false, "pre-start expiry must skip stale URL");
      assert.deepEqual(savedBlobs.get("DokiTool/001_cover.jpg"), jpegBytes);
      assert.equal(opfs.files.size, 0);
    } finally {
      offscreenCtrl?.dispose();
      bg.dispose();
    }
  }
});
