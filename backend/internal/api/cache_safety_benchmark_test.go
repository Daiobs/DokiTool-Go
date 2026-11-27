package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	weiboplatform "github.com/Brilliant666/DokiTool-Go/backend/internal/platform/weibo"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type countingYouTubeHelper struct {
	ctxCalls      atomic.Int32
	finalizeCalls atomic.Int32
}

func (y *countingYouTubeHelper) Context(context.Context) (unified.Object, int) {
	n := y.ctxCalls.Add(1)
	return unified.Object{
		"schema_version": "1.0",
		"code":           "OK",
		"data":           unified.Object{"seq": int64(n)},
	}, http.StatusOK
}

func (y *countingYouTubeHelper) Finalize(_ context.Context, _ []byte, _ bool) (unified.Object, int) {
	n := y.finalizeCalls.Add(1)
	return unified.Object{
		"schema_version": "1.0",
		"code":           "OK",
		"data":           unified.Object{"seq": int64(n)},
	}, http.StatusOK
}

func TestParseCacheExcludesRequesterBoundContent(t *testing.T) {
	c := loadCacheTestCatalog(t)
	var nowSec atomic.Int64
	nowSec.Store(1793448000)

	var weiboCalls, youtubeCalls atomic.Int32

	weiboAdapter := AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
		weiboCalls.Add(1)
		env := makeSyntheticEnvelope("weibo", src, now, "")
		item := unified.Map(unified.Slice(unified.Map(env["data"])["items"])[0])
		const upstream = "https://f.video.weibocdn.com/000abc.mp4?Expires=1793451600"
		unified.Map(item["default"])["url"] = upstream
		variant := unified.Map(unified.Slice(item["variants"])[0])
		source := unified.Map(unified.Slice(unified.Map(variant["delivery"])["sources"])[0])
		source["url"] = upstream
		return env, nil
	})
	youtubeAdapter := AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
		youtubeCalls.Add(1)
		return makeSyntheticEnvelope("youtube", src, now, ""), nil
	})

	h, err := New(c, map[string]Adapter{
		"weibo":   weiboAdapter,
		"youtube": youtubeAdapter,
	}, func() time.Time { return time.Unix(nowSec.Load(), 0) }, weiboplatform.PreparePublic)
	if err != nil {
		t.Fatal(err)
	}
	ytHelper := &countingYouTubeHelper{}
	h.SetYouTubeHelper(ytHelper)

	// 1. Weibo now emits channel-invariant direct URLs (browser_fetch=blocked) and enters parseCache cleanly.
	weiboPath := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://weibo.com/1234567890/AbCdEfGhI")
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, httptest.NewRequest(http.MethodGet, weiboPath, nil))
	nowSec.Add(5)
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, weiboPath, nil))
	if w1.Code != http.StatusOK || w2.Code != http.StatusOK || weiboCalls.Load() != 1 {
		t.Fatalf("weibo direct responses should enter parseCache: code1=%d code2=%d calls=%d", w1.Code, w2.Code, weiboCalls.Load())
	}
	if !bytes.Equal(w1.Body.Bytes(), w2.Body.Bytes()) || strings.Contains(w1.Body.String(), "/api/media/weibo") {
		t.Fatalf("weibo cached direct payload mismatch or unexpected relay URL: %s", w1.Body.String())
	}

	// 2. YouTube /api/youtube/{context,finalize} NEVER enter parseCache, while YouTube /api/parse
	//    caches for youtube_parse_ttl (default 120s) with host canonicalization and can be disabled via 0s.
	ytPathWWW := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
	ytPathMobile := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://m.youtube.com/watch?v=dQw4w9WgXcQ")
	ytPathApex := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://youtube.com/watch?v=dQw4w9WgXcQ")

	for i, ytPath := range []string{ytPathWWW, ytPathMobile, ytPathApex} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, ytPath, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("youtube parse #%d status=%d body=%s", i, w.Code, w.Body.String())
		}
		if i > 0 && w.Header().Get("X-DokiTool-Cache") != "hit" {
			t.Fatalf("youtube alias #%d expected cache hit, got hdr=%q", i, w.Header().Get("X-DokiTool-Cache"))
		}
	}
	if youtubeCalls.Load() != 1 {
		t.Fatalf("expected canonicalized YouTube /api/parse to hit 120s short cache (calls=%d, want 1)", youtubeCalls.Load())
	}
	// After 120s default youtube_parse_ttl: expires and re-parses!
	nowSec.Add(120)
	wYTExp := httptest.NewRecorder()
	h.ServeHTTP(wYTExp, httptest.NewRequest(http.MethodGet, ytPathWWW, nil))
	if wYTExp.Code != http.StatusOK || youtubeCalls.Load() != 2 {
		t.Fatalf("youtube cache did not expire at +120s: code=%d calls=%d", wYTExp.Code, youtubeCalls.Load())
	}

	// Setting youtube_parse_ttl=0s immediately disables YouTube /api/parse caching!
	rtNoYT := DefaultRuntimeConfig()
	rtNoYT.Cache.YouTubeParseTTL = 0
	if !ApplyRuntimeConfig(nil, h, rtNoYT, true, false) {
		t.Fatal("ApplyRuntimeConfig youtube_parse_ttl=0s failed")
	}
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, ytPathWWW, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("youtube uncached parse status=%d body=%s", w.Code, w.Body.String())
		}
		wCtx := httptest.NewRecorder()
		h.ServeHTTP(wCtx, httptest.NewRequest(http.MethodGet, "/api/youtube/context?schema_version=1.0", nil))
		if wCtx.Code != http.StatusOK {
			t.Fatalf("youtube context status=%d", wCtx.Code)
		}
		wFin := httptest.NewRecorder()
		h.ServeHTTP(wFin, httptest.NewRequest(http.MethodPost, "/api/youtube/finalize?schema_version=1.0", strings.NewReader(`{}`)))
		if wFin.Code != http.StatusOK {
			t.Fatalf("youtube finalize status=%d", wFin.Code)
		}
	}
	if youtubeCalls.Load() != 4 || ytHelper.ctxCalls.Load() != 2 || ytHelper.finalizeCalls.Load() != 2 {
		t.Fatalf("youtube bypassed calls mismatch: parse=%d ctx=%d fin=%d",
			youtubeCalls.Load(), ytHelper.ctxCalls.Load(), ytHelper.finalizeCalls.Load())
	}
}

type canaryPanicPayload struct {
	detail string
}

func (c canaryPanicPayload) Error() string  { return c.detail }
func (c canaryPanicPayload) String() string { return c.detail }

func TestSingleflightPanicRecoveryIsolatesWaitersLogsTypeOnlyAndRecovers(t *testing.T) {
	const baseNow int64 = 1793448000
	c := loadCacheTestCatalog(t)

	var rawCanary [16]byte
	if _, err := rand.Read(rawCanary[:]); err != nil {
		t.Fatal(err)
	}
	canary := "canary-" + hex.EncodeToString(rawCanary[:])

	var (
		upstreamCalls     atomic.Int32
		panicMode         atomic.Int32 // 1 = string panic, 2 = custom struct panic, 3 = abandoned panic, 0 = healthy 200 OK
		parseStarted      = make(chan struct{})
		parseOnce         sync.Once
		releaseParse      = make(chan struct{})
		resolveStarted    = make(chan struct{})
		resolveOnce       sync.Once
		releaseResolve    = make(chan struct{})
		abandonedStarted  = make(chan struct{})
		abandonedFinished = make(chan struct{})
	)
	panicMode.Store(1)

	adapter := AdapterFunc(func(ctx context.Context, source string, now int64) (unified.Object, error) {
		upstreamCalls.Add(1)
		switch panicMode.Load() {
		case 1:
			parseOnce.Do(func() { close(parseStarted) })
			<-releaseParse
			panic("adapter exploded on " + source + " " + canary)
		case 2:
			resolveOnce.Do(func() { close(resolveStarted) })
			<-releaseResolve
			panic(canaryPanicPayload{detail: "resolve boom " + source + " " + canary})
		case 3:
			defer close(abandonedFinished)
			close(abandonedStarted)
			<-ctx.Done()
			panic("abandoned panic " + source + " " + canary)
		default:
			exp := time.Unix(now+1800, 0).UTC().Format(time.RFC3339)
			return makeSyntheticEnvelope("bilibili", source, now, exp, "part-1", "part-2"), nil
		}
	})

	h, err := New(c, map[string]Adapter{"bilibili": adapter}, func() time.Time { return time.Unix(baseNow, 0) }, nil)
	if err != nil {
		t.Fatal(err)
	}

	var (
		logMu     sync.Mutex
		panicLogs []string
	)
	h.panicLogf = func(format string, args ...any) {
		line := fmt.Sprintf(format, args...)
		logMu.Lock()
		panicLogs = append(panicLogs, line)
		logMu.Unlock()
	}

	waitForWaiters := func(want int) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			h.cache.mu.Lock()
			got := 0
			for _, call := range h.cache.inflight {
				got = call.waiters
			}
			h.cache.mu.Unlock()
			if got == want {
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for %d coalesced waiters", want)
	}

	assertInternalError500 := func(idx int, w *httptest.ResponseRecorder) {
		t.Helper()
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("caller %d: status=%d, want 500 body=%s", idx, w.Code, w.Body.String())
		}
		if got := w.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("caller %d: Cache-Control=%q, want no-store", idx, got)
		}
		if got := w.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
			t.Fatalf("caller %d: Content-Type=%q", idx, got)
		}
		bodyStr := w.Body.String()
		for _, forbidden := range []string{canary, "bilibili.com", "BV1panic999", "exploded", "boom"} {
			if strings.Contains(bodyStr, forbidden) {
				t.Fatalf("caller %d: response leaked %q: %s", idx, forbidden, bodyStr)
			}
		}
		doc, err := unified.Decode(w.Body.Bytes())
		if err != nil {
			t.Fatalf("caller %d: invalid JSON response: %v", idx, err)
		}
		if err := unified.ValidateEnvelope(doc); err != nil {
			t.Fatalf("caller %d: contract validation failed: %v (%s)", idx, err, bodyStr)
		}
		if unified.Str(doc["code"]) != "INTERNAL_ERROR" || unified.Str(unified.Map(doc["error"])["code"]) != "INTERNAL_ERROR" {
			t.Fatalf("caller %d: unexpected error envelope: %v", idx, doc)
		}
	}

	// 1. 10 active + 2 concurrently-canceling same-key /api/parse callers when adapter panics with string.
	const (
		activeParseWaiters   = 10
		canceledParseWaiters = 2
		totalParseWaiters    = activeParseWaiters + canceledParseWaiters
	)
	rawURL1 := "https://www.bilibili.com/video/BV1panic999?p=2&from=" + canary
	rawURL2 := "HTTPS://WWW.BILIBILI.COM:443/video/BV1panic999?p=2&from=" + canary + "#section"
	parseRecorders := make([]*httptest.ResponseRecorder, totalParseWaiters)
	cancelFuncs := make([]context.CancelFunc, canceledParseWaiters)
	var parseWG sync.WaitGroup
	for i := 0; i < totalParseWaiters; i++ {
		parseRecorders[i] = httptest.NewRecorder()
		target := rawURL1
		if i%2 == 1 {
			target = rawURL2
		}
		req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(target), nil)
		if i >= activeParseWaiters {
			ctx, cancel := context.WithCancel(req.Context())
			cancelFuncs[i-activeParseWaiters] = cancel
			req = req.WithContext(ctx)
		}
		parseWG.Add(1)
		go func(idx int, r *http.Request) {
			defer parseWG.Done()
			h.ServeHTTP(parseRecorders[idx], r)
		}(i, req)
	}

	<-parseStarted
	waitForWaiters(totalParseWaiters)
	for _, cancel := range cancelFuncs {
		go cancel()
	}
	close(releaseParse)
	parseWG.Wait()

	if got := upstreamCalls.Load(); got != 1 {
		t.Fatalf("expected 1 coalesced upstream /api/parse call, got %d", got)
	}
	for i := 0; i < activeParseWaiters; i++ {
		assertInternalError500(i, parseRecorders[i])
	}

	// 2. 5 concurrent same-key /api/resolve callers when adapter panics with a custom error/Stringer struct.
	panicMode.Store(2)
	const resolveWaiters = 5
	resolvePath := "/api/resolve?schema_version=1.0&url=" + url.QueryEscape(rawURL1) + "&item_id=part-2"
	resolveRecorders := make([]*httptest.ResponseRecorder, resolveWaiters)
	var resolveWG sync.WaitGroup
	for i := 0; i < resolveWaiters; i++ {
		resolveRecorders[i] = httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, resolvePath, nil)
		resolveWG.Add(1)
		go func(idx int, r *http.Request) {
			defer resolveWG.Done()
			h.ServeHTTP(resolveRecorders[idx], r)
		}(i, req)
	}

	<-resolveStarted
	waitForWaiters(resolveWaiters)
	close(releaseResolve)
	resolveWG.Wait()

	if got := upstreamCalls.Load(); got != 2 {
		t.Fatalf("expected 2 total upstream calls after /api/resolve panic, got %d", got)
	}
	for i, w := range resolveRecorders {
		assertInternalError500(i, w)
	}

	// Verify panic logs contain ONLY platform + Go panic type (%T), one line per panic.
	logMu.Lock()
	logsCopy := append([]string(nil), panicLogs...)
	logMu.Unlock()
	if len(logsCopy) != 2 {
		t.Fatalf("expected exactly 2 panic log lines, got %d: %v", len(logsCopy), logsCopy)
	}
	wantLines := []string{
		"dokitool: parse panic recovered: platform=bilibili panic_type=string",
		"dokitool: parse panic recovered: platform=bilibili panic_type=api.canaryPanicPayload",
	}
	for i, line := range logsCopy {
		trimmed := strings.TrimSuffix(line, "\n")
		if strings.Contains(trimmed, "\n") || strings.Contains(trimmed, "\r") {
			t.Fatalf("log %d is not single-line: %q", i, line)
		}
		if trimmed != wantLines[i] {
			t.Fatalf("log %d = %q, want %q", i, trimmed, wantLines[i])
		}
		for _, forbidden := range []string{canary, "bilibili.com", "BV1panic999", "p=2", "part-2", "exploded", "boom"} {
			if strings.Contains(line, forbidden) {
				t.Fatalf("log %d leaked %q: %q", i, forbidden, line)
			}
		}
	}

	// Verify neither panic wrote to cache nor left a stale inflight entry.
	if entries, usedBytes := h.cache.stats(); entries != 0 || usedBytes != 0 {
		t.Fatalf("panicked calls polluted parseCache: entries=%d bytes=%d", entries, usedBytes)
	}
	h.cache.mu.Lock()
	inflightAfterPanic := len(h.cache.inflight)
	h.cache.mu.Unlock()
	if inflightAfterPanic != 0 {
		t.Fatalf("stale inflight entries remained after panic: %d", inflightAfterPanic)
	}

	// 3. Immediately next same-key /api/parse and /api/resolve requests re-invoke adapter and succeed (200 OK).
	panicMode.Store(0)
	parsePath := "/api/parse?schema_version=1.0&url=" + url.QueryEscape(rawURL1)
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, parsePath, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("post-panic /api/parse attempt %d status=%d body=%s", i, w.Code, w.Body.String())
		}
	}
	if got := upstreamCalls.Load(); got != 3 {
		t.Fatalf("expected 1 fresh /api/parse invocation followed by cache hit (total=3), got %d", got)
	}

	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, resolvePath, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("post-panic /api/resolve attempt %d status=%d body=%s", i, w.Code, w.Body.String())
		}
	}
	if got := upstreamCalls.Load(); got != 4 {
		t.Fatalf("expected 1 fresh /api/resolve invocation followed by cache hit (total=4), got %d", got)
	}

	// 4. Sole caller cancels (abandoning call) and adapter panics anyway after execCtx cancels:
	// no process crash, no double-close, and single-line type-only log emitted.
	panicMode.Store(3)
	abandonedURL := "https://www.bilibili.com/video/BV1abandoned888?token=" + canary
	abandonedCtx, cancelAbandoned := context.WithCancel(context.Background())
	abandonedReq := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(abandonedURL), nil).WithContext(abandonedCtx)
	var abandonedWG sync.WaitGroup
	abandonedWG.Add(1)
	go func() {
		defer abandonedWG.Done()
		h.ServeHTTP(httptest.NewRecorder(), abandonedReq)
	}()
	<-abandonedStarted
	cancelAbandoned()
	abandonedWG.Wait()
	<-abandonedFinished

	// Wait briefly for runSingleflight's deferred recover + unlock to complete.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		logMu.Lock()
		n := len(panicLogs)
		logMu.Unlock()
		if n == 3 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	logMu.Lock()
	finalLogs := append([]string(nil), panicLogs...)
	logMu.Unlock()
	if len(finalLogs) != 3 || strings.TrimSuffix(finalLogs[2], "\n") != "dokitool: parse panic recovered: platform=bilibili panic_type=string" {
		t.Fatalf("unexpected logs after abandoned panic: %v", finalLogs)
	}
	if strings.Contains(finalLogs[2], canary) || strings.Contains(finalLogs[2], "BV1abandoned888") {
		t.Fatalf("abandoned panic log leaked sensitive input: %q", finalLogs[2])
	}
}

func TestLoadCacheConfigAndDisabledSwitchBypassesCacheAndSingleflight(t *testing.T) {
	if _, err := LoadCacheConfig(nil); err == nil {
		t.Fatal("expected LoadCacheConfig(nil) to fail")
	}

	for _, val := range []string{"", "on"} {
		cfg, err := LoadCacheConfig(func(k string) string {
			if k == "DOKITOOL_PARSE_CACHE" {
				return val
			}
			return ""
		})
		if err != nil {
			t.Fatalf("LoadCacheConfig(%q) unexpected error: %v", val, err)
		}
		if cfg != DefaultCacheConfig() || cfg.Disabled {
			t.Fatalf("LoadCacheConfig(%q) = %+v, want %+v", val, cfg, DefaultCacheConfig())
		}
	}

	offCfg, err := LoadCacheConfig(func(k string) string {
		if k == "DOKITOOL_PARSE_CACHE" {
			return "off"
		}
		return ""
	})
	if err != nil {
		t.Fatalf("LoadCacheConfig(\"off\") unexpected error: %v", err)
	}
	if !offCfg.Disabled || offCfg.MaxEntries != 0 || offCfg.MaxBytes != 0 {
		t.Fatalf("LoadCacheConfig(\"off\") = %+v, want Disabled=true", offCfg)
	}

	for _, bad := range []string{"ON", "OFF", "On", "Off", " on", "off ", "on\n", "true", "false", "1", "0", "auto", "disabled"} {
		cfg, err := LoadCacheConfig(func(k string) string {
			if k == "DOKITOOL_PARSE_CACHE" {
				return bad
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "DOKITOOL_PARSE_CACHE must be on or off") {
			t.Fatalf("LoadCacheConfig(%q) = (%+v, %v), want startup error", bad, cfg, err)
		}
	}

	// Verify DOKITOOL_PARSE_CACHE=off wired into NewWithCacheConfig bypasses BOTH parseCache and singleflight.
	const baseNow int64 = 1793448000
	c := loadCacheTestCatalog(t)

	var (
		upstreamCalls atomic.Int32
		concurrentIn  atomic.Int32
		bothEntered   = make(chan struct{})
		bothOnce      sync.Once
		useBarrier    atomic.Bool
	)
	useBarrier.Store(true)

	adapter := AdapterFunc(func(ctx context.Context, source string, now int64) (unified.Object, error) {
		upstreamCalls.Add(1)
		if useBarrier.Load() {
			if concurrentIn.Add(1) >= 2 {
				bothOnce.Do(func() { close(bothEntered) })
			}
			select {
			case <-bothEntered:
			case <-time.After(2 * time.Second):
				return nil, errors.New("second concurrent caller was coalesced instead of bypassing singleflight")
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		exp := time.Unix(now+1800, 0).UTC().Format(time.RFC3339)
		return makeSyntheticEnvelope("kuaishou", source, now, exp, "ks-1"), nil
	})

	h, err := NewWithCacheConfig(c, map[string]Adapter{"kuaishou": adapter}, func() time.Time {
		return time.Unix(baseNow, 0)
	}, nil, offCfg)
	if err != nil {
		t.Fatal(err)
	}

	parsePath := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.kuaishou.com/short-video/3xdisabled1")
	var wg sync.WaitGroup
	recs := [2]*httptest.ResponseRecorder{httptest.NewRecorder(), httptest.NewRecorder()}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			h.ServeHTTP(recs[idx], httptest.NewRequest(http.MethodGet, parsePath, nil))
		}(i)
	}
	wg.Wait()
	for i, w := range recs {
		if w.Code != http.StatusOK {
			t.Fatalf("concurrent disabled caller %d status=%d body=%s", i, w.Code, w.Body.String())
		}
	}
	if got := upstreamCalls.Load(); got != 2 {
		t.Fatalf("expected 2 uncoalesced upstream calls when DOKITOOL_PARSE_CACHE=off, got %d", got)
	}

	// Sequential /api/parse and /api/resolve must also bypass parseCache every time.
	useBarrier.Store(false)
	wParse := httptest.NewRecorder()
	h.ServeHTTP(wParse, httptest.NewRequest(http.MethodGet, parsePath, nil))
	if wParse.Code != http.StatusOK || upstreamCalls.Load() != 3 {
		t.Fatalf("sequential /api/parse with cache off: status=%d calls=%d", wParse.Code, upstreamCalls.Load())
	}

	resolvePath := "/api/resolve?schema_version=1.0&url=" + url.QueryEscape("https://www.kuaishou.com/short-video/3xdisabled1") + "&item_id=ks-1"
	for i := 0; i < 2; i++ {
		wRes := httptest.NewRecorder()
		h.ServeHTTP(wRes, httptest.NewRequest(http.MethodGet, resolvePath, nil))
		if wRes.Code != http.StatusOK {
			t.Fatalf("sequential /api/resolve %d status=%d body=%s", i, wRes.Code, wRes.Body.String())
		}
	}
	if got := upstreamCalls.Load(); got != 5 {
		t.Fatalf("expected 5 total upstream calls with DOKITOOL_PARSE_CACHE=off, got %d", got)
	}
	if entries, usedBytes := h.cache.stats(); entries != 0 || usedBytes != 0 {
		t.Fatalf("disabled parseCache stored data: entries=%d bytes=%d", entries, usedBytes)
	}
}

// TestBenchmarkLocalFakeUpstreamBeforeAfter runs an offline httptest load
// comparison when DOKITOOL_RUN_CACHE_BENCH=1 is set (0 real network calls):
//   - simulates fast pure-Go (0.5s), Shanghai channel (0.8s), slow yt-dlp (3.0s),
//     and multi-P Bilibili /api/resolve (0.5s) workloads across 5/25/60/120 RPS
//     using Production DefaultAdmissionConfig() + Handler.
func TestBenchmarkLocalFakeUpstreamBeforeAfter(t *testing.T) {
	if os.Getenv("DOKITOOL_RUN_CACHE_BENCH") != "1" {
		t.Skip("set DOKITOOL_RUN_CACHE_BENCH=1 to run local fake-upstream before/after benchmark")
	}
	c := loadCacheTestCatalog(t)
	const window = 8 * time.Second

	type benchMetrics struct {
		totalReqs     int
		upstreamCalls int32
		okCount       int
		status429     int
		otherErr      int
		p50MS         float64
		p95MS         float64
		heapInuseKiB  uint64
		peakGoroutine int
		endGoroutine  int
	}

	hotTargets := []string{
		// Fast pure-Go platforms (~0.5s)
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.kuaishou.com/short-video/3xhot1"),
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.kuaishou.com/short-video/3xhot2"),
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.xiaohongshu.com/explore/66hot1?xsec_token=t1"),
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.xiaohongshu.com/explore/66hot2?xsec_token=t2"),
		// Multi-P Bilibili /api/resolve (~0.5s)
		"/api/resolve?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1234567890/?p=1") + "&item_id=p-1",
		"/api/resolve?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1234567890/?p=2") + "&item_id=p-2",
		"/api/resolve?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1234567890/?p=3") + "&item_id=p-3",
		// Shanghai Douyin channel (~0.8s)
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.douyin.com/video/7300001"),
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.douyin.com/video/7300002"),
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.douyin.com/video/7300003"),
		// Slow yt-dlp platform (~3.0s)
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://x.com/user/status/1800001"),
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://x.com/user/status/1800002"),
	}

	runRate := func(rps int, disableCache bool, withAdmission bool) benchMetrics {
		var upstreamCalls atomic.Int32
		mkAdapter := func(platform string, delay time.Duration) Adapter {
			return AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
				upstreamCalls.Add(1)
				timer := time.NewTimer(delay)
				defer timer.Stop()
				select {
				case <-timer.C:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
				exp := time.Unix(now+1800, 0).UTC().Format(time.RFC3339)
				return makeSyntheticEnvelope(platform, src, now, exp, "p-1", "p-2", "p-3", "p-4"), nil
			})
		}

		h, err := NewWithCacheConfig(c, map[string]Adapter{
			"kuaishou":    mkAdapter("kuaishou", 500*time.Millisecond),
			"xiaohongshu": mkAdapter("xiaohongshu", 500*time.Millisecond),
			"bilibili":    mkAdapter("bilibili", 500*time.Millisecond),
			"douyin":      mkAdapter("douyin", 800*time.Millisecond),
			"x":           mkAdapter("x", 3000*time.Millisecond),
		}, time.Now, nil, CacheConfig{
			Disabled:   disableCache,
			MaxEntries: defaultCacheMaxEntries,
			MaxBytes:   defaultCacheMaxBytes,
		})
		if err != nil {
			t.Fatal(err)
		}
		var handler http.Handler = h
		if withAdmission {
			entry, admErr := WithAdmissionConfig(h, nil, "caddy", testEdgeKey, DefaultAdmissionConfig())
			if admErr != nil {
				t.Fatal(admErr)
			}
			handler = entry
		}
		srv := httptest.NewServer(handler)
		defer srv.Close()

		totalReqs := int(window.Seconds()) * rps
		interval := time.Second / time.Duration(rps)

		tr := &http.Transport{
			MaxIdleConns:        256,
			MaxIdleConnsPerHost: 256,
		}
		defer tr.CloseIdleConnections()
		client := &http.Client{Transport: tr, Timeout: 10 * time.Second}

		type sample struct {
			code    int
			latency time.Duration
		}
		results := make([]sample, totalReqs)
		var peakG atomic.Int32
		var wg sync.WaitGroup
		startWall := time.Now()

		for i := 0; i < totalReqs; i++ {
			targetAt := startWall.Add(time.Duration(i) * interval)
			if wait := time.Until(targetAt); wait > 0 {
				time.Sleep(wait)
			}
			if g := int32(runtime.NumGoroutine()); g > peakG.Load() {
				peakG.Store(g)
			}
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				req, reqErr := http.NewRequest(http.MethodGet, srv.URL+hotTargets[idx%len(hotTargets)], nil)
				if reqErr != nil {
					return
				}
				// Distinct visitor IPs so per-IP cap (1 concurrent, 0.2 RPS) does not obscure server behavior.
				req.Header.Set(edgeHeader, testEdgeKey)
				req.Header.Set(clientHeader, fmt.Sprintf("198.51.%d.%d", 1+((idx/250)%250), 1+(idx%250)))
				t0 := time.Now()
				resp, doErr := client.Do(req)
				lat := time.Since(t0)
				if doErr != nil {
					results[idx] = sample{code: 0, latency: lat}
					return
				}
				_ = resp.Body.Close()
				results[idx] = sample{code: resp.StatusCode, latency: lat}
			}(i)
		}
		wg.Wait()
		tr.CloseIdleConnections()

		runtime.GC()
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)

		latencies := make([]float64, 0, totalReqs)
		m := benchMetrics{
			totalReqs:     totalReqs,
			upstreamCalls: upstreamCalls.Load(),
			heapInuseKiB:  mem.HeapAlloc / 1024,
			peakGoroutine: int(peakG.Load()),
			endGoroutine:  runtime.NumGoroutine(),
		}
		for _, r := range results {
			latencies = append(latencies, float64(r.latency.Microseconds())/1000.0)
			switch r.code {
			case http.StatusOK:
				m.okCount++
			case http.StatusTooManyRequests:
				m.status429++
			default:
				m.otherErr++
			}
		}
		sort.Float64s(latencies)
		pct := func(p float64) float64 {
			idx := int(math.Ceil(p*float64(len(latencies)))) - 1
			if idx < 0 {
				idx = 0
			}
			if idx >= len(latencies) {
				idx = len(latencies) - 1
			}
			return latencies[idx]
		}
		m.p50MS = pct(0.50)
		m.p95MS = pct(0.95)
		return m
	}

	for _, withAdmission := range []bool{true, false} {
		mode := "HandlerOnly"
		if withAdmission {
			mode = "WithDefaultAdmission"
		}
		for _, rps := range []int{5, 25, 60, 120} {
			before := runRate(rps, true, withAdmission)
			after := runRate(rps, false, withAdmission)
			t.Logf("[%s] RPS=%d BEFORE: reqs=%d upstream=%d ok=%.1f%% 429=%.1f%% p50=%.2fms p95=%.2fms heap=%dKiB peakG=%d endG=%d",
				mode, rps, before.totalReqs, before.upstreamCalls,
				100*float64(before.okCount)/float64(before.totalReqs),
				100*float64(before.status429)/float64(before.totalReqs),
				before.p50MS, before.p95MS, before.heapInuseKiB, before.peakGoroutine, before.endGoroutine)
			t.Logf("[%s] RPS=%d AFTER:  reqs=%d upstream=%d ok=%.1f%% 429=%.1f%% p50=%.2fms p95=%.2fms heap=%dKiB peakG=%d endG=%d",
				mode, rps, after.totalReqs, after.upstreamCalls,
				100*float64(after.okCount)/float64(after.totalReqs),
				100*float64(after.status429)/float64(after.totalReqs),
				after.p50MS, after.p95MS, after.heapInuseKiB, after.peakGoroutine, after.endGoroutine)
		}
	}
}
