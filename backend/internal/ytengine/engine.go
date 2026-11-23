// Adapted from wader/goutubedl and lrstanley/go-ytdlp (MIT License).
package ytengine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
)

// PinnedVersion is the locked yt-dlp release approved for this build.
const PinnedVersion = "2026.10.26"

const (
	defaultStaleTempMaxAge     = 2 * time.Hour
	defaultStartupCheckTimeout = 5 * time.Second
	defaultExtractTimeout      = 25 * time.Second
	minExtractTimeout          = 2 * time.Second
	maxExtractTimeout          = 40 * time.Second
	defaultSocketTimeoutSec    = 15
	defaultMaxStdoutBytes      = 16 << 20 // 16 MiB
	defaultMaxStderrBytes      = 64 << 10 // 64 KiB
	maxBinaryFileBytes         = 128 << 20
)

var staleTempCleanupOnce sync.Once

// OfficialSHA256Sums contains the official SHA2-256SUMS for PinnedVersion
// (https://github.com/yt-dlp/yt-dlp/releases/download/<PinnedVersion>/SHA2-256SUMS).
var OfficialSHA256Sums = map[string]string{
	"e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3": "yt-dlp",
	"767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795": "yt-dlp_linux",
	"e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483": "yt-dlp_linux_aarch64",
	"0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa": "yt-dlp_macos",
	"f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d": "yt-dlp.exe",
	"0066dbac3c124028e2dcae2a197fccee33cd91f456313d24f7af89fd54590e98": "yt-dlp_arm64.exe",
}

// Config configures a verified yt-dlp metadata extraction engine.
type Config struct {
	BinaryPath          string
	AllowedHashes       map[string]string
	AllowedURL          func(string) bool
	AllowedOutboundHost func(string) bool
	Resolver            Resolver
	SharedSemaphore     chan struct{}
	DialAddr            func(netip.Addr, string) string
	MaxConcurrency      int
	Timeout             time.Duration
	SocketTimeoutSec    int
	MaxStdoutBytes      int64
	ProxyURL            string
	EnvPath             string
	GatePorts           []int
	Extractors          []string
}

// Engine executes a SHA-256 verified yt-dlp binary in isolated metadata-only mode.
type Engine struct {
	enabled             bool
	disableReason       string
	binaryPath          string
	binarySHA256        string
	binaryAsset         string
	pythonPath          string
	allowedURL          func(string) bool
	allowedOutboundHost func(string) bool
	resolver            Resolver
	dialAddr            func(netip.Addr, string) string
	sem                 chan struct{}
	subSem              chan struct{}
	timeout             time.Duration
	socketTimeoutSec    int
	maxStdoutBytes      int64
	proxyURL            string
	envPath             string
	gatePorts           *gatePortPool
	slotStats           *slotStats
	extractors          []string
}

// CleanupStaleTempDirs removes orphaned dokitool-ytdlp-* directories in tmpRoot
// that are owned by the current service UID, are not symlinks, and whose
// modification time is older than maxAge (defaulting to 2 hours).
func CleanupStaleTempDirs(tmpRoot string, maxAge time.Duration) int {
	return cleanupStaleTempDirsForUID(tmpRoot, maxAge, os.Geteuid())
}

func cleanupStaleTempDirsForUID(tmpRoot string, maxAge time.Duration, expectedUID int) int {
	trimmed := strings.TrimSpace(tmpRoot)
	if trimmed == "" {
		return 0
	}
	if maxAge <= 0 {
		maxAge = defaultStaleTempMaxAge
	}
	entries, err := os.ReadDir(trimmed)
	if err != nil {
		return 0
	}
	cutoff := time.Now().Add(-maxAge)
	cleaned := 0
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "dokitool-ytdlp-") {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			continue
		}
		fullPath := filepath.Join(trimmed, name)
		info, err := os.Lstat(fullPath)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			continue
		}
		if !dirOwnedByUID(info, expectedUID) {
			continue
		}
		if info.ModTime().IsZero() || info.ModTime().After(cutoff) {
			continue
		}
		if err := os.RemoveAll(fullPath); err == nil {
			cleaned++
		}
	}
	return cleaned
}

func detectPythonZipapp(absPath string) bool {
	stat, err := os.Stat(absPath)
	if err != nil || !stat.Mode().IsRegular() {
		return false
	}
	f, err := os.Open(absPath)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, 512)
	n, _ := f.Read(buf)
	if n < 4 {
		return false
	}
	head := buf[:n]
	if !bytes.HasPrefix(head, []byte("#!")) {
		return false
	}
	nl := bytes.IndexByte(head, '\n')
	firstLine := head
	var rest []byte
	if nl >= 0 {
		firstLine = head[:nl]
		rest = head[nl+1:]
	}
	if !strings.Contains(strings.ToLower(string(firstLine)), "python") {
		return false
	}
	if bytes.Contains(rest, []byte("PK\x03\x04")) {
		return true
	}
	return stat.Mode()&0o111 == 0
}

func lookupPython3InPath(envPath string) string {
	searchPath := envPath
	if strings.TrimSpace(searchPath) == "" {
		searchPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
	}
	for _, dir := range filepath.SplitList(searchPath) {
		trimmedDir := strings.TrimSpace(dir)
		if trimmedDir == "" {
			continue
		}
		for _, candidateName := range []string{"python3", "python3.exe"} {
			candidate := filepath.Join(trimmedDir, candidateName)
			stat, err := os.Stat(candidate)
			if err != nil || !stat.Mode().IsRegular() {
				continue
			}
			return candidate
		}
	}
	return ""
}

func verifyStartupVersion(pythonPath, binaryPath, envPath string) error {
	tempDir, err := os.MkdirTemp("", "dokitool-ytdlp-check-*")
	if err != nil {
		return fmt.Errorf("create startup check temp dir: %w", err)
	}
	defer os.RemoveAll(tempDir)
	for _, sub := range []string{"cache", "config", "data", "tmp"} {
		if err := os.MkdirAll(filepath.Join(tempDir, sub), 0o700); err != nil {
			return fmt.Errorf("init startup check temp dir: %w", err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), defaultStartupCheckTimeout)
	defer cancel()

	args := []string{
		"--ignore-config",
		"--no-plugin-dirs",
		"--no-warnings",
		"--version",
	}
	var cmd *exec.Cmd
	if pythonPath != "" {
		pyArgs := make([]string, 0, len(args)+1)
		pyArgs = append(pyArgs, binaryPath)
		pyArgs = append(pyArgs, args...)
		cmd = exec.CommandContext(ctx, pythonPath, pyArgs...)
	} else {
		cmd = exec.CommandContext(ctx, binaryPath, args...)
	}
	cmd.Dir = tempDir
	cmd.Stdin = nil
	cmd.Env = buildIsolatedEnv(tempDir, envPath)
	configureProcessGroup(cmd)

	stdout := &limitedBuffer{max: 4096}
	stderr := &limitedBuffer{max: 4096}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	if err := cmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg != "" {
			return fmt.Errorf("%w (%s)", err, errMsg)
		}
		return err
	}
	gotVersion := strings.TrimSpace(stdout.String())
	if gotVersion != PinnedVersion {
		return fmt.Errorf("yt-dlp --version returned %q, want %q", gotVersion, PinnedVersion)
	}
	return nil
}

// NewDisabled returns an Engine that is explicitly disabled with the given reason.
func NewDisabled(reason string) *Engine {
	if strings.TrimSpace(reason) == "" {
		reason = "yt-dlp engine is not configured"
	}
	return &Engine{
		enabled:       false,
		disableReason: reason,
		slotStats:     newSlotStats(),
	}
}

// VerifyBinary verifies that binaryPath is a regular executable file whose SHA-256
// matches one of the allowed digests (defaulting to OfficialSHA256Sums).
func VerifyBinary(binaryPath string, allowedHashes map[string]string) (string, string, string, error) {
	trimmed := strings.TrimSpace(binaryPath)
	if trimmed == "" {
		return "", "", "", errors.New("yt-dlp binary path is empty")
	}
	absPath, err := filepath.Abs(trimmed)
	if err != nil {
		return "", "", "", fmt.Errorf("resolve yt-dlp binary path: %w", err)
	}
	stat, err := os.Stat(absPath)
	if err != nil {
		return "", "", "", fmt.Errorf("stat yt-dlp binary: %w", err)
	}
	if !stat.Mode().IsRegular() {
		return "", "", "", errors.New("yt-dlp binary must be a regular file")
	}
	if stat.Size() <= 0 || stat.Size() > maxBinaryFileBytes {
		return "", "", "", fmt.Errorf("yt-dlp binary size %d is out of bounds", stat.Size())
	}
	file, err := os.Open(absPath)
	if err != nil {
		return "", "", "", fmt.Errorf("open yt-dlp binary: %w", err)
	}
	defer file.Close()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, io.LimitReader(file, maxBinaryFileBytes+1)); err != nil {
		return "", "", "", fmt.Errorf("hash yt-dlp binary: %w", err)
	}
	digest := hex.EncodeToString(hasher.Sum(nil))

	hashes := allowedHashes
	if len(hashes) == 0 {
		hashes = OfficialSHA256Sums
	}
	asset, ok := hashes[strings.ToLower(digest)]
	if !ok {
		return "", digest, "", fmt.Errorf("yt-dlp binary sha256 %s does not match pinned release %s", digest, PinnedVersion)
	}
	return absPath, digest, asset, nil
}

func lookupBinaryInPath(envPath string) (string, error) {
	for _, dir := range filepath.SplitList(envPath) {
		trimmedDir := strings.TrimSpace(dir)
		if trimmedDir == "" {
			continue
		}
		for _, candidateName := range []string{"yt-dlp", "yt-dlp.exe"} {
			candidate := filepath.Join(trimmedDir, candidateName)
			stat, err := os.Stat(candidate)
			if err != nil || !stat.Mode().IsRegular() {
				continue
			}
			return candidate, nil
		}
	}
	return "", errors.New("yt-dlp binary not found in DOKITOOL_YTDLP_BINARY or PATH")
}

// New verifies the configured yt-dlp binary and returns an Engine.
// When verification fails, New returns both a disabled *Engine and the verification
// error so the caller can log a startup warning without crashing the API process.
func New(cfg Config) (*Engine, error) {
	staleTempCleanupOnce.Do(func() {
		CleanupStaleTempDirs(os.TempDir(), defaultStaleTempMaxAge)
	})
	envPath := cfg.EnvPath
	if envPath == "" {
		envPath = os.Getenv("PATH")
	}
	binaryPath := strings.TrimSpace(cfg.BinaryPath)
	if binaryPath == "" {
		discovered, err := lookupBinaryInPath(envPath)
		if err != nil {
			return NewDisabled(err.Error()), err
		}
		binaryPath = discovered
	}
	absPath, digest, asset, err := VerifyBinary(binaryPath, cfg.AllowedHashes)
	if err != nil {
		return NewDisabled(err.Error()), err
	}
	concurrency := cfg.MaxConcurrency
	if concurrency <= 0 {
		concurrency = defaultMaxConcurrency
	}
	if concurrency > maxAllowedConcurrency {
		return NewDisabled("yt-dlp concurrency exceeds limit"), fmt.Errorf("yt-dlp concurrency %d exceeds max %d", concurrency, maxAllowedConcurrency)
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultExtractTimeout
	}
	if timeout < minExtractTimeout || timeout > maxExtractTimeout {
		return NewDisabled("yt-dlp timeout out of bounds"), fmt.Errorf("yt-dlp timeout %s must be between %s and %s", timeout, minExtractTimeout, maxExtractTimeout)
	}
	socketTimeout := cfg.SocketTimeoutSec
	if socketTimeout <= 0 {
		socketTimeout = defaultSocketTimeoutSec
	}
	if socketTimeout > 30 {
		socketTimeout = 30
	}
	maxStdout := cfg.MaxStdoutBytes
	if maxStdout <= 0 {
		maxStdout = defaultMaxStdoutBytes
	}
	proxyURL := strings.TrimSpace(cfg.ProxyURL)
	if proxyURL != "" {
		if err := validateProxyURL(proxyURL); err != nil {
			return NewDisabled(err.Error()), err
		}
		if cfg.AllowedOutboundHost != nil || cfg.Resolver != nil {
			err := errors.New("DOKITOOL_YTDLP_PROXY is not supported when outbound target policy is enabled")
			return NewDisabled(err.Error()), err
		}
	}
	sem := cfg.SharedSemaphore
	if sem == nil {
		sem = make(chan struct{}, concurrency)
	}
	gatePorts, err := newGatePortPool(cfg.GatePorts, cap(sem))
	if err != nil {
		return NewDisabled(err.Error()), err
	}
	var pythonPath string
	if detectPythonZipapp(absPath) {
		pythonPath = lookupPython3InPath(envPath)
		if pythonPath != "" {
			if err := verifyStartupVersion(pythonPath, absPath, envPath); err != nil {
				log.Printf("dokitool: yt-dlp python3 zipapp self-check failed (%v); attempting direct binary execution fallback", err)
				pythonPath = ""
				if directErr := verifyStartupVersion("", absPath, envPath); directErr != nil {
					reason := fmt.Sprintf("yt-dlp zipapp startup self-check failed (python3: %v; direct: %v)", err, directErr)
					log.Printf("dokitool: %s; disabling yt-dlp engine", reason)
					return NewDisabled(reason), errors.New(reason)
				}
				log.Printf("dokitool: yt-dlp zipapp direct binary execution fallback succeeded (version %s)", PinnedVersion)
			}
		} else {
			if directErr := verifyStartupVersion("", absPath, envPath); directErr != nil {
				reason := fmt.Sprintf("yt-dlp zipapp startup self-check failed without python3 in PATH: %v", directErr)
				log.Printf("dokitool: %s; disabling yt-dlp engine", reason)
				return NewDisabled(reason), errors.New(reason)
			}
		}
	}
	return &Engine{
		gatePorts:           gatePorts,
		slotStats:           newSlotStats(),
		enabled:             true,
		binaryPath:          absPath,
		binarySHA256:        digest,
		binaryAsset:         asset,
		pythonPath:          pythonPath,
		allowedURL:          cfg.AllowedURL,
		allowedOutboundHost: cfg.AllowedOutboundHost,
		resolver:            cfg.Resolver,
		dialAddr:            cfg.DialAddr,
		sem:                 sem,
		timeout:             timeout,
		socketTimeoutSec:    socketTimeout,
		maxStdoutBytes:      maxStdout,
		proxyURL:            proxyURL,
		envPath:             envPath,
		extractors:          normalizeExtractors(cfg.Extractors),
	}, nil
}

func normalizeExtractors(raw []string) []string {
	if len(raw) == 0 {
		return nil
	}
	out := make([]string, 0, len(raw))
	seen := make(map[string]bool, len(raw))
	for _, item := range raw {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// WithGenericConcurrency returns a shallow copy of the Engine configured for
// isolated Tier-2 generic concurrency (limit clamped to 1..MaxConcurrency,
// defaulting to DefaultConcurrency when <= 0).
//
// When gatePorts is nil (dynamic loopback ports), the copy gets an independent
// semaphore and fresh slotStats so generic traffic never contends with Tier-1.
// When gatePorts is non-nil (fixed DOKITOOL_YTDLP_GATE_PORTS), the copy retains
// the shared semaphore and port pool so total listeners never exceed configured
// fixed ports, and attaches a dedicated subSem capped at min(limit, cap(e.sem)).
func (e *Engine) WithGenericConcurrency(limit int) *Engine {
	if e == nil {
		return NewDisabled("yt-dlp engine is nil")
	}
	if limit <= 0 {
		limit = DefaultConcurrency
	}
	if limit > MaxConcurrency {
		limit = MaxConcurrency
	}
	cp := *e
	if e.gatePorts == nil {
		cp.sem = make(chan struct{}, limit)
		cp.subSem = nil
		cp.slotStats = newSlotStats()
		return &cp
	}
	subLimit := limit
	if e.sem != nil && cap(e.sem) > 0 && subLimit > cap(e.sem) {
		subLimit = cap(e.sem)
	}
	cp.subSem = make(chan struct{}, subLimit)
	return &cp
}

// WithExtractors returns a shallow copy of the Engine pinned to the given yt-dlp
// extractor names (passed via --use-extractors) so generic fallback cannot occur.
func (e *Engine) WithExtractors(extractors ...string) *Engine {
	if e == nil {
		return NewDisabled("yt-dlp engine is nil")
	}
	cp := *e
	cp.extractors = normalizeExtractors(extractors)
	return &cp
}

// WithTargetPolicy returns a shallow copy of the Engine bound to the given input URL
// and outbound host policies while sharing the concurrency semaphore and port pool.
func (e *Engine) WithTargetPolicy(allowedURL func(string) bool, allowedOutboundHost func(string) bool) *Engine {
	if e == nil {
		return NewDisabled("yt-dlp engine is nil")
	}
	cp := *e
	cp.allowedURL = allowedURL
	cp.allowedOutboundHost = allowedOutboundHost
	if cp.resolver == nil {
		cp.resolver = net.DefaultResolver
	}
	if cp.proxyURL != "" && (cp.allowedOutboundHost != nil || cp.resolver != nil) {
		cp.enabled = false
		cp.disableReason = "DOKITOOL_YTDLP_PROXY is not supported when outbound target policy is enabled"
	}
	return &cp
}

// NewFromEnv constructs an Engine from DOKITOOL_YTDLP_* environment variables.
func NewFromEnv(getenv func(string) string, allowedURL func(string) bool) (*Engine, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	concurrency := defaultMaxConcurrency
	if raw := strings.TrimSpace(getenv("DOKITOOL_YTDLP_CONCURRENCY")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxAllowedConcurrency {
			err := fmt.Errorf("DOKITOOL_YTDLP_CONCURRENCY must be an integer between 1 and %d", maxAllowedConcurrency)
			return NewDisabled(err.Error()), err
		}
		concurrency = n
	}
	timeout := defaultExtractTimeout
	if raw := strings.TrimSpace(getenv("DOKITOOL_YTDLP_TIMEOUT")); raw != "" {
		parsed, err := time.ParseDuration(raw)
		if err != nil {
			if sec, secErr := strconv.Atoi(raw); secErr == nil && sec > 0 {
				parsed = time.Duration(sec) * time.Second
				err = nil
			}
		}
		if err != nil || parsed < minExtractTimeout || parsed > maxExtractTimeout {
			err := fmt.Errorf("DOKITOOL_YTDLP_TIMEOUT must be a duration between %s and %s", minExtractTimeout, maxExtractTimeout)
			return NewDisabled(err.Error()), err
		}
		timeout = parsed
	}
	gatePorts, err := parseGatePorts(getenv("DOKITOOL_YTDLP_GATE_PORTS"))
	if err != nil {
		return NewDisabled(err.Error()), err
	}
	return New(Config{
		GatePorts:      gatePorts,
		BinaryPath:     getenv("DOKITOOL_YTDLP_BINARY"),
		AllowedHashes:  OfficialSHA256Sums,
		AllowedURL:     allowedURL,
		Resolver:       net.DefaultResolver,
		MaxConcurrency: concurrency,
		Timeout:        timeout,
		ProxyURL:       getenv("DOKITOOL_YTDLP_PROXY"),
		EnvPath:        getenv("PATH"),
	})
}

func (e *Engine) Enabled() bool {
	return e != nil && e.enabled
}

func (e *Engine) DisableReason() string {
	if e == nil {
		return "yt-dlp engine is nil"
	}
	return e.disableReason
}

func (e *Engine) BinarySHA256() string {
	if e == nil {
		return ""
	}
	return e.binarySHA256
}

func (e *Engine) BinaryAsset() string {
	if e == nil {
		return ""
	}
	return e.binaryAsset
}

// UsingPythonZipapp reports whether the verified yt-dlp asset is executed directly
// via python3 as a zero-unpack zipapp rather than a PyInstaller self-extracting binary.
func (e *Engine) UsingPythonZipapp() bool {
	return e != nil && e.pythonPath != ""
}

// CommandArgs returns the hardened CLI argument slice for a single URL extraction.
func (e *Engine) CommandArgs(targetURL string) []string {
	var proxy string
	if e != nil {
		proxy = e.proxyURL
	}
	return e.commandArgsWithProxy(targetURL, proxy)
}

func (e *Engine) commandArgsWithProxy(targetURL, effectiveProxy string) []string {
	socketSec := defaultSocketTimeoutSec
	if e != nil && e.socketTimeoutSec > 0 {
		socketSec = e.socketTimeoutSec
	}
	args := []string{
		"--ignore-config",
		"--no-plugin-dirs",
		"--no-playlist",
		"--no-warnings",
		"--no-progress",
		"--no-cache-dir",
		"--no-cookies-from-browser",
		"--js-runtimes", "deno",
		"--js-runtimes", "node",
		"--socket-timeout", strconv.Itoa(socketSec),
	}
	if effectiveProxy != "" {
		args = append(args, "--proxy", effectiveProxy)
	}
	if e != nil && len(e.extractors) > 0 {
		args = append(args, "--use-extractors", strings.Join(e.extractors, ","))
	}
	args = append(args, "-J", "--", targetURL)
	return args
}

func validateInputURL(raw string, allowed func(string) bool) *Error {
	if raw == "" || len(raw) > 2048 || strings.HasPrefix(raw, "-") {
		return &Error{Code: CodeInvalidInput, Message: "请输入对应平台的有效分享链接"}
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' {
			return &Error{Code: CodeInvalidInput, Message: "请输入对应平台的有效分享链接"}
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Fragment != "" {
		return &Error{Code: CodeInvalidInput, Message: "请输入对应平台的有效分享链接"}
	}
	scheme := strings.ToLower(u.Scheme)
	if (scheme != "http" && scheme != "https") || u.Hostname() == "" {
		return &Error{Code: CodeInvalidInput, Message: "请输入对应平台的有效分享链接"}
	}
	if allowed != nil && !allowed(raw) {
		return &Error{Code: CodeInvalidInput, Message: "请输入对应平台的有效分享链接"}
	}
	return nil
}

func validateProxyURL(raw string) error {
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f {
			return errors.New("DOKITOOL_YTDLP_PROXY contains invalid characters")
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.Opaque != "" || u.Fragment != "" {
		return errors.New("DOKITOOL_YTDLP_PROXY must be a valid proxy URL")
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https", "socks5", "socks5h":
	default:
		return errors.New("DOKITOOL_YTDLP_PROXY scheme must be http, https, socks5 or socks5h")
	}
	if ip, err := netip.ParseAddr(u.Hostname()); err == nil {
		if !ip.IsLoopback() && !fetch.PublicIP(ip) {
			return errors.New("DOKITOOL_YTDLP_PROXY IP literal must be loopback or public")
		}
	}
	return nil
}
