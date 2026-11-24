package ytengine

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWithGenericConcurrencyDynamicPortsIsolation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script fixture requires unix")
	}

	// Nil receiver fails closed cleanly.
	var nilEng *Engine
	if disabled := nilEng.WithGenericConcurrency(2); disabled == nil || disabled.Enabled() {
		t.Fatalf("expected disabled engine for nil.WithGenericConcurrency, got %+v", disabled)
	}

	gateDir := t.TempDir()
	releaseFile := filepath.Join(gateDir, "release")
	startedDir := filepath.Join(gateDir, "started")
	if err := os.MkdirAll(startedDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Block only URLs containing "/slow/"; fast URLs return immediately.
	script := fmt.Sprintf(`
url=""
for a in "$@"; do url="$a"; done
case "$url" in
  */slow/*)
    id=$(basename "$url")
    : > %q/"$id"
    while [ ! -f %q ]; do
      sleep 0.02
    done
    ;;
esac
echo '{"id":"ok","title":"ok","formats":[{"format_id":"1","url":"https://cdn.example.com/v.mp4","ext":"mp4","protocol":"https","vcodec":"avc1","acodec":"mp4a"}]}'
`, startedDir, releaseFile)

	binPath, hashes := writeFakeYTDLP(t, script)
	baseEng, err := New(Config{
		BinaryPath:     binPath,
		AllowedHashes:  hashes,
		MaxConcurrency: 2,
		Timeout:        5 * time.Second,
	})
	if err != nil || !baseEng.Enabled() {
		t.Fatalf("New baseEng failed: %v", err)
	}

	// Clamping & defaults.
	if got := baseEng.WithGenericConcurrency(0).ConcurrencyLimit(); got != DefaultGenericSlots {
		t.Fatalf("WithGenericConcurrency(0) limit = %d, want %d", got, DefaultGenericSlots)
	}
	if got := baseEng.WithGenericConcurrency(-3).ConcurrencyLimit(); got != DefaultGenericSlots {
		t.Fatalf("WithGenericConcurrency(-3) limit = %d, want %d", got, DefaultGenericSlots)
	}
	if got := baseEng.WithGenericConcurrency(1).ConcurrencyLimit(); got != 1 {
		t.Fatalf("WithGenericConcurrency(1) limit = %d, want 1", got)
	}
	if got := baseEng.WithGenericConcurrency(999).ConcurrencyLimit(); got != MaxConcurrency {
		t.Fatalf("WithGenericConcurrency(999) limit = %d, want %d", got, MaxConcurrency)
	}

	genericEng := baseEng.WithGenericConcurrency(2)
	if genericEng.slotPool == baseEng.slotPool {
		t.Fatal("WithGenericConcurrency must allocate an independent DynamicSlotPool")
	}
	if genericEng.slotStats == baseEng.slotStats {
		t.Fatal("WithGenericConcurrency must allocate fresh slotStats")
	}

	// Saturate all 2 generic slots.
	var wg sync.WaitGroup
	errCh := make(chan error, 2)
	for i := 1; i <= 2; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_, exErr := genericEng.Extract(context.Background(), fmt.Sprintf("https://vimeo.com/slow/g%d", idx))
			errCh <- exErr
		}(i)
	}

	// Wait until both generic subprocesses have entered execution.
	deadline := time.Now().Add(3 * time.Second)
	for {
		entries, _ := os.ReadDir(startedDir)
		if len(entries) >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for 2 generic slots to saturate; started=%d", len(entries))
		}
		time.Sleep(15 * time.Millisecond)
	}

	// A 3rd generic call must block on genericEng.sem and fail fast on short context timeout.
	waitCtx, waitCancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer waitCancel()
	_, waitErr := genericEng.Extract(waitCtx, "https://vimeo.com/fast/g3")
	var waitEErr *Error
	if !errors.As(waitErr, &waitEErr) || waitEErr.Code != CodeUpstreamTimeout {
		t.Fatalf("expected 3rd generic call to time out waiting on generic semaphore, got %v", waitErr)
	}

	// Meanwhile Tier-1 baseEng must execute immediately with ZERO wait contention.
	start := time.Now()
	if _, baseErr := baseEng.Extract(context.Background(), "https://x.com/i/status/123"); baseErr != nil {
		t.Fatalf("Tier-1 baseEng.Extract failed while genericEng saturated: %v", baseErr)
	}
	if elapsed := time.Since(start); elapsed > 1500*time.Millisecond {
		t.Fatalf("Tier-1 baseEng was delayed by saturated genericEng: %v", elapsed)
	}
	if snap := baseEng.StatsSnapshot(); snap.Total.WaitCount != 0 || snap.Total.AcquiredCount != 1 {
		t.Fatalf("expected zero Tier-1 contention, got %+v", snap)
	}
	if gSnap := genericEng.StatsSnapshot(); gSnap.Total.CanceledCount != 1 || gSnap.Active != 2 {
		t.Fatalf("expected isolated generic slot stats (active=2, canceled=1), got %+v", gSnap)
	}

	// Release blocked generic workers and confirm clean completion.
	if err := os.WriteFile(releaseFile, []byte("go"), 0o600); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	close(errCh)
	for exErr := range errCh {
		if exErr != nil {
			t.Fatalf("generic Extract failed after release: %v", exErr)
		}
	}
}

func TestWithGenericConcurrencyFixedGatePortsSubSemaphore(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script fixture requires unix")
	}

	gateDir := t.TempDir()
	releaseFile := filepath.Join(gateDir, "release")
	startedDir := filepath.Join(gateDir, "started")
	if err := os.MkdirAll(startedDir, 0o755); err != nil {
		t.Fatal(err)
	}

	script := fmt.Sprintf(`
url=""
for a in "$@"; do url="$a"; done
case "$url" in
  */slow/*)
    id=$(basename "$url")
    : > %q/"$id"
    while [ ! -f %q ]; do
      sleep 0.02
    done
    ;;
esac
echo '{"id":"ok","title":"ok","formats":[{"format_id":"1","url":"https://cdn.example.com/v.mp4","ext":"mp4","protocol":"https","vcodec":"avc1","acodec":"mp4a"}]}'
`, startedDir, releaseFile)

	binPath, hashes := writeFakeYTDLP(t, script)
	ports := testGatePorts(t, 1)
	baseEng, err := New(Config{
		BinaryPath:     binPath,
		AllowedHashes:  hashes,
		MaxConcurrency: 3,
		GatePorts:      ports,
		Timeout:        5 * time.Second,
	})
	if err != nil || !baseEng.Enabled() {
		t.Fatalf("New fixed-port baseEng failed: %v", err)
	}
	t.Cleanup(func() { _ = baseEng.Close() })

	// With multiplexed fixed gate ports, WithGenericConcurrency always gets an independent
	// DynamicSlotPool (not capped by baseEng concurrency) while sharing the multiplexed gateway.
	independent := baseEng.WithGenericConcurrency(10)
	if independent.gatePorts != baseEng.gatePorts {
		t.Fatal("fixed-port WithGenericConcurrency must share multiplexed gatePorts")
	}
	if independent.slotPool == baseEng.slotPool {
		t.Fatal("fixed-port WithGenericConcurrency must use an independent DynamicSlotPool")
	}
	if independent.ConcurrencyLimit() != 10 {
		t.Fatalf("expected independent generic limit = 10, got %d", independent.ConcurrencyLimit())
	}

	// Limit generic to 1 while baseEng has 3 slots sharing 1 fixed port, and verify chaining preserves isolation.
	genericEng := baseEng.
		WithGenericConcurrency(1).
		WithExtractors("default", "-generic")
	if genericEng.gatePorts != baseEng.gatePorts || genericEng.slotPool == baseEng.slotPool {
		t.Fatal("chained fixed-port generic engine must share gatePorts with independent slotPool")
	}
	if genericEng.ConcurrencyLimit() != 1 {
		t.Fatalf("expected chained generic limit = 1, got %d", genericEng.ConcurrencyLimit())
	}

	// Occupy the single generic slot; Tier-1 baseEng still keeps ALL 3 of its slots free.
	doneCh := make(chan error, 1)
	go func() {
		_, exErr := genericEng.Extract(context.Background(), "https://vimeo.com/slow/g1")
		doneCh <- exErr
	}()

	deadline := time.Now().Add(3 * time.Second)
	for {
		entries, _ := os.ReadDir(startedDir)
		if len(entries) >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for first generic call to enter execution")
		}
		time.Sleep(15 * time.Millisecond)
	}

	// A 2nd generic request must block on genericEng's independent slotPool and time out.
	g2Ctx, g2Cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer g2Cancel()
	_, g2Err := genericEng.Extract(g2Ctx, "https://vimeo.com/fast/g2")
	var g2EErr *Error
	if !errors.As(g2Err, &g2EErr) || g2EErr.Code != CodeUpstreamTimeout {
		t.Fatalf("expected 2nd generic call to block on generic pool and time out, got %v", g2Err)
	}

	// Meanwhile Tier-1 baseEng can run ALL 3 concurrent extractions without generic consuming any Tier-1 slot.
	var tier1WG sync.WaitGroup
	tier1Errs := make(chan error, 3)
	for i := 0; i < 3; i++ {
		tier1WG.Add(1)
		go func(idx int) {
			defer tier1WG.Done()
			_, tErr := baseEng.Extract(context.Background(), fmt.Sprintf("https://x.com/i/status/%d", 100+idx))
			tier1Errs <- tErr
		}(i)
	}
	tier1WG.Wait()
	close(tier1Errs)
	for tErr := range tier1Errs {
		if tErr != nil {
			t.Fatalf("Tier-1 Extract failed while generic pool saturated: %v", tErr)
		}
	}

	// Release first generic call and verify slots are freed cleanly.
	if err := os.WriteFile(releaseFile, []byte("go"), 0o600); err != nil {
		t.Fatal(err)
	}
	if exErr := <-doneCh; exErr != nil {
		t.Fatalf("first generic Extract failed after release: %v", exErr)
	}
	if genericEng.slotPool.Active() != 0 || baseEng.slotPool.Active() != 0 {
		t.Fatalf("expected all slots released, got generic=%d base=%d", genericEng.slotPool.Active(), baseEng.slotPool.Active())
	}
}

func TestGenericEngineStatsSnapshotBothGateModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script fixture requires unix")
	}

	modes := []struct {
		name           string
		fixedGatePorts bool
		baseConc       int
		genericLimit   int
		wantLimit      int
	}{
		{
			name:           "dynamic-ports-nil-gatePorts",
			fixedGatePorts: false,
			baseConc:       3,
			genericLimit:   1,
			wantLimit:      1,
		},
		{
			name:           "fixed-gatePorts-subSem",
			fixedGatePorts: true,
			baseConc:       3,
			genericLimit:   1,
			wantLimit:      1,
		},
	}

	for _, tc := range modes {
		t.Run(tc.name, func(t *testing.T) {
			gateDir := t.TempDir()
			releaseFile := filepath.Join(gateDir, "release")
			startedDir := filepath.Join(gateDir, "started")
			if err := os.MkdirAll(startedDir, 0o755); err != nil {
				t.Fatal(err)
			}

			script := fmt.Sprintf(`
url=""
for a in "$@"; do url="$a"; done
case "$url" in
  */slow/*)
    id=$(basename "$url")
    : > %q/"$id"
    while [ ! -f %q ]; do
      sleep 0.01
    done
    ;;
esac
echo '{"id":"ok","title":"ok","formats":[{"format_id":"1","url":"https://cdn.example.com/v.mp4","ext":"mp4","protocol":"https","vcodec":"avc1","acodec":"mp4a"}]}'
`, startedDir, releaseFile)

			binPath, hashes := writeFakeYTDLP(t, script)
			cfg := Config{
				BinaryPath:     binPath,
				AllowedHashes:  hashes,
				MaxConcurrency: tc.baseConc,
				Timeout:        5 * time.Second,
			}
			if tc.fixedGatePorts {
				cfg.GatePorts = testGatePorts(t, 1)
			}
			baseEng, err := New(cfg)
			if err != nil || !baseEng.Enabled() {
				t.Fatalf("New baseEng failed: %v", err)
			}
			t.Cleanup(func() { _ = baseEng.Close() })

			genericEng := baseEng.
				WithGenericConcurrency(tc.genericLimit).
				WithExtractors("default", "-generic")

			// Initial idle snapshot reports isolated concurrency_limit = 1 while baseEng reports 3.
			baseInit := baseEng.StatsSnapshot()
			genInit := genericEng.StatsSnapshot()
			if !genInit.Enabled || genInit.Active != 0 || genInit.Waiting != 0 || genInit.ConcurrencyLimit != tc.wantLimit {
				t.Fatalf("initial generic StatsSnapshot = %+v, want enabled=true active=0 waiting=0 limit=%d", genInit, tc.wantLimit)
			}
			if baseInit.ConcurrencyLimit != tc.baseConc {
				t.Fatalf("initial base StatsSnapshot limit = %d, want %d", baseInit.ConcurrencyLimit, tc.baseConc)
			}

			// 1. Occupy the sole generic slot with an owner request.
			firstDone := make(chan error, 1)
			go func() {
				_, exErr := genericEng.Extract(WithChannel(context.Background(), ChannelOwner), "https://vimeo.com/slow/g1")
				firstDone <- exErr
			}()
			deadline := time.Now().Add(3 * time.Second)
			for {
				if _, statErr := os.Stat(filepath.Join(startedDir, "g1")); statErr == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("timed out waiting for g1 to start")
				}
				time.Sleep(10 * time.Millisecond)
			}

			// 2. While g1 is active, launch a contended anonymous request that cancels on short timeout.
			cancelCtx, cancel := context.WithTimeout(WithChannel(context.Background(), ChannelAnonymous), 90*time.Millisecond)
			defer cancel()
			_, cancelErr := genericEng.Extract(cancelCtx, "https://vimeo.com/fast/g-cancel")
			var ce *Error
			if !errors.As(cancelErr, &ce) || ce.Code != CodeUpstreamTimeout {
				t.Fatalf("expected contended generic cancel timeout, got %v", cancelErr)
			}

			// 3. Launch a contended owner request that waits for g1, verify live Active==1 & Waiting==1, then release!
			waitDone := make(chan error, 1)
			go func() {
				_, exErr := genericEng.Extract(WithChannel(context.Background(), ChannelOwner), "https://vimeo.com/fast/g-wait")
				waitDone <- exErr
			}()
			waitDeadline := time.Now().Add(3 * time.Second)
			var liveSnap SlotStatsSnapshot
			for {
				liveSnap = genericEng.StatsSnapshot()
				if liveSnap.Active == 1 && liveSnap.Waiting == 1 {
					break
				}
				if time.Now().After(waitDeadline) {
					t.Fatalf("timed out waiting for generic active=1 waiting=1, got %+v", liveSnap)
				}
				time.Sleep(5 * time.Millisecond)
			}
			if liveSnap.ConcurrencyLimit != tc.wantLimit {
				t.Fatalf("live generic ConcurrencyLimit = %d, want %d", liveSnap.ConcurrencyLimit, tc.wantLimit)
			}

			// Also execute a Tier-1 baseEng extraction in parallel to prove baseEng stats stay separate from generic sub-pool metrics.
			if _, baseErr := baseEng.Extract(WithChannel(context.Background(), ChannelAnonymous), "https://x.com/i/status/999"); baseErr != nil {
				t.Fatalf("Tier-1 baseEng Extract failed: %v", baseErr)
			}

			time.Sleep(25 * time.Millisecond)
			if err := os.WriteFile(releaseFile, []byte("go"), 0o600); err != nil {
				t.Fatal(err)
			}
			if exErr := <-firstDone; exErr != nil {
				t.Fatalf("first generic Extract failed: %v", exErr)
			}
			if exErr := <-waitDone; exErr != nil {
				t.Fatalf("contended generic Extract failed: %v", exErr)
			}

			finalGen := genericEng.StatsSnapshot()
			if finalGen.Active != 0 || finalGen.Waiting != 0 || finalGen.ConcurrencyLimit != tc.wantLimit {
				t.Fatalf("final generic gauges mismatch: %+v", finalGen)
			}
			// Total acquired: g1 (owner uncontended) + g-wait (owner contended) = 2;
			// Total waits: g-cancel (anon canceled) + g-wait (owner acquired) = 2;
			// Total canceled: g-cancel (anon) = 1.
			if finalGen.Total.AcquiredCount != 2 || finalGen.Total.WaitCount != 2 || finalGen.Total.CanceledCount != 1 {
				t.Fatalf("final generic totals mismatch: %+v", finalGen.Total)
			}
			if finalGen.ByChannel.Owner.AcquiredCount != 2 || finalGen.ByChannel.Owner.WaitCount != 1 || finalGen.ByChannel.Owner.CanceledCount != 0 || finalGen.ByChannel.Owner.WaitMSTotal < 15 {
				t.Fatalf("final generic owner channel mismatch: %+v", finalGen.ByChannel.Owner)
			}
			if finalGen.ByChannel.Anonymous.AcquiredCount != 0 || finalGen.ByChannel.Anonymous.WaitCount != 1 || finalGen.ByChannel.Anonymous.CanceledCount != 1 || finalGen.ByChannel.Anonymous.WaitMSTotal < 50 {
				t.Fatalf("final generic anonymous channel mismatch: %+v", finalGen.ByChannel.Anonymous)
			}

			finalBase := baseEng.StatsSnapshot()
			if finalBase.ConcurrencyLimit != tc.baseConc || finalBase.Active != 0 || finalBase.Waiting != 0 {
				t.Fatalf("final base gauges mismatch: %+v", finalBase)
			}
			// In both dynamic and fixed-port modes, genericEng has an independent DynamicSlotPool,
			// so baseEng only saw Tier-1 (1 acquire, 0 waits/cancels).
			if finalBase.Total.AcquiredCount != 1 || finalBase.Total.WaitCount != 0 || finalBase.Total.CanceledCount != 0 {
				t.Fatalf("final base totals = %+v, want acquired=1 wait=0 canceled=0", finalBase.Total)
			}
		})
	}
}

func TestExtractExtractorFromStderrAndErrorAttribution(t *testing.T) {
	cases := []struct {
		name   string
		stderr string
		want   string
	}{
		{"vimeo-404", "ERROR: [vimeo] 123456: HTTP Error 404: Not Found", "vimeo"},
		{"tiktok-mixed-case", "ERROR: [TikTok] 7300000000000000001: Unable to extract webpage video data", "TikTok"},
		{"tiktok-sub-extractor", "ERROR: [tiktok:user] @demo: Unable to download webpage", "tiktok:user"},
		{"archive-dot", "ERROR: [archive.org] item123: Unable to download", "archive.org"},
		{"warning-fallback", "WARNING: [SoundCloud] Retrying (1/3)...\nERROR: Unable to download webpage: timed out", "SoundCloud"},
		{"error-beats-warning", "WARNING: [vimeo] Retrying...\nERROR: [dailymotion] x8abc: Video is private", "dailymotion"},
		{"generic-tag-extracted", "ERROR: [generic] https://example.com/a: Unsupported URL", "generic"},
		{"unsupported-url-no-bracket", "ERROR: Unsupported URL: https://example.org/blog/post", ""},
		{"python-errno-ignored", "ERROR: [Errno 111] Connection refused", ""},
		{"python-ssl-ignored", "ERROR: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed", ""},
		{"non-extractor-download-tag", "ERROR: [download] Got error: HTTP Error 403", ""},
		{"non-extractor-skipped-for-later-error", "ERROR: [download] retrying\nERROR: [vimeo] 999: Private video", "vimeo"},
		{"hostile-path-traversal", "ERROR: [../etc/passwd] boom", ""},
		{"overlong-tag", "ERROR: [" + strings.Repeat("a", 65) + "] boom", ""},
		{"empty-stderr", "   \r\n  ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ExtractExtractorFromStderr(tc.stderr); got != tc.want {
				t.Fatalf("ExtractExtractorFromStderr(%q) = %q, want %q", tc.stderr, got, tc.want)
			}
		})
	}

	// Subprocess integration: verify Extract attaches Extractor on classified *Error.
	script := `
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  *vimeo-403*)
    echo "ERROR: [Vimeo] 123: HTTP Error 403: Forbidden" >&2
    exit 1
    ;;
  *soundcloud-warn*)
    echo "WARNING: [SoundCloud] Retrying request..." >&2
    echo "ERROR: Unable to download webpage: timed out" >&2
    exit 1
    ;;
  *unsupported*)
    echo "ERROR: Unsupported URL: $last" >&2
    exit 1
    ;;
esac
`
	binPath, hashes := writeFakeYTDLP(t, script)
	eng, err := New(Config{
		BinaryPath:    binPath,
		AllowedHashes: hashes,
		Timeout:       5 * time.Second,
	})
	if err != nil || !eng.Enabled() {
		t.Fatalf("New failed: %v", err)
	}

	_, err = eng.Extract(context.Background(), "https://vimeo.com/vimeo-403")
	var eErr *Error
	if !errors.As(err, &eErr) || eErr.Code != CodeUpstreamBlocked || eErr.Extractor != "Vimeo" {
		t.Fatalf("vimeo-403 err = %#v, want UPSTREAM_BLOCKED Extractor=Vimeo", eErr)
	}

	_, err = eng.Extract(context.Background(), "https://soundcloud.com/soundcloud-warn")
	eErr = nil
	if !errors.As(err, &eErr) || eErr.Code != CodeUpstreamTimeout || eErr.Extractor != "SoundCloud" {
		t.Fatalf("soundcloud-warn err = %#v, want UPSTREAM_TIMEOUT Extractor=SoundCloud", eErr)
	}

	_, err = eng.Extract(context.Background(), "https://example.org/unsupported")
	eErr = nil
	if !errors.As(err, &eErr) || !eErr.UnsupportedURL || eErr.Extractor != "" {
		t.Fatalf("unsupported err = %#v, want UnsupportedURL=true Extractor=''", eErr)
	}
}

func buildRealPythonZipapp(t *testing.T, mainPy string, helperPy string) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.WriteString("#!/usr/bin/env python3\n")
	zw := zip.NewWriter(&buf)
	for name, body := range map[string]string{
		"__main__.py": mainPy,
		"helper.py":   helperPy,
	} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create zip entry %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("write zip entry %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zipapp archive: %v", err)
	}
	return buf.Bytes()
}

func TestRealPythonZipappZeroExtractionAndSafeEnvPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix python3 zipapp fixture")
	}

	// 1. OfficialSHA256Sums must pin the official zero-extraction "yt-dlp" zipapp asset.
	hasOfficialZipapp := false
	for _, asset := range OfficialSHA256Sums {
		if asset == "yt-dlp" {
			hasOfficialZipapp = true
			break
		}
	}
	if !hasOfficialZipapp {
		t.Fatal("OfficialSHA256Sums is missing pinned zero-extraction \"yt-dlp\" zipapp asset")
	}

	realPython3 := lookupPython3InPath(os.Getenv("PATH"))
	if realPython3 == "" {
		t.Skip("python3 not found in PATH")
	}

	// 2. Prepare poisoned PATH components: relative ".", world-writable dir with fake python3, and non-executable python3.
	worldWritableDir := filepath.Join(t.TempDir(), "world-writable")
	if err := os.Mkdir(worldWritableDir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(worldWritableDir, 0o777); err != nil {
		t.Fatal(err)
	}
	hijackPy := filepath.Join(worldWritableDir, "python3")
	if err := os.WriteFile(hijackPy, []byte("#!/bin/sh\necho hijacked >&2\nexit 99\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	nonExecDir := t.TempDir()
	nonExecPy := filepath.Join(nonExecDir, "python3")
	if err := os.WriteFile(nonExecPy, []byte("#!/bin/sh\nexit 98\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	poisonedPath := strings.Join([]string{
		".",
		"relative/bin",
		worldWritableDir,
		nonExecDir,
		os.Getenv("PATH"),
	}, string(os.PathListSeparator))

	gotPy := lookupPython3InPath(poisonedPath)
	if gotPy == "" || gotPy == hijackPy || gotPy == nonExecPy {
		t.Fatalf("lookupPython3InPath selected unsafe candidate %q (hijack=%q nonExec=%q)", gotPy, hijackPy, nonExecPy)
	}
	sanitized := safeEnvPath(poisonedPath)
	for _, seg := range filepath.SplitList(sanitized) {
		if seg == "." || seg == "relative/bin" || seg == worldWritableDir {
			t.Fatalf("safeEnvPath retained unsafe PATH segment %q in %q", seg, sanitized)
		}
	}
	if fallbackPath := safeEnvPath(""); fallbackPath != defaultSafeEnvPath {
		t.Fatalf("safeEnvPath(\"\") = %q, want %q", fallbackPath, defaultSafeEnvPath)
	}

	// 3. Build a genuine archive/zip Python zipapp (mode 0755 & 0644) and verify isolated execution + zero .pyc writes.
	helperPy := "MARKER = 'zipapp-helper-ok'\n"
	mainPy := fmt.Sprintf(`import json, os, sys
import helper

if '--version' in sys.argv:
    print(%q)
    sys.exit(0)

if os.environ.get('PYTHONDONTWRITEBYTECODE') != '1':
    sys.stderr.write('missing PYTHONDONTWRITEBYTECODE=1\n')
    sys.exit(2)
if os.environ.get('PYTHONNOUSERSITE') != '1':
    sys.stderr.write('missing PYTHONNOUSERSITE=1\n')
    sys.exit(3)

path_entries = os.environ.get('PATH', '').split(os.pathsep)
if '.' in path_entries or %q in path_entries:
    sys.stderr.write('unsafe PATH leaked: ' + os.environ.get('PATH', '') + '\n')
    sys.exit(4)

print(json.dumps({
    'id': 'real-zipapp-1',
    'title': helper.MARKER,
    'formats': [{
        'format_id': '18',
        'url': 'https://rr1---sn-test.googlevideo.com/videoplayback?itag=18',
        'ext': 'mp4',
        'protocol': 'https',
        'width': 1280,
        'height': 720,
        'vcodec': 'avc1.42001E',
        'acodec': 'mp4a.40.2',
    }],
}))
`, PinnedVersion, worldWritableDir)

	zipBytes := buildRealPythonZipapp(t, mainPy, helperPy)
	sum := sha256.Sum256(zipBytes)
	digest := hex.EncodeToString(sum[:])

	for _, mode := range []os.FileMode{0o644, 0o755} {
		zipDir := t.TempDir()
		zipPath := filepath.Join(zipDir, "yt-dlp")
		if err := os.WriteFile(zipPath, zipBytes, mode); err != nil {
			t.Fatal(err)
		}
		eng, err := New(Config{
			BinaryPath:    zipPath,
			AllowedHashes: map[string]string{digest: "yt-dlp"},
			EnvPath:       poisonedPath,
		})
		if err != nil || !eng.Enabled() {
			t.Fatalf("mode %#o: expected real zipapp engine to be enabled, got err=%v", mode, err)
		}
		if !eng.UsingPythonZipapp() {
			t.Fatalf("mode %#o: expected UsingPythonZipapp() == true", mode)
		}
		info, err := eng.Extract(context.Background(), "https://www.youtube.com/watch?v=aqz-KE-bpKQ")
		if err != nil || info == nil || info.ID != "real-zipapp-1" || info.Title != "zipapp-helper-ok" {
			t.Fatalf("mode %#o: real zipapp extraction failed: info=%+v err=%v", mode, info, err)
		}
		entries, err := os.ReadDir(zipDir)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".pyc") || entry.Name() == "__pycache__" {
				t.Fatalf("mode %#o: unexpected bytecode artifact written in zipapp dir: %s", mode, entry.Name())
			}
		}
	}

	// 4. Executable #!/usr/bin/env python3 script (non-zipapp) executes directly under buildIsolatedEnv with sanitized PATH.
	scriptDir := t.TempDir()
	scriptPath := filepath.Join(scriptDir, "yt-dlp")
	scriptBody := fmt.Sprintf(`#!/usr/bin/env python3
import json, os, sys
if %q in os.environ.get('PATH', '').split(os.pathsep):
    sys.exit(5)
print(json.dumps({
    'id': 'env-python3-script',
    'title': 'Env Python3 Script',
    'formats': [{
        'format_id': '18',
        'url': 'https://rr1---sn-test.googlevideo.com/videoplayback?itag=18',
        'ext': 'mp4',
        'protocol': 'https',
        'width': 1280,
        'height': 720,
        'vcodec': 'avc1.42001E',
        'acodec': 'mp4a.40.2',
    }],
}))
`, worldWritableDir)
	if err := os.WriteFile(scriptPath, []byte(scriptBody), 0o755); err != nil {
		t.Fatal(err)
	}
	scriptSum := sha256.Sum256([]byte(scriptBody))
	scriptDigest := hex.EncodeToString(scriptSum[:])
	scriptEng, err := New(Config{
		BinaryPath:    scriptPath,
		AllowedHashes: map[string]string{scriptDigest: "yt-dlp"},
		EnvPath:       poisonedPath,
	})
	if err != nil || !scriptEng.Enabled() {
		t.Fatalf("expected #!/usr/bin/env python3 script engine to be enabled, got err=%v", err)
	}
	if scriptEng.UsingPythonZipapp() {
		t.Fatal("expected UsingPythonZipapp() == false for executable plain python3 script without zip payload")
	}
	scriptInfo, err := scriptEng.Extract(context.Background(), "https://www.youtube.com/watch?v=aqz-KE-bpKQ")
	if err != nil || scriptInfo == nil || scriptInfo.ID != "env-python3-script" {
		t.Fatalf("expected #!/usr/bin/env python3 direct execution to succeed, got info=%+v err=%v", scriptInfo, err)
	}
}
