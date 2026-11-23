package fetch

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type resolverFunc func(context.Context, string, string) ([]netip.Addr, error)

func (f resolverFunc) LookupNetIP(ctx context.Context, network, name string) ([]netip.Addr, error) {
	return f(ctx, network, name)
}

func fixtureClient(send roundTrip) *Client {
	return &Client{resolver: resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}), transport: send}
}
func testPolicy() Policy {
	return Policy{Purpose: "test-metadata", AllowedURL: AllowHosts("api.example.test", "cdn.example.test"), Timeout: time.Second, MaxBytes: 100, FollowRedirects: true, MaxRedirects: 2}
}
func reply(status int, headers http.Header, value string) *http.Response {
	return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(value))}
}

func TestPublicAddressBoundary(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.1.1", "192.0.2.1", "198.18.0.1", "203.0.113.1", "224.0.0.1", "::1", "::ffff:8.8.8.8", "2001:db8::1", "2002:0808:0808::", "3fff::1", "fd00::1"} {
		if PublicIP(netip.MustParseAddr(raw)) {
			t.Errorf("accepted reserved %s", raw)
		}
	}
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !PublicIP(netip.MustParseAddr(raw)) {
			t.Errorf("rejected public %s", raw)
		}
	}
}

func TestRejectMixedDNSBeforeTransport(t *testing.T) {
	called := false
	c := fixtureClient(func(*http.Request, []netip.Addr, Policy) (*http.Response, error) {
		called = true
		return reply(200, nil, "{}"), nil
	})
	c.resolver = resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}, nil
	})
	_, err := c.Do(context.Background(), Request{URL: "https://api.example.test/detail", Policy: testPolicy()})
	if !errors.Is(err, ErrPolicy) || called {
		t.Fatalf("mixed DNS escaped policy: %v called=%v", err, called)
	}
}

func TestRedirectChecksAndQueryPreservation(t *testing.T) {
	var calls []string
	c := fixtureClient(func(req *http.Request, ips []netip.Addr, policy Policy) (*http.Response, error) {
		calls = append(calls, req.URL.String())
		if len(ips) != 1 || ips[0].String() != "8.8.8.8" {
			t.Fatal("lost pinned target")
		}
		if len(calls) == 1 {
			return reply(302, http.Header{"Location": {"https://cdn.example.test/item?a=1%2F2&a=3+4"}}, "ignored"), nil
		}
		if req.Header.Get("Cookie") != "" || req.Header.Get("Authorization") != "" {
			t.Fatal("credentials followed cross-host redirect")
		}
		return reply(200, nil, "ok"), nil
	})
	result, err := c.Do(context.Background(), Request{URL: "https://api.example.test/start", Header: http.Header{"Cookie": {"test=1"}, "Authorization": {"test"}}, Policy: testPolicy()})
	if err != nil || result.URL != "https://cdn.example.test/item?a=1%2F2&a=3+4" || len(result.History) != 1 || string(result.Body) != "ok" {
		t.Fatalf("redirect changed transport data: %+v %v", result, err)
	}

	calls = nil
	c.transport = func(req *http.Request, _ []netip.Addr, _ Policy) (*http.Response, error) {
		calls = append(calls, req.URL.String())
		return reply(302, http.Header{"Location": {"https://evil.example/"}}, ""), nil
	}
	_, err = c.Do(context.Background(), Request{URL: "https://api.example.test/start", Policy: testPolicy()})
	if !errors.Is(err, ErrPolicy) || len(calls) != 1 {
		t.Fatalf("redirect bypassed target policy: %v %v", calls, err)
	}
}

func TestRedirectRewriteAppliesBeforePolicyAndDNS(t *testing.T) {
	var calls []string
	c := fixtureClient(func(req *http.Request, _ []netip.Addr, _ Policy) (*http.Response, error) {
		calls = append(calls, req.Method+" "+req.URL.String())
		if len(calls) == 1 {
			return reply(302, http.Header{"Location": {"https://blocked.example.test/fw/photo/3xngkmw8vacriqu?x=y"}}, ""), nil
		}
		if req.Header.Get("Cookie") != "" || req.Header.Get("Authorization") != "" {
			t.Fatal("credentials followed rewritten cross-host redirect")
		}
		return reply(200, nil, "ok"), nil
	})
	c.resolver = resolverFunc(func(_ context.Context, _, host string) ([]netip.Addr, error) {
		if host == "blocked.example.test" {
			t.Fatal("DNS lookup attempted for rewritten redirect host")
		}
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	})
	p := testPolicy()
	p.RewriteRedirect = func(raw string) string {
		if strings.HasPrefix(raw, "https://blocked.example.test/fw/photo/") {
			return "https://cdn.example.test/fw/photo/3xngkmw8vacriqu"
		}
		return raw
	}
	result, err := c.Do(context.Background(), Request{
		URL:    "https://api.example.test/start",
		Method: http.MethodHead,
		Header: http.Header{"Cookie": {"test=1"}, "Authorization": {"Bearer secret"}},
		Policy: p,
	})
	if err != nil || result.URL != "https://cdn.example.test/fw/photo/3xngkmw8vacriqu" || len(calls) != 2 || calls[1] != "HEAD https://cdn.example.test/fw/photo/3xngkmw8vacriqu" {
		t.Fatalf("rewritten redirect failed: calls=%v result=%+v err=%v", calls, result, err)
	}

	calls = nil
	c.transport = func(req *http.Request, _ []netip.Addr, _ Policy) (*http.Response, error) {
		calls = append(calls, req.URL.String())
		return reply(302, http.Header{"Location": {"https://blocked.example.test/private/path?x=y"}}, ""), nil
	}
	_, err = c.Do(context.Background(), Request{URL: "https://api.example.test/start", Method: http.MethodHead, Policy: p})
	if !errors.Is(err, ErrPolicy) || len(calls) != 1 {
		t.Fatalf("unmatched redirect host escaped policy: calls=%v err=%v", calls, err)
	}
}

func TestRedirectBudgetAndNoFollow(t *testing.T) {
	calls := 0
	c := fixtureClient(func(*http.Request, []netip.Addr, Policy) (*http.Response, error) {
		calls++
		return reply(302, http.Header{"Location": {"/loop"}}, ""), nil
	})
	_, err := c.Do(context.Background(), Request{URL: "https://api.example.test/start", Policy: testPolicy()})
	if !errors.Is(err, ErrRedirect) || calls != 3 {
		t.Fatalf("redirect budget %d %v", calls, err)
	}
	p := testPolicy()
	p.FollowRedirects = false
	out, err := c.Do(context.Background(), Request{URL: "https://api.example.test/start", Policy: p})
	if err != nil || out.StatusCode != 302 || len(out.Body) != 0 {
		t.Fatalf("single-hop response %+v %v", out, err)
	}
}

func TestDecodedAndWireLimits(t *testing.T) {
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	_, _ = gz.Write(bytes.Repeat([]byte("x"), 101))
	_ = gz.Close()
	if _, err := readBody(bytes.NewReader(compressed.Bytes()), "gzip", 100); !errors.Is(err, ErrLimit) {
		t.Fatalf("decoded limit %v", err)
	}
	if _, err := readBody(strings.NewReader(strings.Repeat("x", 101)), "identity", 100); !errors.Is(err, ErrLimit) {
		t.Fatalf("wire limit %v", err)
	}
	if value, err := readBody(strings.NewReader("complete"), "identity", 100); err != nil || string(value) != "complete" {
		t.Fatal("bounded complete body rejected")
	}
}

func TestRequestDeadlineCoversDNS(t *testing.T) {
	c := fixtureClient(func(*http.Request, []netip.Addr, Policy) (*http.Response, error) {
		t.Fatal("transport called after cancelled DNS")
		return nil, nil
	})
	c.resolver = resolverFunc(func(ctx context.Context, _, _ string) ([]netip.Addr, error) { <-ctx.Done(); return nil, ctx.Err() })
	p := testPolicy()
	p.Timeout = 10 * time.Millisecond
	_, err := c.Do(context.Background(), Request{URL: "https://api.example.test/detail", Policy: p})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline lost: %v", err)
	}
}

type unreadableMedia struct{ read bool }

func (b *unreadableMedia) Read([]byte) (int, error) { b.read = true; return 0, io.EOF }
func (b *unreadableMedia) Close() error             { return nil }

func TestPartialMediaOnlyRejectsWholeFileBeforeReading(t *testing.T) {
	for _, tc := range []struct {
		code int
		span string
	}{{200, ""}, {206, "bytes 0-9/10"}, {206, "bytes 4-15/10"}, {206, "malformed"}} {
		body := new(unreadableMedia)
		c := fixtureClient(func(*http.Request, []netip.Addr, Policy) (*http.Response, error) {
			return &http.Response{StatusCode: tc.code, Header: http.Header{"Content-Range": {tc.span}}, Body: body}, nil
		})
		p := testPolicy()
		p.PartialMediaOnly = true
		_, err := c.Do(context.Background(), Request{URL: "https://api.example.test/video", Policy: p})
		if !errors.Is(err, ErrPolicy) || body.read {
			t.Fatalf("%d %q err=%v body read=%v", tc.code, tc.span, err, body.read)
		}
	}
}

type poolConnStats struct {
	stateNew    atomic.Int32
	stateIdle   atomic.Int32
	stateClosed atomic.Int32
}

func newPoolTestServer(t *testing.T, useTLS bool, names []string, handler http.Handler) (*httptest.Server, *x509.CertPool, *poolConnStats) {
	t.Helper()
	stats := &poolConnStats{}
	server := httptest.NewUnstartedServer(handler)
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		switch state {
		case http.StateNew:
			stats.stateNew.Add(1)
		case http.StateIdle:
			stats.stateIdle.Add(1)
		case http.StateClosed:
			stats.stateClosed.Add(1)
		}
	}
	if !useTLS {
		server.Start()
		t.Cleanup(server.Close)
		return server, nil, stats
	}
	if len(names) == 0 {
		names = []string{"api.example.test", "cdn.example.test", "example.com"}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "DokiTool keepalive pool test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		DNSNames:              names,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	server.TLS = &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
		MinVersion:   tls.VersionTLS12,
	}
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	return server, roots, stats
}

func TestKeepAlivePoolReusesSingleConnection(t *testing.T) {
	for _, useTLS := range []bool{false, true} {
		scheme := "http"
		expectedPort := "80"
		if useTLS {
			scheme = "https"
			expectedPort = "443"
		}
		t.Run(scheme, func(t *testing.T) {
			var reqCount atomic.Int32
			srv, roots, stats := newPoolTestServer(t, useTLS, []string{"api.example.test", "cdn.example.test"}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := reqCount.Add(1)
				if useTLS && (r.TLS == nil || (r.TLS.ServerName != "api.example.test" && r.TLS.ServerName != "cdn.example.test")) {
					t.Errorf("unexpected TLS SNI: %+v", r.TLS)
				}
				if wantMajor := map[bool]int{false: 1, true: 2}[useTLS]; r.ProtoMajor != wantMajor {
					t.Errorf("expected HTTP/%d pooled transport, got %s", wantMajor, r.Proto)
				}
				if r.Method == http.MethodHead {
					w.WriteHeader(http.StatusOK)
					return
				}
				_, _ = fmt.Fprintf(w, "resp-%d", n)
			}))

			var lookups, dials atomic.Int32
			c := NewWithResolver(resolverFunc(func(_ context.Context, _, _ string) ([]netip.Addr, error) {
				lookups.Add(1)
				return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
			}))
			t.Cleanup(c.CloseIdleConnections)
			c.tlsRootCAs = roots
			c.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
				if network != "tcp" || addr != "93.184.216.34:"+expectedPort {
					return nil, fmt.Errorf("unexpected dial %s %s", network, addr)
				}
				dials.Add(1)
				return (&net.Dialer{}).DialContext(ctx, "tcp", srv.Listener.Addr().String())
			}

			policy := testPolicy()
			requests := []Request{
				{URL: scheme + "://api.example.test/one", Method: http.MethodGet, Policy: policy},
				{URL: scheme + "://API.Example.Test/two", Method: http.MethodPost, Body: []byte(`{"ok":true}`), Policy: policy},
				{URL: scheme + "://api.example.test/three", Method: http.MethodHead, Policy: policy},
				{URL: scheme + "://api.example.test/four", Method: http.MethodGet, Policy: policy},
			}
			for i, req := range requests {
				res, err := c.Do(context.Background(), req)
				if err != nil || res.StatusCode != http.StatusOK {
					t.Fatalf("call %d failed: status=%d err=%v", i+1, res.StatusCode, err)
				}
			}
			if lookups.Load() != 4 {
				t.Fatalf("expected per-request DNS resolution (4 lookups), got %d", lookups.Load())
			}
			if stats.stateNew.Load() != 1 || dials.Load() != 1 {
				t.Fatalf("expected 1 pooled TCP connection across 4 calls, got StateNew=%d dials=%d", stats.stateNew.Load(), dials.Load())
			}

			// Different hostname resolving to the exact same IP must not coalesce onto api.example.test's socket.
			res, err := c.Do(context.Background(), Request{URL: scheme + "://cdn.example.test/asset", Policy: policy})
			if err != nil || res.StatusCode != http.StatusOK {
				t.Fatalf("cdn request failed: status=%d err=%v", res.StatusCode, err)
			}
			if stats.stateNew.Load() != 2 || dials.Load() != 2 {
				t.Fatalf("expected separate socket for distinct host, got StateNew=%d dials=%d", stats.stateNew.Load(), dials.Load())
			}
		})
	}
}

func TestKeepAlivePoolDNSRebindingAndIPChangeIsolation(t *testing.T) {
	var reqsA, reqsB atomic.Int32
	srvA, rootsA, statsA := newPoolTestServer(t, true, []string{"example.com"}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqsA.Add(1)
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "https://example.com/landed", http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, "from-ip-A")
	}))
	srvB, rootsB, statsB := newPoolTestServer(t, true, []string{"example.com"}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reqsB.Add(1)
		_, _ = io.WriteString(w, "from-ip-B")
	}))

	combinedRoots := x509.NewCertPool()
	combinedRoots.AddCert(srvA.Certificate())
	combinedRoots.AddCert(srvB.Certificate())
	_ = rootsA
	_ = rootsB

	var mu sync.Mutex
	currentIPs := []netip.Addr{netip.MustParseAddr("93.184.216.34")}
	var rebindOnSecondHop bool
	var hopLookups int

	var dialsA, dialsB, unexpectedDials atomic.Int32
	c := NewWithResolver(resolverFunc(func(_ context.Context, _, host string) ([]netip.Addr, error) {
		if host != "example.com" {
			return nil, fmt.Errorf("unexpected host %q", host)
		}
		mu.Lock()
		defer mu.Unlock()
		hopLookups++
		if rebindOnSecondHop && hopLookups == 2 {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		}
		return append([]netip.Addr(nil), currentIPs...), nil
	}))
	t.Cleanup(c.CloseIdleConnections)
	c.tlsRootCAs = combinedRoots
	c.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		switch addr {
		case "93.184.216.34:443":
			dialsA.Add(1)
			return (&net.Dialer{}).DialContext(ctx, network, srvA.Listener.Addr().String())
		case "1.1.1.1:443":
			dialsB.Add(1)
			return (&net.Dialer{}).DialContext(ctx, network, srvB.Listener.Addr().String())
		case "93.184.216.99:443":
			return nil, errors.New("synthetic unreachable public IP")
		default:
			unexpectedDials.Add(1)
			return nil, fmt.Errorf("unexpected dial target %s", addr)
		}
	}

	policy := Policy{
		Purpose:         "test-rebinding",
		AllowedURL:      AllowHosts("example.com"),
		Timeout:         2 * time.Second,
		MaxBytes:        1024,
		FollowRedirects: true,
		MaxRedirects:    2,
	}

	// 1. Seed Keep-Alive pool with example.com -> 93.184.216.34.
	res1, err := c.Do(context.Background(), Request{URL: "https://example.com/init", Policy: policy})
	if err != nil || string(res1.Body) != "from-ip-A" || dialsA.Load() != 1 || reqsA.Load() != 1 || statsA.stateNew.Load() != 1 {
		t.Fatalf("initial pooled call failed: body=%q err=%v dialsA=%d reqsA=%d", string(res1.Body), err, dialsA.Load(), reqsA.Load())
	}

	// 2. Rebind example.com -> 127.0.0.1 (and mixed public+private, and IPv6 loopback):
	//    must reject with ErrPolicy BEFORE touching the pooled 93.184.216.34 socket.
	for _, rebound := range [][]netip.Addr{
		{netip.MustParseAddr("127.0.0.1")},
		{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("127.0.0.1")},
		{netip.MustParseAddr("::1")},
	} {
		mu.Lock()
		currentIPs = rebound
		mu.Unlock()
		if _, err := c.Do(context.Background(), Request{URL: "https://example.com/rebound", Policy: policy}); !errors.Is(err, ErrPolicy) {
			t.Fatalf("expected ErrPolicy on rebound %v, got %v", rebound, err)
		}
		if reqsA.Load() != 1 || dialsA.Load() != 1 || unexpectedDials.Load() != 0 {
			t.Fatalf("DNS rebinding touched pooled socket or dialed: reqsA=%d dialsA=%d unexpected=%d",
				reqsA.Load(), dialsA.Load(), unexpectedDials.Load())
		}
	}

	// 3. Rebind on redirect hop 2 (hop 1 uses pooled 93.184.216.34 -> 302, hop 2 resolves to 127.0.0.1).
	mu.Lock()
	currentIPs = []netip.Addr{netip.MustParseAddr("93.184.216.34")}
	rebindOnSecondHop = true
	hopLookups = 0
	mu.Unlock()
	if _, err := c.Do(context.Background(), Request{URL: "https://example.com/redirect", Policy: policy}); !errors.Is(err, ErrPolicy) {
		t.Fatalf("expected ErrPolicy on redirect hop rebinding, got %v", err)
	}
	if reqsA.Load() != 2 || statsA.stateNew.Load() != 1 || unexpectedDials.Load() != 0 {
		t.Fatalf("redirect hop 1 should reuse pool and hop 2 should reject before socket: reqsA=%d StateNewA=%d unexpected=%d",
			reqsA.Load(), statsA.stateNew.Load(), unexpectedDials.Load())
	}

	// 4. DNS rotates to a different public IP (example.com -> 1.1.1.1): must dial 1.1.1.1, NOT reuse 93.184.216.34.
	mu.Lock()
	rebindOnSecondHop = false
	currentIPs = []netip.Addr{netip.MustParseAddr("1.1.1.1")}
	mu.Unlock()
	for i := range 2 {
		resB, err := c.Do(context.Background(), Request{URL: "https://example.com/rotated", Policy: policy})
		if err != nil || string(resB.Body) != "from-ip-B" {
			t.Fatalf("rotated public IP call %d failed: body=%q err=%v", i+1, string(resB.Body), err)
		}
	}
	if reqsA.Load() != 2 || dialsB.Load() != 1 || reqsB.Load() != 2 || statsB.stateNew.Load() != 1 {
		t.Fatalf("expected 1 dial and 2 requests to new public IP without touching old IP: reqsA=%d dialsB=%d reqsB=%d StateNewB=%d",
			reqsA.Load(), dialsB.Load(), reqsB.Load(), statsB.stateNew.Load())
	}

	// 5. Multi-IP dial fallback ([unreachable public IP, 1.1.1.1]) falls back cleanly to 1.1.1.1's pooled transport.
	mu.Lock()
	currentIPs = []netip.Addr{netip.MustParseAddr("93.184.216.99"), netip.MustParseAddr("1.1.1.1")}
	mu.Unlock()
	resFallback, err := c.Do(context.Background(), Request{URL: "https://example.com/fallback", Method: http.MethodPost, Body: []byte("payload"), Policy: policy})
	if err != nil || string(resFallback.Body) != "from-ip-B" || dialsB.Load() != 1 || reqsB.Load() != 3 {
		t.Fatalf("multi-IP fallback failed: body=%q err=%v dialsB=%d reqsB=%d", string(resFallback.Body), err, dialsB.Load(), reqsB.Load())
	}
}

func TestKeepAlivePoolMidBodyCancellationAbortsPromptlyAndRecovers(t *testing.T) {
	for _, useTLS := range []bool{false, true} {
		scheme := "http"
		expectedPort := "80"
		if useTLS {
			scheme = "https"
			expectedPort = "443"
		}
		t.Run(scheme, func(t *testing.T) {
			flushed := make(chan struct{})
			serverSawDisconnect := make(chan struct{})
			srv, roots, stats := newPoolTestServer(t, useTLS, []string{"api.example.test"}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/stall" {
					w.Header().Set("Content-Length", "512")
					w.WriteHeader(http.StatusOK)
					_, _ = io.WriteString(w, "partial-bytes")
					w.(http.Flusher).Flush()
					close(flushed)
					<-r.Context().Done()
					close(serverSawDisconnect)
					return
				}
				_, _ = io.WriteString(w, "healthy")
			}))

			c := NewWithResolver(resolverFunc(func(_ context.Context, _, _ string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
			}))
			t.Cleanup(c.CloseIdleConnections)
			c.tlsRootCAs = roots
			c.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
				if addr != "93.184.216.34:"+expectedPort {
					return nil, fmt.Errorf("unexpected dial %s", addr)
				}
				return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
			}

			policy := testPolicy()
			policy.Timeout = 5 * time.Second
			policy.MaxBytes = 4096

			// Warm up pooled socket.
			if res, err := c.Do(context.Background(), Request{URL: scheme + "://api.example.test/ok", Policy: policy}); err != nil || string(res.Body) != "healthy" {
				t.Fatalf("warmup failed: %+v %v", res, err)
			}
			if stats.stateNew.Load() != 1 {
				t.Fatalf("expected StateNew=1 after warmup, got %d", stats.stateNew.Load())
			}

			// Start mid-body stalling request and cancel while Do is reading resp.Body.
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				_, err := c.Do(ctx, Request{URL: scheme + "://api.example.test/stall", Policy: policy})
				done <- err
			}()

			select {
			case <-flushed:
			case <-time.After(2 * time.Second):
				t.Fatal("server never flushed partial body")
			}
			// Give the client reader a brief moment to enter readBody on the flushed bytes.
			time.Sleep(15 * time.Millisecond)

			cancelStart := time.Now()
			cancel()
			select {
			case err := <-done:
				elapsed := time.Since(cancelStart)
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("expected context.Canceled on mid-body abort, got %v", err)
				}
				if elapsed >= 200*time.Millisecond {
					t.Fatalf("mid-body cancellation took %v (want < 200ms)", elapsed)
				}
			case <-time.After(200 * time.Millisecond):
				t.Fatal("Do() did not abort within 200ms after mid-body cancellation")
			}

			select {
			case <-serverSawDisconnect:
			case <-time.After(time.Second):
				t.Fatal("cancelled mid-body socket stayed open on server")
			}

			// Subsequent requests must dial a clean new connection and resume pooling cleanly.
			for i := range 2 {
				res, err := c.Do(context.Background(), Request{URL: scheme + "://api.example.test/ok", Policy: policy})
				if err != nil || string(res.Body) != "healthy" {
					t.Fatalf("post-cancel recovery call %d failed: %+v %v", i+1, res, err)
				}
			}
			// HTTP/1.1 must drop the poisoned socket and dial once more; h2 only
			// resets the cancelled stream and keeps multiplexing the same socket.
			wantNew := int32(2)
			if useTLS {
				wantNew = 1
			}
			if got := stats.stateNew.Load(); got != wantNew {
				t.Fatalf("expected StateNew=%d after post-cancel recovery, got %d", wantNew, got)
			}
		})
	}
}

func TestStrictMediaHeadersRemainsIsolatedFromKeepAlivePool(t *testing.T) {
	srv, roots, stats := newPoolTestServer(t, true, []string{"api.example.test"}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/dup-cl" {
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Error("hijacking unsupported")
				return
			}
			conn, buf, err := hj.Hijack()
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = buf.WriteString("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-2/10\r\nContent-Length: 3\r\nContent-Length: 3\r\nContent-Type: video/mp4\r\n\r\nabc")
			_ = buf.Flush()
			return
		}
		w.Header().Set("Content-Range", "bytes 0-2/10")
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, "abc")
	}))

	var dials atomic.Int32
	c := NewWithResolver(resolverFunc(func(_ context.Context, _, _ string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
	}))
	t.Cleanup(c.CloseIdleConnections)
	c.tlsRootCAs = roots
	c.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if addr != "93.184.216.34:443" {
			return nil, fmt.Errorf("unexpected dial %s", addr)
		}
		dials.Add(1)
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}

	normalPolicy := testPolicy()
	for i := range 2 {
		if _, err := c.Do(context.Background(), Request{URL: "https://api.example.test/meta", Policy: normalPolicy}); err != nil {
			t.Fatalf("normal call %d failed: %v", i+1, err)
		}
	}
	if dials.Load() != 1 || stats.stateNew.Load() != 1 {
		t.Fatalf("expected normal calls to share 1 pooled socket, got dials=%d StateNew=%d", dials.Load(), stats.stateNew.Load())
	}

	strictPolicy := testPolicy()
	strictPolicy.StrictMediaHeaders = true
	strictPolicy.PartialMediaOnly = true
	strictPolicy.FollowRedirects = false
	for i := range 2 {
		res, err := c.Do(context.Background(), Request{URL: "https://api.example.test/media", Policy: strictPolicy})
		if err != nil || string(res.Body) != "abc" {
			t.Fatalf("strict media call %d failed: %+v %v", i+1, res, err)
		}
	}
	if dials.Load() != 3 || stats.stateNew.Load() != 3 {
		t.Fatalf("expected each StrictMediaHeaders call to use an isolated socket (dials=3 StateNew=3), got dials=%d StateNew=%d",
			dials.Load(), stats.stateNew.Load())
	}

	// Raw duplicate critical header on wire must still be rejected by mediaHeaderConn.
	if _, err := c.Do(context.Background(), Request{URL: "https://api.example.test/dup-cl", Policy: strictPolicy}); !errors.Is(err, ErrMediaHeaders) {
		t.Fatalf("expected ErrMediaHeaders on raw duplicate Content-Length, got %v", err)
	}

	// Normal pooled socket remains intact and untouched by strict calls.
	if _, err := c.Do(context.Background(), Request{URL: "https://api.example.test/meta", Policy: normalPolicy}); err != nil {
		t.Fatalf("post-strict normal call failed: %v", err)
	}
	if dials.Load() != 4 {
		t.Fatalf("expected post-strict normal call to reuse pooled socket without dialing (dials=4), got %d", dials.Load())
	}
}

func TestCloseIdleConnectionsAndConcurrentPoolEviction(t *testing.T) {
	// Safe no-op on nil and zero-value Client.
	var nilClient *Client
	nilClient.CloseIdleConnections()
	(&Client{}).CloseIdleConnections()

	srv, roots, stats := newPoolTestServer(t, true, []string{"api.example.test"}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oversized-header" {
			w.Header().Set("X-Large", strings.Repeat("h", 2048))
		}
		_, _ = io.WriteString(w, "ok")
	}))

	var ipMu sync.Mutex
	targetIP := netip.MustParseAddr("93.184.216.1")
	c := NewWithResolver(resolverFunc(func(_ context.Context, _, _ string) ([]netip.Addr, error) {
		ipMu.Lock()
		ip := targetIP
		ipMu.Unlock()
		return []netip.Addr{ip}, nil
	}))
	t.Cleanup(c.CloseIdleConnections)
	c.tlsRootCAs = roots
	c.dial = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}

	policy := testPolicy()
	policy.Timeout = 3 * time.Second

	// 1. Reuse pooled socket, then CloseIdleConnections() forces a fresh connection on next Do().
	for range 2 {
		if _, err := c.Do(context.Background(), Request{URL: "https://api.example.test/ping", Policy: policy}); err != nil {
			t.Fatal(err)
		}
	}
	if stats.stateNew.Load() != 1 {
		t.Fatalf("expected StateNew=1 before CloseIdleConnections, got %d", stats.stateNew.Load())
	}

	c.CloseIdleConnections()
	deadline := time.Now().Add(time.Second)
	for stats.stateClosed.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if stats.stateClosed.Load() < 1 {
		t.Fatalf("expected idle socket to close after CloseIdleConnections, StateClosed=%d", stats.stateClosed.Load())
	}

	for range 2 {
		if _, err := c.Do(context.Background(), Request{URL: "https://api.example.test/ping", Policy: policy}); err != nil {
			t.Fatal(err)
		}
	}
	if stats.stateNew.Load() != 2 {
		t.Fatalf("expected StateNew=2 after CloseIdleConnections + 2 reused calls, got %d", stats.stateNew.Load())
	}

	// Verify per-request smaller MaxHeaderBytes is still enforced on a pooled transport.
	smallHeaderPolicy := policy
	smallHeaderPolicy.MaxHeaderBytes = 1024
	if _, err := c.Do(context.Background(), Request{URL: "https://api.example.test/oversized-header", Policy: smallHeaderPolicy}); err == nil {
		t.Fatal("expected oversized header response to fail per-request MaxHeaderBytes")
	}

	// 2. Bounded pool eviction at maxPooledTransports (64): inserting 65 distinct public IPs evicts oldest & closes its idle conn.
	closedBeforeEvict := stats.stateClosed.Load()
	for i := 1; i <= maxPooledTransports+1; i++ {
		ipMu.Lock()
		targetIP = netip.MustParseAddr(fmt.Sprintf("93.184.216.%d", i))
		ipMu.Unlock()
		if _, err := c.Do(context.Background(), Request{URL: "https://api.example.test/evict", Policy: policy}); err != nil {
			t.Fatalf("eviction step %d failed: %v", i, err)
		}
	}
	c.poolMu.Lock()
	poolLen := len(c.pool)
	_, firstStillPresent := c.pool[transportKey{host: "api.example.test", port: "443", ip: "93.184.216.1"}]
	c.poolMu.Unlock()
	if poolLen != maxPooledTransports || firstStillPresent {
		t.Fatalf("expected pool capped at %d with oldest entry evicted, got len=%d firstStillPresent=%v",
			maxPooledTransports, poolLen, firstStillPresent)
	}
	deadline = time.Now().Add(time.Second)
	for stats.stateClosed.Load() <= closedBeforeEvict && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if stats.stateClosed.Load() <= closedBeforeEvict {
		t.Fatalf("expected evicted transport's idle connection to close: before=%d after=%d",
			closedBeforeEvict, stats.stateClosed.Load())
	}

	// 3. Concurrent Do() + pool eviction + CloseIdleConnections() under -race.
	var seq atomic.Uint32
	raceClient := NewWithResolver(resolverFunc(func(_ context.Context, _, _ string) ([]netip.Addr, error) {
		n := (seq.Add(1) % 96) + 1
		return []netip.Addr{netip.MustParseAddr(fmt.Sprintf("93.184.217.%d", n))}, nil
	}))
	t.Cleanup(raceClient.CloseIdleConnections)
	raceClient.tlsRootCAs = roots
	raceClient.dial = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}

	var wg sync.WaitGroup
	stopClosers := make(chan struct{})
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stopClosers:
					return
				default:
					raceClient.CloseIdleConnections()
					time.Sleep(2 * time.Millisecond)
				}
			}
		}()
	}

	errCh := make(chan error, 16)
	var workers sync.WaitGroup
	for w := range 8 {
		workers.Add(1)
		go func(workerID int) {
			defer workers.Done()
			for iter := range 20 {
				p := policy
				if (workerID+iter)%7 == 0 {
					p.StrictMediaHeaders = true
					p.FollowRedirects = false
				}
				res, err := raceClient.Do(context.Background(), Request{URL: "https://api.example.test/race", Policy: p})
				if err != nil {
					select {
					case errCh <- err:
					default:
					}
					return
				}
				if string(res.Body) != "ok" {
					select {
					case errCh <- fmt.Errorf("unexpected body %q", string(res.Body)):
					default:
					}
					return
				}
			}
		}(w)
	}
	workers.Wait()
	close(stopClosers)
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatalf("concurrent pool race error: %v", err)
	}
}

func TestShortLivedPublicDNSCacheHitExpiryAndSafetyInvariants(t *testing.T) {
	// Default New() enables the 30s public DNS cache.
	if def := New(); def.dnsCacheTTL != defaultDNSCacheTTL || def.maxDNSEntries != maxDNSCacheEntries {
		t.Fatalf("New() DNS cache defaults = (ttl=%v, max=%d), want (%v, %d)",
			def.dnsCacheTTL, def.maxDNSEntries, defaultDNSCacheTTL, maxDNSCacheEntries)
	}

	var (
		mu       sync.Mutex
		nowTime  = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
		mode     = "public"
		lookups  atomic.Int32
		resolved = netip.MustParseAddr("93.184.216.34")
	)

	c := NewWithResolver(resolverFunc(func(_ context.Context, _, host string) ([]netip.Addr, error) {
		lookups.Add(1)
		mu.Lock()
		m := mode
		ip := resolved
		mu.Unlock()
		switch m {
		case "error":
			return nil, errors.New("dns transient failure")
		case "empty":
			return nil, nil
		case "private":
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		case "mixed":
			return []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("10.0.0.1")}, nil
		default:
			if strings.HasPrefix(host, "host") {
				return []netip.Addr{ip}, nil
			}
			return []netip.Addr{ip}, nil
		}
	})).WithDNSCache(30 * time.Second)
	c.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return nowTime
	}
	c.maxDNSEntries = 2
	c.transport = func(_ *http.Request, ips []netip.Addr, _ Policy) (*http.Response, error) {
		return reply(http.StatusOK, nil, ips[0].String()), nil
	}

	policy := Policy{
		Purpose:    "test-dns-cache",
		AllowedURL: AllowHosts("api.example.test", "cdn.example.test", "host1.example.test", "host2.example.test", "host3.example.test"),
		Timeout:    time.Second,
		MaxBytes:   128,
	}

	// 1. Cache miss -> caches validated public IP; subsequent case-variant calls within 30s hit cache.
	res1, err := c.Do(context.Background(), Request{URL: "https://api.example.test/1", Policy: policy})
	if err != nil || string(res1.Body) != "93.184.216.34" || lookups.Load() != 1 {
		t.Fatalf("initial DNS lookup failed: body=%q lookups=%d err=%v", string(res1.Body), lookups.Load(), err)
	}
	mu.Lock()
	nowTime = nowTime.Add(29 * time.Second)
	mu.Unlock()
	res2, err := c.Do(context.Background(), Request{URL: "https://API.Example.Test/2", Policy: policy})
	if err != nil || string(res2.Body) != "93.184.216.34" || lookups.Load() != 1 {
		t.Fatalf("expected DNS cache hit at +29s: body=%q lookups=%d err=%v", string(res2.Body), lookups.Load(), err)
	}

	// 2. TTL expiry at +30s triggers a fresh lookup and picks up new public IP.
	mu.Lock()
	nowTime = nowTime.Add(time.Second)
	resolved = netip.MustParseAddr("1.1.1.1")
	mu.Unlock()
	res3, err := c.Do(context.Background(), Request{URL: "https://api.example.test/3", Policy: policy})
	if err != nil || string(res3.Body) != "1.1.1.1" || lookups.Load() != 2 {
		t.Fatalf("expected DNS cache expiry at +30s: body=%q lookups=%d err=%v", string(res3.Body), lookups.Load(), err)
	}

	// 3. Errors, empty results, private IPs, and mixed public+private IPs are NEVER cached.
	for _, badMode := range []string{"error", "empty", "private", "mixed"} {
		mu.Lock()
		mode = badMode
		mu.Unlock()
		before := lookups.Load()
		if _, err := c.Do(context.Background(), Request{URL: "https://cdn.example.test/bad", Policy: policy}); err == nil {
			t.Fatalf("mode %q unexpectedly succeeded", badMode)
		}
		if _, err := c.Do(context.Background(), Request{URL: "https://cdn.example.test/bad", Policy: policy}); err == nil {
			t.Fatalf("mode %q second call unexpectedly succeeded", badMode)
		}
		if got := lookups.Load() - before; got != 2 {
			t.Fatalf("mode %q must never cache failures/private IPs: lookups delta=%d, want 2", badMode, got)
		}
	}

	// 4. Re-check PublicIP on cached entry before dialing (defense-in-depth).
	c.dnsMu.Lock()
	if elem, ok := c.dnsCache["api.example.test"]; ok {
		elem.Value.(*dnsCacheEntry).ips = []netip.Addr{netip.MustParseAddr("127.0.0.1")}
	}
	c.dnsMu.Unlock()
	if _, err := c.Do(context.Background(), Request{URL: "https://api.example.test/recheck", Policy: policy}); !errors.Is(err, ErrPolicy) {
		t.Fatalf("expected ErrPolicy on tampered cached non-public IP, got %v", err)
	}

	// 5. Bounded LRU eviction (maxDNSEntries = 2): inserting 3 distinct hosts evicts oldest.
	mu.Lock()
	mode = "public"
	resolved = netip.MustParseAddr("8.8.8.8")
	mu.Unlock()
	for _, h := range []string{"host1.example.test", "host2.example.test", "host3.example.test"} {
		if _, err := c.Do(context.Background(), Request{URL: "https://" + h + "/ok", Policy: policy}); err != nil {
			t.Fatalf("host %s failed: %v", h, err)
		}
	}
	c.dnsMu.Lock()
	cacheLen := len(c.dnsCache)
	_, hasHost1 := c.dnsCache["host1.example.test"]
	c.dnsMu.Unlock()
	if cacheLen != 2 || hasHost1 {
		t.Fatalf("expected DNS cache bounded to 2 with host1 evicted, got len=%d hasHost1=%v", cacheLen, hasHost1)
	}
}

func TestWarmConnectionPoolAffinityAndIdleConnTimeout(t *testing.T) {
	srvA, rootsA, statsA := newPoolTestServer(t, true, []string{"cdn.example.test"}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "from-A")
	}))
	srvB, rootsB, statsB := newPoolTestServer(t, true, []string{"cdn.example.test"}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "from-B")
	}))
	roots := x509.NewCertPool()
	roots.AddCert(srvA.Certificate())
	roots.AddCert(srvB.Certificate())
	_ = rootsA
	_ = rootsB

	ipA := netip.MustParseAddr("93.184.216.34")
	ipB := netip.MustParseAddr("1.1.1.1")
	ipUnreachable := netip.MustParseAddr("93.184.216.99")

	var (
		mu      sync.Mutex
		dnsIPs  = []netip.Addr{ipB}
		dialsA  atomic.Int32
		dialsB  atomic.Int32
		dialsUn atomic.Int32
	)

	c := NewWithResolver(resolverFunc(func(_ context.Context, _, _ string) ([]netip.Addr, error) {
		mu.Lock()
		defer mu.Unlock()
		return append([]netip.Addr(nil), dnsIPs...), nil
	}))
	t.Cleanup(c.CloseIdleConnections)
	c.tlsRootCAs = roots
	c.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		switch addr {
		case ipA.String() + ":443":
			dialsA.Add(1)
			return (&net.Dialer{}).DialContext(ctx, network, srvA.Listener.Addr().String())
		case ipB.String() + ":443":
			dialsB.Add(1)
			return (&net.Dialer{}).DialContext(ctx, network, srvB.Listener.Addr().String())
		case ipUnreachable.String() + ":443":
			dialsUn.Add(1)
			return nil, errors.New("unreachable")
		default:
			return nil, fmt.Errorf("unexpected dial %s", addr)
		}
	}

	policy := testPolicy()

	// 1. Warm pool with ipB and verify pooled IdleConnTimeout == 120s.
	res1, err := c.Do(context.Background(), Request{URL: "https://cdn.example.test/1", Policy: policy})
	if err != nil || string(res1.Body) != "from-B" || dialsB.Load() != 1 {
		t.Fatalf("warm ipB failed: body=%q dialsB=%d err=%v", string(res1.Body), dialsB.Load(), err)
	}
	c.poolMu.Lock()
	elemB := c.pool[transportKey{host: "cdn.example.test", port: "443", ip: ipB.String()}]
	c.poolMu.Unlock()
	if elemB == nil {
		t.Fatal("expected ipB in transport pool")
	}
	if gotTimeout := elemB.Value.(*pooledTransportEntry).transport.IdleConnTimeout; gotTimeout != 120*time.Second {
		t.Fatalf("pooled IdleConnTimeout = %v, want 120s", gotTimeout)
	}

	// 2. Round-robin DNS returns [ipA, ipB]: affinity must prefer warm ipB (ips[1]) without dialing unpooled ipA (ips[0])!
	mu.Lock()
	dnsIPs = []netip.Addr{ipA, ipB}
	mu.Unlock()
	for i := range 3 {
		res, err := c.Do(context.Background(), Request{URL: "https://cdn.example.test/warm", Policy: policy})
		if err != nil || string(res.Body) != "from-B" {
			t.Fatalf("affinity call %d failed: body=%q err=%v", i+1, string(res.Body), err)
		}
	}
	if dialsA.Load() != 0 || statsA.stateNew.Load() != 0 || dialsB.Load() != 1 || statsB.stateNew.Load() != 1 {
		t.Fatalf("warm pool affinity failed: dialsA=%d stateNewA=%d dialsB=%d stateNewB=%d",
			dialsA.Load(), statsA.stateNew.Load(), dialsB.Load(), statsB.stateNew.Load())
	}

	// 3. When NO returned IP is pooled ([unreachable, ipA]), normal dial fallback still succeeds via ipA.
	mu.Lock()
	dnsIPs = []netip.Addr{ipUnreachable, ipA}
	mu.Unlock()
	resFallback, err := c.Do(context.Background(), Request{URL: "https://cdn.example.test/fallback", Policy: policy})
	if err != nil || string(resFallback.Body) != "from-A" || dialsUn.Load() != 1 || dialsA.Load() != 1 {
		t.Fatalf("unpooled multi-IP fallback failed: body=%q dialsUn=%d dialsA=%d err=%v",
			string(resFallback.Body), dialsUn.Load(), dialsA.Load(), err)
	}
}
