package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/bilibili"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/probe"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func testPublicLookup(_ context.Context, _, _ string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
}

type bilibiliShanghaiHarness struct {
	t          *testing.T
	edgeKey    string
	pullToken  string
	ownerToken string
	broker     *shresolver.PullBroker
	router     http.Handler
	mu         sync.Mutex
	nowTime    time.Time
}

func newBilibiliShanghaiHarness(
	t *testing.T,
	startNow time.Time,
	jpExec fetch.Executor,
	extraAdapters map[string]Adapter,
) *bilibiliShanghaiHarness {
	t.Helper()
	edgeKey := randomPrintableToken(t, 48)
	pullToken := randomPrintableToken(t, 48)
	ownerToken := randomPrintableToken(t, 48)

	h := &bilibiliShanghaiHarness{
		t:          t,
		edgeKey:    edgeKey,
		pullToken:  pullToken,
		ownerToken: ownerToken,
		nowTime:    startNow.UTC(),
	}
	clock := func() time.Time {
		h.mu.Lock()
		defer h.mu.Unlock()
		return h.nowTime
	}

	broker, err := shresolver.NewPullBroker(pullToken)
	if err != nil {
		t.Fatal(err)
	}
	broker.WithLookupNetIP(testPublicLookup).WithClock(clock)
	h.broker = broker

	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	adapters := map[string]Adapter{
		"bilibili": bilibili.NewWithShanghai(jpExec, broker),
	}
	for k, v := range extraAdapters {
		adapters[k] = v
	}

	publicMedia := func(ctx context.Context, platform string, payload unified.Object, now int64) (unified.Object, error) {
		switch platform {
		case "bilibili":
			return bilibili.PreparePublic(ctx, platform, payload, now)
		case "douyin":
			return douyin.PreparePublic(ctx, platform, payload, now)
		default:
			return payload, nil
		}
	}

	apiHandler, err := NewWithCacheConfig(cat, adapters, clock, publicMedia, DefaultCacheConfig())
	if err != nil {
		t.Fatal(err)
	}
	apiHandler.Stats().SetShanghaiSource(broker)

	admCfg := DefaultAdmissionConfig()
	admCfg.Parse.ClientBurst = 100
	admCfg.Parse.ClientRPS = 100
	admCfg.Parse.GlobalBurst = 200
	admCfg.Parse.GlobalRPS = 200
	ownerAuth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	router, err := WithAdmissionWithOwner(apiHandler, broker, "caddy", edgeKey, admCfg, ownerAuth)
	if err != nil {
		t.Fatal(err)
	}
	h.router = router
	return h
}

func (h *bilibiliShanghaiHarness) advanceClock(d time.Duration) {
	h.mu.Lock()
	h.nowTime = h.nowTime.Add(d)
	h.mu.Unlock()
}

func (h *bilibiliShanghaiHarness) nowUnix() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.nowTime.Unix()
}

func (h *bilibiliShanghaiHarness) doAPI(target, clientIP, bearer string) (int, unified.Object) {
	h.t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.RemoteAddr = "127.0.0.1:46000"
	req.Header.Set(edgeHeader, h.edgeKey)
	req.Header.Set(clientHeader, clientIP)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	payload, err := unified.Decode(rec.Body.Bytes())
	if err != nil {
		h.t.Fatalf("invalid JSON from %s: %v (body=%s)", target, err, rec.Body.String())
	}
	return rec.Code, payload
}

func (h *bilibiliShanghaiHarness) stats() StatsSnapshot {
	h.t.Helper()
	code, snap := fetchStatsSnapshot(h.t, h.router, h.edgeKey, h.ownerToken, "198.51.100.250", "")
	if code != http.StatusOK {
		h.t.Fatalf("GET /api/stats status=%d", code)
	}
	return snap
}

func handlerControlExecutor(h http.Handler, edgeKey string) fetch.Executor {
	return fetchFunc(func(ctx context.Context, req fetch.Request) (fetch.Response, error) {
		if err := ctx.Err(); err != nil {
			return fetch.Response{}, err
		}
		var bodyReader io.Reader
		if len(req.Body) > 0 {
			bodyReader = bytes.NewReader(req.Body)
		}
		httpReq := httptest.NewRequestWithContext(ctx, req.Method, req.URL, bodyReader)
		httpReq.RemoteAddr = "127.0.0.1:46001"
		for k, vals := range req.Header {
			for _, v := range vals {
				httpReq.Header.Add(k, v)
			}
		}
		if edgeKey != "" {
			httpReq.Header.Set(edgeHeader, edgeKey)
			httpReq.Header.Set(clientHeader, "198.51.100.201")
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httpReq)
		return fetch.Response{
			StatusCode: rec.Code,
			Header:     rec.Header().Clone(),
			Body:       rec.Body.Bytes(),
			URL:        req.URL,
		}, nil
	})
}

func (h *bilibiliShanghaiHarness) startPullWorker(shBiliExec fetch.Executor, shDouyinExec fetch.Executor) context.CancelFunc {
	h.t.Helper()
	if shDouyinExec == nil {
		shDouyinExec = fetchFunc(func(_ context.Context, _ fetch.Request) (fetch.Response, error) {
			return fetch.Response{}, fmt.Errorf("unexpected douyin call")
		})
	}
	controlExec := handlerControlExecutor(h.router, h.edgeKey)
	worker, err := shresolver.NewPullWorkerWithDetail(
		"https://japan.example",
		h.pullToken,
		controlExec,
		shDouyinExec,
		probe.New(shDouyinExec, douyin.AllowedMediaURL),
	)
	if err != nil {
		h.t.Fatal(err)
	}
	worker, err = worker.WithWorkers(1)
	if err != nil {
		h.t.Fatal(err)
	}
	worker.WithBilibili(shBiliExec)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		worker.Run(ctx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if h.broker.ShanghaiStatsSnapshot().WaitingWorkers >= 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
	h.t.Cleanup(cleanup)
	return cleanup
}

type fetchFunc func(context.Context, fetch.Request) (fetch.Response, error)

func (f fetchFunc) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	return f(ctx, req)
}

func makeBilibiliViewJSON(bvid string, cids ...int64) []byte {
	pages := make([]map[string]any, 0, len(cids))
	for i, cid := range cids {
		pages = append(pages, map[string]any{
			"cid":       cid,
			"page":      i + 1,
			"part":      fmt.Sprintf("Part-%d", i+1),
			"duration":  60,
			"dimension": map[string]any{"width": 1920, "height": 1080, "rotate": 0},
		})
	}
	doc := map[string]any{
		"code": 0,
		"data": map[string]any{
			"bvid":    bvid,
			"title":   "Bilibili Shanghai Test " + bvid,
			"pic":     "https://i0.hdslb.com/bfs/archive/cover.jpg",
			"desc":    "desc",
			"pubdate": 1700000000,
			"owner":   map[string]any{"name": "tester", "face": "https://i0.hdslb.com/bfs/face/avatar.jpg"},
			"pages":   pages,
		},
	}
	b, _ := json.Marshal(doc)
	return b
}

func collectVariantSourceURLs(variant unified.Object) []string {
	var out []string
	for _, group := range unified.DeliverySources(unified.Map(variant["delivery"])) {
		for _, raw := range group {
			out = append(out, unified.Str(unified.Map(raw)["url"]))
		}
	}
	return out
}

func assertAllBilivideoSourcesBrowserFetchAllowed(t *testing.T, item unified.Object) {
	t.Helper()
	count := 0
	for _, rawVar := range unified.Slice(item["variants"]) {
		v := unified.Map(rawVar)
		if unified.Str(v["state"]) == "deferred" {
			continue
		}
		for _, group := range unified.DeliverySources(unified.Map(v["delivery"])) {
			for _, rawSrc := range group {
				src := unified.Map(rawSrc)
				u := unified.Str(src["url"])
				if !bilibili.AllowedBrowserFetchURL(u) {
					t.Fatalf("unexpected non-bilivideo URL in Bilibili variant: %s", u)
				}
				if got := unified.Str(src["browser_fetch"]); got != "allowed" {
					t.Fatalf("source %s browser_fetch = %q, want allowed", u, got)
				}
				if got := unified.Str(src["expires_at"]); got == "" {
					t.Fatalf("source %s missing expires_at", u)
				}
				count++
			}
		}
	}
	if count == 0 {
		t.Fatal("expected at least one ready bilivideo source")
	}
}

// Scenario 1: Shanghai normal — parallel fetch, domestic URLs first, Japan overseas mirrors
// last, duplicate URL deduplicated, browser_fetch="allowed" on all *.bilivideo.com sources,
// and /api/stats shanghai.by_platform.bilibili.hits == 1.
func TestBilibiliShanghaiScenario1NormalMergeAndBrowserFetch(t *testing.T) {
	const bvid = "BV1234567890"
	const cid int64 = 101
	baseNow := time.Date(2026, 11, 15, 1, 0, 0, 0, time.UTC)
	dl := baseNow.Unix() + 7200

	shDURL := fmt.Sprintf("https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/01/101/101-1-80.mp4?deadline=%d", dl)
	jpDURL := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/01/101/101-1-80.mp4?deadline=%d", dl)
	shVid80 := fmt.Sprintf("https://cn-zj-hz-01-02.bilivideo.com/upgcxcode/00/01/101/101-1-30080.m4s?deadline=%d", dl)
	jpVid80 := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/01/101/101-1-30080.m4s?deadline=%d", dl)
	shAud := fmt.Sprintf("https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/01/101/101-1-30280.m4s?deadline=%d", dl)
	jpAud := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/01/101/101-1-30280.m4s?deadline=%d", dl)

	jpEntered := make(chan struct{}, 1)
	shEntered := make(chan struct{}, 1)
	bothEntered := make(chan struct{})
	go func() {
		<-jpEntered
		<-shEntered
		close(bothEntered)
	}()

	jpExec := fetchFunc(func(ctx context.Context, req fetch.Request) (fetch.Response, error) {
		if strings.Contains(req.URL, "/x/web-interface/view") {
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: makeBilibiliViewJSON(bvid, cid)}, nil
		}
		select {
		case jpEntered <- struct{}{}:
		default:
		}
		select {
		case <-bothEntered:
		case <-time.After(1500 * time.Millisecond):
			return fetch.Response{}, fmt.Errorf("Shanghai and Japan playurl did not run concurrently")
		case <-ctx.Done():
			return fetch.Response{}, ctx.Err()
		}
		body, _ := json.Marshal(map[string]any{
			"code": 0,
			"data": map[string]any{
				"quality": 80,
				"format":  "mp4720",
				"durl": []map[string]any{
					{"url": jpDURL, "size": 2097152, "length": 60000},
				},
				"dash": map[string]any{
					"video": []map[string]any{
						{"id": 80, "codecid": 7, "codecs": "avc1.640028", "width": 1920, "height": 1080, "bandwidth": 2000000, "baseUrl": jpVid80},
					},
					"audio": []map[string]any{
						{"id": 30280, "codecid": 0, "codecs": "mp4a.40.2", "bandwidth": 192000, "baseUrl": jpAud},
					},
				},
			},
		})
		return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
	})

	shExec := fetchFunc(func(ctx context.Context, req fetch.Request) (fetch.Response, error) {
		if req.Header.Get("Cookie") != "" || !bilibili.AllowedAPIURL(req.URL) {
			return fetch.Response{}, fmt.Errorf("violated Shanghai outbound boundary")
		}
		select {
		case shEntered <- struct{}{}:
		default:
		}
		select {
		case <-bothEntered:
		case <-time.After(1500 * time.Millisecond):
			return fetch.Response{}, fmt.Errorf("Shanghai and Japan playurl did not run concurrently")
		case <-ctx.Done():
			return fetch.Response{}, ctx.Err()
		}
		// Include jpDURL as backup_url to prove identical URL deduplication.
		body, _ := json.Marshal(map[string]any{
			"code": 0,
			"data": map[string]any{
				"quality": 80,
				"durl": []map[string]any{
					{"url": shDURL, "backup_url": []string{jpDURL}},
				},
				"dash": map[string]any{
					"video": []map[string]any{
						{"id": 80, "codecid": 7, "codecs": "avc1.640028", "baseUrl": shVid80},
					},
					"audio": []map[string]any{
						{"id": 30280, "codecid": 0, "codecs": "mp4a.40.2", "baseUrl": shAud},
					},
				},
			},
		})
		return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
	})

	h := newBilibiliShanghaiHarness(t, baseNow, jpExec, nil)
	h.startPullWorker(shExec, nil)

	code, payload := h.doAPI("/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.bilibili.com/video/"+bvid), "198.51.100.1", "")
	if code != http.StatusOK {
		t.Fatalf("status=%d payload=%v", code, payload)
	}
	if err := unified.ValidateEnvelopeAt(payload, baseNow.Unix()); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}

	items := unified.Slice(unified.Map(payload["data"])["items"])
	if len(items) != 1 {
		t.Fatalf("items len=%d, want 1", len(items))
	}
	item := unified.Map(items[0])
	assertAllBilivideoSourcesBrowserFetchAllowed(t, item)

	// Default points to Shanghai domestic route first.
	if got := unified.Str(unified.Map(item["default"])["url"]); got != shDURL {
		t.Fatalf("default.url = %q, want Shanghai domestic %q", got, shDURL)
	}

	variants := unified.Slice(item["variants"])
	if len(variants) != 2 {
		t.Fatalf("variants len=%d, want 2 (1 file + 1 mux)", len(variants))
	}
	fileURLs := collectVariantSourceURLs(unified.Map(variants[0]))
	if len(fileURLs) != 2 || fileURLs[0] != shDURL || fileURLs[1] != jpDURL {
		t.Fatalf("file variant URLs = %v, want [%s, %s] (deduplicated)", fileURLs, shDURL, jpDURL)
	}
	muxRes := unified.Slice(unified.Map(unified.Map(variants[1])["delivery"])["resources"])
	vidSrcs := unified.Slice(unified.Map(unified.Map(muxRes[0])["delivery"])["sources"])
	audSrcs := unified.Slice(unified.Map(unified.Map(muxRes[1])["delivery"])["sources"])
	if len(vidSrcs) != 2 || unified.Str(unified.Map(vidSrcs[0])["url"]) != shVid80 || unified.Str(unified.Map(vidSrcs[1])["url"]) != jpVid80 {
		t.Fatalf("unexpected mux video sources: %v", vidSrcs)
	}
	if len(audSrcs) != 2 || unified.Str(unified.Map(audSrcs[0])["url"]) != shAud || unified.Str(unified.Map(audSrcs[1])["url"]) != jpAud {
		t.Fatalf("unexpected mux audio sources: %v", audSrcs)
	}

	snap := h.stats()
	if snap.Shanghai.ByPlatform.Bilibili.Hits != 1 || snap.Shanghai.ByPlatform.Bilibili.Fallbacks != 0 || snap.Shanghai.Total.Hits != 1 {
		t.Fatalf("unexpected /api/stats shanghai snapshot: %+v", snap.Shanghai)
	}
}

// Scenario 2: Shanghai timeout — bounded wait (~2.5s-3.0s), returns Japan overseas
// result cleanly with browser_fetch="allowed", increments bilibili.fallbacks (not canceled).
func TestBilibiliShanghaiScenario2TimeoutFallsBackToJapan(t *testing.T) {
	const bvid = "BV1234567891"
	const cid int64 = 102
	baseNow := time.Date(2026, 11, 15, 1, 10, 0, 0, time.UTC)
	dl := baseNow.Unix() + 7200
	jpURL := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/01/102/102-1-64.mp4?deadline=%d", dl)

	jpExec := fetchFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		if strings.Contains(req.URL, "/x/web-interface/view") {
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: makeBilibiliViewJSON(bvid, cid)}, nil
		}
		body, _ := json.Marshal(map[string]any{
			"code": 0,
			"data": map[string]any{
				"quality": 64,
				"format":  "mp4720",
				"durl":    []map[string]any{{"url": jpURL, "size": 1048576, "length": 30000}},
			},
		})
		return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
	})
	shExec := fetchFunc(func(ctx context.Context, _ fetch.Request) (fetch.Response, error) {
		select {
		case <-time.After(4 * time.Second):
			return fetch.Response{}, fmt.Errorf("too slow")
		case <-ctx.Done():
			return fetch.Response{}, ctx.Err()
		}
	})

	h := newBilibiliShanghaiHarness(t, baseNow, jpExec, nil)
	h.startPullWorker(shExec, nil)

	start := time.Now()
	code, payload := h.doAPI("/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.bilibili.com/video/"+bvid), "198.51.100.2", "")
	elapsed := time.Since(start)
	if code != http.StatusOK {
		t.Fatalf("status=%d payload=%v", code, payload)
	}
	if elapsed > 3600*time.Millisecond {
		t.Fatalf("Shanghai timeout took %v, expected <= 3.6s bounded budget", elapsed)
	}
	item := unified.Map(unified.Slice(unified.Map(payload["data"])["items"])[0])
	assertAllBilivideoSourcesBrowserFetchAllowed(t, item)
	urls := collectVariantSourceURLs(unified.Map(unified.Slice(item["variants"])[0]))
	if len(urls) != 1 || urls[0] != jpURL {
		t.Fatalf("fallback URLs = %v, want [%s]", urls, jpURL)
	}
	snap := h.stats()
	if snap.Shanghai.ByPlatform.Bilibili.Fallbacks != 1 || snap.Shanghai.ByPlatform.Bilibili.Canceled != 0 || snap.Shanghai.ByPlatform.Bilibili.Hits != 0 {
		t.Fatalf("unexpected timeout stats: %+v", snap.Shanghai.ByPlatform.Bilibili)
	}
}

// Scenarios 3 & 4: Shanghai returns non-bilivideo.com hosts (including apex bilivideo.com
// and evilbilivideo.com) or http://*.bilivideo.com — rejected both at Shanghai pre-return
// and at Japan's untrusted wire validator, cleanly falling back to Japan.
func TestBilibiliShanghaiScenarios3And4InvalidHostAndHTTPSchemeRejected(t *testing.T) {
	baseNow := time.Date(2026, 11, 15, 1, 20, 0, 0, time.UTC)
	dl := baseNow.Unix() + 7200

	cases := []struct {
		name      string
		bvid      string
		badURLs   []string
		rawBypass bool
	}{
		{
			name:    "scenario3-worker-discards-non-bilivideo-and-apex",
			bvid:    "BV1234567892",
			badURLs: []string{fmt.Sprintf("https://evilbilivideo.com/v.mp4?deadline=%d", dl), fmt.Sprintf("https://bilivideo.com/v.mp4?deadline=%d", dl)},
		},
		{
			name:      "scenario3-broker-rejects-untrusted-wire-non-bilivideo",
			bvid:      "BV1234567893",
			badURLs:   []string{fmt.Sprintf("https://cdn.evilbilivideo.com/v.mp4?deadline=%d", dl)},
			rawBypass: true,
		},
		{
			name:    "scenario4-worker-discards-http-scheme",
			bvid:    "BV1234567894",
			badURLs: []string{fmt.Sprintf("http://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/01/105/105-1-64.mp4?deadline=%d", dl)},
		},
		{
			name:      "scenario4-broker-rejects-untrusted-wire-http-scheme",
			bvid:      "BV1234567895",
			badURLs:   []string{fmt.Sprintf("http://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/01/105/105-1-64.mp4?deadline=%d", dl)},
			rawBypass: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			const cid int64 = 105
			jpURL := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/01/105/105-1-64.mp4?deadline=%d", dl)
			jpExec := fetchFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				if strings.Contains(req.URL, "/x/web-interface/view") {
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: makeBilibiliViewJSON(tc.bvid, cid)}, nil
				}
				body, _ := json.Marshal(map[string]any{
					"code": 0,
					"data": map[string]any{
						"quality": 64,
						"format":  "mp4720",
						"durl":    []map[string]any{{"url": jpURL, "size": 1024000, "length": 20000}},
					},
				})
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
			})

			h := newBilibiliShanghaiHarness(t, baseNow, jpExec, nil)
			if !tc.rawBypass {
				shExec := fetchFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					body, _ := json.Marshal(map[string]any{
						"code": 0,
						"data": map[string]any{
							"quality": 64,
							"durl":    []map[string]any{{"url": tc.badURLs[0], "backup_url": tc.badURLs[1:]}},
						},
					})
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
				})
				h.startPullWorker(shExec, nil)
			} else {
				// Simulate a compromised Shanghai peer posting bad URLs directly to /internal/shanghai/result.
				claimDone := make(chan *httptest.ResponseRecorder, 1)
				go func() {
					req := httptest.NewRequest(http.MethodPost, shresolver.ClaimPath, nil)
					req.RemoteAddr = "127.0.0.1:46010"
					req.Header.Set(edgeHeader, h.edgeKey)
					req.Header.Set(clientHeader, "198.51.100.205")
					req.Header.Set("Authorization", "Bearer "+h.pullToken)
					req.Header.Set(shresolver.ProtocolHeader, "2")
					req.Header.Set(shresolver.TasksHeader, "douyin,bilibili")
					rec := httptest.NewRecorder()
					h.router.ServeHTTP(rec, req)
					claimDone <- rec
				}()
				deadlineWait := time.Now().Add(2 * time.Second)
				for time.Now().Before(deadlineWait) && h.broker.ShanghaiStatsSnapshot().WaitingWorkers == 0 {
					time.Sleep(5 * time.Millisecond)
				}
				go func() {
					rec := <-claimDone
					if rec.Code != http.StatusOK {
						return
					}
					var job shresolver.PullJob
					_ = json.Unmarshal(rec.Body.Bytes(), &job)
					evilPlay, _ := json.Marshal(map[string]any{
						"protocol":     2,
						"bvid":         tc.bvid,
						"cid":          cid,
						"durl_quality": 64,
						"durl_pieces":  []map[string]any{{"urls": tc.badURLs}},
					})
					resBody, _ := json.Marshal(shresolver.PullResult{PullJob: job, Result: evilPlay})
					resReq := httptest.NewRequest(http.MethodPost, shresolver.ResultPath, bytes.NewReader(resBody))
					resReq.RemoteAddr = "127.0.0.1:46010"
					resReq.Header.Set(edgeHeader, h.edgeKey)
					resReq.Header.Set(clientHeader, "198.51.100.205")
					resReq.Header.Set("Authorization", "Bearer "+h.pullToken)
					h.router.ServeHTTP(httptest.NewRecorder(), resReq)
				}()
			}

			code, payload := h.doAPI("/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.bilibili.com/video/"+tc.bvid), "198.51.100.3", "")
			if code != http.StatusOK {
				t.Fatalf("status=%d payload=%v", code, payload)
			}
			item := unified.Map(unified.Slice(unified.Map(payload["data"])["items"])[0])
			assertAllBilivideoSourcesBrowserFetchAllowed(t, item)
			urls := collectVariantSourceURLs(unified.Map(unified.Slice(item["variants"])[0]))
			if len(urls) != 1 || urls[0] != jpURL {
				t.Fatalf("got URLs %v, want Japan-only [%s]", urls, jpURL)
			}
			snap := h.stats()
			if snap.Shanghai.ByPlatform.Bilibili.Fallbacks != 1 || snap.Shanghai.ByPlatform.Bilibili.Hits != 0 {
				t.Fatalf("expected bilibili fallback=1 hits=0, got %+v", snap.Shanghai.ByPlatform.Bilibili)
			}
		})
	}
}

// Scenario 5: Quality tier mismatch — (A) partial overlap keeps only Japan's tiers
// without adding extra Shanghai 1080p tiers; (B) zero common tiers falls back cleanly
// and counts as bilibili.fallbacks.
func TestBilibiliShanghaiScenario5QualityTierMismatch(t *testing.T) {
	baseNow := time.Date(2026, 11, 15, 1, 30, 0, 0, time.UTC)
	dl := baseNow.Unix() + 7200

	t.Run("partial-overlap-japan-tier-list-authoritative", func(t *testing.T) {
		const bvid = "BV1234567896"
		const cid int64 = 106
		sh1080 := fmt.Sprintf("https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/01/106/106-1-30080.m4s?deadline=%d", dl)
		sh720 := fmt.Sprintf("https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/01/106/106-1-30064.m4s?deadline=%d", dl)
		sh720HEVC := fmt.Sprintf("https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/01/106/106-1-30066.m4s?deadline=%d", dl)
		jp720 := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/01/106/106-1-30064.m4s?deadline=%d", dl)
		jp480 := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/01/106/106-1-30032.m4s?deadline=%d", dl)
		shAud := fmt.Sprintf("https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/01/106/106-1-30280.m4s?deadline=%d", dl)
		jpAud := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/01/106/106-1-30280.m4s?deadline=%d", dl)

		jpExec := fetchFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			if strings.Contains(req.URL, "/x/web-interface/view") {
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: makeBilibiliViewJSON(bvid, cid)}, nil
			}
			// Japan only has 720p AVC (64/7) and 480p AVC (32/7).
			body, _ := json.Marshal(map[string]any{
				"code": 0,
				"data": map[string]any{
					"quality": 64,
					"dash": map[string]any{
						"video": []map[string]any{
							{"id": 64, "codecid": 7, "codecs": "avc1.64001F", "width": 1280, "height": 720, "bandwidth": 1200000, "baseUrl": jp720},
							{"id": 32, "codecid": 7, "codecs": "avc1.64001E", "width": 852, "height": 480, "bandwidth": 600000, "baseUrl": jp480},
						},
						"audio": []map[string]any{
							{"id": 30280, "codecid": 0, "codecs": "mp4a.40.2", "bandwidth": 192000, "baseUrl": jpAud},
						},
					},
				},
			})
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
		})
		shExec := fetchFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			// Shanghai has extra 1080p AVC (80/7) + extra 720p HEVC (64/12) + matching 720p AVC (64/7).
			body, _ := json.Marshal(map[string]any{
				"code": 0,
				"data": map[string]any{
					"quality": 80,
					"dash": map[string]any{
						"video": []map[string]any{
							{"id": 80, "codecid": 7, "codecs": "avc1.640028", "baseUrl": sh1080},
							{"id": 64, "codecid": 12, "codecs": "hev1.1.6.L93.90", "baseUrl": sh720HEVC},
							{"id": 64, "codecid": 7, "codecs": "avc1.64001F", "baseUrl": sh720},
						},
						"audio": []map[string]any{
							{"id": 30280, "codecid": 0, "codecs": "mp4a.40.2", "baseUrl": shAud},
						},
					},
				},
			})
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
		})

		h := newBilibiliShanghaiHarness(t, baseNow, jpExec, nil)
		h.startPullWorker(shExec, nil)

		code, payload := h.doAPI("/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.bilibili.com/video/"+bvid), "198.51.100.5", "")
		if code != http.StatusOK {
			t.Fatalf("status=%d payload=%v", code, payload)
		}
		rawText := fmt.Sprintf("%v", payload)
		if strings.Contains(rawText, sh1080) || strings.Contains(rawText, sh720HEVC) {
			t.Fatalf("extra Shanghai tier or codec leaked into Japan's variant list: %s", rawText)
		}
		variants := unified.Slice(unified.Map(unified.Slice(unified.Map(payload["data"])["items"])[0])["variants"])
		if len(variants) != 2 {
			t.Fatalf("variants len=%d, want strictly Japan's 2 tiers (720p, 480p)", len(variants))
		}
		v720Res := unified.Slice(unified.Map(unified.Map(variants[0])["delivery"])["resources"])
		v480Res := unified.Slice(unified.Map(unified.Map(variants[1])["delivery"])["resources"])
		v720Srcs := unified.Slice(unified.Map(unified.Map(v720Res[0])["delivery"])["sources"])
		v480Srcs := unified.Slice(unified.Map(unified.Map(v480Res[0])["delivery"])["sources"])
		if len(v720Srcs) != 2 || unified.Str(unified.Map(v720Srcs[0])["url"]) != sh720 || unified.Str(unified.Map(v720Srcs[1])["url"]) != jp720 {
			t.Fatalf("720p sources = %v, want [sh720, jp720]", v720Srcs)
		}
		if len(v480Srcs) != 1 || unified.Str(unified.Map(v480Srcs[0])["url"]) != jp480 {
			t.Fatalf("480p sources = %v, want [jp480]", v480Srcs)
		}
		if snap := h.stats(); snap.Shanghai.ByPlatform.Bilibili.Hits != 1 {
			t.Fatalf("expected bilibili.hits=1 on partial tier overlap, got %+v", snap.Shanghai.ByPlatform.Bilibili)
		}
	})

	t.Run("zero-overlap-counts-as-fallback", func(t *testing.T) {
		const bvid = "BV1234567897"
		const cid int64 = 107
		sh1080 := fmt.Sprintf("https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/01/107/107-1-80.mp4?deadline=%d", dl)
		jp480 := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/01/107/107-1-32.mp4?deadline=%d", dl)

		jpExec := fetchFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			if strings.Contains(req.URL, "/x/web-interface/view") {
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: makeBilibiliViewJSON(bvid, cid)}, nil
			}
			body, _ := json.Marshal(map[string]any{
				"code": 0,
				"data": map[string]any{
					"quality": 32,
					"format":  "mp4",
					"durl":    []map[string]any{{"url": jp480, "size": 524288, "length": 15000}},
				},
			})
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
		})
		shExec := fetchFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			body, _ := json.Marshal(map[string]any{
				"code": 0,
				"data": map[string]any{
					"quality": 80,
					"durl":    []map[string]any{{"url": sh1080}},
				},
			})
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
		})

		h := newBilibiliShanghaiHarness(t, baseNow, jpExec, nil)
		h.startPullWorker(shExec, nil)

		code, payload := h.doAPI("/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.bilibili.com/video/"+bvid), "198.51.100.6", "")
		if code != http.StatusOK {
			t.Fatalf("status=%d payload=%v", code, payload)
		}
		item := unified.Map(unified.Slice(unified.Map(payload["data"])["items"])[0])
		urls := collectVariantSourceURLs(unified.Map(unified.Slice(item["variants"])[0]))
		if len(urls) != 1 || urls[0] != jp480 {
			t.Fatalf("got %v, want Japan-only [%s]", urls, jp480)
		}
		snap := h.stats()
		if snap.Shanghai.ByPlatform.Bilibili.Hits != 0 || snap.Shanghai.ByPlatform.Bilibili.Fallbacks != 1 {
			t.Fatalf("expected 0-overlap to record bilibili.fallbacks=1 hits=0, got %+v", snap.Shanghai.ByPlatform.Bilibili)
		}
	})
}

// Scenario 6: Bidirectional protocol backward compatibility end-to-end —
// (A) Old Shanghai worker (no X-DokiTool-Shanghai-Tasks header) connected to New Japan:
//
//	Bilibili fails open immediately (<80ms, zero 300ms queue stall) while Douyin still hits Shanghai;
//
// (B) New Shanghai PullWorker connected to Old Japan broker (DisallowUnknownFields on PullResult):
//
//	Douyin works byte-for-byte unchanged without any unknown JSON fields.
func TestBilibiliShanghaiScenario6BidirectionalRollingUpgradeEndToEnd(t *testing.T) {
	baseNow := time.Date(2026, 11, 15, 1, 40, 0, 0, time.UTC)
	dl := baseNow.Unix() + 7200
	const bvid = "BV1234567898"
	const cid int64 = 108
	jpURL := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/01/108/108-1-64.mp4?deadline=%d", dl)

	jpExec := fetchFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		if strings.Contains(req.URL, "/x/web-interface/view") {
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: makeBilibiliViewJSON(bvid, cid)}, nil
		}
		body, _ := json.Marshal(map[string]any{
			"code": 0,
			"data": map[string]any{
				"quality": 64,
				"format":  "mp4720",
				"durl":    []map[string]any{{"url": jpURL, "size": 1000000, "length": 15000}},
			},
		})
		return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
	})

	var h *bilibiliShanghaiHarness
	douyinAdapter := AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
		idx := strings.LastIndexByte(src, '/')
		_, _ = h.broker.ResolveWork(ctx, src[idx+1:])
		return makeStatsOKPayload("douyin", src, now), nil
	})
	h = newBilibiliShanghaiHarness(t, baseNow, jpExec, map[string]Adapter{"douyin": douyinAdapter})

	// Direction A: Park an Old V2 Shanghai worker (omits X-DokiTool-Shanghai-Tasks, strict DisallowUnknownFields).
	oldClaimCh := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPost, shresolver.ClaimPath, nil)
		req.RemoteAddr = "127.0.0.1:46020"
		req.Header.Set(edgeHeader, h.edgeKey)
		req.Header.Set(clientHeader, "198.51.100.210")
		req.Header.Set("Authorization", "Bearer "+h.pullToken)
		req.Header.Set(shresolver.ProtocolHeader, "2") // Old worker: NO TasksHeader!
		rec := httptest.NewRecorder()
		h.router.ServeHTTP(rec, req)
		oldClaimCh <- rec
	}()
	deadlineWait := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadlineWait) && h.broker.ShanghaiStatsSnapshot().WaitingWorkers == 0 {
		time.Sleep(5 * time.Millisecond)
	}

	// Bilibili parse must fail open immediately without dispatching to the Old worker or waiting 300ms.
	startBili := time.Now()
	code, biliPayload := h.doAPI("/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.bilibili.com/video/"+bvid), "198.51.100.7", "")
	elapsedBili := time.Since(startBili)
	if code != http.StatusOK || elapsedBili > 150*time.Millisecond {
		t.Fatalf("Old Shanghai + New Japan Bilibili status=%d elapsed=%v (expected <150ms zero queue wait)", code, elapsedBili)
	}
	if got := collectVariantSourceURLs(unified.Map(unified.Slice(unified.Map(unified.Slice(unified.Map(biliPayload["data"])["items"])[0])["variants"])[0])); len(got) != 1 || got[0] != jpURL {
		t.Fatalf("unexpected Bilibili fallback URLs: %v", got)
	}

	// Meanwhile Douyin dispatches to that exact waiting Old worker and succeeds!
	dyDone := make(chan int, 1)
	go func() {
		c, _ := h.doAPI("/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/7800000000000000001"), "198.51.100.8", "")
		dyDone <- c
	}()
	claimRec := <-oldClaimCh
	if claimRec.Code != http.StatusOK {
		t.Fatalf("Old worker did not receive Douyin job: code=%d", claimRec.Code)
	}
	dec := json.NewDecoder(bytes.NewReader(claimRec.Body.Bytes()))
	dec.DisallowUnknownFields()
	var oldJob struct {
		Protocol   int    `json:"protocol"`
		TaskID     string `json:"task_id"`
		AttemptID  string `json:"attempt_id"`
		AwemeID    string `json:"aweme_id"`
		DeadlineMS int64  `json:"deadline_ms"`
	}
	if err := dec.Decode(&oldJob); err != nil {
		t.Fatalf("New Japan sent unknown fields to Old Shanghai worker: %v (%s)", err, claimRec.Body.String())
	}
	workRaw, _ := json.Marshal(shresolver.WorkResponse{Protocol: 2, AwemeID: oldJob.AwemeID, VideoID: "v0200fg100007800000000000000001"})
	resBody, _ := json.Marshal(shresolver.PullResult{
		PullJob: shresolver.PullJob{Protocol: 2, TaskID: oldJob.TaskID, AttemptID: oldJob.AttemptID, AwemeID: oldJob.AwemeID, DeadlineMS: oldJob.DeadlineMS},
		Result:  workRaw,
	})
	resReq := httptest.NewRequest(http.MethodPost, shresolver.ResultPath, bytes.NewReader(resBody))
	resReq.RemoteAddr = "127.0.0.1:46020"
	resReq.Header.Set(edgeHeader, h.edgeKey)
	resReq.Header.Set(clientHeader, "198.51.100.210")
	resReq.Header.Set("Authorization", "Bearer "+h.pullToken)
	h.router.ServeHTTP(httptest.NewRecorder(), resReq)

	if dyStatus := <-dyDone; dyStatus != http.StatusOK {
		t.Fatalf("Douyin status=%d", dyStatus)
	}
	snap := h.stats()
	if snap.Shanghai.ByPlatform.Bilibili.Fallbacks != 1 || snap.Shanghai.ByPlatform.Bilibili.QueueWaits != 0 || snap.Shanghai.ByPlatform.Douyin.Hits != 1 {
		t.Fatalf("unexpected Old Shanghai + New Japan platform breakdown: %+v", snap.Shanghai.ByPlatform)
	}

	// Direction B: Real New PullWorker against frozen Old Japan broker (DisallowUnknownFields on PullResult).
	var accepted atomic.Bool
	oldJapanHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case shresolver.ClaimPath:
			if r.ContentLength != 0 {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if accepted.Load() {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"protocol":2,"task_id":"0123456789abcdef0123456789abcdef","attempt_id":"fedcba9876543210fedcba9876543210","aweme_id":"7800000000000000002","deadline_ms":4102444800000}`)
		case shresolver.ResultPath:
			d := json.NewDecoder(r.Body)
			d.DisallowUnknownFields()
			var legacyRes struct {
				Protocol   int             `json:"protocol"`
				TaskID     string          `json:"task_id"`
				AttemptID  string          `json:"attempt_id"`
				AwemeID    string          `json:"aweme_id"`
				DeadlineMS int64           `json:"deadline_ms"`
				Result     json.RawMessage `json:"result"`
			}
			if err := d.Decode(&legacyRes); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			accepted.Store(true)
			w.WriteHeader(http.StatusNoContent)
		}
	})

	shDyExec := fetchFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		return fetch.Response{
			StatusCode: 200,
			URL:        req.URL,
			Body:       []byte(`{"status_code":0,"aweme_detail":{"aweme_id":"7800000000000000002","video":{"play_addr":{"uri":"v0200fg100007800000000000000002","url_list":["https://v26-luna.douyinvod.com/abc123/video/tos/cn/tos-cn-ve-15/oA0B1C2D3E4F/?a=6383"]}}}}`),
		}, nil
	})
	newWorker, err := shresolver.NewPullWorkerWithDetail("https://old-japan.example", h.pullToken, handlerControlExecutor(oldJapanHandler, ""), shDyExec, probe.New(shDyExec, douyin.AllowedMediaURL))
	if err != nil {
		t.Fatal(err)
	}
	newWorker, err = newWorker.WithWorkers(1)
	if err != nil {
		t.Fatal(err)
	}
	wCtx, wCancel := context.WithCancel(context.Background())
	wDone := make(chan struct{})
	go func() {
		defer close(wDone)
		newWorker.Run(wCtx)
	}()
	waitOld := time.Now().Add(2 * time.Second)
	for time.Now().Before(waitOld) && !accepted.Load() {
		time.Sleep(5 * time.Millisecond)
	}
	wCancel()
	<-wDone
	if !accepted.Load() {
		t.Fatal("New Shanghai PullWorker result was not accepted by Old Japan broker")
	}
}

// Scenario 7: Multi-P /api/parse + /api/resolve and earliest-expiry cache TTL across
// Shanghai and Japan *.bilivideo.com deadline parameters.
func TestBilibiliShanghaiScenario7MultiPResolveAndEarliestExpiryCacheTTL(t *testing.T) {
	const bvid = "BV1234567899"
	const cidP1 int64 = 1001
	const cidP2 int64 = 2002
	baseNow := time.Date(2026, 11, 15, 2, 0, 0, 0, time.UTC)

	var jpPlayCalls atomic.Int64
	var shPlayCalls atomic.Int64

	var h *bilibiliShanghaiHarness
	jpExec := fetchFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		if strings.Contains(req.URL, "/x/web-interface/view") {
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: makeBilibiliViewJSON(bvid, cidP1, cidP2)}, nil
		}
		jpPlayCalls.Add(1)
		u, _ := url.Parse(req.URL)
		cid := u.Query().Get("cid")
		// Japan URL has full 2-hour TTL (now + 7200 -> would cache for 180s if alone).
		jpDL := h.nowUnix() + 7200
		jpURL := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/02/%s/%s-1-80.mp4?deadline=%d", cid, cid, jpDL)
		body, _ := json.Marshal(map[string]any{
			"code": 0,
			"data": map[string]any{
				"quality": 80,
				"format":  "mp4720",
				"durl":    []map[string]any{{"url": jpURL, "size": 3145728, "length": 60000}},
			},
		})
		return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
	})
	shExec := fetchFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		shPlayCalls.Add(1)
		u, _ := url.Parse(req.URL)
		cid := u.Query().Get("cid")
		// Shanghai URL expires in 90s -> earliest_expires_at - now - 60s = 30s cache TTL!
		shDL := h.nowUnix() + 90
		shURL := fmt.Sprintf("https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/02/%s/%s-1-80.mp4?deadline=%d", cid, cid, shDL)
		body, _ := json.Marshal(map[string]any{
			"code": 0,
			"data": map[string]any{
				"quality": 80,
				"durl":    []map[string]any{{"url": shURL}},
			},
		})
		return fetch.Response{StatusCode: 200, URL: req.URL, Body: body}, nil
	})

	h = newBilibiliShanghaiHarness(t, baseNow, jpExec, nil)
	h.startPullWorker(shExec, nil)

	// Step 1: /api/parse resolves P1 (cid=1001) and marks P2 (cid=2002) deferred with resolve_url.
	code, parsePayload := h.doAPI("/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.bilibili.com/video/"+bvid), "198.51.100.10", "")
	if code != http.StatusOK {
		t.Fatalf("parse status=%d payload=%v", code, parsePayload)
	}
	items := unified.Slice(unified.Map(parsePayload["data"])["items"])
	if len(items) != 2 {
		t.Fatalf("items len=%d, want 2", len(items))
	}
	p1 := unified.Map(items[0])
	p2 := unified.Map(items[1])
	assertAllBilivideoSourcesBrowserFetchAllowed(t, p1)
	if unified.Str(p2["state"]) != "deferred" {
		t.Fatalf("P2 state = %q, want deferred", unified.Str(p2["state"]))
	}
	resolveURL := unified.Str(p2["resolve_url"])
	if !strings.HasPrefix(resolveURL, "/api/resolve?") {
		t.Fatalf("unexpected P2 resolve_url: %q", resolveURL)
	}

	// Step 2: Follow P2 resolve_url -> dispatches (bvid, cid=2002) to Shanghai, merges [shanghai, japan].
	code, resPayload := h.doAPI(resolveURL, "198.51.100.10", "")
	if code != http.StatusOK {
		t.Fatalf("resolve P2 status=%d payload=%v", code, resPayload)
	}
	resData := unified.Map(resPayload["data"])
	if got := unified.Str(resData["default_item_id"]); got != bvid+"-p2" {
		t.Fatalf("resolve default_item_id = %q, want %s-p2", got, bvid)
	}
	resP2 := unified.Map(unified.Slice(resData["items"])[1])
	assertAllBilivideoSourcesBrowserFetchAllowed(t, resP2)
	p2URLs := collectVariantSourceURLs(unified.Map(unified.Slice(resP2["variants"])[0]))
	if len(p2URLs) != 2 || !strings.Contains(p2URLs[0], "cn-sh-fx-01-01.bilivideo.com") || !strings.Contains(p2URLs[0], "/2002/") || !strings.Contains(p2URLs[1], "upos-sz-mirrorcosov.bilivideo.com") {
		t.Fatalf("unexpected P2 resolved URLs: %v", p2URLs)
	}

	// Step 3: Verify earliest-expiry cache TTL = 90s - 60s = 30s (governed by Shanghai's 90s deadline, NOT Japan's 7200s!).
	// At +20s (< 30s TTL): must be a cache HIT (zero additional upstream calls).
	callsBeforeHit := jpPlayCalls.Load()
	h.advanceClock(20 * time.Second)
	code, _ = h.doAPI(resolveURL, "198.51.100.10", "")
	if code != http.StatusOK || jpPlayCalls.Load() != callsBeforeHit {
		t.Fatalf("expected cache HIT at +20s (<30s earliest-expiry TTL), jpPlayCalls %d -> %d", callsBeforeHit, jpPlayCalls.Load())
	}

	// At +35s (> 30s earliest-expiry TTL, even though < 60s default and < 180s max!): must expire and re-fetch!
	h.advanceClock(15 * time.Second)
	code, _ = h.doAPI(resolveURL, "198.51.100.10", "")
	if code != http.StatusOK || jpPlayCalls.Load() != callsBeforeHit+1 || shPlayCalls.Load() != 3 {
		t.Fatalf("expected cache expiry at +35s (>30s earliest-expiry TTL), jpCalls=%d shCalls=%d", jpPlayCalls.Load(), shPlayCalls.Load())
	}

	snap := h.stats()
	if snap.Shanghai.ByPlatform.Bilibili.Hits != 3 || snap.Cache.Total.Hits != 1 {
		t.Fatalf("unexpected multi-P + cache stats: shanghai=%+v cache=%+v", snap.Shanghai.ByPlatform.Bilibili, snap.Cache.Total)
	}
}
