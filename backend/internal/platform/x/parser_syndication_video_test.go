package x

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func TestParseXSyndicationVideoFastPathMatrix(t *testing.T) {
	const now int64 = 1762300800

	// 1a. Single amplify_video tweet where original_info (886x876) differs from actual MP4 path dimensions
	// (728x720, 364x360, 272x270): fast-path builds unified-v1 directly without invoking yt-dlp,
	// probes MP4 byte sizes only (never m3u8), and normalizes pbs.twimg.com cover with ?name=orig.
	t.Run("single-amplify-video-zero-ytdlp-and-size-prober", func(t *testing.T) {
		const tweetID = "1790637656616943991"
		const sourceURL = "https://x.com/historyinmemes/status/" + tweetID
		const mp4720 = "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/728x720/kF5AeH6MK-1qDlBg.mp4?tag=14"
		const mp4360 = "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/364x360/MhZUmBoG84GGC0fb.mp4?tag=14"
		const mp4270 = "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/272x270/du7PkQofwIDrjAEz.mp4?tag=14"
		const m3u8Master = "https://video.twimg.com/amplify_video/1790637589910654976/pl/osiKl6ALz2B8l9Cw.m3u8?tag=14&v=cfc"

		synBody, _ := json.Marshal(map[string]any{
			"__typename":         "Tweet",
			"id_str":             tweetID,
			"text":               "One of the most intense moments in history https://t.co/Zgzhvix8ES",
			"created_at":         "2024-05-15T06:57:40.000Z",
			"favorite_count":     132404,
			"conversation_count": 827,
			"user": map[string]any{
				"name":        "Historic Vids",
				"screen_name": "historyinmemes",
			},
			"mediaDetails": []map[string]any{
				{
					"type":            "video",
					"media_url_https": "https://pbs.twimg.com/amplify_video_thumb/1790637589910654976/img/jyhLQQZkq-lJJ9fN.jpg",
					"original_info":   map[string]any{"width": 886, "height": 876},
					"sizes":           map[string]any{"large": map[string]any{"w": 886, "h": 876}},
					"video_info": map[string]any{
						"duration_millis": 15488,
						"variants": []map[string]any{
							{"content_type": "application/x-mpegURL", "url": m3u8Master},
							{"bitrate": 288000, "content_type": "video/mp4", "url": mp4270},
							{"bitrate": 832000, "content_type": "video/mp4", "url": mp4360},
							{"bitrate": 2176000, "content_type": "video/mp4", "url": mp4720},
						},
					},
				},
			},
		})

		var ytCalls atomic.Int32
		var probedMu sync.Mutex
		probedURLs := make([]string, 0, 3)

		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					ytCalls.Add(1)
					return nil, errors.New("yt-dlp must not be spawned on syndication video fast-path")
				},
			},
			func(_ context.Context, rawURL string) (int64, bool) {
				probedMu.Lock()
				probedURLs = append(probedURLs, rawURL)
				probedMu.Unlock()
				if rawURL == mp4720 {
					return 4212736, true
				}
				return 0, false
			},
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: synBody, URL: req.URL}, nil
				},
			},
		)

		env, err := p.Parse(context.Background(), sourceURL, now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		if ytCalls.Load() != 0 {
			t.Fatalf("expected 0 yt-dlp calls on fast-path, got %d", ytCalls.Load())
		}
		for _, u := range probedURLs {
			if strings.Contains(u, ".m3u8") {
				t.Fatalf("SizeProber must never probe HLS master playlist: %q", u)
			}
		}

		view := unified.PublicView(env, false, now)
		if err := unified.ValidateEnvelopeAt(view, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		data := unified.Map(view["data"])
		if got := unified.Str(data["title"]); got != "Historic Vids - One of the most intense moments in history" {
			t.Fatalf("unexpected title: %q", got)
		}
		if got := unified.Str(data["published_at"]); got != "2024-05-15T06:57:40Z" {
			t.Fatalf("unexpected published_at: %q", got)
		}
		wantCover := "https://pbs.twimg.com/amplify_video_thumb/1790637589910654976/img/jyhLQQZkq-lJJ9fN.jpg?name=orig"
		if got := unified.Str(unified.Map(data["cover"])["url"]); got != wantCover {
			t.Fatalf("cover = %q, want %q", got, wantCover)
		}

		items := unified.Slice(data["items"])
		if len(items) != 1 {
			t.Fatalf("expected 1 video item, got %d", len(items))
		}
		item := unified.Map(items[0])
		if item["duration_ms"] != int64(15488) {
			t.Fatalf("duration_ms = %v, want 15488", item["duration_ms"])
		}
		if got := unified.Str(unified.Map(item["default"])["url"]); got != mp4720 {
			t.Fatalf("default.url = %q, want %q", got, mp4720)
		}
		variants := unified.Slice(item["variants"])
		if len(variants) != 3 {
			t.Fatalf("expected 3 progressive MP4 variants, got %d", len(variants))
		}
		wantDims := [][3]int64{
			{728, 720, 2176000},
			{364, 360, 832000},
			{272, 270, 288000},
		}
		wantLabels := []string{"720p", "360p", "270p"}
		for i, v := range variants {
			vm := unified.Map(v)
			if got := unified.Str(vm["label"]); got != wantLabels[i] {
				t.Fatalf("variant[%d] label = %q, want %q", i, got, wantLabels[i])
			}
			meta := unified.Map(vm["metadata"])
			if meta["width"] != wantDims[i][0] || meta["height"] != wantDims[i][1] || meta["bitrate_bps"] != wantDims[i][2] || meta["has_audio"] != true {
				t.Fatalf("variant[%d] metadata mismatch: %+v", i, meta)
			}
		}
		src0 := unified.Map(unified.Slice(unified.Map(unified.Map(variants[0])["delivery"])["sources"])[0])
		if src0["size_bytes"] != int64(4212736) {
			t.Fatalf("expected probed size_bytes=4212736 on 720p variant, got %+v", src0)
		}
	})

	// 1b. Multi-video playlist (4 videos) + /video/3 selection + out-of-bounds /video/4 on 2-video tweet.
	t.Run("multi-video-playlist-and-video-index-selection", func(t *testing.T) {
		const tweetID = "1577719286659006464"
		makeEntry := func(mediaID string, durMS int64) map[string]any {
			return map[string]any{
				"id_str":          mediaID,
				"type":            "video",
				"media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/" + mediaID + "/pu/img/thumb.jpg",
				"original_info":   map[string]any{"width": 1280, "height": 720},
				"sizes":           map[string]any{"large": map[string]any{"w": 1280, "h": 720}},
				"video_info": map[string]any{
					"duration_millis": durMS,
					"variants": []map[string]any{
						{"content_type": "application/x-mpegURL", "url": "https://video.twimg.com/ext_tw_video/" + mediaID + "/pu/pl/master.m3u8?tag=12"},
						{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/" + mediaID + "/pu/vid/1280x720/v720.mp4?tag=12"},
						{"bitrate": 832000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/" + mediaID + "/pu/vid/640x360/v360.mp4?tag=12"},
					},
				},
			}
		}

		fourVidBody, _ := json.Marshal(map[string]any{
			"__typename": "Tweet",
			"id_str":     tweetID,
			"text":       "Test https://t.co/Y3KEZD7Dad",
			"user":       map[string]any{"name": "Ultima", "screen_name": "UltimaShadowX"},
			"mediaDetails": []map[string]any{
				makeEntry("1577719236209922048", 4266),
				makeEntry("1577719252450267136", 2100),
				makeEntry("1577719262554365953", 4766),
				makeEntry("1577719274625572864", 3700),
			},
		})

		var ytCalls atomic.Int32
		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					ytCalls.Add(1)
					return nil, errors.New("unexpected yt-dlp call")
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: fourVidBody, URL: req.URL}, nil
				},
			},
		)

		fullEnv, err := p.Parse(context.Background(), "https://x.com/UltimaShadowX/status/"+tweetID, now)
		if err != nil {
			t.Fatalf("4-video Parse failed: %v", err)
		}
		fullView := unified.PublicView(fullEnv, false, now)
		if err := unified.ValidateEnvelopeAt(fullView, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		items := unified.Slice(unified.Map(fullView["data"])["items"])
		if len(items) != 4 {
			t.Fatalf("expected 4 video items, got %d", len(items))
		}
		wantTitles := []string{"Ultima - Test #1", "Ultima - Test #2", "Ultima - Test #3", "Ultima - Test #4"}
		for i, wantTitle := range wantTitles {
			if got := unified.Str(unified.Map(items[i])["title"]); got != wantTitle {
				t.Fatalf("item[%d].title = %q, want %q", i, got, wantTitle)
			}
		}

		// /video/3 selects the 3rd video as default_item_id without calling yt-dlp.
		selEnv, err := p.Parse(context.Background(), "https://x.com/UltimaShadowX/status/"+tweetID+"/video/3", now)
		if err != nil {
			t.Fatalf("/video/3 Parse failed: %v", err)
		}
		selView := unified.PublicView(selEnv, false, now)
		if err := unified.ValidateEnvelopeAt(selView, now); err != nil {
			t.Fatalf("/video/3 ValidateEnvelopeAt failed: %v", err)
		}
		selData := unified.Map(selView["data"])
		selItems := unified.Slice(selData["items"])
		if unified.Str(selData["default_item_id"]) != unified.Str(unified.Map(selItems[2])["id"]) {
			t.Fatalf("expected /video/3 default_item_id to select 3rd item, got %q vs %q",
				unified.Str(selData["default_item_id"]), unified.Str(unified.Map(selItems[2])["id"]))
		}
		if ytCalls.Load() != 0 {
			t.Fatalf("expected 0 yt-dlp calls across 4-video tests, got %d", ytCalls.Load())
		}
	})

	// 1c. Mixed video + photo tweet: fast-path handles bare status URL ([video, image]), /video/1 ([video] only), and /photo/2 ([image] only) with 0 yt-dlp calls.
	t.Run("mixed-video-photo-fast-path-and-selectors", func(t *testing.T) {
		const tweetID = "1577855540407197696"
		mixedBody, _ := json.Marshal(map[string]any{
			"__typename": "Tweet",
			"id_str":     tweetID,
			"text":       "gm ✨️ now I can post image and video. nice update. https://t.co/cG7XgiINOm",
			"user":       map[string]any{"name": "Oshtru", "screen_name": "oshtru"},
			"photos": []map[string]any{
				{"url": "https://pbs.twimg.com/media/FeWrKrMaYAELAxK.jpg", "width": 1536, "height": 1920},
			},
			"mediaDetails": []map[string]any{
				{
					"id_str":          "1577855447914409984",
					"type":            "video",
					"media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/1577855447914409984/pu/img/5V20pjPHBu3nz6jb.jpg",
					"original_info":   map[string]any{"width": 720, "height": 900},
					"sizes":           map[string]any{"large": map[string]any{"w": 720, "h": 900}},
					"video_info": map[string]any{
						"duration_millis": 30030,
						"variants": []map[string]any{
							{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1577855447914409984/pu/vid/720x900/Dn3XhZkvCK_gMg0d.mp4?tag=12"},
							{"bitrate": 950000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1577855447914409984/pu/vid/480x600/7-QYdEW4oBKK4vSr.mp4?tag=12"},
						},
					},
				},
				{
					"type":            "photo",
					"media_url_https": "https://pbs.twimg.com/media/FeWrKrMaYAELAxK.jpg",
					"original_info":   map[string]any{"width": 1536, "height": 1920},
				},
			},
		})

		var ytCalls atomic.Int32
		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					ytCalls.Add(1)
					return nil, errors.New("unexpected yt-dlp call on complete mixed tweet")
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: mixedBody, URL: req.URL}, nil
				},
			},
		)

		// Bare status URL -> [video, image] + album group.
		bareEnv, err := p.Parse(context.Background(), "https://x.com/oshtru/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		bareView := unified.PublicView(bareEnv, false, now)
		if err := unified.ValidateEnvelopeAt(bareView, now); err != nil {
			t.Fatal(err)
		}
		bareItems := unified.Slice(unified.Map(bareView["data"])["items"])
		if len(bareItems) != 2 || unified.Str(unified.Map(bareItems[0])["type"]) != "video" || unified.Str(unified.Map(bareItems[1])["type"]) != "image" {
			t.Fatalf("expected [video, image] on bare URL, got %+v", bareItems)
		}

		// /video/1 -> [video] only (no photos appended when selectedIndex > 0).
		v1Env, err := p.Parse(context.Background(), "https://x.com/oshtru/status/"+tweetID+"/video/1", now)
		if err != nil {
			t.Fatal(err)
		}
		v1View := unified.PublicView(v1Env, false, now)
		if err := unified.ValidateEnvelopeAt(v1View, now); err != nil {
			t.Fatal(err)
		}
		v1Items := unified.Slice(unified.Map(v1View["data"])["items"])
		if len(v1Items) != 1 || unified.Str(unified.Map(v1Items[0])["type"]) != "video" {
			t.Fatalf("expected 1 video item on /video/1, got %+v", v1Items)
		}

		// /photo/2 -> 2nd attachment (image) only.
		p2Env, err := p.Parse(context.Background(), "https://x.com/oshtru/status/"+tweetID+"/photo/2", now)
		if err != nil {
			t.Fatal(err)
		}
		p2View := unified.PublicView(p2Env, false, now)
		if err := unified.ValidateEnvelopeAt(p2View, now); err != nil {
			t.Fatal(err)
		}
		p2Items := unified.Slice(unified.Map(p2View["data"])["items"])
		if len(p2Items) != 1 || unified.Str(unified.Map(p2Items[0])["type"]) != "image" {
			t.Fatalf("expected 1 image item on /photo/2, got %+v", p2Items)
		}
		if ytCalls.Load() != 0 {
			t.Fatalf("expected 0 yt-dlp calls across mixed fast-path tests, got %d", ytCalls.Load())
		}
	})

	// 1d. animated_gif tweet (duration_millis: 0, bitrate: 0, single /tweet_video/<Key>.mp4 using original_info dimensions)
	// and 1e. unified_card video tweet.
	t.Run("animated-gif-and-unified-card-fast-path", func(t *testing.T) {
		gifBody, _ := json.Marshal(map[string]any{
			"__typename": "Tweet",
			"id_str":     "1800000000000000001",
			"text":       "Looping GIF https://t.co/GifLoop",
			"user":       map[string]any{"name": "GifBot", "screen_name": "gifbot"},
			"mediaDetails": []map[string]any{
				{
					"id_str":          "1800000000000000099",
					"type":            "animated_gif",
					"media_url_https": "https://pbs.twimg.com/tweet_video_thumb/F1a2B3c4D5e6.jpg",
					"original_info":   map[string]any{"width": 498, "height": 280},
					"sizes":           map[string]any{"large": map[string]any{"w": 498, "h": 280}},
					"video_info": map[string]any{
						"duration_millis": 0,
						"variants": []map[string]any{
							{"bitrate": 0, "content_type": "video/mp4", "url": "https://video.twimg.com/tweet_video/F1a2B3c4D5e6.mp4"},
						},
					},
				},
			},
		})

		ucInner, _ := json.Marshal(map[string]any{
			"type": "video_app",
			"media_entities": map[string]any{
				"4_2120003298589655040": map[string]any{
					"id_str":          "2120003298589655040",
					"type":            "photo",
					"media_url_https": "https://pbs.twimg.com/card_img/2120003298589655040/9fR3xxQR?format=jpg&name=orig",
					"original_info":   map[string]any{"width": 246, "height": 246},
				},
				"13_2001841416071450628": map[string]any{
					"id_str":          "2001841416071450628",
					"type":            "video",
					"media_url_https": "https://pbs.twimg.com/amplify_video_thumb/2001841416071450628/img/hpy5KpJh4pO17b65.jpg",
					"original_info":   map[string]any{"width": 1080, "height": 1080},
					"sizes":           map[string]any{"large": map[string]any{"w": 1080, "h": 1080}},
					"video_info": map[string]any{
						"duration_millis": 30278,
						"variants": []map[string]any{
							{"content_type": "application/x-mpegURL", "url": "https://video.twimg.com/amplify_video/2001841416071450628/pl/vCiP2cksCHPAxSVw.m3u8?tag=14"},
							{"bitrate": 1280000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/2001841416071450628/vid/avc1/720x720/1L5-pvqqQlx9qW8I.mp4?tag=14"},
							{"bitrate": 832000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/2001841416071450628/vid/avc1/540x540/fQMDaamZ4e37ZvAN.mp4?tag=14"},
						},
					},
				},
			},
		})
		ucBody, _ := json.Marshal(map[string]any{
			"__typename": "Tweet",
			"id_str":     "2001950365332455490",
			"text":       "Square unified_card video",
			"user":       map[string]any{"name": "Top Heroes", "screen_name": "TopHeroes_"},
			"card": map[string]any{
				"name": "unified_card",
				"binding_values": map[string]any{
					"unified_card": map[string]any{"string_value": string(ucInner)},
				},
			},
		})

		for _, tc := range []struct {
			name      string
			url       string
			body      []byte
			wantAudio bool
			wantW     int64
			wantH     int64
		}{
			{"animated-gif", "https://x.com/gifbot/status/1800000000000000001", gifBody, false, 498, 280},
			{"unified-card", "https://x.com/TopHeroes_/status/2001950365332455490", ucBody, true, 720, 720},
		} {
			t.Run(tc.name, func(t *testing.T) {
				var ytCalls atomic.Int32
				p := NewWithFetcher(
					&stubExtractor{
						enabled: true,
						extract: func(context.Context, string) (*ytengine.Info, error) {
							ytCalls.Add(1)
							return nil, errors.New("unexpected yt-dlp call")
						},
					},
					nil,
					fakeXFetcher{
						fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
							return fetch.Response{StatusCode: http.StatusOK, Body: tc.body, URL: req.URL}, nil
						},
					},
				)
				env, err := p.Parse(context.Background(), tc.url, now)
				if err != nil {
					t.Fatal(err)
				}
				if ytCalls.Load() != 0 {
					t.Fatalf("expected 0 yt-dlp calls for %s, got %d", tc.name, ytCalls.Load())
				}
				view := unified.PublicView(env, false, now)
				if err := unified.ValidateEnvelopeAt(view, now); err != nil {
					t.Fatalf("ValidateEnvelopeAt(%s) failed: %v", tc.name, err)
				}
				item := unified.Map(unified.Slice(unified.Map(view["data"])["items"])[0])
				if !tc.wantAudio && item["duration_ms"] != nil {
					t.Fatalf("expected duration_ms=nil for 0ms GIF, got %v", item["duration_ms"])
				}
				meta := unified.Map(unified.Map(unified.Slice(item["variants"])[0])["metadata"])
				if meta["has_audio"] != tc.wantAudio || meta["width"] != tc.wantW || meta["height"] != tc.wantH {
					t.Fatalf("%s metadata mismatch: %+v", tc.name, meta)
				}
			})
		}
	})
}

func TestParseXSyndicationVideoCompletenessAndFallbackToYTDLP(t *testing.T) {
	const now int64 = 1762300800
	const tweetID = "1790637656616943991"
	const tweetURL = "https://x.com/historyinmemes/status/" + tweetID

	fallbackYTInfo := func() *ytengine.Info {
		return &ytengine.Info{
			ID:        "1790637589910654976",
			DisplayID: tweetID,
			Title:     "Fallback yt-dlp video",
			Duration:  float64Ptr(15.488),
			Formats: []ytengine.Format{
				{
					FormatID: "http-2176",
					URL:      "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/728x720/fallback.mp4?tag=14",
					Ext:      "mp4",
					Protocol: "https",
					Width:    int64Ptr(728),
					Height:   int64Ptr(720),
					TBR:      float64Ptr(2176.0),
				},
			},
		}
	}

	mustJSON := func(m map[string]any) []byte {
		b, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	cases := []struct {
		name string
		body []byte
	}{
		{
			name: "missing-video-info",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "Missing video_info",
				"mediaDetails": []map[string]any{
					{"id_str": "1", "type": "video", "media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/t.jpg"},
				},
			}),
		},
		{
			name: "empty-variants",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "Empty variants",
				"mediaDetails": []map[string]any{
					{
						"id_str":     "1",
						"type":       "video",
						"video_info": map[string]any{"duration_millis": 5000, "variants": []map[string]any{}},
					},
				},
			}),
		},
		{
			name: "hls-only-no-progressive-mp4",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "HLS only",
				"mediaDetails": []map[string]any{
					{
						"id_str": "1",
						"type":   "video",
						"video_info": map[string]any{
							"duration_millis": 5000,
							"variants": []map[string]any{
								{"content_type": "application/x-mpegURL", "url": "https://video.twimg.com/amplify_video/1/pl/master.m3u8"},
							},
						},
					},
				},
			}),
		},
		{
			name: "multi-mp4-missing-path-dimensions",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "Two MP4s without WxH in path",
				"mediaDetails": []map[string]any{
					{
						"id_str":        "1",
						"type":          "video",
						"original_info": map[string]any{"width": 1280, "height": 720},
						"video_info": map[string]any{
							"duration_millis": 5000,
							"variants": []map[string]any{
								{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/1/vid/high.mp4"},
								{"bitrate": 832000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/1/vid/low.mp4"},
							},
						},
					},
				},
			}),
		},
		{
			name: "single-mp4-missing-both-path-and-original-info-dimensions",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "Single MP4 without any dimensions",
				"mediaDetails": []map[string]any{
					{
						"id_str": "1",
						"type":   "video",
						"video_info": map[string]any{
							"duration_millis": 5000,
							"variants": []map[string]any{
								{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/1/vid/nodim.mp4"},
							},
						},
					},
				},
			}),
		},
		{
			name: "zero-duration-on-video-type",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "Video with zero duration",
				"mediaDetails": []map[string]any{
					{
						"id_str": "1",
						"type":   "video",
						"video_info": map[string]any{
							"duration_millis": 0,
							"variants": []map[string]any{
								{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/1/vid/1280x720/v.mp4"},
							},
						},
					},
				},
			}),
		},
		{
			name: "partial-multi-video-never-drops-second-video",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "Two videos where 2nd lacks MP4",
				"mediaDetails": []map[string]any{
					{
						"id_str": "1",
						"type":   "video",
						"video_info": map[string]any{
							"duration_millis": 4000,
							"variants": []map[string]any{
								{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/v1.mp4"},
							},
						},
					},
					{
						"id_str": "2",
						"type":   "video",
						"video_info": map[string]any{
							"duration_millis": 4000,
							"variants": []map[string]any{
								{"content_type": "application/x-mpegURL", "url": "https://video.twimg.com/ext_tw_video/2/pu/pl/master.m3u8"},
							},
						},
					},
				},
			}),
		},
		{
			name: "root-video-without-media-details",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "Root video without mediaDetails bitrates",
				"video": map[string]any{
					"durationMs": 5000,
					"variants": []map[string]any{
						{"type": "video/mp4", "src": "https://video.twimg.com/amplify_video/1/vid/1280x720/v.mp4"},
					},
				},
			}),
		},
		{
			name: "unsupported-broadcast-card",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "Live broadcast",
				"card":       map[string]any{"name": "2586390716:broadcast"},
			}),
		},
		{
			name: "unsupported-audiospace-card",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "X Space",
				"card":       map[string]any{"name": "3691233323:audiospace"},
			}),
		},
		{
			name: "unsupported-amplify-card",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "Legacy amplify card",
				"card":       map[string]any{"name": "amplify"},
			}),
		},
		{
			name: "quoted-tweet-with-video",
			body: mustJSON(map[string]any{
				"__typename": "Tweet",
				"text":       "Quoting a video post",
				"quoted_tweet": map[string]any{
					"mediaDetails": []map[string]any{{"type": "video"}},
				},
			}),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var ytCalls atomic.Int32
			p := NewWithFetcher(
				&stubExtractor{
					enabled: true,
					extract: func(context.Context, string) (*ytengine.Info, error) {
						ytCalls.Add(1)
						return fallbackYTInfo(), nil
					},
				},
				nil,
				fakeXFetcher{
					fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
						return fetch.Response{StatusCode: http.StatusOK, Body: tc.body, URL: req.URL}, nil
					},
				},
			)
			env, err := p.Parse(context.Background(), tweetURL, now)
			if err != nil {
				t.Fatalf("%s Go error: %v", tc.name, err)
			}
			if ytCalls.Load() != 1 {
				t.Fatalf("%s: expected seamless fallback to yt-dlp (ytCalls=1), got %d", tc.name, ytCalls.Load())
			}
			view := unified.PublicView(env, false, now)
			if err := unified.ValidateEnvelopeAt(view, now); err != nil {
				t.Fatalf("%s ValidateEnvelopeAt failed: %v", tc.name, err)
			}
			if unified.Str(view["code"]) != "OK" {
				t.Fatalf("%s expected code=OK from yt-dlp fallback, got %+v", tc.name, view)
			}
		})
	}
}

func TestParseXSyndicationVideoSpoofedHostsRejected(t *testing.T) {
	const now int64 = 1762300800
	const tweetID = "1790637656616943991"
	const tweetURL = "https://x.com/historyinmemes/status/" + tweetID

	spoofedVariants := []map[string]any{
		{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com.evil/ext_tw_video/1/pu/vid/1280x720/a.mp4"},
		{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://evilvideo.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4"},
		{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://sub.video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4"},
		{"bitrate": 2176000, "content_type": "video/mp4", "url": "http://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4"},
		{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com:8443/ext_tw_video/1/pu/vid/1280x720/a.mp4"},
		{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com:80/ext_tw_video/1/pu/vid/1280x720/a.mp4"},
		{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://user:pass@video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4"},
		{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://pbs.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4"},
		{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/..%2fsecret/1280x720/a.mp4"},
		{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.html"},
	}

	// 1. All variants forged -> fast-path rejects, falls back to yt-dlp, and never leaks any non-allowlisted host.
	allSpoofBody, _ := json.Marshal(map[string]any{
		"__typename": "Tweet",
		"text":       "Spoofed syndication variants",
		"mediaDetails": []map[string]any{
			{
				"id_str":          "1",
				"type":            "video",
				"media_url_https": "https://pbs.twimg.com.evil/ext_tw_video_thumb/1/pu/img/spoof.jpg",
				"video_info": map[string]any{
					"duration_millis": 5000,
					"variants":        spoofedVariants,
				},
			},
		},
	})
	var ytCalled atomic.Bool
	allSpoofParser := NewWithFetcher(
		&stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				ytCalled.Store(true)
				return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "no video", Retryable: false}
			},
		},
		nil,
		fakeXFetcher{
			fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: http.StatusOK, Body: allSpoofBody, URL: req.URL}, nil
			},
		},
	)
	spoofEnv, err := allSpoofParser.Parse(context.Background(), tweetURL, now)
	if err != nil {
		t.Fatal(err)
	}
	if !ytCalled.Load() {
		t.Fatal("expected fallback to yt-dlp when all syndication variants are forged")
	}
	encodedSpoof, _ := unified.Encode(spoofEnv)
	if strings.Contains(string(encodedSpoof), "evil") || strings.Contains(string(encodedSpoof), "8443") {
		t.Fatalf("forged host leaked into envelope: %s", string(encodedSpoof))
	}

	// 2. Forged variants + forged covers mixed with 1 valid video.twimg.com MP4 -> strips all forged URLs, keeps valid MP4 on fast-path.
	for _, badCover := range []string{
		"https://pbs.twimg.com.evil/thumb.jpg",
		"https://sub.pbs.twimg.com/thumb.jpg",
		"http://pbs.twimg.com/thumb.jpg",
		"https://pbs.twimg.com:8443/thumb.jpg",
		"https://user:pass@pbs.twimg.com/thumb.jpg",
		"https://video.twimg.com/thumb.jpg",
		"https://pbs.twimg.com/thumb.html",
	} {
		mixedVariants := append([]map[string]any{}, spoofedVariants...)
		mixedVariants = append(mixedVariants, map[string]any{
			"bitrate":      2176000,
			"content_type": "video/mp4",
			"url":          "https://video.twimg.com:443/ext_tw_video/1/pu/vid/1280x720/clean.mp4?tag=12",
		})
		mixedBody, _ := json.Marshal(map[string]any{
			"__typename": "Tweet",
			"text":       "Valid MP4 with forged siblings",
			"mediaDetails": []map[string]any{
				{
					"id_str":          "1",
					"type":            "video",
					"media_url_https": badCover,
					"video_info": map[string]any{
						"duration_millis": 5000,
						"variants":        mixedVariants,
					},
				},
			},
		})
		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					t.Fatalf("yt-dlp must not run when 1 valid allowlisted MP4 exists (badCover=%s)", badCover)
					return nil, nil
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: mixedBody, URL: req.URL}, nil
				},
			},
		)
		env, err := p.Parse(context.Background(), tweetURL, now)
		if err != nil {
			t.Fatal(err)
		}
		view := unified.PublicView(env, false, now)
		if err := unified.ValidateEnvelopeAt(view, now); err != nil {
			t.Fatalf("badCover=%q ValidateEnvelopeAt failed: %v", badCover, err)
		}
		data := unified.Map(view["data"])
		if data["cover"] != nil {
			t.Fatalf("forged cover %q leaked into data.cover: %+v", badCover, data["cover"])
		}
		item := unified.Map(unified.Slice(data["items"])[0])
		if item["cover"] != nil {
			t.Fatalf("forged cover %q leaked into item.cover: %+v", badCover, item["cover"])
		}
		variants := unified.Slice(item["variants"])
		if len(variants) != 1 {
			t.Fatalf("expected only 1 allowlisted variant to survive, got %d", len(variants))
		}
		if gotURL := unified.Str(unified.Map(item["default"])["url"]); gotURL != "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/clean.mp4?tag=12" {
			t.Fatalf("unexpected clean default.url: %q", gotURL)
		}
	}
}

func TestSyndicationFastPathEquivalenceWithYTDLP(t *testing.T) {
	const now int64 = 1762300800

	type eqCase struct {
		name      string
		tweetID   string
		sourceURL string
		synBody   map[string]any
		ytInfo    ytengine.Info
	}

	tsSingle := float64(1715756260) // 2024-05-15T06:57:40Z
	likesSingle := int64(132404)
	commentsSingle := int64(827)
	viewsSingle := int64(34496944)
	repostsSingle := int64(6776)

	tsLong := float64(1664477766) // 2022-09-29T18:56:06Z
	likesLong := int64(10884)
	commentsLong := int64(305)

	tsMulti := float64(1664992565) // 2022-10-05T17:56:05Z
	likesMulti := int64(2092)
	commentsMulti := int64(33)

	tsMixed := float64(1665025050) // 2022-10-06T02:57:30Z
	likesMixed := int64(39)
	commentsMixed := int64(11)

	cases := []eqCase{
		{
			name:      "single-amplify-video-1790637656616943991",
			tweetID:   "1790637656616943991",
			sourceURL: "https://x.com/historyinmemes/status/1790637656616943991",
			synBody: map[string]any{
				"__typename":         "Tweet",
				"id_str":             "1790637656616943991",
				"text":               "One of the most intense moments in history https://t.co/Zgzhvix8ES",
				"created_at":         "2024-05-15T06:57:40.000Z",
				"favorite_count":     likesSingle,
				"conversation_count": commentsSingle,
				"user":               map[string]any{"name": "Historic Vids", "screen_name": "historyinmemes"},
				"mediaDetails": []map[string]any{
					{
						"type":            "video",
						"media_url_https": "https://pbs.twimg.com/amplify_video_thumb/1790637589910654976/img/jyhLQQZkq-lJJ9fN.jpg",
						"original_info":   map[string]any{"width": 886, "height": 876},
						"sizes":           map[string]any{"large": map[string]any{"w": 886, "h": 876}},
						"video_info": map[string]any{
							"duration_millis": 15488,
							"variants": []map[string]any{
								{"content_type": "application/x-mpegURL", "url": "https://video.twimg.com/amplify_video/1790637589910654976/pl/osiKl6ALz2B8l9Cw.m3u8?tag=14&v=cfc"},
								{"bitrate": 288000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/272x270/du7PkQofwIDrjAEz.mp4?tag=14"},
								{"bitrate": 832000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/364x360/MhZUmBoG84GGC0fb.mp4?tag=14"},
								{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/728x720/kF5AeH6MK-1qDlBg.mp4?tag=14"},
							},
						},
					},
				},
			},
			ytInfo: ytengine.Info{
				ID:           "1790637589910654976",
				DisplayID:    "1790637656616943991",
				Title:        "Historic Vids - One of the most intense moments in history",
				Description:  "One of the most intense moments in history https://t.co/Zgzhvix8ES",
				Uploader:     "Historic Vids",
				UploaderID:   "historyinmemes",
				UploaderURL:  "https://twitter.com/historyinmemes",
				Timestamp:    &tsSingle,
				Duration:     float64Ptr(15.488),
				LikeCount:    &likesSingle,
				CommentCount: &commentsSingle,
				ViewCount:    &viewsSingle,
				RepostCount:  &repostsSingle,
				Thumbnail:    "https://pbs.twimg.com/amplify_video_thumb/1790637589910654976/img/jyhLQQZkq-lJJ9fN.jpg?name=orig",
				Formats: []ytengine.Format{
					{FormatID: "hls-716", URL: "https://video.twimg.com/amplify_video/1790637589910654976/pl/avc1/728x720/hls.m3u8", Ext: "mp4", Protocol: "m3u8_native", Width: int64Ptr(728), Height: int64Ptr(720), TBR: float64Ptr(716.185), VCodec: "avc1.64001F", ACodec: "none"},
					{FormatID: "http-288", URL: "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/272x270/du7PkQofwIDrjAEz.mp4?tag=14", Ext: "mp4", Protocol: "https", Width: int64Ptr(272), Height: int64Ptr(270), TBR: float64Ptr(288.0)},
					{FormatID: "http-832", URL: "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/364x360/MhZUmBoG84GGC0fb.mp4?tag=14", Ext: "mp4", Protocol: "https", Width: int64Ptr(364), Height: int64Ptr(360), TBR: float64Ptr(832.0)},
					{FormatID: "http-2176", URL: "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/728x720/kF5AeH6MK-1qDlBg.mp4?tag=14", Ext: "mp4", Protocol: "https", Width: int64Ptr(728), Height: int64Ptr(720), TBR: float64Ptr(2176.0)},
				},
			},
		},
		{
			name:      "landscape-long-caption-tags-1575560063510810624",
			tweetID:   "1575560063510810624",
			sourceURL: "https://x.com/MesoMax919/status/1575560063510810624",
			synBody: map[string]any{
				"__typename":         "Tweet",
				"id_str":             "1575560063510810624",
				"text":               "Absolutely heartbreaking footage captured by our surge probe of catastrophic storm surge washing away homes. #HurricaneIan\n\nFULL VIDEO - https://t.co/DOJJn2VThV https://t.co/iPBUyVKw4s",
				"created_at":         "2022-09-29T18:56:06.000Z",
				"favorite_count":     likesLong,
				"conversation_count": commentsLong,
				"user":               map[string]any{"name": "Max Olson", "screen_name": "MesoMax919"},
				"entities":           map[string]any{"hashtags": []map[string]any{{"text": "HurricaneIan"}}},
				"mediaDetails": []map[string]any{
					{
						"id_str":          "1575559336759263233",
						"type":            "video",
						"media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/1575559336759263233/pu/img/Kvc2iofyjHrt1DmI.jpg",
						"original_info":   map[string]any{"width": 1280, "height": 720},
						"sizes":           map[string]any{"large": map[string]any{"w": 1280, "h": 720}},
						"video_info": map[string]any{
							"duration_millis": 21321,
							"variants": []map[string]any{
								{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1575559336759263233/pu/vid/1280x720/hd.mp4?tag=12"},
								{"bitrate": 832000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1575559336759263233/pu/vid/640x360/md.mp4?tag=12"},
								{"bitrate": 256000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1575559336759263233/pu/vid/480x270/sd.mp4?tag=12"},
							},
						},
					},
				},
			},
			ytInfo: ytengine.Info{
				ID:           "1575559336759263233",
				DisplayID:    "1575560063510810624",
				Title:        "Max Olson - Absolutely heartbreaking footage captured by our surge probe of catas...",
				Description:  "Absolutely heartbreaking footage captured by our surge probe of catastrophic storm surge washing away homes. #HurricaneIan  FULL VIDEO - https://t.co/DOJJn2VThV https://t.co/iPBUyVKw4s",
				Uploader:     "Max Olson",
				UploaderID:   "MesoMax919",
				UploaderURL:  "https://twitter.com/MesoMax919",
				Timestamp:    &tsLong,
				Duration:     float64Ptr(21.321),
				LikeCount:    &likesLong,
				CommentCount: &commentsLong,
				Tags:         []string{"HurricaneIan"},
				Thumbnail:    "https://pbs.twimg.com/ext_tw_video_thumb/1575559336759263233/pu/img/Kvc2iofyjHrt1DmI.jpg?name=orig",
				Formats: []ytengine.Format{
					{FormatID: "http-2176", URL: "https://video.twimg.com/ext_tw_video/1575559336759263233/pu/vid/1280x720/hd.mp4?tag=12", Ext: "mp4", Protocol: "https", Width: int64Ptr(1280), Height: int64Ptr(720), TBR: float64Ptr(2176.0)},
					{FormatID: "http-832", URL: "https://video.twimg.com/ext_tw_video/1575559336759263233/pu/vid/640x360/md.mp4?tag=12", Ext: "mp4", Protocol: "https", Width: int64Ptr(640), Height: int64Ptr(360), TBR: float64Ptr(832.0)},
					{FormatID: "http-256", URL: "https://video.twimg.com/ext_tw_video/1575559336759263233/pu/vid/480x270/sd.mp4?tag=12", Ext: "mp4", Protocol: "https", Width: int64Ptr(480), Height: int64Ptr(270), TBR: float64Ptr(256.0)},
				},
			},
		},
		{
			name:      "multi-video-playlist-with-video-2-selection",
			tweetID:   "1577719286659006464",
			sourceURL: "https://x.com/UltimaShadowX/status/1577719286659006464/video/2",
			synBody: map[string]any{
				"__typename":         "Tweet",
				"id_str":             "1577719286659006464",
				"text":               "Test https://t.co/Y3KEZD7Dad",
				"created_at":         "2022-10-05T17:56:05.000Z",
				"favorite_count":     likesMulti,
				"conversation_count": commentsMulti,
				"user":               map[string]any{"name": "Ultima", "screen_name": "UltimaShadowX"},
				"mediaDetails": []map[string]any{
					{
						"id_str":          "1577719236209922048",
						"type":            "video",
						"media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/1577719236209922048/pu/img/_3it9Ld7aLBKLEOF.jpg",
						"sizes":           map[string]any{"large": map[string]any{"w": 1280, "h": 720}},
						"video_info": map[string]any{
							"duration_millis": 4266,
							"variants": []map[string]any{
								{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1577719236209922048/pu/vid/1280x720/v1.mp4?tag=12"},
							},
						},
					},
					{
						"id_str":          "1577719252450267136",
						"type":            "video",
						"media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/1577719252450267136/pu/img/thumb2.jpg",
						"sizes":           map[string]any{"large": map[string]any{"w": 1280, "h": 720}},
						"video_info": map[string]any{
							"duration_millis": 2100,
							"variants": []map[string]any{
								{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1577719252450267136/pu/vid/1280x720/v2.mp4?tag=12"},
							},
						},
					},
				},
			},
			ytInfo: ytengine.Info{
				ID:           "1577719286659006464",
				DisplayID:    "1577719286659006464",
				Type:         "playlist",
				Title:        "Ultima - Test",
				Description:  "Test https://t.co/Y3KEZD7Dad",
				Uploader:     "Ultima",
				UploaderID:   "UltimaShadowX",
				UploaderURL:  "https://twitter.com/UltimaShadowX",
				Timestamp:    &tsMulti,
				LikeCount:    &likesMulti,
				CommentCount: &commentsMulti,
				Entries: []ytengine.Info{
					{
						ID:        "1577719236209922048",
						DisplayID: "1577719286659006464",
						Title:     "Ultima - Test #1",
						Duration:  float64Ptr(4.266),
						Thumbnail: "https://pbs.twimg.com/ext_tw_video_thumb/1577719236209922048/pu/img/_3it9Ld7aLBKLEOF.jpg?name=orig",
						Formats: []ytengine.Format{
							{FormatID: "http-2176", URL: "https://video.twimg.com/ext_tw_video/1577719236209922048/pu/vid/1280x720/v1.mp4?tag=12", Ext: "mp4", Protocol: "https", Width: int64Ptr(1280), Height: int64Ptr(720), TBR: float64Ptr(2176.0)},
						},
					},
					{
						ID:        "1577719252450267136",
						DisplayID: "1577719286659006464",
						Title:     "Ultima - Test #2",
						Duration:  float64Ptr(2.100),
						Thumbnail: "https://pbs.twimg.com/ext_tw_video_thumb/1577719252450267136/pu/img/thumb2.jpg?name=orig",
						Formats: []ytengine.Format{
							{FormatID: "http-2176", URL: "https://video.twimg.com/ext_tw_video/1577719252450267136/pu/vid/1280x720/v2.mp4?tag=12", Ext: "mp4", Protocol: "https", Width: int64Ptr(1280), Height: int64Ptr(720), TBR: float64Ptr(2176.0)},
						},
					},
				},
			},
		},
		{
			name:      "mixed-vertical-video-and-photo-1577855540407197696",
			tweetID:   "1577855540407197696",
			sourceURL: "https://x.com/oshtru/status/1577855540407197696",
			synBody: map[string]any{
				"__typename":         "Tweet",
				"id_str":             "1577855540407197696",
				"text":               "gm ✨️ now I can post image and video. nice update. https://t.co/cG7XgiINOm",
				"created_at":         "2022-10-06T02:57:30.000Z",
				"favorite_count":     likesMixed,
				"conversation_count": commentsMixed,
				"user":               map[string]any{"name": "Oshtru", "screen_name": "oshtru"},
				"photos": []map[string]any{
					{"url": "https://pbs.twimg.com/media/FeWrKrMaYAELAxK.jpg", "width": 1536, "height": 1920},
				},
				"mediaDetails": []map[string]any{
					{
						"type":            "photo",
						"media_url_https": "https://pbs.twimg.com/media/FeWrKrMaYAELAxK.jpg",
						"original_info":   map[string]any{"width": 1536, "height": 1920},
					},
					{
						"id_str":          "1577855447914409984",
						"type":            "video",
						"media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/1577855447914409984/pu/img/5V20pjPHBu3nz6jb.jpg",
						"sizes":           map[string]any{"large": map[string]any{"w": 720, "h": 900}},
						"video_info": map[string]any{
							"duration_millis": 30030,
							"variants": []map[string]any{
								{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1577855447914409984/pu/vid/720x900/Dn3XhZkvCK_gMg0d.mp4?tag=12"},
								{"bitrate": 950000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1577855447914409984/pu/vid/480x600/7-QYdEW4oBKK4vSr.mp4?tag=12"},
								{"bitrate": 632000, "content_type": "video/mp4", "url": "https://video.twimg.com/ext_tw_video/1577855447914409984/pu/vid/320x400/HYijkv-UtUL9d8qo.mp4?tag=12"},
							},
						},
					},
				},
			},
			ytInfo: ytengine.Info{
				ID:           "1577855447914409984",
				DisplayID:    "1577855540407197696",
				Title:        "Oshtru - gm ✨️ now I can post image and video. nice update.",
				Description:  "gm ✨️ now I can post image and video. nice update. https://t.co/cG7XgiINOm",
				Uploader:     "Oshtru",
				UploaderID:   "oshtru",
				UploaderURL:  "https://twitter.com/oshtru",
				Timestamp:    &tsMixed,
				Duration:     float64Ptr(30.030),
				LikeCount:    &likesMixed,
				CommentCount: &commentsMixed,
				Thumbnail:    "https://pbs.twimg.com/ext_tw_video_thumb/1577855447914409984/pu/img/5V20pjPHBu3nz6jb.jpg?name=orig",
				Formats: []ytengine.Format{
					{FormatID: "http-2176", URL: "https://video.twimg.com/ext_tw_video/1577855447914409984/pu/vid/720x900/Dn3XhZkvCK_gMg0d.mp4?tag=12", Ext: "mp4", Protocol: "https", Width: int64Ptr(720), Height: int64Ptr(900), TBR: float64Ptr(2176.0)},
					{FormatID: "http-950", URL: "https://video.twimg.com/ext_tw_video/1577855447914409984/pu/vid/480x600/7-QYdEW4oBKK4vSr.mp4?tag=12", Ext: "mp4", Protocol: "https", Width: int64Ptr(480), Height: int64Ptr(600), TBR: float64Ptr(950.0)},
					{FormatID: "http-632", URL: "https://video.twimg.com/ext_tw_video/1577855447914409984/pu/vid/320x400/HYijkv-UtUL9d8qo.mp4?tag=12", Ext: "mp4", Protocol: "https", Width: int64Ptr(320), Height: int64Ptr(400), TBR: float64Ptr(632.0)},
				},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			synBytes, err := json.Marshal(tc.synBody)
			if err != nil {
				t.Fatal(err)
			}
			_, _, _, selectedIdx, ok := extractTweetTarget(tc.sourceURL)
			if !ok {
				t.Fatalf("invalid sourceURL %q", tc.sourceURL)
			}

			// Path A: Syndication fast-path (must NOT invoke yt-dlp).
			fastParser := NewWithFetcher(
				&stubExtractor{
					enabled: true,
					extract: func(context.Context, string) (*ytengine.Info, error) {
						t.Fatalf("yt-dlp must not be invoked for %s", tc.name)
						return nil, nil
					},
				},
				nil,
				fakeXFetcher{
					fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
						return fetch.Response{StatusCode: http.StatusOK, Body: synBytes, URL: req.URL}, nil
					},
				},
			)
			synEnvRaw, err := fastParser.Parse(context.Background(), tc.sourceURL, now)
			if err != nil {
				t.Fatalf("fast-path Parse failed: %v", err)
			}
			synView := unified.PublicView(synEnvRaw, false, now)
			if err := unified.ValidateEnvelopeAt(synView, now); err != nil {
				t.Fatalf("fast-path ValidateEnvelopeAt failed: %v", err)
			}

			// Path B: Existing yt-dlp AdaptInfo path (+ syndication photo supplement for mixed tweets).
			st, err := fetchSyndicationTweet(context.Background(), fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: synBytes, URL: req.URL}, nil
				},
			}, tc.tweetID)
			if err != nil {
				t.Fatal(err)
			}
			ytCopy := tc.ytInfo
			var ytEnvRaw unified.Object
			if selectedIdx == 0 && len(st.Photos) > 0 {
				ytEnvRaw = adaptInfoWithPhotos(&ytCopy, st.Photos, tc.tweetID, tc.sourceURL, selectedIdx, now)
			} else {
				ytEnvRaw = AdaptInfo(&ytCopy, tc.tweetID, tc.sourceURL, selectedIdx, now)
			}
			ytView := unified.PublicView(ytEnvRaw, false, now)
			if err := unified.ValidateEnvelopeAt(ytView, now); err != nil {
				t.Fatalf("yt-dlp ValidateEnvelopeAt failed: %v", err)
			}

			synData := unified.Map(synView["data"])
			ytData := unified.Map(ytView["data"])
			for _, field := range []string{"platform", "content_id", "source_url", "refresh_url", "title", "description", "published_at", "default_item_id", "author", "cover", "tags", "groups"} {
				if !reflect.DeepEqual(synData[field], ytData[field]) {
					t.Fatalf("%s data.%s mismatch:\n  syn=%#v\n   yt=%#v", tc.name, field, synData[field], ytData[field])
				}
			}
			synStats := unified.Map(synData["statistics"])
			ytStats := unified.Map(ytData["statistics"])
			for _, statKey := range []string{"likes", "comments"} {
				if !reflect.DeepEqual(synStats[statKey], ytStats[statKey]) {
					t.Fatalf("%s statistics.%s mismatch: syn=%#v yt=%#v", tc.name, statKey, synStats[statKey], ytStats[statKey])
				}
			}

			synItems := unified.Slice(synData["items"])
			ytItems := unified.Slice(ytData["items"])
			if len(synItems) != len(ytItems) {
				t.Fatalf("%s items count mismatch: syn=%d yt=%d", tc.name, len(synItems), len(ytItems))
			}
			for i := range synItems {
				si := unified.Map(synItems[i])
				yi := unified.Map(ytItems[i])
				for _, ik := range []string{"id", "type", "index", "title", "duration_ms", "cover", "default", "resolve_url"} {
					if !reflect.DeepEqual(si[ik], yi[ik]) {
						t.Fatalf("%s item[%d].%s mismatch:\n  syn=%#v\n   yt=%#v", tc.name, i, ik, si[ik], yi[ik])
					}
				}
				sVars := unified.Slice(si["variants"])
				var yFileVars []unified.Object
				for _, yv := range unified.Slice(yi["variants"]) {
					yvm := unified.Map(yv)
					if unified.Str(unified.Map(yvm["delivery"])["kind"]) == "file" {
						yFileVars = append(yFileVars, yvm)
					}
				}
				if len(sVars) != len(yFileVars) {
					t.Fatalf("%s item[%d] progressive file variants mismatch: syn=%d yt=%d", tc.name, i, len(sVars), len(yFileVars))
				}
				for vi := range sVars {
					svm := unified.Map(sVars[vi])
					yvm := yFileVars[vi]
					if !reflect.DeepEqual(svm["id"], yvm["id"]) || !reflect.DeepEqual(svm["label"], yvm["label"]) || !reflect.DeepEqual(svm["delivery"], yvm["delivery"]) {
						t.Fatalf("%s item[%d] variant[%d] id/label/delivery mismatch:\n  syn=%#v\n   yt=%#v", tc.name, i, vi, svm, yvm)
					}
					sMeta := unified.Map(svm["metadata"])
					yMeta := unified.Map(yvm["metadata"])
					for _, mk := range []string{"container", "extension", "mime_type", "width", "height", "bitrate_bps", "has_audio"} {
						if !reflect.DeepEqual(sMeta[mk], yMeta[mk]) {
							t.Fatalf("%s item[%d] variant[%d].metadata.%s mismatch: syn=%#v yt=%#v", tc.name, i, vi, mk, sMeta[mk], yMeta[mk])
						}
					}
				}
			}
		})
	}
}

type countingExtractor struct {
	inner ytengine.Extractor
	calls atomic.Int64
}

func (c *countingExtractor) Enabled() bool { return c.inner != nil && c.inner.Enabled() }

func (c *countingExtractor) Extract(ctx context.Context, rawURL string) (*ytengine.Info, error) {
	c.calls.Add(1)
	return c.inner.Extract(ctx, rawURL)
}

func setupLocalFakeXBenchmarkHarness(tb testing.TB) (fastParser *Parser, legacyParser *Parser, fastCounter *countingExtractor, legacyCounter *countingExtractor, cleanup func()) {
	tb.Helper()
	if runtime.GOOS == "windows" {
		tb.Skip("shell script fake yt-dlp fixture requires unix")
	}

	const tweetID = "1790637656616943991"
	completeSynBody, err := json.Marshal(map[string]any{
		"__typename":         "Tweet",
		"id_str":             tweetID,
		"text":               "One of the most intense moments in history https://t.co/Zgzhvix8ES",
		"created_at":         "2024-05-15T06:57:40.000Z",
		"favorite_count":     132404,
		"conversation_count": 827,
		"user":               map[string]any{"name": "Historic Vids", "screen_name": "historyinmemes"},
		"mediaDetails": []map[string]any{
			{
				"type":            "video",
				"media_url_https": "https://pbs.twimg.com/amplify_video_thumb/1790637589910654976/img/jyhLQQZkq-lJJ9fN.jpg",
				"original_info":   map[string]any{"width": 886, "height": 876},
				"sizes":           map[string]any{"large": map[string]any{"w": 886, "h": 876}},
				"video_info": map[string]any{
					"duration_millis": 15488,
					"variants": []map[string]any{
						{"content_type": "application/x-mpegURL", "url": "https://video.twimg.com/amplify_video/1790637589910654976/pl/osiKl6ALz2B8l9Cw.m3u8?tag=14&v=cfc"},
						{"bitrate": 288000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/272x270/du7PkQofwIDrjAEz.mp4?tag=14"},
						{"bitrate": 832000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/364x360/MhZUmBoG84GGC0fb.mp4?tag=14"},
						{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/728x720/kF5AeH6MK-1qDlBg.mp4?tag=14"},
					},
				},
			},
		},
	})
	if err != nil {
		tb.Fatal(err)
	}

	legacyPhotoOnlySynBody, err := json.Marshal(map[string]any{
		"__typename": "Tweet",
		"id_str":     tweetID,
		"text":       "One of the most intense moments in history https://t.co/Zgzhvix8ES",
		"mediaDetails": []map[string]any{
			{"type": "video", "media_url_https": "https://pbs.twimg.com/amplify_video_thumb/1790637589910654976/img/jyhLQQZkq-lJJ9fN.jpg"},
		},
	})
	if err != nil {
		tb.Fatal(err)
	}

	synSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/legacy" {
			_, _ = w.Write(legacyPhotoOnlySynBody)
			return
		}
		_, _ = w.Write(completeSynBody)
	}))

	dir := tb.TempDir()
	binPath := filepath.Join(dir, "yt-dlp-fake")
	script := "#!/bin/sh\nset -eu\ncat <<'JSON'\n" +
		`{"id":"1790637589910654976","display_id":"1790637656616943991","_type":"video","title":"Historic Vids - One of the most intense moments in history","description":"One of the most intense moments in history https://t.co/Zgzhvix8ES","uploader":"Historic Vids","uploader_id":"historyinmemes","uploader_url":"https://twitter.com/historyinmemes","timestamp":1715756260,"duration":15.488,"like_count":132404,"comment_count":827,"thumbnail":"https://pbs.twimg.com/amplify_video_thumb/1790637589910654976/img/jyhLQQZkq-lJJ9fN.jpg?name=orig","formats":[{"format_id":"http-288","url":"https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/272x270/du7PkQofwIDrjAEz.mp4?tag=14","ext":"mp4","protocol":"https","width":272,"height":270,"tbr":288.0},{"format_id":"http-832","url":"https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/364x360/MhZUmBoG84GGC0fb.mp4?tag=14","ext":"mp4","protocol":"https","width":364,"height":360,"tbr":832.0},{"format_id":"http-2176","url":"https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/728x720/kF5AeH6MK-1qDlBg.mp4?tag=14","ext":"mp4","protocol":"https","width":728,"height":720,"tbr":2176.0}]}` +
		"\nJSON\n"
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		synSrv.Close()
		tb.Fatal(err)
	}
	sum := sha256.Sum256([]byte(script))
	digest := hex.EncodeToString(sum[:])

	realEng, err := ytengine.New(ytengine.Config{
		BinaryPath:     binPath,
		AllowedHashes:  map[string]string{digest: "yt-dlp-fake"},
		AllowedURL:     AllowedTargetURL,
		MaxConcurrency: 4,
	})
	if err != nil {
		synSrv.Close()
		tb.Fatalf("ytengine.New failed: %v", err)
	}

	httpClient := synSrv.Client()
	makeLoopbackFetcher := func(targetPath string) fetch.Executor {
		return fakeXFetcher{
			fn: func(reqCtx context.Context, req fetch.Request) (fetch.Response, error) {
				if req.Policy.AllowedURL != nil && !req.Policy.AllowedURL(req.URL) {
					return fetch.Response{}, fetch.ErrPolicy
				}
				u, err := url.Parse(req.URL)
				if err != nil {
					return fetch.Response{}, err
				}
				localReq, err := http.NewRequestWithContext(reqCtx, req.Method, synSrv.URL+targetPath+"?"+u.RawQuery, nil)
				if err != nil {
					return fetch.Response{}, err
				}
				for k, vals := range req.Header {
					for _, v := range vals {
						localReq.Header.Add(k, v)
					}
				}
				resp, err := httpClient.Do(localReq)
				if err != nil {
					return fetch.Response{}, err
				}
				defer resp.Body.Close()
				body, err := io.ReadAll(io.LimitReader(resp.Body, req.Policy.MaxBytes+1))
				if err != nil {
					return fetch.Response{}, err
				}
				return fetch.Response{
					StatusCode: resp.StatusCode,
					Header:     resp.Header.Clone(),
					Body:       body,
					URL:        req.URL,
				}, nil
			},
		}
	}

	fastCounter = &countingExtractor{inner: realEng}
	legacyCounter = &countingExtractor{inner: realEng}
	fastParser = NewWithFetcher(fastCounter, nil, makeLoopbackFetcher("/tweet-result"))
	legacyParser = NewWithFetcher(legacyCounter, nil, makeLoopbackFetcher("/legacy"))
	return fastParser, legacyParser, fastCounter, legacyCounter, synSrv.Close
}

func BenchmarkXVideoSyndicationFastPathVsYTDLP(b *testing.B) {
	const now int64 = 1762300800
	const targetURL = "https://x.com/historyinmemes/status/1790637656616943991"

	fastParser, legacyParser, fastCounter, legacyCounter, cleanup := setupLocalFakeXBenchmarkHarness(b)
	defer cleanup()

	b.Run("SyndicationFastPath", func(b *testing.B) {
		fastCounter.calls.Store(0)
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			env, err := fastParser.Parse(context.Background(), targetURL, now)
			if err != nil || unified.Str(env["code"]) != "OK" {
				b.Fatalf("fast-path Parse failed: env=%+v err=%v", env, err)
			}
		}
		b.StopTimer()
		if got := fastCounter.calls.Load(); got != 0 {
			b.Fatalf("expected 0 yt-dlp subprocess spawns on SyndicationFastPath, got %d", got)
		}
	})

	b.Run("LegacyYTDLPSubprocessPath", func(b *testing.B) {
		legacyCounter.calls.Store(0)
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			env, err := legacyParser.Parse(context.Background(), targetURL, now)
			if err != nil || unified.Str(env["code"]) != "OK" {
				b.Fatalf("legacy Parse failed: env=%+v err=%v", env, err)
			}
		}
		b.StopTimer()
		if got := legacyCounter.calls.Load(); got != int64(b.N) {
			b.Fatalf("expected %d yt-dlp subprocess spawns on LegacyYTDLPSubprocessPath, got %d", b.N, got)
		}
	})
}
