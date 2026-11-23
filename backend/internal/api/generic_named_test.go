package api

import (
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
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func makeGenericOKPayload(platform, sourceURL string, now int64, expiresAt string) unified.Object {
	src := unified.Object{
		"id":     "src-1",
		"url":    "https://cdn.vimeo.example.test/video.mp4",
		"access": "direct",
	}
	def := unified.Object{
		"variant_id": "v-1",
		"source_id":  "src-1",
		"url":        "https://cdn.vimeo.example.test/video.mp4",
		"access":     "direct",
	}
	if expiresAt != "" {
		src["expires_at"] = expiresAt
		def["expires_at"] = expiresAt
	}
	return unified.Object{
		"schema_version": unified.SchemaVersion,
		"code":           "OK",
		"data": unified.Object{
			"platform":     platform,
			"content_id":   "gen-123456",
			"source_url":   sourceURL,
			"title":        "Generic Demo Clip",
			"generated_at": time.Unix(now, 0).UTC().Format(time.RFC3339),
			"items": unified.Array{
				unified.Object{
					"id":    "video-1",
					"type":  "video",
					"state": "ready",
					"index": 1,
					"variants": unified.Array{
						unified.Object{
							"id": "v-1",
							"metadata": unified.Object{
								"container": "mp4",
								"extension": "mp4",
								"mime_type": "video/mp4",
								"width":     1280,
								"height":    720,
								"has_audio": true,
								"evidence":  "upstream",
							},
							"delivery": unified.Object{
								"kind":    "file",
								"sources": unified.Array{src},
							},
						},
					},
					"default": def,
				},
			},
		},
	}
}

func makeGenericTestCatalog(t *testing.T) *catalog.Catalog {
	t.Helper()
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range []unified.Object{catalog.XPlatform(), catalog.YouTubePlatform(), catalog.InstagramPlatform()} {
		if err := c.Register(entry); err != nil {
			t.Fatal(err)
		}
	}
	return c
}

func TestTwoTierRoutingPrecedenceAndGuards(t *testing.T) {
	const baseNow = int64(1793448000)
	c := makeGenericTestCatalog(t)

	var douyinCalls, genericCalls atomic.Int32
	adapters := map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			douyinCalls.Add(1)
			return makeStatsOKPayload("douyin", src, now), nil
		}),
	}
	h, err := New(c, adapters, func() time.Time { return time.Unix(baseNow, 0) }, nil)
	if err != nil {
		t.Fatal(err)
	}

	// 1. Disabled by default: non-catalog URL returns 400 UNSUPPORTED_PLATFORM.
	if h.GenericEnabled() {
		t.Fatal("expected GenericEnabled()=false before SetGenericAdapter")
	}
	{
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://vimeo.com/123456"), nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("disabled generic status=%d body=%s", w.Code, w.Body.String())
		}
		env, err := unified.Decode(w.Body.Bytes())
		if err != nil || unified.Str(env["code"]) != "UNSUPPORTED_PLATFORM" {
			t.Fatalf("disabled generic code=%v err=%v", env["code"], err)
		}
	}

	// Enable Tier-2 generic adapter.
	h.SetGenericAdapter(AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
		genericCalls.Add(1)
		if strings.Contains(src, "unsupported.example.org") {
			return unified.ContractError("UNSUPPORTED_PLATFORM", "暂不支持该平台链接解析", false), nil
		}
		return makeGenericOKPayload("vimeo", src, now, ""), nil
	}))
	if !h.GenericEnabled() {
		t.Fatal("expected GenericEnabled()=true after SetGenericAdapter")
	}

	// 2. /api/platforms must NEVER expose PlatformGeneric ("ytdlp_generic").
	{
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/platforms?schema_version=1.0", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("/api/platforms status=%d", w.Code)
		}
		if strings.Contains(w.Body.String(), PlatformGeneric) {
			t.Fatalf("/api/platforms leaked internal sentinel %q: %s", PlatformGeneric, w.Body.String())
		}
	}

	// 3. Tier-1 precedence unchanged: Douyin hits Tier-1 adapter and never touches genericAdapter.
	{
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/123456"), nil))
		if w.Code != http.StatusOK || douyinCalls.Load() != 1 || genericCalls.Load() != 0 {
			t.Fatalf("Tier-1 precedence failed: code=%d douyin=%d generic=%d", w.Code, douyinCalls.Load(), genericCalls.Load())
		}
	}

	// 4. Tier-2 generic routing works for omitted platform and platform=all.
	for idx, extra := range []string{"", "&platform=all"} {
		target := fmt.Sprintf("https://vimeo.com/%d", 100001+idx)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(target)+extra, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("Tier-2 (%s) status=%d body=%s", extra, w.Code, w.Body.String())
		}
		env, err := unified.Decode(w.Body.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		if gotPlat := unified.Str(unified.Map(env["data"])["platform"]); gotPlat != "vimeo" {
			t.Fatalf("Tier-2 data.platform=%q, want vimeo", gotPlat)
		}
	}
	if genericCalls.Load() != 2 {
		t.Fatalf("genericCalls=%d, want 2", genericCalls.Load())
	}

	// 5. Explicit ?platform=... and /api/resolve must NEVER trigger generic.
	genericCallsBefore := genericCalls.Load()
	for _, reqPath := range []string{
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://vimeo.com/555555") + "&platform=vimeo",
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://vimeo.com/555555") + "&platform=douyin",
		"/api/resolve?schema_version=1.0&url=" + url.QueryEscape("https://vimeo.com/555555") + "&item_id=video-1",
		"/api/resolve?schema_version=1.0&url=" + url.QueryEscape("https://vimeo.com/555555") + "&platform=all&item_id=video-1",
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, reqPath, nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s status=%d, want 400: %s", reqPath, w.Code, w.Body.String())
		}
		env, _ := unified.Decode(w.Body.Bytes())
		if unified.Str(env["code"]) != "UNSUPPORTED_PLATFORM" {
			t.Fatalf("%s code=%q, want UNSUPPORTED_PLATFORM", reqPath, unified.Str(env["code"]))
		}
	}
	if genericCalls.Load() != genericCallsBefore {
		t.Fatalf("explicit platform or /api/resolve unexpectedly invoked genericAdapter")
	}

	// 6. Invalid / dangerous URLs rejected as 400 INVALID_INPUT with 0 genericAdapter calls.
	overlongURL := "https://vimeo.com/123456?pad=" + strings.Repeat("a", maxYTDLPInputBytes+16)
	badInputs := []string{
		"https://vimeo.com/123456#t=10",
		"https://localhost/video/1",
		"https://box.local/video/1",
		"https://meta.internal/video/1",
		"https://dokitool.com/video/1",
		"https://snap.dokitool.com/video/1",
		"https://127.0.0.1/video/1",
		"https://8.8.8.8/video/1",
		"http://[::1]/video/1",
		"https://vimeo.com:8443/123456",
		"https://vimeo.com",
		"https://vimeo.com/",
		overlongURL,
	}
	for _, raw := range badInputs {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(raw), nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("bad input %q status=%d, want 400: %s", raw, w.Code, w.Body.String())
		}
		env, _ := unified.Decode(w.Body.Bytes())
		if unified.Str(env["code"]) != "INVALID_INPUT" {
			t.Fatalf("bad input %q code=%q, want INVALID_INPUT (body=%s)", raw, unified.Str(env["code"]), w.Body.String())
		}
	}
	if genericCalls.Load() != genericCallsBefore {
		t.Fatalf("bad inputs unexpectedly invoked genericAdapter: before=%d after=%d", genericCallsBefore, genericCalls.Load())
	}

	// 7. Generic adapter returning UNSUPPORTED_PLATFORM records under PlatformUnknown (no dynamic slot pollution).
	{
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://unsupported.example.org/watch/1"), nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("unsupported generic status=%d body=%s", w.Code, w.Body.String())
		}
		env, _ := unified.Decode(w.Body.Bytes())
		if unified.Str(env["code"]) != "UNSUPPORTED_PLATFORM" {
			t.Fatalf("unsupported generic code=%q", unified.Str(env["code"]))
		}
		snap := h.Stats().Snapshot()
		for _, cell := range snap.Requests.ByPlatformCodeChannel {
			if cell.Platform == PlatformGeneric || cell.Platform == "unsupported" {
				t.Fatalf("unexpected platform cell in stats: %+v", cell)
			}
		}
	}
}

func TestGenericAdapterFailClosedOnInvalidDynamicPlatform(t *testing.T) {
	const baseNow = int64(1793448000)
	c := makeGenericTestCatalog(t)
	for _, badPlat := range []string{"douyin", "x", "generic", PlatformGeneric, "unknown", "all"} {
		t.Run(badPlat, func(t *testing.T) {
			h, err := New(c, nil, func() time.Time { return time.Unix(baseNow, 0) }, nil)
			if err != nil {
				t.Fatal(err)
			}
			h.SetGenericAdapter(AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				return makeGenericOKPayload(badPlat, src, now, ""), nil
			}))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://vimeo.com/777777"), nil))
			if w.Code != http.StatusBadGateway {
				t.Fatalf("bad dynamic platform %q status=%d, want 502: %s", badPlat, w.Code, w.Body.String())
			}
		})
	}
}

func TestGenericAPIKeyPlatformScopeEnforcement(t *testing.T) {
	const baseNow = int64(1793448000)
	ownerTok := randomPrintableToken(t, 48)
	friendDeniedTok := randomPrintableToken(t, 48)
	friendAllowedTok := randomPrintableToken(t, 48)
	agentAllTok := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)

	cfg := DefaultAdmissionConfig()
	ownerAuth, err := NewOwnerAuth(ownerTok)
	if err != nil {
		t.Fatal(err)
	}
	manifest := fmt.Sprintf(`{
		"keys": [
			{
				"id": "friend-core-only",
				"role": "friend",
				"token_sha256": %q,
				"platforms": ["douyin", "bilibili"]
			},
			{
				"id": "friend-with-generic",
				"role": "friend",
				"token_sha256": %q,
				"platforms": ["douyin", "ytdlp_generic"]
			},
			{
				"id": "agent-all",
				"role": "agent",
				"token_sha256": %q
			}
		]
	}`, sha256HexOf(friendDeniedTok), sha256HexOf(friendAllowedTok), sha256HexOf(agentAllTok))

	reg, err := ParseAPIKeyRegistry([]byte(manifest), true, ownerAuth, cfg, nil)
	if err != nil {
		t.Fatalf("ParseAPIKeyRegistry failed: %v", err)
	}

	c := makeGenericTestCatalog(t)
	var genericCalls atomic.Int32
	h, err := New(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			return makeStatsOKPayload("douyin", src, now), nil
		}),
	}, func() time.Time { return time.Unix(baseNow, 0) }, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.SetGenericAdapter(AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
		genericCalls.Add(1)
		return makeGenericOKPayload("vimeo", src, now, ""), nil
	}))

	entry, err := WithAdmissionWithRegistry(h, nil, "caddy", edgeKey, cfg, reg)
	if err != nil {
		t.Fatal(err)
	}

	doReq := func(ip, tok, target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(target), nil)
		req.RemoteAddr = "127.0.0.1:43210"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, ip)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		w := httptest.NewRecorder()
		entry.ServeHTTP(w, req)
		return w
	}

	target := "https://vimeo.com/246810"

	// 1. Restricted friend key without "ytdlp_generic" rejected with 401 BEFORE invoking adapter.
	w := doReq("198.51.100.10", friendDeniedTok, target)
	if w.Code != http.StatusUnauthorized || genericCalls.Load() != 0 {
		t.Fatalf("friend-core-only cold generic status=%d calls=%d body=%s", w.Code, genericCalls.Load(), w.Body.String())
	}

	// 2. Owner key succeeds and warms cache.
	w = doReq("198.51.100.11", ownerTok, target)
	if w.Code != http.StatusOK || genericCalls.Load() != 1 {
		t.Fatalf("owner generic status=%d calls=%d body=%s", w.Code, genericCalls.Load(), w.Body.String())
	}

	// 3. Restricted friend key STILL rejected with 401 even when entry is warm in cache!
	w = doReq("198.51.100.10", friendDeniedTok, target)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("friend-core-only warm cache generic status=%d, want 401: %s", w.Code, w.Body.String())
	}

	// 4. Restricted friend key WITH "ytdlp_generic", unrestricted agent key, and anonymous caller ALL succeed via cache!
	for name, tok := range map[string]string{
		"friend-with-generic": friendAllowedTok,
		"agent-all":           agentAllTok,
		"anonymous":           "",
	} {
		w = doReq("198.51.100.12", tok, target)
		if w.Code != http.StatusOK {
			t.Fatalf("%s generic status=%d, want 200: %s", name, w.Code, w.Body.String())
		}
	}
	if genericCalls.Load() != 1 {
		t.Fatalf("expected 1 total adapter call (subsequent calls cached), got %d", genericCalls.Load())
	}

	// 5. Verify stats recorded dynamic "vimeo" (never "ytdlp_generic") and friend-core-only unauthorized=2.
	snap := h.Stats().Snapshot()
	deniedSnap := lookupAPIKeySnap(t, snap, "friend-core-only")
	if deniedSnap.Unauthorized != 2 {
		t.Fatalf("friend-core-only unauthorized=%d, want 2", deniedSnap.Unauthorized)
	}
	var vimeoOwnerOK, vimeoAnonOK, unknownUnauth uint64
	for _, cell := range snap.Requests.ByPlatformCodeChannel {
		if cell.Platform == PlatformGeneric {
			t.Fatalf("internal sentinel %q leaked into stats: %+v", PlatformGeneric, cell)
		}
		if cell.Platform == "vimeo" && cell.Code == "OK" && cell.Channel == ChannelOwner {
			vimeoOwnerOK = cell.Count
		}
		if cell.Platform == "vimeo" && cell.Code == "OK" && cell.Channel == ChannelAnonymous {
			vimeoAnonOK = cell.Count
		}
		if cell.Platform == PlatformUnknown && cell.Code == OutcomeUnauthorized {
			unknownUnauth += cell.Count
		}
	}
	// owner miss + friend-with-generic cache hit + agent-all cache hit = 3 owner OK; 1 anon OK.
	if vimeoOwnerOK != 3 || vimeoAnonOK != 1 || unknownUnauth != 2 {
		t.Fatalf("unexpected stats counts: vimeoOwnerOK=%d vimeoAnonOK=%d unknownUnauth=%d cells=%+v",
			vimeoOwnerOK, vimeoAnonOK, unknownUnauth, snap.Requests.ByPlatformCodeChannel)
	}
}

func TestGenericSlowPoolIsolationFromCorePools(t *testing.T) {
	const baseNow = int64(1793448000)
	edgeKey := randomPrintableToken(t, 48)
	c := makeGenericTestCatalog(t)

	genericStarted := make(chan struct{}, 2)
	releaseGeneric := make(chan struct{})
	xStarted := make(chan struct{}, 2)
	releaseX := make(chan struct{})

	h, err := NewWithCacheConfig(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			return makeStatsOKPayload("douyin", src, now), nil
		}),
		"x": AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
			select {
			case xStarted <- struct{}{}:
			default:
			}
			select {
			case <-releaseX:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return makeStatsOKPayload("x", src, now), nil
		}),
		"youtube": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			return makeStatsOKPayload("youtube", src, now), nil
		}),
		"instagram": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			return makeStatsOKPayload("instagram", src, now), nil
		}),
	}, func() time.Time { return time.Unix(baseNow, 0) }, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}
	h.SetGenericAdapter(AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
		select {
		case genericStarted <- struct{}{}:
		default:
		}
		select {
		case <-releaseGeneric:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return makeGenericOKPayload("vimeo", src, now, ""), nil
	}))

	cfg := DefaultAdmissionConfig()
	cfg.GenericSlowParse.GlobalConcurrency = 1
	cfg.GenericSlowParse.ClientConcurrency = 1
	cfg.GenericSlowParse.QueueSize = 0
	cfg.GenericSlowParse.QueueWait = 0
	cfg.SlowParse.GlobalConcurrency = 1
	cfg.SlowParse.ClientConcurrency = 1
	cfg.SlowParse.QueueSize = 0
	cfg.SlowParse.QueueWait = 0

	entry, err := WithAdmissionConfig(h, nil, "caddy", edgeKey, cfg)
	if err != nil {
		t.Fatal(err)
	}

	doReq := func(ip, target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(target), nil)
		req.RemoteAddr = "127.0.0.1:43210"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, ip)
		w := httptest.NewRecorder()
		entry.ServeHTTP(w, req)
		return w
	}

	// 1. Saturate genericSlow pool with one in-flight Vimeo request.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		w := doReq("198.51.100.1", "https://vimeo.com/900001")
		if w.Code != http.StatusOK {
			t.Errorf("in-flight generic request failed: status=%d body=%s", w.Code, w.Body.String())
		}
	}()
	<-genericStarted

	// 2. Second concurrent generic request from a different IP hits 429 on genericSlow!
	wGen2 := doReq("198.51.100.2", "https://vimeo.com/900002")
	if wGen2.Code != http.StatusTooManyRequests {
		t.Fatalf("second concurrent generic request got %d, want 429", wGen2.Code)
	}

	// 3. While genericSlow is 100% saturated, core SlowParse (YouTube, Instagram) AND core Fast Parse (Douyin) succeed immediately!
	for idx, u := range []string{
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		"https://www.instagram.com/reel/C1234567890/",
		"https://www.douyin.com/video/7400000000000000001",
	} {
		w := doReq(fmt.Sprintf("198.51.100.%d", 10+idx), u)
		if w.Code != http.StatusOK {
			t.Fatalf("core URL %s blocked by genericSlow saturation: status=%d body=%s", u, w.Code, w.Body.String())
		}
	}

	close(releaseGeneric)
	wg.Wait()

	// 4. Conversely, saturating core SlowParse (X) must NOT block genericSlow (Vimeo).
	wg.Add(1)
	go func() {
		defer wg.Done()
		w := doReq("198.51.100.20", "https://x.com/i/status/1800000000000000001")
		if w.Code != http.StatusOK {
			t.Errorf("in-flight X request failed: status=%d body=%s", w.Code, w.Body.String())
		}
	}()
	<-xStarted

	wX2 := doReq("198.51.100.21", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
	if wX2.Code != http.StatusTooManyRequests {
		t.Fatalf("expected SlowParse 429 while X occupies sole slot, got %d", wX2.Code)
	}
	// Release generic immediately by replacing releaseGeneric with an already-closed channel (it is already closed!).
	wVimeo := doReq("198.51.100.22", "https://vimeo.com/900003")
	if wVimeo.Code != http.StatusOK {
		t.Fatalf("genericSlow request blocked by core SlowParse saturation: status=%d body=%s", wVimeo.Code, wVimeo.Body.String())
	}

	close(releaseX)
	wg.Wait()
}

func TestGenericShortTTLCacheCapAndDynamicTelemetry(t *testing.T) {
	nowTime := time.Unix(1793448000, 0).UTC()
	var mu sync.Mutex
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return nowTime
	}
	advance := func(d time.Duration) {
		mu.Lock()
		nowTime = nowTime.Add(d)
		mu.Unlock()
	}

	// Unit check: computeCacheTTLForPlatform caps PlatformGeneric OK responses at defaultCacheTTL (60s)
	// even when earliest_expires_at is 5 minutes ahead (where core platforms get 180s).
	longExpiry := nowTime.Add(5 * time.Minute).Format(time.RFC3339)
	genPayload := makeGenericOKPayload("vimeo", "https://vimeo.com/314159", nowTime.Unix(), longExpiry)
	if ttl, ok := computeCacheTTLForPlatform(PlatformGeneric, genPayload, nowTime); !ok || ttl != defaultCacheTTL {
		t.Fatalf("PlatformGeneric capped TTL = (%v, %v), want (%v, true)", ttl, ok, defaultCacheTTL)
	}
	if ttl, ok := computeCacheTTLForPlatform("douyin", genPayload, nowTime); !ok || ttl != maxCacheTTL {
		t.Fatalf("Tier-1 douyin TTL = (%v, %v), want (%v, true)", ttl, ok, maxCacheTTL)
	}
	shortExpiry := nowTime.Add(90 * time.Second).Format(time.RFC3339) // 90s - 60s margin = 30s < 60s
	genShortPayload := makeGenericOKPayload("vimeo", "https://vimeo.com/314159", nowTime.Unix(), shortExpiry)
	if ttl, ok := computeCacheTTLForPlatform(PlatformGeneric, genShortPayload, nowTime); !ok || ttl != 30*time.Second {
		t.Fatalf("PlatformGeneric short expiry TTL = (%v, %v), want (30s, true)", ttl, ok)
	}

	// End-to-end cache hit + expiry + singleflight dynamic telemetry check.
	c := makeGenericTestCatalog(t)
	var calls atomic.Int32
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	h, err := New(c, nil, clock, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.SetGenericAdapter(AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
		n := calls.Add(1)
		if n == 1 {
			started <- struct{}{}
			<-release
		}
		return makeGenericOKPayload("tiktok", src, now, time.Unix(now, 0).UTC().Add(5*time.Minute).Format(time.RFC3339)), nil
	}))

	reqURL := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.tiktok.com/@demo/video/7000000000000000001")

	// Two concurrent requests coalesce via singleflight; both record "tiktok" in stats!
	var wg sync.WaitGroup
	rec1 := httptest.NewRecorder()
	rec2 := httptest.NewRecorder()
	wg.Add(1)
	go func() {
		defer wg.Done()
		h.ServeHTTP(rec1, httptest.NewRequest(http.MethodGet, reqURL, nil))
	}()
	<-started
	wg.Add(1)
	go func() {
		defer wg.Done()
		h.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, reqURL, nil))
	}()
	// Give second goroutine a brief moment to join inflight, then release.
	time.Sleep(25 * time.Millisecond)
	close(release)
	wg.Wait()

	if rec1.Code != http.StatusOK || rec2.Code != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("singleflight failed: rec1=%d rec2=%d calls=%d", rec1.Code, rec2.Code, calls.Load())
	}

	// After 30s (< 60s cap): cache HIT!
	advance(30 * time.Second)
	rec3 := httptest.NewRecorder()
	h.ServeHTTP(rec3, httptest.NewRequest(http.MethodGet, reqURL, nil))
	if rec3.Code != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("expected cache hit at +30s: code=%d calls=%d", rec3.Code, calls.Load())
	}

	// After 61s (> 60s cap, even though expires_at was +5m): cache EXPIRED -> fresh call!
	advance(31 * time.Second)
	rec4 := httptest.NewRecorder()
	h.ServeHTTP(rec4, httptest.NewRequest(http.MethodGet, reqURL, nil))
	if rec4.Code != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("expected cache expiry after 60s cap: code=%d calls=%d", rec4.Code, calls.Load())
	}

	// Verify dynamic telemetry recorded all 4 requests under "tiktok" (never "ytdlp_generic").
	snap := h.Stats().Snapshot()
	var tiktokCount uint64
	for _, cell := range snap.Requests.ByPlatformCodeChannel {
		if cell.Platform == PlatformGeneric {
			t.Fatalf("internal sentinel %q leaked into stats", PlatformGeneric)
		}
		if cell.Platform == "tiktok" && cell.Code == "OK" {
			tiktokCount += cell.Count
		}
	}
	if tiktokCount != 4 {
		t.Fatalf("tiktok OK count = %d, want 4 (cells=%+v)", tiktokCount, snap.Requests.ByPlatformCodeChannel)
	}
}

func TestLoadAdmissionConfigGenericSlowPool(t *testing.T) {
	defaults, err := LoadAdmissionConfig(func(string) string { return "" })
	if err != nil {
		t.Fatalf("default LoadAdmissionConfig failed: %v", err)
	}
	if defaults.GenericSlowParse.GlobalConcurrency != ytgeneric.DefaultGenericConcurrency ||
		defaults.GenericSlowParse.ClientBurst != 3 ||
		defaults.GenericSlowParse.GlobalBurst != 12 ||
		defaults.GenericSlowParse.QueueSize != 16 ||
		defaults.GenericSlowParse.QueueWait != DefaultSlowParseQueueWait {
		t.Fatalf("unexpected GenericSlowParse defaults: %+v", defaults.GenericSlowParse)
	}

	inherited, err := LoadAdmissionConfig(func(k string) string {
		if k == "DOKITOOL_YTDLP_GENERIC_CONCURRENCY" {
			return "5"
		}
		return ""
	})
	if err != nil || inherited.GenericSlowParse.GlobalConcurrency != 5 {
		t.Fatalf("expected GenericSlowParse.GlobalConcurrency=5 from env, got %+v err=%v", inherited.GenericSlowParse, err)
	}

	overridden, err := LoadAdmissionConfig(func(k string) string {
		switch k {
		case "DOKITOOL_YTDLP_GENERIC_CONCURRENCY":
			return "5"
		case "DOKITOOL_PARSE_GENERIC_GLOBAL_CONCURRENCY":
			return "7"
		case "DOKITOOL_PARSE_GENERIC_QUEUE_SIZE":
			return "24"
		case "DOKITOOL_PARSE_GENERIC_QUEUE_WAIT":
			return "3s"
		default:
			return ""
		}
	})
	if err != nil || overridden.GenericSlowParse.GlobalConcurrency != 7 || overridden.GenericSlowParse.QueueSize != 24 || overridden.GenericSlowParse.QueueWait != 3*time.Second {
		t.Fatalf("unexpected DOKITOOL_PARSE_GENERIC_* overrides: %+v err=%v", overridden.GenericSlowParse, err)
	}

	for _, bad := range []string{"0", "-1", fmt.Sprintf("%d", ytengine.MaxConcurrency+1), "not-an-int"} {
		if _, err := LoadAdmissionConfig(func(k string) string {
			if k == "DOKITOOL_YTDLP_GENERIC_CONCURRENCY" {
				return bad
			}
			return ""
		}); err == nil || !strings.Contains(err.Error(), "DOKITOOL_YTDLP_GENERIC_CONCURRENCY") || strings.Contains(err.Error(), "not-an-int") {
			t.Fatalf("expected actionable startup error for DOKITOOL_YTDLP_GENERIC_CONCURRENCY=%q, got %v", bad, err)
		}
	}
}

func TestGenericAuthenticatedKeyCountsAgainstSlowConcurrency(t *testing.T) {
	const baseNow = int64(1793448000)
	agentTok := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)
	cfg := DefaultAdmissionConfig()

	manifest := fmt.Sprintf(`{
		"keys": [
			{
				"id": "agent-slow1",
				"role": "agent",
				"token_sha256": %q,
				"concurrency": 2,
				"slow_concurrency": 1,
				"queue_size": 0,
				"queue_wait": "0s"
			}
		]
	}`, sha256HexOf(agentTok))
	reg, err := ParseAPIKeyRegistry([]byte(manifest), true, OwnerAuth{}, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}

	started := make(chan struct{}, 1)
	release := make(chan struct{})
	c := makeGenericTestCatalog(t)
	h, err := NewWithCacheConfig(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			return makeStatsOKPayload("douyin", src, now), nil
		}),
	}, func() time.Time { return time.Unix(baseNow, 0) }, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}
	h.SetGenericAdapter(AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return makeGenericOKPayload("vimeo", src, now, ""), nil
	}))

	entry, err := WithAdmissionWithRegistry(h, nil, "caddy", edgeKey, cfg, reg)
	if err != nil {
		t.Fatal(err)
	}

	doReq := func(target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(target), nil)
		req.RemoteAddr = "127.0.0.1:43210"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, "198.51.100.77")
		req.Header.Set("Authorization", "Bearer "+agentTok)
		w := httptest.NewRecorder()
		entry.ServeHTTP(w, req)
		return w
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		w := doReq("https://vimeo.com/888001")
		if w.Code != http.StatusOK {
			t.Errorf("first generic request failed: status=%d body=%s", w.Code, w.Body.String())
		}
	}()
	<-started

	// Second concurrent generic request hits slow_concurrency=1 -> 429!
	if w2 := doReq("https://vimeo.com/888002"); w2.Code != http.StatusTooManyRequests {
		t.Fatalf("second concurrent generic request on slow_concurrency=1 key got %d, want 429", w2.Code)
	}
	// Fast Douyin request STILL succeeds using the remaining concurrency slot!
	if wFast := doReq("https://www.douyin.com/video/7400000000000000009"); wFast.Code != http.StatusOK {
		t.Fatalf("fast Douyin request blocked by generic slow_concurrency=1: status=%d body=%s", wFast.Code, wFast.Body.String())
	}

	close(release)
	wg.Wait()
}
