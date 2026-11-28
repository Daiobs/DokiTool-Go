package fetch

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestTikTokPageDispatchBoundary(t *testing.T) {
	var standardHits, browserHits int
	standard := func(req *http.Request, ips []netip.Addr, policy Policy) (*http.Response, error) {
		standardHits++
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("std"))}, nil
	}
	browser := func(req *http.Request, ips []netip.Addr, policy Policy) (*http.Response, error) {
		browserHits++
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("chrome131"))}, nil
	}
	dispatch := tiktokPageDispatch(standard, browser)
	ips := []netip.Addr{netip.MustParseAddr("93.184.216.34")}
	basePolicy := Policy{
		Purpose:        "tiktok-page",
		AllowedURL:     AllowHosts("www.tiktok.com"),
		Timeout:        12 * time.Second,
		MaxBytes:       4 << 20,
		MaxHeaderBytes: maxPolicyHeaderBytes,
	}

	// Non-tiktok-page purposes fall back to standard transport.
	reqOther, _ := http.NewRequest(http.MethodGet, "https://www.tiktok.com/aweme/v1/play/?video_id=1", nil)
	p302 := basePolicy
	p302.Purpose = "tiktok-play-302"
	if _, err := dispatch(reqOther, ips, p302); err != nil || standardHits != 1 || browserHits != 0 {
		t.Fatalf("tiktok-play-302 must use standard transport: err=%v std=%d browser=%d", err, standardHits, browserHits)
	}

	// Valid anonymous tiktok-page routes to chrome131 transport.
	reqOK, _ := http.NewRequest(http.MethodGet, "https://www.tiktok.com/@i/video/7123456789012345678", nil)
	reqOK.Header.Set("User-Agent", tiktokChrome131UA)
	reqOK.Header.Set("Accept", "text/html")
	reqOK.Header.Set("Accept-Language", "en-US,en;q=0.9")
	reqOK.Header.Set("Accept-Encoding", "gzip, deflate")
	if _, err := dispatch(reqOK, ips, basePolicy); err != nil || browserHits != 1 {
		t.Fatalf("valid tiktok-page should hit chrome131 transport: err=%v browser=%d", err, browserHits)
	}

	// Cookie, Authorization, Range, non-HTTPS, foreign host, or FollowRedirects must be rejected with ErrPolicy.
	for _, tc := range []struct {
		name   string
		mutate func(*http.Request, *Policy)
	}{
		{"cookie", func(r *http.Request, _ *Policy) { r.Header.Set("Cookie", "sid=1") }},
		{"authorization", func(r *http.Request, _ *Policy) { r.Header.Set("Authorization", "Bearer x") }},
		{"range", func(r *http.Request, _ *Policy) { r.Header.Set("Range", "bytes=0-1") }},
		{"http", func(r *http.Request, _ *Policy) { r.URL, _ = url.Parse("http://www.tiktok.com/@i/video/1") }},
		{"foreign_host", func(r *http.Request, _ *Policy) { r.URL, _ = url.Parse("https://evil.example.com/@i/video/1") }},
		{"follow_redirects", func(_ *http.Request, p *Policy) { p.FollowRedirects = true }},
		{"excessive_timeout", func(_ *http.Request, p *Policy) { p.Timeout = 20 * time.Second }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _ := http.NewRequest(http.MethodGet, "https://www.tiktok.com/@i/video/7123456789012345678", nil)
			r.Header.Set("User-Agent", tiktokChrome131UA)
			p := basePolicy
			tc.mutate(r, &p)
			if _, err := dispatch(r, ips, p); !errors.Is(err, ErrPolicy) {
				t.Fatalf("expected ErrPolicy for %s, got %v", tc.name, err)
			}
		})
	}
}

func TestTikTokProxyDispatchRoutesOnlyTikTokPageToBrowser(t *testing.T) {
	var stdHits, browserHits int
	dispatch := tiktokProxyDispatch(
		func(req *http.Request, proxyURL *url.URL, policy Policy) (*http.Response, error) {
			stdHits++
			return &http.Response{StatusCode: 302, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(""))}, nil
		},
		func(req *http.Request, proxyURL *url.URL, policy Policy) (*http.Response, error) {
			browserHits++
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("ok"))}, nil
		},
	)
	proxyURL, _ := url.Parse("http://user:pass@gw.proxy.example:8080")
	pPage := Policy{
		Purpose:        "tiktok-page",
		AllowedURL:     AllowHosts("www.tiktok.com"),
		Timeout:        12 * time.Second,
		MaxBytes:       4 << 20,
		MaxHeaderBytes: maxPolicyHeaderBytes,
	}
	reqPage, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "https://www.tiktok.com/@i/video/7123456789012345678", nil)
	if _, err := dispatch(reqPage, proxyURL, pPage); err != nil || browserHits != 1 || stdHits != 0 {
		t.Fatalf("tiktok-page proxy should use chrome131 proxy transport: err=%v browser=%d std=%d", err, browserHits, stdHits)
	}

	pShort := pPage
	pShort.Purpose = "tiktok-shortlink"
	reqShort, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "https://vm.tiktok.com/ZMTest/", nil)
	if _, err := dispatch(reqShort, proxyURL, pShort); err != nil || stdHits != 1 || browserHits != 1 {
		t.Fatalf("tiktok-shortlink proxy should use standard proxy transport: err=%v std=%d browser=%d", err, stdHits, browserHits)
	}
}
