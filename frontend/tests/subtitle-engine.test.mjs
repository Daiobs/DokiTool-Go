import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createRenderer, createSSRApp, h, markRaw, nextTick } from "vue";
import { renderToString } from "vue/server-renderer";
import {
  YOUTUBE_HELPER_REQUEST_EVENT,
  YOUTUBE_HELPER_RESPONSE_EVENT,
  sanitizePlayerApiResponse,
} from "../src/utils/youtubeHelperCore.js";
import { loadSfc } from "./helpers/loadSfc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");

let vite;
let subtitleEngine;
let coreMediaBarrel;
let parseHelpers;
let ResultSubtitlePanel;
let ResultDetailsSidebar;

test.before(async () => {
  vite = await createServer({
    root: frontendRoot,
    configFile: false,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  subtitleEngine = await vite.ssrLoadModule("/src/core/media/subtitleEngine.ts");
  coreMediaBarrel = await vite.ssrLoadModule("/src/core/media/index.ts");
  parseHelpers = await vite.ssrLoadModule("/src/utils/parseHelpers.ts");
  ResultSubtitlePanel = await loadSfc(
    new URL("../src/components/result/ResultSubtitlePanel.vue", import.meta.url),
    {
      modules: {
        "../AppIcon.vue": { default: { render: (_, { attrs }) => h("i", attrs) } },
      },
    },
  );
  ResultDetailsSidebar = await loadSfc(
    new URL("../src/components/result/ResultDetailsSidebar.vue", import.meta.url),
    {
      modules: {
        "../AppIcon.vue": { default: { render: (_, { attrs }) => h("i", attrs) } },
        "../../services/apiConfig": { apiConfig: { baseUrl: "https://snap.dokitool.com" } },
      },
    },
  );
});

test.after(async () => {
  await vite?.close();
});

function makeSubtitleAttachment({
  id,
  language,
  title,
  trackKind,
  ext = "vtt",
  mime = "text/vtt",
  url,
  sources,
}) {
  return {
    id,
    role: "subtitle",
    language,
    title,
    ...(trackKind ? { track_kind: trackKind } : {}),
    resource: {
      id: `res-${id}`,
      role: "subtitle",
      metadata: {
        container: ext,
        extension: ext,
        mime_type: mime,
        evidence: "upstream",
      },
      delivery: {
        kind: "file",
        sources: sources ?? [{ id: `s-${id}`, url, access: "direct" }],
      },
    },
  };
}

test("core/media barrel exports subtitleEngine API surface cleanly", () => {
  assert.equal(coreMediaBarrel.MAX_SUBTITLE_TRACK_BYTES, 5 * 1024 * 1024);
  assert.equal(coreMediaBarrel.MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE, 512);
  assert.equal(subtitleEngine.MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE, 512);
  for (const fn of [
    "projectYouTubeCaptionsForFinalize",
    "listSubtitleTracks",
    "parseSubtitleCues",
    "formatCuesAsVtt",
    "formatCuesAsSrt",
    "mergeBilingualCues",
    "fetchSubtitleTrackText",
    "buildSubtitleFilename",
    "buildSubtitleDownloadResult",
  ]) {
    assert.equal(typeof coreMediaBarrel[fn], "function", `missing export ${fn}`);
  }
});

test("parseSubtitleCues supports VTT, SRT, SRV3, TTML, XML, JSON3 and enforces XML & NaN safety guards", () => {
  // 1. WebVTT with header, NOTE/STYLE, cue settings, inline tags & HTML entities
  const vttRaw = [
    "\ufeffWEBVTT",
    "",
    "NOTE ignored comment block",
    "",
    "STYLE",
    "::cue { color: white; }",
    "",
    "cue-1",
    "00:01.200 --> 00:03.500 align:start position:10%",
    "<c>Hello</c> &amp; &lt;world&gt; &#39;VTT&#39; &#x21; &#33;",
    "",
    "01:02:03.400 --> 01:02:05.000",
    "<i>Line 1</i>",
    "Line 2",
  ].join("\r\n");
  const vttCues = subtitleEngine.parseSubtitleCues(vttRaw, "vtt");
  assert.deepEqual(vttCues, [
    { startMs: 1200, endMs: 3500, text: "Hello & <world> 'VTT' ! !" },
    { startMs: 3723400, endMs: 3725000, text: "Line 1\nLine 2" },
  ]);

  // 2. SRT with comma timestamps
  const srtRaw = "1\n00:00:01,050 --> 00:00:02,800\nFirst &quot;SRT&quot; cue\n";
  assert.deepEqual(subtitleEngine.parseSubtitleCues(srtRaw, "srt"), [
    { startMs: 1050, endMs: 2800, text: 'First "SRT" cue' },
  ]);

  // 3. YouTube SRV3 XML (<p t d>) including double-escaped entities & NaN/Infinity guards
  const srv3Raw = `<?xml version="1.0" encoding="utf-8"?>
<timedtext format="3"><body>
  <p t="1000" d="2500"><s>Hello</s> &amp;#39;SRV3&amp;#39;</p>
  <p t="NaN" d="1000">Should be skipped</p>
  <p t="Infinity" d="1000">Should also be skipped</p>
  <p t="-500" d="1000">Negative skipped</p>
  <p t="4000" d="NaN">Clamped duration ok</p>
</body></timedtext>`;
  assert.deepEqual(subtitleEngine.parseSubtitleCues(srv3Raw, "srv3"), [
    { startMs: 1000, endMs: 3500, text: "Hello 'SRV3'" },
    { startMs: 4000, endMs: 4000, text: "Clamped duration ok" },
  ]);

  // 4. TTML (<p begin end|dur>) + <br/>
  const ttmlRaw = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
    <p begin="00:00:01.250" end="00:00:03.750">Line A<br/>Line B</p>
    <p begin="4.5s" dur="1500ms">Offset cue</p>
  </div></body></tt>`;
  assert.deepEqual(subtitleEngine.parseSubtitleCues(ttmlRaw, "ttml"), [
    { startMs: 1250, endMs: 3750, text: "Line A\nLine B" },
    { startMs: 4500, endMs: 6000, text: "Offset cue" },
  ]);

  // 5. Legacy YouTube XML (<text start dur>)
  const xmlRaw = `<transcript><text start="2.5" dur="1.25">Hello &lt;tag&gt;</text><text start="bad" dur="1">skip</text></transcript>`;
  assert.deepEqual(subtitleEngine.parseSubtitleCues(xmlRaw, "xml"), [
    { startMs: 2500, endMs: 3750, text: "Hello <tag>" },
  ]);

  // 6. YouTube JSON3
  const json3Raw = JSON.stringify({
    events: [
      { tStartMs: 500, dDurationMs: 1200, segs: [{ utf8: "Hello " }, { utf8: "JSON3" }] },
      { tStartMs: -1, dDurationMs: 500, segs: [{ utf8: "bad negative" }] },
      { tStartMs: 2000, dDurationMs: 800, segs: [{ utf8: "   \n  " }] },
    ],
  });
  assert.deepEqual(subtitleEngine.parseSubtitleCues(json3Raw, "json3"), [
    { startMs: 500, endMs: 1700, text: "Hello JSON3" },
  ]);

  // 7. Rejects XML DOCTYPE / ENTITY payloads
  assert.throws(
    () =>
      subtitleEngine.parseSubtitleCues(
        '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "https://example.invalid/xxe">]><transcript><text start="0" dur="1">&xxe;</text></transcript>',
        "xml",
      ),
    /DOCTYPE|ENTITY/i,
  );
  assert.throws(
    () =>
      subtitleEngine.parseSubtitleCues(
        '<!ENTITY lol "lol"><timedtext><p t="0" d="1000">hi</p></timedtext>',
        "srv3",
      ),
    /DOCTYPE|ENTITY/i,
  );
});

test("mergeBilingualCues aligns by overlap or <=1500ms tolerance, deduplicates identical text, and formats VTT/SRT", () => {
  const primary = [
    { startMs: 1000, endMs: 3000, text: "你好世界" },
    { startMs: 5000, endMs: 7000, text: "同一句" },
    { startMs: 10000, endMs: 11000, text: "轻微偏移" },
    { startMs: 20000, endMs: 21000, text: "无对应行" },
  ];
  const secondary = [
    { startMs: 900, endMs: 1300, text: "Small overlap" },
    { startMs: 1200, endMs: 3100, text: "Hello world" },
    { startMs: 5100, endMs: 6900, text: "同一句" },
    { startMs: 11800, endMs: 13000, text: "Within 800ms tolerance" },
    { startMs: 25000, endMs: 26000, text: "Too far away" },
  ];
  const merged = subtitleEngine.mergeBilingualCues(primary, secondary);
  assert.deepEqual(merged, [
    { startMs: 1000, endMs: 3000, text: "你好世界\nHello world" },
    { startMs: 5000, endMs: 7000, text: "同一句" },
    { startMs: 10000, endMs: 11000, text: "轻微偏移\nWithin 800ms tolerance" },
    { startMs: 20000, endMs: 21000, text: "无对应行" },
  ]);

  const vtt = subtitleEngine.formatCuesAsVtt(merged);
  assert.ok(vtt.startsWith("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n你好世界\nHello world\n\n"));
  const srt = subtitleEngine.formatCuesAsSrt(merged);
  assert.ok(srt.startsWith("1\n00:00:01,000 --> 00:00:03,000\n你好世界\nHello world\n\n2\n"));
});

test("listSubtitleTracks sorts manual > unknown > auto, vtt > srt > ttml > srv3, and skips unavailable/expired sources", () => {
  const media = {
    platform: "youtube",
    items: [],
    attachments: [
      {
        id: "bgm-1",
        role: "background_audio",
        title: "BGM",
        resource: {
          id: "res-bgm",
          role: "audio",
          delivery: { kind: "file", sources: [{ url: "https://cdn.example.test/bgm.m4a" }] },
        },
      },
      makeSubtitleAttachment({
        id: "sub-auto-vtt",
        language: "en",
        title: "English (auto)",
        trackKind: "auto",
        ext: "vtt",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr&fmt=vtt",
      }),
      makeSubtitleAttachment({
        id: "sub-unavail",
        language: "fr",
        title: "French",
        trackKind: "manual",
        ext: "vtt",
        sources: [
          {
            id: "s-unavail",
            url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=fr&fmt=vtt",
            availability: "unavailable",
          },
          {
            id: "s-expired",
            url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=fr&fmt=srt",
            expires_at: "2020-01-01T00:00:00Z",
          },
        ],
      }),
      makeSubtitleAttachment({
        id: "sub-manual-srv3",
        language: "en",
        title: "English SRV3",
        trackKind: "manual",
        ext: "srv3",
        mime: "application/xml",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&fmt=srv3",
      }),
      makeSubtitleAttachment({
        id: "sub-unknown-vtt",
        language: "ja",
        title: "Japanese",
        ext: "vtt",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=ja&fmt=vtt",
      }),
      makeSubtitleAttachment({
        id: "sub-manual-vtt",
        language: "zh-Hans",
        title: "中文（简体）",
        trackKind: "manual",
        ext: "vtt",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-Hans&fmt=vtt",
      }),
      makeSubtitleAttachment({
        id: "sub-manual-srt",
        language: "de",
        title: "Deutsch",
        trackKind: "manual",
        ext: "srt",
        mime: "application/x-subrip",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=de&fmt=srt",
      }),
    ],
  };

  const tracks = subtitleEngine.listSubtitleTracks(media);
  assert.deepEqual(
    tracks.map((t) => t.id),
    [
      "sub-manual-vtt",
      "sub-manual-srt",
      "sub-manual-srv3",
      "sub-unknown-vtt",
      "sub-auto-vtt",
    ],
  );
  assert.deepEqual(
    tracks.map((t) => t.trackKind),
    ["manual", "manual", "manual", "unknown", "auto"],
  );
});

test("fetchSubtitleTrackText enforces credentials:'omit', route fallback, and streaming > 5 MiB rejection even with absent/spoofed Content-Length", async () => {
  // 1. Verify credentials:'omit' + referrerPolicy:'no-referrer' + fallback routes
  const seenCalls = [];
  const fallbackFetch = async (url, init) => {
    seenCalls.push({ url, init });
    if (url.includes("primary-fail")) {
      return new Response("err", { status: 503 });
    }
    return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFallback ok\n", {
      status: 200,
      headers: { "content-type": "text/vtt" },
    });
  };
  const fetched = await subtitleEngine.fetchSubtitleTrackText(
    "https://cdn.example.test/primary-fail.vtt",
    {
      fetchImpl: fallbackFetch,
      routes: [
        "https://cdn.example.test/primary-fail.vtt",
        "https://cdn.example.test/backup-ok.vtt",
      ],
    },
  );
  assert.ok(fetched.includes("Fallback ok"));
  assert.equal(seenCalls.length, 2);
  for (const call of seenCalls) {
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.referrerPolicy, "no-referrer");
  }

  // 2. Streaming > 5 MiB rejection when Content-Length is ABSENT
  let absentCanceled = false;
  let pulledChunks = 0;
  const makeOversizeStreamResponse = (headers = {}) => {
    const chunk = new Uint8Array(1024 * 1024);
    pulledChunks = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (pulledChunks >= 10) {
          controller.close();
          return;
        }
        pulledChunks++;
        controller.enqueue(chunk);
      },
      cancel() {
        absentCanceled = true;
      },
    });
    return new Response(stream, { status: 200, headers });
  };

  await assert.rejects(
    () =>
      subtitleEngine.fetchSubtitleTrackText("https://cdn.example.test/big.vtt", {
        fetchImpl: async () => makeOversizeStreamResponse({}),
      }),
    (err) => err?.code === "SUBTITLE_TOO_LARGE",
  );
  assert.equal(absentCanceled, true, "oversize stream without Content-Length must cancel reader");
  assert.ok(pulledChunks < 10, "reader must cancel before consuming remaining stream chunks");

  // 3. Streaming > 5 MiB rejection when Content-Length is SPOOFED SMALL ("128")
  absentCanceled = false;
  await assert.rejects(
    () =>
      subtitleEngine.fetchSubtitleTrackText("https://cdn.example.test/spoofed.vtt", {
        fetchImpl: async () => makeOversizeStreamResponse({ "content-length": "128" }),
      }),
    (err) => err?.code === "SUBTITLE_TOO_LARGE",
  );
  assert.equal(absentCanceled, true, "oversize stream with spoofed Content-Length must cancel reader");
  assert.ok(pulledChunks < 10, "spoofed stream must cancel early once byte cap is crossed");

  // 4. buildSubtitleDownloadResult bilingual SRT output + sanitized filename
  const tracks = [
    {
      id: "zh",
      attachment: {},
      label: "中文",
      language: "zh-Hans",
      trackKind: "manual",
      format: "vtt",
      url: "https://www.youtube.com/api/timedtext?lang=zh-Hans&fmt=vtt",
      routes: ["https://www.youtube.com/api/timedtext?lang=zh-Hans&fmt=vtt"],
    },
    {
      id: "en",
      attachment: {},
      label: "English",
      language: "en",
      trackKind: "auto",
      format: "srv3",
      url: "https://www.youtube.com/api/timedtext?lang=en&fmt=srv3",
      routes: ["https://www.youtube.com/api/timedtext?lang=en&fmt=srv3"],
    },
  ];
  const dl = await subtitleEngine.buildSubtitleDownloadResult({
    primaryTrack: tracks[0],
    secondaryTrack: tracks[1],
    targetFormat: "srt",
    baseTitle: 'Demo: Video / "Title"?.mp4',
    fetchTrackText: async (track) =>
      track.id === "zh"
        ? "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n你好\n"
        : '<timedtext><p t="1000" d="1500">Hello</p></timedtext>',
  });
  assert.equal(dl.extension, "srt");
  assert.equal(dl.cueCount, 1);
  assert.equal(dl.filename, "Demo Video Title.mp4.zh-Hans_en.srt");
  assert.ok(dl.content.includes("00:00:01,000 --> 00:00:02,500\n你好\nHello"));
});

test("projectYouTubeCaptionsForFinalize & sanitizePlayerApiResponse strip translationLanguages and parseHelpers respects supports_captions", async () => {
  const bloatedCaptions = {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
          name: { simpleText: "English", trackingParams: "HUGE_IGNORED_BLOB" },
          vssId: ".en",
          languageCode: "en",
          kind: "",
          isTranslatable: true,
          rtl: false,
          extraNoise: "x".repeat(4096),
        },
        {
          baseUrl: "",
          languageCode: "bad",
        },
      ],
      audioTracks: [{ captionTrackIndices: [0] }],
      translationLanguages: Array.from({ length: 150 }, (_, idx) => ({
        languageCode: `lang-${idx}`,
        languageName: { simpleText: `Language ${idx}` },
      })),
    },
  };

  // 1. Direct projection strips translationLanguages & bloat
  const projected = subtitleEngine.projectYouTubeCaptionsForFinalize(bloatedCaptions);
  assert.ok(projected);
  assert.equal("translationLanguages" in projected.playerCaptionsTracklistRenderer, false);
  assert.equal("audioTracks" in projected.playerCaptionsTracklistRenderer, false);
  assert.equal(projected.playerCaptionsTracklistRenderer.captionTracks.length, 1);
  assert.deepEqual(projected.playerCaptionsTracklistRenderer.captionTracks[0], {
    baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
    name: { simpleText: "English" },
    vssId: ".en",
    languageCode: "en",
    isTranslatable: true,
  });

  // 2. youtubeHelperCore.sanitizePlayerApiResponse projects captions cleanly
  const sanitizedPlayer = sanitizePlayerApiResponse({
    playabilityStatus: { status: "OK" },
    streamingData: { formats: [], adaptiveFormats: [] },
    videoDetails: { title: "Caption Demo" },
    captions: bloatedCaptions,
  });
  assert.deepEqual(sanitizedPlayer.captions, projected);
  assert.ok(JSON.stringify(sanitizedPlayer.captions).length < 1024);

  // 3. parseHelpers.runYouTubeHelperParse passes projected captions when supports_captions !== false, and omits when false
  const runParseWithContext = async (supportsCaptions) => {
    parseHelpers.clearCachedYouTubeContext();
    const origWindow = globalThis.window;
    const origCustomEvent = globalThis.CustomEvent;
    const bus = new EventTarget();
    globalThis.window = bus;
    if (typeof globalThis.CustomEvent !== "function") {
      globalThis.CustomEvent = class extends Event {
        constructor(type, init = {}) {
          super(type);
          this.detail = init.detail;
        }
      };
    }
    const listener = (event) => {
      const req = JSON.parse(event.detail);
      if (req.action === "prefetch") {
        bus.dispatchEvent(
          new globalThis.CustomEvent(YOUTUBE_HELPER_RESPONSE_EVENT, {
            detail: JSON.stringify({
              requestId: req.requestId,
              ok: true,
              data: { visitorData: "", oembed: null },
            }),
          }),
        );
      } else if (req.action === "player") {
        bus.dispatchEvent(
          new globalThis.CustomEvent(YOUTUBE_HELPER_RESPONSE_EVENT, {
            detail: JSON.stringify({
              requestId: req.requestId,
              ok: true,
              data: {
                playabilityStatus: { status: "OK" },
                streamingData: { formats: [], adaptiveFormats: [] },
                videoDetails: { title: "Caption Demo" },
                captions: bloatedCaptions,
              },
            }),
          }),
        );
      }
    };
    bus.addEventListener(YOUTUBE_HELPER_REQUEST_EVENT, listener);

    let capturedFinalizeBody = null;
    try {
      await parseHelpers.runYouTubeHelperParse({
        videoId: "dQw4w9WgXcQ",
        locale: "zh-CN",
        signal: new AbortController().signal,
        isCurrent: () => true,
        pingExtension: async () => ({ connected: false, version: "", capabilities: [] }),
        pingHelper: async () => ({ installed: true, version: "1.3.2", supported: true }),
        requestStandardParse: async () => {
          throw new Error("should not fall back");
        },
        fetchJSON: async (url, _sig, init) => {
          if (url.includes("/api/youtube/context")) {
            return {
              schema_version: "1.0",
              code: "OK",
              data: {
                player_id: "p123",
                signature_timestamp: 20200,
                client: { name: "TVHTML5", version: "7.20250101.00.00" },
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
                ...(supportsCaptions !== undefined
                  ? { supports_captions: supportsCaptions }
                  : {}),
              },
            };
          }
          capturedFinalizeBody = JSON.parse(String(init?.body || "{}"));
          return {
            schema_version: "1.0",
            code: "OK",
            data: {
              platform: "youtube",
              content_id: "dQw4w9WgXcQ",
              title: "Caption Demo",
              items: [
                {
                  id: "v1",
                  type: "video",
                  state: "ready",
                  variants: [
                    {
                      id: "m1",
                      delivery: {
                        kind: "file",
                        sources: [{ id: "s1", url: "https://rr1---sn-a.googlevideo.com/videoplayback?itag=18" }],
                      },
                    },
                  ],
                  default: {
                    variant_id: "m1",
                    source_id: "s1",
                    url: "https://rr1---sn-a.googlevideo.com/videoplayback?itag=18",
                  },
                },
              ],
            },
          };
        },
        baseUrl: "https://snap.dokitool.com",
        onHelperReady: () => {},
        setResult: () => {},
        setError: (msg) => {
          throw new Error(`unexpected error: ${msg}`);
        },
      });
    } finally {
      bus.removeEventListener(YOUTUBE_HELPER_REQUEST_EVENT, listener);
      globalThis.window = origWindow;
      globalThis.CustomEvent = origCustomEvent;
      parseHelpers.clearCachedYouTubeContext();
    }
    return capturedFinalizeBody;
  };

  const bodySupported = await runParseWithContext(true);
  assert.deepEqual(bodySupported.captions, projected);
  assert.equal("translationLanguages" in bodySupported.captions.playerCaptionsTracklistRenderer, false);

  const bodyUnsupported = await runParseWithContext(false);
  assert.equal("captions" in bodyUnsupported, false);
});

test("ResultSubtitlePanel.vue & ResultDetailsSidebar.vue render manual/auto badges cleanly and isolate subtitles from Music tab", async () => {
  const sampleMedia = {
    platform: "youtube",
    content_id: "dQw4w9WgXcQ",
    title: "Bilingual Subtitle Demo",
    items: [
      {
        id: "yt-1",
        type: "video",
        state: "ready",
        variants: [
          {
            id: "v1",
            delivery: {
              kind: "file",
              sources: [{ id: "s1", url: "https://media.example.test/v.mp4" }],
            },
          },
        ],
        default: { variant_id: "v1", source_id: "s1", url: "https://media.example.test/v.mp4" },
      },
    ],
    attachments: [
      makeSubtitleAttachment({
        id: "sub-zh",
        language: "zh-Hans",
        title: "中文（简体）",
        trackKind: "manual",
        ext: "vtt",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-Hans&fmt=vtt",
      }),
      makeSubtitleAttachment({
        id: "sub-en-auto",
        language: "en",
        title: "English",
        trackKind: "auto",
        ext: "vtt",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr&fmt=vtt",
      }),
    ],
  };

  const tracks = subtitleEngine.listSubtitleTracks(sampleMedia);

  // 1. SSR zh-CN render shows 人工 & 自动 badges and bilingual controls
  const zhHtml = await renderToString(
    createSSRApp({
      render: () =>
        h(ResultSubtitlePanel, {
          tracks,
          baseTitle: sampleMedia.title,
          locale: "zh-CN",
        }),
    }),
  );
  assert.ok(zhHtml.includes('data-testid="result-subtitle-panel"'));
  assert.ok(zhHtml.includes('data-testid="subtitle-bilingual-box"'));
  assert.ok(zhHtml.includes('data-track-kind="manual"'));
  assert.ok(zhHtml.includes("人工"));
  assert.ok(zhHtml.includes('data-track-kind="auto"'));
  assert.ok(zhHtml.includes("自动"));

  // 2. SSR en render shows Manual & Auto badges
  const enHtml = await renderToString(
    createSSRApp({
      render: () =>
        h(ResultSubtitlePanel, {
          tracks,
          baseTitle: sampleMedia.title,
          locale: "en",
        }),
    }),
  );
  assert.ok(enHtml.includes("Manual"));
  assert.ok(enHtml.includes("Auto"));
  assert.ok(enHtml.includes("2 subtitle tracks"));

  // 3. ResultDetailsSidebar isolates subtitles into dedicated "字幕" tab without showing an empty "音乐" tab
  const sidebarHtml = await renderToString(
    createSSRApp({
      render: () =>
        h(ResultDetailsSidebar, {
          resultData: sampleMedia,
          locale: "zh-CN",
          currentItem: sampleMedia.items[0],
          activeVariant: sampleMedia.items[0].variants[0],
          attachments: sampleMedia.attachments,
          activeTab: "subtitles",
          formatNumber: String,
          formatDuration: String,
          safeImageUrl: () => "",
          displayVariantLabel: () => "1080p",
          formatOptionSize: () => "",
        }),
    }),
  );
  assert.ok(sidebarHtml.includes("字幕"), "Subtitles tab must appear");
  assert.equal(sidebarHtml.includes("音乐"), false, "Subtitle attachments must not leak into Music tab");
  assert.ok(sidebarHtml.includes('data-testid="result-subtitle-panel"'));

  // 4. Interactive mount verifies CORS/size error notice renders inside ResultSubtitlePanel
  const element = (type, text = "") =>
    markRaw({
      type,
      text,
      props: {},
      children: [],
      parent: null,
      options: [],
      addEventListener() {},
      removeEventListener() {},
    });
  const detach = (node) => {
    if (node?.parent) {
      node.parent.children = node.parent.children.filter((c) => c !== node);
      node.parent = null;
    }
  };
  const renderer = createRenderer({
    createElement: element,
    createText: (t) => element("#text", t),
    createComment: (t) => element("#comment", t),
    setText(node, t) {
      node.text = t;
    },
    setElementText(node, t) {
      node.text = t;
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
    },
  });
  const findAll = (node, pred) => [
    ...(pred(node) ? [node] : []),
    ...node.children.flatMap((c) => findAll(c, pred)),
  ];
  const textOf = (node) => [node.text, ...node.children.map(textOf)].join("");

  const root = element("root");
  const app = renderer.createApp({
    render: () =>
      h(ResultSubtitlePanel, {
        tracks,
        baseTitle: "Error Test",
        locale: "zh-CN",
        fetchImpl: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
  });
  app.mount(root);
  await nextTick();
  const primaryBtn = findAll(
    root,
    (n) => n.props?.["data-testid"] === "subtitle-primary-download",
  )[0];
  assert.ok(primaryBtn);
  await primaryBtn.props.onClick();
  await nextTick();
  const errNode = findAll(
    root,
    (n) => n.props?.["data-testid"] === "subtitle-error",
  )[0];
  assert.ok(errNode, "CORS/network failure should render error alert");
  assert.match(textOf(errNode), /CORS|跨域/);
  app.unmount();

  // Regression: VTT/SRT cue blocks separated by whitespace-only blank lines (spaces/tabs) still split cleanly
  const spacedVtt =
    "WEBVTT\n   \n00:00:01.000 --> 00:00:02.500\nFirst line\n \t \n00:00:03.000 --> 00:00:04.500\nSecond line\n";
  const spacedCues = subtitleEngine.parseSubtitleCues(spacedVtt, "vtt");
  assert.equal(spacedCues.length, 2);
  assert.equal(spacedCues[0].text, "First line");
  assert.equal(spacedCues[1].text, "Second line");
});

test("mergeBilingualCues matches naive O(N*M) tie-breaks exactly and scales to 10k x 10k cues in < 250ms", () => {
  const norm = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const naiveMerge = (primary, secondary) => {
    if (!primary.length) return secondary.map((c) => ({ ...c }));
    if (!secondary.length) return primary.map((c) => ({ ...c }));
    return primary.map((p) => {
      const pStart = Math.max(0, p.startMs);
      const pEnd = Math.max(pStart, p.endMs);
      const pMid = (pStart + pEnd) / 2;
      let bestOverlap = null;
      let nearest = null;
      for (const s of secondary) {
        const sStart = Math.max(0, s.startMs);
        const sEnd = Math.max(sStart, s.endMs);
        const overlap = Math.min(Math.max(pEnd, pStart + 1), Math.max(sEnd, sStart + 1)) - Math.max(pStart, sStart);
        if (overlap > 0) {
          const midDiff = Math.abs(pMid - (sStart + sEnd) / 2);
          if (!bestOverlap || overlap > bestOverlap.overlap || (overlap === bestOverlap.overlap && midDiff < bestOverlap.midDiff)) {
            bestOverlap = { cue: s, overlap, midDiff };
          }
          continue;
        }
        const gap = Math.max(0, Math.max(pStart, sStart) - Math.min(pEnd, sEnd));
        if (gap <= 1500) {
          const startDiff = Math.abs(pStart - sStart);
          if (!nearest || gap < nearest.gap || (gap === nearest.gap && startDiff < nearest.startDiff)) {
            nearest = { cue: s, gap, startDiff };
          }
        }
      }
      const pText = p.text.trim();
      const sText = (bestOverlap?.cue ?? nearest?.cue)?.text.trim() || "";
      if (!sText) return { startMs: pStart, endMs: pEnd, text: pText };
      const normS = norm(sText);
      const lines = new Set(pText.split("\n").map(norm));
      return { startMs: pStart, endMs: pEnd, text: norm(pText) === normS || lines.has(normS) ? pText : `${pText}\n${sText}` };
    });
  };

  // Unsorted primary & secondary with exact overlap ties, midDiff ties, gap ties, startDiff ties, zero-duration, long spans, and dedup.
  const primary = [
    { startMs: 10_000, endMs: 12_000, text: "Late overlap tie" },
    { startMs: 2_000, endMs: 4_000, text: "Overlap midDiff & origIdx tie" },
    { startMs: 6_000, endMs: 6_000, text: "Zero duration gap tie" },
    { startMs: 20_000, endMs: 21_000, text: "Same text" },
    { startMs: 30_000, endMs: 31_000, text: "No nearby match" },
    { startMs: 5_000, endMs: 5_200, text: "Covered by long span" },
  ];
  const secondary = [
    // Exact same overlap=1000 and midDiff=500 as the entry below, but earlier origIdx (0) with larger sStart
    { startMs: 3_000, endMs: 4_000, text: "Sec right-half (origIdx 0)" },
    { startMs: 2_000, endMs: 3_000, text: "Sec left-half (origIdx 1)" },
    // Long span starting early and covering 5000..5200
    { startMs: 0, endMs: 5_500, text: "Long spanning cue" },
    // Gap tie for 6000..6000: gap=500 both ways, startDiff=500 vs 500 -> origIdx 3 beats origIdx 4 even though sStart is larger!
    { startMs: 6_500, endMs: 7_000, text: "Gap right (origIdx 3)" },
    { startMs: 5_000, endMs: 5_500, text: "Gap left (origIdx 4)" },
    // Overlap ties for 10000..12000: overlap=1000 both, midDiff=0 wins over midDiff=500
    { startMs: 10_000, endMs: 11_000, text: "Off-center" },
    { startMs: 10_500, endMs: 11_500, text: "Centered" },
    // Dedup test
    { startMs: 20_000, endMs: 21_000, text: "  same   text " },
    // Just outside 1500ms tolerance for 30000..31000
    { startMs: 32_501, endMs: 33_000, text: "Too far" },
  ];
  assert.deepEqual(subtitleEngine.mergeBilingualCues(primary, secondary), naiveMerge(primary, secondary));

  // Performance regression: 10,000 x 10,000 cues must finish in < 250ms
  const bigPrimary = Array.from({ length: 10_000 }, (_, i) => ({
    startMs: i * 2_000,
    endMs: i * 2_000 + 1_600,
    text: `P-${i}`,
  }));
  const bigSecondary = Array.from({ length: 10_000 }, (_, i) => ({
    startMs: i * 2_000 + 100,
    endMs: i * 2_000 + 1_700,
    text: `S-${i}`,
  }));
  const t0 = performance.now();
  const bigMerged = subtitleEngine.mergeBilingualCues(bigPrimary, bigSecondary);
  const elapsedMs = performance.now() - t0;
  assert.equal(bigMerged.length, 10_000);
  assert.equal(bigMerged[0].text, "P-0\nS-0");
  assert.equal(bigMerged[9_999].text, "P-9999\nS-9999");
  assert.ok(elapsedMs < 250, `Expected 10k x 10k mergeBilingualCues < 250ms, took ${elapsedMs.toFixed(1)}ms`);
});

test("safeFiniteMs rejects malformed json3 and XML timing strings with trailing garbage or whitespace", () => {
  const malformedJson3 = JSON.stringify({
    events: [
      { tStartMs: "12garbage", dDurationMs: 1000, segs: [{ utf8: "drop-garbage-start" }] },
      { tStartMs: "", dDurationMs: 1000, segs: [{ utf8: "drop-empty-start" }] },
      { tStartMs: "   ", dDurationMs: 1000, segs: [{ utf8: "drop-blank-start" }] },
      { tStartMs: "0x10", dDurationMs: 1000, segs: [{ utf8: "drop-hex-start" }] },
      { tStartMs: true, dDurationMs: 1000, segs: [{ utf8: "drop-bool-start" }] },
      { tStartMs: -5, dDurationMs: 1000, segs: [{ utf8: "drop-negative" }] },
      { tStartMs: "1.5e3", dDurationMs: "250garbage", segs: [{ utf8: "keep-sci-zero-dur" }] },
      { tStartMs: 4000, dDurationMs: "1500", segs: [{ utf8: "keep-valid" }] },
    ],
  });
  const cues = subtitleEngine.parseSubtitleCues(malformedJson3, "json3");
  assert.deepEqual(cues, [
    { startMs: 1500, endMs: 1500, text: "keep-sci-zero-dur" },
    { startMs: 4000, endMs: 5500, text: "keep-valid" },
  ]);

  const malformedXml =
    '<timedtext><body><p t="100px" d="500">bad1</p><p t="  " d="500">bad2</p><p t="2000" d="300bad">ok-zero-dur</p></body></timedtext>';
  const xmlCues = subtitleEngine.parseSubtitleCues(malformedXml, "srv3");
  assert.deepEqual(xmlCues, [{ startMs: 2000, endMs: 2000, text: "ok-zero-dur" }]);
});

test("mergeBilingualCues enforces MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE on adversarial 10k x 10k inputs in < 100ms", () => {
  const cap = subtitleEngine.MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE;
  assert.equal(cap, 512);

  // 1. Exact per-cue budget boundary: candidate at index (cap - 1) is inspected, index (cap) is skipped
  const boundaryPrimary = [{ startMs: 0, endMs: 2_000, text: "P" }];
  const withinCapSecondary = [
    ...Array.from({ length: cap - 1 }, (_, i) => ({ startMs: 0, endMs: 1_000, text: `small-${i}` })),
    { startMs: 0, endMs: 2_000, text: "best-at-511" },
    { startMs: 0, endMs: 2_000, text: "beyond-at-512" },
  ];
  assert.deepEqual(subtitleEngine.mergeBilingualCues(boundaryPrimary, withinCapSecondary), [
    { startMs: 0, endMs: 2_000, text: "P\nbest-at-511" },
  ]);

  const beyondCapSecondary = [
    ...Array.from({ length: cap }, (_, i) => ({ startMs: 0, endMs: 1_000, text: `small-${i}` })),
    { startMs: 0, endMs: 2_000, text: "beyond-at-512" },
  ];
  assert.deepEqual(subtitleEngine.mergeBilingualCues(boundaryPrimary, beyondCapSecondary), [
    { startMs: 0, endMs: 2_000, text: "P\nsmall-0" },
  ]);

  // 2. Adversarial 10,000 x 10,000 full-overlap input ([0, 3_600_000])
  const fullPrimary = Array.from({ length: 10_000 }, (_, i) => ({
    startMs: 0,
    endMs: 3_600_000,
    text: `FP-${i}`,
  }));
  const fullSecondary = Array.from({ length: 10_000 }, (_, i) => ({
    startMs: 0,
    endMs: 3_600_000,
    text: `FS-${i}`,
  }));
  const tFull0 = performance.now();
  const fullMerged = subtitleEngine.mergeBilingualCues(fullPrimary, fullSecondary);
  const fullElapsedMs = performance.now() - tFull0;
  assert.equal(fullMerged.length, 10_000);
  assert.equal(fullMerged[0].text, "FP-0\nFS-0");
  assert.equal(fullMerged[5_000].text, "FP-5000\nFS-0");
  assert.equal(fullMerged[9_999].text, "FP-9999\nFS-0");
  assert.ok(
    fullElapsedMs < 100,
    `Expected adversarial full-overlap 10k x 10k mergeBilingualCues < 100ms, took ${fullElapsedMs.toFixed(1)}ms`,
  );

  // 3. Adversarial prefix-skip 10,000 x 10,000 input (1 long anchor at index 0 + 9,999 short early cues)
  const skipSecondary = [
    { startMs: 0, endMs: 3_600_000, text: "ANCHOR-LONG" },
    ...Array.from({ length: 9_999 }, (_, i) => ({
      startMs: 0,
      endMs: 10,
      text: `SHORT-${i}`,
    })),
  ];
  const skipPrimary = Array.from({ length: 10_000 }, (_, i) => ({
    startMs: 100_000 + i * 100,
    endMs: 100_000 + i * 100 + 50,
    text: `SP-${i}`,
  }));
  const tSkip0 = performance.now();
  const skipMerged = subtitleEngine.mergeBilingualCues(skipPrimary, skipSecondary);
  const skipElapsedMs = performance.now() - tSkip0;
  assert.equal(skipMerged.length, 10_000);
  assert.equal(skipMerged[0].text, "SP-0\nANCHOR-LONG");
  assert.equal(skipMerged[5_000].text, "SP-5000\nANCHOR-LONG");
  assert.equal(skipMerged[9_999].text, "SP-9999\nANCHOR-LONG");
  assert.ok(
    skipElapsedMs < 100,
    `Expected adversarial prefix-skip 10k x 10k mergeBilingualCues < 100ms, took ${skipElapsedMs.toFixed(1)}ms`,
  );
});
