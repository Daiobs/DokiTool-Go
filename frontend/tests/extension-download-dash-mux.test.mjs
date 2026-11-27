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

    // Primary CTA clearly says "下载视频 (1080p)"
    const mainBtn = view.findAll(
      (n) =>
        n.type === "button" &&
        typeof n.props.class === "string" &&
        n.props.class.includes("sp-cta-row__main"),
    )[0];
    assert.ok(mainBtn);
    assert.ok(
      view.textOf(mainBtn).includes("下载视频 (1080p)"),
      `expected concise primary CTA label, got: ${view.textOf(mainBtn)}`,
    );
    assert.equal(view.textOf(mainBtn).includes("无损合流"), false);

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
        sizeBytes: fullBytes.byteLength,
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
        sizeBytes: fullBytes.byteLength,
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
        sizeBytes: 4096,
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

