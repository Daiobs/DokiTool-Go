package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/bearer"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/tiktok"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type stubTikTokFinalizer struct {
	calls     atomic.Int32
	lastBody  []byte
	lastDebug bool
	payload   unified.Object
	status    int
}

func (s *stubTikTokFinalizer) Finalize(_ context.Context, body []byte, debug bool) (unified.Object, int) {
	s.calls.Add(1)
	s.lastBody = append([]byte(nil), body...)
	s.lastDebug = debug
	return s.payload, s.status
}

type failingTikTokExecutor struct {
	hits atomic.Int32
}

func (f *failingTikTokExecutor) Do(context.Context, fetch.Request) (fetch.Response, error) {
	f.hits.Add(1)
	return fetch.Response{StatusCode: http.StatusForbidden}, nil
}

func loadTikTokPhotoFixtureDetail(t *testing.T) json.RawMessage {
	t.Helper()
	htmlBytes, err := os.ReadFile(filepath.Join("..", "platform", "tiktok", "testdata", "photo_post.html"))
	if err != nil {
		t.Fatalf("read photo_post.html: %v", err)
	}
	html := string(htmlBytes)
	start := strings.Index(html, `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"`)
	if start < 0 {
		t.Fatal("missing hydration script")
	}
	gt := strings.IndexByte(html[start:], '>')
	end := strings.Index(html[start+gt+1:], `</script>`)
	rawJSON := strings.TrimSpace(html[start+gt+1 : start+gt+1+end])
	var env struct {
		Scope map[string]json.RawMessage `json:"__DEFAULT_SCOPE__"`
	}
	if err := json.Unmarshal([]byte(rawJSON), &env); err != nil {
		t.Fatalf("unmarshal hydration json: %v", err)
	}
	return env.Scope["webapp.video-detail"]
}

func TestTikTokFinalizeAutoWiredAndGovernance(t *testing.T) {
	now := time.Unix(1791001000, 0).UTC()
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	exec := &failingTikTokExecutor{}
	ttParser := tiktok.New(exec).WithClock(func() time.Time { return now })

	h, err := New(c, map[string]Adapter{
		"tiktok": ttParser,
	}, func() time.Time { return now }, nil)
	if err != nil {
		t.Fatalf("api.New: %v", err)
	}

	photoDetail := loadTikTokPhotoFixtureDetail(t)
	validBody, err := json.Marshal(map[string]any{
		"source_url":     "https://www.tiktok.com/@photo_artist/photo/7399999999999999999",
		"video_detail":   photoDetail,
		"resolved_tiers": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1. Method and schema_version validation.
	recGet := httptest.NewRecorder()
	h.ServeHTTP(recGet, httptest.NewRequest(http.MethodGet, "/api/tiktok/finalize?schema_version=1.0", nil))
	if recGet.Code != http.StatusMethodNotAllowed || recGet.Header().Get("Allow") != "POST" {
		t.Fatalf("GET /api/tiktok/finalize = %d (Allow=%q), want 405 POST", recGet.Code, recGet.Header().Get("Allow"))
	}

	recVer := httptest.NewRecorder()
	h.ServeHTTP(recVer, httptest.NewRequest(http.MethodPost, "/api/tiktok/finalize", bytes.NewReader(validBody)))
	if recVer.Code != http.StatusConflict {
		t.Fatalf("missing schema_version = %d, want 409", recVer.Code)
	}

	// 2. Oversized body (> 512 KiB) fails closed with 400 and Connection: close on HTTP/1.1.
	oversized := bytes.Repeat([]byte("a"), maxTikTokFinalizeBodyBytes+16)
	reqOver := httptest.NewRequest(http.MethodPost, "/api/tiktok/finalize?schema_version=1.0", bytes.NewReader(oversized))
	recOver := httptest.NewRecorder()
	h.ServeHTTP(recOver, reqOver)
	if recOver.Code != http.StatusBadRequest || recOver.Header().Get("Connection") != "close" {
		t.Fatalf("oversized status=%d Connection=%q, want 400 close", recOver.Code, recOver.Header().Get("Connection"))
	}

	// 3. Valid POST /api/tiktok/finalize succeeds with 0 outbound calls and does NOT poison parseCache.
	recOK := httptest.NewRecorder()
	h.ServeHTTP(recOK, httptest.NewRequest(http.MethodPost, "/api/tiktok/finalize?schema_version=1.0", bytes.NewReader(validBody)))
	if recOK.Code != http.StatusOK {
		t.Fatalf("POST /api/tiktok/finalize = %d, body=%s", recOK.Code, recOK.Body.String())
	}
	if exec.hits.Load() != 0 {
		t.Fatalf("POST /api/tiktok/finalize must make 0 outbound calls, got %d", exec.hits.Load())
	}
	var okEnv map[string]any
	if err := json.Unmarshal(recOK.Body.Bytes(), &okEnv); err != nil || okEnv["code"] != "OK" {
		t.Fatalf("unexpected finalize response: %s", recOK.Body.String())
	}

	// Subsequent GET /api/parse for the exact same canonical URL must NOT be served from cache.
	if h.HasFreshCachedParse("/api/parse", "schema_version=1.0&url=https%3A%2F%2Fwww.tiktok.com%2F%40photo_artist%2Fphoto%2F7399999999999999999") {
		t.Fatal("POST /api/tiktok/finalize must never populate parseCache")
	}
	recParse := httptest.NewRecorder()
	h.ServeHTTP(recParse, httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url=https%3A%2F%2Fwww.tiktok.com%2F%40photo_artist%2Fphoto%2F7399999999999999999", nil))
	if recParse.Code != http.StatusForbidden || exec.hits.Load() != 1 {
		t.Fatalf("GET /api/parse must stay independent from finalize (status=%d hits=%d)", recParse.Code, exec.hits.Load())
	}

	// 4. Runtime disabled_platforms kill-switch blocks /api/tiktok/finalize with 503 + Retry-After.
	stub := &stubTikTokFinalizer{
		payload: unified.Object{"schema_version": "1.0", "code": "OK", "data": unified.Object{"platform": "tiktok"}},
		status:  http.StatusOK,
	}
	h.SetTikTokFinalizer(stub)
	cfgDisabled := DefaultRuntimeConfig()
	cfgDisabled.CircuitBreaker.DisabledPlatforms = []string{"tiktok"}
	if !ApplyRuntimeConfig(nil, h, cfgDisabled, true, true) {
		t.Fatal("ApplyRuntimeConfig(disabled tiktok) failed")
	}
	recKill := httptest.NewRecorder()
	h.ServeHTTP(recKill, httptest.NewRequest(http.MethodPost, "/api/tiktok/finalize?schema_version=1.0", bytes.NewReader(validBody)))
	if recKill.Code != http.StatusServiceUnavailable || recKill.Header().Get("Retry-After") == "" {
		t.Fatalf("kill-switch status=%d Retry-After=%q, want 503 with Retry-After", recKill.Code, recKill.Header().Get("Retry-After"))
	}
	if stub.calls.Load() != 0 {
		t.Fatalf("kill-switch leaked finalizer call: calls=%d", stub.calls.Load())
	}

	// Re-enable and verify unset finalizer returns 404.
	if !ApplyRuntimeConfig(nil, h, DefaultRuntimeConfig(), true, true) {
		t.Fatal("ApplyRuntimeConfig(re-enabled) failed")
	}
	h.SetTikTokFinalizer(nil)
	recNil := httptest.NewRecorder()
	h.ServeHTTP(recNil, httptest.NewRequest(http.MethodPost, "/api/tiktok/finalize?schema_version=1.0", bytes.NewReader(validBody)))
	if recNil.Code != http.StatusNotFound {
		t.Fatalf("unset TikTokFinalizer status=%d, want 404", recNil.Code)
	}
}

func TestTikTokFinalizeAdmissionAuthAndRateLimit(t *testing.T) {
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	h, err := New(c, nil, time.Now, nil)
	if err != nil {
		t.Fatal(err)
	}
	stub := &stubTikTokFinalizer{
		payload: unified.Object{"schema_version": "1.0", "code": "OK", "data": unified.Object{"platform": "tiktok"}},
		status:  http.StatusOK,
	}
	h.SetTikTokFinalizer(stub)

	cfg := DefaultAdmissionConfig()
	cfg.Parse.ClientBurst = 1
	cfg.Parse.ClientRPS = 0.01
	cfg.Parse.QueueSize = 0

	douyinOnlyToken := "dkt_test_douyin_only_token_1234567890abcdef"
	tiktokAllowedToken := "dkt_test_tiktok_ok_token_1234567890abcdef"
	manifestBytes, err := json.Marshal(map[string]any{
		"keys": []map[string]any{
			{
				"id":           "agent-douyin",
				"role":         RoleAgent,
				"token_sha256": fmt.Sprintf("%x", bearer.Digest(douyinOnlyToken)),
				"enabled":      true,
				"platforms":    []string{"douyin"},
			},
			{
				"id":           "agent-tiktok",
				"role":         RoleAgent,
				"token_sha256": fmt.Sprintf("%x", bearer.Digest(tiktokAllowedToken)),
				"enabled":      true,
				"platforms":    []string{"tiktok"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	reg, err := ParseAPIKeyRegistry(manifestBytes, true, OwnerAuth{}, cfg, func(string) string { return "" })
	if err != nil {
		t.Fatalf("ParseAPIKeyRegistry: %v", err)
	}
	adm, err := WithAdmissionWithRegistry(h, nil, "direct", "", cfg, reg)
	if err != nil {
		t.Fatalf("WithAdmissionWithRegistry: %v", err)
	}

	// 1. Key restricted to douyin gets 401 unified-v1 error on /api/tiktok/finalize.
	reqDenied := httptest.NewRequest(http.MethodPost, "/api/tiktok/finalize?schema_version=1.0", strings.NewReader(`{}`))
	reqDenied.RemoteAddr = "203.0.113.10:12345"
	reqDenied.Header.Set("Authorization", "Bearer "+douyinOnlyToken)
	recDenied := httptest.NewRecorder()
	adm.ServeHTTP(recDenied, reqDenied)
	if recDenied.Code != http.StatusUnauthorized {
		t.Fatalf("douyin-only key status=%d, want 401 (body=%s)", recDenied.Code, recDenied.Body.String())
	}
	var deniedEnv map[string]any
	if err := json.Unmarshal(recDenied.Body.Bytes(), &deniedEnv); err != nil || deniedEnv["code"] != "INVALID_INPUT" {
		t.Fatalf("401 must return unified-v1 INVALID_INPUT envelope, got %s", recDenied.Body.String())
	}

	// 2. Key allowing tiktok succeeds with 200.
	reqAllowed := httptest.NewRequest(http.MethodPost, "/api/tiktok/finalize?schema_version=1.0", strings.NewReader(`{}`))
	reqAllowed.RemoteAddr = "203.0.113.10:12346"
	reqAllowed.Header.Set("Authorization", "Bearer "+tiktokAllowedToken)
	recAllowed := httptest.NewRecorder()
	adm.ServeHTTP(recAllowed, reqAllowed)
	if recAllowed.Code != http.StatusOK {
		t.Fatalf("tiktok-allowed key status=%d, want 200 (body=%s)", recAllowed.Code, recAllowed.Body.String())
	}

	// 3. Anonymous burst 1 succeeds; 2nd immediate request hits 429 unified-v1 envelope.
	reqAnon1 := httptest.NewRequest(http.MethodPost, "/api/tiktok/finalize?schema_version=1.0", strings.NewReader(`{}`))
	reqAnon1.RemoteAddr = "203.0.113.20:10001"
	recAnon1 := httptest.NewRecorder()
	adm.ServeHTTP(recAnon1, reqAnon1)
	if recAnon1.Code != http.StatusOK {
		t.Fatalf("anon #1 status=%d, want 200", recAnon1.Code)
	}

	reqAnon2 := httptest.NewRequest(http.MethodPost, "/api/tiktok/finalize?schema_version=1.0", strings.NewReader(`{}`))
	reqAnon2.RemoteAddr = "203.0.113.20:10002"
	recAnon2 := httptest.NewRecorder()
	adm.ServeHTTP(recAnon2, reqAnon2)
	if recAnon2.Code != http.StatusTooManyRequests || recAnon2.Header().Get("Retry-After") == "" {
		t.Fatalf("anon #2 status=%d Retry-After=%q, want 429 with Retry-After", recAnon2.Code, recAnon2.Header().Get("Retry-After"))
	}
	var rateEnv map[string]any
	if err := json.Unmarshal(recAnon2.Body.Bytes(), &rateEnv); err != nil || rateEnv["code"] != "RATE_LIMITED" {
		t.Fatalf("429 must return unified-v1 RATE_LIMITED envelope, got %s", recAnon2.Body.String())
	}
}
