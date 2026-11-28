package pinterest

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type stubExecutor func(context.Context, fetch.Request) (fetch.Response, error)

func (f stubExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	return f(ctx, req)
}

func loadFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return data
}

func TestPinterestParseFixturesAndHeaderContract(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC).Unix()

	runFixture := func(t *testing.T, pinID, inputURL, fixtureName string) unified.Object {
		t.Helper()
		body := loadFixture(t, fixtureName)
		var gotReq fetch.Request
		parser := New(stubExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			gotReq = req
			return fetch.Response{StatusCode: http.StatusOK, Body: body, URL: req.URL}, nil
		}))
		out, err := parser.Parse(t.Context(), inputURL, now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		if gotReq.Header.Get("X-Pinterest-PWS-Handler") != "www/pin/[id].js" {
			t.Fatalf("missing required X-Pinterest-PWS-Handler header: %+v", gotReq.Header)
		}
		if gotReq.Header.Get("Cookie") != "" {
			t.Fatalf("must not send Cookie header, got %q", gotReq.Header.Get("Cookie"))
		}
		if gotReq.Policy.FollowRedirects {
			t.Fatal("PinResource request must set FollowRedirects=false")
		}
		if !gotReq.Policy.AllowedURL(gotReq.URL) || gotReq.Policy.AllowedURL("https://evil.example/resource/PinResource/get/") {
			t.Fatal("AllowedURL failed to pin www.pinterest.com")
		}
		if unified.Str(out["code"]) != "OK" {
			t.Fatalf("expected OK envelope, got %+v", out)
		}
		// Validate both raw and PublicView envelopes against strict unified-v1 contract.
		if err := unified.ValidateEnvelope(out); err != nil {
			t.Fatalf("ValidateEnvelope(raw) failed for %s: %v", fixtureName, err)
		}
		pub := unified.PublicView(out, false, now)
		if err := unified.ValidateEnvelope(pub); err != nil {
			t.Fatalf("ValidateEnvelope(public) failed for %s: %v", fixtureName, err)
		}
		data := unified.Map(pub["data"])
		if unified.Str(data["platform"]) != "pinterest" || unified.Str(data["content_id"]) != pinID {
			t.Fatalf("unexpected platform/content_id: %v / %v", data["platform"], data["content_id"])
		}
		return pub
	}

	t.Run("static-image", func(t *testing.T) {
		pub := runFixture(t, "858146903966145191", "https://jp.pinterest.com/pin/cool--858146903966145191/sent/?foo=1", "static_image.json")
		data := unified.Map(pub["data"])
		items := unified.Slice(data["items"])
		if len(items) != 1 {
			t.Fatalf("len(items) = %d, want 1", len(items))
		}
		item := unified.Map(items[0])
		if unified.Str(item["type"]) != "image" {
			t.Fatalf("item type = %v, want image", item["type"])
		}
		v := unified.Map(unified.Slice(item["variants"])[0])
		meta := unified.Map(v["metadata"])
		if unified.Str(meta["extension"]) != "png" || unified.Str(meta["mime_type"]) != "image/png" {
			t.Fatalf("unexpected image metadata: %+v", meta)
		}
		src := unified.Map(unified.Slice(unified.Map(v["delivery"])["sources"])[0])
		if unified.Str(src["access"]) != "direct" {
			t.Fatalf("expected access=direct, got %+v", src)
		}
		if _, hasBF := src["browser_fetch"]; hasBF {
			t.Fatalf("Pinterest must omit browser_fetch (keep unknown) so native preview works, got %+v", src)
		}
	})

	t.Run("video-v720p-key-actual-1080x1920", func(t *testing.T) {
		pub := runFixture(t, "900000000000000102", "https://www.pinterest.com/pin/900000000000000102/", "video_1080p_v720p_key.json")
		data := unified.Map(pub["data"])
		items := unified.Slice(data["items"])
		if len(items) != 1 {
			t.Fatalf("len(items) = %d, want 1", len(items))
		}
		item := unified.Map(items[0])
		variants := unified.Slice(item["variants"])
		if len(variants) != 2 {
			t.Fatalf("expected 2 progressive mp4 variants sorted by pixel area, got %d", len(variants))
		}
		top := unified.Map(variants[0])
		meta := unified.Map(top["metadata"])
		if h, _ := unified.PHPInt(meta["height"]); h != 1920 {
			t.Fatalf("height = %d, want 1920", h)
		}
		if w, _ := unified.PHPInt(meta["width"]); w != 1080 {
			t.Fatalf("width = %d, want 1080", w)
		}
		if unified.Str(top["label"]) != "1080p" {
			t.Fatalf("label = %q, want 1080p (never hardcode 720p from V_720P key)", top["label"])
		}
		src := unified.Map(unified.Slice(unified.Map(top["delivery"])["sources"])[0])
		if _, hasBF := src["browser_fetch"]; hasBF {
			t.Fatalf("Pinterest video must omit browser_fetch, got %+v", src)
		}
	})

	t.Run("story-9-images-album", func(t *testing.T) {
		pub := runFixture(t, "900000000000000103", "https://www.pinterest.ca/pin/900000000000000103/", "story_9_images.json")
		data := unified.Map(pub["data"])
		items := unified.Slice(data["items"])
		if len(items) != 9 {
			t.Fatalf("len(items) = %d, want 9", len(items))
		}
		groups := unified.Slice(data["groups"])
		if len(groups) != 1 || unified.Str(unified.Map(groups[0])["kind"]) != "album" {
			t.Fatalf("expected album group for 9-image story pin, got %+v", groups)
		}
	})

	t.Run("story-mp4-video", func(t *testing.T) {
		pub := runFixture(t, "900000000000000104", "https://www.pinterest.com/pin/900000000000000104/", "story_mp4_video.json")
		data := unified.Map(pub["data"])
		items := unified.Slice(data["items"])
		if len(items) != 1 || unified.Str(unified.Map(items[0])["type"]) != "video" {
			t.Fatalf("expected 1 MP4 video item, got %+v", items)
		}
		variants := unified.Slice(unified.Map(items[0])["variants"])
		if len(variants) != 2 || unified.Str(unified.Map(variants[0])["label"]) != "720p" {
			t.Fatalf("unexpected story mp4 variants: %+v", variants)
		}
	})

	t.Run("story-hls-only-fallback", func(t *testing.T) {
		pub := runFixture(t, "900000000000000105", "https://www.pinterest.com/pin/900000000000000105/", "story_hls_only.json")
		data := unified.Map(pub["data"])
		items := unified.Slice(data["items"])
		if len(items) != 2 {
			t.Fatalf("expected 2 items (cover image + adaptive HLS video), got %d", len(items))
		}
		imgItem := unified.Map(items[0])
		vidItem := unified.Map(items[1])
		if unified.Str(imgItem["type"]) != "image" || unified.Str(vidItem["type"]) != "video" {
			t.Fatalf("unexpected item types: %v, %v", imgItem["type"], vidItem["type"])
		}
		if vidItem["default"] != nil || unified.Str(vidItem["default_unavailable_reason"]) != "processing_required" {
			t.Fatalf("expected HLS video default=nil & processing_required, got default=%v reason=%v", vidItem["default"], vidItem["default_unavailable_reason"])
		}
		delivery := unified.Map(unified.Map(unified.Slice(vidItem["variants"])[0])["delivery"])
		if unified.Str(delivery["kind"]) != "hls" || unified.Str(delivery["scope"]) != "adaptive" {
			t.Fatalf("unexpected HLS delivery: %+v", delivery)
		}
		warnings := unified.Slice(pub["warnings"])
		if len(warnings) != 1 || unified.Str(unified.Map(warnings[0])["code"]) != "HLS_SPLIT_AUDIO_LIMITED" {
			t.Fatalf("expected HLS_SPLIT_AUDIO_LIMITED warning preserved through PublicView, got %+v", warnings)
		}
	})
}

func TestPinterestPinItShortLinkResolutionAndCallerScopedFailure(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC).Unix()
	imgFixture := loadFixture(t, "static_image.json")

	t.Run("two-hop-shortlink-success", func(t *testing.T) {
		hops := 0
		parser := New(stubExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			hops++
			switch req.URL {
			case "https://pin.it/3abcXYZ":
				return fetch.Response{
					StatusCode: http.StatusFound,
					Header:     http.Header{"Location": {"https://api.pinterest.com/url_shortener/3abcXYZ/redirect/"}},
				}, nil
			case "https://api.pinterest.com/url_shortener/3abcXYZ/redirect/":
				return fetch.Response{
					StatusCode: http.StatusFound,
					Header:     http.Header{"Location": {"https://www.pinterest.com/pin/858146903966145191/sent/?invite_code=test"}},
				}, nil
			default:
				if !strings.HasPrefix(req.URL, "https://www.pinterest.com/resource/PinResource/get/") {
					t.Fatalf("unexpected URL: %s", req.URL)
				}
				return fetch.Response{StatusCode: http.StatusOK, Body: imgFixture, URL: req.URL}, nil
			}
		}))
		out, err := parser.Parse(t.Context(), "https://pin.it/3abcXYZ", now)
		if err != nil {
			t.Fatalf("Parse shortlink failed: %v", err)
		}
		if unified.Str(out["code"]) != "OK" || hops != 3 {
			t.Fatalf("expected OK in 3 hops (2 redirects + PinResource), got code=%v hops=%d", out["code"], hops)
		}
		if err := unified.ValidateEnvelope(out); err != nil {
			t.Fatalf("ValidateEnvelope failed: %v", err)
		}
	})

	t.Run("shortlink-to-board-is-caller-scoped-invalid-input", func(t *testing.T) {
		parser := New(stubExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			return fetch.Response{
				StatusCode: http.StatusFound,
				Header:     http.Header{"Location": {"https://www.pinterest.com/creator/some-board/"}},
			}, nil
		}))
		ctx, isCallerScoped := unified.WithCallerScopedFailureTracker(t.Context())
		out, err := parser.Parse(ctx, "https://pin.it/boardLink1", now)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if unified.Str(out["code"]) != "INVALID_INPUT" {
			t.Fatalf("code = %v, want INVALID_INPUT", out["code"])
		}
		if !isCallerScoped() {
			t.Fatal("expected board shortlink failure to be marked caller-scoped")
		}
	})

	t.Run("shortlink-5xx-is-retryable-upstream-unavailable", func(t *testing.T) {
		for _, status := range []int{http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout} {
			parser := New(stubExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: status}, nil
			}))
			ctx, isCallerScoped := unified.WithCallerScopedFailureTracker(t.Context())
			out, err := parser.Parse(ctx, "https://pin.it/serverErr1", now)
			if err != nil {
				t.Fatalf("status %d unexpected error: %v", status, err)
			}
			if unified.Str(out["code"]) != "UPSTREAM_UNAVAILABLE" {
				t.Fatalf("status %d -> code = %v, want UPSTREAM_UNAVAILABLE", status, out["code"])
			}
			retry, _ := unified.Map(out["error"])["retryable"].(bool)
			if !retry {
				t.Errorf("status %d -> retryable = false, want true", status)
			}
			if isCallerScoped() {
				t.Errorf("status %d -> must NOT mark caller-scoped failure", status)
			}
		}
	})

	t.Run("upstream-status-mapping", func(t *testing.T) {
		for _, tc := range []struct {
			status    int
			wantCode  string
			wantRetry bool
		}{
			{http.StatusNotFound, "CONTENT_UNAVAILABLE", false},
			{http.StatusForbidden, "UPSTREAM_BLOCKED", true},
			{http.StatusTooManyRequests, "RATE_LIMITED", true},
			{http.StatusInternalServerError, "UPSTREAM_UNAVAILABLE", true},
		} {
			parser := New(stubExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				return fetch.Response{StatusCode: tc.status}, nil
			}))
			out, err := parser.Parse(t.Context(), "https://www.pinterest.com/pin/858146903966145191/", now)
			if err != nil {
				t.Fatalf("status %d unexpected err: %v", tc.status, err)
			}
			errObj := unified.Map(out["error"])
			retry, _ := errObj["retryable"].(bool)
			if unified.Str(out["code"]) != tc.wantCode || retry != tc.wantRetry {
				t.Fatalf("status %d -> code=%v retry=%v, want %s/%v", tc.status, out["code"], retry, tc.wantCode, tc.wantRetry)
			}
		}
	})
}
