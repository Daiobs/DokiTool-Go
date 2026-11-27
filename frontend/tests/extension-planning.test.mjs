import test, { before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as variantSelection from "../src/extension/planning/variantSelection.ts";
import * as enqueuePlanBuilder from "../src/extension/planning/enqueuePlanBuilder.ts";
import * as extensionDownloadFacade from "../src/extension/extensionDownload.ts";
import { collectTransitiveImportGraph } from "./helpers/staticImportGraph.mjs";

const FIXED_NOW = Date.parse("2026-11-25T12:00:00.000Z");
const FUTURE_EXP = "2026-11-25T14:00:00.000Z";
const SOONER_EXP = "2026-11-25T13:00:00.000Z";
const PAST_EXP = "2026-11-25T11:00:00.000Z";
const API_ORIGIN = "https://snap.dokitool.com";

before(() => {
  // Verify transitive dependency graph of planning/* never drags in offscreen/DOM/JSZip modules.
  const planningInputs = new Set([
    ...collectTransitiveImportGraph(
      fileURLToPath(new URL("../src/extension/planning/variantSelection.ts", import.meta.url)),
    ),
    ...collectTransitiveImportGraph(
      fileURLToPath(new URL("../src/extension/planning/enqueuePlanBuilder.ts", import.meta.url)),
    ),
  ]);
  for (const forbidden of [
    "jszip",
    "extensionDownload.ts",
    "opfsStreamTransfer.ts",
    "dashMuxDownload.ts",
    "youtubeExtensionBridge.ts",
    "offscreen.ts",
  ]) {
    for (const inp of planningInputs) {
      assert.equal(
        inp.includes(forbidden),
        false,
        `planning bundle must not depend on ${forbidden} (found ${inp})`,
      );
    }
  }
});

function makeSource(url, extra = {}) {
  return {
    id: extra.id || "src-1",
    url,
    delivery_mode: "direct",
    expires_at: extra.expires_at ?? FUTURE_EXP,
    ...(extra.size_bytes !== undefined ? { size_bytes: extra.size_bytes } : {}),
  };
}

test("planning: single video quality selection (best / 1080p / audio) & facade deep equality", () => {
  const media = {
    schema_version: "1.0",
    platform: "douyin",
    content_id: "7400001",
    title: "Single Demo Video",
    source_url: "https://www.douyin.com/video/7400001",
    items: [
      {
        id: "item-1",
        type: "video",
        title: "Single Demo Video",
        default: { variant_id: "v-1080" },
        variants: [
          {
            id: "v-4k",
            state: "ready",
            label: "2160p",
            metadata: {
              width: 3840,
              height: 2160,
              has_audio: true,
              video_codec: "avc1",
              extension: "mp4",
              mime_type: "video/mp4",
            },
            delivery: {
              kind: "file",
              sources: [makeSource("https://v26-web.douyinvod.com/demo-4k.mp4", { size_bytes: 20_000_000 })],
            },
          },
          {
            id: "v-1080",
            state: "ready",
            label: "1080p",
            metadata: {
              width: 1920,
              height: 1080,
              has_audio: true,
              video_codec: "avc1",
              extension: "mp4",
              mime_type: "video/mp4",
            },
            delivery: {
              kind: "file",
              sources: [makeSource("https://v26-web.douyinvod.com/demo-1080.mp4", { size_bytes: 8_000_000 })],
            },
          },
        ],
      },
    ],
    attachments: [
      {
        id: "bgm-1",
        role: "background_audio",
        title: "Original Sound",
        resource: {
          id: "aud-1",
          role: "audio",
          metadata: { extension: "m4a", mime_type: "audio/mp4", audio_bitrate_bps: 192000 },
          delivery: {
            kind: "file",
            sources: [makeSource("https://v26-web.douyinvod.com/bgm.m4a", { size_bytes: 1_500_000 })],
          },
        },
      },
    ],
  };

  for (const qualityPreference of ["best", "1080p", "audio"]) {
    const opts = { apiOrigin: API_ORIGIN, qualityPreference, now: FIXED_NOW };
    const direct = enqueuePlanBuilder.buildEnqueueItemsForMedia(media, opts);
    const viaFacade = extensionDownloadFacade.buildEnqueueItemsForMedia(media, opts);
    assert.deepEqual(direct, viaFacade, `facade parity failed for ${qualityPreference}`);
    assert.equal(direct.length, 1);
    assert.equal(direct[0].workFingerprint, "douyin:7400001");
    assert.equal(direct[0].spec.refreshContext?.expiresAtMs, Date.parse(FUTURE_EXP));
  }

  const bestRes = enqueuePlanBuilder.buildEnqueueItemsForMedia(media, {
    apiOrigin: API_ORIGIN,
    qualityPreference: "best",
    now: FIXED_NOW,
  });
  assert.equal(bestRes[0].spec.routes[0], "https://v26-web.douyinvod.com/demo-4k.mp4");

  const p1080Res = enqueuePlanBuilder.buildEnqueueItemsForMedia(media, {
    apiOrigin: API_ORIGIN,
    qualityPreference: "1080p",
    now: FIXED_NOW,
  });
  assert.equal(p1080Res[0].spec.routes[0], "https://v26-web.douyinvod.com/demo-1080.mp4");

  const audioRes = enqueuePlanBuilder.buildEnqueueItemsForMedia(media, {
    apiOrigin: API_ORIGIN,
    qualityPreference: "audio",
    now: FIXED_NOW,
  });
  assert.equal(audioRes[0].spec.routes[0], "https://v26-web.douyinvod.com/bgm.m4a");
  assert.equal(audioRes[0].spec.refreshContext?.attachmentId, "bgm-1");
});

test("planning: multi-P Bilibili DASH mux, part-scoped audio, and subfolder indexing", () => {
  const media = {
    schema_version: "1.0",
    platform: "bilibili",
    content_id: "BV1xx411c7mD",
    title: "MultiPart Series",
    source_url: "https://www.bilibili.com/video/BV1xx411c7mD",
    items: [
      {
        id: "p1",
        index: 1,
        type: "video",
        title: "P1",
        resolve_url: "/api/resolve?platform=bilibili&p=1",
        default: { variant_id: "dash-1080-p1" },
        variants: [
          {
            id: "dash-1080-p1",
            state: "ready",
            label: "1080P AVC",
            metadata: { width: 1920, height: 1080, video_codec: "avc1", has_audio: true },
            delivery: {
              kind: "mux",
              output: { container: "mp4", mime_type: "video/mp4" },
              resources: [
                {
                  id: "v1",
                  role: "video",
                  metadata: { video_codec: "avc1" },
                  delivery: {
                    kind: "file",
                    sources: [makeSource("https://upos-sz-mirrorcos.bilivideo.com/p1-v.m4s", { size_bytes: 10_000_000, expires_at: FUTURE_EXP })],
                  },
                },
                {
                  id: "a1",
                  role: "audio",
                  metadata: { audio_codec: "mp4a.40.2", extension: "m4a", mime_type: "audio/mp4" },
                  delivery: {
                    kind: "file",
                    sources: [makeSource("https://upos-sz-mirrorcos.bilivideo.com/p1-a.m4s", { size_bytes: 2_000_000, expires_at: SOONER_EXP })],
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: "p2",
        index: 2,
        type: "video",
        title: "Episode Two",
        resolve_url: "/api/resolve?platform=bilibili&p=2",
        default: { variant_id: "dash-1080-p2" },
        variants: [
          {
            id: "dash-1080-p2",
            state: "ready",
            label: "1080P AVC",
            metadata: { width: 1920, height: 1080, video_codec: "avc1", has_audio: true },
            delivery: {
              kind: "mux",
              output: { container: "mp4", mime_type: "video/mp4" },
              resources: [
                {
                  id: "v2",
                  role: "video",
                  metadata: { video_codec: "avc1" },
                  delivery: {
                    kind: "file",
                    sources: [makeSource("https://upos-sz-mirrorcos.bilivideo.com/p2-v.m4s", { size_bytes: 12_000_000 })],
                  },
                },
                {
                  id: "a2",
                  role: "audio",
                  metadata: { audio_codec: "mp4a.40.2", extension: "m4a", mime_type: "audio/mp4" },
                  delivery: {
                    kind: "file",
                    sources: [makeSource("https://upos-sz-mirrorcos.bilivideo.com/p2-a.m4s", { size_bytes: 2_500_000 })],
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
        id: "bilibili-audio-p1",
        role: "background_audio",
        title: "P1 Audio",
        resource: {
          id: "ba1",
          role: "audio",
          metadata: { extension: "m4a", mime_type: "audio/mp4", audio_bitrate_bps: 128000 },
          delivery: {
            kind: "file",
            sources: [makeSource("https://upos-sz-mirrorcos.bilivideo.com/p1-a.m4s", { size_bytes: 2_000_000 })],
          },
        },
      },
    ],
  };

  const dashItems = enqueuePlanBuilder.buildEnqueueItemsForMedia(media, {
    apiOrigin: API_ORIGIN,
    subfolderPrefix: "Bili",
    now: FIXED_NOW,
  });
  assert.equal(dashItems.length, 2);
  assert.equal(dashItems[0].spec.kind, "dash_mux");
  assert.equal(dashItems[0].spec.sizeBytes, 12_000_000);
  assert.equal(dashItems[0].spec.refreshContext?.expiresAtMs, Date.parse(SOONER_EXP));
  assert.equal(dashItems[0].spec.filename, "Bili/MultiPart Series/001.mp4");
  assert.equal(dashItems[1].spec.filename, "Bili/MultiPart Series/002_Episode Two.mp4");
  assert.equal(dashItems[1].spec.refreshContext?.resolveUrl, "/api/resolve?platform=bilibili&p=2");

  // Audio preference for p2 must NOT borrow bilibili-audio-p1; it must use p2's own mux audio leaf.
  const p2Audio = enqueuePlanBuilder.buildEnqueueItemsForMedia(media, {
    apiOrigin: API_ORIGIN,
    itemIds: ["p2"],
    qualityPreference: "audio",
    now: FIXED_NOW,
  });
  assert.equal(p2Audio[0].spec.routes[0], "https://upos-sz-mirrorcos.bilivideo.com/p2-a.m4s");
  assert.equal(p2Audio[0].spec.refreshContext?.attachmentId, "mux-audio-p2");
});

test("planning: Live Photo modes (both / video / image) preserve roles & refreshContext", () => {
  const liveMedia = {
    schema_version: "1.0",
    platform: "xiaohongshu",
    content_id: "xhs-live-1",
    title: "Live Note",
    source_url: "https://www.xiaohongshu.com/explore/xhs-live-1",
    items: [
      {
        id: "lp-1",
        type: "live_photo",
        default: { variant_id: "pair-1" },
        variants: [
          {
            id: "pair-1",
            state: "ready",
            label: "实况",
            delivery: {
              kind: "pair",
              resources: [
                {
                  id: "r-motion",
                  role: "motion",
                  metadata: { extension: "mp4", mime_type: "video/mp4" },
                  delivery: {
                    kind: "file",
                    sources: [makeSource("https://sns-video-bd.xhscdn.com/live.mp4", { size_bytes: 3_000_000 })],
                  },
                },
                {
                  id: "r-image",
                  role: "image",
                  metadata: { extension: "jpg", mime_type: "image/jpeg" },
                  delivery: {
                    kind: "file",
                    sources: [makeSource("https://sns-webpic-qc.xhscdn.com/cover.jpg", { size_bytes: 500_000 })],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const both = enqueuePlanBuilder.buildEnqueueItemsForMedia(liveMedia, {
    apiOrigin: API_ORIGIN,
    livePhotoMode: "both",
    now: FIXED_NOW,
  });
  assert.equal(both.length, 2);
  assert.equal(both[0].spec.refreshContext?.resourceRole, "motion");
  assert.equal(both[1].spec.refreshContext?.resourceRole, "image");
  assert.equal(both[0].spec.filename, "Live Note/001_motion.mp4");
  assert.equal(both[1].spec.filename, "Live Note/001_cover.jpg");

  const videoOnly = enqueuePlanBuilder.buildEnqueueItemsForMedia(liveMedia, {
    apiOrigin: API_ORIGIN,
    livePhotoMode: "video",
    now: FIXED_NOW,
  });
  assert.equal(videoOnly.length, 1);
  assert.equal(videoOnly[0].spec.filename, "Live Note.mp4");
  assert.equal(videoOnly[0].spec.refreshContext?.resourceRole, "motion");

  const imageOnly = enqueuePlanBuilder.buildEnqueueItemsForMedia(liveMedia, {
    apiOrigin: API_ORIGIN,
    livePhotoMode: "image",
    now: FIXED_NOW,
  });
  assert.equal(imageOnly.length, 1);
  assert.equal(imageOnly[0].spec.filename, "Live Note.jpg");
  assert.equal(imageOnly[0].spec.refreshContext?.resourceRole, "image");
});

test("planning: YouTube adaptive mux pair selection & earliest expiry alignment", () => {
  const ytMedia = {
    schema_version: "1.0",
    platform: "youtube",
    content_id: "dQw4w9WgXcQ",
    title: "YT 4K Demo",
    source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    items: [
      {
        id: "yt-1",
        type: "video",
        default: { variant_id: "yt-2160" },
        variants: [
          {
            id: "yt-2160",
            state: "ready",
            label: "2160p",
            metadata: {
              width: 3840,
              height: 2160,
              has_audio: false,
              video_codec: "avc1.640033",
              extension: "mp4",
              mime_type: "video/mp4",
            },
            delivery: {
              kind: "file",
              sources: [
                makeSource("https://rr1---sn-demo.googlevideo.com/videoplayback?itag=137", {
                  size_bytes: 50_000_000,
                  expires_at: FUTURE_EXP,
                }),
              ],
            },
          },
          {
            id: "yt-audio-m4a",
            state: "ready",
            label: "M4A 128k",
            metadata: {
              has_audio: true,
              audio_codec: "mp4a.40.2",
              audio_bitrate_bps: 128000,
              extension: "m4a",
              mime_type: "audio/mp4",
            },
            delivery: {
              kind: "file",
              sources: [
                makeSource("https://rr1---sn-demo.googlevideo.com/videoplayback?itag=140", {
                  size_bytes: 4_000_000,
                  expires_at: SOONER_EXP,
                }),
              ],
            },
          },
        ],
      },
    ],
  };

  const items = enqueuePlanBuilder.buildEnqueueItemsForMedia(ytMedia, {
    apiOrigin: API_ORIGIN,
    qualityPreference: "best",
    now: FIXED_NOW,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].spec.kind, "youtube_mux");
  assert.equal(items[0].spec.sizeBytes, 54_000_000);
  assert.equal(items[0].spec.youtubeMux?.outputContainer, "mp4");
  assert.equal(items[0].spec.refreshContext?.expiresAtMs, Date.parse(SOONER_EXP));
});

test("planning: gallery ZIP packing, 500 MB MAX_BATCH_ZIP_BYTES guard, and unwhitelisted ZIP downgrade", () => {
  const makeGallery = (sizePerImg, host) => ({
    schema_version: "1.0",
    platform: "xiaohongshu",
    content_id: "gal-1",
    title: "Photo Album",
    source_url: "https://www.xiaohongshu.com/explore/gal-1",
    items: [1, 2].map((n) => ({
      id: `img-${n}`,
      index: n,
      type: "image",
      default: { variant_id: `v-${n}` },
      variants: [
        {
          id: `v-${n}`,
          state: "ready",
          label: "原图",
          metadata: { extension: "jpg", mime_type: "image/jpeg" },
          delivery: {
            kind: "file",
            sources: [makeSource(`https://${host}/p${n}.jpg`, { size_bytes: sizePerImg })],
          },
        },
      ],
    })),
  });

  // 1) Whitelisted within limit -> single batch_zip spec
  const zipItems = enqueuePlanBuilder.buildEnqueueItemsForMedia(
    makeGallery(1024 * 1024, "sns-webpic-qc.xhscdn.com"),
    { apiOrigin: API_ORIGIN, batchSaveMode: "zip", now: FIXED_NOW },
  );
  assert.equal(zipItems.length, 1);
  assert.equal(zipItems[0].spec.kind, "batch_zip");
  assert.equal(zipItems[0].spec.filename, "Photo Album.zip");
  assert.equal(zipItems[0].spec.zipEntries?.length, 2);

  // 2) Exceeds MAX_BATCH_ZIP_BYTES -> throws ARCHIVE_LIMIT_ERROR
  assert.throws(
    () =>
      enqueuePlanBuilder.buildEnqueueItemsForMedia(
        makeGallery(enqueuePlanBuilder.MAX_BATCH_ZIP_BYTES / 2 + 1, "sns-webpic-qc.xhscdn.com"),
        { apiOrigin: API_ORIGIN, batchSaveMode: "zip", now: FIXED_NOW },
      ),
    (err) => err instanceof Error && err.message === enqueuePlanBuilder.ARCHIVE_LIMIT_ERROR,
  );

  // 3) Unwhitelisted gallery host cannot be ZIP-packed in offscreen -> smoothly degrades to subfolder items
  const degraded = enqueuePlanBuilder.buildEnqueueItemsForMedia(
    makeGallery(1024 * 1024, "cdn.unwhitelisted-example.org"),
    { apiOrigin: API_ORIGIN, batchSaveMode: "zip", now: FIXED_NOW },
  );
  assert.equal(degraded.length, 2);
  assert.equal(degraded[0].spec.kind, "direct_file");
  assert.equal(degraded[0].spec.filename, "Photo Album/001.jpg");
});

test("planning: Tier-2 refresh_url fallback, expired stream filtering, and unwhitelisted variant deprioritization", () => {
  // 1) Tier-2 media without item.resolve_url falls back to media.refresh_url
  const tier2Media = {
    schema_version: "1.0",
    platform: "vimeo",
    content_id: "987654",
    title: "Vimeo Clip",
    refresh_url: "/api/parse?schema_version=1.0&url=https%3A%2F%2Fvimeo.com%2F987654",
    items: [
      {
        id: "t2-1",
        type: "video",
        default: { variant_id: "v-1" },
        variants: [
          {
            id: "v-expired",
            state: "ready",
            label: "2160p",
            metadata: { width: 3840, height: 2160, has_audio: true, extension: "mp4", mime_type: "video/mp4" },
            delivery: {
              kind: "file",
              sources: [makeSource("https://vod-progressive.akamaized.net/expired.mp4", { expires_at: PAST_EXP })],
            },
          },
          {
            id: "v-unwhitelisted-hls",
            state: "ready",
            label: "1440p HLS",
            metadata: { width: 2560, height: 1440, has_audio: true, extension: "mp4" },
            delivery: {
              kind: "hls",
              scope: "single",
              sources: [makeSource("https://hls.unwhitelisted-example.org/playlist.m3u8", { expires_at: FUTURE_EXP })],
            },
          },
          {
            id: "v-1",
            state: "ready",
            label: "1080p",
            metadata: { width: 1920, height: 1080, has_audio: true, extension: "mp4", mime_type: "video/mp4" },
            delivery: {
              kind: "file",
              sources: [makeSource("https://vod-progressive.akamaized.net/ok.mp4", { expires_at: FUTURE_EXP })],
            },
          },
        ],
      },
    ],
  };

  const plan = variantSelection.selectVariantByPreference(
    tier2Media.items[0],
    undefined,
    "best",
    API_ORIGIN,
    FIXED_NOW,
  );
  // Expired 4K is filtered out; unwhitelisted HLS is not directly downloadable; safe native direct file 1080p wins.
  assert.equal(plan?.variant.id, "v-1");

  const items = enqueuePlanBuilder.buildEnqueueItemsForMedia(tier2Media, {
    apiOrigin: API_ORIGIN,
    now: FIXED_NOW,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].spec.refreshContext?.refreshUrl, tier2Media.refresh_url);
  assert.equal(items[0].spec.refreshContext?.parseUrl, "https://vimeo.com/987654");
  assert.equal(items[0].spec.refreshContext?.resolveUrl, undefined);
  assert.equal(items[0].workFingerprint, "vimeo:987654");
});
