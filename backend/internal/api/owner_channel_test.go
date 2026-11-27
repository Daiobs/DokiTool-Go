package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	weiboplatform "github.com/Brilliant666/DokiTool-Go/backend/internal/platform/weibo"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func randomPrintableToken(t *testing.T, length int) string {
	t.Helper()
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._~"
	raw := make([]byte, length)
	if _, err := rand.Read(raw); err != nil {
		t.Fatalf("crypto/rand failed: %v", err)
	}
	out := make([]byte, length)
	for i, b := range raw {
		out[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(out)
}

func TestOwnerAuthValidationAndZeroSecretLeakage(t *testing.T) {
	disabled, err := LoadOwnerAuth(func(string) string { return "" })
	if err != nil || disabled.Enabled() {
		t.Fatalf("empty DOKITOOL_OWNER_TOKEN should disable owner channel cleanly: enabled=%v err=%v", disabled.Enabled(), err)
	}
	if got := fmt.Sprintf("%v|%s|%+v|%#v", disabled, disabled.String(), disabled, disabled); got != "OwnerAuth{enabled:false}|OwnerAuth{enabled:false}|OwnerAuth{enabled:false}|OwnerAuth{enabled:false}" {
		t.Fatalf("unexpected disabled OwnerAuth formatting: %q", got)
	}

	if _, err := LoadOwnerAuth(nil); err == nil {
		t.Fatal("nil getenv must return an error")
	}

	validCanary := randomPrintableToken(t, 48)
	validDigestHex := fmt.Sprintf("%x", sha256.Sum256([]byte(validCanary)))
	enabled, err := LoadOwnerAuth(func(k string) string {
		if k == "DOKITOOL_OWNER_TOKEN" {
			return validCanary
		}
		return ""
	})
	if err != nil || !enabled.Enabled() {
		t.Fatalf("valid DOKITOOL_OWNER_TOKEN rejected: enabled=%v err=%v", enabled.Enabled(), err)
	}
	formatted := fmt.Sprintf("%v|%s|%+v|%#v", enabled, enabled.String(), enabled, enabled)
	if strings.Contains(formatted, validCanary) || strings.Contains(formatted, validCanary[:16]) || strings.Contains(formatted, validDigestHex[:16]) {
		t.Fatalf("OwnerAuth formatting leaked secret or digest: %q", formatted)
	}

	minValid := randomPrintableToken(t, MinOwnerTokenBytes)
	maxValid := randomPrintableToken(t, MaxOwnerTokenBytes)
	if a, err := NewOwnerAuth(minValid); err != nil || !a.Enabled() {
		t.Fatalf("32-byte token rejected: %v", err)
	}
	if a, err := NewOwnerAuth(maxValid); err != nil || !a.Enabled() {
		t.Fatalf("512-byte token rejected: %v", err)
	}

	short29 := randomPrintableToken(t, 29)
	short31 := randomPrintableToken(t, 31)
	over513 := randomPrintableToken(t, 513)
	withSpace := " " + randomPrintableToken(t, 40)
	withTrailingNewline := randomPrintableToken(t, 40) + "\n"
	withInnerTab := randomPrintableToken(t, 20) + "\t" + randomPrintableToken(t, 20)
	withControl := randomPrintableToken(t, 20) + "\x00" + randomPrintableToken(t, 20)
	withDEL := randomPrintableToken(t, 20) + "\x7f" + randomPrintableToken(t, 20)
	withNonASCII := randomPrintableToken(t, 20) + "密" + randomPrintableToken(t, 20)

	for _, bad := range []struct {
		name   string
		val    string
		canary string
		badLen string
	}{
		{"len-1", randomPrintableToken(t, 1), "", ""},
		{"len-29", short29, short29[:12], "29"},
		{"len-31", short31, short31[:12], "31"},
		{"len-513", over513, over513[:12], "513"},
		{"whitespace-only", strings.Repeat(" ", 40), "", "40"},
		{"leading-space", withSpace, strings.TrimSpace(withSpace)[:12], "41"},
		{"trailing-newline", withTrailingNewline, strings.TrimSpace(withTrailingNewline)[:12], "41"},
		{"inner-tab", withInnerTab, withInnerTab[:12], "41"},
		{"nul-byte", withControl, withControl[:12], "41"},
		{"del-byte", withDEL, withDEL[:12], "41"},
		{"non-ascii", withNonASCII, withNonASCII[:12], "43"},
	} {
		t.Run(bad.name, func(t *testing.T) {
			auth, err := NewOwnerAuth(bad.val)
			if err == nil || auth.Enabled() {
				t.Fatalf("expected invalid token (%s) to fail startup validation", bad.name)
			}
			msg := err.Error()
			if bad.canary != "" && strings.Contains(msg, bad.canary) {
				t.Fatalf("startup error leaked token material: %q", msg)
			}
			if bad.badLen != "" && strings.Contains(msg, bad.badLen) {
				t.Fatalf("startup error leaked candidate token length %s: %q", bad.badLen, msg)
			}
		})
	}
}

func TestOwnerAdmissionConfigBoundsAndNoEcho(t *testing.T) {
	defaults, err := LoadAdmissionConfig(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if DefaultOwnerConcurrency != 8 || DefaultOwnerQueueWait != 60*time.Second || DefaultOwnerQueueSize != 256 {
		t.Fatal("owner default constants drifted")
	}
	if defaults.OwnerConcurrency != 8 || defaults.OwnerQueueWait != 60*time.Second || defaults.OwnerQueueSize != 256 {
		t.Fatalf("unexpected owner defaults: %+v", defaults)
	}

	custom, err := LoadAdmissionConfig(func(k string) string {
		switch k {
		case "DOKITOOL_OWNER_CONCURRENCY":
			return "32"
		case "DOKITOOL_OWNER_QUEUE_WAIT":
			return "90s"
		case "DOKITOOL_OWNER_QUEUE_SIZE":
			return "512"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if custom.OwnerConcurrency != 32 || custom.OwnerQueueWait != 90*time.Second || custom.OwnerQueueSize != 512 {
		t.Fatalf("owner config overrides ignored: %+v", custom)
	}

	zeroWait, err := LoadAdmissionConfig(func(k string) string {
		switch k {
		case "DOKITOOL_OWNER_CONCURRENCY":
			return "1"
		case "DOKITOOL_OWNER_QUEUE_WAIT":
			return "0"
		case "DOKITOOL_OWNER_QUEUE_SIZE":
			return "0"
		default:
			return ""
		}
	})
	if err != nil || zeroWait.OwnerConcurrency != 1 || zeroWait.OwnerQueueWait != 0 || zeroWait.OwnerQueueSize != 0 {
		t.Fatalf("zero owner queue configuration rejected: %+v err=%v", zeroWait, err)
	}

	canary := randomPrintableToken(t, 24)
	for _, tc := range []struct {
		key, val string
	}{
		{"DOKITOOL_OWNER_CONCURRENCY", "0"},
		{"DOKITOOL_OWNER_CONCURRENCY", "-1"},
		{"DOKITOOL_OWNER_CONCURRENCY", "33"},
		{"DOKITOOL_OWNER_CONCURRENCY", "100"},
		{"DOKITOOL_OWNER_CONCURRENCY", canary},
		{"DOKITOOL_OWNER_QUEUE_WAIT", "-1s"},
		{"DOKITOOL_OWNER_QUEUE_WAIT", "121s"},
		{"DOKITOOL_OWNER_QUEUE_WAIT", canary},
		{"DOKITOOL_OWNER_QUEUE_SIZE", "-1"},
		{"DOKITOOL_OWNER_QUEUE_SIZE", "4097"},
		{"DOKITOOL_OWNER_QUEUE_SIZE", canary},
	} {
		_, err := LoadAdmissionConfig(func(k string) string {
			if k == tc.key {
				return tc.val
			}
			return ""
		})
		if err == nil {
			t.Fatalf("expected %s=%q to fail validation", tc.key, tc.val)
		}
		if strings.Contains(err.Error(), canary) {
			t.Fatalf("error echoed raw invalid env value for %s: %v", tc.key, err)
		}
	}
}

func newOwnerTestRouter(t *testing.T, cfg AdmissionConfig, ownerToken, edgeKey string, adapterFn func(platform string) Adapter) http.Handler {
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
	specs, err := ytgeneric.ParseSitesEnv("facebook,tumblr,dailymotion")
	if err != nil {
		t.Fatal(err)
	}
	for _, spec := range specs {
		if err := c.Register(spec.CatalogEntry()); err != nil {
			t.Fatal(err)
		}
	}

	adapters := make(map[string]Adapter)
	for _, id := range []string{
		"douyin", "bilibili", "toutiao", "kuaishou", "pipixia", "pipigx", "zuiyou", "xiaohongshu",
		"x", "youtube", "instagram", "facebook", "tumblr",
	} {
		adapters[id] = adapterFn(id)
	}

	h, err := NewWithCacheConfig(c, adapters, func() time.Time { return time.Unix(1793448000, 0) }, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}
	auth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := WithAdmissionWithOwner(h, nil, "caddy", edgeKey, cfg, auth)
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func TestOwnerChannelBypassesPerIPLimitAndAnonymousPools(t *testing.T) {
	ownerToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 40)

	cfg := DefaultAdmissionConfig()
	cfg.Parse.GlobalConcurrency = 1
	cfg.Parse.QueueWait = 0
	cfg.Parse.QueueSize = 0
	cfg.SlowParse.GlobalConcurrency = 1
	cfg.SlowParse.QueueWait = 0
	cfg.SlowParse.QueueSize = 0
	cfg.Catalog.ClientConcurrency = 1
	cfg.Catalog.GlobalConcurrency = 1

	var sawAuthHeader atomic.Bool
	var sawOwnerFlag atomic.Int64
	entry := newOwnerTestRouter(t, cfg, ownerToken, edgeKey, func(platform string) Adapter {
		return AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
			if IsOwnerRequest(ctx) {
				sawOwnerFlag.Add(1)
			}
			return makeSyntheticEnvelope(platform, src, now, ""), nil
		})
	})
	adm := entry.(*admission)

	// Wrap adm.next check to assert Authorization header is stripped downstream.
	origNext := adm.next
	adm.next = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			sawAuthHeader.Store(true)
		}
		origNext.ServeHTTP(w, r)
	})

	// Saturate all anonymous Fast, Slow, and Catalog global concurrency slots.
	relFast, r1 := adm.public.acquire(netip.MustParseAddr("192.0.2.200"), time.Now())
	relSlow, r2 := adm.slow.acquire(netip.MustParseAddr("192.0.2.201"), time.Now())
	relCat, r3 := adm.catalog.acquire(netip.MustParseAddr("192.0.2.202"), time.Now())
	if r1 != 0 || r2 != 0 || r3 != 0 {
		t.Fatalf("failed to saturate anonymous pools: %d %d %d", r1, r2, r3)
	}
	defer relFast()
	defer relSlow()
	defer relCat()

	makeReq := func(target, ip, bearer string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.RemoteAddr = "127.0.0.1:23456"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, ip)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		return req
	}

	// Anonymous visitors hit 429 on Fast, Slow (x.com), and Catalog (/api/platforms).
	for _, target := range []string{
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD"),
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://x.com/user/status/123456"),
		"/api/platforms?schema_version=1.0",
	} {
		if w := call(entry, makeReq(target, "203.0.113.10", "")); w.Code != http.StatusTooManyRequests {
			t.Fatalf("expected saturated anonymous pool to return 429 for %s, got %d", target, w.Code)
		}
	}

	// Single-IP owner batch agent sends 20 sequential requests + 8 concurrent requests
	// across Fast, Slow (x.com), and Catalog without hitting per-IP limits or anonymous pools.
	const ownerIP = "198.51.100.77"
	targets := []string{
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD"),
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://x.com/user/status/123456"),
		"/api/platforms?schema_version=1.0",
	}
	for i := 0; i < 20; i++ {
		w := call(entry, makeReq(targets[i%len(targets)], ownerIP, ownerToken))
		if w.Code != http.StatusOK {
			t.Fatalf("owner sequential request #%d failed: status=%d body=%s", i, w.Code, w.Body.String())
		}
	}

	// 8 concurrent owner requests from the same single IP all enter simultaneously (DefaultOwnerConcurrency = 8).
	allEightEntered := make(chan struct{})
	releaseEight := make(chan struct{})
	var inFlight atomic.Int64
	adm.next = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			sawAuthHeader.Store(true)
		}
		if inFlight.Add(1) == DefaultOwnerConcurrency {
			close(allEightEntered)
		}
		<-releaseEight
		w.WriteHeader(http.StatusOK)
	})

	var wg sync.WaitGroup
	errs := make(chan error, DefaultOwnerConcurrency)
	for i := 0; i < DefaultOwnerConcurrency; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			w := call(entry, makeReq(targets[idx%len(targets)], ownerIP, ownerToken))
			if w.Code != http.StatusOK {
				errs <- fmt.Errorf("concurrent owner #%d got status %d", idx, w.Code)
			}
		}(i)
	}
	select {
	case <-allEightEntered:
	case <-time.After(2 * time.Second):
		t.Fatalf("expected %d concurrent single-IP owner requests to run simultaneously, got %d", DefaultOwnerConcurrency, inFlight.Load())
	}
	close(releaseEight)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	if sawAuthHeader.Load() {
		t.Fatal("Authorization header leaked to downstream handler")
	}
	if sawOwnerFlag.Load() == 0 {
		t.Fatal("IsOwnerRequest(ctx) was not propagated to parse adapters")
	}
	adm.public.mu.Lock()
	_, tracked := adm.public.clients[netip.MustParseAddr(ownerIP)]
	adm.public.mu.Unlock()
	if tracked {
		t.Fatal("valid owner requests must not allocate or charge anonymous per-IP client entries")
	}
}

func TestOwnerPoolFIFOQueueTimeoutOverflowWriteDeadlineAndCancelRace(t *testing.T) {
	ownerToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 40)

	holdSlot := make(chan struct{})
	holderEntered := make(chan struct{})
	var orderMu sync.Mutex
	var order []string

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tag := r.URL.Query().Get("tag")
		orderMu.Lock()
		order = append(order, tag)
		orderMu.Unlock()
		if tag == "holder" {
			close(holderEntered)
			<-holdSlot
		}
		w.WriteHeader(http.StatusOK)
	})

	cfg := DefaultAdmissionConfig()
	cfg.OwnerConcurrency = 1
	cfg.OwnerQueueWait = 140 * time.Millisecond
	cfg.OwnerQueueSize = 2

	auth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := WithAdmissionWithOwner(next, nil, "caddy", edgeKey, cfg, auth)
	if err != nil {
		t.Fatal(err)
	}
	adm := entry.(*admission)

	ownerReq := func(tag string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/api/parse?tag="+tag, nil)
		req.RemoteAddr = "127.0.0.1:34567"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, "198.51.100.88")
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		return req
	}

	// 1. Occupy the single owner slot.
	var holderWG sync.WaitGroup
	holderWG.Add(1)
	go func() {
		defer holderWG.Done()
		if w := call(entry, ownerReq("holder")); w.Code != http.StatusOK {
			t.Errorf("holder got status %d", w.Code)
		}
	}()
	<-holderEntered

	// 2. Enqueue 2 waiters from the same owner IP in FIFO order (q1, q2).
	q1Done := make(chan *httptest.ResponseRecorder, 1)
	go func() { q1Done <- call(entry, ownerReq("q1")) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		adm.owner.mu.Lock()
		qLen := adm.owner.waiters.Len()
		adm.owner.mu.Unlock()
		if qLen == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}

	q2Done := make(chan *httptest.ResponseRecorder, 1)
	go func() { q2Done <- call(entry, ownerReq("q2")) }()
	for time.Now().Before(deadline) {
		adm.owner.mu.Lock()
		qLen := adm.owner.waiters.Len()
		adm.owner.mu.Unlock()
		if qLen == 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}

	// 3. Overflow (3rd queued waiter when OwnerQueueSize=2) fails immediately with 429 RATE_LIMITED.
	t0 := time.Now()
	wOverflow := call(entry, ownerReq("overflow"))
	if wOverflow.Code != http.StatusTooManyRequests || wOverflow.Header().Get("Retry-After") != "1" ||
		wOverflow.Header().Get("Cache-Control") != "no-store" || time.Since(t0) > 50*time.Millisecond {
		t.Fatalf("expected immediate 429 overflow, got status=%d retry=%q elapsed=%s", wOverflow.Code, wOverflow.Header().Get("Retry-After"), time.Since(t0))
	}

	// 4. Release holder -> q1 and q2 run in strict FIFO order.
	close(holdSlot)
	holderWG.Wait()
	if w1 := <-q1Done; w1.Code != http.StatusOK {
		t.Fatalf("q1 status=%d", w1.Code)
	}
	if w2 := <-q2Done; w2.Code != http.StatusOK {
		t.Fatalf("q2 status=%d", w2.Code)
	}
	orderMu.Lock()
	gotOrder := strings.Join(order, ",")
	orderMu.Unlock()
	if gotOrder != "holder,q1,q2" {
		t.Fatalf("expected FIFO order holder,q1,q2, got %q", gotOrder)
	}

	// 5. Queue wait expiry returns contract 429 RATE_LIMITED with Retry-After and retry_after_seconds.
	relHold, retry, canceled := adm.owner.acquireContext(context.Background())
	if retry != 0 || canceled {
		t.Fatalf("unexpected acquire failure: retry=%d canceled=%v", retry, canceled)
	}
	tTimeout := time.Now()
	wTimeout := call(entry, ownerReq("timeout"))
	if wTimeout.Code != http.StatusTooManyRequests || wTimeout.Header().Get("Retry-After") != "1" || time.Since(tTimeout) < 100*time.Millisecond {
		t.Fatalf("expected 429 after queue wait timeout, got status=%d retry=%q elapsed=%s", wTimeout.Code, wTimeout.Header().Get("Retry-After"), time.Since(tTimeout))
	}
	var body map[string]any
	if err := json.Unmarshal(wTimeout.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	errObj, _ := body["error"].(map[string]any)
	if body["code"] != "RATE_LIMITED" || errObj["retry_after_seconds"] != float64(1) || errObj["retryable"] != true {
		t.Fatalf("unexpected 429 body: %v", body)
	}
	relHold()

	// 6. Real TCP server with tight WriteTimeout (40ms): queued owner request waiting 80ms
	// succeeds because admission extends WriteDeadline across OwnerQueueWait.
	srvCfg := DefaultAdmissionConfig()
	srvCfg.OwnerConcurrency = 1
	srvCfg.OwnerQueueWait = 250 * time.Millisecond
	srvCfg.OwnerQueueSize = 4
	srvHandler, err := WithAdmissionWithOwner(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}), nil, "caddy", edgeKey, srvCfg, auth)
	if err != nil {
		t.Fatal(err)
	}
	srvAdm := srvHandler.(*admission)
	relTCP, _, _ := srvAdm.owner.acquireContext(context.Background())
	ts := httptest.NewUnstartedServer(srvHandler)
	ts.Config.WriteTimeout = 40 * time.Second / 1000 // 40ms initial http.Server WriteTimeout
	ts.Start()
	defer ts.Close()
	go func() {
		time.Sleep(85 * time.Millisecond)
		relTCP()
	}()
	tcpReq, err := http.NewRequest(http.MethodGet, ts.URL+"/api/parse", nil)
	if err != nil {
		t.Fatal(err)
	}
	tcpReq.Header.Set(edgeHeader, edgeKey)
	tcpReq.Header.Set(clientHeader, "198.51.100.88")
	tcpReq.Header.Set("Authorization", "Bearer "+ownerToken)
	tcpResp, err := ts.Client().Do(tcpReq)
	if err != nil {
		t.Fatalf("queued owner request over TCP failed (WriteDeadline not extended): %v", err)
	}
	respBytes, _ := io.ReadAll(tcpResp.Body)
	tcpResp.Body.Close()
	if tcpResp.StatusCode != http.StatusOK || string(respBytes) != `{"ok":true}` {
		t.Fatalf("unexpected TCP response: status=%d body=%q", tcpResp.StatusCode, string(respBytes))
	}

	// 7. High-contention concurrent acquire + release + timeout + random ctx cancel under -race.
	raceCfg := DefaultAdmissionConfig()
	raceCfg.OwnerConcurrency = 3
	raceCfg.OwnerQueueWait = 35 * time.Millisecond
	raceCfg.OwnerQueueSize = 12
	raceEntry, err := WithAdmissionWithOwner(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(10 * time.Millisecond)
		w.WriteHeader(http.StatusNoContent)
	}), nil, "caddy", edgeKey, raceCfg, auth)
	if err != nil {
		t.Fatal(err)
	}
	raceAdm := raceEntry.(*admission)

	var wg sync.WaitGroup
	for i := 0; i < 120; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			req := ownerReq(strconv.Itoa(idx))
			switch idx % 4 {
			case 0:
				cctx, cancel := context.WithTimeout(context.Background(), time.Duration(idx%16)*time.Millisecond)
				defer cancel()
				req = req.WithContext(cctx)
			case 1:
				cctx, cancel := context.WithCancel(context.Background())
				go func() {
					time.Sleep(time.Duration(idx%14) * time.Millisecond)
					cancel()
				}()
				req = req.WithContext(cctx)
			}
			call(raceEntry, req)
		}(i)
	}
	wg.Wait()

	raceAdm.owner.mu.Lock()
	defer raceAdm.owner.mu.Unlock()
	if raceAdm.owner.active != 0 || raceAdm.owner.waiters.Len() != 0 {
		t.Fatalf("ownerPool leaked slots after concurrent cancellation race: active=%d waiters=%d", raceAdm.owner.active, raceAdm.owner.waiters.Len())
	}
}

func TestOwnerRespectsDownstreamYTDLPSemaphoreAndShanghaiIsolation(t *testing.T) {
	ownerToken := randomPrintableToken(t, 48)
	pullToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 40)

	broker, err := shresolver.NewPullBroker(pullToken)
	if err != nil {
		t.Fatal(err)
	}

	const ytdlpCap = 2
	ytdlpSem := make(chan struct{}, ytdlpCap)
	var curYTDLP atomic.Int64
	var peakYTDLP atomic.Int64
	var shanghaiResolved atomic.Int64

	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Register(catalog.XPlatform()); err != nil {
		t.Fatal(err)
	}

	adapters := map[string]Adapter{
		"x": AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
			select {
			case ytdlpSem <- struct{}{}:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			defer func() {
				curYTDLP.Add(-1)
				<-ytdlpSem
			}()
			cur := curYTDLP.Add(1)
			for {
				prev := peakYTDLP.Load()
				if cur <= prev || peakYTDLP.CompareAndSwap(prev, cur) {
					break
				}
			}
			time.Sleep(25 * time.Millisecond)
			return makeSyntheticEnvelope("x", src, now, ""), nil
		}),
		"douyin": AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
			idx := strings.LastIndexByte(src, '/')
			awemeID := src[idx+1:]
			res, err := broker.ResolveWork(ctx, awemeID)
			if err != nil || res.VideoID == "" {
				return nil, fmt.Errorf("shanghai resolve failed: %v", err)
			}
			shanghaiResolved.Add(1)
			return makeSyntheticEnvelope("douyin", src, now, ""), nil
		}),
	}

	h, err := NewWithCacheConfig(c, adapters, func() time.Time { return time.Unix(1793448000, 0) }, nil, CacheConfig{Disabled: true})
	if err != nil {
		t.Fatal(err)
	}
	auth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := WithAdmissionWithOwner(h, broker, "caddy", edgeKey, DefaultAdmissionConfig(), auth)
	if err != nil {
		t.Fatal(err)
	}

	// Verify /internal/shanghai/claim rejects DOKITOOL_OWNER_TOKEN with 401 and accepts DOKITOOL_SHANGHAI_PULL_TOKEN.
	badClaim := httptest.NewRequest(http.MethodPost, shresolver.ClaimPath, nil)
	badClaim.RemoteAddr = "127.0.0.1:45678"
	badClaim.Header.Set(edgeHeader, edgeKey)
	badClaim.Header.Set(clientHeader, "198.51.100.210")
	badClaim.Header.Set("Authorization", "Bearer "+ownerToken)
	badClaim.Header.Set(shresolver.ProtocolHeader, "2")
	if w := call(entry, badClaim); w.Code != http.StatusUnauthorized {
		t.Fatalf("owner token must NEVER authenticate /internal/shanghai/claim, got %d", w.Code)
	}

	ts := httptest.NewServer(entry)
	defer ts.Close()

	// Start 1 simulated Shanghai worker over loopback using pullToken.
	workerCtx, cancelWorker := context.WithCancel(context.Background())
	var workerWG sync.WaitGroup
	workerWG.Add(1)
	go func() {
		defer workerWG.Done()
		for workerCtx.Err() == nil {
			req, err := http.NewRequestWithContext(workerCtx, http.MethodPost, ts.URL+shresolver.ClaimPath, nil)
			if err != nil {
				return
			}
			req.Header.Set(edgeHeader, edgeKey)
			req.Header.Set(clientHeader, "198.51.100.211")
			req.Header.Set("Authorization", "Bearer "+pullToken)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set(shresolver.ProtocolHeader, "2")
			resp, err := ts.Client().Do(req)
			if err != nil {
				return
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				continue
			}
			var job shresolver.PullJob
			if err := json.Unmarshal(body, &job); err != nil {
				continue
			}
			workRaw, _ := json.Marshal(shresolver.WorkResponse{
				Protocol: shresolver.ProtocolV2,
				AwemeID:  job.AwemeID,
				VideoID:  "v0200fg1" + job.AwemeID,
			})
			resPayload, _ := json.Marshal(shresolver.PullResult{PullJob: job, Result: workRaw})
			resReq, _ := http.NewRequestWithContext(workerCtx, http.MethodPost, ts.URL+shresolver.ResultPath, bytes.NewReader(resPayload))
			resReq.Header.Set(edgeHeader, edgeKey)
			resReq.Header.Set(clientHeader, "198.51.100.211")
			resReq.Header.Set("Authorization", "Bearer "+pullToken)
			resReq.Header.Set("Content-Type", "application/json")
			ack, err := ts.Client().Do(resReq)
			if err == nil && ack != nil {
				ack.Body.Close()
			}
		}
	}()
	defer func() {
		cancelWorker()
		workerWG.Wait()
	}()
	// Allow the simulated Shanghai pull worker to register its initial long-poll claim.
	time.Sleep(30 * time.Millisecond)

	// Fire 6 concurrent owner x.com requests + 4 concurrent owner Douyin requests from 1 IP.
	var wg sync.WaitGroup
	errCh := make(chan error, 10)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			u := fmt.Sprintf("https://x.com/owner/status/%d", 1800000000000000100+idx)
			req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/parse?schema_version=1.0&url="+url.QueryEscape(u), nil)
			req.Header.Set(edgeHeader, edgeKey)
			req.Header.Set(clientHeader, "198.51.100.88")
			req.Header.Set("Authorization", "Bearer "+ownerToken)
			resp, err := ts.Client().Do(req)
			if err != nil {
				errCh <- err
				return
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				errCh <- fmt.Errorf("owner x request #%d got %d", idx, resp.StatusCode)
			}
		}(i)
	}
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			u := fmt.Sprintf("https://www.douyin.com/video/%019d", 7400000000000000100+idx)
			req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/parse?schema_version=1.0&url="+url.QueryEscape(u), nil)
			req.Header.Set(edgeHeader, edgeKey)
			req.Header.Set(clientHeader, "198.51.100.88")
			req.Header.Set("Authorization", "Bearer "+ownerToken)
			resp, err := ts.Client().Do(req)
			if err != nil {
				errCh <- err
				return
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				errCh <- fmt.Errorf("owner douyin request #%d got %d", idx, resp.StatusCode)
			}
		}(i)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
	if peak := peakYTDLP.Load(); peak < 1 || peak > ytdlpCap {
		t.Fatalf("downstream yt-dlp concurrency exceeded semaphore (%d): peak=%d", ytdlpCap, peak)
	}
	if shanghaiResolved.Load() != 4 {
		t.Fatalf("expected 4 Shanghai pull resolutions, got %d", shanghaiResolved.Load())
	}
}

func TestInvalidOversizedDuplicateAndDisabledAuthThrottlesPerIPWithoutGlobalStarvation(t *testing.T) {
	ownerToken := randomPrintableToken(t, 48)
	wrongToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 40)

	cfg := legacyAdmissionConfig() // GlobalBurst=8, GlobalConcurrency=2, ClientBurst=4, ClientRPS=0.2
	now := time.Unix(2000, 0)

	entry := newOwnerTestRouter(t, cfg, ownerToken, edgeKey, func(platform string) Adapter {
		return AdapterFunc(func(_ context.Context, src string, ts int64) (unified.Object, error) {
			return makeSyntheticEnvelope(platform, src, ts, ""), nil
		})
	})
	adm := entry.(*admission)
	adm.now = func() time.Time { return now }

	makeAuthReq := func(method, target, ip string, authHeaders ...string) *http.Request {
		req := httptest.NewRequest(method, target, nil)
		req.RemoteAddr = "127.0.0.1:56789"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, ip)
		for _, h := range authHeaders {
			req.Header.Add("Authorization", h)
		}
		return req
	}

	// 1. Contract verification across malformed/wrong/duplicate/oversized headers and routes.
	oversized := "Bearer " + randomPrintableToken(t, MaxOwnerAuthHeaderBytes+32)
	hugeHeader := "Bearer " + randomPrintableToken(t, 16384)
	cases := []struct {
		name    string
		method  string
		path    string
		headers []string
		legacy  bool
	}{
		{"wrong-bearer-parse", http.MethodGet, "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD"), []string{"Bearer " + wrongToken}, false},
		{"lowercase-scheme", http.MethodGet, "/api/resolve?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD") + "&item_id=1", []string{"bearer " + ownerToken}, false},
		{"basic-scheme", http.MethodGet, "/api/platforms?schema_version=1.0", []string{"Basic " + ownerToken}, false},
		{"empty-bearer", http.MethodGet, "/api/youtube/context?schema_version=1.0", []string{"Bearer "}, false},
		{"trailing-space", http.MethodGet, "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://x.com/u/status/1"), []string{"Bearer " + ownerToken + " "}, false},
		{"duplicate-header", http.MethodGet, "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD"), []string{"Bearer " + ownerToken, "Bearer " + ownerToken}, false},
		{"oversized-1056b", http.MethodGet, "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD"), []string{oversized}, false},
		{"oversized-16kib", http.MethodGet, "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD"), []string{hugeHeader}, false},
		{"legacy-route", http.MethodGet, "/api/douyin", []string{"Bearer " + wrongToken}, true},
		{"head-parse", http.MethodHead, "/api/parse", []string{"Bearer " + wrongToken}, false},
	}

	for idx, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ip := fmt.Sprintf("198.18.0.%d", idx+1)
			w := call(entry, makeAuthReq(tc.method, tc.path, ip, tc.headers...))
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d (%s)", w.Code, w.Body.String())
			}
			if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("missing security headers on 401: %v", w.Header())
			}
			if tc.method == http.MethodHead {
				if w.Body.Len() != 0 {
					t.Fatalf("HEAD 401 must have empty body, got %q", w.Body.String())
				}
				return
			}
			if strings.Contains(w.Body.String(), wrongToken[:12]) || strings.Contains(w.Body.String(), ownerToken[:12]) {
				t.Fatalf("401 response echoed token bytes: %s", w.Body.String())
			}
			if tc.legacy {
				var obj map[string]any
				if err := json.Unmarshal(w.Body.Bytes(), &obj); err != nil {
					t.Fatal(err)
				}
				if obj["code"] != float64(401) || obj["data"] != nil {
					t.Fatalf("unexpected legacy 401 envelope: %v", obj)
				}
				return
			}
			decoded, err := unified.Decode(w.Body.Bytes())
			if err != nil {
				t.Fatalf("decode 401 unified JSON: %v", err)
			}
			if err := unified.ValidateEnvelope(decoded); err != nil {
				t.Fatalf("401 response failed unified-v1 contract validation: %v", err)
			}
			if decoded["code"] != "INVALID_INPUT" || unified.Map(decoded["error"])["retryable"] == true {
				t.Fatalf("unexpected 401 unified error payload: %v", decoded)
			}
		})
	}

	// 2. Single-IP brute-force across mixed routes (/api/parse fast, slow x.com, /api/platforms, oversized):
	// first 4 attempts return 401; 5th attempt returns 429 RATE_LIMITED (Retry-After: 5);
	// subsequent anonymous request from the SAME IP is also throttled (429)!
	const attackerIP = "203.0.113.66"
	mixedTargets := []string{
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD"),
		"/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://x.com/u/status/123"),
		"/api/platforms?schema_version=1.0",
		"/api/resolve?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD") + "&item_id=1",
	}
	for i := 0; i < 4; i++ {
		hdr := "Bearer " + wrongToken
		if i == 3 {
			hdr = oversized
		}
		if w := call(entry, makeAuthReq(http.MethodGet, mixedTargets[i], attackerIP, hdr)); w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt #%d expected 401, got %d", i+1, w.Code)
		}
	}
	w5 := call(entry, makeAuthReq(http.MethodGet, "/api/platforms?schema_version=1.0", attackerIP, "Bearer "+wrongToken))
	if w5.Code != http.StatusTooManyRequests || w5.Header().Get("Retry-After") != "5" {
		t.Fatalf("5th bad-token attempt must hit per-IP 429 Retry-After:5, got code=%d header=%v body=%s", w5.Code, w5.Header(), w5.Body.String())
	}
	var body429 map[string]any
	if err := json.Unmarshal(w5.Body.Bytes(), &body429); err != nil {
		t.Fatal(err)
	}
	if body429["code"] != "RATE_LIMITED" || body429["error"].(map[string]any)["retry_after_seconds"] != float64(5) {
		t.Fatalf("unexpected 429 brute-force payload: %v", body429)
	}
	// Anonymous request without Authorization from attackerIP shares the exhausted per-IP bucket!
	if wAnonSame := call(entry, makeAuthReq(http.MethodGet, mixedTargets[0], attackerIP)); wAnonSame.Code != http.StatusTooManyRequests {
		t.Fatalf("exhausted bad-token IP bypassed anonymous per-IP limit: got %d", wAnonSame.Code)
	}

	// 3. Distributed bad-token flood from 200 IPs (800 bad requests at fixed timestamp when GlobalBurst=8)
	// must NOT consume global anonymous tokens or concurrency slots!
	for i := 0; i < 200; i++ {
		ip := fmt.Sprintf("198.19.%d.%d", i/250, (i%250)+1)
		for j := 0; j < 4; j++ {
			if w := call(entry, makeAuthReq(http.MethodGet, mixedTargets[0], ip, "Bearer "+wrongToken)); w.Code != http.StatusUnauthorized {
				t.Fatalf("flood ip %s attempt %d got %d", ip, j, w.Code)
			}
		}
	}
	// Legitimate anonymous visitor on a fresh IP still gets 200 OK immediately!
	if wGoodAnon := call(entry, makeAuthReq(http.MethodGet, mixedTargets[0], "192.0.2.99")); wGoodAnon.Code != http.StatusOK {
		t.Fatalf("bad-token flood starved legitimate anonymous visitor: status=%d body=%s", wGoodAnon.Code, wGoodAnon.Body.String())
	}

	// 4. Disabled feature (DOKITOOL_OWNER_TOKEN == ""):
	// requests without Authorization work as anonymous; requests WITH Authorization return 401 + per-IP throttle.
	disabledEntry := newOwnerTestRouter(t, cfg, "", edgeKey, func(platform string) Adapter {
		return AdapterFunc(func(_ context.Context, src string, ts int64) (unified.Object, error) {
			return makeSyntheticEnvelope(platform, src, ts, ""), nil
		})
	})
	disabledEntry.(*admission).now = func() time.Time { return now }
	if w := call(disabledEntry, makeAuthReq(http.MethodGet, mixedTargets[0], "192.0.2.150")); w.Code != http.StatusOK {
		t.Fatalf("anonymous request failed when owner channel disabled: %d", w.Code)
	}
	for i := 0; i < 4; i++ {
		if w := call(disabledEntry, makeAuthReq(http.MethodGet, mixedTargets[0], "192.0.2.151", "Bearer "+ownerToken)); w.Code != http.StatusUnauthorized {
			t.Fatalf("Authorization header when disabled must return 401 (attempt %d): got %d", i+1, w.Code)
		}
	}
	if w := call(disabledEntry, makeAuthReq(http.MethodGet, mixedTargets[0], "192.0.2.151", "Bearer "+ownerToken)); w.Code != http.StatusTooManyRequests {
		t.Fatalf("5th Authorization header when disabled must return 429, got %d", w.Code)
	}
}

func TestQueryParameterTokensNeverAuthenticateAsOwner(t *testing.T) {
	ownerToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 40)

	registry, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	exec := &fakeWeiboSafeExecutor{body: weiboSyntheticResponse}
	h, err := NewWithCacheConfig(
		registry,
		map[string]Adapter{
			"weibo": weiboplatform.New(exec),
			"bilibili": AdapterFunc(func(ctx context.Context, src string, now int64) (unified.Object, error) {
				if IsOwnerRequest(ctx) {
					t.Error("query parameter token authenticated request as owner")
				}
				return makeSyntheticEnvelope("bilibili", src, now, ""), nil
			}),
		},
		func() time.Time { return time.Unix(weiboFrozenNow, 0) },
		weiboplatform.PreparePublic,
		CacheConfig{Disabled: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	auth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := WithAdmissionWithOwner(h, nil, "caddy", edgeKey, DefaultAdmissionConfig(), auth)
	if err != nil {
		t.Fatal(err)
	}
	entry.(*admission).now = func() time.Time { return time.Unix(weiboFrozenNow, 0) }

	queryKeys := []string{"token", "owner_token", "access_token", "authorization", "bearer"}
	for idx, qk := range queryKeys {
		q := url.Values{
			"schema_version": {"1.0"},
			"url":            {weiboFrozenInput},
			qk:               {ownerToken},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/parse?"+q.Encode(), nil)
		req.RemoteAddr = "127.0.0.1:11111"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, fmt.Sprintf("198.51.100.%d", idx+10))
		w := call(entry, req)
		if w.Code != http.StatusOK {
			t.Fatalf("query param %s status=%d body=%s", qk, w.Code, w.Body.String())
		}
		payload, err := unified.Decode(w.Body.Bytes())
		if err != nil {
			t.Fatalf("query param %s invalid JSON: %v", qk, err)
		}
		item := unified.Map(unified.Slice(unified.Map(payload["data"])["items"])[0])
		def := unified.Map(item["default"])
		if def["access"] == "relay" || unified.Str(def["url"]) != weiboCDNURL {
			t.Fatalf("query param ?%s= unexpected Weibo default=%v", qk, def)
		}
	}

	// Same IP sending 5 requests with ?token=<valid> still hits per-IP Burst=4 -> 429 on 5th.
	for i := 0; i < 5; i++ {
		q := url.Values{
			"schema_version": {"1.0"},
			"url":            {"https://www.bilibili.com/video/BV1xx411c7mD"},
			"token":          {ownerToken},
		}
		req := httptest.NewRequest(http.MethodGet, "/api/parse?"+q.Encode(), nil)
		req.RemoteAddr = "127.0.0.1:11111"
		req.Header.Set(edgeHeader, edgeKey)
		req.Header.Set(clientHeader, "198.51.100.99")
		w := call(entry, req)
		want := http.StatusOK
		if i == 4 {
			want = http.StatusTooManyRequests
		}
		if w.Code != want {
			t.Fatalf("?token= request #%d got %d, want %d", i+1, w.Code, want)
		}
	}
}

type fakeWeiboSafeExecutor struct {
	body  string
	calls atomic.Int64
}

func (f *fakeWeiboSafeExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	if err := ctx.Err(); err != nil {
		return fetch.Response{}, err
	}
	f.calls.Add(1)
	return fetch.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{},
		Body:       []byte(f.body),
		URL:        req.URL,
	}, nil
}

func TestWeiboOwnerVsAnonymousConcurrentIsolationAndHostAllowlist(t *testing.T) {
	ownerToken := randomPrintableToken(t, 48)
	edgeKey := randomPrintableToken(t, 40)

	registry, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	exec := &fakeWeiboSafeExecutor{body: weiboSyntheticResponse}
	// Enable parseCache (DefaultCacheConfig) to verify channel-invariant Weibo direct responses coalesce cleanly via cache + singleflight!
	h, err := NewWithCacheConfig(
		registry,
		map[string]Adapter{"weibo": weiboplatform.New(exec)},
		func() time.Time { return time.Unix(weiboFrozenNow, 0) },
		weiboplatform.PreparePublic,
		DefaultCacheConfig(),
	)
	if err != nil {
		t.Fatal(err)
	}
	auth, err := NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := WithAdmissionWithOwner(h, nil, "caddy", edgeKey, DefaultAdmissionConfig(), auth)
	if err != nil {
		t.Fatal(err)
	}

	// 1. 64 concurrent mixed requests (32 owner + 32 anonymous) for the exact same Weibo URL across /api/parse and /api/resolve.
	const pairs = 32
	startBarrier := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, pairs*2)

	checkDirectBlocked := func(label string, w *httptest.ResponseRecorder) {
		if w.Code != http.StatusOK {
			errs <- fmt.Errorf("%s status=%d body=%s", label, w.Code, w.Body.String())
			return
		}
		rawBody := w.Body.String()
		if strings.Contains(rawBody, "/api/media/weibo") {
			errs <- fmt.Errorf("%s unexpectedly contained relay route: %s", label, rawBody)
			return
		}
		payload, err := unified.Decode(w.Body.Bytes())
		if err != nil {
			errs <- err
			return
		}
		if err := unified.ValidateEnvelopeAt(payload, weiboFrozenNow); err != nil {
			errs <- fmt.Errorf("%s contract invalid: %v", label, err)
			return
		}
		item := unified.Map(unified.Slice(unified.Map(payload["data"])["items"])[0])
		def := unified.Map(item["default"])
		if (def["access"] != nil && def["access"] != "direct") || def["url"] != weiboCDNURL {
			errs <- fmt.Errorf("%s default=%v, want direct %s", label, def, weiboCDNURL)
			return
		}
		for _, v := range unified.Slice(item["variants"]) {
			for _, sv := range unified.Slice(unified.Map(unified.Map(v)["delivery"])["sources"]) {
				src := unified.Map(sv)
				if src["direct_url"] != nil || src["browser_fetch"] != "blocked" || src["url"] != weiboCDNURL {
					errs <- fmt.Errorf("%s unexpected source=%v", label, src)
					return
				}
			}
		}
	}

	for i := 0; i < pairs; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-startBarrier
			route := "/api/parse?schema_version=1.0&url=" + url.QueryEscape(weiboFrozenInput)
			if idx%2 == 1 {
				route = "/api/resolve?schema_version=1.0&url=" + url.QueryEscape(weiboFrozenInput) + "&item_id=video"
			}
			req := httptest.NewRequest(http.MethodGet, route, nil)
			req.RemoteAddr = "127.0.0.1:22222"
			req.Header.Set(edgeHeader, edgeKey)
			req.Header.Set(clientHeader, "198.51.100.1")
			req.Header.Set("Authorization", "Bearer "+ownerToken)
			checkDirectBlocked(fmt.Sprintf("owner #%d", idx), call(entry, req))
		}(i)

		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-startBarrier
			route := "/api/parse?schema_version=1.0&url=" + url.QueryEscape(weiboFrozenInput)
			if idx%2 == 1 {
				route = "/api/resolve?schema_version=1.0&url=" + url.QueryEscape(weiboFrozenInput) + "&item_id=video"
			}
			req := httptest.NewRequest(http.MethodGet, route, nil)
			req.RemoteAddr = "127.0.0.1:22222"
			req.Header.Set(edgeHeader, edgeKey)
			req.Header.Set(clientHeader, fmt.Sprintf("203.0.113.%d", idx+1))
			checkDirectBlocked(fmt.Sprintf("anonymous #%d", idx), call(entry, req))
		}(i)
	}
	close(startBarrier)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	// Verify parseCache + singleflight dramatically coalesced upstream Weibo requests (well below 64).
	if got := exec.calls.Load(); got > 4 {
		t.Fatalf("expected Weibo parseCache+singleflight coalescing across 64 concurrent calls, got %d upstream calls", got)
	}

	// 2. Disallowed media host from upstream is STILL rejected (allowlist preserved).
	target := "/api/parse?schema_version=1.0&url=" + url.QueryEscape(weiboFrozenInput)
	disallowedUpstream := `{"idstr":"1234567890","text_raw":"disallowed","page_info":{"media_info":{"mp4_hd_url":"https://evil.example.com/full.mp4","video_title":"t","duration":10}},"user":{"screen_name":"u","idstr":"1"}}`
	badHostHandler, err := New(
		registry,
		map[string]Adapter{"weibo": weiboplatform.New(&fakeWeiboSafeExecutor{body: disallowedUpstream})},
		func() time.Time { return time.Unix(weiboFrozenNow, 0) },
		weiboplatform.PreparePublic,
	)
	if err != nil {
		t.Fatal(err)
	}
	badHostEntry, err := WithAdmissionWithOwner(badHostHandler, nil, "caddy", edgeKey, DefaultAdmissionConfig(), auth)
	if err != nil {
		t.Fatal(err)
	}
	badHostReq := httptest.NewRequest(http.MethodGet, target, nil)
	badHostReq.RemoteAddr = "127.0.0.1:22222"
	badHostReq.Header.Set(edgeHeader, edgeKey)
	badHostReq.Header.Set(clientHeader, "198.51.100.1")
	badHostReq.Header.Set("Authorization", "Bearer "+ownerToken)
	if w := call(badHostEntry, badHostReq); w.Code != http.StatusBadGateway || strings.Contains(w.Body.String(), "evil.example.com") {
		t.Fatalf("owner Weibo must reject non-allowlisted media hosts: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestCanaryTokenNeverLeaksInLogsPanicOrResponses(t *testing.T) {
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal(err)
	}
	canaryToken := hex.EncodeToString(raw[:])
	canaryDigest := fmt.Sprintf("%x", sha256.Sum256([]byte(canaryToken)))
	edgeKey := randomPrintableToken(t, 40)

	var logBuf bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prevOut)

	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewWithCacheConfig(
		c,
		map[string]Adapter{
			"bilibili": AdapterFunc(func(_ context.Context, _ string, _ int64) (unified.Object, error) {
				panic("boom-" + canaryToken)
			}),
		},
		time.Now,
		nil,
		DefaultCacheConfig(),
	)
	if err != nil {
		t.Fatal(err)
	}
	var panicBuf bytes.Buffer
	h.panicLogf = func(format string, args ...any) {
		fmt.Fprintf(&panicBuf, format+"\n", args...)
	}

	auth, err := NewOwnerAuth(canaryToken)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := WithAdmissionWithOwner(h, nil, "caddy", edgeKey, DefaultAdmissionConfig(), auth)
	if err != nil {
		t.Fatal(err)
	}

	// Trigger panic on valid owner request + 401 on wrong request carrying canary substring.
	target := "/api/parse?schema_version=1.0&url=" + url.QueryEscape("https://www.bilibili.com/video/BV1xx411c7mD")
	reqValid := httptest.NewRequest(http.MethodGet, target, nil)
	reqValid.RemoteAddr = "127.0.0.1:33333"
	reqValid.Header.Set(edgeHeader, edgeKey)
	reqValid.Header.Set(clientHeader, "198.51.100.55")
	reqValid.Header.Set("Authorization", "Bearer "+canaryToken)
	wValid := call(entry, reqValid)
	if wValid.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 from recovered panic, got %d", wValid.Code)
	}

	reqBad := httptest.NewRequest(http.MethodGet, target, nil)
	reqBad.RemoteAddr = "127.0.0.1:33333"
	reqBad.Header.Set(edgeHeader, edgeKey)
	reqBad.Header.Set(clientHeader, "198.51.100.56")
	reqBad.Header.Set("Authorization", "Bearer "+canaryToken+"-wrong")
	wBad := call(entry, reqBad)
	if wBad.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 on wrong token, got %d", wBad.Code)
	}

	combined := logBuf.String() + "\n" + panicBuf.String() + "\n" + wValid.Body.String() + "\n" + wBad.Body.String()
	for name, needle := range map[string]string{
		"canary-token":  canaryToken,
		"canary-prefix": canaryToken[:16],
		"canary-digest": canaryDigest[:16],
	} {
		if strings.Contains(combined, needle) {
			t.Fatalf("%s leaked into logs/panic/responses: %q", name, combined)
		}
	}
}
