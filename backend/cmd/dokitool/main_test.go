package main

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
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/api"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/kuaishou"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/pipixia"
	weiboplatform "github.com/Brilliant666/DokiTool-Go/backend/internal/platform/weibo"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/x"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/xiaohongshu"
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

	origAsset, hadOrig := ytengine.OfficialSHA256Sums20261026[hexSum]
	ytengine.OfficialSHA256Sums20261026[hexSum] = "yt-dlp-cmd-test"
	defer func() {
		if hadOrig {
			ytengine.OfficialSHA256Sums20261026[hexSum] = origAsset
		} else {
			delete(ytengine.OfficialSHA256Sums20261026, hexSum)
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
			t.Fatal("deno v2.9.8 binary not found in DOKITOOL_DENO_BINARY or PATH")
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

	origAsset, hadOrig := ytengine.OfficialSHA256Sums20261026[hexSum]
	ytengine.OfficialSHA256Sums20261026[hexSum] = "yt-dlp-sites-cmd-test"
	defer func() {
		if hadOrig {
			ytengine.OfficialSHA256Sums20261026[hexSum] = origAsset
		} else {
			delete(ytengine.OfficialSHA256Sums20261026, hexSum)
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
			name: "enabled-missing-binary-not-registered-in-catalog",
			env: map[string]string{
				"DOKITOOL_YTDLP_SITES":  "facebook,tumblr,dailymotion",
				"DOKITOOL_YTDLP_BINARY": filepath.Join(dir, "missing-yt-dlp"),
			},
			wantSites: nil,
			wantErr:   false,
		},
		{
			name: "enabled-verified-binary-registers-selected-sites-only",
			env: map[string]string{
				"DOKITOOL_YTDLP_SITES":  "facebook,tumblr,dailymotion",
				"DOKITOOL_YTDLP_BINARY": fakeBin,
			},
			wantSites: []string{"facebook", "tumblr", "dailymotion"},
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
			if len(tc.wantSites) == 3 {
				if got := c.PlatformForURL("https://www.facebook.com/reel/1517545242764683"); got != "facebook" {
					t.Fatalf("PlatformForURL(facebook)=%q, want facebook", got)
				}
				if got := c.PlatformForURL("https://maskofthedragon.tumblr.com/post/706987028632748032"); got != "tumblr" {
					t.Fatalf("PlatformForURL(tumblr)=%q, want tumblr", got)
				}
				if got := c.PlatformForURL("https://www.dailymotion.com/video/x8t9abc"); got != "dailymotion" {
					t.Fatalf("PlatformForURL(dailymotion)=%q, want dailymotion", got)
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

	origAsset, hadOrig := ytengine.OfficialSHA256Sums20261026[hexSum]
	ytengine.OfficialSHA256Sums20261026[hexSum] = "yt-dlp-tombstone-cmd-test"
	defer func() {
		if hadOrig {
			ytengine.OfficialSHA256Sums20261026[hexSum] = origAsset
		} else {
			delete(ytengine.OfficialSHA256Sums20261026, hexSum)
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

	h, err := api.New(registry, map[string]api.Adapter{
		"xiaohongshu": xhsAdapter,
		"kuaishou":    ksAdapter,
		"pipixia":     ppxAdapter,
	}, func() time.Time { return time.Unix(now, 0) }, preparePublicMedia(strings.Repeat("x", 64)))
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
			name: "shared-with-media-signing-key",
			env: map[string]string{
				"DOKITOOL_OWNER_TOKEN":   canaryShared,
				"SNAP_MEDIA_SIGNING_KEY": canaryShared,
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

func TestPreparePublicMediaWeiboOwnerDirectVsAnonymousRelay(t *testing.T) {
	const now int64 = 1730000000
	const srcURL = "https://weibo.com/1234567890/AbC"
	const cdnURL = "https://f.video.weibocdn.com/full.mp4?size=1080"
	const body = `{"idstr":"1234567890","text_raw":"t","page_info":{"media_info":{"mp4_hd_url":"https://f.video.weibocdn.com/full.mp4?size=1080","video_title":"v","duration":16}},"user":{"screen_name":"u","idstr":"1"}}`

	mediaKey := randomHexToken(t, 32)
	ownerToken := randomHexToken(t, 24)
	registry, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	wb := weiboplatform.New(fakeExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(body)}, nil
	}))
	h, err := api.New(registry, map[string]api.Adapter{"weibo": wb}, func() time.Time { return time.Unix(now, 0) }, preparePublicMedia(mediaKey))
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
	ownerReq := httptest.NewRequest(http.MethodGet, "/api/parse?"+q.Encode(), nil)
	ownerReq.RemoteAddr = "127.0.0.1:40001"
	ownerReq.Header.Set("Authorization", "Bearer "+ownerToken)
	wOwner := httptest.NewRecorder()
	entry.ServeHTTP(wOwner, ownerReq)
	if wOwner.Code != http.StatusOK || !strings.Contains(wOwner.Body.String(), cdnURL) || strings.Contains(wOwner.Body.String(), "/api/media/weibo?ticket=") {
		t.Fatalf("owner Weibo response did not return direct CDN URL without relay: code=%d body=%s", wOwner.Code, wOwner.Body.String())
	}

	anonReq := httptest.NewRequest(http.MethodGet, "/api/parse?"+q.Encode(), nil)
	anonReq.RemoteAddr = "127.0.0.1:40002"
	wAnon := httptest.NewRecorder()
	entry.ServeHTTP(wAnon, anonReq)
	if wAnon.Code != http.StatusOK || strings.Contains(wAnon.Body.String(), cdnURL) || !strings.Contains(wAnon.Body.String(), "/api/media/weibo?ticket=") {
		t.Fatalf("anonymous Weibo response did not return signed relay URL: code=%d body=%s", wAnon.Code, wAnon.Body.String())
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

	origAsset, hadOrig := ytengine.OfficialSHA256Sums20261026[hexSum]
	ytengine.OfficialSHA256Sums20261026[hexSum] = "yt-dlp-stats-wire-test"
	defer func() {
		if hadOrig {
			ytengine.OfficialSHA256Sums20261026[hexSum] = origAsset
		} else {
			delete(ytengine.OfficialSHA256Sums20261026, hexSum)
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
	ownerAuth, err := loadOwnerAuth(getenv)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := api.WithAdmissionWithOwner(h, control, "direct", "", api.DefaultAdmissionConfig(), ownerAuth)
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

			douyinParser, bilibiliParser := newShanghaiParsers(jpExec, probe.New(jpExec, douyin.AllowedMediaURL), shanghai)
			c, err := catalog.Load()
			if err != nil {
				t.Fatal(err)
			}
			h, err := api.NewWithCacheConfig(c, map[string]api.Adapter{
				"douyin":   douyinParser,
				"bilibili": bilibiliParser,
			}, func() time.Time { return nowTime }, preparePublicMedia(mediaKey), api.DefaultCacheConfig())
			if err != nil {
				t.Fatal(err)
			}
			h.Stats().SetShanghaiSource(broker)
			ownerAuth, err := loadOwnerAuth(getenv)
			if err != nil {
				t.Fatal(err)
			}
			adm := api.DefaultAdmissionConfig()
			adm.Parse.ClientBurst = 50
			adm.Parse.ClientRPS = 50
			entry, err := api.WithAdmissionWithOwner(h, control, "direct", "", adm, ownerAuth)
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
					shURL := fmt.Sprintf("https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/05/%s/%s-1-80.mp4?deadline=%d", cid, cid, dlUnix)
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
					if len(group) != 2 || !strings.Contains(unified.Str(unified.Map(group[0])["url"]), "cn-sh-fx-01-01.bilivideo.com") ||
						!strings.Contains(unified.Str(unified.Map(group[1])["url"]), "upos-sz-mirrorcosov.bilivideo.com") {
						t.Fatalf("enabled mode expected [cn-sh, upos], got %v", group)
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
