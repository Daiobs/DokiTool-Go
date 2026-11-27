import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as mediabunny from "mediabunny";
import * as vue from "vue";
import { loadSfc } from "./loadSfc.mjs";

const { createRenderer, h, markRaw, nextTick, ref } = vue;

const __helpersDir = dirname(fileURLToPath(import.meta.url));
export const TESTS_DIR = resolve(__helpersDir, "..");
export const FRONTEND_DIR = resolve(TESTS_DIR, "..");
export const REPO_ROOT_DIR = resolve(FRONTEND_DIR, "..");

let protocol;
let storage;
let cachedModules = null;

export async function loadExtensionFlowModules() {
  if (cachedModules) return cachedModules;
  globalThis.__DOKITOOL_EXT_TEST__ = true;
  const [
    _protocol,
    _storage,
    youtubeBridgeMod,
    dashMuxSpecMod,
    opfsStreamTransferMod,
    dashMuxDownloadMod,
    dashMuxEngineMod,
    extensionDownloadMod,
    uiTargetHelpersMod,
    targetSpecBuilderMod,
    specRefresherMod,
    offscreenMod,
    backgroundMod,
    mediaContractMod,
  ] = await Promise.all([
    import("../../src/extension/protocol.ts"),
    import("../../src/extension/storage.ts"),
    import("../../src/extension/youtubeExtensionBridge.ts"),
    import("../../src/extension/dashMuxSpec.ts"),
    import("../../src/extension/opfsStreamTransfer.ts"),
    import("../../src/extension/dashMuxDownload.ts"),
    import("../../src/extension/dashMuxEngine.ts"),
    import("../../src/extension/extensionDownload.ts"),
    import("../../src/extension/uiTargetHelpers.ts"),
    import("../../src/extension/targetSpecBuilder.ts"),
    import("../../src/extension/bg/specRefresher.ts"),
    import("../../src/extension/offscreen.ts"),
    import("../../src/extension/background.ts"),
    import("../../src/utils/mediaContract.ts"),
  ]);
  protocol = _protocol;
  storage = _storage;
  cachedModules = {
    protocol,
    storage,
    youtubeBridgeMod,
    dashMuxSpecMod,
    opfsStreamTransferMod,
    dashMuxDownloadMod,
    dashMuxEngineMod,
    extensionDownloadMod,
    uiTargetHelpersMod,
    targetSpecBuilderMod,
    specRefresherMod,
    offscreenMod,
    backgroundMod,
    mediaContractMod,
  };
  return cachedModules;
}

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
          let logicalSize = 0;
          let closed = false;
          const applyTruncate = (size) => {
            const target = Number(size) || 0;
            for (let i = chunks.length - 1; i >= 0; i--) {
              const c = chunks[i];
              if (c.pos >= target) {
                chunks.splice(i, 1);
              } else if (c.pos + c.bytes.byteLength > target) {
                chunks[i] = { pos: c.pos, bytes: c.bytes.slice(0, target - c.pos) };
              }
            }
            logicalSize = target;
            if (cursor > target) cursor = target;
          };
          return {
            async write(chunk) {
              if (closed) throw new Error("Writable already closed");
              if (chunk && typeof chunk === "object" && chunk.type === "truncate") {
                applyTruncate(chunk.size);
                return;
              }
              if (chunk && typeof chunk === "object" && chunk.type === "write") {
                if (typeof chunk.position === "number") cursor = chunk.position;
                const bytes =
                  chunk.data instanceof Uint8Array
                    ? chunk.data
                    : new Uint8Array(chunk.data);
                chunks.push({ pos: cursor, bytes: bytes.slice() });
                cursor += bytes.byteLength;
                if (cursor > logicalSize) logicalSize = cursor;
                return;
              }
              const bytes =
                chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
              chunks.push({ pos: cursor, bytes: bytes.slice() });
              cursor += bytes.byteLength;
              if (cursor > logicalSize) logicalSize = cursor;
            },
            async truncate(size) {
              if (closed) throw new Error("Writable already closed");
              applyTruncate(size);
            },
            async seek(pos) {
              cursor = Number(pos) || 0;
            },
            async close() {
              if (closed) return;
              closed = true;
              activeWriteLocks.delete(name);
              const out = new Uint8Array(logicalSize);
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
// Lightweight Vue SFC Tree Renderer for SidePanel Component Regression Tests
// ============================================================================

const PassthroughTransition = {
  inheritAttrs: false,
  setup: (_props, { slots }) => () => slots.default?.(),
};

async function loadSidePanelSfc(relPathFromTests) {
  return loadSfc(new URL(relPathFromTests, new URL("../", import.meta.url)), {
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


// ============================================================================
// [PR-A Item 4] Multi-Range Chunked Concurrent OPFS Transfer Tests
// ============================================================================

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeDeterministicPayload(byteLength, seed = 17) {
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    out[i] = ((i * 131 + (i >> 8) * 17 + seed) & 0xff);
  }
  return out;
}

function parseTestRangeHeader(raw) {
  if (typeof raw !== "string") return null;
  const m = /^bytes=(\d+)-(\d*)$/i.exec(raw.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === "" ? null : Number(m[2]);
  return { start, end };
}

function padMp4WithFreeBox(baseBytes, minTotalBytes) {
  if (baseBytes.byteLength >= minTotalBytes) return baseBytes;
  const padSize = Math.max(8, minTotalBytes - baseBytes.byteLength);
  const out = new Uint8Array(baseBytes.byteLength + padSize);
  out.set(baseBytes, 0);
  const view = new DataView(out.buffer, baseBytes.byteLength, 8);
  view.setUint32(0, padSize, false);
  out[baseBytes.byteLength + 4] = 0x66; // 'f'
  out[baseBytes.byteLength + 5] = 0x72; // 'r'
  out[baseBytes.byteLength + 6] = 0x65; // 'e'
  out[baseBytes.byteLength + 7] = 0x65; // 'e'
  return out;
}

function makeTestOpfsSink(opfs) {
  let seq = 0;
  return async (taskId, _mimeType, tag) => {
    const dir = await opfs.storage.getDirectory();
    const name = `${protocol.EXTENSION_OPFS_TEMP_PREFIX}${tag ? `${tag}-` : ""}${taskId}-${++seq}.tmp`;
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    let closed = false;
    let cleaned = false;
    let queue = Promise.resolve();
    const enqueue = (fn) => {
      const task = queue.then(() => {
        if (closed || cleaned) throw new Error("closed");
        return fn();
      });
      queue = task.catch(() => {});
      return task;
    };
    return {
      tempName: name,
      rawWritable: writable,
      write(chunk) {
        return enqueue(() => writable.write(chunk));
      },
      writeAt(position, chunk) {
        return enqueue(() => writable.write({ type: "write", position, data: chunk }));
      },
      async closeAndGetBlob() {
        await queue;
        if (!closed) {
          closed = true;
          await writable.close();
        }
        return handle.getFile();
      },
      async cleanup() {
        cleaned = true;
        await queue.catch(() => {});
        if (!closed) {
          closed = true;
          await writable.abort?.().catch(() => {});
        }
        await dir.removeEntry(name).catch(() => {});
      },
    };
  };
}


function createOwnerStatsFixture() {
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
  const emptySlot = {
    acquired_count: 20,
    wait_count: 1,
    canceled_count: 0,
    wait_ms_total: 120,
    wait_ms_max: 60,
    wait_ms: emptyHist,
  };
  const emptyShanghai = {
    hits: 24,
    fallbacks: 2,
    canceled: 0,
    queue_waits: 1,
    queue_granted: 1,
    queue_timeouts: 0,
    queue_wait_ms_total: 40,
    queue_wait_ms_max: 40,
  };
  return {
    started_at: "2026-11-20T08:00:00Z",
    generated_at: "2026-11-22T15:30:00Z",
    uptime_seconds: 199_800,
    requests: {
      total: 220,
      by_channel: { anonymous: 80, owner: 140 },
      by_platform_code_channel: [
        { platform: "douyin", code: "OK", channel: "owner", count: 140 },
      ],
    },
    cache: {
      enabled: true,
      entries: 64,
      bytes: 2_621_440,
      max_entries: 1000,
      max_bytes: 67_108_864,
      total: { hits: 90, misses: 30, singleflight_shared: 5, uncacheable: 2 },
      by_channel: {
        anonymous: { hits: 30, misses: 15, singleflight_shared: 2, uncacheable: 1 },
        owner: { hits: 60, misses: 15, singleflight_shared: 3, uncacheable: 1 },
      },
    },
    admission: {
      fast: {
        active: 1,
        queued: 0,
        concurrency_limit: 8,
        queue_limit: 32,
        waited: 0,
        granted: 100,
        timeout: 0,
        full: 0,
        canceled: 0,
        wait_ms_total: 0,
        wait_ms_max: 0,
      },
      slow: {
        active: 0,
        queued: 0,
        concurrency_limit: 4,
        queue_limit: 16,
        waited: 0,
        granted: 20,
        timeout: 0,
        full: 0,
        canceled: 0,
        wait_ms_total: 0,
        wait_ms_max: 0,
      },
      owner: {
        active: 1,
        queued: 0,
        concurrency_limit: 6,
        queue_limit: 24,
        waited: 0,
        granted: 80,
        timeout: 0,
        full: 0,
        canceled: 0,
        wait_ms_total: 0,
        wait_ms_max: 0,
      },
    },
    api_keys: [],
    ytdlp: {
      enabled: true,
      concurrency_limit: 3,
      active: 1,
      waiting: 0,
      total: emptySlot,
      by_channel: { anonymous: emptySlot, owner: emptySlot },
    },
    shanghai: {
      enabled: true,
      mode: "pull",
      waiting_workers: 2,
      queued_tasks: 0,
      pending_tasks: 0,
      total: emptyShanghai,
      by_channel: { anonymous: emptyShanghai, owner: emptyShanghai },
      by_platform: { douyin: emptyShanghai, bilibili: emptyShanghai },
    },
    parse_latency_ms: {
      total: emptyHist,
      by_channel: { anonymous: emptyHist, owner: emptyHist },
    },
    runtime: {
      version: "v4.1.0-r2",
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
    daily: [
      {
        date: "2026-11-21",
        total: 100,
        ok: 90,
        failed: 10,
        cache_hits: 20,
        shanghai_hits: 10,
        latency_ms: { p50_ms: 150, p95_ms: 800, max_ms: 2000 },
        by_platform: {},
      },
      {
        date: "2026-11-22",
        total: 120,
        ok: 114,
        failed: 6,
        cache_hits: 38,
        shanghai_hits: 24,
        latency_ms: { p50_ms: 140, p95_ms: 820, max_ms: 3100 },
        by_platform: {},
      },
    ],
    hourly: [
      {
        hour_start: "2026-11-22T15:00:00+08:00",
        total: 20,
        ok: 19,
        failed: 1,
        cache_hits: 8,
      },
    ],
  };
}


export {
  createMockWebLocks,
  createMockOpfs,
  createTrackedUrlApi,
  createMockMv3Environment,
  createSyntheticMp4MuxStreams,
  PassthroughTransition,
  loadSidePanelSfc,
  mountSfcTree,
  createSyntheticDashTrackBuffers,
  buildSampleBilibiliDashMedia,
  sha256Hex,
  makeDeterministicPayload,
  parseTestRangeHeader,
  padMp4WithFreeBox,
  makeTestOpfsSink,
  createOwnerStatsFixture,
};
