import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, transformWithEsbuild } from "vite";
import { parse, compileScript } from "@vue/compiler-sfc";
import { createSSRApp, createRenderer, h, markRaw, nextTick, reactive, ref } from "vue";
import { renderToString } from "vue/server-renderer";

import {
  DEFAULT_MUX_AUDIO_CHUNK_BYTES,
  DEFAULT_MUX_CHUNK_BYTES,
  DEFAULT_MUX_INITIAL_CHUNK_BYTES,
  DEFAULT_MUX_PROGRESS_THROTTLE_MS,
  DEFAULT_OPFS_CLEANUP_DELAY_MS,
  MAX_OPFS_CLEANUP_DELAY_MS,
  MIN_YOUTUBE_HELPER_VERSION,
  OPFS_CLEANUP_BYTES_PER_SECOND,
  OPFS_QUOTA_HEADROOM_FACTOR,
  OPFS_STALE_TEMP_MAX_AGE_MS,
  YOUTUBE_FILE_PICKER_ID,
  YOUTUBE_OPFS_TEMP_PREFIX,
  buildTVHTML5PlayerPayload,
  cleanupLeftoverYouTubeOpfsTempFiles,
  compareSemver,
  computeOpfsCleanupDelayMs,
  createUserscriptController,
  extractUrlClen,
  extractVisitorDataFromSwResponse,
  extractYouTubeVideoId,
  isHelperVersionSupported,
  isValidGooglevideoPlaybackUrl,
  isValidSignatureTimestamp,
  isValidTVHTML5Client,
  isValidYouTubeVideoId,
  pingYouTubeHelper,
  sanitizeHelperFilename,
  sanitizePlayerApiResponse,
  sanitizeVideoDetails,
  selectYouTubeMuxPair,
  sendHelperRequest,
} from "../src/utils/youtubeHelperCore.js";
import * as mediabunny from "mediabunny";
import { LATEST_EXTENSION_VERSION } from "../src/core/capabilityHub.ts";

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
      return new Promise((resolve, reject) => {
        const grant = () => {
          const lockObj = { name, mode };
          held.set(name, lockObj);
          Promise.resolve()
            .then(() => callback(lockObj))
            .then(resolve, reject)
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
    async query() {
      return {
        held: [...held.values()].map(({ name, mode }) => ({ name, mode })),
        pending: [...queues.entries()].flatMap(([name, q]) =>
          q.map(() => ({ name, mode: "exclusive" })),
        ),
      };
    },
  };
}

function createMockOpfsEnvironment({
  quota = 500_000_000,
  usage = 0,
  now = () => Date.now(),
  initialFiles = {},
} = {}) {
  const files = new Map();
  const lastModifiedMap = new Map();
  const activeLocks = new Set();
  const locks = createMockWebLocks();
  for (const [name, entry] of Object.entries(initialFiles)) {
    const isDescriptor =
      entry &&
      typeof entry === "object" &&
      !(entry instanceof Uint8Array) &&
      "content" in entry;
    const raw = isDescriptor ? entry.content : entry;
    const mtime = isDescriptor ? Number(entry.lastModified ?? now()) : now();
    files.set(
      name,
      raw instanceof Uint8Array
        ? raw
        : new TextEncoder().encode(String(raw)),
    );
    lastModifiedMap.set(name, mtime);
  }

  function currentUsageBytes() {
    let sum = usage;
    for (const data of files.values()) {
      sum += data.byteLength;
    }
    return sum;
  }

  const rootDir = {
    async *entries() {
      for (const name of [...files.keys()]) {
        yield [name, { kind: "file", name }];
      }
    },
    async getFileHandle(name, options = {}) {
      if (!files.has(name)) {
        if (!options?.create) {
          throw new DOMException("File not found", "NotFoundError");
        }
        files.set(name, new Uint8Array(0));
        lastModifiedMap.set(name, now());
      }
      return {
        kind: "file",
        name,
        async createWritable() {
          if (activeLocks.has(name)) {
            throw new DOMException("File already locked", "NoModificationAllowedError");
          }
          activeLocks.add(name);
          const chunks = [];
          let cursor = 0;
          let closed = false;
          return {
            async write(chunk) {
              if (closed) throw new Error("Writable already closed");
              if (chunk && typeof chunk === "object" && chunk.type === "write") {
                if (typeof chunk.position === "number") {
                  cursor = chunk.position;
                }
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
              activeLocks.delete(name);
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
              activeLocks.delete(name);
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
      if (activeLocks.has(name)) {
        throw new DOMException("File is locked", "InvalidModificationError");
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
    lastModifiedMap,
    activeLocks,
    locks,
    storage: {
      async estimate() {
        return { quota, usage: currentUsageBytes() };
      },
      async getDirectory() {
        return rootDir;
      },
    },
  };
}

async function createSyntheticMuxFixtures() {
  const avcC = new Uint8Array([
    1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x09, 0x67, 0x42, 0xc0, 0x1e, 0xd9,
    0x03, 0xc8, 0x40, 0x00, 0x01, 0x00, 0x04, 0x68, 0xcb, 0x83, 0xcb,
  ]);
  const mp4VideoTarget = new mediabunny.BufferTarget();
  const mp4VideoOut = new mediabunny.Output({
    format: new mediabunny.Mp4OutputFormat({ fastStart: "fragmented" }),
    target: mp4VideoTarget,
  });
  const mp4VideoSrc = new mediabunny.EncodedVideoPacketSource("avc");
  mp4VideoOut.addVideoTrack(mp4VideoSrc);
  await mp4VideoOut.start();
  for (let i = 0; i < 6; i++) {
    const nal = new Uint8Array(2048);
    new DataView(nal.buffer).setUint32(0, 2044);
    nal[4] = i === 0 ? 0x65 : 0x41;
    await mp4VideoSrc.add(
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
              codedWidth: 640,
              codedHeight: 360,
              description: avcC,
            },
          }
        : undefined,
    );
  }
  mp4VideoSrc.close();
  await mp4VideoOut.finalize();

  const m4aAudioTarget = new mediabunny.BufferTarget();
  const m4aAudioOut = new mediabunny.Output({
    format: new mediabunny.Mp4OutputFormat({ fastStart: "fragmented" }),
    target: m4aAudioTarget,
  });
  const m4aAudioSrc = new mediabunny.EncodedAudioPacketSource("aac");
  m4aAudioOut.addAudioTrack(m4aAudioSrc);
  await m4aAudioOut.start();
  for (let i = 0; i < 6; i++) {
    const frame = new Uint8Array(1024);
    frame[0] = 0xde;
    await m4aAudioSrc.add(
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
  m4aAudioSrc.close();
  await m4aAudioOut.finalize();

  const webmVideoTarget = new mediabunny.BufferTarget();
  const webmVideoOut = new mediabunny.Output({
    format: new mediabunny.WebMOutputFormat(),
    target: webmVideoTarget,
  });
  const webmVideoSrc = new mediabunny.EncodedVideoPacketSource("vp9");
  webmVideoOut.addVideoTrack(webmVideoSrc);
  await webmVideoOut.start();
  for (let i = 0; i < 5; i++) {
    const pkt = new Uint8Array(2048);
    pkt[0] = i === 0 ? 0x82 : 0x86;
    await webmVideoSrc.add(
      new mediabunny.EncodedPacket(
        pkt,
        i === 0 ? "key" : "delta",
        i * 0.04,
        0.04,
      ),
      i === 0
        ? {
            decoderConfig: {
              codec: "vp09.00.10.08",
              codedWidth: 1280,
              codedHeight: 720,
            },
          }
        : undefined,
    );
  }
  webmVideoSrc.close();
  await webmVideoOut.finalize();

  const webmAudioTarget = new mediabunny.BufferTarget();
  const webmAudioOut = new mediabunny.Output({
    format: new mediabunny.WebMOutputFormat(),
    target: webmAudioTarget,
  });
  const webmAudioSrc = new mediabunny.EncodedAudioPacketSource("opus");
  webmAudioOut.addAudioTrack(webmAudioSrc);
  await webmAudioOut.start();
  const opusHead = new Uint8Array([
    0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80,
    0xbb, 0x00, 0x00, 0, 0, 0,
  ]);
  for (let i = 0; i < 5; i++) {
    const pkt = new Uint8Array(512);
    pkt[0] = 0xf8;
    await webmAudioSrc.add(
      new mediabunny.EncodedPacket(pkt, "key", i * 0.02, 0.02),
      i === 0
        ? {
            decoderConfig: {
              codec: "opus",
              numberOfChannels: 2,
              sampleRate: 48000,
              description: opusHead,
            },
          }
        : undefined,
    );
  }
  webmAudioSrc.close();
  await webmAudioOut.finalize();

  return {
    mp4VideoBytes: new Uint8Array(mp4VideoTarget.buffer),
    m4aAudioBytes: new Uint8Array(m4aAudioTarget.buffer),
    webmVideoBytes: new Uint8Array(webmVideoTarget.buffer),
    webmAudioBytes: new Uint8Array(webmAudioTarget.buffer),
  };
}

function sliceRangeFromFixture(bytes, rawUrl) {
  const u = new URL(rawUrl);
  const rangeStr = u.searchParams.get("range") || `0-${bytes.byteLength - 1}`;
  const [startStr, endStr] = rangeStr.split("-");
  const start = Number(startStr);
  const end = Math.min(bytes.byteLength - 1, Number(endStr));
  const slice = bytes.slice(start, end + 1);
  return {
    status: 200,
    responseHeaders: `content-range: bytes ${start}-${end}/${bytes.byteLength}\r\n`,
    response: slice.buffer.slice(
      slice.byteOffset,
      slice.byteOffset + slice.byteLength,
    ),
  };
}

describe("YouTube helper userscript static header & validation contract", () => {
  test("userscript validators reject invalid video_id, non-googlevideo URLs, and invalid suffixes", () => {
    // 1. video_id validation
    assert.equal(isValidYouTubeVideoId("I9JvDaciaFk"), true);
    assert.equal(isValidYouTubeVideoId("aqz-KE-bpKQ"), true);
    for (const badId of [
      "",
      "short",
      "toolong12345",
      "bad/char123",
      "bad?char123",
      "I9JvDaciaF!",
      null,
      12345678901,
    ]) {
      assert.equal(
        isValidYouTubeVideoId(badId),
        false,
        `must reject video_id: ${badId}`,
      );
    }

    assert.equal(
      extractYouTubeVideoId("https://www.youtube.com/watch?v=I9JvDaciaFk"),
      "I9JvDaciaFk",
    );
    assert.equal(
      extractYouTubeVideoId("https://youtu.be/aqz-KE-bpKQ?si=test"),
      "aqz-KE-bpKQ",
    );
    assert.equal(
      extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
      "dQw4w9WgXcQ",
    );
    assert.equal(extractYouTubeVideoId("https://www.douyin.com/video/123"), "");

    // 2. signature_timestamp and TVHTML5 client validation
    assert.equal(isValidSignatureTimestamp(20760), true);
    for (const badSts of [0, -1, 999, 1000000, 20760.5, "20760", null]) {
      assert.equal(isValidSignatureTimestamp(badSts), false);
    }
    assert.equal(
      isValidTVHTML5Client({ name: "TVHTML5", version: "7.20260728.13.00" }),
      true,
    );
    assert.equal(
      isValidTVHTML5Client({ name: "TVHTML5", version: "5.20260707" }),
      true,
    );
    for (const badClient of [
      null,
      { name: "WEB", version: "2.20260728.01.00" },
      { name: "TVHTML5", version: "1.0.0" },
      { name: "TVHTML5", version: "7.20260728; evil" },
    ]) {
      assert.equal(isValidTVHTML5Client(badClient), false);
    }

    // 3. googlevideo URL validation
    assert.equal(
      isValidGooglevideoPlaybackUrl(
        "https://rr4---sn-ajoguc-5t.googlevideo.com/videoplayback?expire=1794238131&itag=299&id=o-AOdRLkc6ecTboXRtJhNBILt2v8AQeJUCoLbqEckV1dDI",
      ),
      true,
    );
    for (const badUrl of [
      "",
      "http://rr4---sn-ajoguc-5t.googlevideo.com/videoplayback?itag=299",
      "https://googlevideo.com/videoplayback?itag=299",
      "https://evil-googlevideo.com/videoplayback?itag=299",
      "https://rr4.googlevideo.com.evil.test/videoplayback?itag=299",
      "https://rr4---sn-ajoguc-5t.googlevideo.com/otherpath?itag=299",
      "https://user:pass@rr4---sn-ajoguc-5t.googlevideo.com/videoplayback?itag=299",
      "https://rr4---sn-ajoguc-5t.googlevideo.com:8443/videoplayback?itag=299",
      "https://rr4---sn-ajoguc-5t.googlevideo.com/videoplayback?itag=299#frag",
      "https://www.youtube.com/watch?v=I9JvDaciaFk",
    ]) {
      assert.equal(
        isValidGooglevideoPlaybackUrl(badUrl),
        false,
        `must reject URL: ${badUrl}`,
      );
    }

    // 4. filename suffix & sanitization validation (.mp4, .m4a, .webm allowed)
    assert.deepEqual(sanitizeHelperFilename("My Video: Test?.mp4"), {
      ok: true,
      filename: "My_Video_Test.mp4",
    });
    assert.deepEqual(sanitizeHelperFilename("Audio Track.M4A"), {
      ok: true,
      filename: "Audio_Track.m4a",
    });
    assert.deepEqual(sanitizeHelperFilename("4K VP9 Clip.WEBM"), {
      ok: true,
      filename: "4K_VP9_Clip.webm",
    });
    assert.equal(
      extractUrlClen(
        "https://rr1---sn-test.googlevideo.com/videoplayback?itag=299&clen=488502",
      ),
      488502,
    );
    assert.equal(extractUrlClen("https://rr1---sn-test.googlevideo.com/videoplayback?itag=18"), 0);
    for (const badName of [
      "",
      "video.mkv",
      "payload.exe",
      "script.js",
      "page.html",
      "video.mp4.exe",
      "no_extension",
    ]) {
      const res = sanitizeHelperFilename(badName);
      assert.equal(res.ok, false, `must reject filename: ${badName}`);
    }
  });

  test("userscript controller enforces strict action allowlist, anonymous requests, memory-only visitorData cache, and field stripping", async () => {
    const gmRequests = [];
    const gmDownloads = [];
    const savedBuffers = [];
    const sampleTrackBytes = new Uint8Array(2048);
    for (let i = 0; i < sampleTrackBytes.length; i++) sampleTrackBytes[i] = i & 0xff;
    const controller = createUserscriptController({
      version: "1.3.0",
      pageWindow: {},
      saveBuffer(buf, filename, mimeType) {
        savedBuffers.push({ byteLength: buf.byteLength, filename, mimeType });
      },
      gmXmlhttpRequest(details) {
        gmRequests.push(details);
        if (details.url === "https://www.youtube.com/sw.js_data") {
          details.onload({
            status: 200,
            responseText:
              ')]}\'\n[["yt.sw.adr",null,[[["en","US",null,"198.51.100.7",null,null,null,null,null,null,null,null,null,"Cgt0ZXN0VmlzaXRvckRhdGFTdHJpbmc%3D"]]]]]',
          });
          return;
        }
        if (
          details.url ===
          "https://www.youtube.com/youtubei/v1/player?prettyPrint=false"
        ) {
          details.onload({
            status: 200,
            responseText: JSON.stringify({
              playabilityStatus: {
                status: "OK",
                reason: "ok",
                extraSecretField: "dropped",
              },
              videoDetails: {
                title: "  Me at\u0000 the zoo  ",
                author: "jawed",
                lengthSeconds: "19",
                thumbnail: {
                  thumbnails: [
                    { url: "https://evil.example.com/thumb.jpg" },
                    { url: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg" },
                  ],
                },
                secretToken: "dropped",
              },
              streamingData: {
                expiresInSeconds: "21540",
                formats: [
                  {
                    itag: 18,
                    url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=18",
                    mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
                    width: 640,
                    height: 360,
                    contentLength: "144433",
                    unexpectedField: "must_be_removed",
                  },
                ],
                adaptiveFormats: [],
              },
            }),
          });
          return;
        }
        if (details.url.startsWith("https://rr1---sn-test.googlevideo.com/videoplayback")) {
          details.onload(sliceRangeFromFixture(sampleTrackBytes, details.url));
          return;
        }
        details.onerror();
      },
      gmDownload(details) {
        gmDownloads.push(details);
        details.onload();
      },
    });

    // Reject unknown actions (cannot be used as a generic proxy)
    const unknownResp = await controller.handleRequestObject({
      requestId: "req-unknown",
      action: "generic_fetch",
      payload: { url: "https://www.youtube.com/account" },
    });
    assert.equal(unknownResp.ok, false);
    assert.equal(unknownResp.error.code, "UNSUPPORTED_ACTION");

    // Reject invalid player parameters
    const badPlayerResp = await controller.handleRequestObject({
      requestId: "req-bad-player",
      action: "player",
      payload: {
        video_id: "invalid",
        signature_timestamp: 20760,
        client: { name: "TVHTML5", version: "7.20260728.13.00" },
      },
    });
    assert.equal(badPlayerResp.ok, false);

    // Valid player request: fetches visitorData with anonymous:true, calls player with anonymous:true, strips extra fields
    const okPlayerResp = await controller.handleRequestObject({
      requestId: "req-ok-player",
      action: "player",
      payload: {
        video_id: "I9JvDaciaFk",
        signature_timestamp: 20760,
        client: { name: "TVHTML5", version: "7.20260728.13.00" },
      },
    });
    assert.equal(okPlayerResp.ok, true);
    assert.equal(gmRequests.length, 2);
    assert.equal(gmRequests[0].anonymous, true);
    assert.equal(gmRequests[1].anonymous, true);
    assert.equal(
      gmRequests[1].headers["X-Goog-Visitor-Id"],
      "Cgt0ZXN0VmlzaXRvckRhdGFTdHJpbmc%3D",
    );
    assert.deepEqual(okPlayerResp.data.videoDetails, {
      title: "Me at the zoo",
      author: "jawed",
      lengthSeconds: 19,
      thumbnail: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
    });
    assert.equal(
      okPlayerResp.data.playabilityStatus.extraSecretField,
      undefined,
    );
    assert.equal(
      okPlayerResp.data.streamingData.formats[0].unexpectedField,
      undefined,
    );

    // Second player request reuses in-memory visitorData without calling sw.js_data again
    const okPlayerResp2 = await controller.handleRequestObject({
      requestId: "req-ok-player-2",
      action: "player",
      payload: {
        video_id: "I9JvDaciaFk",
        signature_timestamp: 20760,
        client: { name: "TVHTML5", version: "7.20260728.13.00" },
      },
    });
    assert.equal(okPlayerResp2.ok, true);
    assert.equal(gmRequests.length, 3);
    assert.equal(
      gmRequests[2].url,
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    );

    // Reject download of non-googlevideo URL or disallowed suffix
    const badDlUrl = await controller.handleRequestObject({
      requestId: "req-bad-dl-url",
      action: "download",
      payload: {
        url: "https://www.youtube.com/watch?v=I9JvDaciaFk",
        filename: "video.mp4",
      },
    });
    assert.equal(badDlUrl.ok, false);

    const badDlExt = await controller.handleRequestObject({
      requestId: "req-bad-dl-ext",
      action: "download",
      payload: {
        url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=248",
        filename: "video.mkv",
      },
    });
    assert.equal(badDlExt.ok, false);
    assert.equal(gmDownloads.length, 0);
    assert.equal(savedBuffers.length, 0);

    // Valid MP4, M4A, and WebM downloads use chunked anonymous GM_xmlhttpRequest (not single-connection GM_download)
    const okDl = await controller.handleRequestObject({
      requestId: "req-ok-dl",
      action: "download",
      payload: {
        url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=299",
        filename: "Sample 1080p.mp4",
      },
    });
    assert.equal(okDl.ok, true);
    assert.equal(okDl.data.filename, "Sample_1080p.mp4");
    assert.equal(okDl.data.mode, "memory_buffer");
    assert.equal(savedBuffers.length, 1);
    assert.equal(savedBuffers[0].filename, "Sample_1080p.mp4");
    assert.equal(savedBuffers[0].byteLength, sampleTrackBytes.byteLength);

    const okM4aDl = await controller.handleRequestObject({
      requestId: "req-ok-m4a-dl",
      action: "download",
      payload: {
        url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140",
        filename: "Sample_audio.m4a",
      },
    });
    assert.equal(okM4aDl.ok, true);
    assert.equal(okM4aDl.data.filename, "Sample_audio.m4a");
    assert.equal(okM4aDl.data.mode, "memory_buffer");
    assert.equal(savedBuffers[1].mimeType, "audio/mp4");

    const okWebmDl = await controller.handleRequestObject({
      requestId: "req-ok-webm-dl",
      action: "download",
      payload: {
        url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=315",
        filename: "Sample_2160p.webm",
      },
    });
    assert.equal(okWebmDl.ok, true);
    assert.equal(okWebmDl.data.filename, "Sample_2160p.webm");
    assert.equal(okWebmDl.data.mode, "memory_buffer");
    assert.equal(savedBuffers[2].mimeType, "video/webm");
    assert.equal(gmDownloads.length, 0);
    assert.ok(gmRequests.every((r) => r.anonymous === true));

    // Only when >= 1 GiB and both OPFS & showSaveFilePicker are unavailable does download fall back to gmDownload
    const hugeM4aDl = await controller.handleRequestObject({
      requestId: "req-huge-m4a-dl",
      action: "download",
      payload: {
        url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&clen=1200000000",
        filename: "Huge_audio.m4a",
        size: 1_200_000_000,
      },
    });
    assert.equal(hugeM4aDl.ok, true);
    assert.equal(hugeM4aDl.data.mode, "gm_download");
    assert.equal(gmDownloads.length, 1);
    assert.equal(gmDownloads[0].mode, "native");
  });

  test("sanitizePlayerApiResponse prunes 118-stream multi-audio TVHTML5 responses to default original audioTrack, enforces strict wire keys, and leaves single-language streams untouched", () => {
    // Build a realistic 118-stream YouTube TVHTML5 response:
    // - 1 muxed format (itag 18)
    // - 45 adaptive video streams (AVC1 / VP9 / AV1 across 144p..2160p60)
    // - 18 audio tracks (1 default original + 1 descriptive + 16 foreign AI-dubbed languages) × 4 itags = 72 audio streams
    // Total: 1 + 45 + 72 = 118 streams (> 64 old cap)
    const videoAdaptive = Array.from({ length: 45 }, (_, idx) => ({
      itag: 200 + idx,
      url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=${200 + idx}`,
      mimeType:
        idx % 3 === 0
          ? 'video/mp4; codecs="avc1.640028"'
          : idx % 3 === 1
            ? 'video/webm; codecs="vp9"'
            : 'video/mp4; codecs="av01.0.08M.08"',
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 3500000 - idx * 20000,
      contentLength: "18000000",
    }));

    const audioItags = [
      { itag: 139, mimeType: 'audio/mp4; codecs="mp4a.40.5"', bitrate: 48000 },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 },
      { itag: 249, mimeType: 'audio/webm; codecs="opus"', bitrate: 50000 },
      { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160000 },
    ];

    const dubbedLangs = [
      ["es.3", "Spanish"],
      ["fr.3", "French"],
      ["de.3", "German"],
      ["ja.3", "Japanese"],
      ["ko.3", "Korean"],
      ["pt.3", "Portuguese"],
      ["hi.3", "Hindi"],
      ["id.3", "Indonesian"],
      ["ru.3", "Russian"],
      ["ar.3", "Arabic"],
      ["tr.3", "Turkish"],
      ["vi.3", "Vietnamese"],
      ["th.3", "Thai"],
      ["it.3", "Italian"],
      ["pl.3", "Polish"],
      ["nl.3", "Dutch"],
    ];

    const audioTracksSpec = [
      ...dubbedLangs.slice(0, 8).map(([id, name]) => ({
        id,
        displayName: `${name} (auto-dubbed)`,
        audioIsDefault: false,
        isAutoDubbed: true,
      })),
      {
        id: "en.desc",
        displayName: "English descriptive",
        audioIsDefault: true,
        unknownSecretKey: "must_be_dropped",
      },
      {
        id: "  en.4  ",
        displayName: "  English\u0000 original  ",
        audioIsDefault: true,
        isAutoDubbed: false,
        extraProtoField: "must_be_dropped",
      },
      ...dubbedLangs.slice(8).map(([id, name]) => ({
        id,
        displayName: name,
        audioIsDefault: false,
      })),
    ];
    assert.equal(audioTracksSpec.length, 18);

    const audioAdaptive = audioTracksSpec.flatMap((track, tIdx) =>
      audioItags.map((spec) => ({
        itag: spec.itag,
        url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=${spec.itag}&xtags=acont%3D${encodeURIComponent(track.id.trim())}&t=${tIdx}`,
        mimeType: spec.mimeType,
        bitrate: spec.bitrate,
        contentLength: "3200000",
        audioQuality: spec.bitrate > 100000 ? "AUDIO_QUALITY_MEDIUM" : "AUDIO_QUALITY_LOW",
        audioSampleRate: "48000",
        audioChannels: 2,
        audioTrack: track,
      })),
    );

    const raw118 = {
      playabilityStatus: { status: "OK" },
      streamingData: {
        formats: [
          {
            itag: 18,
            url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=18",
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
            width: 640,
            height: 360,
          },
        ],
        adaptiveFormats: [...videoAdaptive, ...audioAdaptive],
      },
    };
    assert.equal(
      raw118.streamingData.formats.length + raw118.streamingData.adaptiveFormats.length,
      118,
    );

    const sanitized = sanitizePlayerApiResponse(raw118);
    const totalAfter =
      sanitized.streamingData.formats.length +
      sanitized.streamingData.adaptiveFormats.length;
    assert.equal(sanitized.streamingData.formats.length, 1);
    assert.equal(
      sanitized.streamingData.adaptiveFormats.length,
      49,
      "must retain all 45 video streams + 4 default original audio streams (AAC + Opus)",
    );
    assert.ok(totalAfter < 64, `expected < 64 total streams, got ${totalAfter}`);

    const keptAudio = sanitized.streamingData.adaptiveFormats.filter((f) =>
      f.mimeType.startsWith("audio/"),
    );
    assert.deepEqual(
      keptAudio.map((f) => f.itag),
      [139, 140, 249, 251],
    );
    for (const entry of keptAudio) {
      assert.deepEqual(Object.keys(entry.audioTrack).sort(), [
        "audioIsDefault",
        "displayName",
        "id",
      ]);
      assert.deepEqual(entry.audioTrack, {
        id: "en.4",
        displayName: "English original",
        audioIsDefault: true,
      });
    }

    // 2. Fallback when audioIsDefault is false on all tracks: prefers original non-descriptive track over AI dubs & descriptive
    const noDefaultFlagRaw = {
      playabilityStatus: { status: "OK" },
      streamingData: {
        formats: [],
        adaptiveFormats: [
          {
            itag: 140,
            url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&lang=en",
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            audioTrack: { id: "en.3", displayName: "English", audioIsDefault: false },
          },
          {
            itag: 140,
            url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&lang=ja-desc",
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            audioTrack: { id: "ja.desc", displayName: "Japanese (original, descriptive)", audioIsDefault: false },
          },
          {
            itag: 140,
            url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&lang=ja",
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            audioTrack: { id: "ja.4", displayName: "日语（原声）", audioIsDefault: false },
          },
        ],
      },
    };
    const sanitizedFallback = sanitizePlayerApiResponse(noDefaultFlagRaw);
    assert.equal(sanitizedFallback.streamingData.adaptiveFormats.length, 1);
    assert.equal(
      sanitizedFallback.streamingData.adaptiveFormats[0].audioTrack.id,
      "ja.4",
    );

    // 3. Invalid audioTrack fields are dropped instead of emitting malformed keys, and single-language streams without audioTrack stay untouched
    const singleLangRaw = {
      playabilityStatus: { status: "OK" },
      streamingData: {
        formats: [],
        adaptiveFormats: [
          {
            itag: 140,
            url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140",
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          },
          {
            itag: 251,
            url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=251",
            mimeType: 'audio/webm; codecs="opus"',
            audioTrack: { id: "bad/id with spaces", displayName: "\u0000   ", audioIsDefault: "yes" },
          },
        ],
      },
    };
    const sanitizedSingle = sanitizePlayerApiResponse(singleLangRaw);
    assert.equal(sanitizedSingle.streamingData.adaptiveFormats.length, 2);
    assert.equal("audioTrack" in sanitizedSingle.streamingData.adaptiveFormats[0], false);
    assert.equal("audioTrack" in sanitizedSingle.streamingData.adaptiveFormats[1], false);

    // 4. selectYouTubeMuxPair prefers main/original audio over alternate/dubbed when multiple standalone candidates exist
    const muxVideo = {
      id: "v-1080p",
      state: "ready",
      metadata: { has_audio: false, video_codec: "avc1.640028", container: "mp4", extension: "mp4" },
      delivery: {
        kind: "file",
        sources: [{ id: "sv", url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137" }],
      },
    };
    const dubbedAudio = {
      id: "a-dub-es",
      state: "ready",
      label: "Spanish (dubbed)",
      metadata: { has_audio: true, audio_codec: "mp4a.40.2", container: "m4a", extension: "m4a", mime_type: "audio/mp4", audio_language: "es", audio_language_role: "alternate" },
      delivery: {
        kind: "file",
        sources: [{ id: "sa-es", url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&lang=es" }],
      },
    };
    const mainAudio = {
      id: "a-orig-en",
      state: "ready",
      label: "English (original)",
      metadata: { has_audio: true, audio_codec: "mp4a.40.2", container: "m4a", extension: "m4a", mime_type: "audio/mp4", audio_language: "en", audio_language_role: "main" },
      delivery: {
        kind: "file",
        sources: [{ id: "sa-en", url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&lang=en" }],
      },
    };
    const pair = selectYouTubeMuxPair(muxVideo, [muxVideo, dubbedAudio, mainAudio]);
    assert.equal(pair.ok, true);
    assert.equal(pair.audioVariant.id, "a-orig-en");
  });

  test("sanitizePlayerApiResponse and selectYouTubeMuxPair prioritize non-English original track over hl=en AI auto-dub marked audioIsDefault=true", () => {
    // Under TVHTML5 hl:"en", non-English videos (e.g. Japanese original ja.4 with audioIsDefault: false)
    // often receive an English AI auto-dub (en.3 "English (auto-dubbed)" with audioIsDefault: true and xtags acont=dubbed-auto).
    const audioItags = [
      { itag: 139, mimeType: 'audio/mp4; codecs="mp4a.40.5"', bitrate: 48000 },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 },
      { itag: 249, mimeType: 'audio/webm; codecs="opus"', bitrate: 50000 },
      { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160000 },
    ];
    const nonEnglishRaw = {
      playabilityStatus: { status: "OK" },
      streamingData: {
        formats: [],
        adaptiveFormats: [
          {
            itag: 137,
            url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
            mimeType: 'video/mp4; codecs="avc1.640028"',
            width: 1920,
            height: 1080,
            fps: 30,
          },
          ...audioItags.map((spec) => ({
            itag: spec.itag,
            url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=${spec.itag}&xtags=acont%3Ddubbed-auto%3Alang%3Den`,
            mimeType: spec.mimeType,
            bitrate: spec.bitrate + 10000,
            audioTrack: {
              id: "en.3",
              displayName: "English (auto-dubbed)",
              audioIsDefault: true,
            },
          })),
          ...audioItags.map((spec) => ({
            itag: spec.itag,
            url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=${spec.itag}&xtags=acont%3Doriginal%3Alang%3Dja`,
            mimeType: spec.mimeType,
            bitrate: spec.bitrate,
            audioTrack: {
              id: "ja.4",
              displayName: "Japanese original",
              audioIsDefault: false,
            },
          })),
        ],
      },
    };

    const sanitized = sanitizePlayerApiResponse(nonEnglishRaw);
    const keptAudio = sanitized.streamingData.adaptiveFormats.filter((f) =>
      f.mimeType.startsWith("audio/"),
    );
    assert.equal(keptAudio.length, 4);
    assert.deepEqual(
      keptAudio.map((f) => f.itag),
      [139, 140, 249, 251],
    );
    for (const entry of keptAudio) {
      assert.equal(entry.audioTrack.id, "ja.4");
      assert.equal(entry.audioTrack.displayName, "Japanese original");
      assert.equal(entry.audioTrack.audioIsDefault, false);
      assert.ok(entry.url.includes("acont%3Doriginal%3Alang%3Dja"));
    }

    // Also inspect signatureCipher inner URL xtags when displayName has no explicit "original" / "auto-dubbed" suffix
    const cipherRaw = {
      playabilityStatus: { status: "OK" },
      streamingData: {
        formats: [],
        adaptiveFormats: [
          {
            itag: 140,
            signatureCipher:
              "s=SIG1&sp=sig&url=" +
              encodeURIComponent(
                "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&xtags=acont%3Ddubbed-auto%3Alang%3Den",
              ),
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            audioTrack: {
              id: "en.3",
              displayName: "English",
              audioIsDefault: true,
            },
          },
          {
            itag: 140,
            signatureCipher:
              "s=SIG2&sp=sig&url=" +
              encodeURIComponent(
                "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&xtags=acont%3Doriginal%3Alang%3Dja",
              ),
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            audioTrack: {
              id: "ja.4",
              displayName: "Japanese",
              audioIsDefault: false,
            },
          },
        ],
      },
    };
    const sanitizedCipher = sanitizePlayerApiResponse(cipherRaw);
    assert.equal(sanitizedCipher.streamingData.adaptiveFormats.length, 1);
    assert.equal(
      sanitizedCipher.streamingData.adaptiveFormats[0].audioTrack.id,
      "ja.4",
    );

    // selectYouTubeMuxPair also honors xtags acont=original over acont=dubbed-auto when labels are neutral
    const muxVideo = {
      id: "v-1080p",
      state: "ready",
      metadata: {
        has_audio: false,
        video_codec: "avc1.640028",
        container: "mp4",
        extension: "mp4",
      },
      delivery: {
        kind: "file",
        sources: [
          {
            id: "sv",
            url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
          },
        ],
      },
    };
    const autoDubCand = {
      id: "a-en-dub",
      state: "ready",
      label: "仅音频 M4A (128 kbps)",
      metadata: {
        has_audio: true,
        audio_codec: "mp4a.40.2",
        container: "mp4",
        extension: "m4a",
        mime_type: "audio/mp4",
      },
      delivery: {
        kind: "file",
        sources: [
          {
            id: "sa-en",
            url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&xtags=acont%3Ddubbed-auto%3Alang%3Den",
          },
        ],
      },
    };
    const origJaCand = {
      id: "a-ja-orig",
      state: "ready",
      label: "仅音频 M4A (128 kbps)",
      metadata: {
        has_audio: true,
        audio_codec: "mp4a.40.2",
        container: "mp4",
        extension: "m4a",
        mime_type: "audio/mp4",
      },
      delivery: {
        kind: "file",
        sources: [
          {
            id: "sa-ja",
            url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&xtags=acont%3Doriginal%3Alang%3Dja",
          },
        ],
      },
    };
    const muxPair = selectYouTubeMuxPair(muxVideo, [
      muxVideo,
      autoDubCand,
      origJaCand,
    ]);
    assert.equal(muxPair.ok, true);
    assert.equal(muxPair.audioVariant.id, "a-ja-orig");
  });

  test("CustomEvent handshake and semver version check", async () => {
    assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
    assert.equal(compareSemver("1.1.0", "1.0.0"), 1);
    assert.equal(compareSemver("0.9.9", "1.0.0"), -1);
    assert.equal(isHelperVersionSupported("0.9.9", "1.0.0"), false);
    assert.equal(isHelperVersionSupported("1.0.0", "1.0.0"), true);

    const target = new EventTarget();
    // 1. No userscript mounted -> installed: false
    const missingPing = await pingYouTubeHelper({
      eventTarget: target,
      timeoutMs: 30,
    });
    assert.deepEqual(missingPing, {
      installed: false,
      version: null,
      supported: false,
    });

    // 2. Outdated userscript mounted -> installed: true, supported: false
    const unmountOld = createUserscriptController({
      eventTarget: target,
      version: "0.9.0",
    }).mount();
    const oldPing = await pingYouTubeHelper({
      eventTarget: target,
      timeoutMs: 50,
    });
    assert.deepEqual(oldPing, {
      installed: true,
      version: "0.9.0",
      supported: false,
    });
    unmountOld();

    // 3. Current userscript mounted -> installed: true, supported: true
    const unmountCurrent = createUserscriptController({
      eventTarget: target,
      version: LATEST_EXTENSION_VERSION,
    }).mount();
    const readyPing = await pingYouTubeHelper({
      eventTarget: target,
      timeoutMs: 50,
    });
    assert.deepEqual(readyPing, {
      installed: true,
      version: LATEST_EXTENSION_VERSION,
      supported: true,
    });
    unmountCurrent();
  });
});

describe("YouTube Phase 2 pair selection and chunked Mediabunny muxing", () => {
  const sampleUrl = (itag, clen = 100000) =>
    `https://rr4---sn-ajoguc-5t.googlevideo.com/videoplayback?expire=1794238131&ip=198.51.100.7&id=o-AOdRLkc6ecTboXRtJhNBILt2v8AQeJUCoLbqEckV1dDI&itag=${itag}&source=youtube&gir=yes&clen=${clen}&c=TVHTML5&n=F7GraLOqBD6ahA&sparams=expire%2Cip%2Cid%2Citag%2Csource%2Cgir%2Cclen&sig=AAA`;

  const makeVariant = (id, metadata, itag, clen = 100000) => ({
    id,
    state: "ready",
    label: id,
    provenance: "original_endpoint",
    metadata,
    delivery: {
      kind: "file",
      sources: [
        {
          id: `s-${id}`,
          url: sampleUrl(itag, clen),
          access: "direct",
          size_bytes: clen,
        },
      ],
    },
  });

  test("selectYouTubeMuxPair pairs H.264/AV1+AAC->mp4 and VP9+Opus->webm, and rejects cross-container or progressive tracks", () => {
    const h264Video = makeVariant(
      "v-299",
      {
        width: 1920,
        height: 1080,
        fps: 60,
        has_audio: false,
        video_codec: "h264",
        container: "mp4",
        extension: "mp4",
        mime_type: "video/mp4",
      },
      299,
      500000,
    );
    const av1Video = makeVariant(
      "v-701",
      {
        width: 3840,
        height: 2160,
        fps: 60,
        has_audio: false,
        video_codec: "av01.0.12M.10",
        container: "mp4",
        extension: "mp4",
        mime_type: "video/mp4",
      },
      701,
      900000,
    );
    const vp9Video = makeVariant(
      "v-315",
      {
        width: 3840,
        height: 2160,
        fps: 60,
        has_audio: false,
        video_codec: "vp9",
        container: "webm",
        extension: "webm",
        mime_type: "video/webm",
      },
      315,
      800000,
    );
    const vp9HdrVideo = makeVariant(
      "v-337",
      {
        width: 3840,
        height: 2160,
        fps: 60,
        has_audio: false,
        video_codec: "vp9.2",
        container: "webm",
        extension: "webm",
        mime_type: "video/webm",
      },
      337,
      850000,
    );
    const prog360 = makeVariant(
      "v-18",
      {
        width: 640,
        height: 360,
        fps: 30,
        has_audio: true,
        video_codec: "h264",
        audio_codec: "aac",
        container: "mp4",
        extension: "mp4",
        mime_type: "video/mp4",
      },
      18,
      144433,
    );
    const aacAudio = makeVariant(
      "v-140",
      {
        has_audio: true,
        audio_codec: "aac",
        container: "mp4",
        extension: "m4a",
        mime_type: "audio/mp4",
      },
      140,
      80000,
    );
    const opusAudio = makeVariant(
      "v-251",
      {
        has_audio: true,
        audio_codec: "opus",
        container: "webm",
        extension: "webm",
        mime_type: "audio/webm",
      },
      251,
      90000,
    );

    const allVariants = [
      av1Video,
      vp9HdrVideo,
      vp9Video,
      h264Video,
      prog360,
      aacAudio,
      opusAudio,
    ];

    const pH264 = selectYouTubeMuxPair(h264Video, allVariants, []);
    assert.equal(pH264.ok, true);
    assert.equal(pH264.outputContainer, "mp4");
    assert.equal(pH264.outputExtension, "mp4");
    assert.equal(pH264.audioVariant.id, "v-140");

    const pAv1 = selectYouTubeMuxPair(av1Video, allVariants, []);
    assert.equal(pAv1.ok, true);
    assert.equal(pAv1.outputContainer, "mp4");
    assert.equal(pAv1.outputExtension, "mp4");
    assert.equal(pAv1.audioVariant.id, "v-140");

    const pVp9 = selectYouTubeMuxPair(vp9Video, allVariants, []);
    assert.equal(pVp9.ok, true);
    assert.equal(pVp9.outputContainer, "webm");
    assert.equal(pVp9.outputExtension, "webm");
    assert.equal(pVp9.audioVariant.id, "v-251");

    const pVp9Hdr = selectYouTubeMuxPair(vp9HdrVideo, allVariants, []);
    assert.equal(pVp9Hdr.ok, true);
    assert.equal(pVp9Hdr.outputContainer, "webm");
    assert.equal(pVp9Hdr.outputExtension, "webm");
    assert.equal(pVp9Hdr.audioVariant.id, "v-251");

    // Cross-container combinations must be rejected
    const crossVp9OnlyAac = selectYouTubeMuxPair(
      vp9Video,
      [vp9Video, aacAudio],
      [],
    );
    assert.equal(crossVp9OnlyAac.ok, false);
    assert.match(crossVp9OnlyAac.reason, /不做跨容器合流/);

    const crossH264OnlyOpus = selectYouTubeMuxPair(
      h264Video,
      [h264Video, opusAudio],
      [],
    );
    assert.equal(crossH264OnlyOpus.ok, false);
    assert.match(crossH264OnlyOpus.reason, /不做跨容器合流/);

    // Progressive video (has_audio: true) is not muxed
    const progResult = selectYouTubeMuxPair(prog360, allVariants, []);
    assert.equal(progResult.ok, false);

    // Missing audio altogether
    const noAudioResult = selectYouTubeMuxPair(h264Video, [h264Video], []);
    assert.equal(noAudioResult.ok, false);
  });

  test("mux_download recovers from per-chunk 403/network/truncated failures, muxes MP4 and WebM via StreamTarget & BufferTarget, enforces 1 GiB memory cap, and supports cancel_download", async () => {
    const fixtures = await createSyntheticMuxFixtures();
    const mp4VideoUrl = sampleUrl(137, fixtures.mp4VideoBytes.byteLength);
    const m4aAudioUrl = sampleUrl(140, fixtures.m4aAudioBytes.byteLength);
    const webmVideoUrl = sampleUrl(315, fixtures.webmVideoBytes.byteLength);
    const opusAudioUrl = sampleUrl(251, fixtures.webmAudioBytes.byteLength);

    function createMemoryStreamPicker() {
      let fileBytes = new Uint8Array(0);
      let closed = false;
      return {
        getBytes: () => fileBytes,
        isClosed: () => closed,
        pageWindow: {
          async showSaveFilePicker(opts) {
            assert.ok(opts.suggestedName);
            return {
              async createWritable() {
                let cursor = 0;
                return {
                  async write(chunk) {
                    let data;
                    let pos = cursor;
                    if (
                      chunk &&
                      typeof chunk === "object" &&
                      chunk.type === "write"
                    ) {
                      if (typeof chunk.position === "number") {
                        pos = chunk.position;
                      }
                      data = chunk.data;
                    } else {
                      data = chunk;
                    }
                    const u8 =
                      data instanceof Uint8Array
                        ? data
                        : new Uint8Array(data);
                    const end = pos + u8.byteLength;
                    if (end > fileBytes.byteLength) {
                      const grown = new Uint8Array(end);
                      grown.set(fileBytes);
                      fileBytes = grown;
                    }
                    fileBytes.set(u8, pos);
                    cursor = end;
                  },
                  async close() {
                    closed = true;
                  },
                  async abort() {
                    closed = false;
                  },
                };
              },
            };
          },
        },
      };
    }

    // 1. Per-chunk retry recovery (403 -> network error -> truncated -> valid) + MP4 StreamTarget
    let chunk4096Attempts = 0;
    const seenAnonymous = [];
    const mp4Picker = createMemoryStreamPicker();
    const retryTarget = new EventTarget();
    const unmountRetry = createUserscriptController({
      eventTarget: retryTarget,
      pageWindow: mp4Picker.pageWindow,
      mediabunny,
      muxConfig: {
        chunkSize: 4096,
        maxRetries: 3,
        retryBaseDelayMs: 5,
      },
      gmXmlhttpRequest(details) {
        seenAnonymous.push(details.anonymous);
        const u = new URL(details.url);
        const itag = u.searchParams.get("itag");
        const range = u.searchParams.get("range") || "";
        if (itag === "137" && range.startsWith("4096-")) {
          chunk4096Attempts += 1;
          if (chunk4096Attempts === 1) {
            details.onload({
              status: 403,
              responseHeaders: "",
              response: new ArrayBuffer(0),
            });
            return;
          }
          if (chunk4096Attempts === 2) {
            details.onerror(new Error("transient reset"));
            return;
          }
          if (chunk4096Attempts === 3) {
            details.onload({
              status: 200,
              responseHeaders: "",
              response: new ArrayBuffer(64),
            });
            return;
          }
        }
        const bytes =
          itag === "137" ? fixtures.mp4VideoBytes : fixtures.m4aAudioBytes;
        details.onload(sliceRangeFromFixture(bytes, details.url));
      },
    }).mount();

    try {
      const progressEvents = [];
      const res = await sendHelperRequest(
        "mux_download",
        {
          videoUrl: mp4VideoUrl,
          audioUrl: m4aAudioUrl,
          videoSize: fixtures.mp4VideoBytes.byteLength,
          audioSize: fixtures.m4aAudioBytes.byteLength,
          filename: "Retry_Test_1080p.mp4",
          outputContainer: "mp4",
        },
        {
          eventTarget: retryTarget,
          timeoutMs: 10000,
          onProgress: (p) => progressEvents.push(p),
        },
      );
      assert.equal(res.filename, "Retry_Test_1080p.mp4");
      assert.equal(res.mode, "stream_picker");
      assert.equal(chunk4096Attempts, 4);
      assert.ok(seenAnonymous.every((v) => v === true));
      assert.equal(mp4Picker.isClosed(), true);
      assert.ok(progressEvents.length > 0);

      const mergedMp4 = mp4Picker.getBytes();
      const verifyIn = new mediabunny.Input({
        source: new mediabunny.BufferSource(mergedMp4),
        formats: [mediabunny.MP4],
      });
      const vTracks = await verifyIn.getVideoTracks();
      const aTracks = await verifyIn.getAudioTracks();
      assert.equal(vTracks.length, 1);
      assert.equal(aTracks.length, 1);
      assert.equal(vTracks[0].codec, "avc");
      assert.equal(aTracks[0].codec, "aac");
      verifyIn.dispose();
    } finally {
      unmountRetry();
    }

    // 2. WebM StreamTarget (VP9 + Opus -> .webm)
    const webmPicker = createMemoryStreamPicker();
    const webmTarget = new EventTarget();
    const unmountWebm = createUserscriptController({
      eventTarget: webmTarget,
      pageWindow: webmPicker.pageWindow,
      mediabunny,
      muxConfig: { chunkSize: 4096, maxRetries: 2, retryBaseDelayMs: 5 },
      gmXmlhttpRequest(details) {
        const itag = new URL(details.url).searchParams.get("itag");
        const bytes =
          itag === "315" ? fixtures.webmVideoBytes : fixtures.webmAudioBytes;
        details.onload(sliceRangeFromFixture(bytes, details.url));
      },
    }).mount();
    try {
      const res = await sendHelperRequest(
        "mux_download",
        {
          videoUrl: webmVideoUrl,
          audioUrl: opusAudioUrl,
          videoSize: fixtures.webmVideoBytes.byteLength,
          audioSize: fixtures.webmAudioBytes.byteLength,
          filename: "WebM_Test_2160p.webm",
          outputContainer: "webm",
        },
        { eventTarget: webmTarget, timeoutMs: 10000 },
      );
      assert.equal(res.filename, "WebM_Test_2160p.webm");
      assert.equal(res.mode, "stream_picker");
      const verifyWebm = new mediabunny.Input({
        source: new mediabunny.BufferSource(webmPicker.getBytes()),
        formats: [mediabunny.WEBM],
      });
      assert.equal((await verifyWebm.getVideoTracks())[0].codec, "vp9");
      assert.equal((await verifyWebm.getAudioTracks())[0].codec, "opus");
      verifyWebm.dispose();
    } finally {
      unmountWebm();
    }

    // 3. < 1 GiB BufferTarget fallback when showSaveFilePicker is unavailable, and >= 1 GiB rejection
    const savedBuffers = [];
    const bufTarget = new EventTarget();
    const unmountBuf = createUserscriptController({
      eventTarget: bufTarget,
      pageWindow: {}, // No showSaveFilePicker
      mediabunny,
      muxConfig: { chunkSize: 4096, maxRetries: 2, retryBaseDelayMs: 5 },
      saveBuffer(arrayBuffer, filename, mimeType) {
        savedBuffers.push({ arrayBuffer, filename, mimeType });
      },
      gmXmlhttpRequest(details) {
        const itag = new URL(details.url).searchParams.get("itag");
        const bytes =
          itag === "137" ? fixtures.mp4VideoBytes : fixtures.m4aAudioBytes;
        details.onload(sliceRangeFromFixture(bytes, details.url));
      },
    }).mount();
    try {
      const bufRes = await sendHelperRequest(
        "mux_download",
        {
          videoUrl: mp4VideoUrl,
          audioUrl: m4aAudioUrl,
          videoSize: fixtures.mp4VideoBytes.byteLength,
          audioSize: fixtures.m4aAudioBytes.byteLength,
          filename: "Memory_Fallback_1080p.mp4",
          outputContainer: "mp4",
        },
        { eventTarget: bufTarget, timeoutMs: 10000 },
      );
      assert.equal(bufRes.mode, "memory_buffer");
      assert.equal(savedBuffers.length, 1);
      assert.equal(savedBuffers[0].filename, "Memory_Fallback_1080p.mp4");
      assert.equal(savedBuffers[0].mimeType, "video/mp4");
      assert.ok(savedBuffers[0].arrayBuffer.byteLength > 1000);

      // >= 1 GiB without showSaveFilePicker -> rejects with MUX_TOO_LARGE_FOR_MEMORY
      await assert.rejects(
        () =>
          sendHelperRequest(
            "mux_download",
            {
              videoUrl: sampleUrl(701, 900_000_000),
              audioUrl: sampleUrl(140, 250_000_000),
              videoSize: 900_000_000,
              audioSize: 250_000_000,
              filename: "Huge_2160p.mp4",
              outputContainer: "mp4",
            },
            { eventTarget: bufTarget, timeoutMs: 5000 },
          ),
        (err) => err.code === "MUX_TOO_LARGE_FOR_MEMORY",
      );
    } finally {
      unmountBuf();
    }

    // 4. User cancelling showSaveFilePicker -> AbortError / USER_CANCELLED, and cancel_download aborts XHR
    const cancelPickerTarget = new EventTarget();
    const unmountCancelPicker = createUserscriptController({
      eventTarget: cancelPickerTarget,
      pageWindow: {
        async showSaveFilePicker() {
          throw new DOMException("The user aborted a request.", "AbortError");
        },
      },
      mediabunny,
      gmXmlhttpRequest() {
        throw new Error("must not fetch chunks after picker cancel");
      },
    }).mount();
    try {
      await assert.rejects(
        () =>
          sendHelperRequest(
            "mux_download",
            {
              videoUrl: mp4VideoUrl,
              audioUrl: m4aAudioUrl,
              videoSize: fixtures.mp4VideoBytes.byteLength,
              audioSize: fixtures.m4aAudioBytes.byteLength,
              filename: "Cancelled_1080p.mp4",
              outputContainer: "mp4",
            },
            { eventTarget: cancelPickerTarget, timeoutMs: 5000 },
          ),
        (err) => err.name === "AbortError" && err.code === "USER_CANCELLED",
      );
    } finally {
      unmountCancelPicker();
    }

    let abortedChunkXhr = false;
    const inFlightTarget = new EventTarget();
    const unmountInFlight = createUserscriptController({
      eventTarget: inFlightTarget,
      pageWindow: createMemoryStreamPicker().pageWindow,
      mediabunny,
      gmXmlhttpRequest() {
        return {
          abort() {
            abortedChunkXhr = true;
          },
        };
      },
    }).mount();
    try {
      const ac = new AbortController();
      const pending = sendHelperRequest(
        "mux_download",
        {
          videoUrl: mp4VideoUrl,
          audioUrl: m4aAudioUrl,
          videoSize: fixtures.mp4VideoBytes.byteLength,
          audioSize: fixtures.m4aAudioBytes.byteLength,
          filename: "InFlightCancel_1080p.mp4",
          outputContainer: "mp4",
        },
        {
          eventTarget: inFlightTarget,
          timeoutMs: 5000,
          signal: ac.signal,
        },
      );
      await new Promise((r) => setTimeout(r, 25));
      ac.abort();
      await assert.rejects(pending, (err) => err.name === "AbortError");
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(abortedChunkXhr, true);
    } finally {
      unmountInFlight();
    }
  });
});

describe("YouTube frontend parser, ResultSection UI states, and download flows", () => {
  let vite,
    parser,
    selectionMod,
    downloadMod,
    videoFilenameMod,
    ResultSection,
    DownloadCard,
    fixtures;
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNavigator = globalThis.navigator;

  const itag18Url =
    "https://rr4---sn-ajoguc-5t.googlevideo.com/videoplayback?expire=1794238131&ip=198.51.100.7&id=o-AOdRLkc6ecTboXRtJhNBILt2v8AQeJUCoLbqEckV1dDI&itag=18&source=youtube&c=TVHTML5&n=5GuFTFbCJY0P_g&sparams=expire%2Cip%2Cid%2Citag%2Csource&sig=AAA&title=Sample_360p";
  const makeItagUrl = (itag, clen) =>
    `https://rr4---sn-ajoguc-5t.googlevideo.com/videoplayback?expire=1794238131&ip=198.51.100.7&id=o-AOdRLkc6ecTboXRtJhNBILt2v8AQeJUCoLbqEckV1dDI&itag=${itag}&source=youtube&gir=yes&clen=${clen}&c=TVHTML5&n=F7GraLOqBD6ahA&sparams=expire%2Cip%2Cid%2Citag%2Csource%2Cgir%2Cclen&sig=BBB`;

  const sampleYouTubeUnifiedData = (opts = {}) => {
    const videoClen = opts.videoClen ?? fixtures.mp4VideoBytes.byteLength;
    const audioClen = opts.audioClen ?? fixtures.m4aAudioBytes.byteLength;
    const itag299Url = makeItagUrl(299, videoClen);
    const itag140Url = makeItagUrl(140, audioClen);
    const extraVariants = opts.extraVariants ?? [];
    return {
      platform: "youtube",
      content_id: "I9JvDaciaFk",
      source_url: "https://www.youtube.com/watch?v=I9JvDaciaFk",
      generated_at: "2026-11-09T00:00:00Z",
      title: "Sample YouTube Video",
      author: { name: "Sample Channel", id: "channel-1" },
      default_item_id: "video-I9JvDaciaFk",
      items: [
        {
          id: "video-I9JvDaciaFk",
          type: "video",
          state: "ready",
          title: "Sample YouTube Video",
          default: {
            variant_id: "v-18",
            source_id: "s-18",
            url: itag18Url,
            access: "direct",
          },
          variants: [
            ...extraVariants,
            {
              id: "v-299",
              label: "1080p60 (仅视频, 无音频)",
              provenance: "original_endpoint",
              metadata: {
                width: 1920,
                height: 1080,
                fps: 60,
                has_audio: false,
                video_codec: "h264",
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [
                  {
                    id: "s-299",
                    url: itag299Url,
                    access: "direct",
                    size_bytes: videoClen,
                  },
                ],
              },
            },
            {
              id: "v-18",
              label: "360p (含音频)",
              provenance: "original_endpoint",
              metadata: {
                width: 640,
                height: 360,
                fps: 30,
                has_audio: true,
                video_codec: "h264",
                audio_codec: "aac",
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [
                  {
                    id: "s-18",
                    url: itag18Url,
                    access: "direct",
                    size_bytes: 144433,
                  },
                ],
              },
            },
            {
              id: "v-140",
              label: "音轨 (M4A)",
              provenance: "original_endpoint",
              metadata: {
                has_audio: true,
                audio_codec: "aac",
                container: "mp4",
                extension: "m4a",
                mime_type: "audio/mp4",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [
                  {
                    id: "s-140",
                    url: itag140Url,
                    access: "direct",
                    size_bytes: audioClen,
                  },
                ],
              },
            },
          ],
        },
      ],
      attachments: [
        {
          id: "att-m4a",
          role: "background_audio",
          title: "Sample YouTube Video (M4A)",
          resource: {
            id: "audio-140",
            role: "audio",
            metadata: {
              has_audio: true,
              audio_codec: "aac",
              container: "m4a",
              extension: "m4a",
              mime_type: "audio/mp4",
              evidence: "upstream",
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-140",
                  url: itag140Url,
                  access: "direct",
                  size_bytes: audioClen,
                },
              ],
            },
          },
        },
      ],
    };
  };

  before(async () => {
    fixtures = await createSyntheticMuxFixtures();
    vite = await createServer({
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "custom",
    });
    parser = await vite.ssrLoadModule("/src/composables/useVideoParser.ts");
    selectionMod = await vite.ssrLoadModule(
      "/src/composables/useVideoSelection.ts",
    );
    downloadMod = await vite.ssrLoadModule(
      "/src/composables/useMediaDownload.ts",
    );
    videoFilenameMod = await vite.ssrLoadModule(
      "/src/utils/videoFilename.ts",
    );
    ResultSection = (
      await vite.ssrLoadModule("/src/components/ResultSection.vue")
    ).default;
    DownloadCard = (
      await vite.ssrLoadModule("/src/components/DownloadCard.vue")
    ).default;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
    await vite?.close();
  });

  function setupEnvironment() {
    const bus = new EventTarget();
    const clickedAnchors = [];
    globalThis.window = {
      setTimeout,
      clearTimeout,
      CustomEvent: globalThis.CustomEvent,
      addEventListener: bus.addEventListener.bind(bus),
      removeEventListener: bus.removeEventListener.bind(bus),
      dispatchEvent: bus.dispatchEvent.bind(bus),
      open: () => ({}),
    };
    globalThis.document = {
      body: {
        style: {},
        appendChild() {},
      },
      createElement(tag) {
        return {
          tag,
          href: "",
          download: "",
          target: "",
          rel: "",
          referrerPolicy: "",
          addEventListener() {},
          removeEventListener() {},
          click() {
            clickedAnchors.push({
              href: this.href,
              download: this.download,
              target: this.target,
            });
          },
          remove() {},
        };
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userActivation: { isActive: true } },
    });

    const store = reactive({
      resultData: null,
      resultVersion: 0,
      downloads: [],
      resolvingItems: new Set(),
      clearResult() {
        this.resultData = null;
        this.resultVersion++;
      },
      setResult(data) {
        this.resultData = data;
        this.resultVersion++;
      },
      addDownload(input) {
        const id = this.downloads.length + 1;
        this.downloads.push({
          id,
          status: "preparing",
          percent: 0,
          loaded: 0,
          total: 0,
          speed: 0,
          error: null,
          fallbackReason: null,
          statusText: "准备中...",
          show: true,
          abortController: null,
          ...input,
        });
        return id;
      },
      updateDownload(id, updates) {
        const idx = this.downloads.findIndex((d) => d.id === id);
        if (idx !== -1) {
          this.downloads[idx] = { ...this.downloads[idx], ...updates };
        }
      },
      removeDownload(id) {
        const idx = this.downloads.findIndex((d) => d.id === id);
        if (idx !== -1) this.downloads.splice(idx, 1);
      },
      cancelDownload(id) {
        const idx = this.downloads.findIndex((d) => d.id === id);
        if (idx !== -1) {
          this.downloads[idx].abortController?.abort();
          this.downloads[idx].status = "cancelled";
        }
      },
    });
    const toasts = [];
    const showToast = (msg, type = "success") => toasts.push([msg, type]);
    const parserInstance = parser.useVideoParser({
      videoStore: store,
      locale: ref("zh-CN"),
      showToast,
    });
    const selection = selectionMod.useVideoSelection({ videoStore: store });
    const downloader = downloadMod.useMediaDownload({
      videoStore: store,
      showToast,
      selection,
      resolveItem: parserInstance.resolveItem,
    });
    return {
      bus,
      clickedAnchors,
      store,
      toasts,
      parserInstance,
      selection,
      downloader,
    };
  }

  async function renderResultHtml(store, selection, sync = true) {
    if (sync) {
      selection.syncResult();
    }
    const app = createSSRApp({
      render: () =>
        h(ResultSection, {
          resultData: store.resultData,
          resultVersion: store.resultVersion,
          locale: "zh-CN",
          selection,
          isDownloading: false,
          resolvingIds: new Set(),
          formatNumber: String,
          formatDuration: String,
        }),
    });
    return renderToString(app);
  }

  async function renderDownloadCardHtml(store) {
    const app = createSSRApp({
      render: () => h(DownloadCard, { downloads: store.downloads }),
    });
    return renderToString(app);
  }

  test("buildMediaFilename omits _P1 for single-item works, supports .mp4/.m4a/.webm, and keeps _P1/_P2 for multi-item works", () => {
    const { buildMediaFilename, sanitizeFilename, hashMediaName } =
      videoFilenameMod;

    // Single item (total omitted or total === 1): no _P1 suffix
    assert.equal(
      buildMediaFilename({
        title: "Single Work",
        index: 1,
        fallback: "single-1",
        extension: "mp4",
      }),
      "Single Work.mp4",
    );
    assert.equal(
      buildMediaFilename({
        title: "Single Work",
        index: 1,
        total: 1,
        fallback: "single-1",
        extension: "mp4",
      }),
      "Single Work.mp4",
    );
    assert.equal(
      buildMediaFilename({
        title: "Me at the zoo",
        index: 1,
        total: 1,
        suffix: "1080p",
        fallback: "jNQXAC9IVRw",
        extension: "mp4",
      }),
      "Me at the zoo_1080p.mp4",
    );
    assert.equal(
      buildMediaFilename({
        title: "Costa Rica 4K",
        index: 1,
        total: 1,
        suffix: "2160p",
        fallback: "LXb3EKWsInQ",
        extension: "webm",
      }),
      "Costa Rica 4K_2160p.webm",
    );
    assert.equal(
      buildMediaFilename({
        title: "Me at the zoo",
        index: 1,
        total: 1,
        suffix: "audio",
        fallback: "jNQXAC9IVRw",
        extension: "m4a",
      }),
      "Me at the zoo_audio.m4a",
    );
    assert.equal(
      buildMediaFilename({
        title: "Costa Rica 4K",
        index: 1,
        total: 1,
        suffix: "audio",
        fallback: "LXb3EKWsInQ",
        extension: "webm",
      }),
      "Costa Rica 4K_audio.webm",
    );

    // Multi-item (total > 1): keeps _P1, _P2, _P3
    assert.equal(
      buildMediaFilename({
        title: "Album Work",
        index: 1,
        total: 3,
        fallback: "album-1",
        extension: "jpg",
      }),
      "Album Work_P1.jpg",
    );
    assert.equal(
      buildMediaFilename({
        title: "Album Work",
        index: 2,
        total: 3,
        fallback: "album-2",
        extension: "jpg",
      }),
      "Album Work_P2.jpg",
    );
    assert.equal(
      buildMediaFilename({
        title: "Album Work",
        index: 3,
        total: 3,
        fallback: "album-3",
        extension: "mp4",
      }),
      "Album Work_P3.mp4",
    );

    // Strip Unicode format characters (Cf, e.g. U+202E RLO, U+200B ZWSP, U+FEFF BOM)
    assert.equal(
      buildMediaFilename({
        title: " \ufeffClip\u202e4pm.exe\u200b\u202c ",
        index: 1,
        total: 1,
        suffix: "360\u202ep",
        fallback: "I9JvDaciaFk",
        extension: "mp4",
      }),
      "Clip4pm.exe_360p.mp4",
    );
    assert.equal(
      buildMediaFilename({
        title: "\u202e\u200b\ufeff",
        index: 1,
        total: 1,
        fallback: "I9JvDaciaFk",
        extension: "mp4",
      }),
      `${hashMediaName("I9JvDaciaFk")}.mp4`,
    );
    assert.equal(
      sanitizeFilename("test\u202e4pm.exe.mp4"),
      "test4pm.exe.mp4",
    );
  });

  test("OPFS quota headroom (< 1.2x -> showSaveFilePicker with id 'dokitool-youtube'), immediate temp-file deletion on cancel/error, and page-load leftover temp-file sweep", async () => {
    assert.equal(OPFS_QUOTA_HEADROOM_FACTOR, 1.2);
    assert.equal(YOUTUBE_FILE_PICKER_ID, "dokitool-youtube");

    // 1. Page-load sweep only deletes dokitool-yt-tmp-* files older than 1 hour (> 3,600,000 ms), keeping <= 1h temp files and unrelated OPFS files
    const sweepNow = 1_800_000_000_000;
    const sweepOpfs = createMockOpfsEnvironment({
      now: () => sweepNow,
      initialFiles: {
        [`${YOUTUBE_OPFS_TEMP_PREFIX}stale-2h.mp4.part`]: {
          content: "leftover-2h",
          lastModified: sweepNow - 2 * 3_600_000,
        },
        [`${YOUTUBE_OPFS_TEMP_PREFIX}stale-1h-plus-1ms.m4a.part`]: {
          content: "leftover-1h-plus-1ms",
          lastModified: sweepNow - (OPFS_STALE_TEMP_MAX_AGE_MS + 1),
        },
        [`${YOUTUBE_OPFS_TEMP_PREFIX}exact-1h-boundary.mp4.part`]: {
          content: "keep-exact-1h",
          lastModified: sweepNow - OPFS_STALE_TEMP_MAX_AGE_MS,
        },
        [`${YOUTUBE_OPFS_TEMP_PREFIX}recent-5m.mp4.part`]: {
          content: "keep-recent-5m",
          lastModified: sweepNow - 5 * 60_000,
        },
        "keep-other-data.json": {
          content: '{"ok":true}',
          lastModified: sweepNow - 24 * 3_600_000,
        },
      },
    });
    const removedCount = await cleanupLeftoverYouTubeOpfsTempFiles({
      storage: sweepOpfs.storage,
      locks: sweepOpfs.locks,
      now: () => sweepNow,
    });
    assert.equal(removedCount, 2);
    assert.deepEqual(
      [...sweepOpfs.files.keys()].sort(),
      [
        `${YOUTUBE_OPFS_TEMP_PREFIX}exact-1h-boundary.mp4.part`,
        `${YOUTUBE_OPFS_TEMP_PREFIX}recent-5m.mp4.part`,
        "keep-other-data.json",
      ].sort(),
    );

    // 2. Insufficient OPFS quota (remaining = 1.1x < 1.2x estimatedBytes) -> falls back to showSaveFilePicker({ id: "dokitool-youtube" })
    const totalEstimated =
      fixtures.mp4VideoBytes.byteLength + fixtures.m4aAudioBytes.byteLength;
    const tightOpfs = createMockOpfsEnvironment({
      quota: Math.floor(totalEstimated * 1.1),
      usage: 0,
    });
    const pickerInvocations = [];
    const tightBus = new EventTarget();
    const unmountTight = createUserscriptController({
      eventTarget: tightBus,
      version: LATEST_EXTENSION_VERSION,
      mediabunny,
      muxConfig: { chunkSize: 4096, maxRetries: 1, retryBaseDelayMs: 5 },
      pageWindow: {
        navigator: { storage: tightOpfs.storage, locks: tightOpfs.locks },
        async showSaveFilePicker(opts) {
          pickerInvocations.push(opts);
          return {
            name: opts.suggestedName,
            async createWritable() {
              return {
                async write() {},
                async close() {},
                async abort() {},
              };
            },
          };
        },
      },
      gmXmlhttpRequest(details) {
        const itag = new URL(details.url).searchParams.get("itag");
        const bytes =
          itag === "299" ? fixtures.mp4VideoBytes : fixtures.m4aAudioBytes;
        details.onload(sliceRangeFromFixture(bytes, details.url));
      },
    }).mount();

    try {
      const res = await sendHelperRequest(
        "mux_download",
        {
          taskId: "quota-check-1",
          videoUrl: makeItagUrl(299, fixtures.mp4VideoBytes.byteLength),
          audioUrl: makeItagUrl(140, fixtures.m4aAudioBytes.byteLength),
          videoSize: fixtures.mp4VideoBytes.byteLength,
          audioSize: fixtures.m4aAudioBytes.byteLength,
          filename: "Quota_Test_1080p.mp4",
          outputContainer: "mp4",
        },
        { eventTarget: tightBus },
      );
      assert.equal(res.mode, "stream_picker");
      assert.equal(pickerInvocations.length, 1);
      assert.equal(pickerInvocations[0].id, "dokitool-youtube");
      assert.equal(tightOpfs.files.size, 0);
      assert.equal((await tightOpfs.locks.query()).held.length, 0);
    } finally {
      unmountTight();
    }

    // 3. Cancellation mid-mux immediately unlocks (both OPFS writable and Web Lock) & deletes the OPFS temp file
    const cancelOpfs = createMockOpfsEnvironment({ quota: 500_000_000 });
    const cancelBus = new EventTarget();
    let pendingAudioLoad = null;
    const unmountCancel = createUserscriptController({
      eventTarget: cancelBus,
      version: LATEST_EXTENSION_VERSION,
      mediabunny,
      muxConfig: {
        chunkSize: 4096,
        maxRetries: 0,
        retryBaseDelayMs: 5,
        opfsCleanupDelayMs: 60_000,
      },
      pageWindow: {
        navigator: { storage: cancelOpfs.storage, locks: cancelOpfs.locks },
        URL: { createObjectURL: () => "blob:unused", revokeObjectURL() {} },
        document: {
          body: { appendChild() {} },
          createElement: () => ({ style: {}, click() {}, remove() {} }),
        },
      },
      gmXmlhttpRequest(details) {
        const itag = new URL(details.url).searchParams.get("itag");
        if (itag === "140") {
          pendingAudioLoad = () =>
            details.onload({
              status: 403,
              responseHeaders: "",
              response: new ArrayBuffer(0),
            });
          return {
            abort() {
              details.onabort?.();
            },
          };
        }
        details.onload(sliceRangeFromFixture(fixtures.mp4VideoBytes, details.url));
        return {};
      },
    }).mount();

    try {
      const abortController = new AbortController();
      const muxPromise = sendHelperRequest(
        "mux_download",
        {
          taskId: "cancel-opfs-99",
          videoUrl: makeItagUrl(299, fixtures.mp4VideoBytes.byteLength),
          audioUrl: makeItagUrl(140, fixtures.m4aAudioBytes.byteLength),
          videoSize: fixtures.mp4VideoBytes.byteLength,
          audioSize: fixtures.m4aAudioBytes.byteLength,
          filename: "Cancel_Test_1080p.mp4",
          outputContainer: "mp4",
        },
        { eventTarget: cancelBus, signal: abortController.signal },
      );
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(cancelOpfs.files.size, 1, "temp OPFS file must exist while muxing");
      const tempFileName = [...cancelOpfs.files.keys()][0];
      assert.match(tempFileName, /^dokitool-yt-tmp-cancel-opfs-99-/);
      assert.deepEqual((await cancelOpfs.locks.query()).held, [
        { name: tempFileName, mode: "exclusive" },
      ]);

      abortController.abort();
      await assert.rejects(() => muxPromise, (err) => err.name === "AbortError");
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(cancelOpfs.activeLocks.size, 0, "OPFS writable lock must be released immediately");
      assert.equal((await cancelOpfs.locks.query()).held.length, 0, "Web Lock must be released immediately on cancel");
      assert.equal(cancelOpfs.files.size, 0, "OPFS temp file must be deleted immediately on cancel");

      // 4. Error mid-mux ALSO immediately unlocks (OPFS writable + Web Lock) & deletes OPFS temp file
      pendingAudioLoad = null;
      const errPromise = sendHelperRequest(
        "mux_download",
        {
          taskId: "error-opfs-100",
          videoUrl: makeItagUrl(299, fixtures.mp4VideoBytes.byteLength),
          audioUrl: makeItagUrl(140, fixtures.m4aAudioBytes.byteLength),
          videoSize: fixtures.mp4VideoBytes.byteLength,
          audioSize: fixtures.m4aAudioBytes.byteLength,
          filename: "Error_Test_1080p.mp4",
          outputContainer: "mp4",
        },
        { eventTarget: cancelBus },
      );
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(cancelOpfs.files.size, 1);
      assert.equal((await cancelOpfs.locks.query()).held.length, 1);
      pendingAudioLoad?.();
      await assert.rejects(() => errPromise, /HTTP 403/);
      assert.equal(cancelOpfs.activeLocks.size, 0);
      assert.equal((await cancelOpfs.locks.query()).held.length, 0, "Web Lock must be released immediately on error");
      assert.equal(cancelOpfs.files.size, 0, "OPFS temp file must be deleted immediately on error");
    } finally {
      unmountCancel();
    }
  });

  test("OPFS conservative post-handoff cleanup timing (120s min, size / 5 MiB/s, 30m max), multi-controller shared OPFS Web Locks protection, and lockless environment fallback", async () => {
    const MIB = 1024 * 1024;
    const GIB = 1024 * MIB;
    assert.equal(DEFAULT_OPFS_CLEANUP_DELAY_MS, 120_000);
    assert.equal(MAX_OPFS_CLEANUP_DELAY_MS, 1_800_000);
    assert.equal(OPFS_CLEANUP_BYTES_PER_SECOND, 5 * MIB);
    assert.equal(OPFS_STALE_TEMP_MAX_AGE_MS, 3_600_000);

    // 1. Conservative formula verification across small, >600 MiB, >=1 GiB, 4.4 GB, and >9000 MiB sizes
    assert.equal(computeOpfsCleanupDelayMs(0), 120_000);
    assert.equal(computeOpfsCleanupDelayMs(10 * MIB), 120_000);
    assert.equal(computeOpfsCleanupDelayMs(600 * MIB), 120_000);
    assert.equal(computeOpfsCleanupDelayMs(601 * MIB), 121_000);
    assert.equal(computeOpfsCleanupDelayMs(GIB), 205_000);
    assert.equal(computeOpfsCleanupDelayMs(4_400_000_000), 840_000);
    assert.equal(computeOpfsCleanupDelayMs(9000 * MIB), 1_800_000);
    assert.equal(computeOpfsCleanupDelayMs(16 * GIB), 1_800_000);

    // 2. Two independent controller instances sharing one OPFS directory & Web Locks manager do NOT delete each other's active or post-handoff files
    let clockNow = 1_800_000_000_000;
    const staleOldName = `${YOUTUBE_OPFS_TEMP_PREFIX}orphan-2h-old.mp4.part`;
    const recentUnheldName = `${YOUTUBE_OPFS_TEMP_PREFIX}unheld-15m-old.mp4.part`;
    const sharedOpfs = createMockOpfsEnvironment({
      quota: 500_000_000,
      now: () => clockNow,
      initialFiles: {
        [staleOldName]: {
          content: "stale-orphan",
          lastModified: clockNow - 2 * 3_600_000,
        },
        [recentUnheldName]: {
          content: "recent-closed-tab",
          lastModified: clockNow - 15 * 60_000,
        },
      },
    });

    const scheduledTimersA = [];
    const scheduledTimersB = [];
    const busA = new EventTarget();
    const busB = new EventTarget();

    const makeTabWindow = (timersArr, withLocks = true) => ({
      navigator: {
        storage: sharedOpfs.storage,
        ...(withLocks ? { locks: sharedOpfs.locks } : {}),
      },
      setTimeout(fn, ms) {
        timersArr.push({ fn, ms });
        return { unref() {} };
      },
      URL: {
        createObjectURL(file) {
          return `blob:shared-${file.name}`;
        },
        revokeObjectURL() {},
      },
      document: {
        body: { appendChild() {} },
        createElement: () => ({ style: {}, click() {}, remove() {} }),
      },
    });

    const gmMock = (details) => {
      const itag = new URL(details.url).searchParams.get("itag");
      const bytes =
        itag === "299" ? fixtures.mp4VideoBytes : fixtures.m4aAudioBytes;
      details.onload(sliceRangeFromFixture(bytes, details.url));
      return {};
    };

    const controllerA = createUserscriptController({
      eventTarget: busA,
      now: () => clockNow,
      version: LATEST_EXTENSION_VERSION,
      mediabunny,
      muxConfig: { chunkSize: 4096, maxRetries: 1, retryBaseDelayMs: 5 },
      pageWindow: makeTabWindow(scheduledTimersA, true),
      gmXmlhttpRequest: gmMock,
    });
    const unmountA = controllerA.mount();

    // Give controllerA's mount() sweep a turn: it must delete staleOldName (>1h) while keeping recentUnheldName (15m <= 1h)
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sharedOpfs.files.has(staleOldName), false);
    assert.equal(sharedOpfs.files.has(recentUnheldName), true);

    let unmountB = () => {};
    try {
      // Tab A muxes & hands off a file (default conservative cleanup timer = 120,000 ms, NOT overridden)
      const resA = await sendHelperRequest(
        "mux_download",
        {
          taskId: "tab-a-active",
          videoUrl: makeItagUrl(299, fixtures.mp4VideoBytes.byteLength),
          audioUrl: makeItagUrl(140, fixtures.m4aAudioBytes.byteLength),
          videoSize: fixtures.mp4VideoBytes.byteLength,
          audioSize: fixtures.m4aAudioBytes.byteLength,
          filename: "Tab_A_1080p.mp4",
          outputContainer: "mp4",
        },
        { eventTarget: busA },
      );
      assert.equal(resA.mode, "opfs");
      assert.equal(scheduledTimersA.length, 1);
      assert.equal(
        scheduledTimersA[0].ms,
        120_000,
        "unoverridden small/medium file cleanup timer must use conservative 120s minimum",
      );

      const tabATempName = [...sharedOpfs.files.keys()].find((k) =>
        k.startsWith(`${YOUTUBE_OPFS_TEMP_PREFIX}tab-a-active-`),
      );
      assert.ok(tabATempName, "Tab A temp file must remain in OPFS during post-handoff copy window");
      assert.equal(
        sharedOpfs.activeLocks.size,
        0,
        "OPFS writable stream is already closed after handoff",
      );
      assert.deepEqual((await sharedOpfs.locks.query()).held, [
        { name: tabATempName, mode: "exclusive" },
      ]);

      // Tab B also starts its own concurrent OPFS download while mounting & sweeping the shared OPFS directory!
      // Even if clock jumps forward by +3 hours (so tabATempName's lastModified > 1h), Tab B's { ifAvailable: true } Web Lock check MUST skip tabATempName!
      clockNow += 3 * 3_600_000;
      const controllerB = createUserscriptController({
        eventTarget: busB,
        now: () => clockNow,
        version: LATEST_EXTENSION_VERSION,
        mediabunny,
        muxConfig: { chunkSize: 4096, maxRetries: 1, retryBaseDelayMs: 5 },
        pageWindow: makeTabWindow(scheduledTimersB, true),
        gmXmlhttpRequest: gmMock,
      });
      unmountB = controllerB.mount();
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(
        sharedOpfs.files.has(recentUnheldName),
        false,
        "unlocked file now >3h old is swept by Tab B",
      );
      assert.equal(
        sharedOpfs.files.has(tabATempName),
        true,
        "Tab B MUST NOT delete Tab A's post-handoff temp file protected by Web Lock",
      );

      const resB = await sendHelperRequest(
        "download",
        {
          taskId: "tab-b-audio",
          url: makeItagUrl(140, fixtures.m4aAudioBytes.byteLength),
          size: fixtures.m4aAudioBytes.byteLength,
          filename: "Tab_B_audio.m4a",
        },
        { eventTarget: busB },
      );
      assert.equal(resB.mode, "opfs");
      const tabBTempName = [...sharedOpfs.files.keys()].find((k) =>
        k.startsWith(`${YOUTUBE_OPFS_TEMP_PREFIX}tab-b-audio-`),
      );
      assert.ok(tabBTempName);
      assert.equal((await sharedOpfs.locks.query()).held.length, 2);

      // Independent page-load sweep (e.g. App.vue onMounted in Tab C) skips BOTH locked files
      const sweptWhileBothHeld = await cleanupLeftoverYouTubeOpfsTempFiles({
        storage: sharedOpfs.storage,
        locks: sharedOpfs.locks,
        now: () => clockNow + 5 * 3_600_000,
      });
      assert.equal(sweptWhileBothHeld, 0);
      assert.equal(sharedOpfs.files.has(tabATempName), true);
      assert.equal(sharedOpfs.files.has(tabBTempName), true);

      // Firing Tab A's conservative timer removes ONLY Tab A's temp file & releases Tab A's Web Lock
      await scheduledTimersA[0].fn();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(sharedOpfs.files.has(tabATempName), false);
      assert.equal(sharedOpfs.files.has(tabBTempName), true);
      assert.deepEqual((await sharedOpfs.locks.query()).held, [
        { name: tabBTempName, mode: "exclusive" },
      ]);

      // Firing Tab B's conservative timer removes Tab B's temp file & releases Tab B's Web Lock
      await scheduledTimersB[0].fn();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(sharedOpfs.files.size, 0);
      assert.equal((await sharedOpfs.locks.query()).held.length, 0);
    } finally {
      unmountB();
      unmountA();
    }

    // 3. Graceful fallback when navigator.locks is absent or throws SecurityError
    let noLockClock = 1_900_000_000_000;
    const noLockOpfs = createMockOpfsEnvironment({
      quota: 500_000_000,
      now: () => noLockClock,
    });
    const noLockTimers = [];
    const noLockBus = new EventTarget();
    const throwingLocks = {
      request() {
        return Promise.reject(new DOMException("Denied", "SecurityError"));
      },
    };
    const unmountNoLock = createUserscriptController({
      eventTarget: noLockBus,
      now: () => noLockClock,
      webLocks: throwingLocks,
      version: LATEST_EXTENSION_VERSION,
      mediabunny,
      muxConfig: { chunkSize: 4096, maxRetries: 1, retryBaseDelayMs: 5 },
      pageWindow: {
        navigator: { storage: noLockOpfs.storage },
        setTimeout(fn, ms) {
          noLockTimers.push({ fn, ms });
          return { unref() {} };
        },
        URL: { createObjectURL: () => "blob:nolock", revokeObjectURL() {} },
        document: {
          body: { appendChild() {} },
          createElement: () => ({ style: {}, click() {}, remove() {} }),
        },
      },
      gmXmlhttpRequest: gmMock,
    }).mount();

    try {
      const resNoLock = await sendHelperRequest(
        "download",
        {
          taskId: "nolock-task",
          url: makeItagUrl(140, fixtures.m4aAudioBytes.byteLength),
          size: fixtures.m4aAudioBytes.byteLength,
          filename: "NoLock_audio.m4a",
        },
        { eventTarget: noLockBus },
      );
      assert.equal(resNoLock.mode, "opfs");
      assert.equal(noLockOpfs.files.size, 1);

      // Sweep 30m later without navigator.locks keeps file because age <= 1h
      const removedAt30m = await cleanupLeftoverYouTubeOpfsTempFiles({
        storage: noLockOpfs.storage,
        locks: null,
        now: () => noLockClock + 30 * 60_000,
      });
      assert.equal(removedAt30m, 0);
      assert.equal(noLockOpfs.files.size, 1);

      // Sweep >1h later with throwing navigator.locks falls back to age filter and deletes stale file
      const removedAfter2h = await cleanupLeftoverYouTubeOpfsTempFiles({
        storage: noLockOpfs.storage,
        locks: throwingLocks,
        now: () => noLockClock + 2 * 3_600_000,
      });
      assert.equal(removedAfter2h, 1);
      assert.equal(noLockOpfs.files.size, 0);
      await noLockTimers[0]?.fn?.();
    } finally {
      unmountNoLock();
    }
  });

  test("cleanupLeftoverYouTubeOpfsTempFiles protects Chromium .crswap swap files under parent .part Web Lock", async () => {
    const locks = createMockWebLocks();
    const opfs = createMockOpfsEnvironment(10 * 1024 * 1024);
    const oldMtime = 1_000_000;
    opfs.files.set("dokitool-yt-tmp-longwrite.part", new Uint8Array(0));
    opfs.lastModifiedMap.set("dokitool-yt-tmp-longwrite.part", oldMtime);
    opfs.files.set(
      "dokitool-yt-tmp-longwrite.part.crswap",
      new Uint8Array(4096),
    );
    opfs.lastModifiedMap.set("dokitool-yt-tmp-longwrite.part.crswap", oldMtime);

    let releaseParentLock;
    const hold = new Promise((r) => {
      releaseParentLock = r;
    });
    let grantedResolve;
    const granted = new Promise((r) => {
      grantedResolve = r;
    });
    void locks.request(
      "dokitool-yt-tmp-longwrite.part",
      { mode: "exclusive" },
      () => {
        grantedResolve();
        return hold;
      },
    );
    await granted;

    const removedWhileLocked = await cleanupLeftoverYouTubeOpfsTempFiles({
      storage: opfs.storage,
      locks,
      now: () => oldMtime + OPFS_STALE_TEMP_MAX_AGE_MS + 60_000,
    });
    assert.equal(removedWhileLocked, 0);
    assert.equal(opfs.files.has("dokitool-yt-tmp-longwrite.part.crswap"), true);

    releaseParentLock();
    await new Promise((r) => setTimeout(r, 5));

    const removedAfterUnlock = await cleanupLeftoverYouTubeOpfsTempFiles({
      storage: opfs.storage,
      locks,
      now: () => oldMtime + OPFS_STALE_TEMP_MAX_AGE_MS + 60_000,
    });
    assert.equal(removedAfterUnlock, 2);
    assert.equal(opfs.files.size, 0);
  });

  test("Track 1 YouTube UI polish: result-oriented labels, combined estimated size, dynamic primary CTA, codec humanization, copy-url preservation, and genuine silent fallback", async () => {
    setupEnvironment();
    const mediaSourcesMod = await vite.ssrLoadModule("/src/utils/mediaSources.ts");
    const mediaContractMod = await vite.ssrLoadModule("/src/utils/mediaContract.ts");
    const apiConfigMod = await vite.ssrLoadModule("/src/services/apiConfig.ts");
    const ytHelperCoreMod = await vite.ssrLoadModule("/src/utils/youtubeHelperCore.js");
    const { loadSfc } = await import("./helpers/loadSfc.mjs");
    const ClientResultSection = await loadSfc(
      new URL("../src/components/ResultSection.vue", import.meta.url),
      {
        modules: {
          "./AppIcon.vue": { default: { render: (_, { attrs }) => h("i", attrs) } },
          "../utils/mediaSources": mediaSourcesMod,
          "../utils/mediaContract": mediaContractMod,
          "../utils/youtubeHelperCore": ytHelperCoreMod,
          "../services/apiConfig": apiConfigMod,
        },
      },
    );

    const mountInteractiveResult = async (resultData, initialLocale = "zh-CN") => {
      const store = reactive({ resultData, resultVersion: 1 });
      const selection = markRaw(selectionMod.useVideoSelection({ videoStore: store }));
      selection.syncResult();
      const copied = [];
      const mainDownloads = [];
      const localeRef = ref(initialLocale);

      const element = (type, text = "") =>
        markRaw({
          type,
          text,
          props: {},
          children: [],
          parent: null,
          style: {},
          dataset: {},
          removeAttribute() {},
          getAttribute(name) {
            return this.props[name];
          },
        });
      const detach = (node) => {
        if (node.parent) {
          node.parent.children = node.parent.children.filter((item) => item !== node);
        }
        node.parent = null;
      };
      const portal = element("portal");
      const renderer = createRenderer({
        querySelector: () => portal,
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
        patchProp(node, key, _, value) {
          node.props[key] = value;
          if (key === "src") node.src = value;
        },
      });
      const root = element("root");
      const app = renderer.createApp({
        render: () =>
          h(ClientResultSection, {
            resultData: store.resultData,
            resultVersion: store.resultVersion,
            locale: localeRef.value,
            selection,
            isDownloading: false,
            resolvingIds: new Set(),
            formatNumber: String,
            formatDuration: String,
            onSwitchVideo(choice) {
              selection.choose(choice);
            },
            onCopyUrl(url) {
              copied.push(url);
            },
            onDownloadMain() {
              mainDownloads.push(selection.currentTarget.value?.variant?.id);
            },
          }),
      });
      app.mount(root);
      await nextTick();
      const hasClass = (node, cls) =>
        String(node.props?.class || "")
          .split(/\s+/)
          .includes(cls);
      const findAll = (node, pred) => [
        ...(pred(node) ? [node] : []),
        ...(node.children || []).flatMap((c) => findAll(c, pred)),
      ];
      const textOf = (node) =>
        node ? [node.text || "", ...(node.children || []).map(textOf)].join("") : "";
      return {
        app,
        store,
        selection,
        localeRef,
        copied,
        mainDownloads,
        root,
        findAll,
        textOf,
        byClass: (cls) => findAll(root, (n) => hasClass(n, cls)),
      };
    };

    const url4k = makeItagUrl(401, 90_000_000);
    const url2kWebm = makeItagUrl(271, 50_000_000);
    const url1080 = makeItagUrl(299, 35_000_000);
    const url720 = makeItagUrl(136, 18_000_000);
    const urlAdaptive = makeItagUrl(398, 15_000_000);
    const url360 = itag18Url;
    const urlM4a = makeItagUrl(140, 7_000_000);
    const urlOpusNoSize =
      "https://rr1---sn-ajoguc-5t.googlevideo.com/videoplayback?expire=1794238131&itag=251&id=o-AOdRLkc6ecTboXRtJhNBILt2v8AQeJUCoLbqEckV1dDI";
    const urlAudioGeneric = makeItagUrl(139, 3_000_000);

    const pairedData = {
      platform: "youtube",
      content_id: "I9JvDaciaFk",
      source_url: "https://www.youtube.com/watch?v=I9JvDaciaFk",
      title: "Sample 4K YouTube",
      default_item_id: "yt-v1",
      extra: {
        youtube_helper: {
          status: "ready",
          provider: "extension",
          version: LATEST_EXTENSION_VERSION,
          extensionVersion: LATEST_EXTENSION_VERSION,
        },
      },
      items: [
        {
          id: "yt-v1",
          type: "video",
          state: "ready",
          default: { variant_id: "v-360", source_id: "s-360", url: url360 },
          variants: [
            {
              id: "v-4k",
              label: "2026p60 (4K · 仅视频无声)",
              metadata: {
                width: 3840,
                height: 2026,
                fps: 60,
                has_audio: false,
                video_codec: "av01.0.13M.08",
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [{ id: "s-4k", url: url4k, size_bytes: 90_000_000 }],
              },
            },
            {
              id: "v-2k-webm",
              label: "1440p60 (2K · 仅视频无声)",
              metadata: {
                width: 2560,
                height: 1440,
                fps: 60,
                has_audio: false,
                video_codec: "vp09.00.51.08",
                container: "webm",
                extension: "webm",
                mime_type: "video/webm",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [{ id: "s-2k", url: url2kWebm, size_bytes: 50_000_000 }],
              },
            },
            {
              id: "v-1080-crop",
              label: "1012p60 (仅视频无声)",
              metadata: {
                width: 1920,
                height: 1012,
                fps: 60,
                has_audio: false,
                video_codec: "avc1.64002A",
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [{ id: "s-1080", url: url1080, size_bytes: 35_000_000 }],
              },
            },
            {
              id: "v-720",
              label: "720p (仅视频无声)",
              metadata: {
                width: 1280,
                height: 720,
                fps: 30,
                has_audio: false,
                video_codec: "avc1.4d401f",
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [{ id: "s-720", url: url720, size_bytes: 18_000_000 }],
              },
            },
            {
              id: "v-adaptive",
              label: "自适应 (仅视频无声)",
              metadata: {
                has_audio: false,
                video_codec: "avc1.42001E",
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [{ id: "s-adaptive", url: urlAdaptive }],
              },
            },
            {
              id: "v-360",
              label: "360p (含音频)",
              metadata: {
                width: 640,
                height: 360,
                fps: 30,
                has_audio: true,
                video_codec: "avc1.42001E",
                audio_codec: "mp4a.40.2",
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [{ id: "s-360", url: url360, size_bytes: 12_000_000 }],
              },
            },
            {
              id: "v-m4a",
              label: "仅音频 M4A (128 kbps)",
              metadata: {
                has_audio: true,
                audio_codec: "mp4a.40.2",
                container: "m4a",
                extension: "m4a",
                mime_type: "audio/mp4",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [{ id: "s-m4a", url: urlM4a, size_bytes: 7_000_000 }],
              },
            },
            {
              id: "v-webm-audio",
              label: "仅音频 WEBM (160 kbps)",
              metadata: {
                has_audio: true,
                audio_codec: "opus",
                container: "webm",
                extension: "webm",
                mime_type: "audio/webm",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [{ id: "s-opus", url: urlOpusNoSize }],
              },
            },
            {
              id: "v-generic-audio",
              label: "音轨",
              metadata: {
                has_audio: true,
                audio_codec: "opus",
                mime_type: "audio/ogg",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [{ id: "s-gen-audio", url: urlAudioGeneric, size_bytes: 3_000_000 }],
              },
            },
          ],
        },
      ],
    };

    const view = await mountInteractiveResult(pairedData, "zh-CN");
    try {
      // Top dual-banner slimming: ready pill in header, no full-row .rs-yt-helper-notice
      assert.equal(view.byClass("rs-yt-helper-notice").length, 0);
      assert.equal(
        view.textOf(view.byClass("rs-header-hint")[0]),
        `扩展 v${LATEST_EXTENSION_VERSION} 已就绪 · 无损合流`,
      );
      // No "切 360p 听声" button and only 1 <video> element (zero dual-track <audio> sync element in stage)
      assert.ok(!view.textOf(view.root).includes("切 360p"));
      const stage = view.byClass("rs-video-stage")[0];
      assert.equal(view.findAll(stage, (n) => n.type === "video").length, 1);
      assert.equal(view.findAll(stage, (n) => n.type === "audio").length, 0);

      // Open 画质选项 tab
      const backupTab = view
        .byClass("rs-tab")
        .find((n) => view.textOf(n).includes("画质选项"));
      backupTab.props.onClick();
      await nextTick();

      assert.equal(view.byClass("rs-backup-split-actions").length, 0);
      assert.equal(view.textOf(view.byClass("rs-backup-playing")[0]), "当前已选");

      const cardNames = view.byClass("rs-backup-name").map(view.textOf);
      assert.ok(
        cardNames.every((name) => !name.includes("仅视频无声")),
        `paired YouTube quality list must not show 仅视频无声: ${JSON.stringify(cardNames)}`,
      );
      assert.deepEqual(cardNames, [
        "约 97.0 MB · 2026p60 (4K)",
        "50.0 MB · 1440p60 (2K)",
        "约 42.0 MB · 1012p60",
        "约 25.0 MB · 720p",
        "12.0 MB · 360p (含音频)",
        "大小未知 · 自适应",
        "大小未知 · 仅音频 WEBM (160 kbps)",
        "7.0 MB · 仅音频 M4A (128 kbps)",
        "3.0 MB · 音轨",
      ]);

      // Codec tags show human-readable labels and retain raw codec string in title
      const codecTags = view
        .byClass("rs-backup-meta-tag")
        .filter((n) => n.props.title);
      assert.ok(
        codecTags.some(
          (n) => view.textOf(n) === "AV1" && n.props.title === "av01.0.13M.08",
        ),
      );
      assert.ok(
        codecTags.some(
          (n) => view.textOf(n) === "VP9" && n.props.title === "vp09.00.51.08",
        ),
      );
      assert.ok(
        codecTags.some(
          (n) => view.textOf(n) === "H.264" && n.props.title === "avc1.64002A",
        ),
      );
      assert.ok(
        codecTags.some(
          (n) => view.textOf(n) === "AAC" && n.props.title === "mp4a.40.2",
        ),
      );
      assert.ok(
        codecTags.some(
          (n) => view.textOf(n) === "Opus" && n.props.title === "opus",
        ),
      );

      const primaryBtn = () => view.byClass("rs-btn--primary")[0];
      const qualityTag = () => view.byClass("rs-quality-tag")[0];

      // Dynamic primary CTA + .rs-quality-tag across tiers and audio formats
      for (const [variantId, expectedBtnZh, expectedTagZh, expectedBtnEn] of [
        [
          "v-4k",
          "下载 4K 有声视频",
          "2026p60 · 4K（预览无声 · 下载含音频）",
          "Download 4K Video with Audio",
        ],
        [
          "v-2k-webm",
          "下载 2K 有声视频",
          "1440p60 · 2K（预览无声 · 下载含音频）",
          "Download 2K Video with Audio",
        ],
        [
          "v-1080-crop",
          "下载 1080p 有声视频",
          "1012p60（预览无声 · 下载含音频）",
          "Download 1080p Video with Audio",
        ],
        [
          "v-720",
          "下载 720p 有声视频",
          "720p（预览无声 · 下载含音频）",
          "Download 720p Video with Audio",
        ],
        [
          "v-adaptive",
          "下载有声视频",
          "自适应（预览无声 · 下载含音频）",
          "Download Video with Audio",
        ],
        [
          "v-m4a",
          "下载音频 (M4A)",
          "仅音频 M4A (128 kbps)",
          "Download Audio (M4A)",
        ],
        [
          "v-webm-audio",
          "下载音频 (WEBM)",
          "仅音频 WEBM (160 kbps)",
          "Download Audio (WEBM)",
        ],
        [
          "v-generic-audio",
          "下载音频",
          "音轨",
          "Download Audio",
        ],
      ]) {
        view.localeRef.value = "zh-CN";
        view.selection.choose({ variant_id: variantId });
        await nextTick();
        assert.equal(view.textOf(primaryBtn()), expectedBtnZh);
        assert.equal(view.textOf(qualityTag()), expectedTagZh);

        view.localeRef.value = "en";
        await nextTick();
        assert.equal(view.textOf(primaryBtn()), expectedBtnEn);
      }

      // Copy URL button on split 4K stream remains clickable and emits copy-url with activeVideoUrl
      view.localeRef.value = "zh-CN";
      view.selection.choose({ variant_id: "v-4k", source_id: "s-4k" });
      await nextTick();
      const copyBtn = view.findAll(
        view.root,
        (n) => n.type === "button" && view.textOf(n) === "复制链接",
      )[0];
      assert.ok(copyBtn);
      assert.equal(Boolean(copyBtn.props.disabled), false);
      copyBtn.props.onClick();
      assert.deepEqual(view.copied, [url4k]);

      // Clicking primary download button still invokes download-main
      primaryBtn().props.onClick();
      assert.deepEqual(view.mainDownloads, ["v-4k"]);
    } finally {
      view.app.unmount();
    }

    // Genuine silent YouTube video (no paired audio track) -> honestly preserves 仅视频无声 and never promises audio
    const genuineSilentData = {
      ...pairedData,
      items: [
        {
          id: "yt-silent",
          type: "video",
          state: "ready",
          default: { variant_id: "v-4k", source_id: "s-4k", url: url4k },
          variants: [pairedData.items[0].variants[0], pairedData.items[0].variants[2]],
        },
      ],
      default_item_id: "yt-silent",
    };
    const silentView = await mountInteractiveResult(genuineSilentData, "zh-CN");
    try {
      const backupTab = silentView
        .byClass("rs-tab")
        .find((n) => silentView.textOf(n).includes("画质选项"));
      backupTab.props.onClick();
      await nextTick();
      assert.deepEqual(
        silentView.byClass("rs-backup-name").map(silentView.textOf),
        [
          "90.0 MB · 2026p60 (4K · 仅视频无声)",
          "35.0 MB · 1012p60 (仅视频无声)",
        ],
      );
      assert.equal(
        silentView.textOf(silentView.byClass("rs-quality-tag")[0]),
        "2026p60 (4K · 仅视频无声)",
      );
      assert.equal(
        silentView.textOf(silentView.byClass("rs-btn--primary")[0]),
        "下载视频",
      );
      assert.ok(
        !silentView
          .textOf(silentView.byClass("rs-quality-tag")[0])
          .includes("下载含音频"),
      );
    } finally {
      silentView.app.unmount();
    }
  });

  test("ResultDetailsSidebar music tab blocks background_audio playback and disables download when youtube_helper is missing, outdated, or login_required without leaking fallthrough prop", async () => {
    setupEnvironment();
    const mediaSourcesMod = await vite.ssrLoadModule("/src/utils/mediaSources.ts");
    const mediaContractMod = await vite.ssrLoadModule("/src/utils/mediaContract.ts");
    const apiConfigMod = await vite.ssrLoadModule("/src/services/apiConfig.ts");
    const ytHelperCoreMod = await vite.ssrLoadModule("/src/utils/youtubeHelperCore.js");
    const { loadSfc } = await import("./helpers/loadSfc.mjs");
    const ClientResultSection = await loadSfc(
      new URL("../src/components/ResultSection.vue", import.meta.url),
      {
        modules: {
          "./AppIcon.vue": { default: { render: (_, { attrs }) => h("i", attrs) } },
          "../utils/mediaSources": mediaSourcesMod,
          "../utils/mediaContract": mediaContractMod,
          "../utils/youtubeHelperCore": ytHelperCoreMod,
          "../services/apiConfig": apiConfigMod,
        },
      },
    );

    const bgmUrl = makeItagUrl(140, 7_000_000);
    const buildDataForHelperStatus = (status) => ({
      platform: "youtube",
      content_id: "I9JvDaciaFk",
      source_url: "https://www.youtube.com/watch?v=I9JvDaciaFk",
      title: "Sample YouTube With BGM",
      default_item_id: "yt-v1",
      extra: {
        youtube_helper: {
          status,
          provider: "extension",
          version: status === "outdated" ? "4.1.0" : LATEST_EXTENSION_VERSION,
          min_version: MIN_YOUTUBE_HELPER_VERSION,
        },
      },
      attachments: [
        {
          id: "att-bgm-1",
          role: "background_audio",
          title: "Sample Background Audio",
          author: { name: "Sample Artist" },
          resource: {
            role: "audio",
            delivery: {
              kind: "file",
              sources: [{ id: "s-bgm", url: bgmUrl, size_bytes: 7_000_000 }],
            },
          },
        },
      ],
      items: [
        {
          id: "yt-v1",
          type: "video",
          state: "ready",
          default: { variant_id: "v-360", source_id: "s-360", url: itag18Url },
          variants: [
            {
              id: "v-360",
              label: "360p (含音频)",
              metadata: {
                width: 640,
                height: 360,
                fps: 30,
                has_audio: true,
                video_codec: "avc1.42001E",
                audio_codec: "mp4a.40.2",
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
                evidence: "upstream",
              },
              delivery: {
                kind: "file",
                sources: [{ id: "s-360", url: itag18Url, size_bytes: 12_000_000 }],
              },
            },
          ],
        },
      ],
    });

    const mountWithStatus = async (status) => {
      const store = reactive({
        resultData: buildDataForHelperStatus(status),
        resultVersion: 1,
      });
      const selection = markRaw(
        selectionMod.useVideoSelection({ videoStore: store }),
      );
      selection.syncResult();
      const musicDownloads = [];

      const element = (type, text = "") =>
        markRaw({
          type,
          text,
          props: {},
          children: [],
          parent: null,
          style: {},
          dataset: {},
          removeAttribute(name) {
            delete this.props[name];
          },
          getAttribute(name) {
            return this.props[name];
          },
        });
      const detach = (node) => {
        if (node.parent) {
          node.parent.children = node.parent.children.filter(
            (item) => item !== node,
          );
        }
        node.parent = null;
      };
      const portal = element("portal");
      const renderer = createRenderer({
        querySelector: () => portal,
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
        patchProp(node, key, _, value) {
          if (value === undefined || value === null) delete node.props[key];
          else node.props[key] = value;
          if (key === "src") node.src = value;
        },
      });
      const root = element("root");
      const app = renderer.createApp({
        render: () =>
          h(ClientResultSection, {
            resultData: store.resultData,
            resultVersion: store.resultVersion,
            locale: "zh-CN",
            selection,
            isDownloading: false,
            resolvingIds: new Set(),
            formatNumber: String,
            formatDuration: String,
            onDownloadMusic(attachment) {
              musicDownloads.push(attachment.id);
            },
          }),
      });
      app.mount(root);
      await nextTick();
      const hasClass = (node, cls) =>
        String(node.props?.class || "")
          .split(/\s+/)
          .includes(cls);
      const findAll = (node, pred) => [
        ...(pred(node) ? [node] : []),
        ...(node.children || []).flatMap((c) => findAll(c, pred)),
      ];
      const textOf = (node) =>
        node
          ? [node.text || "", ...(node.children || []).map(textOf)].join("")
          : "";
      return {
        app,
        root,
        musicDownloads,
        findAll,
        textOf,
        byClass: (cls) => findAll(root, (n) => hasClass(n, cls)),
      };
    };

    for (const blockedStatus of ["missing", "outdated", "login_required"]) {
      const view = await mountWithStatus(blockedStatus);
      try {
        const infoCol = view.byClass("rs-info-col")[0];
        assert.ok(infoCol, `expected .rs-info-col for status=${blockedStatus}`);
        assert.equal(
          "is-youtube-helper-blocked" in infoCol.props,
          false,
          `must not leak fallthrough is-youtube-helper-blocked attr on .rs-info-col (${blockedStatus})`,
        );
        assert.equal(
          "isYoutubeHelperBlocked" in infoCol.props,
          false,
          `must not leak fallthrough isYoutubeHelperBlocked attr on .rs-info-col (${blockedStatus})`,
        );

        const musicTab = view
          .byClass("rs-tab")
          .find((n) => view.textOf(n).includes("音乐"));
        assert.ok(musicTab, `expected 音乐 tab for status=${blockedStatus}`);
        musicTab.props.onClick();
        await nextTick();

        const musicCard = view.byClass("rs-music")[0];
        assert.ok(musicCard, `expected .rs-music card for status=${blockedStatus}`);
        assert.equal(
          view.findAll(musicCard, (n) => n.type === "audio").length,
          0,
          `blocked status=${blockedStatus} must not render <audio>`,
        );
        assert.ok(
          view.textOf(musicCard).includes("该附件暂不支持直接播放"),
          `blocked status=${blockedStatus} must render fallback note`,
        );
        const dlBtn = view.findAll(
          musicCard,
          (n) => n.type === "button" && view.textOf(n).includes("下载附件"),
        )[0];
        assert.ok(dlBtn);
        assert.equal(
          dlBtn.props.disabled,
          true,
          `blocked status=${blockedStatus} must disable attachment download button`,
        );
      } finally {
        view.app.unmount();
      }
    }

    const readyView = await mountWithStatus("ready");
    try {
      const infoCol = readyView.byClass("rs-info-col")[0];
      assert.equal("is-youtube-helper-blocked" in infoCol.props, false);

      const musicTab = readyView
        .byClass("rs-tab")
        .find((n) => readyView.textOf(n).includes("音乐"));
      assert.ok(musicTab);
      musicTab.props.onClick();
      await nextTick();

      const musicCard = readyView.byClass("rs-music")[0];
      assert.ok(musicCard);
      const audioEls = readyView.findAll(musicCard, (n) => n.type === "audio");
      assert.equal(audioEls.length, 1, "ready status must render <audio>");
      assert.equal(audioEls[0].props.src, bgmUrl);

      const dlBtn = readyView.findAll(
        musicCard,
        (n) => n.type === "button" && readyView.textOf(n).includes("下载附件"),
      )[0];
      assert.ok(dlBtn);
      assert.equal(
        Boolean(dlBtn.props.disabled),
        false,
        "ready status must enable attachment download button",
      );
      dlBtn.props.onClick();
      assert.deepEqual(readyView.musicDownloads, ["att-bgm-1"]);
    } finally {
      readyView.app.unmount();
    }
  });

  test("Issue #48 [P0-2] Spec B.2: 2 MiB/1 MiB/512 KiB chunk geometry, met-gate waiting statusText, monotonic inFlightLoaded progress on retry, and 200ms throttle", async () => {
    assert.equal(DEFAULT_MUX_CHUNK_BYTES, 2 * 1024 * 1024);
    assert.equal(DEFAULT_MUX_AUDIO_CHUNK_BYTES, 1 * 1024 * 1024);
    assert.equal(DEFAULT_MUX_INITIAL_CHUNK_BYTES, 512 * 1024);
    assert.equal(DEFAULT_MUX_PROGRESS_THROTTLE_MS, 200);

    // Build deterministic byte stream spanning chunk 0 (512B), chunk 1 (2048B), chunk 2 (2048B), chunk 3 (392B) = 5000B
    const totalBytes = 5000;
    const expectedBytes = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes; i++) expectedBytes[i] = (i * 31 + 7) & 0xff;

    let fakeNow = 10_000;
    const metSec = (fakeNow - 1500) / 1000; // met + 4.5s -> waitMs = 3000ms (> 300ms)
    const testUrl = `https://rr1---sn-test.googlevideo.com/videoplayback?itag=18&clen=${totalBytes}&met=${metSec.toFixed(2)}`;
    const observedRanges = [];
    let chunk1Attempts = 0;
    let savedBuffer = null;

    const eventTarget = new EventTarget();
    const progressEvents = [];
    eventTarget.addEventListener("dokitool:youtube-helper:progress", (ev) => {
      const detail = typeof ev.detail === "string" ? JSON.parse(ev.detail) : ev.detail;
      progressEvents.push(detail);
    });

    const controller = createUserscriptController({
      eventTarget,
      now: () => fakeNow,
      opfsStorage: null,
      saveBuffer(buf) {
        savedBuffer = new Uint8Array(buf);
      },
      muxConfig: {
        chunkSize: 2048,
        initialChunkSize: 512,
        videoConcurrency: 1,
        maxRetries: 1,
        retryBaseDelayMs: 1,
        progressThrottleMs: 200,
      },
      gmXmlhttpRequest(details) {
        const u = new URL(details.url);
        const range = u.searchParams.get("range") || "";
        observedRanges.push(range);
        const [startStr, endStr] = range.split("-");
        const start = Number(startStr);
        const end = Number(endStr);
        const slice = expectedBytes.slice(start, end + 1);

        queueMicrotask(() => {
          // Simulate chunk 1 failing halfway on first attempt to verify monotonic progress clamp!
          if (start === 512 && chunk1Attempts === 0) {
            chunk1Attempts++;
            fakeNow += 250;
            details.onprogress?.({ loaded: 1200, total: slice.byteLength, lengthComputable: true });
            details.onerror?.(new Error("transient chunk drop"));
            return;
          }
          // Simulate 2 incremental in-flight ticks before chunk completion
          fakeNow += 250;
          details.onprogress?.({ loaded: Math.floor(slice.byteLength / 2), total: slice.byteLength, lengthComputable: true });
          // Within 200ms throttle window -> should be coalesced
          fakeNow += 50;
          details.onprogress?.({ loaded: Math.floor(slice.byteLength * 0.75), total: slice.byteLength, lengthComputable: true });
          fakeNow += 250;
          details.onload?.({
            status: 206,
            statusText: "Partial Content",
            finalUrl: details.url,
            responseHeaders: `content-range: bytes ${start}-${end}/${totalBytes}`,
            response: slice.buffer,
            responseText: "",
          });
        });
        return { abort() {} };
      },
    });
    const unmount = controller.mount();
    try {
      // Advance clock right as met-gate sleep starts so abortableSleep finishes fast? Note: setTimeout uses real timers,
      // so test ensureMetGate with waitMs=350ms (triggers >300ms statusText cleanly in ~350ms!).
      const fastMetSec = (fakeNow - 4150) / 1000; // met + 4.5s - fakeNow = 350ms
      const fastUrl = `https://rr1---sn-test.googlevideo.com/videoplayback?itag=18&clen=${totalBytes}&met=${fastMetSec.toFixed(3)}`;
      const res = await sendHelperRequest(
        "download",
        { url: fastUrl, filename: "smooth_test.mp4", size: totalBytes },
        { eventTarget, timeoutMs: 10_000 },
      );
      assert.equal(res.filename, "smooth_test.mp4");
      assert.ok(savedBuffer, "must produce exact saved output buffer");
      assert.deepEqual(savedBuffer, expectedBytes, "chunk 0 (512B) + 2048B chunks must reassemble byte-for-byte");

      // Exact chunk range geometry: 0-511, 512-2559 (retried), 2560-4607, 4608-4999
      assert.equal(observedRanges[0], "0-511", "chunk 0 must use fast 512B initialChunkSize");
      assert.ok(observedRanges.includes("512-2559"));
      assert.ok(observedRanges.includes("2560-4607"));
      assert.ok(observedRanges.includes("4608-4999"));

      // Met-gate waiting statusText emitted before sleep
      assert.ok(
        progressEvents.some((e) => typeof e.statusText === "string" && e.statusText.includes("等待媒体节点就绪")),
        "ensureMetGate (>300ms) must emit waiting statusText immediately",
      );

      // In-flight incremental progress emitted AND strictly monotonic despite chunk 1 retry
      assert.ok(progressEvents.length >= 6, `expected incremental progress ticks, got ${progressEvents.length}`);
      for (let i = 1; i < progressEvents.length; i++) {
        assert.ok(
          progressEvents[i].loaded >= progressEvents[i - 1].loaded,
          `loaded bytes must remain monotonic across chunk retries (idx=${i}: ${progressEvents[i].loaded} < ${progressEvents[i - 1].loaded})`,
        );
      }
      // Verify at least one in-flight intermediate loaded value appeared (not just chunk-end boundaries)
      assert.ok(
        progressEvents.some((e) => e.loaded > 0 && e.loaded < 512),
        "must report in-flight progress before chunk 0 completes",
      );
      void testUrl;
    } finally {
      unmount();
    }
  });
});
