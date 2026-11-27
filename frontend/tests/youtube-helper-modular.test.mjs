import test, { describe } from "node:test";
import assert from "node:assert/strict";

import * as helperValidation from "../src/utils/youtube/helperValidation.js";
import * as playerPayload from "../src/utils/youtube/playerPayload.js";
import * as muxSelector from "../src/utils/youtube/muxSelector.js";
import * as youtubeHelperCore from "../src/utils/youtubeHelperCore.js";

const VALID_PLAYBACK_URL =
  "https://rr1---sn-4g5e6ns7.googlevideo.com/videoplayback?expire=1890000000&itag=137&clen=42000000";

describe("youtube/helperValidation pure module", () => {
  test("rejects invalid googlevideo playback URLs (non-googlevideo, credentials, wrong scheme, port, fragment, path, control chars)", () => {
    assert.equal(helperValidation.isValidGooglevideoPlaybackUrl(VALID_PLAYBACK_URL), true);
    assert.equal(
      helperValidation.isValidGooglevideoPlaybackUrl(
        "https://rr2---sn-a5mlrn7z.googlevideo.com:443/videoplayback?itag=251",
      ),
      true,
    );
    assert.equal(
      helperValidation.isValidGooglevideoPlaybackUrl(
        "https://rr2---sn-a5mlrn7z.googlevideo.com./videoplayback?itag=251",
      ),
      true,
    );

    const invalidUrls = [
      "",
      null,
      undefined,
      123,
      "http://rr1---sn-4g5e6ns7.googlevideo.com/videoplayback?itag=137",
      "ftp://rr1---sn-4g5e6ns7.googlevideo.com/videoplayback?itag=137",
      "javascript:alert(1)",
      "https://user:pass@rr1---sn-4g5e6ns7.googlevideo.com/videoplayback?itag=137",
      "https://user@rr1---sn-4g5e6ns7.googlevideo.com/videoplayback?itag=137",
      "https://evil.example.com/videoplayback?itag=137",
      "https://googlevideo.com/videoplayback?itag=137",
      "https://rr1.googlevideo.com.evil.com/videoplayback?itag=137",
      "https://rr1---sn-4g5e6ns7.googlevideo.com:8443/videoplayback?itag=137",
      "https://rr1---sn-4g5e6ns7.googlevideo.com/otherpath?itag=137",
      "https://rr1---sn-4g5e6ns7.googlevideo.com/videoplayback/extra",
      "https://rr1---sn-4g5e6ns7.googlevideo.com/videoplayback?itag=137#frag",
      "https://rr1---sn-4g5e6ns7.googlevideo.com/videoplayback?a=1\\b=2",
      "https://rr1---sn-4g5e6ns7.googlevideo.com/videoplayback?a=1\n2",
      "https://rr1---sn-4g5e6ns7.googlevideo.com/videoplayback?a=1 2",
      `https://rr1---sn-4g5e6ns7.googlevideo.com/videoplayback?pad=${"a".repeat(8200)}`,
    ];

    for (const bad of invalidUrls) {
      assert.equal(
        helperValidation.isValidGooglevideoPlaybackUrl(bad),
        false,
        `expected rejection for playback URL: ${String(bad).slice(0, 80)}`,
      );
    }
  });

  test("enforces strict signature timestamp integer boundaries [10000, 999999]", () => {
    assert.equal(helperValidation.isValidSignatureTimestamp(10000), true);
    assert.equal(helperValidation.isValidSignatureTimestamp(20123), true);
    assert.equal(helperValidation.isValidSignatureTimestamp(999999), true);

    const invalid = [
      9999,
      1000000,
      0,
      -20123,
      20123.5,
      NaN,
      Infinity,
      "20123",
      null,
      undefined,
    ];
    for (const val of invalid) {
      assert.equal(
        helperValidation.isValidSignatureTimestamp(val),
        false,
        `expected invalid sts: ${String(val)}`,
      );
    }
  });

  test("validates video IDs, URLs, TVHTML5 client, thumbnails, semver, visitorData, filenames, and helper text", () => {
    assert.equal(helperValidation.isValidYouTubeVideoId("dQw4w9WgXcQ"), true);
    assert.equal(helperValidation.isValidYouTubeVideoId("short"), false);
    assert.equal(helperValidation.isValidYouTubeVideoId("bad$char123"), false);

    assert.equal(
      helperValidation.extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      "dQw4w9WgXcQ",
    );
    assert.equal(
      helperValidation.extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=10"),
      "dQw4w9WgXcQ",
    );
    assert.equal(
      helperValidation.extractYouTubeVideoId("https://m.youtube.com/shorts/dQw4w9WgXcQ"),
      "dQw4w9WgXcQ",
    );
    assert.equal(
      helperValidation.extractYouTubeVideoId("https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ"),
      "",
    );
    assert.equal(
      helperValidation.extractYouTubeVideoId("https://evil.example.com/watch?v=dQw4w9WgXcQ"),
      "",
    );

    assert.equal(
      helperValidation.isValidTVHTML5Client({ name: "TVHTML5", version: "7.20260401.10.00" }),
      true,
    );
    assert.equal(
      helperValidation.isValidTVHTML5Client({ name: "TVHTML5", version: "5.20260401" }),
      true,
    );
    assert.equal(
      helperValidation.isValidTVHTML5Client({ name: "WEB", version: "7.20260401.10.00" }),
      false,
    );
    assert.equal(
      helperValidation.isValidTVHTML5Client({ name: "TVHTML5", version: "7.2026" }),
      false,
    );

    assert.equal(
      helperValidation.isValidYouTubeThumbnailUrl("https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"),
      true,
    );
    assert.equal(
      helperValidation.isValidYouTubeThumbnailUrl("https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg"),
      true,
    );
    assert.equal(
      helperValidation.isValidYouTubeThumbnailUrl("http://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"),
      false,
    );
    assert.equal(
      helperValidation.isValidYouTubeThumbnailUrl("https://evil.com/thumb.jpg"),
      false,
    );

    assert.equal(helperValidation.compareSemver("1.3.2", "1.3.1"), 1);
    assert.equal(helperValidation.compareSemver("1.3.1", "1.3.1"), 0);
    assert.equal(helperValidation.compareSemver("1.2.9", "1.3.1"), -1);
    assert.ok(Number.isNaN(helperValidation.compareSemver("1.3", "1.3.1")));
    assert.equal(helperValidation.isHelperVersionSupported("1.3.1"), true);
    assert.equal(helperValidation.isHelperVersionSupported("1.3.0"), false);

    const token = "Cgtsb25nVG9rZW4xMjM49%3D%3D";
    assert.equal(helperValidation.isValidVisitorDataToken(token), true);
    assert.equal(helperValidation.isValidVisitorDataToken("bad"), false);
    assert.equal(
      helperValidation.extractVisitorDataFromSwResponse(`)]}'\n[[null,null,[null,null,null,null,null,null,"${token}"]]]`),
      token,
    );

    assert.deepEqual(helperValidation.sanitizeHelperFilename("  my/bad:video*name .mp4  "), {
      ok: true,
      filename: "my_bad_video_name.mp4",
    });
    assert.equal(helperValidation.sanitizeHelperFilename("script.exe").ok, false);
    assert.equal(helperValidation.sanitizeHelperText("  hello\x00world  ", 8), "hellowor");
  });
});

describe("youtube/playerPayload pure module", () => {
  test("buildTVHTML5PlayerPayload builds validated TVHTML5 request body and rejects invalid inputs", () => {
    const payload = playerPayload.buildTVHTML5PlayerPayload({
      video_id: "dQw4w9WgXcQ",
      signature_timestamp: 20123,
      client: { name: "TVHTML5", version: "7.20260401.10.00" },
      visitorData: "  Cgtsb25nVG9rZW4xMjM=  ",
    });
    assert.equal(payload.videoId, "dQw4w9WgXcQ");
    assert.equal(payload.context.client.clientName, "TVHTML5");
    assert.equal(payload.context.client.clientVersion, "7.20260401.10.00");
    assert.equal(payload.context.client.visitorData, "Cgtsb25nVG9rZW4xMjM=");
    assert.equal(
      payload.playbackContext.contentPlaybackContext.signatureTimestamp,
      20123,
    );

    assert.throws(() => playerPayload.buildTVHTML5PlayerPayload(null));
    assert.throws(() =>
      playerPayload.buildTVHTML5PlayerPayload({
        video_id: "bad",
        signature_timestamp: 20123,
        client: { name: "TVHTML5", version: "7.20260401.10.00" },
      }),
    );
    assert.throws(() =>
      playerPayload.buildTVHTML5PlayerPayload({
        video_id: "dQw4w9WgXcQ",
        signature_timestamp: 9999,
        client: { name: "TVHTML5", version: "7.20260401.10.00" },
      }),
    );
    assert.throws(() =>
      playerPayload.buildTVHTML5PlayerPayload({
        video_id: "dQw4w9WgXcQ",
        signature_timestamp: 20123,
        client: { name: "IOS", version: "7.20260401.10.00" },
      }),
    );
  });

  test("sanitizePlayerApiResponse enforces field whitelists, prefers original audio, and sanitizes captions", () => {
    const rawTracks = Array.from({ length: 70 }, (_, idx) => ({
      baseUrl: `https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&idx=${idx}`,
      name:
        idx === 0
          ? { simpleText: "English", runs: [{ text: "English", extra: true }], evil: "drop" }
          : idx === 1
            ? "Japanese"
            : { runs: [{ text: `Track ${idx}` }] },
      vssId: `.en.${idx}`,
      languageCode: "en",
      kind: idx === 0 ? "asr" : undefined,
      isTranslatable: idx % 2 === 0,
      injectedField: "must-strip",
    }));

    const sanitized = playerPayload.sanitizePlayerApiResponse({
      playabilityStatus: { status: "OK", reason: "fine", extraStatus: "strip" },
      streamingData: {
        formats: [
          {
            itag: 18,
            url: VALID_PLAYBACK_URL,
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
            width: 640,
            height: 360,
            fps: 30,
            secretToken: "must-strip",
          },
          { itag: 0, url: VALID_PLAYBACK_URL }, // invalid itag -> dropped
        ],
        adaptiveFormats: [
          {
            itag: 401,
            url: VALID_PLAYBACK_URL,
            mimeType: 'video/mp4; codecs="av01.0.12M.08"',
            width: 3840,
            height: 2160,
            fps: 60,
            extraPrivate: "drop-me",
          },
          {
            itag: 140,
            url: `${VALID_PLAYBACK_URL}&xtags=acont%3Ddubbed-auto:lang%3Des`,
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            audioTrack: {
              id: "es.4",
              displayName: "Spanish (auto-dubbed)",
              audioIsDefault: true,
              extraTrackKey: "strip",
            },
          },
          {
            itag: 140,
            url: `${VALID_PLAYBACK_URL}&xtags=acont%3Doriginal:lang%3Den`,
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            audioTrack: {
              id: "en.4",
              displayName: "English original",
              audioIsDefault: false,
            },
          },
        ],
      },
      videoDetails: {
        title: "Test\x00 Title",
        author: "Channel\x1fName",
        lengthSeconds: "125",
        thumbnail: {
          thumbnails: [
            { url: "https://evil.example.com/huge.jpg", width: 9999, height: 9999 },
            { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", width: 480, height: 360 },
            { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg", width: 1280, height: 720 },
          ],
        },
        unlistedSecret: "strip",
      },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: "   " }, // dropped
            ...rawTracks,
          ],
        },
      },
      trackingParams: "strip-top-level",
    });

    assert.deepEqual(sanitized.playabilityStatus, { status: "OK", reason: "fine" });
    assert.equal(sanitized.streamingData.formats.length, 1);
    assert.equal("secretToken" in sanitized.streamingData.formats[0], false);

    // Only video + original audio track kept; dubbed-auto track filtered out
    assert.equal(sanitized.streamingData.adaptiveFormats.length, 2);
    const keptVideo = sanitized.streamingData.adaptiveFormats[0];
    const keptAudio = sanitized.streamingData.adaptiveFormats[1];
    assert.equal("extraPrivate" in keptVideo, false);
    assert.equal(keptAudio.audioTrack.id, "en.4");
    assert.equal(playerPayload.extractXtagsAudioContent(keptAudio), "original");

    assert.deepEqual(sanitized.videoDetails, {
      title: "Test Title",
      author: "ChannelName",
      lengthSeconds: 125,
      thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    });

    const tracks = sanitized.captions.playerCaptionsTracklistRenderer.captionTracks;
    assert.equal(tracks.length, 64, "captions must cap at 64 tracks");
    assert.deepEqual(tracks[0].name, {
      simpleText: "English",
      runs: [{ text: "English" }],
    });
    assert.equal("injectedField" in tracks[0], false);
    assert.equal(tracks[1].name, "Japanese");
    assert.equal("trackingParams" in sanitized, false);

    assert.throws(() => playerPayload.sanitizePlayerApiResponse(null));
    assert.deepEqual(playerPayload.sanitizePlayerApiResponse({}), {
      playabilityStatus: { status: "ERROR" },
      streamingData: null,
    });
  });

  test("extractXtagsAudioContent, classifyAudioFormatEntry, sanitizeFormatArray, sanitizeVideoDetails, and sanitizePlayerCaptions work directly", () => {
    const cipherEntry = {
      signatureCipher: `s=abc&sp=sig&url=${encodeURIComponent(
        `${VALID_PLAYBACK_URL}&xtags=lang%3Dja:acont%3Ddescriptive`,
      )}`,
    };
    assert.equal(playerPayload.extractXtagsAudioContent(cipherEntry), "descriptive");
    const classified = playerPayload.classifyAudioFormatEntry({
      ...cipherEntry,
      audioTrack: { id: "ja.4", displayName: "Japanese", audioIsDefault: false },
    });
    assert.equal(classified.isDescriptive, true);
    assert.equal(classified.hasHint, true);

    assert.deepEqual(playerPayload.sanitizeFormatArray(null), []);
    assert.equal(playerPayload.sanitizeVideoDetails({ lengthSeconds: "0" }), null);
    assert.equal(
      playerPayload.sanitizePlayerCaptions({
        captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=ja" }],
      }).playerCaptionsTracklistRenderer.captionTracks.length,
      1,
    );
    assert.equal(playerPayload.sanitizePlayerCaptions({ captionTracks: [] }), null);
  });
});

describe("youtube/muxSelector pure module", () => {
  function makeVariant(id, label, metadata, url = VALID_PLAYBACK_URL, state = "ready") {
    return {
      id,
      state,
      label,
      metadata,
      delivery: {
        kind: "file",
        sources: [{ url, availability: "available" }],
      },
    };
  }

  test("extractUrlClen extracts positive safe integer clen and returns 0 on invalid values", () => {
    assert.equal(
      muxSelector.extractUrlClen(
        "https://rr1.googlevideo.com/videoplayback?itag=315&clen=987654321",
      ),
      987654321,
    );
    assert.equal(muxSelector.extractUrlClen("https://rr1.googlevideo.com/videoplayback?clen=0"), 0);
    assert.equal(muxSelector.extractUrlClen("https://rr1.googlevideo.com/videoplayback?clen=-5"), 0);
    assert.equal(muxSelector.extractUrlClen("https://rr1.googlevideo.com/videoplayback?clen=12abc"), 0);
    assert.equal(
      muxSelector.extractUrlClen(
        "https://rr1.googlevideo.com/videoplayback?clen=99999999999999999999",
      ),
      0,
    );
    assert.equal(muxSelector.extractUrlClen("not-a-url"), 0);
    assert.equal(muxSelector.extractUrlClen(null), 0);
  });

  test("selectYouTubeMuxPair handles 8K AV1/MP4 + AAC, 8K HDR VP9.2/WebM + Opus, original audio priority, and rejects cross-container pairs", () => {
    const av1_8k = makeVariant(
      "yt-v-8k-av1",
      "4320p60 AV1",
      {
        has_audio: false,
        video_codec: "av01.0.16M.10.0.110.09.16.09.0",
        container: "mp4",
        extension: "mp4",
        width: 7680,
        height: 4320,
      },
      "https://rr1---sn-a.googlevideo.com/videoplayback?itag=571&clen=500000000",
    );
    const vp9_8k_hdr = makeVariant(
      "yt-v-8k-vp9-hdr",
      "4320p60 HDR",
      {
        has_audio: false,
        video_codec: "vp09.02.51.10.01.09.16.09.00",
        container: "webm",
        extension: "webm",
        width: 7680,
        height: 4320,
      },
      "https://rr1---sn-a.googlevideo.com/videoplayback?itag=337&clen=600000000",
    );

    const m4aDubbed = makeVariant(
      "yt-a-m4a-dub",
      "Spanish (auto-dubbed)",
      {
        has_audio: true,
        audio_codec: "mp4a.40.2",
        mime_type: "audio/mp4",
        container: "m4a",
        extension: "m4a",
        audio_language_role: "alternate",
      },
      "https://rr1---sn-a.googlevideo.com/videoplayback?itag=140&xtags=acont%3Ddubbed-auto",
    );
    const m4aOriginal = makeVariant(
      "yt-a-m4a-orig",
      "English 原声",
      {
        has_audio: true,
        audio_codec: "mp4a.40.2",
        mime_type: "audio/mp4",
        container: "m4a",
        extension: "m4a",
        audio_language_role: "main",
      },
      "https://rr1---sn-a.googlevideo.com/videoplayback?itag=140&xtags=acont%3Doriginal",
    );
    const opusWebmAttachment = {
      id: "att-opus",
      title: "Original Opus",
      resource: {
        id: "res-opus",
        role: "audio",
        metadata: {
          has_audio: true,
          audio_codec: "opus",
          mime_type: "audio/webm",
          container: "webm",
          extension: "webm",
        },
        delivery: {
          kind: "file",
          sources: [
            {
              url: "https://rr2---sn-b.googlevideo.com/videoplayback?itag=251&clen=8000000",
              availability: "available",
            },
          ],
        },
      },
    };

    // 8K AV1 MP4 selects original M4A over earlier dubbed M4A
    const mp4Pair = muxSelector.selectYouTubeMuxPair(
      av1_8k,
      [av1_8k, m4aDubbed, m4aOriginal],
      [opusWebmAttachment],
    );
    assert.equal(mp4Pair.ok, true);
    assert.equal(mp4Pair.outputContainer, "mp4");
    assert.equal(mp4Pair.outputMimeType, "video/mp4");
    assert.equal(mp4Pair.audioVariant.id, "yt-a-m4a-orig");

    // 8K HDR VP9.2 WebM selects WebM Opus from attachments
    const webmPair = muxSelector.selectYouTubeMuxPair(
      vp9_8k_hdr,
      [vp9_8k_hdr, m4aOriginal],
      [opusWebmAttachment],
    );
    assert.equal(webmPair.ok, true);
    assert.equal(webmPair.outputContainer, "webm");
    assert.equal(webmPair.outputMimeType, "video/webm");
    assert.equal(webmPair.audioVariant.id, "att-opus");

    // Cross-container mismatch (VP9 WebM with only M4A audio) is rejected
    const crossMismatch = muxSelector.selectYouTubeMuxPair(
      vp9_8k_hdr,
      [vp9_8k_hdr, m4aOriginal],
      [],
    );
    assert.equal(crossMismatch.ok, false);
    assert.match(crossMismatch.reason, /Opus \(WebM\)/);

    // Invalid playback URL on video variant is rejected
    const badVideo = makeVariant(
      "yt-v-bad-url",
      "1080p",
      { has_audio: false, video_codec: "avc1.640028", container: "mp4" },
      "https://evil.example.com/videoplayback?itag=137",
    );
    assert.equal(muxSelector.selectYouTubeMuxPair(badVideo, [m4aOriginal]).ok, false);
  });
});

describe("youtubeHelperCore.js re-export identity contract", () => {
  test("re-exports every moved symbol identically by reference from its submodule", () => {
    const validationSymbols = [
      "MIN_YOUTUBE_HELPER_VERSION",
      "MAX_HELPER_TITLE_CHARS",
      "isValidYouTubeVideoId",
      "extractYouTubeVideoId",
      "isValidSignatureTimestamp",
      "isValidTVHTML5Client",
      "isValidGooglevideoPlaybackUrl",
      "isValidYouTubeThumbnailUrl",
      "compareSemver",
      "isHelperVersionSupported",
      "isValidVisitorDataToken",
      "extractVisitorDataFromSwResponse",
      "sanitizeHelperFilename",
      "sanitizeHelperText",
    ];
    for (const sym of validationSymbols) {
      assert.strictEqual(
        youtubeHelperCore[sym],
        helperValidation[sym],
        `youtubeHelperCore.${sym} must strictly re-export helperValidation.${sym}`,
      );
    }

    const payloadSymbols = [
      "buildTVHTML5PlayerPayload",
      "sanitizeVideoDetails",
      "sanitizePlayerApiResponse",
    ];
    for (const sym of payloadSymbols) {
      assert.strictEqual(
        youtubeHelperCore[sym],
        playerPayload[sym],
        `youtubeHelperCore.${sym} must strictly re-export playerPayload.${sym}`,
      );
    }

    const muxSymbols = ["extractUrlClen", "selectYouTubeMuxPair"];
    for (const sym of muxSymbols) {
      assert.strictEqual(
        youtubeHelperCore[sym],
        muxSelector[sym],
        `youtubeHelperCore.${sym} must strictly re-export muxSelector.${sym}`,
      );
    }

    // Ensure youtubeHelperCore preserves exact 49 exported symbols (after retiring standalone YOUTUBE_HELPER_VERSION & YOUTUBE_HELPER_SCRIPT_URL)
    assert.equal(Object.keys(youtubeHelperCore).length, 49);
  });
});
