package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func TestParseCacheTTLRulesAndClockExpiry(t *testing.T) {
	const startUnix int64 = 1793448000
	c := loadCacheTestCatalog(t)

	t.Run("missing-expires_at-uses-300s-and-reparses-after-expiry", func(t *testing.T) {
		var nowSec atomic.Int64
		nowSec.Store(startUnix)
		var calls atomic.Int32
		h, err := New(c, map[string]Adapter{
			"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				calls.Add(1)
				return makeSyntheticEnvelope("douyin", src, now, ""), nil
			}),
		}, func() time.Time { return time.Unix(nowSec.Load(), 0) }, nil)
		if err != nil {
			t.Fatal(err)
		}

		path := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/1001"
		for _, delta := range []int64{0, 150, 299} {
			nowSec.Store(startUnix + delta)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("delta=%ds status=%d", delta, w.Code)
			}
		}
		if calls.Load() != 1 {
			t.Fatalf("expected 1 upstream call before 300s default TTL, got %d", calls.Load())
		}

		nowSec.Store(startUnix + 300)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK || calls.Load() != 2 {
			t.Fatalf("expected re-parse at +300s: status=%d calls=%d", w.Code, calls.Load())
		}
	})

	t.Run("long-expires_at-capped-at-600s", func(t *testing.T) {
		var nowSec atomic.Int64
		nowSec.Store(startUnix)
		var calls atomic.Int32
		h, err := New(c, map[string]Adapter{
			"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				calls.Add(1)
				exp := time.Unix(now+3600, 0).UTC().Format(time.RFC3339)
				return makeSyntheticEnvelope("douyin", src, now, exp), nil
			}),
		}, func() time.Time { return time.Unix(nowSec.Load(), 0) }, nil)
		if err != nil {
			t.Fatal(err)
		}

		path := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/1002"
		for _, delta := range []int64{0, 300, 599} {
			nowSec.Store(startUnix + delta)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("delta=%ds status=%d", delta, w.Code)
			}
		}
		if calls.Load() != 1 {
			t.Fatalf("expected cached hit through +599s, got calls=%d", calls.Load())
		}

		nowSec.Store(startUnix + 600)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK || calls.Load() != 2 {
			t.Fatalf("expected re-parse at +600s cap: status=%d calls=%d", w.Code, calls.Load())
		}
	})

	t.Run("ttl-below-10s-not-cached-and-10s-boundary-cached", func(t *testing.T) {
		var nowSec atomic.Int64
		nowSec.Store(startUnix)
		var shortCalls, exactCalls atomic.Int32
		h, err := New(c, map[string]Adapter{
			"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				if strings.HasSuffix(src, "/short") {
					shortCalls.Add(1)
					// earliest - now - 60s = 69s - 60s = 9s (< 10s -> do NOT cache).
					exp := time.Unix(now+69, 0).UTC().Format(time.RFC3339)
					return makeSyntheticEnvelope("douyin", src, now, exp), nil
				}
				exactCalls.Add(1)
				// earliest - now - 60s = 70s - 60s = 10s (== 10s -> cache for 10s).
				exp := time.Unix(now+70, 0).UTC().Format(time.RFC3339)
				return makeSyntheticEnvelope("douyin", src, now, exp), nil
			}),
		}, func() time.Time { return time.Unix(nowSec.Load(), 0) }, nil)
		if err != nil {
			t.Fatal(err)
		}

		shortPath := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/short"
		for i := 0; i < 2; i++ {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, shortPath, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("short status=%d", w.Code)
			}
		}
		if shortCalls.Load() != 2 {
			t.Fatalf("expected TTL=9s (<10s) not to be cached, got calls=%d", shortCalls.Load())
		}

		exactPath := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/exact"
		for _, delta := range []int64{0, 9} {
			nowSec.Store(startUnix + delta)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, exactPath, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("exact status=%d", w.Code)
			}
		}
		if exactCalls.Load() != 1 {
			t.Fatalf("expected TTL=10s boundary to be cached at +9s, got calls=%d", exactCalls.Load())
		}
		nowSec.Store(startUnix + 10)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, exactPath, nil))
		if w.Code != http.StatusOK || exactCalls.Load() != 2 {
			t.Fatalf("expected TTL=10s boundary to expire at +10s, got status=%d calls=%d", w.Code, exactCalls.Load())
		}
	})

	t.Run("earliest-expiry-across-nested-mux-and-attachment-sources", func(t *testing.T) {
		var nowSec atomic.Int64
		nowSec.Store(startUnix)
		var calls atomic.Int32
		h, err := New(c, map[string]Adapter{
			"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				calls.Add(1)
				longExp := time.Unix(now+3600, 0).UTC().Format(time.RFC3339)
				// Attachment expires at now + 85s => TTL = 85s - 60s = 25s.
				shortAttExp := time.Unix(now+85, 0).UTC().Format(time.RFC3339)
				env := makeSyntheticEnvelope("douyin", src, now, longExp)
				unified.Map(env["data"])["attachments"] = unified.Array{
					unified.Object{
						"id":   "bgm",
						"role": "background_audio",
						"resource": unified.Object{
							"id":   "audio",
							"role": "audio",
							"delivery": unified.Object{
								"kind": "file",
								"sources": unified.Array{
									unified.Object{
										"id":         "s-bgm",
										"url":        "https://cdn.example.com/douyin/bgm.mp3",
										"expires_at": shortAttExp,
									},
								},
							},
						},
					},
				}
				return env, nil
			}),
		}, func() time.Time { return time.Unix(nowSec.Load(), 0) }, nil)
		if err != nil {
			t.Fatal(err)
		}

		path := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/nested-exp"
		for _, delta := range []int64{0, 24} {
			nowSec.Store(startUnix + delta)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("delta=%ds status=%d body=%s", delta, w.Code, w.Body.String())
			}
		}
		if calls.Load() != 1 {
			t.Fatalf("expected hit at +24s, got calls=%d", calls.Load())
		}
		nowSec.Store(startUnix + 25)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK || calls.Load() != 2 {
			t.Fatalf("expected nested attachment expiry to trigger re-parse at +25s, got calls=%d", calls.Load())
		}
	})

	t.Run("slow-parse-evaluates-ttl-against-finish-time", func(t *testing.T) {
		var nowSec atomic.Int64
		nowSec.Store(startUnix)
		var calls atomic.Int32
		h, err := New(c, map[string]Adapter{
			"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				calls.Add(1)
				// expires_at is startNow + 72s, but upstream took 5s so finishNow sees 67s left (67-60 = 7s < 10s).
				exp := time.Unix(now+72, 0).UTC().Format(time.RFC3339)
				nowSec.Add(5)
				return makeSyntheticEnvelope("douyin", src, now, exp), nil
			}),
		}, func() time.Time { return time.Unix(nowSec.Load(), 0) }, nil)
		if err != nil {
			t.Fatal(err)
		}
		path := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/slow-exp"
		for i := 0; i < 2; i++ {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("status=%d", w.Code)
			}
		}
		if calls.Load() != 2 {
			t.Fatalf("expected slow parse leaving <70s at finish not to be cached, got calls=%d", calls.Load())
		}
	})
}

func TestParseCacheErrorCodePolicy(t *testing.T) {
	const startUnix int64 = 1793448000
	c := loadCacheTestCatalog(t)

	t.Run("CONTENT_UNAVAILABLE-cached-for-10s", func(t *testing.T) {
		var nowSec atomic.Int64
		nowSec.Store(startUnix)
		var parseCalls, resolveCalls atomic.Int32
		h, err := New(c, map[string]Adapter{
			"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				if strings.HasSuffix(src, "/deleted") {
					parseCalls.Add(1)
					return unified.ContractError("CONTENT_UNAVAILABLE", "作品已删除或不可见", false), nil
				}
				resolveCalls.Add(1)
				return makeSyntheticEnvelope("douyin", src, now, "", "item-1"), nil
			}),
		}, func() time.Time { return time.Unix(nowSec.Load(), 0) }, nil)
		if err != nil {
			t.Fatal(err)
		}

		parsePath := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/deleted"
		resolveMissingPath := "/api/resolve?schema_version=1.0&url=https://www.douyin.com/video/alive&item_id=missing-part"
		for _, delta := range []int64{0, 9} {
			nowSec.Store(startUnix + delta)
			for _, p := range []string{parsePath, resolveMissingPath} {
				w := httptest.NewRecorder()
				h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, p, nil))
				if w.Code != http.StatusNotFound {
					t.Fatalf("path=%s delta=%ds status=%d, want 404", p, delta, w.Code)
				}
			}
		}
		if parseCalls.Load() != 1 || resolveCalls.Load() != 1 {
			t.Fatalf("expected CONTENT_UNAVAILABLE cached through +9s: parseCalls=%d resolveCalls=%d", parseCalls.Load(), resolveCalls.Load())
		}

		nowSec.Store(startUnix + 10)
		for _, p := range []string{parsePath, resolveMissingPath} {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, p, nil))
			if w.Code != http.StatusNotFound {
				t.Fatalf("path=%s +10s status=%d, want 404", p, w.Code)
			}
		}
		if parseCalls.Load() != 2 || resolveCalls.Load() != 2 {
			t.Fatalf("expected CONTENT_UNAVAILABLE re-parsed at +10s: parseCalls=%d resolveCalls=%d", parseCalls.Load(), resolveCalls.Load())
		}
	})

	t.Run("upstream-blocked-short-negative-cache-5s-and-disableable", func(t *testing.T) {
		var nowSec atomic.Int64
		nowSec.Store(startUnix)
		var calls atomic.Int32
		h, err := New(c, map[string]Adapter{
			"douyin": AdapterFunc(func(_ context.Context, _ string, _ int64) (unified.Object, error) {
				calls.Add(1)
				return unified.ContractError("UPSTREAM_BLOCKED", "作品受限", false), nil
			}),
		}, func() time.Time { return time.Unix(nowSec.Load(), 0) }, nil)
		if err != nil {
			t.Fatal(err)
		}
		p := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/blocked-1"
		w1 := httptest.NewRecorder()
		h.ServeHTTP(w1, httptest.NewRequest(http.MethodGet, p, nil))
		if w1.Code != http.StatusForbidden || calls.Load() != 1 {
			t.Fatalf("initial UPSTREAM_BLOCKED: code=%d calls=%d", w1.Code, calls.Load())
		}
		// At +4s: hits 5s short negative cache.
		nowSec.Store(startUnix + 4)
		w2 := httptest.NewRecorder()
		h.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, p, nil))
		if w2.Code != http.StatusForbidden || calls.Load() != 1 || w2.Header().Get("X-DokiTool-Cache") != "hit" {
			t.Fatalf("+4s UPSTREAM_BLOCKED expected negative cache hit: code=%d calls=%d hdr=%q", w2.Code, calls.Load(), w2.Header().Get("X-DokiTool-Cache"))
		}
		// At +5s: expired -> re-parses (never served as stale!).
		nowSec.Store(startUnix + 5)
		w3 := httptest.NewRecorder()
		h.ServeHTTP(w3, httptest.NewRequest(http.MethodGet, p, nil))
		if w3.Code != http.StatusForbidden || calls.Load() != 2 {
			t.Fatalf("+5s UPSTREAM_BLOCKED expected re-parse: code=%d calls=%d", w3.Code, calls.Load())
		}

		// Disabling via upstream_blocked_neg_ttl=0s skips caching completely.
		rt := DefaultRuntimeConfig()
		rt.Cache.UpstreamBlockedNegTTL = 0
		if !ApplyRuntimeConfig(nil, h, rt, true, false) {
			t.Fatal("ApplyRuntimeConfig failed")
		}
		p2 := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/blocked-2"
		for i := 0; i < 2; i++ {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, p2, nil))
			if w.Code != http.StatusForbidden {
				t.Fatalf("attempt %d status=%d", i+1, w.Code)
			}
		}
		if calls.Load() != 4 {
			t.Fatalf("UPSTREAM_BLOCKED with ttl=0s was cached: calls=%d, want 4", calls.Load())
		}
	})

	t.Run("all-other-errors-never-cached", func(t *testing.T) {
		nonCachedCodes := []struct {
			code       string
			retryable  bool
			wantStatus int
			goErr      error
		}{
			{code: "INVALID_INPUT", retryable: false, wantStatus: 400},
			{code: "UNSUPPORTED_PLATFORM", retryable: false, wantStatus: 400},
			{code: "NO_MEDIA", retryable: false, wantStatus: 404},
			{code: "RATE_LIMITED", retryable: true, wantStatus: 429},
			{code: "UPSTREAM_TIMEOUT", retryable: true, wantStatus: 504},
			{code: "UPSTREAM_UNAVAILABLE", retryable: true, wantStatus: 502},
			{code: "UPSTREAM_INVALID_RESPONSE", retryable: false, wantStatus: 502},
			{code: "SERVICE_NOT_CONFIGURED", retryable: false, wantStatus: 503},
			{code: "ADAPTER_ERROR", wantStatus: 502, goErr: errors.New("synthetic upstream failure")},
		}

		for _, tc := range nonCachedCodes {
			t.Run(tc.code, func(t *testing.T) {
				var calls atomic.Int32
				h, err := New(c, map[string]Adapter{
					"douyin": AdapterFunc(func(_ context.Context, _ string, _ int64) (unified.Object, error) {
						calls.Add(1)
						if tc.goErr != nil {
							return nil, tc.goErr
						}
						return unified.ContractError(tc.code, "失败："+tc.code, tc.retryable), nil
					}),
				}, func() time.Time { return time.Unix(startUnix, 0) }, nil)
				if err != nil {
					t.Fatal(err)
				}

				path := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/err-" + tc.code
				for i := 0; i < 2; i++ {
					w := httptest.NewRecorder()
					h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
					if w.Code != tc.wantStatus {
						t.Fatalf("attempt %d status=%d, want %d", i+1, w.Code, tc.wantStatus)
					}
				}
				if calls.Load() != 2 {
					t.Fatalf("error %s was unexpectedly cached: calls=%d, want 2", tc.code, calls.Load())
				}
			})
		}
	})
}

func TestParseCacheResolveItemsAndViewsNeverCrossContaminate(t *testing.T) {
	const nowUnix int64 = 1793448000
	c := loadCacheTestCatalog(t)
	fixture := loadDouyinSampleEnvelope(t)

	var seenSources sync.Map
	var calls atomic.Int32
	h, err := New(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			calls.Add(1)
			seenSources.Store(src, true)
			return makeSyntheticEnvelope("douyin", src, now, "", "part-1", "part-2", "part-3"), nil
		}),
		"bilibili": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			calls.Add(1)
			partID := "BV1xx411c7mD-p1"
			if strings.Contains(src, "p=2") && !strings.HasSuffix(src, "p=1") {
				partID = "BV1xx411c7mD-p2"
			}
			return makeSyntheticEnvelope("bilibili", src, now, "", partID), nil
		}),
		"xiaohongshu": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			calls.Add(1)
			out := unified.Clone(fixture)
			data := unified.Map(out["data"])
			data["platform"] = "xiaohongshu"
			data["source_url"] = src
			data["refresh_url"] = "/api/parse?schema_version=1.0&url=" + unified.RFC3986Query(src)
			return out, nil
		}),
	}, func() time.Time { return time.Unix(nowUnix, 0) }, nil)
	if err != nil {
		t.Fatal(err)
	}

	// 1. Concurrent /api/resolve requests across part-1, part-2, part-3, and absent part-999 on the same URL.
	const perTarget = 10
	targets := []string{"part-1", "part-2", "part-3", "part-999"}
	var wg sync.WaitGroup
	errs := make(chan error, len(targets)*perTarget)
	for _, itemID := range targets {
		for i := 0; i < perTarget; i++ {
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				q := url.Values{
					"schema_version": {"1.0"},
					"url":            {"https://www.douyin.com/video/multi-999"},
					"item_id":        {id},
				}
				w := httptest.NewRecorder()
				h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/resolve?"+q.Encode(), nil))
				if id == "part-999" {
					if w.Code != http.StatusNotFound {
						errs <- fmt.Errorf("missing item status=%d, want 404", w.Code)
					}
					return
				}
				if w.Code != http.StatusOK {
					errs <- fmt.Errorf("item %s status=%d", id, w.Code)
					return
				}
				env, decErr := unified.Decode(w.Body.Bytes())
				if decErr != nil {
					errs <- decErr
					return
				}
				gotDefault := unified.Str(unified.Map(env["data"])["default_item_id"])
				if gotDefault != id {
					errs <- fmt.Errorf("cross-contamination: requested %q, got default_item_id=%q", id, gotDefault)
				}
			}(itemID)
		}
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}

	// 2. Platform mismatch on an already-cached URL must still return 400 INVALID_INPUT.
	wMismatch := httptest.NewRecorder()
	h.ServeHTTP(wMismatch, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/multi-999&platform=bilibili", nil))
	if wMismatch.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on platform mismatch against warm URL, got %d", wMismatch.Code)
	}

	// 3. Bilibili ?p=1 vs ?p=2 and duplicate query ?p=1&p=2 vs ?p=2&p=1 never collide.
	biliCases := []struct {
		rawURL string
		wantID string
	}{
		{"https://www.bilibili.com/video/BV1xx411c7mD/?p=1", "BV1xx411c7mD-p1"},
		{"https://www.bilibili.com/video/BV1xx411c7mD/?p=2", "BV1xx411c7mD-p2"},
		{"https://www.bilibili.com/video/BV1xx411c7mD/?p=1&p=2", "BV1xx411c7mD-p2"},
		{"https://www.bilibili.com/video/BV1xx411c7mD/?p=2&p=1", "BV1xx411c7mD-p1"},
	}
	for _, bc := range biliCases {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(bc.rawURL), nil))
		if w.Code != http.StatusOK {
			t.Fatalf("bilibili %s status=%d body=%s", bc.rawURL, w.Code, w.Body.String())
		}
		env, err := unified.Decode(w.Body.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		if got := unified.Str(unified.Map(env["data"])["default_item_id"]); got != bc.wantID {
			t.Fatalf("bilibili %s got default_item_id=%q, want %q", bc.rawURL, got, bc.wantID)
		}
	}

	// 4. debug=0 vs debug=1 views never pollute each other's refresh_url or variants.
	xhsURL := "https://www.xiaohongshu.com/explore/66a1b2c3?xsec_token=tokA"
	wNormal := httptest.NewRecorder()
	h.ServeHTTP(wNormal, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(xhsURL), nil))
	wDebug := httptest.NewRecorder()
	h.ServeHTTP(wDebug, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&debug=1&url="+url.QueryEscape(xhsURL), nil))
	if wNormal.Code != http.StatusOK || wDebug.Code != http.StatusOK {
		t.Fatalf("xhs normal=%d debug=%d", wNormal.Code, wDebug.Code)
	}
	envNormal, _ := unified.Decode(wNormal.Body.Bytes())
	envDebug, _ := unified.Decode(wDebug.Body.Bytes())
	if strings.Contains(unified.Str(unified.Map(envNormal["data"])["refresh_url"]), "debug=1") {
		t.Fatal("normal view was polluted with debug=1 refresh_url")
	}
	if !strings.Contains(unified.Str(unified.Map(envDebug["data"])["refresh_url"]), "debug=1") {
		t.Fatal("debug=1 view lost debug=1 refresh_url")
	}
}

func TestParseCacheCanceledWaiterDoesNotAffectOtherCallers(t *testing.T) {
	const nowUnix int64 = 1793448000
	c := loadCacheTestCatalog(t)

	t.Run("leader-and-middle-waiter-cancellation-isolated", func(t *testing.T) {
		var (
			upstreamCalls atomic.Int32
			startedOnce   sync.Once
			started       = make(chan struct{})
			release       = make(chan struct{})
			sawCanceled   atomic.Bool
		)
		h, err := New(c, map[string]Adapter{
			"douyin": AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
				upstreamCalls.Add(1)
				startedOnce.Do(func() { close(started) })
				<-release
				if ctx.Err() != nil {
					sawCanceled.Store(true)
					return nil, ctx.Err()
				}
				return makeSyntheticEnvelope("douyin", src, now, ""), nil
			}),
		}, func() time.Time { return time.Unix(nowUnix, 0) }, nil)
		if err != nil {
			t.Fatal(err)
		}

		target := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/cancel-isolation"

		// Caller 0 is the leader that initiates the upstream flight, then cancels!
		leaderCtx, cancelLeader := context.WithCancel(context.Background())
		leaderDone := make(chan struct{})
		go func() {
			defer close(leaderDone)
			req := httptest.NewRequest(http.MethodGet, target, nil).WithContext(leaderCtx)
			h.ServeHTTP(httptest.NewRecorder(), req)
		}()

		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("leader did not start upstream parse")
		}

		// Launch 9 additional waiters; waiter #4 will also cancel mid-flight.
		const waiters = 9
		midCtx, cancelMid := context.WithCancel(context.Background())
		defer cancelMid()
		recs := make([]*httptest.ResponseRecorder, waiters)
		var wg sync.WaitGroup
		wg.Add(waiters)
		for i := 0; i < waiters; i++ {
			recs[i] = httptest.NewRecorder()
			go func(idx int) {
				defer wg.Done()
				reqCtx := context.Background()
				if idx == 4 {
					reqCtx = midCtx
				}
				req := httptest.NewRequest(http.MethodGet, target, nil).WithContext(reqCtx)
				h.ServeHTTP(recs[idx], req)
			}(i)
		}
		time.Sleep(20 * time.Millisecond)

		// Cancel BOTH the initiating leader and middle waiter #4 while upstream is still blocked!
		cancelLeader()
		cancelMid()
		select {
		case <-leaderDone:
		case <-time.After(time.Second):
			t.Fatal("canceled leader request did not exit promptly")
		}

		// Release upstream parse: all 8 remaining waiters must receive 200 OK.
		close(release)
		wg.Wait()

		if sawCanceled.Load() {
			t.Fatal("upstream parse context was canceled despite active waiters")
		}
		if upstreamCalls.Load() != 1 {
			t.Fatalf("expected 1 upstream call, got %d", upstreamCalls.Load())
		}
		for i, rec := range recs {
			if i == 4 {
				continue
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("surviving waiter %d failed with status=%d body=%s", i, rec.Code, rec.Body.String())
			}
		}

		// Result must also be cached for subsequent callers.
		wAfter := httptest.NewRecorder()
		h.ServeHTTP(wAfter, httptest.NewRequest(http.MethodGet, target, nil))
		if wAfter.Code != http.StatusOK || upstreamCalls.Load() != 1 {
			t.Fatalf("expected post-flight cache hit, got status=%d calls=%d", wAfter.Code, upstreamCalls.Load())
		}
	})

	t.Run("all-waiters-canceled-cancels-upstream-and-does-not-poison-cache", func(t *testing.T) {
		var (
			calls       atomic.Int32
			firstStart  = make(chan struct{})
			firstCancel = make(chan struct{})
		)
		h, err := New(c, map[string]Adapter{
			"douyin": AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
				n := calls.Add(1)
				if n == 1 {
					close(firstStart)
					<-ctx.Done()
					close(firstCancel)
					return nil, ctx.Err()
				}
				return makeSyntheticEnvelope("douyin", src, now, ""), nil
			}),
		}, func() time.Time { return time.Unix(nowUnix, 0) }, nil)
		if err != nil {
			t.Fatal(err)
		}

		target := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/all-canceled"
		ctx1, cancel1 := context.WithCancel(context.Background())
		done1 := make(chan struct{})
		go func() {
			defer close(done1)
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, target, nil).WithContext(ctx1))
		}()
		<-firstStart
		cancel1()
		<-done1
		select {
		case <-firstCancel:
		case <-time.After(2 * time.Second):
			t.Fatal("upstream context was not canceled when the sole waiter disconnected")
		}

		// A subsequent caller starts a clean flight and receives 200 OK.
		w2 := httptest.NewRecorder()
		h.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, target, nil))
		if w2.Code != http.StatusOK || calls.Load() != 2 {
			t.Fatalf("subsequent request after abandoned flight failed: status=%d calls=%d", w2.Code, calls.Load())
		}
	})
}

func TestParseCachePreservesOriginalTimestampsByteForByte(t *testing.T) {
	var nowSec atomic.Int64
	nowSec.Store(1793448000) // 2026-10-31T12:00:00Z
	wantGeneratedAt := time.Unix(1793448000, 0).UTC().Format(time.RFC3339)
	c := loadCacheTestCatalog(t)
	var calls atomic.Int32

	h, err := New(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			calls.Add(1)
			exp := time.Unix(now+3600, 0).UTC().Format(time.RFC3339)
			return makeSyntheticEnvelope("douyin", src, now, exp), nil
		}),
	}, func() time.Time { return time.Unix(nowSec.Load(), 0) }, nil)
	if err != nil {
		t.Fatal(err)
	}

	path := "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/preserve-ts"
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, httptest.NewRequest(http.MethodGet, path, nil))
	if w1.Code != http.StatusOK {
		t.Fatalf("first call status=%d", w1.Code)
	}

	// Advance clock by +120s (still within 180s TTL).
	nowSec.Store(1793448120)
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, path, nil))
	if w2.Code != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("second call status=%d calls=%d", w2.Code, calls.Load())
	}
	if !bytes.Equal(w1.Body.Bytes(), w2.Body.Bytes()) {
		t.Fatalf("cached body mutated across time advance:\nfirst:  %s\nsecond: %s", w1.Body.String(), w2.Body.String())
	}
	env2, err := unified.Decode(w2.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if got := unified.Str(unified.Map(env2["data"])["generated_at"]); got != wantGeneratedAt {
		t.Fatalf("generated_at forged on cache hit: got %q, want %q", got, wantGeneratedAt)
	}
}

func TestParseCacheLRUEvictionByEntryCountAndByteBudget(t *testing.T) {
	const nowUnix int64 = 1793448000
	c := loadCacheTestCatalog(t)

	t.Run("max-entries-lru-eviction", func(t *testing.T) {
		counts := map[string]int{}
		var mu sync.Mutex
		h, err := NewWithCacheConfig(c, map[string]Adapter{
			"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				mu.Lock()
				counts[src]++
				mu.Unlock()
				return makeSyntheticEnvelope("douyin", src, now, ""), nil
			}),
		}, func() time.Time { return time.Unix(nowUnix, 0) }, nil, CacheConfig{
			MaxEntries: 3,
			MaxBytes:   1 << 20,
		})
		if err != nil {
			t.Fatal(err)
		}

		fetchID := func(id string) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/"+id, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("id=%s status=%d", id, w.Code)
			}
		}

		fetchID("a") // [a]
		fetchID("b") // [b, a]
		fetchID("c") // [c, b, a]
		fetchID("a") // promote a -> [a, c, b] (b is LRU)
		fetchID("d") // evict b -> [d, a, c]

		fetchID("a") // hit
		fetchID("c") // hit
		fetchID("d") // hit
		if counts["https://www.douyin.com/video/a"] != 1 ||
			counts["https://www.douyin.com/video/c"] != 1 ||
			counts["https://www.douyin.com/video/d"] != 1 {
			t.Fatalf("expected MRU entries a, c, d to remain cached: counts=%v", counts)
		}

		fetchID("b") // was LRU-evicted -> must re-parse (count becomes 2)
		if counts["https://www.douyin.com/video/b"] != 2 {
			t.Fatalf("expected LRU entry b to be evicted and re-parsed: counts=%v", counts)
		}
		entries, _ := h.cache.stats()
		if entries != 3 {
			t.Fatalf("expected cache entry count capped at 3, got %d", entries)
		}
	})

	t.Run("max-bytes-lru-eviction-and-oversized-skip", func(t *testing.T) {
		// Measure exact entry size for a standard 1-item synthetic response first.
		probeEnv := makeSyntheticEnvelope("douyin", "https://www.douyin.com/video/v1", nowUnix, "")
		probeEnv = unified.PublicView(probeEnv, false, nowUnix)
		probeRes, _ := encodeResponse(200, probeEnv)
		oneEntryBytes := cacheEntrySize(cacheKey{
			route:    "/api/parse",
			platform: "douyin",
			url:      "https://www.douyin.com/video/v1",
		}, probeRes)

		// Budget fits 2 standard entries, not 3.
		budget := oneEntryBytes*2 + 64
		if budget < minCacheMaxBytes {
			budget = minCacheMaxBytes
		}

		counts := map[string]int{}
		var mu sync.Mutex
		h, err := NewWithCacheConfig(c, map[string]Adapter{
			"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				mu.Lock()
				counts[src]++
				mu.Unlock()
				env := makeSyntheticEnvelope("douyin", src, now, "")
				if strings.HasSuffix(src, "/huge") {
					unified.Map(env["data"])["description"] = strings.Repeat("X", int(budget)+512)
				}
				return env, nil
			}),
		}, func() time.Time { return time.Unix(nowUnix, 0) }, nil, CacheConfig{
			MaxEntries: 100,
			MaxBytes:   budget,
		})
		if err != nil {
			t.Fatal(err)
		}

		fetchID := func(id string) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url=https://www.douyin.com/video/"+id, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("id=%s status=%d body=%s", id, w.Code, w.Body.String())
			}
		}

		fetchID("v1") // [v1]
		fetchID("v2") // [v2, v1]
		fetchID("v1") // promote v1 -> [v1, v2] (v2 is LRU)
		fetchID("v3") // exceeds MaxBytes -> evicts v2 -> [v3, v1]

		_, usedBytes := h.cache.stats()
		if usedBytes > budget {
			t.Fatalf("cache totalBytes=%d exceeded MaxBytes=%d", usedBytes, budget)
		}

		// Oversized single entry (> MaxBytes) still returns 200 OK without evicting v1/v3 or entering cache.
		fetchID("huge")
		fetchID("huge")
		if counts["https://www.douyin.com/video/huge"] != 2 {
			t.Fatalf("expected oversized entry not to be cached, got count=%d", counts["https://www.douyin.com/video/huge"])
		}

		fetchID("v1") // still cached!
		fetchID("v3") // still cached!
		fetchID("v2") // was evicted by byte cap -> re-parses
		if counts["https://www.douyin.com/video/v1"] != 1 ||
			counts["https://www.douyin.com/video/v3"] != 1 ||
			counts["https://www.douyin.com/video/v2"] != 2 {
			t.Fatalf("unexpected byte-cap LRU counts: %v", counts)
		}
	})
}
