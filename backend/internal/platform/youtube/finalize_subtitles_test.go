package youtube

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func TestAllowYouTubeTimedtextURL(t *testing.T) {
	valid := []string{
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://WWW.YOUTUBE.COM/api/timedtext?v=I9JvDaciaFk&ei=abc&expire=1794238131&sparams=v,ei,expire,lang&signature=SIG_123&key=yt8&lang=zh-Hans",
		"https://www.youtube.com:443/api/timedtext?v=I9JvDaciaFk&lang=ja&fmt=vtt",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en&sig=abc%2Bdef%23ghi",
		"https://www.youtube.com/api/timedtext",
	}
	for _, raw := range valid {
		if !AllowYouTubeTimedtextURL(raw) {
			t.Errorf("AllowYouTubeTimedtextURL(%q) = false, want true", raw)
		}
	}

	invalid := []string{
		"",
		"http://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://m.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://music.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://www.youtube.com./api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://evil-youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://www.youtube.com:8443/api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://www.youtube.com:0443/api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://www.youtube.com:/api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://user:pass@www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en#frag",
		"https://www.youtube.com/api/timedtext/extra?v=I9JvDaciaFk&lang=en",
		"https://www.youtube.com/api/%74imedtext?v=I9JvDaciaFk&lang=en",
		"https://www.youtube.com/watch?v=I9JvDaciaFk",
		" https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en\n",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en\\x",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en&x=" + strings.Repeat("a", maxTimedtextURLLength),
		// Forbidden credential / cookie / auth-like query keys (raw, uppercase, encoded, semicolon)
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&cookie=abc",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&COOKIE=abc",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&%63ookie=abc",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en;cookie=abc",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&authorization=Bearer123",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&auth=1",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&sapisid=xyz",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&SID=xyz",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&hsid=xyz",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&ssid=xyz",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&apisid=xyz",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lhid=xyz",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&access_token=xyz",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&id_token=xyz",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&session=xyz",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&token=xyz",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&%ZZ=bad",
	}
	for _, raw := range invalid {
		if AllowYouTubeTimedtextURL(raw) {
			t.Errorf("AllowYouTubeTimedtextURL(%q) = true, want false", raw)
		}
	}
}

func TestEnsureTimedtextFormatURLPreservesSparams(t *testing.T) {
	// 1. fmt absent and NOT in sparams -> appends &fmt=vtt preserving exact original bytes.
	base := "https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&ei=E1&expire=1794238131&sparams=v%2Cei%2Cexpire&signature=SIG_A%2BB&key=yt8&lang=en"
	gotURL, gotExt, gotMime, gotRank, ok := ensureTimedtextFormatURL(base)
	wantURL := base + "&fmt=vtt"
	if !ok || gotURL != wantURL || gotExt != "vtt" || gotMime != "text/vtt" || gotRank != 1 {
		t.Fatalf("got (%q, %q, %q, %d, %v), want (%q, vtt, text/vtt, 1, true)", gotURL, gotExt, gotMime, gotRank, ok, wantURL)
	}

	// 2. fmt absent BUT listed in sparams (plain or percent-encoded) -> MUST NOT mutate URL.
	for _, signed := range []string{
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&sparams=v,expire,fmt&signature=SIG&lang=en",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&sparams=v%2Cexpire%2Cfmt&signature=SIG&lang=en",
	} {
		u, ext, mime, rank, ok := ensureTimedtextFormatURL(signed)
		if !ok || u != signed || ext != "xml" || mime != "application/xml" || rank != 6 {
			t.Fatalf("signed sparams fmt mutated URL: got (%q, %q, %q, %d, %v), want (%q, xml, application/xml, 6, true)", u, ext, mime, rank, ok, signed)
		}
	}

	// 3. Known explicit fmt values map to controlled extensions/MIME/ranks without mutating URL.
	for _, tc := range []struct {
		fmtParam string
		wantExt  string
		wantMime string
		wantRank int
	}{
		{"vtt", "vtt", "text/vtt", 1},
		{"srt", "srt", "application/x-subrip", 2},
		{"ttml", "ttml", "application/ttml+xml", 3},
		{"srv3", "srv3", "application/xml", 4},
		{"json3", "json3", "application/json", 5},
		{"srv2", "xml", "application/xml", 6},
		{"srv1", "xml", "application/xml", 6},
		{"xml", "xml", "application/xml", 6},
	} {
		existing := "https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en&fmt=" + tc.fmtParam + "&signature=SIG"
		u, ext, mime, rank, ok := ensureTimedtextFormatURL(existing)
		if !ok || u != existing || ext != tc.wantExt || mime != tc.wantMime || rank != tc.wantRank {
			t.Fatalf("fmt=%s got (%q, %q, %q, %d, %v), want (%q, %q, %q, %d, true)",
				tc.fmtParam, u, ext, mime, rank, ok, existing, tc.wantExt, tc.wantMime, tc.wantRank)
		}
	}

	// 4. Unknown explicit fmt values are strictly rejected (never passed through as arbitrary extensions).
	for _, badFmt := range []string{"exe", "sh", "html", "arbitrary", ""} {
		badURL := "https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en&fmt=" + badFmt + "&signature=SIG"
		if _, _, _, _, ok := ensureTimedtextFormatURL(badURL); ok {
			t.Fatalf("expected unknown fmt=%q to be rejected", badFmt)
		}
	}
}

func TestFinalizeSubtitlesExtractionAndZeroDiffWithoutCaptions(t *testing.T) {
	currentNow := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	helper := newGoldenHelper(t, "a5c2aafe", nil, func() time.Time { return currentNow })
	const videoID = "I9JvDaciaFk"

	baseReq := func() map[string]any {
		return map[string]any{
			"video_id":  videoID,
			"player_id": "a5c2aafe",
			"title":     "Subtitle Golden Video",
			"formats": []any{
				map[string]any{
					"itag":     18,
					"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
					"width":    640,
					"height":   360,
					"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=18&n=N18",
				},
			},
			"adaptiveFormats": []any{
				map[string]any{
					"itag":     137,
					"mimeType": `video/mp4; codecs="avc1.640028"`,
					"width":    1920,
					"height":   1080,
					"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=137",
				},
				map[string]any{
					"itag":     140,
					"mimeType": `audio/mp4; codecs="mp4a.40.2"`,
					"bitrate":  128000,
					"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=140",
				},
			},
		}
	}

	// 1. Omitted captions -> 0 subtitle attachments (only existing background_audio).
	noCapBody, _ := json.Marshal(baseReq())
	noCapPayload, noCapStatus := helper.Finalize(context.Background(), noCapBody, false)
	if noCapStatus != http.StatusOK {
		t.Fatalf("no-captions status=%d payload=%#v", noCapStatus, noCapPayload)
	}
	if err := unified.ValidateEnvelopeAt(noCapPayload, currentNow.Unix()); err != nil {
		t.Fatalf("no-captions ValidateEnvelopeAt: %v", err)
	}
	noCapAtts := unified.Slice(unified.Map(noCapPayload["data"])["attachments"])
	if len(noCapAtts) != 1 || unified.Str(unified.Map(noCapAtts[0])["role"]) != "background_audio" {
		t.Fatalf("expected only 1 background_audio attachment when captions omitted, got %#v", noCapAtts)
	}

	// 2. With captions: manual + auto, simpleText + runs, dedup, sort, invalid URL fail-soft, sparams preserved.
	reqWithCaps := baseReq()
	signedSparamsFmtURL := "https://www.youtube.com/api/timedtext?v=" + videoID + "&lang=ja&sparams=v,lang,fmt&signature=SIG_JA"
	reqWithCaps["captions"] = map[string]any{
		"playerCaptionsTracklistRenderer": map[string]any{
			"captionTracks": []any{
				// Auto English track (uses runs[] and control chars to sanitize)
				map[string]any{
					"baseUrl":      "https://www.youtube.com/api/timedtext?v=" + videoID + "&lang=en&kind=asr&signature=SIG_EN_AUTO",
					"languageCode": "en",
					"kind":         "asr",
					"name": map[string]any{
						"runs": []any{
							map[string]any{"text": "English\x00 "},
							map[string]any{"text": "(auto-generated)\u200b"},
						},
					},
				},
				// Invalid host -> silently skipped
				map[string]any{
					"baseUrl":      "https://evil.example.com/api/timedtext?v=" + videoID + "&lang=fr",
					"languageCode": "fr",
					"name":         map[string]any{"simpleText": "Evil French"},
				},
				// Credential query param -> silently skipped
				map[string]any{
					"baseUrl":      "https://www.youtube.com/api/timedtext?v=" + videoID + "&lang=de&cookie=secret",
					"languageCode": "de",
					"name":         map[string]any{"simpleText": "German"},
				},
				// Cross-language tlang auto-translation -> silently skipped
				map[string]any{
					"baseUrl":      "https://www.youtube.com/api/timedtext?v=" + videoID + "&lang=en&tlang=es&signature=SIG_ES",
					"languageCode": "es",
					"name":         map[string]any{"simpleText": "Spanish"},
				},
				// Manual Japanese track with fmt in sparams -> URL MUST NOT be mutated!
				map[string]any{
					"baseUrl":      signedSparamsFmtURL,
					"languageCode": "ja",
					"name":         map[string]any{"simpleText": "日本語"},
				},
				// Manual English track (first occurrence wins dedup)
				map[string]any{
					"baseUrl":      "https://www.youtube.com/api/timedtext?v=" + videoID + "&lang=en&sparams=v,lang&signature=SIG_EN_1",
					"languageCode": "en",
					"name":         map[string]any{"simpleText": "English"},
				},
				// Duplicate manual English track -> deduplicated
				map[string]any{
					"baseUrl":      "https://www.youtube.com/api/timedtext?v=" + videoID + "&lang=en&sparams=v,lang&signature=SIG_EN_2",
					"languageCode": "en",
					"name":         map[string]any{"simpleText": "English Duplicate"},
				},
				// Manual Simplified Chinese track (should sort first among manual!)
				map[string]any{
					"baseUrl":      "https://www.youtube.com/api/timedtext?v=" + videoID + "&lang=zh-Hans&sparams=v,lang&signature=SIG_ZH",
					"languageCode": "zh_Hans",
					"name":         map[string]any{"simpleText": "中文（简体）"},
				},
			},
		},
	}

	capBody, _ := json.Marshal(reqWithCaps)
	for _, debug := range []bool{false, true} {
		payload, status := helper.Finalize(context.Background(), capBody, debug)
		if status != http.StatusOK {
			t.Fatalf("debug=%v: status=%d payload=%#v", debug, status, payload)
		}
		if err := unified.ValidateEnvelopeAt(payload, currentNow.Unix()); err != nil {
			t.Fatalf("debug=%v: ValidateEnvelopeAt failed: %v", debug, err)
		}
		atts := unified.Slice(unified.Map(payload["data"])["attachments"])
		// 1 background_audio + 4 subtitles (zh-Hans manual, en manual, ja manual, en auto)
		if len(atts) != 5 {
			t.Fatalf("debug=%v: attachments len = %d, want 5: %#v", debug, len(atts), atts)
		}
		if unified.Str(unified.Map(atts[0])["role"]) != "background_audio" {
			t.Fatalf("debug=%v: atts[0].role = %v, want background_audio", debug, unified.Map(atts[0])["role"])
		}

		wantOrder := []struct {
			lang      string
			trackKind string
			title     string
			wantURL   string
			wantExt   string
			wantMime  string
		}{
			{
				lang:      "zh-Hans",
				trackKind: "manual",
				title:     "中文（简体）",
				wantURL:   "https://www.youtube.com/api/timedtext?v=" + videoID + "&lang=zh-Hans&sparams=v,lang&signature=SIG_ZH&fmt=vtt",
				wantExt:   "vtt",
				wantMime:  "text/vtt",
			},
			{
				lang:      "en",
				trackKind: "manual",
				title:     "English",
				wantURL:   "https://www.youtube.com/api/timedtext?v=" + videoID + "&lang=en&sparams=v,lang&signature=SIG_EN_1&fmt=vtt",
				wantExt:   "vtt",
				wantMime:  "text/vtt",
			},
			{
				lang:      "ja",
				trackKind: "manual",
				title:     "日本語",
				wantURL:   signedSparamsFmtURL,
				wantExt:   "xml",
				wantMime:  "application/xml",
			},
			{
				lang:      "en",
				trackKind: "auto",
				title:     "English (auto-generated)",
				wantURL:   "https://www.youtube.com/api/timedtext?v=" + videoID + "&lang=en&kind=asr&signature=SIG_EN_AUTO&fmt=vtt",
				wantExt:   "vtt",
				wantMime:  "text/vtt",
			},
		}

		for i, want := range wantOrder {
			att := unified.Map(atts[i+1])
			if unified.Str(att["role"]) != "subtitle" {
				t.Fatalf("sub[%d].role = %q, want subtitle", i, unified.Str(att["role"]))
			}
			if unified.Str(att["language"]) != want.lang || unified.Str(att["track_kind"]) != want.trackKind || unified.Str(att["title"]) != want.title {
				t.Fatalf("sub[%d] = (lang=%q, kind=%q, title=%q), want (%q, %q, %q)",
					i, unified.Str(att["language"]), unified.Str(att["track_kind"]), unified.Str(att["title"]),
					want.lang, want.trackKind, want.title)
			}
			res := unified.Map(att["resource"])
			meta := unified.Map(res["metadata"])
			deliv := unified.Map(res["delivery"])
			src := unified.Map(unified.Slice(deliv["sources"])[0])
			if unified.Str(res["role"]) != "subtitle" || unified.Str(deliv["kind"]) != "file" || unified.Str(src["access"]) != "direct" {
				t.Fatalf("sub[%d] invalid resource/delivery/access: %#v", i, res)
			}
			if unified.Str(src["url"]) != want.wantURL {
				t.Fatalf("sub[%d] url = %q, want %q", i, unified.Str(src["url"]), want.wantURL)
			}
			if unified.Str(meta["extension"]) != want.wantExt || unified.Str(meta["mime_type"]) != want.wantMime {
				t.Fatalf("sub[%d] meta = (%q, %q), want (%q, %q)", i, unified.Str(meta["extension"]), unified.Str(meta["mime_type"]), want.wantExt, want.wantMime)
			}
		}
	}

	// 3. Cap enforcement: 80 raw entries -> at most 64 inspected, at most 32 emitted.
	manyTracks := make([]any, 80)
	for i := range manyTracks {
		code := fmt.Sprintf("aa-%02d", i)
		manyTracks[i] = map[string]any{
			"baseUrl":      fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=%s&signature=S%d", videoID, code, i),
			"languageCode": code,
			"name":         map[string]any{"simpleText": "Track " + code},
		}
	}
	// Put a track at index 70 (beyond MaxFinalizeCaptionTracksInspected=64): must NOT be inspected!
	manyTracks[70] = map[string]any{
		"baseUrl":      fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=zh-Hans&signature=BEYOND64", videoID),
		"languageCode": "zh-Hans",
		"name":         map[string]any{"simpleText": "Beyond Cap"},
	}
	reqCap := baseReq()
	reqCap["captions"] = map[string]any{
		"playerCaptionsTracklistRenderer": map[string]any{
			"captionTracks": manyTracks,
		},
	}
	capLimitBody, _ := json.Marshal(reqCap)
	capLimitPayload, capLimitStatus := helper.Finalize(context.Background(), capLimitBody, false)
	if capLimitStatus != http.StatusOK {
		t.Fatalf("cap-limit status=%d payload=%#v", capLimitStatus, capLimitPayload)
	}
	if err := unified.ValidateEnvelopeAt(capLimitPayload, currentNow.Unix()); err != nil {
		t.Fatalf("cap-limit ValidateEnvelopeAt: %v", err)
	}
	subCount := 0
	for _, rawAtt := range unified.Slice(unified.Map(capLimitPayload["data"])["attachments"]) {
		att := unified.Map(rawAtt)
		if unified.Str(att["role"]) == "subtitle" {
			subCount++
			if unified.Str(att["language"]) == "zh-Hans" {
				t.Fatalf("track beyond MaxFinalizeCaptionTracksInspected (index 70) should not have been inspected")
			}
		}
	}
	if subCount != MaxFinalizeSubtitleAttachments {
		t.Fatalf("emitted subtitle count = %d, want %d", subCount, MaxFinalizeSubtitleAttachments)
	}
}

func TestFinalizeSubtitlesRankDedupAndSafeExpiresAt(t *testing.T) {
	currentNow := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	helper := newGoldenHelper(t, "a5c2aafe", nil, func() time.Time { return currentNow })
	const videoID = "I9JvDaciaFk"

	futureExp := currentNow.Add(6 * time.Hour).Unix()
	wantFutureRFC3339 := time.Unix(futureExp, 0).UTC().Format(time.RFC3339)
	pastExp := currentNow.Add(-1 * time.Hour).Unix()
	tooFarExp := currentNow.Add(31 * 24 * time.Hour).Unix()

	req := map[string]any{
		"video_id":  videoID,
		"player_id": "a5c2aafe",
		"title":     "Rank and Expiry Video",
		"formats": []any{
			map[string]any{
				"itag":     18,
				"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
				"width":    640,
				"height":   360,
				"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=18&n=N18",
			},
		},
		"captions": map[string]any{
			"playerCaptionsTracklistRenderer": map[string]any{
				"captionTracks": []any{
					// Unknown fmt -> rejected
					map[string]any{
						"baseUrl":      "https://www.youtube.com/api/timedtext?v=" + videoID + "&lang=fr&fmt=exe",
						"languageCode": "fr",
						"name":         map[string]any{"simpleText": "Bad Fmt"},
					},
					// English: srv1 (rank 6) -> json3 (rank 5) -> vtt (rank 1, valid future expire) -> srt (rank 2) -> vtt #2 (rank 1)
					// Expect vtt #1 to win deterministically and carry expires_at!
					map[string]any{
						"baseUrl":      fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=srv1&expire=%d", videoID, futureExp),
						"languageCode": "en",
						"name":         map[string]any{"simpleText": "English SRV1"},
					},
					map[string]any{
						"baseUrl":      fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=json3&expire=%d", videoID, futureExp),
						"languageCode": "en",
						"name":         map[string]any{"simpleText": "English JSON3"},
					},
					map[string]any{
						"baseUrl":      fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=vtt&expire=%d&sig=FIRST", videoID, futureExp),
						"languageCode": "en",
						"name":         map[string]any{"simpleText": "English VTT First"},
					},
					map[string]any{
						"baseUrl":      fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=srt&expire=%d", videoID, futureExp),
						"languageCode": "en",
						"name":         map[string]any{"simpleText": "English SRT"},
					},
					map[string]any{
						"baseUrl":      fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=vtt&expire=%d&sig=SECOND", videoID, futureExp),
						"languageCode": "en",
						"name":         map[string]any{"simpleText": "English VTT Second"},
					},
					// Japanese: historical past expire -> expires_at MUST be omitted
					map[string]any{
						"baseUrl":      fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=ja&fmt=json3&expire=%d", videoID, pastExp),
						"languageCode": "ja",
						"name":         map[string]any{"simpleText": "日本語"},
					},
					// Korean: >30d expire -> expires_at MUST be omitted
					map[string]any{
						"baseUrl":      fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=ko&fmt=vtt&expires=%d", videoID, tooFarExp),
						"languageCode": "ko",
						"name":         map[string]any{"simpleText": "한국어"},
					},
				},
			},
		},
	}

	body, _ := json.Marshal(req)
	payload, status := helper.Finalize(context.Background(), body, false)
	if status != http.StatusOK {
		t.Fatalf("status=%d payload=%#v", status, payload)
	}
	if err := unified.ValidateEnvelopeAt(payload, currentNow.Unix()); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}

	byLang := make(map[string]unified.Object)
	for _, rawAtt := range unified.Slice(unified.Map(payload["data"])["attachments"]) {
		att := unified.Map(rawAtt)
		if unified.Str(att["role"]) == "subtitle" {
			byLang[unified.Str(att["language"])] = att
		}
	}
	if _, hasFr := byLang["fr"]; hasFr {
		t.Fatalf("unknown fmt=exe track should have been dropped")
	}
	if len(byLang) != 3 {
		t.Fatalf("expected 3 subtitles (en, ja, ko), got %d: %#v", len(byLang), byLang)
	}

	enSrc := unified.Map(unified.Slice(unified.Map(unified.Map(byLang["en"]["resource"])["delivery"])["sources"])[0])
	enMeta := unified.Map(unified.Map(byLang["en"]["resource"])["metadata"])
	if unified.Str(enMeta["extension"]) != "vtt" || !strings.Contains(unified.Str(enSrc["url"]), "sig=FIRST") {
		t.Fatalf("expected en to pick first vtt track, got ext=%v url=%v", enMeta["extension"], enSrc["url"])
	}
	if unified.Str(enSrc["expires_at"]) != wantFutureRFC3339 {
		t.Fatalf("en expires_at = %q, want %q", unified.Str(enSrc["expires_at"]), wantFutureRFC3339)
	}

	jaSrc := unified.Map(unified.Slice(unified.Map(unified.Map(byLang["ja"]["resource"])["delivery"])["sources"])[0])
	jaMeta := unified.Map(unified.Map(byLang["ja"]["resource"])["metadata"])
	if unified.Str(jaMeta["extension"]) != "json3" || unified.Str(jaMeta["mime_type"]) != "application/json" {
		t.Fatalf("expected ja json3 metadata, got %#v", jaMeta)
	}
	if _, exists := jaSrc["expires_at"]; exists {
		t.Fatalf("past expire must not set expires_at, got %#v", jaSrc["expires_at"])
	}

	koSrc := unified.Map(unified.Slice(unified.Map(unified.Map(byLang["ko"]["resource"])["delivery"])["sources"])[0])
	if _, exists := koSrc["expires_at"]; exists {
		t.Fatalf(">30d expire must not set expires_at, got %#v", koSrc["expires_at"])
	}

	// Zero nowTime never emits expires_at
	rawCaps, _ := json.Marshal(req["captions"])
	zeroAtts := extractFinalizeSubtitles(rawCaps, videoID, time.Time{})
	for _, rawAtt := range zeroAtts {
		src := unified.Map(unified.Slice(unified.Map(unified.Map(unified.Map(rawAtt)["resource"])["delivery"])["sources"])[0])
		if _, exists := src["expires_at"]; exists {
			t.Fatalf("zero now must not set expires_at, got %#v", src["expires_at"])
		}
	}
}

// TestSubtitleFormatRankParityWithYTEngine locks cross-package contract parity
// (ARCH-11) between ytengine/subtitles.go and platform/youtube/finalize_subtitles.go:
//
//  1. Shared format ranks {vtt: 1, srt: 2, ttml: 3, srv3: 4, json3: 5} MUST have
//     identical relative precedence and normalized (extension, mime_type) metadata
//     across both packages.
//  2. Rank 6 in finalize_subtitles.go (explicit fmt=xml|srv1|srv2 and immutable
//     signed URLs whose sparams lists "fmt") is an INTENTIONAL browser-helper
//     timedtext compatibility fallback—not accidental drift—because raw YouTube
//     playerResponse.captions timedtext URLs may carry legacy XML formats or
//     signature-locked fmt parameters that cannot be rewritten to &fmt=vtt,
//     whereas yt-dlp (ytengine) exposes structured Tracks in Ranks 1..5 only.
func TestSubtitleFormatRankParityWithYTEngine(t *testing.T) {
	const videoID = "I9JvDaciaFk"
	nowTime := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	w, h := int64(640), int64(360)

	sharedFormats := []struct {
		fmtName  string
		wantRank int
		wantExt  string
		wantMime string
	}{
		{fmtName: "vtt", wantRank: 1, wantExt: "vtt", wantMime: "text/vtt"},
		{fmtName: "srt", wantRank: 2, wantExt: "srt", wantMime: "application/x-subrip"},
		{fmtName: "ttml", wantRank: 3, wantExt: "ttml", wantMime: "application/ttml+xml"},
		{fmtName: "srv3", wantRank: 4, wantExt: "srv3", wantMime: "application/xml"},
		{fmtName: "json3", wantRank: 5, wantExt: "json3", wantMime: "application/json"},
	}

	pickYTEngineFormat := func(formats []string) (ext, mime, chosenURL string, ok bool) {
		tracks := make([]ytengine.SubtitleTrack, 0, len(formats))
		for _, f := range formats {
			tracks = append(tracks, ytengine.SubtitleTrack{
				Ext:  f,
				URL:  fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=%s", videoID, f),
				Name: "English",
			})
		}
		info := &ytengine.Info{
			ID:    videoID,
			Title: "Rank Parity Video",
			Formats: []ytengine.Format{
				{
					FormatID: "18",
					URL:      "https://rr1---sn-parity.googlevideo.com/videoplayback?itag=18",
					Ext:      "mp4",
					Protocol: "https",
					Width:    &w,
					Height:   &h,
					VCodec:   "avc1.42001E",
					ACodec:   "mp4a.40.2",
				},
			},
			Subtitles: map[string][]ytengine.SubtitleTrack{"en": tracks},
		}
		env := ytengine.AdaptInfo(info, ytengine.AdaptOptions{
			PlatformID: "youtube",
			ContentID:  videoID,
			SourceURL:  "https://www.youtube.com/watch?v=" + videoID,
			MaxEntries: 1,
			AllowedMediaURL: func(raw string) bool {
				return strings.Contains(raw, ".googlevideo.com/") || strings.Contains(raw, "www.youtube.com/")
			},
		}, nowTime.Unix())
		for _, rawAtt := range unified.Slice(unified.Map(env["data"])["attachments"]) {
			att := unified.Map(rawAtt)
			if unified.Str(att["role"]) != "subtitle" {
				continue
			}
			res := unified.Map(att["resource"])
			meta := unified.Map(res["metadata"])
			src := unified.Map(unified.Slice(unified.Map(res["delivery"])["sources"])[0])
			return unified.Str(meta["extension"]), unified.Str(meta["mime_type"]), unified.Str(src["url"]), true
		}
		return "", "", "", false
	}

	pickFinalizeFormat := func(urls []string) (ext, mime, chosenURL string, ok bool) {
		captionTracks := make([]map[string]any, 0, len(urls))
		for _, u := range urls {
			captionTracks = append(captionTracks, map[string]any{
				"baseUrl":      u,
				"languageCode": "en",
				"name":         map[string]any{"simpleText": "English"},
			})
		}
		rawCaps, err := json.Marshal(map[string]any{
			"playerCaptionsTracklistRenderer": map[string]any{
				"captionTracks": captionTracks,
			},
		})
		if err != nil {
			t.Fatalf("marshal captions: %v", err)
		}
		atts := extractFinalizeSubtitles(rawCaps, videoID, nowTime)
		if len(atts) == 0 {
			return "", "", "", false
		}
		att := unified.Map(atts[0])
		res := unified.Map(att["resource"])
		meta := unified.Map(res["metadata"])
		src := unified.Map(unified.Slice(unified.Map(res["delivery"])["sources"])[0])
		return unified.Str(meta["extension"]), unified.Str(meta["mime_type"]), unified.Str(src["url"]), true
	}

	// 1. Exact single-format metadata & numeric rank lock on {vtt:1, srt:2, ttml:3, srv3:4, json3:5}.
	for _, tc := range sharedFormats {
		ext, mime, rank, ok := mapTimedtextFormatMetadata(tc.fmtName)
		if !ok || ext != tc.wantExt || mime != tc.wantMime || rank != tc.wantRank {
			t.Fatalf("mapTimedtextFormatMetadata(%q) = (%q, %q, %d, %v), want (%q, %q, %d, true)",
				tc.fmtName, ext, mime, rank, ok, tc.wantExt, tc.wantMime, tc.wantRank)
		}
		ytExt, ytMime, _, ytOK := pickYTEngineFormat([]string{tc.fmtName})
		finURL := fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=%s", videoID, tc.fmtName)
		finExt, finMime, _, finOK := pickFinalizeFormat([]string{finURL})
		if !ytOK || !finOK {
			t.Fatalf("format %q admission mismatch: ytengine=%v finalize=%v", tc.fmtName, ytOK, finOK)
		}
		if ytExt != tc.wantExt || ytMime != tc.wantMime || finExt != ytExt || finMime != ytMime {
			t.Fatalf("format %q metadata drift: ytengine=(%q,%q) finalize=(%q,%q) want=(%q,%q)",
				tc.fmtName, ytExt, ytMime, finExt, finMime, tc.wantExt, tc.wantMime)
		}
	}

	// 2. Pairwise total-order parity across all 10 pairs (i < j) in both input orders.
	for i := 0; i < len(sharedFormats); i++ {
		for j := i + 1; j < len(sharedFormats); j++ {
			higher, lower := sharedFormats[i], sharedFormats[j]
			hiURL := fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=%s", videoID, higher.fmtName)
			loURL := fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=%s", videoID, lower.fmtName)

			for _, order := range []struct {
				label string
				yt    []string
				fin   []string
			}{
				{label: "higher-first", yt: []string{higher.fmtName, lower.fmtName}, fin: []string{hiURL, loURL}},
				{label: "lower-first", yt: []string{lower.fmtName, higher.fmtName}, fin: []string{loURL, hiURL}},
			} {
				ytExt, ytMime, _, ytOK := pickYTEngineFormat(order.yt)
				finExt, finMime, _, finOK := pickFinalizeFormat(order.fin)
				if !ytOK || !finOK || ytExt != higher.wantExt || finExt != higher.wantExt || ytMime != finMime {
					t.Fatalf("pair (%s vs %s, %s): ytengine=(%q,%q,%v) finalize=(%q,%q,%v), want %q (%q)",
						higher.fmtName, lower.fmtName, order.label,
						ytExt, ytMime, ytOK, finExt, finMime, finOK, higher.wantExt, higher.wantMime)
				}
			}
		}
	}

	// 3. Intentional Rank 6 browser-helper fallback:
	//    - ytengine does NOT admit xml/srv1/srv2 (Ranks 1..5 only);
	//    - finalize_subtitles.go intentionally assigns Rank 6 (ext="xml", mime="application/xml")
	//      to xml, srv1, srv2, and signed sparams=fmt immutable URLs, strictly below json3 (Rank 5).
	for _, legacyFmt := range []string{"xml", "srv1", "srv2"} {
		if _, _, _, ytOK := pickYTEngineFormat([]string{legacyFmt}); ytOK {
			t.Fatalf("ytengine unexpectedly admitted legacy browser-helper format %q", legacyFmt)
		}
		ext, mime, rank, ok := mapTimedtextFormatMetadata(legacyFmt)
		if !ok || ext != "xml" || mime != "application/xml" || rank != 6 {
			t.Fatalf("mapTimedtextFormatMetadata(%q) = (%q, %q, %d, %v), want (xml, application/xml, 6, true)",
				legacyFmt, ext, mime, rank, ok)
		}
	}

	rank6URLs := []struct {
		label string
		url   string
	}{
		{"fmt=xml", fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=xml&signature=S1", videoID)},
		{"fmt=srv1", fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=srv1&signature=S2", videoID)},
		{"fmt=srv2", fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=srv2&signature=S3", videoID)},
		{"signed-sparams-fmt", fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&sparams=v,lang,fmt&signature=S4", videoID)},
	}
	json3URL := fmt.Sprintf("https://www.youtube.com/api/timedtext?v=%s&lang=en&fmt=json3&signature=SJ", videoID)
	for _, tc := range rank6URLs {
		// Alone: admitted cleanly at Rank 6 without mutating the signed URL.
		finExt, finMime, gotURL, ok := pickFinalizeFormat([]string{tc.url})
		if !ok || finExt != "xml" || finMime != "application/xml" || gotURL != tc.url {
			t.Fatalf("Rank 6 fallback %s alone = (%q, %q, %q, %v), want (xml, application/xml, %q, true)",
				tc.label, finExt, finMime, gotURL, ok, tc.url)
		}
		// Paired with Rank 5 (json3) in either order: Rank 5 strictly outranks Rank 6.
		for _, pair := range [][]string{{tc.url, json3URL}, {json3URL, tc.url}} {
			winExt, winMime, winURL, winOK := pickFinalizeFormat(pair)
			if !winOK || winExt != "json3" || winMime != "application/json" || winURL != json3URL {
				t.Fatalf("Rank 5 (json3) must beat Rank 6 (%s): got (%q, %q, %q, %v)",
					tc.label, winExt, winMime, winURL, winOK)
			}
		}
	}
}
