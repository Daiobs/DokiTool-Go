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

test("[PR-A Item 4a] Multi-Range concurrent OPFS transfer: out-of-order chunk assembly, maxConcurrency clamping <= 4, realistic 20 MiB direct_file & in-memory fallback writeAt", async () => {
  // 1) Unit matrix: unknown size, out-of-order chunk arrival, maxConcurrency=99 clamped to 4, monotonic progress, exact SHA-256
  {
    const payload = makeDeterministicPayload(16_384, 41); // 8 x 2 KiB chunks
    const expectedSha = sha256Hex(payload);
    const opfs = createMockOpfs();
    let inFlight = 0;
    let maxInFlight = 0;
    const progressEvents = [];
    const chunkRanges = [];

    const result = await opfsStreamTransferMod.streamResumableRouteToOpfs({
      taskId: "range-unit-ooo",
      routes: ["https://upos-sz-mirrorcos.bilivideo.com/ooo.mp4"],
      spec: {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/ooo.mp4"],
        filename: "ooo.mp4",
      },
      openOpfsSink: makeTestOpfsSink(opfs),
      signal: new AbortController().signal,
      maxConcurrency: 99, // must clamp to 4
      rangeChunkSizeBytes: 2048,
      minParallelRangeBytes: 4096,
      onProgress(evt) {
        progressEvents.push(evt);
      },
      fetchFn: async (_url, init) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          const parsed = parseTestRangeHeader(init?.headers?.Range);
          assert.ok(parsed, "must send Range header");
          const start = parsed.start;
          const end = Math.min(payload.byteLength - 1, parsed.end ?? payload.byteLength - 1);
          chunkRanges.push([start, end]);
          // Reverse delay for chunks 1..7 so later chunks arrive BEFORE earlier chunks
          const chunkIdx = Math.floor(start / 2048);
          const delayMs = chunkIdx === 0 ? 1 : Math.max(2, (8 - chunkIdx) * 8);
          await new Promise((r) => setTimeout(r, delayMs));
          const slice = payload.subarray(start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": `bytes ${start}-${end}/${payload.byteLength}`,
              "Content-Length": String(slice.byteLength),
            },
          });
        } finally {
          inFlight -= 1;
        }
      },
    });

    const blob = await result.sink.closeAndGetBlob();
    const outBytes = new Uint8Array(await blob.arrayBuffer());
    await result.sink.cleanup();

    assert.equal(result.parallelUsed, true);
    assert.equal(result.chunkCount, 8);
    assert.equal(maxInFlight, 4, "maxConcurrency=99 must clamp strictly to 4");
    assert.equal(sha256Hex(outBytes), expectedSha, "out-of-order parallel assembly SHA-256 mismatch");
    assert.equal(opfs.files.size, 0);
    // Verify monotonic progress ending at full byteLength
    for (let i = 1; i < progressEvents.length; i++) {
      assert.ok(
        progressEvents[i].loaded >= progressEvents[i - 1].loaded,
        `progress must be monotonic: ${progressEvents[i - 1].loaded} -> ${progressEvents[i].loaded}`,
      );
    }
    assert.equal(progressEvents[progressEvents.length - 1].loaded, payload.byteLength);
    assert.equal(progressEvents[progressEvents.length - 1].total, payload.byteLength);
  }

  // 2) Full executeDirectFile with realistic 20 MiB buffer (default 4 MiB chunks, 8 MiB threshold, unknown sizeBytes)
  {
    const payload = makeDeterministicPayload(20 * 1024 * 1024, 93);
    const expectedSha = sha256Hex(payload);
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const errors = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let handedBytes = null;

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (_url, init) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          const parsed = parseTestRangeHeader(init?.headers?.Range);
          assert.ok(parsed, "20 MiB unknown-size direct_file must probe with Range");
          const start = parsed.start;
          const end = Math.min(payload.byteLength - 1, parsed.end ?? payload.byteLength - 1);
          // Hold parallel chunks briefly so all 4 workers overlap deterministically
          await new Promise((r) => setTimeout(r, start === 0 ? 1 : 25));
          const slice = payload.subarray(start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": `bytes ${start}-${end}/${payload.byteLength}`,
              "Content-Length": String(slice.byteLength),
            },
          });
        } finally {
          inFlight -= 1;
        }
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
        return { chromeDownloadId: 401 };
      },
    });
    try {
      executor.startTask("direct-20mib-parallel", {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://f.video.weibocdn.com/o0/large-20mib.mp4"],
        filename: "large-20mib.mp4",
        mimeType: "video/mp4",
      });
      await executor.waitForIdle();
      assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
      assert.equal(maxInFlight, 4, "20 MiB direct_file must hit 4 concurrent Range workers");
      assert.ok(handedBytes);
      assert.equal(handedBytes.byteLength, payload.byteLength);
      assert.equal(sha256Hex(handedBytes), expectedSha);
      assert.equal(opfs.files.size, 0, "0 OPFS residue after 20 MiB parallel download");
    } finally {
      executor.dispose();
    }
  }

  // 3) Full executeDirectFile with in-memory fallback sink (opfsStorage: null) + out-of-order 12 MiB parallel writeAt
  {
    const payload = makeDeterministicPayload(12 * 1024 * 1024, 55);
    const expectedSha = sha256Hex(payload);
    const urlApi = createTrackedUrlApi();
    const errors = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let handedBytes = null;

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (_url, init) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          const parsed = parseTestRangeHeader(init?.headers?.Range);
          assert.ok(parsed);
          const start = parsed.start;
          const end = Math.min(payload.byteLength - 1, parsed.end ?? payload.byteLength - 1);
          // Chunk 2 arrives before Chunk 1!
          await new Promise((r) => setTimeout(r, start === 0 ? 1 : start === 4 * 1024 * 1024 ? 30 : 5));
          const slice = payload.subarray(start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": `bytes ${start}-${end}/${payload.byteLength}`,
              "Content-Length": String(slice.byteLength),
            },
          });
        } finally {
          inFlight -= 1;
        }
      },
      opfsStorage: null,
      webLocks: null,
      urlApi,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload(msg) {
        const blob = urlApi.activeBlobs.get(msg.blobUrl);
        handedBytes = new Uint8Array(await blob.arrayBuffer());
        setTimeout(() => {
          executor.releaseBlob({ taskId: msg.taskId, blobUrl: msg.blobUrl });
        }, 0);
        return { chromeDownloadId: 402 };
      },
    });
    try {
      executor.startTask("direct-12mib-mem-fallback", {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://f.video.weibocdn.com/o0/mem-12mib.mp4"],
        filename: "mem-12mib.mp4",
        mimeType: "video/mp4",
      });
      await executor.waitForIdle();
      assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
      assert.equal(maxInFlight, 2);
      assert.equal(sha256Hex(handedBytes), expectedSha);
    } finally {
      executor.dispose();
    }
  }
});

test("[PR-A Item 4b & 4c] Probe fallbacks (200 OK zero-waste, 416, gzip 206, malformed 206), small 206 (< threshold), known-small skip, and sink-without-writeAt", async () => {
  const baseSpec = {
    kind: "direct_file",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://upos-sz-mirrorcos.bilivideo.com/probe-test.mp4"],
    filename: "probe-test.mp4",
  };

  // 1) Server ignores Range and returns 200 OK -> zero-waste 1x stream (1 fetch total!)
  {
    const payload = makeDeterministicPayload(12_000, 11);
    const opfs = createMockOpfs();
    let calls = 0;
    const result = await opfsStreamTransferMod.streamResumableRouteToOpfs({
      taskId: "probe-200",
      routes: baseSpec.routes,
      spec: baseSpec,
      openOpfsSink: makeTestOpfsSink(opfs),
      signal: new AbortController().signal,
      maxConcurrency: 4,
      rangeChunkSizeBytes: 2048,
      minParallelRangeBytes: 4096,
      fetchFn: async (_url, init) => {
        calls += 1;
        assert.equal(init?.headers?.Range, "bytes=0-2047");
        return new Response(payload, {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(payload.byteLength),
          },
        });
      },
    });
    const out = new Uint8Array(await (await result.sink.closeAndGetBlob()).arrayBuffer());
    await result.sink.cleanup();
    assert.equal(calls, 1, "200 OK probe must stream in 1 request with zero wasted bytes");
    assert.equal(result.parallelUsed, false);
    assert.equal(sha256Hex(out), sha256Hex(payload));
    assert.equal(opfs.files.size, 0);
  }

  // 2) 416, non-identity Content-Encoding (gzip), and malformed Content-Range (*) on probe -> clean plain GET 1x fallback
  for (const mode of ["416", "gzip-206", "star-total-206"]) {
    const payload = makeDeterministicPayload(10_000, 23);
    const opfs = createMockOpfs();
    const seenRanges = [];
    const result = await opfsStreamTransferMod.streamResumableRouteToOpfs({
      taskId: `probe-fallback-${mode}`,
      routes: baseSpec.routes,
      spec: baseSpec,
      openOpfsSink: makeTestOpfsSink(opfs),
      signal: new AbortController().signal,
      maxConcurrency: 4,
      rangeChunkSizeBytes: 2048,
      minParallelRangeBytes: 4096,
      fetchFn: async (_url, init) => {
        const range = init?.headers?.Range ?? null;
        seenRanges.push(range);
        if (seenRanges.length === 1) {
          assert.equal(range, "bytes=0-2047");
          if (mode === "416") {
            return new Response("Range Not Satisfiable", { status: 416 });
          }
          if (mode === "gzip-206") {
            return new Response(payload.subarray(0, 2048), {
              status: 206,
              headers: {
                "Content-Type": "video/mp4",
                "Content-Encoding": "gzip",
                "Content-Range": `bytes 0-2047/${payload.byteLength}`,
              },
            });
          }
          return new Response(payload.subarray(0, 2048), {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": "bytes 0-2047/*",
            },
          });
        }
        assert.equal(range, null, `${mode}: fallback plain GET must not send Range`);
        return new Response(payload, {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(payload.byteLength),
          },
        });
      },
    });
    const out = new Uint8Array(await (await result.sink.closeAndGetBlob()).arrayBuffer());
    await result.sink.cleanup();
    assert.deepEqual(seenRanges, ["bytes=0-2047", null], `${mode}: expected probe then plain GET`);
    assert.equal(result.parallelUsed, false);
    assert.equal(sha256Hex(out), sha256Hex(payload));
    assert.equal(opfs.files.size, 0);
  }

  // 3) 206 probe with total < chunkSize -> finishes in 1 single request
  {
    const payload = makeDeterministicPayload(1500, 31);
    const opfs = createMockOpfs();
    let calls = 0;
    const result = await opfsStreamTransferMod.streamResumableRouteToOpfs({
      taskId: "probe-small-single",
      routes: baseSpec.routes,
      spec: baseSpec,
      openOpfsSink: makeTestOpfsSink(opfs),
      signal: new AbortController().signal,
      maxConcurrency: 4,
      rangeChunkSizeBytes: 4096,
      minParallelRangeBytes: 8192,
      fetchFn: async (_url, init) => {
        calls += 1;
        assert.equal(init?.headers?.Range, "bytes=0-4095");
        return new Response(payload, {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes 0-${payload.byteLength - 1}/${payload.byteLength}`,
            "Content-Length": String(payload.byteLength),
          },
        });
      },
    });
    const out = new Uint8Array(await (await result.sink.closeAndGetBlob()).arrayBuffer());
    await result.sink.cleanup();
    assert.equal(calls, 1);
    assert.equal(result.parallelUsed, false);
    assert.equal(result.chunkCount, 1);
    assert.equal(sha256Hex(out), sha256Hex(payload));
    assert.equal(opfs.files.size, 0);
  }

  // 4) 206 probe with chunkSize < total < minParallelRangeBytes -> sequential 1x continuation, zero wasted bytes
  {
    const payload = makeDeterministicPayload(6144, 37);
    const opfs = createMockOpfs();
    let inFlight = 0;
    let maxInFlight = 0;
    const ranges = [];
    const result = await opfsStreamTransferMod.streamResumableRouteToOpfs({
      taskId: "probe-below-threshold",
      routes: baseSpec.routes,
      spec: baseSpec,
      openOpfsSink: makeTestOpfsSink(opfs),
      signal: new AbortController().signal,
      maxConcurrency: 4,
      rangeChunkSizeBytes: 4096,
      minParallelRangeBytes: 8192,
      fetchFn: async (_url, init) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          const parsed = parseTestRangeHeader(init?.headers?.Range);
          ranges.push(init?.headers?.Range);
          const start = parsed.start;
          const end = Math.min(payload.byteLength - 1, parsed.end ?? payload.byteLength - 1);
          await new Promise((r) => setTimeout(r, 5));
          const slice = payload.subarray(start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": `bytes ${start}-${end}/${payload.byteLength}`,
              "Content-Length": String(slice.byteLength),
            },
          });
        } finally {
          inFlight -= 1;
        }
      },
    });
    const out = new Uint8Array(await (await result.sink.closeAndGetBlob()).arrayBuffer());
    await result.sink.cleanup();
    assert.equal(maxInFlight, 1, "total < minParallelRangeBytes must NOT fan out");
    assert.equal(result.parallelUsed, false);
    assert.deepEqual(ranges, ["bytes=0-4095", "bytes=4096-6143"]);
    assert.equal(sha256Hex(out), sha256Hex(payload));
    assert.equal(opfs.files.size, 0);
  }

  // 5) Sink without writeAt gracefully stays sequential (maxInFlight === 1)
  {
    const payload = makeDeterministicPayload(12_288, 43);
    const chunks = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await opfsStreamTransferMod.streamResumableRouteToOpfs({
      taskId: "no-write-at",
      routes: baseSpec.routes,
      spec: baseSpec,
      openOpfsSink: async () => ({
        async write(chunk) {
          chunks.push(chunk.slice());
        },
        async closeAndGetBlob() {
          return new Blob(chunks);
        },
        async cleanup() {
          chunks.length = 0;
        },
      }),
      signal: new AbortController().signal,
      maxConcurrency: 4,
      rangeChunkSizeBytes: 2048,
      minParallelRangeBytes: 4096,
      fetchFn: async (_url, init) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          const parsed = parseTestRangeHeader(init?.headers?.Range);
          const start = parsed.start;
          const end = Math.min(payload.byteLength - 1, parsed.end ?? payload.byteLength - 1);
          await new Promise((r) => setTimeout(r, 5));
          const slice = payload.subarray(start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": `bytes ${start}-${end}/${payload.byteLength}`,
              "Content-Length": String(slice.byteLength),
            },
          });
        } finally {
          inFlight -= 1;
        }
      },
    });
    const out = new Uint8Array(await (await result.sink.closeAndGetBlob()).arrayBuffer());
    await result.sink.cleanup();
    assert.equal(maxInFlight, 1);
    assert.equal(result.parallelUsed, false);
    assert.equal(sha256Hex(out), sha256Hex(payload));
  }
});

test("[PR-A Item 4d] Mid-chunk drop + independent offset retry + backup route failover + Content-Range total mismatch rejection + application/json ISOBMFF sniff safety", async () => {
  // 1) Mid-chunk drop -> retries from updated cursor -> backup #2 returns mismatched total (rejected permanently!) -> route #3 completes cleanly
  {
    const payload = makeDeterministicPayload(16_384, 71);
    const expectedSha = sha256Hex(payload);
    const opfs = createMockOpfs();
    const r1 = "https://upos-sz-mirrorcos.bilivideo.com/r1.mp4";
    const r2BadTotal = "https://upos-sz-mirrorali.bilivideo.com/r2-bad-total.mp4";
    const r3GoodBackup = "https://upos-sz-mirrorhw.bilivideo.com/r3-good.mp4";
    let droppedChunk2Once = false;
    let badTotalHits = 0;
    const chunk2Attempts = [];

    const result = await opfsStreamTransferMod.streamResumableRouteToOpfs({
      taskId: "chunk-retry-failover",
      routes: [r1, r2BadTotal, r3GoodBackup],
      spec: {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: [r1, r2BadTotal, r3GoodBackup],
        filename: "failover.mp4",
      },
      openOpfsSink: makeTestOpfsSink(opfs),
      signal: new AbortController().signal,
      maxConcurrency: 4,
      rangeChunkSizeBytes: 2048,
      minParallelRangeBytes: 4096,
      maxChunkRetries: 3,
      fetchFn: async (url, init) => {
        const s = String(url);
        const parsed = parseTestRangeHeader(init?.headers?.Range);
        const start = parsed.start;
        const end = Math.min(payload.byteLength - 1, parsed.end ?? payload.byteLength - 1);

        // Chunk 2 spans [4096 .. 6143]
        if (start >= 4096 && end === 6143) {
          chunk2Attempts.push({ url: s, range: init?.headers?.Range });
        }

        if (s === r2BadTotal) {
          badTotalHits += 1;
          const corruptSlice = new Uint8Array(end - start + 1).fill(0xee);
          return new Response(corruptSlice, {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              // Deliberate total mismatch -> MUST be rejected!
              "Content-Range": `bytes ${start}-${end}/${payload.byteLength + 777}`,
              "Content-Length": String(corruptSlice.byteLength),
            },
          });
        }

        if (s === r1 && start === 4096 && !droppedChunk2Once) {
          droppedChunk2Once = true;
          // Emit first 1024 bytes then drop mid-stream!
          let emitted = false;
          const stream = new ReadableStream({
            pull(controller) {
              if (!emitted) {
                emitted = true;
                controller.enqueue(payload.subarray(4096, 5120));
                return;
              }
              controller.error(new TypeError("simulated chunk-2 mid-stream drop"));
            },
          });
          return new Response(stream, {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": `bytes 4096-6143/${payload.byteLength}`,
              "Content-Length": "2048",
            },
          });
        }

        const slice = payload.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes ${start}-${end}/${payload.byteLength}`,
            "Content-Length": String(slice.byteLength),
          },
        });
      },
    });

    const out = new Uint8Array(await (await result.sink.closeAndGetBlob()).arrayBuffer());
    await result.sink.cleanup();
    assert.equal(sha256Hex(out), expectedSha, "exact SHA-256 must match without any corruption from bad-total route");
    assert.equal(badTotalHits, 1, "mismatched-total backup route must be rejected on first hit and not reused");
    assert.deepEqual(
      chunk2Attempts,
      [
        { url: r1, range: "bytes=4096-6143" },
        { url: r2BadTotal, range: "bytes=5120-6143" },
        { url: r3GoodBackup, range: "bytes=5120-6143" },
      ],
      "Chunk 2 must resume from updated cursor 5120, reject r2 bad total, and complete via r3",
    );
    assert.ok(result.resumedCount >= 2);
    assert.equal(opfs.files.size, 0);
  }

  // 2) application/json ISOBMFF sniff safety on 206 probe:
  //    2a) Fake JSON error body MUST fail on Chunk 0 BEFORE spawning ANY sibling workers!
  {
    const opfs = createMockOpfs();
    let fetchCount = 0;
    const jsonErr = new TextEncoder().encode('{"code":-403,"message":"fake error body padded to exceed 16 bytes"}');
    await assert.rejects(
      () =>
        opfsStreamTransferMod.streamResumableRouteToOpfs({
          taskId: "json-sniff-reject",
          routes: ["https://upos-sz-mirrorhwo1.bilivideo.com/bad-json.m4s"],
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://upos-sz-mirrorhwo1.bilivideo.com/bad-json.m4s"],
            filename: "bad.m4s",
          },
          openOpfsSink: makeTestOpfsSink(opfs),
          signal: new AbortController().signal,
          maxConcurrency: 4,
          rangeChunkSizeBytes: 2048,
          minParallelRangeBytes: 4096,
          fetchFn: async () => {
            fetchCount += 1;
            return new Response(jsonErr, {
              status: 206,
              headers: {
                "Content-Type": "application/json",
                "Content-Range": `bytes 0-${jsonErr.byteLength - 1}/16384`,
                "Content-Length": String(jsonErr.byteLength),
              },
            });
          },
        }),
      /非媒体错误页/,
    );
    assert.equal(fetchCount, 1, "must abort on Chunk 0 sniff failure with 0 sibling worker requests");
    assert.equal(opfs.files.size, 0);
  }

  //    2b) Genuine ISO BMFF header labeled application/json (Huawei OBS quirk) succeeds in parallel!
  {
    const payload = makeDeterministicPayload(12_288, 88);
    // Write a genuine `ftyp` box header at bytes 0..7
    payload[0] = 0x00;
    payload[1] = 0x00;
    payload[2] = 0x00;
    payload[3] = 0x18;
    payload[4] = 0x66; // f
    payload[5] = 0x74; // t
    payload[6] = 0x79; // y
    payload[7] = 0x70; // p
    const opfs = createMockOpfs();
    const result = await opfsStreamTransferMod.streamResumableRouteToOpfs({
      taskId: "json-sniff-pass",
      routes: ["https://upos-sz-mirrorhwo1.bilivideo.com/obs-good.m4s"],
      spec: {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorhwo1.bilivideo.com/obs-good.m4s"],
        filename: "good.m4s",
      },
      openOpfsSink: makeTestOpfsSink(opfs),
      signal: new AbortController().signal,
      maxConcurrency: 4,
      rangeChunkSizeBytes: 2048,
      minParallelRangeBytes: 4096,
      fetchFn: async (_url, init) => {
        const parsed = parseTestRangeHeader(init?.headers?.Range);
        const start = parsed.start;
        const end = Math.min(payload.byteLength - 1, parsed.end ?? payload.byteLength - 1);
        const slice = payload.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Type": "application/json",
            "Content-Range": `bytes ${start}-${end}/${payload.byteLength}`,
            "Content-Length": String(slice.byteLength),
          },
        });
      },
    });
    const out = new Uint8Array(await (await result.sink.closeAndGetBlob()).arrayBuffer());
    await result.sink.cleanup();
    assert.equal(result.parallelUsed, true);
    assert.equal(sha256Hex(out), sha256Hex(payload));
    assert.equal(opfs.files.size, 0);
  }
});

test("[PR-A Item 4e & 4f] All-routes 403/410 expiry (probe & mid-transfer chunk), direct->/api/ failover without parallel fanout, and mid-parallel user cancel with 0 OPFS residue", async () => {
  // 1) All routes return 403/410 on initial probe -> MEDIA_URL_EXPIRED, 0 OPFS residue
  {
    const opfs = createMockOpfs();
    let err = null;
    try {
      await opfsStreamTransferMod.streamResumableRouteToOpfs({
        taskId: "probe-all-403",
        routes: [
          "https://upos-sz-mirrorcos.bilivideo.com/exp1.mp4",
          "https://upos-sz-mirrorali.bilivideo.com/exp2.mp4",
        ],
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: [
            "https://upos-sz-mirrorcos.bilivideo.com/exp1.mp4",
            "https://upos-sz-mirrorali.bilivideo.com/exp2.mp4",
          ],
          filename: "exp.mp4",
        },
        openOpfsSink: makeTestOpfsSink(opfs),
        signal: new AbortController().signal,
        maxConcurrency: 4,
        rangeChunkSizeBytes: 2048,
        minParallelRangeBytes: 4096,
        fetchFn: async (url) => {
          const status = String(url).includes("exp1") ? 403 : 410;
          return new Response("Expired", { status });
        },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, "MEDIA_URL_EXPIRED");
    assert.equal(opfs.files.size, 0);
  }

  // 2) Mid-transfer all-routes 403/410 -> immediately aborts sibling worker, 0 OPFS residue, throws MEDIA_URL_EXPIRED
  {
    const payload = makeDeterministicPayload(16_384, 99);
    const opfs = createMockOpfs();
    const r1 = "https://upos-sz-mirrorcos.bilivideo.com/mid-exp1.mp4";
    const r2 = "https://upos-sz-mirrorali.bilivideo.com/mid-exp2.mp4";
    let siblingAborted = false;
    let err = null;
    try {
      await opfsStreamTransferMod.streamResumableRouteToOpfs({
        taskId: "mid-chunk-all-403",
        routes: [r1, r2],
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: [r1, r2],
          filename: "mid-exp.mp4",
        },
        openOpfsSink: makeTestOpfsSink(opfs),
        signal: new AbortController().signal,
        maxConcurrency: 4,
        rangeChunkSizeBytes: 2048,
        minParallelRangeBytes: 4096,
        fetchFn: async (url, init) => {
          const s = String(url);
          const parsed = parseTestRangeHeader(init?.headers?.Range);
          if (parsed.start === 0 && s === r1) {
            return new Response(payload.subarray(0, 2048), {
              status: 206,
              headers: {
                "Content-Type": "video/mp4",
                "Content-Range": `bytes 0-2047/${payload.byteLength}`,
                "Content-Length": "2048",
              },
            });
          }
          if (parsed.start === 4096) {
            // Sibling chunk hangs until aborted by poolAbort!
            return new Promise((_resolve, reject) => {
              const onAbort = () => {
                siblingAborted = true;
                reject(new DOMException("Aborted", "AbortError"));
              };
              if (init?.signal?.aborted) onAbort();
              else init?.signal?.addEventListener("abort", onAbort, { once: true });
            });
          }
          // Chunk 1 hits 403 on r1 and 410 on r2 -> ALL routes expired!
          await new Promise((r) => setTimeout(r, 10));
          return new Response("Expired", { status: s === r1 ? 403 : 410 });
        },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, "MEDIA_URL_EXPIRED");
    assert.equal(siblingAborted, true, "sibling in-flight worker MUST be aborted immediately");
    assert.equal(opfs.files.size, 0, "0 OPFS residue after mid-transfer expiry");
  }

  // 3) Direct CDN returns 403 mid-transfer while backup is /api/ relay -> NEVER fans out to /api/, fails over to /api/ at 1x!
  {
    const payload = makeDeterministicPayload(12_288, 61);
    const opfs = createMockOpfs();
    const directUrl = "https://f.video.weibocdn.com/o0/mid-403.mp4";
    const relayUrl = "https://snap.dokitool.com/api/media/weibo?ticket=midfallback";
    let relayInFlight = 0;
    let relayMaxInFlight = 0;
    const relayRanges = [];

    const result = await opfsStreamTransferMod.streamResumableRouteToOpfs({
      taskId: "direct-to-relay-failover",
      routes: [directUrl, relayUrl],
      spec: {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: [directUrl, relayUrl],
        filename: "weibo-mid-failover.mp4",
      },
      openOpfsSink: makeTestOpfsSink(opfs),
      signal: new AbortController().signal,
      maxConcurrency: 4,
      rangeChunkSizeBytes: 2048,
      minParallelRangeBytes: 4096,
      apiOrigin: "https://snap.dokitool.com",
      fetchFn: async (url, init) => {
        const s = String(url);
        if (s === directUrl) {
          const parsed = parseTestRangeHeader(init?.headers?.Range);
          if (parsed?.start === 0) {
            return new Response(payload.subarray(0, 2048), {
              status: 206,
              headers: {
                "Content-Type": "video/mp4",
                "Content-Range": `bytes 0-2047/${payload.byteLength}`,
                "Content-Length": "2048",
              },
            });
          }
          return new Response("Forbidden", { status: 403 });
        }
        if (s === relayUrl) {
          relayInFlight += 1;
          relayMaxInFlight = Math.max(relayMaxInFlight, relayInFlight);
          relayRanges.push(init?.headers?.Range ?? null);
          try {
            await new Promise((r) => setTimeout(r, 10));
            return new Response(payload, {
              status: 200,
              headers: {
                "Content-Type": "video/mp4",
                "Content-Length": String(payload.byteLength),
              },
            });
          } finally {
            relayInFlight -= 1;
          }
        }
        throw new Error(`Unexpected URL: ${s}`);
      },
    });
    const out = new Uint8Array(await (await result.sink.closeAndGetBlob()).arrayBuffer());
    await result.sink.cleanup();
    assert.equal(relayMaxInFlight, 1, "/api/ relay fallback must NEVER run in parallel");
    assert.deepEqual(relayRanges, [null], "/api/ relay fallback must use plain 1x GET");
    assert.equal(result.route, relayUrl);
    assert.equal(sha256Hex(out), sha256Hex(payload));
    assert.equal(opfs.files.size, 0);
  }

  // 4) User cancel mid-parallel via executor.cancelTask -> aborts ALL parallel workers immediately, 0 OPFS residue
  {
    const payload = makeDeterministicPayload(20 * 1024 * 1024, 19);
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const errors = [];
    let parallelStarted = 0;
    let parallelAborted = 0;
    let allFourStartedResolve;
    const allFourStarted = new Promise((r) => {
      allFourStartedResolve = r;
    });

    const executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (_url, init) => {
        const parsed = parseTestRangeHeader(init?.headers?.Range);
        if (parsed?.start === 0) {
          const end = Math.min(payload.byteLength - 1, parsed.end);
          const slice = payload.subarray(0, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": `bytes 0-${end}/${payload.byteLength}`,
              "Content-Length": String(slice.byteLength),
            },
          });
        }
        parallelStarted += 1;
        if (parallelStarted === 4) {
          allFourStartedResolve();
        }
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            parallelAborted += 1;
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (init?.signal?.aborted) onAbort();
          else init?.signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
      onError(msg) {
        errors.push(msg);
      },
      async handoffBlobDownload() {
        throw new Error("cancelled parallel task must not handoff");
      },
    });
    try {
      executor.startTask("cancel-mid-parallel", {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://f.video.weibocdn.com/o0/cancel-20mib.mp4"],
        filename: "cancel-20mib.mp4",
        mimeType: "video/mp4",
      });
      await allFourStarted;
      executor.cancelTask("cancel-mid-parallel");
      await executor.waitForIdle();
      assert.equal(parallelAborted, 4, "all 4 in-flight parallel workers MUST be aborted");
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "USER_CANCELLED");
      assert.equal(errors[0].cancelled, true);
      assert.equal(opfs.files.size, 0, "0 OPFS residue after mid-parallel cancel");
      assert.equal(executor.getActiveOpfsTempNames().size, 0);
    } finally {
      executor.dispose();
    }
  }
});

test("[PR-A Item 4g & 4h] dash_mux concurrent video (<=3) + audio (<=2) with total <=5 and valid mediabunny MP4, plus same-origin /api/ relay strictly capped at 1x even >= 8 MiB", async () => {
  // 1) dash_mux: 16 MiB video (Chunk 0 + 3 parallel chunks -> max 3) + 9 MiB audio (Chunk 0 + 2 parallel chunks -> max 2) -> combined <= 5, valid MP4!
  {
    const { videoBytes: rawVideo, audioBytes: rawAudio } =
      await createSyntheticDashTrackBuffers("avc");
    const videoBytes = padMp4WithFreeBox(rawVideo, 16 * 1024 * 1024);
    const audioBytes = padMp4WithFreeBox(rawAudio, 9 * 1024 * 1024);
    const opfs = createMockOpfs({ quota: 200 * 1024 * 1024 });
    const urlApi = createTrackedUrlApi();
    const errors = [];
    let muxedMp4Bytes = null;

    let videoInFlight = 0;
    let videoMaxInFlight = 0;
    let audioInFlight = 0;
    let audioMaxInFlight = 0;
    let totalInFlight = 0;
    let totalMaxInFlight = 0;
    const audioRangeHeaders = [];

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (url, init) => {
        const s = String(url);
        const isVideo = s.includes("dash-par-v.m4s");
        const isAudio = s.includes("dash-par-a.m4s");
        assert.ok(isVideo || isAudio, `Unexpected URL: ${s}`);
        totalInFlight += 1;
        totalMaxInFlight = Math.max(totalMaxInFlight, totalInFlight);
        if (isVideo) {
          videoInFlight += 1;
          videoMaxInFlight = Math.max(videoMaxInFlight, videoInFlight);
        } else {
          audioInFlight += 1;
          audioMaxInFlight = Math.max(audioMaxInFlight, audioInFlight);
          if (init?.headers?.Range) audioRangeHeaders.push(init.headers.Range);
        }

        try {
          const buf = isVideo ? videoBytes : audioBytes;
          const parsed = parseTestRangeHeader(init?.headers?.Range);
          if (parsed) {
            const start = parsed.start;
            const end = Math.min(buf.byteLength - 1, parsed.end ?? buf.byteLength - 1);
            // Stagger so video's 3 parallel workers + audio's 1 worker overlap cleanly
            await new Promise((r) => setTimeout(r, start === 0 ? 1 : 35));
            const slice = buf.subarray(start, end + 1);
            return new Response(slice, {
              status: 206,
              headers: {
                "Content-Type": isVideo ? "video/mp4" : "audio/mp4",
                "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
                "Content-Length": String(slice.byteLength),
              },
            });
          }
          // Audio (maxConcurrency=1) receives plain GET without Range!
          await new Promise((r) => setTimeout(r, 45));
          return new Response(buf, {
            status: 200,
            headers: {
              "Content-Type": isVideo ? "video/mp4" : "audio/mp4",
              "Content-Length": String(buf.byteLength),
            },
          });
        } finally {
          totalInFlight -= 1;
          if (isVideo) videoInFlight -= 1;
          else audioInFlight -= 1;
        }
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
        return { chromeDownloadId: 405 };
      },
    });

    try {
      executor.startTask("dash-parallel-mux", {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/dash-par-v.m4s"],
        filename: "dash-parallel.mp4",
        mimeType: "video/mp4",
        dashMux: {
          videoRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/dash-par-v.m4s"],
          audioRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/dash-par-a.m4s"],
          videoSize: videoBytes.byteLength,
          audioSize: audioBytes.byteLength,
          outputContainer: "mp4",
        },
      });
      await executor.waitForIdle();
      assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
      assert.equal(videoMaxInFlight, 3, "DASH video track must use up to 3 concurrent Range workers");
      assert.equal(audioMaxInFlight, 2, "DASH audio track must use up to 2 concurrent Range workers when >= 3 MiB");
      assert.ok(audioRangeHeaders.length >= 2, "DASH audio track (maxConcurrency=2) must use Range requests for >= 3 MiB");
      assert.ok(
        totalMaxInFlight <= 5,
        `combined DASH in-flight connections must be <= 5 (got ${totalMaxInFlight})`,
      );
      assert.ok(muxedMp4Bytes && muxedMp4Bytes.byteLength > 0);

      const parsed = new mediabunny.Input({
        source: new mediabunny.BufferSource(muxedMp4Bytes),
        formats: mediabunny.ALL_FORMATS,
      });
      try {
        const vTrack = await parsed.getPrimaryVideoTrack();
        const aTrack = await parsed.getPrimaryAudioTrack();
        assert.ok(vTrack, "parallel-fetched DASH MP4 must contain valid video track");
        assert.ok(aTrack, "parallel-fetched DASH MP4 must contain valid audio track");
      } finally {
        parsed.dispose?.();
      }
      assert.equal(opfs.files.size, 0, "0 OPFS residue after parallel dash_mux");
    } finally {
      executor.dispose();
    }
  }

  // 2) Same-origin /api/ relay route strictly capped at 1 connection even when size >= 8 MiB (12 MiB)
  {
    const payload = makeDeterministicPayload(12 * 1024 * 1024, 107);
    const expectedSha = sha256Hex(payload);
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const errors = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let rangeHeaderCount = 0;
    let handedBytes = null;

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (_url, init) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (init?.headers?.Range) rangeHeaderCount += 1;
        try {
          await new Promise((r) => setTimeout(r, 10));
          return new Response(payload, {
            status: 200,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(payload.byteLength),
            },
          });
        } finally {
          inFlight -= 1;
        }
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
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
        return { chromeDownloadId: 406 };
      },
    });
    try {
      executor.startTask("relay-12mib-cap-1x", {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://snap.dokitool.com/api/media/weibo?ticket=large12mib"],
        filename: "weibo-relay-12mib.mp4",
        mimeType: "video/mp4",
        sizeBytes: payload.byteLength,
      });
      await executor.waitForIdle();
      assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
      assert.equal(maxInFlight, 1, "same-origin /api/ relay MUST be strictly capped at 1 connection");
      assert.equal(rangeHeaderCount, 0, "same-origin /api/ relay MUST NOT probe Range for parallel fanout");
      assert.equal(sha256Hex(handedBytes), expectedSha);
      assert.equal(opfs.files.size, 0);
    } finally {
      executor.dispose();
    }
  }
});

test("[PR-A Item 2] Extension Weibo anonymous relay direct_url: direct-first, 403/network fallback to /api/media/weibo, unwhitelisted direct_url ignored, and refreshSpecFromContext preserves [direct_url, relay_url]", async () => {
  const apiOrigin = "https://snap.dokitool.com";
  const directUrl = "https://f.video.weibocdn.com/o0/weibo-anon-direct.mp4?Expires=9999999999";
  const relayPath = "/api/media/weibo?ticket=anon-ticket-1";
  const relayFullUrl = `${apiOrigin}${relayPath}`;
  const unwhitelistedDirectUrl = "https://evil.example.com/not-whitelisted.mp4";
  const payload = makeDeterministicPayload(16_384, 123);
  const expectedSha = sha256Hex(payload);

  const makeWeiboRelayMedia = (sourceDirectUrl, ticketPath = relayPath) => ({
    platform: "weibo",
    content_id: "5123456789012345",
    title: "微博匿名直连测试视频",
    source_url: "https://weibo.com/123456/P12345678",
    default_item_id: "wb-item-1",
    items: [
      {
        id: "wb-item-1",
        type: "video",
        state: "ready",
        title: "微博匿名直连测试视频",
        source_url: "https://weibo.com/123456/P12345678",
        default: {
          variant_id: "wb-hd",
          source_id: "wb-relay-src",
          url: ticketPath,
          access: "relay",
        },
        variants: [
          {
            id: "wb-hd",
            state: "ready",
            label: "1080P",
            metadata: {
              width: 1920,
              height: 1080,
              has_audio: true,
              extension: "mp4",
              mime_type: "video/mp4",
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "wb-relay-src",
                  url: ticketPath,
                  access: "relay",
                  ...(sourceDirectUrl ? { direct_url: sourceDirectUrl } : {}),
                  size_bytes: payload.byteLength,
                },
              ],
            },
          },
        ],
      },
    ],
  });

  // 1) buildEnqueueItemsForMedia puts whitelisted direct_url first, relay_url second;
  //    executor connects directly to weibocdn.com first with 0 calls to /api/media/weibo
  {
    const items = extensionDownloadMod.buildEnqueueItemsForMedia(
      makeWeiboRelayMedia(directUrl),
      { apiOrigin },
    );
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].spec.routes, [directUrl, relayFullUrl]);

    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const fetchedUrls = [];
    const errors = [];
    let handedBytes = null;

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (url) => {
        const s = String(url);
        fetchedUrls.push(s);
        if (s === directUrl) {
          return new Response(payload, {
            status: 200,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(payload.byteLength),
            },
          });
        }
        throw new Error(`Relay must not be fetched when direct succeeds: ${s}`);
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
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
        return { chromeDownloadId: 501 };
      },
    });
    try {
      executor.startTask("weibo-direct-ok", items[0].spec);
      await executor.waitForIdle();
      assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
      assert.deepEqual(fetchedUrls, [directUrl]);
      assert.equal(sha256Hex(handedBytes), expectedSha);
      assert.equal(opfs.files.size, 0);
    } finally {
      executor.dispose();
    }
  }

  // 2) Fallback from direct_url to /api/media/weibo on BOTH HTTP 403 and network drop
  for (const failureMode of ["http-403", "network-drop"]) {
    const items = extensionDownloadMod.buildEnqueueItemsForMedia(
      makeWeiboRelayMedia(directUrl),
      { apiOrigin },
    );
    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const fetchedUrls = [];
    const errors = [];
    let handedBytes = null;

    let executor;
    executor = extensionDownloadMod.createOffscreenDownloadExecutor({
      fetchImpl: async (url) => {
        const s = String(url);
        fetchedUrls.push(s);
        if (s === directUrl) {
          if (failureMode === "http-403") {
            return new Response("Forbidden", { status: 403 });
          }
          throw new TypeError("simulated network error to weibocdn");
        }
        if (s === relayFullUrl) {
          return new Response(payload, {
            status: 200,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(payload.byteLength),
            },
          });
        }
        throw new Error(`Unexpected URL: ${s}`);
      },
      opfsStorage: opfs.storage,
      webLocks: opfs.locks,
      urlApi,
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
        return { chromeDownloadId: 502 };
      },
    });
    try {
      executor.startTask(`weibo-fallback-${failureMode}`, items[0].spec);
      await executor.waitForIdle();
      assert.equal(errors.length, 0, `${failureMode}: unexpected errors ${JSON.stringify(errors)}`);
      assert.deepEqual(
        fetchedUrls,
        [directUrl, relayFullUrl],
        `${failureMode}: must try direct_url first then fall back to relay_url`,
      );
      assert.equal(sha256Hex(handedBytes), expectedSha);
      assert.equal(opfs.files.size, 0);
    } finally {
      executor.dispose();
    }
  }

  // 3) Unwhitelisted direct_url is strictly ignored -> routes contain ONLY [relay_url]
  {
    const items = extensionDownloadMod.buildEnqueueItemsForMedia(
      makeWeiboRelayMedia(unwhitelistedDirectUrl),
      { apiOrigin },
    );
    assert.equal(items.length, 1);
    assert.deepEqual(
      items[0].spec.routes,
      [relayFullUrl],
      "unwhitelisted direct_url must be ignored, keeping only relay_url",
    );
  }

  // 4) refreshSpecFromContext on expired/retried Weibo task preserves [fresh_direct_url, fresh_relay_url]
  {
    const staleDirectUrl = "https://f.video.weibocdn.com/o0/stale.mp4";
    const staleRelayUrl = `${apiOrigin}/api/media/weibo?ticket=stale-ticket`;
    const freshDirectUrl = "https://f.video.weibocdn.com/o0/fresh-after-refresh.mp4";
    const freshRelayPath = "/api/media/weibo?ticket=fresh-ticket";
    const freshRelayUrl = `${apiOrigin}${freshRelayPath}`;

    const opfs = createMockOpfs();
    const urlApi = createTrackedUrlApi();
    const fetchedUrls = [];
    const savedBlobs = new Map();
    let parseCalls = 0;

    const refreshedEnvelope = {
      schema_version: "1.0",
      code: "OK",
      data: makeWeiboRelayMedia(freshDirectUrl, freshRelayPath),
    };

    const mockFetch = async (url) => {
      const s = String(url);
      fetchedUrls.push(s);
      if (s.includes("/api/parse")) {
        parseCalls += 1;
        return new Response(JSON.stringify(refreshedEnvelope), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (s === freshDirectUrl) {
        // Return 403 on fresh direct to prove BOTH fresh direct was tried FIRST
        // AND fresh relay_url remained preserved behind it as fallback!
        return new Response("Forbidden", { status: 403 });
      }
      if (s === freshRelayUrl) {
        return new Response(payload, {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(payload.byteLength),
          },
        });
      }
      throw new Error(`Unexpected URL during Weibo refresh test: ${s}`);
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
            title: "微博匿名直连测试视频",
            platform: "weibo",
            spec: {
              kind: "direct_file",
              apiOrigin,
              routes: [staleDirectUrl, staleRelayUrl],
              filename: "DokiTool/weibo-refreshed.mp4",
              mimeType: "video/mp4",
              sizeBytes: payload.byteLength,
              refreshContext: {
                parseUrl: "https://weibo.com/123456/P12345678",
                platform: "weibo",
                itemId: "wb-item-1",
                variantId: "wb-hd",
                expiresAtMs: Date.now() - 60_000,
              },
            },
          },
        ],
      });
      assert.equal(rpc.ok, true);
      await bg.waitForIdle();
      await offscreenCtrl?.executor.waitForIdle();

      assert.equal(parseCalls, 1, "expired Weibo task must re-parse once before start");
      assert.equal(fetchedUrls.includes(staleDirectUrl), false, "must skip stale direct URL");
      assert.equal(fetchedUrls.includes(staleRelayUrl), false, "must skip stale relay URL");
      const directIdx = fetchedUrls.indexOf(freshDirectUrl);
      const relayIdx = fetchedUrls.indexOf(freshRelayUrl);
      assert.ok(directIdx >= 0, `refreshed spec must try fresh direct_url first; urls=${JSON.stringify(fetchedUrls)}`);
      assert.ok(relayIdx > directIdx, `refreshed spec must preserve fresh relay_url after direct_url; urls=${JSON.stringify(fetchedUrls)}`);
      assert.equal(sha256Hex(savedBlobs.get("DokiTool/weibo-refreshed.mp4")), expectedSha);
      assert.equal(opfs.files.size, 0);
    } finally {
      offscreenCtrl?.dispose();
      bg.dispose();
    }
  }
});

test("[PR-A R2 B2] whitelistedFetch, direct_file (parallel + sequential), and dash_mux enforce cache: 'no-store' on all media fetches", async () => {
  // 1) Direct whitelistedFetch overrides caller-provided cache mode (e.g. force-cache -> no-store)
  {
    const seenInits = [];
    const resp = await opfsStreamTransferMod.whitelistedFetch(
      async (_url, init) => {
        seenInits.push(init);
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "Content-Type": "video/mp4", "Content-Length": "4" },
        });
      },
      "https://upos-sz-mirrorcos.bilivideo.com/cache-test.mp4",
      {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/cache-test.mp4"],
        filename: "cache-test.mp4",
      },
      { cache: "force-cache", headers: { Range: "bytes=0-3" } },
      new AbortController().signal,
    );
    assert.equal(resp.status, 200);
    assert.equal(seenInits.length, 1);
    assert.equal(seenInits[0]?.cache, "no-store", "whitelistedFetch must enforce cache: no-store");
    assert.equal(seenInits[0]?.credentials, "omit");
    assert.equal(seenInits[0]?.referrerPolicy, "no-referrer");
  }

  // 2) Parallel direct_file Range fetches ALL pass cache: "no-store"
  {
    const payload = makeDeterministicPayload(16_384, 51);
    const opfs = createMockOpfs();
    const seenCaches = [];
    const result = await opfsStreamTransferMod.streamResumableRouteToOpfs({
      taskId: "b2-direct-parallel",
      routes: ["https://upos-sz-mirrorcos.bilivideo.com/b2-parallel.mp4"],
      spec: {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/b2-parallel.mp4"],
        filename: "b2-parallel.mp4",
      },
      openOpfsSink: makeTestOpfsSink(opfs),
      signal: new AbortController().signal,
      maxConcurrency: 4,
      rangeChunkSizeBytes: 4096,
      minParallelRangeBytes: 8192,
      fetchFn: async (_url, init) => {
        seenCaches.push(init?.cache);
        const parsed = parseTestRangeHeader(init?.headers?.Range);
        const start = parsed ? parsed.start : 0;
        const end = parsed && parsed.end !== null ? Math.min(payload.byteLength - 1, parsed.end) : payload.byteLength - 1;
        const slice = payload.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes ${start}-${end}/${payload.byteLength}`,
            "Content-Length": String(slice.byteLength),
          },
        });
      },
    });
    await result.sink.cleanup();
    assert.equal(result.parallelUsed, true);
    assert.ok(seenCaches.length >= 4, `expected >= 4 Range fetches, got ${seenCaches.length}`);
    assert.ok(
      seenCaches.every((c) => c === "no-store"),
      `all parallel direct_file fetches must pass cache: no-store, got ${JSON.stringify(seenCaches)}`,
    );
  }

  // 3) dash_mux video + audio fetches ALL pass cache: "no-store"
  {
    const muxFixture = await createSyntheticDashTrackBuffers("avc");
    const opfs = createMockOpfs();
    const seenVideoCaches = [];
    const seenAudioCaches = [];
    let handoffSize = 0;
    const videoUrl = "https://upos-sz-mirrorcos.bilivideo.com/b2-dash-video.m4s";
    const audioUrl = "https://upos-sz-mirrorcos.bilivideo.com/b2-dash-audio.m4s";
    await dashMuxDownloadMod.executeDashMux({
      taskId: "b2-dash-cache",
      spec: {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        filename: "b2-dash.mp4",
        mimeType: "video/mp4",
        dashMux: {
          videoRoutes: [videoUrl],
          audioRoutes: [audioUrl],
          videoSize: muxFixture.videoBytes.byteLength,
          audioSize: muxFixture.audioBytes.byteLength,
          outputContainer: "mp4",
        },
      },
      fetchFn: async (url, init) => {
        const s = String(url);
        const buf = s === videoUrl ? muxFixture.videoBytes : muxFixture.audioBytes;
        if (s === videoUrl) seenVideoCaches.push(init?.cache);
        else seenAudioCaches.push(init?.cache);
        const parsed = parseTestRangeHeader(init?.headers?.Range);
        if (parsed) {
          const end = parsed.end !== null ? Math.min(buf.byteLength - 1, parsed.end) : buf.byteLength - 1;
          const slice = buf.subarray(parsed.start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              "Content-Type": s === videoUrl ? "video/mp4" : "audio/mp4",
              "Content-Range": `bytes ${parsed.start}-${end}/${buf.byteLength}`,
              "Content-Length": String(slice.byteLength),
            },
          });
        }
        return new Response(buf, {
          status: 200,
          headers: {
            "Content-Type": s === videoUrl ? "video/mp4" : "audio/mp4",
            "Content-Length": String(buf.byteLength),
          },
        });
      },
      opfsStorage: opfs.storage,
      openOpfsSink: makeTestOpfsSink(opfs),
      signal: new AbortController().signal,
      reportProgress: () => {},
      handoffSinkAndWaitRelease: async ({ sink }) => {
        const blob = await sink.closeAndGetBlob();
        handoffSize = blob.size;
        await sink.cleanup();
      },
    });
    assert.ok(handoffSize > 0, "expected muxed output blob");
    assert.ok(seenVideoCaches.length >= 1 && seenAudioCaches.length >= 1);
    assert.ok(
      [...seenVideoCaches, ...seenAudioCaches].every((c) => c === "no-store"),
      `all dash_mux fetches must pass cache: no-store, got video=${JSON.stringify(seenVideoCaches)} audio=${JSON.stringify(seenAudioCaches)}`,
    );
    assert.equal(opfs.files.size, 0);
  }
});

// ============================================================================
// PR-C: Zero-<all_urls> Long-Tail Platform Support Tests
// ============================================================================

test("[PR-C 1] Privacy firewall unchanged on browsing/Alt+Shift+D/RESOLVE_LAZY_ITEM while active PARSE_URL, ENQUEUE_BATCH_URLS, QUICK_DOWNLOAD, and RETRY_TASK support long-tail platforms with platform=all", async () => {
  const apiRequests = [];
  let failVimeoFirstAttempt = false;

  const mockFetch = async (url) => {
    apiRequests.push(String(url));
    if (String(url).startsWith("https://snap.dokitool.com/api/parse")) {
      const parsed = new URL(String(url));
      assert.equal(
        parsed.searchParams.get("platform"),
        "all",
        "must always send platform=all (never platform=generic)",
      );
      const target = parsed.searchParams.get("url") || "";
      if (target.includes("vimeo.com/123456")) {
        if (failVimeoFirstAttempt) {
          failVimeoFirstAttempt = false;
          return new Response(
            JSON.stringify({
              schema_version: "1.0",
              code: "UPSTREAM_INVALID_RESPONSE",
              error: { code: "UPSTREAM_INVALID_RESPONSE", message: "临时错误" },
            }),
            { status: 502, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "OK",
            data: {
              platform: "vimeo",
              content_id: "123456",
              source_url: "https://vimeo.com/123456",
              title: "Vimeo Alpine Film",
              items: [
                {
                  id: "v-123456",
                  type: "video",
                  variants: [
                    {
                      id: "hls-1080p",
                      label: "1080p HLS",
                      metadata: {
                        width: 1920,
                        height: 1080,
                        extension: "mp4",
                        has_audio: true,
                      },
                      delivery: {
                        kind: "hls",
                        scope: "single",
                        sources: [
                          { url: "https://skyfire.vimeocdn.com/hls/1080p.m3u8" },
                        ],
                      },
                    },
                    {
                      id: "mp4-720p",
                      label: "720p MP4",
                      metadata: {
                        width: 1280,
                        height: 720,
                        extension: "mp4",
                        has_audio: true,
                      },
                      delivery: {
                        kind: "file",
                        sources: [
                          {
                            url: "https://skyfire.vimeocdn.com/prog/720p.mp4",
                            size_bytes: 12_345_678,
                          },
                        ],
                      },
                    },
                  ],
                  default: {
                    variant_id: "mp4-720p",
                    url: "https://skyfire.vimeocdn.com/prog/720p.mp4",
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (target.includes("soundcloud.com/artist/track-1")) {
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "OK",
            data: {
              platform: "soundcloud",
              content_id: "track-1",
              source_url: "https://soundcloud.com/artist/track-1",
              title: "Midnight Synth",
              items: [
                {
                  id: "sc-1",
                  type: "audio",
                  variants: [
                    {
                      id: "mp3-128",
                      label: "MP3 128kbps",
                      metadata: {
                        extension: "mp3",
                        mime_type: "audio/mpeg",
                        has_audio: true,
                        audio_bitrate_bps: 128000,
                      },
                      delivery: {
                        kind: "file",
                        sources: [
                          {
                            url: "https://cf-media.sndcdn.com/midnight-synth.mp3",
                            size_bytes: 4_200_000,
                          },
                        ],
                      },
                    },
                  ],
                  default: {
                    variant_id: "mp3-128",
                    url: "https://cf-media.sndcdn.com/midnight-synth.mp3",
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    throw new Error(`Unexpected fetch URL in PR-C 1: ${url}`);
  };

  const env = createMockMv3Environment({ autoCompleteDownloads: true });
  const extStorage = storage.createExtensionStorage();
  await extStorage.updateSettings({
    bearerToken: "owner-token-123",
    autoFollowTab: true,
    subfolderPrefix: "LongTail",
  });

  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    fetchImpl: mockFetch,
    tabSyncDebounceMs: 15,
    badgeSuccessDurationMs: 40,
  });
  await bg.init();

  // 1) Privacy firewall: browsing Vimeo, Twitch, or online banking triggers ZERO network calls & redacts rawUrl!
  for (const browsedUrl of [
    "https://vimeo.com/123456",
    "https://www.twitch.tv/videos/2123456789",
    "https://online-banking.example.com/secret?token=abc",
  ]) {
    env.emitTabUpdated(
      1,
      { status: "complete", url: browsedUrl },
      { id: 1, windowId: 10, active: true, url: browsedUrl },
    );
    env.emitTabActivated(1, 10);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(apiRequests.length, 0, `0 network requests when browsing ${browsedUrl}`);
    const snap = await bg.getSnapshot();
    assert.equal(snap.tabSync?.matched, null, `tabSync.matched must stay null for ${browsedUrl}`);
    assert.equal(snap.tabSync?.rawUrl, "", `tabSync.rawUrl must be redacted for ${browsedUrl}`);
  }

  // Alt+Shift+D on Vimeo opens SidePanel synchronously but emits NO inspect intent & 0 network calls
  env.emitCommand(protocol.COMMAND_OPEN_SIDEPANEL, {
    id: 1,
    windowId: 10,
    url: "https://vimeo.com/123456",
  });
  await bg.waitForIdle();
  assert.equal(apiRequests.length, 0, "Alt+Shift+D on long-tail tab makes 0 network calls");
  assert.equal(await extStorage.consumePendingIntent(), null);

  // RESOLVE_LAZY_ITEM still strictly requires core-14 platform inner URL
  const lazyReject = await env.chrome.runtime.sendMessage({
    type: "RESOLVE_LAZY_ITEM",
    platform: "vimeo",
    resolveUrl: "/api/resolve?item_id=p2&url=https%3A%2F%2Fvimeo.com%2F123456",
  });
  assert.equal(lazyReject.ok, false);
  assert.equal(apiRequests.length, 0, "RESOLVE_LAZY_ITEM must reject non-core-14 locally");

  // 2) Active PARSE_URL accepts Vimeo, sends platform=all, and enriches matched.platform / matched.platformLabel
  const parseResp = await env.chrome.runtime.sendMessage({
    type: "PARSE_URL",
    url: "https://vimeo.com/123456",
  });
  assert.equal(parseResp.ok, true, `expected PARSE_URL ok: ${parseResp.error || ""}`);
  assert.equal(parseResp.data.matched.platform, "vimeo");
  assert.equal(parseResp.data.matched.platformLabel, "Vimeo");
  assert.equal(parseResp.data.media.title, "Vimeo Alpine Film");
  assert.equal(apiRequests.length, 1);

  // PARSE_URL still rejects local/private/internal/bare URLs locally with 0 network calls
  for (const blocked of [
    "chrome://extensions",
    "file:///etc/passwd",
    "http://192.168.1.1/video.mp4",
    "http://localhost/video/1",
    "https://snap.dokitool.com/api/parse",
    "https://vimeo.com/",
  ]) {
    const reqCountBefore = apiRequests.length;
    const rej = await env.chrome.runtime.sendMessage({
      type: "PARSE_URL",
      url: blocked,
    });
    assert.equal(rej.ok, false);
    assert.equal(apiRequests.length, reqCountBefore, `0 network calls for blocked ${blocked}`);
  }

  // 3) Active CONTEXT_MENU_QUICK_DOWNLOAD_ID:
  //    a) rejects unsafe/internal URLs locally with 0 network calls
  for (const badQuick of [
    "chrome://extensions",
    "file:///etc/passwd",
    "http://127.0.0.1/secret",
    "http://localhost/admin",
    "https://snap.dokitool.com/api/parse",
  ]) {
    const reqCountBefore = apiRequests.length;
    env.emitContextMenuClick(
      { menuItemId: protocol.CONTEXT_MENU_QUICK_DOWNLOAD_ID, linkUrl: badQuick },
      { id: 1, windowId: 10 },
    );
    await bg.waitForIdle();
    assert.equal(apiRequests.length, reqCountBefore, `quick-download must not fetch ${badQuick}`);
  }
  await env.chrome.runtime.sendMessage({ type: "CLEAR_FINISHED_TASKS" });

  //    b) accepts https://vimeo.com/123456 -> selects downloadable 720p progressive MP4 over 1080p external_only HLS
  //       and dispatches straight to chrome.downloads.download with 0 Offscreen document creations!
  env.downloadCalls.length = 0;
  env.emitContextMenuClick(
    {
      menuItemId: protocol.CONTEXT_MENU_QUICK_DOWNLOAD_ID,
      linkUrl: "https://vimeo.com/123456",
    },
    { id: 1, windowId: 10 },
  );
  await bg.waitForIdle();
  assert.equal(env.getOffscreenCreateCount(), 0, "native direct download must NEVER spawn offscreen.html");
  assert.equal(env.downloadCalls.length, 1);
  assert.equal(env.downloadCalls[0].url, "https://skyfire.vimeocdn.com/prog/720p.mp4");
  assert.equal(env.downloadCalls[0].filename, "LongTail/Vimeo Alpine Film.mp4");

  await env.chrome.runtime.sendMessage({ type: "CLEAR_FINISHED_TASKS" });

  // 4) Active ENQUEUE_BATCH_URLS + RETRY_TASK (url kind) with mixed long-tail URLs & blocked noise
  env.downloadCalls.length = 0;
  failVimeoFirstAttempt = true;
  const batchResp = await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_BATCH_URLS",
    urls: [
      "https://vimeo.com/123456",
      "https://soundcloud.com/artist/track-1",
      "chrome://settings",
      "http://localhost/ignored",
      "https://snap.dokitool.com/api/parse",
    ],
  });
  assert.equal(batchResp.ok, true);
  assert.equal(batchResp.data.taskIds.length, 2, "only valid long-tail URLs enqueued");
  await bg.waitForIdle();

  let snap = await bg.getSnapshot();
  const failedVimeo = snap.tasks.find((t) => t.status === "failed");
  const doneSoundCloud = snap.tasks.find((t) => t.status === "completed");
  assert.ok(failedVimeo && failedVimeo.retryPayload?.kind === "url");
  assert.ok(doneSoundCloud && doneSoundCloud.platform === "soundcloud");
  assert.ok(
    env.downloadCalls.some(
      (d) =>
        d.url === "https://cf-media.sndcdn.com/midnight-synth.mp3" &&
        d.filename === "LongTail/Midnight Synth/Midnight Synth.mp3",
    ),
  );

  // Retry failed long-tail URL task -> succeeds natively with 0 offscreen creates!
  const retryResp = await env.chrome.runtime.sendMessage({
    type: "RETRY_TASK",
    taskId: failedVimeo.taskId,
  });
  assert.equal(retryResp.ok, true);
  await bg.waitForIdle();
  snap = await bg.getSnapshot();
  assert.equal(snap.tasks.every((t) => t.status === "completed"), true);
  assert.equal(env.getOffscreenCreateCount(), 0, "still 0 offscreen creates for long-tail native downloads");

  bg.dispose();
});

test("[PR-C 2] Zero-<all_urls> native chrome.downloads.download lifecycle (complete, interrupted, OPEN_DOWNLOAD_FOLDER, savedWork, zero Offscreen) and background UNWHITELISTED_CDN guard for non-whitelisted streams + ZIP fallback", async () => {
  const fetchCalls = [];
  const offscreenMessages = [];
  const mockFetch = async (url) => {
    fetchCalls.push(String(url));
    throw new Error(`fetch must NEVER be invoked for native direct / blocked stream: ${url}`);
  };

  const env = createMockMv3Environment({ autoCompleteDownloads: false });
  env.chrome.runtime.onMessage.addListener((msg) => {
    if (protocol.isBackgroundToOffscreenRequest(msg)) {
      offscreenMessages.push(msg);
    }
    return false;
  });

  const extStorage = storage.createExtensionStorage();
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    fetchImpl: mockFetch,
    badgeSuccessDurationMs: 50,
  });
  await bg.init();

  // 1) Non-whitelisted direct_file -> straight to chrome.downloads.download with 0 Offscreen invocations!
  const enq1 = await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "Twitch Clip",
        platform: "twitch",
        workFingerprint: "twitch:2123456789",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://vod-metro.twitch.tv/video/clip.mp4"],
          filename: "DokiTool/Twitch Clip.mp4",
          mimeType: "video/mp4",
          sizeBytes: 8_500_000,
        },
      },
    ],
  });
  assert.equal(enq1.ok, true);
  const taskId1 = enq1.data.taskIds[0];

  for (let i = 0; i < 40 && env.downloadCalls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(env.getOffscreenCreateCount(), 0, "must NOT launch offscreen.html");
  assert.equal(fetchCalls.length, 0, "must NOT call fetch");
  assert.equal(env.downloadCalls.length, 1);
  assert.equal(env.downloadCalls[0].url, "https://vod-metro.twitch.tv/video/clip.mp4");
  assert.equal(env.downloadCalls[0].filename, "DokiTool/Twitch Clip.mp4");

  let snap = await bg.getSnapshot();
  assert.equal(snap.tasks[0].status, "downloading");
  assert.equal(snap.tasks[0].statusText, "浏览器原生下载中...");
  assert.equal(snap.tasks[0].chromeDownloadId, env.downloadCalls[0].id);

  // Emit onChanged complete -> completed, percent 100, savedWork recorded, badge ✓, NO RELEASE_BLOB sent!
  env.emitDownloadChanged({
    id: env.downloadCalls[0].id,
    state: { previous: "in_progress", current: "complete" },
  });
  await bg.waitForIdle();

  snap = await bg.getSnapshot();
  assert.equal(snap.tasks[0].status, "completed");
  assert.equal(snap.tasks[0].percent, 100);
  assert.equal(snap.tasks[0].chromeDownloadId, env.downloadCalls[0].id);
  assert.ok(snap.savedWorkFingerprints.includes("twitch:2123456789"));
  assert.equal(
    offscreenMessages.some((m) => m.type === "RELEASE_BLOB"),
    false,
    "native download without blobUrl must NOT send RELEASE_BLOB to offscreen",
  );
  const badgeTexts = env.badgeHistory
    .filter((b) => b.kind === "text")
    .map((b) => b.text);
  assert.ok(badgeTexts.includes("✓"), "badge must show ✓ on native download complete");

  // OPEN_DOWNLOAD_FOLDER calls chrome.downloads.show(downloadId)
  const showResp = await env.chrome.runtime.sendMessage({
    type: "OPEN_DOWNLOAD_FOLDER",
    taskId: taskId1,
  });
  assert.equal(showResp.ok, true);
  assert.equal(showResp.data.opened, true);
  assert.deepEqual(env.shownDownloads, [env.downloadCalls[0].id]);

  // 2) Interrupted native download -> marks failed cleanly
  await env.chrome.runtime.sendMessage({ type: "CLEAR_FINISHED_TASKS" });
  env.downloadCalls.length = 0;
  await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: [
      {
        title: "Reddit Video",
        platform: "reddit",
        spec: {
          kind: "direct_file",
          apiOrigin: "https://snap.dokitool.com",
          routes: ["https://v.redd.it/abc/DASH_720.mp4"],
          filename: "Reddit Video.mp4",
        },
      },
    ],
  });
  for (let i = 0; i < 40 && env.downloadCalls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  env.emitDownloadChanged({
    id: env.downloadCalls[0].id,
    state: { current: "interrupted" },
    error: { current: "NETWORK_FAILED" },
  });
  await bg.waitForIdle();
  snap = await bg.getSnapshot();
  assert.equal(snap.tasks[0].status, "failed");
  assert.match(snap.tasks[0].error || "", /NETWORK_FAILED/);

  // 3) Unsafe direct_file (private IP) AND non-whitelisted hls / dash_mux / segments -> fail cleanly in Background with UNWHITELISTED_CDN, 0 Offscreen, 0 chrome.downloads!
  await env.chrome.runtime.sendMessage({ type: "CLEAR_FINISHED_TASKS" });
  env.downloadCalls.length = 0;
  const blockedSpecs = [
    {
      title: "Private IP Direct",
      platform: "generic",
      spec: {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["http://192.168.1.50/private.mp4"],
        filename: "private.mp4",
      },
      expectedHost: "192.168.1.50",
    },
    {
      title: "Vimeo HLS Stream",
      platform: "vimeo",
      fallbackUrl: "https://vimeo.com/123456",
      spec: {
        kind: "hls",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://skyfire.vimeocdn.com/hls/master.m3u8"],
        filename: "vimeo.mp4",
      },
      expectedHost: "skyfire.vimeocdn.com",
    },
    {
      title: "Reddit DASH Mux",
      platform: "reddit",
      fallbackUrl: "https://www.reddit.com/r/videos/comments/abc/demo",
      spec: {
        kind: "dash_mux",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://v.redd.it/abc/DASH_1080.mp4"],
        filename: "reddit-mux.mp4",
        dashMux: {
          videoRoutes: ["https://v.redd.it/abc/DASH_1080.mp4"],
          audioRoutes: ["https://v.redd.it/abc/DASH_AUDIO_128.mp4"],
          outputContainer: "mp4",
        },
      },
      expectedHost: "v.redd.it",
    },
    {
      title: "LongTail Segments",
      platform: "dailymotion",
      spec: {
        kind: "segments",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://proxy-01.dmcdn.net/seg-0.m4s"],
        filename: "dm.mp4",
        segments: [{ url: "https://proxy-01.dmcdn.net/seg-0.m4s" }],
      },
      expectedHost: "proxy-01.dmcdn.net",
    },
  ];

  await env.chrome.runtime.sendMessage({
    type: "ENQUEUE_DOWNLOADS",
    items: blockedSpecs.map(({ expectedHost: _h, ...item }) => item),
  });
  await bg.waitForIdle();

  assert.equal(env.getOffscreenCreateCount(), 0, "0 offscreen launches for blocked specs");
  assert.equal(env.downloadCalls.length, 0, "0 chrome.downloads calls for blocked specs");
  assert.equal(fetchCalls.length, 0, "0 fetches for blocked specs");

  snap = await bg.getSnapshot();
  assert.equal(snap.tasks.length, blockedSpecs.length);
  for (const expected of blockedSpecs) {
    const task = snap.tasks.find((t) => t.title === expected.title);
    assert.ok(task, `missing task ${expected.title}`);
    assert.equal(task.status, "failed");
    assert.equal(task.lastErrorCode, "UNWHITELISTED_CDN");
    assert.equal(task.unwhitelistedHost, expected.expectedHost);
    assert.ok(task.fallbackUrl, `expected fallbackUrl on ${expected.title}`);
  }

  // 4) buildEnqueueItemsForMedia: batchSaveMode="zip" on non-whitelisted Reddit gallery falls back to individual direct_file subfolder items!
  const redditGallery = {
    platform: "reddit",
    content_id: "gal-1",
    source_url: "https://www.reddit.com/gallery/gal-1",
    title: "Alpine Photos",
    items: [
      {
        id: "img1",
        type: "image",
        index: 1,
        variants: [
          {
            id: "orig",
            metadata: { extension: "jpg" },
            delivery: {
              kind: "file",
              sources: [{ url: "https://i.redd.it/photo1.jpg" }],
            },
          },
        ],
        default: { variant_id: "orig", url: "https://i.redd.it/photo1.jpg" },
      },
      {
        id: "img2",
        type: "image",
        index: 2,
        variants: [
          {
            id: "orig",
            metadata: { extension: "jpg" },
            delivery: {
              kind: "file",
              sources: [{ url: "https://i.redd.it/photo2.jpg" }],
            },
          },
        ],
        default: { variant_id: "orig", url: "https://i.redd.it/photo2.jpg" },
      },
    ],
  };
  const galleryItems = extensionDownloadMod.buildEnqueueItemsForMedia(
    redditGallery,
    {
      apiOrigin: "https://snap.dokitool.com",
      batchSaveMode: "zip",
      subfolderPrefix: "Collect",
    },
  );
  assert.equal(
    galleryItems.length,
    2,
    "non-whitelisted gallery with batchSaveMode=zip must fall back to individual direct_file items",
  );
  assert.equal(galleryItems[0].spec.kind, "direct_file");
  assert.equal(galleryItems[1].spec.kind, "direct_file");
  assert.equal(galleryItems[0].spec.filename, "Collect/Alpine Photos/001.jpg");
  assert.equal(galleryItems[1].spec.filename, "Collect/Alpine Photos/002.jpg");

  bg.dispose();
});

test("[PR-C 3] UI & Selection: formatPlatformDisplayName, deliveryMode classification, progressive-over-HLS auto-selection, SidePanelResult external-only & audio UI, SidePanelBatchQueue mixed pills, and SidePanelApp manual long-tail parse", async () => {
  // 1) formatPlatformDisplayName friendly names + Title Case fallback
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("tiktok"), "TikTok");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("vimeo"), "Vimeo");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("reddit"), "Reddit");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("twitch"), "Twitch");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("twitchvod"), "Twitch");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("twitchclips"), "Twitch");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("soundcloud"), "SoundCloud");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("niconico"), "Niconico");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("pinterest"), "Pinterest");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("dailymotion"), "Dailymotion");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("vk"), "VK");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("streamable"), "Streamable");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("bandcamp"), "Bandcamp");
  assert.equal(uiTargetHelpersMod.formatPlatformDisplayName("bbc_iplayer"), "Bbc Iplayer");

  // 2) buildSidePanelQualityOptions + selectPreferredQualityOption + selectVariantByPreference
  const vimeoMedia = {
    platform: "vimeo",
    content_id: "987654",
    source_url: "https://vimeo.com/987654",
    title: "Mountain Time-Lapse",
    items: [
      {
        id: "v1",
        type: "video",
        variants: [
          {
            id: "hls-1080",
            label: "1080p HLS",
            metadata: { width: 1920, height: 1080, extension: "mp4", has_audio: true },
            delivery: {
              kind: "hls",
              scope: "single",
              sources: [{ url: "https://skyfire.vimeocdn.com/hls/1080.m3u8" }],
            },
          },
          {
            id: "dash-4k",
            label: "4K DASH",
            metadata: { width: 3840, height: 2160, extension: "mp4", has_audio: true },
            delivery: {
              kind: "mux",
              output: { container: "mp4", extension: "mp4", mime_type: "video/mp4" },
              resources: [
                {
                  id: "vid",
                  role: "video",
                  metadata: { width: 3840, height: 2160, video_codec: "avc1.640033" },
                  delivery: {
                    kind: "file",
                    sources: [{ url: "https://skyfire.vimeocdn.com/dash/video.m4s" }],
                  },
                },
                {
                  id: "aud",
                  role: "audio",
                  metadata: { audio_codec: "mp4a.40.2" },
                  delivery: {
                    kind: "file",
                    sources: [{ url: "https://skyfire.vimeocdn.com/dash/audio.m4s" }],
                  },
                },
              ],
            },
          },
          {
            id: "mp4-720",
            label: "720p MP4",
            metadata: { width: 1280, height: 720, extension: "mp4", has_audio: true },
            delivery: {
              kind: "file",
              sources: [
                { url: "https://skyfire.vimeocdn.com/prog/720p.mp4", size_bytes: 20_000_000 },
              ],
            },
          },
        ],
        default: {
          variant_id: "mp4-720",
          url: "https://skyfire.vimeocdn.com/prog/720p.mp4",
        },
      },
    ],
  };

  const options = uiTargetHelpersMod.buildSidePanelQualityOptions(
    vimeoMedia,
    vimeoMedia.items[0],
    "https://snap.dokitool.com",
  );
  const hlsOpt = options.find((o) => o.variant.id === "hls-1080");
  const dashOpt = options.find((o) => o.variant.id === "dash-4k");
  const mp4Opt = options.find((o) => o.variant.id === "mp4-720");

  assert.equal(hlsOpt.deliveryMode, "external_only");
  assert.equal(hlsOpt.downloadable, false);
  assert.ok(hlsOpt.externalOnlyReason);

  assert.equal(dashOpt.deliveryMode, "external_only");
  assert.equal(dashOpt.downloadable, false);
  assert.ok(dashOpt.externalOnlyReason);

  assert.equal(mp4Opt.deliveryMode, "native_direct");
  assert.equal(mp4Opt.downloadable, true);

  // Also verify adaptive HLS (emitted by ytengine.AdaptInfo with EnableHLS: true) preserves copyUrl + external_only reason
  const adaptiveHlsMedia = {
    ...vimeoMedia,
    items: [
      {
        ...vimeoMedia.items[0],
        variants: [
          {
            id: "hls-adaptive-1080",
            label: "1080p HLS 需合流",
            metadata: { width: 1920, height: 1080, has_audio: true },
            delivery: {
              kind: "hls",
              scope: "adaptive",
              sources: [{ url: "https://skyfire.vimeocdn.com/adaptive/master.m3u8" }],
              output: { container: "mp4", extension: "mp4", mime_type: "video/mp4" },
            },
          },
          vimeoMedia.items[0].variants[2],
        ],
      },
    ],
  };
  const adaptiveOpts = uiTargetHelpersMod.buildSidePanelQualityOptions(
    adaptiveHlsMedia,
    adaptiveHlsMedia.items[0],
    "https://snap.dokitool.com",
  );
  const adaptiveHlsOpt = adaptiveOpts.find((o) => o.variant.id === "hls-adaptive-1080");
  assert.equal(adaptiveHlsOpt?.deliveryMode, "external_only");
  assert.equal(adaptiveHlsOpt?.downloadable, false);
  assert.equal(adaptiveHlsOpt?.copyUrl, "https://skyfire.vimeocdn.com/adaptive/master.m3u8");
  assert.match(adaptiveHlsOpt?.externalOnlyReason || "", /白名单/);

  // Both UI and background preference selectors pick downloadable native_direct 720p MP4 over higher-res external_only HLS/DASH!
  for (const pref of ["best", "1080p"]) {
    const uiPicked = uiTargetHelpersMod.selectPreferredQualityOption(
      options,
      vimeoMedia.items[0],
      pref,
      vimeoMedia,
      "https://snap.dokitool.com",
    );
    assert.equal(uiPicked?.variant.id, "mp4-720", `UI selector (${pref}) must prefer native_direct over external_only`);

    const bgPicked = extensionDownloadMod.selectVariantByPreference(
      vimeoMedia.items[0],
      vimeoMedia.attachments,
      pref,
      "https://snap.dokitool.com",
    );
    assert.equal(bgPicked?.variant.id, "mp4-720", `BG selector (${pref}) must prefer native_direct over external_only`);
  }

  // 3) Mounted SidePanelResult.vue: renders 浏览器直下, 需外链 · 非白名单流, external-only-fallback buttons, AND SoundCloud audio item
  const SidePanelResult = await loadSidePanelSfc(
    "../src/extension/components/SidePanelResult.vue",
  );
  const settings = { ...storage.DEFAULT_EXTENSION_SETTINGS };
  const vimeoView = mountSfcTree(SidePanelResult, {
    media: vimeoMedia,
    workFingerprint: "vimeo:987654",
    isSaved: false,
    settings,
    resolvingItemIds: new Set(),
  });
  try {
    await vimeoView.flush();
    const nativeBadges = vimeoView.findAll(
      (n) => n.props?.["data-testid"] === "native-direct-badge",
    );
    const extBadges = vimeoView.findAll(
      (n) => n.props?.["data-testid"] === "external-only-badge",
    );
    const extFallbacks = vimeoView.findAll(
      (n) => n.props?.["data-testid"] === "external-only-fallback",
    );
    assert.ok(nativeBadges.length >= 1, "renders 浏览器直下 badge on native_direct options");
    assert.ok(vimeoView.textOf(nativeBadges[0]).includes("浏览器直下"));
    const nativeNotices = vimeoView.findAll(
      (n) => n.props?.["data-testid"] === "native-direct-notice",
    );
    assert.ok(nativeNotices.length >= 1, "Q5A: renders honest native-direct-notice disclosure");
    assert.match(vimeoView.textOf(nativeNotices[0]), /移交浏览器原生下载器/);
    assert.match(vimeoView.textOf(nativeNotices[0]), /不代理请求/);
    assert.match(vimeoView.textOf(nativeNotices[0]), /不读取响应体/);
    assert.match(vimeoView.textOf(nativeNotices[0]), /不附加\s*Cookie/);
    assert.equal(extBadges.length, 2);
    assert.ok(vimeoView.textOf(extBadges[0]).includes("需外链 · 非白名单流"));
    assert.equal(extFallbacks.length, 2);
    // HLS fallback includes BOTH 复制直链 and 打开原帖 buttons
    const collectButtons = (root) => {
      const out = [];
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (node.type === "button") out.push(node);
        for (const ch of node.children || []) walk(ch);
      };
      walk(root);
      return out;
    };
    // Canonical sort orders external_only options by descending resolution (4K DASH > 1080p HLS):
    // DASH mux fallback has no direct copyUrl, so it renders only 打开原帖 button
    const dashFallbackBtnLabels = collectButtons(extFallbacks[0]).map((b) =>
      vimeoView.textOf(b).trim(),
    );
    assert.deepEqual(dashFallbackBtnLabels, ["打开原帖"]);
    // HLS fallback includes BOTH 复制直链 and 打开原帖 buttons
    const hlsFallbackBtnLabels = collectButtons(extFallbacks[1]).map((b) =>
      vimeoView.textOf(b).trim(),
    );
    assert.deepEqual(hlsFallbackBtnLabels, ["复制直链", "打开原帖"]);
  } finally {
    vimeoView.unmount();
  }

  // SoundCloud item.type === "audio" preview & download
  const soundCloudMedia = {
    platform: "soundcloud",
    content_id: "sc-track-9",
    source_url: "https://soundcloud.com/artist/midnight",
    title: "Midnight Groove",
    cover: { url: "https://i1.sndcdn.com/artworks-1-large.jpg" },
    items: [
      {
        id: "sc-a1",
        type: "audio",
        variants: [
          {
            id: "mp3",
            label: "MP3 128kbps",
            metadata: {
              extension: "mp3",
              mime_type: "audio/mpeg",
              has_audio: true,
              audio_bitrate_bps: 128000,
            },
            delivery: {
              kind: "file",
              sources: [
                { url: "https://cf-media.sndcdn.com/midnight.mp3", size_bytes: 3_500_000 },
              ],
            },
          },
        ],
        default: { variant_id: "mp3", url: "https://cf-media.sndcdn.com/midnight.mp3" },
      },
    ],
  };
  const audioEnqueues = [];
  const scView = mountSfcTree(
    SidePanelResult,
    {
      media: soundCloudMedia,
      workFingerprint: "soundcloud:sc-track-9",
      isSaved: false,
      settings,
      resolvingItemIds: new Set(),
    },
    { onEnqueueDownloads: (payload) => audioEnqueues.push(payload) },
  );
  try {
    await scView.flush();
    const audioStage = scView.findAll(
      (n) => n.props?.["data-testid"] === "audio-preview-stage",
    );
    assert.equal(audioStage.length, 1, "SoundCloud audio item renders dedicated audio preview stage");
    const audioEls = scView.findAll((n) => n.type === "audio");
    assert.equal(audioEls.length, 1);
    assert.equal(audioEls[0].props.src, "https://cf-media.sndcdn.com/midnight.mp3");
    const mainBtn = scView.findAll(
      (n) =>
        n.type === "button" &&
        typeof n.props.class === "string" &&
        n.props.class.includes("sp-cta-row__main"),
    )[0];
    assert.ok(scView.textOf(mainBtn).includes("下载音频 (MP3)"));
    await scView.fire(mainBtn, "onClick");
    assert.equal(audioEnqueues.length, 1);
    assert.equal(audioEnqueues[0].items[0].spec.kind, "direct_file");
    assert.ok(audioEnqueues[0].items[0].spec.filename.endsWith(".mp3"));
  } finally {
    scView.unmount();
  }

  // 4) SidePanelBatchQueue.vue extracts mixed core-14 + long-tail URLs with distinct pills
  const SidePanelBatchQueue = await loadSidePanelSfc(
    "../src/extension/components/SidePanelBatchQueue.vue",
  );
  const batchView = mountSfcTree(SidePanelBatchQueue, {
    modelValue: [
      "https://www.bilibili.com/video/BV1uv411q7Mv",
      "https://vimeo.com/987654",
      "https://www.twitch.tv/videos/2123456789",
      "chrome://extensions",
      "http://localhost/admin",
    ].join("\n"),
    settings,
    tasks: [],
    activeBatchGroupId: "",
    submitting: false,
  });
  try {
    await batchView.flush();
    const text = batchView.textOf();
    assert.ok(text.includes("识别有效链接 3 条"));
    assert.ok(text.includes("B站 ×1"));
    assert.ok(text.includes("vimeo.com ×1"));
    assert.ok(text.includes("twitch.tv ×1"));
    assert.ok(text.includes("已忽略 2 行无关内容"));
  } finally {
    batchView.unmount();
  }

  // 5) SidePanelApp.vue: manual submit parses Vimeo long-tail URL while passive tab browsing makes 0 calls
  const SidePanelApp = await loadSidePanelSfc("../src/extension/SidePanelApp.vue");
  const prevChrome = globalThis.chrome;
  const appApiUrls = [];
  const env = createMockMv3Environment({ autoCompleteDownloads: true });
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: storage.createExtensionStorage(),
    fetchImpl: async (url) => {
      appApiUrls.push(String(url));
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: vimeoMedia,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
    tabSyncDebounceMs: 10,
  });
  await bg.init();
  globalThis.chrome = env.chrome;
  let appView = null;
  try {
    appView = mountSfcTree(SidePanelApp);
    await new Promise((r) => setTimeout(r, 30));
    await appView.flush();

    // Passive tab update on Vimeo -> 0 API calls
    env.emitTabUpdated(
      1,
      { status: "complete", url: "https://vimeo.com/987654" },
      { id: 1, windowId: 10, active: true, url: "https://vimeo.com/987654" },
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(appApiUrls.length, 0, "SidePanelApp must make 0 calls on long-tail tab navigation");

    // Manual paste & submit on Vimeo -> sends PARSE_URL with platform=all and renders Vimeo result!
    const inputEl = appView.findAll((n) => n.type === "input")[0];
    inputEl.value = "https://vimeo.com/987654";
    inputEl.dispatchEvent({ type: "input", target: inputEl });
    await appView.flush();
    const formEl = appView.findAll((n) => n.type === "form")[0];
    await appView.fire(formEl, "onSubmit", { preventDefault() {} });
    await new Promise((r) => setTimeout(r, 30));
    await appView.flush();

    assert.equal(appApiUrls.length, 1);
    assert.ok(appApiUrls[0].includes("platform=all"));
    assert.ok(appView.textOf().includes("Mountain Time-Lapse"));
    assert.ok(appView.textOf().includes("Vimeo"));
  } finally {
    appView?.unmount();
    globalThis.chrome = prevChrome;
    bg.dispose();
  }
});

