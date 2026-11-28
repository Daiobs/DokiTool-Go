import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import * as mediabunny from "mediabunny";
import {
  FRONTEND_DIR,
  REPO_ROOT_DIR,
  loadExtensionFlowModules,
  createMockWebLocks,
  createMockOpfs,
  createTrackedUrlApi,
  createMockMv3Environment,
  createSyntheticMp4MuxStreams,
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
} from "./helpers/extensionDownloadFlowHarness.mjs";

let protocol;
let storage;
let youtubeBridgeMod;
let dashMuxSpecMod;
let opfsStreamTransferMod;
let dashMuxDownloadMod;
let dashMuxEngineMod;
let extensionDownloadMod;
let uiTargetHelpersMod;
let targetSpecBuilderMod;
let specRefresherMod;
let offscreenMod;
let backgroundMod;
let mediaContractMod;

before(async () => {
  ({
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
  } = await loadExtensionFlowModules());
});

beforeEach(() => {
  storage.resetInMemoryExtensionStorage();
});

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

  // Verify dynamic DNR rules synced on init (Rules 1001-1011 including Bilibili Akamai & TikTok CDN/parse rules)
  assert.equal(env.dnrRulesState.size, 11);

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
// Test 3: Shared youtubeHelperCore.js adapter (TVHTML5 player + 4K MP4/M4A mux)
// ============================================================================

function verifyExtensionBridgeUsesSharedYoutubeCore() {
  const bridgeSrc = readFileSync(
    join(FRONTEND_DIR, "src", "extension", "youtubeExtensionBridge.ts"),
    "utf8",
  );
  assert.match(
    bridgeSrc,
    /from\s+["']\.\.\/utils\/youtubeHelperCore["']/,
    "youtubeExtensionBridge must import directly from shared ../utils/youtubeHelperCore (SSOT)",
  );
}

test("YouTube shared-core adapter: imports shared youtubeHelperCore, strips forbidden headers, runs 3-step TVHTML5 parse & Mediabunny OPFS mux into subfolder", async () => {
  // 1) Verify youtubeExtensionBridge reuses shared youtubeHelperCore directly (no forked copy)!
  verifyExtensionBridgeUsesSharedYoutubeCore();

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

  // Verify 3 context menus registered (inspect, quick-download, selection link parse)
  assert.deepEqual(
    env.createdMenus.map((m) => m.id),
    [
      protocol.CONTEXT_MENU_INSPECT_ID,
      protocol.CONTEXT_MENU_QUICK_DOWNLOAD_ID,
      protocol.CONTEXT_MENU_PARSE_SELECTION_ID,
    ],
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
      assert.equal(
        renderedText.includes("仅下当前集") || renderedText.includes("仅下当前项"),
        false,
        `${tc.name} must not render redundant top current-item strip`,
      );
      assert.equal(
        renderedText.includes("按标题存子文件夹"),
        false,
        `${tc.name} must not render verbose subfolder button sentence`,
      );
      const subfolderPill = view.findAll(
        (node) => node.type === "button" && node.props["data-save-mode"] === "subfolder",
      )[0];
      const zipPill = view.findAll(
        (node) => node.type === "button" && node.props["data-save-mode"] === "zip",
      )[0];
      assert.ok(subfolderPill, `${tc.name} renders 存子文件夹 segmented pill`);
      assert.ok(zipPill, `${tc.name} renders 打包 ZIP segmented pill`);
      assert.equal(view.textOf(subfolderPill).trim(), "存子文件夹");
      assert.equal(view.textOf(zipPill).trim(), "打包 ZIP");

      const primaryBtn = () =>
        view.findAll(
          (node) =>
            node.type === "button" &&
            typeof node.props.class === "string" &&
            node.props.class.includes("sp-batch-actions__primary"),
        )[0];
      assert.ok(primaryBtn(), `${tc.name} renders unified primary download button`);
      assert.ok(
        view.textOf(primaryBtn()).includes(`下载全部 (${n})`),
        `${tc.name} primary button shows 下载全部 (n) when all selected, got: ${view.textOf(primaryBtn())}`,
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

      // Switch video item's quality variant to 720p and click unified primary download button (subfolder mode)
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

      await view.fire(primaryBtn(), "onClick");
      assert.equal(emittedEnqueues.length, 1);
      assert.equal(emittedEnqueues[0].items.length, n);
      assert.match(
        emittedEnqueues[0].items[videoIdx].spec.routes[0],
        /_720\.mp4$/,
        "Chosen 720p variant honored in mixed subfolder download",
      );

      // Switch save-mode toggle to 打包 ZIP and click primary -> enqueues batch_zip
      await view.fire(zipPill, "onClick");
      await view.fire(primaryBtn(), "onClick");
      assert.equal(emittedEnqueues.length, 2);
      assert.equal(emittedEnqueues[1].items.length, 1);
      assert.equal(emittedEnqueues[1].items[0].spec.kind, "batch_zip");
      await view.fire(subfolderPill, "onClick");

      // Test 全选 / 反选 / partial selection checkboxes
      const invertBtn = view.findAll(
        (node) => node.type === "button" && view.textOf(node).trim() === "反选",
      )[0];
      await view.fire(invertBtn, "onClick");
      assert.ok(view.textOf(primaryBtn()).includes(`下载已选 (0/${n})`));
      const selectAllBtn = view.findAll(
        (node) => node.type === "button" && view.textOf(node).trim() === "全选",
      )[0];
      await view.fire(selectAllBtn, "onClick");
      assert.ok(view.textOf(primaryBtn()).includes(`下载全部 (${n})`));

      const firstCheck = view.findAll(
        (node) =>
          node.type === "button" &&
          typeof node.props.class === "string" &&
          node.props.class.includes("sp-ep-row__check"),
      )[0];
      await view.fire(firstCheck, "onClick", { stopPropagation() {} });
      assert.ok(view.textOf(primaryBtn()).includes(`下载已选 (${n - 1}/${n})`));
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
// v4.5.2 Resilience & Invariant Regressions (CR-02, CR-06, CR-07, CR-08)
// ============================================================================

test("v4.5.2 CR-02: per-step stallTimeoutMs aborts hung headers/bodies, triggers Range resume, and frees slots for queued 4th task", async () => {
  // Part A: 3 concurrent stalled streams (1 hung header + 2 hung bodies) must timeout and free slots for 4th task
  const opfs = createMockOpfs();
  const urlApi = createTrackedUrlApi();
  const errors = [];
  const handedOff = [];
  const goodPayload = new Uint8Array([11, 22, 33, 44, 55, 66]);

  const mockFetch = async (url, init) => {
    if (url.includes("/hang-header")) {
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }
    if (url.includes("/hang-body")) {
      const stalledStream = new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
      });
      return new Response(stalledStream, {
        status: 200,
        headers: { "Content-Type": "video/mp4", "Content-Length": "1024" },
      });
    }
    if (url.includes("/good-fourth")) {
      return new Response(goodPayload, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(goodPayload.byteLength),
        },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const executor = extensionDownloadMod.createOffscreenDownloadExecutor({
    fetchImpl: mockFetch,
    opfsStorage: opfs.storage,
    webLocks: opfs.locks,
    urlApi,
    maxConcurrentTasks: 3,
    stallTimeoutMs: 60,
    onError: (e) => errors.push(e),
    async handoffBlobDownload(msg) {
      const blob = urlApi.activeBlobs.get(msg.blobUrl);
      handedOff.push({
        taskId: msg.taskId,
        bytes: new Uint8Array(await blob.arrayBuffer()),
      });
      queueMicrotask(() => {
        executor.releaseBlob({
          taskId: msg.taskId,
          blobUrl: msg.blobUrl,
          opfsTempName: msg.opfsTempName,
        });
      });
      return { chromeDownloadId: 901 };
    },
  });

  executor.startTask("stall-1", {
    kind: "direct_file",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://v3-web.douyinvod.com/hang-header.mp4"],
    filename: "stall1.mp4",
    mimeType: "video/mp4",
  });
  executor.startTask("stall-2", {
    kind: "direct_file",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://v3-web.douyinvod.com/hang-body-a.mp4"],
    filename: "stall2.mp4",
    mimeType: "video/mp4",
  });
  executor.startTask("stall-3", {
    kind: "direct_file",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://v3-web.douyinvod.com/hang-body-b.mp4"],
    filename: "stall3.mp4",
    mimeType: "video/mp4",
  });
  executor.startTask("good-4", {
    kind: "direct_file",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://v3-web.douyinvod.com/good-fourth.mp4"],
    filename: "good4.mp4",
    mimeType: "video/mp4",
  });

  await executor.waitForIdle();
  assert.equal(errors.length, 3);
  for (const err of errors) {
    assert.equal(err.code, "STREAM_STALL_TIMEOUT");
    assert.notEqual(err.cancelled, true);
  }
  assert.equal(handedOff.length, 1);
  assert.equal(handedOff[0].taskId, "good-4");
  assert.deepEqual([...handedOff[0].bytes], [...goodPayload]);
  assert.equal(executor.getActiveTaskCount(), 0);
  assert.equal(opfs.files.size, 0);
  executor.dispose();

  // Part B: Mid-stream stall after partial bytes triggers automatic HTTP 206 Range resume
  const fullData = new Uint8Array(16).map((_, i) => i + 1);
  const seenRanges = [];
  let resumeCalls = 0;
  const opfsResume = createMockOpfs();
  const urlResume = createTrackedUrlApi();
  let resumedBytes = null;
  const resumeExec = extensionDownloadMod.createOffscreenDownloadExecutor({
    fetchImpl: async (_url, init) => {
      resumeCalls += 1;
      const rangeHdr = init?.headers?.Range || null;
      seenRanges.push(rangeHdr);
      if (resumeCalls === 1) {
        let sentFirst = false;
        const stream = new ReadableStream({
          pull(controller) {
            if (!sentFirst) {
              sentFirst = true;
              controller.enqueue(fullData.slice(0, 8));
              return;
            }
            return new Promise(() => {});
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(fullData.byteLength),
          },
        });
      }
      assert.equal(rangeHdr, "bytes=8-");
      return new Response(fullData.slice(8), {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes 8-15/16`,
          "Content-Length": "8",
        },
      });
    },
    opfsStorage: opfsResume.storage,
    webLocks: opfsResume.locks,
    urlApi: urlResume,
    stallTimeoutMs: 60,
    async handoffBlobDownload(msg) {
      const blob = urlResume.activeBlobs.get(msg.blobUrl);
      resumedBytes = new Uint8Array(await blob.arrayBuffer());
      queueMicrotask(() => {
        resumeExec.releaseBlob({
          taskId: msg.taskId,
          blobUrl: msg.blobUrl,
          opfsTempName: msg.opfsTempName,
        });
      });
      return { chromeDownloadId: 902 };
    },
  });

  resumeExec.startTask("stall-resume", {
    kind: "direct_file",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://v3-web.douyinvod.com/resumable.mp4"],
    filename: "resumable.mp4",
    mimeType: "video/mp4",
    sizeBytes: fullData.byteLength,
  });
  await resumeExec.waitForIdle();
  assert.ok(resumedBytes, "resumed download must complete after mid-stream stall");
  assert.deepEqual([...resumedBytes], [...fullData]);
  assert.ok(seenRanges.includes("bytes=8-"));
  assert.equal(opfsResume.files.size, 0);
  resumeExec.dispose();
});

test("v4.5.2 CR-06 & CR-07: HLS resolves relative URIs against redirected final manifest URL, enforces manifest/segment size caps, and streams 8 MiB segments to OPFS with truncate rollback on retry", async () => {
  const opfs = createMockOpfs();
  const urlApi = createTrackedUrlApi();
  const writeEvents = [];
  const truncateEvents = [];

  // Instrument OPFS writable to prove incremental writes during read + truncate rollback on retry
  const origGetDirectory = opfs.storage.getDirectory;
  const instrumentedStorage = {
    ...opfs.storage,
    async getDirectory() {
      const dir = await origGetDirectory();
      return {
        ...dir,
        async getFileHandle(name, opts) {
          const handle = await dir.getFileHandle(name, opts);
          return {
            ...handle,
            async createWritable() {
              const writable = await handle.createWritable();
              return {
                ...writable,
                async write(chunk) {
                  if (chunk && typeof chunk === "object" && chunk.type === "write") {
                    writeEvents.push({
                      pos: chunk.position,
                      len: chunk.data.byteLength,
                    });
                  } else if (chunk && typeof chunk === "object" && chunk.type === "truncate") {
                    truncateEvents.push(chunk.size);
                  } else if (chunk instanceof Uint8Array) {
                    writeEvents.push({ pos: null, len: chunk.byteLength });
                  }
                  return writable.write(chunk);
                },
                async truncate(size) {
                  truncateEvents.push(size);
                  return writable.truncate(size);
                },
              };
            },
          };
        },
      };
    },
  };

  // Part A: Redirected HLS manifest resolves #EXT-X-MAP and relative segments against resp.url
  const fetchedUrls = [];
  const handedOff = [];
  const seg1Bytes = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
  const bigSegLen = 8 * 1024 * 1024;
  const chunkLen = 64 * 1024;
  const bigSegBytes = new Uint8Array(bigSegLen);
  for (let i = 0; i < bigSegBytes.length; i += 4096) {
    bigSegBytes[i] = (i / 4096) & 0xff;
  }
  let bigSegAttempts = 0;
  let writesObservedBeforeStreamEnd = 0;

  const mockFetch = async (url) => {
    fetchedUrls.push(url);
    if (url === "https://v.douyinvod.com/origin/index.m3u8") {
      const m3u8 = [
        "#EXTM3U",
        '#EXT-X-MAP:URI="init.mp4"',
        "#EXTINF:5,",
        "seg01.m4s",
        "#EXT-X-ENDLIST",
      ].join("\n");
      const resp = new Response(m3u8, {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl" },
      });
      Object.defineProperty(resp, "url", {
        value: "https://v.douyinvod.com/cdn/v2/stream/master.m3u8",
      });
      return resp;
    }
    if (url === "https://v.douyinvod.com/cdn/v2/stream/init.mp4") {
      return new Response(seg1Bytes, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(seg1Bytes.byteLength),
        },
      });
    }
    if (url === "https://v.douyinvod.com/cdn/v2/stream/seg01.m4s") {
      bigSegAttempts += 1;
      if (bigSegAttempts === 1) {
        // Attempt 1 writes 3 chunks of poison bytes then fails mid-stream
        let sent = 0;
        const poison = new Uint8Array(chunkLen).fill(0xee);
        const failStream = new ReadableStream({
          pull(controller) {
            if (sent < 3) {
              sent += 1;
              controller.enqueue(poison.slice());
              return;
            }
            controller.error(new Error("simulated mid-segment drop"));
          },
        });
        return new Response(failStream, {
          status: 200,
          headers: { "Content-Type": "video/mp4" },
        });
      }
      // Attempt 2 streams 8 MiB in 64 KiB chunks; verify OPFS writes happen DURING reading!
      let offset = 0;
      const okStream = new ReadableStream({
        pull(controller) {
          if (offset === chunkLen * 4) {
            writesObservedBeforeStreamEnd = writeEvents.length;
          }
          if (offset >= bigSegBytes.byteLength) {
            controller.close();
            return;
          }
          const slice = bigSegBytes.subarray(offset, offset + chunkLen);
          offset += slice.byteLength;
          controller.enqueue(slice);
        },
      });
      return new Response(okStream, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(bigSegBytes.byteLength),
        },
      });
    }
    if (url === "https://v.douyinvod.com/oversize/manifest.m3u8") {
      return new Response("x", {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Content-Length": String(2 * 1024 * 1024 + 1),
        },
      });
    }
    if (url === "https://v.douyinvod.com/oversize/huge-seg.ts") {
      return new Response("x", {
        status: 200,
        headers: {
          "Content-Type": "video/mp2t",
          "Content-Length": String(512 * 1024 * 1024 + 1),
        },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const errors = [];
  const executor = extensionDownloadMod.createOffscreenDownloadExecutor({
    fetchImpl: mockFetch,
    opfsStorage: instrumentedStorage,
    webLocks: opfs.locks,
    urlApi,
    onError: (e) => errors.push(e),
    async handoffBlobDownload(msg) {
      const blob = urlApi.activeBlobs.get(msg.blobUrl);
      handedOff.push(new Uint8Array(await blob.arrayBuffer()));
      queueMicrotask(() => {
        executor.releaseBlob({
          taskId: msg.taskId,
          blobUrl: msg.blobUrl,
          opfsTempName: msg.opfsTempName,
        });
      });
      return { chromeDownloadId: 903 };
    },
  });

  executor.startTask("hls-redirect-stream", {
    kind: "hls",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://v.douyinvod.com/origin/index.m3u8"],
    filename: "hls-redirect.mp4",
    mimeType: "video/mp4",
  });
  await executor.waitForIdle();

  assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
  assert.equal(
    fetchedUrls.includes("https://v.douyinvod.com/cdn/v2/stream/init.mp4"),
    true,
  );
  assert.equal(
    fetchedUrls.includes("https://v.douyinvod.com/cdn/v2/stream/seg01.m4s"),
    true,
  );
  assert.equal(
    fetchedUrls.some((u) => u.includes("/origin/init.mp4") || u.includes("/origin/seg01.m4s")),
    false,
    "must resolve relative HLS URIs against redirected final manifest URL",
  );
  assert.equal(bigSegAttempts, 2);
  assert.deepEqual(
    truncateEvents,
    [seg1Bytes.byteLength],
    "failed mid-segment write must truncate OPFS back to committedOffset before retry",
  );
  assert.ok(
    writesObservedBeforeStreamEnd >= 4,
    `expected incremental OPFS writes during 8 MiB stream read, observed ${writesObservedBeforeStreamEnd}`,
  );
  assert.equal(handedOff.length, 1);
  assert.equal(handedOff[0].byteLength, seg1Bytes.byteLength + bigSegLen);
  assert.deepEqual([...handedOff[0].subarray(0, 4)], [...seg1Bytes]);
  // Verify exact byte parity at start, middle, and end (zero 0xee poison residue!)
  assert.equal(handedOff[0][4], 0);
  assert.equal(handedOff[0][4 + 4096], 1);
  assert.equal(handedOff[0][4 + bigSegLen - 4096], ((bigSegLen - 4096) / 4096) & 0xff);
  assert.equal(opfs.files.size, 0);

  // Part B: Oversized HLS manifest (> 2 MiB) & single segment (> 512 MiB) & total (> 8 GiB) rejected
  executor.startTask("hls-manifest-cap", {
    kind: "hls",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://v.douyinvod.com/oversize/manifest.m3u8"],
    filename: "too-big-manifest.mp4",
  });
  executor.startTask("seg-single-cap", {
    kind: "segments",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://v.douyinvod.com/oversize/huge-seg.ts"],
    segments: [{ url: "https://v.douyinvod.com/oversize/huge-seg.ts" }],
    filename: "too-big-seg.ts",
  });
  executor.startTask("seg-total-cap", {
    kind: "segments",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://v.douyinvod.com/oversize/huge-seg.ts"],
    segments: [{ url: "https://v.douyinvod.com/oversize/huge-seg.ts", length: 8 * 1024 * 1024 * 1024 + 1 }],
    filename: "too-big-total.ts",
  });
  await executor.waitForIdle();
  assert.equal(errors.length, 3);
  const byTask = new Map(errors.map((e) => [e.taskId, e]));
  assert.match(byTask.get("hls-manifest-cap")?.error || "", /HLS 清单体积超过安全上限/);
  assert.match(byTask.get("seg-single-cap")?.error || "", /512 MiB/);
  assert.match(byTask.get("seg-total-cap")?.error || "", /8 GiB/);
  assert.equal(opfs.files.size, 0);
  executor.dispose();
});

test("v4.5.2 CR-08: storage quota failure in recordSavedWork still dispatches RELEASE_BLOB and frees offscreen concurrency slot", async () => {
  const opfs = createMockOpfs();
  const urlApi = createTrackedUrlApi();
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const mockFetch = async () =>
    new Response(payload, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(payload.byteLength),
      },
    });

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
          maxConcurrentTasks: 1,
          progressThrottleMs: 0,
        });
      }
    },
  });

  const extStorage = storage.createExtensionStorage();
  const origRecordSavedWork = extStorage.recordSavedWork.bind(extStorage);
  let failStorageOnce = true;
  extStorage.recordSavedWork = async (entry) => {
    if (failStorageOnce) {
      failStorageOnce = false;
      throw new DOMException("QUOTA_BYTES quota exceeded", "QuotaExceededError");
    }
    return origRecordSavedWork(entry);
  };

  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    fetchImpl: mockFetch,
    offscreenIdleCloseMs: 60,
  });
  await bg.init();

  // Enqueue 2 tasks against maxConcurrentTasks=1 so Task 2 can ONLY start if Task 1 releases its slot!
  await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "任务1_配额故障",
        platform: "douyin",
        workFingerprint: "douyin:quota-fail-1",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://v3-web.douyinvod.com/q1.mp4"],
          filename: "q1.mp4",
          mimeType: "video/mp4",
          sizeBytes: payload.byteLength,
        },
      },
      {
        title: "任务2_排队验证槽位释放",
        platform: "douyin",
        workFingerprint: "douyin:quota-ok-2",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://v3-web.douyinvod.com/q2.mp4"],
          filename: "q2.mp4",
          mimeType: "video/mp4",
          sizeBytes: payload.byteLength,
        },
      },
    ],
  });

  for (let i = 0; i < 60 && env.downloadCalls.length < 1; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(env.downloadCalls.length, 1);

  // Complete Task 1 while recordSavedWork throws QuotaExceededError!
  env.emitDownloadChanged({
    id: env.downloadCalls[0].id,
    state: { previous: "in_progress", current: "complete" },
  });

  // Task 2 MUST start and reach chrome.downloads.download (proving RELEASE_BLOB freed the slot!)
  for (let i = 0; i < 60 && env.downloadCalls.length < 2; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(
    env.downloadCalls.length,
    2,
    "Task 2 must acquire offscreen concurrency slot after Task 1 RELEASE_BLOB runs in finally",
  );

  env.emitDownloadChanged({
    id: env.downloadCalls[1].id,
    state: { previous: "in_progress", current: "complete" },
  });
  await bg.waitForIdle();
  await offscreenCtrl.executor.waitForIdle();

  assert.equal(urlApi.activeBlobs.size, 0, "zero leaked Blob URLs");
  assert.equal(opfs.files.size, 0, "zero leaked OPFS temp files");
  const snap = await bg.getSnapshot();
  const statuses = snap.tasks.map((t) => t.status);
  assert.deepEqual(statuses, ["completed", "completed"]);

  offscreenCtrl?.dispose();
  bg.dispose();
});

// ============================================================================
// Theme Persistence, Migration, Zero-Flash Sync & SidePanel UI Controls
// ============================================================================

