package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
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
