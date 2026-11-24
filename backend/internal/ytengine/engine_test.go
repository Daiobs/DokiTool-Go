package ytengine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
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
