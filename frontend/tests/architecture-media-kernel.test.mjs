import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
  assert.equal(
    mediaKernel.isRefererProtectedMediaRoute(
      "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/720p.mp4",
    ),
    true,
  );
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      "https://bili-edge.akamaized.net/media/720p.mp4",
    ),
    true,
  );
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      "https://edge-mirror.akamaized.net/upgcxcode/123/720p.mp4",
    ),
    true,
  );
  // Generic non-Bilibili *.akamaized.net URLs (e.g. Vimeo / Facebook) must NEVER be misrouted
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      "https://vod-progressive.akamaized.net/exp=123/vimeo.mp4",
    ),
    false,
  );
  assert.equal(
    mediaKernel.isRefererProtectedMediaRoute(
      "https://vod-progressive.akamaized.net/exp=123/vimeo.mp4",
    ),
    false,
  );
  assert.equal(
    mediaKernel.prefersExtensionDirectAcceleration(
      "https://akamaized.net/upgcxcode/720p.mp4",
    ),
    false,
  );
  assert.equal(
    mediaKernel.resolveAcceleratedExtensionDirectRoutes(
      {
        delivery: {
          kind: "file",
          sources: [
            { id: "v1", url: "https://vod-progressive.akamaized.net/exp=123/vimeo.mp4" },
          ],
        },
      },
      { apiOrigin: PROD_API_ORIGIN },
    ),
    null,
  );
  assert.equal(
    mediaKernel.resolveProtectedExtensionAudioRoutes(
      {
        delivery: {
          kind: "file",
          sources: [
            { id: "a1", url: "https://vod-progressive.akamaized.net/exp=123/audio.m4a" },
          ],
        },
      },
      { apiOrigin: PROD_API_ORIGIN },
    ),
    null,
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

  // Route capping (> 8 whitelisted routes) aligns strictly with webExternalBridge MAX=8 across all 3 resolvers
  const tenVideoSources = Array.from({ length: 10 }, (_, idx) => ({
    id: `v-${idx}`,
    url: `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/v-${idx}.m4s`,
  }));
  const tenAudioSources = Array.from({ length: 10 }, (_, idx) => ({
    id: `a-${idx}`,
    url: `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/a-${idx}.m4s`,
  }));
  const cappedMux = mediaKernel.resolveWhitelistedExtensionMuxSpec(
    {
      id: "v-10-routes",
      label: "1080p",
      state: "ready",
      metadata: { width: 1920, height: 1080, video_codec: "avc1.640028" },
      delivery: {
        kind: "mux",
        output: { container: "mp4", extension: "mp4" },
        resources: [
          { id: "video", role: "video", delivery: { kind: "file", sources: tenVideoSources } },
          { id: "audio", role: "audio", delivery: { kind: "file", sources: tenAudioSources } },
        ],
      },
    },
    { apiOrigin: PROD_API_ORIGIN },
  );
  assert.ok(cappedMux);
  assert.equal(cappedMux.videoRoutes.length, 8);
  assert.equal(cappedMux.audioRoutes.length, 8);
  assert.equal(cappedMux.videoRoutes[0], tenVideoSources[0].url);
  assert.equal(cappedMux.videoRoutes[7], tenVideoSources[7].url);

  const cappedProtectedAudio = mediaKernel.resolveProtectedExtensionAudioRoutes(
    { delivery: { kind: "file", sources: tenAudioSources } },
    { apiOrigin: PROD_API_ORIGIN },
  );
  assert.ok(cappedProtectedAudio);
  assert.equal(cappedProtectedAudio.length, 8);
  assert.equal(cappedProtectedAudio[7], tenAudioSources[7].url);

  const cappedAccelerated = mediaKernel.resolveAcceleratedExtensionDirectRoutes(
    { delivery: { kind: "file", sources: tenVideoSources } },
    { apiOrigin: PROD_API_ORIGIN },
  );
  assert.ok(cappedAccelerated);
  assert.equal(cappedAccelerated.length, 8);
  assert.equal(cappedAccelerated[7], tenVideoSources[7].url);
});

test("Issue #48 Batch 1: [P1-2] clientSplitMux auto-upgrade, [P1-4]/[P0-1] unified direct delegation traits & capabilityHub, and [P1-5] ugc_season placeholder title & _P<n> dedup", async () => {
  const videoFilenameMod = await vite.ssrLoadModule("/src/utils/videoFilename.ts");

  // 1. [P1-2] shouldAutoUpgradeDefaultVariant upgrades audible 360p to clientSplitMux 4K60/1080p60 when higher resolution
  const yt360 = {
    variant: {
      id: "v-18",
      label: "360p (含音频)",
      state: "ready",
      metadata: { width: 640, height: 360, fps: 30, has_audio: true },
      delivery: { kind: "file", sources: [{ id: "s18", url: "https://rr1---sn.googlevideo.com/videoplayback?itag=18" }] },
    },
    downloadable: true,
    clientSplitMux: false,
  };
  const yt4kSplit = {
    variant: {
      id: "v-315",
      label: "2160p60",
      state: "ready",
      metadata: { width: 3840, height: 2160, fps: 60, has_audio: false },
      delivery: { kind: "file", sources: [{ id: "s315", url: "https://rr1---sn.googlevideo.com/videoplayback?itag=315" }] },
    },
    downloadable: true,
    clientSplitMux: true,
  };
  assert.equal(
    mediaKernel.shouldAutoUpgradeDefaultVariant(yt360, yt4kSplit),
    true,
    "must auto-upgrade 360p default to clientSplitMux 4K60 when YouTube mux pair is ready",
  );
  assert.equal(
    mediaKernel.shouldAutoUpgradeDefaultVariant(yt360, { ...yt4kSplit, clientSplitMux: false }),
    false,
    "must NOT upgrade to silent split track when clientSplitMux is unavailable",
  );
  const progressive4k = {
    variant: {
      id: "v-prog-4k",
      label: "2160p",
      state: "ready",
      metadata: { width: 3840, height: 2160, fps: 30, has_audio: true },
      delivery: { kind: "file", sources: [{ id: "sp4k", url: "https://rr1---sn.googlevideo.com/videoplayback?itag=99" }] },
    },
    downloadable: true,
    clientSplitMux: false,
  };
  const split1080 = {
    variant: {
      id: "v-137",
      label: "1080p",
      state: "ready",
      metadata: { width: 1920, height: 1080, fps: 30, has_audio: false },
      delivery: { kind: "file", sources: [{ id: "s137", url: "https://rr1---sn.googlevideo.com/videoplayback?itag=137" }] },
    },
    downloadable: true,
    clientSplitMux: true,
  };
  assert.equal(
    mediaKernel.shouldAutoUpgradeDefaultVariant(progressive4k, split1080),
    false,
    "must never downgrade a higher-resolution progressive default to a lower-resolution split track",
  );

  // 2. [P1-4] & [P0-1] capabilityHub routes corsBlockedDirect, hasTbvideo, and SW-unavailable whitelisted files to extension_direct
  const extEnv = {
    extensionConnected: true,
    extensionVersion: capabilityHub.LATEST_EXTENSION_VERSION,
    extensionCapabilities: ["dash_mux", "direct_download", "youtube_parse", "youtube_mux"],
    userscriptReady: false,
    swMultiRangeAvailable: true,
  };
  assert.equal(
    capabilityHub.resolveExecutionPlan(
      { deliveryKind: "file", corsBlockedDirect: true, whitelistedForExtension: true },
      extEnv,
    ).channel,
    "extension_direct",
  );
  assert.equal(
    capabilityHub.resolveExecutionPlan(
      { deliveryKind: "file", hasTbvideo: true, whitelistedForExtension: true },
      extEnv,
    ).channel,
    "extension_direct",
  );
  assert.equal(
    capabilityHub.resolveExecutionPlan(
      { deliveryKind: "file", whitelistedForExtension: true },
      { ...extEnv, swMultiRangeAvailable: false },
    ).channel,
    "extension_direct",
  );
  assert.equal(
    capabilityHub.resolveExecutionPlan(
      { deliveryKind: "file", corsBlockedDirect: true, whitelistedForExtension: false },
      extEnv,
    ).channel,
    "browser_direct",
    "unwhitelisted CORS-blocked domain must NEVER delegate to extension",
  );
  assert.equal(
    capabilityHub.resolveExecutionPlan(
      { deliveryKind: "file", whitelistedForExtension: false },
      { ...extEnv, swMultiRangeAvailable: false },
    ).channel,
    "browser_direct",
    "unwhitelisted domain must NEVER delegate to extension on SW failure",
  );

  // 3. [P1-4] inspectDirectFileExtensionTraits + buildDirectFileRoutesWithTbvideo
  const toutiaoTraits = mediaKernel.inspectDirectFileExtensionTraits({
    routes: ["https://v3-default.toutiaovod.com/abc123/video/tos/cn/stream"],
    context: { apiOrigin: PROD_API_ORIGIN },
  });
  assert.equal(toutiaoTraits.corsBlockedDirect, true);
  assert.equal(toutiaoTraits.whitelistedForExtension, true);
  assert.equal(toutiaoTraits.wantsProactiveExtensionDirect, true);

  const tbItem = {
    type: "video",
    tbvideo: {
      platform: "pipigx",
      pid: "1",
      vid: "2",
      sources: { s1: "https://tbvideo.ixiaochuan.cn/clip-candidate.mp4" },
    },
  };
  const tbRoutes = mediaKernel.buildDirectFileRoutesWithTbvideo(
    ["https://media.ippzone.com/clip-primary.mp4"],
    tbItem,
    "s1",
  );
  assert.deepEqual(tbRoutes, [
    "https://media.ippzone.com/clip-primary.mp4",
    "https://tbvideo.ixiaochuan.cn/clip-candidate.mp4",
  ]);
  const tbTraits = mediaKernel.inspectDirectFileExtensionTraits({
    routes: tbRoutes,
    item: tbItem,
    context: { apiOrigin: PROD_API_ORIGIN },
  });
  assert.equal(tbTraits.hasTbvideo, true);
  assert.equal(tbTraits.wantsProactiveExtensionDirect, true);
  assert.equal(tbTraits.whitelistedRoutes.length, 2);

  // 4. [P1-5] Placeholder part title detection, ugc_season single-P title resolution, and _P<n> idempotent dedup
  for (const ph of ["P1", "p01", "P12", "第1集", "第 2 话", "3期", "序列 01", "序列02", ""]) {
    assert.equal(mediaKernel.isPlaceholderPartTitle(ph), true, `expected placeholder: ${ph}`);
  }
  for (const real of ["P1 开场介绍", "真实教程标题", "Episode 1 Overview", "第1集：架构拆解"]) {
    assert.equal(mediaKernel.isPlaceholderPartTitle(real), false, `expected real title: ${real}`);
  }
  assert.equal(
    mediaKernel.resolvePreferredMediaTitle({
      isSingleItem: false,
      itemCount: 1,
      workTitle: "【合集】Go 并发原理全解析",
      itemTitle: "P1",
    }),
    "【合集】Go 并发原理全解析",
  );
  assert.equal(
    mediaKernel.resolvePreferredMediaTitle({
      isSingleItem: false,
      itemCount: 5,
      workTitle: "【合集】Go 并发原理全解析",
      itemTitle: "P1",
    }),
    "【合集】Go 并发原理全解析",
  );
  assert.equal(
    mediaKernel.resolvePreferredMediaTitle({
      isSingleItem: false,
      itemCount: 5,
      workTitle: "【合集】Go 并发原理全解析",
      itemTitle: "第二讲：Channel 源码",
    }),
    "第二讲：Channel 源码",
  );
  assert.equal(
    videoFilenameMod.buildMediaFilename({ title: "P1", index: 1, total: 2, fallback: "bili_1", extension: "mp4" }),
    "P1.mp4",
    "must never produce P1_P1.mp4",
  );
  assert.equal(
    videoFilenameMod.buildMediaFilename({ title: "合集视频_P1", index: 1, total: 3, fallback: "bili_2", extension: "mp4" }),
    "合集视频_P1.mp4",
    "must deduplicate trailing _P1 idempotently",
  );
  assert.equal(
    videoFilenameMod.buildMediaFilename({ title: "我的MVP1", index: 1, total: 3, fallback: "bili_3", extension: "mp4" }),
    "我的MVP1_P1.mp4",
    "must not strip non-boundary P1 suffix inside word",
  );
});

test("Architecture Boundary Gate: static import direction & planning host-purity negative checks", () => {
  const withTempFrontend = (files, fn) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dokitool-arch-gate-"));
    try {
      const writeRel = (rel, content) => {
        const abs = path.join(tmpRoot, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
      };
      writeRel("src/style.css", "@media (forced-colors: active) { .btn { border: 1px solid ButtonText; } }\n");
      writeRel("src/assets/design-system.css", "@media (forced-colors: active) { .ux-btn-primary { border: 1px solid ButtonText; } }\n");
      for (const [rel, content] of Object.entries(files)) {
        writeRel(rel, content);
      }
      fn(tmpRoot);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  };

  // 1) Clean fixture (including commented-out forbidden import) must pass cleanly
  withTempFrontend(
    {
      "src/extension/planning/cleanPlan.ts":
        "// import { x } from \"../opfsStreamTransfer\";\nexport const ok = 1;\n",
      "src/extension/bg/cleanBg.ts":
        "// import { buildEnqueueItemsForMedia } from \"../extensionDownload\";\nimport { ok } from \"../planning/cleanPlan\";\nexport const v = ok;\n",
    },
    (tmpRoot) => {
      const res = runArchitectureBoundaryCheck({ frontendRoot: tmpRoot, legacyRatchets: {} });
      assert.equal(res.passed, true, `unexpected violations: ${res.violations.join("\n")}`);
      assert.equal(res.importDirectionFilesChecked, 2);
    },
  );

  // 2) bg/** -> ../extensionDownload (static & dynamic) must fail
  withTempFrontend(
    {
      "src/extension/bg/badStatic.ts":
        "import { buildEnqueueItemsForMedia } from \"../extensionDownload\";\nexport const fn = buildEnqueueItemsForMedia;\n",
      "src/extension/bg/badDynamic.ts":
        "export async function load() { return import(\"../extensionDownload\"); }\n",
    },
    (tmpRoot) => {
      const res = runArchitectureBoundaryCheck({ frontendRoot: tmpRoot, legacyRatchets: {} });
      assert.equal(res.passed, false);
      assert.ok(res.violations.some((v) => v.includes("[import-direction]") && v.includes("badStatic.ts")));
      assert.ok(res.violations.some((v) => v.includes("[import-direction]") && v.includes("badDynamic.ts")));
    },
  );

  // 3) planning/** -> opfsStreamTransfer / jszip / bg/** / host side-effect globals must fail
  withTempFrontend(
    {
      "src/extension/planning/badOpfs.ts":
        "import { whitelistedFetch } from \"../opfsStreamTransfer\";\nexport const f = whitelistedFetch;\n",
      "src/extension/planning/badZip.ts":
        "import JSZip from \"jszip\";\nexport const z = JSZip;\n",
      "src/extension/planning/badBg.ts":
        "export { createSpecRefresher } from \"../bg/specRefresher\";\n",
      "src/extension/planning/badHost.ts":
        "export function peek() { return [chrome.runtime, navigator.storage, navigator.locks]; }\n",
    },
    (tmpRoot) => {
      const res = runArchitectureBoundaryCheck({ frontendRoot: tmpRoot, legacyRatchets: {} });
      assert.equal(res.passed, false);
      assert.ok(res.violations.some((v) => v.includes("[import-direction]") && v.includes("badOpfs.ts")));
      assert.ok(res.violations.some((v) => v.includes("[import-direction]") && v.includes("badZip.ts")));
      assert.ok(res.violations.some((v) => v.includes("[import-direction]") && v.includes("badBg.ts")));
      assert.ok(res.violations.some((v) => v.includes("[planning-host-side-effect]") && v.includes("chrome-api")));
      assert.ok(res.violations.some((v) => v.includes("[planning-host-side-effect]") && v.includes("navigator-storage")));
      assert.ok(res.violations.some((v) => v.includes("[planning-host-side-effect]") && v.includes("navigator-locks")));
    },
  );

  // 4) Pure SFC view models (monitorViewModel.ts, sidePanelResultModel.ts) must reject .vue/vue/side-effect imports and browser globals
  withTempFrontend(
    {
      "src/monitor/monitorViewModel.ts":
        "import { computed } from \"vue\";\nimport MonitorApp from \"./MonitorApp.vue\";\nexport const bad = () => [computed, MonitorApp, window.location, document.body, fetch(\"/api\"), localStorage.getItem(\"k\")];\n",
      "src/extension/sidePanelResultModel.ts":
        "import SidePanelResult from \"./components/SidePanelResult.vue\";\nimport { buildEnqueueItemsForMedia } from \"./extensionDownload\";\nimport { ensureOffscreen } from \"./offscreen\";\nexport const bad = () => [SidePanelResult, buildEnqueueItemsForMedia, ensureOffscreen, chrome.runtime, navigator.storage];\n",
    },
    (tmpRoot) => {
      const res = runArchitectureBoundaryCheck({ frontendRoot: tmpRoot, legacyRatchets: {} });
      assert.equal(res.passed, false);
      assert.ok(res.violations.some((v) => v.includes("[view-model-import-direction]") && v.includes("monitorViewModel.ts") && v.includes("\"vue\"")));
      assert.ok(res.violations.some((v) => v.includes("[view-model-import-direction]") && v.includes("MonitorApp.vue")));
      assert.ok(res.violations.some((v) => v.includes("[view-model-import-direction]") && v.includes("SidePanelResult.vue")));
      assert.ok(res.violations.some((v) => v.includes("[view-model-import-direction]") && v.includes("extensionDownload")));
      assert.ok(res.violations.some((v) => v.includes("[view-model-import-direction]") && v.includes("offscreen")));
      assert.ok(res.violations.some((v) => v.includes("[view-model-host-side-effect]") && v.includes("window-global")));
      assert.ok(res.violations.some((v) => v.includes("[view-model-host-side-effect]") && v.includes("document-global")));
      assert.ok(res.violations.some((v) => v.includes("[view-model-host-side-effect]") && v.includes("fetch-call")));
      assert.ok(res.violations.some((v) => v.includes("[view-model-host-side-effect]") && v.includes("web-storage")));
      assert.ok(res.violations.some((v) => v.includes("[view-model-host-side-effect]") && v.includes("chrome-api")));
      assert.ok(res.violations.some((v) => v.includes("[view-model-host-side-effect]") && v.includes("navigator-storage")));
    },
  );
});
