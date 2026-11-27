import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as model from "../src/extension/sidePanelResultModel.ts";
import { collectTransitiveImportGraph } from "./helpers/staticImportGraph.mjs";

const MODEL_PATH = fileURLToPath(
  new URL("../src/extension/sidePanelResultModel.ts", import.meta.url),
);
const bundleInputs = collectTransitiveImportGraph(MODEL_PATH);

const CTX = { apiOrigin: "https://snap.dokitool.com" };

function makeFileSource(url, extra = {}) {
  return {
    id: extra.id || "s1",
    url,
    access: extra.access || "direct",
    ...(extra.direct_url ? { direct_url: extra.direct_url } : {}),
  };
}

function makeReadyVideoItem(id, title, url, extra = {}) {
  return {
    id,
    type: extra.type || "video",
    title,
    state: "ready",
    default: { variant_id: extra.defaultVariantId || "v1" },
    ...(extra.cover ? { cover: extra.cover } : {}),
    variants: extra.variants || [
      {
        id: "v1",
        state: "ready",
        label: "1080p",
        metadata: { width: 1920, height: 1080, has_audio: true, video_codec: "avc1", extension: "mp4" },
        delivery: { kind: "file", sources: [makeFileSource(url)] },
      },
    ],
  };
}

function makeLivePhotoItem(id, imageUrl, motionUrl) {
  return {
    id,
    type: "live_photo",
    title: "Live",
    state: "ready",
    default: { variant_id: "lp1" },
    variants: [
      {
        id: "lp1",
        state: "ready",
        label: "LivePhoto",
        delivery: {
          kind: "pair",
          resources: [
            { role: "image", delivery: { kind: "file", sources: [makeFileSource(imageUrl, { id: "img" })] } },
            { role: "motion", delivery: { kind: "file", sources: [makeFileSource(motionUrl, { id: "mov" })] } },
          ],
        },
      },
    ],
  };
}

function makeOption(overrides = {}) {
  const id = overrides.variantId || "v1";
  const height = overrides.height ?? 1080;
  const width = overrides.width ?? Math.round((height * 16) / 9);
  const directUrl = overrides.directUrl ?? `https://cdn.example.com/${id}.mp4`;
  return {
    key: overrides.key || `variant:${id}`,
    kind: overrides.kind || "variant",
    variant: {
      id,
      state: "ready",
      label: overrides.label || `${height}p`,
      metadata: {
        width: overrides.isAudioOnly ? undefined : width,
        height: overrides.isAudioOnly ? undefined : height,
        fps: overrides.fps ?? 30,
        has_audio: overrides.hasAudio ?? true,
        video_codec: overrides.isAudioOnly ? undefined : overrides.videoCodec || "avc1",
        extension: overrides.resolvedExt || "mp4",
      },
      delivery: { kind: "file", sources: [makeFileSource(directUrl)] },
    },
    downloadTarget: overrides.downloadTarget || {
      kind: "file",
      url: directUrl,
      routes: overrides.routes || [directUrl],
    },
    downloadable: overrides.downloadable ?? true,
    deliveryMode: overrides.deliveryMode || "opfs",
    isAudioOnly: overrides.isAudioOnly ?? false,
    effectiveHasAudio: overrides.effectiveHasAudio ?? true,
    shortEdge: overrides.shortEdge ?? (overrides.isAudioOnly ? 0 : height),
    bitrateBps: overrides.bitrateBps ?? 1_000_000,
    sizeBytes: overrides.sizeBytes ?? 10_000_000,
    muxPair: overrides.muxPair ?? null,
    isDashMux: overrides.isDashMux ?? false,
    resolvedExt: overrides.resolvedExt || "mp4",
    directUrl,
    copyUrl: overrides.copyUrl ?? directUrl,
    routes: overrides.routes ?? [directUrl],
  };
}

test("sidePanelResultModel purity: zero Vue/DOM/Chrome/side-effect imports or globals", () => {
  const raw = readFileSync(MODEL_PATH, "utf8");
  for (const forbidden of [
    /from\s+["']vue["']/,
    /\.vue["']/,
    /uiTargetHelpers/,
    /extensionDownload/,
    /offscreen/,
    /opfsStreamTransfer/,
    /dashMuxDownload/,
    /youtubeExtensionBridge/,
    /\bwindow\./,
    /\bdocument\./,
    /\bchrome\./,
    /\bnavigator\.storage\b/,
    /\bfetch\s*\(/,
  ]) {
    assert.equal(forbidden.test(raw), false, `sidePanelResultModel.ts must not match ${forbidden}`);
  }
  for (const inp of bundleInputs) {
    for (const bad of [
      ".vue",
      "uiTargetHelpers",
      "extensionDownload",
      "offscreen",
      "opfsStreamTransfer",
      "dashMuxDownload",
      "youtubeExtensionBridge",
      "storage.ts",
      "jszip",
    ]) {
      assert.equal(inp.includes(bad), false, `bundle must not depend on ${bad} (found ${inp})`);
    }
  }
});

test("multi-P / gallery collections and checklist set operations", () => {
  const ep1 = makeReadyVideoItem("ep1", "第一讲", "https://cdn.bilivideo.com/ep1.mp4");
  const ep2 = { id: "ep2", type: "video", title: "第二讲", state: "deferred", resolve_url: "/api/resolve?item_id=ep2" };
  const ep3 = { id: "ep3", type: "video", title: "已下架", state: "unavailable" };
  const img1 = makeReadyVideoItem("img1", "封面图", "https://cdn.example.com/1.jpg", { type: "image" });
  const lp1 = makeLivePhotoItem("lp1", "https://cdn.example.com/lp.jpg", "https://cdn.example.com/lp.mp4");

  const media = {
    platform: "bilibili",
    content_id: "BV123",
    title: "合集主标题",
    default_item_id: "ep2",
    items: [ep1, ep2, ep3, img1, lp1],
    groups: [
      { id: "g-album", kind: "album", title: "图集", item_ids: ["img1", "lp1"] },
      { id: "g-s1", kind: "collection", title: "第一季", item_ids: ["ep1"] },
      { id: "g-s2", kind: "collection", title: "第二季", item_ids: ["ep2", "ep3"] },
    ],
  };

  // Non-album collections & initial selection locates default_item_id in collection index 1
  const colState0 = model.deriveSidePanelCollections(media, 0);
  assert.equal(colState0.collections.length, 2);
  assert.deepEqual(colState0.visibleEpisodes.map((e) => e.id), ["ep1"]);
  assert.equal(colState0.albumItems.length, 2);
  assert.equal(colState0.hasLivePhotos, true);

  const initial = model.resolveInitialActiveSelection(media, colState0.collections);
  assert.deepEqual(initial, { activeCollectionIdx: 1, activeItemId: "ep2" });

  const colState1 = model.deriveSidePanelCollections(media, 1);
  assert.deepEqual(colState1.visibleEpisodes.map((e) => e.id), ["ep2", "ep3"]);

  // Checklist pool per layoutKind
  assert.deepEqual(
    model.resolveChecklistPool("multi_video", media.items, colState1.albumItems, colState1.visibleEpisodes).map((i) => i.id),
    ["ep2", "ep3"],
  );
  assert.deepEqual(
    model.resolveChecklistPool("album", media.items, colState1.albumItems, colState1.visibleEpisodes).map((i) => i.id),
    ["img1", "lp1"],
  );
  assert.equal(model.resolveChecklistPool("mixed", media.items, colState1.albumItems, colState1.visibleEpisodes).length, 5);
  assert.deepEqual(model.resolveChecklistPool("single", media.items, colState1.albumItems, colState1.visibleEpisodes), []);

  // Set operations: selectAll skips unavailable, toggle ignores unavailable, invert skips unavailable
  const pool = [ep1, ep2, ep3];
  const allChecked = model.buildAllCheckedIdSet(pool);
  assert.deepEqual([...allChecked], ["ep1", "ep2"]);

  const afterToggleUnavailable = model.toggleChecklistItemId(allChecked, ep3);
  assert.deepEqual([...afterToggleUnavailable], ["ep1", "ep2"]);

  const afterUncheckEp1 = model.toggleChecklistItemId(allChecked, ep1);
  assert.deepEqual([...afterUncheckEp1], ["ep2"]);

  const afterInvert = model.invertChecklistIdSet(pool, afterUncheckEp1);
  assert.deepEqual([...afterInvert], ["ep1"]);

  const summary = model.summarizeChecklistSelection(pool, afterInvert);
  assert.deepEqual(summary, { checkedCount: 1, checkableTotalCount: 2, allChecked: false });

  // Deferred filtering, resolve_url preservation & merge
  const entries = model.buildSelectedChecklistEntries(pool, allChecked, {}, () => []);
  assert.equal(entries.length, 2);
  assert.deepEqual(model.filterDeferredResolvableEntries(entries).map((e) => e.item.id), ["ep2"]);

  const resolvedEp2 = makeReadyVideoItem("ep2", "第二讲", "https://cdn.bilivideo.com/ep2.mp4");
  const preserved = model.preserveOriginalResolveUrl(ep2, resolvedEp2);
  assert.equal(preserved.resolve_url, "/api/resolve?item_id=ep2");

  const merged = model.mergeResolvedChecklistEntries(entries, new Map([["ep2", preserved]]));
  assert.deepEqual(merged.map((e) => e.item.id), ["ep1", "ep2"]);
  assert.equal(merged[1].item.state, "ready");

  // Mixed badges & titles
  assert.deepEqual(model.resolveMixedItemTypeBadge(lp1), { text: "LIVE", tone: "live" });
  assert.deepEqual(model.resolveMixedItemTypeBadge(img1), { text: "图片", tone: "image" });
  assert.equal(model.resolveMixedItemDisplayTitle({ type: "video", title: "合集主标题" }, 0, "合集主标题"), "视频片段 #1");
  assert.equal(model.resolveMixedItemDisplayTitle({ type: "video", title: "独立片段" }, 0, "合集主标题"), "独立片段");
});

test("table-driven quality candidate sorting & default selection decisions", () => {
  const opt4k = makeOption({ variantId: "v4k", height: 2160, fps: 60, bitrateBps: 15_000_000, videoCodec: "av01" });
  const opt1080Avc = makeOption({ variantId: "v1080-avc", height: 1080, fps: 30, bitrateBps: 4_000_000, videoCodec: "avc1" });
  const opt1080Hevc = makeOption({ variantId: "v1080-hevc", height: 1080, fps: 30, bitrateBps: 4_000_000, videoCodec: "hvc1" });
  const opt720 = makeOption({ variantId: "v720", height: 720, fps: 30, bitrateBps: 2_000_000, videoCodec: "avc1" });
  const optAudioM4a = makeOption({ variantId: "a-m4a", isAudioOnly: true, resolvedExt: "m4a", bitrateBps: 128_000 });
  const optAudioWebm = makeOption({ variantId: "a-webm", isAudioOnly: true, resolvedExt: "webm", bitrateBps: 160_000 });
  const optExternal = makeOption({ variantId: "v-ext", height: 4320, downloadable: false, deliveryMode: "external_only" });

  const sorted = model.sortResultQualityCandidates([optExternal, optAudioWebm, opt720, opt1080Hevc, opt4k, opt1080Avc, optAudioM4a]);
  assert.equal(sorted[0].variant.id, "v4k");
  assert.equal(sorted[1].variant.id, "v1080-avc");
  assert.equal(sorted[2].variant.id, "v1080-hevc");
  assert.equal(sorted[sorted.length - 1].variant.id, "v-ext");

  const itemWithDefault720 = makeReadyVideoItem("i1", "Demo", "https://cdn.example.com/v720.mp4", { defaultVariantId: "v720" });

  const selectionCases = [
    { name: "best picks 4K60 over 1080p", pref: "best", opts: sorted, expected: "v4k" },
    { name: "1080p picks 1080p H.264 over HEVC and skips 4K", pref: "1080p", opts: sorted, expected: "v1080-avc" },
    { name: "1080p with only 4K/2K picks smallest above 1080p", pref: "1080p", opts: [opt4k, makeOption({ variantId: "v2k", height: 1440 })], expected: "v2k" },
    { name: "audio prefers m4a over higher-bitrate webm", pref: "audio", opts: sorted, expected: "a-m4a" },
    { name: "audio falls back to default when no standalone audio", pref: "audio", opts: [opt4k, opt720], expected: "v720" },
    { name: "all external_only falls back to first option", pref: "best", opts: [optExternal], expected: "v-ext" },
  ];

  for (const tc of selectionCases) {
    const picked = model.selectDefaultQualityCandidate(tc.opts, itemWithDefault720, tc.pref);
    assert.equal(picked?.variant.id, tc.expected, tc.name);
  }

  // Explicit saved user key overrides preference unless stale
  const activeSaved = model.resolveActiveQualitySelection({
    options: sorted,
    item: itemWithDefault720,
    selectedOptionKeyByItem: { i1: "variant:v720" },
    preference: "best",
  });
  assert.equal(activeSaved?.variant.id, "v720");

  const activeStale = model.resolveActiveQualitySelection({
    options: sorted,
    item: itemWithDefault720,
    selectedOptionKeyByItem: { i1: "variant:nonexistent" },
    preference: "best",
  });
  assert.equal(activeStale?.variant.id, "v4k");

  assert.equal(model.formatQualityPreferenceLabel("best"), "最高画质");
  assert.equal(model.formatQualityPreferenceLabel("1080p"), "1080p 优先");
  assert.equal(model.formatQualityPreferenceLabel("audio"), "仅音频 M4A");
});

test("preview source URL picking, YouTube/DASH mux preview fallback & broken-URL failover", () => {
  // 1. YouTube split 4K muxPair falls back to default inline-playable muxed stream
  const ytMux4k = makeOption({
    variantId: "v4k-mux",
    height: 2160,
    hasAudio: false,
    muxPair: { ok: true },
    directUrl: "https://rr1.googlevideo.com/4k-video-only",
  });
  const ytPlayable720 = makeOption({
    variantId: "v720-muxed",
    height: 720,
    hasAudio: true,
    directUrl: "https://rr1.googlevideo.com/720-muxed",
    routes: ["https://rr1.googlevideo.com/720-muxed", "https://rr2.googlevideo.com/720-muxed"],
  });
  const ytItem = makeReadyVideoItem("yt1", "YT", "https://rr1.googlevideo.com/720-muxed", {
    defaultVariantId: "v720-muxed",
  });
  const ytPreviewCandidates = model.resolvePreviewVideoCandidates({
    platform: "youtube",
    activeItem: ytItem,
    activeOption: ytMux4k,
    allOptions: [ytMux4k, ytPlayable720],
    ctx: CTX,
  });
  assert.deepEqual(ytPreviewCandidates, [
    "https://rr1.googlevideo.com/720-muxed",
    "https://rr2.googlevideo.com/720-muxed",
  ]);

  // 2. Broken-URL failover advances route index cleanly
  const firstPreview = model.pickActivePreviewVideoUrl(ytPreviewCandidates, 0, {});
  assert.equal(firstPreview, "https://rr1.googlevideo.com/720-muxed");
  const afterFail = model.advancePreviewVideoRouteOnError({
    failedUrl: firstPreview,
    currentPreviewUrl: firstPreview,
    candidates: ytPreviewCandidates,
    routeIndex: 0,
    brokenUrls: {},
  });
  assert.equal(afterFail.nextRouteIndex, 1);
  assert.equal(
    model.pickActivePreviewVideoUrl(ytPreviewCandidates, afterFail.nextRouteIndex, afterFail.brokenUrls),
    "https://rr2.googlevideo.com/720-muxed",
  );

  // 3. Bilibili DASH mux option keeps inline durl preview & disables direct copy URL
  const biliDash = makeOption({
    variantId: "dash-1080",
    isDashMux: true,
    directUrl: "",
    copyUrl: "",
    routes: ["https://upos.bilivideo.com/video.m4s"],
  });
  const biliDurl = makeOption({
    variantId: "durl-720",
    directUrl: "https://upos.bilivideo.com/durl.mp4",
    routes: ["https://upos.bilivideo.com/durl.mp4"],
  });
  const biliItem = makeReadyVideoItem("b1", "Bili", "https://upos.bilivideo.com/durl.mp4");
  assert.deepEqual(
    model.resolvePreviewVideoCandidates({
      platform: "bilibili",
      activeItem: biliItem,
      activeOption: biliDash,
      allOptions: [biliDash, biliDurl],
      ctx: CTX,
    }),
    ["https://upos.bilivideo.com/durl.mp4"],
  );
  assert.equal(
    model.resolveDirectCopyCandidateUrl({
      media: { source_url: "https://www.bilibili.com/video/BV1" },
      activeItem: biliItem,
      activeOption: biliDash,
      copyCtx: CTX,
    }),
    "",
  );
  assert.match(model.resolveDirectCopyButtonTitle(true), /无损合流/);

  // 4. Cover fallback chain: item cover -> broken skips -> media cover
  const coverItem = makeReadyVideoItem("c1", "Cover", "https://cdn.example.com/v.mp4", {
    cover: makeFileSource("https://cdn.example.com/item-cover.jpg"),
  });
  const mediaCover = makeFileSource("https://cdn.example.com/media-cover.jpg");
  assert.equal(
    model.resolvePreviewCoverUrl({
      media: { cover: mediaCover },
      activeItem: coverItem,
      activeOption: null,
      ctx: CTX,
      brokenUrls: { "https://cdn.example.com/item-cover.jpg": true },
    }),
    "https://cdn.example.com/media-cover.jpg",
  );

  // 5. LivePhoto preview & album thumbnail
  const lp = makeLivePhotoItem("lp1", "https://cdn.example.com/lp.jpg", "https://cdn.example.com/lp.mp4");
  assert.equal(model.resolveAlbumThumbnailUrl(lp, CTX, {}), "https://cdn.example.com/lp.jpg");
  assert.equal(
    model.resolveDirectCopyCandidateUrl({
      media: { source_url: "https://www.xiaohongshu.com/explore/1" },
      activeItem: lp,
      activeOption: null,
      copyCtx: CTX,
    }),
    "https://cdn.example.com/lp.mp4",
  );
});

test("table-driven batch download ZIP / subdirectory naming & save-mode policy decisions", () => {
  const cases = [
    {
      name: "album ZIP enabled -> keeps zip mode, canonical _9P.zip stem & flat numbered image",
      input: {
        media: { platform: "xiaohongshu", content_id: "x1", title: "春日樱花" },
        layoutKind: "album",
        requestedSaveMode: "zip",
        zipDecision: { ok: true, reason: "" },
        subfolderPrefix: "DokiTool",
        totalCount: 9,
        item: { type: "image", title: "ignored-image-title" },
        ordinalIndex: 2,
        ext: "jpg",
      },
      expect: {
        effectiveSaveMode: "zip",
        useMultiPartQueue: false,
        archiveFilename: "DokiTool/春日樱花_9P.zip",
        subfolderItemPath: "DokiTool/春日樱花/002.jpg",
      },
    },
    {
      name: "multi_video ZIP blocked (DASH / >500MB) -> forces subfolder + multipart background queue + episode stem",
      input: {
        media: { platform: "bilibili", content_id: "BV9", title: "系统设计课" },
        layoutKind: "multi_video",
        requestedSaveMode: "zip",
        zipDecision: { ok: false, reason: "超过 500 MB 上限" },
        subfolderPrefix: "",
        totalCount: 12,
        item: { type: "video", title: "分布式共识" },
        ordinalIndex: 3,
        ext: "mp4",
      },
      expect: {
        effectiveSaveMode: "subfolder",
        useMultiPartQueue: true,
        archiveFilename: "系统设计课_12P.zip",
        subfolderItemPath: "系统设计课/003_分布式共识.mp4",
      },
    },
    {
      name: "placeholder episode title (P1 / 第1集) omitted from subfolder filename",
      input: {
        media: { platform: "bilibili", content_id: "BV10", title: "精选合集" },
        layoutKind: "multi_video",
        requestedSaveMode: "subfolder",
        zipDecision: { ok: true, reason: "" },
        totalCount: 3,
        item: { type: "video", title: "P1" },
        ordinalIndex: 1,
        ext: "mp4",
      },
      expect: {
        effectiveSaveMode: "subfolder",
        useMultiPartQueue: true,
        archiveFilename: "精选合集_3P.zip",
        subfolderItemPath: "精选合集/001.mp4",
      },
    },
    {
      name: "live_photo with filter=both appends _live stem; missing title falls back to author",
      input: {
        media: { platform: "weibo", content_id: "w1", title: "  ", author: { name: "摄影师阿明" } },
        layoutKind: "album",
        requestedSaveMode: "subfolder",
        zipDecision: { ok: true, reason: "" },
        totalCount: 4,
        item: { type: "live_photo", title: "Live" },
        ordinalIndex: 1,
        ext: "mp4",
        livePhotoFilter: "both",
      },
      expect: {
        effectiveSaveMode: "subfolder",
        useMultiPartQueue: false,
        archiveFilename: "摄影师阿明_4P.zip",
        subfolderItemPath: "摄影师阿明/001_live.mp4",
      },
    },
    {
      name: "mixed layout with deferred entries streams via multipart queue",
      input: {
        media: { platform: "instagram", content_id: "ig1" },
        layoutKind: "mixed",
        requestedSaveMode: "subfolder",
        zipDecision: { ok: true, reason: "" },
        totalCount: 2,
        item: { type: "video", title: "Clip A" },
        ordinalIndex: 2,
        ext: "mp4",
        hasDeferredEntries: true,
      },
      expect: {
        effectiveSaveMode: "subfolder",
        useMultiPartQueue: true,
        archiveFilename: "instagram_ig1_2P.zip",
        subfolderItemPath: "instagram_ig1/002_Clip A.mp4",
      },
    },
    {
      name: "large >=1000-item batch widens subfolder index padding to 4 digits",
      input: {
        media: { platform: "pixiv", content_id: "p1", title: "超大画集" },
        layoutKind: "album",
        requestedSaveMode: "subfolder",
        zipDecision: { ok: true, reason: "" },
        totalCount: 1200,
        item: { type: "image", title: "img" },
        ordinalIndex: 7,
        ext: "png",
      },
      expect: {
        effectiveSaveMode: "subfolder",
        useMultiPartQueue: false,
        archiveFilename: "超大画集_1200P.zip",
        subfolderItemPath: "超大画集/0007.png",
      },
    },
  ];

  for (const tc of cases) {
    const decision = model.decideBatchNamingPolicy(tc.input);
    assert.equal(decision.effectiveSaveMode, tc.expect.effectiveSaveMode, `${tc.name}: effectiveSaveMode`);
    assert.equal(decision.useMultiPartQueue, tc.expect.useMultiPartQueue, `${tc.name}: useMultiPartQueue`);
    assert.equal(decision.archiveFilename, tc.expect.archiveFilename, `${tc.name}: archiveFilename`);
    assert.equal(decision.subfolderItemPath, tc.expect.subfolderItemPath, `${tc.name}: subfolderItemPath`);
  }

  assert.equal(
    model.resolveZipModeTooltip("multi_video", { ok: true, reason: "" }),
    "将已选分P打包为单个 ZIP 文件（500 MB 以内）",
  );
  assert.equal(
    model.resolveZipModeTooltip("album", { ok: false, reason: "超过 500 MB" }),
    "超过 500 MB",
  );
  assert.equal(model.shouldStreamBatchViaMultiPart("album", [{ item: { id: "1", type: "image", state: "ready" } }]), false);
  assert.equal(model.shouldStreamBatchViaMultiPart("album", [{ item: { id: "1", type: "image", state: "deferred" } }]), true);
});
