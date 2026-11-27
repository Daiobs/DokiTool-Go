package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/youtube"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

// TestRoutePoliciesCoverEveryRouteExhaustively is a permanent architectural invariant
// gate: every route kind in classify() MUST be explicitly declared in routePolicies
// with either kill-switch governance or an explicit non-platform justification.
func TestRoutePoliciesCoverEveryRouteExhaustively(t *testing.T) {
	for kind := route(0); kind < routeCount; kind++ {
		pol := policyForRoute(kind)
		if pol.enforceKillSwitch {
			if (pol.staticPlatform != "") == pol.dynamicPlatform {
				t.Fatalf("route %d has enforceKillSwitch=true but must declare exactly one of staticPlatform or dynamicPlatform (got %+v)", kind, pol)
			}
			continue
		}
		if strings.TrimSpace(pol.nonPlatformReason) == "" {
			t.Fatalf("route %d omits enforceKillSwitch without an explicit nonPlatformReason", kind)
		}
	}

	// Verify key platform-scoped routes cannot silently lose kill-switch coverage.
	for _, tc := range []struct {
		path           string
		wantKillSwitch bool
		wantStaticPlat string
	}{
		{"/api/parse", true, ""},
		{"/api/resolve", true, ""},
		{"/api/youtube/context", true, "youtube"},
		{"/api/youtube/finalize", true, "youtube"},
		{"/api/media/weibo", false, ""},
		{"/api/platforms", false, ""},
		{"/api/stats", false, ""},
	} {
		pol := policyForRoute(classify(tc.path))
		if pol.enforceKillSwitch != tc.wantKillSwitch || pol.staticPlatform != tc.wantStaticPlat {
			t.Fatalf("path %s policy = %+v, want enforceKillSwitch=%v staticPlatform=%q",
				tc.path, pol, tc.wantKillSwitch, tc.wantStaticPlat)
		}
	}
}

type mockKillSwitchYTExecutor struct {
	playerJS     []byte
	upstreamHits atomic.Int32
}

func (m *mockKillSwitchYTExecutor) Do(_ context.Context, req fetch.Request) (fetch.Response, error) {
	m.upstreamHits.Add(1)
	switch req.URL {
	case "https://www.youtube.com/iframe_api":
		return fetch.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/javascript"}},
			Body:       []byte(`var scriptUrl = 'https:\/\/www.youtube.com\/s\/player\/a5c2aafe\/www-widgetapi.vflset\/www-widgetapi.js';`),
			URL:        req.URL,
		}, nil
	case "https://www.youtube.com/s/player/a5c2aafe/tv-player-ias.vflset/tv-player-ias.js":
		return fetch.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/javascript"}},
			Body:       m.playerJS,
			URL:        req.URL,
		}, nil
	default:
		return fetch.Response{StatusCode: http.StatusNotFound}, nil
	}
}

func resolveAPITestDeno(t *testing.T) string {
	t.Helper()
	if envPath := strings.TrimSpace(os.Getenv("DOKITOOL_DENO_BINARY")); envPath != "" {
		return envPath
	}
	if runnerTemp := strings.TrimSpace(os.Getenv("RUNNER_TEMP")); runnerTemp != "" {
		candidate := filepath.Join(runnerTemp, "dokitool-validation", "bin", "deno")
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return candidate
		}
	}
	if p, err := exec.LookPath("deno"); err == nil && p != "" {
		return p
	}
	t.Skip("deno binary not available in PATH or DOKITOOL_DENO_BINARY")
	return ""
}

// TestDisabledPlatformsKillSwitchCoversAllPlatformSubsystems verifies H1 governance
// end-to-end: adding "youtube" and "weibo" to circuit_breaker.disabled_platforms
// via ApplyRuntimeConfig immediately blocks /api/parse, /api/youtube/context,
// /api/youtube/finalize, /api/media/weibo, invalidates cached YouTube player state,
// suppresses background YouTube refreshes, and restores cleanly when re-enabled.
func TestDisabledPlatformsKillSwitchCoversAllPlatformSubsystems(t *testing.T) {
	denoBin := resolveAPITestDeno(t)
	ytDir := filepath.Join("..", "platform", "youtube", "testdata")
	playerJS, err := os.ReadFile(filepath.Join(ytDir, "player_base_fixture.js"))
	if err != nil {
		t.Fatal(err)
	}
	sampleFinalize, err := os.ReadFile(filepath.Join(ytDir, "finalize_sample_46.json"))
	if err != nil {
		t.Fatal(err)
	}
	sb, err := youtube.NewEJSSandbox(youtube.SandboxConfig{
		DenoBinary: denoBin,
		EJSDir:     filepath.Join(ytDir, "ejs"),
	})
	if err != nil {
		t.Fatalf("NewEJSSandbox: %v", err)
	}

	now := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	ytExec := &mockKillSwitchYTExecutor{playerJS: playerJS}
	ytHelper, err := youtube.NewHelper(ytExec, sb, func() time.Time { return now })
	if err != nil {
		t.Fatalf("NewHelper: %v", err)
	}

	c, err := catalog.Load()
	if err != nil {
		t.Fatalf("catalog.Load: %v", err)
	}
	if err := c.Register(catalog.YouTubePlatform()); err != nil {
		t.Fatalf("catalog.Register(youtube): %v", err)
	}
	var ytParseHits, weiboParseHits atomic.Int32
	adapters := map[string]Adapter{
		"youtube": AdapterFunc(func(_ context.Context, _ string, _ int64) (unified.Object, error) {
			ytParseHits.Add(1)
			return unified.ContractError("NO_MEDIA", "no media", false), nil
		}),
		"weibo": AdapterFunc(func(_ context.Context, _ string, _ int64) (unified.Object, error) {
			weiboParseHits.Add(1)
			return unified.ContractError("NO_MEDIA", "no media", false), nil
		}),
	}
	noopMedia := func(_ context.Context, _ string, payload unified.Object, _ int64) (unified.Object, error) {
		return payload, nil
	}
	h, err := New(c, adapters, func() time.Time { return now }, noopMedia)
	if err != nil {
		t.Fatalf("api.New: %v", err)
	}
	h.SetYouTubeHelper(ytHelper)

	// 1. Before kill-switch: YouTube helper warms and serves 200; /api/stats sees active cache.
	reqCtx := httptest.NewRequest(http.MethodGet, "/api/youtube/context?schema_version=1.0", nil)
	recCtx := httptest.NewRecorder()
	h.ServeHTTP(recCtx, reqCtx)
	if recCtx.Code != http.StatusOK {
		t.Fatalf("initial /api/youtube/context = %d, want 200 (body=%s)", recCtx.Code, recCtx.Body.String())
	}
	if !h.HasCachedYouTubeContext() {
		t.Fatal("expected HasCachedYouTubeContext=true after warm context")
	}
	snapWarm := h.Stats().Snapshot()
	if !snapWarm.YouTubeHelper.Enabled || snapWarm.YouTubeHelper.DisabledByConfig ||
		!snapWarm.YouTubeHelper.ActivePlayerCached || snapWarm.YouTubeHelper.ActiveVariant != "tv" {
		t.Fatalf("unexpected warm YouTubeHelper stats: %+v", snapWarm.YouTubeHelper)
	}

	// Verify removed /api/media/weibo route returns 404.
	recRemovedRelay := httptest.NewRecorder()
	h.ServeHTTP(recRemovedRelay, httptest.NewRequest(http.MethodGet, "/api/media/weibo?ticket=test", nil))
	if recRemovedRelay.Code != http.StatusNotFound {
		t.Fatalf("removed /api/media/weibo status=%d, want 404", recRemovedRelay.Code)
	}

	// 2. Apply runtime emergency kill-switch for youtube and weibo via ApplyRuntimeConfig.
	cfgDisabled := DefaultRuntimeConfig()
	cfgDisabled.CircuitBreaker.DisabledPlatforms = []string{"youtube", "weibo"}
	if !ApplyRuntimeConfig(nil, h, cfgDisabled, true, true) {
		t.Fatal("ApplyRuntimeConfig(disabled) returned false")
	}
	hitsAtDisable := ytExec.upstreamHits.Load()

	// Cached player state must be invalidated immediately.
	if h.HasCachedYouTubeContext() {
		t.Fatal("expected HasCachedYouTubeContext=false once youtube is disabled")
	}
	if ytHelper.IsEnabled() {
		t.Fatal("expected ytHelper.IsEnabled()=false once youtube is disabled")
	}
	snapDisabled := h.Stats().Snapshot()
	if !snapDisabled.YouTubeHelper.DisabledByConfig || snapDisabled.YouTubeHelper.ActivePlayerCached {
		t.Fatalf("expected DisabledByConfig=true and ActivePlayerCached=false, got %+v", snapDisabled.YouTubeHelper)
	}

	// All YouTube and Weibo endpoints must fast-fail with 503 + Retry-After and zero upstream/adapter hits.
	for _, tc := range []struct {
		name   string
		method string
		target string
		body   string
	}{
		{"parse-youtube", http.MethodGet, "/api/parse?schema_version=1.0&url=https://www.youtube.com/watch?v=I9JvDaciaFk", ""},
		{"youtube-context", http.MethodGet, "/api/youtube/context?schema_version=1.0", ""},
		{"youtube-finalize", http.MethodPost, "/api/youtube/finalize?schema_version=1.0", string(sampleFinalize)},
		{"parse-weibo", http.MethodGet, "/api/parse?schema_version=1.0&url=https://weibo.com/123456/AbCdEf", ""},
	} {
		rec := httptest.NewRecorder()
		var req *http.Request
		if tc.body != "" {
			req = httptest.NewRequest(tc.method, tc.target, strings.NewReader(tc.body))
		} else {
			req = httptest.NewRequest(tc.method, tc.target, nil)
		}
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s status = %d, want 503 (body=%s)", tc.name, rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Retry-After") == "" {
			t.Fatalf("%s missing Retry-After header", tc.name)
		}
		var env map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil || env["code"] != "UPSTREAM_UNAVAILABLE" {
			t.Fatalf("%s unexpected error envelope: %s", tc.name, rec.Body.String())
		}
	}
	if ytParseHits.Load() != 0 || weiboParseHits.Load() != 0 || ytExec.upstreamHits.Load() != hitsAtDisable {
		t.Fatalf("kill-switch leaked upstream calls: ytParse=%d weiboParse=%d ytHelperUpstream=%d (want %d)",
			ytParseHits.Load(), weiboParseHits.Load(), ytExec.upstreamHits.Load(), hitsAtDisable)
	}

	// Background refresh loop must stay silent while youtube is disabled.
	stopBg := ytHelper.StartBackgroundRefresh(context.Background())
	time.Sleep(40 * time.Millisecond)
	if ytExec.upstreamHits.Load() != hitsAtDisable {
		stopBg()
		t.Fatalf("background refresh issued upstream calls while disabled: got %d, want %d", ytExec.upstreamHits.Load(), hitsAtDisable)
	}

	// 3. Re-enabling via SIGHUP ApplyRuntimeConfig restores YouTube helper cleanly.
	cfgEnabled := DefaultRuntimeConfig()
	if !ApplyRuntimeConfig(nil, h, cfgEnabled, true, true) {
		stopBg()
		t.Fatal("ApplyRuntimeConfig(re-enabled) returned false")
	}
	defer stopBg()

	recCtxAfter := httptest.NewRecorder()
	h.ServeHTTP(recCtxAfter, httptest.NewRequest(http.MethodGet, "/api/youtube/context?schema_version=1.0", nil))
	if recCtxAfter.Code != http.StatusOK {
		t.Fatalf("re-enabled /api/youtube/context = %d, want 200 (body=%s)", recCtxAfter.Code, recCtxAfter.Body.String())
	}
}
