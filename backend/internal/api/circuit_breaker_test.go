package api

import (
	"context"
	"errors"
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

func TestCircuitBreakerStateMachineAndNoFalsePositives(t *testing.T) {
	baseNow := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	cfg := DefaultRuntimeConfig().CircuitBreaker
	cfg.ConsecutiveFailures = 3
	cfg.WindowSize = 5
	cfg.FailureRateThreshold = 0.6
	cfg.OpenDuration = 30 * time.Second
	cfg.HalfOpenMaxProbes = 2

	cb := newCircuitBreakerManager(cfg)

	// 1. Neutral user/content outcomes MUST NEVER trip the circuit or increment failure counters.
	for _, neutral := range []string{
		"INVALID_INPUT",
		"UNSUPPORTED_PLATFORM",
		"NO_MEDIA",
		"CONTENT_UNAVAILABLE",
		"UPSTREAM_BLOCKED",
		"UNAUTHORIZED",
		"RATE_LIMITED",
		"SERVICE_NOT_CONFIGURED",
	} {
		for i := 0; i < 10; i++ {
			allowed, _, gen := cb.Allow("douyin", baseNow)
			if !allowed {
				t.Fatalf("neutral code %s unexpectedly tripped breaker", neutral)
			}
			cb.Finish("douyin", neutral, gen, baseNow)
		}
	}
	snaps := cb.Snapshot(baseNow)
	if len(snaps) != numCorePlatforms || snaps[0].Platform != "douyin" || snaps[0].State != CircuitStateClosed ||
		snaps[0].ConsecutiveFailures != 0 || snaps[0].WindowFailures != 0 || snaps[0].WindowTotal != 0 {
		t.Fatalf("neutral codes polluted breaker state: %+v", snaps[0])
	}

	// 2. Two genuine failures followed by one OK resets consecutive_failures to 0.
	for _, code := range []string{"UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE"} {
		allowed, _, gen := cb.Allow("douyin", baseNow)
		if !allowed {
			t.Fatalf("unexpected open before threshold on %s", code)
		}
		cb.Finish("douyin", code, gen, baseNow)
	}
	// Neutral codes between failures do not reset or break anything.
	cb.Finish("douyin", "NO_MEDIA", 0, baseNow)
	cb.Finish("douyin", "OK", 0, baseNow)
	if s := cb.Snapshot(baseNow)[0]; s.ConsecutiveFailures != 0 || s.State != CircuitStateClosed || s.WindowFailures != 2 || s.WindowTotal != 3 {
		t.Fatalf("expected OK to reset consecutive failures while keeping closed: %+v", s)
	}

	// 3. Sliding window failure rate trips circuit: window=[F, F, OK, OK, F] -> 3/5 == 0.6 >= 0.6!
	cb.Finish("douyin", "OK", 0, baseNow)
	cb.Finish("douyin", "INTERNAL_ERROR", 0, baseNow) // window has 3 failures / 5 total -> OPEN!
	if s := cb.Snapshot(baseNow)[0]; s.State != CircuitStateOpen || s.OpenUntil != baseNow.Add(30*time.Second).Format(time.RFC3339) {
		t.Fatalf("expected window failure rate 0.6 to open circuit: %+v", s)
	}

	// While open: Allow rejects immediately with remaining Retry-After seconds.
	if allowed, retry, _ := cb.Allow("douyin", baseNow.Add(12*time.Second)); allowed || retry != 18 {
		t.Fatalf("while open at +12s: allowed=%v retry=%d, want false/18", allowed, retry)
	}
	// Other platforms remain completely unaffected!
	if allowed, _, _ := cb.Allow("bilibili", baseNow.Add(12*time.Second)); !allowed {
		t.Fatal("douyin open circuit leaked into bilibili")
	}

	// 4. After OpenDuration (+30s): transitions to half_open, capping concurrent probes at HalfOpenMaxProbes=2.
	tHalf := baseNow.Add(30 * time.Second)
	if s := cb.Snapshot(tHalf)[0]; s.State != CircuitStateHalfOpen || s.OpenUntil != "" {
		t.Fatalf("expected snapshot at +30s to report half_open: %+v", s)
	}
	ok1, _, gen1 := cb.Allow("douyin", tHalf)
	ok2, _, gen2 := cb.Allow("douyin", tHalf)
	ok3, retry3, _ := cb.Allow("douyin", tHalf)
	if !ok1 || !ok2 || gen1 == 0 || gen2 == 0 || ok3 || retry3 != 1 {
		t.Fatalf("half_open probe cap failed: ok1=%v ok2=%v ok3=%v retry3=%d", ok1, ok2, ok3, retry3)
	}

	// Neutral outcome in half_open releases probe slot without re-opening or prematurely closing.
	cb.Finish("douyin", "CONTENT_UNAVAILABLE", gen1, tHalf)
	ok4, _, gen4 := cb.Allow("douyin", tHalf)
	if !ok4 || gen4 == 0 {
		t.Fatal("expected neutral outcome in half_open to release probe slot")
	}

	// Probe failure in half_open immediately re-opens for another 30s!
	cb.Finish("douyin", "UPSTREAM_INVALID_RESPONSE", gen4, tHalf.Add(time.Second))
	if s := cb.Snapshot(tHalf.Add(time.Second))[0]; s.State != CircuitStateOpen ||
		s.OpenUntil != tHalf.Add(31*time.Second).Format(time.RFC3339) {
		t.Fatalf("half_open probe failure did not re-open circuit: %+v", s)
	}
	// Stale probe #2 completing later must not corrupt new state.
	cb.Finish("douyin", "OK", gen2, tHalf.Add(2*time.Second))
	if allowed, _, _ := cb.Allow("douyin", tHalf.Add(2*time.Second)); allowed {
		t.Fatal("stale OK from previous half_open wave closed freshly re-opened circuit")
	}

	// 5. After second cooldown (+61s): single OK in half_open closes circuit and resets window!
	tRecover := tHalf.Add(31 * time.Second)
	okR, _, genR := cb.Allow("douyin", tRecover)
	if !okR || genR == 0 {
		t.Fatal("expected probe admission after second cooldown")
	}
	cb.Finish("douyin", "OK", genR, tRecover)
	if s := cb.Snapshot(tRecover)[0]; s.State != CircuitStateClosed || s.ConsecutiveFailures != 0 || s.WindowFailures != 0 || s.WindowTotal != 1 {
		t.Fatalf("half_open recovery did not cleanly close and reset window: %+v", s)
	}
}

func TestCircuitBreakerAndStaleIfErrorEndToEnd(t *testing.T) {
	const startUnix int64 = 1793448000
	var nowSec atomic.Int64
	nowSec.Store(startUnix)
	clock := func() time.Time { return time.Unix(nowSec.Load(), 0).UTC() }

	c := loadCacheTestCatalog(t)
	var mode atomic.Int32 // 0=OK, 1=UPSTREAM_TIMEOUT(retryable), 2=UPSTREAM_UNAVAILABLE(retryable), 3=NO_MEDIA(non-retryable)
	var calls atomic.Int32

	h, err := New(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			calls.Add(1)
			switch mode.Load() {
			case 1:
				return unified.ContractError("UPSTREAM_TIMEOUT", "抖音上游超时", true), nil
			case 2:
				return unified.ContractError("UPSTREAM_UNAVAILABLE", "抖音上游不可用", true), nil
			case 3:
				return unified.ContractError("NO_MEDIA", "无媒体", false), nil
			default:
				// Media expires at startUnix + 500s -> freshTTL = min(600s, 500-60) = 440s;
				// hardExpiresAt = min(freshUntil + 600s, startUnix + 500s - 15s) = startUnix + 485s!
				exp := time.Unix(startUnix+500, 0).UTC().Format(time.RFC3339)
				return makeSyntheticEnvelope("douyin", src, now, exp), nil
			}
		}),
	}, clock, nil)
	if err != nil {
		t.Fatal(err)
	}

	rt := DefaultRuntimeConfig()
	rt.CircuitBreaker.ConsecutiveFailures = 2
	rt.CircuitBreaker.OpenDuration = 30 * time.Second
	rt.Cache.StaleIfErrorTTL = 600 * time.Second
	if !ApplyRuntimeConfig(nil, h, rt, true, false) {
		t.Fatal("ApplyRuntimeConfig failed")
	}

	target := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.douyin.com/video/7400000000000000001")
	targetNoCache := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.douyin.com/video/7400000000000000002")

	// 1. Cold parse OK -> cached (freshUntil = +440s, hardExpiresAt = +485s).
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, httptest.NewRequest(http.MethodGet, target, nil))
	if w1.Code != http.StatusOK || w1.Header().Get("X-DokiTool-Cache") != "" || calls.Load() != 1 {
		t.Fatalf("cold parse: code=%d cacheHdr=%q calls=%d", w1.Code, w1.Header().Get("X-DokiTool-Cache"), calls.Load())
	}

	// 2. At +100s: fresh cache hit sets X-DokiTool-Cache: hit.
	nowSec.Store(startUnix + 100)
	wHit := httptest.NewRecorder()
	h.ServeHTTP(wHit, httptest.NewRequest(http.MethodGet, target, nil))
	if wHit.Code != http.StatusOK || wHit.Header().Get("X-DokiTool-Cache") != "hit" || calls.Load() != 1 {
		t.Fatalf("fresh hit: code=%d cacheHdr=%q calls=%d", wHit.Code, wHit.Header().Get("X-DokiTool-Cache"), calls.Load())
	}

	// 3. Advance to +450s (past freshUntil +440s, strictly before hardExpiresAt +485s).
	// Upstream fails with retryable UPSTREAM_TIMEOUT -> live refresh fails, serves STALE 200 OK!
	nowSec.Store(startUnix + 450)
	mode.Store(1)
	wStale1 := httptest.NewRecorder()
	h.ServeHTTP(wStale1, httptest.NewRequest(http.MethodGet, target, nil))
	if wStale1.Code != http.StatusOK || wStale1.Header().Get("X-DokiTool-Cache") != "stale" || calls.Load() != 2 {
		t.Fatalf("stale-if-error #1: code=%d cacheHdr=%q calls=%d body=%s", wStale1.Code, wStale1.Header().Get("X-DokiTool-Cache"), calls.Load(), wStale1.Body.String())
	}

	// 4. Second failure triggers circuit breaker OPEN (consecutive_failures == 2) while still serving STALE!
	wStale2 := httptest.NewRecorder()
	h.ServeHTTP(wStale2, httptest.NewRequest(http.MethodGet, target, nil))
	if wStale2.Code != http.StatusOK || wStale2.Header().Get("X-DokiTool-Cache") != "stale" || calls.Load() != 3 {
		t.Fatalf("stale-if-error #2: code=%d cacheHdr=%q calls=%d", wStale2.Code, wStale2.Header().Get("X-DokiTool-Cache"), calls.Load())
	}

	// 5. Circuit is NOW OPEN:
	// (a) Target WITH valid stale cache (< +485s) gets STALE 200 OK with ZERO upstream calls!
	wOpenStale := httptest.NewRecorder()
	h.ServeHTTP(wOpenStale, httptest.NewRequest(http.MethodGet, target, nil))
	if wOpenStale.Code != http.StatusOK || wOpenStale.Header().Get("X-DokiTool-Cache") != "stale" || calls.Load() != 3 {
		t.Fatalf("open circuit stale serve: code=%d cacheHdr=%q calls=%d", wOpenStale.Code, wOpenStale.Header().Get("X-DokiTool-Cache"), calls.Load())
	}

	// (b) Uncached target gets immediate 503 UPSTREAM_UNAVAILABLE fast-fail with ZERO upstream calls!
	wFastFail := httptest.NewRecorder()
	h.ServeHTTP(wFastFail, httptest.NewRequest(http.MethodGet, targetNoCache, nil))
	if wFastFail.Code != http.StatusServiceUnavailable || calls.Load() != 3 {
		t.Fatalf("open circuit fast-fail: code=%d calls=%d body=%s", wFastFail.Code, calls.Load(), wFastFail.Body.String())
	}
	if wFastFail.Header().Get("Retry-After") != "30" {
		t.Fatalf("open circuit Retry-After = %q, want 30", wFastFail.Header().Get("Retry-After"))
	}
	ffEnv, err := unified.Decode(wFastFail.Body.Bytes())
	if err != nil || unified.ValidateEnvelopeAt(ffEnv, nowSec.Load()) != nil {
		t.Fatalf("invalid circuit fast-fail envelope: err=%v body=%s", err, wFastFail.Body.String())
	}
	ffErr := unified.Map(ffEnv["error"])
	if unified.Str(ffEnv["code"]) != "UPSTREAM_UNAVAILABLE" || ffErr["retryable"] != true ||
		unified.Str(ffErr["message"]) != "抖音上游服务暂时响应异常，已触发快速保护，请稍后重试" {
		t.Fatalf("unexpected fast-fail payload: %v", ffEnv)
	}

	// 6. IRON RULE: Advance to +485s (exact earliest_expires_at - 15s boundary).
	// Stale entry MUST NOT be served past earliest_expires_at - 15s!
	nowSec.Store(startUnix + 485)
	// Still inside 30s open window (450+30=480 -> elapsed, let's re-open via failed probe first or test disabled_platforms!)
	rtDisabled := rt
	rtDisabled.CircuitBreaker.DisabledPlatforms = []string{"douyin"}
	ApplyRuntimeConfig(nil, h, rtDisabled, true, true)
	callsBeforeHard := calls.Load()
	wPastHard := httptest.NewRecorder()
	h.ServeHTTP(wPastHard, httptest.NewRequest(http.MethodGet, target, nil))
	if wPastHard.Code != http.StatusServiceUnavailable || calls.Load() != callsBeforeHard || wPastHard.Header().Get("X-DokiTool-Cache") != "" {
		t.Fatalf("IRON RULE VIOLATION: served stale past earliest_expires_at-15s! code=%d cacheHdr=%q calls=%d",
			wPastHard.Code, wPastHard.Header().Get("X-DokiTool-Cache"), calls.Load())
	}
	if wPastHard.Header().Get("Retry-After") != "30" {
		t.Fatalf("disabled_by_config Retry-After = %q, want 30", wPastHard.Header().Get("Retry-After"))
	}

	snap := h.Stats().Snapshot()
	if snap.Cache.Total.StaleHits != 3 || snap.Cache.ByChannel.Anonymous.StaleHits != 3 {
		t.Fatalf("unexpected stale_hits: total=%+v anon=%+v", snap.Cache.Total, snap.Cache.ByChannel.Anonymous)
	}
	if snap.CircuitBreakers[0].Platform != "douyin" || !snap.CircuitBreakers[0].DisabledByConfig || snap.CircuitBreakers[0].State != CircuitStateOpen || snap.CircuitBreakers[0].OpenUntil != "" {
		t.Fatalf("unexpected disabled_by_config snapshot: %+v", snap.CircuitBreakers[0])
	}
}

func TestCircuitBreakerDisabledPlatformAlsoCoversGenericAndConcurrentRace(t *testing.T) {
	c := makeGenericTestCatalog(t)
	var nowSec atomic.Int64
	nowSec.Store(1793448000)
	var genCalls atomic.Int32
	h, err := New(c, nil, func() time.Time { return time.Unix(nowSec.Load(), 0).UTC() }, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.SetGenericAdapter(AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
		genCalls.Add(1)
		return makeGenericOKPayload("vimeo", src, now, ""), nil
	}))

	// Disable ytdlp_generic via runtime config (even with circuit_breaker.enabled=false).
	rt := DefaultRuntimeConfig()
	rt.CircuitBreaker.Enabled = false
	rt.CircuitBreaker.DisabledPlatforms = []string{PlatformGeneric}
	if !ApplyRuntimeConfig(nil, h, rt, true, false) {
		t.Fatal("ApplyRuntimeConfig failed")
	}

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://vimeo.com/123456"), nil))
	if w.Code != http.StatusServiceUnavailable || genCalls.Load() != 0 || !strings.Contains(w.Body.String(), "通用平台上游服务暂时响应异常") {
		t.Fatalf("disabled ytdlp_generic failed: code=%d calls=%d body=%s", w.Code, genCalls.Load(), w.Body.String())
	}

	// Concurrent race stress on circuit breaker Allow/Finish/UpdateConfig/Snapshot.
	cb := newCircuitBreakerManager(DefaultRuntimeConfig().CircuitBreaker)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			base := time.Unix(1793448000, 0).UTC()
			for i := 0; i < 200; i++ {
				now := base.Add(time.Duration(i) * time.Second)
				allowed, _, gen := cb.Allow("douyin", now)
				if allowed {
					code := "OK"
					if (id+i)%3 == 0 {
						code = "UPSTREAM_TIMEOUT"
					}
					cb.Finish("douyin", code, gen, now)
				}
				_ = cb.Snapshot(now)
			}
		}(g)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			cfg := DefaultRuntimeConfig().CircuitBreaker
			cfg.WindowSize = 5 + (i % 10)
			if i%2 == 0 {
				cfg.DisabledPlatforms = []string{"x"}
			}
			cb.UpdateConfig(cfg)
		}
	}()
	wg.Wait()
}

func TestDisabledPlatformImmediateBlockAndCachePurgeM4(t *testing.T) {
	const startUnix int64 = 1793448000
	var nowSec atomic.Int64
	nowSec.Store(startUnix)
	clock := func() time.Time { return time.Unix(nowSec.Load(), 0).UTC() }

	c := loadCacheTestCatalog(t)
	var dyCalls, biliCalls atomic.Int32
	h, err := New(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			dyCalls.Add(1)
			exp := time.Unix(now+1200, 0).UTC().Format(time.RFC3339)
			return makeSyntheticEnvelope("douyin", src, now, exp), nil
		}),
		"bilibili": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			biliCalls.Add(1)
			exp := time.Unix(now+1200, 0).UTC().Format(time.RFC3339)
			return makeSyntheticEnvelope("bilibili", src, now, exp), nil
		}),
	}, clock, nil)
	if err != nil {
		t.Fatal(err)
	}

	ownerTok := randomPrintableToken(t, 48)
	auth, err := NewOwnerAuth(ownerTok)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := WithAdmissionWithOwner(h, nil, "direct", "", DefaultAdmissionConfig(), auth)
	if err != nil {
		t.Fatal(err)
	}

	dyURL := "https://www.douyin.com/video/7400000000000000099"
	dyReq := "/api/parse?schema_version=1.0&url=" + url.QueryEscape(dyURL)
	biliURL := "https://www.bilibili.com/video/BV1xx411c7mD"
	biliReq := "/api/parse?schema_version=1.0&url=" + url.QueryEscape(biliURL)

	// 1. Prime both douyin and bilibili caches (freshUntil = +600s, hardExpiresAt = +1185s).
	for _, path := range []string{dyReq, biliReq} {
		w := httptest.NewRecorder()
		entry.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("prime %s failed: code=%d body=%s", path, w.Code, w.Body.String())
		}
	}
	if !h.HasFreshCachedParse("/api/parse", "schema_version=1.0&url="+url.QueryEscape(dyURL)) {
		t.Fatal("expected douyin to have fresh cache before disable")
	}

	// 2. Disable douyin via ApplyRuntimeConfig -> MUST purge douyin cache immediately (leaving bilibili cached)
	// and block BOTH anonymous and owner-authenticated requests with 503 (never serving fresh OR stale cache).
	rt := DefaultRuntimeConfig()
	rt.CircuitBreaker.DisabledPlatforms = []string{"douyin"}
	if !ApplyRuntimeConfig(entry, h, rt, true, true) {
		t.Fatal("ApplyRuntimeConfig failed")
	}
	if h.HasFreshCachedParse("/api/parse", "schema_version=1.0&url="+url.QueryEscape(dyURL)) {
		t.Fatal("HasFreshCachedParse must return false for disabled platform")
	}
	if entries, _ := h.cache.stats(); entries != 1 {
		t.Fatalf("expected purgePlatforms to remove douyin entry while keeping bilibili (entries=1), got %d", entries)
	}

	// Anonymous request -> immediate 503 with zero upstream calls and zero cache header.
	wAnon := httptest.NewRecorder()
	entry.ServeHTTP(wAnon, httptest.NewRequest(http.MethodGet, dyReq, nil))
	if wAnon.Code != http.StatusServiceUnavailable || dyCalls.Load() != 1 || wAnon.Header().Get("X-DokiTool-Cache") != "" {
		t.Fatalf("disabled platform leaked fresh/stale cache to anon: code=%d calls=%d hdr=%q", wAnon.Code, dyCalls.Load(), wAnon.Header().Get("X-DokiTool-Cache"))
	}

	// Owner-authenticated request (would normally hit post-auth zero-slot cache fast-path) -> MUST also get 503!
	reqOwner := httptest.NewRequest(http.MethodGet, dyReq, nil)
	reqOwner.Header.Set("Authorization", "Bearer "+ownerTok)
	wOwner := httptest.NewRecorder()
	entry.ServeHTTP(wOwner, reqOwner)
	if wOwner.Code != http.StatusServiceUnavailable || dyCalls.Load() != 1 || wOwner.Header().Get("X-DokiTool-Cache") != "" {
		t.Fatalf("disabled platform leaked fresh/stale cache to owner: code=%d calls=%d hdr=%q", wOwner.Code, dyCalls.Load(), wOwner.Header().Get("X-DokiTool-Cache"))
	}

	// Even if a stale entry is manually re-inserted into cache while platform is disabled, ServeHTTP MUST still block with 503.
	ck := cacheKey{route: "/api/parse", platform: "douyin", url: normalizeCacheURL("douyin", dyURL)}
	okRes, _ := encodeResponse(http.StatusOK, makeSyntheticEnvelope("douyin", dyURL, startUnix, time.Unix(startUnix+1200, 0).UTC().Format(time.RFC3339)))
	h.cache.mu.Lock()
	h.cache.putWithStaleLocked(ck, okRes, time.Unix(startUnix+50, 0).UTC(), time.Unix(startUnix+1185, 0).UTC(), true)
	h.cache.mu.Unlock()
	nowSec.Store(startUnix + 200) // inside stale window, past freshUntil
	wStaleBlocked := httptest.NewRecorder()
	entry.ServeHTTP(wStaleBlocked, httptest.NewRequest(http.MethodGet, dyReq, nil))
	if wStaleBlocked.Code != http.StatusServiceUnavailable || wStaleBlocked.Header().Get("X-DokiTool-Cache") != "" {
		t.Fatalf("disabled platform must never serve stale cache: code=%d hdr=%q", wStaleBlocked.Code, wStaleBlocked.Header().Get("X-DokiTool-Cache"))
	}

	// Bilibili remains completely unaffected and hits its fresh cache!
	wBili := httptest.NewRecorder()
	entry.ServeHTTP(wBili, httptest.NewRequest(http.MethodGet, biliReq, nil))
	if wBili.Code != http.StatusOK || wBili.Header().Get("X-DokiTool-Cache") != "hit" || biliCalls.Load() != 1 {
		t.Fatalf("unaffected bilibili cache should remain warm: code=%d hdr=%q calls=%d", wBili.Code, wBili.Header().Get("X-DokiTool-Cache"), biliCalls.Load())
	}
}

func TestCircuitBreakerTimeDecayM5(t *testing.T) {
	baseNow := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	cfg := DefaultRuntimeConfig().CircuitBreaker
	cfg.ConsecutiveFailures = 3
	cfg.WindowSize = 4
	cfg.FailureRateThreshold = 0.5
	cfg.OpenDuration = 60 * time.Second // sampleMaxAge = max(5m, 10*60s) = 10m

	cb := newCircuitBreakerManager(cfg)

	// Record 2 failures at t=0 -> not yet open (threshold=3, windowCount=2 < 4).
	cb.Finish("tumblr", "UPSTREAM_TIMEOUT", 0, baseNow)
	cb.Finish("tumblr", "UPSTREAM_UNAVAILABLE", 0, baseNow.Add(10*time.Second))
	tbIdx := corePlatformIndex("tumblr")
	if s := cb.Snapshot(baseNow.Add(5 * time.Minute))[tbIdx]; s.ConsecutiveFailures != 2 || s.WindowFailures != 2 || s.WindowTotal != 2 {
		t.Fatalf("samples within 10m window should remain intact: %+v", s)
	}

	// Advance past 10m (10m + 11s): both old samples & consecutiveFailures MUST decay to 0!
	tDecayed := baseNow.Add(10*time.Minute + 11*time.Second)
	if s := cb.Snapshot(tDecayed)[tbIdx]; s.State != CircuitStateClosed || s.ConsecutiveFailures != 0 || s.WindowFailures != 0 || s.WindowTotal != 0 {
		t.Fatalf("stale samples did not decay past sampleMaxAge: %+v", s)
	}

	// Another sporadic failure hours later must NOT accumulate with expired failures to trip breaker!
	tNextDay := tDecayed.Add(24 * time.Hour)
	cb.Finish("tumblr", "UPSTREAM_TIMEOUT", 0, tNextDay)
	if s := cb.Snapshot(tNextDay)[tbIdx]; s.State != CircuitStateClosed || s.ConsecutiveFailures != 1 || s.WindowFailures != 1 || s.WindowTotal != 1 {
		t.Fatalf("sporadic cross-day failure tripped or miscounted after decay: %+v", s)
	}
}

func TestStaleFallbackCoversUpstreamInvalidResponseAndInternalErrorM6AndCeilingLow8(t *testing.T) {
	const startUnix int64 = 1793448000
	var nowSec atomic.Int64
	nowSec.Store(startUnix)
	clock := func() time.Time { return time.Unix(nowSec.Load(), 0).UTC() }

	c := loadCacheTestCatalog(t)
	var mode atomic.Int32 // 0=OK, 1=adapter Go error (-> 502 UPSTREAM_INVALID_RESPONSE), 2=INTERNAL_ERROR, 3=retryable RATE_LIMITED
	h, err := New(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			switch mode.Load() {
			case 1:
				return nil, errors.New("synthetic adapter decode failure")
			case 2:
				return unified.ContractError("INTERNAL_ERROR", "内部异常", false), nil
			case 3:
				return unified.ContractError("RATE_LIMITED", "限流", true), nil
			default:
				exp := time.Unix(startUnix+500, 0).UTC().Format(time.RFC3339)
				return makeSyntheticEnvelope("douyin", src, now, exp), nil
			}
		}),
	}, clock, nil)
	if err != nil {
		t.Fatal(err)
	}
	rt := DefaultRuntimeConfig()
	rt.CircuitBreaker.ConsecutiveFailures = 10 // Keep breaker closed so we exercise live stale-if-error directly.
	rt.Cache.StaleIfErrorTTL = 600 * time.Second
	ApplyRuntimeConfig(nil, h, rt, true, false)

	target := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.douyin.com/video/7400000000000000077")
	w0 := httptest.NewRecorder()
	h.ServeHTTP(w0, httptest.NewRequest(http.MethodGet, target, nil))
	if w0.Code != http.StatusOK {
		t.Fatalf("prime failed: %d", w0.Code)
	}

	// Move past freshUntil (+440s) and inside hardExpiresAt (+485s).
	nowSec.Store(startUnix + 450)
	for _, tc := range []struct {
		name string
		mode int32
	}{
		{"adapter-error-UPSTREAM_INVALID_RESPONSE", 1},
		{"non-retryable-INTERNAL_ERROR", 2},
		{"retryable-RATE_LIMITED", 3},
	} {
		mode.Store(tc.mode)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
		if w.Code != http.StatusOK || w.Header().Get("X-DokiTool-Cache") != "stale" {
			t.Fatalf("%s: expected 200 stale fallback, got code=%d hdr=%q body=%s", tc.name, w.Code, w.Header().Get("X-DokiTool-Cache"), w.Body.String())
		}
	}

	// Verify Low-8: non-retryable RATE_LIMITED or NO_MEDIA does NOT trigger stale fallback.
	if isStaleFallbackTrigger(cachedResponse{code: "RATE_LIMITED", retryable: false}) {
		t.Fatal("non-retryable RATE_LIMITED must not trigger stale fallback")
	}
	if isStaleFallbackTrigger(cachedResponse{code: "UPSTREAM_BLOCKED", retryable: true}) {
		t.Fatal("UPSTREAM_BLOCKED must not trigger stale fallback")
	}
	if !isStaleFallbackTrigger(cachedResponse{code: "UPSTREAM_INVALID_RESPONSE", retryable: false}) ||
		!isStaleFallbackTrigger(cachedResponse{code: "INTERNAL_ERROR", retryable: false}) {
		t.Fatal("UPSTREAM_INVALID_RESPONSE and INTERNAL_ERROR must trigger stale fallback")
	}
}

func TestGenericCircuitBreakerSnapshotIsolation(t *testing.T) {
	baseTime := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)

	// 1. Nil stats and fresh handler preserve exact 14-core circuit_breakers array
	//    while exposing ytdlp_generic via dedicated generic_circuit_breaker field.
	nilSnap := (*Stats)(nil).Snapshot()
	if len(nilSnap.CircuitBreakers) != numCorePlatforms {
		t.Fatalf("nil CircuitBreakers len = %d, want %d", len(nilSnap.CircuitBreakers), numCorePlatforms)
	}
	if nilSnap.GenericCircuitBreaker.Platform != PlatformGeneric || nilSnap.GenericCircuitBreaker.State != CircuitStateClosed || nilSnap.GenericCircuitBreaker.DisabledByConfig {
		t.Fatalf("unexpected nil GenericCircuitBreaker: %+v", nilSnap.GenericCircuitBreaker)
	}

	c := makeGenericTestCatalog(t)
	var nowSec atomic.Int64
	nowSec.Store(baseTime.Unix())
	clock := func() time.Time { return time.Unix(nowSec.Load(), 0).UTC() }
	h, err := New(c, nil, clock, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.stats.clock = clock
	var calls atomic.Int32
	h.SetGenericAdapter(AdapterFunc(func(_ context.Context, _ string, _ int64) (unified.Object, error) {
		calls.Add(1)
		return unified.ContractError("UPSTREAM_TIMEOUT", "上游超时", true), nil
	}))

	rt := DefaultRuntimeConfig()
	rt.CircuitBreaker.Enabled = true
	rt.CircuitBreaker.ConsecutiveFailures = 2
	rt.CircuitBreaker.OpenDuration = 30 * time.Second
	if !ApplyRuntimeConfig(nil, h, rt, true, false) {
		t.Fatal("ApplyRuntimeConfig failed")
	}

	reqURL := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://vimeo.com/999001")
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, reqURL, nil))
		if w.Code != http.StatusGatewayTimeout {
			t.Fatalf("attempt %d status = %d, want 504", i+1, w.Code)
		}
	}

	snapOpen := h.Stats().Snapshot()
	if len(snapOpen.CircuitBreakers) != numCorePlatforms {
		t.Fatalf("CircuitBreakers len = %d, want %d", len(snapOpen.CircuitBreakers), numCorePlatforms)
	}
	for _, core := range snapOpen.CircuitBreakers {
		if core.Platform == PlatformGeneric {
			t.Fatalf("ytdlp_generic leaked into 14-core circuit_breakers: %+v", snapOpen.CircuitBreakers)
		}
	}
	if snapOpen.GenericCircuitBreaker.Platform != PlatformGeneric ||
		snapOpen.GenericCircuitBreaker.State != CircuitStateOpen ||
		snapOpen.GenericCircuitBreaker.ConsecutiveFailures != 2 ||
		snapOpen.GenericCircuitBreaker.WindowFailures != 2 ||
		snapOpen.GenericCircuitBreaker.WindowTotal != 2 ||
		snapOpen.GenericCircuitBreaker.OpenUntil == "" ||
		snapOpen.GenericCircuitBreaker.DisabledByConfig {
		t.Fatalf("unexpected open GenericCircuitBreaker: %+v", snapOpen.GenericCircuitBreaker)
	}

	// 2. After open_until elapses, GenericCircuitBreaker reports half_open without mutating state.
	nowSec.Store(baseTime.Add(31 * time.Second).Unix())
	snapHalfOpen := h.Stats().Snapshot()
	if snapHalfOpen.GenericCircuitBreaker.State != CircuitStateHalfOpen || snapHalfOpen.GenericCircuitBreaker.OpenUntil != "" {
		t.Fatalf("expected half_open GenericCircuitBreaker after cooldown, got %+v", snapHalfOpen.GenericCircuitBreaker)
	}

	// 3. Disabled via runtime config sets disabled_by_config=true, state=open, open_until="".
	rt.CircuitBreaker.DisabledPlatforms = []string{PlatformGeneric}
	if !ApplyRuntimeConfig(nil, h, rt, true, false) {
		t.Fatal("ApplyRuntimeConfig disable failed")
	}
	snapDisabled := h.Stats().Snapshot()
	if !snapDisabled.GenericCircuitBreaker.DisabledByConfig ||
		snapDisabled.GenericCircuitBreaker.State != CircuitStateOpen ||
		snapDisabled.GenericCircuitBreaker.OpenUntil != "" {
		t.Fatalf("unexpected disabled GenericCircuitBreaker: %+v", snapDisabled.GenericCircuitBreaker)
	}
}

func TestCircuitBreakerIgnoresCallerScopedFailures(t *testing.T) {
	baseNow := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	cat := loadCacheTestCatalog(t)

	var mode atomic.Int32 // 0 = caller-scoped 502, 1 = real upstream 502, 2 = 200 OK
	adapter := AdapterFunc(func(ctx context.Context, source string, now int64) (unified.Object, error) {
		switch mode.Load() {
		case 0:
			unified.MarkCallerScopedFailure(ctx)
			return unified.ContractError("UPSTREAM_INVALID_RESPONSE", "nxdomain share host", false), nil
		case 1:
			return unified.ContractError("UPSTREAM_UNAVAILABLE", "real upstream outage", true), nil
		default:
			exp := baseNow.Add(10 * time.Minute).Format(time.RFC3339)
			return makeSyntheticEnvelope("pipixia", source, now, exp), nil
		}
	})

	h, err := New(cat, map[string]Adapter{"pipixia": adapter}, func() time.Time { return baseNow }, nil)
	if err != nil {
		t.Fatal(err)
	}
	rt := DefaultRuntimeConfig()
	rt.CircuitBreaker.ConsecutiveFailures = 3
	if !ApplyRuntimeConfig(nil, h, rt, true, false) {
		t.Fatal("ApplyRuntimeConfig failed")
	}

	// 1. Five caller-scoped failures on distinct uncached URLs MUST NOT open the breaker (NV-01).
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://nx"+string(rune('a'+i))+".pipix.com/s/1"), nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusBadGateway {
			t.Fatalf("caller-scoped call %d: got HTTP %d, want 502", i, w.Code)
		}
	}
	for _, snap := range h.Stats().Snapshot().CircuitBreakers {
		if snap.Platform == "pipixia" && (snap.State != CircuitStateClosed || snap.ConsecutiveFailures != 0) {
			t.Fatalf("caller-scoped failures tripped pipixia breaker: %+v", snap)
		}
	}

	// 2. Subsequent healthy request succeeds immediately without 503.
	mode.Store(2)
	reqOK := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://h5.pipix.com/ppx/item/123456"), nil)
	wOK := httptest.NewRecorder()
	h.ServeHTTP(wOK, reqOK)
	if wOK.Code != http.StatusOK {
		t.Fatalf("expected healthy request to succeed after caller-scoped failures, got HTTP %d: %s", wOK.Code, wOK.Body.String())
	}

	// 3. Real upstream outages (unmarked) MUST still trip the breaker after 3 failures.
	mode.Store(1)
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://h5.pipix.com/ppx/item/99900"+string(rune('1'+i))), nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
	}
	reqBlocked := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://h5.pipix.com/ppx/item/888888"), nil)
	wBlocked := httptest.NewRecorder()
	h.ServeHTTP(wBlocked, reqBlocked)
	if wBlocked.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected real upstream outages to open breaker (503), got HTTP %d", wBlocked.Code)
	}
}

func TestCircuitBreakerHalfOpenIgnoresStaleGenerationSuccessAndFailure(t *testing.T) {
	baseNow := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	cfg := DefaultRuntimeConfig().CircuitBreaker
	cfg.ConsecutiveFailures = 2
	cfg.WindowSize = 5
	cfg.FailureRateThreshold = 0.8
	cfg.OpenDuration = 30 * time.Second
	cfg.HalfOpenMaxProbes = 2

	cb := newCircuitBreakerManager(cfg)

	// 1. Trip breaker to Open (consecutiveFailures=2).
	cb.Finish("douyin", "UPSTREAM_TIMEOUT", 0, baseNow)
	cb.Finish("douyin", "UPSTREAM_UNAVAILABLE", 0, baseNow.Add(time.Second))
	if s := cb.Snapshot(baseNow.Add(time.Second))[0]; s.State != CircuitStateOpen {
		t.Fatalf("expected Open after 2 failures, got %+v", s)
	}

	// 2. Enter HalfOpen wave 1 (gen1=1): admit two probes, fail probe A -> re-opens (halfOpenGen becomes 2),
	//    leaving probe B (gen1=1) still in flight.
	tWave1 := baseNow.Add(31 * time.Second)
	okA, _, gen1A := cb.Allow("douyin", tWave1)
	okB, _, gen1B := cb.Allow("douyin", tWave1)
	if !okA || !okB || gen1A == 0 || gen1A != gen1B {
		t.Fatalf("expected two probes in wave 1 with matching gen, got okA=%v okB=%v gen1A=%d gen1B=%d", okA, okB, gen1A, gen1B)
	}
	cb.Finish("douyin", "UPSTREAM_TIMEOUT", gen1A, tWave1.Add(time.Second))

	// 3. Enter HalfOpen wave 2 (gen3=3): admit one active probe.
	tWave2 := tWave1.Add(31 * time.Second)
	okW2, _, genWave2 := cb.Allow("douyin", tWave2)
	if !okW2 || genWave2 <= gen1A {
		t.Fatalf("expected wave 2 probe admission with newer gen > %d, got ok=%v gen=%d", gen1A, okW2, genWave2)
	}
	st := cb.states["douyin"]
	consecBefore := st.consecutiveFailures

	// 4. Stale OK from wave 1 (gen1B) and pre-open slow request (gen=0) MUST NOT close wave 2
	//    or clear consecutiveFailures or decrement halfOpenInFlight.
	cb.Finish("douyin", "OK", gen1B, tWave2.Add(time.Second))
	cb.Finish("douyin", "OK", 0, tWave2.Add(time.Second))
	if st.state != CircuitStateHalfOpen || st.halfOpenGen != genWave2 || st.halfOpenInFlight != 1 || st.consecutiveFailures != consecBefore {
		t.Fatalf("stale OK corrupted active HalfOpen wave: state=%s gen=%d inFlight=%d consec=%d (want HalfOpen gen=%d inFlight=1 consec=%d)",
			st.state, st.halfOpenGen, st.halfOpenInFlight, st.consecutiveFailures, genWave2, consecBefore)
	}

	// 5. Stale FAILURE from wave 1 (gen1B) and pre-open slow request (gen=0) MUST NOT re-open wave 2
	//    or increment consecutiveFailures.
	cb.Finish("douyin", "UPSTREAM_TIMEOUT", gen1B, tWave2.Add(2*time.Second))
	cb.Finish("douyin", "UPSTREAM_UNAVAILABLE", 0, tWave2.Add(2*time.Second))
	if st.state != CircuitStateHalfOpen || st.halfOpenGen != genWave2 || st.halfOpenInFlight != 1 || st.consecutiveFailures != consecBefore {
		t.Fatalf("stale failure corrupted active HalfOpen wave: state=%s gen=%d inFlight=%d consec=%d (want HalfOpen gen=%d inFlight=1 consec=%d)",
			st.state, st.halfOpenGen, st.halfOpenInFlight, st.consecutiveFailures, genWave2, consecBefore)
	}

	// 6. Current-generation probe OK cleanly closes circuit and resets window.
	cb.Finish("douyin", "OK", genWave2, tWave2.Add(3*time.Second))
	if s := cb.Snapshot(tWave2.Add(3 * time.Second))[0]; s.State != CircuitStateClosed || s.ConsecutiveFailures != 0 || s.WindowFailures != 0 || s.WindowTotal != 1 {
		t.Fatalf("current-generation probe OK did not close circuit cleanly: %+v", s)
	}

	// 7. Current-generation probe failure in a subsequent HalfOpen wave cleanly re-opens circuit.
	tTrip2 := tWave2.Add(10 * time.Second)
	cb.Finish("douyin", "UPSTREAM_TIMEOUT", 0, tTrip2)
	cb.Finish("douyin", "UPSTREAM_TIMEOUT", 0, tTrip2.Add(time.Second))
	tWave3 := tTrip2.Add(31 * time.Second)
	okW3, _, genWave3 := cb.Allow("douyin", tWave3)
	if !okW3 || genWave3 == 0 {
		t.Fatalf("expected wave 3 probe admission, got ok=%v gen=%d", okW3, genWave3)
	}
	cb.Finish("douyin", "UPSTREAM_UNAVAILABLE", genWave3, tWave3.Add(time.Second))
	if s := cb.Snapshot(tWave3.Add(time.Second))[0]; s.State != CircuitStateOpen {
		t.Fatalf("current-generation probe failure did not re-open circuit: %+v", s)
	}
}
