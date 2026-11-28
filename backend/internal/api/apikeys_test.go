package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	weiboplatform "github.com/Brilliant666/DokiTool-Go/backend/internal/platform/weibo"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func sha256HexOf(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func lookupAPIKeySnap(t *testing.T, snap StatsSnapshot, id string) APIKeyStatsSnapshot {
	t.Helper()
	for _, k := range snap.APIKeys {
		if k.ID == id {
			return k
		}
	}
	t.Fatalf("API key %q not found in StatsSnapshot.APIKeys: %+v", id, snap.APIKeys)
	return APIKeyStatsSnapshot{}
}

func TestAPIKeyRegistryValidationDefaultsBoundsAndDedicatedCredentials(t *testing.T) {
	cfg := DefaultAdmissionConfig()
	ownerTok := randomPrintableToken(t, 48)
	ownerAuth, err := NewOwnerAuth(ownerTok)
	if err != nil {
		t.Fatal(err)
	}

	tokOwner2 := randomPrintableToken(t, 48)
	tokAgent := randomPrintableToken(t, 48)
	tokFriend := randomPrintableToken(t, 48)
	tokDisabled := randomPrintableToken(t, 48)

	validManifest := fmt.Sprintf(`{
		"keys": [
			{
				"id": "owner-backup",
				"role": "owner",
				"token_sha256": %q
			},
			{
				"id": "agent_bot-01",
				"role": "agent",
				"token_sha256": %q,
				"platforms": ["douyin", "bilibili", "x"]
			},
			{
				"id": "friend-alice",
				"role": "friend",
				"token_sha256": %q
			},
			{
				"id": "revoked-key",
				"role": "friend",
				"enabled": false,
				"token_sha256": %q
			}
		]
	}`, sha256HexOf(tokOwner2), sha256HexOf(tokAgent), sha256HexOf(tokFriend), sha256HexOf(tokDisabled))

	reg, err := ParseAPIKeyRegistry([]byte(validManifest), true, ownerAuth, cfg, nil)
	if err != nil {
		t.Fatalf("valid manifest failed: %v", err)
	}
	if reg.Len() != 5 {
		t.Fatalf("expected 5 total keys (implicit owner + 4 file keys), got %d", reg.Len())
	}

	// Formatting never leaks digests or tokens.
	formatted := fmt.Sprintf("%s|%v|%+v|%#v", reg, reg, reg, reg.allKeys[1])
	for _, secret := range []string{ownerTok[:12], sha256HexOf(ownerTok)[:12], sha256HexOf(tokAgent)[:12]} {
		if strings.Contains(formatted, secret) {
			t.Fatalf("registry formatting leaked secret/digest %q: %q", secret, formatted)
		}
	}

	// Verify role defaults on omitted optional fields.
	snaps := reg.snapshots()
	if len(snaps) != 5 {
		t.Fatalf("snapshots len = %d, want 5", len(snaps))
	}
	// 0: implicit owner, 1: owner-backup, 2: agent_bot-01, 3: friend-alice, 4: revoked-key
	if snaps[0].ID != "owner" || snaps[0].Role != RoleOwner || !snaps[0].Enabled ||
		snaps[0].ConcurrencyLimit != DefaultOwnerConcurrency || snaps[0].SlowConcurrencyLimit != 0 || snaps[0].QueueLimit != DefaultOwnerQueueSize {
		t.Fatalf("unexpected implicit owner defaults: %+v", snaps[0])
	}
	if snaps[1].ID != "owner-backup" || snaps[1].Role != RoleOwner || !snaps[1].Enabled ||
		snaps[1].ConcurrencyLimit != DefaultOwnerConcurrency || snaps[1].SlowConcurrencyLimit != 0 || snaps[1].QueueLimit != DefaultOwnerQueueSize {
		t.Fatalf("unexpected file owner defaults: %+v", snaps[1])
	}
	if snaps[2].ID != "agent_bot-01" || snaps[2].Role != RoleAgent || !snaps[2].Enabled ||
		snaps[2].ConcurrencyLimit != 4 || snaps[2].SlowConcurrencyLimit != 1 || snaps[2].QueueLimit != 128 {
		t.Fatalf("unexpected agent defaults: %+v", snaps[2])
	}
	if reg.byID["agent_bot-01"].pool.rps != 5.0 || reg.byID["agent_bot-01"].pool.burst != 16 || reg.byID["agent_bot-01"].pool.queueWait != 45*time.Second {
		t.Fatalf("unexpected agent rate/wait defaults: %+v", reg.byID["agent_bot-01"].pool)
	}
	if snaps[3].ID != "friend-alice" || snaps[3].Role != RoleFriend || !snaps[3].Enabled ||
		snaps[3].ConcurrencyLimit != 2 || snaps[3].SlowConcurrencyLimit != 1 || snaps[3].QueueLimit != 16 {
		t.Fatalf("unexpected friend defaults: %+v", snaps[3])
	}
	if reg.byID["friend-alice"].pool.rps != 1.0 || reg.byID["friend-alice"].pool.burst != 6 || reg.byID["friend-alice"].pool.queueWait != 15*time.Second {
		t.Fatalf("unexpected friend rate/wait defaults: %+v", reg.byID["friend-alice"].pool)
	}
	if snaps[4].ID != "revoked-key" || snaps[4].Enabled {
		t.Fatalf("expected revoked-key enabled=false, got %+v", snaps[4])
	}

	// MaxAPIKeys = 64 boundary: implicit owner + 63 file keys succeeds; + 64 file keys fails.
	buildNFileKeys := func(n int) []byte {
		var items []string
		for i := 0; i < n; i++ {
			tStr := fmt.Sprintf("synthetic-key-number-%03d-%s", i, strings.Repeat("x", 24))
			items = append(items, fmt.Sprintf(`{"id":"k-%02d","role":"agent","token_sha256":%q}`, i, sha256HexOf(tStr)))
		}
		return []byte(`{"keys":[` + strings.Join(items, ",") + `]}`)
	}
	if r64, err := ParseAPIKeyRegistry(buildNFileKeys(63), true, ownerAuth, cfg, nil); err != nil || r64.Len() != 64 {
		t.Fatalf("expected 64 total keys to succeed: len=%d err=%v", r64.Len(), err)
	}
	if _, err := ParseAPIKeyRegistry(buildNFileKeys(64), true, ownerAuth, cfg, nil); err == nil {
		t.Fatal("expected 65 total keys (implicit owner + 64 file keys) to fail MaxAPIKeys=64")
	}

	// Rejection matrix for malformed manifests, unknown fields, bad bounds, duplicates, and collisions.
	canaryPlain := "plaintext-secret-token-never-echo-123456"
	validHexA := sha256HexOf(randomPrintableToken(t, 48))
	validHexB := sha256HexOf(randomPrintableToken(t, 48))

	badManifests := []struct {
		name string
		raw  string
	}{
		{"empty-file", ""},
		{"root-array", `[]`},
		{"missing-keys-field", `{}`},
		{"null-element", `{"keys":[null]}`},
		{"trailing-json", fmt.Sprintf(`{"keys":[{"id":"a","role":"agent","token_sha256":%q}]}{"extra":1}`, validHexA)},
		{"plaintext-token-field", fmt.Sprintf(`{"keys":[{"id":"a","role":"agent","token":%q,"token_sha256":%q}]}`, canaryPlain, validHexA)},
		{"unknown-field", fmt.Sprintf(`{"keys":[{"id":"a","role":"agent","token_sha256":%q,"admin":true}]}`, validHexA)},
		{"uppercase-id", fmt.Sprintf(`{"keys":[{"id":"AgentBot","role":"agent","token_sha256":%q}]}`, validHexA)},
		{"leading-hyphen-id", fmt.Sprintf(`{"keys":[{"id":"-agent","role":"agent","token_sha256":%q}]}`, validHexA)},
		{"overlong-33-char-id", fmt.Sprintf(`{"keys":[{"id":"%s","role":"agent","token_sha256":%q}]}`, strings.Repeat("a", 33), validHexA)},
		{"duplicate-id-in-file", fmt.Sprintf(`{"keys":[{"id":"dup","role":"agent","token_sha256":%q},{"id":"dup","role":"friend","token_sha256":%q}]}`, validHexA, validHexB)},
		{"duplicate-id-with-implicit-owner", fmt.Sprintf(`{"keys":[{"id":"owner","role":"owner","token_sha256":%q}]}`, validHexA)},
		{"duplicate-digest-in-file-even-when-disabled", fmt.Sprintf(`{"keys":[{"id":"k1","role":"agent","token_sha256":%q},{"id":"k2","role":"friend","enabled":false,"token_sha256":%q}]}`, validHexA, validHexA)},
		{"duplicate-digest-with-implicit-owner", fmt.Sprintf(`{"keys":[{"id":"k1","role":"owner","token_sha256":%q}]}`, sha256HexOf(ownerTok))},
		{"unknown-role", fmt.Sprintf(`{"keys":[{"id":"k1","role":"admin","token_sha256":%q}]}`, validHexA)},
		{"owner-rps-without-burst", fmt.Sprintf(`{"keys":[{"id":"k1","role":"owner","rps":10,"token_sha256":%q}]}`, validHexA)},
		{"owner-burst-with-zero-rps", fmt.Sprintf(`{"keys":[{"id":"k1","role":"owner","rps":0,"burst":10,"token_sha256":%q}]}`, validHexA)},
		{"agent-zero-rps", fmt.Sprintf(`{"keys":[{"id":"k1","role":"agent","rps":0,"token_sha256":%q}]}`, validHexA)},
		{"agent-conc-33", fmt.Sprintf(`{"keys":[{"id":"k1","role":"agent","concurrency":33,"token_sha256":%q}]}`, validHexA)},
		{"agent-slow-exceeds-conc", fmt.Sprintf(`{"keys":[{"id":"k1","role":"agent","concurrency":2,"slow_concurrency":3,"token_sha256":%q}]}`, validHexA)},
		{"agent-slow-exceeds-24", fmt.Sprintf(`{"keys":[{"id":"k1","role":"agent","concurrency":32,"slow_concurrency":25,"token_sha256":%q}]}`, validHexA)},
		{"friend-conc-17", fmt.Sprintf(`{"keys":[{"id":"k1","role":"friend","concurrency":17,"token_sha256":%q}]}`, validHexA)},
		{"friend-rps-101", fmt.Sprintf(`{"keys":[{"id":"k1","role":"friend","rps":101,"token_sha256":%q}]}`, validHexA)},
		{"friend-burst-201", fmt.Sprintf(`{"keys":[{"id":"k1","role":"friend","burst":201,"token_sha256":%q}]}`, validHexA)},
		{"friend-queue-size-513", fmt.Sprintf(`{"keys":[{"id":"k1","role":"friend","queue_size":513,"token_sha256":%q}]}`, validHexA)},
		{"friend-queue-wait-61s", fmt.Sprintf(`{"keys":[{"id":"k1","role":"friend","queue_wait":"61s","token_sha256":%q}]}`, validHexA)},
		{"bad-queue-wait-syntax", fmt.Sprintf(`{"keys":[{"id":"k1","role":"agent","queue_wait":"forever","token_sha256":%q}]}`, validHexA)},
		{"platform-unknown-forbidden", fmt.Sprintf(`{"keys":[{"id":"k1","role":"agent","platforms":["unknown"],"token_sha256":%q}]}`, validHexA)},
		{"platform-dailymotion-forbidden", fmt.Sprintf(`{"keys":[{"id":"k1","role":"agent","platforms":["dailymotion"],"token_sha256":%q}]}`, validHexA)},
		{"platform-duplicate", fmt.Sprintf(`{"keys":[{"id":"k1","role":"agent","platforms":["douyin","douyin"],"token_sha256":%q}]}`, validHexA)},
	}
	for _, tc := range badManifests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseAPIKeyRegistry([]byte(tc.raw), true, ownerAuth, cfg, nil)
			if err == nil {
				t.Fatalf("expected %s to fail validation", tc.name)
			}
			for _, secret := range []string{canaryPlain[:16], validHexA[:16], sha256HexOf(ownerTok)[:16]} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("%s error leaked secret/digest %q: %q", tc.name, secret, err.Error())
				}
			}
		})
	}

	// Dedicated credential checks against all 4 system env keys (both file key and implicit owner key).
	sharedSysSecret := randomPrintableToken(t, 48)
	fileWithShared := fmt.Sprintf(`{"keys":[{"id":"shared-bot","role":"agent","enabled":false,"token_sha256":%q}]}`, sha256HexOf(sharedSysSecret))
	for _, sysEnv := range dedicatedSystemEnvKeys {
		_, err := ParseAPIKeyRegistry([]byte(fileWithShared), true, OwnerAuth{}, cfg, func(k string) string {
			if k == sysEnv {
				return sharedSysSecret
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "dedicated credential") {
			t.Fatalf("expected collision with %s to fail dedicated credential check, got %v", sysEnv, err)
		}
		if strings.Contains(err.Error(), sharedSysSecret[:12]) || strings.Contains(err.Error(), sha256HexOf(sharedSysSecret)[:12]) {
			t.Fatalf("collision error leaked secret/digest for %s: %v", sysEnv, err)
		}
	}

	// File loading checks via LoadAPIKeyRegistry (regular file, missing file, directory, >64KiB, whitespace).
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "api-keys.json")
	if err := os.WriteFile(manifestPath, []byte(`{"keys":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if loaded, err := LoadAPIKeyRegistry(func(k string) string {
		if k == EnvAPIKeysFile {
			return manifestPath
		}
		return ""
	}, cfg); err != nil || loaded.Len() != 0 {
		t.Fatalf("empty keys array manifest failed: len=%d err=%v", loaded.Len(), err)
	}
	if _, err := LoadAPIKeyRegistry(func(k string) string {
		if k == EnvAPIKeysFile {
			return filepath.Join(dir, "missing.json")
		}
		return ""
	}, cfg); err == nil || strings.Contains(err.Error(), dir) {
		t.Fatalf("missing file must fail without leaking local path: %v", err)
	}
	if _, err := LoadAPIKeyRegistry(func(k string) string {
		if k == EnvAPIKeysFile {
			return dir
		}
		return ""
	}, cfg); err == nil || strings.Contains(err.Error(), dir) {
		t.Fatalf("directory path must fail without leaking local path: %v", err)
	}
	oversizedPath := filepath.Join(dir, "oversized.json")
	if err := os.WriteFile(oversizedPath, bytes.Repeat([]byte(" "), MaxAPIKeysFileBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadAPIKeyRegistry(func(k string) string {
		if k == EnvAPIKeysFile {
			return oversizedPath
		}
		return ""
	}, cfg); err == nil {
		t.Fatal("expected >64KiB manifest to fail")
	}
	if _, err := LoadAPIKeyRegistry(func(k string) string {
		if k == EnvAPIKeysFile {
			return "   "
		}
		return ""
	}, cfg); err == nil {
		t.Fatal("expected whitespace DOKITOOL_API_KEYS_FILE to fail")
	}
}

func TestMultiKeyRolesDisabledPlatformScopeWeiboDirectAndStatsSchema(t *testing.T) {
	ownerTok := randomPrintableToken(t, 48)
	ownerFileTok := randomPrintableToken(t, 48)
	agentTok := randomPrintableToken(t, 48)
	friendScopedTok := randomPrintableToken(t, 48)
	disabledTok := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)

	const weiboBody = `{"idstr":"1234567890","text_raw":"t","page_info":{"media_info":{"mp4_hd_url":"https://f.video.weibocdn.com/direct-hd.mp4?size=1080","video_title":"v","duration":16}},"user":{"screen_name":"u","idstr":"1"}}`
	wbAdapter := weiboplatform.New(fakeHTTPExec(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(weiboBody)}, nil
	}))
	weiboPublicMedia := weiboplatform.PreparePublic

	c := makeStatsTestCatalog(t)
	var kuaishouCalls atomic.Int32
	adapters := map[string]Adapter{
		"douyin": AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
			return makeStatsOKPayload("douyin", src, now), nil
		}),
		"kuaishou": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			kuaishouCalls.Add(1)
			return makeStatsOKPayload("kuaishou", src, now), nil
		}),
		"weibo": wbAdapter,
		"youtube": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			return makeStatsOKPayload("youtube", src, now), nil
		}),
	}
	pubMedia := func(ctx context.Context, platform string, payload unified.Object, now int64) (unified.Object, error) {
		if platform == "weibo" {
			return weiboPublicMedia(ctx, platform, payload, now)
		}
		return payload, nil
	}

	h, err := NewWithCacheConfig(c, adapters, func() time.Time { return time.Unix(1793448000, 0) }, pubMedia, DefaultCacheConfig())
	if err != nil {
		t.Fatal(err)
	}
	ytStub := &countingYouTubeHelper{}
	h.SetYouTubeHelper(ytStub)

	cfg := DefaultAdmissionConfig()
	cfg.Parse.ClientBurst = 4
	cfg.Parse.ClientRPS = 0.01

	ownerAuth, err := NewOwnerAuth(ownerTok)
	if err != nil {
		t.Fatal(err)
	}
	manifest := fmt.Sprintf(`{
		"keys": [
			{
				"id": "ops-owner",
				"role": "owner",
				"token_sha256": %q,
				"concurrency": 4
			},
			{
				"id": "agent-bot",
				"role": "agent",
				"token_sha256": %q
			},
			{
				"id": "friend-scoped",
				"role": "friend",
				"token_sha256": %q,
				"rps": 20,
				"burst": 20,
				"platforms": ["douyin", "weibo"]
			},
			{
				"id": "disabled-bot",
				"role": "agent",
				"enabled": false,
				"token_sha256": %q
			}
		]
	}`, sha256HexOf(ownerFileTok), sha256HexOf(agentTok), sha256HexOf(friendScopedTok), sha256HexOf(disabledTok))

	reg, err := ParseAPIKeyRegistry([]byte(manifest), true, ownerAuth, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	router, err := WithAdmissionWithRegistry(h, nil, "caddy", edgeKey, cfg, reg)
	if err != nil {
		t.Fatal(err)
	}

	sendReq := func(method, target, ip, tok string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, nil)
		req.RemoteAddr = "127.0.0.1:48000"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, ip)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	assert401Contract := func(t *testing.T, rec *httptest.ResponseRecorder, wantSubstr string) {
		t.Helper()
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d, want 401; body=%s", rec.Code, rec.Body.String())
		}
		var doc map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
			t.Fatalf("unmarshal 401 body failed: %v; body=%s", err, rec.Body.String())
		}
		if doc["schema_version"] != "1.0" || doc["code"] != "INVALID_INPUT" {
			t.Fatalf("unexpected 401 envelope: %v", doc)
		}
		errObj, ok := doc["error"].(map[string]any)
		if !ok || errObj["code"] != "INVALID_INPUT" {
			t.Fatalf("unexpected 401 error object: %v", doc)
		}
		retryableVal, hasRetryable := errObj["retryable"]
		if !hasRetryable || retryableVal != false {
			t.Fatalf("401 error object must explicitly carry \"retryable\": false, got %v (body=%s)", errObj, rec.Body.String())
		}
		msg, _ := errObj["message"].(string)
		if !strings.Contains(msg, wantSubstr) {
			t.Fatalf("401 message = %q, want substring %q", msg, wantSubstr)
		}
	}

	// 1. /api/stats role enforcement: both implicit "owner" and file "ops-owner" succeed (200);
	//    "agent-bot" and "friend-scoped" get 401 ("当前凭据无权访问统计接口") without charging anonymous IP!
	if rec := sendReq(http.MethodGet, "/api/stats", "198.51.100.10", ownerTok); rec.Code != http.StatusOK {
		t.Fatalf("implicit owner /api/stats got %d", rec.Code)
	}
	if rec := sendReq(http.MethodGet, "/api/stats", "198.51.100.10", ownerFileTok); rec.Code != http.StatusOK {
		t.Fatalf("file owner /api/stats got %d", rec.Code)
	}
	for _, nonOwnerTok := range []string{agentTok, friendScopedTok} {
		for i := 0; i < 6; i++ {
			rec := sendReq(http.MethodGet, "/api/stats", "198.51.100.10", nonOwnerTok)
			assert401Contract(t, rec, "当前凭据无权访问统计接口")
		}
	}
	// Anonymous caller from the SAME IP 198.51.100.10 still has its full 4-token parse burst!
	if rec := sendReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/7100000000000000001"), "198.51.100.10", ""); rec.Code != http.StatusOK {
		t.Fatalf("anonymous caller from 198.51.100.10 throttled by valid agent /api/stats 401s: %d", rec.Code)
	}

	// 2. Disabled key never authenticates and charges per-IP brute-force budget (4x 401 -> 5th 429).
	for i := 1; i <= 4; i++ {
		rec := sendReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/7100000000000000002"), "198.51.100.20", disabledTok)
		assert401Contract(t, rec, "认证凭据无效")
	}
	if rec := sendReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/7100000000000000002"), "198.51.100.20", disabledTok); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("disabled key 5th attempt got %d, want 429", rec.Code)
	}

	// 3. Platform scope enforcement on BOTH uncached and WARM-CACHED URLs + YouTube helper routes!
	ksTarget := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.kuaishou.com/short-video/3xngkmw8vacriqu")
	// Warm the cache for kuaishou via unrestricted agent-bot first.
	if rec := sendReq(http.MethodGet, ksTarget, "198.51.100.30", agentTok); rec.Code != http.StatusOK || kuaishouCalls.Load() != 1 {
		t.Fatalf("agent-bot warm kuaishou failed: code=%d calls=%d", rec.Code, kuaishouCalls.Load())
	}
	if !h.HasFreshCachedParse("/api/parse", "schema_version=1.0&url="+url.QueryEscape("https://www.kuaishou.com/short-video/3xngkmw8vacriqu")) {
		t.Fatal("expected kuaishou entry to be fresh in parseCache")
	}
	// friend-scoped (only ["douyin", "weibo"]) MUST get 401 even though kuaishou is warm in parseCache!
	recScopedKS := sendReq(http.MethodGet, ksTarget, "198.51.100.31", friendScopedTok)
	assert401Contract(t, recScopedKS, "当前凭据无权访问该平台")
	// friend-scoped also gets 401 on uncached youtube and /api/youtube/context!
	assert401Contract(t, sendReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "198.51.100.31", friendScopedTok), "当前凭据无权访问该平台")
	assert401Contract(t, sendReq(http.MethodGet, "/api/youtube/context?schema_version=1.0", "198.51.100.31", friendScopedTok), "当前凭据无权访问该平台")
	// Allowed platforms (douyin + weibo) succeed for friend-scoped!
	if rec := sendReq(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/7100000000000000001"), "198.51.100.31", friendScopedTok); rec.Code != http.StatusOK {
		t.Fatalf("friend-scoped allowed douyin got %d", rec.Code)
	}

	// 4. Weibo returns unified direct CDN URL + browser_fetch=blocked across BOTH authenticated roles and anonymous visitors (zero relay).
	weiboTarget := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://weibo.com/1234567890/AbC")
	for _, tok := range []string{ownerTok, agentTok, friendScopedTok, ""} {
		rec := sendReq(http.MethodGet, weiboTarget, "198.51.100.32", tok)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "https://f.video.weibocdn.com/direct-hd.mp4") || strings.Contains(rec.Body.String(), "/api/media/weibo") || strings.Contains(rec.Body.String(), `"direct_url"`) {
			t.Fatalf("Weibo response did not return direct URL: code=%d body=%s", rec.Code, rec.Body.String())
		}
		wbPayload, err := unified.Decode(rec.Body.Bytes())
		if err != nil {
			t.Fatalf("Weibo invalid JSON: %v", err)
		}
		wbItem := unified.Map(unified.Slice(unified.Map(wbPayload["data"])["items"])[0])
		wbDef := unified.Map(wbItem["default"])
		if wbDef["access"] == "relay" || unified.Str(wbDef["url"]) != "https://f.video.weibocdn.com/direct-hd.mp4?size=1080" {
			t.Fatalf("Weibo default expected direct URL: %v", wbDef)
		}
		wbVariant := unified.Map(unified.Slice(wbItem["variants"])[0])
		wbSrc := unified.Map(unified.Slice(unified.Map(wbVariant["delivery"])["sources"])[0])
		if wbSrc["browser_fetch"] != "blocked" || unified.Str(wbSrc["url"]) != "https://f.video.weibocdn.com/direct-hd.mp4?size=1080" {
			t.Fatalf("Weibo source expected direct + browser_fetch=blocked: %v", wbSrc)
		}
	}

	// 5. Inspect /api/stats JSON contract: exact 22 fields per api_keys entry, non-nil slice when empty, zero secrets.
	recStats := sendReq(http.MethodGet, "/api/stats", "198.51.100.99", ownerTok)
	if recStats.Code != http.StatusOK {
		t.Fatalf("/api/stats status=%d", recStats.Code)
	}
	var rawEnv map[string]any
	if err := json.Unmarshal(recStats.Body.Bytes(), &rawEnv); err != nil {
		t.Fatal(err)
	}
	dataObj := rawEnv["data"].(map[string]any)
	rawKeys, ok := dataObj["api_keys"].([]any)
	if !ok || len(rawKeys) != 5 {
		t.Fatalf("expected 5 api_keys entries in /api/stats, got %T %v", dataObj["api_keys"], dataObj["api_keys"])
	}
	want22Fields := []string{
		"active", "cache_hits", "canceled", "concurrency_limit", "enabled",
		"errors", "full", "granted", "id", "ok", "queue_limit", "queued",
		"rate_limited", "requests_total", "role", "slow_active",
		"slow_concurrency_limit", "timeout", "unauthorized", "wait_ms_max",
		"wait_ms_total", "waited",
	}
	slices.Sort(want22Fields)
	for i, item := range rawKeys {
		m := item.(map[string]any)
		gotFields := make([]string, 0, len(m))
		for k := range m {
			gotFields = append(gotFields, k)
		}
		slices.Sort(gotFields)
		if !slices.Equal(gotFields, want22Fields) {
			t.Fatalf("api_keys[%d] fields = %v, want exact 22 fields %v", i, gotFields, want22Fields)
		}
	}

	_, typedSnap := fetchStatsSnapshot(t, router, edgeKey, ownerTok, "198.51.100.99", "")
	// Aggregate Admission.Owner reflects both owner keys (8 + 4 = 12).
	if typedSnap.Admission.Owner.ConcurrencyLimit != DefaultOwnerConcurrency+4 {
		t.Fatalf("Admission.Owner.ConcurrencyLimit = %d, want %d", typedSnap.Admission.Owner.ConcurrencyLimit, DefaultOwnerConcurrency+4)
	}
	friendSnap := lookupAPIKeySnap(t, typedSnap, "friend-scoped")
	// 6x /api/stats 401 + 3x platform-scope 401 = 9 unauthorized; 1x warm douyin cache hit + 1x warm weibo cache hit = 2 ok!
	if friendSnap.Unauthorized != 9 || friendSnap.OK != 2 || friendSnap.CacheHits != 2 || friendSnap.RequestsTotal != 11 {
		t.Fatalf("unexpected friend-scoped telemetry: %+v", friendSnap)
	}
	disabledSnap := lookupAPIKeySnap(t, typedSnap, "disabled-bot")
	if disabledSnap.Enabled || disabledSnap.RequestsTotal != 0 {
		t.Fatalf("expected disabled-bot enabled=false and 0 requests, got %+v", disabledSnap)
	}

	// Empty registry serializes "api_keys":[] (never null).
	emptyRouter, err := WithAdmissionWithRegistry(h, nil, "caddy", edgeKey, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	emptyJSON, err := json.Marshal(emptyRouter.(*admission).stats.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(emptyJSON), `"api_keys":[]`) {
		t.Fatalf("expected empty api_keys to marshal as [], got %s", string(emptyJSON))
	}
}

type fakeHTTPExec func(context.Context, fetch.Request) (fetch.Response, error)

func (f fakeHTTPExec) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	return f(ctx, req)
}

func TestKeyPoolNonHOLBlockingSlowConcurrencyAndZeroSlotCacheFastPath(t *testing.T) {
	agentTok := randomPrintableToken(t, 48)
	ownerTok := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)

	t.Run("non-hol-blocking-arrival-and-full-pool-wakeup-bypass", func(t *testing.T) {
		c := makeStatsTestCatalog(t)
		slow1Entered := make(chan struct{})
		slow1Release := make(chan struct{})
		slow2Entered := make(chan struct{})
		fast1Entered := make(chan struct{})
		fast1Release := make(chan struct{})

		h, err := NewWithCacheConfig(c, map[string]Adapter{
			"x": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				if strings.HasSuffix(src, "/1001") {
					close(slow1Entered)
					<-slow1Release
				} else if strings.HasSuffix(src, "/1002") {
					close(slow2Entered)
				}
				return makeStatsOKPayload("x", src, now), nil
			}),
			"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				if strings.HasSuffix(src, "/2001") {
					close(fast1Entered)
					<-fast1Release
				}
				return makeStatsOKPayload("douyin", src, now), nil
			}),
		}, time.Now, nil, CacheConfig{Disabled: true})
		if err != nil {
			t.Fatal(err)
		}

		// Configure agent key with concurrency=2, slow_concurrency=1, high burst/rps.
		ownerAuth, _ := NewOwnerAuth(ownerTok)
		manifest := fmt.Sprintf(`{
			"keys": [{
				"id": "hol-agent",
				"role": "agent",
				"token_sha256": %q,
				"concurrency": 2,
				"slow_concurrency": 1,
				"rps": 200,
				"burst": 200,
				"queue_size": 8,
				"queue_wait": "5s"
			}]
		}`, sha256HexOf(agentTok))
		reg, err := ParseAPIKeyRegistry([]byte(manifest), true, ownerAuth, DefaultAdmissionConfig(), nil)
		if err != nil {
			t.Fatal(err)
		}
		router, err := WithAdmissionWithRegistry(h, nil, "caddy", edgeKey, DefaultAdmissionConfig(), reg)
		if err != nil {
			t.Fatal(err)
		}

		fire := func(rawURL string) int {
			req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(rawURL), nil)
			req.RemoteAddr = "127.0.0.1:49000"
			req.Header.Set(edgeHeader, edgeKey)
			req.Header.Set(clientHeader, "198.51.100.80")
			req.Header.Set("Authorization", "Bearer "+agentTok)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			return rec.Code
		}

		// Step 1: Occupy slow_concurrency=1 with slow X #1 (active=1, slow_active=1).
		slow1Done := make(chan int, 1)
		go func() { slow1Done <- fire("https://x.com/i/status/1001") }()
		<-slow1Entered

		// Step 2: Enqueue slow X #2 -> blocks on slow_concurrency=1 (queued=1).
		slow2Done := make(chan int, 1)
		go func() { slow2Done <- fire("https://x.com/i/status/1002") }()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			_, s := fetchStatsSnapshot(t, router, edgeKey, ownerTok, "198.51.100.99", "")
			ks := lookupAPIKeySnap(t, s, "hol-agent")
			if ks.Active == 1 && ks.SlowActive == 1 && ks.Queued == 1 {
				break
			}
			time.Sleep(2 * time.Millisecond)
		}

		// Step 3 (Arrival bypass): Fast Douyin #0 arrives while slow X #2 is queued -> runs immediately (<50ms)!
		tArr := time.Now()
		if code := fire("https://www.douyin.com/video/2000"); code != http.StatusOK || time.Since(tArr) > 100*time.Millisecond {
			t.Fatalf("fast douyin arrival blocked behind slow waiter: code=%d elapsed=%v", code, time.Since(tArr))
		}

		// Step 4 (Full-pool wakeup bypass): Hold fast Douyin #1 so active=2/2, slow_active=1/1,
		// while queue has [slow X #2 (head), fast Douyin #2 (behind slow X #2)].
		fast1Done := make(chan int, 1)
		go func() { fast1Done <- fire("https://www.douyin.com/video/2001") }()
		<-fast1Entered

		fast2Done := make(chan int, 1)
		go func() { fast2Done <- fire("https://www.douyin.com/video/2002") }()
		for time.Now().Before(deadline) {
			_, s := fetchStatsSnapshot(t, router, edgeKey, ownerTok, "198.51.100.99", "")
			ks := lookupAPIKeySnap(t, s, "hol-agent")
			if ks.Active == 2 && ks.SlowActive == 1 && ks.Queued == 2 {
				break
			}
			time.Sleep(2 * time.Millisecond)
		}

		// Release fast Douyin #1 while slow X #1 is STILL blocked!
		// Fast Douyin #2 MUST wake up and complete immediately, bypassing slow X #2 at head of queue!
		close(fast1Release)
		if code := <-fast1Done; code != http.StatusOK {
			t.Fatalf("fast1 status=%d", code)
		}
		select {
		case code := <-fast2Done:
			if code != http.StatusOK {
				t.Fatalf("fast2 status=%d", code)
			}
		case <-time.After(500 * time.Millisecond):
			t.Fatal("fast2 waiter suffered HOL blocking behind queued slow X #2")
		}
		select {
		case <-slow2Entered:
			t.Fatal("slow2 entered while slow1 still held the single slow_concurrency slot")
		default:
		}

		// Now release slow X #1 -> slow X #2 wakes up and completes cleanly.
		close(slow1Release)
		if code := <-slow1Done; code != http.StatusOK {
			t.Fatalf("slow1 status=%d", code)
		}
		if code := <-slow2Done; code != http.StatusOK {
			t.Fatalf("slow2 status=%d", code)
		}
	})

	t.Run("zero-slot-cache-fast-path-under-100pct-saturated-keypool-and-nanosecond-expiry-guard", func(t *testing.T) {
		c := makeStatsTestCatalog(t)
		var nowNs atomic.Int64
		baseTime := time.Unix(1793448000, 0).UTC()
		nowNs.Store(baseTime.UnixNano())
		var stepOnHasFresh atomic.Bool

		coldEntered := make(chan struct{}, 4)
		coldRelease := make(chan struct{})
		var warmUpstreamCalls atomic.Int32

		h, err := NewWithCacheConfig(c, map[string]Adapter{
			"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
				if strings.HasSuffix(src, "/warm") {
					warmUpstreamCalls.Add(1)
					return makeStatsOKPayload("douyin", src, now), nil
				}
				coldEntered <- struct{}{}
				<-coldRelease
				return makeStatsOKPayload("douyin", src, now), nil
			}),
		}, func() time.Time {
			return time.Unix(0, nowNs.Load()).UTC()
		}, nil, DefaultCacheConfig())
		if err != nil {
			t.Fatal(err)
		}

		// concurrency=2, queue_size=0, queue_wait=0s, tight parse burst=3 (so 20 cache hits prove parse bucket is NOT drained!).
		ownerAuth, _ := NewOwnerAuth(ownerTok)
		manifest := fmt.Sprintf(`{
			"keys": [{
				"id": "fast-cache-agent",
				"role": "agent",
				"token_sha256": %q,
				"concurrency": 2,
				"slow_concurrency": 1,
				"rps": 1,
				"burst": 4,
				"queue_size": 0,
				"queue_wait": "0s"
			}]
		}`, sha256HexOf(agentTok))
		reg, err := ParseAPIKeyRegistry([]byte(manifest), true, ownerAuth, DefaultAdmissionConfig(), nil)
		if err != nil {
			t.Fatal(err)
		}
		router, err := WithAdmissionWithRegistry(h, nil, "caddy", edgeKey, DefaultAdmissionConfig(), reg)
		if err != nil {
			t.Fatal(err)
		}
		adm := router.(*admission)
		adm.now = func() time.Time { return time.Unix(0, nowNs.Load()).UTC() }

		doAgentGET := func(target string) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodGet, target, nil)
			req.RemoteAddr = "127.0.0.1:49100"
			req.Header.Set(edgeHeader, edgeKey)
			req.Header.Set(clientHeader, "198.51.100.90")
			req.Header.Set("Authorization", "Bearer "+agentTok)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			return rec
		}

		warmURL := "https://www.douyin.com/video/warm"
		warmParsePath := "/api/parse?schema_version=1.0&url=" + url.QueryEscape(warmURL)
		warmResolvePath := "/api/resolve?schema_version=1.0&item_id=item-1&url=" + url.QueryEscape(warmURL)

		// Warm both /api/parse and /api/resolve via ownerTok so agent's 4-token parse burst is still untouched!
		for _, p := range []string{warmParsePath, warmResolvePath} {
			req := httptest.NewRequest(http.MethodGet, p, nil)
			req.RemoteAddr = "127.0.0.1:49100"
			req.Header.Set(edgeHeader, edgeKey)
			req.Header.Set(clientHeader, "198.51.100.91")
			req.Header.Set("Authorization", "Bearer "+ownerTok)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("warm %s failed: %d", p, rec.Code)
			}
		}

		// Saturate 100% of fast-cache-agent's 2 concurrency slots with blocked upstream parses.
		var coldWG sync.WaitGroup
		for i := 1; i <= 2; i++ {
			coldWG.Add(1)
			go func(idx int) {
				defer coldWG.Done()
				_ = doAgentGET(fmt.Sprintf("/api/parse?schema_version=1.0&url=%s", url.QueryEscape(fmt.Sprintf("https://www.douyin.com/video/cold-%d", idx))))
			}(i)
		}
		<-coldEntered
		<-coldEntered

		// Confirm a 3rd uncached parse immediately fails with 429 (queue_size=0, pool 100% saturated).
		if rec := doAgentGET("/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.douyin.com/video/cold-3")); rec.Code != http.StatusTooManyRequests {
			t.Fatalf("expected 3rd uncached parse to get 429 while pool saturated, got %d", rec.Code)
		}

		// Fire 20 concurrent warm cache hits + /api/platforms while all concurrency slots are 100% blocked!
		tFast := time.Now()
		var hitWG sync.WaitGroup
		for i := 0; i < 20; i++ {
			hitWG.Add(1)
			go func(idx int) {
				defer hitWG.Done()
				target := warmParsePath
				if idx%3 == 1 {
					target = warmResolvePath
				} else if idx%3 == 2 {
					target = "/api/platforms?schema_version=1.0"
				}
				rec := doAgentGET(target)
				if rec.Code != http.StatusOK {
					t.Errorf("zero-slot fast-path idx=%d got status=%d body=%s", idx, rec.Code, rec.Body.String())
				}
			}(i)
		}
		hitWG.Wait()
		if elapsed := time.Since(tFast); elapsed > 100*time.Millisecond {
			t.Fatalf("zero-slot cache fast-path took %v while pool saturated", elapsed)
		}

		// Exact nanosecond expiry boundary: set clock to expiresAt - 1ns, and hook h.now so the
		// first call (HasFreshCachedParse) sees expiresAt - 1ns (fresh!) and the next call
		// (getFresh inside tryServeFreshCachedParse) sees expiresAt (expired!).
		// Because all 2 keyPool slots are STILL saturated and queue_size=0, the expiring entry
		// MUST fall through into keyPool and get rejected with 429 instead of bypassing keyPool!
		expAt := baseTime.Add(defaultCacheTTL)
		nowNs.Store(expAt.Add(-time.Nanosecond).UnixNano())
		stepOnHasFresh.Store(true)
		h.now = func() time.Time {
			cur := nowNs.Load()
			if stepOnHasFresh.CompareAndSwap(true, false) {
				nowNs.Store(expAt.UnixNano())
			}
			return time.Unix(0, cur).UTC()
		}
		recBoundary := doAgentGET(warmParsePath)
		if recBoundary.Code != http.StatusTooManyRequests {
			t.Fatalf("entry expiring at exact nanosecond boundary bypassed saturated keyPool: got %d, want 429", recBoundary.Code)
		}

		close(coldRelease)
		coldWG.Wait()

		_, finalSnap := fetchStatsSnapshot(t, router, edgeKey, ownerTok, "198.51.100.99", "")
		ks := lookupAPIKeySnap(t, finalSnap, "fast-cache-agent")
		// 20 fast-path requests: idx%3 != 2 => 14 parse/resolve cache hits; plus 2 cold OKs = 16 OK, 14 CacheHits, 2 RateLimited (cold-3 + boundary).
		if ks.CacheHits != 14 || ks.OK != 16 || ks.RateLimited != 2 || ks.Full != 2 {
			t.Fatalf("unexpected fast-cache-agent stats: %+v", ks)
		}
	})
}

func TestReloadAPIKeysPreservesCumulativeCountersUnderConcurrentTraffic(t *testing.T) {
	ownerTok := randomPrintableToken(t, 48)
	agentTokV1 := randomPrintableToken(t, 48)
	agentTokV2 := randomPrintableToken(t, 48)
	newKeyTok := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)

	c := makeStatsTestCatalog(t)
	h, err := NewWithCacheConfig(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			return makeStatsOKPayload("douyin", src, now), nil
		}),
	}, time.Now, nil, DefaultCacheConfig())
	if err != nil {
		t.Fatal(err)
	}

	cfg := DefaultAdmissionConfig()
	ownerAuth, _ := NewOwnerAuth(ownerTok)
	manifestV1 := fmt.Sprintf(`{
		"keys": [{
			"id": "bot-rotate",
			"role": "agent",
			"token_sha256": %q,
			"concurrency": 4,
			"rps": 500,
			"burst": 500
		}]
	}`, sha256HexOf(agentTokV1))
	regV1, err := ParseAPIKeyRegistry([]byte(manifestV1), true, ownerAuth, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	router, err := WithAdmissionWithRegistry(h, nil, "caddy", edgeKey, cfg, regV1)
	if err != nil {
		t.Fatal(err)
	}

	sendParse := func(rawURL, tok string) int {
		req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(rawURL), nil)
		req.RemoteAddr = "127.0.0.1:49200"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, "198.51.100.95")
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}

	// Accumulate 1 miss + 3 cache hits on bot-rotate with V1 token.
	for i := 0; i < 4; i++ {
		if code := sendParse("https://www.douyin.com/video/7500000000000000001", agentTokV1); code != http.StatusOK {
			t.Fatalf("v1 parse #%d status=%d", i, code)
		}
	}

	// Build V2 registry rotating bot-rotate's token & concurrency=8 and adding friend-new,
	// then reload concurrently while traffic is running.
	manifestV2 := fmt.Sprintf(`{
		"keys": [
			{
				"id": "bot-rotate",
				"role": "agent",
				"token_sha256": %q,
				"concurrency": 8,
				"rps": 500,
				"burst": 500
			},
			{
				"id": "friend-new",
				"role": "friend",
				"token_sha256": %q,
				"rps": 100,
				"burst": 100
			}
		]
	}`, sha256HexOf(agentTokV2), sha256HexOf(newKeyTok))
	regV2, err := ParseAPIKeyRegistry([]byte(manifestV2), true, ownerAuth, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				_ = sendParse("https://www.douyin.com/video/7500000000000000001", ownerTok)
				_, _ = fetchStatsSnapshot(t, router, edgeKey, ownerTok, "198.51.100.99", "")
			}
		}()
	}
	if !ReloadAPIKeys(router, regV2) {
		t.Fatal("ReloadAPIKeys returned false")
	}
	wg.Wait()

	// Old token V1 now fails with 401; new token V2 and friend-new succeed!
	if code := sendParse("https://www.douyin.com/video/7500000000000000001", agentTokV1); code != http.StatusUnauthorized {
		t.Fatalf("rotated-out token V1 got %d, want 401", code)
	}
	if code := sendParse("https://www.douyin.com/video/7500000000000000001", agentTokV2); code != http.StatusOK {
		t.Fatalf("new token V2 got %d, want 200", code)
	}
	if code := sendParse("https://www.douyin.com/video/7500000000000000001", newKeyTok); code != http.StatusOK {
		t.Fatalf("friend-new got %d, want 200", code)
	}

	_, snapAfter := fetchStatsSnapshot(t, router, edgeKey, ownerTok, "198.51.100.99", "")
	botSnap := lookupAPIKeySnap(t, snapAfter, "bot-rotate")
	// 4 pre-reload + 1 post-reload = 5 total, 4 cache hits, concurrency_limit updated to 8!
	if botSnap.ConcurrencyLimit != 8 || botSnap.RequestsTotal != 5 || botSnap.OK != 5 || botSnap.CacheHits != 4 {
		t.Fatalf("cumulative counters or updated limit lost on reload: %+v", botSnap)
	}
	friendNewSnap := lookupAPIKeySnap(t, snapAfter, "friend-new")
	if friendNewSnap.RequestsTotal != 1 || friendNewSnap.OK != 1 || friendNewSnap.CacheHits != 1 {
		t.Fatalf("unexpected friend-new stats: %+v", friendNewSnap)
	}
}

func TestReloadAPIKeysPreservesActiveLeasesWaitersAndRateBuckets(t *testing.T) {
	ownerTok := randomPrintableToken(t, 48)
	agentTok := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 48)

	c := makeStatsTestCatalog(t)
	req1Entered := make(chan struct{})
	req1Release := make(chan struct{})
	req2Entered := make(chan struct{})
	req2Release := make(chan struct{})

	h, err := NewWithCacheConfig(c, map[string]Adapter{
		"douyin": AdapterFunc(func(_ context.Context, src string, now int64) (unified.Object, error) {
			switch {
			case strings.HasSuffix(src, "/lease-1"):
				close(req1Entered)
				<-req1Release
			case strings.HasSuffix(src, "/lease-2"):
				close(req2Entered)
				<-req2Release
			}
			return makeStatsOKPayload("douyin", src, now), nil
		}),
	}, time.Now, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}

	cfg := DefaultAdmissionConfig()
	ownerAuth, _ := NewOwnerAuth(ownerTok)
	buildReg := func(conc, burst, qSize int, qWait string) *APIKeyRegistry {
		manifest := fmt.Sprintf(`{
			"keys": [{
				"id": "bot-live",
				"role": "agent",
				"token_sha256": %q,
				"concurrency": %d,
				"slow_concurrency": 1,
				"rps": 100,
				"burst": %d,
				"queue_size": %d,
				"queue_wait": %q
			}]
		}`, sha256HexOf(agentTok), conc, burst, qSize, qWait)
		reg, parseErr := ParseAPIKeyRegistry([]byte(manifest), true, ownerAuth, cfg, nil)
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		return reg
	}

	reg1 := buildReg(1, 10, 4, "5s")
	origPool := reg1.byID["bot-live"].pool
	router, err := WithAdmissionWithRegistry(h, nil, "caddy", edgeKey, cfg, reg1)
	if err != nil {
		t.Fatal(err)
	}

	fire := func(rawURL string) int {
		req := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url="+url.QueryEscape(rawURL), nil)
		req.RemoteAddr = "127.0.0.1:49210"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, "198.51.100.120")
		req.Header.Set("Authorization", "Bearer "+agentTok)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}

	// 1. Occupy the single concurrency=1 slot and enqueue waiter #2.
	done1 := make(chan int, 1)
	go func() { done1 <- fire("https://www.douyin.com/video/lease-1") }()
	<-req1Entered

	done2 := make(chan int, 1)
	go func() { done2 <- fire("https://www.douyin.com/video/lease-2") }()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, snap := fetchStatsSnapshot(t, router, edgeKey, ownerTok, "198.51.100.99", "")
		ks := lookupAPIKeySnap(t, snap, "bot-live")
		if ks.Active == 1 && ks.Queued == 1 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}

	// 2. Reload with same concurrency=1 and queue_size=0: active lease & waiter MUST stay intact,
	// and a 3rd arrival MUST be rejected with 429 (proving active=1 was NOT reset to 0!).
	reg2 := buildReg(1, 3, 0, "0s")
	if !ReloadAPIKeys(router, reg2) {
		t.Fatal("ReloadAPIKeys reg2 failed")
	}
	if reg2.byID["bot-live"].pool != origPool {
		t.Fatal("ReloadAPIKeys replaced *keyPool instead of reconfiguring in-place")
	}
	origPool.mu.Lock()
	clampedTokens := origPool.parseRate.tokens
	curBurst := origPool.burst
	origPool.mu.Unlock()
	if curBurst != 3 || clampedTokens > 3 {
		t.Fatalf("expected burst=3 and clamped tokens <= 3, got burst=%v tokens=%v", curBurst, clampedTokens)
	}
	if code := fire("https://www.douyin.com/video/lease-3"); code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 while active lease=1 survived reload, got %d", code)
	}
	select {
	case <-req2Entered:
		t.Fatal("queued waiter #2 woke up prematurely while concurrency remained 1")
	default:
	}

	// 3. Reload raising concurrency=2: queued waiter #2 MUST wake immediately while #1 still runs!
	reg3 := buildReg(2, 10, 4, "5s")
	if !ReloadAPIKeys(router, reg3) {
		t.Fatal("ReloadAPIKeys reg3 failed")
	}
	select {
	case <-req2Entered:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("raising concurrency via ReloadAPIKeys did not wake queued waiter #2")
	}
	_, snapMid := fetchStatsSnapshot(t, router, edgeKey, ownerTok, "198.51.100.99", "")
	if ks := lookupAPIKeySnap(t, snapMid, "bot-live"); ks.Active != 2 || ks.Queued != 0 || ks.ConcurrencyLimit != 2 {
		t.Fatalf("unexpected mid-reload pool state: %+v", ks)
	}

	close(req1Release)
	close(req2Release)
	if code := <-done1; code != http.StatusOK {
		t.Fatalf("req1 status = %d", code)
	}
	if code := <-done2; code != http.StatusOK {
		t.Fatalf("req2 status = %d", code)
	}
	_, snapEnd := fetchStatsSnapshot(t, router, edgeKey, ownerTok, "198.51.100.99", "")
	if ks := lookupAPIKeySnap(t, snapEnd, "bot-live"); ks.Active != 0 || ks.Queued != 0 {
		t.Fatalf("pool leaked slots after reload: %+v", ks)
	}
}

func TestKeyPoolConcurrentAcquireChargeFastReadAndReconfigureRace(t *testing.T) {
	pool := newKeyPool(2, 1, 1.0, 1, 0, 0, &keyCounters{})
	baseNow := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)

	// Drain the initial burst token so concurrent acquireAt calls consistently enter avail < 1.
	rel, retry, canceled := pool.acquireAt(context.Background(), baseNow, false)
	if canceled || retry != 0 || rel == nil {
		t.Fatalf("expected initial acquire to succeed, got retry=%d canceled=%v", retry, canceled)
	}
	rel()

	var wg sync.WaitGroup
	// Reconfigure goroutine toggling agent rps (1 <-> 2) and owner unlimited rps (1 <-> 0).
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 400; i++ {
			switch i % 4 {
			case 0:
				pool.reconfigure(2, 1, 1.0, 1, 0, 0)
			case 1:
				pool.reconfigure(2, 1, 2.0, 1, 0, 0)
			case 2:
				pool.reconfigure(2, 0, 0, 0, 0, 0)
			case 3:
				pool.reconfigure(2, 1, 1.0, 1, 0, 0)
			}
		}
	}()

	for g := 0; g < 6; g++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				if (id+i)%2 == 0 {
					r, retrySec, c := pool.acquireAt(context.Background(), baseNow, false)
					if c {
						t.Errorf("unexpected cancel")
					}
					if r != nil {
						r()
					} else if retrySec < 1 || retrySec >= 86400 {
						t.Errorf("invalid retrySeconds under concurrent reconfigure: %d", retrySec)
					}
				} else {
					retrySec := pool.chargeFastRead(baseNow)
					if retrySec < 0 || retrySec >= 86400 {
						t.Errorf("invalid fast-read retrySeconds under concurrent reconfigure: %d", retrySec)
					}
				}
			}
		}(g)
	}
	wg.Wait()
}
