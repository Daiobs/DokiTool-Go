package fetch

import (
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestEnvPlatformProxyProviderScopeAndValidation(t *testing.T) {
	empty, err := NewEnvPlatformProxyProvider("")
	if err != nil || empty.Configured() {
		t.Fatalf("empty env should produce unconfigured provider, got err=%v configured=%v", err, empty.Configured())
	}
	if u, err := empty.ProxyFor(context.Background(), "tiktok", "tiktok-page"); err != nil || u != nil {
		t.Fatalf("unconfigured provider must return (nil, nil), got (%v, %v)", u, err)
	}

	for _, bad := range []string{
		"ftp://proxy.example.com:8080",
		"http://",
		"socks4://proxy.example.com:1080",
		"http://user:pass@proxy.example.com:8080#frag",
		"http://user:pass@proxy.example.com:8080\r\n",
	} {
		if _, err := NewEnvPlatformProxyProvider(bad); err == nil {
			t.Fatalf("expected invalid proxy URL %q to be rejected", bad)
		}
	}

	prov, err := NewEnvPlatformProxyProvider("http://secretuser:s3cr3t%21pass@gw.resi-proxy.example:18080")
	if err != nil || !prov.Configured() {
		t.Fatalf("valid proxy URL failed: err=%v configured=%v", err, prov.Configured())
	}

	// Only tiktok + tiktok-page / tiktok-shortlink may use the proxy.
	for _, purpose := range []string{"tiktok-page", "tiktok-shortlink"} {
		got, err := prov.ProxyFor(context.Background(), "tiktok", purpose)
		if err != nil || got == nil || got.Hostname() != "gw.resi-proxy.example" {
			t.Fatalf("expected proxy for tiktok/%s, got (%v, %v)", purpose, got, err)
		}
		// Mutating returned URL must not corrupt provider state.
		got.Host = "tampered.example"
	}
	again, _ := prov.ProxyFor(context.Background(), "tiktok", "tiktok-page")
	if again == nil || again.Hostname() != "gw.resi-proxy.example" {
		t.Fatalf("provider state mutated by caller: %v", again)
	}

	// Non-target purposes (including tiktok-play-302) and all other platforms MUST stay direct.
	for _, tc := range []struct{ platform, purpose string }{
		{"tiktok", "tiktok-play-302"},
		{"tiktok", "media"},
		{"pinterest", "pinterest-page"},
		{"douyin", "tiktok-page"},
		{"weibo", "weibo-media"},
		{"", "tiktok-page"},
	} {
		got, err := prov.ProxyFor(context.Background(), tc.platform, tc.purpose)
		if err != nil || got != nil {
			t.Fatalf("expected direct (nil, nil) for %s/%s, got (%v, %v)", tc.platform, tc.purpose, got, err)
		}
	}
}

func TestProxyProviderErrorRedactsCredentialsAndHost(t *testing.T) {
	const (
		proxyUser = "alice_proxy_user"
		proxyPass = "TopSecret#99!Pass"
		proxyHost = "secret-gw-01.resi.example"
	)
	proxyRaw := "http://" + url.UserPassword(proxyUser, proxyPass).String() + "@" + proxyHost + ":29999"
	prov, err := NewEnvPlatformProxyProvider(proxyRaw)
	if err != nil {
		t.Fatal(err)
	}

	client := New().WithProxyProvider(prov)
	client.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return nil, errors.New("connect failed to " + proxyRaw + " (" + addr + ") user=" + proxyUser + " pass=" + proxyPass)
	}

	_, reqErr := client.Do(context.Background(), Request{
		Method: http.MethodGet,
		URL:    "https://www.tiktok.com/@i/video/7123456789012345678",
		Policy: Policy{
			Purpose:         "tiktok-page",
			AllowedURL:      AllowHosts("www.tiktok.com"),
			Timeout:         5 * time.Second,
			MaxBytes:        1 << 20,
			FollowRedirects: false,
		},
	})
	if reqErr == nil {
		t.Fatal("expected error from failing proxy dial")
	}
	msg := reqErr.Error()
	for _, leaked := range []string{proxyUser, proxyPass, url.QueryEscape(proxyPass), proxyHost, "secret-gw-01"} {
		if strings.Contains(msg, leaked) {
			t.Fatalf("proxy error leaked sensitive token %q in: %s", leaked, msg)
		}
	}
}

func TestProxyModeRejectsIPLiteralInternalHostAndDirectPurposesStayDirect(t *testing.T) {
	prov, err := NewEnvPlatformProxyProvider("http://user:pass@gw.proxy.example:8080")
	if err != nil {
		t.Fatal(err)
	}

	var proxyCalled, directCalled int
	client := NewWithResolver(staticResolver{ips: []netip.Addr{netip.MustParseAddr("93.184.216.34")}}).WithProxyProvider(prov)
	client.proxyTransport = func(req *http.Request, proxyURL *url.URL, policy Policy) (*http.Response, error) {
		proxyCalled++
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("ok-via-proxy")),
		}, nil
	}
	client.transport = func(req *http.Request, ips []netip.Addr, policy Policy) (*http.Response, error) {
		directCalled++
		return &http.Response{
			StatusCode: http.StatusFound,
			Header:     http.Header{"Location": {"https://v16-web-newkey.tiktokcdn.com/video.mp4"}},
			Body:       io.NopCloser(strings.NewReader("")),
		}, nil
	}

	// 1. tiktok-page routes through proxy
	resp, err := client.Do(context.Background(), Request{
		Method: http.MethodGet,
		URL:    "https://www.tiktok.com/@i/video/7123456789012345678",
		Policy: Policy{
			Purpose:         "tiktok-page",
			AllowedURL:      AllowHosts("www.tiktok.com"),
			Timeout:         5 * time.Second,
			MaxBytes:        64 << 10,
			FollowRedirects: false,
		},
	})
	if err != nil || string(resp.Body) != "ok-via-proxy" || proxyCalled != 1 || directCalled != 0 {
		t.Fatalf("tiktok-page should use proxy: err=%v body=%q proxy=%d direct=%d", err, resp.Body, proxyCalled, directCalled)
	}

	// 2. tiktok-play-302 MUST bypass proxy and run directly
	_, err = client.Do(context.Background(), Request{
		Method: http.MethodGet,
		URL:    "https://www.tiktok.com/aweme/v1/play/?video_id=abc",
		Policy: Policy{
			Purpose:         "tiktok-play-302",
			AllowedURL:      AllowHosts("www.tiktok.com"),
			Timeout:         5 * time.Second,
			MaxBytes:        64 << 10,
			FollowRedirects: false,
		},
	})
	if err != nil || proxyCalled != 1 || directCalled != 1 {
		t.Fatalf("tiktok-play-302 must bypass proxy: err=%v proxy=%d direct=%d", err, proxyCalled, directCalled)
	}

	// 3. IP literals and internal hosts are rejected even if AllowedURL permits them
	for _, blocked := range []string{
		"https://127.0.0.1/admin",
		"https://169.254.169.254/latest/meta-data/",
		"https://metadata.internal/secret",
		"https://intranet.local/page",
	} {
		_, err := client.Do(context.Background(), Request{
			Method: http.MethodGet,
			URL:    blocked,
			Policy: Policy{
				Platform:        "tiktok",
				Purpose:         "tiktok-page",
				AllowedURL:      func(string) bool { return true },
				Timeout:         5 * time.Second,
				MaxBytes:        64 << 10,
				FollowRedirects: false,
			},
		})
		if !errors.Is(err, ErrPolicy) {
			t.Fatalf("expected ErrPolicy for %s in proxy mode, got %v", blocked, err)
		}
	}
	if proxyCalled != 1 {
		t.Fatalf("blocked SSRF targets reached proxy transport: proxyCalled=%d", proxyCalled)
	}
}

type staticResolver struct {
	ips []netip.Addr
}

func (r staticResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return r.ips, nil
}

func TestStandardHTTPSProxyConnectVerifiesOuterTLSCert(t *testing.T) {
	var connectSeen atomic.Int32
	var seenHost atomic.Value
	proxySrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			connectSeen.Add(1)
			seenHost.Store(r.Host)
			http.Error(w, "connect-reached", http.StatusBadGateway)
			return
		}
		http.Error(w, "unexpected method", http.StatusMethodNotAllowed)
	}))
	defer proxySrv.Close()

	_, proxyPort, err := net.SplitHostPort(proxySrv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	// httptest.NewTLSServer generates a certificate whose SAN includes "example.com"
	// (distinct from the target "www.tiktok.com"), verifying outer TLS checks proxy host
	// instead of overriding ServerName with req.URL.Hostname().
	prov, err := NewEnvPlatformProxyProvider("https://example.com:" + proxyPort)
	if err != nil {
		t.Fatal(err)
	}

	rootPool := x509.NewCertPool()
	rootPool.AddCert(proxySrv.Certificate())

	client := New().WithProxyProvider(prov)
	client.tlsRootCAs = rootPool
	client.dial = func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, proxySrv.Listener.Addr().String())
	}

	_, reqErr := client.Do(context.Background(), Request{
		Method: http.MethodGet,
		URL:    "https://www.tiktok.com/@i/video/7123456789012345678",
		Policy: Policy{
			Platform:        "tiktok",
			Purpose:         "tiktok-page",
			AllowedURL:      AllowHosts("www.tiktok.com"),
			Timeout:         5 * time.Second,
			MaxBytes:        64 << 10,
			FollowRedirects: false,
		},
	})
	if reqErr == nil {
		t.Fatal("expected error after proxy returned 502 on CONNECT")
	}
	if connectSeen.Load() != 1 {
		t.Fatalf("expected outer HTTPS proxy TLS handshake to succeed and reach CONNECT once, got %d (err=%v)", connectSeen.Load(), reqErr)
	}
	if gotHost, _ := seenHost.Load().(string); gotHost != "www.tiktok.com:443" {
		t.Fatalf("CONNECT target = %q, want www.tiktok.com:443", gotHost)
	}

	// Untrusted proxy certificate must still be rejected before reaching CONNECT.
	untrustedClient := New().WithProxyProvider(prov)
	untrustedClient.tlsRootCAs = x509.NewCertPool()
	untrustedClient.dial = client.dial
	_, untrustedErr := untrustedClient.Do(context.Background(), Request{
		Method: http.MethodGet,
		URL:    "https://www.tiktok.com/@i/video/7123456789012345678",
		Policy: Policy{
			Platform:        "tiktok",
			Purpose:         "tiktok-page",
			AllowedURL:      AllowHosts("www.tiktok.com"),
			Timeout:         5 * time.Second,
			MaxBytes:        64 << 10,
			FollowRedirects: false,
		},
	})
	if untrustedErr == nil {
		t.Fatal("expected TLS verification failure for untrusted proxy cert")
	}
	if connectSeen.Load() != 1 {
		t.Fatalf("untrusted proxy cert should fail before CONNECT, connectSeen=%d", connectSeen.Load())
	}
}
