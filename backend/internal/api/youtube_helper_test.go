package api

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type stubYouTubeHelper struct {
	ctxPayload unified.Object
	ctxStatus  int
	cached     bool
	finPayload unified.Object
	finStatus  int
	lastBody   []byte
	lastDebug  bool
}

func (s *stubYouTubeHelper) Context(context.Context) (unified.Object, int) {
	return s.ctxPayload, s.ctxStatus
}

func (s *stubYouTubeHelper) HasCachedContext() bool {
	return s.cached
}

func (s *stubYouTubeHelper) Finalize(_ context.Context, body []byte, debug bool) (unified.Object, int) {
	s.lastBody = append([]byte(nil), body...)
	s.lastDebug = debug
	return s.finPayload, s.finStatus
}

func TestYouTubeHelperRoutesDisabledByDefaultAndUnchangedParse(t *testing.T) {
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Register(catalog.YouTubePlatform()); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	parseCalled := false
	h, err := New(c, map[string]Adapter{
		"youtube": AdapterFunc(func(_ context.Context, source string, ts int64) (unified.Object, error) {
			parseCalled = true
			return unified.FinalizeData(unified.Object{
				"platform":        "youtube",
				"content_id":      "I9JvDaciaFk",
				"source_url":      source,
				"default_item_id": "video-1",
				"items": unified.Array{
					unified.Object{
						"id":          "video-1",
						"type":        "video",
						"index":       int64(1),
						"default":     nil,
						"resolve_url": unified.ResolveURL(source, "video-1"),
						"variants": unified.Array{
							unified.Object{
								"id":    "v-18",
								"label": "360p",
								"metadata": unified.Object{
									"evidence":    "upstream",
									"has_audio":   true,
									"container":   "mp4",
									"extension":   "mp4",
									"mime_type":   "video/mp4",
									"width":       int64(640),
									"height":      int64(360),
									"video_codec": "avc1.42001E",
									"audio_codec": "mp4a.40.2",
								},
								"delivery": unified.Object{
									"kind":    "file",
									"sources": unified.Sources(unified.Array{"https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?itag=18"}, ts),
								},
							},
						},
					},
				},
				"generated_at": "2026-11-09T12:00:00Z",
			}, ts), nil
		}),
	}, func() time.Time { return now }, nil)
	if err != nil {
		t.Fatal(err)
	}

	// 1. With helper disabled, /api/youtube/context and /api/youtube/finalize return 404.
	reqCtx := httptest.NewRequest(http.MethodGet, "/api/youtube/context?schema_version=1.0", nil)
	recCtx := httptest.NewRecorder()
	h.ServeHTTP(recCtx, reqCtx)
	if recCtx.Code != http.StatusNotFound {
		t.Fatalf("GET /api/youtube/context status = %d, want 404", recCtx.Code)
	}

	reqFin := httptest.NewRequest(http.MethodPost, "/api/youtube/finalize?schema_version=1.0", strings.NewReader(`{}`))
	recFin := httptest.NewRecorder()
	h.ServeHTTP(recFin, reqFin)
	if recFin.Code != http.StatusNotFound {
		t.Fatalf("POST /api/youtube/finalize status = %d, want 404", recFin.Code)
	}

	// 2. Existing /api/parse for YouTube remains unchanged.
	reqParse := httptest.NewRequest(http.MethodGet, "/api/parse?schema_version=1.0&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DI9JvDaciaFk", nil)
	recParse := httptest.NewRecorder()
	h.ServeHTTP(recParse, reqParse)
	if recParse.Code != http.StatusOK || !parseCalled {
		t.Fatalf("GET /api/parse status = %d, parseCalled = %v, body = %s", recParse.Code, parseCalled, recParse.Body.String())
	}
}

func TestYouTubeHelperRoutesEnabledAndParseAdmission(t *testing.T) {
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	h, err := New(c, nil, time.Now, nil)
	if err != nil {
		t.Fatal(err)
	}
	stub := &stubYouTubeHelper{
		ctxPayload: unified.Object{
			"schema_version": "1.0",
			"code":           "OK",
			"data": unified.Object{
				"player_id":           "a5c2aafe",
				"signature_timestamp": int64(20760),
				"client":              unified.Object{"name": "TVHTML5", "version": "7.20260707.07.00"},
				"expires_at":          "2026-11-09T18:00:00Z",
			},
		},
		ctxStatus: http.StatusOK,
		finPayload: unified.Object{
			"schema_version": "1.0",
			"code":           "OK",
			"data":           unified.Object{"platform": "youtube"},
		},
		finStatus: http.StatusOK,
	}
	h.SetYouTubeHelper(stub)

	// Method checks
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/youtube/context?schema_version=1.0", nil))
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET" {
		t.Fatalf("POST /api/youtube/context status = %d Allow = %q", rec.Code, rec.Header().Get("Allow"))
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/youtube/finalize?schema_version=1.0", nil))
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "POST" {
		t.Fatalf("GET /api/youtube/finalize status = %d Allow = %q", rec.Code, rec.Header().Get("Allow"))
	}

	// Body limit 512 KiB check at HTTP boundary
	overLimit := bytes.Repeat([]byte("a"), maxYouTubeFinalizeBodyBytes+1)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/youtube/finalize?schema_version=1.0", bytes.NewReader(overLimit)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("oversized finalize body status = %d, want 400", rec.Code)
	}

	// SlowParse admission pool enforcement:
	// 1) Cold cache (HasCachedContext() == false): GET /api/youtube/context consumes a SlowParse token,
	//    so an immediate POST /api/youtube/finalize with SlowParse.ClientBurst=1 hits 429,
	//    while Fast Pool (Parse) remains completely untouched.
	cfg := DefaultAdmissionConfig()
	cfg.SlowParse.ClientBurst = 1
	cfg.SlowParse.ClientRPS = 0.1
	entry, err := WithAdmissionConfig(h, nil, "direct", "", cfg)
	if err != nil {
		t.Fatal(err)
	}

	stub.cached = false
	req1 := httptest.NewRequest(http.MethodGet, "/api/youtube/context?schema_version=1.0", nil)
	req1.RemoteAddr = "203.0.113.10:12345"
	rec1 := httptest.NewRecorder()
	entry.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("cold context request status = %d, want 200", rec1.Code)
	}

	req2 := httptest.NewRequest(http.MethodPost, "/api/youtube/finalize?schema_version=1.0", strings.NewReader(`{}`))
	req2.RemoteAddr = "203.0.113.10:12345"
	rec2 := httptest.NewRecorder()
	entry.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusTooManyRequests {
		t.Fatalf("finalize after cold context status = %d, want 429", rec2.Code)
	}

	// 2) Warm cache (HasCachedContext() == true): GET /api/youtube/context uses Catalog budget
	//    instead of consuming a Parse token, so one full YouTube parse (context + finalize)
	//    consumes only 1 Parse token and succeeds under Parse.ClientBurst=1.
	stub.cached = true
	req3 := httptest.NewRequest(http.MethodGet, "/api/youtube/context?schema_version=1.0", nil)
	req3.RemoteAddr = "203.0.113.11:12345"
	rec3 := httptest.NewRecorder()
	entry.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusOK {
		t.Fatalf("warm context request status = %d, want 200", rec3.Code)
	}

	req4 := httptest.NewRequest(http.MethodPost, "/api/youtube/finalize?schema_version=1.0", strings.NewReader(`{}`))
	req4.RemoteAddr = "203.0.113.11:12345"
	rec4 := httptest.NewRecorder()
	entry.ServeHTTP(rec4, req4)
	if rec4.Code != http.StatusOK {
		t.Fatalf("finalize after warm context status = %d, want 200", rec4.Code)
	}

	req5 := httptest.NewRequest(http.MethodPost, "/api/youtube/finalize?schema_version=1.0", strings.NewReader(`{}`))
	req5.RemoteAddr = "203.0.113.11:12345"
	rec5 := httptest.NewRecorder()
	entry.ServeHTTP(rec5, req5)
	if rec5.Code != http.StatusTooManyRequests {
		t.Fatalf("second finalize after warm context status = %d, want 429", rec5.Code)
	}
}

func TestYouTubeFinalizeBodyReadDeadlineOversizedCloseAndSlowSlotRelease(t *testing.T) {
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	h, err := New(c, nil, func() time.Time { return now }, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := h.youtubeFinalizeReadTimeout(); got != 5*time.Second {
		t.Fatalf("default youtubeFinalizeReadTimeout() = %v, want 5s", got)
	}
	// Shorten read deadline in unit test so slow-body timeout completes well under 200ms.
	h.finalizeReadTimeout = 50 * time.Millisecond

	stub := &stubYouTubeHelper{
		finPayload: unified.Object{
			"schema_version": "1.0",
			"code":           "OK",
			"data": unified.Object{
				"platform":        "youtube",
				"content_id":      "I9JvDaciaFk",
				"source_url":      "https://www.youtube.com/watch?v=I9JvDaciaFk",
				"default_item_id": "video-1",
				"items": unified.Array{
					unified.Object{
						"id":          "video-1",
						"type":        "video",
						"index":       int64(1),
						"default":     nil,
						"resolve_url": unified.ResolveURL("https://www.youtube.com/watch?v=I9JvDaciaFk", "video-1"),
						"variants": unified.Array{
							unified.Object{
								"id":    "v-18",
								"label": "360p",
								"metadata": unified.Object{
									"evidence":  "upstream",
									"has_audio": true,
									"container": "mp4",
									"extension": "mp4",
									"mime_type": "video/mp4",
								},
								"delivery": unified.Object{
									"kind":    "file",
									"sources": unified.Sources(unified.Array{"https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?itag=18"}, now.Unix()),
								},
							},
						},
					},
				},
				"generated_at": "2026-11-17T12:00:00Z",
			},
		},
		finStatus: http.StatusOK,
	}
	h.SetYouTubeHelper(stub)

	// (b-unit) HTTP/1.1 >512 KiB request sets r.Close = true and Connection: close with 400 INVALID_INPUT.
	overReq := httptest.NewRequest(http.MethodPost, "/api/youtube/finalize?schema_version=1.0", bytes.NewReader(bytes.Repeat([]byte("x"), maxYouTubeFinalizeBodyBytes+1)))
	overRec := httptest.NewRecorder()
	h.ServeHTTP(overRec, overReq)
	if overRec.Code != http.StatusBadRequest || !overReq.Close || overRec.Header().Get("Connection") != "close" {
		t.Fatalf("HTTP/1.1 oversized finalize: code=%d r.Close=%v Connection=%q", overRec.Code, overReq.Close, overRec.Header().Get("Connection"))
	}
	overEnv, decErr := unified.Decode(overRec.Body.Bytes())
	if decErr != nil || unified.ValidateEnvelopeAt(overEnv, now.Unix()) != nil || unified.Str(overEnv["code"]) != "INVALID_INPUT" {
		t.Fatalf("unexpected oversized error envelope: err=%v body=%s", decErr, overRec.Body.String())
	}

	// Real TCP server with single-slot SlowParse admission (no queue) to prove slow-slot release.
	cfg := DefaultAdmissionConfig()
	cfg.SlowParse.GlobalConcurrency = 1
	cfg.SlowParse.ClientConcurrency = 1
	cfg.SlowParse.QueueWait = 0
	cfg.SlowParse.QueueSize = 0
	cfg.SlowParse.ClientBurst = 10
	cfg.SlowParse.ClientRPS = 10
	cfg.SlowParse.GlobalBurst = 10
	cfg.SlowParse.GlobalRPS = 10
	const edgeKey = testEdgeKey
	entry, err := WithAdmissionConfig(h, nil, "caddy", edgeKey, cfg)
	if err != nil {
		t.Fatal(err)
	}
	adm := entry.(*admission)

	finished := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entry.ServeHTTP(w, r)
		finished <- struct{}{}
	}))
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")

	assertHealthyFinalize := func(clientIP string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/youtube/finalize?schema_version=1.0", strings.NewReader(`{"ok":true}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, clientIP)
		req.Header.Set("Content-Type", "application/json")
		client := srv.Client()
		client.Timeout = time.Second
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("healthy finalize failed: %v", err)
		}
		defer resp.Body.Close()
		_, _ = io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("healthy finalize status = %d, want 200", resp.StatusCode)
		}
		<-finished
	}

	// (a) Slow trickling POST /api/youtube/finalize body times out promptly (<200ms) and releases slow slot.
	slowStart := time.Now()
	connSlow, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connSlow.Close()
	_ = connSlow.SetDeadline(time.Now().Add(2 * time.Second))
	fmt.Fprintf(connSlow, "POST /api/youtube/finalize?schema_version=1.0 HTTP/1.1\r\nHost: test\r\n%s: %s\r\n%s: 198.51.100.20\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{", edgeHeader, edgeKey, clientHeader)

	respSlow, err := http.ReadResponse(bufio.NewReader(connSlow), nil)
	if err != nil {
		t.Fatalf("slow finalize read response failed: %v", err)
	}
	slowBody, _ := io.ReadAll(respSlow.Body)
	respSlow.Body.Close()
	slowElapsed := time.Since(slowStart)
	if slowElapsed >= 200*time.Millisecond {
		t.Fatalf("slow finalize took %v, want <200ms", slowElapsed)
	}
	if respSlow.StatusCode != http.StatusBadRequest || !respSlow.Close {
		t.Fatalf("slow finalize status=%d Close=%v body=%s", respSlow.StatusCode, respSlow.Close, string(slowBody))
	}
	slowEnv, err := unified.Decode(slowBody)
	if err != nil || unified.ValidateEnvelopeAt(slowEnv, now.Unix()) != nil || unified.Str(slowEnv["code"]) != "INVALID_INPUT" {
		t.Fatalf("invalid slow finalize 400 envelope: err=%v body=%s", err, string(slowBody))
	}
	select {
	case <-finished:
	case <-time.After(150 * time.Millisecond):
		t.Fatal("slow finalize handler did not exit and release slow slot promptly")
	}
	adm.slow.mu.Lock()
	slowActiveAfterTimeout := adm.slow.active
	adm.slow.mu.Unlock()
	if slowActiveAfterTimeout != 0 {
		t.Fatalf("slow pool active = %d after timeout, want 0", slowActiveAfterTimeout)
	}
	assertHealthyFinalize("198.51.100.21")

	// (b-tcp) >512 KiB HTTP/1.1 body (even with stalled trailing bytes after 512 KiB + 1)
	// returns 400 INVALID_INPUT with Connection: close and releases the slow slot immediately.
	h.finalizeReadTimeout = 5 * time.Second
	overStart := time.Now()
	connOver, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connOver.Close()
	_ = connOver.SetDeadline(time.Now().Add(2 * time.Second))
	declaredLen := maxYouTubeFinalizeBodyBytes + 65536
	fmt.Fprintf(connOver, "POST /api/youtube/finalize?schema_version=1.0 HTTP/1.1\r\nHost: test\r\n%s: %s\r\n%s: 198.51.100.22\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n", edgeHeader, edgeKey, clientHeader, declaredLen)
	if _, err := connOver.Write(bytes.Repeat([]byte("z"), maxYouTubeFinalizeBodyBytes+1)); err != nil {
		t.Fatalf("write oversized prefix failed: %v", err)
	}
	respOver, err := http.ReadResponse(bufio.NewReader(connOver), nil)
	if err != nil {
		t.Fatalf("oversized TCP finalize read response failed: %v", err)
	}
	overTCPBody, _ := io.ReadAll(respOver.Body)
	respOver.Body.Close()
	if overElapsed := time.Since(overStart); overElapsed >= 500*time.Millisecond {
		t.Fatalf("oversized TCP finalize stalled draining body (%v), want immediate close", overElapsed)
	}
	if respOver.StatusCode != http.StatusBadRequest || !respOver.Close {
		t.Fatalf("oversized TCP finalize status=%d Close=%v", respOver.StatusCode, respOver.Close)
	}
	overTCPEnv, err := unified.Decode(overTCPBody)
	if err != nil || unified.ValidateEnvelopeAt(overTCPEnv, now.Unix()) != nil || unified.Str(overTCPEnv["code"]) != "INVALID_INPUT" {
		t.Fatalf("invalid oversized TCP 400 envelope: err=%v body=%s", err, string(overTCPBody))
	}
	select {
	case <-finished:
	case <-time.After(150 * time.Millisecond):
		t.Fatal("oversized finalize handler did not exit and release slow slot promptly")
	}
	adm.slow.mu.Lock()
	slowActiveAfterOver := adm.slow.active
	adm.slow.mu.Unlock()
	if slowActiveAfterOver != 0 {
		t.Fatalf("slow pool active = %d after oversized body, want 0", slowActiveAfterOver)
	}
	assertHealthyFinalize("198.51.100.23")
}
