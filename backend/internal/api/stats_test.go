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
	"sync/atomic"
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
	if len(nilSnap.Daily) != DailyStatsWindowDays || len(nilSnap.Hourly) != HourlyStatsWindowHours {
		t.Fatalf("nil Stats.Snapshot() daily=%d hourly=%d, want 30/24", len(nilSnap.Daily), len(nilSnap.Hourly))
	}
	if len(emptySnap.Daily) != DailyStatsWindowDays || len(emptySnap.Hourly) != HourlyStatsWindowHours {
		t.Fatalf("empty Stats.Snapshot() daily=%d hourly=%d, want 30/24", len(emptySnap.Daily), len(emptySnap.Hourly))
	}
	if nilSnap.Runtime.Version != "unknown" || nilSnap.Runtime.ShanghaiMode != "off" || nilSnap.Runtime.XHSTransport != "standard" {
		t.Fatalf("unexpected nil Stats default runtime config: %+v", nilSnap.Runtime)
	}
}

type mockShanghaiStatsProvider struct {
	mode string
	hits atomic.Uint64
}

func (m *mockShanghaiStatsProvider) ShanghaiStatsSnapshot() shresolver.StatsSnapshot {
	h := m.hits.Load()
	return shresolver.StatsSnapshot{
		Enabled: m.mode == "direct" || m.mode == "pull",
		Mode:    m.mode,
		Total: shresolver.ChannelStatsSnapshot{
			Hits: h,
		},
	}
}

func TestStatsShanghaiDailyHourlyRolloverAndMidnightBoundary(t *testing.T) {
	// Start at 2026-11-22 23:59:30+08:00 (= 2026-11-22 15:59:30Z).
	var clockMu sync.Mutex
	curTime := time.Date(2026, 11, 22, 15, 59, 30, 0, time.UTC)
	clock := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return curTime
	}
	setClock := func(next time.Time) {
		clockMu.Lock()
		curTime = next
		clockMu.Unlock()
	}

	st := NewStats(clock)
	st.RecordParse("douyin", "OK", ChannelAnonymous, 45*time.Millisecond)
	st.recordCacheHit(ChannelAnonymous)

	// Cross Asia/Shanghai midnight (+1 min -> 2026-11-23 00:00:30+08:00, still 2026-11-22 16:00:30Z in UTC!).
	setClock(time.Date(2026, 11, 22, 16, 0, 30, 0, time.UTC))
	st.RecordParse("bilibili", "OK", ChannelOwner, 120*time.Millisecond)
	st.RecordParse("bilibili", "UPSTREAM_TIMEOUT", ChannelAnonymous, 6500*time.Millisecond)

	snap1 := st.Snapshot()
	if len(snap1.Daily) != 30 {
		t.Fatalf("daily len = %d, want 30", len(snap1.Daily))
	}
	if len(snap1.Hourly) != 24 {
		t.Fatalf("hourly len = %d, want 24", len(snap1.Hourly))
	}
	for i := 1; i < len(snap1.Daily); i++ {
		if snap1.Daily[i-1].Date >= snap1.Daily[i].Date {
			t.Fatalf("daily buckets not strictly ascending at %d: %s >= %s", i, snap1.Daily[i-1].Date, snap1.Daily[i].Date)
		}
		if snap1.Daily[i].ByPlatform == nil {
			t.Fatalf("daily[%d].ByPlatform is nil", i)
		}
	}
	for i := 1; i < len(snap1.Hourly); i++ {
		if snap1.Hourly[i-1].HourStart >= snap1.Hourly[i].HourStart {
			t.Fatalf("hourly buckets not strictly ascending at %d: %s >= %s", i, snap1.Hourly[i-1].HourStart, snap1.Hourly[i].HourStart)
		}
	}
	if snap1.Daily[28].Date != "2026-11-22" || snap1.Daily[28].Total != 1 || snap1.Daily[28].OK != 1 || snap1.Daily[28].CacheHits != 1 {
		t.Fatalf("unexpected yesterday (2026-11-22) daily bucket: %+v", snap1.Daily[28])
	}
	if snap1.Daily[29].Date != "2026-11-23" || snap1.Daily[29].Total != 2 || snap1.Daily[29].OK != 1 || snap1.Daily[29].Failed != 1 {
		t.Fatalf("unexpected today (2026-11-23) daily bucket: %+v", snap1.Daily[29])
	}
	if snap1.Hourly[22].HourStart != "2026-11-22T23:00:00+08:00" || snap1.Hourly[22].Total != 1 || snap1.Hourly[22].CacheHits != 1 {
		t.Fatalf("unexpected 23:00+08:00 hourly bucket: %+v", snap1.Hourly[22])
	}
	if snap1.Hourly[23].HourStart != "2026-11-23T00:00:00+08:00" || snap1.Hourly[23].Total != 2 || snap1.Hourly[23].OK != 1 || snap1.Hourly[23].Failed != 1 {
		t.Fatalf("unexpected 00:00+08:00 hourly bucket: %+v", snap1.Hourly[23])
	}

	// Cross UTC midnight (2026-11-22 23:59:30Z = 2026-11-23 07:59:30+08:00 -> 2026-11-23 00:00:30Z = 2026-11-23 08:00:30+08:00).
	// Both MUST stay inside Shanghai day 2026-11-23 while advancing the hourly bucket from 07:00 to 08:00!
	setClock(time.Date(2026, 11, 22, 23, 59, 30, 0, time.UTC))
	st.RecordParse("x", "OK", ChannelOwner, 80*time.Millisecond)
	setClock(time.Date(2026, 11, 23, 0, 0, 30, 0, time.UTC))
	st.RecordParse("x", "OK", ChannelOwner, 90*time.Millisecond)
	st.recordCacheHit(ChannelOwner)

	snap2 := st.Snapshot()
	if snap2.Daily[29].Date != "2026-11-23" || snap2.Daily[29].Total != 4 || snap2.Daily[29].OK != 3 || snap2.Daily[29].Failed != 1 || snap2.Daily[29].CacheHits != 1 {
		t.Fatalf("crossing UTC midnight must remain in Shanghai day 2026-11-23: %+v", snap2.Daily[29])
	}
	if snap2.Hourly[22].HourStart != "2026-11-23T07:00:00+08:00" || snap2.Hourly[22].Total != 1 {
		t.Fatalf("unexpected 07:00+08:00 hourly bucket: %+v", snap2.Hourly[22])
	}
	if snap2.Hourly[23].HourStart != "2026-11-23T08:00:00+08:00" || snap2.Hourly[23].Total != 1 || snap2.Hourly[23].CacheHits != 1 {
		t.Fatalf("unexpected 08:00+08:00 hourly bucket: %+v", snap2.Hourly[23])
	}

	// Roll forward 32 days: old buckets from 2026-11-22 and 2026-11-23 must be completely evicted
	// and reused ring slots must start cleanly at zero!
	setClock(time.Date(2026, 12, 25, 2, 0, 0, 0, time.UTC)) // 2026-12-25 10:00+08:00
	st.RecordParse("weibo", "OK", ChannelAnonymous, 30*time.Millisecond)
	snap3 := st.Snapshot()
	if snap3.Daily[0].Date != "2026-11-26" || snap3.Daily[29].Date != "2026-12-25" {
		t.Fatalf("unexpected 30d window bounds after rollover: [%s .. %s]", snap3.Daily[0].Date, snap3.Daily[29].Date)
	}
	var sumDaily uint64
	for _, b := range snap3.Daily {
		sumDaily += b.Total
	}
	if sumDaily != 1 || snap3.Daily[29].Total != 1 {
		t.Fatalf("stale daily counts leaked across 30d ring rollover: sum=%d today=%+v", sumDaily, snap3.Daily[29])
	}
	var sumHourly uint64
	for _, h := range snap3.Hourly {
		sumHourly += h.Total
	}
	if sumHourly != 1 || snap3.Hourly[23].HourStart != "2026-12-25T10:00:00+08:00" || snap3.Hourly[23].Total != 1 {
		t.Fatalf("stale hourly counts leaked across 24h ring rollover: sum=%d cur=%+v", sumHourly, snap3.Hourly[23])
	}
}

func TestStatsDailyLatencyPercentilesAndPerPlatformBreakdown(t *testing.T) {
	now := time.Date(2026, 11, 22, 4, 0, 0, 0, time.UTC) // 2026-11-22 12:00+08:00
	st := NewStats(func() time.Time { return now })

	// Empty day must report all zeros.
	empty := st.Snapshot().Daily[29]
	if empty.LatencyMS.P50MS != 0 || empty.LatencyMS.P95MS != 0 || empty.LatencyMS.MaxMS != 0 {
		t.Fatalf("empty day latency must be 0/0/0, got %+v", empty.LatencyMS)
	}

	// Single tiny sample (5ms): upper bound of <=10ms bin MUST clamp to max_ms (5ms)!
	st.RecordParse("weibo", "OK", ChannelAnonymous, 5*time.Millisecond)
	single := st.Snapshot().Daily[29]
	if single.LatencyMS.P50MS != 5 || single.LatencyMS.P95MS != 5 || single.LatencyMS.MaxMS != 5 {
		t.Fatalf("single 5ms sample must clamp to 5/5/5, got %+v", single.LatencyMS)
	}
	if ps := single.ByPlatform["weibo"]; ps.P95MS != 5 || ps.Total != 1 || ps.OK != 1 || ps.Failed != 0 || ps.ByCode["OK"] != 1 || len(ps.ByCode) != 1 {
		t.Fatalf("unexpected weibo single-sample platform stats: %+v", ps)
	}

	// Multi-sample distribution on douyin including +Inf (>30s) tail and multiple error codes.
	st2 := NewStats(func() time.Time { return now })
	for i := 0; i < 90; i++ {
		st2.RecordParse("douyin", "OK", ChannelAnonymous, 40*time.Millisecond) // <=50ms bin
	}
	for i := 0; i < 4; i++ {
		st2.RecordParse("douyin", "UPSTREAM_BLOCKED", ChannelAnonymous, 400*time.Millisecond) // <=500ms bin
	}
	for i := 0; i < 6; i++ {
		st2.RecordParse("douyin", "UPSTREAM_TIMEOUT", ChannelOwner, 42000*time.Millisecond) // +Inf bin (6% tail -> P95 lands in +Inf!)
	}
	st2.RecordParse("bilibili", "NO_MEDIA", ChannelAnonymous, 180*time.Millisecond) // <=250ms clamped to 180ms

	day := st2.Snapshot().Daily[29]
	if day.Total != 101 || day.OK != 90 || day.Failed != 11 {
		t.Fatalf("unexpected day totals: %+v", day)
	}
	if !(day.LatencyMS.P50MS <= day.LatencyMS.P95MS && day.LatencyMS.P95MS <= day.LatencyMS.MaxMS) {
		t.Fatalf("broken latency invariant 0 <= p50 <= p95 <= max: %+v", day.LatencyMS)
	}
	if day.LatencyMS.P50MS != 50 || day.LatencyMS.P95MS != 42000 || day.LatencyMS.MaxMS != 42000 {
		t.Fatalf("unexpected day latency summary: %+v", day.LatencyMS)
	}

	dy := day.ByPlatform["douyin"]
	if dy.Total != 100 || dy.OK != 90 || dy.Failed != 10 || dy.P95MS != 42000 {
		t.Fatalf("unexpected douyin daily stats: %+v", dy)
	}
	if len(dy.ByCode) != 3 || dy.ByCode["OK"] != 90 || dy.ByCode["UPSTREAM_BLOCKED"] != 4 || dy.ByCode["UPSTREAM_TIMEOUT"] != 6 {
		t.Fatalf("unexpected douyin by_code: %+v", dy.ByCode)
	}

	bili := day.ByPlatform["bilibili"]
	if bili.Total != 1 || bili.OK != 0 || bili.Failed != 1 || bili.P95MS != 180 || len(bili.ByCode) != 1 || bili.ByCode["NO_MEDIA"] != 1 {
		t.Fatalf("unexpected bilibili daily stats: %+v", bili)
	}
}

func TestStatsShanghaiHitsDeltaSyncAndModeInference(t *testing.T) {
	cur := time.Date(2026, 11, 22, 4, 0, 0, 0, time.UTC) // 2026-11-22 12:00+08:00
	st := NewStats(func() time.Time { return cur })

	mock1 := &mockShanghaiStatsProvider{mode: "pull"}
	st.SetShanghaiSource(mock1)

	// Runtime ShanghaiMode should infer "pull" when unset/"off" while shSrc != nil.
	if got := st.Snapshot().Runtime.ShanghaiMode; got != "pull" {
		t.Fatalf("expected inferred runtime.shanghai_mode=pull, got %q", got)
	}

	mock1.hits.Add(3)
	st.RecordParse("douyin", "OK", ChannelAnonymous, 50*time.Millisecond)
	snap1 := st.Snapshot()
	if snap1.Daily[29].ShanghaiHits != 3 {
		t.Fatalf("day 1 shanghai_hits = %d, want 3", snap1.Daily[29].ShanghaiHits)
	}
	// Repeated Snapshot() without new hits MUST NOT duplicate-count.
	snap1Repeat := st.Snapshot()
	if snap1Repeat.Daily[29].ShanghaiHits != 3 {
		t.Fatalf("repeated Snapshot duplicated shanghai_hits: got %d, want 3", snap1Repeat.Daily[29].ShanghaiHits)
	}

	// Additional 2 hits on day 1 synced via Snapshot().
	mock1.hits.Add(2)
	if got := st.Snapshot().Daily[29].ShanghaiHits; got != 5 {
		t.Fatalf("day 1 shanghai_hits after +2 = %d, want 5", got)
	}

	// Advance to day 2 (+24h), add 4 more hits, flush via SaveSnapshot -> only delta +4 lands in day 2!
	cur = cur.Add(24 * time.Hour)
	mock1.hits.Add(4)
	snapPath := filepath.Join(t.TempDir(), "stats.json")
	if err := st.SaveSnapshot(snapPath); err != nil {
		t.Fatalf("SaveSnapshot failed: %v", err)
	}
	snap2 := st.Snapshot()
	if snap2.Daily[28].ShanghaiHits != 5 || snap2.Daily[29].ShanghaiHits != 4 {
		t.Fatalf("unexpected shanghai_hits across day rollover: day1=%d day2=%d, want 5/4", snap2.Daily[28].ShanghaiHits, snap2.Daily[29].ShanghaiHits)
	}

	// Replacing Shanghai source resets lastSyncedShanghaiHits = 0 so direct mode hits start syncing fresh.
	mock2 := &mockShanghaiStatsProvider{mode: "direct"}
	st.SetShanghaiSource(mock2)
	mock2.hits.Add(2)
	snap3 := st.Snapshot()
	if snap3.Runtime.ShanghaiMode != "direct" {
		t.Fatalf("expected inferred runtime.shanghai_mode=direct after swap, got %q", snap3.Runtime.ShanghaiMode)
	}
	if snap3.Daily[29].ShanghaiHits != 6 {
		t.Fatalf("day 2 shanghai_hits after source swap +2 = %d, want 6", snap3.Daily[29].ShanghaiHits)
	}
}

func TestStatsBoundedDynamicPlatformsAndClosedVocabularyPreserved(t *testing.T) {
	// Verify KnownPlatforms & NormalizePlatform remain strictly unchanged (15 closed elements).
	if len(KnownPlatforms()) != 15 {
		t.Fatalf("KnownPlatforms() len = %d, want 15", len(KnownPlatforms()))
	}
	if NormalizePlatform("vimeo") != PlatformUnknown || NormalizePlatform(PlatformYTDLPOther) != PlatformUnknown {
		t.Fatal("NormalizePlatform must remain strictly closed-set (14 core + unknown)")
	}

	// Validate IsValidDynamicPlatformKey edge cases.
	for _, valid := range []string{"a", "0", "vimeo", "yt:vimeo-hd_1", "tiktok", PlatformYTDLPOther, strings.Repeat("a", 32)} {
		if !IsValidDynamicPlatformKey(valid) {
			t.Fatalf("IsValidDynamicPlatformKey(%q) = false, want true", valid)
		}
	}
	for _, invalid := range []string{"", "all", "unknown", "_lead", "-lead", ":lead", "Upper", "bad/slash", "bad.dot", "has space", "抖音", strings.Repeat("a", 33)} {
		if IsValidDynamicPlatformKey(invalid) {
			t.Fatalf("IsValidDynamicPlatformKey(%q) = true, want false", invalid)
		}
	}

	now := time.Date(2026, 11, 22, 6, 0, 0, 0, time.UTC)
	st := NewStats(func() time.Time { return now })

	// Record 1 core platform via RecordDynamicParse.
	st.RecordDynamicParse("douyin", "OK", ChannelOwner, 25*time.Millisecond)
	// Record invalid keys -> must all route to "unknown".
	for _, bad := range []string{"", "all", "unknown", "UPPER_BAD", "evil/path", strings.Repeat("z", 40)} {
		st.RecordDynamicParse(bad, "UNSUPPORTED_PLATFORM", ChannelAnonymous, 10*time.Millisecond)
	}
	// Record 64 distinct valid dynamic platforms in reverse order to verify deterministic sorting!
	for i := MaxDynamicPlatforms; i >= 1; i-- {
		key := fmt.Sprintf("dyn_%02d", i)
		st.RecordDynamicParse(key, "OK", ChannelAnonymous, 35*time.Millisecond)
	}
	// Record 10 additional distinct keys beyond 64 -> must ALL spill into ytdlp_other!
	for i := MaxDynamicPlatforms + 1; i <= MaxDynamicPlatforms+10; i++ {
		key := fmt.Sprintf("dyn_%02d", i)
		st.RecordDynamicParse(key, "UPSTREAM_TIMEOUT", ChannelOwner, 100*time.Millisecond)
	}
	// Direct ytdlp_other key also merges into ytdlp_other without displacing the 64 keys.
	st.RecordDynamicParse(PlatformYTDLPOther, "OK", ChannelAnonymous, 20*time.Millisecond)

	snap := st.Snapshot()
	wantTotal := uint64(1 + 6 + MaxDynamicPlatforms + 10 + 1)
	if snap.Requests.Total != wantTotal || snap.ParseLatencyMS.Total.Count != wantTotal {
		t.Fatalf("total=%d latencyCount=%d, want %d", snap.Requests.Total, snap.ParseLatencyMS.Total.Count, wantTotal)
	}
	if snap.Requests.ByChannel.Anonymous+snap.Requests.ByChannel.Owner != wantTotal {
		t.Fatalf("by_channel sum mismatch: %+v", snap.Requests.ByChannel)
	}

	// Verify ordering in by_platform_code_channel: core platforms first ("douyin", "unknown"),
	// then sorted dyn_01..dyn_64, then ytdlp_other.
	cells := snap.Requests.ByPlatformCodeChannel
	if len(cells) != 2+MaxDynamicPlatforms+2 {
		t.Fatalf("unexpected cells len=%d, want %d", len(cells), 2+MaxDynamicPlatforms+2)
	}
	if cells[0].Platform != "douyin" || cells[1].Platform != PlatformUnknown || cells[1].Count != 6 {
		t.Fatalf("unexpected core prefix cells: %+v %+v", cells[0], cells[1])
	}
	for i := 1; i <= MaxDynamicPlatforms; i++ {
		wantPlat := fmt.Sprintf("dyn_%02d", i)
		if cells[1+i].Platform != wantPlat || cells[1+i].Count != 1 {
			t.Fatalf("dynamic cell[%d] = %+v, want platform %q count 1", 1+i, cells[1+i], wantPlat)
		}
	}
	if lookupCellCount(cells, PlatformYTDLPOther, "UPSTREAM_TIMEOUT", ChannelOwner) != 10 {
		t.Fatalf("expected 10 spilled timeouts under ytdlp_other, cells tail=%+v", cells[len(cells)-2:])
	}
	if lookupCellCount(cells, PlatformYTDLPOther, "OK", ChannelAnonymous) != 1 {
		t.Fatalf("expected 1 explicit OK under ytdlp_other, cells tail=%+v", cells[len(cells)-2:])
	}

	// Verify daily[29].ByPlatform matches exact bounded set (no dyn_65..dyn_74, no invalid keys).
	dayPlats := snap.Daily[29].ByPlatform
	if len(dayPlats) != 2+MaxDynamicPlatforms+1 {
		t.Fatalf("daily by_platform count = %d, want %d", len(dayPlats), 2+MaxDynamicPlatforms+1)
	}
	if _, leaked := dayPlats["dyn_65"]; leaked {
		t.Fatal("65th dynamic platform leaked into daily.by_platform instead of spilling to ytdlp_other")
	}
	if other := dayPlats[PlatformYTDLPOther]; other.Total != 11 || other.OK != 1 || other.Failed != 10 {
		t.Fatalf("unexpected daily ytdlp_other stats: %+v", other)
	}

	// SummaryReporter.FormatLine() must still only emit closed-vocabulary platform tokens.
	line := st.FormatSummaryLine()
	if strings.Contains(line, "dyn_01") || strings.Contains(line, "UPPER_BAD") || strings.Contains(line, "evil/path") {
		t.Fatalf("SummaryReporter.FormatLine() leaked non-closed platform key: %q", line)
	}
}

func TestStatsRuntimeConfigNormalizationAndNoSecretLeak(t *testing.T) {
	st := NewStats(func() time.Time { return time.Date(2026, 11, 22, 4, 0, 0, 0, time.UTC) })
	st.SetRuntimeConfig(RuntimeConfigSnapshot{
		Version:                 "  v2.3.4\r\n",
		ShanghaiMode:            "bogus-mode",
		ShanghaiBilibili:        true,
		BilibiliDASH:            true,
		YouTubeHelper:           true,
		XHSTransport:            "evil-transport",
		YTDLPEnabled:            true,
		YTDLPGenericEnabled:     false,
		TBVideoPipigx:           true,
		TBVideoZuiyou:           false,
		StatsPersistenceEnabled: true,
	})
	snap := st.Snapshot()
	if snap.Runtime.Version != "v2.3.4" ||
		snap.Runtime.ShanghaiMode != "off" ||
		!snap.Runtime.ShanghaiBilibili ||
		!snap.Runtime.BilibiliDASH ||
		!snap.Runtime.YouTubeHelper ||
		snap.Runtime.XHSTransport != "standard" ||
		!snap.Runtime.YTDLPEnabled ||
		snap.Runtime.YTDLPGenericEnabled ||
		!snap.Runtime.TBVideoPipigx ||
		snap.Runtime.TBVideoZuiyou ||
		!snap.Runtime.StatsPersistenceEnabled {
		t.Fatalf("unexpected normalized runtime config: %+v", snap.Runtime)
	}

	raw, err := json.Marshal(snap.Runtime)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if len(m) != 11 {
		t.Fatalf("expected exactly 11 fields in runtime JSON, got %d: %s", len(m), string(raw))
	}
	for _, forbidden := range []string{"url", "endpoint", "token", "secret", "path", "file"} {
		for k := range m {
			if strings.Contains(strings.ToLower(k), forbidden) {
				t.Fatalf("runtime JSON field %q looks like secret/path/endpoint", k)
			}
		}
	}
}

func TestStatsPersistenceAtomicSaveLoadPruningAndFailSoft(t *testing.T) {
	dir := t.TempDir()
	snapPath := filepath.Join(dir, "stats-snapshot.json")

	// Cold start on missing file and empty path -> nil error, zero warning logs.
	var coldLogs []string
	coldLogf := func(format string, args ...any) {
		coldLogs = append(coldLogs, fmt.Sprintf(format, args...))
	}
	cur := time.Date(2026, 11, 10, 4, 0, 0, 0, time.UTC) // 2026-11-10 12:00+08:00
	st1 := NewStats(func() time.Time { return cur })
	if err := st1.LoadSnapshot("", coldLogf); err != nil {
		t.Fatalf("empty path LoadSnapshot failed: %v", err)
	}
	if err := st1.LoadSnapshot(snapPath, coldLogf); err != nil {
		t.Fatalf("missing file cold-start LoadSnapshot failed: %v", err)
	}
	if len(coldLogs) != 0 {
		t.Fatalf("cold start should not emit warnings, got %v", coldLogs)
	}

	mockSH := &mockShanghaiStatsProvider{mode: "pull"}
	st1.SetShanghaiSource(mockSH)

	// Day 1 (2026-11-10): will be expired after advancing +31 days!
	st1.RecordParse("douyin", "OK", ChannelAnonymous, 40*time.Millisecond)
	st1.recordCacheHit(ChannelAnonymous)
	mockSH.hits.Add(2)
	st1.RecordDynamicParse("vimeo", "UPSTREAM_TIMEOUT", ChannelOwner, 1200*time.Millisecond)

	// Day 2 (2026-11-22 12:00+08:00): recent day + recent hours!
	cur = time.Date(2026, 11, 22, 4, 0, 0, 0, time.UTC)
	st1.RecordParse("bilibili", "OK", ChannelOwner, 85*time.Millisecond)
	st1.RecordParse("bilibili", "UPSTREAM_BLOCKED", ChannelAnonymous, 320*time.Millisecond)
	st1.recordCacheHit(ChannelOwner)
	mockSH.hits.Add(3)
	st1.RecordDynamicParse("tiktok", "OK", ChannelAnonymous, 210*time.Millisecond)

	cur = cur.Add(2 * time.Hour) // 14:00+08:00
	st1.RecordParse("x", "OK", ChannelOwner, 500*time.Millisecond)

	if err := st1.SaveSnapshot(snapPath); err != nil {
		t.Fatalf("SaveSnapshot failed: %v", err)
	}

	// Verify 0600 permissions (on Unix) and zero leftover .tmp files in directory.
	info, err := os.Stat(snapPath)
	if err != nil {
		t.Fatalf("stat snapshot failed: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("snapshot file mode = %o, want 0600", info.Mode().Perm())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "stats-snapshot.json" {
		t.Fatalf("unexpected directory entries (leftover tmp files?): %v", entries)
	}

	// Reload into fresh Stats at the exact same timestamp -> 30d daily & 24h hourly match identically!
	wantSnap := st1.Snapshot()
	st2 := NewStats(func() time.Time { return cur })
	if err := st2.LoadSnapshot(snapPath, nil); err != nil {
		t.Fatalf("LoadSnapshot into fresh Stats failed: %v", err)
	}
	gotSnap := st2.Snapshot()
	wantDailyJSON, _ := json.Marshal(wantSnap.Daily)
	gotDailyJSON, _ := json.Marshal(gotSnap.Daily)
	if string(wantDailyJSON) != string(gotDailyJSON) {
		t.Fatalf("reloaded daily mismatch:\nwant=%s\ngot =%s", string(wantDailyJSON), string(gotDailyJSON))
	}
	wantHourlyJSON, _ := json.Marshal(wantSnap.Hourly)
	gotHourlyJSON, _ := json.Marshal(gotSnap.Hourly)
	if string(wantHourlyJSON) != string(gotHourlyJSON) {
		t.Fatalf("reloaded hourly mismatch:\nwant=%s\ngot =%s", string(wantHourlyJSON), string(gotHourlyJSON))
	}

	// Reload at +20 days later (2026-12-12 14:00+08:00):
	// 2026-11-10 is > 30 days old (pruned!), 2026-11-22 is 20 days old (kept!), hourly buckets are > 24h old (pruned!).
	later := cur.Add(20 * 24 * time.Hour)
	st3 := NewStats(func() time.Time { return later })
	if err := st3.LoadSnapshot(snapPath, nil); err != nil {
		t.Fatalf("LoadSnapshot at +20d failed: %v", err)
	}
	snap3 := st3.Snapshot()
	var totalDaily3, totalHourly3 uint64
	var foundNov22 bool
	for _, b := range snap3.Daily {
		totalDaily3 += b.Total
		if b.Date == "2026-11-22" {
			foundNov22 = true
			if b.Total != 4 || b.OK != 3 || b.Failed != 1 || b.CacheHits != 1 || b.ShanghaiHits != 3 {
				t.Fatalf("unexpected preserved 2026-11-22 bucket after pruning: %+v", b)
			}
		}
	}
	for _, h := range snap3.Hourly {
		totalHourly3 += h.Total
	}
	if !foundNov22 || totalDaily3 != 4 || totalHourly3 != 0 {
		t.Fatalf("unexpected pruned reload counts: foundNov22=%v totalDaily=%d totalHourly=%d", foundNov22, totalDaily3, totalHourly3)
	}

	// Hand-crafted snapshot with >64 dynamic platforms, invalid platform key, and unknown outcome code -> clamped & normalized!
	var oversizedDyn []string
	platMap := make(map[string]persistedDailyPlatform)
	for i := 1; i <= 70; i++ {
		k := fmt.Sprintf("ext_%02d", i)
		oversizedDyn = append(oversizedDyn, k)
		platMap[k] = persistedDailyPlatform{
			Total: 1, OK: 1,
			ByCode: map[string]uint64{"OK": 1},
		}
	}
	platMap["BAD/KEY"] = persistedDailyPlatform{
		Total: 2, Failed: 2,
		ByCode: map[string]uint64{"BOGUS_ERR": 2},
	}
	crafted := persistedStatsSnapshot{
		SchemaVersion:    1,
		Timezone:         "Asia/Shanghai",
		SavedAt:          cur.In(shanghaiZone).Format(time.RFC3339),
		DynamicPlatforms: oversizedDyn,
		Daily: []persistedDailyBucket{{
			Date:       "2026-11-22",
			Total:      72,
			OK:         70,
			Failed:     2,
			ByPlatform: platMap,
		}},
	}
	craftedBytes, _ := json.Marshal(crafted)
	craftedPath := filepath.Join(dir, "crafted.json")
	if err := os.WriteFile(craftedPath, craftedBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	stCrafted := NewStats(func() time.Time { return cur })
	if err := stCrafted.LoadSnapshot(craftedPath, nil); err != nil {
		t.Fatalf("crafted snapshot load failed: %v", err)
	}
	craftedDay := stCrafted.Snapshot().Daily[29]
	if craftedDay.ByPlatform[PlatformYTDLPOther].Total != 6 {
		t.Fatalf("expected 6 overflow dynamic keys (65..70) spilled to ytdlp_other, got %+v", craftedDay.ByPlatform[PlatformYTDLPOther])
	}
	if unk := craftedDay.ByPlatform[PlatformUnknown]; unk.Total != 2 || unk.ByCode["INTERNAL_ERROR"] != 2 {
		t.Fatalf("expected invalid key + unknown code normalized to unknown/INTERNAL_ERROR, got %+v", unk)
	}

	// Fail-soft corrupt / bad-version / bad-date / bad-hour / oversized / directory cases!
	badCases := []struct {
		name string
		data []byte
		path string
	}{
		{"corrupt-json", []byte("{not-json"), filepath.Join(dir, "bad1.json")},
		{"wrong-schema-version", []byte(`{"schema_version":2,"timezone":"Asia/Shanghai"}`), filepath.Join(dir, "bad2.json")},
		{"missing-schema-version", []byte(`{"timezone":"Asia/Shanghai"}`), filepath.Join(dir, "bad3.json")},
		{"wrong-timezone", []byte(`{"schema_version":1,"timezone":"UTC"}`), filepath.Join(dir, "bad4.json")},
		{"invalid-daily-date", []byte(`{"schema_version":1,"timezone":"Asia/Shanghai","daily":[{"date":"2026-13-45","total":1}]}`), filepath.Join(dir, "bad5.json")},
		{"non-hour-aligned-hourly", []byte(`{"schema_version":1,"timezone":"Asia/Shanghai","hourly":[{"hour_start":"2026-11-22T14:30:00+08:00","total":1}]}`), filepath.Join(dir, "bad6.json")},
		{"oversized-file", bytes.Repeat([]byte("{"), MaxStatsSnapshotBytes+16), filepath.Join(dir, "bad7.json")},
		{"directory-instead-of-file", nil, dir},
	}
	for _, tc := range badCases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.data != nil {
				if err := os.WriteFile(tc.path, tc.data, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			var warnBuf bytes.Buffer
			stBad := NewStats(func() time.Time { return cur })
			err := stBad.LoadSnapshot(tc.path, func(format string, args ...any) {
				fmt.Fprintf(&warnBuf, format, args...)
			})
			if err == nil {
				t.Fatalf("%s: expected LoadSnapshot error, got nil", tc.name)
			}
			if warnBuf.Len() == 0 {
				t.Fatalf("%s: expected warning log on fail-soft error", tc.name)
			}
			if strings.Contains(warnBuf.String(), dir) || strings.Contains(err.Error(), dir) {
				t.Fatalf("%s: leaked local filesystem path in warning/error: warn=%q err=%v", tc.name, warnBuf.String(), err)
			}
			// State must remain cleanly empty.
			if got := stBad.Snapshot().Daily[29].Total; got != 0 {
				t.Fatalf("%s: expected clean empty stats after failed load, got today total=%d", tc.name, got)
			}
		})
	}

	// StartPeriodicSnapshot writes periodically and exits cleanly on stop().
	periodicPath := filepath.Join(dir, "periodic.json")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stopPeriodic := st1.StartPeriodicSnapshot(ctx, periodicPath, 15*time.Millisecond, nil)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(periodicPath); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	stopPeriodic()
	stopPeriodic() // idempotent
	if _, err := os.Stat(periodicPath); err != nil {
		t.Fatalf("periodic snapshot file was not created: %v", err)
	}
}

func TestStatsConcurrentRecordSnapshotSaveRace(t *testing.T) {
	dir := t.TempDir()
	snapPath := filepath.Join(dir, "race-snapshot.json")

	st := NewStats(time.Now)
	mockSH := &mockShanghaiStatsProvider{mode: "pull"}
	st.SetShanghaiSource(mockSH)
	st.SetRuntimeConfig(RuntimeConfigSnapshot{
		Version:                 "race-test",
		ShanghaiMode:            "pull",
		StatsPersistenceEnabled: true,
	})

	const workers = 8
	const iters = 60
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := 0; i < iters; i++ {
				switch (id + i) % 5 {
				case 0:
					st.RecordParse("douyin", "OK", ChannelAnonymous, time.Duration(i+1)*time.Millisecond)
				case 1:
					st.RecordDynamicParse(fmt.Sprintf("dyn_%02d", (id*13+i)%80), "OK", ChannelOwner, time.Duration(i+5)*time.Millisecond)
				case 2:
					st.recordCacheHit(ChannelAnonymous)
					mockSH.hits.Add(1)
				case 3:
					snap := st.Snapshot()
					if len(snap.Daily) != DailyStatsWindowDays || len(snap.Hourly) != HourlyStatsWindowHours {
						t.Errorf("invalid daily/hourly length under concurrency: %d/%d", len(snap.Daily), len(snap.Hourly))
					}
				case 4:
					if err := st.SaveSnapshot(snapPath); err != nil {
						t.Errorf("concurrent SaveSnapshot failed: %v", err)
					}
				}
			}
		}(w)
	}
	wg.Wait()

	// Final save and invariant check.
	if err := st.SaveSnapshot(snapPath); err != nil {
		t.Fatalf("final SaveSnapshot failed: %v", err)
	}
	finalSnap := st.Snapshot()
	var sumCells uint64
	for _, cell := range finalSnap.Requests.ByPlatformCodeChannel {
		sumCells += cell.Count
	}
	if sumCells != finalSnap.Requests.Total || finalSnap.ParseLatencyMS.Total.Count != finalSnap.Requests.Total {
		t.Fatalf("post-race invariant mismatch: sumCells=%d total=%d latencyCount=%d", sumCells, finalSnap.Requests.Total, finalSnap.ParseLatencyMS.Total.Count)
	}
	// Verify zero leftover .tmp files in directory.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("found leftover temp file after concurrent saves: %s", e.Name())
		}
	}
}

type stubYTDLPStatsSource struct {
	snap ytengine.SlotStatsSnapshot
}

func (s stubYTDLPStatsSource) StatsSnapshot() ytengine.SlotStatsSnapshot {
	return s.snap
}

func TestStatsGenericYTDLPAndGenericSlowAdmission(t *testing.T) {
	// 1. Nil and freshly initialized Stats emit zero-valued admission.generic_slow and ytdlp_generic.
	var nilStats *Stats
	nilStats.SetGenericYTDLPEngine(stubYTDLPStatsSource{snap: ytengine.SlotStatsSnapshot{Enabled: true}})
	nilSnap := nilStats.Snapshot()
	if nilSnap.YTDLPGeneric.Enabled || nilSnap.YTDLPGeneric.ConcurrencyLimit != 0 || nilSnap.Admission.GenericSlow.ConcurrencyLimit != 0 {
		t.Fatalf("nil Stats snapshot unexpected generic fields: ytdlp_generic=%+v generic_slow=%+v", nilSnap.YTDLPGeneric, nilSnap.Admission.GenericSlow)
	}
	rawNil, err := json.Marshal(nilSnap)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rawNil), `"generic_slow":{`) || !strings.Contains(string(rawNil), `"ytdlp_generic":{`) {
		t.Fatalf("nil Stats JSON missing generic_slow or ytdlp_generic keys: %s", string(rawNil))
	}

	// 2. Typed-nil *ytengine.Engine passed to SetGenericYTDLPEngine stays safe zero-value.
	st := NewStats(nil)
	var typedNilEng *ytengine.Engine
	st.SetGenericYTDLPEngine(typedNilEng)
	if got := st.Snapshot().YTDLPGeneric; got.Enabled || got.Active != 0 || got.ConcurrencyLimit != 0 {
		t.Fatalf("typed-nil SetGenericYTDLPEngine produced non-zero snapshot: %+v", got)
	}

	// 3. Custom YTDLPStatsSource wired via SetGenericYTDLPEngine appears in ytdlp_generic without affecting ytdlp.
	wantMock := ytengine.SlotStatsSnapshot{
		Enabled:          true,
		Active:           2,
		Waiting:          1,
		ConcurrencyLimit: 4,
		Total: ytengine.ChannelSlotStatsSnapshot{
			AcquiredCount: 9,
			WaitCount:     3,
			CanceledCount: 1,
			WaitMSTotal:   450,
			WaitMSMax:     220,
		},
	}
	st.SetGenericYTDLPEngine(stubYTDLPStatsSource{snap: wantMock})
	mockSnap := st.Snapshot()
	if mockSnap.YTDLPGeneric != wantMock {
		t.Fatalf("YTDLPGeneric = %+v, want %+v", mockSnap.YTDLPGeneric, wantMock)
	}
	if mockSnap.YTDLP.Enabled || mockSnap.YTDLP.ConcurrencyLimit != 0 {
		t.Fatalf("YTDLP should remain zero when only generic source is set: %+v", mockSnap.YTDLP)
	}

	// 4. End-to-end HTTP /api/stats reports both admission.generic_slow and ytdlp_generic from live engines.
	if runtime.GOOS == "windows" {
		return
	}
	ownerToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)
	gateDir := t.TempDir()
	binPath := filepath.Join(gateDir, "yt-dlp-fake")
	script := "#!/bin/sh\nset -eu\n" + `
touch "` + gateDir + `/started"
while [ ! -f "` + gateDir + `/release" ]; do
  sleep 0.01
done
echo '{"id":"12345","extractor_key":"Vimeo","extractor":"vimeo","title":"Demo","formats":[{"format_id":"1","url":"https://cdn.vimeo.test/v.mp4","ext":"mp4","protocol":"https","vcodec":"avc1","acodec":"mp4a","width":1280,"height":720,"filesize":1024}]}'
`
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(script))
	baseEng, err := ytengine.New(ytengine.Config{
		BinaryPath:     binPath,
		AllowedHashes:  map[string]string{hex.EncodeToString(sum[:]): "yt-dlp-generic-stats-test"},
		Resolver:       staticPublicResolver{},
		MaxConcurrency: 2,
		Timeout:        10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	genericEng := baseEng.
		WithGenericConcurrency(3).
		WithTargetPolicy(ytgeneric.AllowedGenericInputURL, ytgeneric.AllowedGenericOutboundHost).
		WithExtractors(ytgeneric.GenericExtractorArgs()...)

	c := makeStatsTestCatalog(t)
	h, err := NewWithCacheConfig(c, nil, time.Now, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}
	h.SetGenericAdapter(ytgeneric.NewGenericNamed(genericEng, nil, staticPublicResolver{}))
	h.Stats().SetYTDLPEngine(baseEng)
	h.Stats().SetGenericYTDLPEngine(genericEng)

	cfg := DefaultAdmissionConfig()
	cfg.GenericSlowParse.GlobalConcurrency = 3
	cfg.GenericSlowParse.QueueSize = 12
	auth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	router, err := WithAdmissionWithOwner(h, nil, "caddy", edgeKey, cfg, auth)
	if err != nil {
		t.Fatal(err)
	}

	// Start one in-flight anonymous generic parse to observe active=1 in both admission.generic_slow and ytdlp_generic!
	doneCh := make(chan int, 1)
	go func() {
		req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://vimeo.com/12345"), nil)
		req.RemoteAddr = "127.0.0.1:44100"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, "198.51.100.80")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		doneCh <- rec.Code
	}()

	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, statErr := os.Stat(filepath.Join(gateDir, "started")); statErr == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for generic yt-dlp subprocess to start")
		}
		time.Sleep(10 * time.Millisecond)
	}

	status, liveSnap := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "schema_version=1.0")
	if status != http.StatusOK {
		t.Fatalf("GET /api/stats status=%d", status)
	}
	if liveSnap.Admission.GenericSlow.Active != 1 || liveSnap.Admission.GenericSlow.ConcurrencyLimit != 3 || liveSnap.Admission.GenericSlow.QueueLimit != 12 {
		t.Fatalf("unexpected live admission.generic_slow: %+v", liveSnap.Admission.GenericSlow)
	}
	if !liveSnap.YTDLPGeneric.Enabled || liveSnap.YTDLPGeneric.Active != 1 || liveSnap.YTDLPGeneric.ConcurrencyLimit != 3 {
		t.Fatalf("unexpected live ytdlp_generic: %+v", liveSnap.YTDLPGeneric)
	}
	if !liveSnap.YTDLP.Enabled || liveSnap.YTDLP.Active != 0 || liveSnap.YTDLP.ConcurrencyLimit != 2 {
		t.Fatalf("expected core ytdlp unaffected (active=0, limit=2), got %+v", liveSnap.YTDLP)
	}

	if err := os.WriteFile(filepath.Join(gateDir, "release"), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := <-doneCh; code != http.StatusOK {
		t.Fatalf("generic parse status=%d, want 200", code)
	}

	_, endSnap := fetchStatsSnapshot(t, router, edgeKey, ownerToken, "198.51.100.99", "schema_version=1.0")
	if endSnap.Admission.GenericSlow.Active != 0 || endSnap.YTDLPGeneric.Active != 0 || endSnap.YTDLPGeneric.Total.AcquiredCount != 1 {
		t.Fatalf("unexpected post-release generic stats: adm=%+v ytdlp_generic=%+v", endSnap.Admission.GenericSlow, endSnap.YTDLPGeneric)
	}
}

func TestStatsYTDLPUnmatchedReservedCardinalityAndPersistence(t *testing.T) {
	cur := time.Date(2026, 11, 22, 6, 0, 0, 0, time.UTC)
	st := NewStats(func() time.Time { return cur })

	// Fill all 64 dynamic platform slots first.
	for i := 1; i <= MaxDynamicPlatforms; i++ {
		st.RecordDynamicParse(fmt.Sprintf("dyn_%02d", i), "OK", ChannelAnonymous, 20*time.Millisecond)
	}
	// Overflow 3 extra dynamic keys -> must spill to ytdlp_other.
	for i := MaxDynamicPlatforms + 1; i <= MaxDynamicPlatforms+3; i++ {
		st.RecordDynamicParse(fmt.Sprintf("dyn_%02d", i), "UPSTREAM_TIMEOUT", ChannelOwner, 50*time.Millisecond)
	}
	// Record ytdlp_unmatched AFTER all 64 slots are saturated -> must stay in dedicated ytdlp_unmatched (never spill to ytdlp_other!).
	st.RecordDynamicParse(PlatformYTDLPUnmatched, "UNSUPPORTED_PLATFORM", ChannelAnonymous, 15*time.Millisecond)
	st.RecordDynamicParse(PlatformYTDLPUnmatched, "UPSTREAM_BLOCKED", ChannelOwner, 30*time.Millisecond)
	// Hostile / raw stderr strings must still fall back to unknown (never corrupt dynamic or unmatched buckets).
	st.RecordDynamicParse("ERROR: [bad/raw]", "UPSTREAM_UNAVAILABLE", ChannelAnonymous, 10*time.Millisecond)

	snap := st.Snapshot()
	wantTotal := uint64(MaxDynamicPlatforms + 3 + 2 + 1)
	if snap.Requests.Total != wantTotal {
		t.Fatalf("total = %d, want %d", snap.Requests.Total, wantTotal)
	}
	cells := snap.Requests.ByPlatformCodeChannel
	if got := lookupCellCount(cells, PlatformYTDLPUnmatched, "UNSUPPORTED_PLATFORM", ChannelAnonymous); got != 1 {
		t.Fatalf("ytdlp_unmatched UNSUPPORTED_PLATFORM = %d, want 1", got)
	}
	if got := lookupCellCount(cells, PlatformYTDLPUnmatched, "UPSTREAM_BLOCKED", ChannelOwner); got != 1 {
		t.Fatalf("ytdlp_unmatched UPSTREAM_BLOCKED = %d, want 1", got)
	}
	if got := lookupCellCount(cells, PlatformYTDLPOther, "UPSTREAM_TIMEOUT", ChannelOwner); got != 3 {
		t.Fatalf("ytdlp_other UPSTREAM_TIMEOUT = %d, want 3", got)
	}
	if got := lookupCellCount(cells, PlatformUnknown, "UPSTREAM_UNAVAILABLE", ChannelAnonymous); got != 1 {
		t.Fatalf("unknown UPSTREAM_UNAVAILABLE (rejected raw key) = %d, want 1", got)
	}

	dayPlats := snap.Daily[29].ByPlatform
	if unmatched := dayPlats[PlatformYTDLPUnmatched]; unmatched.Total != 2 || unmatched.ByCode["UNSUPPORTED_PLATFORM"] != 1 || unmatched.ByCode["UPSTREAM_BLOCKED"] != 1 {
		t.Fatalf("daily ytdlp_unmatched mismatch: %+v", unmatched)
	}

	// Persist & reload cleanly while 64 dynamic platforms are active.
	snapPath := filepath.Join(t.TempDir(), "stats-unmatched.json")
	if err := st.SaveSnapshot(snapPath); err != nil {
		t.Fatalf("SaveSnapshot failed: %v", err)
	}
	st2 := NewStats(func() time.Time { return cur })
	if err := st2.LoadSnapshot(snapPath, nil); err != nil {
		t.Fatalf("LoadSnapshot failed: %v", err)
	}
	reloadedDay := st2.Snapshot().Daily[29].ByPlatform
	if unmatched := reloadedDay[PlatformYTDLPUnmatched]; unmatched.Total != 2 || unmatched.ByCode["UNSUPPORTED_PLATFORM"] != 1 || unmatched.ByCode["UPSTREAM_BLOCKED"] != 1 {
		t.Fatalf("reloaded daily ytdlp_unmatched mismatch: %+v", unmatched)
	}
	if other := reloadedDay[PlatformYTDLPOther]; other.Total != 3 {
		t.Fatalf("reloaded daily ytdlp_other total = %d, want 3", other.Total)
	}
}
