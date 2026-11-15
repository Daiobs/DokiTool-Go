package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"

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
