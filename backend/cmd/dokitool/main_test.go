package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/api"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/bearer"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/kuaishou"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/pipixia"
	weiboplatform "github.com/Brilliant666/DokiTool-Go/backend/internal/platform/weibo"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/x"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/xiaohongshu"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/youtube"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/zuiyou"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/probe"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func TestXHSPageTransportSelection(t *testing.T) {
	for _, mode := range []string{"standard", "chrome131"} {
		executor, err := newXHSExecutor(mode)
		if err != nil || executor == nil {
			t.Fatalf("valid mode %s failed: %v", mode, err)
		}
	}
	for _, mode := range []string{"", "auto", "chrome150", "https://proxy.example.test", "Chrome131"} {
		if executor, err := newXHSExecutor(mode); err == nil || executor != nil {
			t.Fatalf("invalid mode accepted: %q", mode)
		}
	}
}

func TestUnknownXHSPageTransportFailsBeforeListener(t *testing.T) {
	if err := run([]string{"serve", "-xhs-page-transport", "auto"}); err == nil {
		t.Fatal("unknown transport accepted")
	}
}

func TestAdmissionCaddyRequiresConfiguredKeyBeforeListener(t *testing.T) {
	t.Setenv("SNAP_INGRESS_KEY", "")
	occupied, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	err = run([]string{"serve", "-listen", occupied.Addr().String(), "-client-identity", "caddy"})
	if err == nil || !strings.Contains(err.Error(), "SNAP_INGRESS_KEY") {
		t.Fatalf("want missing proxy authentication before binding, got %v", err)
	}
}
func TestShanghaiModeSelection(t *testing.T) {
	const (
		mode     = "DOKITOOL_SHANGHAI_MODE"
		endpoint = "DOKITOOL_SHANGHAI_ENDPOINT"
		token    = "DOKITOOL_SHANGHAI_TOKEN"
		pull     = "DOKITOOL_SHANGHAI_PULL_TOKEN"
		address  = "https://shanghai.example.org/v1/douyin/original"
		key      = "development-test-only-32-byte-bearer"
	)
	tests := []struct {
		name                       string
		env                        map[string]string
		resolver, control, invalid bool
	}{
		{"default-off", nil, false, false, false},
		{"explicit-off", map[string]string{mode: "off", endpoint: address, token: key, pull: key}, false, false, false},
		{"legacy-direct", map[string]string{endpoint: address, token: key}, true, false, false},
		{"legacy-invalid-stays-off", map[string]string{endpoint: "invalid"}, false, false, false},
		{"explicit-direct", map[string]string{mode: "direct", endpoint: address, token: key}, true, false, false},
		{"explicit-pull", map[string]string{mode: "pull", pull: key}, true, true, false},
		{"missing-pull-credential", map[string]string{mode: "pull", token: key}, false, false, true},
		{"shared-credential", map[string]string{mode: "pull", pull: key, "SNAP_INGRESS_KEY": key}, false, false, true},
		{"ambiguous", map[string]string{mode: "pull", pull: key, endpoint: address}, false, false, true},
		{"invalid-mode", map[string]string{mode: "auto", pull: key}, false, false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s, h, err := configureShanghai(fetch.New(), func(k string) string { return tc.env[k] })
			if (err != nil) != tc.invalid || (s != nil) != tc.resolver || (h != nil) != tc.control {
				t.Fatalf("resolver=%T control=%T error=%v", s, h, err)
			}
		})
	}
}

func TestYTDLPXConfiguration(t *testing.T) {
	dir := t.TempDir()
	fakeBin := filepath.Join(dir, "yt-dlp")
	payload := []byte("#!/bin/sh\necho '{}' \n")
	if err := os.WriteFile(fakeBin, payload, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	hexSum := hex.EncodeToString(sum[:])

	origAsset, hadOrig := ytengine.OfficialSHA256Sums[hexSum]
	ytengine.OfficialSHA256Sums[hexSum] = "yt-dlp-cmd-test"
	defer func() {
		if hadOrig {
			ytengine.OfficialSHA256Sums[hexSum] = origAsset
		} else {
			delete(ytengine.OfficialSHA256Sums, hexSum)
		}
	}()

	tests := []struct {
		name           string
		env            map[string]string
		wantRegistered bool
		wantErr        bool
	}{
		{
			name:           "default-off",
			env:            nil,
			wantRegistered: false,
			wantErr:        false,
		},
		{
			name:           "explicit-false",
			env:            map[string]string{"DOKITOOL_YTDLP_X_ENABLED": "false"},
			wantRegistered: false,
			wantErr:        false,
		},
		{
			name:           "invalid-bool",
			env:            map[string]string{"DOKITOOL_YTDLP_X_ENABLED": "auto"},
			wantRegistered: false,
			wantErr:        true,
		},
		{
			name: "enabled-missing-binary-not-registered-in-catalog",
			env: map[string]string{
				"DOKITOOL_YTDLP_X_ENABLED": "true",
				"DOKITOOL_YTDLP_BINARY":    filepath.Join(dir, "missing-yt-dlp"),
			},
			wantRegistered: false,
			wantErr:        false,
		},
		{
			name: "enabled-verified-binary",
			env: map[string]string{
				"DOKITOOL_YTDLP_X_ENABLED": "true",
				"DOKITOOL_YTDLP_BINARY":    fakeBin,
			},
			wantRegistered: true,
			wantErr:        false,
		},
		{
			name: "enabled-verified-binary-via-path",
			env: map[string]string{
				"DOKITOOL_YTDLP_X_ENABLED": "true",
				"PATH":                     dir,
			},
			wantRegistered: true,
			wantErr:        false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, err := catalog.Load()
			if err != nil {
				t.Fatal(err)
			}
			adapters := map[string]api.Adapter{}
			err = configureYTDLPX(c, adapters, fetch.New(), func(k string) string { return tc.env[k] })
			if (err != nil) != tc.wantErr {
				t.Fatalf("configureYTDLPX err=%v, wantErr=%v", err, tc.wantErr)
			}
			if c.Has("x") != tc.wantRegistered || (adapters["x"] != nil) != tc.wantRegistered {
				t.Fatalf("catalog.Has(x)=%v adapter=%v, wantRegistered=%v", c.Has("x"), adapters["x"] != nil, tc.wantRegistered)
			}
		})
	}

	t.Run("x-engine-pins-twitter-extractors-and-forbids-generic", func(t *testing.T) {
		baseEngine, err := ytengine.NewFromEnv(func(k string) string {
			if k == "DOKITOOL_YTDLP_BINARY" {
				return fakeBin
			}
			return ""
		}, nil)
		if err != nil || !baseEngine.Enabled() {
			t.Fatalf("NewFromEnv failed: %v", err)
		}
		xEngine := newXEngine(baseEngine)
		target := "https://x.com/i/status/2115900212212588814"
		args := xEngine.CommandArgs(target)
		wantExtractors := strings.Join(x.AllowedExtractors(), ",")
		if wantExtractors != "twitter,twitter:amplify,twitter:broadcast,twitter:card,twitter:spaces" {
			t.Fatalf("unexpected x.AllowedExtractors(): %q", wantExtractors)
		}
		if strings.Contains(wantExtractors, "generic") || strings.Contains(wantExtractors, "shortener") {
			t.Fatalf("x.AllowedExtractors() must exclude generic and twitter:shortener, got %q", wantExtractors)
		}
		var sawUseExtractors bool
		for i := 0; i < len(args)-1; i++ {
			if args[i] == "--use-extractors" {
				sawUseExtractors = true
				if args[i+1] != wantExtractors {
					t.Fatalf("--use-extractors value = %q, want %q (args=%v)", args[i+1], wantExtractors, args)
				}
			}
		}
		if !sawUseExtractors {
			t.Fatalf("expected --use-extractors in xEngine CommandArgs, got %v", args)
		}
	})
}

func TestYouTubeHelperConfiguration(t *testing.T) {
	denoBin := strings.TrimSpace(os.Getenv("DOKITOOL_DENO_BINARY"))
	if denoBin == "" {
		if runnerTemp := strings.TrimSpace(os.Getenv("RUNNER_TEMP")); runnerTemp != "" {
			candidate := filepath.Join(runnerTemp, "dokitool-validation", "bin", "deno")
			if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
				denoBin = candidate
			}
		}
	}
	if denoBin == "" {
		p, err := exec.LookPath("deno")
		if err != nil || p == "" {
			t.Fatalf("deno v%s binary not found in DOKITOOL_DENO_BINARY or PATH", youtube.PinnedDenoVersion)
		}
		denoBin = p
	}
	ejsDir := filepath.Join("..", "..", "internal", "platform", "youtube", "testdata", "ejs")

	tests := []struct {
		name           string
		env            map[string]string
		wantRegistered bool
		wantErr        bool
	}{
		{
			name:           "default-off",
			env:            nil,
			wantRegistered: false,
			wantErr:        false,
		},
		{
			name:           "explicit-false",
			env:            map[string]string{"DOKITOOL_YOUTUBE_HELPER": "false"},
			wantRegistered: false,
			wantErr:        false,
		},
		{
			name:           "invalid-bool",
			env:            map[string]string{"DOKITOOL_YOUTUBE_HELPER": "auto"},
			wantRegistered: false,
			wantErr:        true,
		},
		{
			name: "enabled-missing-assets-disables-helper-only",
			env: map[string]string{
				"DOKITOOL_YOUTUBE_HELPER": "true",
				"DOKITOOL_DENO_BINARY":    filepath.Join(t.TempDir(), "missing-deno"),
				"DOKITOOL_EJS_DIR":        ejsDir,
			},
			wantRegistered: false,
			wantErr:        false,
		},
		{
			name: "enabled-verified-assets",
			env: map[string]string{
				"DOKITOOL_YOUTUBE_HELPER": "true",
				"DOKITOOL_DENO_BINARY":    denoBin,
				"DOKITOOL_EJS_DIR":        ejsDir,
			},
			wantRegistered: true,
			wantErr:        false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, err := catalog.Load()
			if err != nil {
				t.Fatal(err)
			}
			h, err := api.New(c, nil, time.Now, nil)
			if err != nil {
				t.Fatal(err)
			}
			err = configureYouTubeHelper(c, h, fetch.New(), func(k string) string { return tc.env[k] })
			if (err != nil) != tc.wantErr {
				t.Fatalf("configureYouTubeHelper err=%v, wantErr=%v", err, tc.wantErr)
			}
			// Check whether /api/youtube/context returns 404 (disabled) vs non-404 (enabled, e.g. 409 without schema_version).
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/youtube/context", nil))
			isEnabled := rec.Code != http.StatusNotFound
			if isEnabled != tc.wantRegistered {
				t.Fatalf("helper enabled=%v (status=%d), want %v", isEnabled, rec.Code, tc.wantRegistered)
			}
		})
	}
}

func TestYTDLPSitesConfiguration(t *testing.T) {
	dir := t.TempDir()
	fakeBin := filepath.Join(dir, "yt-dlp")
	payload := []byte("#!/bin/sh\necho '{}' \n")
	if err := os.WriteFile(fakeBin, payload, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	hexSum := hex.EncodeToString(sum[:])

	origAsset, hadOrig := ytengine.OfficialSHA256Sums[hexSum]
	ytengine.OfficialSHA256Sums[hexSum] = "yt-dlp-sites-cmd-test"
	defer func() {
		if hadOrig {
			ytengine.OfficialSHA256Sums[hexSum] = origAsset
		} else {
			delete(ytengine.OfficialSHA256Sums, hexSum)
		}
	}()

	tests := []struct {
		name      string
		env       map[string]string
		wantSites []string
		wantErr   bool
	}{
		{
			name:      "default-off",
			env:       nil,
			wantSites: nil,
			wantErr:   false,
		},
		{
			name: "unknown-site-fails-even-when-other-switches-off-and-binary-missing",
			env: map[string]string{
				"DOKITOOL_YTDLP_SITES":  "facebook,vimeo",
				"DOKITOOL_YTDLP_BINARY": filepath.Join(dir, "missing-yt-dlp"),
			},
			wantSites: nil,
			wantErr:   true,
		},
		{
			name: "empty-token-fails",
			env: map[string]string{
				"DOKITOOL_YTDLP_SITES": "facebook,,tumblr",
			},
			wantSites: nil,
			wantErr:   true,
		},
		{
			name: "retired-dailymotion-only-is-graceful-noop",
			env: map[string]string{
				"DOKITOOL_YTDLP_SITES":  "dailymotion",
				"DOKITOOL_YTDLP_BINARY": filepath.Join(dir, "missing-yt-dlp"),
			},
			wantSites: nil,
			wantErr:   false,
		},
		{
			name: "enabled-missing-binary-not-registered-in-catalog",
			env: map[string]string{
				"DOKITOOL_YTDLP_SITES":  "facebook,tumblr,dailymotion",
				"DOKITOOL_YTDLP_BINARY": filepath.Join(dir, "missing-yt-dlp"),
			},
			wantSites: nil,
			wantErr:   false,
		},
		{
			name: "enabled-verified-binary-registers-selected-sites-and-skips-retired-dailymotion",
			env: map[string]string{
				"DOKITOOL_YTDLP_SITES":  "facebook,tumblr,dailymotion",
				"DOKITOOL_YTDLP_BINARY": fakeBin,
			},
			wantSites: []string{"facebook", "tumblr"},
			wantErr:   false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, err := catalog.Load()
			if err != nil {
				t.Fatal(err)
			}
			adapters := map[string]api.Adapter{}
			err = configureYTDLPX(c, adapters, fetch.New(), func(k string) string { return tc.env[k] })
			if (err != nil) != tc.wantErr {
				t.Fatalf("configureYTDLPX err=%v, wantErr=%v", err, tc.wantErr)
			}
			wantSet := map[string]bool{}
			for _, id := range tc.wantSites {
				wantSet[id] = true
			}
			for _, id := range []string{"facebook", "tumblr", "dailymotion", "x", "youtube", "instagram"} {
				want := wantSet[id]
				if c.Has(id) != want || (adapters[id] != nil) != want {
					t.Fatalf("site %s: catalog.Has=%v adapter=%v, want=%v", id, c.Has(id), adapters[id] != nil, want)
				}
			}
			if len(tc.wantSites) == 2 {
				if got := c.PlatformForURL("https://www.facebook.com/reel/1517545242764683"); got != "facebook" {
					t.Fatalf("PlatformForURL(facebook)=%q, want facebook", got)
				}
				if got := c.PlatformForURL("https://maskofthedragon.tumblr.com/post/706987028632748032"); got != "tumblr" {
					t.Fatalf("PlatformForURL(tumblr)=%q, want tumblr", got)
				}
				if got := c.PlatformForURL("https://www.dailymotion.com/video/x8t9abc"); got != "" {
					t.Fatalf("PlatformForURL(dailymotion)=%q, want empty", got)
				}
			}
		})
	}

	t.Run("unknown-site-fails-serve-before-listener", func(t *testing.T) {
		t.Setenv("DOKITOOL_YTDLP_SITES", "facebook,unknownsite")
		occupied, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer occupied.Close()
		err = run([]string{"serve", "-listen", occupied.Addr().String(), "-client-identity", "direct"})
		if err == nil || !strings.Contains(err.Error(), "DOKITOOL_YTDLP_SITES") {
			t.Fatalf("want DOKITOOL_YTDLP_SITES startup error before binding listener, got %v", err)
		}
	})
}

func TestXTombstoneFallbackFlagAndConfiguration(t *testing.T) {
	for _, valid := range []string{x.TombstoneFallbackOff, x.TombstoneFallbackFxTwitter} {
		if err := x.ValidateTombstoneFallback(valid); err != nil {
			t.Fatalf("ValidateTombstoneFallback(%q) failed: %v", valid, err)
		}
	}
	for _, invalid := range []string{"", "auto", "true", "false", "vxtwitter", "FXTWITTER", "Off", "https://api.fxtwitter.com"} {
		if err := x.ValidateTombstoneFallback(invalid); err == nil {
			t.Fatalf("ValidateTombstoneFallback(%q) unexpectedly succeeded", invalid)
		}
		occupied, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		runErr := run([]string{"serve", "-listen", occupied.Addr().String(), "-x-tombstone-fallback", invalid})
		occupied.Close()
		if runErr == nil || !strings.Contains(runErr.Error(), "x-tombstone-fallback") {
			t.Fatalf("want startup error before listener for -x-tombstone-fallback=%q, got %v", invalid, runErr)
		}
	}

	dir := t.TempDir()
	fakeBin := filepath.Join(dir, "yt-dlp")
	payload := []byte("#!/bin/sh\necho '{}' \n")
	if err := os.WriteFile(fakeBin, payload, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	hexSum := hex.EncodeToString(sum[:])

	origAsset, hadOrig := ytengine.OfficialSHA256Sums[hexSum]
	ytengine.OfficialSHA256Sums[hexSum] = "yt-dlp-tombstone-cmd-test"
	defer func() {
		if hadOrig {
			ytengine.OfficialSHA256Sums[hexSum] = origAsset
		} else {
			delete(ytengine.OfficialSHA256Sums, hexSum)
		}
	}()

	env := map[string]string{
		"DOKITOOL_YTDLP_X_ENABLED": "true",
		"DOKITOOL_YTDLP_BINARY":    fakeBin,
	}

	// Default configureYTDLPX keeps tombstone fallback off.
	cDefault, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	defaultAdapters := map[string]api.Adapter{}
	if err := configureYTDLPX(cDefault, defaultAdapters, fetch.New(), func(k string) string { return env[k] }); err != nil {
		t.Fatalf("configureYTDLPX failed: %v", err)
	}
	defaultX, ok := defaultAdapters["x"].(*x.Parser)
	if !ok || defaultX == nil || defaultX.TombstoneFallback() != x.TombstoneFallbackOff {
		t.Fatalf("default X parser TombstoneFallback = %v, want %q", defaultAdapters["x"], x.TombstoneFallbackOff)
	}

	// Explicit off and fxtwitter modes wire cleanly into the registered X adapter.
	for _, mode := range []string{x.TombstoneFallbackOff, x.TombstoneFallbackFxTwitter} {
		c, err := catalog.Load()
		if err != nil {
			t.Fatal(err)
		}
		adapters := map[string]api.Adapter{}
		if err := configureYTDLPWithOptions(c, adapters, fetch.New(), mode, func(k string) string { return env[k] }); err != nil {
			t.Fatalf("configureYTDLPWithOptions(%q) failed: %v", mode, err)
		}
		xp, ok := adapters["x"].(*x.Parser)
		if !ok || xp == nil || xp.TombstoneFallback() != mode {
			t.Fatalf("mode %q: X parser TombstoneFallback = %v, want %q", mode, adapters["x"], mode)
		}
	}
}

func TestParseCacheStartupSwitch(t *testing.T) {
	for _, invalid := range []string{"true", "false", "1", "0", "ON", "OFF", " on", "off ", "auto"} {
		t.Setenv("DOKITOOL_PARSE_CACHE", invalid)
		occupied, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		runErr := run([]string{"serve", "-listen", occupied.Addr().String(), "-client-identity", "direct"})
		occupied.Close()
		if runErr == nil || !strings.Contains(runErr.Error(), "DOKITOOL_PARSE_CACHE must be on or off") {
			t.Fatalf("want DOKITOOL_PARSE_CACHE startup error before binding listener for %q, got %v", invalid, runErr)
		}
	}

	for _, valid := range []string{"", "on", "off"} {
		t.Setenv("DOKITOOL_PARSE_CACHE", valid)
		occupied, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		runErr := run([]string{"serve", "-listen", occupied.Addr().String(), "-client-identity", "direct"})
		occupied.Close()
		if runErr == nil || strings.Contains(runErr.Error(), "DOKITOOL_PARSE_CACHE") {
			t.Fatalf("valid DOKITOOL_PARSE_CACHE=%q should reach listener bind (expected address-in-use error), got %v", valid, runErr)
		}
	}
}

type fakeExecutor func(context.Context, fetch.Request) (fetch.Response, error)

func (f fakeExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	return f(ctx, req)
}

func TestPreparePublicMediaMultiRoutePlatforms(t *testing.T) {
	const now int64 = 1793448000
	registry, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}

	xhsHTML := `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"6a7e74de0000000033033075":{"note":{"noteId":"6a7e74de0000000033033075","type":"video","title":"XHS HTTP transcode","video":{"media":{"stream":{"h264":[{"masterUrl":"http://sns-v11.rednotecdn.com/stream/only.mp4?sig=a%2Bb","backupUrls":["http://sns-v27.rednotecdn.com/stream/only.mp4?sig=a%2Bb"],"width":720,"height":1280}]}}}}}}}}</script>`
	xhsAdapter := xiaohongshu.New(fakeExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(xhsHTML)}, nil
	}))

	ksTarget := "https://c.kuaishou.com/fw/photo/3xngkmw8vacriqu"
	ksHTML := `<script>window.INIT_STATE = {"tusjoh-a":{"photo":{"photoType":"VIDEO","caption":"KS routes","mainMvUrls":[{"url":"https://v1.kwaicdn.com/ks1.mp4"},{"url":"https://v23-3.kwaicdn.com/ks2.mp4"}]}}};</script>`
	ksAdapter := kuaishou.New(fakeExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		if req.Method == http.MethodHead {
			return fetch.Response{StatusCode: http.StatusOK, URL: ksTarget}, nil
		}
		return fetch.Response{StatusCode: http.StatusOK, URL: ksTarget, Body: []byte(ksHTML)}, nil
	}))

	ppxHTML := `<script>{"ppxItemDetail":{"item":{"item_id_str":"7385813877985909043","content":"PPX routes","video":{"video_high":{"width":720,"height":1280,"url_list":[{"url":"https://v6-cdn-tos.ppxvod.com/` + strings.Repeat("a", 32) + `/6a000001/video/tos/cn/tos-cn-ve-0026/ObjA/?a=1319&ft=1&dy_q=1&l=1"},{"url":"https://v26-cdn-tos.ppxvod.com/` + strings.Repeat("b", 32) + `/6a000001/video/tos/cn/tos-cn-ve-0026/ObjA/?a=1319&ft=1&dy_q=1&l=1"}]}}}}}</script>`
	ppxAdapter := pipixia.New(fakeExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(ppxHTML)}, nil
	}))

	zyBody := `{"ret":1,"data":{"post":{"id":427896637,"content":"ZY image","member":{"name":"ZY","avatar_urls":{"origin":{"urls":["http://bd-tbfile.izuiyou.com/avatar/1?sig=a%2Bb"]}}},"imgs":[{"id":1,"urls":{"origin":{"urls":["http://web-f01.izuiyou.com/img/view/id/427896637?sig=a%2Bb"]},"540_webp":{"urls":["http://web-f01.izuiyou.com/img/webp/id/427896637"]}}}],"videos":{}}}}`
	zyAdapter := zuiyou.New(fakeExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(zyBody)}, nil
	}))

	h, err := api.New(registry, map[string]api.Adapter{
		"xiaohongshu": xhsAdapter,
		"kuaishou":    ksAdapter,
		"pipixia":     ppxAdapter,
		"zuiyou":      zyAdapter,
	}, func() time.Time { return time.Unix(now, 0) }, preparePublicMedia())
	if err != nil {
		t.Fatal(err)
	}

	checks := []struct {
		platform  string
		sourceURL string
		wantURLs  []string
	}{
		{
			platform:  "xiaohongshu",
			sourceURL: "https://www.xiaohongshu.com/explore/6a7e74de0000000033033075",
			wantURLs:  []string{"https://sns-v11.rednotecdn.com/stream/only.mp4?sig=a%2Bb", "https://sns-v27.rednotecdn.com/stream/only.mp4?sig=a%2Bb"},
		},
		{
			platform:  "kuaishou",
			sourceURL: "https://www.kuaishou.com/short-video/3xngkmw8vacriqu",
			wantURLs:  []string{"https://v1.kwaicdn.com/ks1.mp4", "https://v23-3.kwaicdn.com/ks2.mp4"},
		},
		{
			platform:  "pipixia",
			sourceURL: "https://h5.pipix.com/item/7385813877985909043",
			wantURLs: []string{
				"https://v6-cdn-tos.ppxvod.com/" + strings.Repeat("a", 32) + "/6a000001/video/tos/cn/tos-cn-ve-0026/ObjA/?a=1319&ft=1&dy_q=1&l=1",
				"https://v26-cdn-tos.ppxvod.com/" + strings.Repeat("b", 32) + "/6a000001/video/tos/cn/tos-cn-ve-0026/ObjA/?a=1319&ft=1&dy_q=1&l=1",
			},
		},
		{
			platform:  "zuiyou",
			sourceURL: "https://share.xiaochuankeji.cn/hybrid/share/post?pid=427896637",
			wantURLs:  []string{"https://web-f01.izuiyou.com/img/view/id/427896637?sig=a%2Bb"},
		},
	}

	for _, tc := range checks {
		t.Run(tc.platform, func(t *testing.T) {
			q := url.Values{"schema_version": {"1.0"}, "url": {tc.sourceURL}}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?"+q.Encode(), nil))
			if w.Code != http.StatusOK {
				t.Fatalf("GET /api/parse (%s) status=%d body=%s", tc.platform, w.Code, w.Body.String())
			}
			out, err := unified.Decode(w.Body.Bytes())
			if err != nil {
				t.Fatal(err)
			}
			if err := unified.ValidateEnvelopeAt(out, now); err != nil {
				t.Fatalf("ValidateEnvelopeAt failed: %v", err)
			}
			item := unified.Map(unified.Slice(unified.Map(out["data"])["items"])[0])
			if gotDefault := unified.Str(unified.Map(item["default"])["url"]); gotDefault != tc.wantURLs[0] {
				t.Fatalf("default.url = %q, want %q", gotDefault, tc.wantURLs[0])
			}
			sources := unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["sources"])
			if len(sources) != len(tc.wantURLs) {
				t.Fatalf("sources len = %d, want %d", len(sources), len(tc.wantURLs))
			}
			for i, want := range tc.wantURLs {
				src := unified.Map(sources[i])
				if got := unified.Str(src["url"]); got != want {
					t.Fatalf("source[%d].url = %q, want %q", i, got, want)
				}
				if got := unified.Str(src["browser_fetch"]); got != "allowed" {
					t.Fatalf("source[%d].browser_fetch = %q, want allowed", i, got)
				}
			}
		})
	}
}

func randomHexToken(t *testing.T, bytesLen int) string {
	t.Helper()
	buf := make([]byte, bytesLen)
	if _, err := rand.Read(buf); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(buf)
}

func TestOwnerChannelStartupValidationAndNoSecretLeak(t *testing.T) {
	canaryShort := randomHexToken(t, 12) // 24 chars (< 32)
	canaryLong := randomHexToken(t, 260) // 520 chars (> 512)
	canaryShared := randomHexToken(t, 24)
	canaryValid := randomHexToken(t, 24)
	canaryBadInt := randomHexToken(t, 10)

	var logBuf bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prevOut)

	badEnvCases := []struct {
		name      string
		env       map[string]string
		wantSub   string
		forbidSub string
	}{
		{
			name:      "short-owner-token",
			env:       map[string]string{"DOKITOOL_OWNER_TOKEN": canaryShort},
			wantSub:   "DOKITOOL_OWNER_TOKEN",
			forbidSub: canaryShort[:12],
		},
		{
			name:      "overlong-owner-token",
			env:       map[string]string{"DOKITOOL_OWNER_TOKEN": canaryLong},
			wantSub:   "DOKITOOL_OWNER_TOKEN",
			forbidSub: canaryLong[:12],
		},
		{
			name:      "whitespace-owner-token",
			env:       map[string]string{"DOKITOOL_OWNER_TOKEN": " " + canaryValid},
			wantSub:   "DOKITOOL_OWNER_TOKEN",
			forbidSub: canaryValid[:12],
		},
		{
			name: "shared-with-ingress-key",
			env: map[string]string{
				"DOKITOOL_OWNER_TOKEN": canaryShared,
				"SNAP_INGRESS_KEY":     canaryShared,
			},
			wantSub:   "DOKITOOL_OWNER_TOKEN requires a dedicated credential",
			forbidSub: canaryShared[:12],
		},
		{
			name: "shared-with-shanghai-pull-token",
			env: map[string]string{
				"DOKITOOL_OWNER_TOKEN":         canaryShared,
				"DOKITOOL_SHANGHAI_MODE":       "pull",
				"DOKITOOL_SHANGHAI_PULL_TOKEN": canaryShared,
			},
			wantSub:   "dedicated",
			forbidSub: canaryShared[:12],
		},
		{
			name:      "concurrency-zero",
			env:       map[string]string{"DOKITOOL_OWNER_CONCURRENCY": "0"},
			wantSub:   "DOKITOOL_OWNER_CONCURRENCY",
			forbidSub: canaryBadInt,
		},
		{
			name:      "concurrency-above-32",
			env:       map[string]string{"DOKITOOL_OWNER_CONCURRENCY": "33"},
			wantSub:   "DOKITOOL_OWNER_CONCURRENCY",
			forbidSub: canaryBadInt,
		},
		{
			name:      "concurrency-non-integer",
			env:       map[string]string{"DOKITOOL_OWNER_CONCURRENCY": canaryBadInt},
			wantSub:   "DOKITOOL_OWNER_CONCURRENCY",
			forbidSub: canaryBadInt,
		},
	}

	for _, tc := range badEnvCases {
		t.Run(tc.name, func(t *testing.T) {
			for _, k := range []string{
				"DOKITOOL_OWNER_TOKEN",
				"DOKITOOL_OWNER_CONCURRENCY",
				"SNAP_INGRESS_KEY",
				"SNAP_MEDIA_SIGNING_KEY",
				"DOKITOOL_SHANGHAI_MODE",
				"DOKITOOL_SHANGHAI_PULL_TOKEN",
			} {
				t.Setenv(k, tc.env[k])
			}
			occupied, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			runErr := run([]string{"serve", "-listen", occupied.Addr().String(), "-client-identity", "direct"})
			occupied.Close()
			if runErr == nil || !strings.Contains(runErr.Error(), tc.wantSub) {
				t.Fatalf("expected startup error containing %q before listener bind, got %v", tc.wantSub, runErr)
			}
			if tc.forbidSub != "" && strings.Contains(runErr.Error(), tc.forbidSub) {
				t.Fatalf("startup error leaked secret/raw value: %v", runErr)
			}
		})
	}

	// Valid DOKITOOL_OWNER_TOKEN + DOKITOOL_OWNER_CONCURRENCY reaches listener bind and never logs the token.
	t.Setenv("DOKITOOL_OWNER_TOKEN", canaryValid)
	t.Setenv("DOKITOOL_OWNER_CONCURRENCY", "16")
	t.Setenv("SNAP_INGRESS_KEY", "")
	t.Setenv("SNAP_MEDIA_SIGNING_KEY", "")
	t.Setenv("DOKITOOL_SHANGHAI_MODE", "")
	t.Setenv("DOKITOOL_SHANGHAI_PULL_TOKEN", "")

	occupied, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	runErr := run([]string{"serve", "-listen", occupied.Addr().String(), "-client-identity", "direct"})
	occupied.Close()
	if runErr == nil || strings.Contains(runErr.Error(), "DOKITOOL_OWNER") {
		t.Fatalf("valid owner configuration failed before bind: %v", runErr)
	}
	if strings.Contains(logBuf.String(), canaryValid[:12]) || strings.Contains(runErr.Error(), canaryValid[:12]) {
		t.Fatalf("startup log or bind error leaked DOKITOOL_OWNER_TOKEN: log=%q err=%v", logBuf.String(), runErr)
	}
}

func TestPreparePublicMediaWeiboUnifiedDirectBlocked(t *testing.T) {
	const now int64 = 1730000000
	const srcURL = "https://weibo.com/1234567890/AbC"
	const cdnURL = "https://f.video.weibocdn.com/full.mp4?size=1080"
	const body = `{"idstr":"1234567890","text_raw":"t","page_info":{"media_info":{"mp4_hd_url":"https://f.video.weibocdn.com/full.mp4?size=1080","video_title":"v","duration":16}},"user":{"screen_name":"u","idstr":"1"}}`

	ownerToken := randomHexToken(t, 24)
	registry, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	wb := weiboplatform.New(fakeExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(body)}, nil
	}))
	h, err := api.New(registry, map[string]api.Adapter{"weibo": wb}, func() time.Time { return time.Unix(now, 0) }, preparePublicMedia())
	if err != nil {
		t.Fatal(err)
	}
	auth, err := api.NewOwnerAuth(ownerToken)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := api.WithAdmissionWithOwner(h, nil, "direct", "", api.DefaultAdmissionConfig(), auth)
	if err != nil {
		t.Fatal(err)
	}

	q := url.Values{"schema_version": {"1.0"}, "url": {srcURL}}
	for _, tc := range []struct {
		name  string
		token string
		addr  string
	}{
		{"owner", ownerToken, "127.0.0.1:40001"},
		{"anonymous", "", "127.0.0.1:40002"},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/parse?"+q.Encode(), nil)
		req.RemoteAddr = tc.addr
		if tc.token != "" {
			req.Header.Set("Authorization", "Bearer "+tc.token)
		}
		w := httptest.NewRecorder()
		entry.ServeHTTP(w, req)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), cdnURL) || strings.Contains(w.Body.String(), "/api/media/weibo") || strings.Contains(w.Body.String(), `"direct_url"`) {
			t.Fatalf("%s Weibo response did not return direct CDN URL without relay/direct_url: code=%d body=%s", tc.name, w.Code, w.Body.String())
		}
		payload, err := unified.Decode(w.Body.Bytes())
		if err != nil {
			t.Fatalf("%s Weibo invalid JSON: %v", tc.name, err)
		}
		item := unified.Map(unified.Slice(unified.Map(payload["data"])["items"])[0])
		def := unified.Map(item["default"])
		if def["access"] == "relay" || unified.Str(def["url"]) != cdnURL {
			t.Fatalf("%s Weibo default expected direct %q, got %#v", tc.name, cdnURL, def)
		}
		src := unified.Map(unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["sources"])[0])
		if src["browser_fetch"] != "blocked" || unified.Str(src["url"]) != cdnURL {
			t.Fatalf("%s Weibo source expected direct + browser_fetch=blocked, got %#v", tc.name, src)
		}
	}

	// Verify /api/media/weibo returns 404 (removed in Phase 3).
	wRelay := httptest.NewRecorder()
	relayReq := httptest.NewRequest(http.MethodGet, "/api/media/weibo?ticket=legacy", nil)
	relayReq.RemoteAddr = "127.0.0.1:40003"
	entry.ServeHTTP(wRelay, relayReq)
	if wRelay.Code != http.StatusNotFound {
		t.Fatalf("removed /api/media/weibo status=%d, want 404 (body=%s)", wRelay.Code, wRelay.Body.String())
	}

	// Verify newTikTokExecutor validates transport mode and DOKITOOL_TIKTOK_PROXY_URL.
	if _, configured, err := newTikTokExecutor("standard", ""); err != nil || configured {
		t.Fatalf("standard direct tiktok executor failed: configured=%v err=%v", configured, err)
	}
	if _, configured, err := newTikTokExecutor("chrome131", "http://user:pass@gw.proxy.example:8080"); err != nil || !configured {
		t.Fatalf("chrome131 proxy tiktok executor failed: configured=%v err=%v", configured, err)
	}
	if _, _, err := newTikTokExecutor("invalid", ""); err == nil {
		t.Fatal("invalid tiktok-page-transport should fail")
	}
	if _, _, err := newTikTokExecutor("standard", "ftp://bad-proxy.example:21"); err == nil {
		t.Fatal("invalid DOKITOOL_TIKTOK_PROXY_URL should fail")
	}
}

func TestServeStatsWiringYTDLPAndShanghai(t *testing.T) {
	if api.DefaultStatsLogInterval != 5*time.Minute {
		t.Fatalf("DefaultStatsLogInterval = %v, want 5m", api.DefaultStatsLogInterval)
	}
	dir := t.TempDir()
	fakeBin := filepath.Join(dir, "yt-dlp")
	payload := []byte("#!/bin/sh\necho '{}'\n")
	if err := os.WriteFile(fakeBin, payload, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	hexSum := hex.EncodeToString(sum[:])

	origAsset, hadOrig := ytengine.OfficialSHA256Sums[hexSum]
	ytengine.OfficialSHA256Sums[hexSum] = "yt-dlp-stats-wire-test"
	defer func() {
		if hadOrig {
			ytengine.OfficialSHA256Sums[hexSum] = origAsset
		} else {
			delete(ytengine.OfficialSHA256Sums, hexSum)
		}
	}()

	ownerToken := randomHexToken(t, 24)
	pullToken := randomHexToken(t, 24)
	env := map[string]string{
		"DOKITOOL_OWNER_TOKEN":         ownerToken,
		"DOKITOOL_SHANGHAI_MODE":       "pull",
		"DOKITOOL_SHANGHAI_PULL_TOKEN": pullToken,
		"DOKITOOL_YTDLP_X_ENABLED":     "true",
		"DOKITOOL_YTDLP_BINARY":        fakeBin,
	}
	getenv := func(k string) string { return env[k] }

	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	shanghai, control, err := configureShanghai(fetch.New(), getenv)
	if err != nil || shanghai == nil || control == nil {
		t.Fatalf("configureShanghai failed: resolver=%v control=%v err=%v", shanghai, control, err)
	}
	adapters := map[string]api.Adapter{}
	ytEng, err := configureYTDLPWithEngine(c, adapters, fetch.New(), x.TombstoneFallbackOff, getenv)
	if err != nil || ytEng == nil || !ytEng.Enabled() {
		t.Fatalf("configureYTDLPWithEngine failed: eng=%v err=%v", ytEng, err)
	}
	h, err := api.NewWithCacheConfig(c, adapters, time.Now, nil, api.DefaultCacheConfig())
	if err != nil {
		t.Fatal(err)
	}
	h.Stats().SetYTDLPEngine(ytEng)
	if sp, ok := shanghai.(shresolver.StatsProvider); ok {
		h.Stats().SetShanghaiSource(sp)
	}
	adm := api.DefaultAdmissionConfig()
	keyRegistry, err := api.LoadAPIKeyRegistry(getenv, adm)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := api.WithAdmissionWithRegistry(h, control, "direct", "", adm, keyRegistry)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	req.RemoteAddr = "127.0.0.1:40100"
	req.Header.Set("Authorization", "Bearer "+ownerToken)
	rec := httptest.NewRecorder()
	entry.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/stats status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"mode":"pull"`) || !strings.Contains(body, `"concurrency_limit":2`) || !strings.Contains(body, `"by_platform":{"douyin":`) || !strings.Contains(body, `"bilibili":`) {
		t.Fatalf("expected pull shanghai mode, by_platform.{douyin,bilibili}, and ytdlp concurrency_limit=2 in /api/stats, got %s", body)
	}
	if !strings.Contains(body, `"generic_slow":{`) || !strings.Contains(body, `"ytdlp_generic":{"enabled":false,`) {
		t.Fatalf("expected admission.generic_slow and disabled ytdlp_generic in /api/stats, got %s", body)
	}
}

func TestShanghaiBilibiliSwitchValidation(t *testing.T) {
	const (
		address = "https://shanghai.example.org/v1/douyin/original"
		key     = "development-test-only-32-byte-bearer"
	)

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
		got, err := parseShanghaiBilibili(func(k string) string {
			if k == "DOKITOOL_SHANGHAI_BILIBILI" {
				return tc.raw
			}
			return ""
		})
		if err != nil || got != tc.want {
			t.Fatalf("parseShanghaiBilibili(%q) = (%v, %v), want (%v, nil)", tc.raw, got, err, tc.want)
		}

		// Pull mode wiring check.
		pullRes, _, err := configureShanghai(fetch.New(), func(k string) string {
			switch k {
			case "DOKITOOL_SHANGHAI_MODE":
				return "pull"
			case "DOKITOOL_SHANGHAI_PULL_TOKEN":
				return key
			case "DOKITOOL_SHANGHAI_BILIBILI":
				return tc.raw
			default:
				return ""
			}
		})
		if err != nil {
			t.Fatalf("configureShanghai(pull, %q) failed: %v", tc.raw, err)
		}
		broker, ok := pullRes.(*shresolver.PullBroker)
		if !ok || broker == nil || broker.BilibiliEnabled() != tc.want {
			t.Fatalf("configureShanghai(pull, %q) broker.BilibiliEnabled() = %v, want %v", tc.raw, broker != nil && broker.BilibiliEnabled(), tc.want)
		}

		// Direct mode wiring check.
		directRes, _, err := configureShanghai(fetch.New(), func(k string) string {
			switch k {
			case "DOKITOOL_SHANGHAI_MODE":
				return "direct"
			case "DOKITOOL_SHANGHAI_ENDPOINT":
				return address
			case "DOKITOOL_SHANGHAI_TOKEN":
				return key
			case "DOKITOOL_SHANGHAI_BILIBILI":
				return tc.raw
			default:
				return ""
			}
		})
		if err != nil {
			t.Fatalf("configureShanghai(direct, %q) failed: %v", tc.raw, err)
		}
		client, ok := directRes.(*shresolver.Client)
		if !ok || client == nil || client.BilibiliEnabled() != tc.want {
			t.Fatalf("configureShanghai(direct, %q) client.BilibiliEnabled() = %v, want %v", tc.raw, client != nil && client.BilibiliEnabled(), tc.want)
		}
	}

	for _, invalid := range []string{"yes_please", "2", "on", "off", "auto", " true", "true "} {
		if _, _, err := configureShanghai(fetch.New(), func(k string) string {
			if k == "DOKITOOL_SHANGHAI_BILIBILI" {
				return invalid
			}
			return ""
		}); err == nil || !strings.Contains(err.Error(), "DOKITOOL_SHANGHAI_BILIBILI must be a boolean") {
			t.Fatalf("configureShanghai(%q) err = %v, want DOKITOOL_SHANGHAI_BILIBILI boolean error", invalid, err)
		}

		t.Setenv("DOKITOOL_SHANGHAI_BILIBILI", invalid)
		t.Setenv("DOKITOOL_SHANGHAI_MODE", "")
		occupied, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		runErr := run([]string{"serve", "-listen", occupied.Addr().String(), "-client-identity", "direct"})
		occupied.Close()
		if runErr == nil || !strings.Contains(runErr.Error(), "DOKITOOL_SHANGHAI_BILIBILI must be a boolean") {
			t.Fatalf("want DOKITOOL_SHANGHAI_BILIBILI startup error before listener bind for %q, got %v", invalid, runErr)
		}
		if strings.Contains(runErr.Error(), invalid) {
			t.Fatalf("startup error echoed raw invalid env value %q: %v", invalid, runErr)
		}
	}
}

func TestShanghaiBilibiliSwitchEndToEndPullAndDouyinIsolation(t *testing.T) {
	const (
		bvid    = "BV1234567890"
		cidP1   = int64(5001)
		cidP2   = int64(5002)
		awemeID = "7704056737233449610"
		videoID = "v0200fg10000dbl4sn7og65ijmfp8hm0"
		objKey  = "/video/tos/cn/tos-cn-v-0015c001-alinc2/oNormal1080"
		nowUnix = int64(1800000000)
		dlUnix  = int64(1800007200)
	)
	nowTime := time.Unix(nowUnix, 0).UTC()
	jpDouyinURL := "https://v3-dy-ov.zjcdn.com/" + strings.Repeat("2", 32) + "/6a000001" + objKey + "/?a=6383&mime_type=video_mp4"
	shDouyinRaw := "https://v26-web.douyinvod.com/" + strings.Repeat("a", 32) + "/6a000001" + objKey + "/?a=6383&mime_type=video_mp4"
	shDouyinLuna := "https://v26-luna.douyinvod.com/" + strings.Repeat("a", 32) + "/6a000001" + objKey + "/?a=6383&mime_type=video_mp4"

	douyinDetailBody := func(mediaURL string) []byte {
		doc := map[string]any{
			"status_code": 0,
			"aweme_detail": map[string]any{
				"aweme_id": awemeID,
				"desc":     "douyin isolation test",
				"author":   map[string]any{"uid": "u1", "nickname": "author"},
				"video": map[string]any{
					"duration":        15000,
					"cdn_url_expired": dlUnix,
					"play_addr":       map[string]any{"uri": videoID},
					"bit_rate": []map[string]any{{
						"gear_name": "normal_1080_0",
						"format":    "mp4",
						"bit_rate":  2107000,
						"is_h265":   0,
						"play_addr": map[string]any{
							"uri":       videoID,
							"file_hash": "hash1080",
							"width":     1920,
							"height":    1080,
							"data_size": 2135392,
							"url_list":  []string{mediaURL},
						},
					}},
				},
			},
		}
		b, _ := json.Marshal(doc)
		return b
	}

	biliViewBody, _ := json.Marshal(map[string]any{
		"code": 0,
		"data": map[string]any{
			"bvid":    bvid,
			"title":   "Switch Test",
			"pic":     "https://i0.hdslb.com/bfs/archive/cover.jpg",
			"desc":    "desc",
			"pubdate": 1700000000,
			"owner":   map[string]any{"name": "tester", "face": "https://i0.hdslb.com/bfs/face/avatar.jpg"},
			"pages": []map[string]any{
				{"cid": cidP1, "page": 1, "part": "P1", "duration": 30, "dimension": map[string]any{"width": 1920, "height": 1080, "rotate": 0}},
				{"cid": cidP2, "page": 2, "part": "P2", "duration": 30, "dimension": map[string]any{"width": 1920, "height": 1080, "rotate": 0}},
			},
		},
	})

	cases := []struct {
		name        string
		envVal      string
		wantEnabled bool
	}{
		{"default-unset", "", false},
		{"explicit-0", "0", false},
		{"explicit-false", "false", false},
		{"explicit-1", "1", true},
		{"explicit-true", "true", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ownerToken := randomHexToken(t, 24)
			pullToken := randomHexToken(t, 24)
			mediaKey := randomHexToken(t, 32)
			env := map[string]string{
				"DOKITOOL_OWNER_TOKEN":         ownerToken,
				"DOKITOOL_SHANGHAI_MODE":       "pull",
				"DOKITOOL_SHANGHAI_PULL_TOKEN": pullToken,
				"DOKITOOL_SHANGHAI_BILIBILI":   tc.envVal,
				"SNAP_MEDIA_SIGNING_KEY":       mediaKey,
			}
			getenv := func(k string) string { return env[k] }

			var shBiliCalls atomic.Int64
			var shDouyinCalls atomic.Int64

			jpExec := fakeExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				switch {
				case strings.Contains(req.URL, "api.bilibili.com/x/web-interface/view"):
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: biliViewBody}, nil
				case strings.Contains(req.URL, "api.bilibili.com/x/player/playurl"):
					u, _ := url.Parse(req.URL)
					cid := u.Query().Get("cid")
					jpURL := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/05/%s/%s-1-80.mp4?deadline=%d", cid, cid, dlUnix)
					b, _ := json.Marshal(map[string]any{
						"code": 0,
						"data": map[string]any{
							"quality": 80,
							"format":  "mp4720",
							"durl":    []map[string]any{{"url": jpURL, "size": 2097152, "length": 30000}},
						},
					})
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: b}, nil
				case strings.Contains(req.URL, "api.amemv.com/aweme/v1/aweme/detail/"):
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: douyinDetailBody(jpDouyinURL)}, nil
				case strings.Contains(req.URL, "aweme.snssdk.com/aweme/v1/play/"):
					return fetch.Response{StatusCode: 404, URL: req.URL}, nil
				default:
					return fetch.Response{}, fmt.Errorf("unexpected Japan outbound request: %s", req.URL)
				}
			})

			shanghai, control, err := configureShanghai(jpExec, getenv)
			if err != nil {
				t.Fatalf("configureShanghai failed: %v", err)
			}
			broker := shanghai.(*shresolver.PullBroker)
			broker.WithLookupNetIP(func(context.Context, string, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
			}).WithClock(func() time.Time { return nowTime })

			douyinParser, bilibiliParser := newShanghaiParsers(jpExec, probe.New(jpExec, douyin.AllowedMediaURL), shanghai, false)
			c, err := catalog.Load()
			if err != nil {
				t.Fatal(err)
			}
			h, err := api.NewWithCacheConfig(c, map[string]api.Adapter{
				"douyin":   douyinParser,
				"bilibili": bilibiliParser,
			}, func() time.Time { return nowTime }, preparePublicMedia(), api.DefaultCacheConfig())
			if err != nil {
				t.Fatal(err)
			}
			h.Stats().SetShanghaiSource(broker)
			adm := api.DefaultAdmissionConfig()
			adm.Parse.ClientBurst = 50
			adm.Parse.ClientRPS = 50
			keyRegistry, err := api.LoadAPIKeyRegistry(getenv, adm)
			if err != nil {
				t.Fatal(err)
			}
			entry, err := api.WithAdmissionWithRegistry(h, control, "direct", "", adm, keyRegistry)
			if err != nil {
				t.Fatal(err)
			}

			// Start an upgraded Shanghai PullWorker advertising X-DokiTool-Shanghai-Tasks: douyin,bilibili.
			controlExec := fakeExecutor(func(ctx context.Context, req fetch.Request) (fetch.Response, error) {
				if err := ctx.Err(); err != nil {
					return fetch.Response{}, err
				}
				var bodyReader io.Reader
				if len(req.Body) > 0 {
					bodyReader = bytes.NewReader(req.Body)
				}
				httpReq := httptest.NewRequestWithContext(ctx, req.Method, req.URL, bodyReader)
				httpReq.RemoteAddr = "127.0.0.1:47001"
				for k, vals := range req.Header {
					for _, v := range vals {
						httpReq.Header.Add(k, v)
					}
				}
				rec := httptest.NewRecorder()
				entry.ServeHTTP(rec, httpReq)
				return fetch.Response{StatusCode: rec.Code, Header: rec.Header().Clone(), Body: rec.Body.Bytes(), URL: req.URL}, nil
			})
			shUpExec := fakeExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				switch req.Policy.Purpose {
				case "bilibili-play":
					shBiliCalls.Add(1)
					u, _ := url.Parse(req.URL)
					cid := u.Query().Get("cid")
					shURL := fmt.Sprintf("https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/05/%s/%s-1-80.mp4?deadline=%d", cid, cid, dlUnix)
					b, _ := json.Marshal(map[string]any{
						"code": 0,
						"data": map[string]any{"quality": 80, "durl": []map[string]any{{"url": shURL}}},
					})
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: b}, nil
				case "douyin-detail":
					shDouyinCalls.Add(1)
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: douyinDetailBody(shDouyinRaw)}, nil
				default:
					if strings.Contains(req.URL, "aweme.snssdk.com/aweme/v1/play/") {
						return fetch.Response{StatusCode: 404, URL: req.URL}, nil
					}
					return fetch.Response{}, fmt.Errorf("unexpected Shanghai purpose %q (%s)", req.Policy.Purpose, req.URL)
				}
			})
			worker, err := shresolver.NewPullWorkerWithDetail("https://japan.example", pullToken, controlExec, shUpExec, probe.New(shUpExec, douyin.AllowedMediaURL))
			if err != nil {
				t.Fatal(err)
			}
			worker, err = worker.WithWorkers(1)
			if err != nil {
				t.Fatal(err)
			}
			wCtx, wCancel := context.WithCancel(context.Background())
			wDone := make(chan struct{})
			go func() {
				defer close(wDone)
				_ = worker.Run(wCtx)
			}()
			t.Cleanup(func() {
				wCancel()
				<-wDone
			})
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) && broker.ShanghaiStatsSnapshot().WaitingWorkers == 0 {
				time.Sleep(5 * time.Millisecond)
			}

			doGET := func(target, bearer string) (int, unified.Object) {
				req := httptest.NewRequest(http.MethodGet, target, nil)
				req.RemoteAddr = "127.0.0.1:47010"
				if bearer != "" {
					req.Header.Set("Authorization", "Bearer "+bearer)
				}
				rec := httptest.NewRecorder()
				entry.ServeHTTP(rec, req)
				out, decErr := unified.Decode(rec.Body.Bytes())
				if decErr != nil {
					t.Fatalf("decode %s failed: %v (body=%s)", target, decErr, rec.Body.String())
				}
				return rec.Code, out
			}

			// 1. Bilibili /api/parse (P1) + /api/resolve (P2)
			code, parseOut := doGET("/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.bilibili.com/video/"+bvid), "")
			if code != http.StatusOK {
				t.Fatalf("Bilibili /api/parse status=%d out=%v", code, parseOut)
			}
			p1 := unified.Map(unified.Slice(unified.Map(parseOut["data"])["items"])[0])
			p2 := unified.Map(unified.Slice(unified.Map(parseOut["data"])["items"])[1])
			p1Sources := unified.Slice(unified.Map(unified.Map(unified.Slice(p1["variants"])[0])["delivery"])["sources"])
			resolveURL := unified.Str(p2["resolve_url"])

			code, resOut := doGET(resolveURL, "")
			if code != http.StatusOK {
				t.Fatalf("Bilibili /api/resolve status=%d out=%v", code, resOut)
			}
			resP2 := unified.Map(unified.Slice(unified.Map(resOut["data"])["items"])[1])
			p2Sources := unified.Slice(unified.Map(unified.Map(unified.Slice(resP2["variants"])[0])["delivery"])["sources"])

			for _, group := range []unified.Array{p1Sources, p2Sources} {
				for _, rawSrc := range group {
					src := unified.Map(rawSrc)
					if unified.Str(src["browser_fetch"]) != "allowed" || unified.Str(src["expires_at"]) == "" {
						t.Fatalf("expected browser_fetch=allowed and expires_at on Bilibili source, got %v", src)
					}
				}
				if tc.wantEnabled {
					if len(group) != 2 || !strings.Contains(unified.Str(unified.Map(group[0])["url"]), "upos-sz-mirrorcos.bilivideo.com") ||
						!strings.Contains(unified.Str(unified.Map(group[1])["url"]), "upos-sz-mirrorcosov.bilivideo.com") {
						t.Fatalf("enabled mode expected [upos-dom, upos-ov], got %v", group)
					}
				} else {
					if len(group) != 1 || !strings.Contains(unified.Str(unified.Map(group[0])["url"]), "upos-sz-mirrorcosov.bilivideo.com") {
						t.Fatalf("disabled mode expected Japan-only [upos], got %v", group)
					}
				}
			}

			if tc.wantEnabled {
				if shBiliCalls.Load() != 2 {
					t.Fatalf("enabled mode shBiliCalls = %d, want 2", shBiliCalls.Load())
				}
			} else {
				if shBiliCalls.Load() != 0 {
					t.Fatalf("disabled mode shBiliCalls = %d, want 0", shBiliCalls.Load())
				}
			}

			// 2. Douyin /api/parse on the exact same running server & upgraded PullWorker
			code, dyOut := doGET("/api/parse?schema_version=1.0&url="+url.QueryEscape("https://www.douyin.com/video/"+awemeID), "")
			if code != http.StatusOK {
				t.Fatalf("Douyin /api/parse status=%d out=%v", code, dyOut)
			}
			dyItem := unified.Map(unified.Slice(unified.Map(dyOut["data"])["items"])[0])
			if gotDefault := unified.Str(unified.Map(dyItem["default"])["url"]); gotDefault != shDouyinLuna {
				t.Fatalf("Douyin default.url = %q, want Shanghai domestic %q", gotDefault, shDouyinLuna)
			}

			// 3. Verify /api/stats shanghai.by_platform.{bilibili,douyin}
			code, statsOut := doGET("/api/stats", ownerToken)
			if code != http.StatusOK {
				t.Fatalf("/api/stats status=%d out=%v", code, statsOut)
			}
			byPlat := unified.Map(unified.Map(unified.Map(statsOut["data"])["shanghai"])["by_platform"])
			biliStats := unified.Map(byPlat["bilibili"])
			dyStats := unified.Map(byPlat["douyin"])
			biliHits, _ := unified.PHPInt(biliStats["hits"])
			biliFallbacks, _ := unified.PHPInt(biliStats["fallbacks"])
			dyHits, _ := unified.PHPInt(dyStats["hits"])
			dyFallbacks, _ := unified.PHPInt(dyStats["fallbacks"])

			if dyHits != 1 || dyFallbacks != 0 {
				t.Fatalf("Douyin Shanghai stats = %+v, want hits=1 fallbacks=0", dyStats)
			}
			if tc.wantEnabled {
				if biliHits != 2 || biliFallbacks != 0 {
					t.Fatalf("enabled Bilibili Shanghai stats = %+v, want hits=2 fallbacks=0", biliStats)
				}
			} else {
				if biliHits != 0 || biliFallbacks != 0 {
					t.Fatalf("disabled Bilibili Shanghai stats = %+v, want hits=0 fallbacks=0", biliStats)
				}
			}
		})
	}
}

func TestDokitoolMainSubprocessHelper(t *testing.T) {
	raw := os.Getenv("DOKITOOL_TEST_MAIN_ARGS")
	if raw == "" {
		return
	}
	os.Args = append([]string{"dokitool"}, strings.Split(raw, "\n")...)
	main()
}

func TestHashTokenSubcommand(t *testing.T) {
	canaryArg := "cli-arg-secret-token-never-echo-9876543210"
	for _, badArgs := range [][]string{
		{canaryArg},
		{"--token=" + canaryArg},
		{"-h"},
	} {
		var out bytes.Buffer
		err := runHashToken(badArgs, strings.NewReader(""), &out)
		if err == nil || err.Error() != "hash-token reads from stdin; do not pass token in arguments" {
			t.Fatalf("runHashToken(%v) = %v, want exact argument rejection message", badArgs, err)
		}
		if strings.Contains(err.Error(), "cli-arg-secret") || out.Len() != 0 {
			t.Fatalf("runHashToken leaked CLI secret or wrote stdout: err=%v out=%q", err, out.String())
		}
	}

	minTok := strings.Repeat("A", bearer.MinTokenBytes)
	maxTok := strings.Repeat("~", bearer.MaxTokenBytes)
	sampleTok := randomHexToken(t, 24) // 48 hex chars

	for _, tc := range []struct {
		name  string
		stdin string
		want  string
	}{
		{"no-newline", sampleTok, fmt.Sprintf("%x\n", sha256.Sum256([]byte(sampleTok)))},
		{"lf-newline", sampleTok + "\n", fmt.Sprintf("%x\n", sha256.Sum256([]byte(sampleTok)))},
		{"crlf-newline", sampleTok + "\r\n", fmt.Sprintf("%x\n", sha256.Sum256([]byte(sampleTok)))},
		{"min-32-bytes", minTok + "\n", fmt.Sprintf("%x\n", sha256.Sum256([]byte(minTok)))},
		{"max-512-bytes-with-crlf", maxTok + "\r\n", fmt.Sprintf("%x\n", sha256.Sum256([]byte(maxTok)))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			if err := runHashToken(nil, strings.NewReader(tc.stdin), &out); err != nil {
				t.Fatalf("runHashToken(%s) failed: %v", tc.name, err)
			}
			if out.String() != tc.want || len(strings.TrimSuffix(out.String(), "\n")) != 64 {
				t.Fatalf("runHashToken(%s) = %q, want %q", tc.name, out.String(), tc.want)
			}
		})
	}

	canaryStdin := "stdin-secret-token-material-never-echo-1234"
	for _, bad := range []struct {
		name  string
		stdin string
	}{
		{"empty", ""},
		{"only-lf", "\n"},
		{"short-31", canaryStdin[:31] + "\n"},
		{"long-513", canaryStdin + strings.Repeat("x", 513-len(canaryStdin)) + "\n"},
		{"double-lf", sampleTok + "\n\n"},
		{"bare-cr", sampleTok + "\r"},
		{"inner-space", canaryStdin[:20] + " " + canaryStdin[20:] + "\n"},
		{"non-ascii", canaryStdin[:20] + "密" + canaryStdin[20:] + "\n"},
	} {
		t.Run("bad-"+bad.name, func(t *testing.T) {
			var out bytes.Buffer
			err := runHashToken(nil, strings.NewReader(bad.stdin), &out)
			if err == nil {
				t.Fatalf("expected invalid stdin %s to fail", bad.name)
			}
			if strings.Contains(err.Error(), "stdin-secret") || out.Len() != 0 {
				t.Fatalf("hash-token error leaked secret or wrote stdout: err=%v out=%q", err, out.String())
			}
		})
	}

	// End-to-end subprocess verification (`dokitool hash-token`).
	cmd := exec.Command(os.Args[0], "-test.run=^TestDokitoolMainSubprocessHelper$")
	cmd.Env = append(os.Environ(), "DOKITOOL_TEST_MAIN_ARGS=hash-token")
	cmd.Stdin = strings.NewReader(sampleTok + "\n")
	var subOut, subErr bytes.Buffer
	cmd.Stdout = &subOut
	cmd.Stderr = &subErr
	if err := cmd.Run(); err != nil {
		t.Fatalf("subprocess dokitool hash-token failed: err=%v stderr=%q", err, subErr.String())
	}
	wantPrefix := fmt.Sprintf("%x\n", sha256.Sum256([]byte(sampleTok)))
	if !strings.HasPrefix(subOut.String(), wantPrefix) {
		t.Fatalf("subprocess hash-token stdout = %q, want prefix %q", subOut.String(), wantPrefix)
	}
}

func TestServeAPIKeysFileStartupValidationAndSIGHUPHotReload(t *testing.T) {
	dir := t.TempDir()
	manifestFile := filepath.Join(dir, "api-keys.json")
	canaryShared := randomHexToken(t, 24)
	canaryPlain := randomHexToken(t, 24)
	sharedDigest := fmt.Sprintf("%x", sha256.Sum256([]byte(canaryShared)))

	// 1. Startup rejects invalid DOKITOOL_API_KEYS_FILE and system credential collisions before bind.
	startupRejects := []struct {
		name string
		file string
		env  map[string]string
	}{
		{
			name: "missing-manifest-file",
			env:  map[string]string{api.EnvAPIKeysFile: filepath.Join(dir, "does-not-exist.json")},
		},
		{
			name: "plaintext-token-field",
			file: fmt.Sprintf(`{"keys":[{"id":"bad","role":"agent","token":%q,"token_sha256":%q}]}`, canaryPlain, sharedDigest),
		},
		{
			name: "collides-with-ingress-key",
			file: fmt.Sprintf(`{"keys":[{"id":"agent-a","role":"agent","token_sha256":%q}]}`, sharedDigest),
			env:  map[string]string{"SNAP_INGRESS_KEY": canaryShared},
		},
		{
			name: "collides-with-shanghai-token",
			file: fmt.Sprintf(`{"keys":[{"id":"agent-a","role":"agent","token_sha256":%q}]}`, sharedDigest),
			env:  map[string]string{"DOKITOOL_SHANGHAI_TOKEN": canaryShared},
		},
		{
			name: "collides-with-shanghai-pull-token",
			file: fmt.Sprintf(`{"keys":[{"id":"agent-a","role":"agent","token_sha256":%q}]}`, sharedDigest),
			env: map[string]string{
				"DOKITOOL_SHANGHAI_MODE":       "pull",
				"DOKITOOL_SHANGHAI_PULL_TOKEN": canaryShared,
			},
		},
	}

	for _, tc := range startupRejects {
		t.Run(tc.name, func(t *testing.T) {
			if tc.file != "" {
				if err := os.WriteFile(manifestFile, []byte(tc.file), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			for _, k := range []string{
				"DOKITOOL_OWNER_TOKEN",
				api.EnvAPIKeysFile,
				"SNAP_INGRESS_KEY",
				"SNAP_MEDIA_SIGNING_KEY",
				"DOKITOOL_SHANGHAI_MODE",
				"DOKITOOL_SHANGHAI_TOKEN",
				"DOKITOOL_SHANGHAI_PULL_TOKEN",
			} {
				val := tc.env[k]
				if k == api.EnvAPIKeysFile && val == "" && tc.file != "" {
					val = manifestFile
				}
				t.Setenv(k, val)
			}
			occupied, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			runErr := run([]string{"serve", "-listen", occupied.Addr().String(), "-client-identity", "direct"})
			occupied.Close()
			if runErr == nil {
				t.Fatalf("expected %s to fail startup before bind", tc.name)
			}
			for _, secret := range []string{canaryShared[:12], canaryPlain[:12], sharedDigest[:12], dir} {
				if strings.Contains(runErr.Error(), secret) {
					t.Fatalf("%s startup error leaked %q: %v", tc.name, secret, runErr)
				}
			}
		})
	}

	// 2. End-to-end live subprocess SIGHUP hot-reload (valid reload preserving stats + invalid reload keeping old state).
	if runtime.GOOS == "windows" {
		return
	}
	ownerTok := randomHexToken(t, 24)
	agentV1 := randomHexToken(t, 24)
	agentV2 := randomHexToken(t, 24)
	friendNew := randomHexToken(t, 24)
	hexSum := func(s string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(s))) }

	v1JSON := fmt.Sprintf(`{
		"keys": [{
			"id": "agent-bot",
			"role": "agent",
			"token_sha256": %q,
			"concurrency": 4,
			"rps": 100,
			"burst": 100
		}]
	}`, hexSum(agentV1))
	if err := os.WriteFile(manifestFile, []byte(v1JSON), 0o600); err != nil {
		t.Fatal(err)
	}

	// Reserve an ephemeral loopback port >= 1024, release it, and launch dokitool serve.
	probeLn, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listenAddr := probeLn.Addr().String()
	_ = probeLn.Close()

	cmd := exec.Command(os.Args[0], "-test.run=^TestDokitoolMainSubprocessHelper$")
	cmd.Env = append(os.Environ(),
		"DOKITOOL_TEST_MAIN_ARGS="+strings.Join([]string{"serve", "-listen", listenAddr, "-client-identity", "direct"}, "\n"),
		"DOKITOOL_OWNER_TOKEN="+ownerTok,
		api.EnvAPIKeysFile+"="+manifestFile,
	)
	var logMu sync.Mutex
	var logBuf bytes.Buffer
	logWriter := writerFunc(func(p []byte) (int, error) {
		logMu.Lock()
		defer logMu.Unlock()
		return logBuf.Write(p)
	})
	cmd.Stdout = logWriter
	cmd.Stderr = logWriter
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start dokitool serve subprocess: %v", err)
	}
	var exited atomic.Bool
	waitDone := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		exited.Store(true)
		waitDone <- err
	}()
	t.Cleanup(func() {
		if !exited.Load() && cmd.Process != nil {
			_ = cmd.Process.Kill()
			<-waitDone
		}
	})

	client := &http.Client{Timeout: 2 * time.Second}
	doSubReq := func(path, tok string) (int, []byte, error) {
		req, err := http.NewRequest(http.MethodGet, "http://"+listenAddr+path, nil)
		if err != nil {
			return 0, nil, err
		}
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		resp, err := client.Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		return resp.StatusCode, b, err
	}

	// Wait for server readiness via /api/platforms?schema_version=1.0.
	readyDeadline := time.Now().Add(5 * time.Second)
	for {
		if code, _, reqErr := doSubReq("/api/platforms?schema_version=1.0", ""); reqErr == nil && code == http.StatusOK {
			break
		}
		if time.Now().After(readyDeadline) {
			logMu.Lock()
			logs := logBuf.String()
			logMu.Unlock()
			t.Fatalf("dokitool serve subprocess did not become ready on %s; logs=%s", listenAddr, logs)
		}
		time.Sleep(15 * time.Millisecond)
	}

	// Send 2 invalid-input /api/parse requests with agentV1 so agent-bot records requests_total=2, errors=2 without any network call!
	for i := 0; i < 2; i++ {
		code, _, reqErr := doSubReq("/api/parse?schema_version=1.0&url=not-a-valid-url", agentV1)
		if reqErr != nil || code != http.StatusBadRequest {
			t.Fatalf("pre-reload agentV1 /api/parse got code=%d err=%v, want 400", code, reqErr)
		}
	}
	// Agent role cannot read /api/stats (401 -> unauthorized=1, requests_total=3).
	if code, _, reqErr := doSubReq("/api/stats", agentV1); reqErr != nil || code != http.StatusUnauthorized {
		t.Fatalf("agentV1 /api/stats got code=%d err=%v, want 401", code, reqErr)
	}

	// Write V2 manifest (rotate agent-bot to agentV2 with concurrency=6, add friend-new) and send SIGHUP!
	v2JSON := fmt.Sprintf(`{
		"keys": [
			{
				"id": "agent-bot",
				"role": "agent",
				"token_sha256": %q,
				"concurrency": 6,
				"rps": 100,
				"burst": 100
			},
			{
				"id": "friend-new",
				"role": "friend",
				"token_sha256": %q,
				"rps": 50,
				"burst": 50
			}
		]
	}`, hexSum(agentV2), hexSum(friendNew))
	if err := os.WriteFile(manifestFile, []byte(v2JSON), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Process.Signal(syscall.SIGHUP); err != nil {
		t.Fatalf("SIGHUP #1 failed: %v", err)
	}

	// Poll until reloaded (keys=3: implicit owner + agent-bot + friend-new).
	reloadDeadline := time.Now().Add(3 * time.Second)
	for {
		logMu.Lock()
		okReload := strings.Contains(logBuf.String(), "api keys reloaded (keys=3)")
		logMu.Unlock()
		if okReload {
			break
		}
		if time.Now().After(reloadDeadline) {
			logMu.Lock()
			logs := logBuf.String()
			logMu.Unlock()
			t.Fatalf("timed out waiting for SIGHUP #1 reload log; logs=%s", logs)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Verify agentV1 is now rejected (401), agentV2 and friendNew work, and agent-bot preserved its cumulative counters!
	if code, _, _ := doSubReq("/api/parse?schema_version=1.0&url=not-a-valid-url", agentV1); code != http.StatusUnauthorized {
		t.Fatalf("expected rotated-out agentV1 to get 401, got %d", code)
	}
	if code, _, _ := doSubReq("/api/parse?schema_version=1.0&url=not-a-valid-url", agentV2); code != http.StatusBadRequest {
		t.Fatalf("expected rotated-in agentV2 to authenticate and reach handler (400), got %d", code)
	}
	if code, _, _ := doSubReq("/api/parse?schema_version=1.0&url=not-a-valid-url", friendNew); code != http.StatusBadRequest {
		t.Fatalf("expected friend-new to authenticate and reach handler (400), got %d", code)
	}

	// Write an INVALID manifest containing a canary secret + digest and send SIGHUP #2 -> must keep V2 active!
	badCanary := "reload-canary-secret-never-log-55555555"
	badDigest := hexSum(badCanary)
	badReloadJSON := fmt.Sprintf(`{"keys":[{"id":"agent-bot","role":"agent","token":%q,"token_sha256":%q}]}`, badCanary, badDigest)
	if err := os.WriteFile(manifestFile, []byte(badReloadJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Process.Signal(syscall.SIGHUP); err != nil {
		t.Fatalf("SIGHUP #2 failed: %v", err)
	}
	rejectDeadline := time.Now().Add(3 * time.Second)
	for {
		logMu.Lock()
		sawReject := strings.Contains(logBuf.String(), "api keys reload rejected")
		logMu.Unlock()
		if sawReject {
			break
		}
		if time.Now().After(rejectDeadline) {
			logMu.Lock()
			logs := logBuf.String()
			logMu.Unlock()
			t.Fatalf("timed out waiting for SIGHUP #2 rejection log; logs=%s", logs)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// V2 keys remain active and cumulative stats are intact!
	if code, _, _ := doSubReq("/api/parse?schema_version=1.0&url=not-a-valid-url", agentV2); code != http.StatusBadRequest {
		t.Fatalf("agentV2 stopped working after rejected SIGHUP reload: %d", code)
	}
	stCode, stBody, stErr := doSubReq("/api/stats", ownerTok)
	if stErr != nil || stCode != http.StatusOK {
		t.Fatalf("owner /api/stats after SIGHUP #2 failed: code=%d err=%v", stCode, stErr)
	}
	var env struct {
		Data api.StatsSnapshot `json:"data"`
	}
	if err := json.Unmarshal(stBody, &env); err != nil {
		t.Fatal(err)
	}
	var gotAgent *api.APIKeyStatsSnapshot
	for i := range env.Data.APIKeys {
		if env.Data.APIKeys[i].ID == "agent-bot" {
			gotAgent = &env.Data.APIKeys[i]
		}
	}
	// Pre-reload: 2 errors + 1 unauthorized = 3; Post-reload #1: 1 error; Post-reload #2: 1 error => total=5, errors=4, unauthorized=1, concurrency_limit=6!
	if gotAgent == nil || gotAgent.ConcurrencyLimit != 6 || gotAgent.RequestsTotal != 5 || gotAgent.Errors != 4 || gotAgent.Unauthorized != 1 {
		t.Fatalf("unexpected agent-bot cumulative stats after SIGHUPs: %+v", gotAgent)
	}

	// Verify logs contain zero secrets, digests, or local paths, then gracefully shut down subprocess via SIGTERM.
	logMu.Lock()
	allLogs := logBuf.String()
	logMu.Unlock()
	for _, secret := range []string{ownerTok[:12], agentV1[:12], agentV2[:12], badCanary[:12], badDigest[:12], hexSum(agentV2)[:12], dir} {
		if strings.Contains(allLogs, secret) {
			t.Fatalf("server logs leaked secret/digest/path %q: %s", secret, allLogs)
		}
	}

	_ = cmd.Process.Signal(syscall.SIGTERM)
	select {
	case waitErr := <-waitDone:
		if waitErr != nil {
			// go test exits 0 when main() returns cleanly on SIGTERM!
			t.Fatalf("dokitool serve subprocess exited with error on SIGTERM: %v", waitErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dokitool serve subprocess did not shut down within 5s after SIGTERM")
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

func TestBilibiliDASHSwitchValidationAndWiring(t *testing.T) {
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
		if _, err := parseBilibiliDASH(func(k string) string {
			if k == "DOKITOOL_BILIBILI_DASH" {
				return invalid
			}
			return ""
		}); err == nil || !strings.Contains(err.Error(), "DOKITOOL_BILIBILI_DASH must be a boolean") {
			t.Fatalf("parseBilibiliDASH(%q) err = %v, want DOKITOOL_BILIBILI_DASH boolean error", invalid, err)
		}

		t.Setenv("DOKITOOL_BILIBILI_DASH", invalid)
		t.Setenv("DOKITOOL_SHANGHAI_MODE", "")
		occupied, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		runErr := run([]string{"serve", "-listen", occupied.Addr().String(), "-client-identity", "direct"})
		occupied.Close()
		if runErr == nil || !strings.Contains(runErr.Error(), "DOKITOOL_BILIBILI_DASH must be a boolean") {
			t.Fatalf("want DOKITOOL_BILIBILI_DASH startup error before listener bind for %q, got %v", invalid, runErr)
		}
		if strings.Contains(runErr.Error(), invalid) {
			t.Fatalf("startup error echoed raw invalid env value %q: %v", invalid, runErr)
		}
	}

	const (
		bvid    = "BV1234567890"
		nowUnix = int64(1800000000)
		dlUnix  = int64(1800007200)
	)
	viewBody := `{"code":0,"data":{"title":"DASH Wiring","pages":[{"page":1,"cid":101,"part":"P1","duration":60}]}}`
	durlBody := fmt.Sprintf(`{"code":0,"data":{"quality":64,"durl":[{"url":"https://upos-sz-mirrorcosov.bilivideo.com/101-64.mp4?deadline=%d","width":1280,"height":720}]}}`, dlUnix)
	dashBody := fmt.Sprintf(`{"code":0,"data":{"quality":80,"dash":{"video":[{"id":80,"codecid":7,"codecs":"avc1.640028","width":1920,"height":1080,"bandwidth":2200000,"baseUrl":"https://upos-sz-mirrorcosov.bilivideo.com/101-80.m4s?deadline=%d"}],"audio":[{"id":30280,"codecid":0,"codecs":"mp4a.40.2","bandwidth":192000,"baseUrl":"https://upos-sz-mirrorcosov.bilivideo.com/101-30280.m4s?deadline=%d"}]}}}`, dlUnix, dlUnix)

	for _, withShanghai := range []bool{false, true} {
		for _, dashEnabled := range []bool{false, true} {
			name := fmt.Sprintf("shanghai=%t/dash=%t", withShanghai, dashEnabled)
			t.Run(name, func(t *testing.T) {
				var dashCalls atomic.Int32
				exec := fakeExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					switch req.Policy.Purpose {
					case "bilibili-view":
						return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(viewBody)}, nil
					case "bilibili-play":
						return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(durlBody)}, nil
					case "bilibili-play-dash":
						dashCalls.Add(1)
						return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(dashBody)}, nil
					default:
						return fetch.Response{}, fmt.Errorf("unexpected purpose %q", req.Policy.Purpose)
					}
				})
				var sh douyin.OriginalResolver
				if withShanghai {
					broker, err := shresolver.NewPullBroker(randomHexToken(t, 24))
					if err != nil {
						t.Fatal(err)
					}
					broker.WithBilibili(true)
					sh = broker
				}
				_, biliParser := newShanghaiParsers(exec, probe.New(exec, douyin.AllowedMediaURL), sh, dashEnabled)
				env, err := biliParser.Parse(context.Background(), "https://www.bilibili.com/video/"+bvid+"/", nowUnix)
				if err != nil {
					t.Fatalf("Parse failed: %v", err)
				}
				if err := unified.ValidateEnvelopeAt(env, nowUnix); err != nil {
					t.Fatalf("ValidateEnvelopeAt failed: %v", err)
				}
				data := unified.Map(env["data"])
				variants := unified.Slice(unified.Map(unified.Slice(data["items"])[0])["variants"])
				if dashEnabled {
					if dashCalls.Load() != 1 {
						t.Fatalf("dashCalls = %d, want 1", dashCalls.Load())
					}
					if len(unified.Slice(data["attachments"])) != 1 {
						t.Fatalf("expected 1 audio attachment, got %v", data["attachments"])
					}
					if len(variants) != 2 || unified.Str(unified.Map(variants[1])["id"]) != "dash-80-avc" {
						t.Fatalf("expected [durl, dash-80-avc], got %v", variants)
					}
				} else {
					if dashCalls.Load() != 0 {
						t.Fatalf("dashCalls = %d, want 0 when DOKITOOL_BILIBILI_DASH=false", dashCalls.Load())
					}
					if data["attachments"] != nil {
						t.Fatalf("expected 0 attachments when disabled, got %v", data["attachments"])
					}
					if len(variants) != 1 {
						t.Fatalf("expected single durl variant when disabled, got %v", variants)
					}
				}
			})
		}
	}
}

func TestServeStatsRuntimeConfigAndPersistenceAcrossRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("SIGTERM subprocess persistence test requires unix signals")
	}

	dir := t.TempDir()
	snapPath := filepath.Join(dir, "stats-snapshot.json")
	ownerTok := randomHexToken(t, 24)
	client := &http.Client{Timeout: 2 * time.Second}

	startServe := func(extraEnv ...string) (string, *exec.Cmd, chan error, func() string) {
		t.Helper()
		probeLn, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		listenAddr := probeLn.Addr().String()
		_ = probeLn.Close()

		cmd := exec.Command(os.Args[0], "-test.run=^TestDokitoolMainSubprocessHelper$")
		args := []string{"serve", "-listen", listenAddr, "-client-identity", "direct", "-xhs-page-transport", "chrome131"}
		env := append(os.Environ(),
			"DOKITOOL_TEST_MAIN_ARGS="+strings.Join(args, "\n"),
			"DOKITOOL_OWNER_TOKEN="+ownerTok,
			"DOKITOOL_BILIBILI_DASH=true",
			"DOKITOOL_TBVIDEO_REWRITE_PIPIGX=false",
			"DOKITOOL_TBVIDEO_REWRITE_ZUIYOU=true",
			api.EnvStatsSnapshotPath+"="+snapPath,
		)
		env = append(env, extraEnv...)
		cmd.Env = env

		var logMu sync.Mutex
		var logBuf bytes.Buffer
		logWriter := writerFunc(func(p []byte) (int, error) {
			logMu.Lock()
			defer logMu.Unlock()
			return logBuf.Write(p)
		})
		cmd.Stdout = logWriter
		cmd.Stderr = logWriter

		if err := cmd.Start(); err != nil {
			t.Fatalf("failed to start dokitool serve subprocess: %v", err)
		}
		var exited atomic.Bool
		waitDone := make(chan error, 1)
		go func() {
			err := cmd.Wait()
			exited.Store(true)
			waitDone <- err
		}()
		t.Cleanup(func() {
			if !exited.Load() && cmd.Process != nil {
				_ = cmd.Process.Kill()
				<-waitDone
			}
		})

		getLogs := func() string {
			logMu.Lock()
			defer logMu.Unlock()
			return logBuf.String()
		}

		readyDeadline := time.Now().Add(5 * time.Second)
		for {
			resp, reqErr := client.Get("http://" + listenAddr + "/api/platforms?schema_version=1.0")
			if reqErr == nil {
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					break
				}
			}
			if time.Now().After(readyDeadline) {
				t.Fatalf("dokitool serve subprocess did not become ready on %s; logs=%s", listenAddr, getLogs())
			}
			time.Sleep(15 * time.Millisecond)
		}
		return listenAddr, cmd, waitDone, getLogs
	}

	doReq := func(listenAddr, path, tok string) (int, []byte) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, "http://"+listenAddr+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("request %s failed: %v", path, err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, body
	}

	fetchStats := func(listenAddr string) (api.StatsSnapshot, []byte) {
		t.Helper()
		code, body := doReq(listenAddr, "/api/stats?schema_version=1.0", ownerTok)
		if code != http.StatusOK {
			t.Fatalf("GET /api/stats status=%d body=%s", code, string(body))
		}
		var env struct {
			Data api.StatsSnapshot `json:"data"`
		}
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatalf("unmarshal /api/stats failed: %v\nbody=%s", err, string(body))
		}
		return env.Data, body
	}

	stopServe := func(cmd *exec.Cmd, waitDone chan error) {
		t.Helper()
		if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
			t.Fatalf("SIGTERM failed: %v", err)
		}
		select {
		case waitErr := <-waitDone:
			if waitErr != nil {
				t.Fatalf("dokitool serve subprocess exited with error on SIGTERM: %v", waitErr)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("dokitool serve subprocess did not exit within 5s after SIGTERM")
		}
	}

	// Run 1: cold start, record 3 parse outcomes, verify runtime switches & zero secret/path leakage, then SIGTERM flush!
	addr1, cmd1, wait1, logs1 := startServe()
	for i := 0; i < 2; i++ {
		if code, _ := doReq(addr1, "/api/parse?schema_version=1.0&url=not-a-valid-url", ""); code != http.StatusBadRequest {
			t.Fatalf("anon invalid parse #%d got %d, want 400", i+1, code)
		}
	}
	if code, _ := doReq(addr1, "/api/parse?schema_version=1.0&url=not-a-valid-url", ownerTok); code != http.StatusBadRequest {
		t.Fatalf("owner invalid parse got %d, want 400", code)
	}

	snap1, raw1 := fetchStats(addr1)
	if snap1.Runtime.Version != version ||
		snap1.Runtime.ShanghaiMode != "off" ||
		snap1.Runtime.ShanghaiBilibili ||
		!snap1.Runtime.BilibiliDASH ||
		snap1.Runtime.YouTubeHelper ||
		snap1.Runtime.XHSTransport != "chrome131" ||
		snap1.Runtime.YTDLPEnabled ||
		snap1.Runtime.YTDLPGenericEnabled ||
		snap1.Runtime.TBVideoPipigx ||
		!snap1.Runtime.TBVideoZuiyou ||
		!snap1.Runtime.StatsPersistenceEnabled {
		t.Fatalf("unexpected runtime config snapshot: %+v", snap1.Runtime)
	}
	if len(snap1.Daily) != api.DailyStatsWindowDays || len(snap1.Hourly) != api.HourlyStatsWindowHours {
		t.Fatalf("unexpected daily/hourly lengths: %d/%d", len(snap1.Daily), len(snap1.Hourly))
	}
	wantDate := snap1.Daily[len(snap1.Daily)-1].Date
	wantHour := snap1.Hourly[len(snap1.Hourly)-1].HourStart
	if snap1.Daily[len(snap1.Daily)-1].Total != 3 || snap1.Hourly[len(snap1.Hourly)-1].Total != 3 {
		t.Fatalf("expected 3 recorded parses in today/current-hour, got daily=%+v hourly=%+v", snap1.Daily[len(snap1.Daily)-1], snap1.Hourly[len(snap1.Hourly)-1])
	}
	for _, secret := range []string{dir, snapPath, ownerTok[:12]} {
		if strings.Contains(string(raw1), secret) {
			t.Fatalf("/api/stats leaked sensitive value %q", secret)
		}
	}

	stopServe(cmd1, wait1)
	for _, secret := range []string{dir, ownerTok[:12]} {
		if strings.Contains(logs1(), secret) {
			t.Fatalf("run 1 logs leaked sensitive value %q: %s", secret, logs1())
		}
	}

	// Verify snapshot file permissions (0600) and zero leftover .tmp files.
	info, err := os.Stat(snapPath)
	if err != nil {
		t.Fatalf("expected stats snapshot file after SIGTERM: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("snapshot file mode = %o, want 0600", info.Mode().Perm())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "stats-snapshot.json" {
		t.Fatalf("unexpected directory contents after SIGTERM flush: %v", entries)
	}

	// Run 2: restart against the same snapshot path -> daily & hourly totals survive restart identically!
	addr2, cmd2, wait2, logs2 := startServe()
	snap2, _ := fetchStats(addr2)
	if snap2.Requests.Total != 0 {
		t.Fatalf("expected process-lifetime requests.total=0 immediately after restart, got %d", snap2.Requests.Total)
	}
	var survivedDaily, survivedHourly uint64
	for _, d := range snap2.Daily {
		if d.Date == wantDate {
			survivedDaily = d.Total
		}
	}
	for _, h := range snap2.Hourly {
		if h.HourStart == wantHour {
			survivedHourly = h.Total
		}
	}
	if survivedDaily != 3 || survivedHourly != 3 {
		t.Fatalf("persisted stats did not survive restart: wantDate=%s daily=%d wantHour=%s hourly=%d", wantDate, survivedDaily, wantHour, survivedHourly)
	}
	stopServe(cmd2, wait2)
	for _, secret := range []string{dir, ownerTok[:12]} {
		if strings.Contains(logs2(), secret) {
			t.Fatalf("run 2 logs leaked sensitive value %q: %s", secret, logs2())
		}
	}

	// Run 3: corrupt snapshot file -> fail-soft startup (must NOT block!), safe warning with zero path leak, empty history!
	if err := os.WriteFile(snapPath, []byte("{corrupt-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	addr3, cmd3, wait3, logs3 := startServe()
	snap3, _ := fetchStats(addr3)
	if !snap3.Runtime.StatsPersistenceEnabled {
		t.Fatal("expected stats_persistence_enabled=true even after fail-soft corrupt load")
	}
	if snap3.Daily[len(snap3.Daily)-1].Total != 0 || snap3.Hourly[len(snap3.Hourly)-1].Total != 0 {
		t.Fatalf("expected empty history after corrupt snapshot load, got daily=%+v hourly=%+v", snap3.Daily[len(snap3.Daily)-1], snap3.Hourly[len(snap3.Hourly)-1])
	}
	stopServe(cmd3, wait3)

	allLogs3 := logs3()
	if !strings.Contains(allLogs3, "stats snapshot load skipped") {
		t.Fatalf("expected fail-soft warning in run 3 logs, got: %s", allLogs3)
	}
	for _, secret := range []string{dir, ownerTok[:12]} {
		if strings.Contains(allLogs3, secret) {
			t.Fatalf("run 3 logs leaked sensitive value %q: %s", secret, allLogs3)
		}
	}
	// Graceful shutdown should have replaced the corrupt file with a valid schema_version=1 snapshot!
	healedRaw, err := os.ReadFile(snapPath)
	if err != nil {
		t.Fatalf("read healed snapshot failed: %v", err)
	}
	var healedMeta struct {
		SchemaVersion int    `json:"schema_version"`
		Timezone      string `json:"timezone"`
	}
	if err := json.Unmarshal(healedRaw, &healedMeta); err != nil || healedMeta.SchemaVersion != 1 || healedMeta.Timezone != "Asia/Shanghai" {
		t.Fatalf("expected healed schema_version=1 Asia/Shanghai snapshot after SIGTERM, got %s (err=%v)", string(healedRaw), err)
	}
}

func TestYTDLPGenericConfigurationAndStartupValidation(t *testing.T) {
	// 1. Invalid DOKITOOL_YTDLP_GENERIC_ENABLED fails startup before listener bind without echoing raw value.
	for _, invalid := range []string{"auto", "yes_please", " true", "2"} {
		t.Setenv("DOKITOOL_YTDLP_GENERIC_ENABLED", invalid)
		t.Setenv("DOKITOOL_YTDLP_GENERIC_CONCURRENCY", "")
		occupied, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		runErr := run([]string{"serve", "-listen", occupied.Addr().String(), "-client-identity", "direct"})
		occupied.Close()
		if runErr == nil || !strings.Contains(runErr.Error(), "DOKITOOL_YTDLP_GENERIC_ENABLED must be a boolean") {
			t.Fatalf("want DOKITOOL_YTDLP_GENERIC_ENABLED startup error for %q, got %v", invalid, runErr)
		}
		if strings.Contains(runErr.Error(), invalid) {
			t.Fatalf("startup error echoed raw invalid value %q: %v", invalid, runErr)
		}
	}

	// 2. Invalid DOKITOOL_YTDLP_GENERIC_CONCURRENCY fails startup before listener bind without echoing raw value.
	for _, invalid := range []string{"0", "-2", "25", "badconcurrency"} {
		t.Setenv("DOKITOOL_YTDLP_GENERIC_ENABLED", "")
		t.Setenv("DOKITOOL_YTDLP_GENERIC_CONCURRENCY", invalid)
		occupied, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		runErr := run([]string{"serve", "-listen", occupied.Addr().String(), "-client-identity", "direct"})
		occupied.Close()
		if runErr == nil || !strings.Contains(runErr.Error(), "DOKITOOL_YTDLP_GENERIC_CONCURRENCY must be an integer between 1 and 24") {
			t.Fatalf("want DOKITOOL_YTDLP_GENERIC_CONCURRENCY startup error for %q, got %v", invalid, runErr)
		}
		if strings.Contains(runErr.Error(), "badconcurrency") {
			t.Fatalf("startup error echoed raw invalid value %q: %v", invalid, runErr)
		}
	}

	// 3. Unit tests for configureYTDLPFull + runtime.ytdlp_generic_enabled wiring.
	dir := t.TempDir()
	fakeBin := filepath.Join(dir, "yt-dlp")
	payload := []byte("#!/bin/sh\necho '{}' \n")
	if err := os.WriteFile(fakeBin, payload, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	hexSum := hex.EncodeToString(sum[:])

	origAsset, hadOrig := ytengine.OfficialSHA256Sums[hexSum]
	ytengine.OfficialSHA256Sums[hexSum] = "yt-dlp-generic-cmd-test"
	defer func() {
		if hadOrig {
			ytengine.OfficialSHA256Sums[hexSum] = origAsset
		} else {
			delete(ytengine.OfficialSHA256Sums, hexSum)
		}
	}()

	cases := []struct {
		name               string
		env                map[string]string
		wantEngine         bool
		wantGenericEnabled bool
		wantErr            bool
	}{
		{
			name:               "default-off",
			env:                nil,
			wantEngine:         false,
			wantGenericEnabled: false,
		},
		{
			name: "generic-only-missing-binary-fails-soft",
			env: map[string]string{
				"DOKITOOL_YTDLP_GENERIC_ENABLED": "true",
				"DOKITOOL_YTDLP_BINARY":          filepath.Join(dir, "missing-yt-dlp"),
			},
			wantEngine:         false,
			wantGenericEnabled: false,
		},
		{
			name: "generic-only-verified-binary-enables-without-core-ytdlp-switches",
			env: map[string]string{
				"DOKITOOL_YTDLP_GENERIC_ENABLED":     "true",
				"DOKITOOL_YTDLP_GENERIC_CONCURRENCY": "3",
				"DOKITOOL_YTDLP_BINARY":              fakeBin,
			},
			wantEngine:         true,
			wantGenericEnabled: true,
		},
		{
			name: "x-only-keeps-generic-disabled",
			env: map[string]string{
				"DOKITOOL_YTDLP_X_ENABLED": "true",
				"DOKITOOL_YTDLP_BINARY":    fakeBin,
			},
			wantEngine:         true,
			wantGenericEnabled: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, err := catalog.Load()
			if err != nil {
				t.Fatal(err)
			}
			adapters := map[string]api.Adapter{}
			res, err := configureYTDLPFull(c, adapters, fetch.New(), x.TombstoneFallbackOff, func(k string) string { return tc.env[k] })
			if (err != nil) != tc.wantErr {
				t.Fatalf("configureYTDLPFull err=%v, wantErr=%v", err, tc.wantErr)
			}
			if (res.engine != nil) != tc.wantEngine || (res.genericAdapter != nil) != tc.wantGenericEnabled || (res.genericEngine != nil) != tc.wantGenericEnabled {
				t.Fatalf("engine=%v genericEngine=%v genericAdapter=%v, want engine=%v generic=%v",
					res.engine != nil, res.genericEngine != nil, res.genericAdapter != nil, tc.wantEngine, tc.wantGenericEnabled)
			}
			if c.Has(api.PlatformGeneric) {
				t.Fatal("catalog must never register internal sentinel PlatformGeneric")
			}

			h, err := api.New(c, adapters, time.Now, nil)
			if err != nil {
				t.Fatal(err)
			}
			if res.genericAdapter != nil {
				h.SetGenericAdapter(res.genericAdapter)
			}
			if res.engine != nil {
				h.Stats().SetYTDLPEngine(res.engine)
			}
			if res.genericEngine != nil {
				h.Stats().SetGenericYTDLPEngine(res.genericEngine)
			}
			h.Stats().SetRuntimeConfig(api.RuntimeConfigSnapshot{
				Version:             version,
				YTDLPEnabled:        res.engine != nil,
				YTDLPGenericEnabled: h.GenericEnabled(),
			})
			snap := h.Stats().Snapshot()
			if snap.Runtime.YTDLPEnabled != tc.wantEngine || snap.Runtime.YTDLPGenericEnabled != tc.wantGenericEnabled {
				t.Fatalf("runtime snapshot=%+v, want ytdlp=%v generic=%v", snap.Runtime, tc.wantEngine, tc.wantGenericEnabled)
			}
			if snap.YTDLPGeneric.Enabled != tc.wantGenericEnabled {
				t.Fatalf("ytdlp_generic.enabled=%v, want %v (snap=%+v)", snap.YTDLPGeneric.Enabled, tc.wantGenericEnabled, snap.YTDLPGeneric)
			}
			if tc.wantGenericEnabled {
				if snap.YTDLPGeneric.ConcurrencyLimit != 3 || snap.YTDLP.ConcurrencyLimit != 2 {
					t.Fatalf("unexpected concurrency limits: ytdlp_generic=%d ytdlp=%d, want 3/2", snap.YTDLPGeneric.ConcurrencyLimit, snap.YTDLP.ConcurrencyLimit)
				}
			} else if snap.YTDLPGeneric.ConcurrencyLimit != 0 {
				t.Fatalf("expected zero ytdlp_generic.concurrency_limit when disabled, got %d", snap.YTDLPGeneric.ConcurrencyLimit)
			}

			admCfg, err := api.LoadAdmissionConfig(func(k string) string { return tc.env[k] })
			if err != nil {
				t.Fatalf("LoadAdmissionConfig failed: %v", err)
			}
			ownerTok := randomHexToken(t, 24)
			auth, err := api.NewOwnerAuth(ownerTok)
			if err != nil {
				t.Fatal(err)
			}
			entry, err := api.WithAdmissionWithOwner(h, nil, "direct", "", admCfg, auth)
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodGet, "/api/stats?schema_version=1.0", nil)
			req.RemoteAddr = "127.0.0.1:40200"
			req.Header.Set("Authorization", "Bearer "+ownerTok)
			rec := httptest.NewRecorder()
			entry.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("GET /api/stats status=%d body=%s", rec.Code, rec.Body.String())
			}
			var statsEnv struct {
				Data api.StatsSnapshot `json:"data"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &statsEnv); err != nil {
				t.Fatalf("unmarshal /api/stats: %v", err)
			}
			wantGenAdmLimit := ytgeneric.DefaultGenericConcurrency
			if tc.wantGenericEnabled {
				wantGenAdmLimit = 3
			}
			if statsEnv.Data.Admission.GenericSlow.ConcurrencyLimit != wantGenAdmLimit {
				t.Fatalf("admission.generic_slow.concurrency_limit=%d, want %d", statsEnv.Data.Admission.GenericSlow.ConcurrencyLimit, wantGenAdmLimit)
			}
			if statsEnv.Data.YTDLPGeneric.Enabled != tc.wantGenericEnabled {
				t.Fatalf("HTTP ytdlp_generic.enabled=%v, want %v", statsEnv.Data.YTDLPGeneric.Enabled, tc.wantGenericEnabled)
			}
		})
	}
}

func TestYTDLPThreeCompartmentsAndRuntimeHotReloadSIGHUP(t *testing.T) {
	dir := t.TempDir()
	fakeBin := filepath.Join(dir, "yt-dlp")
	payload := []byte("#!/bin/sh\nexit 0\n")
	if err := os.WriteFile(fakeBin, payload, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	hexSum := hex.EncodeToString(sum[:])
	origAsset, hadOrig := ytengine.OfficialSHA256Sums[hexSum]
	ytengine.OfficialSHA256Sums[hexSum] = "yt-dlp-p37-compartments-test"
	defer func() {
		if hadOrig {
			ytengine.OfficialSHA256Sums[hexSum] = origAsset
		} else {
			delete(ytengine.OfficialSHA256Sums, hexSum)
		}
	}()

	runtimePath := filepath.Join(dir, "runtime.json")
	initialJSON := `{
  "schema_version": "1.0",
  "ytdlp": {
    "youtube_slots": 5,
    "youtube_queue_size": 40,
    "youtube_queue_wait": "18s",
    "social_slots": 6,
    "social_queue_size": 44,
    "social_queue_wait": "19s",
    "generic_slots": 3,
    "generic_queue_size": 20,
    "generic_queue_wait": "14s",
    "youtube_ejs_concurrency": 7,
    "youtube_ejs_queue_size": 70,
    "youtube_ejs_queue_wait": "9s"
  },
  "fast_pool": {
    "per_platform_max_concurrency": 20
  },
  "circuit_breaker": {
    "enabled": true,
    "consecutive_failures": 5,
    "window_size": 10,
    "failure_rate_threshold": 0.6,
    "open_duration": "30s",
    "half_open_max_probes": 2,
    "disabled_platforms": []
  },
  "cache": {
    "youtube_parse_ttl": "90s",
    "stale_if_error_ttl": "480s",
    "upstream_blocked_neg_ttl": "4s"
  }
}`
	if err := os.WriteFile(runtimePath, []byte(initialJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	envMap := map[string]string{
		"DOKITOOL_YTDLP_BINARY":          fakeBin,
		"DOKITOOL_YTDLP_GATE_PORTS":      "23101", // Single fixed port shared across all 3 compartments (5+6+3=14 slots)
		"DOKITOOL_YTDLP_YOUTUBE_ENABLED": "true",
		"DOKITOOL_YTDLP_X_ENABLED":       "true",
		"DOKITOOL_YTDLP_GENERIC_ENABLED": "true",
		api.EnvRuntimeConfigFile:         runtimePath,
	}
	getenv := func(k string) string { return envMap[k] }

	rtCfg, fromFile, err := api.LoadRuntimeConfig(getenv)
	if err != nil || !fromFile {
		t.Fatalf("LoadRuntimeConfig failed: fromFile=%v err=%v", fromFile, err)
	}
	limits, err := api.LoadAdmissionConfig(getenv)
	if err != nil {
		t.Fatalf("LoadAdmissionConfig failed: %v", err)
	}
	api.ApplyRuntimeConfigToAdmissionConfig(&limits, rtCfg)

	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	adapters := map[string]api.Adapter{}
	ytCfg, err := configureYTDLPFullWithRuntime(c, adapters, fetch.New(), x.TombstoneFallbackOff, getenv, limits, rtCfg, fromFile)
	if err != nil {
		t.Fatalf("configureYTDLPFullWithRuntime failed: %v", err)
	}
	defer func() { _ = ytCfg.Close() }()

	if ytCfg.youtubeEngine == nil || ytCfg.socialEngine == nil || ytCfg.genericEngine == nil {
		t.Fatalf("expected all 3 compartment engines to be initialized: %+v", ytCfg)
	}
	if ytCfg.youtubeEngine.ConcurrencyLimit() != 5 || ytCfg.socialEngine.ConcurrencyLimit() != 6 || ytCfg.genericEngine.ConcurrencyLimit() != 3 {
		t.Fatalf("unexpected initial compartment limits: yt=%d social=%d generic=%d, want 5/6/3",
			ytCfg.youtubeEngine.ConcurrencyLimit(), ytCfg.socialEngine.ConcurrencyLimit(), ytCfg.genericEngine.ConcurrencyLimit())
	}

	h, err := api.New(c, adapters, time.Now, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.SetGenericAdapter(ytCfg.genericAdapter)
	h.Stats().SetYTDLPEngine(ytCfg.socialEngine)
	h.Stats().SetGenericYTDLPEngine(ytCfg.genericEngine)
	h.Stats().SetYTDLPCompartmentSources(ytCfg.youtubeEngine, ytCfg.socialEngine, ytCfg.genericEngine)
	h.Stats().SetRuntimeConfig(api.RuntimeConfigSnapshot{
		Version:             version,
		YTDLPEnabled:        true,
		YTDLPGenericEnabled: true,
	})

	ownerTok := randomHexToken(t, 24)
	auth, err := api.NewOwnerAuth(ownerTok)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := api.WithAdmissionWithOwner(h, nil, "direct", "", limits, auth)
	if err != nil {
		t.Fatal(err)
	}
	api.ApplyRuntimeConfig(entry, h, rtCfg, true, false)

	// Trigger SIGHUP with valid updated runtime.json.
	updatedJSON := `{
  "schema_version": "1.0",
  "ytdlp": {
    "youtube_slots": 8,
    "youtube_queue_size": 48,
    "youtube_queue_wait": "22s",
    "social_slots": 7,
    "social_queue_size": 40,
    "social_queue_wait": "21s",
    "generic_slots": 4,
    "generic_queue_size": 24,
    "generic_queue_wait": "12s",
    "youtube_ejs_concurrency": 9,
    "youtube_ejs_queue_size": 80,
    "youtube_ejs_queue_wait": "11s"
  },
  "fast_pool": {
    "per_platform_max_concurrency": 32
  },
  "circuit_breaker": {
    "enabled": true,
    "consecutive_failures": 4,
    "window_size": 12,
    "failure_rate_threshold": 0.5,
    "open_duration": "45s",
    "half_open_max_probes": 3,
    "disabled_platforms": ["tumblr"]
  },
  "cache": {
    "youtube_parse_ttl": "0s",
    "stale_if_error_ttl": "300s",
    "upstream_blocked_neg_ttl": "8s"
  }
}`
	if err := os.WriteFile(runtimePath, []byte(updatedJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigCh := make(chan os.Signal, 2)
	var logsMu sync.Mutex
	var logs []string
	logf := func(format string, args ...any) {
		logsMu.Lock()
		logs = append(logs, fmt.Sprintf(format, args...))
		logsMu.Unlock()
	}
	stopReload := startSignalReloader(ctx, sigCh, entry, h, &ytCfg, getenv, limits, logf)
	defer stopReload()

	sigCh <- syscall.SIGHUP
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if h.Stats().Snapshot().RuntimePolicy.ReloadCount == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	snap := h.Stats().Snapshot()
	if snap.RuntimePolicy.ReloadCount != 1 || !snap.RuntimePolicy.ConfigFileActive || snap.RuntimePolicy.LastReloadedAt == "" {
		t.Fatalf("runtime hot-reload did not update stats policy: %+v", snap.RuntimePolicy)
	}
	if ytCfg.youtubeEngine.ConcurrencyLimit() != 8 || ytCfg.socialEngine.ConcurrencyLimit() != 7 || ytCfg.genericEngine.ConcurrencyLimit() != 4 {
		t.Fatalf("ytengine compartment limits not resized on SIGHUP: yt=%d social=%d generic=%d, want 8/7/4",
			ytCfg.youtubeEngine.ConcurrencyLimit(), ytCfg.socialEngine.ConcurrencyLimit(), ytCfg.genericEngine.ConcurrencyLimit())
	}
	if snap.YTDLPPools.YouTube.ConcurrencyLimit != 8 || snap.YTDLPPools.Social.ConcurrencyLimit != 7 || snap.YTDLPPools.Generic.ConcurrencyLimit != 4 || snap.YTDLPPools.YouTubeEJS.ConcurrencyLimit != 9 {
		t.Fatalf("stats ytdlp_pools not updated on SIGHUP: %+v", snap.YTDLPPools)
	}
	if snap.RuntimePolicy.FastPerPlatformMaxConcurrency != 32 || snap.RuntimePolicy.YouTubeParseTTLSeconds != 0 || len(snap.RuntimePolicy.DisabledPlatforms) != 1 || snap.RuntimePolicy.DisabledPlatforms[0] != "tumblr" {
		t.Fatalf("unexpected reloaded runtime policy fields: %+v", snap.RuntimePolicy)
	}

	// Trigger SIGHUP with invalid JSON (unknown field) -> must fail safe and retain previous limits.
	if err := os.WriteFile(runtimePath, []byte(`{"schema_version":"1.0","unknown_key":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	sigCh <- syscall.SIGHUP
	deadline = time.Now().Add(2 * time.Second)
	rejectedLogged := false
	for time.Now().Before(deadline) {
		logsMu.Lock()
		for _, line := range logs {
			if strings.Contains(line, "runtime config reload rejected") {
				rejectedLogged = true
				break
			}
		}
		logsMu.Unlock()
		if rejectedLogged {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !rejectedLogged {
		t.Fatal("expected fail-safe rejection log for invalid runtime.json reload")
	}
	snapAfterBad := h.Stats().Snapshot()
	if snapAfterBad.RuntimePolicy.ReloadCount != 1 || snapAfterBad.RuntimePolicy.YouTubeSlots != 8 || ytCfg.youtubeEngine.ConcurrencyLimit() != 8 {
		t.Fatalf("invalid reload mutated active config: policy=%+v ytLimit=%d", snapAfterBad.RuntimePolicy, ytCfg.youtubeEngine.ConcurrencyLimit())
	}

	// 4. Env-only startup (!runtimeFromFile) MUST align all 3 ytengine compartments with validated AdmissionConfig limits (M2 / Low-4).
	envOnlyMap := map[string]string{
		"DOKITOOL_YTDLP_BINARY":                     fakeBin,
		"DOKITOOL_YTDLP_YOUTUBE_ENABLED":            "true",
		"DOKITOOL_YTDLP_X_ENABLED":                  "true",
		"DOKITOOL_YTDLP_GENERIC_ENABLED":            "true",
		"DOKITOOL_PARSE_YOUTUBE_GLOBAL_CONCURRENCY": "7",
		"DOKITOOL_PARSE_SLOW_GLOBAL_CONCURRENCY":    "9",
		"DOKITOOL_PARSE_GENERIC_GLOBAL_CONCURRENCY": "5",
	}
	envOnlyGet := func(k string) string { return envOnlyMap[k] }
	envOnlyLimits, err := api.LoadAdmissionConfig(envOnlyGet)
	if err != nil {
		t.Fatalf("env-only LoadAdmissionConfig failed: %v", err)
	}
	cEnvOnly, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	ytEnvOnly, err := configureYTDLPFullWithRuntime(cEnvOnly, map[string]api.Adapter{}, fetch.New(), x.TombstoneFallbackOff, envOnlyGet, envOnlyLimits, api.DefaultRuntimeConfig(), false)
	if err != nil {
		t.Fatalf("env-only configureYTDLPFullWithRuntime failed: %v", err)
	}
	defer func() { _ = ytEnvOnly.Close() }()
	if ytEnvOnly.youtubeEngine.ConcurrencyLimit() != 7 || ytEnvOnly.socialEngine.ConcurrencyLimit() != 9 || ytEnvOnly.genericEngine.ConcurrencyLimit() != 5 {
		t.Fatalf("env-only compartment limits did not align with AdmissionConfig: yt=%d social=%d generic=%d, want 7/9/5",
			ytEnvOnly.youtubeEngine.ConcurrencyLimit(), ytEnvOnly.socialEngine.ConcurrencyLimit(), ytEnvOnly.genericEngine.ConcurrencyLimit())
	}

	// 5. Fault-injected SIGHUP atomic rollback (F4 / NB-1 / ARCH-05):
	// Inject BOTH compartment #2 (socialEngine) and compartment #3 (genericEngine) failures and assert
	// all prior compartments, admission pools, circuit breakers, cache policy, and generation remain untouched.
	genBeforeRollback := h.RuntimeConfigGeneration()
	if genBeforeRollback != 2 {
		t.Fatalf("expected generation=2 after startup apply + 1 valid reload, got %d", genBeforeRollback)
	}
	policyBeforeRollback := h.RuntimePolicySnapshot()
	rollbackJSON := strings.ReplaceAll(updatedJSON, `"youtube_slots": 8`, `"youtube_slots": 11`)
	rollbackJSON = strings.ReplaceAll(rollbackJSON, `"social_slots": 7`, `"social_slots": 10`)
	rollbackJSON = strings.ReplaceAll(rollbackJSON, `"generic_slots": 4`, `"generic_slots": 6`)
	rollbackJSON = strings.ReplaceAll(rollbackJSON, `"youtube_parse_ttl": "0s"`, `"youtube_parse_ttl": "180s"`)
	rollbackJSON = strings.ReplaceAll(rollbackJSON, `"disabled_platforms": ["tumblr"]`, `"disabled_platforms": ["douyin"]`)
	if err := os.WriteFile(runtimePath, []byte(rollbackJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	// (a) Compartment #2 (social) failure -> compartment #1 (youtube) rolls back to 8; zero contamination!
	faultyComp2 := ytdlpConfigResult{
		engine:        ytCfg.engine,
		youtubeEngine: ytCfg.youtubeEngine, // currently 8
		socialEngine:  ytengine.NewDisabled("injected compartment #2 failure"),
		genericEngine: ytCfg.genericEngine, // currently 4
	}
	if ok := reloadRuntimeConfigOnce(entry, h, &faultyComp2, getenv, logf); ok {
		t.Fatal("expected reloadRuntimeConfigOnce to return false when compartment #2 fails")
	}
	if ytCfg.youtubeEngine.ConcurrencyLimit() != 8 || ytCfg.socialEngine.ConcurrencyLimit() != 7 || ytCfg.genericEngine.ConcurrencyLimit() != 4 {
		t.Fatalf("compartment #2 failure did not roll back youtubeEngine: yt=%d social=%d generic=%d, want 8/7/4",
			ytCfg.youtubeEngine.ConcurrencyLimit(), ytCfg.socialEngine.ConcurrencyLimit(), ytCfg.genericEngine.ConcurrencyLimit())
	}

	// (b) Compartment #3 (generic) failure -> compartments #2 (social) and #1 (youtube) roll back in reverse order to 7 & 8!
	faultyComp3 := ytdlpConfigResult{
		engine:        ytCfg.engine,
		youtubeEngine: ytCfg.youtubeEngine, // currently 8
		socialEngine:  ytCfg.socialEngine,  // currently 7
		genericEngine: ytengine.NewDisabled("injected compartment #3 failure"),
	}
	if ok := reloadRuntimeConfigOnce(entry, h, &faultyComp3, getenv, logf); ok {
		t.Fatal("expected reloadRuntimeConfigOnce to return false when compartment #3 fails")
	}
	if ytCfg.youtubeEngine.ConcurrencyLimit() != 8 || ytCfg.socialEngine.ConcurrencyLimit() != 7 || ytCfg.genericEngine.ConcurrencyLimit() != 4 {
		t.Fatalf("compartment #3 failure did not roll back compartments #1/#2: yt=%d social=%d generic=%d, want 8/7/4",
			ytCfg.youtubeEngine.ConcurrencyLimit(), ytCfg.socialEngine.ConcurrencyLimit(), ytCfg.genericEngine.ConcurrencyLimit())
	}

	// Assert generation, immutable policy snapshot, admission pools, circuit breakers, and cache TTL are 100% untouched.
	if h.RuntimeConfigGeneration() != genBeforeRollback || h.RuntimePolicySnapshot() != policyBeforeRollback {
		t.Fatalf("policy snapshot or generation mutated after compartment failures: gen=%d want %d",
			h.RuntimeConfigGeneration(), genBeforeRollback)
	}
	if snapAfterRollback := h.Stats().Snapshot(); snapAfterRollback.RuntimePolicy.ReloadCount != 1 ||
		snapAfterRollback.RuntimePolicy.YouTubeSlots != 8 ||
		snapAfterRollback.RuntimePolicy.SocialSlots != 7 ||
		snapAfterRollback.RuntimePolicy.GenericSlots != 4 ||
		snapAfterRollback.RuntimePolicy.YouTubeParseTTLSeconds != 0 ||
		len(snapAfterRollback.RuntimePolicy.DisabledPlatforms) != 1 ||
		snapAfterRollback.RuntimePolicy.DisabledPlatforms[0] != "tumblr" ||
		snapAfterRollback.YTDLPPools.YouTube.ConcurrencyLimit != 8 ||
		snapAfterRollback.YTDLPPools.Social.ConcurrencyLimit != 7 ||
		snapAfterRollback.YTDLPPools.Generic.ConcurrencyLimit != 4 {
		t.Fatalf("admission/cb/cache/stats mutated despite compartment failure: policy=%+v pools=%+v",
			snapAfterRollback.RuntimePolicy, snapAfterRollback.YTDLPPools)
	}
	for _, cbSnap := range h.Stats().Snapshot().CircuitBreakers {
		if cbSnap.Platform == "douyin" && cbSnap.DisabledByConfig {
			t.Fatal("circuit breaker disabled_platforms leaked douyin after failed compartment resize")
		}
		if cbSnap.Platform == "tumblr" && !cbSnap.DisabledByConfig {
			t.Fatal("circuit breaker lost prior disabled platform tumblr after failed compartment resize")
		}
	}
}

type fakeCompartmentLimiter struct {
	name      string
	limit     int
	failLimit int
	failErr   error
	ops       *[]string
}

func (f *fakeCompartmentLimiter) ConcurrencyLimit() int { return f.limit }

func (f *fakeCompartmentLimiter) SetConcurrencyLimit(next int) error {
	*f.ops = append(*f.ops, fmt.Sprintf("%s:%d->%d", f.name, f.limit, next))
	if f.failErr != nil && next == f.failLimit {
		return f.failErr
	}
	f.limit = next
	return nil
}

func TestApplyCompartmentLimitTargetsReverseRollbackAndErrorJoin(t *testing.T) {
	var ops []string
	yt := &fakeCompartmentLimiter{name: "youtube", limit: 4, ops: &ops}
	socialRollbackErr := errors.New("social rollback failure")
	social := &fakeCompartmentLimiter{name: "social", limit: 6, failLimit: 6, failErr: socialRollbackErr, ops: &ops}
	genericResizeErr := errors.New("generic resize failure")
	generic := &fakeCompartmentLimiter{name: "generic", limit: 2, failLimit: 5, failErr: genericResizeErr, ops: &ops}

	err := applyCompartmentLimitTargets([]compartmentLimitTarget{
		{name: "youtube", limiter: yt, prev: yt.ConcurrencyLimit(), next: 9},
		{name: "social", limiter: social, prev: social.ConcurrencyLimit(), next: 10},
		{name: "generic", limiter: generic, prev: generic.ConcurrencyLimit(), next: 5},
	})
	if err == nil {
		t.Fatal("expected error when generic compartment resize fails")
	}
	if !errors.Is(err, genericResizeErr) || !errors.Is(err, socialRollbackErr) || !errors.Is(err, errCompartmentRollbackFailed) {
		t.Fatalf("expected joined resize + rollback + sentinel errors, got: %v", err)
	}
	// Verify reverse-order rollback attempted social first, then youtube (and youtube succeeded!).
	wantOps := []string{"youtube:4->9", "social:6->10", "generic:2->5", "social:10->6", "youtube:9->4"}
	if strings.Join(ops, ",") != strings.Join(wantOps, ",") {
		t.Fatalf("compartment ops = %v, want %v", ops, wantOps)
	}
	if yt.limit != 4 || generic.limit != 2 {
		t.Fatalf("unexpected final limits: yt=%d generic=%d, want 4/2", yt.limit, generic.limit)
	}
}

func TestReloadRuntimeConfigOnceLogsCriticalOnCompartmentRollbackFailure(t *testing.T) {
	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	cfgJSON := `{"schema_version":"1.0","ytdlp":{"youtube_slots":9,"social_slots":10,"generic_slots":5}}`
	if err := os.WriteFile(runtimePath, []byte(cfgJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	h, err := api.New(c, map[string]api.Adapter{}, time.Now, nil)
	if err != nil {
		t.Fatal(err)
	}
	limits, err := api.LoadAdmissionConfig(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	entry, err := api.WithAdmissionWithOwner(h, nil, "direct", "", limits, api.OwnerAuth{})
	if err != nil {
		t.Fatal(err)
	}
	getenv := func(k string) string {
		if k == api.EnvRuntimeConfigFile {
			return runtimePath
		}
		return ""
	}

	var ops []string
	ytRollbackErr := errors.New("youtube rollback failure")
	socialResizeErr := errors.New("social resize failure")
	yt := &fakeCompartmentLimiter{name: "youtube", limit: 4, failLimit: 4, failErr: ytRollbackErr, ops: &ops}
	social := &fakeCompartmentLimiter{name: "social", limit: 6, failLimit: 10, failErr: socialResizeErr, ops: &ops}
	generic := &fakeCompartmentLimiter{name: "generic", limit: 2, ops: &ops}
	ytCfg := ytdlpConfigResult{
		testBuildTargets: func(ytSlots, socialSlots, genericSlots int) []compartmentLimitTarget {
			return []compartmentLimitTarget{
				{name: "youtube", limiter: yt, prev: yt.ConcurrencyLimit(), next: ytSlots},
				{name: "social", limiter: social, prev: social.ConcurrencyLimit(), next: socialSlots},
				{name: "generic", limiter: generic, prev: generic.ConcurrencyLimit(), next: genericSlots},
			}
		},
	}

	var logged []string
	logf := func(format string, args ...any) {
		logged = append(logged, fmt.Sprintf(format, args...))
	}
	genBefore := h.RuntimeConfigGeneration()
	if ok := reloadRuntimeConfigOnce(entry, h, &ytCfg, getenv, logf); ok {
		t.Fatal("expected reloadRuntimeConfigOnce to fail when compartment #2 resize and compartment #1 rollback both fail")
	}
	if h.RuntimeConfigGeneration() != genBefore {
		t.Fatalf("generation mutated despite rollback failure: got %d want %d", h.RuntimeConfigGeneration(), genBefore)
	}
	if len(logged) != 1 || !strings.Contains(logged[0], "dokitool: CRITICAL runtime config reload rollback failed") || strings.Contains(logged[0], "previous configuration preserved") {
		t.Fatalf("expected CRITICAL rollback failure log without preserved claim, got: %q", logged)
	}
	if !strings.Contains(logged[0], "compartment rollback failed") || !strings.Contains(logged[0], "social resize failure") || !strings.Contains(logged[0], "youtube rollback failure") {
		t.Fatalf("CRITICAL log missing joined root-cause errors: %q", logged[0])
	}
	wantOps := []string{"youtube:4->9", "social:6->10", "youtube:9->4"}
	if strings.Join(ops, ",") != strings.Join(wantOps, ",") {
		t.Fatalf("compartment ops = %v, want %v", ops, wantOps)
	}
}

func TestConfigureShanghaiDirectModeRejectsTokenCollision(t *testing.T) {
	shared := strings.Repeat("s", 32)
	env := map[string]string{
		"DOKITOOL_SHANGHAI_MODE":     "direct",
		"DOKITOOL_SHANGHAI_ENDPOINT": "https://sh.example.com/resolve",
		"DOKITOOL_SHANGHAI_TOKEN":    shared,
		"DOKITOOL_OWNER_TOKEN":       shared,
	}
	_, _, err := configureShanghai(nil, func(k string) string { return env[k] })
	if err == nil || !strings.Contains(err.Error(), "dedicated Shanghai token") {
		t.Fatalf("expected direct mode token collision error, got: %v", err)
	}
}
