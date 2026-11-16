import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createServer } from "vite";
import { ref, computed, markRaw } from "vue";
import JSZip from "jszip";

let vite, segmentDownload, mediaContract, mediaDelivery, downloads, selectionModule;
let clicked, blobs, fetched;

const originals = {
  fetch: globalThis.fetch,
  document: globalThis.document,
  window: globalThis.window,
  location: globalThis.location,
  cryptoDescriptor: Object.getOwnPropertyDescriptor(globalThis, "crypto"),
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  segmentDownload = await vite.ssrLoadModule("/src/utils/segmentDownload.ts");
  mediaContract = await vite.ssrLoadModule("/src/utils/mediaContract.ts");
  mediaDelivery = await vite.ssrLoadModule("/src/utils/mediaDelivery.ts");
  downloads = await vite.ssrLoadModule("/src/composables/useMediaDownload.ts");
  selectionModule = await vite.ssrLoadModule("/src/composables/useVideoSelection.ts");

  globalThis.window = {
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.location = {
    href: "https://snap.dokitool.com/",
    origin: "https://snap.dokitool.com",
  };
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  globalThis.document = {
    body: { appendChild() {}, style: {} },
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      return {
        tag,
        setAttribute(name, value) {
          this[name] = value;
        },
        addEventListener() {},
        removeEventListener() {},
        click() {
          clicked.push({ href: this.href, filename: this.download });
        },
        remove() {},
      };
    },
  };
  URL.createObjectURL = (blob) => {
    blobs.push(blob);
    return `blob:archive-fallback-${blobs.length}`;
  };
  URL.revokeObjectURL = () => {};
});

beforeEach(() => {
  clicked = [];
  blobs = [];
  fetched = [];
  globalThis.fetch = async () => {
    throw new Error("unexpected fetch in test");
  };
});

after(async () => {
  Object.assign(globalThis, {
    fetch: originals.fetch,
    document: originals.document,
    window: originals.window,
    location: originals.location,
  });
  if (originals.cryptoDescriptor) {
    Object.defineProperty(globalThis, "crypto", originals.cryptoDescriptor);
  } else {
    delete globalThis.crypto;
  }
  URL.createObjectURL = originals.createObjectURL;
  URL.revokeObjectURL = originals.revokeObjectURL;
  await vite?.close();
});

function createHarness(initialData, resolver) {
  const result = ref(structuredClone(initialData));
  const toasts = [];
  const store = {
    get resultData() {
      return result.value;
    },
    set resultData(value) {
      result.value = value;
      selection.syncResult();
    },
    resultVersion: 1,
    downloads: [],
    addDownload(input) {
      const id = this.downloads.length + 1;
      this.downloads.push({ id, ...input });
      return id;
    },
    updateDownload(id, changes) {
      const row = this.downloads.find((item) => item.id === id);
      if (row) Object.assign(row, changes);
    },
    replaceItem(item) {
      result.value = {
        ...result.value,
        items: result.value.items.map((old) => (old.id === item.id ? item : old)),
      };
    },
    cancelDownload(id) {
      const task = this.downloads.find((item) => item.id === id);
      if (task) {
        task.abortController?.abort();
        task.status = "cancelled";
      }
    },
    removeDownload(id) {
      this.downloads = this.downloads.filter((item) => item.id !== id);
    },
  };
  const selection = markRaw(
    selectionModule.useVideoSelection({ videoStore: store }),
  );
  selection.syncResult();
  const resolveItem = async (item, signal) => {
    const resolved = await resolver?.(item, signal);
    if (!resolved) throw new Error("解析失败");
    return resolved;
  };
  const instance = downloads.useMediaDownload({
    videoStore: store,
    selection,
    resolveItem,
    showToast: (...args) => toasts.push(args),
  });
  return {
    store,
    selection,
    instance,
    toasts,
    currentVideoUrl: computed(() => selection.currentVideoUrl.value),
  };
}

function makeFileItem({
  id = "part-1",
  type = "video",
  index = 1,
  title = "测试分P",
  extension = "mp4",
  mimeType = "video/mp4",
  sources,
  defaultSourceIndex = 0,
}) {
  const chosen = sources[defaultSourceIndex];
  return {
    id,
    type,
    index,
    title,
    variants: [
      {
        id: "v0",
        metadata: { extension, mime_type: mimeType },
        delivery: {
          kind: "file",
          sources,
        },
      },
    ],
    default: {
      variant_id: "v0",
      ...(chosen.id ? { source_id: chosen.id } : {}),
      url: chosen.url,
      ...(chosen.access ? { access: chosen.access } : {}),
      ...(chosen.expires_at ? { expires_at: chosen.expires_at } : {}),
    },
  };
}

test("a) multi-P video archive falls back sequentially when sources[0] rejects with TypeError('Failed to fetch') and packs valid .mp4 entries", async () => {
  const deadUrl = "https://cn-bj-cc-03-02.bilivideo.com/upgcxcode/11/22/p1.m4s?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M=";
  const mirrorUrl = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/11/22/p1.m4s?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M=";
  const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

  const item = makeFileItem({
    id: "bili-p1",
    sources: [
      { id: "sh-0", url: deadUrl, size_bytes: mp4Bytes.byteLength, browser_fetch: "allowed" },
      { id: "mirror-1", url: mirrorUrl, size_bytes: mp4Bytes.byteLength, browser_fetch: "allowed" },
    ],
  });
  const target = mediaContract.getDownloadTarget(item, null, {});
  assert.equal(target.kind, "file");

  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url) === deadUrl) {
      throw new TypeError("Failed to fetch");
    }
    if (String(url) === mirrorUrl) {
      return new Response(mp4Bytes, {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": String(mp4Bytes.byteLength),
        },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await segmentDownload.collectArchiveTargetEntries({
    itemId: item.id,
    target,
    base: "001_测试分P_P1",
    apiContext: {},
    signal: new AbortController().signal,
    maxArchiveBytes: 500 * 1024 * 1024,
    currentBytes: 0,
  });

  assert.deepEqual(fetched, [deadUrl, mirrorUrl]);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].filename, "001_测试分P_P1.mp4");
  assert.equal(result.totalBytes, mp4Bytes.byteLength);
  const actualBytes = new Uint8Array(await result.entries[0].data.arrayBuffer());
  assert.deepEqual(actualBytes, mp4Bytes);

  // Also verify full 2-P downloadVideosAsZip (P1 ready + P2 deferred resolve) via useMediaDownload
  fetched = [];
  blobs = [];
  const p2Dead = "https://cn-bj-cc-03-02.bilivideo.com/upgcxcode/11/22/p2.m4s";
  const p2Mirror = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/11/22/p2.m4s";
  const p2Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70]);
  const multiPartData = {
    platform: "bilibili",
    title: "B站多P合集",
    default_item_id: "bili-p1",
    items: [
      item,
      {
        id: "bili-p2",
        type: "video",
        index: 2,
        title: "第二集",
        state: "deferred",
        default: null,
        default_unavailable_reason: "needs_resolve",
        resolve_url: "/api/resolve?item_id=bili-p2",
      },
    ],
  };
  const h = createHarness(multiPartData, async (reqItem) => {
    assert.equal(reqItem.id, "bili-p2");
    return makeFileItem({
      id: "bili-p2",
      index: 2,
      title: "第二集",
      sources: [
        { id: "sh-0", url: p2Dead, size_bytes: p2Bytes.byteLength },
        { id: "mirror-1", url: p2Mirror, size_bytes: p2Bytes.byteLength },
      ],
    });
  });

  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url) === deadUrl || String(url) === p2Dead) {
      throw new TypeError("Failed to fetch");
    }
    const payload = String(url) === mirrorUrl ? mp4Bytes : p2Bytes;
    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(payload.byteLength),
      },
    });
  };

  await h.instance.downloadVideosAsZip(h.store.resultData.items);
  assert.equal(h.store.downloads[0].status, "completed", h.store.downloads[0].error || "");
  assert.deepEqual(fetched, [deadUrl, mirrorUrl, p2Dead, p2Mirror]);
  assert.equal(blobs.length, 1);
  const zip = await JSZip.loadAsync(await blobs[0].arrayBuffer());
  const names = Object.keys(zip.files).sort();
  assert.equal(names.length, 2);
  assert.ok(names.every((n) => n.endsWith(".mp4")));
  assert.deepEqual(await zip.files[names[0]].async("uint8array"), mp4Bytes);
  assert.deepEqual(await zip.files[names[1]].async("uint8array"), p2Bytes);
});

test("b) HTTP status & fallback_urls fallback tries [sources[0].url, sources[0].fallback_urls[0], sources[1].url] in exact order", async () => {
  const url0 = "https://cdn-primary.example.test/video.mp4?token=1";
  const url0Fallback = "https://cdn-primary.example.test/video.mp4?token=2";
  const url1 = "https://cdn-backup.example.test/video.mp4?token=3";
  const body = new Uint8Array([10, 20, 30, 40, 50]);

  const item = makeFileItem({
    sources: [
      {
        id: "s0",
        url: url0,
        fallback_urls: [url0Fallback],
        size_bytes: body.byteLength,
      },
      {
        id: "s1",
        url: url1,
        size_bytes: body.byteLength,
      },
    ],
  });
  const target = mediaContract.getDownloadTarget(item, null, {});
  assert.equal(target.kind, "file");

  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url) === url0) {
      return new Response("Service Unavailable", { status: 503 });
    }
    if (String(url) === url0Fallback) {
      return new Response("Forbidden", { status: 403 });
    }
    if (String(url) === url1) {
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": String(body.byteLength),
        },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const collected = await segmentDownload.collectArchiveTargetEntries({
    itemId: item.id,
    target,
    base: "001_clip",
    apiContext: {},
    signal: new AbortController().signal,
    maxArchiveBytes: 500 * 1024 * 1024,
    currentBytes: 0,
  });

  assert.deepEqual(fetched, [url0, url0Fallback, url1]);
  assert.equal(collected.entries.length, 1);
  assert.deepEqual(
    new Uint8Array(await collected.entries[0].data.arrayBuffer()),
    body,
  );
});

test("c) per-source size_bytes: sources[1] validates against its own size_bytes (1024 or undefined), never sources[0]'s stale 1000", async () => {
  const url0 = "https://cdn-a.example.test/media.mp4";
  const url1 = "https://cdn-b.example.test/media.mp4";
  const url2 = "https://cdn-c.example.test/media.mp4";
  const payload1024 = new Uint8Array(1024).fill(0x42);

  // Subcase 1: sources[0] size_bytes=1000 (fails), sources[1] size_bytes=1024 (succeeds with 1024 bytes)
  {
    fetched = [];
    const item = makeFileItem({
      sources: [
        { id: "s0", url: url0, size_bytes: 1000 },
        { id: "s1", url: url1, size_bytes: 1024 },
      ],
    });
    const target = mediaContract.getDownloadTarget(item, null, {});
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      if (String(url) === url0) throw new TypeError("Failed to fetch");
      return new Response(payload1024, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "1024" },
      });
    };
    const res = await segmentDownload.collectArchiveTargetEntries({
      itemId: item.id,
      target,
      base: "001_exact1024",
      apiContext: {},
      signal: new AbortController().signal,
      maxArchiveBytes: 500 * 1024 * 1024,
      currentBytes: 0,
    });
    assert.deepEqual(fetched, [url0, url1]);
    assert.equal(res.totalBytes, 1024);
  }

  // Subcase 2: sources[0] size_bytes=1000 (fails), sources[1] size_bytes=undefined (succeeds with 1024 bytes)
  {
    fetched = [];
    const item = makeFileItem({
      sources: [
        { id: "s0", url: url0, size_bytes: 1000 },
        { id: "s1", url: url1 },
      ],
    });
    const target = mediaContract.getDownloadTarget(item, null, {});
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      if (String(url) === url0) return new Response("Bad Gateway", { status: 502 });
      return new Response(payload1024, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    };
    const res = await segmentDownload.collectArchiveTargetEntries({
      itemId: item.id,
      target,
      base: "001_unknownSize",
      apiContext: {},
      signal: new AbortController().signal,
      maxArchiveBytes: 500 * 1024 * 1024,
      currentBytes: 0,
    });
    assert.deepEqual(fetched, [url0, url1]);
    assert.equal(res.totalBytes, 1024);
  }

  // Subcase 3: sources[1] has size_bytes=1024 and returns truncated 1000 bytes -> rejected and falls back to sources[2]
  {
    fetched = [];
    const item = makeFileItem({
      sources: [
        { id: "s0", url: url0, size_bytes: 1000 },
        { id: "s1", url: url1, size_bytes: 1024 },
        { id: "s2", url: url2, size_bytes: 1024 },
      ],
    });
    const target = mediaContract.getDownloadTarget(item, null, {});
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      if (String(url) === url0) throw new TypeError("Failed to fetch");
      if (String(url) === url1) {
        return new Response(new Uint8Array(1000), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      return new Response(payload1024, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "1024" },
      });
    };
    const res = await segmentDownload.collectArchiveTargetEntries({
      itemId: item.id,
      target,
      base: "001_truncated1",
      apiContext: {},
      signal: new AbortController().signal,
      maxArchiveBytes: 500 * 1024 * 1024,
      currentBytes: 0,
    });
    assert.deepEqual(fetched, [url0, url1, url2]);
    assert.equal(res.totalBytes, 1024);
  }
});

test("d) image gallery multi-item archive succeeds when item 1 hits sources[0] and item 2 falls back from 403 on sources[0] to sources[1]", async () => {
  const img1Primary = "https://sns-img-bd.xhscdn.com/pic-1.webp";
  const img2Dead = "https://sns-img-bd.xhscdn.com/pic-2.webp";
  const img2Backup = "https://sns-img-hw.xhscdn.com/pic-2.webp";
  const bytes1 = new Uint8Array([1, 2, 3, 4]);
  const bytes2 = new Uint8Array([5, 6, 7, 8, 9]);

  const galleryData = {
    platform: "xiaohongshu",
    title: "图文合集",
    default_item_id: "img-1",
    items: [
      makeFileItem({
        id: "img-1",
        type: "image",
        index: 1,
        title: "图1",
        extension: "webp",
        mimeType: "image/webp",
        sources: [{ id: "s0", url: img1Primary, size_bytes: bytes1.byteLength }],
      }),
      makeFileItem({
        id: "img-2",
        type: "image",
        index: 2,
        title: "图2",
        extension: "webp",
        mimeType: "image/webp",
        sources: [
          { id: "s0", url: img2Dead, size_bytes: bytes2.byteLength },
          { id: "s1", url: img2Backup, size_bytes: bytes2.byteLength },
        ],
      }),
    ],
  };

  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url) === img1Primary) {
      return new Response(bytes1, {
        status: 200,
        headers: { "content-type": "image/webp", "content-length": String(bytes1.byteLength) },
      });
    }
    if (String(url) === img2Dead) {
      return new Response("Forbidden", { status: 403 });
    }
    if (String(url) === img2Backup) {
      return new Response(bytes2, {
        status: 200,
        headers: { "content-type": "image/webp", "content-length": String(bytes2.byteLength) },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const h = createHarness(galleryData);
  await h.instance.downloadAllMedia("images");

  assert.equal(h.store.downloads[0].status, "completed", h.store.downloads[0].error || "");
  assert.deepEqual(fetched, [img1Primary, img2Dead, img2Backup]);
  assert.equal(blobs.length, 1);
  const zip = await JSZip.loadAsync(await blobs[0].arrayBuffer());
  const names = Object.keys(zip.files).sort();
  assert.equal(names.length, 2);
  assert.deepEqual(await zip.files[names[0]].async("uint8array"), bytes1);
  assert.deepEqual(await zip.files[names[1]].async("uint8array"), bytes2);
});

test("e) Live Photo pair archive falls back on motion resource from failed sources[0] to sources[1] and packs both image + motion", async () => {
  const coverUrl = "https://sns-img.xhscdn.com/live-cover.jpg";
  const motionDead = "https://sns-v1.xhscdn.com/live-motion.mp4";
  const motionFallbackCred = "https://sns-v1.xhscdn.com/live-motion.mp4?bak=1";
  const motionMirror = "https://sns-v2.rednotecdn.com/live-motion.mp4";
  const coverBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const motionBytes = new Uint8Array([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70]);

  const liveData = {
    platform: "xiaohongshu",
    title: "实况图集",
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
            id: "pair",
            delivery: {
              kind: "pair",
              resources: [
                {
                  id: "img",
                  role: "image",
                  metadata: { extension: "jpg", mime_type: "image/jpeg" },
                  delivery: {
                    kind: "file",
                    sources: [{ id: "c0", url: coverUrl, size_bytes: coverBytes.byteLength }],
                  },
                },
                {
                  id: "mot",
                  role: "motion",
                  metadata: { extension: "mp4", mime_type: "video/mp4" },
                  delivery: {
                    kind: "file",
                    sources: [
                      {
                        id: "m0",
                        url: motionDead,
                        fallback_urls: [motionFallbackCred],
                        size_bytes: motionBytes.byteLength,
                      },
                      {
                        id: "m1",
                        url: motionMirror,
                        size_bytes: motionBytes.byteLength,
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
  };

  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url) === coverUrl) {
      return new Response(coverBytes, {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": String(coverBytes.byteLength) },
      });
    }
    if (String(url) === motionDead) {
      return new Response("Service Unavailable", { status: 503 });
    }
    if (String(url) === motionFallbackCred) {
      throw new TypeError("Failed to fetch");
    }
    if (String(url) === motionMirror) {
      return new Response(motionBytes, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": String(motionBytes.byteLength) },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const h = createHarness(liveData);
  await h.instance.downloadAllMedia("live");

  assert.equal(h.store.downloads[0].status, "completed", h.store.downloads[0].error || "");
  assert.deepEqual(fetched, [coverUrl, motionDead, motionFallbackCred, motionMirror]);
  assert.equal(blobs.length, 1);
  const zip = await JSZip.loadAsync(await blobs[0].arrayBuffer());
  const names = Object.keys(zip.files).sort();
  assert.equal(names.length, 2);
  assert.ok(names.some((n) => n.endsWith("_image.jpg")));
  assert.ok(names.some((n) => n.endsWith("_motion.mp4")));
  const imageName = names.find((n) => n.endsWith("_image.jpg"));
  const motionName = names.find((n) => n.endsWith("_motion.mp4"));
  assert.deepEqual(await zip.files[imageName].async("uint8array"), coverBytes);
  assert.deepEqual(await zip.files[motionName].async("uint8array"), motionBytes);
});

test("f) aborting signal during sources[0] throws AbortError immediately and makes 0 requests to sources[1]", async () => {
  const url0 = "https://cdn-primary.example.test/abort-me.mp4";
  const url1 = "https://cdn-backup.example.test/never-called.mp4";
  const item = makeFileItem({
    sources: [
      { id: "s0", url: url0, size_bytes: 16 },
      { id: "s1", url: url1, size_bytes: 16 },
    ],
  });
  const target = mediaContract.getDownloadTarget(item, null, {});

  let resolveStarted;
  const started = new Promise((r) => {
    resolveStarted = r;
  });
  const controller = new AbortController();

  globalThis.fetch = async (url, init) => {
    fetched.push(String(url));
    if (String(url) === url0) {
      resolveStarted();
      return new Promise((_, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }
    throw new Error(`sources[1] must never be requested on abort: ${url}`);
  };

  const pending = segmentDownload.collectArchiveTargetEntries({
    itemId: item.id,
    target,
    base: "001_abort",
    apiContext: {},
    signal: controller.signal,
    maxArchiveBytes: 500 * 1024 * 1024,
    currentBytes: 0,
  });

  await started;
  controller.abort();

  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(fetched, [url0]);
});

test("g) exceeding maxArchiveBytes throws ARCHIVE_LIMIT_ERROR immediately and makes 0 requests to sources[1]", async () => {
  const url0 = "https://cdn-primary.example.test/too-large.mp4";
  const url1 = "https://cdn-backup.example.test/never-called.mp4";

  // Subcase 1: streaming body exceeds maxArchiveBytes
  {
    fetched = [];
    let streamCancelled = false;
    const item = makeFileItem({
      sources: [
        { id: "s0", url: url0 },
        { id: "s1", url: url1 },
      ],
    });
    const target = mediaContract.getDownloadTarget(item, null, {});

    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      if (String(url) === url0) {
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(600));
            },
            cancel() {
              streamCancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "video/mp4" } },
        );
      }
      throw new Error(`sources[1] must never be requested on ARCHIVE_LIMIT_ERROR: ${url}`);
    };

    await assert.rejects(
      segmentDownload.collectArchiveTargetEntries({
        itemId: item.id,
        target,
        base: "001_limit_stream",
        apiContext: {},
        signal: new AbortController().signal,
        maxArchiveBytes: 1000,
        currentBytes: 0,
      }),
      (err) => err instanceof Error && err.message === segmentDownload.ARCHIVE_LIMIT_ERROR,
    );
    assert.deepEqual(fetched, [url0]);
    assert.equal(streamCancelled, true);
  }

  // Subcase 2: declared route size_bytes exceeds remaining budget -> 0 requests to sources[0] and 0 requests to sources[1]
  {
    fetched = [];
    const item = makeFileItem({
      sources: [
        { id: "s0", url: url0, size_bytes: 1200 },
        { id: "s1", url: url1, size_bytes: 1200 },
      ],
    });
    const target = mediaContract.getDownloadTarget(item, null, {});

    await assert.rejects(
      segmentDownload.collectArchiveTargetEntries({
        itemId: item.id,
        target,
        base: "001_limit_declared",
        apiContext: {},
        signal: new AbortController().signal,
        maxArchiveBytes: 1000,
        currentBytes: 0,
      }),
      (err) => err instanceof Error && err.message === segmentDownload.ARCHIVE_LIMIT_ERROR,
    );
    assert.deepEqual(fetched, []);
  }
});

test("h) all routes fail: tries all candidate routes in exact order and rejects cleanly when the last route fails", async () => {
  const url0 = "https://cdn-1.example.test/fail.mp4?try=1";
  const url0Fallback = "https://cdn-1.example.test/fail.mp4?try=2";
  const url1 = "https://cdn-2.example.test/fail.mp4";

  const item = makeFileItem({
    sources: [
      { id: "s0", url: url0, fallback_urls: [url0Fallback], size_bytes: 64 },
      { id: "s1", url: url1, size_bytes: 64 },
    ],
  });
  const target = mediaContract.getDownloadTarget(item, null, {});

  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url) === url0) throw new TypeError("Failed to fetch");
    if (String(url) === url0Fallback) return new Response("Bad Gateway", { status: 502 });
    return new Response("Forbidden", { status: 403 });
  };

  await assert.rejects(
    segmentDownload.collectArchiveTargetEntries({
      itemId: item.id,
      target,
      base: "001_all_fail",
      apiContext: {},
      signal: new AbortController().signal,
      maxArchiveBytes: 500 * 1024 * 1024,
      currentBytes: 0,
    }),
    /HTTP 403/,
  );
  assert.deepEqual(fetched, [url0, url0Fallback, url1]);
});

test("expired and unavailable sources are skipped via availableSources without making network requests, and segment chunks fall back across routes", async () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  const expiredUrl = "https://cdn-expired.example.test/video.mp4";
  const unavailableUrl = "https://cdn-down.example.test/video.mp4";
  const activeDeadUrl = "https://cdn-active-1.example.test/video.mp4";
  const activeGoodUrl = "https://cdn-active-2.example.test/video.mp4";
  const bytes = new Uint8Array([7, 8, 9]);

  // File target with expired/unavailable backup routes
  const item = makeFileItem({
    defaultSourceIndex: 2,
    sources: [
      { id: "s-exp", url: expiredUrl, expires_at: "2026-11-15T12:00:00Z", size_bytes: 3 },
      { id: "s-unavail", url: unavailableUrl, availability: "unavailable", size_bytes: 3 },
      { id: "s-dead", url: activeDeadUrl, expires_at: "2026-11-15T13:00:00Z", size_bytes: 3 },
      { id: "s-good", url: activeGoodUrl, expires_at: "2026-11-15T13:00:00Z", size_bytes: 3 },
    ],
  });
  const target = mediaContract.getDownloadTarget(
    item,
    { variant_id: "v0", source_id: "s-dead" },
    { now },
  );
  assert.equal(target.kind, "file");

  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url) === activeDeadUrl) throw new TypeError("Failed to fetch");
    if (String(url) === activeGoodUrl) {
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "3" },
      });
    }
    throw new Error(`expired/unavailable URL must never be fetched: ${url}`);
  };

  const fileRes = await segmentDownload.collectArchiveTargetEntries({
    itemId: item.id,
    target,
    base: "001_filtered",
    apiContext: { now },
    signal: new AbortController().signal,
    maxArchiveBytes: 500 * 1024 * 1024,
    currentBytes: 0,
  });
  assert.deepEqual(fetched, [activeDeadUrl, activeGoodUrl]);
  assert.equal(fileRes.totalBytes, 3);

  // Segments delivery with backup sources on pieces
  fetched = [];
  const segDead = "https://seg-1.example.test/chunk1.m4s";
  const segGood = "https://seg-2.example.test/chunk1.m4s";
  const segItem = {
    id: "seg-1",
    type: "video",
    variants: [
      {
        id: "v-seg",
        metadata: { extension: "mp4" },
        delivery: {
          kind: "segments",
          join: "byte_concat",
          join_evidence: "validated_fragment_layout",
          output: { container: "mp4", extension: "mp4" },
          pieces: [
            {
              index: 1,
              byte_range: { start: 0, end_inclusive: 2 },
              sources: [
                { id: "p0", url: segDead },
                { id: "p1", url: segGood },
              ],
            },
          ],
        },
      },
    ],
    default: null,
    default_unavailable_reason: "processing_required",
  };
  const segTarget = mediaContract.getDownloadTarget(
    segItem,
    { variant_id: "v-seg" },
    { now },
  );
  assert.equal(segTarget.kind, "segments");

  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url) === segDead) return new Response("Unavailable", { status: 503 });
    if (String(url) === segGood) {
      return new Response(bytes, {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-length": "3",
          "content-range": "bytes 0-2/3",
        },
      });
    }
    throw new Error(`unexpected segment URL: ${url}`);
  };

  const segRes = await segmentDownload.collectArchiveTargetEntries({
    itemId: segItem.id,
    target: segTarget,
    base: "001_seg",
    apiContext: { now },
    signal: new AbortController().signal,
    maxArchiveBytes: 500 * 1024 * 1024,
    currentBytes: 0,
  });
  assert.deepEqual(fetched, [segDead, segGood]);
  assert.equal(segRes.entries[0].filename, "001_seg.mp4");
  assert.deepEqual(
    new Uint8Array(await segRes.entries[0].data.arrayBuffer()),
    bytes,
  );

  // HLS manifest delivery with fallback_urls + secondary source
  fetched = [];
  const hlsDead = "https://hls-1.example.test/list.m3u8?tok=1";
  const hlsFallback = "https://hls-1.example.test/list.m3u8?tok=2";
  const hlsGood = "https://hls-2.example.test/list.m3u8";
  const hlsClip = "https://hls-2.example.test/clip.ts";
  const hlsItem = {
    id: "hls-1",
    type: "video",
    variants: [
      {
        id: "v-hls",
        delivery: {
          kind: "hls",
          scope: "single",
          output: { container: "ts", extension: "ts" },
          sources: [
            { id: "h0", url: hlsDead, fallback_urls: [hlsFallback] },
            { id: "h1", url: hlsGood },
          ],
        },
      },
    ],
    default: null,
    default_unavailable_reason: "processing_required",
  };
  const hlsTarget = mediaContract.getDownloadTarget(
    hlsItem,
    { variant_id: "v-hls" },
    { now },
  );
  assert.equal(hlsTarget.kind, "hls");

  globalThis.fetch = async (url, init) => {
    fetched.push(`${init?.method || "GET"}:${String(url)}`);
    if (String(url) === hlsDead) throw new TypeError("Failed to fetch");
    if (String(url) === hlsFallback) return new Response("Forbidden", { status: 403 });
    if (String(url) === hlsGood) {
      return new Response("#EXTM3U\n#EXTINF:1,\nclip.ts\n#EXT-X-ENDLIST\n", {
        status: 200,
      });
    }
    if (String(url) === hlsClip) {
      if (init?.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-length": "3" } });
      }
      return new Response(bytes, {
        status: 200,
        headers: { "content-length": "3" },
      });
    }
    throw new Error(`unexpected HLS URL: ${url}`);
  };

  const hlsRes = await segmentDownload.collectArchiveTargetEntries({
    itemId: hlsItem.id,
    target: hlsTarget,
    base: "001_hls",
    apiContext: { now },
    signal: new AbortController().signal,
    maxArchiveBytes: 500 * 1024 * 1024,
    currentBytes: 0,
  });
  assert.deepEqual(fetched, [
    `GET:${hlsDead}`,
    `GET:${hlsFallback}`,
    `GET:${hlsGood}`,
    `HEAD:${hlsClip}`,
    `GET:${hlsClip}`,
  ]);
  assert.equal(hlsRes.entries[0].filename, "001_hls.ts");
  assert.deepEqual(
    new Uint8Array(await hlsRes.entries[0].data.arrayBuffer()),
    bytes,
  );
});
