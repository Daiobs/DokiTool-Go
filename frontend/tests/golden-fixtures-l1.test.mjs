import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendRoot, "..");
const goldenRoot = path.join(repoRoot, "tests", "golden-fixtures");
const PROD_API_ORIGIN = "https://snap.dokitool.com";

const CJK_RE = /[\u4e00-\u9fff]/;

function loadGoldenFixture(relPath) {
  const abs = path.join(goldenRoot, relPath);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function walkJsonFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJsonFiles(abs));
    else if (ent.isFile() && ent.name.endsWith(".json")) out.push(abs);
  }
  return out.sort();
}

function stripAllowedLanguageSelectorLabels(html) {
  // Strip HTML comments and any explicit language switcher `<option value="zh-CN">中文</option>` labels
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<option\b[^>]*value=["']zh-CN["'][^>]*>[\s\S]*?<\/option>/gi, "");
}

function stripHtmlTags(html) {
  return stripAllowedLanguageSelectorLabels(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let vite;
let mediaKernel;
let capabilityHub;
let resultPresentation;
let resultI18n;
let uiTargetHelpers;
let videoFilename;
let hostWhitelist;
let youtubeHelperCore;
let mediaSources;
let useVideoSelection;
let PlatformGrid;
let ResultSection;
let ResultDetailsSidebar;

test.before(async () => {
  vite = await createServer({
    root: frontendRoot,
    configFile: false,
    logLevel: "error",
    plugins: [vue()],
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  mediaKernel = await vite.ssrLoadModule("/src/core/media/index.ts");
  capabilityHub = await vite.ssrLoadModule("/src/core/capabilityHub.ts");
  resultPresentation = await vite.ssrLoadModule(
    "/src/components/result/resultPresentation.ts",
  );
  resultI18n = await vite.ssrLoadModule("/src/components/result/resultI18n.ts");
  uiTargetHelpers = await vite.ssrLoadModule(
    "/src/extension/uiTargetHelpers.ts",
  );
  videoFilename = await vite.ssrLoadModule("/src/utils/videoFilename.ts");
  hostWhitelist = await vite.ssrLoadModule("/src/extension/hostWhitelist.ts");
  youtubeHelperCore = await vite.ssrLoadModule(
    "/src/utils/youtubeHelperCore.js",
  );
  mediaSources = await vite.ssrLoadModule("/src/utils/mediaSources.ts");
  useVideoSelection = (
    await vite.ssrLoadModule("/src/composables/useVideoSelection.ts")
  ).useVideoSelection;
  PlatformGrid = (await vite.ssrLoadModule("/src/components/PlatformGrid.vue"))
    .default;
  ResultSection = (await vite.ssrLoadModule("/src/components/ResultSection.vue"))
    .default;
  ResultDetailsSidebar = (
    await vite.ssrLoadModule("/src/components/result/ResultDetailsSidebar.vue")
  ).default;
});

test.after(async () => {
  await vite?.close();
});

test("L1 Golden Corpus Hygiene: all tests/golden-fixtures JSON files are sanitized and free of secrets or local paths", () => {
  const files = walkJsonFiles(goldenRoot);
  assert.ok(files.length >= 8, `Expected >= 8 golden fixtures, found ${files.length}`);

  const forbiddenPatterns = [
    /xsec_token\s*=/i,
    /owner_token\s*=/i,
    /bearer\s+[a-z0-9._-]{16,}/i,
    /\/Users\//,
    /\/home\//,
    /[A-Za-z]:\\Users\\/,
    /file:\/\//i,
    /(?<![0-9A-Za-z.])(?:127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(?![0-9A-Za-z.])/,
  ];

  for (const abs of files) {
    const raw = fs.readFileSync(abs, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed, "object");
    const rel = path.relative(repoRoot, abs);
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(raw),
        false,
        `Golden fixture ${rel} matched forbidden sensitive pattern ${pattern}`,
      );
    }
  }
});

test("L1 Golden Bilibili ugc_season single-P: title & filename never degrade to P1/P1_P1.mp4 and M2/M3 stay 100% identical", () => {
  const { media } = loadGoldenFixture("bilibili/ugc-season-single-p.json");
  const item = media.items[0];
  const ctx = { apiOrigin: PROD_API_ORIGIN };

  // 1. Preferred title skips placeholder 'P1' and uses real workTitle
  const resolvedWebTitle = mediaKernel.resolvePreferredMediaTitle({
    isSingleItem: false,
    itemCount: media.items.length,
    workTitle: media.title,
    itemTitle: item.title,
  });
  assert.equal(resolvedWebTitle, "【技术实录】全链路架构演进");
  assert.notEqual(resolvedWebTitle, "P1");

  const resolvedExtBaseName = uiTargetHelpers.resolveItemBaseName(media, item);
  assert.equal(resolvedExtBaseName, "【技术实录】全链路架构演进");

  // 2. buildMediaFilename never produces P1_P1.mp4 even if multi-count is passed
  const webFilename = videoFilename.buildMediaFilename({
    title: resolvedWebTitle,
    index: 1,
    total: media.items.length,
    fallback: item.id,
    extension: "mp4",
  });
  assert.equal(webFilename, "【技术实录】全链路架构演进.mp4");
  assert.equal(/P1_P1/i.test(webFilename), false);

  // Idempotent deduplication guard when title already ends with P1
  const dedupedMulti = videoFilename.buildMediaFilename({
    title: "Demo_P1",
    index: 1,
    total: 5,
    fallback: "demo",
    extension: "mp4",
  });
  assert.equal(dedupedMulti, "Demo_P1.mp4");

  // 3. Extension-ready M2 vs M3 parity: default variant selection, ordering, and filename
  const webOptions = resultPresentation.buildAllQualityOptions(
    item,
    null,
    null,
    ctx,
    { allowExtensionDashMux: true },
  );
  const extOptions = uiTargetHelpers
    .buildSidePanelQualityOptions(media, item, PROD_API_ORIGIN)
    .filter((o) => o.kind === "variant");

  assert.deepEqual(
    webOptions.map((o) => o.variant.id),
    extOptions.map((o) => o.variant.id),
    "M2 and M3 Bilibili option sort order must be 100% identical",
  );
  assert.equal(webOptions[0].variant.id, "bili-1080p-dash");

  const defaultWebOpt = webOptions.find(
    (o) => o.variant.id === item.default.variant_id,
  );
  assert.equal(
    mediaKernel.shouldAutoUpgradeDefaultVariant(defaultWebOpt, webOptions[0]),
    true,
    "M2 must auto-upgrade from 720p direct to 1080p DASH mux when extension is connected",
  );

  const selectedExtOpt = uiTargetHelpers.selectPreferredQualityOption(
    extOptions,
    "highest",
  );
  assert.equal(selectedExtOpt?.variant?.id, webOptions[0].variant.id);

  const extEnqueue = uiTargetHelpers.buildSingleDownloadEnqueueItem({
    media,
    item,
    option: selectedExtOpt,
    settings: {
      apiBaseUrl: PROD_API_ORIGIN,
      subfolderPrefix: "",
    },
  });
  assert.equal(extEnqueue.spec.filename, webFilename);
});

test("L1 Golden YouTube 8K/4K60 adaptive: 4320p labeled 8K (never 4K), deduped tag, and M2/M3 default upgrade + filename parity", () => {
  const { media } = loadGoldenFixture("youtube/4k60-8k-adaptive.json");
  const item = media.items[0];
  const ctx = { apiOrigin: PROD_API_ORIGIN };

  const v8k = item.variants.find((v) => v.id === "yt-4320p60");
  const v4k = item.variants.find((v) => v.id === "yt-2160p60");
  const v360 = item.variants.find((v) => v.id === "yt-360p");
  const vAudio = item.variants.find((v) => v.id === "yt-audio-m4a");
  assert.ok(v8k && v4k && v360 && vAudio);

  // 1. 4320p strictly resolves to 8K (never 4K), and player quality tag never duplicates 4K/8K
  assert.equal(resultI18n.resolveYouTubeHighResTier(v8k), "8K");
  assert.equal(resultI18n.resolveYouTubeDownloadTier(v8k), "8K");
  assert.equal(resultI18n.resolveYouTubeHighResTier(v4k), "4K");

  const tag8k = resultPresentation.buildPlayerQualityTagText(
    v8k,
    v8k.label,
    "en",
  );
  assert.match(tag8k, /8K/);
  assert.equal(/\b4K\b/.test(tag8k), false, `8K player tag must not contain 4K: ${tag8k}`);
  assert.equal(
    (tag8k.match(/8K/g) || []).length,
    1,
    `8K player tag must deduplicate 8K badge: ${tag8k}`,
  );

  // 2. Build YouTube mux pairs for M2 and compare against M3 SidePanel
  const muxPairs = new Map();
  for (const variant of item.variants) {
    const pair = youtubeHelperCore.selectYouTubeMuxPair(
      variant,
      item.variants,
      media.attachments,
    );
    if (pair?.ok) muxPairs.set(variant.id, pair);
  }
  assert.equal(muxPairs.has("yt-4320p60"), true);
  assert.equal(muxPairs.has("yt-2160p60"), true);
  assert.equal(muxPairs.has("yt-1080p60"), true);

  const webOptions = resultPresentation.buildAllQualityOptions(
    item,
    null,
    null,
    ctx,
    { allowExtensionDashMux: true, muxPairsByVariantId: muxPairs },
  );
  const extOptions = uiTargetHelpers
    .buildSidePanelQualityOptions(media, item, PROD_API_ORIGIN)
    .filter((o) => o.kind === "variant");

  assert.deepEqual(
    webOptions.map((o) => o.variant.id),
    extOptions.map((o) => o.variant.id),
    "M2 and M3 YouTube canonical sort order must be 100% identical",
  );
  assert.equal(webOptions[0].variant.id, "yt-4320p60");

  // Auto-upgrade default selection from 360p to 8K60 when extension mux is ready
  const webDefaultOpt = webOptions.find((o) => o.variant.id === "yt-360p");
  assert.equal(
    mediaKernel.shouldAutoUpgradeDefaultVariant(webDefaultOpt, webOptions[0]),
    true,
    "M2 must auto-upgrade YouTube default from 360p to 4320p60 when extension is ready",
  );
  const extSelected = uiTargetHelpers.selectPreferredQualityOption(
    extOptions,
    "highest",
  );
  assert.equal(extSelected?.variant?.id, "yt-4320p60");

  // 3. M2 vs M3 canonical filename parity across 8K, 4K, 360p, and standalone M4A audio
  for (const [variantId, expectedExt, expectedTag] of [
    ["yt-4320p60", "mp4", "4320p"],
    ["yt-2160p60", "mp4", "2160p"],
    ["yt-360p", "mp4", "360p"],
    ["yt-audio-m4a", "m4a", "audio"],
  ]) {
    const extOpt = extOptions.find((o) => o.variant?.id === variantId);
    assert.ok(extOpt, `Missing extension option for ${variantId}`);
    const extEnqueue = uiTargetHelpers.buildSingleDownloadEnqueueItem({
      media,
      item,
      option: extOpt,
      settings: { apiBaseUrl: PROD_API_ORIGIN, subfolderPrefix: "" },
    });
    const webTag = mediaKernel.resolveAdaptiveQualityFilenameTag({
      enabled: true,
      itemType: item.type,
      extension: expectedExt,
      variant: extOpt.variant,
    });
    assert.equal(webTag, expectedTag);
    const webFile = videoFilename.buildMediaFilename({
      title: mediaKernel.appendCanonicalQualitySuffix(media.title, webTag),
      fallback: item.id,
      extension: expectedExt,
    });
    assert.equal(
      extEnqueue.spec.filename,
      webFile,
      `M2 vs M3 filename mismatch for ${variantId}: ext=${extEnqueue.spec.filename} web=${webFile}`,
    );
  }
});

test("L1 Golden Xiaohongshu 4K original_endpoint & 3-item album: M2/M3 sort order and _3P.zip naming match 100%", () => {
  const { video_media: videoMedia, album_media: albumMedia } =
    loadGoldenFixture("xiaohongshu/original-4k-and-album.json");
  const ctx = { apiOrigin: PROD_API_ORIGIN };

  // 1. 4K original_endpoint prioritized first across Web & Extension
  const webOpts = resultPresentation.buildAllQualityOptions(
    videoMedia.items[0],
    null,
    null,
    ctx,
  );
  const extOpts = uiTargetHelpers
    .buildSidePanelQualityOptions(videoMedia, videoMedia.items[0], PROD_API_ORIGIN)
    .filter((o) => o.kind === "variant");
  assert.deepEqual(
    webOpts.map((o) => o.variant.id),
    ["xhs-orig-4k", "xhs-1080p", "xhs-720p"],
  );
  assert.deepEqual(
    webOpts.map((o) => o.variant.id),
    extOpts.map((o) => o.variant.id),
  );
  const webDefault = webOpts.find((o) => o.variant.id === "xhs-720p");
  assert.equal(
    mediaKernel.shouldAutoUpgradeDefaultVariant(webDefault, webOpts[0]),
    true,
  );

  // 2. Album ZIP naming parity (`_<N>P.zip` where N matches actual archive entries)
  const entries = albumMedia.items.map((it) => {
    const opts = uiTargetHelpers.buildSidePanelQualityOptions(
      albumMedia,
      it,
      PROD_API_ORIGIN,
    );
    return { item: it, option: opts[0] };
  });
  const extZipBoth = uiTargetHelpers.buildChecklistZipEnqueueItem({
    media: albumMedia,
    entries,
    totalCount: albumMedia.items.length,
    settings: { apiBaseUrl: PROD_API_ORIGIN, subfolderPrefix: "" },
    livePhotoFilter: "both",
  });
  assert.equal(extZipBoth.ok, true);
  // 2 images + 1 live_photo (still + motion) = 4 archive entries -> `_4P.zip`
  const webArchiveBoth = videoFilename.buildArchiveFilename({
    title: albumMedia.title,
    count: extZipBoth.item.spec.zipEntries.length,
    fallback: albumMedia.content_id,
  });
  assert.equal(webArchiveBoth, "京都秋日胶片实况_4P.zip");
  assert.equal(extZipBoth.item.spec.filename, webArchiveBoth);

  const extZipImagesOnly = uiTargetHelpers.buildChecklistZipEnqueueItem({
    media: albumMedia,
    entries,
    totalCount: albumMedia.items.length,
    settings: { apiBaseUrl: PROD_API_ORIGIN, subfolderPrefix: "" },
    livePhotoFilter: "image",
  });
  assert.equal(extZipImagesOnly.ok, true);
  const webArchiveImagesOnly = videoFilename.buildArchiveFilename({
    title: albumMedia.title,
    count: albumMedia.items.length,
    fallback: albumMedia.content_id,
  });
  assert.equal(webArchiveImagesOnly, "京都秋日胶片实况_3P.zip");
  assert.equal(extZipImagesOnly.item.spec.filename, webArchiveImagesOnly);
});

test("L1 Golden Routing Matrix (M1 / M2 / M3): youtube_direct, toutiaovod, tbvideo, relay, and unwhitelisted generic_hls", () => {
  const yt = loadGoldenFixture("youtube/4k60-8k-adaptive.json").media;
  const toutiao = loadGoldenFixture("toutiao/cors-blocked-direct.json").media;
  const zuiyou = loadGoldenFixture("zuiyou/tbvideo-direct.json").media;
  const weibo = loadGoldenFixture("weibo/relay-480p-orb.json").media;
  const genericHls = loadGoldenFixture("generic/unwhitelisted-hls.json").media;

  const m1WebOnly = {
    extensionConnected: false,
    extensionVersion: "",
    extensionCapabilities: [],
    swMultiRangeAvailable: true,
  };
  const m2ExtConnected = {
    extensionConnected: true,
    extensionVersion: capabilityHub.LATEST_EXTENSION_VERSION,
    extensionCapabilities: [
      "dash_mux",
      "direct_download",
      "youtube_parse",
      "youtube_mux",
    ],
    swMultiRangeAvailable: true,
  };

  // 1. youtube_direct (360p with &title= signed attachment)
  const yt360Url = yt.items[0].variants.find((v) => v.id === "yt-360p").delivery
    .sources[0].url;
  assert.equal(mediaKernel.canAttemptSignedDirectAttachment(yt360Url), true);
  assert.equal(hostWhitelist.isWhitelistedMediaUrl(yt360Url).allowed, true);
  const ytDirectInput = {
    deliveryKind: "file",
    requiresClientSession: true,
    whitelistedForExtension: true,
    corsBlockedDirect: mediaKernel.isCorsBlockedDirectUrl(yt360Url),
  };
  assert.equal(
    capabilityHub.resolveExecutionPlan(ytDirectInput, m1WebOnly).channel,
    "blocked",
  );
  assert.equal(
    capabilityHub.resolveExecutionPlan(ytDirectInput, m2ExtConnected).channel,
    "extension_direct",
  );

  // 2. toutiaovod (CORS-blocked direct)
  const ttUrl = toutiao.items[0].variants[0].delivery.sources[0].url;
  assert.equal(mediaKernel.isCorsBlockedDirectUrl(ttUrl), true);
  assert.equal(mediaKernel.inferDirectVideoExtension(ttUrl, false), "mp4");
  assert.equal(hostWhitelist.isWhitelistedMediaUrl(ttUrl).allowed, true);
  const ttInput = {
    deliveryKind: "file",
    whitelistedForExtension: true,
    corsBlockedDirect: true,
  };
  assert.equal(
    capabilityHub.resolveExecutionPlan(ttInput, m1WebOnly).channel,
    "browser_direct",
  );
  assert.equal(
    capabilityHub.resolveExecutionPlan(ttInput, m2ExtConnected).channel,
    "extension_direct",
  );

  // 3. tbvideo (zuiyou/pipigx)
  const zyItem = zuiyou.items[0];
  const zyUrl = zyItem.variants[0].delivery.sources[0].url;
  assert.equal(mediaKernel.isTbvideoVideoItem(zyItem), true);
  assert.equal(hostWhitelist.isWhitelistedMediaUrl(zyUrl).allowed, true);
  const zyInput = {
    deliveryKind: "file",
    whitelistedForExtension: true,
    hasTbvideo: true,
  };
  assert.equal(
    capabilityHub.resolveExecutionPlan(zyInput, m1WebOnly).channel,
    "web_sw_stream",
  );
  assert.equal(
    capabilityHub.resolveExecutionPlan(zyInput, m2ExtConnected).channel,
    "extension_direct",
  );

  // 4. Weibo relay + 480p label accuracy + proactive ORB cover suppression
  const wbItem = weibo.items[0];
  const wbVariant = wbItem.variants[0];
  const wbSource = wbVariant.delivery.sources[0];
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      PROD_API_ORIGIN + wbSource.url,
      wbSource,
    ),
    false,
  );
  assert.equal(
    mediaKernel.isRefererBlockedWebImageUrl(wbItem.cover.url),
    true,
    "Weibo sinaimg.cn cover must be proactively flagged to avoid Web ERR_BLOCKED_BY_ORB",
  );
  assert.equal(mediaSources.variantLabel(wbVariant), "480p");
  assert.equal(
    capabilityHub.resolveExecutionPlan(
      { deliveryKind: "file", whitelistedForExtension: true },
      m1WebOnly,
    ).channel,
    "web_sw_stream",
  );

  // 5. Non-whitelisted generic_hls: strictly rejected by extension host whitelist
  const hlsUrl = genericHls.items[0].variants[0].delivery.sources[0].url;
  assert.equal(hostWhitelist.isWhitelistedMediaUrl(hlsUrl).allowed, false);
  const hlsPlanM2 = capabilityHub.resolveExecutionPlan(
    { deliveryKind: "hls", whitelistedForExtension: false },
    m2ExtConnected,
  );
  assert.equal(hlsPlanM2.usesExtension, false);
  assert.equal(hlsPlanM2.channel, "browser_direct");

  const extGenericOpts = uiTargetHelpers.buildSidePanelQualityOptions(
    genericHls,
    genericHls.items[0],
    PROD_API_ORIGIN,
  );
  assert.equal(
    extGenericOpts[0]?.deliveryMode,
    "external_only",
    "M3 SidePanel must isolate unwhitelisted generic_hls as external_only (zero offscreen egress)",
  );
});

test("L1 EN Zero-CJK Gate: PlatformGrid, App.vue formatNumber, ResultDetailsSidebar, and ResultSection emit zero CJK chars in locale='en'", async () => {
  // 1. PlatformGrid under locale="en"
  const enGridHtml = await renderToString(
    createSSRApp({ render: () => h(PlatformGrid, { locale: "en" }) }),
  );
  const gridVisible = stripHtmlTags(enGridHtml);
  assert.equal(
    CJK_RE.test(gridVisible),
    false,
    `EN PlatformGrid leaked CJK: ${JSON.stringify(gridVisible.match(/[\u4e00-\u9fff]+/g))}`,
  );
  // Also verify aria-label / alt attributes in PlatformGrid contain zero CJK
  assert.equal(
    CJK_RE.test(stripAllowedLanguageSelectorLabels(enGridHtml)),
    false,
    `EN PlatformGrid attributes leaked CJK: ${JSON.stringify(enGridHtml.match(/[\u4e00-\u9fff]+/g))}`,
  );

  // 2. App.vue formatNumber (verify implementation mirrors exact en K/M/B rule without 万/亿)
  const appVueSource = fs.readFileSync(
    path.join(frontendRoot, "src", "App.vue"),
    "utf8",
  );
  assert.match(
    appVueSource,
    /locale\.value\s*===\s*["']en["'][\s\S]{0,260}\+ "B"[\s\S]{0,120}\+ "M"[\s\S]{0,120}\+ "K"/,
    "App.vue formatNumber must format EN numbers with K/M/B instead of 万/亿",
  );

  const enFormatNumber = (num) => {
    const n = Number(num);
    if (!Number.isFinite(n)) return "0";
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  };
  const enFormatDuration = (sec) => {
    const s = Math.round(Number(sec) || 0);
    const hVal = Math.floor(s / 3600);
    const mVal = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    return hVal > 0
      ? `${hVal}:${String(mVal).padStart(2, "0")}:${String(rem).padStart(2, "0")}`
      : `${mVal}:${String(rem).padStart(2, "0")}`;
  };
  for (const sampleNum of [0, 42, 999, 1_500, 11_200, 2_450_000, 1_200_000_000]) {
    const formatted = enFormatNumber(sampleNum);
    assert.equal(CJK_RE.test(formatted), false, `EN formatNumber(${sampleNum}) leaked CJK: ${formatted}`);
  }

  // 3. ResultDetailsSidebar under locale="en" across ALL tabs (info, stats, backup, tags, music)
  const enMediaFixture = {
    schema_version: "1.0",
    platform: "bilibili",
    platform_name: "Bilibili",
    content_id: "BV1enTest01",
    title: "English Architecture Walkthrough",
    source_url: "https://www.bilibili.com/video/BV1enTest01",
    published_at: "2026-11-20T08:00:00Z",
    author: { id: "eng01", name: "SystemLab" },
    statistics: {
      views: { value: 2450000, state: "verified" },
      likes: { value: 11200, state: "verified" },
      comments: { value: 0, state: "unverified" },
    },
    tags: ["Engineering", "Video"],
    default_item_id: "item-1",
    items: [
      {
        id: "item-1",
        index: 0,
        type: "video",
        state: "ready",
        duration_ms: 125000,
        default: { variant_id: "v-1080" },
        variants: [
          {
            id: "v-1080",
            label: "1080p60",
            state: "ready",
            metadata: {
              width: 1920,
              height: 1080,
              video_codec: "avc1.640032",
              audio_codec: "mp4a.40.2",
              container: "mp4",
              extension: "mp4",
              mime_type: "video/mp4",
              has_audio: true,
              duration_ms: 125000,
            },
            delivery: {
              kind: "mux",
              resources: [
                {
                  id: "v",
                  role: "video",
                  metadata: { width: 1920, height: 1080, container: "mp4" },
                  delivery: {
                    kind: "file",
                    sources: [
                      {
                        id: "sv",
                        url: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/en/v.m4s",
                        size_bytes: 20000000,
                      },
                    ],
                  },
                },
                {
                  id: "a",
                  role: "audio",
                  metadata: { audio_bitrate_bps: 192000, container: "m4a" },
                  delivery: {
                    kind: "file",
                    sources: [
                      {
                        id: "sa",
                        url: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/en/a.m4s",
                        size_bytes: 2000000,
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
    attachments: [
      {
        id: "att-nonplay",
        role: "other",
        title: "Subtitle Pack",
        resource: {
          id: "sub-1",
          role: "other",
          delivery: { kind: "hls", sources: [] },
        },
      },
    ],
  };

  const sidebarQualityOptions = resultPresentation.buildAllQualityOptions(
    enMediaFixture.items[0],
    null,
    null,
    { apiOrigin: PROD_API_ORIGIN },
    { allowExtensionDashMux: true },
  );

  for (const activeTab of ["info", "stats", "backup", "tags", "music"]) {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(ResultDetailsSidebar, {
            resultData: enMediaFixture,
            locale: "en",
            currentItem: enMediaFixture.items[0],
            activeVariant: enMediaFixture.items[0].variants[0],
            metadata: enMediaFixture.items[0].variants[0].metadata,
            attachments: enMediaFixture.attachments,
            hasBackup: true,
            activeTab,
            formatNumber: enFormatNumber,
            formatDuration: enFormatDuration,
            safeImageUrl: () => "",
            displayVariantLabel: (v) => v?.label || "1080p",
            formatOptionSize: () => "22 MB",
            qualityOptions: sidebarQualityOptions,
            downloadableCount: sidebarQualityOptions.length,
            isBilibili: true,
            isExtensionConnected: false,
            bilibiliDashSummary: { tierCount: 1, maxResolution: "1080p" },
          }),
      }),
    );
    const visible = stripHtmlTags(html);
    assert.equal(
      CJK_RE.test(visible),
      false,
      `EN ResultDetailsSidebar[tab=${activeTab}] leaked CJK: ${JSON.stringify(visible.match(/[\u4e00-\u9fff]+/g))}`,
    );
  }

  // 3b. PR #52 [P3-Low]: backend-provided bilibili-audio-* attachment with default Chinese title
  //     ("原声音频 (M4A)") must map to "Original Audio (M4A)" under locale="en" (and stay Chinese in zh-CN).
  const backendBiliAudioAttachments = [
    {
      id: "bilibili-audio-item-1",
      role: "background_audio",
      title: "原声音频 (M4A)",
      resource: {
        id: "bili-audio-backend-1",
        role: "audio",
        metadata: { audio_bitrate_bps: 192000, container: "m4a" },
        delivery: {
          kind: "file",
          sources: [
            {
              id: "sa-backend",
              url: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/en/a.m4s",
              size_bytes: 2000000,
            },
          ],
        },
      },
    },
  ];
  for (const isExtensionConnected of [false, true]) {
    const biliMusicEnHtml = await renderToString(
      createSSRApp({
        render: () =>
          h(ResultDetailsSidebar, {
            resultData: enMediaFixture,
            locale: "en",
            currentItem: enMediaFixture.items[0],
            activeVariant: enMediaFixture.items[0].variants[0],
            metadata: enMediaFixture.items[0].variants[0].metadata,
            attachments: backendBiliAudioAttachments,
            hasBackup: true,
            activeTab: "music",
            formatNumber: enFormatNumber,
            formatDuration: enFormatDuration,
            safeImageUrl: () => "",
            displayVariantLabel: (v) => v?.label || "1080p",
            formatOptionSize: () => "22 MB",
            qualityOptions: sidebarQualityOptions,
            downloadableCount: sidebarQualityOptions.length,
            isBilibili: true,
            isExtensionConnected,
            bilibiliDashSummary: { tierCount: 1, maxResolution: "1080p" },
          }),
      }),
    );
    const biliMusicEnVisible = stripHtmlTags(biliMusicEnHtml);
    assert.equal(
      CJK_RE.test(biliMusicEnVisible),
      false,
      `EN ResultDetailsSidebar[bilibili-audio-*, ext=${isExtensionConnected}] leaked CJK: ${JSON.stringify(biliMusicEnVisible.match(/[\u4e00-\u9fff]+/g))}`,
    );
    assert.ok(
      biliMusicEnVisible.includes("Original Audio (M4A)"),
      `EN ResultDetailsSidebar[bilibili-audio-*, ext=${isExtensionConnected}] must map backend audio title to "Original Audio (M4A)", got: ${biliMusicEnVisible}`,
    );
  }
  const biliMusicZhHtml = await renderToString(
    createSSRApp({
      render: () =>
        h(ResultDetailsSidebar, {
          resultData: enMediaFixture,
          locale: "zh-CN",
          currentItem: enMediaFixture.items[0],
          activeVariant: enMediaFixture.items[0].variants[0],
          metadata: enMediaFixture.items[0].variants[0].metadata,
          attachments: backendBiliAudioAttachments,
          hasBackup: true,
          activeTab: "music",
          formatNumber: enFormatNumber,
          formatDuration: enFormatDuration,
          safeImageUrl: () => "",
          displayVariantLabel: (v) => v?.label || "1080p",
          formatOptionSize: () => "22 MB",
          qualityOptions: sidebarQualityOptions,
          downloadableCount: sidebarQualityOptions.length,
          isBilibili: true,
          isExtensionConnected: false,
          bilibiliDashSummary: { tierCount: 1, maxResolution: "1080p" },
        }),
    }),
  );
  assert.ok(
    stripHtmlTags(biliMusicZhHtml).includes("原声音频 (M4A)"),
    "zh-CN ResultDetailsSidebar[bilibili-audio-*] must keep Chinese title",
  );

  // 4. ResultSection under locale="en" across key scenarios:
  //    (a) YouTube 8K ready, (b) YouTube login_required alert, (c) Bilibili video, (d) Album
  const ytEnBase = structuredClone(
    loadGoldenFixture("youtube/4k60-8k-adaptive.json").media,
  );
  // Replace Chinese fixture labels with English labels so we test component chrome, not fixture data
  for (const v of ytEnBase.items[0].variants) {
    v.label = v.label
      .replace("含音频", "with audio")
      .replace("仅视频无声", "video only")
      .replace("音频", "Audio");
  }
  const ytEnLoginRequired = structuredClone(ytEnBase);
  ytEnLoginRequired.extra.youtube_helper = { status: "login_required" };

  const enAlbum = {
    schema_version: "1.0",
    platform: "xiaohongshu",
    platform_name: "Xiaohongshu",
    content_id: "en-album-1",
    title: "Autumn Film Gallery",
    source_url: "https://www.xiaohongshu.com/explore/en-album-1",
    default_item_id: "img-1",
    items: [
      {
        id: "img-1",
        index: 0,
        type: "image",
        state: "ready",
        default: { variant_id: "i1" },
        variants: [
          {
            id: "i1",
            label: "Original",
            state: "ready",
            metadata: { extension: "jpg", mime_type: "image/jpeg" },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s1",
                  url: "https://sns-webpic-qc.xhscdn.com/golden/en-1.jpg",
                  browser_fetch: "allowed",
                },
              ],
            },
          },
        ],
      },
      {
        id: "img-2",
        index: 1,
        type: "image",
        state: "ready",
        default: { variant_id: "i2" },
        variants: [
          {
            id: "i2",
            label: "Original",
            state: "ready",
            metadata: { extension: "jpg", mime_type: "image/jpeg" },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s2",
                  url: "https://sns-webpic-qc.xhscdn.com/golden/en-2.jpg",
                  browser_fetch: "allowed",
                },
              ],
            },
          },
        ],
      },
    ],
  };

  for (const [scenarioName, resultData] of [
    ["youtube-8k-ready", ytEnBase],
    ["youtube-login-required", ytEnLoginRequired],
    ["bilibili-dash", enMediaFixture],
    ["xiaohongshu-album", enAlbum],
  ]) {
    const selection = useVideoSelection({ videoStore: { resultData } });
    selection.syncResult();
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(ResultSection, {
            resultData,
            resultVersion: 1,
            locale: "en",
            selection,
            isDownloading: false,
            needsManualHelperRefresh: false,
            resolvingIds: new Set(),
            formatNumber: enFormatNumber,
            formatDuration: enFormatDuration,
          }),
      }),
    );
    const visible = stripHtmlTags(html);
    assert.equal(
      CJK_RE.test(visible),
      false,
      `EN ResultSection[${scenarioName}] leaked CJK: ${JSON.stringify(visible.match(/[\u4e00-\u9fff]+/g))}`,
    );
  }
});
