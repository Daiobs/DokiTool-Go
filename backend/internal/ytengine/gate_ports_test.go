package ytengine

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testGatePorts(t *testing.T, count int) []int {
	t.Helper()
	var listeners []net.Listener
	var ports []int
	for i := 0; i < count; i++ {
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		listeners = append(listeners, ln)
		ports = append(ports, ln.Addr().(*net.TCPAddr).Port)
	}
	for _, ln := range listeners {
		_ = ln.Close()
	}
	return ports
}

func inertGateBinary(t *testing.T) (string, map[string]string) {
	t.Helper()
	b := []byte("not executed: binary preflight fixture")
	p := filepath.Join(t.TempDir(), "inert")
	if err := os.WriteFile(p, b, 0600); err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(b)
	return p, map[string]string{hex.EncodeToString(h[:]): "inert"}
}

func TestGatePortConfiguration(t *testing.T) {
	bin, hashes := inertGateBinary(t)
	tooMany := make([]int, MaxConcurrency+1)
	for i := range tooMany {
		tooMany[i] = 19200 + i
	}
	for _, ports := range [][]int{{1023, 19002}, {19001, 65536}, {19001, 19001}, tooMany} {
		e, err := New(Config{BinaryPath: bin, AllowedHashes: hashes, GatePorts: ports})
		if err == nil || e.Enabled() {
			t.Fatalf("invalid port set accepted: %v", ports)
		}
	}
	for _, raw := range []string{"127.0.0.1:19001,19002", "localhost:19001", "19001,", "+19001,19002", "19001-19002"} {
		_, err := NewFromEnv(func(key string) string {
			if key == "DOKITOOL_YTDLP_GATE_PORTS" {
				return raw
			}
			return ""
		}, nil)
		if err == nil || !strings.Contains(err.Error(), "GATE_PORTS") {
			t.Fatalf("invalid env syntax accepted: %q", raw)
		}
	}
	// Multiplexed gateway breaks the old 1:1 port==concurrency restriction:
	// 1 port with concurrency 6, 3 ports with concurrency 2, and SharedSemaphore mismatch all succeed.
	for _, tc := range []struct {
		ports []int
		conc  int
	}{
		{[]int{19001}, 6},
		{[]int{19001, 19002}, 12},
		{[]int{19001, 19002, 19003}, 2},
	} {
		eng, err := New(Config{BinaryPath: bin, AllowedHashes: hashes, MaxConcurrency: tc.conc, GatePorts: tc.ports})
		if err != nil || !eng.Enabled() {
			t.Fatalf("expected GatePorts=%v with MaxConcurrency=%d to succeed, got err=%v", tc.ports, tc.conc, err)
		}
	}
	if sharedEng, err := New(Config{BinaryPath: bin, AllowedHashes: hashes, GatePorts: []int{19001, 19002}, SharedSemaphore: make(chan struct{}, 1)}); err != nil || !sharedEng.Enabled() {
		t.Fatalf("expected GatePorts with SharedSemaphore to succeed under multiplexed gateway, got err=%v", err)
	}
	ports, err := parseGatePorts("19001, 19002")
	if err != nil {
		t.Fatal(err)
	}
	eng, err := New(Config{BinaryPath: bin, AllowedHashes: hashes, GatePorts: ports})
	if err != nil {
		t.Fatal(err)
	}
	ports[0] = 19999
	if eng.gatePorts.ports[0] != 19001 {
		t.Fatal("configuration slice retained by reference")
	}
	clone := eng.WithTargetPolicy(func(string) bool { return true }, func(string) bool { return true })
	if clone.gatePorts != eng.gatePorts || clone.slotPool != eng.slotPool {
		t.Fatal("platform clones must share gateway and concurrency allocation")
	}
	for _, n := range []int{6, MaxConcurrency} {
		poolPorts := make([]int, n)
		for i := range poolPorts {
			poolPorts[i] = 19100 + i
		}
		okEng, okErr := New(Config{BinaryPath: bin, AllowedHashes: hashes, MaxConcurrency: n, GatePorts: poolPorts})
		if okErr != nil || !okEng.Enabled() {
			t.Fatalf("expected GatePorts of size %d to succeed, got err=%v", n, okErr)
		}
	}
}

func TestGateFixedPoolNoFallbackAndReclaims(t *testing.T) {
	ports := testGatePorts(t, 2)
	p, err := newGatePortPool(ports)
	if err != nil {
		t.Fatal(err)
	}
	e := &Engine{gatePorts: p}
	t.Cleanup(func() { _ = e.Close() })
	x := e.WithTargetPolicy(nil, func(s string) bool { return s == "x.example" })
	y := e.WithTargetPolicy(nil, func(s string) bool { return s == "y.example" })
	z := e.WithTargetPolicy(nil, func(s string) bool { return s == "z.example" })
	xURL, xClose, err := x.startOutboundGate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer xClose()
	yURL, yClose, err := y.startOutboundGate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer yClose()
	xu, _ := url.Parse(xURL)
	yu, _ := url.Parse(yURL)
	if xu.Host == yu.Host {
		t.Fatal("two tasks on two fixed ports should distribute across both listeners")
	}
	if got := gateRawRequest(t, xu, "GET", "http://y.example/", gateAuth(xu)); got != 403 {
		t.Fatal("x task borrowed y target policy")
	}
	if got := gateRawRequest(t, yu, "CONNECT", "x.example:443", gateAuth(yu)); got != 403 {
		t.Fatal("y task borrowed x target policy")
	}
	if got := gateRawRequest(t, yu, "GET", "http://y.example/", gateAuth(xu)); got != 407 {
		t.Fatal("one task credential authorized another task on another port")
	}
	// A 3rd concurrent task multiplexes cleanly onto one of the 2 configured fixed ports with full policy isolation.
	zURL, zClose, err := z.startOutboundGate(context.Background())
	if err != nil {
		t.Fatalf("3rd concurrent task failed to multiplex on 2-port gateway: %v", err)
	}
	defer zClose()
	zu, _ := url.Parse(zURL)
	if zu.Host != xu.Host {
		t.Fatalf("expected round-robin 3rd task on %s, got %s", xu.Host, zu.Host)
	}
	if got := gateRawRequest(t, zu, "GET", "http://x.example/", gateAuth(zu)); got != 403 {
		t.Fatalf("z task on shared port borrowed x policy: got %d", got)
	}
	xClose()
	yClose()
	zClose()
	_ = e.Close()

	// Fresh engine where ports[0] is externally occupied must skip ports[0] and bind ports[1] without falling back to :0.
	occupiedPorts := testGatePorts(t, 2)
	occupied, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", fmt.Sprint(occupiedPorts[0])))
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	pSkip, err := newGatePortPool(occupiedPorts)
	if err != nil {
		t.Fatal(err)
	}
	eSkip := &Engine{gatePorts: pSkip}
	t.Cleanup(func() { _ = eSkip.Close() })
	u, closeGate, err := eSkip.startOutboundGate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(u)
	if parsed.Port() != fmt.Sprint(occupiedPorts[1]) {
		t.Fatalf("must skip occupied port without contacting its service: got %s want %d", parsed.Port(), occupiedPorts[1])
	}
	closeGate()
	ctx, cancel := context.WithCancel(context.Background())
	_, closeGate, err = eSkip.startOutboundGate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	closeGate()
	if eSkip.gatePorts.activeSessionCount() != 0 {
		t.Fatal("cancel leaked active gate session")
	}

	// Fresh engine where ALL configured ports are externally occupied must return error and never fall back to :0.
	busyPorts := testGatePorts(t, 2)
	busy0, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", fmt.Sprint(busyPorts[0])))
	if err != nil {
		t.Fatal(err)
	}
	defer busy0.Close()
	busy1, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", fmt.Sprint(busyPorts[1])))
	if err != nil {
		t.Fatal(err)
	}
	defer busy1.Close()
	pAllBusy, err := newGatePortPool(busyPorts)
	if err != nil {
		t.Fatal(err)
	}
	eAllBusy := &Engine{gatePorts: pAllBusy}
	t.Cleanup(func() { _ = eAllBusy.Close() })
	if _, _, err := eAllBusy.startOutboundGate(context.Background()); err == nil {
		t.Fatal("all occupied ports must fail rather than falling back to random :0")
	}
}

type countingGateResolver struct{ count atomic.Int64 }

func (r *countingGateResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	r.count.Add(1)
	return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
}

func gateAuth(u *url.URL) string {
	pass, _ := u.User.Password()
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(u.User.Username()+":"+pass))
}

func gateRawRequest(t *testing.T, u *url.URL, method, target, auth string) int {
	t.Helper()
	c, err := net.DialTimeout("tcp4", u.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	_, err = fmt.Fprintf(c, "%s %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: %s\r\nConnection: close\r\n\r\n", method, target, "public.example", auth)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func TestGateAuthenticationBeforePolicyAndExpiry(t *testing.T) {
	var hits atomic.Int64
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("credential forwarded to upstream")
		}
		b, _ := io.ReadAll(r.Body)
		_, _ = w.Write(b)
	}))
	defer up.Close()
	upURL, _ := url.Parse(up.URL)
	resolver := &countingGateResolver{}
	pool, _ := newGatePortPool(testGatePorts(t, 1))
	e := &Engine{
		maxStdoutBytes:      defaultMaxStdoutBytes,
		gatePorts:           pool,
		resolver:            resolver,
		allowedOutboundHost: func(h string) bool { return h == "public.example" },
		testHooks:           &gateTestHooks{dialAddr: func(netip.Addr, string) string { return upURL.Host }},
	}
	t.Cleanup(func() { _ = e.Close() })
	u, closeGate, err := e.startOutboundGate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer closeGate()
	parsed, _ := url.Parse(u)
	for _, method := range []string{"GET", "CONNECT"} {
		target := "http://public.example/"
		if method == "CONNECT" {
			target = "public.example:443"
		}
		for _, auth := range []string{"", "Basic d3Jvbmc6d3Jvbmc="} {
			if got := gateRawRequest(t, parsed, method, target, auth); got != 407 {
				t.Fatalf("unauthorized %s status %d", method, got)
			}
		}
	}
	if resolver.count.Load() != 0 || hits.Load() != 0 {
		t.Fatal("unauthenticated request reached DNS or upstream")
	}
	tr := &http.Transport{Proxy: http.ProxyURL(parsed)}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 2 * time.Second}
	resp, err := client.Post("http://public.example/post", "text/plain", strings.NewReader("exact request body"))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(b) != "exact request body" {
		t.Fatalf("authenticated HTTP body not preserved: status=%d body=%q", resp.StatusCode, string(b))
	}
	for _, target := range []string{"http://other.example/", "http://127.0.0.1/", "http://169.254.169.254/"} {
		if got := gateRawRequest(t, parsed, "GET", target, gateAuth(parsed)); got != 403 {
			t.Fatalf("policy bypass %s: %d", target, got)
		}
	}
	oldAuth := gateAuth(parsed)
	closeGate()
	u, nextClose, err := e.startOutboundGate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer nextClose()
	next, _ := url.Parse(u)
	if parsed.Host != next.Host {
		t.Fatal("test must actually reuse the fixed port")
	}
	if oldAuth == gateAuth(next) {
		t.Fatal("new task reused credential")
	}
	before := resolver.count.Load()
	if got := gateRawRequest(t, next, "GET", "http://public.example/", oldAuth); got != 407 {
		t.Fatal("old credential accepted")
	}
	if got := gateRawRequest(t, next, "CONNECT", "public.example:443", oldAuth); got != 407 {
		t.Fatal("old CONNECT credential accepted")
	}
	if resolver.count.Load() != before {
		t.Fatal("expired credential reached DNS")
	}
}

func TestGateCancelActiveTunnelBeforePortReuse(t *testing.T) {
	up, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer up.Close()
	upDone := make(chan struct{})
	go func() {
		defer close(upDone)
		c, err := up.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = io.Copy(c, c)
	}()
	pool, _ := newGatePortPool(testGatePorts(t, 1))
	e := &Engine{
		gatePorts:           pool,
		resolver:            &countingGateResolver{},
		allowedOutboundHost: func(h string) bool { return h == "public.example" },
		testHooks:           &gateTestHooks{dialAddr: func(netip.Addr, string) string { return up.Addr().String() }},
	}
	t.Cleanup(func() { _ = e.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	u, closeGate, err := e.startOutboundGate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer closeGate()
	parsed, _ := url.Parse(u)
	c, err := net.DialTimeout("tcp4", parsed.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = fmt.Fprintf(c, "CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\nProxy-Authorization: %s\r\n\r\n", gateAuth(parsed))
	reader := bufio.NewReader(c)
	resp, err := http.ReadResponse(reader, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatal("authenticated CONNECT not established")
	}
	_, _ = c.Write([]byte("x"))
	b, err := reader.ReadByte()
	if err != nil || b != 'x' {
		t.Fatal("CONNECT tunnel did not carry payload")
	}
	cancel()
	closeGate()
	_, err = reader.ReadByte()
	if err == nil {
		t.Fatal("cancel left tunnel open")
	}
	if nerr, ok := err.(net.Error); ok && nerr.Timeout() {
		t.Fatal("tunnel expired only by client timeout")
	}
	select {
	case <-upDone:
	case <-time.After(time.Second):
		t.Fatal("upstream tunnel remained open")
	}
	u, nextClose, err := e.startOutboundGate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer nextClose()
	next, _ := url.Parse(u)
	if next.Host != parsed.Host {
		t.Fatal("fixed tunnel port not reused")
	}
	if got := gateRawRequest(t, next, "CONNECT", "public.example:443", gateAuth(parsed)); got != 407 {
		t.Fatal("cancelled tunnel credential remained valid")
	}
}
