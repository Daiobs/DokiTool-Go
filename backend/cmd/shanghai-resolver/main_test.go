package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/bilibili"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/probe"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
)

func randomTestToken(t *testing.T) string {
	t.Helper()
	var buf [24]byte
	if _, err := rand.Read(buf[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(buf[:])
}

func TestRejectConflictingModesBeforeConnecting(t *testing.T) {
	for _, arg := range []string{"-listen=127.0.0.1:9083", "-tls-cert=unused", "-tls-key=unused"} {
		if err := run([]string{"-pull-origin=https://japan.example.org", arg}); err == nil || !strings.Contains(err.Error(), "pull mode") {
			t.Fatalf("%s did not reject mixed modes: %v", arg, err)
		}
		if err := run([]string{"-pull-origin=https://japan.example.org", "-workers=4", arg}); err == nil || !strings.Contains(err.Error(), "pull mode") {
			t.Fatalf("%s with -workers did not reject mixed modes: %v", arg, err)
		}
	}
	if err := run([]string{"-workers=4"}); err == nil || !strings.Contains(err.Error(), "requires -pull-origin") {
		t.Fatalf("-workers without -pull-origin was not rejected: %v", err)
	}
}

func TestPullRequiresOwnTokenAndOrigin(t *testing.T) {
	t.Setenv("DOKITOOL_SHANGHAI_TOKEN", randomTestToken(t))
	t.Setenv("DOKITOOL_SHANGHAI_PULL_TOKEN", "")
	if err := run([]string{"-pull-origin=https://japan.example.org"}); err == nil {
		t.Fatal("pull accepted only the old inbound bearer")
	}
	t.Setenv("DOKITOOL_SHANGHAI_PULL_TOKEN", randomTestToken(t))
	if err := run([]string{"-pull-origin="}); err == nil {
		t.Fatal("explicit empty pull origin accepted")
	}
}

func TestWorkersSubprocessHelper(t *testing.T) {
	raw := os.Getenv("SHANGHAI_RESOLVER_TEST_MAIN_ARGS")
	if raw == "" {
		return
	}
	os.Args = append([]string{"shanghai-resolver"}, strings.Split(raw, "\n")...)
	main()
}

func TestWorkersFlagBoundsAndStartupExitCode(t *testing.T) {
	t.Setenv("DOKITOOL_SHANGHAI_PULL_TOKEN", randomTestToken(t))

	// Invalid values (< 1, > 8, non-numeric) must fail immediately at startup.
	for _, bad := range []string{"0", "-1", "-2", "9", "100", "invalid"} {
		for _, args := range [][]string{
			{"-pull-origin=https://japan.example.org", "-workers=" + bad},
			{"-workers=" + bad},
		} {
			err := run(args)
			if err == nil {
				t.Fatalf("run(%v) succeeded for invalid -workers=%s", args, bad)
			}
			if bad != "invalid" && !strings.Contains(err.Error(), "workers must be between 1 and 8") {
				t.Fatalf("run(%v) unexpected error: %v", args, err)
			}
		}

		cmd := exec.Command(os.Args[0], "-test.run=^TestWorkersSubprocessHelper$")
		cmd.Env = append(os.Environ(), "SHANGHAI_RESOLVER_TEST_MAIN_ARGS=-pull-origin=https://japan.example.org\n-workers="+bad)
		out, err := cmd.CombinedOutput()
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() == 0 {
			t.Fatalf("main() with -workers=%s did not exit non-zero: err=%v out=%s", bad, err, out)
		}
	}

	// Valid boundary values (omitted default 3, plus 1, 3, 8) pass -workers validation
	// and proceed to pull worker construction (verified without network via loopback origin check).
	for _, args := range [][]string{
		{"-pull-origin=https://127.0.0.1"},
		{"-pull-origin=https://127.0.0.1", "-workers=1"},
		{"-pull-origin=https://127.0.0.1", "-workers=3"},
		{"-pull-origin=https://127.0.0.1", "-workers=8"},
	} {
		err := run(args)
		if err == nil || !strings.Contains(err.Error(), "public address") {
			t.Fatalf("run(%v) did not pass -workers validation into worker setup: %v", args, err)
		}
	}
}

type fakeUpstreamExecutor func(context.Context, fetch.Request) (fetch.Response, error)

func (f fakeUpstreamExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	return f(ctx, req)
}

func TestHandlerWithDetailSupportsBilibiliAndRejectsInvalidTasks(t *testing.T) {
	token := randomTestToken(t)
	exec := fakeUpstreamExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		if !bilibili.AllowedAPIURL(req.URL) || req.Header.Get("Cookie") != "" {
			t.Fatalf("unexpected outbound request from shanghai-resolver: %s", req.URL)
		}
		return fetch.Response{
			StatusCode: http.StatusOK,
			Body:       []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":"https://cn-zjhz-cu-01-01.bilivideo.com/upgcxcode/00/01/101/101-1-64.mp4?deadline=4102444800&upsig=dom","backup_url":["http://cn-insecure.bilivideo.com/drop.mp4?deadline=4102444800","https://evilbilivideo.com/drop.mp4?deadline=4102444800"]}]}}`),
		}, nil
	})
	p := probe.New(exec, douyin.AllowedMediaURL).WithTimeout(shresolver.ProbeTimeout)
	h, err := shresolver.NewHandlerWithDetail(token, exec, p)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, shresolver.Path, bytes.NewBufferString(`{"protocol":2,"task_type":"bilibili","bvid":"BV1234567890","cid":101}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("Bilibili handler status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var got bilibili.ShanghaiPlay
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.BVID != "BV1234567890" || got.CID != 101 || len(got.DURLPieces) != 1 || len(got.DURLPieces[0].URLs) != 1 {
		t.Fatalf("unexpected ShanghaiPlay response: %+v", got)
	}

	badReq := httptest.NewRequest(http.MethodPost, shresolver.Path, bytes.NewBufferString(`{"protocol":2,"task_type":"bilibili","bvid":"BVabcdefghij","cid":101}`))
	badReq.Header.Set("Authorization", "Bearer "+token)
	badRec := httptest.NewRecorder()
	h.ServeHTTP(badRec, badReq)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("invalid BVID status = %d, want 400", badRec.Code)
	}
}

func TestVersionSubcommandAndStartupLogs(t *testing.T) {
	// 1. Default version via subprocess (`shanghai-resolver version`) prints version + newline to stdout and exits 0.
	cmd := exec.Command(os.Args[0], "-test.run=^TestWorkersSubprocessHelper$")
	cmd.Env = append(os.Environ(), "SHANGHAI_RESOLVER_TEST_MAIN_ARGS=version")
	var subStdout, subStderr bytes.Buffer
	cmd.Stdout = &subStdout
	cmd.Stderr = &subStderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("main() with 'version' failed: err=%v stderr=%q", err, subStderr.String())
	}
	// go test prints PASS\n after TestWorkersSubprocessHelper returns; prefix must be version + "\n".
	if !strings.HasPrefix(subStdout.String(), "development\n") {
		t.Fatalf("subprocess stdout = %q, want prefix %q", subStdout.String(), "development\n")
	}

	// 2. Custom injected version in runWithContext prints exact version + newline and rejects extra positional args.
	prevVersion := version
	version = "4bf1880e66b0c5bd2fad73bf35bb8d29bd254f40"
	t.Cleanup(func() { version = prevVersion })

	var out bytes.Buffer
	if err := runWithContext(context.Background(), []string{"version"}, &out); err != nil {
		t.Fatalf("runWithContext(version) failed: %v", err)
	}
	if out.String() != "4bf1880e66b0c5bd2fad73bf35bb8d29bd254f40\n" {
		t.Fatalf("version output = %q, want %q", out.String(), "4bf1880e66b0c5bd2fad73bf35bb8d29bd254f40\n")
	}
	if err := runWithContext(context.Background(), []string{"version", "extra"}, &out); err == nil {
		t.Fatal("expected extra arg after version to fail")
	}

	// 3. Startup log in pull mode includes version=<sha> and never logs the pull token.
	pullToken := randomTestToken(t)
	t.Setenv("DOKITOOL_SHANGHAI_PULL_TOKEN", pullToken)
	var pullLogs bytes.Buffer
	prevLogOut := log.Writer()
	log.SetOutput(&pullLogs)
	t.Cleanup(func() { log.SetOutput(prevLogOut) })

	pullCtx, cancelPull := context.WithCancel(context.Background())
	cancelPull()
	if err := runWithContext(pullCtx, []string{"-pull-origin=https://japan.example.org", "-workers=4"}, &bytes.Buffer{}); err != nil {
		t.Fatalf("pull mode with pre-canceled ctx failed: %v", err)
	}
	pullLogStr := pullLogs.String()
	if !strings.Contains(pullLogStr, "version=4bf1880e66b0c5bd2fad73bf35bb8d29bd254f40") || !strings.Contains(pullLogStr, "pull mode") {
		t.Fatalf("pull startup log missing version or mode: %q", pullLogStr)
	}
	if strings.Contains(pullLogStr, pullToken) {
		t.Fatalf("pull startup log leaked token: %q", pullLogStr)
	}

	// 4. Startup log in direct mode includes version=<sha> and never logs the inbound token.
	directToken := randomTestToken(t)
	t.Setenv("DOKITOOL_SHANGHAI_TOKEN", directToken)
	var directLogs syncLogBuffer
	log.SetOutput(&directLogs)

	directCtx, cancelDirect := context.WithCancel(context.Background())
	directDone := make(chan error, 1)
	go func() {
		directDone <- runWithContext(directCtx, []string{"-listen=127.0.0.1:0"}, &bytes.Buffer{})
	}()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(directLogs.String(), "direct mode") {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancelDirect()
	if err := <-directDone; err != nil {
		t.Fatalf("direct mode shutdown returned error: %v", err)
	}
	directLogStr := directLogs.String()
	if !strings.Contains(directLogStr, "version=4bf1880e66b0c5bd2fad73bf35bb8d29bd254f40") || !strings.Contains(directLogStr, "direct mode") {
		t.Fatalf("direct startup log missing version or mode: %q", directLogStr)
	}
	if strings.Contains(directLogStr, directToken) {
		t.Fatalf("direct startup log leaked token: %q", directLogStr)
	}
}

type syncLogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncLogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestDirectModeGracefulShutdownTimeoutAndDrain(t *testing.T) {
	// 1. Unit-check directShutdownTimeout: uses s.WriteTimeout when positive, and
	//    falls back to shresolver.WorkTimeout + 2s (11s) when <= 0 or nil.
	wantFallback := shresolver.WorkTimeout + 2*time.Second
	if got := directShutdownTimeout(nil); got != wantFallback {
		t.Fatalf("directShutdownTimeout(nil) = %v, want %v", got, wantFallback)
	}
	for _, nonPos := range []time.Duration{0, -time.Second} {
		if got := directShutdownTimeout(&http.Server{WriteTimeout: nonPos}); got != wantFallback {
			t.Fatalf("directShutdownTimeout(WriteTimeout=%v) = %v, want %v", nonPos, got, wantFallback)
		}
	}
	customSrv := &http.Server{WriteTimeout: 14 * time.Second}
	if got := directShutdownTimeout(customSrv); got != customSrv.WriteTimeout || got < customSrv.WriteTimeout {
		t.Fatalf("directShutdownTimeout(14s) = %v, want %v", got, customSrv.WriteTimeout)
	}

	// 2. End-to-end runWithContext in direct mode: verify shutdown context timeout >= s.WriteTimeout
	//    (covering both 8s v1 ProbeTimeout and 7s v2 WorkResolveTimeout) and exits cleanly.
	t.Setenv("DOKITOOL_SHANGHAI_TOKEN", randomTestToken(t))
	prevLogOut := log.Writer()
	var logs syncLogBuffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(prevLogOut) })

	prevShutdown := shutdownServer
	var (
		capturedWriteTimeout time.Duration
		capturedDeadline     time.Time
		capturedHasDeadline  bool
	)
	shutdownServer = func(s *http.Server, ctx context.Context) error {
		capturedWriteTimeout = s.WriteTimeout
		capturedDeadline, capturedHasDeadline = ctx.Deadline()
		return s.Shutdown(ctx)
	}
	t.Cleanup(func() { shutdownServer = prevShutdown })

	directCtx, cancelDirect := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runWithContext(directCtx, []string{"-listen=127.0.0.1:0"}, io.Discard)
	}()

	waitDeadline := time.Now().Add(time.Second)
	for time.Now().Before(waitDeadline) {
		if strings.Contains(logs.String(), "direct mode") {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	beforeCancel := time.Now()
	cancelDirect()
	if err := <-done; err != nil {
		t.Fatalf("direct mode runWithContext shutdown failed: %v", err)
	}
	if !capturedHasDeadline {
		t.Fatal("expected direct mode shutdown context to carry a deadline")
	}
	if capturedWriteTimeout != wantFallback {
		t.Fatalf("direct mode WriteTimeout = %v, want %v", capturedWriteTimeout, wantFallback)
	}
	// Since context.WithTimeout runs after beforeCancel, capturedDeadline.Sub(beforeCancel) >= shutdownTimeout.
	observedBudget := capturedDeadline.Sub(beforeCancel)
	if observedBudget < capturedWriteTimeout {
		t.Fatalf("direct mode shutdown budget = %v, want >= WriteTimeout (%v)", observedBudget, capturedWriteTimeout)
	}
	if capturedWriteTimeout <= shresolver.ProbeTimeout || capturedWriteTimeout <= shresolver.WorkResolveTimeout {
		t.Fatalf("WriteTimeout (%v) must exceed v1 ProbeTimeout (%v) and v2 WorkResolveTimeout (%v)",
			capturedWriteTimeout, shresolver.ProbeTimeout, shresolver.WorkResolveTimeout)
	}

	// 3. Verify serveDirect drains an in-flight request cleanly upon cancellation without truncating it.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	inFlightEntered := make(chan struct{})
	releaseHandler := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(inFlightEntered)
		<-releaseHandler
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	serveCtx, cancelServe := context.WithCancel(context.Background())
	serveErrCh := make(chan error, 1)
	go func() {
		serveErrCh <- serveDirect(serveCtx, ln, handler, "", "")
	}()

	type httpResult struct {
		status int
		body   string
		err    error
	}
	reqDone := make(chan httpResult, 1)
	go func() {
		resp, reqErr := http.Get("http://" + ln.Addr().String() + shresolver.Path)
		if reqErr != nil {
			reqDone <- httpResult{err: reqErr}
			return
		}
		defer resp.Body.Close()
		b, readErr := io.ReadAll(resp.Body)
		reqDone <- httpResult{status: resp.StatusCode, body: string(b), err: readErr}
	}()

	<-inFlightEntered
	cancelServe()
	time.Sleep(30 * time.Millisecond)
	close(releaseHandler)

	res := <-reqDone
	if res.err != nil || res.status != http.StatusOK || res.body != `{"ok":true}` {
		t.Fatalf("in-flight request during graceful shutdown failed: %+v", res)
	}
	if err := <-serveErrCh; err != nil {
		t.Fatalf("serveDirect returned error after draining in-flight request: %v", err)
	}
}

func TestBilibiliDASHSwitchValidationAndStartupWiring(t *testing.T) {
	validCases := []struct {
		raw  string
		want bool
	}{
		{"", false},
		{"0", false},
		{"false", false},
		{"FALSE", false},
		{"f", false},
		{"1", true},
		{"true", true},
		{"TRUE", true},
		{"t", true},
	}
	for _, tc := range validCases {
		got, err := parseBilibiliDASH(func(k string) string {
			if k == "DOKITOOL_BILIBILI_DASH" {
				return tc.raw
			}
			return ""
		})
		if err != nil || got != tc.want {
			t.Fatalf("parseBilibiliDASH(%q) = (%v, %v), want (%v, nil)", tc.raw, got, err, tc.want)
		}
	}

	for _, invalid := range []string{"yes_please", "2", "on", "off", "auto", " true", "true "} {
		t.Setenv("DOKITOOL_BILIBILI_DASH", invalid)
		t.Setenv("DOKITOOL_SHANGHAI_TOKEN", randomTestToken(t))
		t.Setenv("DOKITOOL_SHANGHAI_PULL_TOKEN", randomTestToken(t))

		// Direct mode: must fail BEFORE listener bind and never echo raw invalid value.
		occupied, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		directErr := runWithContext(context.Background(), []string{"-listen=" + occupied.Addr().String()}, io.Discard)
		occupied.Close()
		if directErr == nil || !strings.Contains(directErr.Error(), "DOKITOOL_BILIBILI_DASH must be a boolean") {
			t.Fatalf("direct mode invalid %q: got err=%v, want DOKITOOL_BILIBILI_DASH boolean error", invalid, directErr)
		}
		if strings.Contains(directErr.Error(), invalid) {
			t.Fatalf("direct mode error echoed raw invalid value %q: %v", invalid, directErr)
		}

		// Pull mode: must fail BEFORE starting pull loop and never echo raw invalid value.
		pullErr := runWithContext(context.Background(), []string{"-pull-origin=https://japan.example.org"}, io.Discard)
		if pullErr == nil || !strings.Contains(pullErr.Error(), "DOKITOOL_BILIBILI_DASH must be a boolean") {
			t.Fatalf("pull mode invalid %q: got err=%v, want DOKITOOL_BILIBILI_DASH boolean error", invalid, pullErr)
		}
		if strings.Contains(pullErr.Error(), invalid) {
			t.Fatalf("pull mode error echoed raw invalid value %q: %v", invalid, pullErr)
		}
	}

	// Verify both pull mode and direct mode wire DOKITOOL_BILIBILI_DASH (default false, explicit true).
	prevLogOut := log.Writer()
	t.Cleanup(func() { log.SetOutput(prevLogOut) })

	for _, tc := range []struct {
		envVal string
		want   string
	}{
		{"", "bilibili_dash=false"},
		{"false", "bilibili_dash=false"},
		{"true", "bilibili_dash=true"},
	} {
		t.Run("wiring/"+tc.envVal, func(t *testing.T) {
			t.Setenv("DOKITOOL_BILIBILI_DASH", tc.envVal)
			t.Setenv("DOKITOOL_SHANGHAI_PULL_TOKEN", randomTestToken(t))
			t.Setenv("DOKITOOL_SHANGHAI_TOKEN", randomTestToken(t))

			var pullLogs syncLogBuffer
			log.SetOutput(&pullLogs)
			pullCtx, cancelPull := context.WithCancel(context.Background())
			cancelPull()
			if err := runWithContext(pullCtx, []string{"-pull-origin=https://japan.example.org"}, io.Discard); err != nil {
				t.Fatalf("pull mode failed: %v", err)
			}
			if !strings.Contains(pullLogs.String(), tc.want) {
				t.Fatalf("pull log %q missing %q", pullLogs.String(), tc.want)
			}

			var directLogs syncLogBuffer
			log.SetOutput(&directLogs)
			directCtx, cancelDirect := context.WithCancel(context.Background())
			directDone := make(chan error, 1)
			go func() {
				directDone <- runWithContext(directCtx, []string{"-listen=127.0.0.1:0"}, io.Discard)
			}()
			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				if strings.Contains(directLogs.String(), "direct mode") {
					break
				}
				time.Sleep(5 * time.Millisecond)
			}
			cancelDirect()
			if err := <-directDone; err != nil {
				t.Fatalf("direct mode failed: %v", err)
			}
			if !strings.Contains(directLogs.String(), tc.want) {
				t.Fatalf("direct log %q missing %q", directLogs.String(), tc.want)
			}
		})
	}
}
