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
	gotURL, gotExt, gotMime := ensureTimedtextFormatURL(base)
	wantURL := base + "&fmt=vtt"
	if gotURL != wantURL || gotExt != "vtt" || gotMime != "text/vtt" {
		t.Fatalf("got (%q, %q, %q), want (%q, vtt, text/vtt)", gotURL, gotExt, gotMime, wantURL)
	}

	// 2. fmt absent BUT listed in sparams (plain or percent-encoded) -> MUST NOT mutate URL.
	for _, signed := range []string{
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&sparams=v,expire,fmt&signature=SIG&lang=en",
		"https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&sparams=v%2Cexpire%2Cfmt&signature=SIG&lang=en",
	} {
		u, ext, mime := ensureTimedtextFormatURL(signed)
		if u != signed || ext != "xml" || mime != "application/xml" {
			t.Fatalf("signed sparams fmt mutated URL: got (%q, %q, %q), want (%q, xml, application/xml)", u, ext, mime, signed)
		}
	}

	// 3. fmt already present (e.g. fmt=srv3 or fmt=ttml or fmt=vtt) -> MUST NOT mutate URL.
	existing := "https://www.youtube.com/api/timedtext?v=I9JvDaciaFk&lang=en&fmt=ttml&signature=SIG"
	u, ext, mime := ensureTimedtextFormatURL(existing)
	if u != existing || ext != "ttml" || mime != "application/ttml+xml" {
		t.Fatalf("existing fmt mutated: got (%q, %q, %q)", u, ext, mime)
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
