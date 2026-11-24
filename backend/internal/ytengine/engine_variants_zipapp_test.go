package ytengine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

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
