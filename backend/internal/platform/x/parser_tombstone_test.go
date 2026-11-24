package x

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func TestFxTwitterAllowlistAndOutboundHostIsolation(t *testing.T) {
	// Requirement 2: api.fxtwitter.com MUST NEVER be added to yt-dlp AllowedOutboundHost.
	for _, forbiddenHost := range []string{
		"api.fxtwitter.com",
		"fxtwitter.com",
		"d.fxtwitter.com",
		"mosaic.fxtwitter.com",
	} {
		if AllowedOutboundHost(forbiddenHost) {
			t.Fatalf("AllowedOutboundHost(%q) = true, want false (fxtwitter must never enter yt-dlp allowlist)", forbiddenHost)
		}
	}

	validURLs := []string{
		"https://api.fxtwitter.com/i/status/1",
		"https://api.fxtwitter.com/i/status/2119994769057132696",
		"https://API.FXTWITTER.COM/i/status/12345678901234567890",
	}
	for _, u := range validURLs {
		if !AllowedFxTwitterURL(u) {
			t.Fatalf("AllowedFxTwitterURL(%q) = false, want true", u)
		}
	}

	invalidURLs := []string{
		"",
		"http://api.fxtwitter.com/i/status/2119994769057132696",
		"https://api.fxtwitter.com:443/i/status/2119994769057132696",
		"https://api.fxtwitter.com:8443/i/status/2119994769057132696",
		"https://api.fxtwitter.com:80/i/status/2119994769057132696",
		"https://user:pass@api.fxtwitter.com/i/status/2119994769057132696",
		"https://user@api.fxtwitter.com/i/status/2119994769057132696",
		"https://api.fxtwitter.com.evil/i/status/2119994769057132696",
		"https://evilapi.fxtwitter.com/i/status/2119994769057132696",
		"https://sub.api.fxtwitter.com/i/status/2119994769057132696",
		"https://api.fxtwitter.com./i/status/2119994769057132696",
		"https://fxtwitter.com/i/status/2119994769057132696",
		"https://api.fxtwitter.com/i/status/2119994769057132696?foo=1",
		"https://api.fxtwitter.com/i/status/2119994769057132696#frag",
		"https://api.fxtwitter.com/i/status/2119994769057132696/",
		"https://api.fxtwitter.com/i/status/2119994769057132696/photo/1",
		"https://api.fxtwitter.com/MiuMiu99999999/status/2119994769057132696",
		"https://api.fxtwitter.com/i/status/02119994769057132696",
		"https://api.fxtwitter.com/i/status/0",
		"https://api.fxtwitter.com/i/status/123456789012345678901",
		"https://api.fxtwitter.com/i/status/abc",
		"https://api.fxtwitter.com/i/status/..%2f2119994769057132696",
	}
	for _, u := range invalidURLs {
		if AllowedFxTwitterURL(u) {
			t.Fatalf("AllowedFxTwitterURL(%q) = true, want false", u)
		}
	}
}

func assertFxTwitterRequestHygiene(t *testing.T, req fetch.Request, wantTweetID string) {
	t.Helper()
	wantURL := "https://api.fxtwitter.com/i/status/" + wantTweetID
	if req.Method != http.MethodGet {
		t.Fatalf("fxtwitter Method = %q, want GET", req.Method)
	}
	if req.URL != wantURL {
		t.Fatalf("fxtwitter URL = %q, want %q", req.URL, wantURL)
	}
	if req.Policy.AllowedURL == nil || !req.Policy.AllowedURL(req.URL) {
		t.Fatalf("fxtwitter AllowedURL rejected %q", req.URL)
	}
	if req.Policy.FollowRedirects || req.Policy.ReadRedirectBody || req.Policy.AutoReferer || req.Policy.MaxRedirects != 0 {
		t.Fatalf("fxtwitter redirect/referer policy must disable redirects and auto-referer: %+v", req.Policy)
	}
	if req.Policy.MaxBytes != 256<<10 {
		t.Fatalf("fxtwitter MaxBytes = %d, want %d (256 KiB)", req.Policy.MaxBytes, 256<<10)
	}
	if req.Policy.Timeout != 4*time.Second {
		t.Fatalf("fxtwitter Timeout = %v, want 4s", req.Policy.Timeout)
	}
	if gotCookie := req.Header.Get("Cookie"); gotCookie != "" {
		t.Fatalf("fxtwitter request must never carry Cookie, got %q", gotCookie)
	}
	if gotRef := req.Header.Get("Referer"); gotRef != "" {
		t.Fatalf("fxtwitter request must never carry Referer, got %q", gotRef)
	}
	if gotAuth := req.Header.Get("Authorization"); gotAuth != "" {
		t.Fatalf("fxtwitter request must never carry Authorization, got %q", gotAuth)
	}
	if gotXFF := req.Header.Get("X-Forwarded-For"); gotXFF != "" {
		t.Fatalf("fxtwitter request must never forward client IP, got %q", gotXFF)
	}
	if gotUA := req.Header.Get("User-Agent"); gotUA != "DokiTool-Go (+https://snap.dokitool.com)" {
		t.Fatalf("fxtwitter User-Agent = %q, want %q", gotUA, "DokiTool-Go (+https://snap.dokitool.com)")
	}
	if gotAccept := req.Header.Get("Accept"); gotAccept != "application/json" {
		t.Fatalf("fxtwitter Accept = %q, want application/json", gotAccept)
	}
	if len(req.Header) != 2 {
		t.Fatalf("fxtwitter request must only send User-Agent and Accept headers, got %+v", req.Header)
	}
}

func TestParseXTombstoneFxTwitterMediaMatrix(t *testing.T) {
	const now int64 = 1762300800
	tombstoneSynBody := []byte(`{"__typename":"TweetTombstone","tombstone":{"text":{"text":"Age-restricted adult content."}}}`)

	// 1. Single restricted photo (Issue #88 real sample 2119994769057132696, 2448x3264).
	t.Run("tombstone-single-photo-2119994769057132696", func(t *testing.T) {
		const tweetID = "2119994769057132696"
		const sourceURL = "https://x.com/MiuMiu99999999/status/" + tweetID
		longFirstLine := strings.Repeat("喵", 95)
		fxBody, _ := json.Marshal(map[string]any{
			"code":    200,
			"message": "OK",
			"tweet": map[string]any{
				"id":          tweetID,
				"text":        longFirstLine + "\x00\r\nSecond line https://t.co/Restricted123",
				"likes":       99999,
				"secret_leak": "must_never_appear_in_envelope",
				"author": map[string]any{
					"name":        "MiuMiu\x07\nChannel",
					"screen_name": "MiuMiu99999999",
					"avatar_url":  "https://fxtwitter.com/spoof-avatar.jpg",
					"banner_url":  "https://fxtwitter.com/spoof-banner.jpg",
				},
				"media": map[string]any{
					"mosaic": map[string]any{
						"type": "mosaic_photo",
						"formats": map[string]any{
							"jpeg": "https://mosaic.fxtwitter.com/jpeg/" + tweetID,
						},
					},
					"photos": []map[string]any{
						{
							"type":   "photo",
							"url":    "https://pbs.twimg.com/media/HCpE9UZaAAAHlX5.jpg?name=orig",
							"width":  2448,
							"height": 3264,
						},
					},
				},
			},
		})

		var synCalls, fxCalls atomic.Int32
		baseParser := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{
						Code:      ytengine.CodeUpstreamBlocked,
						Message:   "Age-restricted adult content",
						Retryable: false,
					}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					if strings.HasPrefix(req.URL, syndicationEndpointURL) {
						synCalls.Add(1)
						return fetch.Response{StatusCode: http.StatusOK, Body: tombstoneSynBody, URL: req.URL}, nil
					}
					fxCalls.Add(1)
					assertFxTwitterRequestHygiene(t, req, tweetID)
					return fetch.Response{StatusCode: http.StatusOK, Body: fxBody, URL: req.URL}, nil
				},
			},
		)
		p, err := baseParser.WithTombstoneFallback(TombstoneFallbackFxTwitter)
		if err != nil {
			t.Fatalf("WithTombstoneFallback failed: %v", err)
		}

		env, err := p.Parse(context.Background(), sourceURL, now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		if synCalls.Load() != 1 || fxCalls.Load() != 1 {
			t.Fatalf("expected synCalls=1 fxCalls=1, got syn=%d fx=%d", synCalls.Load(), fxCalls.Load())
		}
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		view := unified.PublicView(env, false, now)
		if err := unified.ValidateEnvelopeAt(view, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt(PublicView) failed: %v", err)
		}
		encoded, _ := unified.Encode(view)
		if strings.Contains(string(encoded), "must_never_appear") ||
			strings.Contains(string(encoded), "fxtwitter.com") ||
			strings.Contains(string(encoded), `"relay"`) {
			t.Fatalf("third-party URL/field or relay leaked into public envelope: %s", string(encoded))
		}

		data := unified.Map(view["data"])
		if len([]rune(unified.Str(data["title"]))) != 80 {
			t.Fatalf("expected title truncated to 80 runes, got %d (%q)", len([]rune(unified.Str(data["title"]))), unified.Str(data["title"]))
		}
		author := unified.Map(data["author"])
		if unified.Str(author["id"]) != "MiuMiu99999999" ||
			unified.Str(author["name"]) != "MiuMiu Channel" ||
			unified.Str(author["url"]) != "https://x.com/MiuMiu99999999" ||
			author["avatar"] != nil {
			t.Fatalf("unexpected sanitized author: %+v", author)
		}
		items := unified.Slice(data["items"])
		if len(items) != 1 {
			t.Fatalf("expected 1 photo item, got %d", len(items))
		}
		item := unified.Map(items[0])
		def := unified.Map(item["default"])
		const wantOrigURL = "https://pbs.twimg.com/media/HCpE9UZaAAAHlX5?format=jpg&name=orig"
		if unified.Str(def["url"]) != wantOrigURL {
			t.Fatalf("default.url = %q, want %q", unified.Str(def["url"]), wantOrigURL)
		}
		meta := unified.Map(unified.Map(unified.Slice(item["variants"])[0])["metadata"])
		if meta["width"] != int64(2448) || meta["height"] != int64(3264) {
			t.Fatalf("expected 2448x3264 metadata, got %+v", meta)
		}
	})

	// 2. Four-photo tombstone album + /photo/N selection + out-of-bounds /photo/N.
	t.Run("tombstone-four-photos-and-photo-index-selection", func(t *testing.T) {
		const tweetID = "1900000000000000004"
		fxFourBody, _ := json.Marshal(map[string]any{
			"code": 200,
			"tweet": map[string]any{
				"text":   "Four restricted photos https://t.co/AlbumLink",
				"author": map[string]any{"name": "Artist", "screen_name": "artist_x"},
				"media": map[string]any{
					"photos": []map[string]any{
						{"url": "https://pbs.twimg.com/media/TombImg1.jpg?name=orig", "width": 2000, "height": 1500},
						{"url": "https://pbs.twimg.com/media/TombImg2.png?name=orig", "width": 1920, "height": 1080},
						{"url": "https://pbs.twimg.com/media/TombImg3?format=webp&name=large", "width": 1440, "height": 1800},
						{"url": "https://pbs.twimg.com:443/media/TombImg4.jpeg", "width": 1200, "height": 1200},
						{"url": "https://pbs.twimg.com/media/TombImg5Ignored.jpg", "width": 800, "height": 800},
					},
				},
			},
		})

		var fxCalls atomic.Int32
		var ytCalls atomic.Int32
		p, err := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					ytCalls.Add(1)
					return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "no video", Retryable: false}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					if strings.HasPrefix(req.URL, syndicationEndpointURL) {
						return fetch.Response{StatusCode: http.StatusOK, Body: tombstoneSynBody, URL: req.URL}, nil
					}
					fxCalls.Add(1)
					assertFxTwitterRequestHygiene(t, req, tweetID)
					return fetch.Response{StatusCode: http.StatusOK, Body: fxFourBody, URL: req.URL}, nil
				},
			},
		).WithTombstoneFallback(TombstoneFallbackFxTwitter)
		if err != nil {
			t.Fatal(err)
		}

		// Full status URL -> 4 photos + album group.
		fullEnv, err := p.Parse(context.Background(), "https://x.com/artist_x/status/"+tweetID, now)
		if err != nil {
			t.Fatalf("full 4-photo Parse failed: %v", err)
		}
		fullView := unified.PublicView(fullEnv, false, now)
		if err := unified.ValidateEnvelopeAt(fullView, now); err != nil {
			t.Fatalf("4-photo ValidateEnvelopeAt failed: %v", err)
		}
		if fxCalls.Load() != 1 {
			t.Fatalf("expected exactly 1 fxtwitter call, got %d", fxCalls.Load())
		}
		fullData := unified.Map(fullView["data"])
		items := unified.Slice(fullData["items"])
		if len(items) != 4 {
			t.Fatalf("expected 4 capped photo items, got %d", len(items))
		}
		wantURLs := []string{
			"https://pbs.twimg.com/media/TombImg1?format=jpg&name=orig",
			"https://pbs.twimg.com/media/TombImg2?format=png&name=orig",
			"https://pbs.twimg.com/media/TombImg3?format=webp&name=orig",
			"https://pbs.twimg.com/media/TombImg4?format=jpg&name=orig",
		}
		for i, want := range wantURLs {
			got := unified.Str(unified.Map(unified.Map(items[i])["default"])["url"])
			if got != want {
				t.Fatalf("item[%d] default.url = %q, want %q", i, got, want)
			}
		}
		groups := unified.Slice(fullData["groups"])
		if len(groups) != 1 || len(unified.Slice(unified.Map(groups[0])["item_ids"])) != 4 {
			t.Fatalf("expected 4-item album group, got %+v", groups)
		}

		// /photo/2 -> bypasses yt-dlp, returns only the 2nd photo.
		ytCallsBefore := ytCalls.Load()
		photo2Env, err := p.Parse(context.Background(), "https://x.com/artist_x/status/"+tweetID+"/photo/2", now)
		if err != nil {
			t.Fatalf("/photo/2 Parse failed: %v", err)
		}
		if ytCalls.Load() != ytCallsBefore {
			t.Fatalf("expected /photo/2 to bypass yt-dlp, ytCalls changed %d -> %d", ytCallsBefore, ytCalls.Load())
		}
		photo2View := unified.PublicView(photo2Env, false, now)
		if err := unified.ValidateEnvelopeAt(photo2View, now); err != nil {
			t.Fatalf("/photo/2 ValidateEnvelopeAt failed: %v", err)
		}
		photo2Items := unified.Slice(unified.Map(photo2View["data"])["items"])
		if len(photo2Items) != 1 || unified.Str(unified.Map(unified.Map(photo2Items[0])["default"])["url"]) != wantURLs[1] {
			t.Fatalf("unexpected /photo/2 items: %+v", photo2Items)
		}

		// Out-of-bounds /photo/3 on a 2-photo tombstone tweet -> CONTENT_UNAVAILABLE.
		fxTwoBody, _ := json.Marshal(map[string]any{
			"code": 200,
			"tweet": map[string]any{
				"text": "Two photos",
				"media": map[string]any{
					"photos": []map[string]any{
						{"url": "https://pbs.twimg.com/media/TombImg1.jpg", "width": 1000, "height": 1000},
						{"url": "https://pbs.twimg.com/media/TombImg2.jpg", "width": 1000, "height": 1000},
					},
				},
			},
		})
		pTwo, _ := NewWithFetcher(
			&stubExtractor{enabled: true},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					if strings.HasPrefix(req.URL, syndicationEndpointURL) {
						return fetch.Response{StatusCode: http.StatusOK, Body: tombstoneSynBody, URL: req.URL}, nil
					}
					return fetch.Response{StatusCode: http.StatusOK, Body: fxTwoBody, URL: req.URL}, nil
				},
			},
		).WithTombstoneFallback(TombstoneFallbackFxTwitter)
		oobEnv, err := pTwo.Parse(context.Background(), "https://x.com/artist_x/status/"+tweetID+"/photo/3", now)
		if err != nil || unified.Str(oobEnv["code"]) != "CONTENT_UNAVAILABLE" {
			t.Fatalf("expected CONTENT_UNAVAILABLE for out-of-bounds /photo/3, got env=%+v err=%v", oobEnv, err)
		}
	})

	// 3. Tombstone video (progressive MP4s + master .m3u8 + SizeProber + /video/1 + HLS-only).
	t.Run("tombstone-video-and-hls-only", func(t *testing.T) {
		const tweetID = "1900000000000000005"
		const mp4Best = "https://video.twimg.com/amplify_video/1900000000000000001/vid/avc1/728x720/best720.mp4?tag=14"
		const mp4Low = "https://video.twimg.com/amplify_video/1900000000000000001/vid/avc1/364x360/low360.mp4?tag=14"
		const thumbURL = "https://pbs.twimg.com/amplify_video_thumb/1900000000000000001/img/cover.jpg"

		fxVideoBody, _ := json.Marshal(map[string]any{
			"code": 200,
			"tweet": map[string]any{
				"text":   "Restricted video post https://t.co/VidLink",
				"author": map[string]any{"name": "VideoAuthor", "screen_name": "vid_author"},
				"media": map[string]any{
					"videos": []map[string]any{
						{
							"id":            "1900000000000000001",
							"type":          "video",
							"url":           mp4Best,
							"thumbnail_url": thumbURL,
							"duration":      15.488,
							"width":         728,
							"height":        720,
							"formats": []map[string]any{
								{
									"url":       "https://video.twimg.com/amplify_video/1900000000000000001/pl/master.m3u8?tag=14",
									"container": "m3u8",
								},
								{
									"url":       mp4Low,
									"bitrate":   832000,
									"container": "mp4",
									"codec":     "h264",
								},
								{
									"url":       mp4Best,
									"bitrate":   2176000,
									"container": "mp4",
									"codec":     "h264",
								},
							},
						},
					},
				},
			},
		})

		for _, targetURL := range []string{
			"https://x.com/vid_author/status/" + tweetID,
			"https://x.com/vid_author/status/" + tweetID + "/video/1",
		} {
			var fxCalls atomic.Int32
			p, err := NewWithFetcher(
				&stubExtractor{
					enabled: true,
					extract: func(context.Context, string) (*ytengine.Info, error) {
						return nil, &ytengine.Error{Code: ytengine.CodeUpstreamBlocked, Message: "NSFW tweet requires login", Retryable: false}
					},
				},
				func(_ context.Context, rawURL string) (int64, bool) {
					if rawURL == mp4Best {
						return 4194304, true
					}
					return 0, false
				},
				fakeXFetcher{
					fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
						if strings.HasPrefix(req.URL, syndicationEndpointURL) {
							return fetch.Response{StatusCode: http.StatusOK, Body: tombstoneSynBody, URL: req.URL}, nil
						}
						fxCalls.Add(1)
						assertFxTwitterRequestHygiene(t, req, tweetID)
						return fetch.Response{StatusCode: http.StatusOK, Body: fxVideoBody, URL: req.URL}, nil
					},
				},
			).WithTombstoneFallback(TombstoneFallbackFxTwitter)
			if err != nil {
				t.Fatal(err)
			}

			env, err := p.Parse(context.Background(), targetURL, now)
			if err != nil {
				t.Fatalf("Parse(%s) failed: %v", targetURL, err)
			}
			if fxCalls.Load() != 1 {
				t.Fatalf("Parse(%s): fxCalls = %d, want 1", targetURL, fxCalls.Load())
			}
			view := unified.PublicView(env, false, now)
			if err := unified.ValidateEnvelopeAt(view, now); err != nil {
				t.Fatalf("Parse(%s) ValidateEnvelopeAt failed: %v", targetURL, err)
			}
			data := unified.Map(view["data"])
			if unified.Str(unified.Map(data["cover"])["url"]) != thumbURL {
				t.Fatalf("unexpected cover: %+v", data["cover"])
			}
			items := unified.Slice(data["items"])
			if len(items) != 1 {
				t.Fatalf("expected 1 video item, got %d", len(items))
			}
			item := unified.Map(items[0])
			if unified.Str(item["type"]) != "video" || item["duration_ms"] != int64(15488) {
				t.Fatalf("unexpected video item fields: %+v", item)
			}
			def := unified.Map(item["default"])
			if unified.Str(def["url"]) != mp4Best {
				t.Fatalf("expected default MP4 %q, got %+v", mp4Best, def)
			}
			variants := unified.Slice(item["variants"])
			if len(variants) != 2 {
				t.Fatalf("expected 2 progressive MP4 variants (master m3u8 skipped), got %d: %+v", len(variants), variants)
			}
			bestMeta := unified.Map(unified.Map(variants[0])["metadata"])
			if bestMeta["width"] != int64(728) || bestMeta["height"] != int64(720) || bestMeta["bitrate_bps"] != int64(2176000) || bestMeta["has_audio"] != true {
				t.Fatalf("unexpected 720p metadata: %+v", bestMeta)
			}
			bestSrc := unified.Map(unified.Slice(unified.Map(unified.Map(variants[0])["delivery"])["sources"])[0])
			if bestSrc["size_bytes"] != int64(4194304) {
				t.Fatalf("expected probed size_bytes=4194304, got %+v", bestSrc)
			}
		}

		// HLS-only tombstone video succeeds when no MP4 is available.
		fxHLSOnlyBody, _ := json.Marshal(map[string]any{
			"code": 200,
			"tweet": map[string]any{
				"text": "HLS only restricted video",
				"media": map[string]any{
					"videos": []map[string]any{
						{
							"id":            "1900000000000000099",
							"type":          "video",
							"url":           "https://video.twimg.com/amplify_video/1900000000000000099/pl/1280x720/playlist.m3u8",
							"thumbnail_url": thumbURL,
							"duration":      10.0,
						},
					},
				},
			},
		})
		pHLS, _ := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeUpstreamBlocked, Message: "blocked", Retryable: false}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					if strings.HasPrefix(req.URL, syndicationEndpointURL) {
						return fetch.Response{StatusCode: http.StatusOK, Body: tombstoneSynBody, URL: req.URL}, nil
					}
					return fetch.Response{StatusCode: http.StatusOK, Body: fxHLSOnlyBody, URL: req.URL}, nil
				},
			},
		).WithTombstoneFallback(TombstoneFallbackFxTwitter)
		hlsEnv, err := pHLS.Parse(context.Background(), "https://x.com/vid_author/status/"+tweetID, now)
		if err != nil {
			t.Fatalf("HLS-only Parse failed: %v", err)
		}
		hlsView := unified.PublicView(hlsEnv, false, now)
		if err := unified.ValidateEnvelopeAt(hlsView, now); err != nil {
			t.Fatalf("HLS-only ValidateEnvelopeAt failed: %v", err)
		}
		if unified.Str(hlsView["code"]) != "OK" {
			t.Fatalf("expected OK on HLS-only tombstone video, got %+v", hlsView)
		}
	})

	// 4. Tombstone GIF (type="gif", silent /tweet_video/<key>.mp4, duration=0, bitrate=0).
	t.Run("tombstone-gif", func(t *testing.T) {
		const tweetID = "1900000000000000006"
		const gifURL = "https://video.twimg.com/tweet_video/GifKeyAbc123.mp4"
		const gifThumb = "https://pbs.twimg.com/tweet_video_thumb/GifKeyAbc123.jpg"

		fxGIFBody, _ := json.Marshal(map[string]any{
			"code": 200,
			"tweet": map[string]any{
				"text":   "Restricted animated GIF",
				"author": map[string]any{"name": "GifMaker", "screen_name": "gif_maker"},
				"media": map[string]any{
					"videos": []map[string]any{
						{
							"id":            "1900000000000000002",
							"type":          "gif",
							"url":           gifURL,
							"thumbnail_url": gifThumb,
							"duration":      0,
							"width":         498,
							"height":        280,
							"formats": []map[string]any{
								{
									"url":       gifURL,
									"bitrate":   0,
									"container": "mp4",
									"codec":     "h264",
								},
							},
						},
					},
				},
			},
		})

		p, err := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeUpstreamBlocked, Message: "restricted", Retryable: false}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					if strings.HasPrefix(req.URL, syndicationEndpointURL) {
						return fetch.Response{StatusCode: http.StatusOK, Body: tombstoneSynBody, URL: req.URL}, nil
					}
					assertFxTwitterRequestHygiene(t, req, tweetID)
					return fetch.Response{StatusCode: http.StatusOK, Body: fxGIFBody, URL: req.URL}, nil
				},
			},
		).WithTombstoneFallback(TombstoneFallbackFxTwitter)
		if err != nil {
			t.Fatal(err)
		}

		env, err := p.Parse(context.Background(), "https://x.com/gif_maker/status/"+tweetID, now)
		if err != nil {
			t.Fatalf("GIF Parse failed: %v", err)
		}
		view := unified.PublicView(env, false, now)
		if err := unified.ValidateEnvelopeAt(view, now); err != nil {
			t.Fatalf("GIF ValidateEnvelopeAt failed: %v", err)
		}
		item := unified.Map(unified.Slice(unified.Map(view["data"])["items"])[0])
		if item["duration_ms"] != nil {
			t.Fatalf("GIF with duration=0 must omit duration_ms, got %v", item["duration_ms"])
		}
		if unified.Str(unified.Map(item["default"])["url"]) != gifURL {
			t.Fatalf("expected GIF default.url=%q, got %+v", gifURL, item["default"])
		}
		meta := unified.Map(unified.Map(unified.Slice(item["variants"])[0])["metadata"])
		if meta["has_audio"] != false || meta["width"] != int64(498) || meta["height"] != int64(280) {
			t.Fatalf("unexpected GIF metadata: %+v", meta)
		}
	})
}

func TestParseXTombstoneSpoofedMediaHostsDiscarded(t *testing.T) {
	const now int64 = 1762300800
	const tweetID = "1900000000000000007"
	tombstoneSynBody := []byte(`{"__typename":"TweetTombstone"}`)

	spoofedPhotos := []map[string]any{
		{"url": "https://pbs.twimg.com.evil/media/Spoof1.jpg", "width": 1000, "height": 1000},
		{"url": "https://evilpbs.twimg.com/media/Spoof2.jpg", "width": 1000, "height": 1000},
		{"url": "https://sub.pbs.twimg.com/media/Spoof3.jpg", "width": 1000, "height": 1000},
		{"url": "https://user:secret@pbs.twimg.com/media/Spoof4.jpg", "width": 1000, "height": 1000},
		{"url": "https://pbs.twimg.com:8443/media/Spoof5.jpg", "width": 1000, "height": 1000},
		{"url": "https://pbs.twimg.com:80/media/Spoof6.jpg", "width": 1000, "height": 1000},
		{"url": "http://pbs.twimg.com/media/Spoof7.jpg", "width": 1000, "height": 1000},
		{"url": "https://video.twimg.com/media/Spoof8.jpg", "width": 1000, "height": 1000},
		{"url": "https://mosaic.fxtwitter.com/jpeg/Spoof9.jpg", "width": 1000, "height": 1000},
	}

	// 1a. All photos spoofed -> 403 UPSTREAM_BLOCKED.
	allSpoofPhotoBody, _ := json.Marshal(map[string]any{
		"code": 200,
		"tweet": map[string]any{
			"text":  "All spoofed photos",
			"media": map[string]any{"photos": spoofedPhotos},
		},
	})
	makeParser := func(fxBody []byte) *Parser {
		p, err := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeUpstreamBlocked, Message: "blocked", Retryable: false}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					if strings.HasPrefix(req.URL, syndicationEndpointURL) {
						return fetch.Response{StatusCode: http.StatusOK, Body: tombstoneSynBody, URL: req.URL}, nil
					}
					return fetch.Response{StatusCode: http.StatusOK, Body: fxBody, URL: req.URL}, nil
				},
			},
		).WithTombstoneFallback(TombstoneFallbackFxTwitter)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}

	env, err := makeParser(allSpoofPhotoBody).Parse(context.Background(), "https://x.com/u/status/"+tweetID, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := unified.ValidateEnvelopeAt(env, now); err != nil {
		t.Fatal(err)
	}
	if unified.Str(env["code"]) != "UPSTREAM_BLOCKED" || unified.Map(env["error"])["retryable"] == true {
		t.Fatalf("expected UPSTREAM_BLOCKED when all photo URLs are spoofed, got %+v", env)
	}

	// 1b. Spoofed photos mixed with 1 valid pbs.twimg.com photo -> discards spoofed entries, keeps only valid photo.
	mixedPhotos := append([]map[string]any{}, spoofedPhotos...)
	mixedPhotos = append(mixedPhotos, map[string]any{
		"url":    "https://pbs.twimg.com/media/ValidSafeKey.png?name=large",
		"width":  1600,
		"height": 900,
	})
	mixedSpoofPhotoBody, _ := json.Marshal(map[string]any{
		"code": 200,
		"tweet": map[string]any{
			"text":  "Mixed spoofed and valid photo",
			"media": map[string]any{"photos": mixedPhotos},
		},
	})
	validPhotoEnv, err := makeParser(mixedSpoofPhotoBody).Parse(context.Background(), "https://x.com/u/status/"+tweetID, now)
	if err != nil {
		t.Fatal(err)
	}
	validPhotoView := unified.PublicView(validPhotoEnv, false, now)
	if err := unified.ValidateEnvelopeAt(validPhotoView, now); err != nil {
		t.Fatal(err)
	}
	photoItems := unified.Slice(unified.Map(validPhotoView["data"])["items"])
	if len(photoItems) != 1 || unified.Str(unified.Map(unified.Map(photoItems[0])["default"])["url"]) != "https://pbs.twimg.com/media/ValidSafeKey?format=png&name=orig" {
		t.Fatalf("expected only the 1 valid pbs.twimg.com photo to survive, got %+v", photoItems)
	}

	// 2a. All video stream URLs spoofed -> 403 UPSTREAM_BLOCKED.
	spoofedFormats := []map[string]any{
		{"url": "https://video.twimg.com.evil/ext_tw_video/1/pu/vid/1280x720/a.mp4", "bitrate": 2176000, "container": "mp4"},
		{"url": "https://evilvideo.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4", "bitrate": 2176000, "container": "mp4"},
		{"url": "https://sub.video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4", "bitrate": 2176000, "container": "mp4"},
		{"url": "https://user:pass@video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4", "bitrate": 2176000, "container": "mp4"},
		{"url": "https://video.twimg.com:8443/ext_tw_video/1/pu/vid/1280x720/a.mp4", "bitrate": 2176000, "container": "mp4"},
		{"url": "https://video.twimg.com:80/ext_tw_video/1/pu/vid/1280x720/a.mp4", "bitrate": 2176000, "container": "mp4"},
		{"url": "http://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4", "bitrate": 2176000, "container": "mp4"},
		{"url": "https://pbs.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4", "bitrate": 2176000, "container": "mp4"},
		{"url": "https://d.fxtwitter.com/ext_tw_video/1/pu/vid/1280x720/a.mp4", "bitrate": 2176000, "container": "mp4"},
		{"url": "https://video.twimg.com/ext_tw_video/..%2fsecret/a.mp4", "bitrate": 2176000, "container": "mp4"},
		{"url": "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.html", "bitrate": 2176000, "container": "mp4"},
	}
	allSpoofVideoBody, _ := json.Marshal(map[string]any{
		"code": 200,
		"tweet": map[string]any{
			"text": "All spoofed videos",
			"media": map[string]any{
				"videos": []map[string]any{
					{
						"id":            "1",
						"type":          "video",
						"url":           "https://d.fxtwitter.com/spoof.mp4",
						"thumbnail_url": "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/ok.jpg",
						"formats":       spoofedFormats,
					},
				},
			},
		},
	})
	spoofVidEnv, err := makeParser(allSpoofVideoBody).Parse(context.Background(), "https://x.com/u/status/"+tweetID, now)
	if err != nil {
		t.Fatal(err)
	}
	if unified.Str(spoofVidEnv["code"]) != "UPSTREAM_BLOCKED" {
		t.Fatalf("expected UPSTREAM_BLOCKED when all video stream URLs are spoofed, got %+v", spoofVidEnv)
	}

	// 2b. Valid video.twimg.com stream + spoofed cover URLs -> spoofed cover discarded, valid video kept without cover.
	for _, badCover := range []string{
		"https://pbs.twimg.com.evil/thumb.jpg",
		"https://evilpbs.twimg.com/thumb.jpg",
		"https://user:pass@pbs.twimg.com/thumb.jpg",
		"https://pbs.twimg.com:8443/thumb.jpg",
		"http://pbs.twimg.com/thumb.jpg",
		"https://video.twimg.com/thumb.jpg",
		"https://pbs.twimg.com/thumb.html",
	} {
		formatsWithOneValid := append([]map[string]any{}, spoofedFormats...)
		formatsWithOneValid = append(formatsWithOneValid, map[string]any{
			"url":       "https://video.twimg.com:443/ext_tw_video/1/pu/vid/1280x720/clean.mp4?tag=12",
			"bitrate":   2176000,
			"container": "mp4",
			"codec":     "h264",
		})
		bodyWithBadCover, _ := json.Marshal(map[string]any{
			"code": 200,
			"tweet": map[string]any{
				"text": "Valid stream with spoofed cover",
				"media": map[string]any{
					"videos": []map[string]any{
						{
							"id":            "1",
							"type":          "video",
							"url":           "https://d.fxtwitter.com/ignored.mp4",
							"thumbnail_url": badCover,
							"duration":      5.0,
							"formats":       formatsWithOneValid,
						},
					},
				},
			},
		})
		cleanVidEnv, err := makeParser(bodyWithBadCover).Parse(context.Background(), "https://x.com/u/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		cleanVidView := unified.PublicView(cleanVidEnv, false, now)
		if err := unified.ValidateEnvelopeAt(cleanVidView, now); err != nil {
			t.Fatalf("badCover=%q ValidateEnvelopeAt failed: %v", badCover, err)
		}
		data := unified.Map(cleanVidView["data"])
		if data["cover"] != nil {
			t.Fatalf("badCover=%q leaked into data.cover: %+v", badCover, data["cover"])
		}
		item := unified.Map(unified.Slice(data["items"])[0])
		if item["cover"] != nil {
			t.Fatalf("badCover=%q leaked into item.cover: %+v", badCover, item["cover"])
		}
		if gotURL := unified.Str(unified.Map(item["default"])["url"]); gotURL != "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/clean.mp4?tag=12" {
			t.Fatalf("unexpected clean video URL: %q", gotURL)
		}
	}
}

func TestParseXTombstoneFallbackErrorSemanticsAndTriggerBoundaries(t *testing.T) {
	const now int64 = 1762300800
	const tweetID = "2119994769057132696"
	const tweetURL = "https://x.com/MiuMiu99999999/status/" + tweetID
	tombstoneSynBody := []byte(`{"__typename":"TweetTombstone"}`)

	// 1. Fallback response failure matrix: 404 -> CONTENT_UNAVAILABLE; everything else -> 403 UPSTREAM_BLOCKED.
	oversizedBody := append([]byte(`{"code":200,"pad":"`), append([]byte(strings.Repeat("a", (256<<10)+32)), []byte(`"}`)...)...)
	failureCases := []struct {
		name     string
		fxFn     func(context.Context, fetch.Request) (fetch.Response, error)
		wantCode string
	}{
		{
			name: "fx-404-not-found",
			fxFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: http.StatusNotFound, Body: []byte(`{"code":404,"message":"NOT_FOUND"}`), URL: req.URL}, nil
			},
			wantCode: "CONTENT_UNAVAILABLE",
		},
		{
			name: "fx-redirect-302-status",
			fxFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				hdr := make(http.Header)
				hdr.Set("Location", "https://fxtwitter.com/i/status/"+tweetID)
				return fetch.Response{StatusCode: http.StatusFound, Header: hdr, URL: req.URL}, nil
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
		{
			name: "fx-redirect-301-status",
			fxFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: http.StatusMovedPermanently, URL: req.URL}, nil
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
		{
			name: "fx-err-redirect",
			fxFn: func(context.Context, fetch.Request) (fetch.Response, error) {
				return fetch.Response{}, fetch.ErrRedirect
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
		{
			name: "fx-oversized-err-limit",
			fxFn: func(context.Context, fetch.Request) (fetch.Response, error) {
				return fetch.Response{}, fetch.ErrLimit
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
		{
			name: "fx-oversized-raw-body-over-256kib",
			fxFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: http.StatusOK, Body: oversizedBody, URL: req.URL}, nil
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
		{
			name: "fx-timeout",
			fxFn: func(context.Context, fetch.Request) (fetch.Response, error) {
				return fetch.Response{}, context.DeadlineExceeded
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
		{
			name: "fx-policy-blocked",
			fxFn: func(context.Context, fetch.Request) (fetch.Response, error) {
				return fetch.Response{}, fetch.ErrPolicy
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
		{
			name: "fx-non-json-html",
			fxFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: http.StatusOK, Body: []byte(`<!DOCTYPE html><html>challenge</html>`), URL: req.URL}, nil
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
		{
			name: "fx-malformed-json",
			fxFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: http.StatusOK, Body: []byte(`{"code":200,"tweet":`), URL: req.URL}, nil
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
		{
			name: "fx-500-server-error",
			fxFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: http.StatusInternalServerError, Body: []byte(`{"code":500}`), URL: req.URL}, nil
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
		{
			name: "fx-403-blocked",
			fxFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: http.StatusForbidden, Body: []byte(`forbidden`), URL: req.URL}, nil
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
		{
			name: "fx-200-without-media",
			fxFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: http.StatusOK, Body: []byte(`{"code":200,"tweet":{"text":"text only restricted post"}}`), URL: req.URL}, nil
			},
			wantCode: "UPSTREAM_BLOCKED",
		},
	}

	for _, tc := range failureCases {
		t.Run(tc.name, func(t *testing.T) {
			var fxCalls atomic.Int32
			p, err := NewWithFetcher(
				&stubExtractor{
					enabled: true,
					extract: func(context.Context, string) (*ytengine.Info, error) {
						return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "no video", Retryable: false}
					},
				},
				nil,
				fakeXFetcher{
					fn: func(ctx context.Context, req fetch.Request) (fetch.Response, error) {
						if strings.HasPrefix(req.URL, syndicationEndpointURL) {
							return fetch.Response{StatusCode: http.StatusOK, Body: tombstoneSynBody, URL: req.URL}, nil
						}
						fxCalls.Add(1)
						assertFxTwitterRequestHygiene(t, req, tweetID)
						return tc.fxFn(ctx, req)
					},
				},
			).WithTombstoneFallback(TombstoneFallbackFxTwitter)
			if err != nil {
				t.Fatal(err)
			}

			env, err := p.Parse(context.Background(), tweetURL, now)
			if err != nil {
				t.Fatalf("unexpected Go error: %v", err)
			}
			if fxCalls.Load() != 1 {
				t.Fatalf("expected exactly 1 fxtwitter call, got %d", fxCalls.Load())
			}
			if err := unified.ValidateEnvelopeAt(env, now); err != nil {
				t.Fatalf("ValidateEnvelopeAt failed: %v", err)
			}
			if got := unified.Str(env["code"]); got != tc.wantCode {
				t.Fatalf("code = %q, want %q (env=%+v)", got, tc.wantCode, env)
			}
			errObj := unified.Map(env["error"])
			if errObj["retryable"] == true {
				t.Fatalf("expected non-retryable error, got %+v", errObj)
			}
			if tc.wantCode == "UPSTREAM_BLOCKED" && unified.Str(errObj["message"]) != tombstoneBlockedMessage {
				t.Fatalf("expected platform-neutral blocked message %q, got %q", tombstoneBlockedMessage, unified.Str(errObj["message"]))
			}
		})
	}

	// 2. Switch "off" (both default and explicit): NEVER calls fxtwitter, returns 403 UPSTREAM_BLOCKED on Tombstone.
	t.Run("switch-off-never-requests-fxtwitter-and-returns-upstream-blocked", func(t *testing.T) {
		defaultP := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "no video", Retryable: false}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					if !strings.HasPrefix(req.URL, syndicationEndpointURL) {
						t.Fatalf("switch off must never request fxtwitter, got %s", req.URL)
					}
					return fetch.Response{StatusCode: http.StatusOK, Body: tombstoneSynBody, URL: req.URL}, nil
				},
			},
		)
		explicitOffP, err := defaultP.WithTombstoneFallback(TombstoneFallbackOff)
		if err != nil {
			t.Fatal(err)
		}

		for _, p := range []*Parser{defaultP, explicitOffP} {
			for _, u := range []string{tweetURL, tweetURL + "/photo/1"} {
				env, err := p.Parse(context.Background(), u, now)
				if err != nil {
					t.Fatalf("Parse(%s) error: %v", u, err)
				}
				if err := unified.ValidateEnvelopeAt(env, now); err != nil {
					t.Fatal(err)
				}
				if unified.Str(env["code"]) != "UPSTREAM_BLOCKED" ||
					unified.Str(unified.Map(env["error"])["message"]) != tombstoneBlockedMessage ||
					unified.Map(env["error"])["retryable"] == true {
					t.Fatalf("Parse(%s) with switch off = %+v, want UPSTREAM_BLOCKED", u, env)
				}
			}
		}
	})

	// 3. Normal tweets, syndication errors, and Tombstone-when-yt-dlp-got-video NEVER request fxtwitter.
	t.Run("normal-tweets-and-syndication-errors-never-request-fxtwitter", func(t *testing.T) {
		noFxCases := []struct {
			name    string
			ytFn    func(context.Context, string) (*ytengine.Info, error)
			synFn   func(context.Context, fetch.Request) (fetch.Response, error)
			wantErr string
		}{
			{
				name: "normal-photo-tweet",
				ytFn: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "no video", Retryable: false}
				},
				synFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{
						StatusCode: http.StatusOK,
						Body:       []byte(`{"__typename":"Tweet","text":"Normal photo","photos":[{"url":"https://pbs.twimg.com/media/NormalKey.jpg","width":800,"height":600}]}`),
						URL:        req.URL,
					}, nil
				},
				wantErr: "OK",
			},
			{
				name: "normal-text-only-tweet",
				ytFn: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "no video", Retryable: false}
				},
				synFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{
						StatusCode: http.StatusOK,
						Body:       []byte(`{"__typename":"Tweet","text":"Just text"}`),
						URL:        req.URL,
					}, nil
				},
				wantErr: "NO_MEDIA",
			},
			{
				name: "pure-text-tweet-with-external-link",
				ytFn: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "ERROR: [twitter] 123: No video could be found in this tweet", Retryable: false}
				},
				synFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{
						StatusCode: http.StatusOK,
						Body:       []byte(`{"__typename":"Tweet","text":"Read this article https://t.co/abcDEF123"}`),
						URL:        req.URL,
					}, nil
				},
				wantErr: "NO_MEDIA",
			},
			{
				name: "pure-text-tweet-empty-info",
				ytFn: func(context.Context, string) (*ytengine.Info, error) {
					return &ytengine.Info{ID: tweetID, Title: "Just text"}, nil
				},
				synFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{
						StatusCode: http.StatusOK,
						Body:       []byte(`{"__typename":"Tweet","text":"Just text"}`),
						URL:        req.URL,
					}, nil
				},
				wantErr: "NO_MEDIA",
			},
			{
				name: "syndication-network-error",
				ytFn: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "no video", Retryable: false}
				},
				synFn: func(context.Context, fetch.Request) (fetch.Response, error) {
					return fetch.Response{}, errors.New("dial tcp: connection reset")
				},
				wantErr: "UPSTREAM_UNAVAILABLE",
			},
			{
				name: "syndication-timeout",
				ytFn: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "no video", Retryable: false}
				},
				synFn: func(context.Context, fetch.Request) (fetch.Response, error) {
					return fetch.Response{}, context.DeadlineExceeded
				},
				wantErr: "UPSTREAM_TIMEOUT",
			},
			{
				name: "syndication-404",
				ytFn: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "not found", Retryable: false}
				},
				synFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusNotFound, Body: []byte(`not found`), URL: req.URL}, nil
				},
				wantErr: "CONTENT_UNAVAILABLE",
			},
			{
				name: "tombstone-but-ytdlp-already-obtained-video",
				ytFn: func(context.Context, string) (*ytengine.Info, error) {
					return &ytengine.Info{
						ID:        "999",
						DisplayID: tweetID,
						Title:     "Primary yt-dlp video",
						Formats: []ytengine.Format{
							{
								FormatID: "http-2176",
								URL:      "https://video.twimg.com/ext_tw_video/999/pu/vid/1280x720/v.mp4",
								Ext:      "mp4",
								Protocol: "https",
								Width:    int64Ptr(1280),
								Height:   int64Ptr(720),
								VCodec:   "h264",
							},
						},
					}, nil
				},
				synFn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: tombstoneSynBody, URL: req.URL}, nil
				},
				wantErr: "OK",
			},
		}

		for _, tc := range noFxCases {
			t.Run(tc.name, func(t *testing.T) {
				p, err := NewWithFetcher(
					&stubExtractor{enabled: true, extract: tc.ytFn},
					nil,
					fakeXFetcher{
						fn: func(ctx context.Context, req fetch.Request) (fetch.Response, error) {
							if !strings.HasPrefix(req.URL, syndicationEndpointURL) {
								t.Fatalf("%s must NEVER request fxtwitter, got %s", tc.name, req.URL)
							}
							return tc.synFn(ctx, req)
						},
					},
				).WithTombstoneFallback(TombstoneFallbackFxTwitter)
				if err != nil {
					t.Fatal(err)
				}
				env, err := p.Parse(context.Background(), tweetURL, now)
				if err != nil {
					t.Fatalf("%s Go error: %v", tc.name, err)
				}
				if got := unified.Str(env["code"]); got != tc.wantErr {
					t.Fatalf("%s code = %q, want %q (env=%+v)", tc.name, got, tc.wantErr, env)
				}
			})
		}
	})
}
