package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func TestRuntimeConfigExampleMatchesDefaults(t *testing.T) {
	cfg, err := LoadRuntimeConfigFile("../../../ops/examples/runtime.example.json")
	if err != nil {
		t.Fatalf("LoadRuntimeConfigFile(runtime.example.json) failed: %v", err)
	}
	want := DefaultRuntimeConfig()
	if cfg.SchemaVersion != want.SchemaVersion ||
		cfg.YTDLP != want.YTDLP ||
		cfg.FastPool != want.FastPool ||
		cfg.Cache != want.Cache ||
		cfg.CircuitBreaker.Enabled != want.CircuitBreaker.Enabled ||
		cfg.CircuitBreaker.ConsecutiveFailures != want.CircuitBreaker.ConsecutiveFailures ||
		cfg.CircuitBreaker.WindowSize != want.CircuitBreaker.WindowSize ||
		cfg.CircuitBreaker.FailureRateThreshold != want.CircuitBreaker.FailureRateThreshold ||
		cfg.CircuitBreaker.OpenDuration != want.CircuitBreaker.OpenDuration ||
		cfg.CircuitBreaker.HalfOpenMaxProbes != want.CircuitBreaker.HalfOpenMaxProbes ||
		len(cfg.CircuitBreaker.DisabledPlatforms) != 0 {
		t.Fatalf("runtime.example.json does not match DefaultRuntimeConfig():\ngot:  %+v\nwant: %+v", cfg, want)
	}
}

func TestLoadRuntimeConfigEnvAndFileValidation(t *testing.T) {
	// 1. Unset env returns (DefaultRuntimeConfig(), false, nil).
	cfg, fromFile, err := LoadRuntimeConfig(func(string) string { return "" })
	if err != nil || fromFile || cfg.YTDLP.YouTubeSlots != 4 {
		t.Fatalf("unset LoadRuntimeConfig = (%+v, %v, %v), want defaults/false/nil", cfg, fromFile, err)
	}
	if _, _, err := LoadRuntimeConfig(nil); err == nil {
		t.Fatal("expected nil getenv to fail")
	}
	if _, _, err := LoadRuntimeConfig(func(k string) string {
		if k == EnvRuntimeConfigFile {
			return "   "
		}
		return ""
	}); err == nil {
		t.Fatal("expected whitespace path to fail")
	}

	// 2. Non-existent, directory, and oversized (> 64 KiB) files are rejected without leaking paths.
	dir := t.TempDir()
	secretPath := filepath.Join(dir, "secret-canary-runtime.json")
	if _, _, err := LoadRuntimeConfig(func(k string) string {
		if k == EnvRuntimeConfigFile {
			return secretPath
		}
		return ""
	}); err == nil || strings.Contains(err.Error(), "secret-canary") {
		t.Fatalf("missing file err leaked path or nil: %v", err)
	}
	if _, err := LoadRuntimeConfigFile(dir); err == nil || strings.Contains(err.Error(), dir) {
		t.Fatalf("directory path err leaked path or nil: %v", err)
	}
	overPath := filepath.Join(dir, "oversized.json")
	if err := os.WriteFile(overPath, []byte(`{"schema_version":"1.0","pad":"`+strings.Repeat("a", MaxRuntimeConfigFileBytes)+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadRuntimeConfigFile(overPath); err == nil {
		t.Fatal("expected oversized runtime config file to fail")
	}

	// 3. Partial valid JSON inherits defaults and deduplicates disabled_platforms.
	partialJSON := `{
		"schema_version": "1.0",
		"ytdlp": {"youtube_slots": 6, "social_slots": 6, "generic_slots": 4, "youtube_ejs_concurrency": 1},
		"circuit_breaker": {"disabled_platforms": ["douyin", "ytdlp_generic", "douyin"]},
		"cache": {"youtube_parse_ttl": "0s", "stale_if_error_ttl": "0s", "upstream_blocked_neg_ttl": "0s"}
	}`
	parsed, err := ParseRuntimeConfig([]byte(partialJSON))
	if err != nil {
		t.Fatalf("partial valid runtime config rejected: %v", err)
	}
	if parsed.YTDLP.YouTubeSlots != 6 || parsed.YTDLP.SocialSlots != 6 || parsed.YTDLP.GenericSlots != 4 ||
		parsed.YTDLP.YouTubeEJSConcurrency != 1 || parsed.YTDLP.YouTubeQueueSize != 32 ||
		parsed.FastPool.PerPlatformMaxConcurrency != 24 ||
		parsed.Cache.YouTubeParseTTL != 0 || parsed.Cache.StaleIfErrorTTL != 0 || parsed.Cache.UpstreamBlockedNegTTL != 0 {
		t.Fatalf("unexpected parsed partial config: %+v", parsed)
	}
	if len(parsed.CircuitBreaker.DisabledPlatforms) != 2 ||
		parsed.CircuitBreaker.DisabledPlatforms[0] != "douyin" ||
		parsed.CircuitBreaker.DisabledPlatforms[1] != PlatformGeneric {
		t.Fatalf("disabled_platforms deduplication failed: %v", parsed.CircuitBreaker.DisabledPlatforms)
	}

	// Verify ApplyRuntimeConfigToAdmissionConfig clamps YouTubeEJS.ClientConcurrency when concurrency=1.
	admCfg := DefaultAdmissionConfig()
	ApplyRuntimeConfigToAdmissionConfig(&admCfg, parsed)
	if admCfg.YouTubeEJS.GlobalConcurrency != 1 || admCfg.YouTubeEJS.ClientConcurrency != 1 {
		t.Fatalf("expected YouTubeEJS concurrency clamped to 1/1, got %+v", admCfg.YouTubeEJS)
	}
	if err := admCfg.Validate(); err != nil {
		t.Fatalf("AdmissionConfig.Validate() failed after ApplyRuntimeConfigToAdmissionConfig: %v", err)
	}

	// 4. Exhaustive invalid payloads: unknown fields, trailing garbage, null values, and bound violations.
	badPayloads := []struct {
		name string
		body string
	}{
		{"empty", ""},
		{"array", "[]"},
		{"trailing-garbage", `{"schema_version":"1.0"}{}`},
		{"unknown-top", `{"schema_version":"1.0","extra":1}`},
		{"unknown-ytdlp", `{"schema_version":"1.0","ytdlp":{"unknown":1}}`},
		{"unknown-fast-pool", `{"schema_version":"1.0","fast_pool":{"unknown":1}}`},
		{"unknown-cb", `{"schema_version":"1.0","circuit_breaker":{"unknown":1}}`},
		{"unknown-cache", `{"schema_version":"1.0","cache":{"unknown":1}}`},
		{"null-section", `{"schema_version":"1.0","ytdlp":null}`},
		{"null-leaf", `{"schema_version":"1.0","ytdlp":{"youtube_slots":null}}`},
		{"bad-schema-version", `{"schema_version":"2.0"}`},
		{"missing-schema-version", `{}`},
		{"yt-slots-0", `{"schema_version":"1.0","ytdlp":{"youtube_slots":0}}`},
		{"yt-slots-17", `{"schema_version":"1.0","ytdlp":{"youtube_slots":17}}`},
		{"social-slots-0", `{"schema_version":"1.0","ytdlp":{"social_slots":0}}`},
		{"social-slots-17", `{"schema_version":"1.0","ytdlp":{"social_slots":17}}`},
		{"generic-slots-0", `{"schema_version":"1.0","ytdlp":{"generic_slots":0}}`},
		{"generic-slots-13", `{"schema_version":"1.0","ytdlp":{"generic_slots":13}}`},
		{"total-slots-33", `{"schema_version":"1.0","ytdlp":{"youtube_slots":16,"social_slots":16,"generic_slots":1}}`},
		{"queue-size-neg", `{"schema_version":"1.0","ytdlp":{"youtube_queue_size":-1}}`},
		{"queue-size-over", `{"schema_version":"1.0","ytdlp":{"social_queue_size":1025}}`},
		{"queue-wait-neg", `{"schema_version":"1.0","ytdlp":{"generic_queue_wait":"-1s"}}`},
		{"queue-wait-over", `{"schema_version":"1.0","ytdlp":{"youtube_ejs_queue_wait":"31s"}}`},
		{"queue-wait-invalid", `{"schema_version":"1.0","ytdlp":{"youtube_queue_wait":"not-a-dur"}}`},
		{"ejs-conc-0", `{"schema_version":"1.0","ytdlp":{"youtube_ejs_concurrency":0}}`},
		{"ejs-conc-17", `{"schema_version":"1.0","ytdlp":{"youtube_ejs_concurrency":17}}`},
		{"fast-per-plat-1", `{"schema_version":"1.0","fast_pool":{"per_platform_max_concurrency":1}}`},
		{"fast-per-plat-257", `{"schema_version":"1.0","fast_pool":{"per_platform_max_concurrency":257}}`},
		{"cb-consec-0", `{"schema_version":"1.0","circuit_breaker":{"consecutive_failures":0}}`},
		{"cb-consec-101", `{"schema_version":"1.0","circuit_breaker":{"consecutive_failures":101}}`},
		{"cb-win-0", `{"schema_version":"1.0","circuit_breaker":{"window_size":0}}`},
		{"cb-win-201", `{"schema_version":"1.0","circuit_breaker":{"window_size":201}}`},
		{"cb-rate-0", `{"schema_version":"1.0","circuit_breaker":{"failure_rate_threshold":0}}`},
		{"cb-rate-over", `{"schema_version":"1.0","circuit_breaker":{"failure_rate_threshold":1.01}}`},
		{"cb-open-4s", `{"schema_version":"1.0","circuit_breaker":{"open_duration":"4s"}}`},
		{"cb-open-601s", `{"schema_version":"1.0","circuit_breaker":{"open_duration":"601s"}}`},
		{"cb-probes-0", `{"schema_version":"1.0","circuit_breaker":{"half_open_max_probes":0}}`},
		{"cb-probes-17", `{"schema_version":"1.0","circuit_breaker":{"half_open_max_probes":17}}`},
		{"cb-disabled-unknown", `{"schema_version":"1.0","circuit_breaker":{"disabled_platforms":["vimeo"]}}`},
		{"cache-yt-ttl-over", `{"schema_version":"1.0","cache":{"youtube_parse_ttl":"601s"}}`},
		{"cache-yt-ttl-neg", `{"schema_version":"1.0","cache":{"youtube_parse_ttl":"-1s"}}`},
		{"cache-stale-over", `{"schema_version":"1.0","cache":{"stale_if_error_ttl":"3601s"}}`},
		{"cache-neg-over", `{"schema_version":"1.0","cache":{"upstream_blocked_neg_ttl":"61s"}}`},
	}
	for _, tc := range badPayloads {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseRuntimeConfig([]byte(tc.body)); err == nil {
				t.Fatalf("expected invalid runtime config %s to be rejected", tc.name)
			}
		})
	}

	// Boundary acceptance: 16 + 14 + 2 == 32 slots.
	boundaryJSON := `{"schema_version":"1.0","ytdlp":{"youtube_slots":16,"social_slots":14,"generic_slots":2}}`
	if _, err := ParseRuntimeConfig([]byte(boundaryJSON)); err != nil {
		t.Fatalf("expected total 32 slots to pass: %v", err)
	}
}

func TestApplyRuntimeConfigInPlacePreservesLeasesAndWakesWaiters(t *testing.T) {
	c := loadCacheTestCatalog(t)
	now := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	h, err := New(c, nil, func() time.Time { return now }, nil)
	if err != nil {
		t.Fatal(err)
	}
	cfg := DefaultAdmissionConfig()
	cfg.SlowParse.GlobalConcurrency = 2
	cfg.SlowParse.QueueSize = 8
	cfg.SlowParse.QueueWait = 5 * time.Second
	cfg.SlowParse.ClientBurst = 10
	cfg.SlowParse.ClientRPS = 10
	cfg.SlowParse.GlobalBurst = 50
	cfg.SlowParse.GlobalRPS = 50

	entry, err := WithAdmissionConfig(h, nil, "caddy", testEdgeKey, cfg)
	if err != nil {
		t.Fatal(err)
	}
	adm := entry.(*admission)
	origSlowPtr := adm.slow

	// Acquire 2 active leases on social slow pool.
	rel1, retry1 := adm.slow.acquire(netip.MustParseAddr("198.51.100.1"), now)
	rel2, retry2 := adm.slow.acquire(netip.MustParseAddr("198.51.100.2"), now)
	if retry1 != 0 || retry2 != 0 {
		t.Fatalf("initial acquires failed: retry1=%d retry2=%d", retry1, retry2)
	}

	// Queue 3 FIFO waiters.
	type waiterResult struct {
		idx     int
		release func()
		retry   int
	}
	woken := make(chan waiterResult, 3)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ip := netip.MustParseAddr("198.51.100." + string(rune('3'+idx)))
			rel, retry, canceled := adm.slow.acquireContext(context.Background(), ip, now)
			if canceled {
				t.Errorf("waiter %d unexpectedly canceled", idx)
				return
			}
			woken <- waiterResult{idx: idx, release: rel, retry: retry}
		}(i)
	}

	// Wait until all 3 waiters are queued.
	deadline := time.Now().Add(2 * time.Second)
	for {
		snap := adm.slow.statsSnapshot()
		if snap.Active == 2 && snap.Queued == 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("waiters did not enqueue in time: %+v", snap)
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Hot-reload: increase social_slots from 2 -> 4 in-place!
	nextRT := DefaultRuntimeConfig()
	nextRT.YTDLP.SocialSlots = 4
	nextRT.YTDLP.YouTubeSlots = 6
	nextRT.YTDLP.GenericSlots = 3
	nextRT.YTDLP.YouTubeEJSConcurrency = 8
	nextRT.FastPool.PerPlatformMaxConcurrency = 16
	nextRT.Cache.YouTubeParseTTL = 45 * time.Second
	if ok := ApplyRuntimeConfig(entry, h, nextRT, true, true); !ok {
		t.Fatal("ApplyRuntimeConfig returned false for valid config")
	}

	// Pool pointer MUST NOT have been replaced (P2-9 invariant).
	if adm.slow != origSlowPtr {
		t.Fatal("ApplyRuntimeConfig replaced *pool pointer instead of updating in-place")
	}

	// Exactly 2 queued waiters must wake immediately while 1 remains queued!
	var wokenReleases []func()
	for i := 0; i < 2; i++ {
		select {
		case res := <-woken:
			if res.retry != 0 || res.release == nil {
				t.Fatalf("woken waiter %d failed: retry=%d", res.idx, res.retry)
			}
			wokenReleases = append(wokenReleases, res.release)
		case <-time.After(time.Second):
			t.Fatalf("expected waiter #%d to wake immediately after increasing social_slots 2->4", i+1)
		}
	}
	if snap := adm.slow.statsSnapshot(); snap.Active != 4 || snap.Queued != 1 || snap.ConcurrencyLimit != 4 {
		t.Fatalf("unexpected pool state after scale-up: %+v", snap)
	}

	// Hot-reload scale-down: decrease social_slots from 4 -> 2 while 4 are active and 1 is queued!
	downRT := nextRT
	downRT.YTDLP.SocialSlots = 2
	if ok := ApplyRuntimeConfig(entry, h, downRT, true, true); !ok {
		t.Fatal("ApplyRuntimeConfig scale-down returned false")
	}
	// Release 2 active leases (4 -> 3 -> 2): waiter #3 MUST NOT wake while active >= 2!
	rel1()
	rel2()
	time.Sleep(25 * time.Millisecond)
	select {
	case res := <-woken:
		t.Fatalf("waiter %d woke prematurely during scale-down drain (active should still be 2)", res.idx)
	default:
	}
	if snap := adm.slow.statsSnapshot(); snap.Active != 2 || snap.Queued != 1 || snap.ConcurrencyLimit != 2 {
		t.Fatalf("unexpected pool state during scale-down drain: %+v", snap)
	}

	// Release 1 more active lease (2 -> 1 < 2): waiter #3 now wakes cleanly!
	wokenReleases[0]()
	select {
	case res := <-woken:
		if res.retry != 0 || res.release == nil {
			t.Fatalf("waiter 3 failed after drain: retry=%d", res.retry)
		}
		res.release()
	case <-time.After(time.Second):
		t.Fatal("waiter 3 did not wake once active dropped below new limit 2")
	}
	wokenReleases[1]()
	wg.Wait()

	if snap := adm.slow.statsSnapshot(); snap.Active != 0 || snap.Queued != 0 {
		t.Fatalf("lease leak after in-place reload drain: %+v", snap)
	}

	// Invalid reload must be rejected and retain previous policy + reload_count=2.
	invalidRT := downRT
	invalidRT.YTDLP.SocialSlots = 99
	if ApplyRuntimeConfig(entry, h, invalidRT, true, true) {
		t.Fatal("invalid RuntimeConfig unexpectedly applied")
	}

	statsSnap := h.Stats().Snapshot()
	rp := statsSnap.RuntimePolicy
	if !rp.ConfigFileActive || rp.ReloadCount != 2 || rp.LastReloadedAt == "" ||
		rp.SocialSlots != 2 || rp.YouTubeSlots != 6 || rp.GenericSlots != 3 ||
		rp.YouTubeEJSConcurrency != 8 || rp.FastPerPlatformMaxConcurrency != 16 ||
		rp.YouTubeParseTTLSeconds != 45 {
		t.Fatalf("unexpected RuntimePolicySummary after reloads: %+v", rp)
	}

	// Smoke check that HTTP handler continues serving cleanly after reloads.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/platforms?schema_version=1.0", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("platforms after reload status=%d", rec.Code)
	}
}

func TestApplyRuntimeConfigHookFailureAndInvalidReloadRollback(t *testing.T) {
	c := loadCacheTestCatalog(t)
	now := time.Date(2026, 11, 26, 10, 0, 0, 0, time.UTC)
	h, err := New(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, ts int64) (unified.Object, error) {
			return makeSyntheticEnvelope("douyin", src, ts, ""), nil
		}),
	}, func() time.Time { return now }, nil)
	if err != nil {
		t.Fatal(err)
	}
	if gen := h.RuntimeConfigGeneration(); gen != 0 {
		t.Fatalf("initial RuntimeConfigGeneration = %d, want 0", gen)
	}

	var observerCalls atomic.Int32
	h.RegisterRuntimeConfigObserver(RuntimeConfigObserverFunc(func(RuntimeConfig) {
		observerCalls.Add(1)
	}))

	entry, err := WithAdmissionConfig(h, nil, "caddy", testEdgeKey, DefaultAdmissionConfig())
	if err != nil {
		t.Fatal(err)
	}
	adm := entry.(*admission)

	// Commit baseline config (generation 0 -> 1).
	baseCfg := DefaultRuntimeConfig()
	baseCfg.YTDLP.YouTubeSlots = 5
	baseCfg.YTDLP.SocialSlots = 6
	baseCfg.YTDLP.GenericSlots = 3
	baseCfg.YTDLP.YouTubeEJSConcurrency = 7
	baseCfg.FastPool.PerPlatformMaxConcurrency = 20
	baseCfg.CircuitBreaker.ConsecutiveFailures = 4
	baseCfg.CircuitBreaker.WindowSize = 8
	baseCfg.CircuitBreaker.DisabledPlatforms = []string{"tumblr"}
	baseCfg.Cache.YouTubeParseTTL = 90 * time.Second
	baseCfg.Cache.StaleIfErrorTTL = 420 * time.Second
	baseCfg.Cache.UpstreamBlockedNegTTL = 6 * time.Second
	if err := ApplyRuntimeConfigWithHook(entry, h, baseCfg, true, false, nil); err != nil {
		t.Fatalf("baseline ApplyRuntimeConfigWithHook failed: %v", err)
	}
	if h.RuntimeConfigGeneration() != 1 {
		t.Fatalf("generation after baseline = %d, want 1", h.RuntimeConfigGeneration())
	}
	if observerCalls.Load() != 1 {
		t.Fatalf("observerCalls = %d, want 1", observerCalls.Load())
	}

	// Prime parse cache for douyin so we can assert a failed reload never purges cached entries.
	dyReq := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.douyin.com/video/7400000000000000123")
	recPrime := httptest.NewRecorder()
	h.ServeHTTP(recPrime, httptest.NewRequest(http.MethodGet, dyReq, nil))
	if recPrime.Code != http.StatusOK {
		t.Fatalf("prime douyin parse failed: %d", recPrime.Code)
	}
	if entries, _ := h.cache.stats(); entries != 1 {
		t.Fatalf("expected 1 cached entry after prime, got %d", entries)
	}

	// Verify immutable RuntimePolicySnapshot defensive copy behavior.
	baseSnap := h.RuntimePolicySnapshot()
	if baseSnap.Generation != 1 || baseSnap.Cache != baseCfg.Cache || !baseSnap.IsPlatformDisabled("tumblr") || baseSnap.IsPlatformDisabled("douyin") {
		t.Fatalf("unexpected baseline RuntimePolicySnapshot: %+v", baseSnap)
	}
	clonedDisabled := baseSnap.DisabledPlatforms()
	clonedDisabled[0] = "douyin"
	if !baseSnap.IsPlatformDisabled("tumblr") || baseSnap.IsPlatformDisabled("douyin") || !slices.Equal(baseSnap.DisabledPlatforms(), []string{"tumblr"}) {
		t.Fatal("mutating DisabledPlatforms() slice corrupted RuntimePolicySnapshot")
	}

	// 1. Out-of-range invalid config fails before invoking hook and leaves all state + generation untouched.
	badCfg := baseCfg
	badCfg.YTDLP.YouTubeSlots = 99
	hookCalled := false
	if err := ApplyRuntimeConfigWithHook(entry, h, badCfg, true, true, func(RuntimeConfig) error {
		hookCalled = true
		return nil
	}); err == nil {
		t.Fatal("expected out-of-range config to fail")
	}
	if hookCalled {
		t.Fatal("commit hook must not run when validation fails")
	}

	// 2. Valid config whose compartment commit hook fails must leave admission pools,
	//    circuit breakers, parse cache, RuntimePolicySnapshot, observers, stats, and generation 100% untouched!
	candidateCfg := baseCfg
	candidateCfg.YTDLP.YouTubeSlots = 10
	candidateCfg.YTDLP.SocialSlots = 11
	candidateCfg.YTDLP.GenericSlots = 4
	candidateCfg.YTDLP.YouTubeEJSConcurrency = 12
	candidateCfg.FastPool.PerPlatformMaxConcurrency = 48
	candidateCfg.CircuitBreaker.Enabled = false
	candidateCfg.CircuitBreaker.DisabledPlatforms = []string{"douyin"}
	candidateCfg.Cache.YouTubeParseTTL = 15 * time.Second
	candidateCfg.Cache.StaleIfErrorTTL = 30 * time.Second

	injectedErr := errors.New("injected compartment #2 failure")
	if err := ApplyRuntimeConfigWithHook(entry, h, candidateCfg, true, true, func(RuntimeConfig) error {
		return injectedErr
	}); !errors.Is(err, injectedErr) {
		t.Fatalf("expected injected hook error, got %v", err)
	}

	// Assert zero contamination across every subsystem.
	if h.RuntimeConfigGeneration() != 1 {
		t.Fatalf("generation mutated on failed reload: got %d, want 1", h.RuntimeConfigGeneration())
	}
	if curSnap := h.RuntimePolicySnapshot(); curSnap != baseSnap {
		t.Fatalf("RuntimePolicySnapshot pointer changed on failed reload: got gen=%d, want gen=1", curSnap.Generation)
	}
	if observerCalls.Load() != 1 {
		t.Fatalf("observers invoked despite failed hook: got %d, want 1", observerCalls.Load())
	}
	if adm.youtubeSlow.statsSnapshot().ConcurrencyLimit != 5 ||
		adm.slow.statsSnapshot().ConcurrencyLimit != 6 ||
		adm.genericSlow.statsSnapshot().ConcurrencyLimit != 3 ||
		adm.youtubeEJS.statsSnapshot().ConcurrencyLimit != 7 ||
		adm.public.currentPerPlatformLimit() != 20 {
		t.Fatalf("admission pool limits mutated despite failed hook: yt=%d social=%d generic=%d ejs=%d fastPerPlat=%d",
			adm.youtubeSlow.statsSnapshot().ConcurrencyLimit,
			adm.slow.statsSnapshot().ConcurrencyLimit,
			adm.genericSlow.statsSnapshot().ConcurrencyLimit,
			adm.youtubeEJS.statsSnapshot().ConcurrencyLimit,
			adm.public.currentPerPlatformLimit())
	}
	if h.cb.IsDisabled("douyin") || !h.cb.IsDisabled("tumblr") {
		t.Fatalf("circuit breaker disabled platforms mutated on failed hook: douyin=%v tumblr=%v",
			h.cb.IsDisabled("douyin"), h.cb.IsDisabled("tumblr"))
	}
	if entries, _ := h.cache.stats(); entries != 1 {
		t.Fatalf("parse cache purged on failed hook: entries=%d, want 1", entries)
	}
	rp := h.Stats().Snapshot().RuntimePolicy
	if rp.ReloadCount != 0 || rp.YouTubeSlots != 5 || rp.SocialSlots != 6 || rp.GenericSlots != 3 ||
		rp.YouTubeParseTTLSeconds != 90 || !rp.CircuitBreakerEnabled || !slices.Equal(rp.DisabledPlatforms, []string{"tumblr"}) {
		t.Fatalf("stats RuntimePolicySummary mutated on failed hook: %+v", rp)
	}
}

func TestApplyRuntimeConfigHighConcurrencyRaceStress(t *testing.T) {
	c := loadCacheTestCatalog(t)
	now := time.Date(2026, 11, 26, 11, 0, 0, 0, time.UTC)
	h, err := New(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, ts int64) (unified.Object, error) {
			return makeSyntheticEnvelope("douyin", src, ts, ""), nil
		}),
		"youtube": AdapterFunc(func(_ context.Context, src string, ts int64) (unified.Object, error) {
			return makeSyntheticEnvelope("youtube", src, ts, ""), nil
		}),
	}, func() time.Time { return now }, nil)
	if err != nil {
		t.Fatal(err)
	}

	admCfg := DefaultAdmissionConfig()
	for _, p := range []*PoolConfig{&admCfg.Parse, &admCfg.YouTubeSlowParse, &admCfg.SlowParse, &admCfg.GenericSlowParse, &admCfg.YouTubeEJS} {
		p.ClientBurst = 1000
		p.ClientRPS = 1000
		p.GlobalBurst = 5000
		p.GlobalRPS = 5000
		p.QueueWait = 25 * time.Millisecond
		p.QueueSize = 32
	}
	entry, err := WithAdmissionConfig(h, nil, "caddy", testEdgeKey, admCfg)
	if err != nil {
		t.Fatal(err)
	}
	adm := entry.(*admission)
	origPools := [5]*pool{adm.youtubeSlow, adm.slow, adm.genericSlow, adm.youtubeEJS, adm.public}

	const workerCount = 24
	const reloadIterations = 50

	stopWorkers := make(chan struct{})
	var workerWG sync.WaitGroup
	var monotonicityViolations atomic.Int64
	var panicCount atomic.Int64

	pools := []*pool{adm.youtubeSlow, adm.slow, adm.genericSlow, adm.youtubeEJS, adm.public}
	for w := 0; w < workerCount; w++ {
		workerWG.Add(1)
		go func(id int) {
			defer workerWG.Done()
			defer func() {
				if r := recover(); r != nil {
					panicCount.Add(1)
					t.Errorf("worker %d panicked: %v", id, r)
				}
			}()
			var lastGen uint64
			ip := netip.MustParseAddr(fmt.Sprintf("198.51.100.%d", (id%200)+1))
			for iter := 0; ; iter++ {
				select {
				case <-stopWorkers:
					return
				default:
				}
				snap := h.RuntimePolicySnapshot()
				if snap.Generation < lastGen {
					monotonicityViolations.Add(1)
				}
				lastGen = snap.Generation
				_ = snap.IsPlatformDisabled("youtube")
				_ = snap.Cache.YouTubeParseTTL

				targetPool := pools[(id+iter)%len(pools)]
				plat := ""
				if targetPool == adm.public {
					plat = "douyin"
				}
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Millisecond)
				rel, retry, canceled := targetPool.acquireContextForPlatform(ctx, ip, time.Now(), plat)
				if !canceled && retry == 0 && rel != nil {
					if iter%5 == 0 {
						_ = h.HasFreshCachedParse("/api/parse", "schema_version=1.0&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ")
					}
					rel()
				}
				cancel()
			}
		}(w)
	}

	// Background reload loop firing 50 alternating valid/invalid reloads across two concurrent reloaders
	// to stress reloadMu serialization, atomic snapshot publication, and rollback invariants.
	var validCommitted atomic.Uint64
	var reloadWG sync.WaitGroup
	for r := 0; r < 2; r++ {
		reloadWG.Add(1)
		go func(reloaderID int) {
			defer reloadWG.Done()
			for i := 0; i < reloadIterations/2; i++ {
				step := reloaderID*(reloadIterations/2) + i
				rt := DefaultRuntimeConfig()
				switch step % 3 {
				case 0: // Valid config A
					rt.YTDLP.YouTubeSlots = 2 + (step % 6)
					rt.YTDLP.SocialSlots = 2 + (step % 5)
					rt.YTDLP.GenericSlots = 1 + (step % 4)
					rt.YTDLP.YouTubeEJSConcurrency = 2 + (step % 6)
					rt.FastPool.PerPlatformMaxConcurrency = 4 + (step % 12)
					rt.Cache.YouTubeParseTTL = time.Duration((step%5)*30) * time.Second
					if step%2 == 0 {
						rt.CircuitBreaker.DisabledPlatforms = []string{"youtube"}
					}
					if ok := ApplyRuntimeConfig(entry, h, rt, true, true); !ok {
						t.Errorf("valid reload step=%d unexpectedly failed", step)
					} else {
						validCommitted.Add(1)
					}
				case 1: // Invalid out-of-range config -> must fail without touching generation
					rt.YTDLP.YouTubeSlots = 999
					if ApplyRuntimeConfig(entry, h, rt, true, true) {
						t.Errorf("invalid reload step=%d unexpectedly succeeded", step)
					}
				case 2: // Valid config with failing compartment hook -> must roll back without touching generation
					rt.YTDLP.SocialSlots = 9
					if err := ApplyRuntimeConfigWithHook(entry, h, rt, true, true, func(RuntimeConfig) error {
						return errors.New("synthetic compartment resize error")
					}); err == nil {
						t.Errorf("failing-hook reload step=%d unexpectedly succeeded", step)
					}
				}
			}
		}(r)
	}

	reloadWG.Wait()
	close(stopWorkers)
	workerWG.Wait()

	if panicCount.Load() != 0 {
		t.Fatalf("observed %d panics during concurrent stress", panicCount.Load())
	}
	if monotonicityViolations.Load() != 0 {
		t.Fatalf("observed %d generation monotonicity regressions", monotonicityViolations.Load())
	}
	if gotGen, wantGen := h.RuntimeConfigGeneration(), validCommitted.Load(); gotGen != wantGen {
		t.Fatalf("RuntimeConfigGeneration = %d, want exact valid commit count %d", gotGen, wantGen)
	}
	if rp := h.Stats().Snapshot().RuntimePolicy; rp.ReloadCount != validCommitted.Load() {
		t.Fatalf("stats ReloadCount = %d, want %d", rp.ReloadCount, validCommitted.Load())
	}

	// Verify all 5 *pool pointers remained strictly in-place (never replaced).
	curPools := [5]*pool{adm.youtubeSlow, adm.slow, adm.genericSlow, adm.youtubeEJS, adm.public}
	for i := range origPools {
		if curPools[i] != origPools[i] {
			t.Fatalf("pool[%d] pointer replaced during reload stress", i)
		}
	}

	// Verify exact pool conservation across all 5 pools.
	for i, p := range curPools {
		p.mu.Lock()
		active := p.active
		waiters := p.waiters.Len()
		idleLen := p.idle.Len()
		clientsLen := len(p.clients)
		platActiveLen := len(p.platformActive)
		var leakedClients int
		for _, st := range p.clients {
			if st.active != 0 || st.idleElem == nil {
				leakedClients++
			}
		}
		p.mu.Unlock()
		if active != 0 || waiters != 0 || idleLen != clientsLen || leakedClients != 0 || platActiveLen != 0 {
			t.Fatalf("pool[%d] conservation violated: active=%d waiters=%d idle=%d clients=%d leakedClients=%d platformActive=%d",
				i, active, waiters, idleLen, clientsLen, leakedClients, platActiveLen)
		}
	}
}
