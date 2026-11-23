import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { runArchitectureBoundaryCheck } from "../scripts/check-architecture-boundaries.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const PROD_API_ORIGIN = "https://snap.dokitool.com";

let vite;
let mediaKernel;
let capabilityHub;
let resultPresentation;
let uiTargetHelpers;
let extensionDownload;

test.before(async () => {
  vite = await createServer({
    root: frontendRoot,
    configFile: false,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  mediaKernel = await vite.ssrLoadModule("/src/core/media/index.ts");
  capabilityHub = await vite.ssrLoadModule("/src/core/capabilityHub.ts");
  resultPresentation = await vite.ssrLoadModule(
    "/src/components/result/resultPresentation.ts",
  );
  uiTargetHelpers = await vite.ssrLoadModule(
    "/src/extension/uiTargetHelpers.ts",
  );
  extensionDownload = await vite.ssrLoadModule(
    "/src/extension/extensionDownload.ts",
  );
});

test.after(async () => {
  await vite?.close();
});

test("Architecture Boundary Gate: zero business-layer platform hardcoding, file complexity caps, and solid CSS fallbacks", () => {
  const result = runArchitectureBoundaryCheck();
  assert.equal(
    result.passed,
    true,
    `Expected 0 architecture boundary violations, got:\n${result.violations.join("\n")}`,
  );
  assert.ok(result.businessFilesChecked >= 20);
  assert.ok(result.lineCapFilesChecked >= 5);
  assert.ok(result.cssFilesChecked >= 15);
});

test("Shared Media Kernel: Web and Extension produce 100% byte-identical canonical variant ordering across XHS, Bilibili, YouTube, and Tier-2 mux fixtures", () => {
  const context = { apiOrigin: PROD_API_ORIGIN };

  // 1. Xiaohongshu: 720p listed first (backend default), 2160x3840 original_endpoint listed second
  const xhsMedia = {
    schema_version: "1.0",
    platform: "xiaohongshu",
    platform_name: "小红书",
    content_id: "xhs_4k_sort_fixture",
    title: "小红书 4K 排序回归",
    default_item_id: "item-1",
    items: [
      {
        id: "item-1",
        index: 0,
        type: "video",
        state: "ready",
        default: { variant_id: "xhs-720p", source_id: "s-720" },
        variants: [
          {
            id: "xhs-720p",
            label: "720p",
            state: "ready",
            provenance: "transcode",
            metadata: {
              width: 720,
              height: 1280,
              video_codec: "avc1.640028",
              container: "mp4",
              has_audio: true,
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-720",
                  url: "https://sns-video-bd.xhscdn.com/stream/720p.mp4",
                  size_bytes: 5_000_000,
                },
              ],
            },
          },
          {
            id: "xhs-orig-4k",
            label: "原始入口",
            state: "ready",
            provenance: "original_endpoint",
            metadata: {
              width: 2160,
              height: 3840,
              video_codec: "hev1.1.6.L150.90",
              container: "mp4",
              has_audio: true,
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-orig",
                  url: "https://sns-video-bd.xhscdn.com/stream/orig-4k.mp4",
                  size_bytes: 28_000_000,
                },
              ],
            },
          },
          {
            id: "xhs-1080p",
            label: "1080p",
            state: "ready",
            provenance: "transcode",
            metadata: {
              width: 1080,
              height: 1920,
              video_codec: "avc1.640028",
              container: "mp4",
              has_audio: true,
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-1080",
                  url: "https://sns-video-bd.xhscdn.com/stream/1080p.mp4",
                  size_bytes: 12_000_000,
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const webXhsIds = resultPresentation
    .buildAllQualityOptions(xhsMedia.items[0], null, null, context)
    .map((o) => o.variant.id);
  const extXhsIds = uiTargetHelpers
    .buildSidePanelQualityOptions(xhsMedia, xhsMedia.items[0], PROD_API_ORIGIN)
    .map((o) => o.variant.id);
  assert.deepEqual(webXhsIds, ["xhs-orig-4k", "xhs-1080p", "xhs-720p"]);
  assert.deepEqual(
    webXhsIds,
    extXhsIds,
    "Web and Extension XHS variant order must be 100% identical",
  );
  const xhsDefault = mediaKernel.resolveEffectiveDefaultVariant(
    resultPresentation.buildAllQualityOptions(xhsMedia.items[0], null, null, context),
    null,
  );
  assert.equal(xhsDefault.variant.id, "xhs-orig-4k");
  const xhsQuickPlan = extensionDownload.selectVariantByPreference(
    xhsMedia.items[0],
    [],
    "best",
    PROD_API_ORIGIN,
  );
  assert.equal(xhsQuickPlan.variant.id, "xhs-orig-4k");

  // 2. Bilibili: 720p file + 3x 1080p DASH mux (AV1, HEVC, H.264) in deliberately scrambled order
  const biliMedia = {
    schema_version: "1.0",
    platform: "bilibili",
    platform_name: "B站",
    content_id: "BV1SortTest001",
    title: "B站单P排序测试",
    default_item_id: "p1",
    items: [
      {
        id: "p1",
        index: 0,
        type: "video",
        state: "ready",
        default: { variant_id: "bili-720p", source_id: "s-720" },
        variants: [
          {
            id: "bili-720p",
            label: "720p",
            state: "ready",
            metadata: {
              width: 1280,
              height: 720,
              video_codec: "avc1.640028",
              container: "mp4",
              has_audio: true,
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-720",
                  url: "https://upos-sz-mirrorcosov.bilivideo.com/720p.mp4",
                  size_bytes: 14_000_000,
                },
              ],
            },
          },
          {
            id: "dash-80-av1",
            label: "1080p",
            state: "ready",
            metadata: {
              width: 1920,
              height: 1080,
              fps: 30,
              video_codec: "av01.0.08M.08",
              audio_codec: "mp4a.40.2",
              container: "mp4",
            },
            delivery: {
              kind: "mux",
              output: { container: "mp4", extension: "mp4" },
              resources: [
                {
                  id: "video",
                  role: "video",
                  delivery: {
                    kind: "file",
                    sources: [
                      {
                        id: "v-av1",
                        url: "https://upos-sz-mirrorcosov.bilivideo.com/1080-av1.m4s",
                        size_bytes: 22_000_000,
                      },
                    ],
                  },
                },
                {
                  id: "audio",
                  role: "audio",
                  delivery: {
                    kind: "file",
                    sources: [
                      {
                        id: "a-aac",
                        url: "https://upos-sz-mirrorcosov.bilivideo.com/audio.m4s",
                        size_bytes: 2_400_000,
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            id: "dash-80-hevc",
            label: "1080p",
            state: "ready",
            metadata: {
              width: 1920,
              height: 1080,
              fps: 30,
              video_codec: "hev1.1.6.L120.90",
              audio_codec: "mp4a.40.2",
              container: "mp4",
            },
            delivery: {
              kind: "mux",
              output: { container: "mp4", extension: "mp4" },
              resources: [
                {
                  id: "video",
                  role: "video",
                  delivery: {
                    kind: "file",
                    sources: [
                      {
                        id: "v-hevc",
                        url: "https://upos-sz-mirrorcosov.bilivideo.com/1080-hevc.m4s",
                        size_bytes: 25_000_000,
                      },
                    ],
                  },
                },
                {
                  id: "audio",
                  role: "audio",
                  delivery: {
                    kind: "file",
                    sources: [
                      {
                        id: "a-aac2",
                        url: "https://upos-sz-mirrorcosov.bilivideo.com/audio.m4s",
                        size_bytes: 2_400_000,
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            id: "dash-80-avc",
            label: "1080p",
            state: "ready",
            metadata: {
              width: 1920,
              height: 1080,
              fps: 30,
              video_codec: "avc1.640032",
              audio_codec: "mp4a.40.2",
              container: "mp4",
            },
            delivery: {
              kind: "mux",
              output: { container: "mp4", extension: "mp4" },
              resources: [
                {
                  id: "video",
                  role: "video",
                  delivery: {
                    kind: "file",
                    sources: [
                      {
                        id: "v-avc",
                        url: "https://upos-sz-mirrorcosov.bilivideo.com/1080-avc.m4s",
                        size_bytes: 40_000_000,
                      },
                    ],
                  },
                },
                {
                  id: "audio",
                  role: "audio",
                  delivery: {
                    kind: "file",
                    sources: [
                      {
                        id: "a-aac3",
                        url: "https://upos-sz-mirrorcosov.bilivideo.com/audio.m4s",
                        size_bytes: 2_400_000,
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

  // Disconnected Web: 720p is the only downloadable tier -> ranks #1 and selected by default
  const webBiliOff = resultPresentation.buildAllQualityOptions(
    biliMedia.items[0],
    null,
    null,
    context,
    { allowExtensionDashMux: false },
  );
  assert.equal(webBiliOff[0].variant.id, "bili-720p");
  assert.equal(
    mediaKernel.resolveEffectiveDefaultVariant(webBiliOff, null).variant.id,
    "bili-720p",
  );

  // Connected Web vs Extension: 100% identical ordering [H.264 1080p, HEVC 1080p, AV1 1080p, 720p]
  const webBiliOn = resultPresentation.buildAllQualityOptions(
    biliMedia.items[0],
    null,
    null,
    context,
    { allowExtensionDashMux: true },
  );
  const extBili = uiTargetHelpers.buildSidePanelQualityOptions(
    biliMedia,
    biliMedia.items[0],
    PROD_API_ORIGIN,
  );
  const expectedBiliOrder = [
    "dash-80-avc",
    "dash-80-hevc",
    "dash-80-av1",
    "bili-720p",
  ];
  assert.deepEqual(
    webBiliOn.map((o) => o.variant.id),
    expectedBiliOrder,
  );
  assert.deepEqual(
    extBili.filter((o) => o.kind === "variant").map((o) => o.variant.id),
    expectedBiliOrder,
    "Web (connected) and Extension Bilibili variant order must be 100% identical",
  );
  // Synthesized standalone audio attachment on SidePanel always sits after all video tiers
  const extBiliAttachments = extBili.filter((o) => o.kind === "attachment");
  if (extBiliAttachments.length > 0) {
    assert.equal(extBili.at(-1).kind, "attachment");
  }
  // Dynamic default auto-upgrades to 1080p H.264, while respecting explicit manual override
  assert.equal(
    mediaKernel.resolveEffectiveDefaultVariant(webBiliOn, null).variant.id,
    "dash-80-avc",
  );
  assert.equal(
    mediaKernel.resolveEffectiveDefaultVariant(webBiliOn, "bili-720p").variant.id,
    "bili-720p",
  );

  // 3. YouTube: 360p muxed, 1080p30 split, 4K60 split, 1080p60 split, audio m4a -> identical on Web & Extension
  const ytMedia = {
    schema_version: "1.0",
    platform: "youtube",
    platform_name: "YouTube",
    content_id: "dQw4w9WgXcQ",
    title: "YouTube 4K60 排序回归",
    default_item_id: "yt-1",
    items: [
      {
        id: "yt-1",
        index: 0,
        type: "video",
        state: "ready",
        default: { variant_id: "yt-360", source_id: "s-360" },
        variants: [
          {
            id: "yt-audio",
            label: "音频 M4A",
            state: "ready",
            metadata: {
              audio_codec: "mp4a.40.2",
              mime_type: "audio/mp4",
              container: "m4a",
              has_audio: true,
              audio_bitrate_bps: 128_000,
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-aud",
                  url: "https://rr1---sn-demo.googlevideo.com/videoplayback?itag=140",
                  size_bytes: 3_000_000,
                },
              ],
            },
          },
          {
            id: "yt-360",
            label: "360p",
            state: "ready",
            metadata: {
              width: 640,
              height: 360,
              fps: 30,
              video_codec: "avc1.42001E",
              audio_codec: "mp4a.40.2",
              has_audio: true,
              container: "mp4",
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-360",
                  url: "https://rr1---sn-demo.googlevideo.com/videoplayback?itag=18",
                  size_bytes: 8_000_000,
                },
              ],
            },
          },
          {
            id: "yt-1080p30",
            label: "1080p",
            state: "ready",
            metadata: {
              width: 1920,
              height: 1080,
              fps: 30,
              video_codec: "avc1.640028",
              has_audio: false,
              container: "mp4",
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-1080-30",
                  url: "https://rr1---sn-demo.googlevideo.com/videoplayback?itag=137",
                  size_bytes: 40_000_000,
                },
              ],
            },
          },
          {
            id: "yt-1080p60",
            label: "1080p60",
            state: "ready",
            metadata: {
              width: 1920,
              height: 1080,
              fps: 60,
              video_codec: "avc1.64002A",
              has_audio: false,
              container: "mp4",
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-1080-60",
                  url: "https://rr1---sn-demo.googlevideo.com/videoplayback?itag=299",
                  size_bytes: 60_000_000,
                },
              ],
            },
          },
          {
            id: "yt-4k60",
            label: "4K60",
            state: "ready",
            metadata: {
              width: 3840,
              height: 2160,
              fps: 60,
              video_codec: "av01.0.13M.08",
              has_audio: false,
              container: "mp4",
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-4k60",
                  url: "https://rr1---sn-demo.googlevideo.com/videoplayback?itag=401",
                  size_bytes: 180_000_000,
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const ytMuxPairs = new Map([
    ["yt-4k60", { ok: true }],
    ["yt-1080p60", { ok: true }],
    ["yt-1080p30", { ok: true }],
  ]);
  const webYtIds = resultPresentation
    .buildAllQualityOptions(ytMedia.items[0], null, null, context, {
      muxPairsByVariantId: ytMuxPairs,
    })
    .map((o) => o.variant.id);
  const extYtIds = uiTargetHelpers
    .buildSidePanelQualityOptions(ytMedia, ytMedia.items[0], PROD_API_ORIGIN)
    .map((o) => o.variant.id);
  const expectedYtOrder = [
    "yt-4k60",
    "yt-1080p60",
    "yt-1080p30",
    "yt-360",
    "yt-audio",
  ];
  assert.deepEqual(webYtIds, expectedYtOrder);
  assert.deepEqual(
    webYtIds,
    extYtIds,
    "Web and Extension YouTube variant order must be 100% identical",
  );

  // 4. Non-Bilibili Tier-2 platform returning standard `delivery.kind === "mux"` MUST NOT be blocked
  const vimeoMuxItem = {
    id: "vimeo-1",
    index: 0,
    type: "video",
    state: "ready",
    default: null,
    variants: [
      {
        id: "vimeo-1080-mux",
        label: "1080p",
        state: "ready",
        metadata: {
          width: 1920,
          height: 1080,
          video_codec: "avc1.640028",
          audio_codec: "mp4a.40.2",
          container: "mp4",
        },
        delivery: {
          kind: "mux",
          output: { container: "mp4", extension: "mp4" },
          resources: [
            {
              id: "video",
              role: "video",
              delivery: {
                kind: "file",
                sources: [
                  {
                    id: "v-1",
                    url: "https://vod-progressive.akamaized.net/vimeo-video.m4s",
                  },
                ],
              },
            },
            {
              id: "audio",
              role: "audio",
              delivery: {
                kind: "file",
                sources: [
                  {
                    id: "a-1",
                    url: "https://vod-progressive.akamaized.net/vimeo-audio.m4s",
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  };
  const extractedMux = resultPresentation.extractMuxVariants(vimeoMuxItem);
  assert.equal(extractedMux.length, 1);
  assert.equal(extractedMux[0].id, "vimeo-1080-mux");
  const webVimeoOpts = resultPresentation.buildAllQualityOptions(
    vimeoMuxItem,
    null,
    null,
    context,
    { allowExtensionDashMux: true },
  );
  assert.equal(webVimeoOpts[0].extensionMux, true);
  assert.equal(webVimeoOpts[0].downloadable, true);

  // 5. Unwhitelisted third-party mux domain MUST NOT claim extension mux availability
  const unwhitelistedMuxItem = {
    ...vimeoMuxItem,
    id: "unwhitelisted-1",
    variants: [
      {
        ...vimeoMuxItem.variants[0],
        id: "unwhitelisted-1080-mux",
        delivery: {
          ...vimeoMuxItem.variants[0].delivery,
          resources: [
            {
              id: "video",
              role: "video",
              delivery: {
                kind: "file",
                sources: [
                  { id: "v-u", url: "https://media.example.test/video.m4s" },
                ],
              },
            },
            {
              id: "audio",
              role: "audio",
              delivery: {
                kind: "file",
                sources: [
                  { id: "a-u", url: "https://media.example.test/audio.m4s" },
                ],
              },
            },
          ],
        },
      },
    ],
  };
  assert.equal(
    resultPresentation.extractMuxVariants(unwhitelistedMuxItem, context).length,
    0,
  );
  const webUnwhitelistedOpts = resultPresentation.buildAllQualityOptions(
    unwhitelistedMuxItem,
    null,
    null,
    context,
    { allowExtensionDashMux: true },
  );
  assert.equal(webUnwhitelistedOpts[0].extensionMux, false);
  assert.equal(webUnwhitelistedOpts[0].downloadable, false);

  // 6. Cinema 4K 60fps (3840x2026@60) sorts above 16:9 4K 30fps (3840x2160@30)
  const cinemaItem = {
    id: "cinema-1",
    index: 0,
    type: "video",
    state: "ready",
    default: { variant_id: "v-4k30", source_id: "s-30" },
    variants: [
      {
        id: "v-4k30",
        label: "4K",
        state: "ready",
        metadata: { width: 3840, height: 2160, fps: 30, has_audio: true },
        delivery: {
          kind: "file",
          sources: [{ id: "s-30", url: "https://cdn.example.test/4k30.mp4" }],
        },
      },
      {
        id: "v-cinema-4k60",
        label: "2026p60 (4K)",
        state: "ready",
        metadata: { width: 3840, height: 2026, fps: 60, has_audio: true },
        delivery: {
          kind: "file",
          sources: [{ id: "s-60", url: "https://cdn.example.test/4k60.mp4" }],
        },
      },
    ],
  };
  assert.deepEqual(
    resultPresentation
      .buildAllQualityOptions(cinemaItem, null, null, context)
      .map((o) => o.variant.id),
    ["v-cinema-4k60", "v-4k30"],
  );

  // 7. shouldAutoUpgradeDefaultVariant guards all Unified-v1 & playback invariants
  assert.equal(
    mediaKernel.shouldAutoUpgradeDefaultVariant(null, webBiliOn[0]),
    false,
    "never auto-select when item.default is absent",
  );
  assert.equal(
    mediaKernel.shouldAutoUpgradeDefaultVariant(
      webBiliOn.find((o) => o.variant.id === "bili-720p"),
      webBiliOn[0],
    ),
    true,
    "auto-upgrades Bilibili 720p to unlocked 1080p H.264 extensionMux",
  );
  const webXhsOpts = resultPresentation.buildAllQualityOptions(
    xhsMedia.items[0],
    null,
    null,
    context,
  );
  assert.equal(
    mediaKernel.shouldAutoUpgradeDefaultVariant(
      webXhsOpts.find((o) => o.variant.id === "xhs-720p"),
      webXhsOpts[0],
    ),
    true,
    "auto-upgrades XHS 720p to original_endpoint 4K",
  );
  const unprobedDefault = {
    variant: {
      id: "v0",
      state: "ready",
      metadata: { extension: "mp4" },
      delivery: { kind: "file", sources: [{ id: "s0", url: "https://media.test/main.mp4" }] },
    },
    downloadable: true,
  };
  const labeledBackup = {
    variant: {
      id: "v1",
      label: "720p",
      state: "ready",
      metadata: { extension: "mp4" },
      delivery: { kind: "file", sources: [{ id: "s1", url: "https://media.test/720p.mp4" }] },
    },
    downloadable: true,
  };
  assert.equal(
    mediaKernel.shouldAutoUpgradeDefaultVariant(unprobedDefault, labeledBackup),
    false,
    "never discards an unprobed primary default for a labeled backup",
  );
});

test("Capability Hub: enforces priority Connected Extension > Userscript > Web SW > Direct and SemVer update checks", () => {
  const extFullEnv = {
    extensionConnected: true,
    extensionVersion: capabilityHub.LATEST_EXTENSION_VERSION,
    extensionCapabilities: [
      "dash_mux",
      "direct_download",
      "youtube_parse",
      "youtube_mux",
    ],
    userscriptReady: true,
    swMultiRangeAvailable: true,
  };
  const userscriptOnlyEnv = {
    extensionConnected: false,
    extensionVersion: "",
    extensionCapabilities: [],
    userscriptReady: true,
    swMultiRangeAvailable: true,
  };
  const bareWebEnv = {
    extensionConnected: false,
    extensionVersion: "",
    extensionCapabilities: [],
    userscriptReady: false,
    swMultiRangeAvailable: true,
  };

  // Connected extension beats userscript for client-session parse & split mux
  assert.equal(
    capabilityHub.resolveClientParseRoute(true, extFullEnv).channel,
    "extension_client_parse",
  );
  assert.equal(
    capabilityHub.resolveClientParseRoute(true, userscriptOnlyEnv).channel,
    "userscript_client_parse",
  );
  assert.equal(
    capabilityHub.resolveClientParseRoute(true, bareWebEnv).channel,
    "server_api",
  );

  const ytSplitPlanExt = capabilityHub.resolveExecutionPlan(
    {
      deliveryKind: "file",
      hasSplitMuxPair: true,
      requiresClientSession: true,
      whitelistedForExtension: true,
    },
    extFullEnv,
  );
  assert.equal(ytSplitPlanExt.channel, "extension_youtube_mux");
  assert.equal(ytSplitPlanExt.usesExtension, true);

  const ytSplitPlanUs = capabilityHub.resolveExecutionPlan(
    {
      deliveryKind: "file",
      hasSplitMuxPair: true,
      requiresClientSession: true,
      whitelistedForExtension: true,
    },
    userscriptOnlyEnv,
  );
  assert.equal(ytSplitPlanUs.channel, "userscript_mux");
  assert.equal(ytSplitPlanUs.usesUserscript, true);

  const ytSplitPlanBare = capabilityHub.resolveExecutionPlan(
    {
      deliveryKind: "file",
      hasSplitMuxPair: true,
      requiresClientSession: true,
      whitelistedForExtension: true,
    },
    bareWebEnv,
  );
  assert.equal(ytSplitPlanBare.channel, "blocked");
  assert.equal(ytSplitPlanBare.requiresUpgradeNotice, true);

  // Generic mux unlocked via connected extension, blocked otherwise
  assert.equal(
    capabilityHub.resolveExecutionPlan(
      { deliveryKind: "mux", whitelistedForExtension: true },
      extFullEnv,
    ).channel,
    "extension_mux",
  );
  assert.equal(
    capabilityHub.resolveExecutionPlan(
      { deliveryKind: "mux", whitelistedForExtension: true },
      bareWebEnv,
    ).channel,
    "blocked",
  );

  // SemVer update detection
  assert.equal(capabilityHub.compareSemver("4.1.0", "4.2.0"), -1);
  assert.equal(capabilityHub.compareSemver("4.2.0", "4.2.0"), 0);
  assert.equal(capabilityHub.compareSemver("4.2.1", "4.2.0"), 1);
  assert.equal(
    capabilityHub.isExtensionVersionOutdated("4.1.0", "4.2.0"),
    true,
  );
  assert.equal(
    capabilityHub.isExtensionVersionOutdated("4.2.0", "4.2.0"),
    false,
  );
  assert.equal(capabilityHub.isExtensionVersionOutdated("", "4.2.0"), false);

  // Release meta JSON matches LATEST_EXTENSION_VERSION
  const metaJson = JSON.parse(
    fs.readFileSync(
      path.join(frontendRoot, "src", "core", "extensionReleaseMeta.json"),
      "utf8",
    ),
  );
  assert.equal(capabilityHub.LATEST_EXTENSION_VERSION, metaJson.version);
});

test("Round 2 regressions: loopback apiOrigin mux whitelist, mixed-route stripping, source/fallback pairing, and label-inferred 1080p60 > 1080p+ > 1080p", () => {
  const prodContext = { apiOrigin: PROD_API_ORIGIN };
  const loopbackContext = { apiOrigin: "http://127.0.0.1:4173" };

  // 1. Loopback apiOrigin allows local 127.0.0.1:<port> mux streams while public HTTPS stays fail-closed
  const loopbackMuxItem = {
    id: "loopback-mux-1",
    index: 0,
    type: "video",
    state: "ready",
    default: null,
    variants: [
      {
        id: "local-1080-mux",
        label: "1080p",
        state: "ready",
        metadata: { width: 1920, height: 1080, video_codec: "avc1.640028" },
        delivery: {
          kind: "mux",
          output: { container: "mp4", extension: "mp4" },
          resources: [
            {
              id: "video",
              role: "video",
              delivery: {
                kind: "file",
                sources: [
                  {
                    id: "v-local",
                    url: "http://127.0.0.1:4173/media/video-1080.mp4",
                  },
                ],
              },
            },
            {
              id: "audio",
              role: "audio",
              delivery: {
                kind: "file",
                sources: [
                  {
                    id: "a-local",
                    url: "http://127.0.0.1:4173/media/audio.m4a",
                    browser_fetch: "blocked",
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  };

  assert.equal(
    mediaKernel.resolveWhitelistedExtensionMuxSpec(
      loopbackMuxItem.variants[0],
      prodContext,
    ),
    null,
    "public https apiOrigin must reject loopback mux URLs",
  );
  const loopbackResolved = mediaKernel.resolveWhitelistedExtensionMuxSpec(
    loopbackMuxItem.variants[0],
    loopbackContext,
  );
  assert.ok(loopbackResolved, "loopback apiOrigin must allow its own origin mux");
  assert.deepEqual(loopbackResolved.videoRoutes, [
    "http://127.0.0.1:4173/media/video-1080.mp4",
  ]);
  assert.deepEqual(loopbackResolved.audioRoutes, [
    "http://127.0.0.1:4173/media/audio.m4a",
  ]);
  assert.equal(
    mediaKernel.isMuxSpecWhitelistedForExtension(
      mediaKernel.extractMuxSpec(loopbackMuxItem.variants[0], loopbackContext),
      loopbackContext,
    ),
    true,
  );
  const loopbackWebOpts = resultPresentation.buildAllQualityOptions(
    loopbackMuxItem,
    null,
    null,
    loopbackContext,
    { allowExtensionDashMux: true },
  );
  assert.equal(loopbackWebOpts[0].extensionMux, true);
  assert.equal(loopbackWebOpts[0].downloadable, true);
  assert.deepEqual(
    mediaKernel.resolveProtectedExtensionAudioRoutes(
      loopbackMuxItem.variants[0].delivery.resources[1],
      loopbackContext,
    ),
    ["http://127.0.0.1:4173/media/audio.m4a"],
  );
  assert.equal(
    mediaKernel.resolveProtectedExtensionAudioRoutes(
      loopbackMuxItem.variants[0].delivery.resources[1],
      prodContext,
    ),
    null,
  );

  // 2. Mixed whitelisted + unwhitelisted routes: strips unwhitelisted mirrors and preserves accurate per-Source fallback_urls pairing
  const mixedMuxVariant = {
    id: "mixed-mux",
    label: "1080p",
    state: "ready",
    metadata: { width: 1920, height: 1080, video_codec: "avc1.640028" },
    delivery: {
      kind: "mux",
      output: { container: "mp4", extension: "mp4" },
      resources: [
        {
          id: "video",
          role: "video",
          delivery: {
            kind: "file",
            sources: [
              {
                id: "v-primary",
                url: "https://upos-sz-mirrorcosov.bilivideo.com/v1080.m4s",
                fallback_urls: ["https://upos-sz-mirrorcosov.bilivideo.com/v1080.m4s?cred=alt"],
              },
              {
                id: "v-backup",
                url: "https://cdn-unwhitelisted.example.org/v1080-backup.m4s",
              },
            ],
          },
        },
        {
          id: "audio",
          role: "audio",
          delivery: {
            kind: "file",
            sources: [
              {
                id: "a-unavail",
                url: "https://cdn-unwhitelisted.example.org/dead.m4s",
                availability: "unavailable",
              },
              {
                id: "a-primary",
                url: "https://vod-progressive.akamaized.net/audio-1.m4a",
                fallback_urls: ["https://vod-progressive.akamaized.net/audio-1.m4a?cred=alt"],
              },
              {
                id: "a-unwhitelisted-mirror",
                url: "https://cdn-unwhitelisted.example.org/audio-mirror.m4a",
              },
              {
                id: "a-blocked",
                url: "https://upos-sz-mirrorcosov.bilivideo.com/audio-2.m4s",
                browser_fetch: "blocked",
              },
            ],
          },
        },
      ],
    },
  };
  const filteredMux = mediaKernel.resolveWhitelistedExtensionMuxSpec(
    mixedMuxVariant,
    prodContext,
  );
  assert.ok(filteredMux);
  assert.deepEqual(filteredMux.videoRoutes, [
    "https://upos-sz-mirrorcosov.bilivideo.com/v1080.m4s",
    "https://upos-sz-mirrorcosov.bilivideo.com/v1080.m4s?cred=alt",
  ]);
  assert.deepEqual(filteredMux.audioRoutes, [
    "https://vod-progressive.akamaized.net/audio-1.m4a",
    "https://vod-progressive.akamaized.net/audio-1.m4a?cred=alt",
    "https://upos-sz-mirrorcosov.bilivideo.com/audio-2.m4s",
  ]);
  // Even with unavailable source + same-origin fallback_urls shifting array indices, source #3's browser_fetch="blocked" is paired accurately!
  assert.deepEqual(
    mediaKernel.resolveProtectedExtensionAudioRoutes(
      mixedMuxVariant.delivery.resources[1],
      prodContext,
    ),
    [
      "https://vod-progressive.akamaized.net/audio-1.m4a",
      "https://vod-progressive.akamaized.net/audio-1.m4a?cred=alt",
      "https://upos-sz-mirrorcosov.bilivideo.com/audio-2.m4s",
    ],
  );
  // Purely non-protected whitelisted audio (e.g. douyinvod without browser_fetch="blocked") returns null -> stays native Web audio
  assert.equal(
    mediaKernel.resolveProtectedExtensionAudioRoutes(
      {
        delivery: {
          kind: "file",
          sources: [
            { id: "a-open", url: "https://v26-web.douyinvod.com/open.m4a" },
          ],
        },
      },
      prodContext,
    ),
    null,
  );

  // 3. Known 1920x1080 without numeric metadata.fps sorts 1080p60 > 1080p+ > 1080p identically on Web & Extension
  const labelFpsMedia = {
    schema_version: "1.0",
    platform: "bilibili",
    platform_name: "B站",
    content_id: "label-fps-sort",
    title: "标签帧率与高码率档位排序",
    default_item_id: "item-fps",
    items: [
      {
        id: "item-fps",
        index: 0,
        type: "video",
        state: "ready",
        default: { variant_id: "v-1080", source_id: "s-1080" },
        variants: [
          {
            id: "v-1080",
            label: "1080p",
            state: "ready",
            metadata: {
              width: 1920,
              height: 1080,
              video_codec: "avc1.640028",
              has_audio: true,
            },
            delivery: {
              kind: "file",
              sources: [
                { id: "s-1080", url: "https://upos-sz-mirrorcosov.bilivideo.com/1080.mp4" },
              ],
            },
          },
          {
            id: "v-1080-plus",
            label: "1080p+",
            state: "ready",
            metadata: {
              width: 1920,
              height: 1080,
              video_codec: "avc1.640028",
              has_audio: true,
            },
            delivery: {
              kind: "file",
              sources: [
                { id: "s-1080p", url: "https://upos-sz-mirrorcosov.bilivideo.com/1080plus.mp4" },
              ],
            },
          },
          {
            id: "v-1080-60",
            label: "1080p60",
            state: "ready",
            metadata: {
              width: 1920,
              height: 1080,
              video_codec: "avc1.640028",
              has_audio: true,
            },
            delivery: {
              kind: "file",
              sources: [
                { id: "s-1080-60", url: "https://upos-sz-mirrorcosov.bilivideo.com/1080p60.mp4" },
              ],
            },
          },
        ],
      },
    ],
  };
  const webLabelOrder = resultPresentation
    .buildAllQualityOptions(labelFpsMedia.items[0], null, null, prodContext)
    .map((o) => o.variant.id);
  const extLabelOrder = uiTargetHelpers
    .buildSidePanelQualityOptions(labelFpsMedia, labelFpsMedia.items[0], PROD_API_ORIGIN)
    .map((o) => o.variant.id);
  assert.deepEqual(webLabelOrder, ["v-1080-60", "v-1080-plus", "v-1080"]);
  assert.deepEqual(extLabelOrder, ["v-1080-60", "v-1080-plus", "v-1080"]);
  assert.equal(
    extensionDownload.selectVariantByPreference(
      labelFpsMedia.items[0],
      [],
      "best",
      PROD_API_ORIGIN,
    ).variant.id,
    "v-1080-60",
  );
});

test("P2: prefersExtensionDirectAcceleration and resolveAcceleratedExtensionDirectRoutes identify whitelisted slow progressive CDNs cleanly", () => {
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/720p.mp4",
    ),
    true,
  );
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      "https://cn-sh-fx-01.bilivideo.cn/upgcxcode/720p.mp4",
    ),
    true,
  );
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/720p.mp4",
    ),
    true,
  );
  // Reject non-slow hosts, http:, credentials, and relay sources
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      "https://sns-video-bd.xhscdn.com/stream/720p.mp4",
    ),
    false,
  );
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      "http://upos-sz-mirrorcos.bilivideo.com/720p.mp4",
    ),
    false,
  );
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      "https://user:pass@upos-sz-mirrorcos.bilivideo.com/720p.mp4",
    ),
    false,
  );
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      "https://upos-sz-mirrorcos.bilivideo.com/720p.mp4",
      { access: "relay" },
    ),
    false,
  );

  // resolveAcceleratedExtensionDirectRoutes keeps only whitelisted routes and filters out unwhitelisted sources
  const routes = mediaKernel.resolveAcceleratedExtensionDirectRoutes(
    {
      delivery: {
        kind: "file",
        sources: [
          {
            id: "s1",
            url: "https://upos-sz-mirrorcos.bilivideo.com/720p.mp4",
          },
          {
            id: "s2",
            url: "https://upos-hz-mirrorakam.akamaized.net/720p.mp4",
          },
          {
            id: "s3",
            url: "https://evil-unwhitelisted.example/720p.mp4",
          },
        ],
      },
    },
    { apiOrigin: PROD_API_ORIGIN },
  );
  assert.deepEqual(routes, [
    "https://upos-sz-mirrorcos.bilivideo.com/720p.mp4",
    "https://upos-hz-mirrorakam.akamaized.net/720p.mp4",
  ]);

  // Normal fast CDN returns null (no extension hijack)
  assert.equal(
    mediaKernel.resolveAcceleratedExtensionDirectRoutes(
      {
        delivery: {
          kind: "file",
          sources: [
            { id: "s1", url: "https://sns-video-bd.xhscdn.com/stream/1080p.mp4" },
          ],
        },
      },
      { apiOrigin: PROD_API_ORIGIN },
    ),
    null,
  );
});
