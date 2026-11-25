//go:build canary

package youtube

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
)

const (
	canaryReportSchemaVersion = "1.0"
	defaultCanaryEJSTimeout   = 12 * time.Second
	canaryOverallTimeout      = 60 * time.Second
)

// canaryReport is the strictly sanitized, closed-vocabulary JSON summary emitted
// when DOKITOOL_CANARY_JSON_OUT is configured. It never contains URLs, IPs,
// raw HTML/JS, headers, cookies, or local filesystem paths.
type canaryReport struct {
	SchemaVersion      string `json:"schema_version"`
	PlayerID           string `json:"player_id"`
	Status             string `json:"status"`
	TVOK               bool   `json:"tv_ok"`
	MainOK             bool   `json:"main_ok"`
	TVErrorCode        string `json:"tv_error_code"`
	MainErrorCode      string `json:"main_error_code"`
	DiscoveryErrorCode string `json:"discovery_error_code"`
	ElapsedMS          int64  `json:"elapsed_ms"`
	DenoVersion        string `json:"deno_version"`
	EJSVersion         string `json:"ejs_version"`
	OverallOK          bool   `json:"overall_ok"`
}

func sanitizeCanaryPlayerID(raw string) string {
	id := strings.ToLower(strings.TrimSpace(raw))
	if !playerIDPattern.MatchString(id) {
		return ""
	}
	return id
}

func deriveCanaryStatus(tvOK, mainOK bool) string {
	switch {
	case tvOK && mainOK:
		return "ok"
	case !tvOK && mainOK:
		return "degraded_tv_only"
	case tvOK && !mainOK:
		return "degraded_main_only"
	default:
		return "outage"
	}
}

func isCanaryTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// classifyCanaryError maps arbitrary runtime errors into a closed uppercase
// ASCII error vocabulary so raw upstream messages, URLs, or paths never leak.
func classifyCanaryError(stage string, err error) string {
	if err == nil {
		return ""
	}
	msg := strings.ToLower(err.Error())
	switch stage {
	case "discovery":
		switch {
		case isCanaryTimeout(err):
			return "DISCOVERY_TIMEOUT"
		case errors.Is(err, fetch.ErrPolicy):
			return "DISCOVERY_POLICY_DENIED"
		case errors.Is(err, fetch.ErrLimit):
			return "DISCOVERY_SIZE_LIMIT"
		case strings.Contains(msg, "returned status"):
			return "DISCOVERY_HTTP_ERROR"
		case strings.Contains(msg, "player_id not found") || strings.Contains(msg, "invalid player_id"):
			return "DISCOVERY_PLAYER_ID_MISSING"
		default:
			return "DISCOVERY_FETCH_FAILED"
		}
	case "fetch":
		switch {
		case isCanaryTimeout(err):
			return "FETCH_TIMEOUT"
		case errors.Is(err, fetch.ErrPolicy):
			return "FETCH_POLICY_DENIED"
		case errors.Is(err, fetch.ErrLimit):
			return "FETCH_SIZE_LIMIT"
		case strings.Contains(msg, "returned status"):
			return "FETCH_HTTP_ERROR"
		case strings.Contains(msg, "signaturetimestamp"):
			return "STS_MISSING"
		default:
			return "FETCH_FAILED"
		}
	case "preprocess":
		switch {
		case isCanaryTimeout(err):
			return "EJS_TIMEOUT"
		case strings.Contains(msg, "stdout exceeded limit"):
			return "EJS_STDOUT_LIMIT"
		case strings.Contains(msg, "ejs n probe"):
			return "EJS_N_PROBE_FAILED"
		case strings.Contains(msg, "preprocessed_player") ||
			strings.Contains(msg, "ejs returned error") ||
			strings.Contains(msg, "invalid ejs output"):
			return "EJS_PREPROCESS_FAILED"
		default:
			return "EJS_EXEC_FAILED"
		}
	default:
		return "CANARY_INTERNAL_ERROR"
	}
}

func lookupPlayerVariant(name string) (playerJSVariant, bool) {
	for _, v := range playerJSVariants {
		if v.name == name {
			return v, true
		}
	}
	return playerJSVariant{}, false
}

func runCanaryProbe(ctx context.Context, h *Helper) canaryReport {
	started := time.Now()
	report := canaryReport{
		SchemaVersion: canaryReportSchemaVersion,
		Status:        "outage",
		DenoVersion:   PinnedDenoVersion,
		EJSVersion:    PinnedEJSVersion,
	}
	defer func() {
		elapsed := time.Since(started).Milliseconds()
		if elapsed < 0 {
			elapsed = 0
		}
		report.ElapsedMS = elapsed
	}()

	rawPlayerID, err := h.fetchCurrentPlayerID(ctx)
	if err != nil {
		report.DiscoveryErrorCode = classifyCanaryError("discovery", err)
		report.TVErrorCode = "SKIPPED_DISCOVERY_FAILED"
		report.MainErrorCode = "SKIPPED_DISCOVERY_FAILED"
		return report
	}
	playerID := sanitizeCanaryPlayerID(rawPlayerID)
	if playerID == "" {
		report.DiscoveryErrorCode = "DISCOVERY_PLAYER_ID_MISSING"
		report.TVErrorCode = "SKIPPED_DISCOVERY_FAILED"
		report.MainErrorCode = "SKIPPED_DISCOVERY_FAILED"
		return report
	}
	report.PlayerID = playerID

	probeVariant := func(name string) (bool, string) {
		variant, ok := lookupPlayerVariant(name)
		if !ok {
			return false, "VARIANT_UNCONFIGURED"
		}
		rawJS, _, fetchErr := h.fetchPlayerJSVariant(ctx, playerID, variant)
		if fetchErr != nil {
			return false, classifyCanaryError("fetch", fetchErr)
		}
		if _, probeErr := h.sandbox.PreprocessAndProbePlayer(ctx, rawJS); probeErr != nil {
			return false, classifyCanaryError("preprocess", probeErr)
		}
		return true, ""
	}

	report.TVOK, report.TVErrorCode = probeVariant("tv")
	report.MainOK, report.MainErrorCode = probeVariant("main")
	report.OverallOK = report.TVOK && report.MainOK
	report.Status = deriveCanaryStatus(report.TVOK, report.MainOK)
	return report
}

func resolveCanaryDenoBinary() string {
	if envPath := strings.TrimSpace(os.Getenv("DOKITOOL_DENO_BINARY")); envPath != "" {
		return envPath
	}
	if runnerTemp := strings.TrimSpace(os.Getenv("RUNNER_TEMP")); runnerTemp != "" {
		candidate := filepath.Join(runnerTemp, "dokitool-validation", "bin", "deno")
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return candidate
		}
	}
	if p, err := exec.LookPath("deno"); err == nil && p != "" {
		return p
	}
	return ""
}

func resolveCanaryEJSTimeout() time.Duration {
	if raw := strings.TrimSpace(os.Getenv("DOKITOOL_EJS_TIMEOUT")); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d >= minEJSTimeout && d <= maxEJSTimeout {
			return d
		}
	}
	return defaultCanaryEJSTimeout
}

func writeCanaryReportJSON(path string, report canaryReport) error {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return nil
	}
	if dir := filepath.Dir(trimmed); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	return os.WriteFile(trimmed, encoded, 0o600)
}

// TestCanaryLiveYouTubePlayerVariants performs a live zero-permission Deno/EJS
// compatibility probe against YouTube's current iframe_api player ID for BOTH
// "tv" and "main" variants. Guarded by //go:build canary so default PR tests
// remain 100% offline.
func TestCanaryLiveYouTubePlayerVariants(t *testing.T) {
	started := time.Now()
	report := canaryReport{
		SchemaVersion: canaryReportSchemaVersion,
		Status:        "outage",
	}
	outPath := strings.TrimSpace(os.Getenv("DOKITOOL_CANARY_JSON_OUT"))
	defer func() {
		if report.ElapsedMS == 0 {
			if elapsed := time.Since(started).Milliseconds(); elapsed > 0 {
				report.ElapsedMS = elapsed
			}
		}
		if err := writeCanaryReportJSON(outPath, report); err != nil {
			t.Errorf("failed to write sanitized canary JSON report: %v", err)
		}
	}()

	denoBin := resolveCanaryDenoBinary()
	if denoBin == "" {
		report.DiscoveryErrorCode = "DENO_NOT_CONFIGURED"
		report.TVErrorCode = "DENO_NOT_CONFIGURED"
		report.MainErrorCode = "DENO_NOT_CONFIGURED"
		t.Fatalf("canary preflight failed: status=%s code=DENO_NOT_CONFIGURED", report.Status)
	}

	ejsDir := strings.TrimSpace(os.Getenv("DOKITOOL_EJS_DIR"))
	if ejsDir == "" {
		ejsDir = filepath.Join("testdata", "ejs")
	}

	sb, err := NewEJSSandbox(SandboxConfig{
		DenoBinary:     denoBin,
		EJSDir:         ejsDir,
		MaxConcurrency: 2,
		Timeout:        resolveCanaryEJSTimeout(),
	})
	if err != nil {
		report.DiscoveryErrorCode = "SANDBOX_INIT_FAILED"
		report.TVErrorCode = "SANDBOX_INIT_FAILED"
		report.MainErrorCode = "SANDBOX_INIT_FAILED"
		t.Fatalf("canary preflight failed: status=%s code=SANDBOX_INIT_FAILED", report.Status)
	}

	helper, err := NewHelper(fetch.New(), sb, time.Now)
	if err != nil {
		report.DiscoveryErrorCode = "HELPER_INIT_FAILED"
		report.TVErrorCode = "HELPER_INIT_FAILED"
		report.MainErrorCode = "HELPER_INIT_FAILED"
		t.Fatalf("canary preflight failed: status=%s code=HELPER_INIT_FAILED", report.Status)
	}

	ctx, cancel := context.WithTimeout(context.Background(), canaryOverallTimeout)
	defer cancel()

	report = runCanaryProbe(ctx, helper)
	t.Logf(
		"youtube canary result: player_id=%q status=%s overall_ok=%t tv_ok=%t tv_error=%q main_ok=%t main_error=%q discovery_error=%q elapsed_ms=%d deno=%s ejs=%s",
		report.PlayerID,
		report.Status,
		report.OverallOK,
		report.TVOK,
		report.TVErrorCode,
		report.MainOK,
		report.MainErrorCode,
		report.DiscoveryErrorCode,
		report.ElapsedMS,
		report.DenoVersion,
		report.EJSVersion,
	)

	if !report.OverallOK {
		t.Errorf(
			"youtube live canary failed: status=%s player_id=%q tv_ok=%t tv_error=%q main_ok=%t main_error=%q discovery_error=%q",
			report.Status,
			report.PlayerID,
			report.TVOK,
			report.TVErrorCode,
			report.MainOK,
			report.MainErrorCode,
			report.DiscoveryErrorCode,
		)
	}
}

func TestCanaryReportSanitizationAndClassification(t *testing.T) {
	if got := sanitizeCanaryPlayerID("B485E332"); got != "b485e332" {
		t.Fatalf("sanitizeCanaryPlayerID(valid) = %q, want b485e332", got)
	}
	for _, bad := range []string{"", "not-hex!", "https://www.youtube.com/s/player/b485e332", "1234567"} {
		if got := sanitizeCanaryPlayerID(bad); got != "" {
			t.Fatalf("sanitizeCanaryPlayerID(%q) = %q, want empty", bad, got)
		}
	}

	if got := deriveCanaryStatus(true, true); got != "ok" {
		t.Fatalf("deriveCanaryStatus(true,true) = %q", got)
	}
	if got := deriveCanaryStatus(false, true); got != "degraded_tv_only" {
		t.Fatalf("deriveCanaryStatus(false,true) = %q", got)
	}
	if got := deriveCanaryStatus(true, false); got != "degraded_main_only" {
		t.Fatalf("deriveCanaryStatus(true,false) = %q", got)
	}
	if got := deriveCanaryStatus(false, false); got != "outage" {
		t.Fatalf("deriveCanaryStatus(false,false) = %q", got)
	}

	rawErr := errors.New("ejs n probe failed: arbitrary upstream runtime detail")
	if got := classifyCanaryError("preprocess", rawErr); got != "EJS_N_PROBE_FAILED" {
		t.Fatalf("classifyCanaryError(preprocess) = %q, want EJS_N_PROBE_FAILED", got)
	}
	if got := classifyCanaryError("discovery", context.DeadlineExceeded); got != "DISCOVERY_TIMEOUT" {
		t.Fatalf("classifyCanaryError(discovery, timeout) = %q, want DISCOVERY_TIMEOUT", got)
	}
	if got := classifyCanaryError("fetch", errors.New("signatureTimestamp not found in player main variant")); got != "STS_MISSING" {
		t.Fatalf("classifyCanaryError(fetch, sts) = %q, want STS_MISSING", got)
	}

	outFile := filepath.Join(t.TempDir(), "nested", "canary.json")
	sample := canaryReport{
		SchemaVersion: canaryReportSchemaVersion,
		PlayerID:      "b485e332",
		Status:        "degraded_main_only",
		TVOK:          true,
		MainOK:        false,
		MainErrorCode: "EJS_N_PROBE_FAILED",
		ElapsedMS:     420,
		DenoVersion:   PinnedDenoVersion,
		EJSVersion:    PinnedEJSVersion,
		OverallOK:     false,
	}
	if err := writeCanaryReportJSON(outFile, sample); err != nil {
		t.Fatalf("writeCanaryReportJSON failed: %v", err)
	}
	raw, err := os.ReadFile(outFile)
	if err != nil {
		t.Fatalf("read back canary json failed: %v", err)
	}
	var decoded canaryReport
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal canary json failed: %v", err)
	}
	if decoded != sample {
		t.Fatalf("decoded report = %+v, want %+v", decoded, sample)
	}
}
