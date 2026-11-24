package ytengine

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func (e *Engine) withGateTestHooks(hooks gateTestHooks) *Engine {
	if e == nil {
		return NewDisabled("yt-dlp engine is nil")
	}
	cp := *e
	h := hooks
	cp.testHooks = &h
	return &cp
}

func certPoolFromCert(cert *x509.Certificate) *x509.CertPool {
	pool := x509.NewCertPool()
	if cert != nil {
		pool.AddCert(cert)
	}
	return pool
}

func newTLSServerForHosts(t *testing.T, handler http.Handler, hosts ...string) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate test TLS key: %v", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 62))
	if err != nil {
		t.Fatalf("generate test TLS serial: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "ytengine-test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              hosts,
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("create test TLS cert: %v", err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse test TLS cert: %v", err)
	}
	srv := httptest.NewUnstartedServer(handler)
	srv.TLS = &tls.Config{
		MinVersion: tls.VersionTLS12,
		Certificates: []tls.Certificate{
			{
				Certificate: [][]byte{der},
				PrivateKey:  priv,
				Leaf:        leaf,
			},
		},
	}
	srv.StartTLS()
	return srv, certPoolFromCert(leaf)
}

func TestSingleFixedPortMultiplexesConcurrentCompartmentsAndIsolatesTunnels(t *testing.T) {
	// 1. Upstream HTTP echo server + TCP echo server (for CONNECT tunnels).
	httpUp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("Proxy-Authorization leaked to upstream")
		}
		if r.URL.Path == "/slow" {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(10 * time.Second):
			}
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("host=" + r.Host))
	}))
	defer httpUp.Close()
	httpUpURL, _ := url.Parse(httpUp.URL)

	tcpEchoLn, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tcpEchoLn.Close()
	go func() {
		for {
			c, err := tcpEchoLn.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}(c)
		}
	}()

	// 2. Build a single-fixed-port base engine and derive multiple compartments.
	bin, hashes := inertGateBinary(t)
	ports := testGatePorts(t, 1)
	resolver := &countingGateResolver{}
	baseEng, err := New(Config{
		BinaryPath:     bin,
		AllowedHashes:  hashes,
		MaxConcurrency: 12,
		GatePorts:      ports,
		Resolver:       resolver,
	})
	if err != nil || !baseEng.Enabled() {
		t.Fatalf("New single-port baseEng failed: %v", err)
	}
	t.Cleanup(func() { _ = baseEng.Close() })

	ytComp := baseEng.WithCompartment(DefaultYouTubeSlots)
	socialComp := baseEng.WithSlotPool(NewDynamicSlotPool(DefaultSocialSlots))
	genericComp := baseEng.WithGenericConcurrency(DefaultGenericSlots)
	for name, comp := range map[string]*Engine{"youtube": ytComp, "social": socialComp, "generic": genericComp} {
		if comp.gatePorts != baseEng.gatePorts {
			t.Fatalf("%s compartment did not share persistent multiplexed gateway", name)
		}
	}

	// 3. Concurrently start 12 tasks across all 3 compartments on the SAME single fixed port.
	const numTasks = 12
	type taskHandle struct {
		host   string
		parsed *url.URL
		close  func()
	}
	compartments := []*Engine{ytComp, socialComp, genericComp}
	handles := make([]taskHandle, numTasks)
	seenUsers := make(map[string]bool, numTasks)
	wantHost := net.JoinHostPort("127.0.0.1", fmt.Sprint(ports[0]))

	for i := 0; i < numTasks; i++ {
		allowedHost := fmt.Sprintf("task%d.example", i)
		taskEng := compartments[i%len(compartments)].
			WithTargetPolicy(nil, func(h string) bool { return h == allowedHost }).
			WithExtractors("default", "-generic").
			withGateTestHooks(gateTestHooks{
				dialAddr: func(_ netip.Addr, port string) string {
					if port == "443" {
						return tcpEchoLn.Addr().String()
					}
					return httpUpURL.Host
				},
			})
		gateURL, closeGate, err := taskEng.startOutboundGate(context.Background())
		if err != nil {
			t.Fatalf("task %d startOutboundGate failed: %v", i, err)
		}
		parsed, err := url.Parse(gateURL)
		if err != nil {
			closeGate()
			t.Fatalf("parse gateURL: %v", err)
		}
		if parsed.Host != wantHost {
			closeGate()
			t.Fatalf("task %d expected single fixed port %s, got %s", i, wantHost, parsed.Host)
		}
		user := parsed.User.Username()
		if !strings.HasPrefix(user, "task-") || len(user) != len("task-")+16 {
			closeGate()
			t.Fatalf("task %d unexpected username format: %q", i, user)
		}
		if seenUsers[user] {
			closeGate()
			t.Fatalf("duplicate task username %q", user)
		}
		seenUsers[user] = true
		handles[i] = taskHandle{host: allowedHost, parsed: parsed, close: closeGate}
	}
	defer func() {
		for _, h := range handles {
			h.close()
		}
	}()
	if got := baseEng.gatePorts.activeSessionCount(); got != numTasks {
		t.Fatalf("expected %d active sessions on single port, got %d", numTasks, got)
	}

	// 4. Verify 100% cross-task policy isolation across all 12 concurrent tasks on the SAME port.
	var wg sync.WaitGroup
	errCh := make(chan error, numTasks*2)
	for i := 0; i < numTasks; i++ {
		h := handles[i]
		other := handles[(i+1)%numTasks]
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Own allowed host -> 200 OK.
			if code := gateRawRequest(t, h.parsed, "GET", "http://"+h.host+"/ok", gateAuth(h.parsed)); code != http.StatusOK {
				errCh <- fmt.Errorf("task %s own host got %d, want 200", h.host, code)
				return
			}
			// Sibling task's host using own credential on same port -> 403 Forbidden.
			if code := gateRawRequest(t, h.parsed, "GET", "http://"+other.host+"/ok", gateAuth(h.parsed)); code != http.StatusForbidden {
				errCh <- fmt.Errorf("task %s reached sibling host %s with status %d, want 403", h.host, other.host, code)
				return
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for e := range errCh {
		t.Fatal(e)
	}

	// 5. Verify duplicate Proxy-Authorization headers and bad credentials get 407 BEFORE DNS lookup.
	beforeDNS := resolver.count.Load()
	{
		c, err := net.DialTimeout("tcp4", wantHost, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_ = c.SetDeadline(time.Now().Add(2 * time.Second))
		authA := gateAuth(handles[0].parsed)
		_, _ = fmt.Fprintf(c, "GET http://%s/ HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: %s\r\nProxy-Authorization: %s\r\nConnection: close\r\n\r\n", handles[0].host, handles[0].host, authA, authA)
		resp, err := http.ReadResponse(bufio.NewReader(c), nil)
		_ = c.Close()
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusProxyAuthRequired || resp.Header.Get("Proxy-Authenticate") != `Basic realm="task"` {
			t.Fatalf("duplicate Proxy-Authorization expected 407 with realm=task, got status=%d header=%q", resp.StatusCode, resp.Header.Get("Proxy-Authenticate"))
		}
	}
	if resolver.count.Load() != beforeDNS {
		t.Fatal("rejected duplicate Proxy-Authorization triggered DNS lookup")
	}

	// 6. Establish simultaneous CONNECT tunnels for Task 0 and Task 1 on the SAME fixed port.
	openTunnel := func(h taskHandle) (net.Conn, *bufio.Reader) {
		t.Helper()
		c, err := net.DialTimeout("tcp4", h.parsed.Host, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_ = c.SetDeadline(time.Now().Add(3 * time.Second))
		_, err = fmt.Fprintf(c, "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\nProxy-Authorization: %s\r\n\r\n", h.host, h.host, gateAuth(h.parsed))
		if err != nil {
			_ = c.Close()
			t.Fatal(err)
		}
		r := bufio.NewReader(c)
		resp, err := http.ReadResponse(r, nil)
		if err != nil || resp.StatusCode != http.StatusOK {
			_ = c.Close()
			t.Fatalf("CONNECT for %s failed: resp=%v err=%v", h.host, resp, err)
		}
		return c, r
	}
	tunA, readerA := openTunnel(handles[0])
	defer tunA.Close()
	tunB, readerB := openTunnel(handles[1])
	defer tunB.Close()

	// Both tunnels carry payload concurrently.
	if _, err := tunA.Write([]byte("A")); err != nil {
		t.Fatal(err)
	}
	if b, err := readerA.ReadByte(); err != nil || b != 'A' {
		t.Fatalf("tunnel A echo failed: b=%q err=%v", b, err)
	}
	if _, err := tunB.Write([]byte("B")); err != nil {
		t.Fatal(err)
	}
	if b, err := readerB.ReadByte(); err != nil || b != 'B' {
		t.Fatalf("tunnel B echo failed: b=%q err=%v", b, err)
	}

	// Also start an in-flight slow HTTP request on Task 2 to prove closing Task 2 aborts only Task 2.
	slowDone := make(chan error, 1)
	go func() {
		tr := &http.Transport{Proxy: http.ProxyURL(handles[2].parsed)}
		defer tr.CloseIdleConnections()
		cl := &http.Client{Transport: tr, Timeout: 5 * time.Second}
		resp, err := cl.Get("http://" + handles[2].host + "/slow")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				slowDone <- fmt.Errorf("expected aborted slow HTTP request, got 200 OK")
				return
			}
		}
		slowDone <- nil
	}()
	time.Sleep(40 * time.Millisecond)

	// Close ONLY Task 0 and Task 2!
	startClose := time.Now()
	handles[0].close()
	handles[2].close()
	if time.Since(startClose) > time.Second {
		t.Fatalf("closing Task 0 & Task 2 took too long: %v", time.Since(startClose))
	}

	// Task 0's tunnel MUST close immediately (not by read timeout).
	_ = tunA.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	if _, err := readerA.ReadByte(); err == nil {
		t.Fatal("Task 0 CONNECT tunnel remained open after closeGate")
	} else if nerr, ok := err.(net.Error); ok && nerr.Timeout() {
		t.Fatal("Task 0 CONNECT tunnel expired by timeout instead of immediate close")
	}

	// Task 2's in-flight HTTP request MUST abort cleanly.
	select {
	case err := <-slowDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Task 2 in-flight HTTP request did not abort when Task 2 closed")
	}

	// Task 0's revoked credential MUST immediately get 407 with ZERO DNS calls!
	beforeRevokedDNS := resolver.count.Load()
	if code := gateRawRequest(t, handles[0].parsed, "GET", "http://"+handles[0].host+"/ok", gateAuth(handles[0].parsed)); code != http.StatusProxyAuthRequired {
		t.Fatalf("revoked Task 0 GET expected 407, got %d", code)
	}
	if code := gateRawRequest(t, handles[0].parsed, "CONNECT", handles[0].host+":443", gateAuth(handles[0].parsed)); code != http.StatusProxyAuthRequired {
		t.Fatalf("revoked Task 0 CONNECT expected 407, got %d", code)
	}
	if resolver.count.Load() != beforeRevokedDNS {
		t.Fatal("revoked credential triggered DNS lookup")
	}

	// Task 1's active CONNECT tunnel on the EXACT SAME PORT MUST stay alive!
	_ = tunB.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := tunB.Write([]byte("Z")); err != nil {
		t.Fatalf("Task 1 tunnel write failed after Task 0 closed: %v", err)
	}
	if b, err := readerB.ReadByte(); err != nil || b != 'Z' {
		t.Fatalf("Task 1 tunnel disturbed by Task 0 close: b=%q err=%v", b, err)
	}
	if code := gateRawRequest(t, handles[1].parsed, "GET", "http://"+handles[1].host+"/ok", gateAuth(handles[1].parsed)); code != http.StatusOK {
		t.Fatalf("Task 1 HTTP on same port expected 200 after Task 0 closed, got %d", code)
	}

	// 7. Close() is nil-safe and idempotent, tears down persistent listener cleanly.
	var nilEng *Engine
	if err := nilEng.Close(); err != nil {
		t.Fatalf("nil Engine.Close returned error: %v", err)
	}
	if err := baseEng.Close(); err != nil {
		t.Fatalf("baseEng.Close failed: %v", err)
	}
	if err := baseEng.Close(); err != nil {
		t.Fatalf("second baseEng.Close failed: %v", err)
	}
	if _, _, err := ytComp.startOutboundGate(context.Background()); err == nil {
		t.Fatal("expected startOutboundGate after Close() to fail")
	}
}

func TestDynamicSlotPoolInPlaceResizeAndFIFO(t *testing.T) {
	// Verify locked compartment constant contract.
	if DefaultConcurrency != 2 || MaxConcurrency != 24 || MaxTotalActiveSlots != 32 ||
		DefaultYouTubeSlots != 4 || MinYouTubeSlots != 1 || MaxYouTubeSlots != 16 ||
		DefaultSocialSlots != 4 || MinSocialSlots != 1 || MaxSocialSlots != 16 ||
		DefaultGenericSlots != 2 || MinGenericSlots != 1 || MaxGenericSlots != 12 {
		t.Fatal("exported slot constants diverged from locked API contract")
	}

	// Constructor defaults and clamping.
	if got := NewDynamicSlotPool(0).Limit(); got != DefaultConcurrency {
		t.Fatalf("NewDynamicSlotPool(0).Limit() = %d, want %d", got, DefaultConcurrency)
	}
	if got := NewDynamicSlotPool(-5).Limit(); got != DefaultConcurrency {
		t.Fatalf("NewDynamicSlotPool(-5).Limit() = %d, want %d", got, DefaultConcurrency)
	}
	if got := NewDynamicSlotPool(999).Limit(); got != MaxConcurrency {
		t.Fatalf("NewDynamicSlotPool(999).Limit() = %d, want %d", got, MaxConcurrency)
	}

	pool := NewDynamicSlotPool(1)
	if err := pool.SetLimit(0); err == nil {
		t.Fatal("SetLimit(0) must fail")
	}
	if err := pool.SetLimit(-1); err == nil {
		t.Fatal("SetLimit(-1) must fail")
	}
	if err := pool.SetLimit(MaxConcurrency + 1); err == nil {
		t.Fatal("SetLimit(MaxConcurrency+1) must fail")
	}
	if pool.Limit() != 1 {
		t.Fatalf("failed SetLimit mutated limit to %d", pool.Limit())
	}

	// Acquire initial lease (limit = 1).
	stats := newSlotStats()
	rel0, acqErr := pool.acquire(context.Background(), stats, chAnonIdx)
	if acqErr != nil {
		t.Fatalf("initial acquire failed: %v", acqErr)
	}
	if pool.Active() != 1 || pool.Waiting() != 0 {
		t.Fatalf("unexpected gauges after first acquire: active=%d waiting=%d", pool.Active(), pool.Waiting())
	}

	// Queue 4 waiters strictly in FIFO order.
	const numWaiters = 4
	acquiredOrder := make(chan int, numWaiters)
	releases := make([]chan func(), numWaiters)
	for i := 0; i < numWaiters; i++ {
		releases[i] = make(chan func(), 1)
		idx := i + 1
		go func() {
			rel, aErr := pool.acquire(context.Background(), stats, chOwnerIdx)
			if aErr != nil {
				t.Errorf("waiter %d acquire failed: %v", idx, aErr)
				return
			}
			acquiredOrder <- idx
			releases[idx-1] <- rel
		}()
		deadline := time.Now().Add(time.Second)
		for pool.Waiting() < idx && time.Now().Before(deadline) {
			time.Sleep(2 * time.Millisecond)
		}
		if pool.Waiting() != idx {
			t.Fatalf("timed out waiting for waiter %d to queue (waiting=%d)", idx, pool.Waiting())
		}
	}

	// Scale UP from 1 -> 2 first: MUST deterministically wake ONLY waiter 1 (strict FIFO head).
	if err := pool.SetLimit(2); err != nil {
		t.Fatalf("SetLimit(2) failed: %v", err)
	}
	if got1 := <-acquiredOrder; got1 != 1 {
		t.Fatalf("scale-up 1->2 woke waiter %d, want FIFO head 1", got1)
	}
	rel1 := <-releases[0]
	if pool.Limit() != 2 || pool.Active() != 2 || pool.Waiting() != 3 {
		t.Fatalf("unexpected gauges after 1->2 scale-up: limit=%d active=%d waiting=%d", pool.Limit(), pool.Active(), pool.Waiting())
	}

	// Batch scale UP from 2 -> 4: MUST immediately wake waiters 2 and 3 (leaving waiter 4 queued).
	if err := pool.SetLimit(4); err != nil {
		t.Fatalf("SetLimit(4) failed: %v", err)
	}
	wokenBatch := map[int]bool{<-acquiredOrder: true, <-acquiredOrder: true}
	if !wokenBatch[2] || !wokenBatch[3] {
		t.Fatalf("batch scale-up 2->4 woke %v, want {2, 3} in FIFO order", wokenBatch)
	}
	rel2 := <-releases[1]
	rel3 := <-releases[2]
	if pool.Active() != 4 || pool.Waiting() != 1 {
		t.Fatalf("expected active=4 waiting=1, got active=%d waiting=%d", pool.Active(), pool.Waiting())
	}

	// Scale DOWN from 4 -> 2 while 4 leases are active:
	// MUST NOT kill active leases; waiter 4 MUST stay queued until active drains below 2!
	if err := pool.SetLimit(2); err != nil {
		t.Fatalf("SetLimit(2) failed: %v", err)
	}
	if pool.Limit() != 2 || pool.Active() != 4 || pool.Waiting() != 1 {
		t.Fatalf("unexpected gauges immediately after scale-down: limit=%d active=%d waiting=%d", pool.Limit(), pool.Active(), pool.Waiting())
	}

	// Release 1st active lease (4 -> 3): still >= limit(2), waiter 4 must NOT wake.
	rel0()
	time.Sleep(20 * time.Millisecond)
	if pool.Active() != 3 || pool.Waiting() != 1 {
		t.Fatalf("after 1st release expected active=3 waiting=1, got active=%d waiting=%d", pool.Active(), pool.Waiting())
	}

	// Release 2nd active lease (3 -> 2): still == limit(2), waiter 4 must NOT wake.
	rel1()
	time.Sleep(20 * time.Millisecond)
	if pool.Active() != 2 || pool.Waiting() != 1 {
		t.Fatalf("after 2nd release expected active=2 waiting=1, got active=%d waiting=%d", pool.Active(), pool.Waiting())
	}

	// Release 3rd active lease (2 -> 1 < 2): waiter 4 MUST wake immediately (active becomes 2, waiting 0).
	rel2()
	select {
	case got4 := <-acquiredOrder:
		if got4 != 4 {
			t.Fatalf("expected waiter 4, got %d", got4)
		}
	case <-time.After(time.Second):
		t.Fatal("waiter 4 did not wake once active drained below new limit")
	}
	rel4 := <-releases[3]
	if pool.Active() != 2 || pool.Waiting() != 0 {
		t.Fatalf("expected active=2 waiting=0 after waiter 4 woke, got active=%d waiting=%d", pool.Active(), pool.Waiting())
	}

	rel3()
	rel4()
	if pool.Active() != 0 || pool.Waiting() != 0 {
		t.Fatalf("expected clean drain active=0 waiting=0, got active=%d waiting=%d", pool.Active(), pool.Waiting())
	}

	// Verify Engine.SetConcurrencyLimit / ConcurrencyLimit / StatsSnapshot integration.
	bin, hashes := inertGateBinary(t)
	eng, err := New(Config{BinaryPath: bin, AllowedHashes: hashes, MaxConcurrency: 2})
	if err != nil {
		t.Fatal(err)
	}
	comp := eng.WithCompartment(DefaultYouTubeSlots)
	if comp.ConcurrencyLimit() != DefaultYouTubeSlots || comp.StatsSnapshot().ConcurrencyLimit != DefaultYouTubeSlots {
		t.Fatalf("WithCompartment limit mismatch: method=%d snap=%d", comp.ConcurrencyLimit(), comp.StatsSnapshot().ConcurrencyLimit)
	}
	if err := comp.SetConcurrencyLimit(8); err != nil {
		t.Fatalf("SetConcurrencyLimit(8) failed: %v", err)
	}
	if comp.ConcurrencyLimit() != 8 || comp.StatsSnapshot().ConcurrencyLimit != 8 {
		t.Fatalf("post-resize limit mismatch: method=%d snap=%d", comp.ConcurrencyLimit(), comp.StatsSnapshot().ConcurrencyLimit)
	}
	if eng.ConcurrencyLimit() != 2 {
		t.Fatalf("resizing compartment mutated base engine limit to %d", eng.ConcurrencyLimit())
	}
	if err := NewDisabled("off").SetConcurrencyLimit(2); err == nil {
		t.Fatal("disabled engine SetConcurrencyLimit must fail")
	}
	var nilEng *Engine
	if err := nilEng.SetConcurrencyLimit(2); err == nil {
		t.Fatal("nil engine SetConcurrencyLimit must fail")
	}
}

func TestExplicitPythonPathValidationAndZipapp(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix python/chmod fixture")
	}
	realPython3 := lookupPython3InPath(os.Getenv("PATH"))
	if realPython3 == "" {
		t.Skip("python3 not found in PATH")
	}

	// Build a fake zipapp binary (real archive/zip payload with #!/usr/bin/env python3).
	mainPy := fmt.Sprintf(`import json, sys
if '--version' in sys.argv:
    print(%q)
    sys.exit(0)
print(json.dumps({
    'id': 'explicit-py-ok',
    'title': sys.executable,
    'formats': [{'format_id': '18', 'url': 'https://cdn.example.com/v.mp4', 'ext': 'mp4', 'protocol': 'https', 'width': 1280, 'height': 720, 'vcodec': 'avc1', 'acodec': 'mp4a'}]
}))
`, PinnedVersion)
	zipBytes := buildRealPythonZipapp(t, mainPy, "OK = True\n")
	zipDir := t.TempDir()
	zipPath := filepath.Join(zipDir, "yt-dlp")
	if err := os.WriteFile(zipPath, zipBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	zipSum := sha256.Sum256(zipBytes)
	zipHashes := map[string]string{hex.EncodeToString(zipSum[:]): "yt-dlp"}

	// 1. Reject invalid DOKITOOL_YTDLP_PYTHON values.
	badDir := t.TempDir()
	nonExecPath := filepath.Join(badDir, "nonexec-python")
	if err := os.WriteFile(nonExecPath, []byte("#!/bin/sh\nexit 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	worldWritablePath := filepath.Join(badDir, "world-writable-python")
	if err := os.WriteFile(worldWritablePath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(worldWritablePath, 0o777); err != nil {
		t.Fatal(err)
	}
	symlinkToWorldWritable := filepath.Join(badDir, "symlink-bad-python")
	if err := os.Symlink(worldWritablePath, symlinkToWorldWritable); err != nil {
		t.Fatal(err)
	}
	symlinkToNonExec := filepath.Join(badDir, "symlink-nonexec-python")
	if err := os.Symlink(nonExecPath, symlinkToNonExec); err != nil {
		t.Fatal(err)
	}

	for name, badPy := range map[string]string{
		"relative-bare":          "python3",
		"relative-dot":           "./python3",
		"nonexistent":            filepath.Join(badDir, "does-not-exist"),
		"directory":              badDir,
		"non-executable":         nonExecPath,
		"world-writable":         worldWritablePath,
		"symlink-world-writable": symlinkToWorldWritable,
		"symlink-non-executable": symlinkToNonExec,
	} {
		t.Run("reject-"+name, func(t *testing.T) {
			eng, err := New(Config{
				BinaryPath:    zipPath,
				PythonPath:    badPy,
				AllowedHashes: zipHashes,
			})
			if err == nil || eng.Enabled() {
				t.Fatalf("expected PythonPath=%q to be rejected, got enabled=%v err=%v", badPy, eng.Enabled(), err)
			}
		})
	}

	// 2. Accept a valid executable symlink (simulating /opt/dokitool/ytdlp-venv/bin/python3 -> system python3)
	// and preserve the configured symlink path in e.PythonPath() for pyvenv.cfg discovery.
	venvBinDir := filepath.Join(t.TempDir(), "venv", "bin")
	if err := os.MkdirAll(venvBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	venvPython := filepath.Join(venvBinDir, "python3")
	if err := os.Symlink(realPython3, venvPython); err != nil {
		t.Fatal(err)
	}
	eng, err := New(Config{
		BinaryPath:    zipPath,
		PythonPath:    venvPython,
		AllowedHashes: zipHashes,
		EnvPath:       "/nonexistent-path-proving-explicit-python-used",
	})
	if err != nil || !eng.Enabled() {
		t.Fatalf("expected valid symlink PythonPath to succeed, got err=%v", err)
	}
	if !eng.UsingPythonZipapp() || eng.PythonPath() != venvPython {
		t.Fatalf("unexpected zipapp state: using=%v pythonPath=%q want=%q", eng.UsingPythonZipapp(), eng.PythonPath(), venvPython)
	}
	info, err := eng.Extract(context.Background(), "https://example.com/v/1")
	if err != nil || info == nil || info.ID != "explicit-py-ok" {
		t.Fatalf("Extract with explicit PythonPath failed: info=%+v err=%v", info, err)
	}

	// 3. Explicit PythonPath failing --version self-check MUST fail closed (no silent direct fallback).
	execZipPath := filepath.Join(zipDir, "yt-dlp-exec")
	if err := os.WriteFile(execZipPath, zipBytes, 0o755); err != nil {
		t.Fatal(err)
	}
	badSelfCheckPy := filepath.Join(badDir, "failing-python")
	if err := os.WriteFile(badSelfCheckPy, []byte("#!/bin/sh\necho wrong-version\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	failEng, failErr := New(Config{
		BinaryPath:    execZipPath,
		PythonPath:    badSelfCheckPy,
		AllowedHashes: zipHashes,
		EnvPath:       os.Getenv("PATH"),
	})
	if failErr == nil || failEng.Enabled() {
		t.Fatalf("expected explicit failing DOKITOOL_YTDLP_PYTHON to fail closed, got enabled=%v err=%v", failEng.Enabled(), failErr)
	}

	// 4. Native (non-zipapp) binary leaves PythonPath() empty even if valid PythonPath is configured.
	nativeBin, nativeHashes := writeFakeYTDLP(t, `echo '{"id":"native"}'`)
	nativeEng, err := New(Config{
		BinaryPath:    nativeBin,
		PythonPath:    venvPython,
		AllowedHashes: nativeHashes,
	})
	if err != nil || !nativeEng.Enabled() {
		t.Fatalf("expected native binary with valid PythonPath to succeed, got err=%v", err)
	}
	if nativeEng.UsingPythonZipapp() || nativeEng.PythonPath() != "" {
		t.Fatalf("native binary must report empty PythonPath, got using=%v path=%q", nativeEng.UsingPythonZipapp(), nativeEng.PythonPath())
	}

	// 5. NewFromEnv wires DOKITOOL_YTDLP_PYTHON and fails closed on invalid value.
	envEng, envErr := NewFromEnv(func(k string) string {
		switch k {
		case "DOKITOOL_YTDLP_BINARY":
			return nativeBin
		case "DOKITOOL_YTDLP_PYTHON":
			return "relative/python3"
		}
		return ""
	}, nil)
	if envErr == nil || envEng.Enabled() {
		t.Fatalf("expected NewFromEnv with relative DOKITOOL_YTDLP_PYTHON to fail, got err=%v", envErr)
	}
}

func TestGateRedirectHeaderStrippingP27(t *testing.T) {
	type seenReq struct {
		host   string
		path   string
		scheme string
		auth   string
		cookie string
	}
	var (
		mu   sync.Mutex
		seen []seenReq
	)
	record := func(scheme string, r *http.Request) {
		mu.Lock()
		seen = append(seen, seenReq{
			host:   r.Host,
			path:   r.URL.Path,
			scheme: scheme,
			auth:   r.Header.Get("Authorization"),
			cookie: r.Header.Get("Cookie"),
		})
		mu.Unlock()
	}

	makeHandler := func(scheme string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			record(scheme, r)
			switch r.URL.Path {
			case "/same1":
				http.Redirect(w, r, "https://a.example/same2", http.StatusFound)
			case "/cross1":
				http.Redirect(w, r, "https://b.example/cross2", http.StatusFound)
			case "/cross2":
				// Redirect back to original host a.example: credentials MUST remain permanently stripped!
				http.Redirect(w, r, "https://a.example/cross3", http.StatusFound)
			case "/port1":
				http.Redirect(w, r, "https://a.example:8443/port2", http.StatusFound)
			case "/down1":
				http.Redirect(w, r, "http://a.example/down2", http.StatusFound)
			case "/down2":
				// Redirect back to HTTPS: credentials MUST remain permanently stripped after downgrade!
				http.Redirect(w, r, "https://a.example/down3", http.StatusFound)
			default:
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte("ok:" + r.URL.Path))
			}
		})
	}

	tlsSrv, caPool := newTLSServerForHosts(t, makeHandler("https"), "a.example", "b.example")
	defer tlsSrv.Close()
	httpSrv := httptest.NewServer(makeHandler("http"))
	defer httpSrv.Close()

	tlsURL, _ := url.Parse(tlsSrv.URL)
	httpURL, _ := url.Parse(httpSrv.URL)

	resolver := stubResolver{
		ips: map[string][]netip.Addr{
			"a.example": {netip.MustParseAddr("93.184.216.34")},
			"b.example": {netip.MustParseAddr("93.184.216.35")},
		},
	}
	bin, hashes := inertGateBinary(t)
	baseEng, err := New(Config{
		BinaryPath:          bin,
		AllowedHashes:       hashes,
		AllowedOutboundHost: func(h string) bool { return h == "a.example" || h == "b.example" },
		Resolver:            resolver,
	})
	if err != nil {
		t.Fatal(err)
	}
	eng := baseEng.withGateTestHooks(gateTestHooks{
		dialAddr: func(_ netip.Addr, port string) string {
			if port == "80" {
				return httpURL.Host
			}
			return tlsURL.Host
		},
		rootCAs:         caPool,
		allowCustomPort: true,
	})

	gateURL, closeGate, err := eng.startOutboundGate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer closeGate()
	parsedGate, _ := url.Parse(gateURL)

	sendViaProxy := func(targetURL string) int {
		t.Helper()
		c, err := net.DialTimeout("tcp4", parsedGate.Host, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(3 * time.Second))
		u, _ := url.Parse(targetURL)
		_, err = fmt.Fprintf(c, "GET %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: %s\r\nAuthorization: Bearer top-secret\r\nCookie: sid=xyz\r\nConnection: close\r\n\r\n", targetURL, u.Host, gateAuth(parsedGate))
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.ReadResponse(bufio.NewReader(c), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		_, _ = io.ReadAll(resp.Body)
		return resp.StatusCode
	}

	// 1. Same-origin HTTPS redirect preserves Authorization & Cookie.
	seen = nil
	if code := sendViaProxy("https://a.example/same1"); code != http.StatusOK {
		t.Fatalf("same-origin redirect got %d, want 200", code)
	}
	if len(seen) != 2 || seen[1].auth != "Bearer top-secret" || seen[1].cookie != "sid=xyz" {
		t.Fatalf("same-origin HTTPS redirect dropped credentials: %+v", seen)
	}

	// 2. Cross-host redirect strips Authorization & Cookie permanently (even on bounce-back to a.example).
	seen = nil
	if code := sendViaProxy("https://a.example/cross1"); code != http.StatusOK {
		t.Fatalf("cross-host redirect got %d, want 200", code)
	}
	if len(seen) != 3 {
		t.Fatalf("expected 3 hops, got %+v", seen)
	}
	if seen[0].auth != "Bearer top-secret" || seen[0].cookie != "sid=xyz" {
		t.Fatalf("initial hop missing credentials: %+v", seen[0])
	}
	for i := 1; i < 3; i++ {
		if seen[i].auth != "" || seen[i].cookie != "" {
			t.Fatalf("hop %d leaked credentials after cross-host redirect: %+v", i, seen[i])
		}
	}

	// 3. Cross-port redirect strips Authorization & Cookie.
	seen = nil
	if code := sendViaProxy("https://a.example/port1"); code != http.StatusOK {
		t.Fatalf("cross-port redirect got %d, want 200", code)
	}
	if len(seen) != 2 || seen[1].auth != "" || seen[1].cookie != "" {
		t.Fatalf("cross-port redirect leaked credentials: %+v", seen)
	}

	// 4. HTTPS -> HTTP scheme downgrade strips Authorization & Cookie permanently (even on upgrade back to HTTPS).
	seen = nil
	if code := sendViaProxy("https://a.example/down1"); code != http.StatusOK {
		t.Fatalf("scheme downgrade redirect got %d, want 200", code)
	}
	if len(seen) != 3 {
		t.Fatalf("expected 3 hops on downgrade chain, got %+v", seen)
	}
	for i := 1; i < 3; i++ {
		if seen[i].auth != "" || seen[i].cookie != "" {
			t.Fatalf("hop %d leaked credentials after https->http downgrade: %+v", i, seen[i])
		}
	}
}

func TestGateTLSVerificationAndPortPolicyP28(t *testing.T) {
	var hits atomic.Int64
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("tls-ok"))
	})
	tlsSrv, caPool := newTLSServerForHosts(t, handler, "a.example")
	defer tlsSrv.Close()
	unrelatedTLS, unrelatedCA := newTLSServerForHosts(t, handler, "other.example")
	defer unrelatedTLS.Close()
	plainSrv := httptest.NewServer(handler)
	defer plainSrv.Close()

	tlsURL, _ := url.Parse(tlsSrv.URL)
	plainURL, _ := url.Parse(plainSrv.URL)

	resolver := stubResolver{
		ips: map[string][]netip.Addr{
			"a.example": {netip.MustParseAddr("93.184.216.34")},
		},
	}
	bin, hashes := inertGateBinary(t)
	baseEng, err := New(Config{
		BinaryPath:          bin,
		AllowedHashes:       hashes,
		AllowedOutboundHost: func(h string) bool { return h == "a.example" },
		Resolver:            resolver,
	})
	if err != nil {
		t.Fatal(err)
	}

	send := func(eng *Engine, targetURL string) int {
		t.Helper()
		gateURL, closeGate, err := eng.startOutboundGate(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		defer closeGate()
		parsedGate, _ := url.Parse(gateURL)
		return gateRawRequest(t, parsedGate, "GET", targetURL, gateAuth(parsedGate))
	}

	// 1. Trusted test CA in RootCAs succeeds with full TLS verification.
	trustedEng := baseEng.withGateTestHooks(gateTestHooks{
		dialAddr: func(netip.Addr, string) string { return tlsURL.Host },
		rootCAs:  caPool,
	})
	if code := send(trustedEng, "https://a.example/ok"); code != http.StatusOK {
		t.Fatalf("trusted TLS cert expected 200, got %d", code)
	}

	// 2. Untrusted TLS cert (RootCAs does not trust server CA) MUST be rejected — proving InsecureSkipVerify is gone!
	beforeUntrusted := hits.Load()
	untrustedEng := baseEng.withGateTestHooks(gateTestHooks{
		dialAddr: func(netip.Addr, string) string { return tlsURL.Host },
		rootCAs:  unrelatedCA,
	})
	if code := send(untrustedEng, "https://a.example/ok"); code != http.StatusBadGateway {
		t.Fatalf("untrusted TLS cert expected 502 handshake failure, got %d", code)
	}
	if hits.Load() != beforeUntrusted {
		t.Fatal("untrusted TLS cert reached upstream handler (InsecureSkipVerify regression!)")
	}

	// 3. No plaintext fallback when upstream on port 443 speaks HTTP (allowPlaintextFallback == false).
	noFallbackEng := baseEng.withGateTestHooks(gateTestHooks{
		dialAddr: func(netip.Addr, string) string { return plainURL.Host },
		rootCAs:  caPool,
	})
	if code := send(noFallbackEng, "https://a.example/ok"); code != http.StatusBadGateway {
		t.Fatalf("https->http plaintext fallback must be disabled, got %d", code)
	}

	// 4. Custom non-80/443 port MUST be rejected with 403 even when dialAddr hook is set (allowCustomPort == false).
	if code := send(trustedEng, "https://a.example:8443/ok"); code != http.StatusForbidden {
		t.Fatalf("custom port 8443 expected 403 Forbidden when allowCustomPort=false, got %d", code)
	}
}

func TestPythonPathAncestorDirAndPreExecReverifyM3(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits test")
	}
	realPython3 := lookupPython3InPath(os.Getenv("PATH"))
	if realPython3 == "" {
		t.Skip("python3 not found in PATH")
	}

	mainPy := fmt.Sprintf(`import json, sys
if '--version' in sys.argv:
    print(%q)
    sys.exit(0)
print(json.dumps({
    'id': 'preexec-ok',
    'title': sys.executable,
    'formats': [{'format_id': '18', 'url': 'https://cdn.example.com/v.mp4', 'ext': 'mp4', 'protocol': 'https', 'width': 1280, 'height': 720, 'vcodec': 'avc1', 'acodec': 'mp4a'}]
}))
`, PinnedVersion)
	zipBytes := buildRealPythonZipapp(t, mainPy, "OK = True\n")
	zipDir := t.TempDir()
	zipPath := filepath.Join(zipDir, "yt-dlp")
	if err := os.WriteFile(zipPath, zipBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	zipSum := sha256.Sum256(zipBytes)
	zipHashes := map[string]string{hex.EncodeToString(zipSum[:]): "yt-dlp"}

	// 1. World-writable ancestor directory without sticky bit MUST be rejected.
	wwParent := filepath.Join(t.TempDir(), "ww-dir")
	if err := os.MkdirAll(wwParent, 0o755); err != nil {
		t.Fatal(err)
	}
	wwBinDir := filepath.Join(wwParent, "bin")
	if err := os.MkdirAll(wwBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	wwPy := filepath.Join(wwBinDir, "python3")
	if err := os.Symlink(realPython3, wwPy); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(wwParent, 0o777); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(wwParent, 0o755) })
	if eng, err := New(Config{BinaryPath: zipPath, PythonPath: wwPy, AllowedHashes: zipHashes}); err == nil || eng.Enabled() {
		t.Fatalf("expected world-writable ancestor directory without sticky bit to be rejected, got enabled=%v err=%v", eng.Enabled(), err)
	}

	// 2. Group-writable (0o775) AND sticky world-writable (0o1777) ancestor directories MUST be accepted.
	safeParent := filepath.Join(t.TempDir(), "sticky-parent")
	groupBin := filepath.Join(safeParent, "group-writable-bin")
	if err := os.MkdirAll(groupBin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(safeParent, os.ModeSticky|0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(groupBin, 0o775); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(groupBin, 0o755)
		_ = os.Chmod(safeParent, 0o755)
	})
	safePy := filepath.Join(groupBin, "python3")
	if err := os.Symlink(realPython3, safePy); err != nil {
		t.Fatal(err)
	}
	eng, err := New(Config{
		BinaryPath:    zipPath,
		PythonPath:    safePy,
		AllowedHashes: zipHashes,
		EnvPath:       "/nonexistent",
	})
	if err != nil || !eng.Enabled() {
		t.Fatalf("expected sticky + group-writable ancestor directory to succeed, got err=%v", err)
	}
	info, err := eng.Extract(context.Background(), "https://example.com/v/ok")
	if err != nil || info == nil || info.ID != "preexec-ok" {
		t.Fatalf("initial Extract failed: info=%+v err=%v", info, err)
	}

	// 3. Runtime symlink swap AFTER startup MUST be blocked before exec with non-retryable CodeUpstreamUnavailable.
	altExec := filepath.Join(t.TempDir(), "alt-python")
	if err := os.WriteFile(altExec, []byte("#!/bin/sh\necho '{\"id\":\"pwned\"}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(safePy); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(altExec, safePy); err != nil {
		t.Fatal(err)
	}
	_, tamperErr := eng.Extract(context.Background(), "https://example.com/v/tampered")
	var ytErr *Error
	if !errors.As(tamperErr, &ytErr) || ytErr.Code != CodeUpstreamUnavailable || ytErr.Retryable {
		t.Fatalf("expected non-retryable CodeUpstreamUnavailable on runtime python symlink swap, got %v", tamperErr)
	}

	// 4. Restore original symlink, then chmod parent world-writable without sticky bit -> MUST also block before exec!
	if err := os.Remove(safePy); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realPython3, safePy); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(groupBin, 0o777); err != nil {
		t.Fatal(err)
	}
	_, permErr := eng.Extract(context.Background(), "https://example.com/v/ww")
	ytErr = nil
	if !errors.As(permErr, &ytErr) || ytErr.Code != CodeUpstreamUnavailable || ytErr.Retryable {
		t.Fatalf("expected non-retryable CodeUpstreamUnavailable when ancestor becomes world-writable, got %v", permErr)
	}
}

func TestGatePortPoolBusyPortLogsWarningLow5(t *testing.T) {
	occupied, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	busyPort := occupied.Addr().(*net.TCPAddr).Port

	freeLn, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	freePort := freeLn.Addr().(*net.TCPAddr).Port
	_ = freeLn.Close()

	pool, err := newGatePortPool([]int{busyPort, freePort})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pool.Close() }()

	var logBuf bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prevOut)

	gl, err := pool.pickListener()
	if err != nil {
		t.Fatalf("expected free port %d to bind while busy port %d is skipped: %v", freePort, busyPort, err)
	}
	if gl.port != freePort {
		t.Fatalf("picked port = %d, want %d", gl.port, freePort)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "skipped busy ports") || !strings.Contains(logged, fmt.Sprintf("%d", busyPort)) || !strings.Contains(logged, "1/2") {
		t.Fatalf("expected warning log for skipped busy port %d (1/2), got %q", busyPort, logged)
	}
}
