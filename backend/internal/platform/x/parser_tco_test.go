package x

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

type xLockedLogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *xLockedLogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *xLockedLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestXChildGoroutinePanicsRecoverWithoutHanging(t *testing.T) {
	const (
		now       int64 = 1762300800
		sourceURL       = "https://x.com/historyinmemes/status/1790637656616943991"
	)

	var logBuf xLockedLogBuffer
	origOut := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(origOut) })

	validYTInfo := func() *ytengine.Info {
		return &ytengine.Info{
			ID:        "1790637589910654976",
			DisplayID: "1790637656616943991",
			Title:     "X fallback video",
			Uploader:  "historyinmemes",
			Thumbnail: "https://pbs.twimg.com/ext_tw_video_thumb/1790637589910654976/pu/img/thumb.jpg",
			Formats: []ytengine.Format{
				{
					FormatID: "http-832",
					URL:      "https://video.twimg.com/ext_tw_video/1790637589910654976/pu/vid/avc1/640x360/vid.mp4",
					Ext:      "mp4",
					Protocol: "https",
					Width:    int64Ptr(640),
					Height:   int64Ptr(360),
					Filesize: int64Ptr(1234567),
					VCodec:   "avc1.4d001e",
					ACodec:   "mp4a.40.2",
				},
			},
		}
	}

	t.Run("Stage1SyndicationPanicFallsBackToYTDLPImmediately", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return validYTInfo(), nil
				},
			},
			nil,
			fakeXFetcher{
				fn: func(context.Context, fetch.Request) (fetch.Response, error) {
					panic("x-syn-secret-https://syndication.example/leak?token=xsynsecret")
				},
			},
		)

		start := time.Now()
		env, err := p.Parse(ctx, sourceURL, now)
		elapsed := time.Since(start)
		if err != nil {
			t.Fatalf("Parse returned unexpected error: %v", err)
		}
		if elapsed >= 500*time.Millisecond {
			t.Fatalf("Parse blocked for %v after syndication panic; expected immediate fallback below %v", elapsed, syndicationSupplementTimeout)
		}
		if unified.Str(env["code"]) != "OK" {
			t.Fatalf("expected OK fallback from yt-dlp, got %+v", env)
		}
	})

	t.Run("Stage2YTDLPPanicReturnsCleanErrorImmediately", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					panic(errors.New("x-ytdlp-secret-https://proxy.example/leak?pass=xytdlpsecret"))
				},
			},
			nil,
			fakeXFetcher{
				fn: func(context.Context, fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusServiceUnavailable}, nil
				},
			},
		)

		start := time.Now()
		env, err := p.Parse(ctx, sourceURL, now)
		elapsed := time.Since(start)
		if err != nil {
			t.Fatalf("Parse returned unexpected error: %v", err)
		}
		if elapsed >= 500*time.Millisecond {
			t.Fatalf("Parse blocked for %v after yt-dlp panic; expected immediate error return", elapsed)
		}
		if unified.Str(env["code"]) != "UPSTREAM_UNAVAILABLE" {
			t.Fatalf("expected UPSTREAM_UNAVAILABLE after syndication 503 + yt-dlp panic, got %+v", env)
		}
	})

	t.Run("Stage2YTDLPPanicRecoversViaSlowSyndicationPhotoFastPath", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		ytStarted := make(chan struct{})
		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					close(ytStarted)
					panic("x-ytdlp-secret-stage2")
				},
			},
			nil,
			fakeXFetcher{
				fn: func(context.Context, fetch.Request) (fetch.Response, error) {
					<-ytStarted
					return fetch.Response{
						StatusCode: http.StatusOK,
						Body:       []byte(`{"id_str":"1790637656616943991","text":"photo post","user":{"name":"User","screen_name":"historyinmemes"},"photos":[{"url":"https://pbs.twimg.com/media/Abc123XYZ.jpg","width":1200,"height":800}]}`),
					}, nil
				},
			},
		)
		p.supplementTimeout = 5 * time.Millisecond

		start := time.Now()
		env, err := p.Parse(ctx, sourceURL, now)
		elapsed := time.Since(start)
		if err != nil {
			t.Fatalf("Parse returned unexpected error: %v", err)
		}
		if elapsed >= 500*time.Millisecond {
			t.Fatalf("Parse blocked for %v in Stage 2 recovery", elapsed)
		}
		if unified.Str(env["code"]) != "OK" {
			t.Fatalf("expected OK via syndication fast-path after yt-dlp panic, got %+v", env)
		}
	})

	t.Run("SizeProberPanicReleasesSemaphoreAndPopulatesHealthyFormats", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		const totalFormats = sizeProbeConcurrency + 2
		formats := make([]ytengine.Format, 0, totalFormats)
		for i := 0; i < totalFormats; i++ {
			formats = append(formats, ytengine.Format{
				FormatID: fmt.Sprintf("http-%d", i),
				URL:      fmt.Sprintf("https://video.twimg.com/ext_tw_video/1790637589910654976/pu/vid/avc1/640x360/v%d.mp4", i),
				Ext:      "mp4",
				Protocol: "https",
				Width:    int64Ptr(640),
				Height:   int64Ptr(360),
				VCodec:   "avc1.4d001e",
				ACodec:   "mp4a.40.2",
			})
		}
		info := &ytengine.Info{ID: "1790637589910654976", Formats: formats}

		start := time.Now()
		populateMissingMP4Sizes(ctx, info, func(_ context.Context, u string) (int64, bool) {
			for i := 0; i < sizeProbeConcurrency; i++ {
				if strings.HasSuffix(u, fmt.Sprintf("/v%d.mp4", i)) {
					panic("x-probe-secret-" + u + "?sig=xprobesecret")
				}
			}
			return 2468000, true
		})
		elapsed := time.Since(start)
		if elapsed >= 500*time.Millisecond {
			t.Fatalf("populateMissingMP4Sizes blocked for %v on prober panic", elapsed)
		}
		for i := 0; i < sizeProbeConcurrency; i++ {
			if info.Formats[i].Filesize != nil {
				t.Fatalf("panicking format %d unexpectedly got Filesize=%v", i, *info.Formats[i].Filesize)
			}
		}
		for i := sizeProbeConcurrency; i < totalFormats; i++ {
			if info.Formats[i].Filesize == nil || *info.Formats[i].Filesize != 2468000 {
				t.Fatalf("healthy format %d expected Filesize=2468000, got %v", i, info.Formats[i].Filesize)
			}
		}
	})

	logged := logBuf.String()
	for _, want := range []string{
		"x: syndication goroutine panic recovered: panic_type=",
		"x: ytdlp goroutine panic recovered: panic_type=",
		"x: size probe goroutine panic recovered: panic_type=",
	} {
		if !strings.Contains(logged, want) {
			t.Fatalf("expected log substring %q, got %q", want, logged)
		}
	}
	for _, forbidden := range []string{
		"x-syn-secret", "xsynsecret", "syndication.example",
		"x-ytdlp-secret", "xytdlpsecret", "proxy.example",
		"x-probe-secret", "xprobesecret", "video.twimg.com",
	} {
		if strings.Contains(logged, forbidden) {
			t.Fatalf("panic recovery log leaked sensitive value %q: %q", forbidden, logged)
		}
	}
}

func TestAllowedTCoURLValidation(t *testing.T) {
	valid := []string{
		"https://t.co/Zgzhvix8ES",
		"http://t.co/Zgzhvix8ES",
		"https://T.CO:443/AbCd1234",
		"http://t.co:80/a",
		"https://t.co/" + strings.Repeat("A", 32),
		"https://t.co/Zgzhvix8ES/",
		"https://t.co/Zgzhvix8ES?amp=1",
		"https://t.co/Zgzhvix8ES#top",
	}
	for _, raw := range valid {
		if !AllowedTCoURL(raw) {
			t.Fatalf("AllowedTCoURL(%q) = false, want true", raw)
		}
		if AllowedTargetURL(raw) {
			t.Fatalf("AllowedTargetURL(%q) = true, want false (ytengine must never accept t.co)", raw)
		}
	}
	if AllowedOutboundHost("t.co") || AllowedOutboundHost("www.t.co") {
		t.Fatal("AllowedOutboundHost must not allow t.co for yt-dlp subprocesses")
	}

	invalid := []string{
		"",
		"https://t.co",
		"https://t.co/",
		"https://t.co//Zgzhvix8ES",
		"https://t.co/Zgzhvix8ES//",
		"https://t.co/Zgzhvix8ES/extra",
		"https://t.co/" + strings.Repeat("A", 33),
		"https://t.co/abc_def",
		"https://t.co/abc-def",
		"https://t.co/%41bCd",
		"https://www.t.co/Zgzhvix8ES",
		"https://sub.t.co/Zgzhvix8ES",
		"https://t.co.evil.example/Zgzhvix8ES",
		"https://nott.co/Zgzhvix8ES",
		"https://t.co./Zgzhvix8ES",
		"https://104.244.42.1/Zgzhvix8ES",
		"https://t.co:8443/Zgzhvix8ES",
		"https://t.co:80/Zgzhvix8ES",
		"http://t.co:443/Zgzhvix8ES",
		"https://t.co:/Zgzhvix8ES",
		"https://user:pass@t.co/Zgzhvix8ES",
		"https://user@t.co/Zgzhvix8ES",
		"ftp://t.co/Zgzhvix8ES",
		"https://t.co/Zgzhvix8ES\\evil",
		"https://t.co/Zgzhvix8ES\x00",
		"https://t.co/中文",
		"https://t.co/Zgzhvix8ES?" + strings.Repeat("q", 2040),
	}
	for _, raw := range invalid {
		if AllowedTCoURL(raw) {
			t.Fatalf("AllowedTCoURL(%q) = true, want false", raw)
		}
	}
}

func TestTCoShortlinkControlledSingleHopExpansion(t *testing.T) {
	const now int64 = 1762300800

	syndicationTwoPhotosJSON, err := json.Marshal(map[string]any{
		"__typename": "Tweet",
		"id_str":     "1790637656616943991",
		"text":       "Two photos via t.co https://t.co/PhotoShort1",
		"user": map[string]any{
			"name":        "Creator",
			"screen_name": "creator_x",
		},
		"mediaDetails": []any{
			map[string]any{
				"id_str":          "1001",
				"type":            "photo",
				"media_url_https": "https://pbs.twimg.com/media/PhotoOneKey.jpg",
				"original_info":   map[string]any{"width": 1200, "height": 900},
			},
			map[string]any{
				"id_str":          "1002",
				"type":            "photo",
				"media_url_https": "https://pbs.twimg.com/media/PhotoTwoKey.png",
				"original_info":   map[string]any{"width": 1600, "height": 1200},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	makeMultiVideoInfo := func() *ytengine.Info {
		mkEntry := func(num, id string) ytengine.Info {
			return ytengine.Info{
				ID:        id,
				DisplayID: "1577719286659006464",
				Title:     "Clip #" + num,
				Duration:  float64Ptr(5.0),
				Thumbnail: "https://pbs.twimg.com/ext_tw_video_thumb/" + id + "/pu/img/t.jpg?name=orig",
				Formats: []ytengine.Format{
					{
						FormatID: "http-2176",
						URL:      "https://video.twimg.com/ext_tw_video/" + id + "/pu/vid/1280x720/v720.mp4?tag=12",
						Ext:      "mp4",
						Protocol: "https",
						Width:    int64Ptr(1280),
						Height:   int64Ptr(720),
						TBR:      float64Ptr(2176),
					},
				},
			}
		}
		return &ytengine.Info{
			ID:       "1577719286659006464",
			Type:     "playlist",
			Title:    "Multi Video Tweet",
			Uploader: "Ultima",
			Entries:  []ytengine.Info{mkEntry("1", "1577719236209922048"), mkEntry("2", "1577719239326273536")},
		}
	}

	t.Run("301-redirect-to-video-selector-and-policy-invariants", func(t *testing.T) {
		var tcoHits, synHits, ytHits atomic.Int32
		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(_ context.Context, rawURL string) (*ytengine.Info, error) {
					ytHits.Add(1)
					if rawURL != "https://x.com/i/status/1577719286659006464" {
						t.Fatalf("unexpected canonical URL passed to ytengine: %q", rawURL)
					}
					return makeMultiVideoInfo(), nil
				},
			},
			nil,
			fakeXFetcher{
				fn: func(reqCtx context.Context, req fetch.Request) (fetch.Response, error) {
					if strings.HasPrefix(req.URL, "https://t.co/") {
						tcoHits.Add(1)
						if req.URL != "https://t.co/VidSel2Ab" {
							t.Fatalf("expected canonicalized HTTPS t.co URL without query, got %q", req.URL)
						}
						if req.Policy.FollowRedirects || req.Policy.MaxRedirects != 0 {
							t.Fatalf("t.co policy must disable redirect following: %+v", req.Policy)
						}
						if req.Policy.Timeout != 5*time.Second || req.Policy.MaxBytes != 64<<10 {
							t.Fatalf("unexpected t.co policy bounds: Timeout=%v MaxBytes=%d", req.Policy.Timeout, req.Policy.MaxBytes)
						}
						if req.Policy.AllowedURL == nil || !req.Policy.AllowedURL(req.URL) || req.Policy.AllowedURL("https://x.com/i/status/1") {
							t.Fatal("t.co policy AllowedURL must strictly allow t.co only")
						}
						if req.Header.Get("Cookie") != "" || req.Header.Get("Authorization") != "" {
							t.Fatalf("t.co request must carry zero credentials: %+v", req.Header)
						}
						dl, hasDL := reqCtx.Deadline()
						if !hasDL || time.Until(dl) > 6*time.Second {
							t.Fatalf("expected ~5s context deadline on t.co hop, got hasDL=%v remaining=%v", hasDL, time.Until(dl))
						}
						h := make(http.Header)
						h.Set("Location", "https://twitter.com/UltimaShadowX/status/1577719286659006464/video/2?s=20")
						return fetch.Response{StatusCode: http.StatusMovedPermanently, Header: h, URL: req.URL}, nil
					}
					if strings.HasPrefix(req.URL, "https://cdn.syndication.twimg.com/") {
						synHits.Add(1)
						return fetch.Response{StatusCode: http.StatusNotFound, URL: req.URL}, nil
					}
					t.Fatalf("unexpected outbound URL: %s", req.URL)
					return fetch.Response{}, nil
				},
			},
		)

		env, err := p.Parse(context.Background(), "http://T.CO:80/VidSel2Ab?amp=1#frag", now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		if tcoHits.Load() != 1 || ytHits.Load() != 1 {
			t.Fatalf("expected 1 t.co hop and 1 yt-dlp call, got tco=%d yt=%d", tcoHits.Load(), ytHits.Load())
		}
		pub := unified.PublicView(env, false, now)
		if err := unified.ValidateEnvelopeAt(pub, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		data := unified.Map(pub["data"])
		if got := unified.Str(data["source_url"]); got != "https://x.com/i/status/1577719286659006464/video/2" {
			t.Fatalf("source_url = %q, want canonical /video/2 URL", got)
		}
		items := unified.Slice(data["items"])
		if len(items) != 2 {
			t.Fatalf("expected 2 video items, got %d", len(items))
		}
		secondID := unified.Str(unified.Map(items[1])["id"])
		if unified.Str(data["default_item_id"]) != secondID {
			t.Fatalf("expected /video/2 selector to choose 2nd item %q, got %q", secondID, unified.Str(data["default_item_id"]))
		}
	})

	t.Run("302-and-200-meta-refresh-and-location-replace-including-photo-selector", func(t *testing.T) {
		cases := []struct {
			name         string
			code         string
			tcoResp      fetch.Response
			wantSource   string
			wantItemPart string
		}{
			{
				name: "302-location-photo-2",
				code: "Photo302",
				tcoResp: func() fetch.Response {
					h := make(http.Header)
					h.Set("Location", "https://x.com/creator_x/status/1790637656616943991/photo/2")
					return fetch.Response{StatusCode: http.StatusFound, Header: h}
				}(),
				wantSource:   "https://x.com/i/status/1790637656616943991/photo/2",
				wantItemPart: "PhotoTwoKey",
			},
			{
				name: "200-meta-refresh-with-html-entities",
				code: "Meta200A",
				tcoResp: fetch.Response{
					StatusCode: http.StatusOK,
					Body: []byte(`<head><meta name="referrer" content="always"><noscript>` +
						`<META http-equiv="refresh" content="0;URL=https://x.com/creator_x/status/1790637656616943991/photo/1?s=20&amp;t=xyz">` +
						`</noscript></head>`),
				},
				wantSource:   "https://x.com/i/status/1790637656616943991/photo/1",
				wantItemPart: "PhotoOneKey",
			},
			{
				name: "200-meta-refresh-reversed-attrs-and-single-quotes",
				code: "Meta200B",
				tcoResp: fetch.Response{
					StatusCode: http.StatusOK,
					Body:       []byte(`<html><head><meta content="0; url='https://mobile.twitter.com/creator_x/status/1790637656616943991/photo/2'" http-equiv='refresh'></head></html>`),
				},
				wantSource:   "https://x.com/i/status/1790637656616943991/photo/2",
				wantItemPart: "PhotoTwoKey",
			},
			{
				name: "200-script-location-replace-escaped-slashes",
				code: "LocRep200",
				tcoResp: fetch.Response{
					StatusCode: http.StatusOK,
					Body:       []byte(`<script>window.opener = null; location.replace("https:\/\/x.com\/creator_x\/status\/1790637656616943991\/photo\/1?s=20\u0026t=abc")</script>`),
				},
				wantSource:   "https://x.com/i/status/1790637656616943991/photo/1",
				wantItemPart: "PhotoOneKey",
			},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				var ytCalled atomic.Bool
				p := NewWithFetcher(
					&stubExtractor{
						enabled: true,
						extract: func(_ context.Context, _ string) (*ytengine.Info, error) {
							ytCalled.Store(true)
							return nil, errors.New("unexpected yt-dlp call for /photo/<N>")
						},
					},
					nil,
					fakeXFetcher{
						fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
							if req.URL == "https://t.co/"+tc.code {
								resp := tc.tcoResp
								resp.URL = req.URL
								return resp, nil
							}
							if strings.HasPrefix(req.URL, "https://cdn.syndication.twimg.com/tweet-result") {
								return fetch.Response{StatusCode: http.StatusOK, Body: syndicationTwoPhotosJSON, URL: req.URL}, nil
							}
							t.Fatalf("unexpected request URL: %s", req.URL)
							return fetch.Response{}, nil
						},
					},
				)

				env, err := p.Parse(context.Background(), "https://t.co/"+tc.code, now)
				if err != nil {
					t.Fatalf("Parse failed: %v", err)
				}
				if ytCalled.Load() {
					t.Fatal("expected /photo/<N> via t.co not to invoke yt-dlp")
				}
				pub := unified.PublicView(env, false, now)
				if err := unified.ValidateEnvelopeAt(pub, now); err != nil {
					t.Fatalf("ValidateEnvelopeAt failed: %v", err)
				}
				data := unified.Map(pub["data"])
				if unified.Str(data["source_url"]) != tc.wantSource {
					t.Fatalf("source_url = %q, want %q", unified.Str(data["source_url"]), tc.wantSource)
				}
				items := unified.Slice(data["items"])
				if len(items) != 1 {
					t.Fatalf("expected 1 selected photo item, got %d", len(items))
				}
				defURL := unified.Str(unified.Map(unified.Map(items[0])["default"])["url"])
				if !strings.Contains(defURL, tc.wantItemPart) {
					t.Fatalf("default.url = %q, want substring %q", defURL, tc.wantItemPart)
				}
			})
		}
	})

	t.Run("non-tweet-external-and-nested-tco-targets-rejected-with-zero-target-requests", func(t *testing.T) {
		nonTweetTargets := []struct {
			name string
			resp fetch.Response
		}{
			{
				name: "301-external-domain",
				resp: func() fetch.Response {
					h := make(http.Header)
					h.Set("Location", "https://example.com/blog/2026/post")
					return fetch.Response{StatusCode: http.StatusMovedPermanently, Header: h}
				}(),
			},
			{
				name: "301-private-ip-ssrf-target",
				resp: func() fetch.Response {
					h := make(http.Header)
					h.Set("Location", "http://169.254.169.254/latest/meta-data/")
					return fetch.Response{StatusCode: http.StatusMovedPermanently, Header: h}
				}(),
			},
			{
				name: "301-nested-tco",
				resp: func() fetch.Response {
					h := make(http.Header)
					h.Set("Location", "https://t.co/SecondHop99")
					return fetch.Response{StatusCode: http.StatusMovedPermanently, Header: h}
				}(),
			},
			{
				name: "301-self-tco",
				resp: func() fetch.Response {
					h := make(http.Header)
					h.Set("Location", "https://t.co/FirstHop01")
					return fetch.Response{StatusCode: http.StatusMovedPermanently, Header: h}
				}(),
			},
			{
				name: "301-x-profile-not-status",
				resp: func() fetch.Response {
					h := make(http.Header)
					h.Set("Location", "https://x.com/historyinmemes")
					return fetch.Response{StatusCode: http.StatusMovedPermanently, Header: h}
				}(),
			},
			{
				name: "200-first-meta-refresh-external-ignores-second-meta-tweet",
				resp: fetch.Response{
					StatusCode: http.StatusOK,
					Body: []byte(`<html><head>` +
						`<meta http-equiv="refresh" content="0;URL=https://evil.example/landing">` +
						`<meta http-equiv="refresh" content="0;URL=https://x.com/u/status/1790637656616943991">` +
						`</head></html>`),
				},
			},
			{
				name: "200-location-replace-nested-tco",
				resp: fetch.Response{
					StatusCode: http.StatusOK,
					Body:       []byte(`<script>location.replace("https:\/\/t.co\/NestedLoop")</script>`),
				},
			},
			{
				name: "200-warning-interstitial-without-redirect",
				resp: fetch.Response{
					StatusCode: http.StatusOK,
					Body:       []byte(`<html><body>Warning: this link may be unsafe</body></html>`),
				},
			},
		}

		for _, tc := range nonTweetTargets {
			t.Run(tc.name, func(t *testing.T) {
				var fetchCount, ytCount atomic.Int32
				p := NewWithFetcher(
					&stubExtractor{
						enabled: true,
						extract: func(_ context.Context, rawURL string) (*ytengine.Info, error) {
							ytCount.Add(1)
							t.Fatalf("ytengine must never be called on rejected t.co target: %s", rawURL)
							return nil, nil
						},
					},
					nil,
					fakeXFetcher{
						fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
							n := fetchCount.Add(1)
							if n > 1 || req.URL != "https://t.co/FirstHop01" {
								t.Fatalf("unexpected second outbound request #%d to %q", n, req.URL)
							}
							resp := tc.resp
							resp.URL = req.URL
							return resp, nil
						},
					},
				)

				env, err := p.Parse(context.Background(), "https://t.co/FirstHop01", now)
				if err != nil {
					t.Fatalf("Parse returned Go error: %v", err)
				}
				if fetchCount.Load() != 1 || ytCount.Load() != 0 {
					t.Fatalf("expected exactly 1 t.co hop and 0 target calls, got fetch=%d yt=%d", fetchCount.Load(), ytCount.Load())
				}
				if err := unified.ValidateEnvelopeAt(env, now); err != nil {
					t.Fatalf("ValidateEnvelopeAt failed: %v", err)
				}
				errObj := unified.Map(env["error"])
				if unified.Str(env["code"]) != "INVALID_INPUT" ||
					errObj["retryable"] == true ||
					unified.Str(errObj["message"]) != "该 t.co 短链未指向有效的 X / Twitter 帖子" {
					t.Fatalf("unexpected error envelope: %+v", env)
				}
			})
		}
	})

	t.Run("invalid-tco-inputs-nil-fetcher-upstream-errors-timeout-and-cancel", func(t *testing.T) {
		// 1. Invalid t.co inputs make ZERO network calls.
		var invalidCalls atomic.Int32
		pInvalid := NewWithFetcher(
			&stubExtractor{enabled: true},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					invalidCalls.Add(1)
					t.Fatalf("invalid t.co input must not make network calls: %s", req.URL)
					return fetch.Response{}, nil
				},
			},
		)
		for _, bad := range []string{
			"https://sub.t.co/Zgzhvix8ES",
			"https://t.co/",
			"https://t.co/a/b",
			"https://t.co:8443/Zgzhvix8ES",
			"https://t.co/Zgzhvix8ES?" + strings.Repeat("a", 2040),
		} {
			env, err := pInvalid.Parse(context.Background(), bad, now)
			if err != nil || unified.Str(env["code"]) != "INVALID_INPUT" {
				t.Fatalf("Parse(%q) = (%+v, %v), want INVALID_INPUT", bad, env, err)
			}
		}
		if invalidCalls.Load() != 0 {
			t.Fatalf("expected 0 network calls, got %d", invalidCalls.Load())
		}

		// 2. Nil fetcher -> UPSTREAM_UNAVAILABLE (retryable: true).
		nilFetcherParser := New(&stubExtractor{enabled: true})
		nilEnv, err := nilFetcherParser.Parse(context.Background(), "https://t.co/Zgzhvix8ES", now)
		if err != nil {
			t.Fatalf("nil fetcher Parse error: %v", err)
		}
		if unified.Str(nilEnv["code"]) != "UPSTREAM_UNAVAILABLE" || unified.Map(nilEnv["error"])["retryable"] != true {
			t.Fatalf("expected retryable UPSTREAM_UNAVAILABLE when p.fetcher == nil, got %+v", nilEnv)
		}

		// 3. Upstream 404, 429, 502, network failure, and timeout.
		upstreamCases := []struct {
			name      string
			fn        func(context.Context, fetch.Request) (fetch.Response, error)
			wantCode  string
			retryable bool
		}{
			{
				name: "404-not-found",
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusNotFound, URL: req.URL}, nil
				},
				wantCode:  "CONTENT_UNAVAILABLE",
				retryable: false,
			},
			{
				name: "429-rate-limited",
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusTooManyRequests, URL: req.URL}, nil
				},
				wantCode:  "RATE_LIMITED",
				retryable: true,
			},
			{
				name: "503-unavailable",
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusServiceUnavailable, URL: req.URL}, nil
				},
				wantCode:  "UPSTREAM_UNAVAILABLE",
				retryable: true,
			},
			{
				name: "network-error",
				fn: func(_ context.Context, _ fetch.Request) (fetch.Response, error) {
					return fetch.Response{}, errors.New("dial tcp timeout/reset")
				},
				wantCode:  "UPSTREAM_UNAVAILABLE",
				retryable: true,
			},
			{
				name: "deadline-exceeded-timeout",
				fn: func(_ context.Context, _ fetch.Request) (fetch.Response, error) {
					return fetch.Response{}, context.DeadlineExceeded
				},
				wantCode:  "UPSTREAM_TIMEOUT",
				retryable: true,
			},
		}
		for _, uc := range upstreamCases {
			t.Run(uc.name, func(t *testing.T) {
				pUp := NewWithFetcher(&stubExtractor{enabled: true}, nil, fakeXFetcher{fn: uc.fn})
				env, err := pUp.Parse(context.Background(), "https://t.co/Zgzhvix8ES", now)
				if err != nil {
					t.Fatalf("unexpected Go error: %v", err)
				}
				if unified.Str(env["code"]) != uc.wantCode || (unified.Map(env["error"])["retryable"] == true) != uc.retryable {
					t.Fatalf("got env=%+v, want code=%s retryable=%v", env, uc.wantCode, uc.retryable)
				}
			})
		}

		// 4. Caller context cancellation aborts in-flight t.co hop immediately and returns context.Canceled.
		entered := make(chan struct{})
		pCancel := NewWithFetcher(
			&stubExtractor{enabled: true},
			nil,
			fakeXFetcher{
				fn: func(reqCtx context.Context, _ fetch.Request) (fetch.Response, error) {
					close(entered)
					<-reqCtx.Done()
					return fetch.Response{}, reqCtx.Err()
				},
			},
		)
		cancelCtx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			_, callErr := pCancel.Parse(cancelCtx, "https://t.co/Zgzhvix8ES", now)
			done <- callErr
		}()
		<-entered
		startCancel := time.Now()
		cancel()
		callErr := <-done
		if !errors.Is(callErr, context.Canceled) {
			t.Fatalf("expected context.Canceled on caller abort, got %v", callErr)
		}
		if time.Since(startCancel) >= 500*time.Millisecond {
			t.Fatalf("caller cancellation took too long: %v", time.Since(startCancel))
		}
	})
}
