package api

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testEdgeKey = "synthetic-test-key-32-bytes-not-a-deployment-key"

// Keep the historical policy as an explicit fixture, not the production default.
func legacyAdmissionConfig() AdmissionConfig {
	c := DefaultAdmissionConfig()
	c.Parse = PoolConfig{
		ClientBurst:       4,
		ClientRPS:         12.0 / 60,
		GlobalBurst:       8,
		GlobalRPS:         1,
		ClientConcurrency: 1,
		GlobalConcurrency: 2,
	}
	c.SlowParse = PoolConfig{
		ClientBurst:       4,
		ClientRPS:         12.0 / 60,
		GlobalBurst:       8,
		GlobalRPS:         1,
		ClientConcurrency: 1,
		GlobalConcurrency: 2,
	}
	c.Relay = PoolConfig{
		ClientBurst:       12,
		ClientRPS:         1,
		GlobalBurst:       24,
		GlobalRPS:         2,
		ClientConcurrency: 2,
		GlobalConcurrency: 2,
	}
	c.MaxClients = 1024
	return c
}

func protected(t *testing.T, mode string, next http.Handler) *admission {
	t.Helper()
	key := ""
	if mode == "caddy" {
		key = testEdgeKey
	}
	entry, err := WithAdmissionConfig(next, nil, mode, key, legacyAdmissionConfig())
	if err != nil {
		t.Fatal(err)
	}
	return entry.(*admission)
}

func edgeRequest(path, ip string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set(edgeHeader, testEdgeKey)
	req.Header.Set(clientHeader, ip)
	return req
}
func call(entry http.Handler, req *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	entry.ServeHTTP(w, req)
	return w
}

func TestAdmissionRateAndContracts(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(edgeHeader) != "" || r.Header.Get(clientHeader) != "" {
			t.Error("hop-private header leaked downstream")
		}
		w.WriteHeader(200)
	})
	now := time.Unix(1000, 0)
	entry := protected(t, "caddy", next)
	entry.now = func() time.Time { return now }
	paths := []string{"/api/parse", "/api/resolve", "/api/parse", "/api/bilibili"}
	for _, path := range paths {
		if got := call(entry, edgeRequest(path, "::ffff:198.51.100.11")); got.Code != 200 {
			t.Fatalf("%s: %d", path, got.Code)
		}
	}
	check := func(path string, want int, message string) {
		t.Helper()
		w := call(entry, edgeRequest(path, "198.51.100.11"))
		if w.Code != 429 || w.Header().Get("Retry-After") != strconv.Itoa(want) || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %v", path, w.Code, w.Header())
		}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if path == "/api/short_videos" {
			if body["code"] != float64(429) || body["data"] != nil || body["msg"] != message {
				t.Fatal(body)
			}
		} else {
			err, ok := body["error"].(map[string]any)
			if !ok || body["code"] != "RATE_LIMITED" || body["schema_version"] != "1.0" || err["retry_after_seconds"] != float64(want) || err["retryable"] != true || err["message"] != message {
				t.Fatal(body)
			}
		}
	}
	check("/api/short_videos", 5, "解析请求过于频繁，请稍后重试")
	now = now.Add(1500 * time.Millisecond)
	check("/api/resolve", 4, "解析请求过于频繁，请稍后重试")
	if w := call(entry, edgeRequest("/api/media/weibo", "198.51.100.11")); w.Code != 200 {
		t.Fatalf("public exhausted relay: %d", w.Code)
	}
	now = now.Add(3500 * time.Millisecond)
	if w := call(entry, edgeRequest("/api/platforms", "198.51.100.11")); w.Code != 200 {
		t.Fatal(w.Code)
	}
	// Encoded or unknown paths are dispatched as-is, not charged to either pool.
	if w := call(entry, edgeRequest("/api/%70arse", "bad IP")); w.Code != 200 {
		t.Fatal(w.Code)
	}
}

func TestAdmissionGlobalRateAndIPGroups(t *testing.T) {
	for _, tc := range []struct {
		name     string
		capacity int
		step     time.Duration
		path     string
	}{
		{"public", 8, time.Second, "/api/parse"}, {"relay", 24, time.Second / 2, "/api/media/weibo"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Unix(1000, 0)
			entry := protected(t, "caddy", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
			entry.now = func() time.Time { return now }
			for i := 0; i < tc.capacity; i++ {
				if w := call(entry, edgeRequest(tc.path, fmt.Sprintf("192.0.2.%d", i+1))); w.Code != 204 {
					t.Fatal(w.Code)
				}
			}
			if w := call(entry, edgeRequest(tc.path, "192.0.2.99")); w.Code != 429 || w.Header().Get("Retry-After") != "1" {
				t.Fatal(w.Code, w.Header())
			}
			now = now.Add(tc.step)
			if w := call(entry, edgeRequest(tc.path, "192.0.2.99")); w.Code != 204 {
				t.Fatal(w.Code)
			}
		})
	}
	entry := protected(t, "caddy", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	entry.now = func() time.Time { return time.Unix(1000, 0) }
	for i := 1; i <= 12; i++ {
		if w := call(entry, edgeRequest("/api/media/weibo", fmt.Sprintf("2001:db8:1:2::%x", i))); w.Code != 204 {
			t.Fatal(w.Code)
		}
	}
	req := edgeRequest("/api/media/weibo", "2001:db8:1:2::aa")
	if w := call(entry, req.Clone(req.Context())); w.Code != 429 || !strings.Contains(w.Body.String(), "媒体请求过于频繁") {
		t.Fatal(w.Body.String())
	}
	req.Method = http.MethodHead
	if w := call(entry, req); w.Code != 429 || w.Body.Len() != 0 || w.Header().Get("Retry-After") != "1" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call(entry, edgeRequest("/api/media/weibo", "2001:db8:1:3::1")); w.Code != 204 {
		t.Fatal(w.Code)
	}
}

func TestAdmissionClientTrust(t *testing.T) {
	for _, tc := range []struct{ mode, key string }{{"caddy", ""}, {"caddy", "too-short"}, {"caddy", testEdgeKey + "\n"}, {"auto", testEdgeKey}, {"direct", testEdgeKey}} {
		if _, err := WithAdmission(nil, nil, tc.mode, tc.key); err == nil {
			t.Fatal("invalid identity configuration accepted")
		}
	}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	entry := protected(t, "caddy", next)
	for _, change := range []func(*http.Request){
		func(r *http.Request) { r.RemoteAddr = "192.0.2.1:10" },
		func(r *http.Request) { r.Header.Del(edgeHeader) },
		func(r *http.Request) { r.Header.Set(edgeHeader, "incorrect") },
		func(r *http.Request) { r.Header.Add(edgeHeader, testEdgeKey) },
		func(r *http.Request) { r.Header.Add(clientHeader, "192.0.2.2") },
		func(r *http.Request) { r.Header.Del(clientHeader) },
		func(r *http.Request) { r.Header.Set(clientHeader, "192.0.2.1, 192.0.2.2") },
		func(r *http.Request) { r.Header.Set(clientHeader, "fe80::1%eth0") },
	} {
		req := edgeRequest("/api/parse", "198.51.100.2")
		change(req)
		req.Header.Set("X-Forwarded-For", "198.51.100.2")
		w := call(entry, req)
		if w.Code != 503 || w.Header().Get("Retry-After") != "30" || !strings.Contains(w.Body.String(), "SERVICE_NOT_CONFIGURED") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, mode := range []string{"direct", "caddy"} {
		entry := protected(t, mode, next)
		entry.now = func() time.Time { return time.Unix(1000, 0) }
		for i := 0; i < 5; i++ {
			req := edgeRequest("/api/parse", "203.0.113.6")
			if mode == "direct" {
				req.Header.Del(edgeHeader)
				req.Header.Del(clientHeader)
			}
			req.Header.Set("X-Forwarded-For", fmt.Sprintf("192.0.2.%d", i))
			req.Header.Set("X-Real-IP", fmt.Sprintf("198.51.100.%d", i))
			want := 204
			if i == 4 {
				want = 429
			}
			if got := call(entry, req); got.Code != want {
				t.Fatalf("%s: %d", mode, got.Code)
			}
		}
	}
	if w := call(protected(t, "direct", next), edgeRequest("/api/parse", "192.0.2.1")); w.Code != 503 {
		t.Fatal("misconfigured Caddy silently collapsed identities")
	}
}

func TestAdmissionFullStreamLeaseAndRelease(t *testing.T) {
	finished := make(chan struct{}, 4)
	entry := protected(t, "caddy", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Has("slow") {
			w.Write([]byte("first"))
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		} else if r.URL.Query().Has("error") {
			w.WriteHeader(http.StatusBadGateway)
		} else {
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entry.ServeHTTP(w, r)
		if r.URL.Query().Has("slow") {
			finished <- struct{}{}
		}
	}))
	defer s.Close()
	send := func(path, ip string, want int) *http.Response {
		t.Helper()
		req, err := http.NewRequest("GET", s.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set(edgeHeader, testEdgeKey)
		req.Header.Set(clientHeader, ip)
		resp, err := s.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != want {
			resp.Body.Close()
			t.Fatalf("%s: got %d want %d", path, resp.StatusCode, want)
		}
		return resp
	}
	check := func(path, ip string, want int) {
		resp := send(path, ip, want)
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
	stop := func(resp *http.Response) {
		resp.Body.Close()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Fatal("client disconnect did not release lease")
		}
	}
	hold := func(path, ip string) *http.Response {
		r := send(path+"?slow", ip, 200)
		t.Cleanup(func() { r.Body.Close() })
		return r
	}
	p1 := hold("/api/parse", "192.0.2.1")
	defer p1.Body.Close()
	check("/api/resolve", "192.0.2.1", 429)
	p2 := hold("/api/resolve", "192.0.2.2")
	defer p2.Body.Close()
	check("/api/resolve", "192.0.2.3", 429)
	m1 := hold("/api/media/weibo", "192.0.2.1")
	defer m1.Body.Close()
	m2 := hold("/api/media/weibo", "192.0.2.1")
	defer m2.Body.Close()
	check("/api/media/weibo", "192.0.2.2", 429)
	stop(m1)
	stop(p1)
	check("/api/resolve?error", "192.0.2.1", 502)
	check("/api/parse", "192.0.2.1", 204)
	check("/api/media/weibo", "192.0.2.1", 204)
	stop(m2)
	stop(p2)
}

func TestAdmissionBoundedClientsAndIdleExpiry(t *testing.T) {
	now := time.Unix(1000, 0)
	p := newPool(12, 1, 24, 2, 2, 2, 1024)
	for i := 0; i < 1024; i++ {
		release, retry := p.acquire(netip.AddrFrom4([4]byte{192, 0, byte(i >> 8), byte(i)}), now)
		if retry != 0 {
			t.Fatal(retry)
		}
		release()
		now = now.Add(time.Second / 2)
	}
	ip := netip.MustParseAddr("198.51.100.5")
	if release, retry := p.acquire(ip, now); release == nil || retry != 0 {
		t.Fatal("idle full buckets should be safely reclaimed", retry)
	} else {
		release()
	}
	if len(p.clients) > 1024 {
		t.Fatal("client table exceeded capacity")
	}
	if release, retry := p.acquire(ip, now.Add(10*time.Minute)); release == nil || retry != 0 {
		t.Fatal(retry)
	} else {
		release()
	}
}
func TestPullControlIngressIsolation(t *testing.T) {
	entered := make(chan struct{})
	unblock := make(chan struct{})
	defer close(unblock)
	normal := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if classify(r.URL.EscapedPath()) == unknown {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	control := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(edgeHeader) != "" || r.Header.Get(clientHeader) != "" {
			t.Error("forwarded hop credentials into control handler")
		}
		if r.URL.EscapedPath() == shresolver.ClaimPath {
			close(entered)
			select {
			case <-r.Context().Done():
			case <-unblock:
			}
		}
		w.WriteHeader(http.StatusNoContent)
	})
	h, err := WithAdmissionConfig(normal, control, "caddy", testEdgeKey, legacyAdmissionConfig())
	if err != nil {
		t.Fatal(err)
	}
	from := "203.0.113.4"
	r := edgeRequest(shresolver.ClaimPath, from)
	r.Header.Del(edgeHeader)
	if w := call(h, r); w.Code != 503 {
		t.Fatalf("untrusted edge reached control: %d", w.Code)
	}
	if w := call(h, edgeRequest("/internal/shanghai/%63laim", from)); w.Code != 404 {
		t.Fatalf("noncanonical path reached control: %d", w.Code)
	}

	start := edgeRequest(shresolver.ClaimPath, from)
	ctx, cancel := context.WithCancel(start.Context())
	defer cancel()
	done := make(chan int, 1)
	go func() { done <- call(h, start.WithContext(ctx)).Code }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("control request did not reach handler")
	}
	for _, path := range []string{"/api/parse", "/api/resolve", "/api/platforms", "/api/bilibili", "/api/parse", "/api/media/weibo"} {
		if w := call(h, edgeRequest(path, from)); w.Code != 200 {
			t.Fatalf("waiting control poll affected %s: %d", path, w.Code)
		}
	}
	if w := call(h, edgeRequest("/api/parse", from)); w.Code != 429 {
		t.Fatalf("expected exhausted user tokens: %d", w.Code)
	}
	if w := call(h, edgeRequest(shresolver.ResultPath, from)); w.Code != 204 {
		t.Fatalf("parse quota blocked result: %d", w.Code)
	}
	cancel()
	if code := <-done; code != 204 {
		t.Fatalf("claim: %d", code)
	}
}

func TestFastAndSlowPoolClassificationAndIsolation(t *testing.T) {
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []unified.Object{catalog.XPlatform(), catalog.YouTubePlatform(), catalog.InstagramPlatform()} {
		if err := c.Register(p); err != nil {
			t.Fatal(err)
		}
	}
	specs, err := ytgeneric.ParseSitesEnv("facebook,tumblr,dailymotion")
	if err != nil {
		t.Fatal(err)
	}
	for _, spec := range specs {
		if err := c.Register(spec.CatalogEntry()); err != nil {
			t.Fatal(err)
		}
	}

	okAdapter := AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
		return makeSyntheticEnvelope(c.PlatformForURL(src), src, now, ""), nil
	})
	adapters := make(map[string]Adapter)
	for _, id := range []string{
		"douyin", "bilibili", "toutiao", "kuaishou", "pipixia", "pipigx", "zuiyou", "xiaohongshu",
		"x", "youtube", "instagram", "facebook", "tumblr", "dailymotion",
	} {
		adapters[id] = okAdapter
	}
	h, err := NewWithCacheConfig(c, adapters, func() time.Time { return time.Unix(1793448000, 0) }, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}

	cfg := DefaultAdmissionConfig()
	cfg.SlowParse.GlobalConcurrency = 1
	cfg.SlowParse.QueueWait = 0
	cfg.SlowParse.QueueSize = 0
	entry, err := WithAdmissionConfig(h, nil, "caddy", testEdgeKey, cfg)
	if err != nil {
		t.Fatal(err)
	}
	adm := entry.(*admission)

	// Saturate the single SlowParse slot directly.
	relSlow, retry := adm.slow.acquire(netip.MustParseAddr("198.51.100.250"), time.Now())
	if retry != 0 {
		t.Fatal(retry)
	}
	defer relSlow()

	// All 6 yt-dlp slow platforms hit 429 on SlowParse when saturated.
	slowURLs := []string{
		"https://x.com/user/status/123456",
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		"https://www.instagram.com/reel/C123456/",
		"https://www.facebook.com/watch/?v=123456",
		"https://demo.tumblr.com/post/123456",
		"https://www.dailymotion.com/video/x8t9abc",
	}
	for i, u := range slowURLs {
		ip := fmt.Sprintf("198.51.100.%d", i+1)
		w := call(entry, edgeRequest("/api/parse?schema_version=1.0&url="+url.QueryEscape(u), ip))
		if w.Code != http.StatusTooManyRequests {
			t.Fatalf("expected slow URL %s to use SlowParse and hit 429, got %d", u, w.Code)
		}
	}

	// Pure-Go platforms, legacy routes, and malformed/unsupported /api/parse inputs
	// route to Fast Pool (Parse) and never get blocked by SlowParse saturation!
	fastURLs := []string{
		"https://www.douyin.com/video/123",
		"https://www.bilibili.com/video/BV1xx411c7mD",
		"https://www.toutiao.com/video/123/",
		"https://www.kuaishou.com/short-video/3x123",
		"https://h5.pipix.com/item/123",
		"https://h5.pipigx.com/pp/post/123",
		"https://share.xiaochuankeji.cn/hybrid/share/post?pid=123",
		"https://www.xiaohongshu.com/explore/123",
	}
	for i, u := range fastURLs {
		ip := fmt.Sprintf("203.0.113.%d", i+1)
		w := call(entry, edgeRequest("/api/parse?schema_version=1.0&url="+url.QueryEscape(u), ip))
		if w.Code != http.StatusOK {
			t.Fatalf("expected fast URL %s to succeed on Fast Pool while SlowParse full, got %d: %s", u, w.Code, w.Body.String())
		}
	}
	for i, bad := range []string{
		"/api/parse?schema_version=1.0",
		"/api/parse?schema_version=1.0&url=not-a-url",
		"/api/parse?schema_version=1.0&url=https://unsupported.example.com/v/1",
		"/api/parse?schema_version=1.0&url[]=https://x.com/user/status/123",
		"/api/douyin",
	} {
		ip := fmt.Sprintf("203.0.113.%d", 100+i)
		w := call(entry, edgeRequest(bad, ip))
		if w.Code == http.StatusTooManyRequests {
			t.Fatalf("malformed/legacy request %q must use Fast Pool, not SlowParse (got 429)", bad)
		}
	}
}

func TestBoundedWaitQueueWakeupTimeoutOverflowAndPerIPGuard(t *testing.T) {
	holdSlot := make(chan struct{})
	slot1Entered := make(chan struct{})
	var orderMu sync.Mutex
	var executionOrder []string

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tag := r.URL.Query().Get("tag")
		orderMu.Lock()
		executionOrder = append(executionOrder, tag)
		orderMu.Unlock()
		if tag == "holder" {
			close(slot1Entered)
			<-holdSlot
		}
		w.WriteHeader(http.StatusOK)
	})

	cfg := DefaultAdmissionConfig()
	cfg.Parse = PoolConfig{
		ClientBurst:       4,
		ClientRPS:         1,
		GlobalBurst:       32,
		GlobalRPS:         20,
		ClientConcurrency: 1,
		GlobalConcurrency: 1,
		QueueWait:         120 * time.Millisecond,
		QueueSize:         2,
	}
	entry, err := WithAdmissionConfig(next, nil, "caddy", testEdgeKey, cfg)
	if err != nil {
		t.Fatal(err)
	}
	adm := entry.(*admission)

	// 1. Holder occupies the single GlobalConcurrency=1 slot.
	var holderWG sync.WaitGroup
	holderWG.Add(1)
	go func() {
		defer holderWG.Done()
		if w := call(entry, edgeRequest("/api/parse?tag=holder", "192.0.2.1")); w.Code != http.StatusOK {
			t.Errorf("holder status=%d", w.Code)
		}
	}()
	<-slot1Entered

	// 2. Queue 2 distinct clients (fills QueueSize=2 in FIFO order: q1 then q2).
	q1Done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		q1Done <- call(entry, edgeRequest("/api/parse?tag=q1", "192.0.2.2"))
	}()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		adm.public.mu.Lock()
		qLen := adm.public.waiters.Len()
		adm.public.mu.Unlock()
		if qLen == 1 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}

	// Same IP ("192.0.2.2") sending a 2nd concurrent request while queued must be rejected immediately!
	tSame := time.Now()
	wSame := call(entry, edgeRequest("/api/parse?tag=same-ip", "192.0.2.2"))
	if wSame.Code != http.StatusTooManyRequests || time.Since(tSame) > 40*time.Millisecond {
		t.Fatalf("same-IP concurrent request while queued must fail immediately with 429, got code=%d elapsed=%s", wSame.Code, time.Since(tSame))
	}

	q2Done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		q2Done <- call(entry, edgeRequest("/api/parse?tag=q2", "192.0.2.3"))
	}()
	for time.Now().Before(deadline) {
		adm.public.mu.Lock()
		qLen := adm.public.waiters.Len()
		adm.public.mu.Unlock()
		if qLen == 2 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}

	// 3. Queue overflow (3rd waiter when QueueSize=2) rejects immediately without waiting QueueWait.
	tOverflow := time.Now()
	wOverflow := call(entry, edgeRequest("/api/parse?tag=overflow", "192.0.2.4"))
	if wOverflow.Code != http.StatusTooManyRequests || wOverflow.Header().Get("Retry-After") != "1" || time.Since(tOverflow) > 40*time.Millisecond {
		t.Fatalf("overflow request must reject immediately with 429 Retry-After:1, got code=%d elapsed=%s", wOverflow.Code, time.Since(tOverflow))
	}

	// 4. Release holder within QueueWait -> q1 and q2 wake in FIFO order and both return 200 OK.
	close(holdSlot)
	holderWG.Wait()
	if w1 := <-q1Done; w1.Code != http.StatusOK {
		t.Fatalf("q1 expected 200 OK after wakeup, got %d", w1.Code)
	}
	if w2 := <-q2Done; w2.Code != http.StatusOK {
		t.Fatalf("q2 expected 200 OK after wakeup, got %d", w2.Code)
	}
	orderMu.Lock()
	gotOrder := strings.Join(executionOrder, ",")
	orderMu.Unlock()
	if gotOrder != "holder,q1,q2" {
		t.Fatalf("expected FIFO execution order holder,q1,q2, got %q", gotOrder)
	}

	// 5. Queue timeout returns 429 RATE_LIMITED with Retry-After and retry_after_seconds >= 1, freeing client & queue slots.
	relBlock, retry := adm.public.acquire(netip.MustParseAddr("192.0.2.50"), time.Now())
	if retry != 0 {
		t.Fatal(retry)
	}
	tTimeout := time.Now()
	wTimeout := call(entry, edgeRequest("/api/parse?tag=timeout", "192.0.2.51"))
	elapsedTimeout := time.Since(tTimeout)
	if wTimeout.Code != http.StatusTooManyRequests || wTimeout.Header().Get("Retry-After") != "1" || elapsedTimeout < 90*time.Millisecond {
		t.Fatalf("expected queue timeout 429 after ~120ms, got code=%d retry=%q elapsed=%s", wTimeout.Code, wTimeout.Header().Get("Retry-After"), elapsedTimeout)
	}
	var errPayload map[string]any
	if err := json.Unmarshal(wTimeout.Body.Bytes(), &errPayload); err != nil {
		t.Fatal(err)
	}
	errMap, _ := errPayload["error"].(map[string]any)
	if errPayload["code"] != "RATE_LIMITED" || errMap["retry_after_seconds"] != float64(1) {
		t.Fatalf("unexpected queue timeout error payload: %v", errPayload)
	}
	relBlock()

	adm.public.mu.Lock()
	defer adm.public.mu.Unlock()
	if adm.public.active != 0 || adm.public.waiters.Len() != 0 {
		t.Fatalf("pool leaked state after timeout: active=%d waiters=%d", adm.public.active, adm.public.waiters.Len())
	}
	for ip, st := range adm.public.clients {
		if st.active != 0 {
			t.Fatalf("client %s leaked active=%d", ip, st.active)
		}
	}
}

func TestWaitQueueContextCancellationAndRaceZeroSlotLeaks(t *testing.T) {
	var handlerHits atomic.Int64
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerHits.Add(1)
		time.Sleep(12 * time.Millisecond)
		w.WriteHeader(http.StatusNoContent)
	})
	cfg := DefaultAdmissionConfig()
	cfg.Parse = PoolConfig{
		ClientBurst:       10,
		ClientRPS:         100,
		GlobalBurst:       500,
		GlobalRPS:         500,
		ClientConcurrency: 1,
		GlobalConcurrency: 3,
		QueueWait:         40 * time.Millisecond,
		QueueSize:         16,
	}
	entry, err := WithAdmissionConfig(next, nil, "caddy", testEdgeKey, cfg)
	if err != nil {
		t.Fatal(err)
	}
	adm := entry.(*admission)

	// 1. Explicit cancellation while queued frees client & queue slot immediately without invoking next.
	var releases []func()
	for i := 0; i < 3; i++ {
		rel, retry := adm.public.acquire(netip.MustParseAddr(fmt.Sprintf("198.51.100.%d", i+1)), time.Now())
		if retry != 0 {
			t.Fatal(retry)
		}
		releases = append(releases, rel)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancelDone := make(chan struct{})
	go func() {
		defer close(cancelDone)
		req := edgeRequest("/api/parse", "198.51.100.99").WithContext(ctx)
		call(entry, req)
	}()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		adm.public.mu.Lock()
		qLen := adm.public.waiters.Len()
		adm.public.mu.Unlock()
		if qLen == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-cancelDone:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("canceled queued request did not exit promptly")
	}
	if handlerHits.Load() != 0 {
		t.Fatalf("canceled queued request reached handler: hits=%d", handlerHits.Load())
	}
	for _, rel := range releases {
		rel()
	}

	// 2. High-contention concurrent acquire + release + timeout + random ctx cancellation under -race.
	var wg sync.WaitGroup
	for i := 0; i < 120; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ip := fmt.Sprintf("203.0.113.%d", (idx%200)+1)
			req := edgeRequest("/api/parse", ip)
			switch idx % 4 {
			case 0:
				rctx, rcancel := context.WithTimeout(context.Background(), time.Duration(idx%18)*time.Millisecond)
				defer rcancel()
				req = req.WithContext(rctx)
			case 1:
				rctx, rcancel := context.WithCancel(context.Background())
				go func() {
					time.Sleep(time.Duration(idx%15) * time.Millisecond)
					rcancel()
				}()
				req = req.WithContext(rctx)
			}
			call(entry, req)
		}(i)
	}
	wg.Wait()

	adm.public.mu.Lock()
	defer adm.public.mu.Unlock()
	if adm.public.active != 0 {
		t.Fatalf("global active slot leak after concurrent race: got %d, want 0", adm.public.active)
	}
	if adm.public.waiters.Len() != 0 {
		t.Fatalf("waiters queue not empty after concurrent race: got %d", adm.public.waiters.Len())
	}
	if adm.public.idle.Len() != len(adm.public.clients) {
		t.Fatalf("idle LRU count (%d) != client map size (%d)", adm.public.idle.Len(), len(adm.public.clients))
	}
	for ip, st := range adm.public.clients {
		if st.active != 0 || st.idleElem == nil {
			t.Fatalf("client %s corrupted state: active=%d idleElem=%v", ip, st.active, st.idleElem)
		}
	}
}
