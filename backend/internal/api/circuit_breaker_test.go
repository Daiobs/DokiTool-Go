package api

import (
	"context"
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
	if len(snaps) != 14 || snaps[0].Platform != "douyin" || snaps[0].State != CircuitStateClosed ||
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
