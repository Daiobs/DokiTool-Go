package api

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/bilibili"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/kuaishou"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/pipixia"
	weiboplatform "github.com/Brilliant666/DokiTool-Go/backend/internal/platform/weibo"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/xiaohongshu"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/zuiyou"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func TestUncachedParseAndResolveRecoverPanicsWithoutLeak(t *testing.T) {
	const (
		nowSec = int64(1790000000)
		canary = "SECRET_UNCACHED_CANARY_TOKEN_98765"
	)

	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Register(catalog.YouTubePlatform()); err != nil {
		t.Fatal(err)
	}
	if err := c.Register(catalog.XPlatform()); err != nil {
		t.Fatal(err)
	}

	var (
		logMu     sync.Mutex
		panicLogs []string
	)
	recordPanicLog := func(format string, args ...any) {
		logMu.Lock()
		panicLogs = append(panicLogs, fmt.Sprintf(format, args...))
		logMu.Unlock()
	}

	assertInternal500 := func(t *testing.T, label string, w *httptest.ResponseRecorder) {
		t.Helper()
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("%s: status = %d, want 500; body=%s", label, w.Code, w.Body.String())
		}
		env, err := unified.Decode(w.Body.Bytes())
		if err != nil {
			t.Fatalf("%s: invalid JSON: %v (%s)", label, err, w.Body.String())
		}
		if err := unified.ValidateEnvelopeAt(env, nowSec); err != nil {
			t.Fatalf("%s: ValidateEnvelopeAt failed: %v", label, err)
		}
		if unified.Str(env["code"]) != "INTERNAL_ERROR" {
			t.Fatalf("%s: code = %q, want INTERNAL_ERROR", label, unified.Str(env["code"]))
		}
		if strings.Contains(w.Body.String(), canary) {
			t.Fatalf("%s: response body leaked canary: %s", label, w.Body.String())
		}
	}

	// Suite 1: Cache enabled, exercising all uncacheable request classes (weibo, youtube, >2048B URL)
	// across both /api/parse and /api/resolve (plus publicMedia panic).
	var weiboMediaPanic atomic.Bool
	hEnabled, err := NewWithCacheConfig(c, map[string]Adapter{
		"weibo": AdapterFunc(func(_ context.Context, source string, ts int64) (unified.Object, error) {
			if weiboMediaPanic.Load() {
				exp := time.Unix(ts+1800, 0).UTC().Format(time.RFC3339)
				return makeSyntheticEnvelope("weibo", source, ts, exp, "video-1"), nil
			}
			panic("weibo adapter exploded: " + canary + " url=" + source)
		}),
		"youtube": AdapterFunc(func(_ context.Context, source string, _ int64) (unified.Object, error) {
			panic(canaryPanicPayload{detail: canary + ":" + source})
		}),
		"x": AdapterFunc(func(_ context.Context, source string, _ int64) (unified.Object, error) {
			panic("overlong x panic " + canary + " " + source)
		}),
	}, func() time.Time { return time.Unix(nowSec, 0) }, func(_ context.Context, platform string, payload unified.Object, _ int64) (unified.Object, error) {
		if platform == "weibo" && weiboMediaPanic.Load() {
			panic("publicMedia exploded " + canary)
		}
		return payload, nil
	}, DefaultCacheConfig())
	if err != nil {
		t.Fatal(err)
	}
	// Disable YouTube parse caching in Suite 1 so all 7 cases exercise the uncacheable path.
	rtUncacheYT := DefaultRuntimeConfig()
	rtUncacheYT.Cache.YouTubeParseTTL = 0
	ApplyRuntimeConfig(nil, hEnabled, rtUncacheYT, false, false)
	hEnabled.panicLogf = recordPanicLog

	longXURL := "https://x.com/i/status/1800000000000000001?pad=" + strings.Repeat("a", maxYTDLPInputBytes+32) + "&tok=" + canary
	enabledCases := []struct {
		name     string
		route    string
		rawURL   string
		itemID   string
		owner    bool
		mediaPan bool
		wantLog  string
	}{
		{
			name:    "weibo-parse-anon",
			route:   "/api/parse",
			rawURL:  "https://weibo.com/1234567890/AbCdEfGhI?tok=" + canary,
			wantLog: "dokitool: parse panic recovered: platform=weibo panic_type=string",
		},
		{
			name:    "weibo-resolve-owner",
			route:   "/api/resolve",
			rawURL:  "https://weibo.com/1234567890/AbCdEfGhI?tok=" + canary,
			itemID:  "video-1",
			owner:   true,
			wantLog: "dokitool: parse panic recovered: platform=weibo panic_type=string",
		},
		{
			name:     "weibo-publicMedia-panic",
			route:    "/api/parse",
			rawURL:   "https://weibo.com/1234567890/AbCdEfGhI",
			mediaPan: true,
			wantLog:  "dokitool: parse panic recovered: platform=weibo panic_type=string",
		},
		{
			name:    "youtube-parse-anon",
			route:   "/api/parse",
			rawURL:  "https://www.youtube.com/watch?v=dQw4w9WgXcQ&tok=" + canary,
			wantLog: "dokitool: parse panic recovered: platform=youtube panic_type=api.canaryPanicPayload",
		},
		{
			name:    "youtube-resolve-anon",
			route:   "/api/resolve",
			rawURL:  "https://www.youtube.com/watch?v=dQw4w9WgXcQ&tok=" + canary,
			itemID:  "video-1",
			wantLog: "dokitool: parse panic recovered: platform=youtube panic_type=api.canaryPanicPayload",
		},
		{
			name:    "overlong-x-parse",
			route:   "/api/parse",
			rawURL:  longXURL,
			wantLog: "dokitool: parse panic recovered: platform=x panic_type=string",
		},
		{
			name:    "overlong-x-resolve",
			route:   "/api/resolve",
			rawURL:  longXURL,
			itemID:  "part-2",
			wantLog: "dokitool: parse panic recovered: platform=x panic_type=string",
		},
	}

	for _, tc := range enabledCases {
		weiboMediaPanic.Store(tc.mediaPan)
		target := tc.route + "?schema_version=1.0&url=" + url.QueryEscape(tc.rawURL)
		if tc.itemID != "" {
			target += "&item_id=" + url.QueryEscape(tc.itemID)
		}
		req := httptest.NewRequest(http.MethodGet, target, nil)
		if tc.owner {
			req = req.WithContext(WithOwnerRequest(req.Context()))
		}
		rec := httptest.NewRecorder()
		hEnabled.ServeHTTP(rec, req)
		assertInternal500(t, tc.name, rec)
	}

	sumOutcome := func(snap StatsSnapshot, code string) uint64 {
		var total uint64
		for _, cell := range snap.Requests.ByPlatformCodeChannel {
			if cell.Code == code {
				total += cell.Count
			}
		}
		return total
	}

	snapEnabled := hEnabled.Stats().Snapshot()
	if got := snapEnabled.Requests.Total; got != uint64(len(enabledCases)) {
		t.Fatalf("enabled uncached Requests.Total = %d, want %d", got, len(enabledCases))
	}
	if got := sumOutcome(snapEnabled, "INTERNAL_ERROR"); got != uint64(len(enabledCases)) {
		t.Fatalf("enabled uncached INTERNAL_ERROR count = %d, want %d (%+v)", got, len(enabledCases), snapEnabled.Requests.ByPlatformCodeChannel)
	}
	if snapEnabled.Requests.ByChannel.Anonymous != 6 || snapEnabled.Requests.ByChannel.Owner != 1 {
		t.Fatalf("unexpected channel breakdown: %+v", snapEnabled.Requests.ByChannel)
	}
	if snapEnabled.Cache.Total.Uncacheable != uint64(len(enabledCases)) {
		t.Fatalf("Cache.Total.Uncacheable = %d, want %d", snapEnabled.Cache.Total.Uncacheable, len(enabledCases))
	}
	logMu.Lock()
	enabledLogs := append([]string(nil), panicLogs...)
	panicLogs = nil
	logMu.Unlock()
	if len(enabledLogs) != len(enabledCases) {
		t.Fatalf("expected %d panic logs on uncacheable cases, got %d: %v", len(enabledCases), len(enabledLogs), enabledLogs)
	}
	for i, tc := range enabledCases {
		trimmed := strings.TrimSuffix(enabledLogs[i], "\n")
		if trimmed != tc.wantLog {
			t.Fatalf("%s: log = %q, want %q", tc.name, trimmed, tc.wantLog)
		}
		for _, forbidden := range []string{canary, "weibo.com", "youtube.com", "x.com", "exploded", "AbCdEfGhI", "dQw4w9WgXcQ", "1800000000000000001"} {
			if strings.Contains(enabledLogs[i], forbidden) {
				t.Fatalf("%s: log leaked %q: %q", tc.name, forbidden, enabledLogs[i])
			}
		}
	}

	// Suite 2: DOKITOOL_PARSE_CACHE=off (CacheConfig{Disabled: true}) across /api/parse and /api/resolve.
	hDisabled, err := NewWithCacheConfig(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, source string, _ int64) (unified.Object, error) {
			panic(canaryPanicPayload{detail: canary + ":" + source})
		}),
	}, func() time.Time { return time.Unix(nowSec, 0) }, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}
	hDisabled.panicLogf = recordPanicLog

	for _, target := range []string{
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.douyin.com/video/7300000000000000001?tok="+canary),
		"/api/resolve?schema_version=1.0&url=" + url.QueryEscape("https://www.douyin.com/video/7300000000000000001?tok="+canary) + "&item_id=video-1",
	} {
		rec := httptest.NewRecorder()
		hDisabled.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		assertInternal500(t, "cache-disabled:"+target, rec)
	}

	snapDisabled := hDisabled.Stats().Snapshot()
	if snapDisabled.Requests.Total != 2 || sumOutcome(snapDisabled, "INTERNAL_ERROR") != 2 || snapDisabled.Cache.Total.Uncacheable != 2 {
		t.Fatalf("unexpected stats on cache-disabled panics: requests=%+v cache=%+v", snapDisabled.Requests, snapDisabled.Cache)
	}

	logMu.Lock()
	disabledLogs := append([]string(nil), panicLogs...)
	logMu.Unlock()
	if len(disabledLogs) != 2 {
		t.Fatalf("expected 2 panic logs on cache-disabled handler, got %d: %v", len(disabledLogs), disabledLogs)
	}
	for i, line := range disabledLogs {
		trimmed := strings.TrimSuffix(line, "\n")
		if trimmed != "dokitool: parse panic recovered: platform=douyin panic_type=api.canaryPanicPayload" {
			t.Fatalf("disabled log %d = %q", i, trimmed)
		}
		for _, forbidden := range []string{canary, "douyin.com", "7300000000000000001", "exploded"} {
			if strings.Contains(line, forbidden) {
				t.Fatalf("disabled log %d leaked %q: %q", i, forbidden, line)
			}
		}
	}
}

func TestParseCacheLockFreeReadHitsLazyLRUAndConcurrentRace(t *testing.T) {
	baseTime := time.Unix(1793448000, 0).UTC()

	t.Run("interleaved-read-hits-and-non-full-puts-evict-exact-lru", func(t *testing.T) {
		pc, err := newParseCache(CacheConfig{
			MaxEntries: 4,
			MaxBytes:   1 << 20,
		})
		if err != nil {
			t.Fatal(err)
		}
		mkKey := func(id string) cacheKey {
			return cacheKey{route: "/api/parse", platform: "douyin", url: "https://www.douyin.com/video/" + id}
		}
		mkRes := func(id string) cachedResponse {
			return cachedResponse{status: 200, code: "OK", body: []byte(`{"id":"` + id + `"}`)}
		}
		put := func(id string) {
			pc.mu.Lock()
			pc.putLocked(mkKey(id), mkRes(id), baseTime.Add(60*time.Second))
			pc.mu.Unlock()
		}

		// Insert A(1), B(2), C(3) while cache is not yet full (3 < 4).
		put("A")
		put("B")
		put("C")

		// Pure RLock read hit on A (seq=4), then non-full put D (seq=5).
		// True recency order from MRU to LRU is now: D(5), A(4), C(3), B(2).
		if res, ok := pc.getFresh(mkKey("A"), baseTime); !ok || string(res.body) != `{"id":"A"}` {
			t.Fatalf("expected getFresh(A) hit, got ok=%v res=%+v", ok, res)
		}
		put("D")

		// Put E triggers 1 eviction -> must evict B(2), keeping E, D, A, C!
		put("E")
		if _, ok := pc.getFresh(mkKey("B"), baseTime); ok {
			t.Fatal("expected true LRU entry B to be evicted")
		}
		for _, wantAlive := range []string{"E", "D", "A", "C"} {
			if !pc.fresh(mkKey(wantAlive), baseTime) {
				t.Fatalf("expected %s to remain cached after evicting B", wantAlive)
			}
		}

		// Now C is the oldest untouched entry (seq=3), while A had seq=4, D had seq=5, E had seq=6.
		// Put F triggers 1 eviction -> must evict C(3) in O(1), keeping F, E, D, A!
		put("F")
		if pc.fresh(mkKey("C"), baseTime) {
			t.Fatal("expected next LRU entry C to be evicted")
		}
		for _, wantAlive := range []string{"F", "E", "D", "A"} {
			if !pc.fresh(mkKey(wantAlive), baseTime) {
				t.Fatalf("expected %s to remain cached after evicting C", wantAlive)
			}
		}

		// Exact nanosecond expiry boundary under getFresh and fresh.
		expAt := baseTime.Add(60 * time.Second)
		if _, ok := pc.getFresh(mkKey("A"), expAt.Add(-time.Nanosecond)); !ok {
			t.Fatal("expected getFresh to succeed 1ns before expiresAt")
		}
		if _, ok := pc.getFresh(mkKey("A"), expAt); ok {
			t.Fatal("expected getFresh to return false at exact expiresAt boundary")
		}
		if pc.fresh(mkKey("A"), expAt) {
			t.Fatal("expected fresh to return false at exact expiresAt boundary")
		}
	})

	t.Run("concurrent-rlock-readers-proceed-while-shared-rlock-is-held-and-pass-race", func(t *testing.T) {
		pc, err := newParseCache(CacheConfig{
			MaxEntries: 16,
			MaxBytes:   1 << 20,
		})
		if err != nil {
			t.Fatal(err)
		}
		hotKey := cacheKey{route: "/api/parse", platform: "douyin", url: "https://www.douyin.com/video/hot"}
		pc.mu.Lock()
		pc.putLocked(hotKey, cachedResponse{status: 200, code: "OK", body: []byte(`{"hot":true}`)}, baseTime.Add(time.Minute))
		pc.mu.Unlock()

		// Hold an explicit RLock while 16 concurrent readers call getFresh and fresh:
		// if getFresh or fresh ever attempted Lock(), this would deadlock immediately.
		pc.mu.RLock()
		doneReaders := make(chan struct{})
		go func() {
			var rwg sync.WaitGroup
			for i := 0; i < 16; i++ {
				rwg.Add(1)
				go func() {
					defer rwg.Done()
					for j := 0; j < 50; j++ {
						if !pc.fresh(hotKey, baseTime) {
							t.Errorf("fresh(hotKey) returned false")
						}
						if _, ok := pc.getFresh(hotKey, baseTime); !ok {
							t.Errorf("getFresh(hotKey) returned false")
						}
					}
				}()
			}
			rwg.Wait()
			close(doneReaders)
		}()
		select {
		case <-doneReaders:
		case <-time.After(2 * time.Second):
			pc.mu.RUnlock()
			t.Fatal("concurrent getFresh/fresh blocked while RLock was held")
		}
		pc.mu.RUnlock()

		// High-contention concurrent readers + writers + evictions under -race.
		var wg sync.WaitGroup
		for r := 0; r < 12; r++ {
			wg.Add(1)
			go func(readerID int) {
				defer wg.Done()
				for iter := 0; iter < 400; iter++ {
					id := fmt.Sprintf("item-%d", (readerID+iter)%32)
					k := cacheKey{route: "/api/parse", platform: "douyin", url: "https://www.douyin.com/video/" + id}
					_, _ = pc.getFresh(k, baseTime.Add(time.Duration(iter%90)*time.Second))
					_ = pc.fresh(k, baseTime)
					_, _ = pc.stats()
				}
			}(r)
		}
		for w := 0; w < 4; w++ {
			wg.Add(1)
			go func(writerID int) {
				defer wg.Done()
				for iter := 0; iter < 200; iter++ {
					id := fmt.Sprintf("item-%d", (writerID*7+iter)%32)
					k := cacheKey{route: "/api/parse", platform: "douyin", url: "https://www.douyin.com/video/" + id}
					res := cachedResponse{status: 200, code: "OK", body: []byte(`{"id":"` + id + `"}`)}
					pc.mu.Lock()
					if iter%5 == 0 {
						_, _ = pc.getLocked(k, baseTime.Add(time.Duration(iter%90)*time.Second))
					}
					pc.putLocked(k, res, baseTime.Add(60*time.Second))
					pc.mu.Unlock()
				}
			}(w)
		}
		wg.Wait()

		entries, usedBytes := pc.stats()
		if entries < 0 || entries > 16 || usedBytes < 0 || usedBytes > (1<<20) {
			t.Fatalf("cache bounds violated after concurrent race stress: entries=%d bytes=%d", entries, usedBytes)
		}
	})
}

func TestParseCacheTieredTTLAndShanghaiDegradedFallbackCap(t *testing.T) {
	const startUnix int64 = 1793448000
	baseNow := time.Unix(startUnix, 0).UTC()

	// 1. Direct unit checks on computeCacheTTLForResult across normal, safety-margin, generic, and Shanghai fallback modes.
	distantExp := baseNow.Add(2 * time.Hour).Format(time.RFC3339)
	midExp := baseNow.Add(400 * time.Second).Format(time.RFC3339) // 400s - 60s = 340s (between 300s and 600s)
	nearExp := baseNow.Add(72 * time.Second).Format(time.RFC3339) // 72s - 60s = 12s (< 15s Shanghai cap)
	tooSoon := baseNow.Add(69 * time.Second).Format(time.RFC3339) // 69s - 60s = 9s (< 10s minCacheTTL)

	if ttl, ok := computeCacheTTLForResult("douyin", makeSyntheticEnvelope("douyin", "https://www.douyin.com/video/1", startUnix, ""), baseNow, false); !ok || ttl != 300*time.Second {
		t.Fatalf("normal no-expiry TTL = (%v, %v), want (300s, true)", ttl, ok)
	}
	if ttl, ok := computeCacheTTLForResult("douyin", makeSyntheticEnvelope("douyin", "https://www.douyin.com/video/1", startUnix, distantExp), baseNow, false); !ok || ttl != 600*time.Second {
		t.Fatalf("normal distant-expiry TTL = (%v, %v), want (600s, true)", ttl, ok)
	}
	if ttl, ok := computeCacheTTLForResult("douyin", makeSyntheticEnvelope("douyin", "https://www.douyin.com/video/1", startUnix, midExp), baseNow, false); !ok || ttl != 340*time.Second {
		t.Fatalf("normal safety-margin TTL = (%v, %v), want (340s, true)", ttl, ok)
	}
	if ttl, ok := computeCacheTTLForResult("douyin", makeSyntheticEnvelope("douyin", "https://www.douyin.com/video/1", startUnix, distantExp), baseNow, true); !ok || ttl != 15*time.Second {
		t.Fatalf("douyin Shanghai degraded TTL = (%v, %v), want (15s, true)", ttl, ok)
	}
	if ttl, ok := computeCacheTTLForResult("bilibili", makeSyntheticEnvelope("bilibili", "https://www.bilibili.com/video/BV1234567890", startUnix, distantExp), baseNow, true); !ok || ttl != 15*time.Second {
		t.Fatalf("bilibili Shanghai degraded TTL = (%v, %v), want (15s, true)", ttl, ok)
	}
	if ttl, ok := computeCacheTTLForResult("douyin", makeSyntheticEnvelope("douyin", "https://www.douyin.com/video/1", startUnix, nearExp), baseNow, true); !ok || ttl != 12*time.Second {
		t.Fatalf("media safety margin must still beat 15s Shanghai cap: got (%v, %v), want (12s, true)", ttl, ok)
	}
	if ttl, ok := computeCacheTTLForResult("douyin", makeSyntheticEnvelope("douyin", "https://www.douyin.com/video/1", startUnix, tooSoon), baseNow, true); ok || ttl != 0 {
		t.Fatalf("sub-10s safety margin must remain uncached even on Shanghai fallback: got (%v, %v)", ttl, ok)
	}

	// 2. End-to-end Handler test: degraded Douyin parse (marked via unified.MarkShanghaiFallback) expires at +15s,
	//    then recovers cleanly and caches for 600s!
	c := loadCacheTestCatalog(t)
	var nowSec atomic.Int64
	nowSec.Store(startUnix)
	var degraded atomic.Bool
	degraded.Store(true)
	var calls atomic.Int32

	h, err := New(c, map[string]Adapter{
		"douyin": AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
			calls.Add(1)
			if degraded.Load() {
				unified.MarkShanghaiFallback(ctx)
			}
			exp := time.Unix(now+3600, 0).UTC().Format(time.RFC3339)
			return makeSyntheticEnvelope("douyin", src, now, exp), nil
		}),
	}, func() time.Time { return time.Unix(nowSec.Load(), 0).UTC() }, nil)
	if err != nil {
		t.Fatal(err)
	}

	reqPath := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/7704056737233499999"
	// Initial degraded call
	if w := httptest.NewRecorder(); func() int { h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, reqPath, nil)); return w.Code }() != http.StatusOK {
		t.Fatal("initial degraded call failed")
	}
	// At +14s: still hits 15s degraded cache.
	nowSec.Store(startUnix + 14)
	if w := httptest.NewRecorder(); func() int { h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, reqPath, nil)); return w.Code }() != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("expected degraded cache hit at +14s, calls=%d", calls.Load())
	}
	// Shanghai recovers; at +15s degraded cache expires and re-parses!
	degraded.Store(false)
	nowSec.Store(startUnix + 15)
	if w := httptest.NewRecorder(); func() int { h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, reqPath, nil)); return w.Code }() != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("expected degraded cache expiry at +15s, calls=%d", calls.Load())
	}
	// Healthy result is now cached for 600s (+15s -> +614s stays hit, +615s expires).
	nowSec.Store(startUnix + 15 + 599)
	if w := httptest.NewRecorder(); func() int { h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, reqPath, nil)); return w.Code }() != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("expected recovered cache hit through +599s, calls=%d", calls.Load())
	}
	nowSec.Store(startUnix + 15 + 600)
	if w := httptest.NewRecorder(); func() int { h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, reqPath, nil)); return w.Code }() != http.StatusOK || calls.Load() != 3 {
		t.Fatalf("expected recovered cache expiry at +600s, calls=%d", calls.Load())
	}
}

func TestPlatformTraitsTableConsolidation(t *testing.T) {
	// 1. Cacheability driven by platformTraits.disableParseCache
	for _, uncacheable := range []string{"", "weibo"} {
		if cacheablePlatform(uncacheable) {
			t.Fatalf("cacheablePlatform(%q) = true, want false", uncacheable)
		}
	}
	for _, cacheable := range []string{"douyin", "bilibili", "xiaohongshu", "x", "youtube", "instagram", "facebook", "tumblr", PlatformGeneric} {
		if !cacheablePlatform(cacheable) {
			t.Fatalf("cacheablePlatform(%q) = false, want true", cacheable)
		}
	}

	// 2. Slow-engine & strictInput2048 invariants preserved (youtube now has strictInput2048=true, disableParseCache=false)
	for _, p := range []string{"x", "youtube", "instagram", "facebook", "tumblr", PlatformGeneric} {
		tr := traitsForPlatform(p)
		if !tr.slowEngine || !tr.strictInput2048 || tr.disableParseCache {
			t.Fatalf("platform %q traits = %+v, want slowEngine=true strictInput2048=true disableParseCache=false", p, tr)
		}
	}
	for _, ytAlias := range []string{
		"http://youtube.com/watch?v=dQw4w9WgXcQ",
		"https://m.youtube.com/watch?v=dQw4w9WgXcQ",
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	} {
		if got := normalizeCacheURL("youtube", ytAlias); got != "https://www.youtube.com/watch?v=dQw4w9WgXcQ" {
			t.Fatalf("normalizeCacheURL(youtube, %q) = %q", ytAlias, got)
		}
	}

	// 3. Shanghai fallback 15s TTL cap applies only to Shanghai-enabled platforms (douyin, bilibili)
	const startUnix int64 = 1793448000
	baseNow := time.Unix(startUnix, 0).UTC()
	distantExp := baseNow.Add(2 * time.Hour).Format(time.RFC3339)

	for _, p := range []string{"douyin", "bilibili"} {
		if !traitsForPlatform(p).shanghaiFallbackShortTTL {
			t.Fatalf("expected shanghaiFallbackShortTTL=true for %q", p)
		}
		ttl, ok := computeCacheTTLForResult(p, makeSyntheticEnvelope(p, "https://example.com/1", startUnix, distantExp), baseNow, true)
		if !ok || ttl != shanghaiFallbackCacheTTL {
			t.Fatalf("computeCacheTTLForResult(%q, shanghaiFallback=true) = (%v, %v), want (%v, true)", p, ttl, ok, shanghaiFallbackCacheTTL)
		}
	}
	// Non-Shanghai platform ignores shanghaiFallback=true and keeps normal maxCacheTTL (600s).
	if ttl, ok := computeCacheTTLForResult("xiaohongshu", makeSyntheticEnvelope("xiaohongshu", "https://www.xiaohongshu.com/explore/1", startUnix, distantExp), baseNow, true); !ok || ttl != maxCacheTTL {
		t.Fatalf("xiaohongshu with shanghaiFallback=true = (%v, %v), want (%v, true)", ttl, ok, maxCacheTTL)
	}
	// YouTube caps OK TTL at youtube_parse_ttl (default 120s) while enforcing earliest_expires_at - 60s clamp.
	if ttl, ok := computeCacheTTLForResult("youtube", makeSyntheticEnvelope("youtube", "https://www.youtube.com/watch?v=abc", startUnix, distantExp), baseNow, false); !ok || ttl != defaultYouTubeParseCacheTTL {
		t.Fatalf("youtube OK TTL = (%v, %v), want (%v, true)", ttl, ok, defaultYouTubeParseCacheTTL)
	}
	shortYTExp := baseNow.Add(100 * time.Second).Format(time.RFC3339) // 100s - 60s = 40s < 120s
	if ttl, ok := computeCacheTTLForResult("youtube", makeSyntheticEnvelope("youtube", "https://www.youtube.com/watch?v=abc", startUnix, shortYTExp), baseNow, false); !ok || ttl != 40*time.Second {
		t.Fatalf("youtube short expiry TTL = (%v, %v), want (40s, true)", ttl, ok)
	}
	// PlatformGeneric uses maxOKCacheTTL = genericCacheTTL (60s).
	if ttl, ok := computeCacheTTLForResult(PlatformGeneric, makeSyntheticEnvelope("vimeo", "https://vimeo.com/123", startUnix, distantExp), baseNow, false); !ok || ttl != genericCacheTTL {
		t.Fatalf("PlatformGeneric OK TTL = (%v, %v), want (%v, true)", ttl, ok, genericCacheTTL)
	}
}

// TestChannelDependentPublicMediaMustDisableParseCache is a mandatory safety guard
// preventing any platform whose PublicMedia output varies between anonymous visitors
// and authenticated owner/agent callers (currently weibo) from ever sharing parseCache.
func TestChannelDependentPublicMediaMustDisableParseCache(t *testing.T) {
	const now int64 = 1793448000
	signingKey := strings.Repeat("k", 64)
	weiboPrep := weiboplatform.PreparePublicWithOwner(signingKey, IsOwnerRequest)
	prepareAll := func(ctx context.Context, platform string, payload unified.Object, ts int64) (unified.Object, error) {
		switch platform {
		case "douyin":
			return douyin.PreparePublic(ctx, platform, payload, ts)
		case "bilibili":
			return bilibili.PreparePublic(ctx, platform, payload, ts)
		case "xiaohongshu":
			return xiaohongshu.PreparePublic(ctx, platform, payload, ts)
		case "kuaishou":
			return kuaishou.PreparePublic(ctx, platform, payload, ts)
		case "pipixia":
			return pipixia.PreparePublic(ctx, platform, payload, ts)
		case "zuiyou":
			return zuiyou.PreparePublic(ctx, platform, payload, ts)
		default:
			return weiboPrep(ctx, platform, payload, ts)
		}
	}

	sampleURLs := map[string]struct {
		sourceURL string
		mediaURL  string
	}{
		"douyin":      {"https://www.douyin.com/video/7400000000000000001", "https://v26-web.douyinvod.com/demo/video.mp4"},
		"bilibili":    {"https://www.bilibili.com/video/BV1xx411c7mD", "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/demo.mp4"},
		"weibo":       {"https://weibo.com/tv/show/1034:5000000000000001", "https://f.video.weibocdn.com/000demo.mp4?Expires=1793451600"},
		"toutiao":     {"https://www.toutiao.com/video/7400000000000000001/", "https://v3-default.ixigua.com/demo.mp4"},
		"kuaishou":    {"https://www.kuaishou.com/short-video/3x123", "https://v2.kwaicdn.com/upic/demo.mp4"},
		"pipixia":     {"https://h5.pipix.com/item/7400000000000000001", "https://v1-ppx.ixigua.com/demo.mp4"},
		"pipigx":      {"https://h5.pipigx.com/pp/post/12345", "https://file.ippzone.com/video/demo.mp4"},
		"zuiyou":      {"https://share.xiaochuankeji.cn/hybrid/share/post?pid=12345", "https://tbvideo.ixiaochuan.cn/zyvd/demo.mp4"},
		"xiaohongshu": {"https://www.xiaohongshu.com/explore/66a1b2c3d4e5f6a7b8c9d0e1", "http://sns-video-bd.xhscdn.com/stream/demo.mp4"},
		"x":           {"https://x.com/user/status/1800000000000000001", "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/demo.mp4"},
		"youtube":     {"https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?itag=18"},
		"instagram":   {"https://www.instagram.com/reel/C123456/", "https://scontent.cdninstagram.com/v/demo.mp4"},
		"facebook":    {"https://www.facebook.com/watch/?v=123456", "https://video.xx.fbcdn.net/v/demo.mp4"},
		"tumblr":      {"https://demo.tumblr.com/post/123456", "https://va.media.tumblr.com/tumblr_demo.mp4"},
	}

	anonCtx := context.Background()
	ownerCtx := WithOwnerRequest(context.Background())
	weiboVaried := false

	for i := 0; i < numCorePlatforms; i++ {
		plat := knownPlatforms[i]
		sample, ok := sampleURLs[plat]
		if !ok {
			t.Fatalf("missing sample URL fixture for core platform %q", plat)
		}
		makeInput := func() unified.Object {
			env := makeSyntheticEnvelope(plat, sample.sourceURL, now, "")
			item := unified.Map(unified.Slice(unified.Map(env["data"])["items"])[0])
			unified.Map(item["default"])["url"] = sample.mediaURL
			variant := unified.Map(unified.Slice(item["variants"])[0])
			src := unified.Map(unified.Slice(unified.Map(variant["delivery"])["sources"])[0])
			src["url"] = sample.mediaURL
			return env
		}

		anonOut, err := prepareAll(anonCtx, plat, makeInput(), now)
		if err != nil {
			t.Fatalf("prepareAll(anon, %q) failed: %v", plat, err)
		}
		ownerOut, err := prepareAll(ownerCtx, plat, makeInput(), now)
		if err != nil {
			t.Fatalf("prepareAll(owner, %q) failed: %v", plat, err)
		}
		anonBytes, err := unified.Encode(unified.PublicView(anonOut, false, now))
		if err != nil {
			t.Fatalf("encode anon %q: %v", plat, err)
		}
		ownerBytes, err := unified.Encode(unified.PublicView(ownerOut, false, now))
		if err != nil {
			t.Fatalf("encode owner %q: %v", plat, err)
		}

		variesByChannel := !bytes.Equal(anonBytes, ownerBytes)
		if plat == "weibo" {
			weiboVaried = variesByChannel
		}
		if variesByChannel && !traitsForPlatform(plat).disableParseCache {
			t.Fatalf("SECURITY INVARIANT VIOLATION: platform %q PublicMedia output varies with IsOwnerRequest(ctx), MUST set disableParseCache=true in platformTraits!", plat)
		}
	}
	if !weiboVaried {
		t.Fatal("regression test sanity check failed: weibo PublicMedia did not differ between anonymous and owner")
	}
}
