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

type deadlineRecordingWriter struct {
	*httptest.ResponseRecorder
	mu        sync.Mutex
	deadlines []time.Time
}

func (w *deadlineRecordingWriter) SetWriteDeadline(t time.Time) error {
	w.mu.Lock()
	w.deadlines = append(w.deadlines, t)
	w.mu.Unlock()
	return nil
}

func (w *deadlineRecordingWriter) snapshot() []time.Time {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]time.Time(nil), w.deadlines...)
}

type stubParseClassifierHandler struct {
	http.HandlerFunc
}

func (s stubParseClassifierHandler) ParsePlatform(rawQuery string) string {
	v, _ := url.ParseQuery(rawQuery)
	if strings.Contains(v.Get("url"), "x.com") {
		return "x"
	}
	return "douyin"
}

func TestAnonymousQueuedPoolsExtendAndResetWriteDeadline(t *testing.T) {
	// 1. Verify exact SetWriteDeadline extension before queue wait and reset upon grant
	//    on anonymous queued pools (both slow and public), while leaving queueWait==0 pools untouched.
	cfg := DefaultAdmissionConfig()
	cfg.SlowParse.GlobalConcurrency = 1
	cfg.SlowParse.ClientConcurrency = 1
	cfg.SlowParse.QueueWait = 12 * time.Second
	cfg.SlowParse.QueueSize = 4
	cfg.SlowParse.ClientBurst = 10
	cfg.SlowParse.ClientRPS = 10
	cfg.SlowParse.GlobalBurst = 10
	cfg.SlowParse.GlobalRPS = 10

	cfg.Parse.GlobalConcurrency = 1
	cfg.Parse.ClientConcurrency = 1
	cfg.Parse.QueueWait = 8 * time.Second
	cfg.Parse.QueueSize = 4
	cfg.Parse.ClientBurst = 10
	cfg.Parse.ClientRPS = 10
	cfg.Parse.GlobalBurst = 10
	cfg.Parse.GlobalRPS = 10

	var inHandlerDeadlines []time.Time
	next := stubParseClassifierHandler{
		HandlerFunc: func(w http.ResponseWriter, r *http.Request) {
			if rw, ok := w.(*deadlineRecordingWriter); ok {
				inHandlerDeadlines = rw.snapshot()
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		},
	}
	entry, err := WithAdmissionConfig(next, nil, "caddy", testEdgeKey, cfg)
	if err != nil {
		t.Fatal(err)
	}
	adm := entry.(*admission)

	// (a) Slow pool queued request: pre-queue deadline ~ now + 12s + 50s, post-grant reset ~ now + 50s.
	relSlow, retry := adm.slow.acquire(netip.MustParseAddr("198.51.100.1"), time.Now())
	if retry != 0 {
		t.Fatalf("unexpected retry holding slow slot: %d", retry)
	}
	slowRW := &deadlineRecordingWriter{ResponseRecorder: httptest.NewRecorder()}
	slowReq := edgeRequest("/api/parse?schema_version=1.0&url=https%3A%2F%2Fx.com%2Fi%2Fstatus%2F1", "198.51.100.2")
	beforeEnqueue := time.Now()
	slowDone := make(chan struct{})
	go func() {
		defer close(slowDone)
		entry.ServeHTTP(slowRW, slowReq)
	}()

	deadlineWait := time.Now().Add(time.Second)
	for time.Now().Before(deadlineWait) {
		adm.slow.mu.Lock()
		waiting := adm.slow.waiters.Len()
		adm.slow.mu.Unlock()
		if waiting == 1 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	preGrant := slowRW.snapshot()
	if len(preGrant) != 1 {
		relSlow()
		<-slowDone
		t.Fatalf("expected exactly 1 SetWriteDeadline call before queue wait, got %d (%v)", len(preGrant), preGrant)
	}
	minExtended := beforeEnqueue.Add(cfg.SlowParse.QueueWait + serverWriteWindow - 200*time.Millisecond)
	maxExtended := time.Now().Add(cfg.SlowParse.QueueWait + serverWriteWindow + 200*time.Millisecond)
	if preGrant[0].Before(minExtended) || preGrant[0].After(maxExtended) {
		relSlow()
		<-slowDone
		t.Fatalf("pre-queue deadline %v outside expected [%v, %v]", preGrant[0], minExtended, maxExtended)
	}

	beforeGrant := time.Now()
	relSlow()
	<-slowDone
	afterGrant := time.Now()
	if slowRW.Code != http.StatusOK || len(inHandlerDeadlines) != 2 {
		t.Fatalf("queued slow request status=%d deadlines=%v, want 200 and 2 deadline updates", slowRW.Code, inHandlerDeadlines)
	}
	minReset := beforeGrant.Add(serverWriteWindow - 200*time.Millisecond)
	maxReset := afterGrant.Add(serverWriteWindow + 200*time.Millisecond)
	if inHandlerDeadlines[1].Before(minReset) || inHandlerDeadlines[1].After(maxReset) || !inHandlerDeadlines[1].Before(inHandlerDeadlines[0]) {
		t.Fatalf("post-grant reset deadline %v not reset to serverWriteWindow [%v, %v] (pre-queue=%v)", inHandlerDeadlines[1], minReset, maxReset, inHandlerDeadlines[0])
	}

	// (b) Public pool queued request: pre-queue deadline ~ now + 8s + 50s, post-grant reset ~ now + 50s.
	inHandlerDeadlines = nil
	pubRW := &deadlineRecordingWriter{ResponseRecorder: httptest.NewRecorder()}
	pubReq := edgeRequest("/api/parse?schema_version=1.0&url=https%3A%2F%2Fwww.douyin.com%2Fvideo%2F1", "198.51.100.3")
	t0 := time.Now()
	entry.ServeHTTP(pubRW, pubReq)
	if pubRW.Code != http.StatusOK || len(inHandlerDeadlines) != 2 {
		t.Fatalf("public queued pool status=%d deadlines=%v, want 200 and 2 deadline updates", pubRW.Code, inHandlerDeadlines)
	}
	if inHandlerDeadlines[0].Sub(inHandlerDeadlines[1]) < cfg.Parse.QueueWait-500*time.Millisecond || inHandlerDeadlines[1].Sub(t0) < serverWriteWindow-500*time.Millisecond {
		t.Fatalf("unexpected public pool deadlines: %v", inHandlerDeadlines)
	}

	// (c) Unqueued pools (QueueWait == 0, e.g. catalog and relay) do not call SetWriteDeadline.
	for _, unqueuedPath := range []string{"/api/platforms?schema_version=1.0", "/api/media/weibo?ticket=abc"} {
		rw := &deadlineRecordingWriter{ResponseRecorder: httptest.NewRecorder()}
		entry.ServeHTTP(rw, edgeRequest(unqueuedPath, "198.51.100.4"))
		if got := rw.snapshot(); len(got) != 0 {
			t.Fatalf("unqueued path %s unexpectedly called SetWriteDeadline: %v", unqueuedPath, got)
		}
	}

	// 2. Real TCP server with tight WriteTimeout (40ms): anonymous queued slow request waiting 85ms
	//    succeeds because admission extends WriteDeadline across budget.queueWait.
	tcpCfg := DefaultAdmissionConfig()
	tcpCfg.SlowParse.GlobalConcurrency = 1
	tcpCfg.SlowParse.ClientConcurrency = 1
	tcpCfg.SlowParse.QueueWait = 250 * time.Millisecond
	tcpCfg.SlowParse.QueueSize = 4
	tcpEntry, err := WithAdmissionConfig(stubParseClassifierHandler{
		HandlerFunc: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		},
	}, nil, "caddy", testEdgeKey, tcpCfg)
	if err != nil {
		t.Fatal(err)
	}
	tcpAdm := tcpEntry.(*admission)
	relHold, holdRetry := tcpAdm.slow.acquire(netip.MustParseAddr("198.51.100.90"), time.Now())
	if holdRetry != 0 {
		t.Fatalf("hold slow slot failed: %d", holdRetry)
	}
	ts := httptest.NewUnstartedServer(tcpEntry)
	ts.Config.WriteTimeout = 40 * time.Millisecond
	ts.Start()
	defer ts.Close()
	go func() {
		time.Sleep(85 * time.Millisecond)
		relHold()
	}()
	tcpReq, err := http.NewRequest(http.MethodGet, ts.URL+"/api/parse?schema_version=1.0&url=https%3A%2F%2Fx.com%2Fi%2Fstatus%2F99", nil)
	if err != nil {
		t.Fatal(err)
	}
	tcpReq.Header.Set(edgeHeader, testEdgeKey)
	tcpReq.Header.Set(clientHeader, "198.51.100.91")
	tcpResp, err := ts.Client().Do(tcpReq)
	if err != nil {
		t.Fatalf("queued anonymous slow request over TCP failed (WriteDeadline not extended): %v", err)
	}
	tcpBody, _ := io.ReadAll(tcpResp.Body)
	tcpResp.Body.Close()
	if tcpResp.StatusCode != http.StatusOK || string(tcpBody) != `{"ok":true}` {
		t.Fatalf("unexpected TCP response: status=%d body=%q", tcpResp.StatusCode, string(tcpBody))
	}
}

type readDeadlineFlusherRecorder struct {
	*httptest.ResponseRecorder
	readDeadlineSet bool
	flushed         bool
}

func (w *readDeadlineFlusherRecorder) SetReadDeadline(_ time.Time) error {
	w.readDeadlineSet = true
	return nil
}

func (w *readDeadlineFlusherRecorder) Flush() {
	w.flushed = true
	w.ResponseRecorder.Flush()
}

func TestPullControlChargesOnly401AndExemptsValidWorkerPolls(t *testing.T) {
	const pullToken = "shanghai-pull-test-token-40-bytes-fixture"
	broker, err := shresolver.NewPullBroker(pullToken)
	if err != nil {
		t.Fatal(err)
	}

	var controlHits atomic.Int64
	var controllerSawReadDeadline atomic.Bool
	var controllerSawFlusher atomic.Bool
	control := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		controlHits.Add(1)
		if err := http.NewResponseController(w).SetReadDeadline(time.Now().Add(time.Second)); err == nil {
			controllerSawReadDeadline.Store(true)
		}
		broker.ServeHTTP(w, r)
		if flusher, ok := w.(http.Flusher); ok {
			controllerSawFlusher.Store(true)
			flusher.Flush()
		}
	})
	normal := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	now := time.Unix(2_000_000, 0)
	h, err := WithAdmissionConfig(normal, control, "caddy", testEdgeKey, legacyAdmissionConfig())
	if err != nil {
		t.Fatal(err)
	}
	adm := h.(*admission)
	adm.now = func() time.Time { return now }

	sendControl := func(ctx context.Context, path, ip, authHeader string, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set(edgeHeader, testEdgeKey)
		req.Header.Set(clientHeader, ip)
		if authHeader != "" {
			req.Header.Set("Authorization", authHeader)
		}
		rec := &readDeadlineFlusherRecorder{ResponseRecorder: httptest.NewRecorder()}
		h.ServeHTTP(rec, req)
		return rec.ResponseRecorder
	}

	// 1. Verify ResponseController Unwrap() + http.Flusher passthrough and 0-token cost
	//    across 200 valid non-401 control requests at a frozen timestamp (zero token refill).
	workerIP := "203.0.113.10"
	canceledCtx, cancel := context.WithCancel(t.Context())
	cancel()
	for i := 0; i < 100; i++ {
		if w := sendControl(canceledCtx, shresolver.ClaimPath, workerIP, "Bearer "+pullToken, ""); w.Code != http.StatusNoContent {
			t.Fatalf("valid claim #%d unexpectedly returned %d", i+1, w.Code)
		}
		if w := sendControl(t.Context(), shresolver.ResultPath, workerIP, "Bearer "+pullToken, "{}"); w.Code != http.StatusBadRequest {
			t.Fatalf("authenticated non-401 result #%d unexpectedly returned %d", i+1, w.Code)
		}
	}
	if !controllerSawFlusher.Load() || !controllerSawReadDeadline.Load() {
		t.Fatalf("controlStatusWriter broke Flusher (%v) or ResponseController Unwrap (%v)", controllerSawFlusher.Load(), controllerSawReadDeadline.Load())
	}
	adm.controlAuth.mu.Lock()
	workerTracked := len(adm.controlAuth.clients)
	adm.controlAuth.mu.Unlock()
	if workerTracked != 0 {
		t.Fatalf("valid control requests must consume 0 tokens and allocate 0 abuse entries, got %d", workerTracked)
	}

	// 2. Brute-force 401 callers consume 1 token per 401 up to ClientBurst (4),
	//    after which subsequent attempts are rejected with 429 BEFORE hitting pullControl.
	attackerIP := "203.0.113.77"
	hitsBefore := controlHits.Load()
	badCreds := []string{"", "Bearer wrong", "Basic dXNlcjpwYXNz", "Bearer " + strings.Repeat("z", 64)}
	for i, cred := range badCreds {
		target := shresolver.ClaimPath
		if i%2 == 1 {
			target = shresolver.ResultPath
		}
		w := sendControl(t.Context(), target, attackerIP, cred, "")
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("bad attempt #%d expected 401, got %d", i+1, w.Code)
		}
	}
	if gotHits := controlHits.Load() - hitsBefore; gotHits != 4 {
		t.Fatalf("expected 4 control hits for 4 initial 401s, got %d", gotHits)
	}

	for i := 0; i < 20; i++ {
		w := sendControl(t.Context(), shresolver.ClaimPath, attackerIP, "Bearer wrong", "")
		if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "5" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("exhausted brute-force attempt #%d expected 429 Retry-After:5, got %d (%v)", i+1, w.Code, w.Header())
		}
	}
	if gotHits := controlHits.Load() - hitsBefore; gotHits != 4 {
		t.Fatalf("rate-limited brute-force requests must not reach pullControl: hits=%d want 4", gotHits)
	}

	// Legitimate worker on its own IP remains completely unaffected while attacker is throttled.
	if w := sendControl(canceledCtx, shresolver.ClaimPath, workerIP, "Bearer "+pullToken, ""); w.Code != http.StatusNoContent {
		t.Fatalf("legitimate worker affected by throttled attacker: %d", w.Code)
	}

	// Partial refill (4s -> 0.8 tokens < 1) still blocks with Retry-After: 1; full 1-token refill (5s) allows 1 check.
	now = now.Add(4 * time.Second)
	if w := sendControl(t.Context(), shresolver.ResultPath, attackerIP, "Bearer wrong", ""); w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "1" {
		t.Fatalf("partial refill expected 429 Retry-After:1, got %d (%v)", w.Code, w.Header())
	}
	now = now.Add(time.Second)
	if w := sendControl(t.Context(), shresolver.ResultPath, attackerIP, "Bearer wrong", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 1 refilled attempt to return 401, got %d", w.Code)
	}
	if w := sendControl(t.Context(), shresolver.ResultPath, attackerIP, "Bearer wrong", ""); w.Code != http.StatusTooManyRequests {
		t.Fatalf("expected immediate re-throttle after refilled 401, got %d", w.Code)
	}

	// 3. Concurrent 401 burst from a single IP never exceeds ClientBurst (4) 401 responses.
	burstIP := "203.0.113.88"
	var wg sync.WaitGroup
	var got401, got429 atomic.Int32
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := sendControl(t.Context(), shresolver.ClaimPath, burstIP, "Bearer wrong", "")
			switch w.Code {
			case http.StatusUnauthorized:
				got401.Add(1)
			case http.StatusTooManyRequests:
				got429.Add(1)
			default:
				t.Errorf("unexpected status %d under concurrent burst", w.Code)
			}
		}()
	}
	wg.Wait()
	if got401.Load() != 4 || got429.Load() != 16 {
		t.Fatalf("concurrent 401 burst expected 4x401 and 16x429, got 401=%d 429=%d", got401.Load(), got429.Load())
	}
}
