// Adapted from wader/goutubedl and lrstanley/go-ytdlp (MIT License).
package ytengine

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func writeFakeYTDLP(t *testing.T, scriptBody string) (string, map[string]string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell script fixture requires unix")
	}
	dir := t.TempDir()
	binPath := filepath.Join(dir, "yt-dlp-fake")
	content := "#!/bin/sh\nset -eu\n" + scriptBody + "\n"
	if err := os.WriteFile(binPath, []byte(content), 0o755); err != nil {
		t.Fatalf("write fake binary: %v", err)
	}
	sum := sha256.Sum256([]byte(content))
	digest := hex.EncodeToString(sum[:])
	return binPath, map[string]string{digest: "yt-dlp-fake"}
}

func TestOfficialSHA256VerificationAndMismatchDegradation(t *testing.T) {
	if len(OfficialSHA256Sums) != 6 {
		t.Fatalf("expected 6 official SHA-256 entries for %s, got %d", PinnedVersion, len(OfficialSHA256Sums))
	}

	// Missing binary -> returns disabled engine and error without panicking.
	eng, err := New(Config{
		BinaryPath: filepath.Join(t.TempDir(), "nonexistent-yt-dlp"),
	})
	if err == nil || eng == nil || eng.Enabled() {
		t.Fatalf("expected disabled engine on missing binary, got enabled=%v err=%v", eng != nil && eng.Enabled(), err)
	}
	_, extractErr := eng.Extract(context.Background(), "https://x.com/i/status/123456")
	var eErr *Error
	if extractErr == nil || !strings.Contains(extractErr.Error(), string(CodeServiceNotConfigured)) {
		t.Fatalf("expected SERVICE_NOT_CONFIGURED from disabled engine, got %v (%v)", extractErr, eErr)
	}

	// Tampered binary whose SHA-256 does not match OfficialSHA256Sums -> rejected.
	binPath, _ := writeFakeYTDLP(t, `echo '{"id":"1"}'`)
	tamperedEng, err := New(Config{
		BinaryPath:    binPath,
		AllowedHashes: OfficialSHA256Sums,
	})
	if err == nil || !strings.Contains(err.Error(), "does not match pinned release "+PinnedVersion) {
		t.Fatalf("expected SHA-256 mismatch error, got %v", err)
	}
	if tamperedEng == nil || tamperedEng.Enabled() {
		t.Fatalf("expected tampered engine to remain disabled")
	}
}

func TestHardenedExecutionIsolatedEnvAndExactFilesize(t *testing.T) {
	script := `
# Verify secret env vars are never inherited by the subprocess
if [ -n "${SNAP_MEDIA_SIGNING_KEY:-}" ] || [ -n "${SNAP_INGRESS_KEY:-}" ]; then
  echo "secret environment leaked" >&2
  exit 2
fi
# Verify isolated HOME exists and is writable
test -d "$HOME"
test -d "$XDG_CACHE_HOME"
echo "$HOME" > "$HOME/home_check.txt"
cat <<'JSON'
{
  "id": "1790637589910654976",
  "display_id": "1790637656616943991",
  "_type": "video",
  "title": "Test Video",
  "formats": [
    {
      "format_id": "http-2176",
      "url": "https://video.twimg.com/amplify_video/1790637589910654976/vid/avc1/728x720/test.mp4?tag=14",
      "ext": "mp4",
      "protocol": "https",
      "width": 728,
      "height": 720,
      "tbr": 2176.0,
      "filesize": null,
      "filesize_approx": 4212736,
      "http_headers": {
        "Cookie": "secret=1"
      }
    }
  ]
}
JSON
`
	binPath, hashes := writeFakeYTDLP(t, script)
	t.Setenv("SNAP_MEDIA_SIGNING_KEY", "super-secret-signing-key-32-bytes-minimum")
	t.Setenv("SNAP_INGRESS_KEY", "super-secret-ingress-key-32-bytes-minimum")

	eng, err := New(Config{
		BinaryPath:    binPath,
		AllowedHashes: hashes,
		AllowedURL: func(u string) bool {
			return u == "https://x.com/i/status/1790637656616943991"
		},
	})
	if err != nil || !eng.Enabled() {
		t.Fatalf("expected enabled engine, got err=%v", err)
	}

	args := eng.CommandArgs("https://x.com/i/status/1790637656616943991")
	wantFlags := []string{
		"--ignore-config",
		"--no-plugin-dirs",
		"--no-playlist",
		"--no-warnings",
		"--no-progress",
		"--no-cache-dir",
		"--no-cookies-from-browser",
		"-J",
		"--",
	}
	joined := strings.Join(args, " ")
	for _, flag := range wantFlags {
		if !strings.Contains(joined, flag) {
			t.Fatalf("missing hardened CLI flag %q in %v", flag, args)
		}
	}

	info, err := eng.Extract(context.Background(), "https://x.com/i/status/1790637656616943991")
	if err != nil {
		t.Fatalf("Extract failed: %v", err)
	}
	if info.ID != "1790637589910654976" || len(info.Formats) != 1 {
		t.Fatalf("unexpected info: %+v", info)
	}
	f := info.Formats[0]
	if f.Filesize != nil {
		t.Fatalf("expected exact Filesize to remain nil when only filesize_approx is present, got %v", *f.Filesize)
	}
	if f.FilesizeApprox == nil || *f.FilesizeApprox != 4212736 {
		t.Fatalf("expected FilesizeApprox=4212736, got %v", f.FilesizeApprox)
	}

	// Reject disallowed URL or option-injection attempt
	for _, bad := range []string{
		"--exec=id",
		"-o/tmp/pwn",
		"file:///etc/passwd",
		"https://user:pass@x.com/i/status/1790637656616943991",
		"https://x.com/other/status/1790637656616943991",
	} {
		if _, err := eng.Extract(context.Background(), bad); err == nil {
			t.Fatalf("expected URL %q to be rejected", bad)
		}
	}
}

func TestSubprocessCancellationAndStderrClassification(t *testing.T) {
	sleepScript := `
sleep 10
`
	binPath, hashes := writeFakeYTDLP(t, sleepScript)
	eng, err := New(Config{
		BinaryPath:    binPath,
		AllowedHashes: hashes,
		Timeout:       2 * time.Second,
	})
	if err != nil {
		t.Fatalf("New engine failed: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err = eng.Extract(ctx, "https://x.com/i/status/1790637656616943991")
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected timeout error on slow subprocess")
	}
	if elapsed > 2*time.Second {
		t.Fatalf("process cancellation took too long: %s", elapsed)
	}

	// Verify stderr classification
	cases := []struct {
		stderr        string
		wantCode      ErrorCode
		wantRetryable bool
		wantMessage   string
	}{
		{"ERROR: [twitter] 123: HTTP Error 429: Too Many Requests", CodeRateLimited, true, ""},
		{"ERROR: [twitter] 123: No video could be found in this tweet", CodeContentUnavailable, false, "未找到可用的媒体，或该内容已不可访问"},
		{"ERROR: [twitter] 123: Protected tweet; please sign in", CodeUpstreamBlocked, false, ""},
		{"ERROR: [generic] gen-ai-pose-image: Unable to download webpage: <urlopen error Tunnel connection failed: 403 Forbidden>", CodeUpstreamBlocked, false, ""},
		{"ERROR: Unsupported URL: https://github.com/wzc520pyfm/gen-ai-pose-image", CodeContentUnavailable, false, "未找到可用的媒体，或该内容已不可访问"},
		{"ERROR: No suitable extractor found for URL https://github.com/wzc520pyfm/gen-ai-pose-image/issues/429?timeout=1", CodeContentUnavailable, false, "未找到可用的媒体，或该内容已不可访问"},
		{"ERROR: [facebook] 637842556329505: This video is only available for registered users. Use --cookies-from-browser or --cookies for the authentication.", CodeUpstreamBlocked, false, ""},
		{"ERROR: [facebook] 123456: The video is not available, Facebook said: \"You must log in to continue.\"", CodeUpstreamBlocked, false, ""},
		{"ERROR: [facebook] 123456: Cannot parse data; please report this issue on https://github.com/yt-dlp/yt-dlp/issues", CodeUpstreamBlocked, false, ""},
	}
	for _, tc := range cases {
		classified := classifyStderr(tc.stderr, errors.New("exit status 1"))
		if classified.Code != tc.wantCode || classified.Retryable != tc.wantRetryable {
			t.Fatalf("classifyStderr(%q) = (code=%s, retryable=%v), want (code=%s, retryable=%v)",
				tc.stderr, classified.Code, classified.Retryable, tc.wantCode, tc.wantRetryable)
		}
		if tc.wantMessage != "" && classified.Message != tc.wantMessage {
			t.Fatalf("classifyStderr(%q).Message = %q, want %q", tc.stderr, classified.Message, tc.wantMessage)
		}
		if strings.Contains(classified.Message, "推文") {
			t.Fatalf("classifyStderr(%q).Message must be platform-neutral, got %q", tc.stderr, classified.Message)
		}
		errBin, errHashes := writeFakeYTDLP(t, "echo '"+tc.stderr+"' >&2\nexit 1")
		errEng, err := New(Config{BinaryPath: errBin, AllowedHashes: errHashes})
		if err != nil {
			t.Fatal(err)
		}
		_, extractErr := errEng.Extract(context.Background(), "https://x.com/i/status/123")
		var eErr *Error
		if !errors.As(extractErr, &eErr) || eErr.Code != tc.wantCode || eErr.Retryable != tc.wantRetryable {
			t.Fatalf("stderr %q => %#v (%v), want code=%s retryable=%v", tc.stderr, eErr, extractErr, tc.wantCode, tc.wantRetryable)
		}
	}

	// Missing binary / generic "not found" errors must stay retryable UPSTREAM_UNAVAILABLE rather than CONTENT_UNAVAILABLE.
	for _, nfTC := range []struct {
		stderr        string
		wantCode      ErrorCode
		wantRetryable bool
	}{
		{"yt-dlp: not found", CodeUpstreamUnavailable, true},
		{"sh: 1: yt-dlp: not found", CodeUpstreamUnavailable, true},
		{"ERROR: [youtube] x9zzzzzz999: Not found.", CodeUpstreamUnavailable, true},
		{"ERROR: [generic] x9zzzzzz999: ffmpeg not found.", CodeUpstreamUnavailable, true},
	} {
		got := classifyStderr(nfTC.stderr, errors.New("exit status 1"))
		if got.Code != nfTC.wantCode || got.Retryable != nfTC.wantRetryable {
			t.Fatalf("classifyStderr(%q) = (code=%s, retryable=%v), want (code=%s, retryable=%v)",
				nfTC.stderr, got.Code, got.Retryable, nfTC.wantCode, nfTC.wantRetryable)
		}
	}
}

func TestPathDiscoveryAndSHA256Verification(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script fixture requires unix")
	}
	dir := t.TempDir()
	pathBin := filepath.Join(dir, "yt-dlp")
	content := []byte("#!/bin/sh\necho '{\"id\":\"1\"}'\n")
	if err := os.WriteFile(pathBin, content, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])

	// 1. Valid SHA-256 discovered via EnvPath when BinaryPath is empty
	eng, err := New(Config{
		BinaryPath:    "",
		EnvPath:       dir,
		AllowedHashes: map[string]string{digest: "yt-dlp"},
	})
	if err != nil || !eng.Enabled() || eng.BinarySHA256() != digest {
		t.Fatalf("expected PATH discovery to succeed with matching SHA-256, got enabled=%v err=%v", eng != nil && eng.Enabled(), err)
	}

	// 2. Missing binary in PATH when BinaryPath is empty
	emptyDir := t.TempDir()
	missEng, err := New(Config{
		BinaryPath:    "",
		EnvPath:       emptyDir,
		AllowedHashes: map[string]string{digest: "yt-dlp"},
	})
	if err == nil || missEng.Enabled() || !strings.Contains(err.Error(), "not found in DOKITOOL_YTDLP_BINARY or PATH") {
		t.Fatalf("expected PATH miss error, got enabled=%v err=%v", missEng != nil && missEng.Enabled(), err)
	}

	// 3. Wrong SHA-256 discovered via PATH
	badEng, err := New(Config{
		BinaryPath:    "",
		EnvPath:       dir,
		AllowedHashes: OfficialSHA256Sums,
	})
	if err == nil || badEng.Enabled() || !strings.Contains(err.Error(), "does not match pinned release") {
		t.Fatalf("expected PATH wrong-hash rejection, got enabled=%v err=%v", badEng != nil && badEng.Enabled(), err)
	}
}

func TestCrossPlatformSharedConcurrencyLimitAndRelease(t *testing.T) {
	coordDir := t.TempDir()
	countFile := filepath.Join(coordDir, "invocations.log")
	releaseFile := filepath.Join(coordDir, "release.flag")

	script := fmt.Sprintf(`
echo "1" >> %q
idx=$(wc -l < %q | tr -d ' ')
touch "%s/started_${idx}"
while [ ! -f %q ]; do
  sleep 0.02
done
echo '{"id":"ok","formats":[{"format_id":"18","url":"https://video.twimg.com/ext_tw_video/1/pu/vid/640x360/a.mp4","ext":"mp4","protocol":"https","width":640,"height":360}]}'
`, countFile, countFile, coordDir, releaseFile)

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

	pubResolver := stubResolver{ips: map[string][]netip.Addr{
		"x.com":             {netip.MustParseAddr("104.244.42.1")},
		"www.youtube.com":   {netip.MustParseAddr("142.250.190.78")},
		"www.instagram.com": {netip.MustParseAddr("157.240.22.174")},
	}}
	baseEng.resolver = pubResolver

	xEng := baseEng.WithTargetPolicy(
		func(u string) bool { return strings.HasPrefix(u, "https://x.com/") },
		func(h string) bool { return h == "x.com" },
	)
	ytEng := baseEng.WithTargetPolicy(
		func(u string) bool { return strings.HasPrefix(u, "https://www.youtube.com/") },
		func(h string) bool { return h == "www.youtube.com" },
	)
	igEng := baseEng.WithTargetPolicy(
		func(u string) bool { return strings.HasPrefix(u, "https://www.instagram.com/") },
		func(h string) bool { return h == "www.instagram.com" },
	)
	xEng.resolver = pubResolver
	ytEng.resolver = pubResolver
	igEng.resolver = pubResolver

	if xEng.ConcurrencyLimit() != 2 || xEng.slotPool != ytEng.slotPool || ytEng.slotPool != igEng.slotPool {
		t.Fatalf("expected all 3 platform engines to share a single capacity-2 slot pool")
	}

	var wg sync.WaitGroup
	errs := make([]error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, errs[0] = xEng.Extract(context.Background(), "https://x.com/i/status/1")
	}()
	go func() {
		defer wg.Done()
		_, errs[1] = ytEng.Extract(context.Background(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
	}()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_, err1 := os.Stat(filepath.Join(coordDir, "started_1"))
		_, err2 := os.Stat(filepath.Join(coordDir, "started_2"))
		if err1 == nil && err2 == nil && baseEng.slotPool.Active() == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if baseEng.slotPool.Active() != 2 {
		t.Fatalf("expected both slot pool slots to be occupied, got %d", baseEng.slotPool.Active())
	}

	// 3a. A 3rd concurrent request with a short deadline waits on the full 2-slot
	// pool without spawning a 3rd yt-dlp subprocess, then exits on ctx.Done().
	waitCtx, cancelWait := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancelWait()
	startWait := time.Now()
	_, waitErr := igEng.Extract(waitCtx, "https://www.instagram.com/reel/C123456/")
	waitElapsed := time.Since(startWait)
	if waitElapsed < 60*time.Millisecond || waitElapsed > time.Second {
		t.Fatalf("expected slot pool wait to respect 80ms ctx deadline, took %s", waitElapsed)
	}
	var engineErr *Error
	if !errors.As(waitErr, &engineErr) || engineErr.Code != CodeUpstreamTimeout || !engineErr.Retryable {
		t.Fatalf("expected UPSTREAM_TIMEOUT after slot pool wait deadline, got %#v (%v)", engineErr, waitErr)
	}

	// 3b. A queued 3rd concurrent request with a live context waits on e.slotPool without
	// spawning a 3rd subprocess until one of the 2 active extractions finishes.
	queuedDone := make(chan error, 1)
	go func() {
		_, err := igEng.Extract(context.Background(), "https://www.instagram.com/reel/C123456/")
		queuedDone <- err
	}()
	time.Sleep(50 * time.Millisecond)

	countBytes, err := os.ReadFile(countFile)
	if err != nil {
		t.Fatalf("read invocation log: %v", err)
	}
	if lines := strings.Split(strings.TrimSpace(string(countBytes)), "\n"); len(lines) != 2 {
		t.Fatalf("expected exactly 2 spawned subprocesses while full, got %d (%q)", len(lines), string(countBytes))
	}

	// Release the 2 running subprocesses; the queued 3rd request must acquire a freed slot and succeed.
	if err := os.WriteFile(releaseFile, []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	for i, e := range errs {
		if e != nil {
			t.Fatalf("in-flight call %d failed: %v", i, e)
		}
	}
	if queuedErr := <-queuedDone; queuedErr != nil {
		t.Fatalf("queued 3rd call failed after slot release: %v", queuedErr)
	}
	if baseEng.slotPool.Active() != 0 {
		t.Fatalf("expected slot pool to be empty after completion, got %d", baseEng.slotPool.Active())
	}
	countBytes, err = os.ReadFile(countFile)
	if err != nil {
		t.Fatalf("read invocation log after release: %v", err)
	}
	if lines := strings.Split(strings.TrimSpace(string(countBytes)), "\n"); len(lines) != 3 {
		t.Fatalf("expected 3 total spawned subprocesses after queued request ran, got %d", len(lines))
	}

	// Subsequent request after slots release must succeed cleanly.
	if _, err := igEng.Extract(context.Background(), "https://www.instagram.com/reel/C123456/"); err != nil {
		t.Fatalf("expected subsequent request after slot release to succeed, got %v", err)
	}
	if baseEng.slotPool.Active() != 0 {
		t.Fatalf("expected slot pool to be empty after subsequent call, got %d", baseEng.slotPool.Active())
	}

	// Verify relaxed concurrency bounds (1..MaxConcurrency=24) for 6C / 13G host.
	for _, validN := range []int{1, 6, 16, MaxConcurrency} {
		okEng, okErr := New(Config{
			BinaryPath:     binPath,
			AllowedHashes:  hashes,
			MaxConcurrency: validN,
		})
		if okErr != nil || !okEng.Enabled() || okEng.ConcurrencyLimit() != validN {
			t.Fatalf("expected MaxConcurrency=%d to succeed, got enabled=%v limit=%d err=%v", validN, okEng != nil && okEng.Enabled(), okEng.ConcurrencyLimit(), okErr)
		}
	}
	if badEng, badErr := New(Config{
		BinaryPath:     binPath,
		AllowedHashes:  hashes,
		MaxConcurrency: MaxConcurrency + 1,
	}); badErr == nil || badEng.Enabled() {
		t.Fatalf("expected MaxConcurrency=%d to fail bounds check", MaxConcurrency+1)
	}
	for _, badRaw := range []string{"0", "-1", "25", "secret-invalid"} {
		badEng, badErr := NewFromEnv(func(k string) string {
			if k == "DOKITOOL_YTDLP_CONCURRENCY" {
				return badRaw
			}
			return ""
		}, nil)
		if badErr == nil || badEng.Enabled() || strings.Contains(badErr.Error(), "secret-invalid") {
			t.Fatalf("expected invalid DOKITOOL_YTDLP_CONCURRENCY=%q to fail safely, got %v", badRaw, badErr)
		}
	}
}

func TestExtractSlotLifecycleAcrossSuccessFailureTimeoutAndCancel(t *testing.T) {
	coordDir := t.TempDir()
	countFile := filepath.Join(coordDir, "invocations.log")
	startedCancelFile := filepath.Join(coordDir, "started_cancel")

	script := fmt.Sprintf(`
echo "1" >> %q
target=""
for arg in "$@"; do
  target="$arg"
done
case "$target" in
  *fail*)
    echo "ERROR: Video unavailable" >&2
    exit 1
    ;;
  *timeout*)
    sleep 5
    ;;
  *cancel*)
    touch %q
    sleep 5
    ;;
  *)
    echo '{"id":"ok","formats":[{"format_id":"18","url":"https://video.twimg.com/ext_tw_video/1/pu/vid/640x360/a.mp4","ext":"mp4","protocol":"https","width":640,"height":360}]}'
    ;;
esac
`, countFile, startedCancelFile)

	binPath, hashes := writeFakeYTDLP(t, script)
	eng, err := New(Config{
		BinaryPath:     binPath,
		AllowedHashes:  hashes,
		MaxConcurrency: 1,
		Timeout:        minExtractTimeout,
		AllowedURL:     func(u string) bool { return strings.HasPrefix(u, "https://x.com/") },
		AllowedOutboundHost: func(h string) bool {
			return h == "x.com"
		},
		Resolver: stubResolver{ips: map[string][]netip.Addr{
			"x.com": {netip.MustParseAddr("104.244.42.1")},
		}},
	})
	if err != nil || !eng.Enabled() {
		t.Fatalf("New eng failed: %v", err)
	}

	// 1. Pre-canceled context does not start execution or acquire/leak slot.
	preCanceledCtx, preCancel := context.WithCancel(context.Background())
	preCancel()
	if _, err := eng.Extract(preCanceledCtx, "https://x.com/i/status/1"); err == nil {
		t.Fatal("expected pre-canceled Extract to fail")
	}
	if _, statErr := os.Stat(countFile); !os.IsNotExist(statErr) {
		t.Fatalf("expected pre-canceled Extract not to spawn subprocess, statErr=%v", statErr)
	}
	if eng.slotPool.Active() != 0 {
		t.Fatalf("expected 0 occupied slots after pre-canceled call, got %d", eng.slotPool.Active())
	}

	// 2. Success releases slot once.
	if _, err := eng.Extract(context.Background(), "https://x.com/i/status/1"); err != nil {
		t.Fatalf("expected success path to pass, got %v", err)
	}
	if eng.slotPool.Active() != 0 {
		t.Fatalf("expected 0 occupied slots after success, got %d", eng.slotPool.Active())
	}

	// 3. Subprocess failure releases slot once.
	if _, err := eng.Extract(context.Background(), "https://x.com/i/status/fail"); err == nil {
		t.Fatal("expected failure path to return error")
	}
	if eng.slotPool.Active() != 0 {
		t.Fatalf("expected 0 occupied slots after failure, got %d", eng.slotPool.Active())
	}

	// 4. In-flight context cancellation releases slot once.
	cancelCtx, cancel := context.WithCancel(context.Background())
	go func() {
		for i := 0; i < 100; i++ {
			if _, err := os.Stat(startedCancelFile); err == nil {
				cancel()
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		cancel()
	}()
	if _, err := eng.Extract(cancelCtx, "https://x.com/i/status/cancel"); err == nil {
		t.Fatal("expected canceled in-flight path to return error")
	}
	if eng.slotPool.Active() != 0 {
		t.Fatalf("expected 0 occupied slots after in-flight cancel, got %d", eng.slotPool.Active())
	}

	// 5. Timeout releases slot once.
	if _, err := eng.Extract(context.Background(), "https://x.com/i/status/timeout"); err == nil {
		t.Fatal("expected timeout path to return error")
	}
	if eng.slotPool.Active() != 0 {
		t.Fatalf("expected 0 occupied slots after timeout, got %d", eng.slotPool.Active())
	}

	// 6. Subsequent normal request still acquires the single slot and succeeds.
	if _, err := eng.Extract(context.Background(), "https://x.com/i/status/2"); err != nil {
		t.Fatalf("expected subsequent request after all 4 paths to succeed, got %v", err)
	}
	if eng.slotPool.Active() != 0 {
		t.Fatalf("expected 0 occupied slots at end, got %d", eng.slotPool.Active())
	}
}

type stubResolver struct {
	ips map[string][]netip.Addr
}

func (s stubResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	h := strings.ToLower(strings.TrimSuffix(host, "."))
	if addrs, ok := s.ips[h]; ok {
		return addrs, nil
	}
	return nil, errors.New("host not found: " + h)
}

func TestOutboundSecurityGateAndDNSProtection(t *testing.T) {
	binPath, hashes := writeFakeYTDLP(t, `echo '{"id":"should-not-run"}'`)
	resolver := stubResolver{
		ips: map[string][]netip.Addr{
			"loopback.x.com":  {netip.MustParseAddr("127.0.0.1")},
			"private.x.com":   {netip.MustParseAddr("10.0.0.1")},
			"metadata.x.com":  {netip.MustParseAddr("169.254.169.254")},
			"ipv6loop.x.com":  {netip.MustParseAddr("::1")},
			"public.x.com":    {netip.MustParseAddr("104.244.42.1")},
			"evil.example.io": {netip.MustParseAddr("93.184.216.34")},
		},
	}

	eng, err := New(Config{
		BinaryPath:    binPath,
		AllowedHashes: hashes,
		AllowedURL:    func(string) bool { return true },
		AllowedOutboundHost: func(host string) bool {
			return host == "public.x.com" || strings.HasSuffix(host, ".x.com")
		},
		Resolver: resolver,
	})
	if err != nil {
		t.Fatalf("New engine failed: %v", err)
	}

	// 1. Pre-spawn DNS check blocks private/loopback/metadata/IPv6-loopback resolution
	for _, blockedURL := range []string{
		"https://loopback.x.com/i/status/1",
		"https://private.x.com/i/status/1",
		"https://metadata.x.com/i/status/1",
		"https://ipv6loop.x.com/i/status/1",
	} {
		_, err := eng.Extract(context.Background(), blockedURL)
		var eErr *Error
		if !errors.As(err, &eErr) || eErr.Code != CodeUpstreamBlocked {
			t.Fatalf("expected CodeUpstreamBlocked for %s, got %v", blockedURL, err)
		}
	}

	// 2. Test in-process outbound proxy gate directly for host allowlist, port restriction, and 302 redirect to private IP
	redirectTarget := "http://169.254.169.254/latest/meta-data/"
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect-private" {
			http.Redirect(w, r, redirectTarget, http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstreamSrv.Close()

	srvURL, _ := url.Parse(upstreamSrv.URL)
	eng = eng.withGateTestHooks(gateTestHooks{
		dialAddr: func(_ netip.Addr, _ string) string {
			return srvURL.Host
		},
	})

	gateURL, closeGate, err := eng.startOutboundGate(context.Background())
	if err != nil {
		t.Fatalf("startOutboundGate failed: %v", err)
	}
	defer closeGate()

	parsedGate, _ := url.Parse(gateURL)
	gateClient := &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyURL(parsedGate),
		},
		Timeout: 3 * time.Second,
	}

	// 2a. Allowed public host succeeds through gate
	resp, err := gateClient.Get("http://public.x.com/ok")
	if err != nil {
		t.Fatalf("expected allowed public host to succeed via gate, got %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK for public.x.com, got %d", resp.StatusCode)
	}

	// 2b. Disallowed host is blocked by gate with 403
	resp, err = gateClient.Get("http://evil.example.io/ok")
	if err != nil {
		t.Fatalf("gate request failed: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for non-allowlisted host, got %d", resp.StatusCode)
	}

	// 2c. Allowlisted host resolving to private IP is blocked by gate with 403
	resp, err = gateClient.Get("http://private.x.com/ok")
	if err != nil {
		t.Fatalf("gate request failed: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for private IP resolution, got %d", resp.StatusCode)
	}

	// 2d. 302 redirect from public host to private/metadata IP is blocked by gate with 403
	resp, err = gateClient.Get("http://public.x.com/redirect-private")
	if err != nil {
		t.Fatalf("gate redirect request failed: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden on redirect to 169.254.169.254, got %d", resp.StatusCode)
	}

	// 3. Verify validateProxyURL rejects private/metadata IP literals
	for _, badProxy := range []string{
		"http://10.0.0.1:8080",
		"http://169.254.169.254:80",
		"socks5://192.168.1.1:1080",
	} {
		if err := validateProxyURL(badProxy); err == nil {
			t.Fatalf("expected validateProxyURL(%q) to reject private/link-local IP literal", badProxy)
		}
	}
	if err := validateProxyURL("http://127.0.0.1:7897"); err != nil {
		t.Fatalf("expected loopback proxy URL to be allowed, got %v", err)
	}
}

type fakeProbeExecutor struct {
	fn func(context.Context, fetch.Request) (fetch.Response, error)
}

func (f fakeProbeExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	return f.fn(ctx, req)
}

func TestSizeProberRejectsErrorPagesAndInvalidContentRange(t *testing.T) {
	allowed := func(raw string) bool {
		return strings.HasPrefix(raw, "https://rr1---sn-test.googlevideo.com/")
	}
	mediaURL := "https://rr1---sn-test.googlevideo.com/videoplayback?itag=18"

	cases := []struct {
		name     string
		status   int
		headers  http.Header
		body     []byte
		wantSize int64
		wantOK   bool
	}{
		{
			name:   "200-text-html-error-page-rejected",
			status: http.StatusOK,
			headers: http.Header{
				"Content-Type":   {"text/html; charset=utf-8"},
				"Content-Length": {"7"},
			},
			body:     []byte("<html/>"),
			wantSize: 0,
			wantOK:   false,
		},
		{
			name:   "200-application-json-rejected",
			status: http.StatusOK,
			headers: http.Header{
				"Content-Type":   {"application/json"},
				"Content-Length": {"15"},
			},
			body:     []byte(`{"error":"bad"}`),
			wantSize: 0,
			wantOK:   false,
		},
		{
			name:   "206-invalid-content-range-prefix-rejected",
			status: http.StatusPartialContent,
			headers: http.Header{
				"Content-Type":  {"video/mp4"},
				"Content-Range": {"not-a-range/12345"},
			},
			body:     []byte{0x00},
			wantSize: 0,
			wantOK:   false,
		},
		{
			name:   "206-unsatisfied-wildcard-range-rejected",
			status: http.StatusPartialContent,
			headers: http.Header{
				"Content-Type":  {"video/mp4"},
				"Content-Range": {"bytes */12345"},
			},
			body:     []byte{0x00},
			wantSize: 0,
			wantOK:   false,
		},
		{
			name:   "206-wrong-start-offset-rejected",
			status: http.StatusPartialContent,
			headers: http.Header{
				"Content-Type":  {"video/mp4"},
				"Content-Range": {"bytes 1-1/12345"},
			},
			body:     []byte{0x00},
			wantSize: 0,
			wantOK:   false,
		},
		{
			name:   "206-duplicate-content-range-rejected",
			status: http.StatusPartialContent,
			headers: http.Header{
				"Content-Type":  {"video/mp4"},
				"Content-Range": {"bytes 0-0/12345", "bytes 0-0/99999"},
			},
			body:     []byte{0x00},
			wantSize: 0,
			wantOK:   false,
		},
		{
			name:   "206-gzip-content-encoding-rejected",
			status: http.StatusPartialContent,
			headers: http.Header{
				"Content-Type":     {"video/mp4"},
				"Content-Encoding": {"gzip"},
				"Content-Range":    {"bytes 0-0/12345"},
			},
			body:     []byte{0x00},
			wantSize: 0,
			wantOK:   false,
		},
		{
			name:   "206-valid-mp4-range-accepted",
			status: http.StatusPartialContent,
			headers: http.Header{
				"Content-Type":  {"video/mp4"},
				"Content-Range": {"bytes 0-0/28523658"},
			},
			body:     []byte{0x00},
			wantSize: 28523658,
			wantOK:   true,
		},
		{
			name:   "200-full-small-mp4-with-ftyp-magic-accepted",
			status: http.StatusOK,
			headers: http.Header{
				"Content-Type":   {"video/mp4"},
				"Content-Length": {"16"},
			},
			body:     []byte("\x00\x00\x00\x10ftypisom\x00\x00\x02\x00"),
			wantSize: 16,
			wantOK:   true,
		},
		{
			name:   "200-truncated-or-non-media-body-rejected",
			status: http.StatusOK,
			headers: http.Header{
				"Content-Type":   {"video/mp4"},
				"Content-Length": {"12345"},
			},
			body:     []byte("\x00\x00\x00\x10ftypisom"),
			wantSize: 0,
			wantOK:   false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			prober := NewSizeProber(fakeProbeExecutor{
				fn: func(_ context.Context, req fetch.Request) (fetch.Response, error) {
					if req.Header.Get("Range") != "bytes=0-0" || req.Header.Get("Accept-Encoding") != "identity" || req.Policy.FollowRedirects {
						t.Fatalf("unexpected probe request policy/headers: %+v", req)
					}
					return fetch.Response{
						StatusCode: tc.status,
						Header:     tc.headers,
						Body:       tc.body,
						URL:        req.URL,
					}, nil
				},
			}, allowed)
			gotSize, gotOK := prober(context.Background(), mediaURL)
			if gotOK != tc.wantOK || gotSize != tc.wantSize {
				t.Fatalf("prober() = (%d, %v), want (%d, %v)", gotSize, gotOK, tc.wantSize, tc.wantOK)
			}
		})
	}
}

func TestPR36ReviewCounterexamples(t *testing.T) {
	const now int64 = 1762300800

	// 1. Same representation renewal keeps stable source_id on googlevideo.com
	w, h, sz := int64(640), int64(360), int64(28523658)
	opts := AdaptOptions{
		PlatformID: "youtube",
		ContentID:  "aqz-KE-bpKQ",
		SourceURL:  "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
		MaxEntries: 1,
	}
	info1 := &Info{
		ID:    "aqz-KE-bpKQ",
		Title: "Big Buck Bunny",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&ei=E1&ip=1.1.1.1&id=o-1&itag=18&source=youtube&clen=28523658&dur=634.566&lmt=1700000000000000&sig=SIG_A",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w,
				Height:   &h,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: &sz,
			},
		},
	}
	info2 := &Info{
		ID:    "aqz-KE-bpKQ",
		Title: "Big Buck Bunny",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      "https://rr4---sn-ogueln67.googlevideo.com/videoplayback?expire=1762360000&ei=E2&ip=2.2.2.2&id=o-1&itag=18&source=youtube&clen=28523658&dur=634.566&lmt=1700000000000000&sig=SIG_B",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w,
				Height:   &h,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: &sz,
			},
		},
	}
	env1 := AdaptInfo(info1, opts, now)
	env2 := AdaptInfo(info2, opts, now+60)
	def1 := unified.Map(unified.Map(unified.Slice(unified.Map(env1["data"])["items"])[0])["default"])
	def2 := unified.Map(unified.Map(unified.Slice(unified.Map(env2["data"])["items"])[0])["default"])
	if unified.Str(def1["source_id"]) != unified.Str(def2["source_id"]) {
		t.Fatalf("R3 counterexample failed: source_id drifted from %v to %v", def1["source_id"], def2["source_id"])
	}

	// 2 & 3. HTML 200 and invalid 206 Content-Range rejected by ValidateProbedMediaResponse
	if sz, ok := ValidateProbedMediaResponse(http.StatusOK, http.Header{
		"Content-Type":   {"text/html"},
		"Content-Length": {"7"},
	}, []byte("<html/>")); ok || sz != 0 {
		t.Fatalf("R4 counterexample 1 failed: accepted 200 text/html as (%d, %v)", sz, ok)
	}
	if sz, ok := ValidateProbedMediaResponse(http.StatusPartialContent, http.Header{
		"Content-Type":  {"video/mp4"},
		"Content-Range": {"not-a-range/12345"},
	}, []byte{0x00}); ok || sz != 0 {
		t.Fatalf("R4 counterexample 2 failed: accepted invalid 206 Content-Range as (%d, %v)", sz, ok)
	}

	// 4. Multi-entry SelectedIndex preserves original entry position when entry #1 has no formats
	multiOpts := AdaptOptions{
		PlatformID:    "x",
		ContentID:     "1577719286659006464",
		SourceURL:     "https://x.com/u/status/1577719286659006464/video/2",
		SelectedIndex: 2,
		MaxEntries:    4,
	}
	multiInfo := &Info{
		ID:   "1577719286659006464",
		Type: "playlist",
		Entries: []Info{
			{ID: "entry1-empty", Formats: nil},
			{
				ID:    "entry2-valid",
				Title: "Entry Two",
				Formats: []Format{
					{
						FormatID: "http-720",
						URL:      "https://video.twimg.com/ext_tw_video/2/pu/vid/1280x720/v2.mp4",
						Ext:      "mp4",
						Protocol: "https",
						Width:    &w,
						Height:   &h,
						VCodec:   "avc1.640020",
						ACodec:   "mp4a.40.2",
					},
				},
			},
			{
				ID:    "entry3-valid",
				Title: "Entry Three",
				Formats: []Format{
					{
						FormatID: "http-720",
						URL:      "https://video.twimg.com/ext_tw_video/3/pu/vid/1280x720/v3.mp4",
						Ext:      "mp4",
						Protocol: "https",
						Width:    &w,
						Height:   &h,
						VCodec:   "avc1.640020",
						ACodec:   "mp4a.40.2",
					},
				},
			},
		},
	}
	multiEnv := AdaptInfo(multiInfo, multiOpts, now)
	multiData := unified.Map(multiEnv["data"])
	multiItems := unified.Slice(multiData["items"])
	firstSurviving := unified.Map(multiItems[0])
	if unified.Str(multiData["default_item_id"]) != unified.Str(firstSurviving["id"]) || !unified.Equal(firstSurviving["index"], 2) {
		t.Fatalf("R1 counterexample failed: expected default_item_id=%v (index 2), got default_item_id=%v (index=%v)", firstSurviving["id"], multiData["default_item_id"], firstSurviving["index"])
	}
}

func TestPR36Review5785629879Counterexamples(t *testing.T) {
	const now int64 = 1762300800

	// Counterexample 1 (R2-A): External proxy must not bypass controlled outbound boundary
	binPath, hashes := writeFakeYTDLP(t, `echo '{"id":"1","formats":[{"format_id":"18","url":"https://video.twimg.com/v.mp4","ext":"mp4"}]}'`)
	privateResolver := stubResolver{
		ips: map[string][]netip.Addr{
			"x.com":         {netip.MustParseAddr("10.0.0.1")},
			"public.x.com":  {netip.MustParseAddr("93.184.216.34")},
			"private.x.com": {netip.MustParseAddr("10.0.0.1")},
		},
	}
	// New with ProxyURL + Resolver/AllowedOutboundHost must fail closed
	if engWithProxy, err := New(Config{
		BinaryPath:          binPath,
		AllowedHashes:       hashes,
		AllowedOutboundHost: func(h string) bool { return h == "x.com" || strings.HasSuffix(h, ".x.com") },
		Resolver:            privateResolver,
		ProxyURL:            "http://127.0.0.1:18080",
	}); err == nil || engWithProxy.Enabled() {
		t.Fatalf("R2-A failed: expected New with ProxyURL and outbound policy to fail closed, got enabled=%v err=%v", engWithProxy.Enabled(), err)
	}
	// Direct verifyPublicTargetHost & Extract with ProxyURL set on Engine struct must still enforce Resolver and block private IP
	directProxyEng := &Engine{
		enabled:             true,
		binaryPath:          binPath,
		allowedOutboundHost: func(h string) bool { return h == "x.com" || strings.HasSuffix(h, ".x.com") },
		resolver:            privateResolver,
		proxyURL:            "http://127.0.0.1:18080",
		sem:                 make(chan struct{}, 1),
		timeout:             5 * time.Second,
	}
	if err := directProxyEng.verifyPublicTargetHost(context.Background(), "https://x.com/i/status/1"); err == nil || err.Code != CodeUpstreamBlocked {
		t.Fatalf("R2-A failed: verifyPublicTargetHost with ProxyURL bypassed private IP check: %v", err)
	}
	if _, err := directProxyEng.Extract(context.Background(), "https://x.com/i/status/1"); err == nil {
		t.Fatalf("R2-A failed: Extract with ProxyURL and private target IP succeeded unexpectedly")
	}
	// NewHTTPSizeProber with external proxy must fail closed without dialing
	proberWithProxy := NewHTTPSizeProber("http://127.0.0.1:18080", func(string) bool { return true })
	if sz, ok := proberWithProxy(context.Background(), "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/v.mp4"); ok || sz != 0 {
		t.Fatalf("R2-A failed: expected NewHTTPSizeProber with external proxy to fail closed, got (%d, %v)", sz, ok)
	}

	// Counterexamples 2, 3, 4 (R2-B): Gate POST body preservation, HTTP->HTTPS redirect (with real TLS RootCAs), and CONNECT cancellation cleanup
	var gotPostBody string
	upstreamHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/post":
			b, _ := io.ReadAll(r.Body)
			gotPostBody = string(b)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok:" + gotPostBody))
		case "/step1":
			http.Redirect(w, r, "https://public.x.com/step2", http.StatusFound)
		case "/step2":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("https-step2-ok"))
		case "/step1-private":
			http.Redirect(w, r, "https://private.x.com/step2", http.StatusFound)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	upstreamSrv := httptest.NewServer(upstreamHandler)
	defer upstreamSrv.Close()
	upstreamTLS, upstreamCA := newTLSServerForHosts(t, upstreamHandler, "public.x.com")
	defer upstreamTLS.Close()

	srvURL, _ := url.Parse(upstreamSrv.URL)
	tlsURL, _ := url.Parse(upstreamTLS.URL)
	gateEng, err := New(Config{
		BinaryPath:          binPath,
		AllowedHashes:       hashes,
		AllowedOutboundHost: func(h string) bool { return h == "x.com" || strings.HasSuffix(h, ".x.com") },
		Resolver:            privateResolver,
	})
	if err != nil {
		t.Fatalf("New gateEng failed: %v", err)
	}
	gateEng = gateEng.withGateTestHooks(gateTestHooks{
		dialAddr: func(_ netip.Addr, port string) string {
			if port == "443" {
				return tlsURL.Host
			}
			return srvURL.Host
		},
		rootCAs: upstreamCA,
	})

	gateCtx, gateCancel := context.WithCancel(context.Background())
	defer gateCancel()
	gateURL, closeGate, err := gateEng.startOutboundGate(gateCtx)
	if err != nil {
		t.Fatalf("startOutboundGate failed: %v", err)
	}
	defer closeGate()

	parsedGate, _ := url.Parse(gateURL)
	gateClient := &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyURL(parsedGate),
		},
		Timeout: 3 * time.Second,
	}

	// Counterexample 2: POST body "hello=1" preserved through gate
	postResp, err := gateClient.Post("http://public.x.com/post", "application/x-www-form-urlencoded", strings.NewReader("hello=1"))
	if err != nil {
		t.Fatalf("R2-B POST failed: %v", err)
	}
	_ = postResp.Body.Close()
	if postResp.StatusCode != http.StatusOK || gotPostBody != "hello=1" {
		t.Fatalf("R2-B POST body counterexample failed: status=%d gotPostBody=%q, want 'hello=1'", postResp.StatusCode, gotPostBody)
	}

	// Counterexample 3: http://public.x.com/step1 -> 302 https://public.x.com/step2 succeeds, while -> https://private.x.com/step2 is 403
	redirResp, err := gateClient.Get("http://public.x.com/step1")
	if err != nil {
		t.Fatalf("R2-B HTTP->HTTPS redirect request failed: %v", err)
	}
	redirBody, _ := io.ReadAll(redirResp.Body)
	_ = redirResp.Body.Close()
	if redirResp.StatusCode != http.StatusOK || string(redirBody) != "https-step2-ok" {
		t.Fatalf("R2-B HTTP->HTTPS public redirect failed: status=%d body=%q", redirResp.StatusCode, string(redirBody))
	}
	privRedirResp, err := gateClient.Get("http://public.x.com/step1-private")
	if err != nil {
		t.Fatalf("R2-B HTTP->HTTPS private redirect request failed: %v", err)
	}
	_ = privRedirResp.Body.Close()
	if privRedirResp.StatusCode != http.StatusForbidden {
		t.Fatalf("R2-B HTTP->HTTPS private redirect expected 403 Forbidden, got %d", privRedirResp.StatusCode)
	}

	// Counterexample 4: CONNECT tunnel closes within <500ms when cancel() + closeGate() is invoked
	holdLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen holdLn failed: %v", err)
	}
	defer holdLn.Close()
	holdDone := make(chan struct{})
	defer close(holdDone)
	go func() {
		for {
			c, err := holdLn.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				<-holdDone
			}(c)
		}
	}()

	connEng := gateEng.withGateTestHooks(gateTestHooks{
		dialAddr: func(_ netip.Addr, _ string) string {
			return holdLn.Addr().String()
		},
	})
	tunCtx, tunCancel := context.WithCancel(context.Background())
	tunGateURL, closeTunGate, err := connEng.startOutboundGate(tunCtx)
	if err != nil {
		t.Fatalf("startOutboundGate for CONNECT test failed: %v", err)
	}
	tunParsed, _ := url.Parse(tunGateURL)
	tunConn, err := net.DialTimeout("tcp", tunParsed.Host, 2*time.Second)
	if err != nil {
		t.Fatalf("dial tunGate failed: %v", err)
	}
	defer tunConn.Close()
	if _, err := tunConn.Write([]byte("CONNECT public.x.com:443 HTTP/1.1\r\nHost: public.x.com:443\r\nProxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(tunParsed.User.String())) + "\r\n\r\n")); err != nil {
		t.Fatalf("write CONNECT failed: %v", err)
	}
	replyBuf := make([]byte, 128)
	n, err := tunConn.Read(replyBuf)
	if err != nil || !strings.Contains(string(replyBuf[:n]), "200 Connection Established") {
		t.Fatalf("expected 200 Connection Established, got %q (err=%v)", string(replyBuf[:n]), err)
	}
	startCancel := time.Now()
	tunCancel()
	closeTunGate()
	_ = tunConn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	eofBuf := make([]byte, 16)
	_, readErr := tunConn.Read(eofBuf)
	elapsed := time.Since(startCancel)
	if readErr == nil {
		t.Fatalf("R2-B CONNECT cleanup failed: expected tunnel read to return error/EOF after cancel+closeGate")
	}
	if netErr, ok := readErr.(net.Error); ok && netErr.Timeout() {
		t.Fatalf("R2-B CONNECT cleanup failed: tunnel remained open until 500ms deadline (%v)", elapsed)
	}

	// Counterexample 5 (R3): Optional size probe success/failure does not drift source_id, while conflicting size is rejected
	w360, h360, sz360 := int64(640), int64(360), int64(28523658)
	ytOpts := AdaptOptions{
		PlatformID:    "youtube",
		ContentID:     "aqz-KE-bpKQ",
		SourceURL:     "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
		MaxEntries:    1,
		EnableDASHMux: true,
	}
	ytURL := "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=18&source=youtube&clen=28523658&dur=634.566&lmt=1700000000000000&sig=SIG_A"
	envKnownSize := AdaptInfo(&Info{
		ID: "aqz-KE-bpKQ",
		Formats: []Format{{
			FormatID: "18",
			URL:      ytURL,
			Ext:      "mp4",
			Protocol: "https",
			Width:    &w360,
			Height:   &h360,
			VCodec:   "avc1.42001E",
			ACodec:   "mp4a.40.2",
			Filesize: &sz360,
		}},
	}, ytOpts, now)
	envNilSize := AdaptInfo(&Info{
		ID: "aqz-KE-bpKQ",
		Formats: []Format{{
			FormatID: "18",
			URL:      ytURL,
			Ext:      "mp4",
			Protocol: "https",
			Width:    &w360,
			Height:   &h360,
			VCodec:   "avc1.42001E",
			ACodec:   "mp4a.40.2",
			Filesize: nil,
		}},
	}, ytOpts, now)
	defKnown := unified.Map(unified.Map(unified.Slice(unified.Map(envKnownSize["data"])["items"])[0])["default"])
	defNil := unified.Map(unified.Map(unified.Slice(unified.Map(envNilSize["data"])["items"])[0])["default"])
	if unified.Str(defKnown["source_id"]) != unified.Str(defNil["source_id"]) {
		t.Fatalf("R3 counterexample failed: source_id drifted when Filesize toggled nil: %v vs %v", defKnown["source_id"], defNil["source_id"])
	}
	badSz := int64(99999)
	envConflictSize := AdaptInfo(&Info{
		ID: "aqz-KE-bpKQ",
		Formats: []Format{{
			FormatID: "18",
			URL:      ytURL,
			Ext:      "mp4",
			Protocol: "https",
			Width:    &w360,
			Height:   &h360,
			VCodec:   "avc1.42001E",
			ACodec:   "mp4a.40.2",
			Filesize: &badSz,
		}},
	}, ytOpts, now)
	defConflict := unified.Map(unified.Map(unified.Slice(unified.Map(envConflictSize["data"])["items"])[0])["default"])
	if _, hasSize := defConflict["size_bytes"]; hasSize {
		t.Fatalf("R3 counterexample failed: expected conflicting clen vs Filesize to omit size_bytes, got %v", defConflict["size_bytes"])
	}

	// Counterexample 6 (Default selection + 4K metadata): 360p (has_audio=true) + 2160p (3840x2160, has_audio=false)
	w4k, h4k, sz4k := int64(3840), int64(2160), int64(712445280)
	env4K := AdaptInfo(&Info{
		ID:    "aqz-KE-bpKQ",
		Title: "4K Test",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      ytURL,
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w360,
				Height:   &h360,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: &sz360,
			},
			{
				FormatID: "401",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=401&source=youtube&clen=712445280&dur=634.566&lmt=1700000000000000&sig=SIG_B",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w4k,
				Height:   &h4k,
				VCodec:   "av01.0.13M.08",
				ACodec:   "none",
				Filesize: &sz4k,
			},
		},
	}, ytOpts, now)
	if err := unified.ValidateEnvelopeAt(env4K, now); err != nil {
		t.Fatalf("4K envelope validation failed: %v", err)
	}
	item4K := unified.Map(unified.Slice(unified.Map(env4K["data"])["items"])[0])
	def4K := unified.Map(item4K["default"])
	if !strings.Contains(unified.Str(def4K["url"]), "itag=18") {
		t.Fatalf("expected 360p audible variant (itag=18) as item.default, got %+v", def4K)
	}
	variants4K := unified.Slice(item4K["variants"])
	meta4K := unified.Map(unified.Map(variants4K[0])["metadata"])
	if !unified.Equal(meta4K["width"], int64(3840)) || !unified.Equal(meta4K["height"], int64(2160)) {
		t.Fatalf("expected 4K silent variant to preserve metadata.width=3840 and metadata.height=2160, got %+v", meta4K)
	}

	// Counterexample 7 (R4): 206 Partial Content with empty body must be rejected
	if sz, ok := ValidateProbedMediaResponse(http.StatusPartialContent, http.Header{
		"Content-Type":  {"video/mp4"},
		"Content-Range": {"bytes 0-0/12345"},
	}, []byte{}); ok || sz != 0 {
		t.Fatalf("R4 206 empty-body counterexample failed: accepted empty body as (%d, %v)", sz, ok)
	}
}

func TestPR36Review5788284772C1AndExport(t *testing.T) {
	const now int64 = 1762300800
	w360, h360, sz360 := int64(640), int64(360), int64(15048844)
	w720, h720, sz720 := int64(1280), int64(720), int64(42000000)
	w1080, h1080, sz1080 := int64(1920), int64(1080), int64(120000000)
	w4k, h4k, sz4k := int64(3840), int64(2160), int64(712445280)
	szAudio := int64(9800000)

	ytOpts := AdaptOptions{
		PlatformID:    "youtube",
		ContentID:     "aqz-KE-bpKQ",
		SourceURL:     "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
		MaxEntries:    1,
		EnableDASHMux: true,
	}

	// 1. Positive: Audible 360p default + 4K/1080p split silent video-only + M4A audio-only (normal & debug)
	ytAudibleAnd4K := AdaptInfo(&Info{
		ID:       "aqz-KE-bpKQ",
		Title:    "Big Buck Bunny 60fps 4K",
		Uploader: "Blender Foundation",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=18&source=youtube&clen=15048844&dur=634.566&lmt=1700000000000000&sig=SIG_18",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w360,
				Height:   &h360,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: &sz360,
			},
			{
				FormatID: "313",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=313&source=youtube&clen=712445280&dur=634.566&lmt=1700000000000000&sig=SIG_313",
				Ext:      "webm",
				Protocol: "https",
				Width:    &w4k,
				Height:   &h4k,
				VCodec:   "vp9",
				ACodec:   "none",
				Filesize: &sz4k,
			},
			{
				FormatID: "248",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=248&source=youtube&clen=120000000&dur=634.566&lmt=1700000000000000&sig=SIG_248",
				Ext:      "webm",
				Protocol: "https",
				Width:    &w1080,
				Height:   &h1080,
				VCodec:   "vp9",
				ACodec:   "none",
				Filesize: &sz1080,
			},
			{
				FormatID: "140",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=140&source=youtube&clen=9800000&dur=634.566&lmt=1700000000000000&sig=SIG_140",
				Ext:      "m4a",
				Protocol: "https",
				VCodec:   "none",
				ACodec:   "mp4a.40.2",
				Filesize: &szAudio,
			},
		},
	}, ytOpts, now)

	ytNormal := unified.PublicView(ytAudibleAnd4K, false, now)
	ytDebug := unified.PublicView(ytAudibleAnd4K, true, now)
	for viewName, env := range map[string]unified.Object{"normal": ytNormal, "debug": ytDebug} {
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("YouTube %s envelope failed ValidateEnvelopeAt: %v", viewName, err)
		}
	}

	// Negative 1a: Selecting 4K split silent or M4A audio-only when audible 360p exists must be rejected
	for _, badIdx := range []int{0, 3} {
		mutated := unified.Clone(ytNormal)
		it := unified.Map(unified.Slice(unified.Map(mutated["data"])["items"])[0])
		badVar := unified.Map(unified.Slice(it["variants"])[badIdx])
		badSrc := unified.Map(unified.Slice(unified.Map(badVar["delivery"])["sources"])[0])
		it["default"] = unified.Object{
			"variant_id": badVar["id"],
			"source_id":  badSrc["id"],
			"url":        badSrc["url"],
		}
		if err := unified.ValidateEnvelopeAt(mutated, now); err == nil {
			t.Fatalf("expected ValidateEnvelopeAt to reject non-eligible default variant index %d (%s)", badIdx, unified.Str(badVar["label"]))
		}
	}

	// Negative 1b: Two audible complete files (360p + 720p) alongside 4K silent: selecting 360p must be rejected
	ytTwoAudible := AdaptInfo(&Info{
		ID:    "aqz-KE-bpKQ",
		Title: "Two Audible + 4K Silent",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=18&source=youtube&clen=15048844&dur=634.566&lmt=1700000000000000&sig=SIG_18",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w360,
				Height:   &h360,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: &sz360,
			},
			{
				FormatID: "22",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=22&source=youtube&clen=42000000&dur=634.566&lmt=1700000000000000&sig=SIG_22",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w720,
				Height:   &h720,
				VCodec:   "avc1.64001F",
				ACodec:   "mp4a.40.2",
				Filesize: &sz720,
			},
			{
				FormatID: "313",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=313&source=youtube&clen=712445280&dur=634.566&lmt=1700000000000000&sig=SIG_313",
				Ext:      "webm",
				Protocol: "https",
				Width:    &w4k,
				Height:   &h4k,
				VCodec:   "vp9",
				ACodec:   "none",
				Filesize: &sz4k,
			},
		},
	}, ytOpts, now)
	if err := unified.ValidateEnvelopeAt(ytTwoAudible, now); err != nil {
		t.Fatalf("expected 720p audible default to pass ValidateEnvelopeAt: %v", err)
	}
	lowDefault := unified.Clone(ytTwoAudible)
	itLow := unified.Map(unified.Slice(unified.Map(lowDefault["data"])["items"])[0])
	for _, rawV := range unified.Slice(itLow["variants"]) {
		v := unified.Map(rawV)
		if strings.Contains(unified.Str(v["label"]), "360p") {
			src := unified.Map(unified.Slice(unified.Map(v["delivery"])["sources"])[0])
			itLow["default"] = unified.Object{
				"variant_id": v["id"],
				"source_id":  src["id"],
				"url":        src["url"],
			}
		}
	}
	if err := unified.ValidateEnvelopeAt(lowDefault, now); err == nil {
		t.Fatal("expected ValidateEnvelopeAt to reject 360p default when 720p audible complete file is present")
	}

	// 2. Only silent video files: 4K silent selected as default passes; selecting 1080p silent is rejected
	ytOnlySilent := AdaptInfo(&Info{
		ID:    "aqz-KE-bpKQ",
		Title: "Only Silent Video Files",
		Formats: []Format{
			{
				FormatID: "313",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=313&source=youtube&clen=712445280&dur=634.566&lmt=1700000000000000&sig=SIG_313",
				Ext:      "webm",
				Protocol: "https",
				Width:    &w4k,
				Height:   &h4k,
				VCodec:   "vp9",
				ACodec:   "none",
				Filesize: &sz4k,
			},
			{
				FormatID: "248",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=248&source=youtube&clen=120000000&dur=634.566&lmt=1700000000000000&sig=SIG_248",
				Ext:      "webm",
				Protocol: "https",
				Width:    &w1080,
				Height:   &h1080,
				VCodec:   "vp9",
				ACodec:   "none",
				Filesize: &sz1080,
			},
			{
				FormatID: "140",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=140&source=youtube&clen=9800000&dur=634.566&lmt=1700000000000000&sig=SIG_140",
				Ext:      "m4a",
				Protocol: "https",
				VCodec:   "none",
				ACodec:   "mp4a.40.2",
				Filesize: &szAudio,
			},
		},
	}, ytOpts, now)
	ytSilentNormal := unified.PublicView(ytOnlySilent, false, now)
	ytSilentDebug := unified.PublicView(ytOnlySilent, true, now)
	for viewName, env := range map[string]unified.Object{"normal": ytSilentNormal, "debug": ytSilentDebug} {
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("only-silent %s envelope failed ValidateEnvelopeAt: %v", viewName, err)
		}
	}
	silentLow := unified.Clone(ytSilentNormal)
	itSilentLow := unified.Map(unified.Slice(unified.Map(silentLow["data"])["items"])[0])
	v1080Silent := unified.Map(unified.Slice(itSilentLow["variants"])[1])
	src1080Silent := unified.Map(unified.Slice(unified.Map(v1080Silent["delivery"])["sources"])[0])
	itSilentLow["default"] = unified.Object{
		"variant_id": v1080Silent["id"],
		"source_id":  src1080Silent["id"],
		"url":        src1080Silent["url"],
	}
	if err := unified.ValidateEnvelopeAt(silentLow, now); err == nil {
		t.Fatal("expected ValidateEnvelopeAt to reject 1080p silent default when 4K silent file is present")
	}

	// 3. Unknown audio (omitted has_audio) is not forged as true, and on Instagram is preferred over silent DASH tracks
	igOpts := AdaptOptions{
		PlatformID:                   "instagram",
		ContentID:                    "CTApqC8BGWd",
		SourceURL:                    "https://www.instagram.com/reel/CTApqC8BGWd/",
		MaxEntries:                   1,
		EnableDASHMux:                true,
		AllowCodecLessProgressiveMP4: true,
	}
	igUnknown := AdaptInfo(&Info{
		ID:    "CTApqC8BGWd",
		Title: "Video by mrcigar",
		Formats: []Format{
			{
				FormatID: "dash-720-silent",
				URL:      "https://scontent-nrt1-1.cdninstagram.com/o1/v/t2/f2/m86/dash720.mp4?efg=eyJ2ZW5jb2RlX3RhZyI6ImRhc2hfaGlnaF8xX3YxIn0&_nc_ht=scontent-nrt1-1.cdninstagram.com&oe=690D8A00",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w720,
				Height:   &h720,
				VCodec:   "avc1.64001F",
				ACodec:   "none",
			},
			{
				FormatID: "1",
				URL:      "https://scontent-nrt1-2.cdninstagram.com/o1/v/t16/f2/m69/10000000_1_n.mp4?efg=eyJ2ZW5jb2RlX3RhZyI6InZ0c192b2RfdXJsZ2VuIn0&_nc_ht=scontent-nrt1-2.cdninstagram.com&oe=690D8A00",
				Ext:      "mp4",
				Protocol: "https",
			},
			{
				FormatID: "dash-audio",
				URL:      "https://scontent-nrt1-1.cdninstagram.com/o1/v/t16/f2/m69/audio.mp4?_nc_ht=scontent-nrt1-1.cdninstagram.com&oe=690D8A00",
				Ext:      "m4a",
				Protocol: "https",
				VCodec:   "none",
				ACodec:   "mp4a.40.5",
			},
		},
	}, igOpts, now)
	igNormal := unified.PublicView(igUnknown, false, now)
	igDebug := unified.PublicView(igUnknown, true, now)
	for viewName, env := range map[string]unified.Object{"normal": igNormal, "debug": igDebug} {
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("Instagram unknown-audio %s envelope failed ValidateEnvelopeAt: %v", viewName, err)
		}
		item := unified.Map(unified.Slice(unified.Map(env["data"])["items"])[0])
		def := unified.Map(item["default"])
		if def == nil || !strings.Contains(unified.Str(def["url"]), "10000000_1_n.mp4") {
			t.Fatalf("expected Instagram unknown-audio MP4 default in %s view, got %v", viewName, def)
		}
		variants := unified.Slice(item["variants"])
		meta := unified.Map(unified.Map(variants[1])["metadata"])
		if _, exists := meta["has_audio"]; exists {
			t.Fatalf("expected unknown audio to omit has_audio in %s view, got %v", viewName, meta["has_audio"])
		}
	}

	// Unknown audio 360p alongside 4K split silent must NOT be treated as audible complete file
	unknownPlus4KSilent := unified.Clone(ytNormal)
	itUnk := unified.Map(unified.Slice(unified.Map(unknownPlus4KSilent["data"])["items"])[0])
	for _, rawV := range unified.Slice(itUnk["variants"]) {
		v := unified.Map(rawV)
		if strings.Contains(unified.Str(v["label"]), "360p") {
			meta := unified.Map(v["metadata"])
			delete(meta, "has_audio")
			delete(meta, "audio_codec")
		}
	}
	if err := unified.ValidateEnvelopeAt(unknownPlus4KSilent, now); err == nil {
		t.Fatal("expected ValidateEnvelopeAt to reject 360p unknown-audio default when 4K silent file is present")
	}

	if dest := os.Getenv("DOKITOOL_GO_YTDLP_OUTPUT"); dest != "" {
		exports := unified.Array{
			ytNormal,
			ytDebug,
			unified.PublicView(ytTwoAudible, false, now),
			unified.PublicView(ytTwoAudible, true, now),
			ytSilentNormal,
			ytSilentDebug,
			igNormal,
			igDebug,
		}
		raw, err := unified.Encode(exports)
		if err != nil {
			t.Fatalf("encode DOKITOOL_GO_YTDLP_OUTPUT: %v", err)
		}
		if err := os.WriteFile(dest, append(raw, '\n'), 0600); err != nil {
			t.Fatalf("write DOKITOOL_GO_YTDLP_OUTPUT: %v", err)
		}
	}
}

func TestOmniGetPoint2PythonZipappAndStaleTempCleanup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix python3 fixture")
	}

	// 1. CleanupStaleTempDirs only removes stale dokitool-ytdlp-* real directories owned by our UID,
	// never removes _MEI* directories, never follows or removes symlinks, and never removes other-UID dirs.
	tmpRoot := t.TempDir()
	staleMEI := filepath.Join(tmpRoot, "_MEI123456")
	staleDoki := filepath.Join(tmpRoot, "dokitool-ytdlp-old")
	freshDoki := filepath.Join(tmpRoot, "dokitool-ytdlp-fresh")
	unrelatedDir := filepath.Join(tmpRoot, "other-dir")
	symlinkTarget := filepath.Join(tmpRoot, "protected-target")
	symlinkSentinel := filepath.Join(symlinkTarget, "keep.txt")
	dokiSymlink := filepath.Join(tmpRoot, "dokitool-ytdlp-symlink")

	for _, dir := range []string{staleMEI, staleDoki, freshDoki, unrelatedDir, symlinkTarget} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(symlinkSentinel, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(symlinkTarget, dokiSymlink); err != nil {
		t.Fatal(err)
	}

	oldTime := time.Now().Add(-3 * time.Hour)
	for _, dir := range []string{staleMEI, staleDoki, unrelatedDir, symlinkTarget} {
		if err := os.Chtimes(dir, oldTime, oldTime); err != nil {
			t.Fatal(err)
		}
	}

	// Verify that a mismatched UID removes 0 directories even when staleDoki is >2h old.
	if cleanedOtherUID := cleanupStaleTempDirsForUID(tmpRoot, 2*time.Hour, os.Geteuid()+1); cleanedOtherUID != 0 {
		t.Fatalf("expected 0 dirs removed for non-matching UID, got %d", cleanedOtherUID)
	}
	if _, err := os.Stat(staleDoki); err != nil {
		t.Fatalf("expected staleDoki to remain when UID does not match: %v", err)
	}

	// Verify normal CleanupStaleTempDirs removes only staleDoki (1 dir), preserving _MEI*, symlinks, fresh dirs, and unrelated dirs.
	cleaned := CleanupStaleTempDirs(tmpRoot, 2*time.Hour)
	if cleaned != 1 {
		t.Fatalf("expected CleanupStaleTempDirs to remove exactly 1 stale dokitool-ytdlp-* dir, got %d", cleaned)
	}
	if _, err := os.Stat(staleDoki); !os.IsNotExist(err) {
		t.Fatalf("expected stale dir %s to be removed", staleDoki)
	}
	for _, kept := range []string{staleMEI, freshDoki, unrelatedDir, symlinkTarget, symlinkSentinel} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("expected %s to be preserved: %v", kept, err)
		}
	}
	if lstat, err := os.Lstat(dokiSymlink); err != nil || lstat.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected symlink %s to remain untouched, err=%v", dokiSymlink, err)
	}

	// 2. Python zipapp execution (mode 0644, non-executable, invoked via python3)
	pyPath := lookupPython3InPath(os.Getenv("PATH"))
	if pyPath == "" {
		t.Skip("python3 not found in PATH")
	}
	zipappDir := t.TempDir()
	zipappPath := filepath.Join(zipappDir, "yt-dlp")
	pyBody := "#!/usr/bin/env python3\n# PK\x03\x04 simulated zipapp header\nimport json, sys\nif '--version' in sys.argv:\n    print('" + PinnedVersion + "')\n    sys.exit(0)\nprint(json.dumps({'id':'zipapp-ok','title':'Zipapp Test','formats':[{'format_id':'18','url':'https://rr1---sn-test.googlevideo.com/videoplayback?itag=18','ext':'mp4','protocol':'https','width':1280,'height':720,'vcodec':'avc1.42001E','acodec':'mp4a.40.2'}]}))\n"
	if err := os.WriteFile(zipappPath, []byte(pyBody), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(pyBody))
	digest := hex.EncodeToString(sum[:])

	eng, err := New(Config{
		BinaryPath:    zipappPath,
		AllowedHashes: map[string]string{digest: "yt-dlp"},
		EnvPath:       os.Getenv("PATH"),
	})
	if err != nil || !eng.Enabled() {
		t.Fatalf("expected zipapp engine to be enabled, got err=%v", err)
	}
	if !eng.UsingPythonZipapp() {
		t.Fatal("expected UsingPythonZipapp() == true for python zipapp")
	}

	info, err := eng.Extract(context.Background(), "https://www.youtube.com/watch?v=aqz-KE-bpKQ")
	if err != nil || info == nil || info.ID != "zipapp-ok" {
		t.Fatalf("expected zipapp extraction via python3 to succeed, got info=%+v err=%v", info, err)
	}
}

func TestOmniGetPythonZipappStartupVersionSelfCheckFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix python3 fixture")
	}

	realPython3 := lookupPython3InPath(os.Getenv("PATH"))
	if realPython3 == "" {
		t.Skip("python3 not found in PATH")
	}

	// Create a fake "python3" in a custom PATH directory that simulates an incompatible/old python3 failing self-check.
	badPyDir := t.TempDir()
	badPyPath := filepath.Join(badPyDir, "python3")
	badPyScript := "#!/bin/sh\necho 'SyntaxError: future feature annotations is not defined' >&2\nexit 1\n"
	if err := os.WriteFile(badPyPath, []byte(badPyScript), 0o755); err != nil {
		t.Fatal(err)
	}
	customEnvPath := badPyDir + string(os.PathListSeparator) + os.Getenv("PATH")

	// Case 1: python3 in PATH exists but fails startup --version self-check, AND the verified zipapp is executable (0755)
	// with a working direct interpreter -> falls back cleanly to direct execution (UsingPythonZipapp() == false, Enabled() == true).
	execZipDir := t.TempDir()
	execZipPath := filepath.Join(execZipDir, "yt-dlp")
	execZipBody := fmt.Sprintf("#!%s\n# PK\x03\x04 simulated zipapp header\nimport json, sys\nif '--version' in sys.argv:\n    print('%s')\n    sys.exit(0)\nprint(json.dumps({'id':'direct-fallback-ok','title':'Direct Fallback','formats':[{'format_id':'18','url':'https://rr1---sn-test.googlevideo.com/videoplayback?itag=18','ext':'mp4','protocol':'https','width':1280,'height':720,'vcodec':'avc1.42001E','acodec':'mp4a.40.2'}]}))\n", realPython3, PinnedVersion)
	if err := os.WriteFile(execZipPath, []byte(execZipBody), 0o755); err != nil {
		t.Fatal(err)
	}
	execSum := sha256.Sum256([]byte(execZipBody))
	execDigest := hex.EncodeToString(execSum[:])

	fallbackEng, err := New(Config{
		BinaryPath:    execZipPath,
		AllowedHashes: map[string]string{execDigest: "yt-dlp"},
		EnvPath:       customEnvPath,
	})
	if err != nil || fallbackEng == nil || !fallbackEng.Enabled() {
		t.Fatalf("expected zipapp with executable direct fallback to stay enabled when python3 fails self-check, got enabled=%v err=%v", fallbackEng != nil && fallbackEng.Enabled(), err)
	}
	if fallbackEng.UsingPythonZipapp() {
		t.Fatalf("expected UsingPythonZipapp() == false after python3 self-check failure and direct binary fallback")
	}
	info, err := fallbackEng.Extract(context.Background(), "https://www.youtube.com/watch?v=aqz-KE-bpKQ")
	if err != nil || info == nil || info.ID != "direct-fallback-ok" {
		t.Fatalf("expected direct fallback extraction to succeed, got info=%+v err=%v", info, err)
	}

	// Case 2: python3 in PATH exists but fails startup --version self-check, AND direct execution of the zipapp also fails
	// (e.g. non-executable 0644 or shebang uses the broken python3) -> engine is disabled at startup with clear reason.
	nonExecZipDir := t.TempDir()
	nonExecZipPath := filepath.Join(nonExecZipDir, "yt-dlp")
	if err := os.WriteFile(nonExecZipPath, []byte(execZipBody), 0o644); err != nil {
		t.Fatal(err)
	}
	disabledEng, err := New(Config{
		BinaryPath:    nonExecZipPath,
		AllowedHashes: map[string]string{execDigest: "yt-dlp"},
		EnvPath:       customEnvPath,
	})
	if err == nil || disabledEng == nil || disabledEng.Enabled() {
		t.Fatalf("expected engine to be disabled when both python3 self-check and direct execution fail, got enabled=%v err=%v", disabledEng != nil && disabledEng.Enabled(), err)
	}
	if !strings.Contains(disabledEng.DisableReason(), "zipapp startup self-check failed") {
		t.Fatalf("expected DisableReason to mention zipapp startup self-check failure, got %q", disabledEng.DisableReason())
	}

	// Case 3: python3 in PATH outputs wrong yt-dlp version (not PinnedVersion) and direct execution also outputs wrong version -> disabled.
	wrongVerDir := t.TempDir()
	wrongVerPath := filepath.Join(wrongVerDir, "yt-dlp")
	wrongVerBody := fmt.Sprintf("#!%s\n# PK\x03\x04 simulated zipapp header\nimport sys\nif '--version' in sys.argv:\n    print('2024.01.01')\n    sys.exit(0)\n", realPython3)
	if err := os.WriteFile(wrongVerPath, []byte(wrongVerBody), 0o755); err != nil {
		t.Fatal(err)
	}
	wrongSum := sha256.Sum256([]byte(wrongVerBody))
	wrongDigest := hex.EncodeToString(wrongSum[:])

	wrongVerEng, err := New(Config{
		BinaryPath:    wrongVerPath,
		AllowedHashes: map[string]string{wrongDigest: "yt-dlp"},
		EnvPath:       os.Getenv("PATH"),
	})
	if err == nil || wrongVerEng == nil || wrongVerEng.Enabled() {
		t.Fatalf("expected engine to be disabled when --version != %s, got enabled=%v err=%v", PinnedVersion, wrongVerEng != nil && wrongVerEng.Enabled(), err)
	}
}

func TestAdaptInfoDualContainerDASHAudioVariants(t *testing.T) {
	const now int64 = 1762300800
	w360, h360, sz360 := int64(640), int64(360), int64(15048844)
	w1080, h1080, sz1080 := int64(1920), int64(1080), int64(98000000)
	w4k, h4k, sz4k := int64(3840), int64(2160), int64(429584204)
	abr140, abr251, abr171 := 129.4, 135.2, 118.0
	ch2 := int64(2)
	asr44, asr48 := int64(44100), int64(48000)
	sz140, sz251, sz171 := int64(5044939), int64(6407118), int64(5500000)

	ytOpts := AdaptOptions{
		PlatformID:    "youtube",
		ContentID:     "tO01J-M3g0U",
		SourceURL:     "https://www.youtube.com/watch?v=tO01J-M3g0U",
		MaxEntries:    1,
		EnableDASHMux: true,
	}

	env := AdaptInfo(&Info{
		ID:       "tO01J-M3g0U",
		Title:    "Costa Rica in 4K 60fps HDR",
		Uploader: "Jacob + Katie Schwarz",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=18&source=youtube&clen=15048844&dur=313.8&sig=SIG_18",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w360,
				Height:   &h360,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: &sz360,
			},
			{
				FormatID: "137",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=137&source=youtube&clen=98000000&dur=313.8&sig=SIG_137",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w1080,
				Height:   &h1080,
				VCodec:   "avc1.640028",
				ACodec:   "none",
				Filesize: &sz1080,
			},
			{
				FormatID: "315",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=315&source=youtube&clen=429584204&dur=313.8&sig=SIG_315",
				Ext:      "webm",
				Protocol: "https",
				Width:    &w4k,
				Height:   &h4k,
				VCodec:   "vp9",
				ACodec:   "none",
				Filesize: &sz4k,
			},
			{
				FormatID:      "140",
				URL:           "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=140&source=youtube&clen=5044939&dur=313.8&sig=SIG_140",
				Ext:           "m4a",
				Protocol:      "https",
				VCodec:        "none",
				ACodec:        "mp4a.40.2",
				ABR:           &abr140,
				ASR:           &asr44,
				AudioChannels: &ch2,
				Filesize:      &sz140,
			},
			{
				FormatID:      "171",
				URL:           "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=171&source=youtube&clen=5500000&dur=313.8&sig=SIG_171",
				Ext:           "webm",
				Protocol:      "https",
				VCodec:        "none",
				ACodec:        "vorbis",
				ABR:           &abr171,
				ASR:           &asr44,
				AudioChannels: &ch2,
				Filesize:      &sz171,
			},
			{
				FormatID:      "251",
				URL:           "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=251&source=youtube&clen=6407118&dur=313.8&sig=SIG_251",
				Ext:           "webm",
				Protocol:      "https",
				VCodec:        "none",
				ACodec:        "opus",
				ABR:           &abr251,
				ASR:           &asr48,
				AudioChannels: &ch2,
				Filesize:      &sz251,
			},
		},
	}, ytOpts, now)

	for viewName, view := range map[string]unified.Object{
		"normal": unified.PublicView(env, false, now),
		"debug":  unified.PublicView(env, true, now),
	} {
		if err := unified.ValidateEnvelopeAt(view, now); err != nil {
			t.Fatalf("dual-container audio %s envelope failed ValidateEnvelopeAt: %v", viewName, err)
		}
		item := unified.Map(unified.Slice(unified.Map(view["data"])["items"])[0])
		var sawAAC, sawOpus bool
		var audioVariantCount int
		for _, rawV := range unified.Slice(item["variants"]) {
			v := unified.Map(rawV)
			meta := unified.Map(v["metadata"])
			mime := unified.Str(meta["mime_type"])
			if !strings.HasPrefix(mime, "audio/") {
				continue
			}
			audioVariantCount++
			src := unified.Map(unified.Slice(unified.Map(v["delivery"])["sources"])[0])
			srcURL := unified.Str(src["url"])
			switch unified.Str(meta["container"]) {
			case "mp4":
				sawAAC = true
				if unified.Str(meta["extension"]) != "m4a" || unified.Str(meta["audio_codec"]) != "mp4a.40.2" || !strings.Contains(srcURL, "itag=140") {
					t.Fatalf("unexpected mp4/m4a audio variant in %s: %+v url=%s", viewName, meta, srcURL)
				}
			case "webm":
				sawOpus = true
				if unified.Str(meta["extension"]) != "webm" || unified.Str(meta["audio_codec"]) != "opus" || !strings.Contains(srcURL, "itag=251") {
					t.Fatalf("expected best webm audio variant to prefer opus (itag=251) over vorbis (itag=171) in %s: %+v url=%s", viewName, meta, srcURL)
				}
			}
		}
		if !sawAAC || !sawOpus || audioVariantCount != 2 {
			t.Fatalf("expected exactly 2 deduplicated standalone audio variants (mp4/AAC + webm/Opus) in %s, got count=%d sawAAC=%v sawOpus=%v", viewName, audioVariantCount, sawAAC, sawOpus)
		}
	}
}

func TestWithExtractorsCommandArgsAndSubprocess(t *testing.T) {
	base := &Engine{socketTimeoutSec: 15}
	target := "https://www.facebook.com/watch/?v=647537299265662"

	defaultArgs := base.CommandArgs(target)
	for _, arg := range defaultArgs {
		if arg == "--use-extractors" {
			t.Fatalf("default engine must not emit --use-extractors, got %v", defaultArgs)
		}
	}

	pinned := base.WithExtractors("facebook", "facebook:reel", "facebook")
	args := pinned.CommandArgs(target)
	n := len(args)
	if n < 5 ||
		args[n-5] != "--use-extractors" ||
		args[n-4] != "facebook,facebook:reel" ||
		args[n-3] != "-J" ||
		args[n-2] != "--" ||
		args[n-1] != target {
		t.Fatalf("unexpected --use-extractors CLI tail: %v", args)
	}

	if runtime.GOOS == "windows" {
		return
	}
	dir := t.TempDir()
	fakeBin := filepath.Join(dir, "yt-dlp")
	script := "#!/bin/sh\nseen=''\nprev=''\nfor a in \"$@\"; do\n  if [ \"$prev\" = \"--use-extractors\" ]; then seen=\"$a\"; fi\n  prev=\"$a\"\ndone\nif [ \"$seen\" != \"facebook,facebook:reel\" ]; then\n  echo \"ERROR: missing --use-extractors ($seen)\" >&2\n  exit 1\nfi\necho '{\"id\":\"647537299265662\",\"title\":\"FB Test\",\"formats\":[{\"format_id\":\"hd\",\"url\":\"https://video-nrt6-1.xx.fbcdn.net/v/sample.mp4\",\"ext\":\"mp4\",\"protocol\":\"https\"}]}'\n"
	if err := os.WriteFile(fakeBin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(script))
	digest := hex.EncodeToString(sum[:])

	eng, err := New(Config{
		BinaryPath:    fakeBin,
		AllowedHashes: map[string]string{digest: "yt-dlp-test"},
	})
	if err != nil {
		t.Fatal(err)
	}
	fbEng := eng.WithExtractors("facebook", "facebook:reel")
	info, err := fbEng.Extract(context.Background(), target)
	if err != nil || info == nil || info.ID != "647537299265662" {
		t.Fatalf("expected subprocess with --use-extractors to succeed, got info=%+v err=%v", info, err)
	}
}

func TestSingleStreamHLSOnlyFiltering(t *testing.T) {
	const now int64 = 1762300800
	w1080, h1080 := int64(1920), int64(1080)
	w720, h720 := int64(1280), int64(720)
	fps60 := float64(60)
	sz := int64(5000000)

	info := &Info{
		ID:       "xbvrdzy",
		Title:    "Single Stream HLS Filter Test",
		Uploader: "Creator",
		Formats: []Format{
			// 1. Progressive MP4 (must be excluded in SingleStreamHLSOnly mode)
			{
				FormatID: "http-720",
				URL:      "https://vod2.cf.dmcdn.net/progressive/720.mp4",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w720,
				Height:   &h720,
				VCodec:   "avc1.64001f",
				ACodec:   "mp4a.40.2",
				Filesize: &sz,
			},
			// 2. Video-only HLS needing external #EXT-X-MEDIA audio (must be excluded)
			{
				FormatID: "hls-video-only",
				URL:      "https://vod2.cf.dmcdn.net/adaptive/video.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    &w1080,
				Height:   &h1080,
				VCodec:   "avc1.64002a",
				ACodec:   "none",
			},
			// 3. Audio-only HLS (must be excluded)
			{
				FormatID: "hls-audio-only",
				URL:      "https://vod2.cf.dmcdn.net/adaptive/audio.m3u8",
				Ext:      "m4a",
				Protocol: "m3u8_native",
				VCodec:   "none",
				ACodec:   "mp4a.40.2",
			},
			// 4. Unknown-codec HLS (must be excluded)
			{
				FormatID: "hls-unknown",
				URL:      "https://vod2.cf.dmcdn.net/sec2(tok)/cloud/fmp4/1/unknown/manifest.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
			},
			// 5. Legacy Dailymotion MPEG-TS HLS lacking /fmp4/ (must be excluded even with ext=="mp4" and codecs)
			{
				FormatID: "hls-legacy-ts",
				URL:      "https://vod3.cf.dmcdn.net/sec2(tok)/video/790/233/154332097_mp4_h264_aac_hd.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    &w720,
				Height:   &h720,
				VCodec:   "avc1.64001f",
				ACodec:   "mp4a.40.2",
			},
			// 6. Verified single-stream combined fMP4 HLS (must be kept!)
			{
				FormatID: "hls-1080@60",
				URL:      "https://vod2.cf.dmcdn.net/sec2(tok)/cloud/fmp4/1/h264_aac_fhd_hfr/2/manifest.m3u8",
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    &w1080,
				Height:   &h1080,
				FPS:      &fps60,
				VCodec:   "avc1.64002a",
				ACodec:   "mp4a.40.2",
			},
		},
	}

	opts := AdaptOptions{
		PlatformID:          "dailymotion",
		ContentID:           "xbvrdzy",
		SourceURL:           "https://www.dailymotion.com/video/xbvrdzy",
		SingleStreamHLSOnly: true,
		AllowedMediaURL: func(raw string) bool {
			return strings.Contains(raw, ".dmcdn.net/")
		},
	}
	probed := false
	PopulateMissingMP4Sizes(context.Background(), info, func(context.Context, string) (int64, bool) {
		probed = true
		return 1234, true
	}, opts)
	if probed {
		t.Fatal("PopulateMissingMP4Sizes must not probe when SingleStreamHLSOnly is true")
	}

	env := AdaptInfo(info, opts, now)
	if err := unified.ValidateEnvelopeAt(env, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}
	pub := unified.PublicView(env, false, now)
	if err := unified.ValidateEnvelopeAt(pub, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt(PublicView) failed: %v", err)
	}

	item := unified.Map(unified.Slice(unified.Map(pub["data"])["items"])[0])
	if item["default"] != nil || unified.Str(item["default_unavailable_reason"]) != "processing_required" {
		t.Fatalf("expected null default with processing_required, got default=%v reason=%v", item["default"], item["default_unavailable_reason"])
	}
	variants := unified.Slice(item["variants"])
	if len(variants) != 1 {
		t.Fatalf("expected exactly 1 verified single-stream HLS variant, got %d: %+v", len(variants), variants)
	}
	v := unified.Map(variants[0])
	delivery := unified.Map(v["delivery"])
	if unified.Str(delivery["kind"]) != "hls" || unified.Str(delivery["scope"]) != "single" {
		t.Fatalf("expected kind=hls scope=single, got %+v", delivery)
	}
	if _, hasSel := delivery["selection"]; hasSel {
		t.Fatalf("single-stream HLS must not set selection: %+v", delivery)
	}
	if unified.Str(v["label"]) != "1080p60" {
		t.Fatalf("expected label 1080p60, got %v", v["label"])
	}

	// Live streams (is_live == true) must never be emitted as single-stream VOD HLS.
	isLive := true
	liveInfo := *info
	liveInfo.IsLive = &isLive
	liveEnv := AdaptInfo(&liveInfo, opts, now)
	if err := unified.ValidateEnvelopeAt(liveEnv, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt(liveEnv) failed: %v", err)
	}
	if unified.Str(liveEnv["code"]) != "NO_MEDIA" {
		t.Fatalf("expected live stream to return NO_MEDIA in SingleStreamHLSOnly mode, got %+v", liveEnv)
	}
}

type ytLockedLogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *ytLockedLogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *ytLockedLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestPopulateMissingMP4SizesRecoversProberPanicWithoutDeadlock(t *testing.T) {
	var logBuf ytLockedLogBuffer
	origOut := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(origOut) })

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	const totalFormats = sizeProbeConcurrency + 2
	w, h := int64(1280), int64(720)
	formats := make([]Format, 0, totalFormats)
	for i := 0; i < totalFormats; i++ {
		formats = append(formats, Format{
			FormatID: fmt.Sprintf("mp4-%d", i),
			URL:      fmt.Sprintf("https://cdn.example.com/media/v%d.mp4", i),
			Ext:      "mp4",
			Protocol: "https",
			Width:    &w,
			Height:   &h,
			VCodec:   "avc1.4d401f",
			ACodec:   "mp4a.40.2",
		})
	}
	info := &Info{ID: "vid1", Formats: formats}
	opts := AdaptOptions{
		PlatformID: "youtube",
		ContentID:  "vid1",
		SourceURL:  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		AllowedMediaURL: func(raw string) bool {
			return strings.HasPrefix(raw, "https://cdn.example.com/")
		},
	}

	start := time.Now()
	PopulateMissingMP4Sizes(ctx, info, func(_ context.Context, u string) (int64, bool) {
		for i := 0; i < sizeProbeConcurrency; i++ {
			if strings.HasSuffix(u, fmt.Sprintf("/v%d.mp4", i)) {
				panic("ytengine-probe-secret-" + u + "?sig=ytprobesecret")
			}
		}
		return 3141592, true
	}, opts)
	elapsed := time.Since(start)
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("PopulateMissingMP4Sizes blocked for %v on prober panic", elapsed)
	}

	for i := 0; i < sizeProbeConcurrency; i++ {
		if info.Formats[i].Filesize != nil {
			t.Fatalf("panicking format %d unexpectedly got Filesize=%v", i, *info.Formats[i].Filesize)
		}
	}
	for i := sizeProbeConcurrency; i < totalFormats; i++ {
		if info.Formats[i].Filesize == nil || *info.Formats[i].Filesize != 3141592 {
			t.Fatalf("healthy format %d expected Filesize=3141592, got %v", i, info.Formats[i].Filesize)
		}
	}

	logged := logBuf.String()
	if strings.Count(logged, "ytengine: size probe goroutine panic recovered: panic_type=") != sizeProbeConcurrency {
		t.Fatalf("expected %d sanitized size probe panic logs, got %q", sizeProbeConcurrency, logged)
	}
	for _, forbidden := range []string{"ytengine-probe-secret", "ytprobesecret", "cdn.example.com"} {
		if strings.Contains(logged, forbidden) {
			t.Fatalf("panic recovery log leaked sensitive value %q: %q", forbidden, logged)
		}
	}
}

func TestSortAudioFormatsStrictWeakOrdering(t *testing.T) {
	abr := 128.0
	ch := int64(2)
	makeFmt := func(id, tag string) Format {
		return Format{
			FormatID:      id,
			URL:           "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&tag=" + tag,
			Ext:           "m4a",
			Protocol:      "https",
			VCodec:        "none",
			ACodec:        "mp4a.40.2",
			ABR:           &abr,
			AudioChannels: &ch,
		}
	}

	// Probe the exact strict-less relation induced by sortAudioFormats via 2-element SliceStable:
	// [b, a] swaps to [a, b] iff less(a, b) is true.
	less := func(aID, bID string) bool {
		pair := []Format{makeFmt(bID, "b"), makeFmt(aID, "a")}
		sortAudioFormats(pair)
		return strings.HasSuffix(pair[0].URL, "tag=a")
	}
	incomp := func(aID, bID string) bool {
		return !less(aID, bID) && !less(bID, aID)
	}

	ids := []string{"140", "140-dup2", "140-0", "140-drc", "140-dup3", "139"}
	for _, a := range ids {
		if less(a, a) {
			t.Fatalf("irreflexivity violated: less(%q, %q) == true", a, a)
		}
		for _, b := range ids {
			if less(a, b) && less(b, a) {
				t.Fatalf("asymmetry violated for (%q, %q)", a, b)
			}
			for _, c := range ids {
				if less(a, b) && less(b, c) && !less(a, c) {
					t.Fatalf("transitivity violated: less(%q, %q) && less(%q, %q), but !less(%q, %q)", a, b, b, c, a, c)
				}
				if incomp(a, b) && incomp(b, c) && !incomp(a, c) {
					t.Fatalf("transitivity of incomparability violated for (%q, %q, %q): less(a,c)=%v less(c,a)=%v",
						a, b, c, less(a, c), less(c, a))
				}
			}
		}
	}

	// Deterministic sort.SliceStable output on ["140", "140-dup2", "140-0", "140-drc"]:
	// - "140-0" has baseFormatID "140-0" > "140" (and non-DRC) -> first
	// - "140" and "140-dup2" share baseFormatID "140" -> SliceStable preserves ["140", "140-dup2"]
	// - "140-drc" is deprioritized by DRC penalty -> last
	formats := []Format{
		makeFmt("140", "first-140"),
		makeFmt("140-dup2", "dup2-140"),
		makeFmt("140-0", "zero-140"),
		makeFmt("140-drc", "drc-140"),
	}
	sortAudioFormats(formats)
	gotOrder := []string{formats[0].FormatID, formats[1].FormatID, formats[2].FormatID, formats[3].FormatID}
	wantOrder := []string{"140-0", "140", "140-dup2", "140-drc"}
	for i := range wantOrder {
		if gotOrder[i] != wantOrder[i] {
			t.Fatalf("sortAudioFormats([140, 140-dup2, 140-0, 140-drc]) = %v, want %v", gotOrder, wantOrder)
		}
	}

	// Reversing "140-dup2" before "140" also preserves stability among equal baseFormatIDs while keeping "140-0" first and "140-drc" last.
	reversedDup := []Format{
		makeFmt("140-drc", "drc-140"),
		makeFmt("140-dup2", "dup2-140"),
		makeFmt("140-0", "zero-140"),
		makeFmt("140", "first-140"),
	}
	sortAudioFormats(reversedDup)
	gotRev := []string{reversedDup[0].FormatID, reversedDup[1].FormatID, reversedDup[2].FormatID, reversedDup[3].FormatID}
	wantRev := []string{"140-0", "140-dup2", "140", "140-drc"}
	for i := range wantRev {
		if gotRev[i] != wantRev[i] {
			t.Fatalf("sortAudioFormats([140-drc, 140-dup2, 140-0, 140]) = %v, want %v", gotRev, wantRev)
		}
	}
}

func TestClassifyStderrUnsupportedURLFlag(t *testing.T) {
	unsupportedCases := []string{
		"ERROR: Unsupported URL: https://example.com/article/123",
		"ERROR: No suitable extractor found for URL https://example.com/article/123",
	}
	for _, msg := range unsupportedCases {
		got := classifyStderr(msg, errors.New("exit status 1"))
		if got.Code != CodeContentUnavailable || got.Retryable || !got.UnsupportedURL {
			t.Fatalf("classifyStderr(%q) = %+v, want Code=CONTENT_UNAVAILABLE Retryable=false UnsupportedURL=true", msg, got)
		}
		if got.Message != "未找到可用的媒体，或该内容已不可访问" {
			t.Fatalf("classifyStderr(%q).Message = %q, want backwards-compatible Tier-1 message", msg, got.Message)
		}
	}

	nonUnsupportedCases := []struct {
		stderr   string
		wantCode ErrorCode
	}{
		{"ERROR: [twitter] 123: No video could be found in this tweet", CodeContentUnavailable},
		{"ERROR: [vimeo] 123: HTTP Error 404: Not Found", CodeContentUnavailable},
		{"ERROR: [vimeo] 123: HTTP Error 429: Too Many Requests", CodeRateLimited},
		{"ERROR: [vimeo] 123: Private video; please sign in", CodeUpstreamBlocked},
		{"ERROR: [vimeo] 123: timed out", CodeUpstreamTimeout},
		{"ERROR: upstream blocked by outbound security policy", CodeUpstreamBlocked},
	}
	for _, tc := range nonUnsupportedCases {
		got := classifyStderr(tc.stderr, errors.New("exit status 1"))
		if got.Code != tc.wantCode || got.UnsupportedURL {
			t.Fatalf("classifyStderr(%q) = %+v, want Code=%s UnsupportedURL=false", tc.stderr, got, tc.wantCode)
		}
	}
}

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
