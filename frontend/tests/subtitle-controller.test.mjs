import assert from "node:assert/strict";
import test from "node:test";
import * as subtitleController from "../src/core/media/subtitleController.ts";
import * as subtitleEngine from "../src/core/media/subtitleEngine.ts";

function makeTrack(id, language, url, format = "vtt") {
  return {
    id,
    attachment: { id, role: "subtitle" },
    label: language.toUpperCase(),
    language,
    trackKind: "manual",
    format,
    url,
    routes: [url],
  };
}

const SAMPLE_VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello world\n";

test("subtitleController: syncTracks and primary/secondary mutual exclusion & auto-clear", () => {
  const states = [];
  const ctrl = subtitleController.createSubtitleDownloadController({
    getBaseTitle: () => "Demo",
    formatError: () => "ERR",
    formatEmptyCuesError: () => "EMPTY",
    formatSuccessStatus: (r) => `OK:${r.filename}`,
    onStateChange: (s) => states.push(s),
  });

  const t1 = makeTrack("t1", "en", "https://cdn.example.com/en.vtt");
  const t2 = makeTrack("t2", "zh", "https://cdn.example.com/zh.vtt");
  const t3 = makeTrack("t3", "ja", "https://cdn.example.com/ja.vtt");

  ctrl.syncTracks([t1, t2, t3]);
  assert.equal(ctrl.getState().primaryId, "t1");
  assert.equal(ctrl.getState().secondaryId, "");
  assert.equal(ctrl.getState().canMergeBilingual, true);
  assert.deepEqual(
    ctrl.getState().secondaryCandidates.map((t) => t.id),
    ["t2", "t3"],
  );

  ctrl.setSecondaryId("t2");
  assert.equal(ctrl.getState().secondaryId, "t2");
  assert.equal(ctrl.getState().secondaryTrack?.id, "t2");

  // Switching primary to current secondary clears secondaryId automatically
  ctrl.setPrimaryId("t2");
  assert.equal(ctrl.getState().primaryId, "t2");
  assert.equal(ctrl.getState().secondaryId, "");
  assert.equal(ctrl.getState().secondaryTrack, null);

  // Syncing a track list without t2 falls back to first track and clears stale secondary
  ctrl.setSecondaryId("t3");
  ctrl.syncTracks([t1]);
  assert.equal(ctrl.getState().primaryId, "t1");
  assert.equal(ctrl.getState().secondaryId, "");
  assert.equal(ctrl.getState().canMergeBilingual, false);
  assert.ok(states.length >= 4);
});

test("subtitleController: busyKey re-entrancy lock blocks concurrent double-clicks", async () => {
  let fetchCount = 0;
  let resolveFetch;
  const fetchImpl = () => {
    fetchCount += 1;
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };

  const ctrl = subtitleController.createSubtitleDownloadController({
    getBaseTitle: () => "Concurrency",
    getFetchImpl: () => fetchImpl,
    formatError: (err) => String(err),
    formatEmptyCuesError: () => "EMPTY",
    formatSuccessStatus: (r) => `SAVED:${r.filename}`,
    deliverDownload: () => {},
  });

  const t1 = makeTrack("t1", "en", "https://cdn.example.com/en.vtt");
  ctrl.syncTracks([t1]);

  const first = ctrl.downloadConfigured();
  assert.equal(ctrl.getState().busyKey, "configured");
  assert.equal(fetchCount, 1);

  // Second concurrent click is ignored while busyKey is active
  await ctrl.runDownload(t1, null, "srt", "t1:srt");
  assert.equal(fetchCount, 1);
  assert.equal(ctrl.getState().busyKey, "configured");

  resolveFetch(new Response(SAMPLE_VTT, { status: 200 }));
  await first;
  assert.equal(ctrl.getState().busyKey, "");
  assert.equal(ctrl.getState().statusMessage, "SAVED:Concurrency.en.vtt");
});

test("subtitleController: dispose() aborts in-flight fetch silently without error flash", async () => {
  let capturedSignal = null;
  let rejectFetch;
  const fetchImpl = (_url, init) => {
    capturedSignal = init?.signal ?? null;
    return new Promise((_resolve, reject) => {
      rejectFetch = reject;
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };

  const ctrl = subtitleController.createSubtitleDownloadController({
    getBaseTitle: () => "AbortTest",
    getFetchImpl: () => fetchImpl,
    formatError: () => "UNEXPECTED_ERROR",
    formatEmptyCuesError: () => "EMPTY",
    formatSuccessStatus: () => "OK",
    deliverDownload: () => {},
  });

  const t1 = makeTrack("t1", "en", "https://cdn.example.com/en.vtt");
  ctrl.syncTracks([t1]);
  const pending = ctrl.downloadConfigured();
  assert.equal(capturedSignal?.aborted, false);

  ctrl.dispose();
  assert.equal(capturedSignal?.aborted, true);
  assert.ok(typeof rejectFetch === "function");
  await pending;

  assert.equal(ctrl.getState().errorMessage, "");
  assert.equal(ctrl.getState().statusMessage, "");
  assert.equal(ctrl.getState().busyKey, "");
});

test("subtitleController: empty cues, >5 MiB byte cap, and extension SUBTITLE_UNWHITELISTED rejection", async () => {
  // 1) Empty cues
  const emptyCtrl = subtitleController.createSubtitleDownloadController({
    getBaseTitle: () => "Empty",
    getFetchImpl: () => async () => new Response("WEBVTT\n\n", { status: 200 }),
    formatError: () => "ERR",
    formatEmptyCuesError: () => "NO_VALID_CUES",
    formatSuccessStatus: () => "OK",
    deliverDownload: () => {
      throw new Error("must not download empty cues");
    },
  });
  const t1 = makeTrack("t1", "en", "https://cdn.example.com/en.vtt");
  emptyCtrl.syncTracks([t1]);
  await emptyCtrl.downloadConfigured();
  assert.equal(emptyCtrl.getState().errorMessage, "NO_VALID_CUES");
  assert.equal(emptyCtrl.getState().statusMessage, "");

  // 2) > 5 MiB cap enforcement
  const oversizeBytes = subtitleEngine.MAX_SUBTITLE_TRACK_BYTES + 1024;
  const oversizeCtrl = subtitleController.createSubtitleDownloadController({
    getBaseTitle: () => "Oversize",
    getFetchImpl: () => async () =>
      new Response("WEBVTT", {
        status: 200,
        headers: { "content-length": String(oversizeBytes) },
      }),
    formatError: (err) => `ERR:${err?.code || "UNKNOWN"}`,
    formatEmptyCuesError: () => "EMPTY",
    formatSuccessStatus: () => "OK",
    deliverDownload: () => {},
  });
  oversizeCtrl.syncTracks([t1]);
  await oversizeCtrl.downloadConfigured();
  assert.equal(oversizeCtrl.getState().errorMessage, "ERR:SUBTITLE_TOO_LARGE");

  // 3) Extension host validateBeforeDownload blocks non-whitelisted tracks with zero fetches
  let extFetched = 0;
  const extCtrl = subtitleController.createSubtitleDownloadController({
    getBaseTitle: () => "ExtGuard",
    validateBeforeDownload: () => {
      throw Object.assign(new Error("blocked"), { code: "SUBTITLE_UNWHITELISTED" });
    },
    fetchTrackText: async () => {
      extFetched += 1;
      return SAMPLE_VTT;
    },
    formatError: (err) => `EXT:${err?.code || "UNKNOWN"}`,
    formatEmptyCuesError: () => "EMPTY",
    formatSuccessStatus: () => "OK",
    deliverDownload: () => {},
  });
  extCtrl.syncTracks([t1]);
  await extCtrl.downloadConfigured();
  assert.equal(extFetched, 0);
  assert.equal(extCtrl.getState().errorMessage, "EXT:SUBTITLE_UNWHITELISTED");
});

test("subtitleController: successful export triggers Blob URL creation, anchor click, and delayed revokeObjectURL", async () => {
  const createdUrls = [];
  const revokedUrls = [];
  const scheduled = [];
  let clicked = 0;
  let removed = 0;
  let lastLink = null;
  let notified = null;

  const fakeEnv = {
    BlobCtor: Blob,
    urlApi: {
      createObjectURL(blob) {
        const url = `blob:test/${createdUrls.length + 1}`;
        createdUrls.push({ url, type: blob.type, size: blob.size });
        return url;
      },
      revokeObjectURL(url) {
        revokedUrls.push(url);
      },
    },
    doc: {
      createElement(tag) {
        assert.equal(tag, "a");
        lastLink = {
          href: "",
          download: "",
          rel: "",
          style: {},
          click() {
            clicked += 1;
          },
          remove() {
            removed += 1;
          },
        };
        return lastLink;
      },
      body: { appendChild() {} },
    },
    scheduleRevoke(fn, delayMs) {
      scheduled.push({ fn, delayMs });
    },
    revokeDelayMs: 1000,
  };

  const ctrl = subtitleController.createSubtitleDownloadController({
    getBaseTitle: () => "ExportDemo",
    getFetchImpl: () => async () => new Response(SAMPLE_VTT, { status: 200 }),
    formatError: (err) => String(err),
    formatEmptyCuesError: () => "EMPTY",
    formatSuccessStatus: (r) => `DONE:${r.filename}:${r.cueCount}`,
    onSuccess: (r) => {
      notified = r.filename;
    },
    blobDownloadEnv: fakeEnv,
  });

  const t1 = makeTrack("t1", "en", "https://cdn.example.com/en.vtt");
  ctrl.syncTracks([t1]);
  ctrl.setTargetFormat("srt");
  await ctrl.downloadConfigured();

  assert.equal(ctrl.getState().statusMessage, "DONE:ExportDemo.en.srt:1");
  assert.equal(notified, "ExportDemo.en.srt");
  assert.equal(createdUrls.length, 1);
  assert.equal(createdUrls[0].type, "application/x-subrip;charset=utf-8");
  assert.equal(lastLink.download, "ExportDemo.en.srt");
  assert.equal(lastLink.rel, "noopener");
  assert.equal(clicked, 1);
  assert.equal(removed, 1);
  assert.equal(revokedUrls.length, 0);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 1000);

  scheduled[0].fn();
  assert.deepEqual(revokedUrls, ["blob:test/1"]);
});
