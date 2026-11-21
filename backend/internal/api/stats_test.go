package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/x"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func makeStatsTestCatalog(t *testing.T) *catalog.Catalog {
	t.Helper()
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []unified.Object{catalog.XPlatform(), catalog.YouTubePlatform(), catalog.InstagramPlatform()} {
		if err := c.Register(p); err != nil {
			t.Fatal(err)
		}
	}
	specs, err := ytgeneric.ParseSitesEnv("facebook,tumblr")
	if err != nil {
		t.Fatal(err)
	}
	for _, spec := range specs {
		if err := c.Register(spec.CatalogEntry()); err != nil {
			t.Fatal(err)
		}
	}
	return c
}

func makeStatsOKPayload(platform, src string, now int64) unified.Object {
	return makeSyntheticEnvelope(platform, src, now, "")
}

func fetchStatsSnapshot(t *testing.T, router http.Handler, edgeKey, ownerToken, clientIP, rawQuery string) (int, StatsSnapshot) {
	t.Helper()
	target := "/api/stats"
	if rawQuery != "" {
		target += "?" + rawQuery
	}
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.RemoteAddr = "127.0.0.1:41000"
	if edgeKey != "" {
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, clientIP)
	}
	if ownerToken != "" {
		req.Header.Set("Authorization", "Bearer "+ownerToken)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		return rec.Code, StatsSnapshot{}
	}
	var env struct {
		SchemaVersion string        `json:"schema_version"`
		Code          string        `json:"code"`
		Data          StatsSnapshot `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal /api/stats body failed: %v\nbody=%s", err, rec.Body.String())
	}
	if env.SchemaVersion != unified.SchemaVersion || env.Code != "OK" {
		t.Fatalf("unexpected /api/stats envelope header: schema_version=%q code=%q", env.SchemaVersion, env.Code)
	}
	return rec.Code, env.Data
}

func lookupCellCount(cells []PlatformOutcomeCount, platform, code, channel string) uint64 {
	for _, cell := range cells {
		if cell.Platform == platform && cell.Code == code && cell.Channel == channel {
			return cell.Count
		}
	}
	return 0
}

// 1) Bounded platform × code × channel accuracy across OK, errors, 401, 429, 503, and hostile/unknown inputs.
func TestStatsBoundedPlatformCodeChannelMatrix(t *testing.T) {
	ownerToken := randomPrintableToken(t, 48)
	wrongToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)
	hostilePlatform := "attacker_plat_" + randomPrintableToken(t, 12)
	hostileURL := "https://evil.example.org/watch?v=" + randomPrintableToken(t, 16)

	if len(KnownPlatforms()) != 15 || len(KnownOutcomeCodes()) != 13 {
		t.Fatalf("unexpected closed vocabulary sizes: platforms=%d codes=%d", len(KnownPlatforms()), len(KnownOutcomeCodes()))
	}
	if NormalizePlatform(hostilePlatform) != PlatformUnknown {
		t.Fatalf("NormalizePlatform(%q) = %q, want %q", hostilePlatform, NormalizePlatform(hostilePlatform), PlatformUnknown)
	}
	if NormalizeOutcomeCode("HOSTILE_CODE") != "INTERNAL_ERROR" {
		t.Fatalf("NormalizeOutcomeCode(HOSTILE_CODE) = %q, want INTERNAL_ERROR", NormalizeOutcomeCode("HOSTILE_CODE"))
	}
	if NormalizeChannel("vip") != ChannelAnonymous || NormalizeChannel("owner") != ChannelOwner {
		t.Fatal("NormalizeChannel failed closed-set check")
	}

	c := makeStatsTestCatalog(t)
	// Leave "zuiyou" unregistered in adapters map? No, NewWithCacheConfig validates non-nil adapters,
	// so omit "zuiyou" from adapters map so /api/parse on zuiyou hits the 503 SERVICE_NOT_CONFIGURED branch!
	adapters := map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			if strings.Contains(src, "9999999999999999999") {
				return unified.ContractError("CONTENT_UNAVAILABLE", "作品不存在", false), nil
			}
			return makeStatsOKPayload("douyin", src, now), nil
		}),
		"bilibili": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			if strings.Contains(src, "BV1nomedia00") {
				return unified.ContractError("NO_MEDIA", "无可用媒体", false), nil
			}
			return makeStatsOKPayload("bilibili", src, now), nil
		}),
		"toutiao": AdapterFunc(func(_ context.Context, _ string, _ int64) (unified.Object, error) {
			return unified.ContractError("UPSTREAM_BLOCKED", "上游拒绝访问", false), nil
		}),
		"kuaishou": AdapterFunc(func(_ context.Context, _ string, _ int64) (unified.Object, error) {
			return unified.ContractError("UPSTREAM_TIMEOUT", "上游超时", true), nil
		}),
		"pipixia": AdapterFunc(func(_ context.Context, _ string, _ int64) (unified.Object, error) {
			return nil, fmt.Errorf("upstream broken")
		}),
		"x": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			return makeStatsOKPayload("x", src, now), nil
		}),
	}

	h, err := NewWithCacheConfig(c, adapters, func() time.Time { return time.Unix(1793448000, 0) }, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}
	cfg := DefaultAdmissionConfig()
	cfg.Parse.ClientBurst = 4
	cfg.Parse.ClientRPS = 0.01
	cfg.OwnerConcurrency = 1
	cfg.OwnerQueueWait = 0
	cfg.OwnerQueueSize = 0

	auth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	router, err := WithAdmissionWithOwner(h, nil, "caddy", edgeKey, cfg, auth)
	if err != nil {
		t.Fatal(err)
	}

	doReq := func(method, pathQuery, ip, bearer string) int {
		req := httptest.NewRequest(method, pathQuery, nil)
		req.RemoteAddr = "127.0.0.1:42000"
		if edgeKey != "" && ip != "INVALID_HOP" {
			req.Header.Set(edgeHeader, edgeKey)
			req.Header.Set(clientHeader, ip)
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}

	// Anonymous OK, CONTENT_UNAVAILABLE, NO_MEDIA, UPSTREAM_BLOCKED, UPSTREAM_TIMEOUT, UPSTREAM_INVALID_RESPONSE, 503 missing adapter.
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/7123456789012345678"), "198.51.100.1", ""); code != 200 {
		t.Fatalf("douyin anon OK got %d", code)
	}
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/9999999999999999999"), "198.51.100.1", ""); code != 404 {
		t.Fatalf("douyin CONTENT_UNAVAILABLE got %d", code)
	}
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.bilibili.com/video/BV1nomedia00"), "198.51.100.1", ""); code != 404 {
		t.Fatalf("bilibili NO_MEDIA got %d", code)
	}
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.toutiao.com/video/7123456789012345678/"), "198.51.100.1", ""); code != 403 {
		t.Fatalf("toutiao UPSTREAM_BLOCKED got %d", code)
	}
	// Fresh IP since 198.51.100.1 exhausted its 4-token burst!
	// Wait: sending a 5th request from 198.51.100.1 tests anonymous admission 429 RATE_LIMITED!
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/7123456789012345678"), "198.51.100.1", ""); code != 429 {
		t.Fatalf("expected 5th anon request from 198.51.100.1 to get 429, got %d", code)
	}

	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.kuaishou.com/short-video/3xngkmw8vacriqu"), "198.51.100.2", ""); code != 504 {
		t.Fatalf("kuaishou UPSTREAM_TIMEOUT got %d", code)
	}
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://h5.pipix.com/item/7385813877985909043"), "198.51.100.2", ""); code != 502 {
		t.Fatalf("pipixia UPSTREAM_INVALID_RESPONSE got %d", code)
	}
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://share.izuiyou.com/detail/123456789"), "198.51.100.2", ""); code != 503 {
		t.Fatalf("zuiyou nil adapter 503 got %d", code)
	}

	// Hostile/unknown URLs, hostile platform parameter, 405, 409, /api/resolve OK & missing item.
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(hostileURL), "198.51.100.3", ""); code != 400 {
		t.Fatalf("unsupported URL got %d", code)
	}
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&platform="+url.QueryEscape(hostilePlatform)+"&url="+url.QueryEscape("https://www.douyin.com/video/7123456789012345678"), "198.51.100.3", ""); code != 400 {
		t.Fatalf("hostile platform param got %d", code)
	}
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("not-a-url"), "198.51.100.3", ""); code != 400 {
		t.Fatalf("malformed URL got %d", code)
	}
	if code := doReq(http.MethodPost, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD"), "198.51.100.4", ""); code != 405 {
		t.Fatalf("POST /api/parse got %d", code)
	}
	if code := doReq(http.MethodGet, "/api/parse?schema_version=9.9&url="+url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD"), "198.51.100.4", ""); code != 409 {
		t.Fatalf("wrong schema_version got %d", code)
	}
	if code := doReq(http.MethodGet, "/api/resolve?schema_version=1.0&item_id=item-1&url="+url.QueryEscape("https://x.com/i/status/1790637656616943991"), "198.51.100.5", ownerToken); code != 200 {
		t.Fatalf("owner /api/resolve OK got %d", code)
	}
	if code := doReq(http.MethodGet, "/api/resolve?schema_version=1.0&item_id=missing-item&url="+url.QueryEscape("https://x.com/i/status/1790637656616943991"), "198.51.100.5", ownerToken); code != 404 {
		t.Fatalf("owner /api/resolve missing item got %d", code)
	}

	// Admission 503 (missing trusted proxy headers on /api/parse).
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/7123456789012345678"), "INVALID_HOP", ""); code != 503 {
		t.Fatalf("missing edge header got %d, want 503", code)
	}

	// Bad Authorization on /api/parse from 198.51.100.6: 4x 401 UNAUTHORIZED -> 5th gets 429 RATE_LIMITED!
	for attempt := 1; attempt <= 4; attempt++ {
		if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://x.com/i/status/1790637656616943991"), "198.51.100.6", wrongToken); code != 401 {
			t.Fatalf("bad bearer attempt %d got %d, want 401", attempt, code)
		}
	}
	if code := doReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://x.com/i/status/1790637656616943991"), "198.51.100.6", wrongToken); code != 429 {
		t.Fatalf("bad bearer attempt 5 got %d, want 429", code)
	}

	// /api/platforms must NOT pollute /api/parse platform×code×channel counters.
	if code := doReq(http.MethodGet, "/api/platforms?schema_version=1.0", "198.51.100.7", ""); code != 200 {
		t.Fatalf("/api/platforms got %d", code)
	}

	status, snap := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "")
	if status != http.StatusOK {
		t.Fatalf("GET /api/stats returned %d", status)
	}

	// Verify raw JSON contains zero hostile caller-supplied strings.
	rawJSON, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{hostilePlatform, hostileURL, ownerToken[:12], wrongToken[:12], edgeKey[:12]} {
		if strings.Contains(string(rawJSON), forbidden) {
			t.Fatalf("stats JSON leaked caller/secret string %q: %s", forbidden, string(rawJSON))
		}
	}

	knownPlatSet := KnownPlatforms()
	knownCodeSet := KnownOutcomeCodes()
	var sumCells uint64
	for _, cell := range snap.Requests.ByPlatformCodeChannel {
		if !slices.Contains(knownPlatSet, cell.Platform) {
			t.Fatalf("unbounded platform key %q in stats", cell.Platform)
		}
		if !slices.Contains(knownCodeSet, cell.Code) {
			t.Fatalf("unbounded outcome code %q in stats", cell.Code)
		}
		if cell.Channel != ChannelAnonymous && cell.Channel != ChannelOwner {
			t.Fatalf("unbounded channel %q in stats", cell.Channel)
		}
		sumCells += cell.Count
	}
	if sumCells != snap.Requests.Total || snap.Requests.Total != snap.Requests.ByChannel.Anonymous+snap.Requests.ByChannel.Owner {
		t.Fatalf("request count sum mismatch: sumCells=%d total=%d by_channel=%+v", sumCells, snap.Requests.Total, snap.Requests.ByChannel)
	}
	if snap.ParseLatencyMS.Total.Count != snap.Requests.Total {
		t.Fatalf("latency total count=%d != requests total=%d", snap.ParseLatencyMS.Total.Count, snap.Requests.Total)
	}

	// Spot-check exact cells across dimensions.
	checks := []struct {
		platform, code, channel string
		want                    uint64
	}{
		{"douyin", "OK", "anonymous", 1},
		{"douyin", "CONTENT_UNAVAILABLE", "anonymous", 1},
		{"douyin", "RATE_LIMITED", "anonymous", 1},
		{"douyin", "UNSUPPORTED_PLATFORM", "anonymous", 1},
		{"douyin", "SERVICE_NOT_CONFIGURED", "anonymous", 1},
		{"bilibili", "NO_MEDIA", "anonymous", 1},
		{"bilibili", "INVALID_INPUT", "anonymous", 2}, // 405 + 409
		{"toutiao", "UPSTREAM_BLOCKED", "anonymous", 1},
		{"kuaishou", "UPSTREAM_TIMEOUT", "anonymous", 1},
		{"pipixia", "UPSTREAM_INVALID_RESPONSE", "anonymous", 1},
		{"zuiyou", "SERVICE_NOT_CONFIGURED", "anonymous", 1},
		{"unknown", "UNSUPPORTED_PLATFORM", "anonymous", 1},
		{"unknown", "INVALID_INPUT", "anonymous", 1},
		{"x", OutcomeUnauthorized, "anonymous", 4},
		{"x", "RATE_LIMITED", "anonymous", 1},
		{"x", "OK", "owner", 1},
		{"x", "CONTENT_UNAVAILABLE", "owner", 1},
	}
	for _, tc := range checks {
		if got := lookupCellCount(snap.Requests.ByPlatformCodeChannel, tc.platform, tc.code, tc.channel); got != tc.want {
			t.Fatalf("cell (%s, %s, %s) = %d, want %d (all=%+v)", tc.platform, tc.code, tc.channel, got, tc.want, snap.Requests.ByPlatformCodeChannel)
		}
	}
}

// 2) Cache hits + singleflight coalescing + Shanghai PullBroker hits/queue_waits/fallbacks + admission queue waits.
func TestStatsCacheSingleflightShanghaiAndAdmissionQueues(t *testing.T) {
	ownerToken := randomPrintableToken(t, 48)
	pullToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)

	broker, err := shresolver.NewPullBroker(pullToken)
	if err != nil {
		t.Fatal(err)
	}

	// Gates for bilibili (fast pool + singleflight), x (slow pool), and toutiao (owner pool).
	biliEntered := make(chan struct{}, 8)
	biliRelease := make(chan struct{})
	var biliGate sync.Once

	slowHoldEntered := make(chan struct{}, 4)
	slowHoldRelease := make(chan struct{})
	ownerHoldEntered := make(chan struct{}, 4)
	ownerHoldRelease := make(chan struct{})
	fastHoldEntered := make(chan struct{}, 4)
	fastHoldRelease := make(chan struct{})

	c := makeStatsTestCatalog(t)
	adapters := map[string]Adapter{
		"bilibili": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			if strings.Contains(src, "BV1sfcoalesce") {
				biliEntered <- struct{}{}
				<-biliRelease
			}
			if strings.Contains(src, "BV1fasthold") {
				fastHoldEntered <- struct{}{}
				<-fastHoldRelease
			}
			return makeStatsOKPayload("bilibili", src, now), nil
		}),
		"weibo": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			return makeStatsOKPayload("weibo", src, now), nil
		}),
		"douyin": AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
			idx := strings.LastIndexByte(src, '/')
			awemeID := src[idx+1:]
			// Mirror Douyin Shanghai-first + Japan fallback behavior.
			_, _ = broker.ResolveWork(ctx, awemeID)
			return makeStatsOKPayload("douyin", src, now), nil
		}),
		"x": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			if strings.Contains(src, "1900000000000000001") {
				slowHoldEntered <- struct{}{}
				<-slowHoldRelease
			}
			return makeStatsOKPayload("x", src, now), nil
		}),
		"toutiao": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			if strings.Contains(src, "7900000000000000001") {
				ownerHoldEntered <- struct{}{}
				<-ownerHoldRelease
			}
			return makeStatsOKPayload("toutiao", src, now), nil
		}),
	}

	publicMedia := func(_ context.Context, _ string, payload unified.Object, _ int64) (unified.Object, error) {
		return payload, nil
	}
	h, err := NewWithCacheConfig(c, adapters, time.Now, publicMedia, DefaultCacheConfig())
	if err != nil {
		t.Fatal(err)
	}
	h.Stats().SetShanghaiSource(broker)

	cfg := DefaultAdmissionConfig()
	cfg.Parse.GlobalConcurrency = 1
	cfg.Parse.ClientConcurrency = 1
	cfg.Parse.ClientBurst = 50
	cfg.Parse.ClientRPS = 50
	cfg.Parse.GlobalBurst = 100
	cfg.Parse.GlobalRPS = 100
	cfg.Parse.QueueSize = 2
	cfg.Parse.QueueWait = 60 * time.Millisecond

	cfg.SlowParse.GlobalConcurrency = 1
	cfg.SlowParse.ClientConcurrency = 1
	cfg.SlowParse.ClientBurst = 50
	cfg.SlowParse.ClientRPS = 50
	cfg.SlowParse.GlobalBurst = 100
	cfg.SlowParse.GlobalRPS = 100
	cfg.SlowParse.QueueSize = 1
	cfg.SlowParse.QueueWait = 60 * time.Millisecond

	cfg.OwnerConcurrency = 1
	cfg.OwnerQueueSize = 2
	cfg.OwnerQueueWait = 60 * time.Millisecond

	auth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	router, err := WithAdmissionWithOwner(h, broker, "caddy", edgeKey, cfg, auth)
	if err != nil {
		t.Fatal(err)
	}

	sendParse := func(ctx context.Context, rawURL, ip, bearer string) int {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(rawURL), nil)
		if err != nil {
			t.Fatal(err)
		}
		req.RemoteAddr = "127.0.0.1:43000"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, ip)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}

	// --- Part A: Cache miss + singleflight shared + cache hits + uncacheable ---
	const sfURL = "https://www.bilibili.com/video/BV1sfcoalesce"
	leaderDone := make(chan int, 1)
	go func() {
		leaderDone <- sendParse(context.Background(), sfURL, "198.51.100.10", "")
	}()
	<-biliEntered // Anonymous leader is now inside adapter; fast pool slot is occupied, so owner joiners bypass fast pool via ownerPool!

	ownerJoinDone := make(chan int, 1)
	go func() {
		ownerJoinDone <- sendParse(context.Background(), sfURL, "198.51.100.11", ownerToken)
	}()
	// Wait until inflight waiters == 2 so singleflight coalescing is deterministic.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, snap := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "")
		if snap.Cache.ByChannel.Owner.SingleflightShared == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	biliGate.Do(func() { close(biliRelease) })

	if code := <-leaderDone; code != 200 {
		t.Fatalf("singleflight leader status=%d", code)
	}
	if code := <-ownerJoinDone; code != 200 {
		t.Fatalf("singleflight owner joiner status=%d", code)
	}

	// Subsequent requests hit LRU cache directly.
	if code := sendParse(context.Background(), sfURL, "198.51.100.10", ""); code != 200 {
		t.Fatalf("anon cache hit status=%d", code)
	}
	if code := sendParse(context.Background(), sfURL, "198.51.100.11", ownerToken); code != 200 {
		t.Fatalf("owner cache hit status=%d", code)
	}

	// Uncacheable platform (weibo) increments Uncacheable for both channels.
	if code := sendParse(context.Background(), "https://weibo.com/1234567890/AbCdEfG", "198.51.100.12", ""); code != 200 {
		t.Fatalf("anon weibo status=%d", code)
	}
	if code := sendParse(context.Background(), "https://weibo.com/1234567890/AbCdEfG", "198.51.100.12", ownerToken); code != 200 {
		t.Fatalf("owner weibo status=%d", code)
	}

	// --- Part B: Shanghai PullBroker hits, 300ms queue waits (granted + timeout fallback) ---
	claimOnce := func(ctx context.Context) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, shresolver.ClaimPath, nil)
		req.RemoteAddr = "127.0.0.1:43001"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, "198.51.100.200")
		req.Header.Set("Authorization", "Bearer "+pullToken)
		req.Header.Set(shresolver.ProtocolHeader, "2")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	submitWork := func(job shresolver.PullJob) {
		workRaw, _ := json.Marshal(shresolver.WorkResponse{
			Protocol: shresolver.ProtocolV2,
			AwemeID:  job.AwemeID,
			VideoID:  "v0200fg1" + job.AwemeID,
		})
		body, _ := json.Marshal(shresolver.PullResult{PullJob: job, Result: workRaw})
		req := httptest.NewRequest(http.MethodPost, shresolver.ResultPath, bytes.NewReader(body))
		req.RemoteAddr = "127.0.0.1:43001"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, "198.51.100.200")
		req.Header.Set("Authorization", "Bearer "+pullToken)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("Shanghai result submit got %d", rec.Code)
		}
	}

	// B1: Pre-park worker -> immediate owner Shanghai hit (0 queue_waits).
	claimRecCh := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		claimRecCh <- claimOnce(context.Background())
	}()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if broker.ShanghaiStatsSnapshot().WaitingWorkers == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	dyOwnerDone := make(chan int, 1)
	go func() {
		dyOwnerDone <- sendParse(context.Background(), "https://www.douyin.com/video/7700000000000000001", "198.51.100.20", ownerToken)
	}()
	claimRec1 := <-claimRecCh
	var job1 shresolver.PullJob
	if claimRec1.Code != 200 || json.Unmarshal(claimRec1.Body.Bytes(), &job1) != nil {
		t.Fatalf("unexpected claim #1: code=%d body=%s", claimRec1.Code, claimRec1.Body.String())
	}
	submitWork(job1)
	if code := <-dyOwnerDone; code != 200 {
		t.Fatalf("owner douyin parse got %d", code)
	}

	// B2: Worker recently active -> anonymous Douyin parse enters 300ms queue, worker arrives after ~25ms -> queue_waits=1, queue_granted=1, hits=1.
	dyAnonQueuedDone := make(chan int, 1)
	go func() {
		dyAnonQueuedDone <- sendParse(context.Background(), "https://www.douyin.com/video/7700000000000000002", "198.51.100.21", "")
	}()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if broker.ShanghaiStatsSnapshot().QueuedTasks == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(25 * time.Millisecond)
	claimRec2 := claimOnce(context.Background())
	var job2 shresolver.PullJob
	if claimRec2.Code != 200 || json.Unmarshal(claimRec2.Body.Bytes(), &job2) != nil {
		t.Fatalf("unexpected queued claim #2: code=%d body=%s", claimRec2.Code, claimRec2.Body.String())
	}
	submitWork(job2)
	if code := <-dyAnonQueuedDone; code != 200 {
		t.Fatalf("queued anon douyin parse got %d", code)
	}

	// B3: No worker claims within 300ms -> queue_timeouts=1, fallbacks=1, parse still succeeds via Japan fallback (200 OK).
	if code := sendParse(context.Background(), "https://www.douyin.com/video/7700000000000000003", "198.51.100.22", ""); code != 200 {
		t.Fatalf("fallback anon douyin parse got %d", code)
	}

	// --- Part C: Admission queue waits (fast, slow, owner: granted, timeout, full, canceled) ---
	// C1: Fast pool (conc=1, queue=2, wait=60ms): hold active, cancel 1 queued waiter, grant 1 queued waiter.
	fastActiveDone := make(chan int, 1)
	go func() {
		fastActiveDone <- sendParse(context.Background(), "https://www.bilibili.com/video/BV1fasthold", "198.51.100.30", "")
	}()
	<-fastHoldEntered

	cancelFastCtx, cancelFast := context.WithCancel(context.Background())
	fastCanceledDone := make(chan struct{})
	go func() {
		_ = sendParse(cancelFastCtx, "https://www.bilibili.com/video/BV1fastcancel", "198.51.100.31", "")
		close(fastCanceledDone)
	}()
	fastGrantedDone := make(chan int, 1)
	go func() {
		fastGrantedDone <- sendParse(context.Background(), "https://www.bilibili.com/video/BV1fastgrant", "198.51.100.32", "")
	}()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, s := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "")
		if s.Admission.Fast.Active == 1 && s.Admission.Fast.Queued == 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Queue is now full (2/2): 3rd waiter is rejected immediately with 429 and increments Full.
	if code := sendParse(context.Background(), "https://www.bilibili.com/video/BV1fastfull", "198.51.100.33", ""); code != 429 {
		t.Fatalf("expected fast queue full 429, got %d", code)
	}
	cancelFast()
	<-fastCanceledDone
	time.Sleep(15 * time.Millisecond)
	close(fastHoldRelease)
	if code := <-fastActiveDone; code != 200 {
		t.Fatalf("fast active got %d", code)
	}
	if code := <-fastGrantedDone; code != 200 {
		t.Fatalf("fast granted waiter got %d", code)
	}

	// C2: Slow pool (conc=1, queue=1, wait=60ms): hold active past 60ms so 1 queued waiter times out (429), and 2nd overflows Full (429).
	slowActiveDone := make(chan int, 1)
	go func() {
		slowActiveDone <- sendParse(context.Background(), "https://x.com/i/status/1900000000000000001", "198.51.100.40", "")
	}()
	<-slowHoldEntered
	slowTimeoutDone := make(chan int, 1)
	go func() {
		slowTimeoutDone <- sendParse(context.Background(), "https://x.com/i/status/1900000000000000002", "198.51.100.41", "")
	}()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, s := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "")
		if s.Admission.Slow.Queued == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if code := sendParse(context.Background(), "https://x.com/i/status/1900000000000000003", "198.51.100.42", ""); code != 429 {
		t.Fatalf("expected slow queue full 429, got %d", code)
	}
	if code := <-slowTimeoutDone; code != 429 {
		t.Fatalf("expected slow queued waiter timeout 429, got %d", code)
	}
	close(slowHoldRelease)
	if code := <-slowActiveDone; code != 200 {
		t.Fatalf("slow active got %d", code)
	}

	// C3: Owner pool (conc=1, queue=2, wait=60ms): hold active, grant 1 queued waiter after 20ms.
	ownerActiveDone := make(chan int, 1)
	go func() {
		ownerActiveDone <- sendParse(context.Background(), "https://www.toutiao.com/video/7900000000000000001/", "198.51.100.50", ownerToken)
	}()
	<-ownerHoldEntered
	ownerWaitDone := make(chan int, 1)
	go func() {
		ownerWaitDone <- sendParse(context.Background(), "https://www.toutiao.com/video/7900000000000000002/", "198.51.100.50", ownerToken)
	}()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, s := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "")
		if s.Admission.Owner.Queued == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	close(ownerHoldRelease)
	if code := <-ownerActiveDone; code != 200 {
		t.Fatalf("owner active got %d", code)
	}
	if code := <-ownerWaitDone; code != 200 {
		t.Fatalf("owner queued waiter got %d", code)
	}

	// Verify final snapshot across Cache, Shanghai, and Admission pools!
	st, snap := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "schema_version=1.0")
	if st != 200 {
		t.Fatalf("GET /api/stats?schema_version=1.0 status=%d", st)
	}
	if !snap.Cache.Enabled || snap.Cache.Entries == 0 || snap.Cache.Bytes <= 0 {
		t.Fatalf("expected populated cache occupancy, got %+v", snap.Cache)
	}
	if snap.Cache.ByChannel.Anonymous.Hits != 1 || snap.Cache.ByChannel.Owner.Hits != 1 ||
		snap.Cache.ByChannel.Owner.SingleflightShared != 1 ||
		snap.Cache.ByChannel.Anonymous.Uncacheable != 1 || snap.Cache.ByChannel.Owner.Uncacheable != 1 {
		t.Fatalf("unexpected cache breakdown: %+v", snap.Cache)
	}

	if !snap.Shanghai.Enabled || snap.Shanghai.Mode != "pull" {
		t.Fatalf("unexpected shanghai mode/enabled: %+v", snap.Shanghai)
	}
	if snap.Shanghai.ByChannel.Owner.Hits != 1 || snap.Shanghai.ByChannel.Owner.QueueWaits != 0 {
		t.Fatalf("unexpected owner shanghai stats: %+v", snap.Shanghai.ByChannel.Owner)
	}
	if snap.Shanghai.ByChannel.Anonymous.Hits != 1 ||
		snap.Shanghai.ByChannel.Anonymous.Fallbacks != 1 ||
		snap.Shanghai.ByChannel.Anonymous.QueueWaits != 2 ||
		snap.Shanghai.ByChannel.Anonymous.QueueGranted != 1 ||
		snap.Shanghai.ByChannel.Anonymous.QueueTimeouts != 1 ||
		snap.Shanghai.ByChannel.Anonymous.QueueWaitMSTotal < 250 {
		t.Fatalf("unexpected anonymous shanghai stats: %+v", snap.Shanghai.ByChannel.Anonymous)
	}
	if snap.Shanghai.ByPlatform.Douyin.Hits != 2 ||
		snap.Shanghai.ByPlatform.Douyin.Fallbacks != 1 ||
		snap.Shanghai.ByPlatform.Douyin.QueueWaits != 2 ||
		snap.Shanghai.ByPlatform.Bilibili.Hits != 0 ||
		snap.Shanghai.ByPlatform.Bilibili.Fallbacks != 0 {
		t.Fatalf("unexpected by_platform shanghai stats: %+v", snap.Shanghai.ByPlatform)
	}

	if snap.Admission.Fast.Granted != 1 || snap.Admission.Fast.Canceled != 1 || snap.Admission.Fast.Full != 1 || snap.Admission.Fast.Waited != 2 {
		t.Fatalf("unexpected fast pool stats: %+v", snap.Admission.Fast)
	}
	if snap.Admission.Slow.Timeout != 1 || snap.Admission.Slow.Full != 1 || snap.Admission.Slow.Waited != 1 || snap.Admission.Slow.WaitMSTotal < 40 {
		t.Fatalf("unexpected slow pool stats: %+v", snap.Admission.Slow)
	}
	if snap.Admission.Owner.Granted != 1 || snap.Admission.Owner.Waited != 1 || snap.Admission.Owner.WaitMSTotal < 10 {
		t.Fatalf("unexpected owner pool stats: %+v", snap.Admission.Owner)
	}
}

// 3) End-to-end HTTP yt-dlp contention between owner and anonymous slow-platform requests.
func TestStatsYTDLPContentionByChannelEndToEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script fixture requires unix")
	}
	ownerToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)

	gateDir := t.TempDir()
	binPath := filepath.Join(gateDir, "yt-dlp-fake")
	script := "#!/bin/sh\nset -eu\n" + `
target=""
for arg in "$@"; do
  target="$arg"
done
id="${target##*/}"
touch "` + gateDir + `/started_${id}"
while [ ! -f "` + gateDir + `/release_${id}" ]; do
  sleep 0.01
done
cat <<JSON
{"id":"${id}","display_id":"${id}","_type":"video","title":"X Video","uploader":"tester","uploader_id":"tester","timestamp":1790000000,"duration":5,"formats":[{"format_id":"http-720","url":"https://video.twimg.com/amplify_video/${id}/vid/avc1/720x720/test.mp4","ext":"mp4","protocol":"https","vcodec":"avc1.4d401f","acodec":"mp4a.40.2","width":720,"height":720,"filesize":1048576}]}
JSON
`
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(script))
	hexSum := hex.EncodeToString(sum[:])

	baseEng, err := ytengine.New(ytengine.Config{
		BinaryPath:     binPath,
		AllowedHashes:  map[string]string{hexSum: "yt-dlp-stats-e2e"},
		Resolver:       staticPublicResolver{},
		MaxConcurrency: 1,
		Timeout:        10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	xEng := baseEng.WithTargetPolicy(x.AllowedTargetURL, x.AllowedOutboundHost).WithExtractors(x.AllowedExtractors()...)
	xParser := x.NewWithSizeProber(xEng, nil)

	c := makeStatsTestCatalog(t)
	h, err := NewWithCacheConfig(c, map[string]Adapter{"x": xParser}, time.Now, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}
	h.Stats().SetYTDLPEngine(baseEng)

	cfg := DefaultAdmissionConfig()
	auth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	router, err := WithAdmissionWithOwner(h, nil, "caddy", edgeKey, cfg, auth)
	if err != nil {
		t.Fatal(err)
	}

	releaseID := func(id string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(gateDir, "release_"+id), []byte("1"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	waitStartedID := func(id string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(filepath.Join(gateDir, "started_"+id)); err == nil {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for yt-dlp %s to start", id)
	}
	sendX := func(tweetID, ip, bearer string) int {
		u := "https://x.com/i/status/" + tweetID
		req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(u), nil)
		req.RemoteAddr = "127.0.0.1:44000"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, ip)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}

	// Step 1: Uncontended anonymous & owner calls record 0 waits.
	releaseID("1800000000000000001")
	if code := sendX("1800000000000000001", "198.51.100.60", ""); code != 200 {
		t.Fatalf("uncontended anon X got %d", code)
	}
	releaseID("1800000000000000002")
	if code := sendX("1800000000000000002", "198.51.100.61", ownerToken); code != 200 {
		t.Fatalf("uncontended owner X got %d", code)
	}
	_, snap0 := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "")
	if snap0.YTDLP.ByChannel.Anonymous.WaitCount != 0 || snap0.YTDLP.ByChannel.Owner.WaitCount != 0 {
		t.Fatalf("uncontended yt-dlp calls recorded non-zero waits: %+v", snap0.YTDLP)
	}

	// Step 2: Owner holds the single yt-dlp slot while anonymous slow-platform request waits.
	ownerDone := make(chan int, 1)
	go func() {
		ownerDone <- sendX("1800000000000000003", "198.51.100.61", ownerToken)
	}()
	waitStartedID("1800000000000000003")

	releaseID("1800000000000000004")
	anonDone := make(chan int, 1)
	go func() {
		anonDone <- sendX("1800000000000000004", "198.51.100.62", "")
	}()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_, live := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "")
		if live.YTDLP.Active == 1 && live.YTDLP.Waiting == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(35 * time.Millisecond)
	releaseID("1800000000000000003")
	if code := <-ownerDone; code != 200 {
		t.Fatalf("owner holder X got %d", code)
	}
	if code := <-anonDone; code != 200 {
		t.Fatalf("anon waiter X got %d", code)
	}

	_, snap1 := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "")
	if snap1.YTDLP.ByChannel.Anonymous.WaitCount != 1 || snap1.YTDLP.ByChannel.Anonymous.WaitMSTotal < 25 || snap1.YTDLP.ByChannel.Owner.WaitCount != 0 {
		t.Fatalf("expected anonymous WaitCount=1 (>=25ms) and owner WaitCount=0, got %+v", snap1.YTDLP.ByChannel)
	}

	// Step 3: Anonymous holds the single yt-dlp slot while owner slow-platform request waits.
	anonHoldDone := make(chan int, 1)
	go func() {
		anonHoldDone <- sendX("1800000000000000005", "198.51.100.63", "")
	}()
	waitStartedID("1800000000000000005")

	releaseID("1800000000000000006")
	ownerWaitDone := make(chan int, 1)
	go func() {
		ownerWaitDone <- sendX("1800000000000000006", "198.51.100.61", ownerToken)
	}()
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_, live := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "")
		if live.YTDLP.Active == 1 && live.YTDLP.Waiting == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(35 * time.Millisecond)
	releaseID("1800000000000000005")
	if code := <-anonHoldDone; code != 200 {
		t.Fatalf("anon holder X got %d", code)
	}
	if code := <-ownerWaitDone; code != 200 {
		t.Fatalf("owner waiter X got %d", code)
	}

	_, snap2 := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "")
	if snap2.YTDLP.ByChannel.Owner.WaitCount != 1 || snap2.YTDLP.ByChannel.Owner.WaitMSTotal < 25 {
		t.Fatalf("expected owner WaitCount=1 (>=25ms), got %+v", snap2.YTDLP.ByChannel.Owner)
	}
}

// 4) GET /api/stats auth matrix, brute-force charging, and instant response under 100% saturated ownerPool.
func TestStatsEndpointAuthMatrixAndNonBlockingUnderSaturatedOwnerPool(t *testing.T) {
	ownerToken := randomPrintableToken(t, 48)
	wrongToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)

	blockEntered := make(chan struct{}, 8)
	blockRelease := make(chan struct{})

	c := makeStatsTestCatalog(t)
	h, err := NewWithCacheConfig(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			blockEntered <- struct{}{}
			<-blockRelease
			return makeStatsOKPayload("douyin", src, now), nil
		}),
	}, time.Now, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}

	cfg := DefaultAdmissionConfig()
	cfg.OwnerConcurrency = 2
	cfg.OwnerQueueSize = 1
	cfg.OwnerQueueWait = 5 * time.Second

	auth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	router, err := WithAdmissionWithOwner(h, nil, "caddy", edgeKey, cfg, auth)
	if err != nil {
		t.Fatal(err)
	}

	sendRawStats := func(rtr http.Handler, method, target, ip string, authHeaders []string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, nil)
		req.RemoteAddr = "127.0.0.1:45000"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, ip)
		for _, hdr := range authHeaders {
			req.Header.Add("Authorization", hdr)
		}
		rec := httptest.NewRecorder()
		rtr.ServeHTTP(rec, req)
		return rec
	}

	assertSecurityHeaders := func(t *testing.T, rec *httptest.ResponseRecorder) {
		t.Helper()
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("Cache-Control = %q, want no-store", got)
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
		}
		if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
			t.Fatalf("Content-Type = %q, want application/json", got)
		}
	}

	// Direct Handler call without admission owner context fails closed with 401.
	directRec := httptest.NewRecorder()
	h.ServeHTTP(directRec, httptest.NewRequest(http.MethodGet, "/api/stats", nil))
	if directRec.Code != http.StatusUnauthorized {
		t.Fatalf("direct Handler.ServeHTTP(/api/stats) without owner context got %d, want 401", directRec.Code)
	}
	assertSecurityHeaders(t, directRec)

	// Brute-force matrix from single IP (203.0.113.10): 4 invalid auth attempts -> 401, 5th -> 429!
	overlongHdr := "Bearer " + randomPrintableToken(t, MaxOwnerTokenBytes+16)
	badAttempts := []struct {
		name    string
		method  string
		target  string
		headers []string
	}{
		{"missing-header", http.MethodGet, "/api/stats", nil},
		{"wrong-token", http.MethodGet, "/api/stats", []string{"Bearer " + wrongToken}},
		{"query-param-token", http.MethodGet, "/api/stats?token=" + url.QueryEscape(ownerToken), nil},
		{"oversized-header", http.MethodGet, "/api/stats", []string{overlongHdr}},
	}
	for i, tc := range badAttempts {
		rec := sendRawStats(router, tc.method, tc.target, "203.0.113.10", tc.headers)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d (%s): status=%d, want 401; body=%s", i+1, tc.name, rec.Code, rec.Body.String())
		}
		assertSecurityHeaders(t, rec)
		dec, err := unified.Decode(rec.Body.Bytes())
		if err != nil || unified.Str(dec["code"]) != "INVALID_INPUT" {
			t.Fatalf("attempt %d (%s): expected unified-v1 INVALID_INPUT body, got %s", i+1, tc.name, rec.Body.String())
		}
	}
	// 5th bad attempt from 203.0.113.10 hits per-IP rate limit (429).
	rec5 := sendRawStats(router, http.MethodGet, "/api/stats", "203.0.113.10", []string{"Bearer " + wrongToken})
	if rec5.Code != http.StatusTooManyRequests || rec5.Header().Get("Retry-After") == "" {
		t.Fatalf("5th bad auth attempt got status=%d Retry-After=%q, want 429", rec5.Code, rec5.Header().Get("Retry-After"))
	}
	assertSecurityHeaders(t, rec5)

	// Valid owner token from the SAME throttled IP still succeeds immediately with 200 OK.
	recValidSameIP := sendRawStats(router, http.MethodGet, "/api/stats", "203.0.113.10", []string{"Bearer " + ownerToken})
	if recValidSameIP.Code != http.StatusOK {
		t.Fatalf("valid owner token from throttled IP got %d, want 200", recValidSameIP.Code)
	}
	assertSecurityHeaders(t, recValidSameIP)

	// Query-param token is rejected even when valid Authorization header is present (400).
	recQueryWithAuth := sendRawStats(router, http.MethodGet, "/api/stats?token="+url.QueryEscape(ownerToken), "203.0.113.11", []string{"Bearer " + ownerToken})
	if recQueryWithAuth.Code != http.StatusBadRequest {
		t.Fatalf("query token with valid header got %d, want 400", recQueryWithAuth.Code)
	}

	// Wrong schema_version with valid header -> 409; schema_version=1.0 -> 200.
	if rec := sendRawStats(router, http.MethodGet, "/api/stats?schema_version=2.0", "203.0.113.11", []string{"Bearer " + ownerToken}); rec.Code != http.StatusConflict {
		t.Fatalf("wrong schema_version got %d, want 409", rec.Code)
	}
	if rec := sendRawStats(router, http.MethodGet, "/api/stats?schema_version=1.0", "203.0.113.11", []string{"Bearer " + ownerToken}); rec.Code != http.StatusOK {
		t.Fatalf("schema_version=1.0 got %d, want 200", rec.Code)
	}

	// POST /api/stats: 401 without token; 405 (Allow: GET) with valid token.
	if rec := sendRawStats(router, http.MethodPost, "/api/stats", "203.0.113.12", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST /api/stats without token got %d, want 401", rec.Code)
	}
	postAuthRec := sendRawStats(router, http.MethodPost, "/api/stats", "203.0.113.12", []string{"Bearer " + ownerToken})
	if postAuthRec.Code != http.StatusMethodNotAllowed || postAuthRec.Header().Get("Allow") != "GET" {
		t.Fatalf("POST /api/stats with valid token got status=%d Allow=%q, want 405 GET", postAuthRec.Code, postAuthRec.Header().Get("Allow"))
	}

	// Disabled DOKITOOL_OWNER_TOKEN="" (OwnerAuth{}): returns 401 x4 -> 429 on 5th even with a well-formed Bearer header.
	hDisabled, err := NewWithCacheConfig(c, nil, time.Now, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}
	disabledRouter, err := WithAdmissionWithOwner(hDisabled, nil, "caddy", edgeKey, cfg, OwnerAuth{})
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 4; i++ {
		if rec := sendRawStats(disabledRouter, http.MethodGet, "/api/stats", "203.0.113.20", []string{"Bearer " + ownerToken}); rec.Code != http.StatusUnauthorized {
			t.Fatalf("disabled owner token attempt %d got %d, want 401", i, rec.Code)
		}
	}
	if rec := sendRawStats(disabledRouter, http.MethodGet, "/api/stats", "203.0.113.20", []string{"Bearer " + ownerToken}); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("disabled owner token 5th attempt got %d, want 429", rec.Code)
	}

	// Verify zero /api/stats requests polluted /api/parse counters before saturation test.
	_, preSnap := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "203.0.113.99", "")
	if preSnap.Requests.Total != 0 || len(preSnap.Requests.ByPlatformCodeChannel) != 0 {
		t.Fatalf("/api/stats polluted /api/parse counters: %+v", preSnap.Requests)
	}

	// Saturate ownerPool completely: 2 active + 1 queued (OwnerConcurrency=2, OwnerQueueSize=1).
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			u := fmt.Sprintf("https://www.douyin.com/video/780000000000000000%d", idx+1)
			req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(u), nil)
			req.RemoteAddr = "127.0.0.1:45000"
			req.Header.Set(edgeHeader, edgeKey)
			req.Header.Set(clientHeader, "203.0.113.50")
			req.Header.Set("Authorization", "Bearer "+ownerToken)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
		}(i)
	}
	<-blockEntered
	<-blockEntered
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, s := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "203.0.113.99", "")
		if s.Admission.Owner.Active == 2 && s.Admission.Owner.Queued == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Confirm ownerPool is 100% saturated + queue full (a 4th owner /api/parse gets 429).
	overflowReq := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/7800000000000000009"), nil)
	overflowReq.RemoteAddr = "127.0.0.1:45000"
	overflowReq.Header.Set(edgeHeader, edgeKey)
	overflowReq.Header.Set(clientHeader, "203.0.113.50")
	overflowReq.Header.Set("Authorization", "Bearer "+ownerToken)
	overflowRec := httptest.NewRecorder()
	router.ServeHTTP(overflowRec, overflowReq)
	if overflowRec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 4th owner /api/parse to get 429 while saturated, got %d", overflowRec.Code)
	}

	// GET /api/stats MUST respond immediately without waiting behind ownerPool!
	startStats := time.Now()
	st, liveSnap := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "203.0.113.50", "")
	statsElapsed := time.Since(startStats)
	if st != http.StatusOK || statsElapsed > 250*time.Millisecond {
		t.Fatalf("GET /api/stats blocked or failed under saturated ownerPool: status=%d elapsed=%v", st, statsElapsed)
	}
	if liveSnap.Admission.Owner.Active != 2 || liveSnap.Admission.Owner.Queued != 1 || liveSnap.Admission.Owner.Full != 1 {
		t.Fatalf("unexpected live saturated ownerPool gauges: %+v", liveSnap.Admission.Owner)
	}

	close(blockRelease)
	wg.Wait()
}

// 5) 5-minute periodic summary logger: strictly single-line output, accurate window deltas, and zero canary leakage.
func TestStatsPeriodicSummaryLoggerSingleLineAndZeroCanaryLeakage(t *testing.T) {
	ownerToken := randomPrintableToken(t, 48)
	wrongToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)
	canaryQuery := "canary_q_" + randomPrintableToken(t, 16)
	canaryHost := "canary-" + strings.ToLower(randomPrintableToken(t, 10)) + ".example.org"
	canaryErr := "upstream_secret_" + randomPrintableToken(t, 16) + "\nmultiline_err"
	const canaryIP = "203.0.113.177"

	c := makeStatsTestCatalog(t)
	h, err := NewWithCacheConfig(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			return makeStatsOKPayload("douyin", src, now), nil
		}),
		"pipixia": AdapterFunc(func(_ context.Context, _ string, _ int64) (unified.Object, error) {
			return nil, fmt.Errorf("%s", canaryErr)
		}),
	}, time.Now, nil, DefaultCacheConfig())
	if err != nil {
		t.Fatal(err)
	}
	auth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	router, err := WithAdmissionWithOwner(h, nil, "caddy", edgeKey, DefaultAdmissionConfig(), auth)
	if err != nil {
		t.Fatal(err)
	}

	fire := func(rawURL, bearer string) {
		req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&canary="+url.QueryEscape(canaryQuery)+"&url="+url.QueryEscape(rawURL), nil)
		req.RemoteAddr = "127.0.0.1:46000"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, canaryIP)
		req.Header.Set("X-Canary-Header", canaryQuery)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		_, _ = io.Copy(io.Discard, rec.Result().Body)
	}

	fire("https://www.douyin.com/video/7123456789012345678?"+canaryQuery+"=1", "")
	fire("https://www.douyin.com/video/7123456789012345678?"+canaryQuery+"=1", ownerToken)
	fire("https://h5.pipix.com/item/7385813877985909043?"+canaryQuery+"=2", "")
	fire("https://"+canaryHost+"/secret/path?"+canaryQuery+"=3", "")
	fire("https://www.douyin.com/video/7123456789012345678", wrongToken)

	var (
		mu    sync.Mutex
		lines []string
	)
	tickCh := make(chan int, 8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	stopLog := h.Stats().StartPeriodicLog(ctx, 15*time.Millisecond, func(format string, args ...any) {
		entry := fmt.Sprintf(format, args...)
		mu.Lock()
		lines = append(lines, entry)
		n := len(lines)
		mu.Unlock()
		select {
		case tickCh <- n:
		default:
		}
	})

	deadline := time.After(2 * time.Second)
	for {
		select {
		case n := <-tickCh:
			if n >= 2 {
				stopLog()
				goto doneTicks
			}
		case <-deadline:
			stopLog()
			t.Fatal("timed out waiting for >=2 periodic stats log ticks")
		}
	}
doneTicks:
	// Calling stopLog() a second time is idempotent and no further lines are emitted afterwards.
	stopLog()
	mu.Lock()
	countAfterStop := len(lines)
	captured := slices.Clone(lines)
	mu.Unlock()
	time.Sleep(35 * time.Millisecond)
	mu.Lock()
	if len(lines) != countAfterStop {
		mu.Unlock()
		t.Fatalf("periodic logger kept emitting after stop(): %d -> %d", countAfterStop, len(lines))
	}
	mu.Unlock()

	canaries := []string{
		canaryIP,
		canaryQuery,
		canaryHost,
		"7123456789012345678",
		"7385813877985909043",
		ownerToken[:12],
		wrongToken[:12],
		edgeKey[:12],
		"upstream_secret_",
		"multiline_err",
	}
	for idx, line := range captured {
		if strings.ContainsAny(line, "\r\n") {
			t.Fatalf("line %d is not single-line: %q", idx, line)
		}
		if !strings.HasPrefix(line, "dokitool: stats_summary ") {
			t.Fatalf("line %d missing expected prefix: %q", idx, line)
		}
		for _, cStr := range canaries {
			if strings.Contains(line, cStr) {
				t.Fatalf("line %d leaked canary %q: %q", idx, cStr, line)
			}
		}
	}
	if !strings.Contains(captured[0], "req_total=5 req_anon=4 req_owner=1 win_req_anon=4 win_req_owner=1") {
		t.Fatalf("tick 0 missing expected cumulative+window request totals: %q", captured[0])
	}
	if !strings.Contains(captured[1], "req_total=5 req_anon=4 req_owner=1 win_req_anon=0 win_req_owner=0") {
		t.Fatalf("tick 1 should report 0 window deltas when idle while retaining cumulative totals: %q", captured[1])
	}
	if !strings.Contains(captured[0], "douyin:OK:owner=1") || !strings.Contains(captured[0], "douyin:UNAUTHORIZED:anonymous=1") {
		t.Fatalf("tick 0 missing expected bounded outcome tokens: %q", captured[0])
	}
}

func TestStatsSnapshotAPIKeysNonNilWhenNilOrUnconfigured(t *testing.T) {
	nilSnap := (*Stats)(nil).Snapshot()
	if nilSnap.APIKeys == nil || len(nilSnap.APIKeys) != 0 {
		t.Fatalf("nil Stats.Snapshot().APIKeys must be non-nil empty slice, got %#v", nilSnap.APIKeys)
	}
	rawNil, err := json.Marshal(nilSnap)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rawNil), `"api_keys":[]`) {
		t.Fatalf("nil Stats.Snapshot() did not serialize api_keys as []: %s", string(rawNil))
	}

	emptyStats := NewStats(nil)
	emptySnap := emptyStats.Snapshot()
	if emptySnap.APIKeys == nil || len(emptySnap.APIKeys) != 0 {
		t.Fatalf("unattached Stats.Snapshot().APIKeys must be non-nil empty slice, got %#v", emptySnap.APIKeys)
	}
	rawEmpty, err := json.Marshal(emptySnap)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rawEmpty), `"api_keys":[]`) {
		t.Fatalf("unattached Stats.Snapshot() did not serialize api_keys as []: %s", string(rawEmpty))
	}
}
