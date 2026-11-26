package ytengine

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/urlpolicy"
)

func TestAllowPublicSubtitleURL(t *testing.T) {
	valid := []string{
		"https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en&fmt=vtt",
		"https://WWW.YOUTUBE.COM:443/api/timedtext?v=aqz-KE-bpKQ&lang=zh-Hans&fmt=vtt&signature=SIG",
		"https://captions.cloud.vimeo.com/captions/12345.vtt?exp=1794238131&token=cdn_sig",
		"https://subs.example.test/tracks/en.srt",
	}
	for _, raw := range valid {
		if !AllowPublicSubtitleURL(raw) {
			t.Errorf("AllowPublicSubtitleURL(%q) = false, want true", raw)
		}
	}

	invalid := []string{
		"",
		"http://captions.cloud.vimeo.com/captions/12345.vtt",
		"http://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en",
		"https://user:pass@captions.cloud.vimeo.com/captions/12345.vtt",
		"https://captions.cloud.vimeo.com/captions/12345.vtt#frag",
		"https://captions.cloud.vimeo.com:8443/captions/12345.vtt",
		"https://captions.cloud.vimeo.com:/captions/12345.vtt",
		"https://captions.cloud.vimeo.com/a b.vtt",
		"https://captions.cloud.vimeo.com/a\\b.vtt",
		"https://captions.cloud.vimeo.com/\n.vtt",
		"https://localhost/sub.vtt",
		"https://api.localhost/sub.vtt",
		"https://media.local/sub.vtt",
		"https://svc.internal/sub.vtt",
		"https://snap.dokitool.com/sub.vtt",
		"https://127.0.0.1/sub.vtt",
		"https://10.0.0.1/sub.vtt",
		"https://169.254.169.254/latest/meta-data",
		"https://192.168.1.1/sub.vtt",
		"https://[::1]/sub.vtt",
		"https://[::ffff:127.0.0.1]/sub.vtt",
		"https://[fe80::1%25lo0]/sub.vtt",
		// YouTube-specific host/path/credential restrictions
		"https://youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en",
		"https://m.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en",
		"https://www.youtube.com./api/timedtext?v=aqz-KE-bpKQ&lang=en",
		"https://www.youtube.com/watch?v=aqz-KE-bpKQ",
		"https://www.youtube.com/api/timedtext/extra?v=aqz-KE-bpKQ",
		"https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&cookie=1",
		"https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&SAPISID=1",
		"https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&authorization=1",
		"https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&access_token=1",
		"https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&token=1",
		"https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&%63ookie=1",
		"https://subs.example.test/" + strings.Repeat("a", maxSubtitleURLLength),
	}
	for _, raw := range invalid {
		if AllowPublicSubtitleURL(raw) {
			t.Errorf("AllowPublicSubtitleURL(%q) = true, want false", raw)
		}
	}
}

func TestAdaptInfoSubtitleExtractionFormatPriorityAndTlangFilter(t *testing.T) {
	const now int64 = 1762300800
	w, h := int64(640), int64(360)

	makeBaseInfo := func() *Info {
		return &Info{
			ID:    "aqz-KE-bpKQ",
			Title: "Big Buck Bunny",
			Formats: []Format{
				{
					FormatID: "18",
					URL:      "https://rr1---sn-golden.googlevideo.com/videoplayback?itag=18",
					Ext:      "mp4",
					Protocol: "https",
					Width:    &w,
					Height:   &h,
					VCodec:   "avc1.42001E",
					ACodec:   "mp4a.40.2",
				},
			},
		}
	}
	ytOpts := AdaptOptions{
		PlatformID: "youtube",
		ContentID:  "aqz-KE-bpKQ",
		SourceURL:  "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
		MaxEntries: 1,
		AllowedMediaURL: func(raw string) bool {
			return strings.Contains(raw, ".googlevideo.com/") || strings.Contains(raw, "www.youtube.com/")
		},
	}

	// 1. Without subtitles / automatic_captions: zero attachments emitted (0 diff).
	baseEnv := AdaptInfo(makeBaseInfo(), ytOpts, now)
	if err := unified.ValidateEnvelopeAt(baseEnv, now); err != nil {
		t.Fatalf("base ValidateEnvelopeAt: %v", err)
	}
	if _, exists := unified.Map(baseEnv["data"])["attachments"]; exists {
		t.Fatalf("expected no attachments when subtitles are empty, got %#v", unified.Map(baseEnv["data"])["attachments"])
	}

	// 2. Format preference (vtt > srt > ttml > srv3), tlang= filtering of 155 auto-translated tracks,
	//    en + en-orig URL dedup, live_chat ignored, credential header / invalid URL silently dropped.
	info := makeBaseInfo()
	info.Subtitles = map[string][]SubtitleTrack{
		"live_chat": {
			{Ext: "json", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&fmt=json", Protocol: "youtube_live_chat"},
		},
		"en": {
			{Ext: "json3", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en&fmt=json3", Name: "English"},
			{Ext: "srv3", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en&fmt=srv3", Name: "English"},
			{Ext: "srt", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en&fmt=srt", Name: "English"},
			{Ext: "vtt", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en&fmt=vtt", Name: "English"},
			{Ext: "ttml", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en&fmt=ttml", Name: "English"},
		},
		"ja": {
			{Ext: "srv3", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=ja&fmt=srv3", Name: "日本語"},
			{Ext: "srt", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=ja&fmt=srt", Name: "日本語"},
		},
		"de": {
			{Ext: "srv3", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=de&fmt=srv3", Name: "Deutsch"},
			{Ext: "ttml", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=de&fmt=ttml", Name: "Deutsch"},
		},
		"fr": {
			{Ext: "srv3", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=fr&fmt=srv3", Name: "Français"},
		},
		// Rejected: carries Cookie HTTPHeader
		"es": {
			{
				Ext:         "vtt",
				URL:         "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=es&fmt=vtt",
				Name:        "Español",
				HTTPHeaders: map[string]string{"Cookie": "SESSDATA=secret"},
			},
		},
		// Rejected: private IP / non-YouTube host blocked by AllowPublicSubtitleURL + AllowedMediaURL
		"it": {
			{Ext: "vtt", URL: "https://127.0.0.1/it.vtt", Name: "Italiano"},
		},
	}

	autoMap := map[string][]SubtitleTrack{
		"en": {
			{Ext: "vtt", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en&kind=asr&fmt=vtt", Name: "English"},
		},
		// Same URL as "en" -> deduplicated onto "en"
		"en-orig": {
			{Ext: "vtt", URL: "https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en&kind=asr&fmt=vtt", Name: "English (Original)"},
		},
	}
	// Add 155 auto-translated tlang= entries simulating real yt-dlp output bloat.
	for i := 0; i < 155; i++ {
		langKey := fmt.Sprintf("xx-%03d", i)
		autoMap[langKey] = []SubtitleTrack{
			{
				Ext:  "vtt",
				URL:  fmt.Sprintf("https://www.youtube.com/api/timedtext?v=aqz-KE-bpKQ&lang=en&kind=asr&tlang=%s&fmt=vtt", langKey),
				Name: "Translated " + langKey,
			},
		}
	}
	info.AutomaticCaptions = autoMap

	env := AdaptInfo(info, ytOpts, now)
	if err := unified.ValidateEnvelopeAt(env, now); err != nil {
		t.Fatalf("AdaptInfo ValidateEnvelopeAt: %v", err)
	}
	for _, debug := range []bool{false, true} {
		view := unified.PublicView(env, debug, now)
		if err := unified.ValidateEnvelopeAt(view, now); err != nil {
			t.Fatalf("PublicView(debug=%v) ValidateEnvelopeAt: %v", debug, err)
		}
		atts := unified.Slice(unified.Map(view["data"])["attachments"])
		// Expect exact 5 tracks: en(manual,vtt), ja(manual,srt), de(manual,ttml), fr(manual,srv3), en(auto,vtt)
		if len(atts) != 5 {
			t.Fatalf("debug=%v: attachments len = %d, want 5: %#v", debug, len(atts), atts)
		}
		want := []struct {
			lang      string
			trackKind string
			ext       string
			mime      string
		}{
			{"en", "manual", "vtt", "text/vtt"},
			{"ja", "manual", "srt", "application/x-subrip"},
			{"de", "manual", "ttml", "application/ttml+xml"},
			{"fr", "manual", "srv3", "application/xml"},
			{"en", "auto", "vtt", "text/vtt"},
		}
		for i, w := range want {
			att := unified.Map(atts[i])
			res := unified.Map(att["resource"])
			meta := unified.Map(res["metadata"])
			if unified.Str(att["role"]) != "subtitle" ||
				unified.Str(att["language"]) != w.lang ||
				unified.Str(att["track_kind"]) != w.trackKind ||
				unified.Str(meta["extension"]) != w.ext ||
				unified.Str(meta["mime_type"]) != w.mime {
				t.Fatalf("debug=%v att[%d] = (%v,%v,%v,%v,%v), want (subtitle,%s,%s,%s,%s)",
					debug, i, att["role"], att["language"], att["track_kind"], meta["extension"], meta["mime_type"],
					w.lang, w.trackKind, w.ext, w.mime)
			}
		}
	}
}

func TestAdaptInfoSubtitleCapManualPriorityAndTier2PublicCDN(t *testing.T) {
	const now int64 = 1762300800
	w, h := int64(1280), int64(720)

	manual := make(map[string][]SubtitleTrack, 40)
	for i := 0; i < 38; i++ {
		code := fmt.Sprintf("aa-%02d", i)
		manual[code] = []SubtitleTrack{
			{Ext: "vtt", URL: fmt.Sprintf("https://captions.cloud.vimeo.com/captions/%s.vtt", code), Name: "Track " + code},
		}
	}
	// Ensure zh-Hans and en survive cap even though alphabetically late/middle.
	manual["zh-Hans"] = []SubtitleTrack{
		{Ext: "vtt", URL: "https://captions.cloud.vimeo.com/captions/zh-Hans.vtt", Name: "简体中文"},
	}
	manual["en"] = []SubtitleTrack{
		{Ext: "vtt", URL: "https://captions.cloud.vimeo.com/captions/en.vtt", Name: "English"},
	}
	auto := map[string][]SubtitleTrack{
		"fr": {{Ext: "vtt", URL: "https://captions.cloud.vimeo.com/captions/auto-fr.vtt", Name: "Auto FR"}},
	}

	info := &Info{
		ID:    "987654321",
		Title: "Vimeo Demo",
		Formats: []Format{
			{
				FormatID: "http-720",
				URL:      "https://vod-progressive.akamaized.net/exp/demo.mp4",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w,
				Height:   &h,
				VCodec:   "avc1.64001f",
				ACodec:   "mp4a.40.2",
			},
		},
		Subtitles:         manual,
		AutomaticCaptions: auto,
	}

	env := AdaptInfo(info, AdaptOptions{
		PlatformID: "vimeo",
		ContentID:  "987654321",
		SourceURL:  "https://vimeo.com/987654321",
		MaxEntries: 1,
	}, now)
	if err := unified.ValidateEnvelopeAt(env, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt: %v", err)
	}
	atts := unified.Slice(unified.Map(env["data"])["attachments"])
	if len(atts) != MaxSubtitleAttachments {
		t.Fatalf("attachments len = %d, want %d", len(atts), MaxSubtitleAttachments)
	}
	// First two MUST be zh-Hans and en (manual), and all 32 must be manual (no auto leaked into capped manual pool).
	if unified.Str(unified.Map(atts[0])["language"]) != "zh-Hans" || unified.Str(unified.Map(atts[1])["language"]) != "en" {
		t.Fatalf("expected zh-Hans then en first, got %q then %q",
			unified.Str(unified.Map(atts[0])["language"]), unified.Str(unified.Map(atts[1])["language"]))
	}
	for i, raw := range atts {
		if unified.Str(unified.Map(raw)["track_kind"]) != "manual" {
			t.Fatalf("att[%d].track_kind = %v, want manual (manual must take priority over auto)", i, unified.Map(raw)["track_kind"])
		}
	}
}

func TestAdaptInfoSubtitleJson3AndSafeExpiresAt(t *testing.T) {
	const now int64 = 1762300800
	nowTime := time.Unix(now, 0).UTC()
	futureExp := nowTime.Add(2 * time.Hour).Unix()
	wantFutureRFC3339 := time.Unix(futureExp, 0).UTC().Format(time.RFC3339)
	pastExp := nowTime.Add(-30 * time.Minute).Unix()
	tooFarExp := nowTime.Add(31 * 24 * time.Hour).Unix()
	w, h := int64(640), int64(360)

	info := &Info{
		ID:    "subExpDemo",
		Title: "Subtitle json3 and expiry",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      "https://rr1---sn-golden.googlevideo.com/videoplayback?itag=18",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w,
				Height:   &h,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
			},
		},
		Subtitles: map[string][]SubtitleTrack{
			// Only json3 available + valid future expire -> accepted as json3 with expires_at
			"ko": {
				{
					Ext:  "json3",
					URL:  fmt.Sprintf("https://www.youtube.com/api/timedtext?v=subExpDemo&lang=ko&fmt=json3&expire=%d", futureExp),
					Name: "한국어",
				},
			},
			// json3 + srv3 -> srv3 wins (rank 4 < rank 5) + valid future expires=
			"ja": {
				{
					Ext:  "json3",
					URL:  fmt.Sprintf("https://www.youtube.com/api/timedtext?v=subExpDemo&lang=ja&fmt=json3&expires=%d", futureExp),
					Name: "日本語 JSON3",
				},
				{
					Ext:  "srv3",
					URL:  fmt.Sprintf("https://www.youtube.com/api/timedtext?v=subExpDemo&lang=ja&fmt=srv3&expires=%d", futureExp),
					Name: "日本語 SRV3",
				},
			},
			// Historical past expire -> expires_at omitted (must NOT mark source expired!)
			"en": {
				{
					Ext:  "vtt",
					URL:  fmt.Sprintf("https://www.youtube.com/api/timedtext?v=subExpDemo&lang=en&fmt=vtt&expire=%d", pastExp),
					Name: "English Past",
				},
			},
			// >30d expire -> expires_at omitted
			"de": {
				{
					Ext:  "vtt",
					URL:  fmt.Sprintf("https://www.youtube.com/api/timedtext?v=subExpDemo&lang=de&fmt=vtt&expire=%d", tooFarExp),
					Name: "Deutsch Far",
				},
			},
		},
	}

	env := AdaptInfo(info, AdaptOptions{
		PlatformID: "youtube",
		ContentID:  "subExpDemo",
		SourceURL:  "https://www.youtube.com/watch?v=subExpDemo",
		MaxEntries: 1,
	}, now)
	if err := unified.ValidateEnvelopeAt(env, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}

	byLang := make(map[string]unified.Object)
	for _, raw := range unified.Slice(unified.Map(env["data"])["attachments"]) {
		att := unified.Map(raw)
		byLang[unified.Str(att["language"])] = att
	}
	if len(byLang) != 4 {
		t.Fatalf("expected 4 subtitle tracks, got %d", len(byLang))
	}

	koMeta := unified.Map(unified.Map(byLang["ko"]["resource"])["metadata"])
	koSrc := unified.Map(unified.Slice(unified.Map(unified.Map(byLang["ko"]["resource"])["delivery"])["sources"])[0])
	if unified.Str(koMeta["extension"]) != "json3" || unified.Str(koMeta["mime_type"]) != "application/json" {
		t.Fatalf("ko meta = %#v, want json3/application/json", koMeta)
	}
	if unified.Str(koSrc["expires_at"]) != wantFutureRFC3339 {
		t.Fatalf("ko expires_at = %q, want %q", unified.Str(koSrc["expires_at"]), wantFutureRFC3339)
	}

	jaMeta := unified.Map(unified.Map(byLang["ja"]["resource"])["metadata"])
	jaSrc := unified.Map(unified.Slice(unified.Map(unified.Map(byLang["ja"]["resource"])["delivery"])["sources"])[0])
	if unified.Str(jaMeta["extension"]) != "srv3" {
		t.Fatalf("ja ext = %v, want srv3 (rank 4 < json3 rank 5)", jaMeta["extension"])
	}
	if unified.Str(jaSrc["expires_at"]) != wantFutureRFC3339 {
		t.Fatalf("ja expires_at = %q, want %q", unified.Str(jaSrc["expires_at"]), wantFutureRFC3339)
	}

	for _, lang := range []string{"en", "de"} {
		src := unified.Map(unified.Slice(unified.Map(unified.Map(byLang[lang]["resource"])["delivery"])["sources"])[0])
		if _, exists := src["expires_at"]; exists {
			t.Fatalf("%s out-of-window expire must not populate expires_at, got %#v", lang, src["expires_at"])
		}
	}

	if got := urlpolicy.ExtractSubtitleExpiresAt(fmt.Sprintf("https://www.youtube.com/api/timedtext?v=x&expire=%d", futureExp), time.Time{}, maxSubtitleExpiresWindow); got != "" {
		t.Fatalf("zero now must return empty expires_at, got %q", got)
	}
}
