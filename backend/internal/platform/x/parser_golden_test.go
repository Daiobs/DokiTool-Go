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

	"github.com/Brilliant666/DokiTool-Go/backend/internal/api"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func assertGoldenEnvelopeValid(t *testing.T, env unified.Object, now int64, wantCode string, wantStatus int) {
	t.Helper()
	if env == nil {
		t.Fatalf("expected non-nil envelope for code %q", wantCode)
	}
	if err := unified.ValidateEnvelopeAt(env, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v\nenvelope=%+v", err, env)
	}
	if gotCode := unified.Str(env["code"]); gotCode != wantCode {
		t.Fatalf("code = %q, want %q; envelope=%+v", gotCode, wantCode, env)
	}
	if gotStatus := api.Status(env); gotStatus != wantStatus {
		t.Fatalf("api.Status = %d, want %d; envelope=%+v", gotStatus, wantStatus, env)
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

func makeGoldenSingleVideoYTInfo(tweetID, entryID string, missingSize1080 bool) *ytengine.Info {
	var sz1080 *int64
	if !missingSize1080 {
		sz1080 = int64Ptr(8400000)
	}
	return &ytengine.Info{
		ID:           entryID,
		DisplayID:    tweetID,
		Title:        "Golden X Clip",
		Description:  "Golden X Clip description",
		Uploader:     "Golden Author",
		UploaderID:   "golden_author",
		UploaderURL:  "https://x.com/golden_author",
		Duration:     float64Ptr(12.4),
		Timestamp:    float64Ptr(1762000000),
		ViewCount:    int64Ptr(42000),
		LikeCount:    int64Ptr(1500),
		RepostCount:  int64Ptr(320),
		CommentCount: int64Ptr(88),
		Tags:         []string{"golang", "golden"},
		Thumbnail:    "https://pbs.twimg.com/ext_tw_video_thumb/" + entryID + "/pu/img/cover.jpg?name=orig",
		Formats: []ytengine.Format{
			{
				FormatID: "http-2176",
				URL:      "https://video.twimg.com/ext_tw_video/" + entryID + "/pu/vid/avc1/1920x1080/v1080.mp4?tag=12",
				Ext:      "mp4",
				Protocol: "https",
				Width:    int64Ptr(1920),
				Height:   int64Ptr(1080),
				TBR:      float64Ptr(2176),
				VCodec:   "avc1.640032",
				ACodec:   "mp4a.40.2",
				Filesize: sz1080,
			},
			{
				FormatID: "http-832",
				URL:      "https://video.twimg.com/ext_tw_video/" + entryID + "/pu/vid/avc1/1280x720/v720.mp4?tag=12",
				Ext:      "mp4",
				Protocol: "https",
				Width:    int64Ptr(1280),
				Height:   int64Ptr(720),
				TBR:      float64Ptr(832),
				VCodec:   "avc1.4d001f",
				ACodec:   "mp4a.40.2",
				Filesize: int64Ptr(3600000),
			},
			{
				FormatID: "hls-audio-128",
				URL:      "https://video.twimg.com/ext_tw_video/" + entryID + "/pu/pl/mp4a/128000/audio.m3u8",
				Ext:      "m3u8",
				Protocol: "m3u8_native",
				VCodec:   "none",
				ACodec:   "mp4a.40.2",
				ABR:      float64Ptr(128),
			},
			{
				FormatID: "hls-1080",
				URL:      "https://video.twimg.com/ext_tw_video/" + entryID + "/pu/pl/avc1/1920x1080/v1080.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    int64Ptr(1920),
				Height:   int64Ptr(1080),
				TBR:      float64Ptr(2300),
				VCodec:   "avc1.640032",
				ACodec:   "none",
			},
		},
	}
}

func makeGoldenPlaylistYTInfo(tweetID string) *ytengine.Info {
	mkEntry := func(seq, entryID string, w, h, sz int64) ytengine.Info {
		return ytengine.Info{
			ID:        entryID,
			DisplayID: tweetID,
			Title:     "Playlist Clip #" + seq,
			Duration:  float64Ptr(6.5),
			Thumbnail: "https://pbs.twimg.com/ext_tw_video_thumb/" + entryID + "/pu/img/thumb.jpg?name=orig",
			Formats: []ytengine.Format{
				{
					FormatID: "http-1500",
					URL:      "https://video.twimg.com/ext_tw_video/" + entryID + "/pu/vid/avc1/1280x720/clip.mp4",
					Ext:      "mp4",
					Protocol: "https",
					Width:    int64Ptr(w),
					Height:   int64Ptr(h),
					TBR:      float64Ptr(1500),
					VCodec:   "avc1.4d001f",
					ACodec:   "mp4a.40.2",
					Filesize: int64Ptr(sz),
				},
			},
		}
	}
	return &ytengine.Info{
		ID:          tweetID,
		DisplayID:   tweetID,
		Type:        "playlist",
		Title:       "Golden Multi Video",
		Uploader:    "PlaylistCreator",
		UploaderID:  "playlist_creator",
		UploaderURL: "https://x.com/playlist_creator",
		Entries: []ytengine.Info{
			mkEntry("1", "1810000000000000101", 1280, 720, 2100000),
			mkEntry("2", "1810000000000000102", 1920, 1080, 4500000),
		},
	}
}

func TestGoldenParseDirectURLAndPreconditions(t *testing.T) {
	const now int64 = 1762300800
	const tweetID = "1810000000000000001"

	t.Run("pre-canceled-and-expired-context", func(t *testing.T) {
		p := New(&stubExtractor{enabled: true})

		cancelCtx, cancel := context.WithCancel(context.Background())
		cancel()
		env, err := p.Parse(cancelCtx, "https://x.com/user/status/"+tweetID, now)
		if !errors.Is(err, context.Canceled) || env != nil {
			t.Fatalf("expected (nil, context.Canceled), got env=%+v err=%v", env, err)
		}

		expCtx, expCancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
		defer expCancel()
		env, err = p.Parse(expCtx, "https://x.com/user/status/"+tweetID, now)
		if !errors.Is(err, context.DeadlineExceeded) || env != nil {
			t.Fatalf("expected (nil, context.DeadlineExceeded), got env=%+v err=%v", env, err)
		}
	})

	t.Run("invalid-direct-urls", func(t *testing.T) {
		p := New(&stubExtractor{enabled: true})
		invalidInputs := []string{
			"",
			"https://example.com/user/status/" + tweetID,
			"https://x.com/home/status/" + tweetID,
			"https://x.com/user/status/notanumber",
			"https://x.com/user/status/" + tweetID + "/video/0",
			"https://x.com/user/status/" + tweetID + "/video/5",
			"https://x.com/user/status/" + tweetID + "/photo/5",
			"https://x.com/user/status/" + tweetID + "/audio/1",
			"https://x.com:8443/user/status/" + tweetID,
		}
		for _, raw := range invalidInputs {
			env, err := p.Parse(context.Background(), raw, now)
			if err != nil {
				t.Fatalf("input %q returned unexpected err: %v", raw, err)
			}
			assertGoldenEnvelopeValid(t, env, now, "INVALID_INPUT", http.StatusBadRequest)
		}
	})

	t.Run("service-not-configured", func(t *testing.T) {
		target := "https://x.com/user/status/" + tweetID
		for name, p := range map[string]*Parser{
			"nil-parser":      nil,
			"nil-engine":      New(nil),
			"disabled-engine": New(&stubExtractor{enabled: false}),
		} {
			env, err := p.Parse(context.Background(), target, now)
			if err != nil {
				t.Fatalf("%s returned err: %v", name, err)
			}
			assertGoldenEnvelopeValid(t, env, now, "SERVICE_NOT_CONFIGURED", http.StatusServiceUnavailable)
		}
	})

	t.Run("valid-direct-url-with-video-selector", func(t *testing.T) {
		var gotCanonical string
		p := New(&stubExtractor{
			enabled: true,
			extract: func(_ context.Context, rawURL string) (*ytengine.Info, error) {
				gotCanonical = rawURL
				return makeGoldenPlaylistYTInfo(tweetID), nil
			},
		})
		sourceURL := "https://twitter.com/PlaylistCreator/status/" + tweetID + "/video/2?s=20"
		env, err := p.Parse(context.Background(), sourceURL, now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		assertGoldenEnvelopeValid(t, env, now, "OK", http.StatusOK)
		if gotCanonical != "https://x.com/i/status/"+tweetID {
			t.Fatalf("canonicalURL = %q, want https://x.com/i/status/%s", gotCanonical, tweetID)
		}
		data := unified.Map(env["data"])
		if unified.Str(data["platform"]) != "x" || unified.Str(data["content_id"]) != tweetID || unified.Str(data["source_url"]) != sourceURL {
			t.Fatalf("unexpected envelope metadata: %+v", data)
		}
		items := unified.Slice(data["items"])
		if len(items) != 2 {
			t.Fatalf("expected 2 video items, got %d", len(items))
		}
		item1 := unified.Map(items[0])
		item2 := unified.Map(items[1])
		wantID1 := "video-" + shortDigest("1810000000000000101")
		wantID2 := "video-" + shortDigest("1810000000000000102")
		if unified.Str(item1["id"]) != wantID1 || unified.Str(item2["id"]) != wantID2 {
			t.Fatalf("unexpected item IDs: got [%s, %s], want [%s, %s]", item1["id"], item2["id"], wantID1, wantID2)
		}
		if unified.Str(data["default_item_id"]) != wantID2 {
			t.Fatalf("default_item_id = %q, want selected 2nd item %q", data["default_item_id"], wantID2)
		}
	})
}

func TestGoldenParseTCoExpansionMatrix(t *testing.T) {
	const now int64 = 1762300800
	const tweetID = "1810000000000000002"

	synPhotosBody, err := json.Marshal(map[string]any{
		"__typename": "Tweet",
		"id_str":     tweetID,
		"text":       "Golden photos via t.co",
		"user":       map[string]any{"name": "PhotoAuthor", "screen_name": "photo_author"},
		"mediaDetails": []map[string]any{
			{
				"id_str":          "2001",
				"type":            "photo",
				"media_url_https": "https://pbs.twimg.com/media/GoldenPhotoA.jpg",
				"original_info":   map[string]any{"width": 1200, "height": 800},
			},
			{
				"id_str":          "2002",
				"type":            "photo",
				"media_url_https": "https://pbs.twimg.com/media/GoldenPhotoB.png",
				"original_info":   map[string]any{"width": 1600, "height": 1200},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("invalid-tco-syntax-and-preconditions", func(t *testing.T) {
		pWithAll := NewWithFetcher(&stubExtractor{enabled: true}, nil, fakeXFetcher{
			fn: func(context.Context, fetch.Request) (fetch.Response, error) {
				t.Fatal("fetcher must not be called for invalid t.co syntax")
				return fetch.Response{}, nil
			},
		})
		for _, bad := range []string{
			"https://t.co/",
			"https://t.co/bad%20code",
			"https://t.co/a/b",
			"https://sub.t.co/Abc123",
			"https://t.co:8443/Abc123",
		} {
			env, err := pWithAll.Parse(context.Background(), bad, now)
			if err != nil {
				t.Fatalf("%q returned err: %v", bad, err)
			}
			assertGoldenEnvelopeValid(t, env, now, "INVALID_INPUT", http.StatusBadRequest)
		}

		// Nil fetcher on valid t.co -> UPSTREAM_UNAVAILABLE (502, retryable).
		pNoFetcher := New(&stubExtractor{enabled: true})
		env, err := pNoFetcher.Parse(context.Background(), "https://t.co/Abc123XY", now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, env, now, "UPSTREAM_UNAVAILABLE", http.StatusBadGateway)
		if unified.Map(env["error"])["retryable"] != true {
			t.Fatalf("expected retryable=true on nil-fetcher t.co error: %+v", env)
		}

		// Disabled engine on valid t.co -> SERVICE_NOT_CONFIGURED (503).
		pDisabledEng := NewWithFetcher(&stubExtractor{enabled: false}, nil, fakeXFetcher{
			fn: func(context.Context, fetch.Request) (fetch.Response, error) {
				t.Fatal("fetcher must not be called when engine is disabled")
				return fetch.Response{}, nil
			},
		})
		env, err = pDisabledEng.Parse(context.Background(), "https://t.co/Abc123XY", now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, env, now, "SERVICE_NOT_CONFIGURED", http.StatusServiceUnavailable)
	})

	t.Run("tco-redirect-and-html-expansion-success", func(t *testing.T) {
		const playlistTweetID = "1810000000000000099"
		var ytCalls atomic.Int32
		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(_ context.Context, rawURL string) (*ytengine.Info, error) {
					ytCalls.Add(1)
					return makeGoldenPlaylistYTInfo(playlistTweetID), nil
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					switch req.URL {
					case "https://t.co/Vid301":
						h := make(http.Header)
						h.Set("Location", "https://twitter.com/PlaylistCreator/status/"+tweetID+"/video/2?s=20")
						return fetch.Response{StatusCode: http.StatusMovedPermanently, Header: h, URL: req.URL}, nil
					case "https://t.co/VidYT301":
						h := make(http.Header)
						h.Set("Location", "https://twitter.com/PlaylistCreator/status/"+playlistTweetID+"/video/2?s=20")
						return fetch.Response{StatusCode: http.StatusMovedPermanently, Header: h, URL: req.URL}, nil
					case "https://t.co/PicMeta":
						return fetch.Response{
							StatusCode: http.StatusOK,
							Body:       []byte(`<html><head><meta http-equiv="refresh" content="0;url=https://x.com/photo_author/status/` + tweetID + `/photo/2?s=19"></head></html>`),
							URL:        req.URL,
						}, nil
					default:
						if strings.HasPrefix(req.URL, syndicationEndpointURL) {
							if strings.Contains(req.URL, "id="+playlistTweetID) {
								return fetch.Response{StatusCode: http.StatusNotFound, URL: req.URL}, nil
							}
							return fetch.Response{StatusCode: http.StatusOK, Body: synPhotosBody, URL: req.URL}, nil
						}
						t.Fatalf("unexpected fetch URL: %s", req.URL)
						return fetch.Response{}, nil
					}
				},
			},
		)

		// 1) PicMeta -> /photo/2 direct syndication without spawning yt-dlp.
		envPhoto, err := p.Parse(context.Background(), "https://t.co/PicMeta", now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envPhoto, now, "OK", http.StatusOK)
		if ytCalls.Load() != 0 {
			t.Fatalf("expected 0 yt-dlp calls on /photo/2 via t.co, got %d", ytCalls.Load())
		}
		photoData := unified.Map(envPhoto["data"])
		if got := unified.Str(photoData["source_url"]); got != "https://x.com/i/status/"+tweetID+"/photo/2" {
			t.Fatalf("source_url = %q, want canonical /photo/2 URL", got)
		}
		photoItems := unified.Slice(photoData["items"])
		if len(photoItems) != 1 || unified.Str(unified.Map(photoItems[0])["id"]) != "image-"+shortDigest("x:photo-item:"+tweetID+":GoldenPhotoB") {
			t.Fatalf("unexpected selected photo item: %+v", photoItems)
		}

		// 2) Vid301 -> /video/2 where tweet is pure photo in syndication -> CONTENT_UNAVAILABLE (404) fast-path.
		envVidOnPhoto, err := p.Parse(context.Background(), "https://t.co/Vid301", now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envVidOnPhoto, now, "CONTENT_UNAVAILABLE", http.StatusNotFound)
		if ytCalls.Load() != 0 {
			t.Fatalf("expected 0 yt-dlp calls when syndication proves pure-photo tweet on /video/2, got %d", ytCalls.Load())
		}

		// 3) VidYT301 -> /video/2 falling back to yt-dlp playlist and selecting 2nd video item.
		envVidYT, err := p.Parse(context.Background(), "https://t.co/VidYT301", now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envVidYT, now, "OK", http.StatusOK)
		if ytCalls.Load() != 1 {
			t.Fatalf("expected 1 yt-dlp call on VidYT301, got %d", ytCalls.Load())
		}
		vidYTData := unified.Map(envVidYT["data"])
		if got := unified.Str(vidYTData["source_url"]); got != "https://x.com/i/status/"+playlistTweetID+"/video/2" {
			t.Fatalf("source_url = %q, want canonical /video/2 URL", got)
		}
		vidYTItems := unified.Slice(vidYTData["items"])
		if len(vidYTItems) != 2 || unified.Str(vidYTData["default_item_id"]) != unified.Str(unified.Map(vidYTItems[1])["id"]) {
			t.Fatalf("expected /video/2 via t.co to select 2nd video item, got %+v", vidYTData)
		}
	})

	t.Run("tco-failure-and-error-mapping", func(t *testing.T) {
		cases := []struct {
			name          string
			fn            func(context.Context, fetch.Request) (fetch.Response, error)
			wantCode      string
			wantStatus    int
			wantRetryable bool
		}{
			{
				name: "external-target-location-replace",
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{
						StatusCode: http.StatusOK,
						Body:       []byte(`<script>location.replace("https:\/\/example.org\/article\/42")</script>`),
						URL:        req.URL,
					}, nil
				},
				wantCode:   "INVALID_INPUT",
				wantStatus: http.StatusBadRequest,
			},
			{
				name: "404-not-found",
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusNotFound, URL: req.URL}, nil
				},
				wantCode:   "CONTENT_UNAVAILABLE",
				wantStatus: http.StatusNotFound,
			},
			{
				name: "429-rate-limited",
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusTooManyRequests, URL: req.URL}, nil
				},
				wantCode:      "RATE_LIMITED",
				wantStatus:    http.StatusTooManyRequests,
				wantRetryable: true,
			},
			{
				name: "403-blocked",
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusForbidden, URL: req.URL}, nil
				},
				wantCode:   "UPSTREAM_BLOCKED",
				wantStatus: http.StatusForbidden,
			},
			{
				name: "504-gateway-timeout",
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusGatewayTimeout, URL: req.URL}, nil
				},
				wantCode:      "UPSTREAM_TIMEOUT",
				wantStatus:    http.StatusGatewayTimeout,
				wantRetryable: true,
			},
			{
				name: "deadline-exceeded",
				fn: func(_ context.Context, _ fetch.Request) (fetch.Response, error) {
					return fetch.Response{}, context.DeadlineExceeded
				},
				wantCode:      "UPSTREAM_TIMEOUT",
				wantStatus:    http.StatusGatewayTimeout,
				wantRetryable: true,
			},
			{
				name: "policy-limit-error",
				fn: func(_ context.Context, _ fetch.Request) (fetch.Response, error) {
					return fetch.Response{}, fetch.ErrLimit
				},
				wantCode:   "UPSTREAM_INVALID_RESPONSE",
				wantStatus: http.StatusBadGateway,
			},
			{
				name: "missing-redirect-location",
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusFound, Header: make(http.Header), URL: req.URL}, nil
				},
				wantCode:   "UPSTREAM_INVALID_RESPONSE",
				wantStatus: http.StatusBadGateway,
			},
			{
				name: "503-upstream-unavailable",
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusServiceUnavailable, URL: req.URL}, nil
				},
				wantCode:      "UPSTREAM_UNAVAILABLE",
				wantStatus:    http.StatusBadGateway,
				wantRetryable: true,
			},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				p := NewWithFetcher(&stubExtractor{enabled: true}, nil, fakeXFetcher{fn: tc.fn})
				env, err := p.Parse(context.Background(), "https://t.co/FailCase1", now)
				if err != nil {
					t.Fatalf("unexpected err: %v", err)
				}
				assertGoldenEnvelopeValid(t, env, now, tc.wantCode, tc.wantStatus)
				gotRetry := unified.Map(env["error"])["retryable"] == true
				if gotRetry != tc.wantRetryable {
					t.Fatalf("retryable = %v, want %v; err=%+v", gotRetry, tc.wantRetryable, env["error"])
				}
			})
		}

		// Canceled caller context during t.co hop -> pass through context.Canceled.
		cancelCtx, cancel := context.WithCancel(context.Background())
		pCancel := NewWithFetcher(&stubExtractor{enabled: true}, nil, fakeXFetcher{
			fn: func(context.Context, fetch.Request) (fetch.Response, error) {
				cancel()
				return fetch.Response{}, context.Canceled
			},
		})
		env, err := pCancel.Parse(cancelCtx, "https://t.co/CancelHop", now)
		if !errors.Is(err, context.Canceled) || env != nil {
			t.Fatalf("expected (nil, context.Canceled), got env=%+v err=%v", env, err)
		}
	})
}

func TestGoldenParseSelectedPhotoDirectSyndication(t *testing.T) {
	const now int64 = 1762300800
	const tweetID = "1810000000000000003"

	synTwoPhotos, err := json.Marshal(map[string]any{
		"__typename": "Tweet",
		"id_str":     tweetID,
		"text":       "Gallery tweet",
		"user":       map[string]any{"name": "Artist", "screen_name": "artist_x"},
		"mediaDetails": []map[string]any{
			{
				"id_str":          "3001",
				"type":            "photo",
				"media_url_https": "https://pbs.twimg.com/media/GalleryKey1.jpg",
				"original_info":   map[string]any{"width": 1080, "height": 1080},
			},
			{
				"id_str":          "3002",
				"type":            "photo",
				"media_url_https": "https://pbs.twimg.com/media/GalleryKey2.png",
				"original_info":   map[string]any{"width": 1600, "height": 900},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	var ytCalls atomic.Int32
	p := NewWithFetcher(
		&stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				ytCalls.Add(1)
				return nil, errors.New("unexpected yt-dlp invocation")
			},
		},
		nil,
		fakeXFetcher{
			fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: http.StatusOK, Body: synTwoPhotos, URL: req.URL}, nil
			},
		},
	)

	// 1. Valid /photo/2 selection.
	src2 := "https://x.com/artist_x/status/" + tweetID + "/photo/2"
	env, err := p.Parse(context.Background(), src2, now)
	if err != nil {
		t.Fatal(err)
	}
	assertGoldenEnvelopeValid(t, env, now, "OK", http.StatusOK)
	if ytCalls.Load() != 0 {
		t.Fatalf("expected 0 yt-dlp calls, got %d", ytCalls.Load())
	}
	data := unified.Map(env["data"])
	items := unified.Slice(data["items"])
	if len(items) != 1 {
		t.Fatalf("expected 1 photo item, got %d", len(items))
	}
	item := unified.Map(items[0])
	wantItemID := "image-" + shortDigest("x:photo-item:"+tweetID+":GalleryKey2")
	wantVarID := "img-" + shortDigest("x:image:"+tweetID+":GalleryKey2")
	if unified.Str(item["id"]) != wantItemID || unified.Str(item["type"]) != "image" {
		t.Fatalf("unexpected photo item: %+v", item)
	}
	variant := unified.Map(unified.Slice(item["variants"])[0])
	if unified.Str(variant["id"]) != wantVarID {
		t.Fatalf("variant.id = %q, want %q", variant["id"], wantVarID)
	}
	meta := unified.Map(variant["metadata"])
	if unified.Str(meta["container"]) != "png" || unified.Str(meta["extension"]) != "png" ||
		unified.Str(meta["mime_type"]) != "image/png" || meta["width"] != int64(1600) || meta["height"] != int64(900) {
		t.Fatalf("unexpected photo metadata: %+v", meta)
	}
	delivery := unified.Map(variant["delivery"])
	srcObj := unified.Map(unified.Slice(delivery["sources"])[0])
	if unified.Str(delivery["kind"]) != "file" || unified.Str(srcObj["url"]) != "https://pbs.twimg.com/media/GalleryKey2.png" &&
		unified.Str(srcObj["url"]) != "https://pbs.twimg.com/media/GalleryKey2?format=png&name=orig" {
		t.Fatalf("unexpected photo delivery: %+v", delivery)
	}
	if unified.Str(srcObj["url"]) != "https://pbs.twimg.com/media/GalleryKey2?format=png&name=orig" {
		t.Fatalf("expected normalized orig photo URL, got %q", srcObj["url"])
	}

	// 2. Out-of-range /photo/3 when tweet has 2 photos -> CONTENT_UNAVAILABLE (404).
	envOOB, err := p.Parse(context.Background(), "https://x.com/artist_x/status/"+tweetID+"/photo/3", now)
	if err != nil {
		t.Fatal(err)
	}
	assertGoldenEnvelopeValid(t, envOOB, now, "CONTENT_UNAVAILABLE", http.StatusNotFound)
	if !strings.Contains(unified.Str(unified.Map(envOOB["error"])["message"]), "第 3 张图片") {
		t.Fatalf("unexpected out-of-range message: %+v", envOOB["error"])
	}

	// 3. Tombstone on /photo/1: off vs fxtwitter.
	tombstoneBody := []byte(`{"__typename":"TweetTombstone"}`)
	fxBody, _ := json.Marshal(map[string]any{
		"code": 200,
		"tweet": map[string]any{
			"text":   "NSFW art",
			"author": map[string]any{"name": "NSFWArtist", "screen_name": "nsfw_artist"},
			"media": map[string]any{
				"photos": []map[string]any{
					{"url": "https://pbs.twimg.com/media/TombKey1.jpg", "width": 1280, "height": 720},
				},
			},
		},
	})
	tombFetcher := fakeXFetcher{
		fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			if strings.HasPrefix(req.URL, syndicationEndpointURL) {
				return fetch.Response{StatusCode: http.StatusOK, Body: tombstoneBody, URL: req.URL}, nil
			}
			return fetch.Response{StatusCode: http.StatusOK, Body: fxBody, URL: req.URL}, nil
		},
	}
	pOff := NewWithFetcher(&stubExtractor{enabled: true}, nil, tombFetcher)
	envOff, err := pOff.Parse(context.Background(), "https://x.com/nsfw_artist/status/"+tweetID+"/photo/1", now)
	if err != nil {
		t.Fatal(err)
	}
	assertGoldenEnvelopeValid(t, envOff, now, "UPSTREAM_BLOCKED", http.StatusForbidden)

	pFx, err := pOff.WithTombstoneFallback(TombstoneFallbackFxTwitter)
	if err != nil {
		t.Fatal(err)
	}
	envFx, err := pFx.Parse(context.Background(), "https://x.com/nsfw_artist/status/"+tweetID+"/photo/1", now)
	if err != nil {
		t.Fatal(err)
	}
	assertGoldenEnvelopeValid(t, envFx, now, "OK", http.StatusOK)

	envFxOOB, err := pFx.Parse(context.Background(), "https://x.com/nsfw_artist/status/"+tweetID+"/photo/2", now)
	if err != nil {
		t.Fatal(err)
	}
	assertGoldenEnvelopeValid(t, envFxOOB, now, "CONTENT_UNAVAILABLE", http.StatusNotFound)
}

func TestGoldenParseNilFetcherDirectYTEngine(t *testing.T) {
	const now int64 = 1762300800
	const tweetID = "1810000000000000004"
	const entryID = "1810000000000000401"

	var probedURLs []string
	p := NewWithSizeProber(
		&stubExtractor{
			enabled: true,
			extract: func(_ context.Context, rawURL string) (*ytengine.Info, error) {
				if rawURL != "https://x.com/i/status/"+tweetID {
					t.Fatalf("unexpected canonical URL: %q", rawURL)
				}
				return makeGoldenSingleVideoYTInfo(tweetID, entryID, true), nil
			},
		},
		func(_ context.Context, rawURL string) (int64, bool) {
			probedURLs = append(probedURLs, rawURL)
			return 9876543, true
		},
	)

	srcURL := "https://x.com/golden_author/status/" + tweetID
	env, err := p.Parse(context.Background(), srcURL, now)
	if err != nil {
		t.Fatal(err)
	}
	assertGoldenEnvelopeValid(t, env, now, "OK", http.StatusOK)
	if len(probedURLs) != 1 || !strings.Contains(probedURLs[0], "v1080.mp4") {
		t.Fatalf("expected sizeProber to probe only missing 1080p MP4 URL, got %v", probedURLs)
	}

	data := unified.Map(env["data"])
	item := unified.Map(unified.Slice(data["items"])[0])
	variants := unified.Slice(item["variants"])
	if len(variants) != 3 {
		t.Fatalf("expected 3 variants [1080p, 720p, 1080p HLS], got %d: %+v", len(variants), variants)
	}

	v0 := unified.Map(variants[0])
	v1 := unified.Map(variants[1])
	v2 := unified.Map(variants[2])
	if unified.Str(v0["label"]) != "1080p" || unified.Str(v1["label"]) != "720p" || unified.Str(v2["label"]) != "1080p (HLS 需合流)" {
		t.Fatalf("unexpected variant label order: [%v, %v, %v]", v0["label"], v1["label"], v2["label"])
	}
	if unified.Str(v0["id"]) != "v-"+shortDigest("x:file:"+entryID+":http-2176") ||
		unified.Str(v1["id"]) != "v-"+shortDigest("x:file:"+entryID+":http-832") ||
		unified.Str(v2["id"]) != "v-"+shortDigest("x:hls:"+entryID+":hls-1080") {
		t.Fatalf("unexpected variant IDs: [%v, %v, %v]", v0["id"], v1["id"], v2["id"])
	}
	src0 := unified.Map(unified.Slice(unified.Map(v0["delivery"])["sources"])[0])
	if src0["size_bytes"] != int64(9876543) {
		t.Fatalf("expected probed size_bytes=9876543 on 1080p MP4, got %v", src0["size_bytes"])
	}
	if unified.Str(unified.Map(item["default"])["variant_id"]) != unified.Str(v0["id"]) {
		t.Fatalf("expected 1080p MP4 as default variant, got %+v", item["default"])
	}
	sel2 := unified.Map(unified.Map(v2["delivery"])["selection"])
	if unified.Str(sel2["video_representation_id"]) != "hls-1080" || unified.Str(sel2["audio_representation_id"]) != "hls-audio-128" {
		t.Fatalf("expected adaptive HLS audio pairing, got %+v", sel2)
	}

	// Engine error with RetryAfter propagation.
	pErr := New(&stubExtractor{
		enabled: true,
		extract: func(context.Context, string) (*ytengine.Info, error) {
			return nil, &ytengine.Error{
				Code:       ytengine.CodeRateLimited,
				Message:    "解析队列繁忙，请稍后重试",
				Retryable:  true,
				RetryAfter: 7,
			}
		},
	})
	envErr, err := pErr.Parse(context.Background(), srcURL, now)
	if err != nil {
		t.Fatal(err)
	}
	assertGoldenEnvelopeValid(t, envErr, now, "RATE_LIMITED", http.StatusTooManyRequests)
	if unified.Map(envErr["error"])["retry_after_seconds"] != 7 {
		t.Fatalf("expected retry_after_seconds=7, got %+v", envErr["error"])
	}
}

func TestGoldenParseStage1SyndicationFastPath(t *testing.T) {
	const now int64 = 1762300800
	const tweetID = "1810000000000000005"

	mixedSynBody, err := json.Marshal(map[string]any{
		"__typename":         "Tweet",
		"id_str":             tweetID,
		"text":               "Fast-path mixed video and photo #demo https://t.co/xyz123",
		"created_at":         "Wed Nov 05 12:00:00 +0000 2025",
		"favorite_count":     900,
		"conversation_count": 45,
		"user":               map[string]any{"name": "FastCreator", "screen_name": "fast_creator"},
		"entities": map[string]any{
			"hashtags": []map[string]any{{"text": "demo"}},
		},
		"mediaDetails": []map[string]any{
			{
				"id_str":          "1810000000000000501",
				"type":            "video",
				"media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/1810000000000000501/pu/img/thumb.jpg",
				"original_info":   map[string]any{"width": 1920, "height": 1080},
				"video_info": map[string]any{
					"duration_millis": 8500,
					"variants": []map[string]any{
						{
							"bitrate":      2176000,
							"content_type": "video/mp4",
							"url":          "https://video.twimg.com/ext_tw_video/1810000000000000501/pu/vid/avc1/1920x1080/fast1080.mp4",
						},
						{
							"bitrate":      832000,
							"content_type": "video/mp4",
							"url":          "https://video.twimg.com/ext_tw_video/1810000000000000501/pu/vid/avc1/1280x720/fast720.mp4",
						},
					},
				},
			},
			{
				"id_str":          "1810000000000000502",
				"type":            "photo",
				"media_url_https": "https://pbs.twimg.com/media/FastSuppPhoto1.webp",
				"original_info":   map[string]any{"width": 1440, "height": 1080},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	purePhotoSynBody, err := json.Marshal(map[string]any{
		"__typename": "Tweet",
		"id_str":     tweetID,
		"text":       "Pure photo post",
		"user":       map[string]any{"name": "PhotoOnly", "screen_name": "photo_only"},
		"photos": []map[string]any{
			{"url": "https://pbs.twimg.com/media/PurePic1.jpg", "width": 1000, "height": 800},
			{"url": "https://pbs.twimg.com/media/PurePic2.jpg", "width": 1000, "height": 800},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("video-with-photo-fast-path-never-spawns-ytdlp", func(t *testing.T) {
		var ytCalls atomic.Int32
		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					ytCalls.Add(1)
					return nil, errors.New("yt-dlp must not run on Stage 1 fast-path")
				},
			},
			func(_ context.Context, rawURL string) (int64, bool) {
				if strings.Contains(rawURL, "fast1080.mp4") {
					return 5550000, true
				}
				return 2220000, true
			},
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: mixedSynBody, URL: req.URL}, nil
				},
			},
		)

		env, err := p.Parse(context.Background(), "https://x.com/fast_creator/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, env, now, "OK", http.StatusOK)
		if ytCalls.Load() != 0 {
			t.Fatalf("expected 0 yt-dlp calls, got %d", ytCalls.Load())
		}
		data := unified.Map(env["data"])
		items := unified.Slice(data["items"])
		if len(items) != 2 {
			t.Fatalf("expected 2 items [video, image], got %d: %+v", len(items), items)
		}
		vidItem := unified.Map(items[0])
		imgItem := unified.Map(items[1])
		if unified.Str(vidItem["type"]) != "video" || unified.Str(imgItem["type"]) != "image" {
			t.Fatalf("unexpected item types: [%v, %v]", vidItem["type"], imgItem["type"])
		}
		if unified.Str(data["default_item_id"]) != unified.Str(vidItem["id"]) {
			t.Fatalf("expected video item as default_item_id, got %q", data["default_item_id"])
		}
		groups := unified.Slice(data["groups"])
		if len(groups) != 1 || unified.Str(unified.Map(groups[0])["kind"]) != "album" {
			t.Fatalf("expected album group for supplemental photo, got %+v", groups)
		}
		variants := unified.Slice(vidItem["variants"])
		if len(variants) != 2 ||
			unified.Str(unified.Map(variants[0])["label"]) != "1080p" ||
			unified.Str(unified.Map(variants[1])["label"]) != "720p" {
			t.Fatalf("unexpected video variants: %+v", variants)
		}
	})

	t.Run("pure-photo-and-video-selector-on-pure-photo", func(t *testing.T) {
		var ytCalls atomic.Int32
		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					ytCalls.Add(1)
					return nil, errors.New("yt-dlp must not run on pure photo Stage 1")
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: purePhotoSynBody, URL: req.URL}, nil
				},
			},
		)

		envPhotos, err := p.Parse(context.Background(), "https://x.com/photo_only/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envPhotos, now, "OK", http.StatusOK)
		if len(unified.Slice(unified.Map(envPhotos["data"])["items"])) != 2 {
			t.Fatalf("expected 2 photo items, got %+v", envPhotos["data"])
		}

		envVidSel, err := p.Parse(context.Background(), "https://x.com/photo_only/status/"+tweetID+"/video/1", now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envVidSel, now, "CONTENT_UNAVAILABLE", http.StatusNotFound)
		if ytCalls.Load() != 0 {
			t.Fatalf("expected 0 yt-dlp calls, got %d", ytCalls.Load())
		}
	})
}

func TestGoldenParseStage2ParallelRaceAndFallbacks(t *testing.T) {
	const now int64 = 1762300800
	const tweetID = "1810000000000000006"
	const entryID = "1810000000000000601"

	purePhotoSynBody, _ := json.Marshal(map[string]any{
		"__typename": "Tweet",
		"id_str":     tweetID,
		"text":       "Slow syndication photo post",
		"user":       map[string]any{"name": "SlowPhoto", "screen_name": "slow_photo"},
		"photos": []map[string]any{
			{"url": "https://pbs.twimg.com/media/SlowPhotoKey1.jpg", "width": 1200, "height": 900},
		},
	})

	pureTextSynBody, _ := json.Marshal(map[string]any{
		"__typename": "Tweet",
		"id_str":     tweetID,
		"text":       "Just a text status without media or cards",
		"user":       map[string]any{"name": "TextUser", "screen_name": "text_user"},
	})

	incompleteVideoWithPhotosSynBody, _ := json.Marshal(map[string]any{
		"__typename": "Tweet",
		"id_str":     tweetID,
		"text":       "Mixed tweet where syndication lacks MP4 variants",
		"user":       map[string]any{"name": "MixedAuthor", "screen_name": "mixed_author"},
		"mediaDetails": []map[string]any{
			{
				"id_str":          entryID,
				"type":            "video",
				"media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/" + entryID + "/pu/img/t.jpg",
				"video_info": map[string]any{
					"duration_millis": 10000,
					"variants": []map[string]any{
						{
							"content_type": "application/x-mpegURL",
							"url":          "https://video.twimg.com/ext_tw_video/" + entryID + "/pu/pl/master.m3u8",
						},
					},
				},
			},
			{
				"id_str":          "6002",
				"type":            "photo",
				"media_url_https": "https://pbs.twimg.com/media/MergedPhoto1.jpg",
				"original_info":   map[string]any{"width": 1280, "height": 960},
			},
			{
				"id_str":          "6003",
				"type":            "photo",
				"media_url_https": "https://pbs.twimg.com/media/MergedPhoto2.webp",
				"original_info":   map[string]any{"width": 1280, "height": 960},
			},
		},
	})

	t.Run("late-syndication-fast-path-cancels-ytdlp", func(t *testing.T) {
		ytEntered := make(chan struct{})
		ytCanceled := make(chan struct{})

		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(ytCtx context.Context, _ string) (*ytengine.Info, error) {
					close(ytEntered)
					<-ytCtx.Done()
					close(ytCanceled)
					return nil, ytCtx.Err()
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					<-ytEntered
					return fetch.Response{StatusCode: http.StatusOK, Body: purePhotoSynBody, URL: req.URL}, nil
				},
			},
		)
		p.supplementTimeout = 5 * time.Millisecond

		env, err := p.Parse(context.Background(), "https://x.com/slow_photo/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, env, now, "OK", http.StatusOK)
		select {
		case <-ytCanceled:
		case <-time.After(time.Second):
			t.Fatal("expected running yt-dlp context to be canceled by late syndication fast-path")
		}
	})

	t.Run("ytdlp-local-busy-passthrough-cancels-syndication", func(t *testing.T) {
		synCanceled := make(chan struct{})
		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{
						Code:       ytengine.CodeRateLimited,
						Message:    "解析队列已满",
						Retryable:  true,
						RetryAfter: 5,
						LocalBusy:  true,
					}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(synCtx context.Context, _ fetch.Request) (fetch.Response, error) {
					<-synCtx.Done()
					close(synCanceled)
					return fetch.Response{}, synCtx.Err()
				},
			},
		)
		p.supplementTimeout = 5 * time.Millisecond

		env, err := p.Parse(context.Background(), "https://x.com/user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, env, now, "RATE_LIMITED", http.StatusTooManyRequests)
		if unified.Map(env["error"])["retry_after_seconds"] != 5 {
			t.Fatalf("expected retry_after_seconds=5 on LocalBusy, got %+v", env["error"])
		}
		select {
		case <-synCanceled:
		case <-time.After(time.Second):
			t.Fatal("expected slow syndication context to be canceled immediately on LocalBusy")
		}
	})

	t.Run("ytdlp-failure-fallback-matrix", func(t *testing.T) {
		// 1) yt-dlp fails -> rescued by slow syndication fast-path.
		ytDone := make(chan struct{})
		pRescue := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					defer close(ytDone)
					return nil, &ytengine.Error{Code: ytengine.CodeUpstreamUnavailable, Message: "yt failed", Retryable: true}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					<-ytDone
					return fetch.Response{StatusCode: http.StatusOK, Body: purePhotoSynBody, URL: req.URL}, nil
				},
			},
		)
		pRescue.supplementTimeout = 5 * time.Millisecond
		envRescue, err := pRescue.Parse(context.Background(), "https://x.com/slow_photo/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envRescue, now, "OK", http.StatusOK)

		// 2) yt-dlp fails + syndication Tombstone -> UPSTREAM_BLOCKED (off) vs OK (fxtwitter).
		tombBody := []byte(`{"__typename":"TweetTombstone"}`)
		fxPhotoBody, _ := json.Marshal(map[string]any{
			"code": 200,
			"tweet": map[string]any{
				"text":   "Age gated photo",
				"author": map[string]any{"name": "Gated", "screen_name": "gated_user"},
				"media": map[string]any{
					"photos": []map[string]any{
						{"url": "https://pbs.twimg.com/media/GatedPic1.jpg", "width": 1000, "height": 1000},
					},
				},
			},
		})
		pTombOff := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeUpstreamBlocked, Message: "blocked"}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					if strings.HasPrefix(req.URL, syndicationEndpointURL) {
						return fetch.Response{StatusCode: http.StatusOK, Body: tombBody, URL: req.URL}, nil
					}
					return fetch.Response{StatusCode: http.StatusOK, Body: fxPhotoBody, URL: req.URL}, nil
				},
			},
		)
		envTombOff, err := pTombOff.Parse(context.Background(), "https://x.com/gated_user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envTombOff, now, "UPSTREAM_BLOCKED", http.StatusForbidden)

		pTombFx, _ := pTombOff.WithTombstoneFallback(TombstoneFallbackFxTwitter)
		envTombFx, err := pTombFx.Parse(context.Background(), "https://x.com/gated_user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envTombFx, now, "OK", http.StatusOK)

		// 3) yt-dlp CONTENT_UNAVAILABLE + pure-text syndication -> NO_MEDIA (404).
		pPureText := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "no video in tweet"}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: pureTextSynBody, URL: req.URL}, nil
				},
			},
		)
		envPureText, err := pPureText.Parse(context.Background(), "https://x.com/text_user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envPureText, now, "NO_MEDIA", http.StatusNotFound)

		// 4) yt-dlp CONTENT_UNAVAILABLE + syndication 429 -> maps syndication error RATE_LIMITED (429).
		pSyn429 := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "no video"}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusTooManyRequests, URL: req.URL}, nil
				},
			},
		)
		envSyn429, err := pSyn429.Parse(context.Background(), "https://x.com/user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envSyn429, now, "RATE_LIMITED", http.StatusTooManyRequests)

		// 5) yt-dlp CONTENT_UNAVAILABLE + syndication 404 -> preserves CONTENT_UNAVAILABLE (404).
		pBoth404 := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return nil, &ytengine.Error{Code: ytengine.CodeContentUnavailable, Message: "deleted"}
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusNotFound, URL: req.URL}, nil
				},
			},
		)
		envBoth404, err := pBoth404.Parse(context.Background(), "https://x.com/user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envBoth404, now, "CONTENT_UNAVAILABLE", http.StatusNotFound)

		// 6) yt-dlp returns format-less Info (adapted["code"] == "NO_MEDIA"):
		//    rescued by syndication fast-path, tombstone, pure-text, or syndication 403 error.
		pEmptyYTRescued := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return &ytengine.Info{ID: tweetID, DisplayID: tweetID}, nil
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					time.Sleep(15 * time.Millisecond)
					return fetch.Response{StatusCode: http.StatusOK, Body: purePhotoSynBody, URL: req.URL}, nil
				},
			},
		)
		pEmptyYTRescued.supplementTimeout = 5 * time.Millisecond
		envEmptyRescued, err := pEmptyYTRescued.Parse(context.Background(), "https://x.com/user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envEmptyRescued, now, "OK", http.StatusOK)

		pEmptyYTTomb := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return &ytengine.Info{ID: tweetID, DisplayID: tweetID}, nil
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: tombBody, URL: req.URL}, nil
				},
			},
		)
		envEmptyTomb, err := pEmptyYTTomb.Parse(context.Background(), "https://x.com/user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envEmptyTomb, now, "UPSTREAM_BLOCKED", http.StatusForbidden)

		pEmptyYTPureText := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return &ytengine.Info{ID: tweetID, DisplayID: tweetID}, nil
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: pureTextSynBody, URL: req.URL}, nil
				},
			},
		)
		envEmptyPureText, err := pEmptyYTPureText.Parse(context.Background(), "https://x.com/user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envEmptyPureText, now, "NO_MEDIA", http.StatusNotFound)

		pEmptyYTBlockedSyn := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return &ytengine.Info{ID: tweetID, DisplayID: tweetID}, nil
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusForbidden, URL: req.URL}, nil
				},
			},
		)
		envEmptyBlocked, err := pEmptyYTBlockedSyn.Parse(context.Background(), "https://x.com/user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envEmptyBlocked, now, "UPSTREAM_BLOCKED", http.StatusForbidden)
	})

	t.Run("ytdlp-success-merged-with-syndication-supplemental-photos", func(t *testing.T) {
		p := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return makeGoldenSingleVideoYTInfo(tweetID, entryID, false), nil
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusOK, Body: incompleteVideoWithPhotosSynBody, URL: req.URL}, nil
				},
			},
		)

		// Unindexed status URL merges 1 video + 2 supplemental photos + album group.
		envMerged, err := p.Parse(context.Background(), "https://x.com/mixed_author/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envMerged, now, "OK", http.StatusOK)
		data := unified.Map(envMerged["data"])
		items := unified.Slice(data["items"])
		if len(items) != 3 {
			t.Fatalf("expected 3 items [video, image1, image2], got %d: %+v", len(items), items)
		}
		if unified.Str(unified.Map(items[0])["type"]) != "video" ||
			unified.Str(unified.Map(items[1])["type"]) != "image" ||
			unified.Str(unified.Map(items[2])["type"]) != "image" {
			t.Fatalf("unexpected item types in merged envelope: %+v", items)
		}
		if unified.Str(data["default_item_id"]) != unified.Str(unified.Map(items[0])["id"]) {
			t.Fatalf("default_item_id must remain video item, got %q", data["default_item_id"])
		}
		groups := unified.Slice(data["groups"])
		if len(groups) != 1 || unified.Map(groups[0])["total_count"] != int64(2) {
			t.Fatalf("expected album group of 2 supplemental photos, got %+v", groups)
		}

		// Explicit /video/1 selector must NOT append supplemental photos.
		envVideoOnly, err := p.Parse(context.Background(), "https://x.com/mixed_author/status/"+tweetID+"/video/1", now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envVideoOnly, now, "OK", http.StatusOK)
		if len(unified.Slice(unified.Map(envVideoOnly["data"])["items"])) != 1 {
			t.Fatalf("expected /video/1 selector to omit supplemental photos, got %+v", envVideoOnly["data"])
		}
	})

	t.Run("stage1-and-stage2-cancellation-and-timeout", func(t *testing.T) {
		// Stage 1 caller cancel -> (nil, context.Canceled)
		s1Ctx, s1Cancel := context.WithCancel(context.Background())
		pS1Cancel := NewWithFetcher(
			&stubExtractor{enabled: true},
			nil,
			fakeXFetcher{
				fn: func(reqCtx context.Context, _ fetch.Request) (fetch.Response, error) {
					s1Cancel()
					<-reqCtx.Done()
					return fetch.Response{}, reqCtx.Err()
				},
			},
		)
		env, err := pS1Cancel.Parse(s1Ctx, "https://x.com/user/status/"+tweetID, now)
		if !errors.Is(err, context.Canceled) || env != nil {
			t.Fatalf("expected Stage 1 (nil, context.Canceled), got env=%+v err=%v", env, err)
		}

		// Stage 1 caller deadline -> UPSTREAM_TIMEOUT (504)
		s1TimeoutCtx, s1TimeoutCancel := context.WithTimeout(context.Background(), 15*time.Millisecond)
		defer s1TimeoutCancel()
		pS1Timeout := NewWithFetcher(
			&stubExtractor{enabled: true},
			nil,
			fakeXFetcher{
				fn: func(reqCtx context.Context, _ fetch.Request) (fetch.Response, error) {
					<-reqCtx.Done()
					return fetch.Response{}, reqCtx.Err()
				},
			},
		)
		pS1Timeout.supplementTimeout = time.Second
		envTimeout1, err := pS1Timeout.Parse(s1TimeoutCtx, "https://x.com/user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envTimeout1, now, "UPSTREAM_TIMEOUT", http.StatusGatewayTimeout)

		// Stage 2 caller cancel -> (nil, context.Canceled)
		s2Ctx, s2Cancel := context.WithCancel(context.Background())
		pS2Cancel := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(ytCtx context.Context, _ string) (*ytengine.Info, error) {
					s2Cancel()
					<-ytCtx.Done()
					return nil, ytCtx.Err()
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusNotFound, URL: req.URL}, nil
				},
			},
		)
		env, err = pS2Cancel.Parse(s2Ctx, "https://x.com/user/status/"+tweetID, now)
		if !errors.Is(err, context.Canceled) || env != nil {
			t.Fatalf("expected Stage 2 (nil, context.Canceled), got env=%+v err=%v", env, err)
		}

		// Stage 2 caller deadline -> UPSTREAM_TIMEOUT (504)
		s2TimeoutCtx, s2TimeoutCancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer s2TimeoutCancel()
		pS2Timeout := NewWithFetcher(
			&stubExtractor{
				enabled: true,
				extract: func(ytCtx context.Context, _ string) (*ytengine.Info, error) {
					<-ytCtx.Done()
					return nil, ytCtx.Err()
				},
			},
			nil,
			fakeXFetcher{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					return fetch.Response{StatusCode: http.StatusNotFound, URL: req.URL}, nil
				},
			},
		)
		envTimeout2, err := pS2Timeout.Parse(s2TimeoutCtx, "https://x.com/user/status/"+tweetID, now)
		if err != nil {
			t.Fatal(err)
		}
		assertGoldenEnvelopeValid(t, envTimeout2, now, "UPSTREAM_TIMEOUT", http.StatusGatewayTimeout)
	})
}
