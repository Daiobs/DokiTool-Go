package api

import (
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestAdmissionConfigDefaultsAndOverrides(t *testing.T) {
	defaults, err := LoadAdmissionConfig(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if defaults.Parse.GlobalConcurrency != 64 || defaults.Parse.GlobalRPS != 50 || defaults.Parse.GlobalBurst != 100 ||
		defaults.Parse.ClientConcurrency != 1 || defaults.Parse.ClientBurst != 4 ||
		defaults.Parse.QueueWait != 1500*time.Millisecond || defaults.Parse.QueueSize != 128 ||
		defaults.SlowParse.GlobalConcurrency != 2 || defaults.SlowParse.GlobalRPS != 10 || defaults.SlowParse.GlobalBurst != 32 ||
		defaults.SlowParse.ClientConcurrency != 1 || defaults.SlowParse.ClientBurst != 4 ||
		defaults.SlowParse.QueueWait != 5*time.Second || defaults.SlowParse.QueueSize != 32 ||
		defaults.Relay.GlobalConcurrency != 12 || defaults.MaxClients != 4096 {
		t.Fatalf("wrong production defaults: %+v", defaults)
	}

	// SlowParse.GlobalConcurrency automatically inherits DOKITOOL_YTDLP_CONCURRENCY when unset.
	inherited, err := LoadAdmissionConfig(func(k string) string {
		if k == "DOKITOOL_YTDLP_CONCURRENCY" {
			return "6"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if inherited.SlowParse.GlobalConcurrency != 6 {
		t.Fatalf("expected SlowParse.GlobalConcurrency to inherit DOKITOOL_YTDLP_CONCURRENCY=6, got %d", inherited.SlowParse.GlobalConcurrency)
	}

	values := map[string]string{
		"DOKITOOL_YTDLP_CONCURRENCY":             "6",
		"DOKITOOL_PARSE_GLOBAL_CONCURRENCY":      "96",
		"DOKITOOL_PARSE_GLOBAL_RPS":              "80",
		"DOKITOOL_PARSE_GLOBAL_BURST":            "160",
		"DOKITOOL_PARSE_CLIENT_CONCURRENCY":      "2",
		"DOKITOOL_PARSE_CLIENT_RPS":              "0.5",
		"DOKITOOL_PARSE_QUEUE_WAIT":              "2s",
		"DOKITOOL_PARSE_QUEUE_SIZE":              "256",
		"DOKITOOL_PARSE_SLOW_GLOBAL_CONCURRENCY": "10",
		"DOKITOOL_PARSE_SLOW_GLOBAL_RPS":         "15",
		"DOKITOOL_PARSE_SLOW_GLOBAL_BURST":       "40",
		"DOKITOOL_PARSE_SLOW_QUEUE_WAIT":         "8s",
		"DOKITOOL_PARSE_SLOW_QUEUE_SIZE":         "64",
		"DOKITOOL_CATALOG_GLOBAL_CONCURRENCY":    "80",
		"DOKITOOL_WEIBO_GLOBAL_CONCURRENCY":      "8",
		"DOKITOOL_REPORT_GLOBAL_CONCURRENCY":     "20",
		"DOKITOOL_ADMISSION_MAX_CLIENTS":         "8192",
	}
	got, err := LoadAdmissionConfig(func(k string) string { return values[k] })
	if err != nil {
		t.Fatal(err)
	}
	if got.Parse.GlobalConcurrency != 96 || got.Parse.GlobalRPS != 80 || got.Parse.GlobalBurst != 160 ||
		got.Parse.ClientConcurrency != 2 || got.Parse.ClientRPS != 0.5 ||
		got.Parse.QueueWait != 2*time.Second || got.Parse.QueueSize != 256 ||
		got.SlowParse.GlobalConcurrency != 10 || got.SlowParse.GlobalRPS != 15 || got.SlowParse.GlobalBurst != 40 ||
		got.SlowParse.QueueWait != 8*time.Second || got.SlowParse.QueueSize != 64 ||
		got.Catalog.GlobalConcurrency != 80 || got.Relay.GlobalConcurrency != 8 ||
		got.Reports.GlobalConcurrency != 20 || got.MaxClients != 8192 {
		t.Fatalf("configuration ignored: %+v", got)
	}

	for _, tc := range []struct{ key, value string }{
		{"DOKITOOL_PARSE_GLOBAL_RPS", "NaN"},
		{"DOKITOOL_PARSE_CLIENT_RPS", "+Inf"},
		{"DOKITOOL_PARSE_GLOBAL_BURST", "0.5"},
		{"DOKITOOL_PARSE_CLIENT_BURST", "0"},
		{"DOKITOOL_PARSE_CLIENT_CONCURRENCY", "65"},
		{"DOKITOOL_PARSE_GLOBAL_CONCURRENCY", "0"},
		{"DOKITOOL_PARSE_GLOBAL_CONCURRENCY", "2.5"},
		{"DOKITOOL_PARSE_GLOBAL_CONCURRENCY", "4097"},
		{"DOKITOOL_PARSE_QUEUE_WAIT", "-1ms"},
		{"DOKITOOL_PARSE_QUEUE_WAIT", "16s"},
		{"DOKITOOL_PARSE_QUEUE_WAIT", "secret-invalid"},
		{"DOKITOOL_PARSE_QUEUE_SIZE", "-1"},
		{"DOKITOOL_PARSE_QUEUE_SIZE", "4097"},
		{"DOKITOOL_PARSE_QUEUE_SIZE", "secret-invalid"},
		{"DOKITOOL_PARSE_SLOW_GLOBAL_CONCURRENCY", "0"},
		{"DOKITOOL_PARSE_SLOW_GLOBAL_CONCURRENCY", "65"},
		{"DOKITOOL_PARSE_SLOW_CLIENT_CONCURRENCY", "3"},
		{"DOKITOOL_PARSE_SLOW_QUEUE_WAIT", "-1s"},
		{"DOKITOOL_PARSE_SLOW_QUEUE_WAIT", "31s"},
		{"DOKITOOL_PARSE_SLOW_QUEUE_WAIT", "secret-invalid"},
		{"DOKITOOL_PARSE_SLOW_QUEUE_SIZE", "-1"},
		{"DOKITOOL_PARSE_SLOW_QUEUE_SIZE", "1025"},
		{"DOKITOOL_PARSE_SLOW_QUEUE_SIZE", "secret-invalid"},
		{"DOKITOOL_YTDLP_CONCURRENCY", "0"},
		{"DOKITOOL_YTDLP_CONCURRENCY", "25"},
		{"DOKITOOL_YTDLP_CONCURRENCY", "secret-invalid"},
		{"DOKITOOL_WEIBO_GLOBAL_CONCURRENCY", "13"},
		{"DOKITOOL_ADMISSION_MAX_CLIENTS", "65537"},
		{"DOKITOOL_REPORT_GLOBAL_RPS", "secret-invalid"},
	} {
		_, err := LoadAdmissionConfig(func(k string) string {
			if k == tc.key {
				return tc.value
			}
			return ""
		})
		if err == nil || strings.Contains(err.Error(), "secret-invalid") {
			t.Fatalf("bad configuration accepted or value leaked: %s=%q err=%v", tc.key, tc.value, err)
		}
	}

	// Non-parse pools must reject non-zero queue settings in Validate().
	badRelayQueue := DefaultAdmissionConfig()
	badRelayQueue.Relay.QueueWait = 100 * time.Millisecond
	badRelayQueue.Relay.QueueSize = 4
	if err := badRelayQueue.Validate(); err == nil {
		t.Fatal("expected Relay queue configuration to be rejected")
	}
}

func TestAdmissionCatalogIndependentOfBusyParse(t *testing.T) {
	called := 0
	cfg := DefaultAdmissionConfig()
	cfg.Parse.QueueWait = 0
	cfg.SlowParse.QueueWait = 0
	h, err := WithAdmissionConfig(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called++; w.WriteHeader(204) }), nil, "caddy", testEdgeKey, cfg)
	if err != nil {
		t.Fatal(err)
	}
	a := h.(*admission)
	now := time.Unix(1000, 0)
	a.now = func() time.Time { return now }
	var releases []func()
	defer func() {
		for _, release := range releases {
			release()
		}
	}()
	for i := 0; i < cfg.Parse.GlobalConcurrency; i++ {
		release, retry := a.public.acquire(netip.MustParseAddr(fmt.Sprintf("192.0.2.%d", i+1)), now)
		if retry != 0 {
			t.Fatal(retry)
		}
		releases = append(releases, release)
	}
	for i := 0; i < cfg.SlowParse.GlobalConcurrency; i++ {
		release, retry := a.slow.acquire(netip.MustParseAddr(fmt.Sprintf("198.51.100.%d", i+1)), now)
		if retry != 0 {
			t.Fatal(retry)
		}
		releases = append(releases, release)
	}
	if w := call(h, edgeRequest("/api/parse", "203.0.113.1")); w.Code != 429 {
		t.Fatal("global capacity not enforced", w.Code)
	}
	if w := call(h, edgeRequest("/api/platforms?schema_version=1.0", "192.0.2.1")); w.Code != 204 {
		t.Fatal("catalog blocked by parsing", w.Code)
	}
	if w := call(h, edgeRequest("/api/media/weibo", "192.0.2.1")); w.Code != 204 {
		t.Fatal("media pool coupled", w.Code)
	}
	if called != 2 {
		t.Fatal(called)
	}
}

func TestAdmissionGlobalCapacityDoesNotRelaxClientProtection(t *testing.T) {
	h, err := WithAdmission(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }), nil, "caddy", testEdgeKey)
	if err != nil {
		t.Fatal(err)
	}
	a := h.(*admission)
	now := time.Unix(1000, 0)
	a.now = func() time.Time { return now }
	release, retry := a.public.acquire(netip.MustParseAddr("192.0.2.1"), now)
	if retry != 0 {
		t.Fatal(retry)
	}
	if w := call(h, edgeRequest("/api/parse", "192.0.2.1")); w.Code != 429 {
		t.Fatal("same IP parallel request allowed", w.Code)
	}
	if w := call(h, edgeRequest("/api/parse", "192.0.2.2")); w.Code != 204 {
		t.Fatal("other user rejected", w.Code)
	}
	release()
	release() // A repeated cleanup must not mint a concurrency slot.
	for i := 0; i < 3; i++ {
		if w := call(h, edgeRequest("/api/parse", "192.0.2.1")); w.Code != 204 {
			t.Fatal(w.Code)
		}
	}
	if w := call(h, edgeRequest("/api/resolve", "192.0.2.1")); w.Code != 429 || w.Header().Get("Retry-After") != "5" {
		t.Fatal("client rate limit relaxed", w.Code, w.Header())
	}
	if a.public.active != 0 {
		t.Fatal("lease count leaked", a.public.active)
	}
}

func TestAdmissionConfiguredRateAndConcurrencyIndependent(t *testing.T) {
	p := newConfiguredPool(PoolConfig{
		ClientBurst:       10,
		ClientRPS:         1,
		GlobalBurst:       6,
		GlobalRPS:         2,
		ClientConcurrency: 2,
		GlobalConcurrency: 4,
	}, 100)
	now := time.Unix(1000, 0)
	var release []func()
	for i := 0; i < 4; i++ {
		f, retry := p.acquire(netip.AddrFrom4([4]byte{192, 0, 2, byte(i + 1)}), now)
		if retry != 0 {
			t.Fatal(retry)
		}
		release = append(release, f)
	}
	fifth := netip.MustParseAddr("192.0.2.9")
	if f, retry := p.acquire(fifth, now); f != nil || retry != 1 {
		t.Fatal("configured global slots not enforced", retry)
	}
	for _, f := range release {
		f()
	}
	for i := 0; i < 2; i++ {
		f, retry := p.acquire(fifth, now)
		if retry != 0 {
			t.Fatal(retry)
		}
		f()
	}
	if f, retry := p.acquire(fifth, now); f != nil || retry != 1 {
		t.Fatal("global tokens not enforced", retry)
	}
	f, retry := p.acquire(fifth, now.Add(500*time.Millisecond))
	if retry != 0 {
		t.Fatal(retry)
	}
	f()
}

func TestAdmissionTableEvictsLeastRecentlyActiveIdleClient(t *testing.T) {
	p := newConfiguredPool(PoolConfig{
		ClientBurst:       2,
		ClientRPS:         0.2,
		GlobalBurst:       100,
		GlobalRPS:         100,
		ClientConcurrency: 1,
		GlobalConcurrency: 8,
	}, 3)
	now := time.Unix(1000, 0)
	inFlight := netip.MustParseAddr("192.0.2.1")
	oldestIdle := netip.MustParseAddr("192.0.2.2")
	recentHammer := netip.MustParseAddr("192.0.2.3")
	newVisitor := netip.MustParseAddr("192.0.2.4")

	// 1. inFlight holds an active request (active == 1): must NEVER be evicted.
	relInFlight, retry := p.acquire(inFlight, now)
	if retry != 0 {
		t.Fatal(retry)
	}
	defer relInFlight()

	// 2. oldestIdle makes 1 request and finishes (active == 0, bucket NOT yet refilled: tokens = 1 < burst 2).
	relOld, retry := p.acquire(oldestIdle, now)
	if retry != 0 {
		t.Fatal(retry)
	}
	relOld()

	// 3. recentHammer exhausts its burst (2 requests) and then hits 429 at t+1s.
	for i := 0; i < 2; i++ {
		relH, r := p.acquire(recentHammer, now)
		if r != 0 {
			t.Fatal(r)
		}
		relH()
	}
	// Make oldestIdle become older than recentHammer, then have recentHammer hammer again while rate-limited.
	if f, r := p.acquire(recentHammer, now.Add(time.Second)); f != nil || r == 0 {
		t.Fatalf("expected recentHammer to be rate-limited, got retry=%d", r)
	}

	// 4. newVisitor arrives while table is at capacity (3) and oldestIdle's bucket has NOT refilled:
	// oldestIdle (active == 0, least recently active) is evicted; inFlight and recentHammer stay!
	relNew, retry := p.acquire(newVisitor, now.Add(time.Second))
	if relNew == nil || retry != 0 {
		t.Fatalf("expected idle LRU eviction to admit newVisitor, got retry=%d", retry)
	}
	if p.clients[inFlight] == nil || p.clients[inFlight].active != 1 {
		t.Fatal("in-flight client was evicted")
	}
	if p.clients[oldestIdle] != nil {
		t.Fatal("least recently active idle client was not evicted")
	}
	if p.clients[recentHammer] == nil {
		t.Fatal("more recently active rate-limited client was evicted ahead of older idle client")
	}
	if len(p.clients) != 3 {
		t.Fatalf("client table size = %d, want 3", len(p.clients))
	}

	// 5. Make all 3 entries active simultaneously; a 4th distinct IP must get retry=60 without evicting live leases.
	relHammer, retry := p.acquire(recentHammer, now.Add(10*time.Second))
	if retry != 0 {
		t.Fatalf("expected recentHammer to recover after 10s, got retry=%d", retry)
	}
	defer relHammer()
	// Now inFlight, newVisitor, and recentHammer ALL have active == 1 (3 == MaxClients).
	if f, r := p.acquire(netip.MustParseAddr("192.0.2.99"), now.Add(10*time.Second)); f != nil || r != 60 {
		t.Fatalf("expected retry=60 when all MaxClients have active > 0, got retry=%d", r)
	}
	relNew()
}
