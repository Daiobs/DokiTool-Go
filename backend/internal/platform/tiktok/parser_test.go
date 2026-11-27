package tiktok

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type stubExecutor struct {
	mu       sync.Mutex
	requests []fetch.Request
	fn       func(ctx context.Context, req fetch.Request, policy fetch.Policy) (fetch.Response, error)
}

func (s *stubExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	s.mu.Lock()
	s.requests = append(s.requests, req)
	s.mu.Unlock()
	return s.fn(ctx, req, req.Policy)
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return data
}

func TestAllowedMediaURL(t *testing.T) {
	allowed := []string{
		"https://v16-web-newkey.tiktokcdn.com/abcdef0123456789abcdef0123456789/6b09f2e5/video/tos/useast2a/v.mp4",
		"https://v16m-default.tiktokcdn-us.com/abcdef0123456789abcdef0123456789/6b09f2e5/video/tos/useast5/v.mp4",
		"https://v19-web-newkey.tiktokcdn-eu.com/video/tos/no1a/v.mp4",
		"https://v16-cold.tiktokv.com/video/tos/alisg/v.mp4",
		"https://p16-common-sign.tiktokcdn.com/tos-maliva-i-photomode/img.jpeg?x-expires=1800000000",
	}
	for _, raw := range allowed {
		if !AllowedMediaURL(raw) {
			t.Errorf("expected AllowedMediaURL(%q)=true", raw)
		}
	}

	rejected := []string{
		"",
		"http://v16-web-newkey.tiktokcdn.com/v.mp4",                                         // cleartext
		"https://v16-webapp-prime.tiktok.com/video/tos/v.mp4",                               // webapp-prime cookie-bound
		"https://v16-web-newkey.tiktokcdn.com/video/tos/v.mp4?tk=tt_chain_token",            // cookie token
		"https://v16-web-newkey.tiktokcdn.com:8443/video/tos/v.mp4",                         // non-standard port
		"https://user:pass@v16-web-newkey.tiktokcdn.com/video/tos/v.mp4",                    // userinfo
		"https://127.0.0.1/video/tos/v.mp4",                                                 // ip literal
		"https://10.0.0.1/video/tos/v.mp4",                                                  // private ip
		"https://evil.example/video/tos/v.mp4",                                              // foreign domain
		"https://tiktokcdn.com/video/tos/v.mp4",                                             // bare apex (needs subdomain)
		"https://www.tiktok.com/aweme/v1/play/?video_id=1",                                  // non-CDN host
	}
	for _, raw := range rejected {
		if AllowedMediaURL(raw) {
			t.Errorf("expected AllowedMediaURL(%q)=false", raw)
		}
	}
}

func TestParseVideoPostWithConcurrent302AndHexExpiry(t *testing.T) {
	now := int64(1795700000)
	expUnix := now + 21600 // +6h
	expHex := fmt.Sprintf("%08x", expUnix)
	html := readFixture(t, "video_post.html")

	var play302Calls atomic.Int32
	exec := &stubExecutor{
		fn: func(_ context.Context, req fetch.Request, policy fetch.Policy) (fetch.Response, error) {
			if policy.Purpose == "tiktok-page" {
				if req.URL != "https://www.tiktok.com/@i/video/7345678901234567890" {
					t.Errorf("unexpected hydration URL: %s", req.URL)
				}
				if req.Header.Get("Cookie") != "" {
					t.Errorf("hydration must send 0 Cookie, got %q", req.Header.Get("Cookie"))
				}
				if !strings.Contains(req.Header.Get("Accept-Encoding"), "gzip") {
					t.Errorf("hydration must request gzip, got %q", req.Header.Get("Accept-Encoding"))
				}
				return fetch.Response{StatusCode: 200, Body: html}, nil
			}
			if policy.Purpose == "tiktok-play-302" {
				play302Calls.Add(1)
				if req.Header.Get("Cookie") != "" {
					t.Errorf("302 must send 0 Cookie, got %q", req.Header.Get("Cookie"))
				}
				if req.Header.Get("Range") != "" {
					t.Errorf("302 must NOT attach Range header, got %q", req.Header.Get("Range"))
				}
				if req.Header.Get("Referer") != "https://www.tiktok.com/" {
					t.Errorf("302 must set Referer=https://www.tiktok.com/, got %q", req.Header.Get("Referer"))
				}
				if policy.FollowRedirects {
					t.Errorf("302 policy must set FollowRedirects=false")
				}
				if strings.Contains(req.URL, "vvc_skip") {
					t.Errorf("bytevc2/vvc stream must be filtered before 302")
				}
				h := make(http.Header)
				switch {
				case strings.Contains(req.URL, "tier_1080_hevc"):
					h.Set("Location", fmt.Sprintf("https://v16m-default.tiktokcdn-us.com/0123456789abcdef0123456789abcdef/%s/video/tos/useast5/1080.mp4", expHex))
				case strings.Contains(req.URL, "tier_720_hevc"):
					h.Set("Location", fmt.Sprintf("https://v16-web-newkey.tiktokcdn.com/fedcba9876543210fedcba9876543210/%s/video/tos/useast2a/720.mp4", expHex))
				case strings.Contains(req.URL, "tier_540_h264"):
					h.Set("Location", fmt.Sprintf("https://v19-web-newkey.tiktokcdn-eu.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/%s/video/tos/no1a/540.mp4", expHex))
				case strings.Contains(req.URL, "tier_360_low"):
					h.Set("Location", fmt.Sprintf("https://v16-cold.tiktokv.com/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/%s/video/tos/alisg/360.mp4", expHex))
				default:
					return fetch.Response{StatusCode: 404}, nil
				}
				return fetch.Response{StatusCode: 302, Header: h}, nil
			}
			return fetch.Response{}, fmt.Errorf("unexpected purpose %q url %q", policy.Purpose, req.URL)
		},
	}

	p := New(exec).WithClock(func() time.Time { return time.Unix(now, 0) })
	// Test normalization from /share/video/ and m.tiktok.com/v/<id>.html
	payload, err := p.Parse(context.Background(), "https://m.tiktok.com/v/7345678901234567890.html?foo=1", now)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if err := unified.ValidateEnvelope(payload); err != nil {
		t.Fatalf("ValidateEnvelope failed: %v", err)
	}
	if unified.Str(payload["code"]) != "OK" {
		t.Fatalf("code=%v, want OK", payload["code"])
	}
	if play302Calls.Load() != 4 {
		t.Fatalf("play302Calls=%d, want 4 (capped representative tiers)", play302Calls.Load())
	}

	data := unified.Map(payload["data"])
	if unified.Str(data["platform"]) != "tiktok" || unified.Str(data["content_id"]) != "7345678901234567890" {
		t.Fatalf("unexpected platform/content_id: %+v", data)
	}
	cover := unified.Map(data["cover"])
	if unified.Str(cover["browser_fetch"]) != "allowed" {
		t.Fatalf("cover browser_fetch=%q, want allowed", cover["browser_fetch"])
	}
	items := unified.Slice(data["items"])
	if len(items) != 1 {
		t.Fatalf("items len=%d, want 1", len(items))
	}
	variants := unified.Slice(unified.Map(items[0])["variants"])
	if len(variants) != 4 {
		t.Fatalf("variants len=%d, want 4", len(variants))
	}

	wantExpRFC3339 := time.Unix(expUnix, 0).UTC().Format(time.RFC3339)
	foundH264 := false
	for i, rv := range variants {
		v := unified.Map(rv)
		meta := unified.Map(v["metadata"])
		if unified.Str(meta["video_codec"]) == "h264" {
			foundH264 = true
		}
		if i == 0 && unified.Str(meta["video_codec"]) != "h265" {
			t.Errorf("top tier codec=%q, want h265", meta["video_codec"])
		}
		sources := unified.Slice(unified.Map(v["delivery"])["sources"])
		if len(sources) != 1 {
			t.Fatalf("variant[%d] sources=%d, want 1", i, len(sources))
		}
		src := unified.Map(sources[0])
		if unified.Str(src["access"]) != "direct" || unified.Str(src["browser_fetch"]) != "blocked" {
			t.Errorf("variant[%d] source access/browser_fetch = (%q,%q), want (direct,blocked)", i, src["access"], src["browser_fetch"])
		}
		if unified.Str(src["expires_at"]) != wantExpRFC3339 {
			t.Errorf("variant[%d] expires_at=%q, want %q", i, src["expires_at"], wantExpRFC3339)
		}
	}
	if !foundH264 {
		t.Fatalf("expected H.264 compatibility tier among selected variants")
	}

	atts := unified.Slice(data["attachments"])
	if len(atts) != 1 {
		t.Fatalf("attachments len=%d, want 1", len(atts))
	}
	attSrc := unified.Map(unified.Slice(unified.Map(unified.Map(unified.Map(atts[0])["resource"])["delivery"])["sources"])[0])
	if unified.Str(attSrc["browser_fetch"]) != "allowed" {
		t.Fatalf("music attachment browser_fetch=%q, want allowed", attSrc["browser_fetch"])
	}

	stats := p.TikTokRiskStatsSnapshot()
	if stats.HydrationOK != 1 || stats.Play302OK != 4 || stats.Play302Failed != 0 || stats.WAFBlocked != 0 || stats.ContentNotFound != 0 {
		t.Fatalf("unexpected risk stats: %+v", stats)
	}
}

func TestParsePhotoModeZero302AndSkipHEIC(t *testing.T) {
	now := int64(1791001000)
	html := readFixture(t, "photo_post.html")

	var play302Calls atomic.Int32
	exec := &stubExecutor{
		fn: func(_ context.Context, req fetch.Request, policy fetch.Policy) (fetch.Response, error) {
			if policy.Purpose == "tiktok-play-302" {
				play302Calls.Add(1)
			}
			if req.URL != "https://www.tiktok.com/@i/video/7399999999999999999" {
				t.Errorf("photo URL must normalize to /@i/video/<id>, got %s", req.URL)
			}
			return fetch.Response{StatusCode: 200, Body: html}, nil
		},
	}

	p := New(exec).WithClock(func() time.Time { return time.Unix(now, 0) })
	payload, err := p.Parse(context.Background(), "https://www.tiktok.com/@photo_artist/photo/7399999999999999999", now)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if err := unified.ValidateEnvelope(payload); err != nil {
		t.Fatalf("ValidateEnvelope failed: %v", err)
	}
	if play302Calls.Load() != 0 {
		t.Fatalf("Photo Mode must make 0 play-302 requests, got %d", play302Calls.Load())
	}

	data := unified.Map(payload["data"])
	items := unified.Slice(data["items"])
	if len(items) != 2 {
		t.Fatalf("items len=%d, want 2", len(items))
	}
	for i, ri := range items {
		item := unified.Map(ri)
		v := unified.Map(unified.Slice(item["variants"])[0])
		src := unified.Map(unified.Slice(unified.Map(v["delivery"])["sources"])[0])
		u := unified.Str(src["url"])
		if strings.Contains(u, ".heic") {
			t.Errorf("item[%d] selected HEIC URL instead of JPEG/WebP: %s", i, u)
		}
		if unified.Str(src["access"]) != "direct" || unified.Str(src["browser_fetch"]) != "allowed" {
			t.Errorf("item[%d] access/browser_fetch = (%q,%q), want (direct,allowed)", i, src["access"], src["browser_fetch"])
		}
		if unified.Str(src["expires_at"]) == "" {
			t.Errorf("item[%d] expected expires_at from x-expires", i)
		}
	}
	groups := unified.Slice(data["groups"])
	if len(groups) != 1 || unified.Str(unified.Map(groups[0])["kind"]) != "album" {
		t.Fatalf("expected album group, got %+v", groups)
	}
	atts := unified.Slice(data["attachments"])
	if len(atts) != 1 || unified.Str(unified.Map(atts[0])["role"]) != "background_audio" {
		t.Fatalf("expected background_audio attachment, got %+v", atts)
	}
}

func TestParseWAFAndUnavailableAndShortlinks(t *testing.T) {
	now := int64(1795700000)

	t.Run("SlardarWAF_1462B", func(t *testing.T) {
		wafHTML := readFixture(t, "slardar_waf.html")
		exec := &stubExecutor{
			fn: func(context.Context, fetch.Request, fetch.Policy) (fetch.Response, error) {
				return fetch.Response{StatusCode: 200, Body: wafHTML}, nil
			},
		}
		p := New(exec)
		payload, err := p.Parse(context.Background(), "https://www.tiktok.com/@a/video/7345678901234567890", now)
		if err != nil {
			t.Fatal(err)
		}
		if unified.Str(payload["code"]) != "UPSTREAM_BLOCKED" {
			t.Fatalf("code=%v, want UPSTREAM_BLOCKED", payload["code"])
		}
		st := p.TikTokRiskStatsSnapshot()
		if st.WAFBlocked != 1 || st.ContentNotFound != 0 || st.HydrationOK != 0 {
			t.Fatalf("unexpected stats: %+v", st)
		}
	})

	t.Run("StatusCode10204_NotWAF", func(t *testing.T) {
		notFoundHTML := readFixture(t, "status_10204.html")
		exec := &stubExecutor{
			fn: func(context.Context, fetch.Request, fetch.Policy) (fetch.Response, error) {
				return fetch.Response{StatusCode: 200, Body: notFoundHTML}, nil
			},
		}
		p := New(exec)
		payload, err := p.Parse(context.Background(), "https://www.tiktok.com/@a/video/7345678901234567890", now)
		if err != nil {
			t.Fatal(err)
		}
		if unified.Str(payload["code"]) != "CONTENT_UNAVAILABLE" {
			t.Fatalf("code=%v, want CONTENT_UNAVAILABLE", payload["code"])
		}
		st := p.TikTokRiskStatsSnapshot()
		if st.ContentNotFound != 1 || st.WAFBlocked != 0 {
			t.Fatalf("unexpected stats: %+v", st)
		}
	})

	t.Run("DeadShortlinkToHome", func(t *testing.T) {
		exec := &stubExecutor{
			fn: func(context.Context, fetch.Request, fetch.Policy) (fetch.Response, error) {
				h := make(http.Header)
				h.Set("Location", "https://www.tiktok.com/?_r=1")
				return fetch.Response{StatusCode: 302, Header: h}, nil
			},
		}
		p := New(exec)
		ctx, isCallerScoped := unified.WithCallerScopedFailureTracker(context.Background())
		payload, err := p.Parse(ctx, "https://vm.tiktok.com/ZM8deadlink/", now)
		if err != nil {
			t.Fatal(err)
		}
		if unified.Str(payload["code"]) != "CONTENT_UNAVAILABLE" {
			t.Fatalf("code=%v, want CONTENT_UNAVAILABLE", payload["code"])
		}
		if !isCallerScoped() {
			t.Fatalf("dead shortlink must mark callerScopedFailure")
		}
	})

	t.Run("ShortlinkCacheHitOnSecondParse", func(t *testing.T) {
		photoHTML := readFixture(t, "photo_post.html")
		var shortCalls atomic.Int32
		exec := &stubExecutor{
			fn: func(_ context.Context, req fetch.Request, policy fetch.Policy) (fetch.Response, error) {
				if policy.Purpose == "tiktok-shortlink" {
					shortCalls.Add(1)
					h := make(http.Header)
					h.Set("Location", "https://www.tiktok.com/@photo_artist/photo/7399999999999999999")
					return fetch.Response{StatusCode: 302, Header: h}, nil
				}
				return fetch.Response{StatusCode: 200, Body: photoHTML}, nil
			},
		}
		p := New(exec).WithClock(func() time.Time { return time.Unix(now, 0) })
		for i := 0; i < 2; i++ {
			payload, err := p.Parse(context.Background(), "https://vt.tiktok.com/ZS9cachehit/", now)
			if err != nil || unified.Str(payload["code"]) != "OK" {
				t.Fatalf("call %d failed: payload=%+v err=%v", i, payload, err)
			}
		}
		if shortCalls.Load() != 1 {
			t.Fatalf("expected shortlink LRU hit on 2nd call (1 shortlink fetch), got %d", shortCalls.Load())
		}
	})

	t.Run("RejectWebappPrimeAndPrivateIP302", func(t *testing.T) {
		videoHTML := readFixture(t, "video_post.html")
		var idx atomic.Int32
		badLocations := []string{
			"https://v16-webapp-prime.tiktok.com/video/tos/a.mp4",
			"https://v16-web-newkey.tiktokcdn.com/video/tos/b.mp4?tk=tt_chain_token",
			"https://10.0.0.1/video/tos/c.mp4",
			"https://evil.example/video/tos/d.mp4",
		}
		exec := &stubExecutor{
			fn: func(_ context.Context, _ fetch.Request, policy fetch.Policy) (fetch.Response, error) {
				if policy.Purpose == "tiktok-page" {
					return fetch.Response{StatusCode: 200, Body: videoHTML}, nil
				}
				i := int(idx.Add(1)-1) % len(badLocations)
				h := make(http.Header)
				h.Set("Location", badLocations[i])
				return fetch.Response{StatusCode: 302, Header: h}, nil
			},
		}
		p := New(exec)
		payload, err := p.Parse(context.Background(), "https://www.tiktok.com/@a/video/7345678901234567890", now)
		if err != nil {
			t.Fatal(err)
		}
		if unified.Str(payload["code"]) != "UPSTREAM_UNAVAILABLE" {
			t.Fatalf("code=%v, want UPSTREAM_UNAVAILABLE when all 302 targets are rejected", payload["code"])
		}
		st := p.TikTokRiskStatsSnapshot()
		if st.Play302OK != 0 || st.Play302Failed != 4 {
			t.Fatalf("expected Play302OK=0 Play302Failed=4, got %+v", st)
		}
	})

	t.Run("DirectRateLimitGuardrailAndProxyBypass", func(t *testing.T) {
		photoHTML := readFixture(t, "photo_post.html")
		exec := &stubExecutor{
			fn: func(context.Context, fetch.Request, fetch.Policy) (fetch.Response, error) {
				return fetch.Response{StatusCode: 200, Body: photoHTML}, nil
			},
		}
		fixedTime := time.Unix(now, 0)
		p := New(exec).WithClock(func() time.Time { return fixedTime })
		for i := 0; i < 6; i++ {
			payload, err := p.Parse(context.Background(), "https://www.tiktok.com/@a/photo/7399999999999999999", now)
			if err != nil || unified.Str(payload["code"]) != "OK" {
				t.Fatalf("burst call %d failed: %+v err=%v", i, payload, err)
			}
		}
		limited, err := p.Parse(context.Background(), "https://www.tiktok.com/@a/photo/7399999999999999999", now)
		if err != nil || unified.Str(limited["code"]) != "RATE_LIMITED" {
			t.Fatalf("7th burst call expected RATE_LIMITED, got %+v err=%v", limited, err)
		}

		// Proxy-configured mode bypasses single-IP direct bucket.
		p.WithProxyConfigured(true)
		bypassed, err := p.Parse(context.Background(), "https://www.tiktok.com/@a/photo/7399999999999999999", now)
		if err != nil || unified.Str(bypassed["code"]) != "OK" {
			t.Fatalf("proxy-configured mode should bypass direct bucket, got %+v err=%v", bypassed, err)
		}
	})
}
