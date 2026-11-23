package shresolver

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/bilibili"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const (
	biliTestBVID      = "BV1234567890"
	biliTestCID       = int64(101)
	biliTestPlayQuery = "https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=3&player=3&qn=112&bvid=BV1234567890&cid=101&platform=html5&high_quality=1"
)

// Frozen pre-#120 v2 wire contracts with DisallowUnknownFields() to prove
// bidirectional rolling-upgrade compatibility without unknown-field breakage.
type frozenV2PullJob struct {
	Protocol   int    `json:"protocol,omitempty"`
	TaskID     string `json:"task_id"`
	AttemptID  string `json:"attempt_id"`
	VideoID    string `json:"video_id,omitempty"`
	AwemeID    string `json:"aweme_id,omitempty"`
	DeadlineMS int64  `json:"deadline_ms"`
}

type frozenV2PullResult struct {
	frozenV2PullJob
	Result json.RawMessage `json:"result"`
}

type frozenV2PullBroker struct {
	token   string
	mu      sync.Mutex
	waiting []chan frozenV2PullJob
	pending map[string]chan WorkResponse
}

func newFrozenV2PullBroker(token string) *frozenV2PullBroker {
	return &frozenV2PullBroker{
		token:   token,
		pending: map[string]chan WorkResponse{},
	}
}

func (b *frozenV2PullBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+b.token || r.Method != http.MethodPost {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	switch r.URL.EscapedPath() {
	case ClaimPath:
		if r.ContentLength != 0 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.Header.Get(ProtocolHeader) != "2" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		ch := make(chan frozenV2PullJob, 1)
		b.mu.Lock()
		b.waiting = append(b.waiting, ch)
		b.mu.Unlock()
		select {
		case job := <-ch:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(job)
		case <-r.Context().Done():
			w.WriteHeader(http.StatusNoContent)
		}
	case ResultPath:
		var res frozenV2PullResult
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxResponseBytes+512))
		dec.DisallowUnknownFields()
		if dec.Decode(&res) != nil || dec.Decode(&struct{}{}) != io.EOF || len(res.Result) == 0 || len(res.Result) > maxResponseBytes {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var parsed WorkResponse
		inner := json.NewDecoder(bytes.NewReader(res.Result))
		inner.UseNumber()
		inner.DisallowUnknownFields()
		if inner.Decode(&parsed) != nil || inner.Decode(&struct{}{}) != io.EOF || parsed.Protocol != ProtocolV2 || parsed.AwemeID != res.AwemeID {
			w.WriteHeader(http.StatusConflict)
			return
		}
		b.mu.Lock()
		out := b.pending[res.TaskID]
		delete(b.pending, res.TaskID)
		b.mu.Unlock()
		if out == nil {
			w.WriteHeader(http.StatusConflict)
			return
		}
		out <- parsed
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (b *frozenV2PullBroker) waitClaim(t *testing.T) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		b.mu.Lock()
		n := len(b.waiting)
		b.mu.Unlock()
		if n >= 1 {
			return
		}
		select {
		case <-deadline:
			t.Fatal("timed out waiting for frozen v2 broker claim")
		case <-time.After(time.Millisecond):
		}
	}
}

func (b *frozenV2PullBroker) resolveV2(ctx context.Context, awemeID string) (WorkResponse, error) {
	b.mu.Lock()
	if len(b.waiting) == 0 {
		b.mu.Unlock()
		return WorkResponse{}, errUnavailable
	}
	ch := b.waiting[0]
	b.waiting = b.waiting[1:]
	var ids [32]byte
	rand.Read(ids[:])
	job := frozenV2PullJob{
		Protocol:   ProtocolV2,
		TaskID:     hex.EncodeToString(ids[:16]),
		AttemptID:  hex.EncodeToString(ids[16:]),
		AwemeID:    awemeID,
		DeadlineMS: time.Now().Add(8 * time.Second).UnixMilli(),
	}
	out := make(chan WorkResponse, 1)
	b.pending[job.TaskID] = out
	b.mu.Unlock()
	ch <- job
	select {
	case <-ctx.Done():
		return WorkResponse{}, ctx.Err()
	case r := <-out:
		return r, nil
	}
}

// runFrozenV2WorkerOnce simulates a pre-#120 Shanghai PullWorker that advertises
// ProtocolHeader: 2 (without TasksHeader) and decodes PullJob with DisallowUnknownFields()
// onto frozenV2PullJob.
func runFrozenV2WorkerOnce(ctx context.Context, control, detail fetch.Executor, origin, token string, p originalProbe) error {
	post := func(path string, body []byte) (fetch.Response, error) {
		target := origin + path
		h := http.Header{"Authorization": {"Bearer " + token}, "Content-Type": {"application/json"}}
		if path == ClaimPath {
			h.Set(ProtocolHeader, "2")
		}
		return control.Do(ctx, fetch.Request{
			URL:    target,
			Method: http.MethodPost,
			Body:   body,
			Header: h,
			Policy: fetch.Policy{Purpose: "douyin-original-pull", Timeout: 10 * time.Second, MaxBytes: 1024, MaxHeaderBytes: 8192, AllowedURL: func(raw string) bool { return raw == target }},
		})
	}
	res, err := post(ClaimPath, nil)
	if err != nil {
		return err
	}
	if res.StatusCode == http.StatusNoContent {
		return nil
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected claim status %d", res.StatusCode)
	}
	var job frozenV2PullJob
	d := json.NewDecoder(bytes.NewReader(res.Body))
	d.DisallowUnknownFields()
	if d.Decode(&job) != nil || d.Decode(&struct{}{}) != io.EOF || job.Protocol != ProtocolV2 || !douyin.ValidAwemeID(job.AwemeID) {
		return fmt.Errorf("frozen v2 worker rejected job JSON: %s", string(res.Body))
	}
	out, err := resolveWork(ctx, detail, p, job.AwemeID)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(frozenV2PullResult{frozenV2PullJob: job, Result: raw})
	ack, err := post(ResultPath, body)
	if err != nil {
		return err
	}
	if ack.StatusCode != http.StatusNoContent {
		return fmt.Errorf("unexpected result ack %d", ack.StatusCode)
	}
	return nil
}

// newFrozenV2DirectServer simulates a pre-#120 Shanghai direct HTTP server with
// DisallowUnknownFields() accepting only {protocol, video_id, aweme_id}.
func newFrozenV2DirectServer(token string, detail fetch.Executor, p originalProbe) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != Path || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var req struct {
			Protocol int    `json:"protocol"`
			VideoID  string `json:"video_id"`
			AwemeID  string `json:"aweme_id"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512))
		dec.DisallowUnknownFields()
		if dec.Decode(&req) != nil || dec.Decode(&struct{}{}) != io.EOF {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if req.Protocol != ProtocolV2 || req.VideoID != "" || !douyin.ValidAwemeID(req.AwemeID) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		out, err := resolveWork(r.Context(), detail, p, req.AwemeID)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})
}

func sampleBilibiliPlayBody(deadlineUnix int64) []byte {
	exp := fmt.Sprintf("%010d", deadlineUnix)
	return []byte(`{
		"code": 0,
		"data": {
			"quality": 64,
			"durl": [{
				"url": "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/01/101/101-1-64.mp4?deadline=` + exp + `&upsig=dom1",
				"backup_url": ["https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/00/01/101/101-1-64.mp4?deadline=` + exp + `&upsig=dom2"]
			}],
			"dash": {
				"video": [{"id": 80, "codecid": 7, "codecs": "avc1.640028", "baseUrl": "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/01/101/101-1-30080.m4s?deadline=` + exp + `&upsig=dv1"}],
				"audio": [{"id": 30280, "codecid": 0, "codecs": "mp4a.40.2", "base_url": "https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/00/01/101/101-1-30280.m4s?deadline=` + exp + `&upsig=da1"}]
			}
		}
	}`)
}

func TestStrictBilibiliExecutorOutboundBoundary(t *testing.T) {
	var upstreamCalled atomic.Int32
	guarded := wrapBilibiliExecutor(resolveExecutor(func(_ context.Context, _ fetch.Request) (fetch.Response, error) {
		upstreamCalled.Add(1)
		return fetch.Response{StatusCode: http.StatusOK, Body: []byte(`{}`)}, nil
	}))

	blocked := []fetch.Request{
		{URL: "https://www.bilibili.com/video/BV1234567890/", Method: http.MethodGet},
		{URL: "http://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=101", Method: http.MethodGet},
		{URL: "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1234567890&cid=101", Method: http.MethodGet},
		{URL: biliTestPlayQuery, Method: http.MethodPost},
		{URL: biliTestPlayQuery, Method: http.MethodGet, Body: []byte("x")},
		{URL: biliTestPlayQuery, Method: http.MethodGet, Policy: fetch.Policy{FollowRedirects: true}},
		{URL: biliTestPlayQuery, Method: http.MethodGet, Header: http.Header{"Cookie": {"SESSDATA=secret"}}},
		{URL: biliTestPlayQuery, Method: http.MethodGet, Header: http.Header{"cookie": {"SESSDATA=secret"}}},
	}
	for i, req := range blocked {
		if _, err := guarded.Do(t.Context(), req); !errors.Is(err, fetch.ErrPolicy) {
			t.Fatalf("case %d (%s %s): got err=%v, want fetch.ErrPolicy", i, req.Method, req.URL, err)
		}
	}
	if upstreamCalled.Load() != 0 {
		t.Fatalf("upstreamCalled = %d, want 0", upstreamCalled.Load())
	}

	okReq := fetch.Request{
		URL:    biliTestPlayQuery,
		Method: http.MethodGet,
		Header: http.Header{"Accept-Encoding": {"gzip,deflate"}, "User-Agent": {""}},
	}
	if _, err := guarded.Do(t.Context(), okReq); err != nil || upstreamCalled.Load() != 1 {
		t.Fatalf("valid official request rejected: err=%v calls=%d", err, upstreamCalled.Load())
	}
}

func TestBilibiliRollingUpgradeFourWayInterop(t *testing.T) {
	const origin = "https://japan.example.org"
	shOriginalProbe := resolverFunc(func(_ context.Context, u string) ([]unified.Object, error) {
		if u != douyin.OriginalPlayURL(wireVideo) {
			return nil, fmt.Errorf("unexpected original dispatcher %q", u)
		}
		return []unified.Object{deliveryRow("v26-cold.douyinvod.com", "objectA", "a")}, nil
	})
	shExec := resolveExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		switch req.Policy.Purpose {
		case "douyin-detail":
			return fetch.Response{StatusCode: 200, Body: interopDetailBody("v26-web.douyinvod.com", "v11-weba.douyinvod.com")}, nil
		case "bilibili-play":
			if req.URL != biliTestPlayQuery || req.Header.Get("Cookie") != "" {
				return fetch.Response{}, fmt.Errorf("unexpected bilibili request: %s", req.URL)
			}
			return fetch.Response{StatusCode: 200, Body: sampleBilibiliPlayBody(time.Now().Add(2 * time.Hour).Unix())}, nil
		default:
			return fetch.Response{}, fmt.Errorf("unexpected purpose %q", req.Policy.Purpose)
		}
	})

	// 1. Pull mode: New PullWorker (advertising douyin,bilibili) + Frozen Old V2 PullBroker (Old Japan).
	t.Run("pull-new-shanghai-old-japan", func(t *testing.T) {
		oldBroker := newFrozenV2PullBroker(wireToken)
		srv := httptest.NewTLSServer(oldBroker)
		defer srv.Close()

		worker, err := NewPullWorkerWithDetail(origin, wireToken, controlTransportForTLS(srv, origin), shExec, shOriginalProbe)
		if err != nil {
			t.Fatal(err)
		}
		workerDone := make(chan error, 1)
		go func() {
			_, runErr := worker.runOnce(t.Context())
			workerDone <- runErr
		}()
		oldBroker.waitClaim(t)

		got, err := oldBroker.resolveV2(t.Context(), interopAwemeID)
		if err != nil {
			t.Fatalf("old Japan v2 broker failed against new Shanghai worker: %v", err)
		}
		if got.AwemeID != interopAwemeID || len(got.Renditions) != 2 || len(got.Candidates) != 1 {
			t.Fatalf("unexpected Douyin WorkResponse on old Japan: %+v", got)
		}
		if err := <-workerDone; err != nil {
			t.Fatalf("new worker runOnce returned error against old Japan: %v", err)
		}
	})

	// 2. Pull mode: Frozen Old V2 PullWorker (Old Shanghai) + New PullBroker (New Japan).
	t.Run("pull-old-shanghai-new-japan", func(t *testing.T) {
		newBroker, err := NewPullBroker(wireToken)
		if err != nil {
			t.Fatal(err)
		}
		newBroker.WithBilibili(true)
		newBroker.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
		}
		srv := httptest.NewTLSServer(newBroker)
		defer srv.Close()
		control := controlTransportForTLS(srv, origin)

		workerDone := make(chan error, 1)
		go func() {
			workerDone <- runFrozenV2WorkerOnce(t.Context(), control, shExec, origin, wireToken, shOriginalProbe)
		}()
		waitForPullCount(t, newBroker, 1)

		// Bilibili must fail open immediately (0ms queue wait) without poisoning Old Shanghai's waiting claim!
		start := time.Now()
		if _, err := newBroker.ResolveBilibili(t.Context(), biliTestBVID, biliTestCID); !errors.Is(err, errUnavailable) {
			t.Fatalf("expected errUnavailable for Bilibili against old Shanghai worker, got %v", err)
		}
		if elapsed := time.Since(start); elapsed >= 150*time.Millisecond {
			t.Fatalf("ResolveBilibili waited %v against old worker, want immediate fail-open (<150ms)", elapsed)
		}

		// The very same parked Old Shanghai claim must still serve Douyin V2 immediately!
		work, err := newBroker.ResolveWork(t.Context(), interopAwemeID)
		if err != nil || work == nil || len(work.Renditions) != 2 {
			t.Fatalf("Douyin ResolveWork failed after Bilibili fail-open: work=%+v err=%v", work, err)
		}
		if err := <-workerDone; err != nil {
			t.Fatalf("frozen old v2 worker failed: %v", err)
		}

		plat := newBroker.PlatformStatsSnapshot()
		if plat.Bilibili.Fallbacks != 1 || plat.Bilibili.Hits != 0 || plat.Bilibili.QueueWaits != 0 {
			t.Fatalf("unexpected Bilibili platform stats: %+v", plat.Bilibili)
		}
		if plat.Douyin.Hits != 1 || plat.Douyin.Fallbacks != 0 {
			t.Fatalf("unexpected Douyin platform stats: %+v", plat.Douyin)
		}
	})

	// 3. Direct HTTP mode: New Shanghai server + Old Japan V1/V2 requests.
	t.Run("direct-new-shanghai-old-japan", func(t *testing.T) {
		newHandler, err := NewHandlerWithDetail(wireToken, shExec, shOriginalProbe)
		if err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewTLSServer(newHandler)
		defer srv.Close()

		c, err := NewClient(srv.URL+Path, wireToken, fetch.New())
		if err != nil {
			t.Fatal(err)
		}
		pool := x509.NewCertPool()
		pool.AddCert(srv.Certificate())
		c.local.Transport.(*http.Transport).TLSClientConfig.RootCAs = pool
		c.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
		}

		if rows, err := c.ResolveOriginal(t.Context(), wireVideo); err != nil || len(rows) != 1 {
			t.Fatalf("legacy V1 ResolveOriginal failed against new server: rows=%v err=%v", rows, err)
		}
		if work, err := c.ResolveWork(t.Context(), interopAwemeID); err != nil || work == nil || len(work.Renditions) != 2 {
			t.Fatalf("legacy V2 ResolveWork failed against new server: work=%+v err=%v", work, err)
		}
	})

	// 4. Direct HTTP mode: Frozen Old V2 Shanghai server + New Japan Client (Bilibili falls back, Douyin works).
	t.Run("direct-old-shanghai-new-japan", func(t *testing.T) {
		srv := httptest.NewTLSServer(newFrozenV2DirectServer(wireToken, shExec, shOriginalProbe))
		defer srv.Close()

		c, err := NewClient(srv.URL+Path, wireToken, fetch.New())
		if err != nil {
			t.Fatal(err)
		}
		c.WithBilibili(true)
		pool := x509.NewCertPool()
		pool.AddCert(srv.Certificate())
		c.local.Transport.(*http.Transport).TLSClientConfig.RootCAs = pool
		c.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
		}

		if _, err := c.ResolveBilibili(t.Context(), biliTestBVID, biliTestCID); !errors.Is(err, errUnavailable) {
			t.Fatalf("expected errUnavailable from old direct server on Bilibili, got %v", err)
		}
		if work, err := c.ResolveWork(t.Context(), interopAwemeID); err != nil || work == nil || len(work.Renditions) != 2 {
			t.Fatalf("Douyin ResolveWork failed against old direct server: work=%+v err=%v", work, err)
		}
		plat := c.PlatformStatsSnapshot()
		if plat.Bilibili.Fallbacks != 1 || plat.Bilibili.Hits != 0 || plat.Douyin.Hits != 1 {
			t.Fatalf("unexpected direct platform stats: %+v", plat)
		}
	})
}

func TestBilibiliUntrustedWireValidationDNSDedupAndQueueWait(t *testing.T) {
	const (
		origin  = "https://japan.example.org"
		nowUnix = int64(1800000000)
		expGood = int64(1800007200)
	)

	var dnsCalls atomic.Int32
	validator := responseValidator{
		now: func() time.Time { return time.Unix(nowUnix, 0) },
		lookup: func(_ context.Context, _, host string) ([]netip.Addr, error) {
			dnsCalls.Add(1)
			if strings.Contains(host, "private") {
				return []netip.Addr{netip.MustParseAddr("10.0.0.8")}, nil
			}
			return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
		},
	}

	rawMixed, err := json.Marshal(bilibili.ShanghaiPlay{
		BVID:        biliTestBVID,
		CID:         biliTestCID,
		DURLQuality: 64,
		DURLPieces: []bilibili.ShanghaiDURLPiece{{
			URLs: []string{
				"http://upos-sz-mirrorcos.bilivideo.com/1.mp4?deadline=1800007200",
				"https://cn-zjhz-cu-01-01.bilivideo.com/cn-edge.mp4?deadline=1800007200",
				"https://xy123.mcdn.bilivideo.com/mcdn.mp4?deadline=1800007200",
				"https://bilivideo.com/apex.mp4?deadline=1800007200",
				"https://evilbilivideo.com/spoof.mp4?deadline=1800007200",
				"https://upos-expired.bilivideo.com/exp.mp4?deadline=1800000000",
				"https://upos-private.bilivideo.com/priv.mp4?deadline=1800007200",
				"https://upos-sz-mirrorcos.bilivideo.com/good1.mp4?deadline=1800007200",
			},
		}},
		DashVideo: []bilibili.ShanghaiDashTrack{
			{ID: 80, CodecID: 7, Codecs: "avc1.640028", URLs: []string{"https://cn-zjhz-cu-01-01.bilivideo.com/cn-drop.m4s?deadline=1800007200", "https://upos-sz-mirrorcos.bilivideo.com/v80.m4s?deadline=1800007200"}},
			{ID: 64, CodecID: 7, Codecs: "avc1.64001F", URLs: []string{"https://upos-sz-mirrorhw.bilivideo.com/v64.m4s?deadline=1800007200"}},
		},
		DashAudio: []bilibili.ShanghaiDashTrack{
			{ID: 30280, Codecs: "mp4a.40.2", URLs: []string{"https://upos-sz-mirrorcos.bilivideo.com/a80.m4s?deadline=1800007200"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	got, err := validator.validateBilibiliResponse(t.Context(), biliTestBVID, biliTestCID, rawMixed)
	if err != nil {
		t.Fatalf("validateBilibiliResponse failed: %v", err)
	}
	// Exactly 3 distinct valid upos-* future-deadline hosts were queried in DNS:
	// upos-private.bilivideo.com, upos-sz-mirrorcos.bilivideo.com, upos-sz-mirrorhw.bilivideo.com
	// (cn-* and mcdn.* are rejected before DNS).
	if dnsCalls.Load() != 3 {
		t.Fatalf("expected deduplicated DNS lookups = 3, got %d", dnsCalls.Load())
	}
	if len(got.DURLPieces) != 1 || len(got.DURLPieces[0].URLs) != 1 || got.DURLPieces[0].URLs[0] != "https://upos-sz-mirrorcos.bilivideo.com/good1.mp4?deadline=1800007200" {
		t.Fatalf("unexpected validated DURL pieces: %+v", got.DURLPieces)
	}
	if len(got.DashVideo) != 2 || len(got.DashVideo[0].URLs) != 1 || got.DashVideo[0].URLs[0] != "https://upos-sz-mirrorcos.bilivideo.com/v80.m4s?deadline=1800007200" {
		t.Fatalf("unexpected validated DashVideo (cn-* must be dropped): %+v", got.DashVideo)
	}

	// Reject unknown fields, wrong BVID, wrong CID, all-expired URLs, or cn-*-only URLs.
	badPayloads := [][]byte{
		[]byte(`{"bvid":"BV1234567890","cid":101,"unknown":1}`),
		[]byte(`{"bvid":"BV1999999999","cid":101,"durl_quality":64,"durl_pieces":[{"urls":["https://upos-a.bilivideo.com/1.mp4?deadline=1800007200"]}]}`),
		[]byte(`{"bvid":"BV1234567890","cid":102,"durl_quality":64,"durl_pieces":[{"urls":["https://upos-a.bilivideo.com/1.mp4?deadline=1800007200"]}]}`),
		[]byte(`{"bvid":"BV1234567890","cid":101,"durl_quality":64,"durl_pieces":[{"urls":["https://upos-a.bilivideo.com/1.mp4?deadline=1799999999"]}]}`),
		[]byte(`{"bvid":"BV1234567890","cid":101,"durl_quality":64,"durl_pieces":[{"urls":["https://cn-sh-fx-01-01.bilivideo.com/1.mp4?deadline=1800007200"]}]}`),
	}
	for i, bad := range badPayloads {
		if _, err := validator.validateBilibiliResponse(t.Context(), biliTestBVID, biliTestCID, bad); err == nil {
			t.Fatalf("bad payload %d unexpectedly succeeded", i)
		}
	}

	// End-to-end PullBroker + PullWorker with 1 worker: exercises 300ms queue grant + ResolveBilibiliPending monotonic stats.
	broker, err := NewPullBroker(wireToken)
	if err != nil {
		t.Fatal(err)
	}
	broker.WithBilibili(true)
	broker.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
	}
	srv := httptest.NewTLSServer(broker)
	defer srv.Close()

	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	var callNum atomic.Int32
	biliExec := resolveExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		if callNum.Add(1) == 1 {
			close(firstEntered)
			<-releaseFirst
		}
		return fetch.Response{StatusCode: 200, Body: sampleBilibiliPlayBody(time.Now().Add(2 * time.Hour).Unix())}, nil
	})
	noopProbe := resolverFunc(func(context.Context, string) ([]unified.Object, error) { return nil, errors.New("unused") })
	worker, err := NewPullWorkerWithDetail(origin, wireToken, controlTransportForTLS(srv, origin), biliExec, noopProbe)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := worker.WithWorkers(1); err != nil {
		t.Fatal(err)
	}
	wCtx, wCancel := context.WithCancel(t.Context())
	defer wCancel()
	wDone := make(chan error, 1)
	go func() { wDone <- worker.Run(wCtx) }()
	waitForPullCount(t, broker, 1)

	firstDone := make(chan error, 1)
	go func() {
		_, err := broker.ResolveBilibili(WithChannel(t.Context(), ChannelAnonymous), biliTestBVID, biliTestCID)
		firstDone <- err
	}()
	<-firstEntered

	// Second request arrives while single worker is busy -> enters 300ms queue; releasing worker within 40ms grants it!
	go func() {
		time.Sleep(40 * time.Millisecond)
		close(releaseFirst)
	}()
	play2, finish2, err := broker.ResolveBilibiliPending(WithChannel(t.Context(), ChannelOwner), biliTestBVID, biliTestCID)
	if err != nil || play2 == nil || !play2.HasAnyRoute() {
		t.Fatalf("queued ResolveBilibiliPending failed: play=%+v err=%v", play2, err)
	}
	// Simulate zero matching quality tiers on Japan -> finish(false) records fallback monotonically (idempotent).
	finish2(false)
	finish2(true)

	if err := <-firstDone; err != nil {
		t.Fatalf("first ResolveBilibili failed: %v", err)
	}

	plat := broker.PlatformStatsSnapshot()
	if plat.Bilibili.Hits != 1 || plat.Bilibili.Fallbacks != 1 || plat.Bilibili.QueueWaits != 1 || plat.Bilibili.QueueGranted != 1 {
		t.Fatalf("unexpected Bilibili platform stats after queue grant + pending demotion: %+v", plat.Bilibili)
	}
	snap := broker.ShanghaiStatsSnapshot()
	if snap.ByChannel.Anonymous.Hits != 1 || snap.ByChannel.Owner.Fallbacks != 1 || snap.Total.Hits != 1 || snap.Total.Fallbacks != 1 {
		t.Fatalf("unexpected Shanghai channel stats: %+v", snap)
	}

	wCancel()
	<-wDone
}

func TestBilibiliDefaultDisabledOnPullBrokerAndClient(t *testing.T) {
	const origin = "https://japan.example.org"
	var shBiliCalls atomic.Int32
	var shDouyinCalls atomic.Int32
	shOriginalProbe := resolverFunc(func(_ context.Context, u string) ([]unified.Object, error) {
		if u != douyin.OriginalPlayURL(wireVideo) {
			return nil, fmt.Errorf("unexpected original dispatcher %q", u)
		}
		return []unified.Object{deliveryRow("v26-cold.douyinvod.com", "objectA", "a")}, nil
	})
	shExec := resolveExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		switch req.Policy.Purpose {
		case "douyin-detail":
			shDouyinCalls.Add(1)
			return fetch.Response{StatusCode: 200, Body: interopDetailBody("v26-web.douyinvod.com", "v11-weba.douyinvod.com")}, nil
		case "bilibili-play":
			shBiliCalls.Add(1)
			return fetch.Response{StatusCode: 200, Body: sampleBilibiliPlayBody(time.Now().Add(2 * time.Hour).Unix())}, nil
		default:
			return fetch.Response{}, fmt.Errorf("unexpected purpose %q", req.Policy.Purpose)
		}
	})

	t.Run("pull-broker-default-disabled", func(t *testing.T) {
		broker, err := NewPullBroker(wireToken)
		if err != nil {
			t.Fatal(err)
		}
		if broker.BilibiliEnabled() {
			t.Fatal("NewPullBroker must keep Bilibili disabled by default")
		}
		broker.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
		}
		srv := httptest.NewTLSServer(broker)
		defer srv.Close()

		worker, err := NewPullWorkerWithDetail(origin, wireToken, controlTransportForTLS(srv, origin), shExec, shOriginalProbe)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := worker.WithWorkers(1); err != nil {
			t.Fatal(err)
		}
		wCtx, wCancel := context.WithCancel(t.Context())
		defer wCancel()
		wDone := make(chan error, 1)
		go func() { wDone <- worker.Run(wCtx) }()
		waitForPullCount(t, broker, 1)

		if _, err := broker.ResolveBilibili(t.Context(), biliTestBVID, biliTestCID); !errors.Is(err, errUnavailable) {
			t.Fatalf("expected errUnavailable when Bilibili is disabled on PullBroker, got %v", err)
		}
		if shBiliCalls.Load() != 0 {
			t.Fatalf("expected 0 Shanghai Bilibili calls when disabled, got %d", shBiliCalls.Load())
		}

		// Unsolicited Bilibili result callback must be rejected with 400 when disabled.
		unsolicitedBody := `{"protocol":2,"task_type":"bilibili","task_id":"0123456789abcdef0123456789abcdef","attempt_id":"fedcba9876543210fedcba9876543210","bvid":"BV1234567890","cid":101,"deadline_ms":4102444800000,"result":null}`
		resReq := httptest.NewRequest(http.MethodPost, ResultPath, strings.NewReader(unsolicitedBody))
		resReq.Header.Set("Authorization", "Bearer "+wireToken)
		rec := httptest.NewRecorder()
		broker.ServeHTTP(rec, resReq)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("unsolicited Bilibili result status = %d, want 400", rec.Code)
		}

		// Douyin on the exact same broker & upgraded worker continues to hit Shanghai!
		work, err := broker.ResolveWork(t.Context(), interopAwemeID)
		if err != nil || work == nil || len(work.Renditions) != 2 {
			t.Fatalf("Douyin ResolveWork failed while Bilibili disabled: work=%+v err=%v", work, err)
		}
		if shDouyinCalls.Load() != 1 || shBiliCalls.Load() != 0 {
			t.Fatalf("unexpected upstream call counts: douyin=%d bilibili=%d", shDouyinCalls.Load(), shBiliCalls.Load())
		}
		plat := broker.PlatformStatsSnapshot()
		if plat.Bilibili.Hits != 0 || plat.Bilibili.Fallbacks != 0 || plat.Bilibili.QueueWaits != 0 {
			t.Fatalf("disabled Bilibili must leave bilibili stats at 0, got %+v", plat.Bilibili)
		}
		if plat.Douyin.Hits != 1 || plat.Douyin.Fallbacks != 0 {
			t.Fatalf("expected Douyin hits=1 fallbacks=0, got %+v", plat.Douyin)
		}

		wCancel()
		<-wDone
	})

	t.Run("direct-client-default-disabled", func(t *testing.T) {
		shDouyinCalls.Store(0)
		shBiliCalls.Store(0)
		newHandler, err := NewHandlerWithDetail(wireToken, shExec, shOriginalProbe)
		if err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewTLSServer(newHandler)
		defer srv.Close()

		c, err := NewClient(srv.URL+Path, wireToken, fetch.New())
		if err != nil {
			t.Fatal(err)
		}
		if c.BilibiliEnabled() {
			t.Fatal("NewClient must keep Bilibili disabled by default")
		}
		pool := x509.NewCertPool()
		pool.AddCert(srv.Certificate())
		c.local.Transport.(*http.Transport).TLSClientConfig.RootCAs = pool
		c.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
		}

		if _, err := c.ResolveBilibili(t.Context(), biliTestBVID, biliTestCID); !errors.Is(err, errUnavailable) {
			t.Fatalf("expected errUnavailable when Bilibili is disabled on Client, got %v", err)
		}
		if shBiliCalls.Load() != 0 {
			t.Fatalf("expected 0 Shanghai Bilibili calls in direct mode when disabled, got %d", shBiliCalls.Load())
		}
		work, err := c.ResolveWork(t.Context(), interopAwemeID)
		if err != nil || work == nil || len(work.Renditions) != 2 {
			t.Fatalf("Douyin ResolveWork failed on Client while Bilibili disabled: work=%+v err=%v", work, err)
		}
		plat := c.PlatformStatsSnapshot()
		if plat.Bilibili.Hits != 0 || plat.Bilibili.Fallbacks != 0 || plat.Douyin.Hits != 1 {
			t.Fatalf("unexpected direct platform stats with Bilibili disabled: %+v", plat)
		}
	})
}

func TestBilibiliDASHSwitchOnServerAndPullWorker(t *testing.T) {
	if (*Server)(nil).WithBilibiliDASH(true) != nil || (*Server)(nil).BilibiliDASHEnabled() {
		t.Fatal("nil *Server WithBilibiliDASH / BilibiliDASHEnabled must be nil-safe")
	}
	if (*PullWorker)(nil).WithBilibiliDASH(true) != nil || (*PullWorker)(nil).BilibiliDASHEnabled() {
		t.Fatal("nil *PullWorker WithBilibiliDASH / BilibiliDASHEnabled must be nil-safe")
	}

	const origin = "https://japan.example.org"
	exp := fmt.Sprintf("%010d", time.Now().Add(2*time.Hour).Unix())
	durlOnlyBody := []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":"https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/01/101/101-1-64.mp4?deadline=` + exp + `&upsig=dom1"}]}}`)
	dashOnlyBody := []byte(`{"code":0,"data":{"quality":80,"dash":{"video":[{"id":80,"codecid":7,"codecs":"avc1.640028","baseUrl":"https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/01/101/101-1-30080.m4s?deadline=` + exp + `&upsig=dv1"}],"audio":[{"id":30280,"codecid":0,"codecs":"mp4a.40.2","base_url":"https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/01/101/101-1-30280.m4s?deadline=` + exp + `&upsig=da1"}]}}}`)
	noopProbe := resolverFunc(func(context.Context, string) ([]unified.Object, error) { return nil, errors.New("unused") })

	for _, enableDASH := range []bool{false, true} {
		modeName := "dash-default-off"
		if enableDASH {
			modeName = "dash-enabled"
		}

		t.Run("direct-server/"+modeName, func(t *testing.T) {
			var playCalls, dashCalls atomic.Int32
			shExec := resolveExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				switch req.Policy.Purpose {
				case "bilibili-play":
					playCalls.Add(1)
					return fetch.Response{StatusCode: http.StatusOK, Body: durlOnlyBody}, nil
				case "bilibili-play-dash":
					dashCalls.Add(1)
					return fetch.Response{StatusCode: http.StatusOK, Body: dashOnlyBody}, nil
				default:
					return fetch.Response{}, fmt.Errorf("unexpected purpose %q", req.Policy.Purpose)
				}
			})

			srvHandler, err := NewHandlerWithDetail(wireToken, shExec, noopProbe)
			if err != nil {
				t.Fatal(err)
			}
			if srvHandler.BilibiliDASHEnabled() {
				t.Fatal("NewHandlerWithDetail must default BilibiliDASHEnabled to false")
			}
			if enableDASH {
				srvHandler.WithBilibiliDASH(true)
			}
			if srvHandler.BilibiliDASHEnabled() != enableDASH {
				t.Fatalf("BilibiliDASHEnabled() = %v, want %v", srvHandler.BilibiliDASHEnabled(), enableDASH)
			}

			req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"protocol":2,"task_type":"bilibili","bvid":"`+biliTestBVID+`","cid":101}`))
			req.Header.Set("Authorization", "Bearer "+wireToken)
			rec := httptest.NewRecorder()
			srvHandler.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
			}
			var got bilibili.ShanghaiPlay
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if playCalls.Load() != 1 {
				t.Fatalf("playCalls = %d, want 1", playCalls.Load())
			}
			if enableDASH {
				if dashCalls.Load() != 1 || len(got.DashVideo) != 1 || len(got.DashAudio) != 1 {
					t.Fatalf("dash enabled: dashCalls=%d got=%+v", dashCalls.Load(), got)
				}
			} else {
				if dashCalls.Load() != 0 || len(got.DashVideo) != 0 || len(got.DashAudio) != 0 {
					t.Fatalf("dash disabled: dashCalls=%d got=%+v", dashCalls.Load(), got)
				}
			}
		})

		t.Run("pull-worker/"+modeName, func(t *testing.T) {
			var playCalls, dashCalls atomic.Int32
			shExec := resolveExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				switch req.Policy.Purpose {
				case "bilibili-play":
					playCalls.Add(1)
					return fetch.Response{StatusCode: http.StatusOK, Body: durlOnlyBody}, nil
				case "bilibili-play-dash":
					dashCalls.Add(1)
					return fetch.Response{StatusCode: http.StatusOK, Body: dashOnlyBody}, nil
				default:
					return fetch.Response{}, fmt.Errorf("unexpected purpose %q", req.Policy.Purpose)
				}
			})

			broker, err := NewPullBroker(wireToken)
			if err != nil {
				t.Fatal(err)
			}
			broker.WithBilibili(true)
			broker.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
			}
			srv := httptest.NewTLSServer(broker)
			defer srv.Close()

			worker, err := NewPullWorkerWithDetail(origin, wireToken, controlTransportForTLS(srv, origin), shExec, noopProbe)
			if err != nil {
				t.Fatal(err)
			}
			if worker.BilibiliDASHEnabled() {
				t.Fatal("NewPullWorkerWithDetail must default BilibiliDASHEnabled to false")
			}
			if _, err := worker.WithWorkers(1); err != nil {
				t.Fatal(err)
			}
			if enableDASH {
				worker.WithBilibiliDASH(true)
			}
			if worker.BilibiliDASHEnabled() != enableDASH {
				t.Fatalf("worker.BilibiliDASHEnabled() = %v, want %v", worker.BilibiliDASHEnabled(), enableDASH)
			}

			wCtx, wCancel := context.WithCancel(t.Context())
			defer wCancel()
			wDone := make(chan error, 1)
			go func() { wDone <- worker.Run(wCtx) }()
			waitForPullCount(t, broker, 1)

			got, err := broker.ResolveBilibili(t.Context(), biliTestBVID, biliTestCID)
			if err != nil {
				t.Fatalf("ResolveBilibili failed: %v", err)
			}
			wCancel()
			<-wDone

			if playCalls.Load() != 1 {
				t.Fatalf("playCalls = %d, want 1", playCalls.Load())
			}
			if enableDASH {
				if dashCalls.Load() != 1 || len(got.DashVideo) != 1 || len(got.DashAudio) != 1 {
					t.Fatalf("dash enabled: dashCalls=%d got=%+v", dashCalls.Load(), got)
				}
			} else {
				if dashCalls.Load() != 0 || len(got.DashVideo) != 0 || len(got.DashAudio) != 0 {
					t.Fatalf("dash disabled: dashCalls=%d got=%+v", dashCalls.Load(), got)
				}
			}
		})
	}
}
