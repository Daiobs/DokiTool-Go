package ytengine

import (
	"context"
	"strings"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func goldenInt64Ptr(v int64) *int64       { return &v }
func goldenFloat64Ptr(v float64) *float64 { return &v }
func goldenIntPtr(v int) *int             { return &v }

func assertGoldenVariantEnvelopeValid(t *testing.T, env unified.Object, now int64, wantCode string) {
	t.Helper()
	if env == nil {
		t.Fatalf("expected non-nil envelope")
	}
	if err := unified.ValidateEnvelopeAt(env, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v\nenvelope=%+v", err, env)
	}
	if got := unified.Str(env["code"]); got != wantCode {
		t.Fatalf("code = %q, want %q; envelope=%+v", got, wantCode, env)
	}
	if wantCode == "OK" {
		for _, debug := range []bool{false, true} {
			pub := unified.PublicView(env, debug, now)
			if err := unified.ValidateEnvelopeAt(pub, now); err != nil {
				t.Fatalf("ValidateEnvelopeAt(PublicView debug=%v) failed: %v", debug, err)
			}
		}
	}
}

func TestGoldenBuildEntryVariantsSingleStreamHLSOnly(t *testing.T) {
	const now int64 = 1762300800
	const contentID = "dmGolden01"
	const entryKey = "dmGolden01-entry"

	opts := AdaptOptions{
		PlatformID:          "dailymotion",
		ContentID:           contentID,
		SourceURL:           "https://www.dailymotion.com/video/" + contentID,
		SingleStreamHLSOnly: true,
		AllowedMediaURL: func(raw string) bool {
			return strings.HasPrefix(raw, "https://vod2.cf.dmcdn.net/")
		},
	}

	baseEntry := Info{
		ID:       entryKey,
		Title:    "Golden Single Stream HLS",
		Uploader: "DMCreator",
		Formats: []Format{
			// Excluded: disallowed host
			{
				FormatID: "hls-bad-host",
				URL:      "https://evil.example.com/cloud/fmp4/1/manifest.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    goldenInt64Ptr(1920),
				Height:   goldenInt64Ptr(1080),
				VCodec:   "avc1.64002a",
				ACodec:   "mp4a.40.2",
			},
			// Excluded: progressive MP4
			{
				FormatID: "http-720",
				URL:      "https://vod2.cf.dmcdn.net/progressive/v720.mp4",
				Ext:      "mp4",
				Protocol: "https",
				Width:    goldenInt64Ptr(1280),
				Height:   goldenInt64Ptr(720),
				VCodec:   "avc1.4d401f",
				ACodec:   "mp4a.40.2",
			},
			// Excluded: video-only adaptive HLS
			{
				FormatID: "hls-video-only",
				URL:      "https://vod2.cf.dmcdn.net/cloud/fmp4/1/video_only.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    goldenInt64Ptr(1920),
				Height:   goldenInt64Ptr(1080),
				VCodec:   "avc1.64002a",
				ACodec:   "none",
			},
			// Excluded: non-fMP4 TS-HLS
			{
				FormatID: "hls-legacy-ts",
				URL:      "https://vod2.cf.dmcdn.net/legacy/1080.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    goldenInt64Ptr(1920),
				Height:   goldenInt64Ptr(1080),
				VCodec:   "avc1.64002a",
				ACodec:   "mp4a.40.2",
			},
			// Kept: 720p30 fMP4 HLS
			{
				FormatID: "hls-720p30",
				URL:      "https://vod2.cf.dmcdn.net/cloud/fmp4/1/720p30/manifest.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    goldenInt64Ptr(1280),
				Height:   goldenInt64Ptr(720),
				FPS:      goldenFloat64Ptr(30),
				TBR:      goldenFloat64Ptr(2100),
				VCodec:   "avc1.4d401f",
				ACodec:   "mp4a.40.2",
			},
			// Deduped out: lower TBR 1080p60 fMP4 HLS in same 1920x1080:60 tier
			{
				FormatID: "hls-1080p60-lo",
				URL:      "https://vod2.cf.dmcdn.net/cloud/fmp4/1/1080p60_lo/manifest.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    goldenInt64Ptr(1920),
				Height:   goldenInt64Ptr(1080),
				FPS:      goldenFloat64Ptr(60),
				TBR:      goldenFloat64Ptr(4100),
				VCodec:   "avc1.64002a",
				ACodec:   "mp4a.40.2",
			},
			// Kept: higher TBR 1080p60 fMP4 HLS
			{
				FormatID: "hls-1080p60-hi",
				URL:      "https://vod2.cf.dmcdn.net/cloud/fmp4/1/1080p60_hi/manifest.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    goldenInt64Ptr(1920),
				Height:   goldenInt64Ptr(1080),
				FPS:      goldenFloat64Ptr(60),
				TBR:      goldenFloat64Ptr(5800),
				VCodec:   "avc1.64002a",
				ACodec:   "mp4a.40.2",
			},
			// Deduped out: exact duplicate URL (after fragment strip) with lower TBR
			{
				FormatID: "hls-1080p60-dupurl",
				URL:      "https://vod2.cf.dmcdn.net/cloud/fmp4/1/1080p60_hi/manifest.m3u8#frag",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    goldenInt64Ptr(1920),
				Height:   goldenInt64Ptr(1080),
				FPS:      goldenFloat64Ptr(60),
				TBR:      goldenFloat64Ptr(5700),
				VCodec:   "avc1.64002a",
				ACodec:   "mp4a.40.2",
			},
			// Kept: 1080p30 fMP4 HLS (distinct fpsTier=0 vs fpsTier=60)
			{
				FormatID: "hls-1080p30",
				URL:      "https://vod2.cf.dmcdn.net/cloud/fmp4/1/1080p30/manifest.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    goldenInt64Ptr(1920),
				Height:   goldenInt64Ptr(1080),
				FPS:      goldenFloat64Ptr(30),
				TBR:      goldenFloat64Ptr(3400),
				VCodec:   "avc1.640028",
				ACodec:   "mp4a.40.2",
			},
		},
	}

	variants, att := buildEntryVariants(&baseEntry, &baseEntry, entryKey, baseEntry.Title, opts, now)
	if att != nil {
		t.Fatalf("SingleStreamHLSOnly must return nil audioAttachment, got %+v", att)
	}
	if len(variants) != 3 {
		t.Fatalf("expected 3 deduplicated single-stream HLS variants, got %d: %+v", len(variants), variants)
	}

	wantOrder := []struct {
		formatKey string
		label     string
		url       string
		fps       int64
	}{
		{
			formatKey: "hls-1080p60-hi",
			label:     "1080p60",
			url:       "https://vod2.cf.dmcdn.net/cloud/fmp4/1/1080p60_hi/manifest.m3u8",
			fps:       60,
		},
		{
			formatKey: "hls-1080p30",
			label:     "1080p",
			url:       "https://vod2.cf.dmcdn.net/cloud/fmp4/1/1080p30/manifest.m3u8",
			fps:       30,
		},
		{
			formatKey: "hls-720p30",
			label:     "720p",
			url:       "https://vod2.cf.dmcdn.net/cloud/fmp4/1/720p30/manifest.m3u8",
			fps:       30,
		},
	}
	for i, want := range wantOrder {
		v := unified.Map(variants[i])
		wantID := "v-" + shortDigest("dailymotion:hls-single:"+entryKey+":"+want.formatKey)
		if unified.Str(v["id"]) != wantID || unified.Str(v["label"]) != want.label {
			t.Fatalf("variant[%d] = (id=%v, label=%v), want (id=%s, label=%s)", i, v["id"], v["label"], wantID, want.label)
		}
		meta := unified.Map(v["metadata"])
		if meta["has_audio"] != true || meta["fps"] != want.fps {
			t.Fatalf("variant[%d] unexpected metadata: %+v", i, meta)
		}
		delivery := unified.Map(v["delivery"])
		if unified.Str(delivery["kind"]) != "hls" || unified.Str(delivery["scope"]) != "single" {
			t.Fatalf("variant[%d] unexpected delivery: %+v", i, delivery)
		}
		if _, hasSel := delivery["selection"]; hasSel {
			t.Fatalf("variant[%d] single-stream HLS must omit selection: %+v", i, delivery)
		}
		out := unified.Map(delivery["output"])
		if unified.Str(out["container"]) != "mp4" || unified.Str(out["extension"]) != "mp4" || unified.Str(out["mime_type"]) != "video/mp4" {
			t.Fatalf("variant[%d] unexpected output: %+v", i, out)
		}
		src := unified.Map(unified.Slice(delivery["sources"])[0])
		if unified.Str(src["url"]) != want.url {
			t.Fatalf("variant[%d] url = %q, want %q", i, src["url"], want.url)
		}
	}

	env := AdaptInfo(&baseEntry, opts, now)
	assertGoldenVariantEnvelopeValid(t, env, now, "OK")
	item := unified.Map(unified.Slice(unified.Map(env["data"])["items"])[0])
	if item["default"] != nil || unified.Str(item["default_unavailable_reason"]) != "processing_required" {
		t.Fatalf("expected null default with processing_required, got %+v", item)
	}

	// Live stream rejection on entry.IsLive and parent.IsLive.
	isLive := true
	entryLive := baseEntry
	entryLive.IsLive = &isLive
	if vLive, aLive := buildEntryVariants(&entryLive, &baseEntry, entryKey, baseEntry.Title, opts, now); vLive != nil || aLive != nil {
		t.Fatalf("expected (nil, nil) on entry.IsLive, got (%v, %v)", vLive, aLive)
	}
	parentLive := baseEntry
	parentLive.IsLive = &isLive
	if vParentLive, aParentLive := buildEntryVariants(&baseEntry, &parentLive, entryKey, baseEntry.Title, opts, now); vParentLive != nil || aParentLive != nil {
		t.Fatalf("expected (nil, nil) on parent.IsLive, got (%v, %v)", vParentLive, aParentLive)
	}
	envLive := AdaptInfo(&entryLive, opts, now)
	assertGoldenVariantEnvelopeValid(t, envLive, now, "NO_MEDIA")
}

func TestGoldenBuildEntryVariantsMixedDASHProgressiveAndAudio(t *testing.T) {
	const now int64 = 1762300800
	const contentID = "vidGolden01"

	opts := AdaptOptions{
		PlatformID:    "youtube",
		ContentID:     contentID,
		SourceURL:     "https://www.youtube.com/watch?v=" + contentID,
		MaxEntries:    1,
		EnableDASHMux: true,
	}

	info := &Info{
		ID:         contentID,
		Title:      "Golden 4K Test",
		Uploader:   "Golden Channel",
		UploaderID: "@golden",
		Thumbnail:  "https://i.ytimg.com/vi/vidGolden01/maxresdefault.jpg",
		Formats: []Format{
			// Progressive MP4 360p30 with audio
			{
				FormatID: "18",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=18&clen=15000000&sig=S18",
				Ext:      "mp4",
				Protocol: "https",
				Width:    goldenInt64Ptr(640),
				Height:   goldenInt64Ptr(360),
				FPS:      goldenFloat64Ptr(30),
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: goldenInt64Ptr(15000000),
			},
			// Progressive MP4 720p30 with audio (sets maxMP4Edge=720, maxMP4FPS=30)
			{
				FormatID: "22",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=22&clen=48000000&sig=S22",
				Ext:      "mp4",
				Protocol: "https",
				Width:    goldenInt64Ptr(1280),
				Height:   goldenInt64Ptr(720),
				FPS:      goldenFloat64Ptr(30),
				VCodec:   "avc1.64001F",
				ACodec:   "mp4a.40.2",
				Filesize: goldenInt64Ptr(48000000),
			},
			// DASH video-only 360p30 -> MUST BE FILTERED OUT (edge < maxMP4Edge)
			{
				FormatID: "134",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=134&sig=S134",
				Ext:      "mp4",
				Protocol: "https",
				Width:    goldenInt64Ptr(640),
				Height:   goldenInt64Ptr(360),
				FPS:      goldenFloat64Ptr(30),
				VCodec:   "avc1.4d401e",
				ACodec:   "none",
			},
			// DASH video-only 720p30 -> MUST BE FILTERED OUT (edge == maxMP4Edge, !higherFPS)
			{
				FormatID: "136",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=136&sig=S136",
				Ext:      "mp4",
				Protocol: "https",
				Width:    goldenInt64Ptr(1280),
				Height:   goldenInt64Ptr(720),
				FPS:      goldenFloat64Ptr(30),
				VCodec:   "avc1.4d401f",
				ACodec:   "none",
			},
			// DASH video-only 720p60 -> MUST BE KEPT (edge == maxMP4Edge, fps=60 > 30+5 && >= 50)
			{
				FormatID: "298",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=298&sig=S298",
				Ext:      "mp4",
				Protocol: "https",
				Width:    goldenInt64Ptr(1280),
				Height:   goldenInt64Ptr(720),
				FPS:      goldenFloat64Ptr(60),
				VBR:      goldenFloat64Ptr(3200),
				VCodec:   "avc1.640020",
				ACodec:   "none",
			},
			// DASH video-only 1080p60 WebM VP9 -> deduped out by 1080p60 MP4 H.264 below
			{
				FormatID: "303",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=303&sig=S303",
				Ext:      "webm",
				Protocol: "https",
				Width:    goldenInt64Ptr(1920),
				Height:   goldenInt64Ptr(1080),
				FPS:      goldenFloat64Ptr(60),
				VBR:      goldenFloat64Ptr(4500),
				VCodec:   "vp9",
				ACodec:   "none",
			},
			// DASH video-only 1080p60 MP4 H.264 -> wins 1920x1080 SDR tier
			{
				FormatID: "299",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=299&sig=S299",
				Ext:      "mp4",
				Protocol: "https",
				Width:    goldenInt64Ptr(1920),
				Height:   goldenInt64Ptr(1080),
				FPS:      goldenFloat64Ptr(60),
				VBR:      goldenFloat64Ptr(5400),
				VCodec:   "avc1.64002a",
				ACodec:   "none",
			},
			// DASH video-only 4K 60fps HDR10 WebM
			{
				FormatID:     "337",
				URL:          "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=337&clen=410000000&sig=S337",
				Ext:          "webm",
				Protocol:     "https",
				Width:        goldenInt64Ptr(3840),
				Height:       goldenInt64Ptr(2160),
				FPS:          goldenFloat64Ptr(60),
				DynamicRange: "HDR10",
				VBR:          goldenFloat64Ptr(18500),
				VCodec:       "vp9.2",
				ACodec:       "none",
				Filesize:     goldenInt64Ptr(410000000),
			},
			// Standalone audio: dubbed track (lower LanguagePreference, must lose despite higher ABR)
			{
				FormatID:           "140-dub",
				URL:                "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=140&xtags=dub&sig=SDUB",
				Ext:                "m4a",
				Protocol:           "https",
				VCodec:             "none",
				ACodec:             "mp4a.40.2",
				ABR:                goldenFloat64Ptr(192.0),
				ASR:                goldenInt64Ptr(44100),
				AudioChannels:      goldenInt64Ptr(2),
				LanguagePreference: goldenIntPtr(-1),
			},
			// Standalone audio: DRC track (must lose to standard 140)
			{
				FormatID:           "140-drc",
				URL:                "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=140&xtags=drc&sig=SDRC",
				Ext:                "m4a",
				Protocol:           "https",
				VCodec:             "none",
				ACodec:             "mp4a.40.2",
				ABR:                goldenFloat64Ptr(130.0),
				ASR:                goldenInt64Ptr(44100),
				AudioChannels:      goldenInt64Ptr(2),
				LanguagePreference: goldenIntPtr(10),
			},
			// Standalone audio: best M4A AAC original track
			{
				FormatID:           "140",
				URL:                "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=140&clen=5044939&sig=S140",
				Ext:                "m4a",
				Protocol:           "https",
				VCodec:             "none",
				ACodec:             "mp4a.40.2",
				ABR:                goldenFloat64Ptr(129.4),
				ASR:                goldenInt64Ptr(44100),
				AudioChannels:      goldenInt64Ptr(2),
				LanguagePreference: goldenIntPtr(10),
				Filesize:           goldenInt64Ptr(5044939),
			},
			// Standalone audio: WebM Vorbis (must lose to Opus 251)
			{
				FormatID:           "171",
				URL:                "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=171&sig=S171",
				Ext:                "webm",
				Protocol:           "https",
				VCodec:             "none",
				ACodec:             "vorbis",
				ABR:                goldenFloat64Ptr(128.0),
				ASR:                goldenInt64Ptr(44100),
				AudioChannels:      goldenInt64Ptr(2),
				LanguagePreference: goldenIntPtr(10),
			},
			// Standalone audio: best WebM Opus original track
			{
				FormatID:           "251",
				URL:                "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=251&clen=6407118&sig=S251",
				Ext:                "webm",
				Protocol:           "https",
				VCodec:             "none",
				ACodec:             "opus",
				ABR:                goldenFloat64Ptr(135.6),
				ASR:                goldenInt64Ptr(48000),
				AudioChannels:      goldenInt64Ptr(2),
				LanguagePreference: goldenIntPtr(10),
				Filesize:           goldenInt64Ptr(6407118),
			},
		},
	}

	entryKey := resolveEntryKey(info, contentID, 1)
	variants, att := buildEntryVariants(info, info, entryKey, info.Title, opts, now)

	wantVariants := []struct {
		id        string
		label     string
		hasAudio  bool
		container string
		ext       string
		mime      string
		urlSubstr string
	}{
		{
			id:        "v-" + shortDigest("youtube:dashv-file:"+entryKey+":337"),
			label:     "2160p60 (4K · HDR · 仅视频无声)",
			hasAudio:  false,
			container: "webm",
			ext:       "webm",
			mime:      "video/webm",
			urlSubstr: "itag=337",
		},
		{
			id:        "v-" + shortDigest("youtube:dashv-file:"+entryKey+":299"),
			label:     "1080p60 (仅视频无声)",
			hasAudio:  false,
			container: "mp4",
			ext:       "mp4",
			mime:      "video/mp4",
			urlSubstr: "itag=299",
		},
		{
			id:        "v-" + shortDigest("youtube:dashv-file:"+entryKey+":298"),
			label:     "720p60 (仅视频无声)",
			hasAudio:  false,
			container: "mp4",
			ext:       "mp4",
			mime:      "video/mp4",
			urlSubstr: "itag=298",
		},
		{
			id:        "v-" + shortDigest("youtube:file:"+entryKey+":22"),
			label:     "720p (含音频)",
			hasAudio:  true,
			container: "mp4",
			ext:       "mp4",
			mime:      "video/mp4",
			urlSubstr: "title=Golden_4K_Test_720p",
		},
		{
			id:        "v-" + shortDigest("youtube:file:"+entryKey+":18"),
			label:     "360p (含音频)",
			hasAudio:  true,
			container: "mp4",
			ext:       "mp4",
			mime:      "video/mp4",
			urlSubstr: "title=Golden_4K_Test_360p",
		},
		{
			id:        "v-" + shortDigest("youtube:dasha-file:"+entryKey+":140"),
			label:     "仅音频 M4A (129 kbps)",
			hasAudio:  true,
			container: "mp4",
			ext:       "m4a",
			mime:      "audio/mp4",
			urlSubstr: "sig=S140",
		},
		{
			id:        "v-" + shortDigest("youtube:dasha-file:"+entryKey+":251"),
			label:     "仅音频 WEBM (136 kbps)",
			hasAudio:  true,
			container: "webm",
			ext:       "webm",
			mime:      "audio/webm",
			urlSubstr: "sig=S251",
		},
	}

	if len(variants) != len(wantVariants) {
		t.Fatalf("len(variants) = %d, want %d\ngot=%+v", len(variants), len(wantVariants), variants)
	}
	for i, want := range wantVariants {
		v := unified.Map(variants[i])
		if unified.Str(v["id"]) != want.id || unified.Str(v["label"]) != want.label {
			t.Fatalf("variant[%d] = (id=%v, label=%v), want (id=%s, label=%s)", i, v["id"], v["label"], want.id, want.label)
		}
		meta := unified.Map(v["metadata"])
		if meta["has_audio"] != want.hasAudio ||
			unified.Str(meta["container"]) != want.container ||
			unified.Str(meta["extension"]) != want.ext ||
			unified.Str(meta["mime_type"]) != want.mime {
			t.Fatalf("variant[%d] unexpected metadata: %+v", i, meta)
		}
		delivery := unified.Map(v["delivery"])
		if unified.Str(delivery["kind"]) != "file" {
			t.Fatalf("variant[%d] expected kind=file, got %+v", i, delivery)
		}
		src := unified.Map(unified.Slice(delivery["sources"])[0])
		if !strings.Contains(unified.Str(src["url"]), want.urlSubstr) {
			t.Fatalf("variant[%d] url %q missing %q", i, src["url"], want.urlSubstr)
		}
	}
	if hdr := unified.Str(unified.Map(unified.Map(variants[0])["metadata"])["hdr_type"]); hdr != "hdr10" {
		t.Fatalf("expected 4K HDR variant hdr_type=hdr10, got %q", hdr)
	}

	// Deep check on background_audio attachment.
	if att == nil {
		t.Fatal("expected non-nil background_audio attachment")
	}
	wantAttID := "att-" + shortDigest("youtube:att-audio:"+contentID+":"+entryKey)
	if unified.Str(att["id"]) != wantAttID || unified.Str(att["role"]) != "background_audio" {
		t.Fatalf("unexpected attachment identity: %+v", att)
	}
	if unified.Str(att["title"]) != "Golden 4K Test (M4A · 129 kbps)" {
		t.Fatalf("unexpected attachment title: %q", att["title"])
	}
	attAuthor := unified.Map(att["author"])
	if unified.Str(attAuthor["name"]) != "Golden Channel" || unified.Str(attAuthor["id"]) != "@golden" {
		t.Fatalf("unexpected attachment author: %+v", attAuthor)
	}
	attRes := unified.Map(att["resource"])
	attSrc := unified.Map(unified.Slice(unified.Map(attRes["delivery"])["sources"])[0])
	if unified.Str(attRes["role"]) != "audio" || !strings.Contains(unified.Str(attSrc["url"]), "sig=S140") {
		t.Fatalf("expected attachment resource to select original M4A 140, got %+v", attRes)
	}

	// Full AdaptInfo envelope check: default selects 720p progressive audiovisual MP4.
	env := AdaptInfo(info, opts, now)
	assertGoldenVariantEnvelopeValid(t, env, now, "OK")
	data := unified.Map(env["data"])
	if len(unified.Slice(data["attachments"])) != 1 {
		t.Fatalf("expected 1 envelope attachment, got %+v", data["attachments"])
	}
	item := unified.Map(unified.Slice(data["items"])[0])
	if unified.Str(unified.Map(item["default"])["variant_id"]) != wantVariants[3].id {
		t.Fatalf("expected 720p progressive MP4 (%s) as item.default, got %+v", wantVariants[3].id, item["default"])
	}
}

func TestGoldenBuildEntryVariantsCodecLessProgressiveDimensionInheritance(t *testing.T) {
	const now int64 = 1762300800

	t.Run("single-codecless-mp4-inherits-entry-dimensions", func(t *testing.T) {
		entry := &Info{
			ID:     "igSingle1",
			Title:  "Single Stream IG",
			Width:  goldenInt64Ptr(1080),
			Height: goldenInt64Ptr(1920),
			Formats: []Format{
				{
					FormatID: "0",
					URL:      "https://scontent-nrt1-1.cdninstagram.com/v/t50.2886-16/single.mp4?efg=1",
					Ext:      "mp4",
					Protocol: "https",
				},
			},
		}
		opts := AdaptOptions{
			PlatformID:                   "instagram",
			ContentID:                    "igSingle1",
			SourceURL:                    "https://www.instagram.com/reel/igSingle1/",
			AllowCodecLessProgressiveMP4: true,
		}
		variants, att := buildEntryVariants(entry, entry, "single.mp4", entry.Title, opts, now)
		if att != nil || len(variants) != 1 {
			t.Fatalf("expected 1 variant and nil attachment, got variants=%+v att=%+v", variants, att)
		}
		v := unified.Map(variants[0])
		if unified.Str(v["label"]) != "1080p" {
			t.Fatalf("expected inherited short-edge label 1080p, got %q", v["label"])
		}
		if !strings.HasPrefix(unified.Str(v["id"]), "v-") || strings.HasPrefix(unified.Str(v["id"]), "v-hd-") || strings.HasPrefix(unified.Str(v["id"]), "v-sd-") {
			t.Fatalf("expected standard v- prefix when dimensions are inherited, got %q", v["id"])
		}
		meta := unified.Map(v["metadata"])
		if meta["width"] != int64(1080) || meta["height"] != int64(1920) {
			t.Fatalf("expected inherited 1080x1920 metadata, got %+v", meta)
		}
		if _, hasAudioExists := meta["has_audio"]; hasAudioExists {
			t.Fatalf("expected unknown codec has_audio to be omitted, got %+v", meta)
		}
		env := AdaptInfo(entry, opts, now)
		assertGoldenVariantEnvelopeValid(t, env, now, "OK")
	})

	t.Run("silent-codecless-mp4-when-entry-has-no-audio", func(t *testing.T) {
		entry := &Info{
			ID:     "igSilent1",
			Title:  "Silent Vintage Reel",
			Width:  goldenInt64Ptr(720),
			Height: goldenInt64Ptr(1280),
			Formats: []Format{
				{
					FormatID: "0",
					URL:      "https://scontent-nrt1-1.cdninstagram.com/v/t50.2886-16/silent.mp4",
					Ext:      "mp4",
					Protocol: "https",
					VCodec:   "",
					ACodec:   "none",
				},
			},
		}
		opts := AdaptOptions{
			PlatformID:                   "instagram",
			ContentID:                    "igSilent1",
			SourceURL:                    "https://www.instagram.com/reel/igSilent1/",
			AllowCodecLessProgressiveMP4: true,
		}
		variants, _ := buildEntryVariants(entry, entry, "silent.mp4", entry.Title, opts, now)
		if len(variants) != 1 {
			t.Fatalf("expected 1 silent progressive MP4 variant, got %+v", variants)
		}
		v := unified.Map(variants[0])
		meta := unified.Map(v["metadata"])
		if unified.Str(v["label"]) != "720p" || meta["has_audio"] != false || meta["width"] != int64(720) || meta["height"] != int64(1280) {
			t.Fatalf("unexpected silent codec-less MP4 variant: %+v", v)
		}
		env := AdaptInfo(entry, opts, now)
		assertGoldenVariantEnvelopeValid(t, env, now, "OK")
	})

	t.Run("multiple-distinct-progressive-mp4-urls-do-not-inherit-entry-dimensions", func(t *testing.T) {
		entry := &Info{
			ID:     "fbMultiTier",
			Title:  "SD and HD Tiers",
			Width:  goldenInt64Ptr(1280),
			Height: goldenInt64Ptr(720),
			Formats: []Format{
				{
					FormatID: "sd",
					URL:      "https://video-nrt6-1.xx.fbcdn.net/v/sd_stream.mp4",
					Ext:      "mp4",
					Protocol: "https",
				},
				{
					FormatID: "hd",
					URL:      "https://video-nrt6-1.xx.fbcdn.net/v/hd_stream.mp4",
					Ext:      "mp4",
					Protocol: "https",
				},
			},
		}
		opts := AdaptOptions{
			PlatformID:                   "facebook",
			ContentID:                    "fbMultiTier",
			SourceURL:                    "https://www.facebook.com/watch/?v=123456",
			AllowCodecLessProgressiveMP4: true,
		}
		variants, _ := buildEntryVariants(entry, entry, "fb-entry", entry.Title, opts, now)
		if len(variants) != 2 {
			t.Fatalf("expected 2 variants [HD, SD], got %+v", variants)
		}
		vHD := unified.Map(variants[0])
		vSD := unified.Map(variants[1])
		if unified.Str(vHD["label"]) != "HD" || !strings.HasPrefix(unified.Str(vHD["id"]), "v-hd-") {
			t.Fatalf("expected first variant HD with v-hd- prefix, got %+v", vHD)
		}
		if unified.Str(vSD["label"]) != "SD" || !strings.HasPrefix(unified.Str(vSD["id"]), "v-sd-") {
			t.Fatalf("expected second variant SD with v-sd- prefix, got %+v", vSD)
		}
		if _, hasW := unified.Map(vSD["metadata"])["width"]; hasW {
			t.Fatalf("multi-URL SD format must not inherit entry 1280x720 dimensions: %+v", vSD["metadata"])
		}
		env := AdaptInfo(entry, opts, now)
		assertGoldenVariantEnvelopeValid(t, env, now, "OK")
	})

	t.Run("codecless-mp4-rejected-when-disabled-or-dash-tagged", func(t *testing.T) {
		entry := &Info{
			ID:     "reject1",
			Width:  goldenInt64Ptr(1280),
			Height: goldenInt64Ptr(720),
			Formats: []Format{
				{
					FormatID:   "dash-hd",
					FormatNote: "DASH video",
					URL:        "https://video-nrt6-1.xx.fbcdn.net/v/dash_stream.mp4",
					Ext:        "mp4",
					Protocol:   "https",
				},
			},
		}
		variants, _ := buildEntryVariants(entry, entry, "reject-entry", "", AdaptOptions{
			PlatformID:                   "facebook",
			ContentID:                    "reject1",
			SourceURL:                    "https://www.facebook.com/watch/?v=999",
			AllowCodecLessProgressiveMP4: true,
		}, now)
		if len(variants) != 0 {
			t.Fatalf("expected DASH-noted codec-less MP4 to be rejected, got %+v", variants)
		}
	})
}

func TestGoldenBuildEntryVariantsAdaptiveHLSPairing(t *testing.T) {
	const now int64 = 1762300800

	t.Run("with-external-hls-audio-pairing-and-embedded-audio-coexistence", func(t *testing.T) {
		entry := &Info{
			ID:       "hlsPair01",
			Title:    "Adaptive HLS Stream",
			Uploader: "HLSAuthor",
			Formats: []Format{
				{
					FormatID: "hls-audio-64",
					URL:      "https://cdn.example.com/hls/audio_64.m3u8",
					Ext:      "m4a",
					Protocol: "m3u8_native",
					VCodec:   "none",
					ACodec:   "mp4a.40.5",
					ABR:      goldenFloat64Ptr(64),
				},
				{
					FormatID: "hls-audio-160",
					URL:      "https://cdn.example.com/hls/audio_160.m3u8",
					Ext:      "m4a",
					Protocol: "m3u8_native",
					VCodec:   "none",
					ACodec:   "mp4a.40.2",
					ABR:      goldenFloat64Ptr(160),
				},
				{
					FormatID: "hls-v1080",
					URL:      "https://cdn.example.com/hls/v1080.m3u8",
					Ext:      "mp4",
					Protocol: "m3u8_native",
					Width:    goldenInt64Ptr(1920),
					Height:   goldenInt64Ptr(1080),
					FPS:      goldenFloat64Ptr(60),
					TBR:      goldenFloat64Ptr(4500),
					VCodec:   "avc1.64002a",
					ACodec:   "none",
				},
				{
					FormatID: "hls-mux480",
					URL:      "https://cdn.example.com/hls/mux480.m3u8",
					Ext:      "mp4",
					Protocol: "m3u8_native",
					Width:    goldenInt64Ptr(854),
					Height:   goldenInt64Ptr(480),
					FPS:      goldenFloat64Ptr(30),
					TBR:      goldenFloat64Ptr(950),
					VCodec:   "avc1.4d401e",
					ACodec:   "mp4a.40.2",
				},
			},
		}
		opts := AdaptOptions{
			PlatformID: "vimeo",
			ContentID:  "hlsPair01",
			SourceURL:  "https://vimeo.com/123456789",
			EnableHLS:  true,
		}

		variants, att := buildEntryVariants(entry, entry, "hlsPair01-entry", entry.Title, opts, now)
		if att != nil || len(variants) != 2 {
			t.Fatalf("expected 2 adaptive HLS variants and nil attachment, got variants=%+v att=%+v", variants, att)
		}

		v0 := unified.Map(variants[0])
		if unified.Str(v0["id"]) != "v-"+shortDigest("vimeo:hls:hlsPair01-entry:hls-v1080") ||
			unified.Str(v0["label"]) != "1080p60 (HLS 需合流)" {
			t.Fatalf("unexpected v0: %+v", v0)
		}
		if unified.Map(v0["metadata"])["has_audio"] != false {
			t.Fatalf("expected v0 has_audio=false, got %+v", v0["metadata"])
		}
		d0 := unified.Map(v0["delivery"])
		sel0 := unified.Map(d0["selection"])
		if unified.Str(d0["kind"]) != "hls" || unified.Str(d0["scope"]) != "adaptive" ||
			unified.Str(sel0["video_representation_id"]) != "hls-v1080" ||
			unified.Str(sel0["audio_representation_id"]) != "hls-audio-160" {
			t.Fatalf("expected v0 adaptive HLS paired with best audio hls-audio-160, got %+v", d0)
		}

		v1 := unified.Map(variants[1])
		if unified.Str(v1["id"]) != "v-"+shortDigest("vimeo:hls:hlsPair01-entry:hls-mux480") ||
			unified.Str(v1["label"]) != "480p (HLS 需合流)" {
			t.Fatalf("unexpected v1: %+v", v1)
		}
		if unified.Map(v1["metadata"])["has_audio"] != true {
			t.Fatalf("expected v1 has_audio=true, got %+v", v1["metadata"])
		}
		sel1 := unified.Map(unified.Map(v1["delivery"])["selection"])
		if unified.Str(sel1["video_representation_id"]) != "hls-mux480" {
			t.Fatalf("unexpected v1 video_representation_id: %+v", sel1)
		}
		if _, hasAudioRep := sel1["audio_representation_id"]; hasAudioRep {
			t.Fatalf("embedded-audio HLS variant must not set audio_representation_id: %+v", sel1)
		}

		env := AdaptInfo(entry, opts, now)
		assertGoldenVariantEnvelopeValid(t, env, now, "OK")
	})

	t.Run("without-external-hls-audio-tracks", func(t *testing.T) {
		entry := &Info{
			ID:       "hlsNoAudio02",
			Title:    "Silent Adaptive HLS",
			Uploader: "HLSAuthor",
			Formats: []Format{
				{
					FormatID: "hls-v720",
					URL:      "https://cdn.example.com/hls/v720_silent.m3u8",
					Ext:      "mp4",
					Protocol: "m3u8_native",
					Width:    goldenInt64Ptr(1280),
					Height:   goldenInt64Ptr(720),
					VCodec:   "avc1.4d401f",
					ACodec:   "none",
				},
			},
		}
		opts := AdaptOptions{
			PlatformID: "vimeo",
			ContentID:  "hlsNoAudio02",
			SourceURL:  "https://vimeo.com/987654321",
			EnableHLS:  true,
		}

		variants, _ := buildEntryVariants(entry, entry, "hlsNoAudio02-entry", entry.Title, opts, now)
		if len(variants) != 1 {
			t.Fatalf("expected 1 adaptive HLS variant, got %+v", variants)
		}
		v := unified.Map(variants[0])
		sel := unified.Map(unified.Map(v["delivery"])["selection"])
		if unified.Str(v["label"]) != "720p (HLS 需合流)" || unified.Str(sel["video_representation_id"]) != "hls-v720" {
			t.Fatalf("unexpected silent adaptive HLS variant: %+v", v)
		}
		if _, hasAudioRep := sel["audio_representation_id"]; hasAudioRep {
			t.Fatalf("expected no audio_representation_id when hlsAudioFormats is empty, got %+v", sel)
		}

		env := AdaptInfo(entry, opts, now)
		assertGoldenVariantEnvelopeValid(t, env, now, "OK")
	})
}

func TestAdaptInfoAllowAudioOnlyAndProgressiveWebM(t *testing.T) {
	const now int64 = 1762300800

	t.Run("audio-only-disabled-by-default-returns-NO_MEDIA", func(t *testing.T) {
		info := &Info{
			ID:           "sc-track-1",
			Title:        "Ambient Synth",
			Uploader:     "Artist",
			ExtractorKey: "Soundcloud",
			Formats: []Format{
				{
					FormatID: "http_mp3_128",
					URL:      "https://cf-media.sndcdn.com/track/ambient.mp3",
					Ext:      "mp3",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "mp3",
					ABR:      goldenFloat64Ptr(128),
				},
			},
		}
		env := AdaptInfo(info, AdaptOptions{
			PlatformID: "soundcloud",
			ContentID:  "sc-track-1",
			SourceURL:  "https://soundcloud.com/artist/ambient-synth",
		}, now)
		assertGoldenVariantEnvelopeValid(t, env, now, "NO_MEDIA")
	})

	t.Run("audio-only-enabled-emits-audio-item-all-mime-types-and-dedups", func(t *testing.T) {
		info := &Info{
			ID:           "bc-track-42",
			Title:        "Lossless Session",
			Uploader:     "BandcampArtist",
			Duration:     goldenFloat64Ptr(215.4),
			Thumbnail:    "https://f4.bcbits.com/img/a12345_10.jpg",
			ExtractorKey: "Bandcamp",
			Formats: []Format{
				{
					FormatID: "mp3-320",
					URL:      "https://t4.bcbits.com/stream/track_320.mp3",
					Ext:      "mp3",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "mp3",
					ABR:      goldenFloat64Ptr(320),
					Filesize: goldenInt64Ptr(8600000),
				},
				{
					FormatID: "mp3-128-a",
					URL:      "https://t4.bcbits.com/stream/track_128_a.mp3",
					Ext:      "mp3",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "mp3",
					ABR:      goldenFloat64Ptr(128),
				},
				// Duplicate container+bitrate (mp3:128) -> must be deduplicated
				{
					FormatID: "mp3-128-b",
					URL:      "https://t4.bcbits.com/stream/track_128_b.mp3",
					Ext:      "mp3",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "mp3",
					ABR:      goldenFloat64Ptr(128),
				},
				{
					FormatID: "m4a-256",
					URL:      "https://t4.bcbits.com/stream/track_256.m4a",
					Ext:      "m4a",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "mp4a.40.2",
					ABR:      goldenFloat64Ptr(256),
				},
				// Same container (mp4) + bitrate (256) as m4a-256 -> must be deduplicated
				{
					FormatID: "mp4-audio-256",
					URL:      "https://t4.bcbits.com/stream/track_256.mp4",
					Ext:      "mp4",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "mp4a.40.2",
					ABR:      goldenFloat64Ptr(256),
				},
				{
					FormatID: "webm-160",
					URL:      "https://t4.bcbits.com/stream/track_160.webm",
					Ext:      "webm",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "opus",
					ABR:      goldenFloat64Ptr(160),
				},
				{
					FormatID: "ogg-192",
					URL:      "https://t4.bcbits.com/stream/track_192.ogg",
					Ext:      "ogg",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "vorbis",
					ABR:      goldenFloat64Ptr(192),
				},
				{
					FormatID: "opus-128",
					URL:      "https://t4.bcbits.com/stream/track_128.opus",
					Ext:      "opus",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "opus",
					ABR:      goldenFloat64Ptr(128),
				},
				{
					FormatID: "flac-1000",
					URL:      "https://t4.bcbits.com/stream/track.flac",
					Ext:      "flac",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "flac",
					ABR:      goldenFloat64Ptr(1000),
				},
				{
					FormatID: "wav-1411",
					URL:      "https://t4.bcbits.com/stream/track.wav",
					Ext:      "wav",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "pcm_s16le",
					ABR:      goldenFloat64Ptr(1411),
				},
				// Unsupported extension -> skipped
				{
					FormatID: "bad-ext",
					URL:      "https://t4.bcbits.com/stream/track.mhtml",
					Ext:      "mhtml",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "unknown_codec",
				},
				// HLS audio-only -> ignored as file
				{
					FormatID: "hls-mp3",
					URL:      "https://t4.bcbits.com/stream/playlist.m3u8",
					Ext:      "mp3",
					Protocol: "m3u8_native",
					VCodec:   "none",
					ACodec:   "mp3",
				},
			},
		}
		opts := AdaptOptions{
			PlatformID:     "bandcamp",
			ContentID:      "bc-track-42",
			SourceURL:      "https://artist.bandcamp.com/track/lossless-session",
			AllowAudioOnly: true,
			EnableDASHMux:  true,
			EnableHLS:      true,
		}
		env := AdaptInfo(info, opts, now)
		assertGoldenVariantEnvelopeValid(t, env, now, "OK")

		data := unified.Map(env["data"])
		if _, hasAtt := data["attachments"]; hasAtt {
			t.Fatalf("audio-only item must not emit redundant attachments: %+v", data["attachments"])
		}
		items := unified.Slice(data["items"])
		if len(items) != 1 {
			t.Fatalf("expected 1 audio item, got %d", len(items))
		}
		item := unified.Map(items[0])
		if unified.Str(item["type"]) != "audio" {
			t.Fatalf("item type = %q, want audio", item["type"])
		}
		if !strings.HasPrefix(unified.Str(item["id"]), "audio-") {
			t.Fatalf("audio item id = %q, want audio- prefix", item["id"])
		}
		if item["default"] == nil {
			t.Fatalf("expected audio item to select a non-nil default file variant")
		}

		variants := unified.Slice(item["variants"])
		// 8 unique container+bitrate variants: m4a(256), webm(160), opus(128), wav(1411), flac(1000), mp3(320), ogg(192), mp3(128)
		if len(variants) != 8 {
			t.Fatalf("expected 8 deduplicated audio variants, got %d: %+v", len(variants), variants)
		}
		seenMimes := make(map[string]int)
		for _, rawV := range variants {
			v := unified.Map(rawV)
			if unified.Str(unified.Map(v["delivery"])["kind"]) != "file" {
				t.Fatalf("expected kind=file for audio variant, got %+v", v["delivery"])
			}
			mime := unified.Str(unified.Map(v["metadata"])["mime_type"])
			seenMimes[mime]++
		}
		wantMimes := map[string]int{
			"audio/mpeg": 2, // 320k + 128k
			"audio/mp4":  1, // m4a 256k (mp4 256k deduped)
			"audio/webm": 1,
			"audio/ogg":  2, // ogg 192k + opus 128k
			"audio/flac": 1,
			"audio/wav":  1,
		}
		for mime, wantCount := range wantMimes {
			if seenMimes[mime] != wantCount {
				t.Fatalf("mime %q count = %d, want %d (all=%+v)", mime, seenMimes[mime], wantCount, seenMimes)
			}
		}
	})

	t.Run("audio-only-does-not-override-when-video-exists", func(t *testing.T) {
		info := &Info{
			ID:    "vid-and-audio",
			Title: "Video With Audio",
			Formats: []Format{
				{
					FormatID: "mp4-720",
					URL:      "https://cdn.example.com/video720.mp4",
					Ext:      "mp4",
					Protocol: "https",
					Width:    goldenInt64Ptr(1280),
					Height:   goldenInt64Ptr(720),
					VCodec:   "avc1.4d401f",
					ACodec:   "mp4a.40.2",
				},
				{
					FormatID: "mp3-128",
					URL:      "https://cdn.example.com/audio.mp3",
					Ext:      "mp3",
					Protocol: "https",
					VCodec:   "none",
					ACodec:   "mp3",
					ABR:      goldenFloat64Ptr(128),
				},
			},
		}
		env := AdaptInfo(info, AdaptOptions{
			PlatformID:     "vimeo",
			ContentID:      "vid-and-audio",
			SourceURL:      "https://vimeo.com/111111",
			AllowAudioOnly: true,
		}, now)
		assertGoldenVariantEnvelopeValid(t, env, now, "OK")
		item := unified.Map(unified.Slice(unified.Map(env["data"])["items"])[0])
		if unified.Str(item["type"]) != "video" || !strings.HasPrefix(unified.Str(item["id"]), "video-") {
			t.Fatalf("expected video item when video variants exist, got type=%v id=%v", item["type"], item["id"])
		}
	})

	t.Run("progressive-webm-opt-in-and-size-probing", func(t *testing.T) {
		makeInfo := func() *Info {
			return &Info{
				ID:    "webm-1",
				Title: "Progressive WebM Clip",
				Formats: []Format{
					{
						FormatID: "webm-720",
						URL:      "https://cdn.example.com/clip720.webm",
						Ext:      "webm",
						Protocol: "https",
						Width:    goldenInt64Ptr(1280),
						Height:   goldenInt64Ptr(720),
						VCodec:   "vp9",
						ACodec:   "opus",
						ABR:      goldenFloat64Ptr(128),
					},
					// Invalid as progressive WebM: m3u8 path / missing codec / none codec
					{
						FormatID: "webm-m3u8",
						URL:      "https://cdn.example.com/clip.m3u8",
						Ext:      "webm",
						Protocol: "https",
						VCodec:   "vp9",
						ACodec:   "opus",
					},
					{
						FormatID: "webm-silent",
						URL:      "https://cdn.example.com/silent.webm",
						Ext:      "webm",
						Protocol: "https",
						VCodec:   "vp9",
						ACodec:   "none",
					},
				},
			}
		}

		// Default AllowProgressiveWebM=false -> progressive WebM ignored (NO_MEDIA) and not size-probed.
		offOpts := AdaptOptions{
			PlatformID: "streamable",
			ContentID:  "webm-1",
			SourceURL:  "https://streamable.com/abc123",
		}
		offInfo := makeInfo()
		probedOff := false
		PopulateMissingMP4Sizes(context.Background(), offInfo, func(_ context.Context, _ string) (int64, bool) {
			probedOff = true
			return 555555, true
		}, offOpts)
		if probedOff {
			t.Fatal("PopulateMissingMP4Sizes must not probe progressive WebM when AllowProgressiveWebM is false")
		}
		envOff := AdaptInfo(offInfo, offOpts, now)
		assertGoldenVariantEnvelopeValid(t, envOff, now, "NO_MEDIA")

		// Opt-in AllowProgressiveWebM=true -> probed and emitted as video/webm file variant.
		onOpts := AdaptOptions{
			PlatformID:           "streamable",
			ContentID:            "webm-1",
			SourceURL:            "https://streamable.com/abc123",
			AllowProgressiveWebM: true,
		}
		onInfo := makeInfo()
		var probedURLs []string
		PopulateMissingMP4Sizes(context.Background(), onInfo, func(_ context.Context, rawURL string) (int64, bool) {
			probedURLs = append(probedURLs, rawURL)
			return 4444444, true
		}, onOpts)
		if len(probedURLs) != 1 || probedURLs[0] != "https://cdn.example.com/clip720.webm" {
			t.Fatalf("expected only progressive WebM to be size-probed, got %v", probedURLs)
		}
		envOn := AdaptInfo(onInfo, onOpts, now)
		assertGoldenVariantEnvelopeValid(t, envOn, now, "OK")
		item := unified.Map(unified.Slice(unified.Map(envOn["data"])["items"])[0])
		variants := unified.Slice(item["variants"])
		if len(variants) != 1 {
			t.Fatalf("expected 1 progressive WebM variant, got %d: %+v", len(variants), variants)
		}
		v := unified.Map(variants[0])
		meta := unified.Map(v["metadata"])
		if unified.Str(meta["container"]) != "webm" ||
			unified.Str(meta["extension"]) != "webm" ||
			unified.Str(meta["mime_type"]) != "video/webm" ||
			meta["has_audio"] != true {
			t.Fatalf("unexpected progressive WebM metadata: %+v", meta)
		}
		src := unified.Map(unified.Slice(unified.Map(v["delivery"])["sources"])[0])
		if src["size_bytes"] != int64(4444444) {
			t.Fatalf("expected probed size_bytes=4444444, got %+v", src)
		}
	})
}
