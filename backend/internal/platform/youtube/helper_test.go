package youtube

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func resolveTestDenoBinary(t *testing.T) string {
	t.Helper()
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
	t.Fatalf("deno v%s binary not found in DOKITOOL_DENO_BINARY or PATH", PinnedDenoVersion)
	return ""
}

func newTestSandbox(t *testing.T) *EJSSandbox {
	t.Helper()
	denoBin := resolveTestDenoBinary(t)
	ejsDir := filepath.Join("testdata", "ejs")
	sb, err := NewEJSSandbox(SandboxConfig{
		DenoBinary: denoBin,
		EJSDir:     ejsDir,
	})
	if err != nil {
		t.Fatalf("NewEJSSandbox failed: %v", err)
	}
	return sb
}

func TestEJSSandboxVerification(t *testing.T) {
	sb := newTestSandbox(t)
	if sb.DenoSHA256() == "" || sb.DenoAsset() == "" {
		t.Fatalf("expected non-empty deno sha256 and asset, got sha=%q asset=%q", sb.DenoSHA256(), sb.DenoAsset())
	}
	if sb.LibSHA256() != OfficialEJSLibSHA256 {
		t.Fatalf("lib sha256 = %q, want %q", sb.LibSHA256(), OfficialEJSLibSHA256)
	}
	if sb.CoreSHA256() != OfficialEJSCoreSHA256 {
		t.Fatalf("core sha256 = %q, want %q", sb.CoreSHA256(), OfficialEJSCoreSHA256)
	}

	// Tampered ejs asset must fail verification.
	badDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(badDir, "yt.solver.lib.min.js"), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(badDir, "yt.solver.core.min.js"), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := NewEJSSandbox(SandboxConfig{
		DenoBinary: resolveTestDenoBinary(t),
		EJSDir:     badDir,
	}); err == nil {
		t.Fatal("expected tampered ejs assets to fail verification")
	}

	// Tampered deno binary must fail verification.
	fakeDeno := filepath.Join(badDir, "deno")
	if err := os.WriteFile(fakeDeno, []byte("#!/bin/sh\necho deno "+PinnedDenoVersion+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := NewEJSSandbox(SandboxConfig{
		DenoBinary: fakeDeno,
		EJSDir:     filepath.Join("testdata", "ejs"),
	}); err == nil {
		t.Fatal("expected unpinned deno binary to fail SHA-256 verification")
	}
}

func TestEJSSandboxBlocksNetworkAndFilesystem(t *testing.T) {
	sb := newTestSandbox(t)
	ctx := context.Background()

	// 1. Network access inside sandbox must fail.
	_, err := sb.RunRawScript(ctx, `await fetch("http://127.0.0.1:8080/");`)
	if err == nil {
		t.Fatal("expected network access inside deno sandbox to fail")
	}
	if !strings.Contains(err.Error(), "NotCapable") && !strings.Contains(err.Error(), "net access") {
		t.Fatalf("expected NotCapable net access error, got: %v", err)
	}

	// 2. File read inside sandbox must fail.
	_, err = sb.RunRawScript(ctx, `Deno.readTextFileSync("/etc/passwd");`)
	if err == nil {
		t.Fatal("expected file read inside deno sandbox to fail")
	}
	if !strings.Contains(err.Error(), "NotCapable") && !strings.Contains(err.Error(), "read access") {
		t.Fatalf("expected NotCapable read access error, got: %v", err)
	}

	// 3. Environment variable access and subprocess spawning inside sandbox must also fail.
	_, err = sb.RunRawScript(ctx, `Deno.env.get("HOME");`)
	if err == nil {
		t.Fatal("expected env access inside deno sandbox to fail")
	}
	_, err = sb.RunRawScript(ctx, `new Deno.Command("sh").outputSync();`)
	if err == nil {
		t.Fatal("expected subprocess spawn inside deno sandbox to fail")
	}
}

type mockYouTubeFetchExecutor struct {
	playerID         string
	playerBaseJS     []byte
	tvPlayerJS       []byte
	fetchDelay       time.Duration
	failRefresh      atomic.Bool
	failTVFetch      atomic.Bool
	failMainFetch    atomic.Bool
	panicRefresh     atomic.Bool
	startedHits      atomic.Int32
	iframeHits       atomic.Int32
	playerJSHits     atomic.Int32
	tvPlayerJSHits   atomic.Int32
	mainPlayerJSHits atomic.Int32
	forbiddenHits    atomic.Int32
}

func (m *mockYouTubeFetchExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	if req.Policy.AllowedURL == nil || !req.Policy.AllowedURL(req.URL) {
		m.forbiddenHits.Add(1)
		return fetch.Response{}, fetch.ErrPolicy
	}
	// Policy must reject any non-www.youtube.com URL, especially googlevideo.com.
	if req.Policy.AllowedURL("https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback") ||
		req.Policy.AllowedURL("http://www.youtube.com/iframe_api") ||
		req.Policy.AllowedURL("https://evil.example.com/iframe_api") {
		m.forbiddenHits.Add(1)
		return fetch.Response{}, fetch.ErrPolicy
	}
	m.startedHits.Add(1)
	if m.fetchDelay > 0 {
		timer := time.NewTimer(m.fetchDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fetch.Response{}, ctx.Err()
		case <-timer.C:
		}
	}
	switch req.URL {
	case "https://www.youtube.com/iframe_api":
		m.iframeHits.Add(1)
		if m.panicRefresh.Load() {
			panic("simulated iframe_api panic during refreshActivePlayer")
		}
		if m.failRefresh.Load() {
			return fetch.Response{StatusCode: http.StatusBadGateway}, nil
		}
		body := `var scriptUrl = 'https:\/\/www.youtube.com\/s\/player\/` + m.playerID + `\/www-widgetapi.vflset\/www-widgetapi.js';`
		return fetch.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/javascript"}},
			Body:       []byte(body),
			URL:        req.URL,
		}, nil
	case "https://www.youtube.com/s/player/" + m.playerID + "/tv-player-ias.vflset/tv-player-ias.js":
		m.playerJSHits.Add(1)
		m.tvPlayerJSHits.Add(1)
		if m.failRefresh.Load() || m.failTVFetch.Load() {
			return fetch.Response{StatusCode: http.StatusBadGateway}, nil
		}
		body := m.tvPlayerJS
		if len(body) == 0 {
			body = m.playerBaseJS
		}
		return fetch.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/javascript"}},
			Body:       body,
			URL:        req.URL,
		}, nil
	case "https://www.youtube.com/s/player/" + m.playerID + "/player_ias.vflset/en_US/base.js":
		m.playerJSHits.Add(1)
		m.mainPlayerJSHits.Add(1)
		if m.failRefresh.Load() || m.failMainFetch.Load() {
			return fetch.Response{StatusCode: http.StatusBadGateway}, nil
		}
		return fetch.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/javascript"}},
			Body:       m.playerBaseJS,
			URL:        req.URL,
		}, nil
	default:
		m.forbiddenHits.Add(1)
		return fetch.Response{StatusCode: http.StatusNotFound}, nil
	}
}

func TestYouTubeHelperContextAndFinalizeSample46(t *testing.T) {
	sb := newTestSandbox(t)
	playerJS, err := os.ReadFile(filepath.Join("testdata", "player_base_fixture.js"))
	if err != nil {
		t.Fatal(err)
	}
	sampleJSON, err := os.ReadFile(filepath.Join("testdata", "finalize_sample_46.json"))
	if err != nil {
		t.Fatal(err)
	}

	execMock := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
	}
	currentNow := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	helper, err := NewHelper(execMock, sb, func() time.Time { return currentNow })
	if err != nil {
		t.Fatal(err)
	}

	// 1. GET /api/youtube/context populates cache and preprocesses player JS.
	ctxPayload, status := helper.Context(context.Background())
	if status != http.StatusOK {
		t.Fatalf("Context status = %d, payload = %#v", status, ctxPayload)
	}
	data := unified.Map(ctxPayload["data"])
	if got := unified.Str(data["player_id"]); got != "a5c2aafe" {
		t.Fatalf("player_id = %q, want a5c2aafe", got)
	}
	if got, ok := unified.Numeric(data["signature_timestamp"]); !ok || int(got) != 20760 {
		t.Fatalf("signature_timestamp = %v, want 20760", data["signature_timestamp"])
	}
	clientObj := unified.Map(data["client"])
	if unified.Str(clientObj["name"]) != TVHTML5ClientName || unified.Str(clientObj["version"]) != TVHTML5ClientVersion {
		t.Fatalf("client = %#v", clientObj)
	}
	if unified.Str(data["expires_at"]) != "2026-11-09T18:00:00Z" {
		t.Fatalf("expires_at = %q, want 2026-11-09T18:00:00Z", unified.Str(data["expires_at"]))
	}

	// 2. Second Context call within TTL uses cached player without re-fetching.
	_, status2 := helper.Context(context.Background())
	if status2 != http.StatusOK || execMock.iframeHits.Load() != 1 || execMock.playerJSHits.Load() != 1 {
		t.Fatalf("expected 1 iframe hit and 1 playerJS hit, got iframe=%d playerJS=%d", execMock.iframeHits.Load(), execMock.playerJSHits.Load())
	}

	// 3. POST /api/youtube/finalize with #46 sanitized sample.
	finPayload, finStatus := helper.Finalize(context.Background(), sampleJSON, false)
	if finStatus != http.StatusOK {
		t.Fatalf("Finalize status = %d, payload = %#v", finStatus, finPayload)
	}
	if err := unified.ValidateEnvelopeAt(finPayload, currentNow.Unix()); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}
	if execMock.forbiddenHits.Load() != 0 {
		t.Fatalf("unexpected outbound hits: %d", execMock.forbiddenHits.Load())
	}

	finData := unified.Map(finPayload["data"])
	if unified.Str(finData["platform"]) != "youtube" || unified.Str(finData["content_id"]) != "I9JvDaciaFk" {
		t.Fatalf("unexpected platform/content_id: %#v", finData)
	}
	items := unified.Slice(finData["items"])
	if len(items) != 1 {
		t.Fatalf("items len = %d, want 1", len(items))
	}
	item := unified.Map(items[0])
	def := unified.Map(item["default"])
	if def == nil {
		t.Fatal("expected non-nil item.default")
	}
	defVariantID := unified.Str(def["variant_id"])
	if defVariantID == "" {
		t.Fatal("expected non-empty item.default.variant_id")
	}
	defURL := unified.Str(def["url"])
	if defURL == "" {
		t.Fatal("expected non-empty item.default.url")
	}
	parsedDefURL, err := url.Parse(defURL)
	if err != nil {
		t.Fatal(err)
	}
	if parsedDefURL.Query().Get("itag") != "18" {
		t.Fatalf("default url itag = %q, want 18", parsedDefURL.Query().Get("itag"))
	}
	if parsedDefURL.Query().Get("title") != "I9JvDaciaFk_360p" {
		t.Fatalf("expected itag 18 URL to have title=I9JvDaciaFk_360p, got %q", parsedDefURL.Query().Get("title"))
	}
	if parsedDefURL.Query().Get("n") != "SOLVED_N_CHALLENGE_N_18" {
		t.Fatalf("expected solved n parameter, got %q", parsedDefURL.Query().Get("n"))
	}
	if !strings.HasPrefix(parsedDefURL.Query().Get("sig"), "SOLVED_SIG_") {
		t.Fatalf("expected solved sig parameter, got %q", parsedDefURL.Query().Get("sig"))
	}

	variants := unified.Slice(item["variants"])
	var sawDefaultVariant, saw1080VideoOnly, sawAudioM4A bool
	for _, rawV := range variants {
		v := unified.Map(rawV)
		label := unified.Str(v["label"])
		meta := unified.Map(v["metadata"])
		if unified.Str(v["id"]) == defVariantID {
			sawDefaultVariant = true
			if label != "360p (含音频)" {
				t.Fatalf("default variant label = %q, want 360p (含音频)", label)
			}
			if meta["has_audio"] != true {
				t.Fatalf("default variant metadata.has_audio = %v, want true", meta["has_audio"])
			}
		}
		if strings.HasPrefix(label, "1080p") && strings.Contains(label, "仅视频无声") {
			saw1080VideoOnly = true
			if meta["has_audio"] != false {
				t.Fatalf("expected 1080p video-only has_audio=false, got %v", meta["has_audio"])
			}
		}
		if strings.HasPrefix(label, "仅音频 M4A") {
			sawAudioM4A = true
			if meta["has_audio"] != true || unified.Str(meta["extension"]) != "m4a" {
				t.Fatalf("unexpected audio variant metadata: %#v", meta)
			}
		}
	}
	if !sawDefaultVariant || !saw1080VideoOnly || !sawAudioM4A {
		t.Fatalf("missing expected variants: sawDefaultVariant=%v saw1080VideoOnly=%v sawAudioM4A=%v", sawDefaultVariant, saw1080VideoOnly, sawAudioM4A)
	}
}

func TestYouTubeHelperFinalizeRejections(t *testing.T) {
	sb := newTestSandbox(t)
	playerJS, err := os.ReadFile(filepath.Join("testdata", "player_base_fixture.js"))
	if err != nil {
		t.Fatal(err)
	}
	sampleJSON, err := os.ReadFile(filepath.Join("testdata", "finalize_sample_46.json"))
	if err != nil {
		t.Fatal(err)
	}

	execMock := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
	}
	currentNow := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	helper, err := NewHelper(execMock, sb, func() time.Time { return currentNow })
	if err != nil {
		t.Fatal(err)
	}
	_, _ = helper.Context(context.Background())

	var baseReq map[string]any
	if err := json.Unmarshal(sampleJSON, &baseReq); err != nil {
		t.Fatal(err)
	}
	firstFmt := baseReq["formats"].([]any)[0].(map[string]any)

	mustReject := func(name string, body []byte) {
		t.Helper()
		payload, status := helper.Finalize(context.Background(), body, false)
		if status != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d (%#v)", name, status, payload)
		}
		if unified.Str(payload["code"]) != "INVALID_INPUT" {
			t.Fatalf("%s: expected INVALID_INPUT, got %q", name, unified.Str(payload["code"]))
		}
	}

	// 1. Non-googlevideo.com/videoplayback URLs.
	for _, badURL := range []string{
		"https://evil.example.com/videoplayback?id=I9JvDaciaFk&itag=18&n=abc",
		"http://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=I9JvDaciaFk&itag=18&n=abc",
		"https://googlevideo.com/videoplayback?id=I9JvDaciaFk&itag=18&n=abc",
		"https://rr1---sn-npoe7n7r.googlevideo.com/other?id=I9JvDaciaFk&itag=18&n=abc",
	} {
		reqBody, _ := json.Marshal(map[string]any{
			"video_id":  "I9JvDaciaFk",
			"player_id": "a5c2aafe",
			"formats": []any{
				map[string]any{
					"itag":     18,
					"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
					"url":      badURL,
				},
			},
		})
		mustReject("non-googlevideo URL "+badURL, reqBody)
	}

	// 2. URL parameter id inconsistent with video_id.
	for _, badIDURL := range []string{
		"https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=dQw4w9WgXcQ&itag=18&n=abc",
		"https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=o-short&itag=18&n=abc",
		"https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?itag=18&n=abc",
	} {
		reqBody, _ := json.Marshal(map[string]any{
			"video_id":  "I9JvDaciaFk",
			"player_id": "a5c2aafe",
			"formats": []any{
				map[string]any{
					"itag":     18,
					"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
					"url":      badIDURL,
				},
			},
		})
		mustReject("mismatched id "+badIDURL, reqBody)
	}

	// Also reject mixed stream IDs within the same request.
	mixedBody, _ := json.Marshal(map[string]any{
		"video_id":  "I9JvDaciaFk",
		"player_id": "a5c2aafe",
		"formats": []any{
			firstFmt,
		},
		"adaptiveFormats": []any{
			map[string]any{
				"itag":     140,
				"mimeType": `audio/mp4; codecs="mp4a.40.2"`,
				"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=o-AMD5XRy5l4PR-ScuEnaV1lEOnKBdYN9jbrY9dri_rXIK&itag=140&n=abc",
			},
		},
	})
	mustReject("inconsistent stream id across formats", mixedBody)

	// 3. player_id not in cache.
	uncachedBody, _ := json.Marshal(map[string]any{
		"video_id":  "I9JvDaciaFk",
		"player_id": "deadbeef",
		"formats":   []any{firstFmt},
	})
	mustReject("uncached player_id", uncachedBody)

	// 4. player_id expired.
	currentNow = currentNow.Add(7 * time.Hour)
	mustReject("expired player_id", sampleJSON)
	// Restore time for remaining checks.
	currentNow = time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)

	// 5. Format entries > 256 (MaxFinalizeFormatEntries).
	compactFmt := map[string]any{
		"itag":     18,
		"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
		"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=I9JvDaciaFk&itag=18&n=CHALLENGE_N_18",
	}
	many := make([]any, MaxFinalizeFormatEntries+1)
	for i := range many {
		many[i] = compactFmt
	}
	tooManyBody, _ := json.Marshal(map[string]any{
		"video_id":        "I9JvDaciaFk",
		"player_id":       "a5c2aafe",
		"formats":         many[:1],
		"adaptiveFormats": many[1:],
	})
	if len(tooManyBody) >= MaxFinalizeBodyBytes {
		t.Fatalf("tooManyBody length %d must be < MaxFinalizeBodyBytes %d to test entry cap", len(tooManyBody), MaxFinalizeBodyBytes)
	}
	mustReject("entries > 256", tooManyBody)

	// 5b. Unknown field inside audioTrack must be rejected.
	unknownAudioTrackBody, _ := json.Marshal(map[string]any{
		"video_id":  "I9JvDaciaFk",
		"player_id": "a5c2aafe",
		"formats": []any{
			map[string]any{
				"itag":     140,
				"mimeType": `audio/mp4; codecs="mp4a.40.2"`,
				"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=I9JvDaciaFk&itag=140&n=CHALLENGE_N_18",
				"audioTrack": map[string]any{
					"id":             "en.4",
					"displayName":    "English original",
					"audioIsDefault": true,
					"unexpectedKey":  1,
				},
			},
		},
	})
	mustReject("unknown audioTrack field", unknownAudioTrackBody)

	// 6. Body > 512 KiB.
	hugeBody := bytes.Repeat([]byte(" "), MaxFinalizeBodyBytes+1)
	mustReject("body > 512 KiB", hugeBody)

	// 7. Unknown top-level field.
	unknownFieldBody, _ := json.Marshal(map[string]any{
		"video_id":   "I9JvDaciaFk",
		"player_id":  "a5c2aafe",
		"formats":    []any{firstFmt},
		"visitor_id": "unexpected",
	})
	mustReject("unknown top-level field", unknownFieldBody)
}

func TestYouTubeHelperContextConcurrentSingleflightAndStaleFallback(t *testing.T) {
	sb := newTestSandbox(t)
	playerJS, err := os.ReadFile(filepath.Join("testdata", "player_base_fixture.js"))
	if err != nil {
		t.Fatal(err)
	}

	execMock := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
		fetchDelay:   25 * time.Millisecond,
	}
	var nowMu sync.Mutex
	currentNow := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	helper, err := NewHelper(execMock, sb, func() time.Time {
		nowMu.Lock()
		defer nowMu.Unlock()
		return currentNow
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1. 20 concurrent Context calls when cache is empty must coalesce into a single refresh.
	const concurrency = 20
	var wg sync.WaitGroup
	startGate := make(chan struct{})
	statuses := make([]int, concurrency)
	playerIDs := make([]string, concurrency)

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-startGate
			payload, status := helper.Context(context.Background())
			statuses[idx] = status
			playerIDs[idx] = unified.Str(unified.Map(payload["data"])["player_id"])
		}(i)
	}
	close(startGate)
	wg.Wait()

	for i := 0; i < concurrency; i++ {
		if statuses[i] != http.StatusOK || playerIDs[i] != "a5c2aafe" {
			t.Fatalf("caller %d got status=%d player_id=%q", i, statuses[i], playerIDs[i])
		}
	}
	if got := execMock.iframeHits.Load(); got != 1 {
		t.Fatalf("iframe_api hits = %d, want 1", got)
	}
	if got := execMock.playerJSHits.Load(); got != 1 {
		t.Fatalf("base.js hits = %d, want 1", got)
	}

	// 2. Stale fallback within 1 hour when refresh fails.
	execMock.failRefresh.Store(true)
	nowMu.Lock()
	currentNow = currentNow.Add(DefaultPlayerCacheTTL + 30*time.Minute)
	nowMu.Unlock()

	stalePayload, staleStatus := helper.Context(context.Background())
	if staleStatus != http.StatusOK {
		t.Fatalf("expected 200 from stale fallback within 1h, got %d (%#v)", staleStatus, stalePayload)
	}
	if got := unified.Str(unified.Map(stalePayload["data"])["player_id"]); got != "a5c2aafe" {
		t.Fatalf("stale fallback player_id = %q, want a5c2aafe", got)
	}

	// 3. Past 1 hour after expiry, failed refresh must return 502.
	nowMu.Lock()
	currentNow = currentNow.Add(45 * time.Minute) // total +6h75m (> +7h)
	nowMu.Unlock()

	failPayload, failStatus := helper.Context(context.Background())
	if failStatus != http.StatusBadGateway {
		t.Fatalf("expected 502 when stale > 1h and refresh fails, got %d (%#v)", failStatus, failPayload)
	}
}

func TestYouTubeHelperFinalizeMetadataFields(t *testing.T) {
	sb := newTestSandbox(t)
	playerJS, err := os.ReadFile(filepath.Join("testdata", "player_base_fixture.js"))
	if err != nil {
		t.Fatal(err)
	}
	sampleJSON, err := os.ReadFile(filepath.Join("testdata", "finalize_sample_46.json"))
	if err != nil {
		t.Fatal(err)
	}

	execMock := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
	}
	currentNow := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	helper, err := NewHelper(execMock, sb, func() time.Time { return currentNow })
	if err != nil {
		t.Fatal(err)
	}
	_, _ = helper.Context(context.Background())

	var baseReq map[string]any
	if err := json.Unmarshal(sampleJSON, &baseReq); err != nil {
		t.Fatal(err)
	}
	firstFmt := baseReq["formats"].([]any)[0].(map[string]any)

	// 1. Valid title, author, duration_seconds, and i.ytimg.com thumbnail.
	validBody, _ := json.Marshal(map[string]any{
		"video_id":         "I9JvDaciaFk",
		"player_id":        "a5c2aafe",
		"title":            "  Me at the zoo  ",
		"author":           "  jawed  ",
		"duration_seconds": 19,
		"thumbnail":        "https://i.ytimg.com/vi/I9JvDaciaFk/maxresdefault.jpg",
		"formats":          []any{firstFmt},
	})
	payload, status := helper.Finalize(context.Background(), validBody, false)
	if status != http.StatusOK {
		t.Fatalf("valid metadata finalize status = %d, payload = %#v", status, payload)
	}
	data := unified.Map(payload["data"])
	if got := unified.Str(data["title"]); got != "Me at the zoo" {
		t.Fatalf("data.title = %q, want %q", got, "Me at the zoo")
	}
	if got := unified.Str(unified.Map(data["author"])["name"]); got != "jawed" {
		t.Fatalf("data.author.name = %q, want %q", got, "jawed")
	}
	if got := unified.Str(unified.Map(data["cover"])["url"]); got != "https://i.ytimg.com/vi/I9JvDaciaFk/maxresdefault.jpg" {
		t.Fatalf("data.cover.url = %q", got)
	}
	item := unified.Map(unified.Slice(data["items"])[0])
	if got, ok := unified.Numeric(item["duration_ms"]); !ok || int(got) != 19000 {
		t.Fatalf("item.duration_ms = %v, want 19000", item["duration_ms"])
	}
	defURL, _ := url.Parse(unified.Str(unified.Map(item["default"])["url"]))
	if got := defURL.Query().Get("title"); got != "Me_at_the_zoo_360p" {
		t.Fatalf("itag 18 title query = %q, want Me_at_the_zoo_360p", got)
	}

	// 2. Title with control characters / Unicode format characters (Cf, e.g. U+202E) and empty fallback.
	ctrlBody, _ := json.Marshal(map[string]any{
		"video_id":  "I9JvDaciaFk",
		"player_id": "a5c2aafe",
		"title":     " \x00\x07Hello\u202e\u200b\ufeff\n\tWorld\x1f\x7f ",
		"author":    " \u202ejawed\u202c ",
		"formats":   []any{firstFmt},
	})
	ctrlPayload, ctrlStatus := helper.Finalize(context.Background(), ctrlBody, false)
	if ctrlStatus != http.StatusOK {
		t.Fatalf("control-char/Cf title status = %d", ctrlStatus)
	}
	ctrlData := unified.Map(ctrlPayload["data"])
	if got := unified.Str(ctrlData["title"]); got != "HelloWorld" {
		t.Fatalf("control-char/Cf stripped title = %q, want HelloWorld", got)
	}
	if got := unified.Str(unified.Map(ctrlData["author"])["name"]); got != "jawed" {
		t.Fatalf("Cf stripped author = %q, want jawed", got)
	}

	emptyCtrlBody, _ := json.Marshal(map[string]any{
		"video_id":  "I9JvDaciaFk",
		"player_id": "a5c2aafe",
		"title":     " \x00\x07\u202e\u200b\ufeff\t\n ",
		"formats":   []any{firstFmt},
	})
	emptyCtrlPayload, emptyCtrlStatus := helper.Finalize(context.Background(), emptyCtrlBody, false)
	if emptyCtrlStatus != http.StatusOK {
		t.Fatalf("empty control-char/Cf title status = %d", emptyCtrlStatus)
	}
	if got := unified.Str(unified.Map(emptyCtrlPayload["data"])["title"]); got != "I9JvDaciaFk" {
		t.Fatalf("fallback title = %q, want I9JvDaciaFk", got)
	}

	// 3. Overly long title (> 200 runes) is truncated to 200 runes.
	longTitle := strings.Repeat("测A", 125) // 250 runes
	longBody, _ := json.Marshal(map[string]any{
		"video_id":  "I9JvDaciaFk",
		"player_id": "a5c2aafe",
		"title":     longTitle,
		"formats":   []any{firstFmt},
	})
	longPayload, longStatus := helper.Finalize(context.Background(), longBody, false)
	if longStatus != http.StatusOK {
		t.Fatalf("overlong title status = %d", longStatus)
	}
	gotLongTitle := unified.Str(unified.Map(longPayload["data"])["title"])
	if rc := utf8.RuneCountInString(gotLongTitle); rc != MaxFinalizeTitleRunes {
		t.Fatalf("truncated title rune count = %d, want %d", rc, MaxFinalizeTitleRunes)
	}

	// 4. Invalid optional fields (thumbnail, duration_seconds, title, author) drop only that field and still return 200 OK.
	for _, badThumb := range []any{
		"https://evil.example.com/vi/I9JvDaciaFk/hqdefault.jpg",
		"http://127.0.0.1/thumb.jpg",
		"https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?itag=18",
		"ftp://i.ytimg.com/vi/I9JvDaciaFk/hqdefault.jpg",
		12345,
	} {
		badThumbBody, _ := json.Marshal(map[string]any{
			"video_id":  "I9JvDaciaFk",
			"player_id": "a5c2aafe",
			"title":     "Valid Title",
			"thumbnail": badThumb,
			"formats":   []any{firstFmt},
		})
		okPayload, okStatus := helper.Finalize(context.Background(), badThumbBody, false)
		if okStatus != http.StatusOK || unified.Str(okPayload["code"]) != "OK" {
			t.Fatalf("expected 200 OK with bad thumbnail %v dropped, got %d (%#v)", badThumb, okStatus, okPayload)
		}
		okData := unified.Map(okPayload["data"])
		if okData["cover"] != nil {
			t.Fatalf("expected cover to be omitted for bad thumbnail %v, got %#v", badThumb, okData["cover"])
		}
		if got := unified.Str(okData["title"]); got != "Valid Title" {
			t.Fatalf("expected valid title preserved, got %q", got)
		}
	}

	for _, badDur := range []any{0, -10, 86400*365 + 1, "19", 19.5} {
		badDurBody, _ := json.Marshal(map[string]any{
			"video_id":         "I9JvDaciaFk",
			"player_id":        "a5c2aafe",
			"title":            "Valid Title",
			"duration_seconds": badDur,
			"formats":          []any{firstFmt},
		})
		okPayload, okStatus := helper.Finalize(context.Background(), badDurBody, false)
		if okStatus != http.StatusOK || unified.Str(okPayload["code"]) != "OK" {
			t.Fatalf("expected 200 OK with bad duration_seconds %v dropped, got %d (%#v)", badDur, okStatus, okPayload)
		}
		okItem := unified.Map(unified.Slice(unified.Map(okPayload["data"])["items"])[0])
		if okItem["duration_ms"] != nil {
			t.Fatalf("expected duration_ms omitted for duration_seconds %v, got %#v", badDur, okItem["duration_ms"])
		}
	}

	nonStringOptionalBody, _ := json.Marshal(map[string]any{
		"video_id":  "I9JvDaciaFk",
		"player_id": "a5c2aafe",
		"title":     123,
		"author":    false,
		"formats":   []any{firstFmt},
	})
	optPayload, optStatus := helper.Finalize(context.Background(), nonStringOptionalBody, false)
	if optStatus != http.StatusOK || unified.Str(optPayload["code"]) != "OK" {
		t.Fatalf("expected 200 OK with non-string title/author dropped, got %d (%#v)", optStatus, optPayload)
	}
	optData := unified.Map(optPayload["data"])
	if got := unified.Str(optData["title"]); got != "I9JvDaciaFk" {
		t.Fatalf("expected fallback video_id title, got %q", got)
	}
	if optData["author"] != nil {
		t.Fatalf("expected invalid author omitted, got %#v", optData["author"])
	}
}

func TestYouTubeHelperRefreshPanicDoesNotWedgeSubsequentContext(t *testing.T) {
	sb := newTestSandbox(t)
	playerJS, err := os.ReadFile(filepath.Join("testdata", "player_base_fixture.js"))
	if err != nil {
		t.Fatal(err)
	}

	execMock := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
		fetchDelay:   25 * time.Millisecond,
	}
	execMock.panicRefresh.Store(true)

	currentNow := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	helper, err := NewHelper(execMock, sb, func() time.Time { return currentNow })
	if err != nil {
		t.Fatal(err)
	}

	// Launch a concurrent waiter alongside the panicking leader to ensure neither wedges.
	var wg sync.WaitGroup
	wg.Add(2)
	panicked := atomic.Bool{}
	waiterStatus := atomic.Int32{}

	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				panicked.Store(true)
			}
		}()
		_, _ = helper.Context(context.Background())
	}()

	time.Sleep(5 * time.Millisecond)
	go func() {
		defer wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, st := helper.Context(ctx)
		waiterStatus.Store(int32(st))
	}()

	wg.Wait()
	if !panicked.Load() {
		t.Fatal("expected first Context call to panic during simulated refresh panic")
	}
	if got := int(waiterStatus.Load()); got != http.StatusBadGateway {
		t.Fatalf("concurrent waiter status = %d, want 502 after leader panic", got)
	}
	if helper.HasCachedContext() {
		t.Fatal("expected cache to remain empty after panicked refresh")
	}

	// Clear panic flag: subsequent Context request must refresh normally without hanging.
	execMock.panicRefresh.Store(false)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	payload, status := helper.Context(ctx)
	if status != http.StatusOK {
		t.Fatalf("subsequent Context status = %d, payload = %#v", status, payload)
	}
	if got := unified.Str(unified.Map(payload["data"])["player_id"]); got != "a5c2aafe" {
		t.Fatalf("player_id = %q, want a5c2aafe", got)
	}
	if !helper.HasCachedContext() {
		t.Fatal("expected HasCachedContext() == true after successful refresh")
	}
}

func TestYouTubeHelperMultiAudio120EntriesAndV131Compatibility(t *testing.T) {
	sb := newTestSandbox(t)
	playerJS, err := os.ReadFile(filepath.Join("testdata", "player_base_fixture.js"))
	if err != nil {
		t.Fatal(err)
	}
	execMock := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
	}
	currentNow := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	helper, err := NewHelper(execMock, sb, func() time.Time { return currentNow })
	if err != nil {
		t.Fatal(err)
	}
	if _, st := helper.Context(context.Background()); st != http.StatusOK {
		t.Fatalf("Context status = %d", st)
	}

	const videoID = "R3GfuzLMPkA"
	progFormat := map[string]any{
		"itag":     18,
		"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
		"width":    640,
		"height":   360,
		"fps":      30,
		"bitrate":  500000,
		"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=18&n=CHALLENGE_N_18",
	}

	// Build 45 adaptive video streams across resolutions/codecs.
	videoStreams := make([]any, 0, 45)
	resolutions := [][2]int{{3840, 2160}, {2560, 1440}, {1920, 1080}, {1280, 720}, {854, 480}}
	for i := 0; i < 45; i++ {
		res := resolutions[i%len(resolutions)]
		itag := 137 + i
		mime := `video/mp4; codecs="avc1.640028"`
		if i%3 == 1 {
			mime = `video/webm; codecs="vp9"`
		} else if i%3 == 2 {
			mime = `video/mp4; codecs="av01.0.08M.08"`
		}
		videoStreams = append(videoStreams, map[string]any{
			"itag":     itag,
			"mimeType": mime,
			"width":    res[0],
			"height":   res[1],
			"fps":      30,
			"bitrate":  2500000 - i*10000,
			"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=" + strconv.Itoa(itag) + "&n=CHALLENGE_N_18",
		})
	}

	extractAudioURLs := func(t *testing.T, finPayload unified.Object) (m4aURL, webmURL, attURL string) {
		t.Helper()
		data := unified.Map(finPayload["data"])
		item := unified.Map(unified.Slice(data["items"])[0])
		for _, rawV := range unified.Slice(item["variants"]) {
			v := unified.Map(rawV)
			label := unified.Str(v["label"])
			srcURL := unified.Str(unified.Map(unified.Slice(unified.Map(v["delivery"])["sources"])[0])["url"])
			if strings.HasPrefix(label, "仅音频 M4A") {
				m4aURL = srcURL
			} else if strings.HasPrefix(label, "仅音频 WEBM") {
				webmURL = srcURL
			}
		}
		atts := unified.Slice(data["attachments"])
		if len(atts) > 0 {
			res := unified.Map(unified.Map(atts[0])["resource"])
			attURL = unified.Str(unified.Map(unified.Slice(unified.Map(res["delivery"])["sources"])[0])["url"])
		}
		return m4aURL, webmURL, attURL
	}

	// Subtest 1: 120-entry multi-audio payload (1 prog + 45 video + 18 langs * 4 audio + 2 descriptive = 120)
	// with dubbed & descriptive tracks appearing BEFORE the original default track.
	t.Run("120-entries-with-audioTrack-selects-original-over-dubs-and-descriptive", func(t *testing.T) {
		langs := []struct {
			id   string
			name string
			def  bool
		}{
			{"es.1", "Spanish", false},
			{"fr.1", "French", false},
			{"de.1", "German", false},
			{"pt.1", "Portuguese", false},
			{"hi.1", "Hindi", false},
			{"ar.1", "Arabic", false},
			{"ja.1", "Japanese", false},
			{"ko.1", "Korean", false},
			{"ru.1", "Russian", false},
			{"it.1", "Italian", false},
			{"id.1", "Indonesian", false},
			{"tr.1", "Turkish", false},
			{"vi.1", "Vietnamese", false},
			{"th.1", "Thai", false},
			{"pl.1", "Polish", false},
			{"nl.1", "Dutch", false},
			{"zh-Hans.1", "Chinese (Simplified)", false},
			{"en.4", "English original", true},
		}
		audioItags := []struct {
			itag    int
			mime    string
			bitrate int
		}{
			{139, `audio/mp4; codecs="mp4a.40.5"`, 48000},
			{140, `audio/mp4; codecs="mp4a.40.2"`, 128000},
			{249, `audio/webm; codecs="opus"`, 50000},
			{251, `audio/webm; codecs="opus"`, 160000},
		}

		adaptive := append([]any{}, videoStreams...)
		// Descriptive English tracks marked audioIsDefault: true placed first to ensure descriptive is excluded.
		for _, it := range audioItags[:2] {
			adaptive = append(adaptive, map[string]any{
				"itag":            it.itag,
				"mimeType":        it.mime,
				"bitrate":         it.bitrate + 20000,
				"audioSampleRate": "44100",
				"audioChannels":   2,
				"url":             "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=" + strconv.Itoa(it.itag) + "&track=en-descriptive&n=CHALLENGE_N_18",
				"audioTrack": map[string]any{
					"id":             "en.desc",
					"displayName":    "English descriptive",
					"audioIsDefault": true,
				},
			})
		}
		for _, lg := range langs {
			for _, it := range audioItags {
				br := it.bitrate
				if !lg.def {
					br += 10000 // Give dubbed tracks slightly higher nominal bitrate to prove original still wins!
				}
				adaptive = append(adaptive, map[string]any{
					"itag":            it.itag,
					"mimeType":        it.mime,
					"bitrate":         br,
					"audioSampleRate": "44100",
					"audioChannels":   2,
					"url":             "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=" + strconv.Itoa(it.itag) + "&track=" + lg.id + "&n=CHALLENGE_N_18",
					"audioTrack": map[string]any{
						"id":             lg.id,
						"displayName":    lg.name,
						"audioIsDefault": lg.def,
					},
				})
			}
		}

		total := 1 + len(adaptive)
		if total != 120 {
			t.Fatalf("expected 120 total entries, got %d", total)
		}
		body, err := json.Marshal(map[string]any{
			"video_id":        videoID,
			"player_id":       "a5c2aafe",
			"title":           "Multi-Audio 120 Stream Video",
			"formats":         []any{progFormat},
			"adaptiveFormats": adaptive,
		})
		if err != nil {
			t.Fatal(err)
		}
		payload, status := helper.Finalize(context.Background(), body, false)
		if status != http.StatusOK {
			t.Fatalf("120-entry Finalize status = %d, payload = %#v", status, payload)
		}
		if err := unified.ValidateEnvelopeAt(payload, currentNow.Unix()); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		m4aURL, webmURL, attURL := extractAudioURLs(t, payload)
		if !strings.Contains(m4aURL, "itag=140") || !strings.Contains(m4aURL, "track=en.4") {
			t.Fatalf("M4A audio URL selected wrong track: %q", m4aURL)
		}
		if !strings.Contains(webmURL, "itag=251") || !strings.Contains(webmURL, "track=en.4") {
			t.Fatalf("WebM audio URL selected wrong track: %q", webmURL)
		}
		if !strings.Contains(attURL, "itag=140") || !strings.Contains(attURL, "track=en.4") {
			t.Fatalf("background_audio attachment selected wrong track: %q", attURL)
		}
	})

	// Subtest 2: v1.3.1 backward compatibility (118 entries WITHOUT audioTrack and WITH duplicate itags).
	t.Run("v1.3.1-without-audioTrack-handles-duplicate-itags-and-prefers-original-xtags", func(t *testing.T) {
		adaptive := append([]any{}, videoStreams...)
		// 18 languages * 4 itags = 72 audio streams + 45 video + 1 prog = 118 entries (no audioTrack field).
		for i := 0; i < 18; i++ {
			acont := "dubbed-auto"
			lang := "lang" + strconv.Itoa(i)
			if i == 12 {
				acont = "original"
				lang = "en"
			}
			for _, it := range []struct {
				itag int
				mime string
				br   int
			}{
				{139, `audio/mp4; codecs="mp4a.40.5"`, 48000},
				{140, `audio/mp4; codecs="mp4a.40.2"`, 128000},
				{249, `audio/webm; codecs="opus"`, 50000},
				{251, `audio/webm; codecs="opus"`, 160000},
			} {
				xtags := url.QueryEscape("acont=" + acont + ":lang=" + lang)
				adaptive = append(adaptive, map[string]any{
					"itag":            it.itag,
					"mimeType":        it.mime,
					"bitrate":         it.br,
					"audioSampleRate": "44100",
					"audioChannels":   2,
					"url":             "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=" + strconv.Itoa(it.itag) + "&xtags=" + xtags + "&n=CHALLENGE_N_18",
				})
			}
		}
		if got := 1 + len(adaptive); got != 118 {
			t.Fatalf("expected 118 entries, got %d", got)
		}
		body, _ := json.Marshal(map[string]any{
			"video_id":        videoID,
			"player_id":       "a5c2aafe",
			"formats":         []any{progFormat},
			"adaptiveFormats": adaptive,
		})
		payload, status := helper.Finalize(context.Background(), body, false)
		if status != http.StatusOK {
			t.Fatalf("v1.3.1 118-entry Finalize status = %d, payload = %#v", status, payload)
		}
		if err := unified.ValidateEnvelopeAt(payload, currentNow.Unix()); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		m4aURL, webmURL, attURL := extractAudioURLs(t, payload)
		if !strings.Contains(m4aURL, "acont%3Doriginal%3Alang%3Den") {
			t.Fatalf("v1.3.1 M4A URL did not select xtags original track: %q", m4aURL)
		}
		if !strings.Contains(webmURL, "acont%3Doriginal%3Alang%3Den") {
			t.Fatalf("v1.3.1 WebM URL did not select xtags original track: %q", webmURL)
		}
		if !strings.Contains(attURL, "acont%3Doriginal%3Alang%3Den") {
			t.Fatalf("v1.3.1 attachment URL did not select xtags original track: %q", attURL)
		}
	})

	// Subtest 3: Duplicate audio itags without audioTrack and without xtags keep first-seen track order.
	t.Run("duplicate-itags-without-audioTrack-or-xtags-preserves-first-track", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"video_id":  videoID,
			"player_id": "a5c2aafe",
			"formats":   []any{progFormat},
			"adaptiveFormats": []any{
				videoStreams[0],
				map[string]any{
					"itag":     140,
					"mimeType": `audio/mp4; codecs="mp4a.40.2"`,
					"bitrate":  128000,
					"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=140&order=first&n=CHALLENGE_N_18",
				},
				map[string]any{
					"itag":     140,
					"mimeType": `audio/mp4; codecs="mp4a.40.2"`,
					"bitrate":  128000,
					"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=140&order=second&n=CHALLENGE_N_18",
				},
			},
		})
		payload, status := helper.Finalize(context.Background(), body, false)
		if status != http.StatusOK {
			t.Fatalf("status = %d, payload = %#v", status, payload)
		}
		m4aURL, _, attURL := extractAudioURLs(t, payload)
		if !strings.Contains(m4aURL, "order=first") || !strings.Contains(attURL, "order=first") {
			t.Fatalf("expected first duplicate itag=140 to win, got m4a=%q att=%q", m4aURL, attURL)
		}
	})

	// Subtest 4: Non-English original track (ja.4, audioIsDefault: false) wins over hl="en" English AI auto-dub (en.3, audioIsDefault: true).
	t.Run("non-english-original-track-wins-over-hl-en-auto-dub-marked-default", func(t *testing.T) {
		audioItags := []struct {
			itag    int
			mime    string
			bitrate int
		}{
			{139, `audio/mp4; codecs="mp4a.40.5"`, 48000},
			{140, `audio/mp4; codecs="mp4a.40.2"`, 128000},
			{249, `audio/webm; codecs="opus"`, 50000},
			{251, `audio/webm; codecs="opus"`, 160000},
		}
		adaptive := append([]any{}, videoStreams[:5]...)
		for _, it := range audioItags {
			adaptive = append(adaptive, map[string]any{
				"itag":            it.itag,
				"mimeType":        it.mime,
				"bitrate":         it.bitrate + 16000, // Give English auto-dub higher nominal bitrate and earlier position
				"audioSampleRate": "48000",
				"audioChannels":   2,
				"url":             "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=" + strconv.Itoa(it.itag) + "&xtags=acont%3Ddubbed-auto%3Alang%3Den&n=CHALLENGE_N_18",
				"audioTrack": map[string]any{
					"id":             "en.3",
					"displayName":    "English (auto-dubbed)",
					"audioIsDefault": true,
				},
			})
		}
		for _, it := range audioItags {
			adaptive = append(adaptive, map[string]any{
				"itag":            it.itag,
				"mimeType":        it.mime,
				"bitrate":         it.bitrate,
				"audioSampleRate": "48000",
				"audioChannels":   2,
				"url":             "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=" + strconv.Itoa(it.itag) + "&xtags=acont%3Doriginal%3Alang%3Dja&n=CHALLENGE_N_18",
				"audioTrack": map[string]any{
					"id":             "ja.4",
					"displayName":    "Japanese original",
					"audioIsDefault": false,
				},
			})
		}

		body, err := json.Marshal(map[string]any{
			"video_id":        videoID,
			"player_id":       "a5c2aafe",
			"title":           "Japanese Original Video",
			"formats":         []any{progFormat},
			"adaptiveFormats": adaptive,
		})
		if err != nil {
			t.Fatal(err)
		}
		payload, status := helper.Finalize(context.Background(), body, false)
		if status != http.StatusOK {
			t.Fatalf("Finalize status = %d, payload = %#v", status, payload)
		}
		if err := unified.ValidateEnvelopeAt(payload, currentNow.Unix()); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		m4aURL, webmURL, attURL := extractAudioURLs(t, payload)
		if !strings.Contains(m4aURL, "itag=140") || !strings.Contains(m4aURL, "acont%3Doriginal%3Alang%3Dja") {
			t.Fatalf("M4A audio URL selected wrong track (expected ja.4 original): %q", m4aURL)
		}
		if !strings.Contains(webmURL, "itag=251") || !strings.Contains(webmURL, "acont%3Doriginal%3Alang%3Dja") {
			t.Fatalf("WebM audio URL selected wrong track (expected ja.4 original): %q", webmURL)
		}
		if !strings.Contains(attURL, "itag=140") || !strings.Contains(attURL, "acont%3Doriginal%3Alang%3Dja") {
			t.Fatalf("background_audio attachment selected wrong track (expected ja.4 original): %q", attURL)
		}
	})

	// Subtest 5: convertToYTFormat always combines AudioTrack with parseXtagsAudioHints.
	t.Run("convertToYTFormat-combines-audioTrack-and-xtags-preferences", func(t *testing.T) {
		boolVal := func(v bool) *bool { return &v }
		jaOrig, ok := convertToYTFormat(finalizeFormatInput{
			Itag:       140,
			MimeType:   `audio/mp4; codecs="mp4a.40.2"`,
			AudioTrack: &finalizeAudioTrack{ID: "", DisplayName: "原声", AudioIsDefault: boolVal(false)},
		}, "140", "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id="+videoID+"&itag=140&xtags=acont%3Doriginal%3Alang%3Dja")
		if !ok || jaOrig.Language != "ja" || jaOrig.LanguagePreference == nil || *jaOrig.LanguagePreference != 20 {
			t.Fatalf("expected jaOrig Language=ja LanguagePreference=20, got ok=%v lang=%q pref=%v", ok, jaOrig.Language, jaOrig.LanguagePreference)
		}

		cleanDef, ok := convertToYTFormat(finalizeFormatInput{
			Itag:       140,
			MimeType:   `audio/mp4; codecs="mp4a.40.2"`,
			AudioTrack: &finalizeAudioTrack{ID: "en.4", DisplayName: "English", AudioIsDefault: boolVal(true)},
		}, "140", "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id="+videoID+"&itag=140")
		if !ok || cleanDef.Language != "en" || cleanDef.LanguagePreference == nil || *cleanDef.LanguagePreference != 10 {
			t.Fatalf("expected cleanDef Language=en LanguagePreference=10, got ok=%v lang=%q pref=%v", ok, cleanDef.Language, cleanDef.LanguagePreference)
		}

		enAutoDub, ok := convertToYTFormat(finalizeFormatInput{
			Itag:       140,
			MimeType:   `audio/mp4; codecs="mp4a.40.2"`,
			AudioTrack: &finalizeAudioTrack{ID: "en.3", DisplayName: "English", AudioIsDefault: boolVal(true)},
		}, "140-dup2", "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id="+videoID+"&itag=140&xtags=acont%3Ddubbed-auto%3Alang%3Den")
		if !ok || enAutoDub.Language != "en" || enAutoDub.LanguagePreference == nil || *enAutoDub.LanguagePreference != -10 {
			t.Fatalf("expected enAutoDub Language=en LanguagePreference=-10 even when audioIsDefault=true, got ok=%v lang=%q pref=%v", ok, enAutoDub.Language, enAutoDub.LanguagePreference)
		}

		enDesc, ok := convertToYTFormat(finalizeFormatInput{
			Itag:       140,
			MimeType:   `audio/mp4; codecs="mp4a.40.2"`,
			AudioTrack: &finalizeAudioTrack{ID: "en.desc", DisplayName: "English descriptive", AudioIsDefault: boolVal(true)},
		}, "140-dup3", "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id="+videoID+"&itag=140")
		if !ok || enDesc.LanguagePreference == nil || *enDesc.LanguagePreference > -10 {
			t.Fatalf("expected descriptive track LanguagePreference <= -10, got ok=%v pref=%v", ok, enDesc.LanguagePreference)
		}
	})
}

func TestYouTubeHelperSpecB1PrewarmSWRAndChallengeLRU(t *testing.T) {
	sb := newTestSandbox(t)
	playerJS, err := os.ReadFile(filepath.Join("testdata", "player_base_fixture.js"))
	if err != nil {
		t.Fatal(err)
	}

	// 1. Bounded challenge LRU capacity & eviction semantics.
	lru := newChallengeLRU(3)
	lru.Put("a5c2aafe", "tv", "d1", "n", "k1", "v1")
	lru.Put("a5c2aafe", "tv", "d1", "n", "k2", "v2")
	lru.Put("a5c2aafe", "tv", "d1", "n", "k3", "v3")
	if v, ok := lru.Get("a5c2aafe", "tv", "d1", "n", "k1"); !ok || v != "v1" {
		t.Fatalf("expected k1 hit=v1, got ok=%v v=%q", ok, v)
	}
	// k2 is now least recently used; inserting k4 must evict k2 and keep Len() == 3.
	lru.Put("a5c2aafe", "tv", "d1", "n", "k4", "v4")
	if lru.Len() != 3 {
		t.Fatalf("expected bounded len 3, got %d", lru.Len())
	}
	if _, ok := lru.Get("a5c2aafe", "tv", "d1", "n", "k2"); ok {
		t.Fatal("expected LRU k2 to be evicted")
	}
	if v, ok := lru.Get("a5c2aafe", "tv", "d1", "n", "k1"); !ok || v != "v1" {
		t.Fatalf("expected recently touched k1 to remain cached, got ok=%v v=%q", ok, v)
	}

	// 2. Startup background prewarm (with retry backoff) + SWR proactive refresh before ExpiresAt.
	execMock := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
		fetchDelay:   10 * time.Millisecond,
	}
	execMock.failRefresh.Store(true)

	var nowMu sync.Mutex
	currentNow := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	helper, err := NewHelper(execMock, sb, func() time.Time {
		nowMu.Lock()
		defer nowMu.Unlock()
		return currentNow
	})
	if err != nil {
		t.Fatal(err)
	}
	helper.prewarmBackoffs = []time.Duration{15 * time.Millisecond, 25 * time.Millisecond}
	helper.bgRefreshInterval = time.Hour

	bgCtx, bgCancel := context.WithCancel(context.Background())
	stopBg := helper.StartBackgroundRefresh(bgCtx)
	defer func() {
		bgCancel()
		stopBg()
	}()

	// Allow first attempt to fail, then allow retry to warm cache asynchronously.
	time.Sleep(20 * time.Millisecond)
	execMock.failRefresh.Store(false)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !helper.HasCachedContext() {
		time.Sleep(15 * time.Millisecond)
	}
	if !helper.HasCachedContext() {
		t.Fatal("expected StartBackgroundRefresh retry to warm player context")
	}
	initialPlayerJSHits := execMock.playerJSHits.Load()
	if initialPlayerJSHits != 1 {
		t.Fatalf("expected exactly 1 base.js fetch during prewarm, got %d", initialPlayerJSHits)
	}

	// 3. Advance into [ExpiresAt - SoftRefreshBefore, ExpiresAt) window (5h30m of 6h):
	// Context() must return immediately AND renew ExpiresAt asynchronously without re-downloading base.js when player_id is unchanged.
	nowMu.Lock()
	currentNow = currentNow.Add(DefaultPlayerCacheTTL - 30*time.Minute)
	nowMu.Unlock()
	beforeIframeHits := execMock.iframeHits.Load()
	payload, status := helper.Context(context.Background())
	if status != http.StatusOK {
		t.Fatalf("SWR context status = %d, want 200 (%#v)", status, payload)
	}
	helper.bgWG.Wait()
	if execMock.iframeHits.Load() <= beforeIframeHits {
		t.Fatalf("expected SWR background refresh to probe iframe_api (before=%d after=%d)", beforeIframeHits, execMock.iframeHits.Load())
	}
	if execMock.playerJSHits.Load() != initialPlayerJSHits {
		t.Fatalf("unchanged player_id SWR must not re-fetch base.js (got %d, want %d)", execMock.playerJSHits.Load(), initialPlayerJSHits)
	}
	// Verify renewed TTL extends beyond the original 6h deadline.
	renewedPayload, renewedStatus := helper.Context(context.Background())
	if renewedStatus != http.StatusOK {
		t.Fatalf("renewed context status = %d, want 200", renewedStatus)
	}
	renewedExp, err := time.Parse(time.RFC3339, unified.Str(unified.Map(renewedPayload["data"])["expires_at"]))
	if err != nil {
		t.Fatalf("invalid renewed expires_at: %v", err)
	}
	expectedMinExp := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC).Add(DefaultPlayerCacheTTL + 5*time.Hour)
	if renewedExp.Before(expectedMinExp) {
		t.Fatalf("expected SWR-renewed expires_at >= %s, got %s", expectedMinExp, renewedExp)
	}

	// 4. Finalize challenge LRU cache hit skips Deno solver on repeat challenges.
	sampleJSON, err := os.ReadFile(filepath.Join("testdata", "finalize_sample_46.json"))
	if err != nil {
		t.Fatal(err)
	}
	firstRes, firstStatus := helper.Finalize(context.Background(), sampleJSON, false)
	if firstStatus != http.StatusOK {
		t.Fatalf("first Finalize status = %d, want 200 (%#v)", firstStatus, firstRes)
	}
	if helper.challengeCache.Len() == 0 {
		t.Fatal("expected Finalize to populate challengeCache LRU")
	}
	// Replace sandbox with an unconfigured empty sandbox (would fail if invoked) to prove 100% cache hit skips Deno!
	savedSandbox := helper.sandbox
	helper.sandbox = &EJSSandbox{}
	secondRes, secondStatus := helper.Finalize(context.Background(), sampleJSON, false)
	helper.sandbox = savedSandbox
	if secondStatus != http.StatusOK {
		t.Fatalf("second Finalize with warm challenge LRU must succeed without invoking Deno, got %d (%#v)", secondStatus, secondRes)
	}
}

func TestYouTubeHelperRound2StaleGraceWritebackAndBgShutdown(t *testing.T) {
	sb := newTestSandbox(t)
	playerJS, err := os.ReadFile(filepath.Join("testdata", "player_base_fixture.js"))
	if err != nil {
		t.Fatal(err)
	}
	sampleJSON, err := os.ReadFile(filepath.Join("testdata", "finalize_sample_46.json"))
	if err != nil {
		t.Fatal(err)
	}

	// 1. [P1] Synchronous executeRefreshCall stale fallback must persist grace ExpiresAt
	// back into h.cache so an immediate Finalize() succeeds instead of returning 400 INVALID_INPUT.
	execMock := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
	}
	var nowMu sync.Mutex
	currentNow := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	helper, err := NewHelper(execMock, sb, func() time.Time {
		nowMu.Lock()
		defer nowMu.Unlock()
		return currentNow
	})
	if err != nil {
		t.Fatal(err)
	}

	// Populate initial cache via Context().
	if payload, status := helper.Context(context.Background()); status != http.StatusOK {
		t.Fatalf("initial Context status = %d, payload = %#v", status, payload)
	}
	// Advance past ExpiresAt (6h) into stale grace window (e.g. 6h + 10m <= 12h),
	// fail upstream refresh, and trigger synchronous executeRefreshCall via runSingleflightRefresh.
	nowMu.Lock()
	currentNow = currentNow.Add(DefaultPlayerCacheTTL + 10*time.Minute)
	nowMu.Unlock()
	execMock.failRefresh.Store(true)

	served, err := helper.runSingleflightRefresh(context.Background())
	if err != nil || served == nil {
		t.Fatalf("expected stale fallback from runSingleflightRefresh, got entry=%v err=%v", served, err)
	}
	// Immediate Finalize() MUST pass lookupCachedPlayer's !now.Before(entry.ExpiresAt) check!
	finPayload, finStatus := helper.Finalize(context.Background(), sampleJSON, false)
	if finStatus != http.StatusOK {
		t.Fatalf("Finalize after executeRefreshCall stale fallback = %d, want 200 (%#v)", finStatus, finPayload)
	}

	// 2. [P2] Stopping StartBackgroundRefresh cancels in-flight refresh immediately via h.bgCtx
	// (millisecond shutdown rather than waiting for 35s refresh timeout).
	slowExec := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
		fetchDelay:   5 * time.Second,
	}
	slowHelper, err := NewHelper(slowExec, sb, func() time.Time { return currentNow })
	if err != nil {
		t.Fatal(err)
	}
	slowHelper.prewarmBackoffs = nil
	slowHelper.bgRefreshInterval = time.Hour

	stopBg := slowHelper.StartBackgroundRefresh(context.Background())
	// Wait briefly for startup prewarm fetch to enter Do(ctx, ...).
	waitStart := time.Now().Add(2 * time.Second)
	for time.Now().Before(waitStart) && slowExec.startedHits.Load() == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if slowExec.startedHits.Load() == 0 {
		t.Fatal("expected slow prewarm fetch to start")
	}

	stopBegin := time.Now()
	stopBg()
	if elapsed := time.Since(stopBegin); elapsed >= 1500*time.Millisecond {
		t.Fatalf("stopBg() took %s; expected fast cancellation via h.bgCtx (< 1.5s)", elapsed)
	}
}

func TestYouTubeHelperPlayerJSVariantPreferenceAndFallback(t *testing.T) {
	sb := newTestSandbox(t)
	playerJS, err := os.ReadFile(filepath.Join("testdata", "player_base_fixture.js"))
	if err != nil {
		t.Fatal(err)
	}
	sampleJSON, err := os.ReadFile(filepath.Join("testdata", "finalize_sample_46.json"))
	if err != nil {
		t.Fatal(err)
	}
	currentNow := time.Date(2026, 11, 25, 6, 0, 0, 0, time.UTC)

	// 0. URL allowlist permits both TV and main player variants on https://www.youtube.com only.
	if !AllowYouTubePlayerFetchURL("https://www.youtube.com/s/player/b485e332/tv-player-ias.vflset/tv-player-ias.js") {
		t.Fatal("expected TV player variant URL to be allowed")
	}
	if !AllowYouTubePlayerFetchURL("https://www.youtube.com/s/player/b485e332/player_ias.vflset/en_US/base.js") {
		t.Fatal("expected main player variant URL to be allowed")
	}
	if AllowYouTubePlayerFetchURL("http://www.youtube.com/s/player/b485e332/tv-player-ias.vflset/tv-player-ias.js") ||
		AllowYouTubePlayerFetchURL("https://evil.example.com/s/player/b485e332/tv-player-ias.vflset/tv-player-ias.js") {
		t.Fatal("expected non-HTTPS or non-youtube.com player variant URLs to be rejected")
	}

	// 1. Default path prefers tv-player-ias.js without touching main base.js.
	primaryExec := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
	}
	primaryHelper, err := NewHelper(primaryExec, sb, func() time.Time { return currentNow })
	if err != nil {
		t.Fatal(err)
	}
	if payload, status := primaryHelper.Context(context.Background()); status != http.StatusOK {
		t.Fatalf("primary TV Context status = %d, payload = %#v", status, payload)
	}
	if primaryExec.tvPlayerJSHits.Load() != 1 || primaryExec.mainPlayerJSHits.Load() != 0 || primaryExec.forbiddenHits.Load() != 0 {
		t.Fatalf("expected tv=1 main=0 forbidden=0, got tv=%d main=%d forbidden=%d",
			primaryExec.tvPlayerJSHits.Load(), primaryExec.mainPlayerJSHits.Load(), primaryExec.forbiddenHits.Load())
	}

	// 2. When tv-player-ias.js fetch fails (e.g. HTTP 502), automatically falls back to main base.js.
	fetchFallbackExec := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
	}
	fetchFallbackExec.failTVFetch.Store(true)
	fetchFallbackHelper, err := NewHelper(fetchFallbackExec, sb, func() time.Time { return currentNow })
	if err != nil {
		t.Fatal(err)
	}
	if payload, status := fetchFallbackHelper.Context(context.Background()); status != http.StatusOK {
		t.Fatalf("fetch fallback Context status = %d, payload = %#v", status, payload)
	}
	if fetchFallbackExec.tvPlayerJSHits.Load() != 1 || fetchFallbackExec.mainPlayerJSHits.Load() != 1 || fetchFallbackExec.forbiddenHits.Load() != 0 {
		t.Fatalf("expected tv=1 main=1 forbidden=0, got tv=%d main=%d forbidden=%d",
			fetchFallbackExec.tvPlayerJSHits.Load(), fetchFallbackExec.mainPlayerJSHits.Load(), fetchFallbackExec.forbiddenHits.Load())
	}
	// Cache hit avoids re-fetching either variant.
	if _, status := fetchFallbackHelper.Context(context.Background()); status != http.StatusOK {
		t.Fatalf("cached fallback Context status = %d, want 200", status)
	}
	if fetchFallbackExec.tvPlayerJSHits.Load() != 1 || fetchFallbackExec.mainPlayerJSHits.Load() != 1 {
		t.Fatalf("expected cached Context not to refetch variants, got tv=%d main=%d",
			fetchFallbackExec.tvPlayerJSHits.Load(), fetchFallbackExec.mainPlayerJSHits.Load())
	}

	// 3. When tv-player-ias.js downloads 200 with a valid signatureTimestamp but fails EJS preprocessing
	// (e.g. AST/runtime syntax or solver mismatch), automatically falls back to main base.js.
	preprocessFallbackExec := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		tvPlayerJS:   []byte(`var meta = {signatureTimestamp:20779}; function broken( { syntax error`),
		playerBaseJS: playerJS,
	}
	preprocessFallbackHelper, err := NewHelper(preprocessFallbackExec, sb, func() time.Time { return currentNow })
	if err != nil {
		t.Fatal(err)
	}
	ppPayload, ppStatus := preprocessFallbackHelper.Context(context.Background())
	if ppStatus != http.StatusOK {
		t.Fatalf("preprocess fallback Context status = %d, payload = %#v", ppStatus, ppPayload)
	}
	if preprocessFallbackExec.tvPlayerJSHits.Load() != 1 || preprocessFallbackExec.mainPlayerJSHits.Load() != 1 {
		t.Fatalf("expected tv=1 main=1 after preprocess fallback, got tv=%d main=%d",
			preprocessFallbackExec.tvPlayerJSHits.Load(), preprocessFallbackExec.mainPlayerJSHits.Load())
	}
	if gotSTS, ok := unified.Numeric(unified.Map(ppPayload["data"])["signature_timestamp"]); !ok || int(gotSTS) != 20760 {
		t.Fatalf("expected fallback signature_timestamp=20760, got %v", unified.Map(ppPayload["data"])["signature_timestamp"])
	}
	if finPayload, finStatus := preprocessFallbackHelper.Finalize(context.Background(), sampleJSON, false); finStatus != http.StatusOK {
		t.Fatalf("Finalize after preprocess fallback status = %d, payload = %#v", finStatus, finPayload)
	}

	// 4. When both variants fail, Context returns 502 UPSTREAM_UNAVAILABLE cleanly.
	bothFailExec := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
	}
	bothFailExec.failTVFetch.Store(true)
	bothFailExec.failMainFetch.Store(true)
	bothFailHelper, err := NewHelper(bothFailExec, sb, func() time.Time { return currentNow })
	if err != nil {
		t.Fatal(err)
	}
	failPayload, failStatus := bothFailHelper.Context(context.Background())
	if failStatus != http.StatusBadGateway || unified.Str(failPayload["code"]) != "UPSTREAM_UNAVAILABLE" {
		t.Fatalf("expected 502 UPSTREAM_UNAVAILABLE when both variants fail, got status=%d payload=%#v", failStatus, failPayload)
	}
	if bothFailExec.tvPlayerJSHits.Load() != 1 || bothFailExec.mainPlayerJSHits.Load() != 1 {
		t.Fatalf("expected both variants attempted once, got tv=%d main=%d",
			bothFailExec.tvPlayerJSHits.Load(), bothFailExec.mainPlayerJSHits.Load())
	}
}

func TestYouTubeHelperGovernanceWave1Hardening(t *testing.T) {
	sb := newTestSandbox(t)
	playerJS, err := os.ReadFile(filepath.Join("testdata", "player_base_fixture.js"))
	if err != nil {
		t.Fatal(err)
	}
	sampleJSON, err := os.ReadFile(filepath.Join("testdata", "finalize_sample_46.json"))
	if err != nil {
		t.Fatal(err)
	}

	// 1. M2 Refresh-time Solve Smoke Probe: a tv variant that passes AST preprocessing
	// cleanly yet throws at runtime inside the n-solver must automatically fall back to
	// main base.js during refresh (keeping Finalize zero-network and sts-consistent).
	brokenNSolverTVJS := []byte(`var _yt_player={};
(function(g){
  var window=this;
  g.sts={signatureTimestamp:20779};
  function U(u){this.m={};}
  U.prototype.set=function(k,v){this.m[k]=v;};
  U.prototype.get=function(k){return this.m[k];};
  U.prototype.clone=function(){return new U("");};
  U.prototype.apply=function(){
    if(this.m.s){var d=decodeURIComponent(this.m.s);this.m.s=encodeURIComponent("SOLVED_SIG_"+d.split("").reverse().join(""));}
    if(this.m.n){throw new TypeError("simulated tv n-solver runtime failure");}
  };
  var makeUrl=function(raw,k,v){
    var u=new U(raw);
    u.set("alr","yes");
    if(k&&v!==undefined){u.set(k,v);}
    return u;
  };
})(_yt_player);`)
	// Confirm brokenNSolverTVJS genuinely passes plain PreprocessPlayer so the test proves
	// the Solve smoke probe (not AST syntax rejection) triggered the fallback.
	if _, preErr := sb.PreprocessPlayer(context.Background(), string(brokenNSolverTVJS)); preErr != nil {
		t.Fatalf("expected brokenNSolverTVJS to pass plain PreprocessPlayer, got: %v", preErr)
	}
	probeFallbackExec := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		tvPlayerJS:   brokenNSolverTVJS,
		playerBaseJS: playerJS,
	}
	probeNow := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	probeHelper, err := NewHelper(probeFallbackExec, sb, func() time.Time { return probeNow })
	if err != nil {
		t.Fatal(err)
	}
	pPayload, pStatus := probeHelper.Context(context.Background())
	if pStatus != http.StatusOK {
		t.Fatalf("Context after n-probe fallback = %d, want 200 (%#v)", pStatus, pPayload)
	}
	if probeFallbackExec.tvPlayerJSHits.Load() != 1 || probeFallbackExec.mainPlayerJSHits.Load() != 1 {
		t.Fatalf("expected tv=1 main=1 on n-probe fallback, got tv=%d main=%d",
			probeFallbackExec.tvPlayerJSHits.Load(), probeFallbackExec.mainPlayerJSHits.Load())
	}
	probeStats := probeHelper.HelperStatsSnapshot()
	if probeStats.ActiveVariant != "main" || !probeStats.ActivePlayerCached || probeStats.RefreshSuccesses != 1 {
		t.Fatalf("unexpected stats after n-probe fallback: %+v", probeStats)
	}
	if finPayload, finStatus := probeHelper.Finalize(context.Background(), sampleJSON, false); finStatus != http.StatusOK {
		t.Fatalf("Finalize after n-probe fallback = %d, want 200 (%#v)", finStatus, finPayload)
	}

	// 2. M1 Exponential Failure Cooldown & Telemetry: cold refresh failure activates 5s cooldown
	// so immediate retries fail fast without hammering upstream or Deno.
	var nowMu sync.Mutex
	coolNow := time.Date(2026, 11, 25, 11, 0, 0, 0, time.UTC)
	coolExec := &mockYouTubeFetchExecutor{
		playerID:     "a5c2aafe",
		playerBaseJS: playerJS,
	}
	coolExec.failRefresh.Store(true)
	coolHelper, err := NewHelper(coolExec, sb, func() time.Time {
		nowMu.Lock()
		defer nowMu.Unlock()
		return coolNow
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, st := coolHelper.Context(context.Background()); st != http.StatusBadGateway {
		t.Fatalf("first failing Context = %d, want 502", st)
	}
	hitsAfterFirstFail := coolExec.iframeHits.Load()
	if hitsAfterFirstFail != 1 {
		t.Fatalf("expected 1 iframe hit after first fail, got %d", hitsAfterFirstFail)
	}
	// Immediate second Context within 5s cooldown must NOT hit upstream.
	if _, st := coolHelper.Context(context.Background()); st != http.StatusBadGateway {
		t.Fatalf("cooldown Context = %d, want 502", st)
	}
	if coolExec.iframeHits.Load() != hitsAfterFirstFail {
		t.Fatalf("cooldown retry hit upstream: got %d, want %d", coolExec.iframeHits.Load(), hitsAfterFirstFail)
	}
	coolStats := coolHelper.HelperStatsSnapshot()
	if !coolStats.InCooldown || coolStats.CooldownSkips != 1 || coolStats.RefreshFailures != 1 || coolStats.ConsecutiveFailures != 1 {
		t.Fatalf("unexpected cooldown stats: %+v", coolStats)
	}
	// Advance clock by 5s and recover upstream -> retry succeeds and clears cooldown.
	nowMu.Lock()
	coolNow = coolNow.Add(5 * time.Second)
	nowMu.Unlock()
	coolExec.failRefresh.Store(false)
	if _, st := coolHelper.Context(context.Background()); st != http.StatusOK {
		t.Fatalf("post-cooldown recovered Context = %d, want 200", st)
	}
	recoveredStats := coolHelper.HelperStatsSnapshot()
	if recoveredStats.InCooldown || recoveredStats.ConsecutiveFailures != 0 || recoveredStats.RefreshSuccesses != 1 {
		t.Fatalf("unexpected recovered stats: %+v", recoveredStats)
	}

	// 3. M6 Variant + Preprocessed Digest Namespaced LRU & MaxPlayerRenewalAge (24h) Cap.
	lru := newChallengeLRU(16)
	lru.Put("a5c2aafe", "tv", "digest_tv_1", "n", "ch1", "val_tv")
	if got, ok := lru.Get("a5c2aafe", "main", "digest_main_1", "n", "ch1"); ok || got != "" {
		t.Fatalf("expected cross-variant LRU miss, got (%q, %v)", got, ok)
	}
	if got, ok := lru.Get("a5c2aafe", "tv", "digest_tv_2", "n", "ch1"); ok || got != "" {
		t.Fatalf("expected cross-digest LRU miss, got (%q, %v)", got, ok)
	}
	if got, ok := lru.Get("a5c2aafe", "tv", "digest_tv_1", "n", "ch1"); !ok || got != "val_tv" {
		t.Fatalf("expected exact variant+digest LRU hit, got (%q, %v)", got, ok)
	}
	// Advance coolHelper past MaxPlayerRenewalAge (24h) via successive renewals with unchanged player_id;
	// refreshActivePlayer must eventually force a fresh player JS fetch instead of renewing forever.
	initialPlayerFetches := coolExec.playerJSHits.Load()
	for step := 0; step < 5; step++ {
		nowMu.Lock()
		coolNow = coolNow.Add(DefaultPlayerCacheTTL - 30*time.Minute)
		nowMu.Unlock()
		if _, err := coolHelper.refreshActivePlayer(context.Background()); err != nil {
			t.Fatalf("refreshActivePlayer step %d failed: %v", step, err)
		}
	}
	if coolExec.playerJSHits.Load() <= initialPlayerFetches {
		t.Fatalf("expected MaxPlayerRenewalAge (24h) to force fresh player JS fetch (initial=%d, final=%d)",
			initialPlayerFetches, coolExec.playerJSHits.Load())
	}

	// 4. Mid-flight client disconnect must still record global failure cooldown
	// whenever the detached singleflight refresh (bgCtx or context.WithoutCancel)
	// actually ran to upstream failure.
	verifyDisconnectRecordsCooldown := func(t *testing.T, withBgCtx bool) {
		t.Helper()
		slowFailExec := &mockYouTubeFetchExecutor{
			playerID:     "a5c2aafe",
			playerBaseJS: playerJS,
			fetchDelay:   60 * time.Millisecond,
		}
		fixedNow := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
		h, err := NewHelper(slowFailExec, sb, func() time.Time { return fixedNow })
		if err != nil {
			t.Fatal(err)
		}
		if withBgCtx {
			h.prewarmBackoffs = nil
			h.bgRefreshInterval = time.Hour
			stopBg := h.StartBackgroundRefresh(context.Background())
			defer stopBg()
			// Wait for initial prewarm to complete cleanly so h.bgCtx is active and
			// refreshCall is idle before arming the slow-failure case.
			waitWarm := time.Now().Add(3 * time.Second)
			for time.Now().Before(waitWarm) {
				h.mu.Lock()
				idle := h.refreshCall == nil && h.activeID != ""
				h.mu.Unlock()
				if idle {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			h.mu.Lock()
			ready := h.refreshCall == nil && h.activeID != ""
			h.mu.Unlock()
			if !ready {
				t.Fatal("expected StartBackgroundRefresh prewarm to settle before test")
			}
			h.InvalidateCache()
		}
		slowFailExec.failRefresh.Store(true)
		startedBefore := slowFailExec.startedHits.Load()
		iframeBefore := slowFailExec.iframeHits.Load()

		reqCtx, reqCancel := context.WithCancel(context.Background())
		done := make(chan int, 1)
		go func() {
			_, status := h.Context(reqCtx)
			done <- status
		}()

		waitStart := time.Now().Add(2 * time.Second)
		for time.Now().Before(waitStart) && slowFailExec.startedHits.Load() <= startedBefore {
			time.Sleep(5 * time.Millisecond)
		}
		if slowFailExec.startedHits.Load() <= startedBefore {
			reqCancel()
			t.Fatal("expected cold refresh to enter executor.Do before client cancel")
		}
		// Client disconnects mid-flight while upstream refresh continues on refreshBase.
		reqCancel()
		if st := <-done; st != http.StatusBadGateway {
			t.Fatalf("canceled cold Context status = %d, want 502", st)
		}

		stats := h.HelperStatsSnapshot()
		if !stats.InCooldown || stats.ConsecutiveFailures != 1 {
			t.Fatalf("expected cooldown active after mid-flight client disconnect (withBgCtx=%v), got %+v", withBgCtx, stats)
		}
		if gotHits := slowFailExec.iframeHits.Load(); gotHits != iframeBefore+1 {
			t.Fatalf("expected exactly 1 failed iframe_api attempt (withBgCtx=%v), got %d (before=%d)", withBgCtx, gotHits, iframeBefore)
		}

		// Immediate follow-up request must hit cooldown skip without touching upstream.
		if _, st := h.Context(context.Background()); st != http.StatusBadGateway {
			t.Fatalf("follow-up cooldown Context status = %d, want 502", st)
		}
		if gotHits := slowFailExec.iframeHits.Load(); gotHits != iframeBefore+1 {
			t.Fatalf("follow-up request bypassed cooldown and hit upstream (withBgCtx=%v): got %d, want %d", withBgCtx, gotHits, iframeBefore+1)
		}
		if after := h.HelperStatsSnapshot(); after.CooldownSkips != 1 {
			t.Fatalf("expected CooldownSkips=1 after follow-up (withBgCtx=%v), got %+v", withBgCtx, after)
		}
	}
	t.Run("midflight-disconnect-records-cooldown-without-bgCtx", func(t *testing.T) {
		verifyDisconnectRecordsCooldown(t, false)
	})
	t.Run("midflight-disconnect-records-cooldown-with-bgCtx", func(t *testing.T) {
		verifyDisconnectRecordsCooldown(t, true)
	})
}
