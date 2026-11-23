package ytgeneric

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func genInt64Ptr(v int64) *int64       { return &v }
func genFloat64Ptr(v float64) *float64 { return &v }

type errResolver struct {
	err error
}

func (r errResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return nil, r.err
}

func assertGenericEnvelopeValid(t *testing.T, payload unified.Object, now int64, wantCode string) {
	t.Helper()
	if err := unified.ValidateEnvelopeAt(payload, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v\npayload=%+v", err, payload)
	}
	if got := unified.Str(payload["code"]); got != wantCode {
		t.Fatalf("code = %q, want %q; payload=%+v", got, wantCode, payload)
	}
	if wantCode == "OK" {
		for _, debug := range []bool{false, true} {
			pub := unified.PublicView(payload, debug, now)
			if err := unified.ValidateEnvelopeAt(pub, now); err != nil {
				t.Fatalf("ValidateEnvelopeAt(PublicView debug=%v) failed: %v", debug, err)
			}
		}
	}
}

func TestGenericExtractorArgs(t *testing.T) {
	want := []string{
		"default",
		"-generic",
		"-douyin.*",
		"-iesdouyin.*",
		"-bilibili.*",
		"-weibo.*",
		"-toutiao.*",
		"-kuaishou.*",
		"-pipixia.*",
		"-pipigx.*",
		"-zuiyou.*",
		"-xiaohongshu.*",
		"-rednote.*",
		"-twitter.*",
		"-youtube.*",
		"-instagram.*",
		"-facebook.*",
		"-tumblr.*",
	}
	got := GenericExtractorArgs()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("GenericExtractorArgs() = %v, want %v", got, want)
	}
	// Mutating returned slice must not affect subsequent calls.
	got[0] = "tampered"
	if !reflect.DeepEqual(GenericExtractorArgs(), want) {
		t.Fatal("GenericExtractorArgs() shared backing slice across calls")
	}
}

func TestAllowedGenericOutboundHost(t *testing.T) {
	allowed := []string{
		"vimeo.com",
		"VIMEO.COM.",
		"tiktok.com",
		"video.example.com",
		"media.example",
		"cdn.vimeo.test",
		"sub.media.test",
		"a-b.co.uk",
		"my-site.xn--fiqs8s",
		"www.notdokitool.com",
		"123.example.org",
	}
	for _, host := range allowed {
		if !AllowedGenericOutboundHost(host) {
			t.Fatalf("AllowedGenericOutboundHost(%q) = false, want true", host)
		}
	}

	longLabel := strings.Repeat("a", 64) + ".com"
	longHost := strings.Repeat("a.", 127) + "com" // 257 bytes > 253
	rejected := []string{
		"",
		" ",
		" vimeo.com",
		"vimeo.com ",
		"vimeo.com\n",
		"vimeo.com\t",
		"127.0.0.1",
		"8.8.8.8",
		"10.0.0.1",
		"169.254.169.254",
		"::1",
		"2001:db8::1",
		"[::1]",
		"2130706433",
		"0x7f000001",
		"0177.0.0.1",
		"127.1",
		"0x7f.0.0.1",
		"0x7f.0x0.0x0.0x1",
		"intranet",
		"localhost",
		"LOCALHOST",
		"localhost.",
		"sub.localhost",
		"my.sub.localhost",
		"printer.local",
		"service.internal",
		"metadata.google.internal",
		"box.localdomain",
		"home.arpa",
		"router.home.arpa",
		"invalid",
		"foo.invalid",
		"SUB.INVALID.",
		"lan",
		"router.lan",
		"corp",
		"sso.corp",
		"portal.intranet",
		"private",
		"db.private",
		"a.b.private",
		"dokitool.com",
		"DOKITOOL.COM",
		"snap.dokitool.com",
		"api.sub.dokitool.com",
		"foo..bar.com",
		".vimeo.com",
		"vimeo.com..",
		"-bad.com",
		"bad-.com",
		"foo.-bar.com",
		"foo.bar-.com",
		"foo_bar.com",
		"foo.123",
		"foo.a",
		"foo.xn--",
		longLabel,
		longHost,
	}
	for _, host := range rejected {
		if AllowedGenericOutboundHost(host) {
			t.Fatalf("AllowedGenericOutboundHost(%q) = true, want false", host)
		}
	}
}

func TestNormalizeAndAllowedGenericInputURL(t *testing.T) {
	validCases := []struct {
		raw  string
		want string
	}{
		{"https://vimeo.com/123456", "https://vimeo.com/123456"},
		{"http://vimeo.com:80/123456", "http://vimeo.com/123456"},
		{"https://vimeo.com:443/123456?h=abc", "https://vimeo.com/123456?h=abc"},
		{"HTTPS://Vimeo.COM/watch/123", "https://vimeo.com/watch/123"},
		{"https://vimeo.com/?v=123", "https://vimeo.com/?v=123"},
		{"https://vimeo.com?v=123", "https://vimeo.com?v=123"},
		{"https://www.tiktok.com/@creator/video/7123456789012345678", "https://www.tiktok.com/@creator/video/7123456789012345678"},
		{"https://soundcloud.com/artist/track-name", "https://soundcloud.com/artist/track-name"},
		{"https://media.example/video/123", "https://media.example/video/123"},
		{"https://cdn.vimeo.test/video/123", "https://cdn.vimeo.test/video/123"},
	}
	for _, tc := range validCases {
		got, ok := NormalizeGenericInputURL(tc.raw)
		if !ok || got != tc.want {
			t.Fatalf("NormalizeGenericInputURL(%q) = (%q, %v), want (%q, true)", tc.raw, got, ok, tc.want)
		}
		if !AllowedGenericInputURL(tc.raw) {
			t.Fatalf("AllowedGenericInputURL(%q) = false, want true", tc.raw)
		}
	}

	over2048 := "https://vimeo.com/" + strings.Repeat("a", 2040)
	rejected := []string{
		"",
		over2048,
		"-https://vimeo.com/123",
		"--exec=id",
		" https://vimeo.com/123",
		"https://vimeo.com/123 ",
		"https://vimeo.com/123\n",
		"https://vimeo.com/123\x00",
		"https://vimeo.com/中文",
		"https://vimeo.com/a\\b",
		"https://vimeo.com/123#t=10",
		"https://vimeo.com/123#",
		"https://user:pass@vimeo.com/123",
		"https://user@vimeo.com/123",
		"file:///etc/passwd",
		"ftp://vimeo.com/123",
		"javascript:alert(1)",
		"mailto:a@b.com",
		"//vimeo.com/123",
		"https://vimeo.com:8443/123",
		"http://vimeo.com:443/123",
		"https://vimeo.com:80/123",
		"https://vimeo.com:/123",
		"https://vimeo.com:0443/123",
		"https://127.0.0.1/123",
		"https://[::1]/123",
		"https://localhost/123",
		"https://sub.localhost/123",
		"https://nas.local/123",
		"https://metadata.google.internal/computeMetadata/v1/",
		"https://router.home.arpa/admin",
		"https://foo.invalid/video/1",
		"https://router.lan/video/1",
		"https://portal.corp/video/1",
		"https://app.intranet/video/1",
		"https://db.private/video/1",
		"https://dokitool.com/parse",
		"https://snap.dokitool.com/api/parse?url=x",
		"https://intranet/video/1",
		"https://vimeo.com",
		"https://vimeo.com/",
		"https://vimeo.com///",
	}
	for _, raw := range rejected {
		if got, ok := NormalizeGenericInputURL(raw); ok {
			t.Fatalf("NormalizeGenericInputURL(%q) unexpectedly succeeded with %q", raw, got)
		}
		if AllowedGenericInputURL(raw) {
			t.Fatalf("AllowedGenericInputURL(%q) = true, want false", raw)
		}
	}
}

func TestAllowedGenericMediaURL(t *testing.T) {
	valid := []string{
		"https://cdn.vimeo.test/video/1080p.mp4?token=abc",
		"https://media.example/video/1080p.mp4",
		"http://cdn.example.com:80/audio/track.mp3",
		"https://cdn.example.com:443/clip.webm",
		"https://cdn.example.com/" + strings.Repeat("a", 8100),
	}
	for _, raw := range valid {
		if !AllowedGenericMediaURL(raw) {
			t.Fatalf("AllowedGenericMediaURL(%q) = false, want true", raw)
		}
	}

	over8192 := "https://cdn.example.com/" + strings.Repeat("a", 8192)
	rejected := []string{
		"",
		over8192,
		"https://cdn.example.com/v.mp4#frag",
		"https://cdn.example.com/v.mp4#",
		"https://user:pass@cdn.example.com/v.mp4",
		"https://cdn.example.com:8443/v.mp4",
		"http://cdn.example.com:443/v.mp4",
		"https://cdn.example.com:80/v.mp4",
		"https://cdn.example.com:/v.mp4",
		"https://127.0.0.1/v.mp4",
		"https://localhost/v.mp4",
		"https://printer.local/v.mp4",
		"https://metadata.google.internal/v.mp4",
		"https://foo.invalid/v.mp4",
		"https://router.lan/v.mp4",
		"https://portal.corp/v.mp4",
		"https://app.intranet/v.mp4",
		"https://db.private/v.mp4",
		"https://snap.dokitool.com/v.mp4",
		"https://dokitool.com/v.mp4",
		"ftp://cdn.example.com/v.mp4",
		"https://cdn.example.com/v.mp4\n",
		"https://cdn.example.com/v\\1.mp4",
		"https://cdn.example.com/中文.mp4",
	}
	for _, raw := range rejected {
		if AllowedGenericMediaURL(raw) {
			t.Fatalf("AllowedGenericMediaURL(%q) = true, want false", raw)
		}
	}
}

func TestNormalizeExtractorPlatform(t *testing.T) {
	schemaRe := regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

	allowedCases := []struct {
		key, ext string
		want     string
	}{
		{"TikTok", "tiktok", "tiktok"},
		{"TikTokUser", "tiktok:user", "tiktokuser"},
		{"Vimeo", "vimeo", "vimeo"},
		{"Vimeo:Album", "vimeo:album", "vimeo_album"},
		{"Reddit", "Reddit", "reddit"},
		{"Twitch", "twitch", "twitch"},
		{"TwitchVod", "twitch:vod", "twitchvod"},
		{"", "twitch:clips", "twitch_clips"},
		{"Soundcloud", "soundcloud", "soundcloud"},
		{"Niconico", "niconico", "niconico"},
		{"Pinterest", "pinterest", "pinterest"},
		{"Dailymotion", "dailymotion", "dailymotion"},
		{"VK", "vk", "vk"},
		{"Streamable", "streamable", "streamable"},
		{"Bandcamp", "Bandcamp", "bandcamp"},
		{"Ximalaya", "ximalaya", "ximalaya"},
		{"9gag", "9gag", "site_9gag"},
		{"17Live", "17live", "site_17live"},
		{"  ", "bandcamp:album", "bandcamp_album"},
		{"Foo---Bar::Baz", "", "foo_bar_baz"},
		{"VeryLongNamedSiteExtractorKeyExceedingThirtyTwoBytes", "", "verylongnamedsiteextractorkeyexc"},
		{"abcdefghijklmnopqrstuvwxyz12345_extra", "", "abcdefghijklmnopqrstuvwxyz12345"},
	}
	for _, tc := range allowedCases {
		got := NormalizeExtractorPlatform(tc.key, tc.ext)
		if got != tc.want {
			t.Fatalf("NormalizeExtractorPlatform(%q, %q) = %q, want %q", tc.key, tc.ext, got, tc.want)
		}
		if !schemaRe.MatchString(got) {
			t.Fatalf("normalized platform %q violates ^[a-z][a-z0-9_]{0,31}$", got)
		}
	}

	rejectedCases := [][2]string{
		{"", ""},
		{"___", "::"},
		{"Generic", "generic"},
		{"generic", ""},
		{"generic:html5", ""},
		{"Custom", "generic"},
		{"all", ""},
		{"unknown", ""},
		{"Douyin", "douyin"},
		{"IESDouyin", "iesdouyin"},
		{"BiliBili", "BiliBili"},
		{"BiliBiliBangumi", "bilibili:bangumi"},
		{"BiliLive", "bililive"},
		{"Weibo", "weibo"},
		{"WeiboVideo", "weibo:video"},
		{"Toutiao", "toutiao"},
		{"Kuaishou", "kuaishou"},
		{"Pipixia", "pipixia"},
		{"Pipigx", "pipigx"},
		{"Zuiyou", "zuiyou"},
		{"XiaoHongShu", "xiaohongshu"},
		{"RedNote", "rednote"},
		{"Twitter", "twitter"},
		{"TwitterCard", "twitter:card"},
		{"X", "x"},
		{"x:status", ""},
		{"x_video", ""},
		{"Youtube", "youtube"},
		{"YoutubeTab", "youtube:tab"},
		{"YoutubeShorts", ""},
		{"CustomAlias", "youtube:tab"},
		{"Instagram", "instagram"},
		{"InstagramStory", "instagram:story"},
		{"Facebook", "facebook"},
		{"FacebookReel", "facebook:reel"},
		{"Tumblr", "Tumblr"},
	}
	for _, tc := range rejectedCases {
		if got := NormalizeExtractorPlatform(tc[0], tc[1]); got != "" {
			t.Fatalf("NormalizeExtractorPlatform(%q, %q) = %q, want empty", tc[0], tc[1], got)
		}
	}
}

func TestGenericParserErrorsAndSSRF(t *testing.T) {
	const now int64 = 1762300800

	// 1. Canceled context propagates context.Canceled.
	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()
	p := NewGenericNamed(&stubExtractor{enabled: true}, nil, nil)
	if _, err := p.Parse(canceledCtx, "https://vimeo.com/123456", now); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}

	// 2. Invalid input returns INVALID_INPUT without invoking resolver or engine.
	for _, bad := range []string{
		"https://vimeo.com/123456#frag",
		"https://localhost/video/1",
		"https://snap.dokitool.com/video/1",
		"https://127.0.0.1/video/1",
		"https://vimeo.com/",
		"https://vimeo.com:8443/123",
	} {
		resolverCalls := 0
		engineCalled := false
		parser := NewGenericNamed(&stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				engineCalled = true
				return nil, nil
			},
		}, nil, stubResolver{calls: &resolverCalls})
		payload, err := parser.Parse(context.Background(), bad, now)
		if err != nil {
			t.Fatalf("Parse(%q) returned Go error: %v", bad, err)
		}
		assertGenericEnvelopeValid(t, payload, now, "INVALID_INPUT")
		if resolverCalls != 0 || engineCalled {
			t.Fatalf("Parse(%q) invoked resolver(%d) or engine(%v) for invalid URL", bad, resolverCalls, engineCalled)
		}
	}

	// 3. Disabled / nil engine returns SERVICE_NOT_CONFIGURED.
	for _, parser := range []*GenericParser{
		nil,
		NewGenericNamed(nil, nil, nil),
		NewGenericNamed(&stubExtractor{enabled: false}, nil, nil),
	} {
		payload, err := parser.Parse(context.Background(), "https://vimeo.com/123456", now)
		if err != nil {
			t.Fatalf("disabled Parse returned Go error: %v", err)
		}
		assertGenericEnvelopeValid(t, payload, now, "SERVICE_NOT_CONFIGURED")
	}

	// 4. Private / loopback / link-local / mixed IP resolution -> UPSTREAM_BLOCKED before Extract.
	privateSets := [][]netip.Addr{
		{netip.MustParseAddr("127.0.0.1")},
		{netip.MustParseAddr("10.0.0.1")},
		{netip.MustParseAddr("169.254.169.254")},
		{netip.MustParseAddr("::1")},
		{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("192.168.1.1")},
		{},
	}
	for _, addrs := range privateSets {
		engineCalled := false
		parser := NewGenericNamed(&stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				engineCalled = true
				return nil, nil
			},
		}, nil, stubResolver{ips: map[string][]netip.Addr{"vimeo.com": addrs}})
		payload, err := parser.Parse(context.Background(), "https://vimeo.com/123456", now)
		if err != nil {
			t.Fatalf("Parse(%v) returned Go error: %v", addrs, err)
		}
		assertGenericEnvelopeValid(t, payload, now, "UPSTREAM_BLOCKED")
		if engineCalled {
			t.Fatalf("engine.Extract must not be called when DNS resolves to %v", addrs)
		}
	}

	// 5. DNS deadline exceeded -> UPSTREAM_TIMEOUT (retryable).
	timeoutParser := NewGenericNamed(&stubExtractor{enabled: true}, nil, errResolver{err: context.DeadlineExceeded})
	timeoutPayload, err := timeoutParser.Parse(context.Background(), "https://vimeo.com/123456", now)
	if err != nil {
		t.Fatalf("DNS timeout Parse returned Go error: %v", err)
	}
	assertGenericEnvelopeValid(t, timeoutPayload, now, "UPSTREAM_TIMEOUT")
	if unified.Map(timeoutPayload["error"])["retryable"] != true {
		t.Fatalf("expected retryable=true on DNS timeout, got %+v", timeoutPayload)
	}

	// 6. UnsupportedURL -> UNSUPPORTED_PLATFORM; regular CONTENT_UNAVAILABLE stays CONTENT_UNAVAILABLE.
	pubResolver := stubResolver{ips: map[string][]netip.Addr{"example.com": {netip.MustParseAddr("93.184.216.34")}}}
	unsupParser := NewGenericNamed(&stubExtractor{
		enabled: true,
		extract: func(context.Context, string) (*ytengine.Info, error) {
			return nil, &ytengine.Error{
				Code:           ytengine.CodeContentUnavailable,
				Message:        "未找到可用的媒体，或该内容已不可访问",
				UnsupportedURL: true,
			}
		},
	}, nil, pubResolver)
	unsupPayload, err := unsupParser.Parse(context.Background(), "https://example.com/blog/post", now)
	if err != nil {
		t.Fatalf("UnsupportedURL Parse returned Go error: %v", err)
	}
	assertGenericEnvelopeValid(t, unsupPayload, now, "UNSUPPORTED_PLATFORM")

	unavailParser := NewGenericNamed(&stubExtractor{
		enabled: true,
		extract: func(context.Context, string) (*ytengine.Info, error) {
			return nil, &ytengine.Error{
				Code:           ytengine.CodeContentUnavailable,
				Message:        "未找到可用的媒体，或该内容已不可访问",
				UnsupportedURL: false,
			}
		},
	}, nil, pubResolver)
	unavailPayload, err := unavailParser.Parse(context.Background(), "https://example.com/video/deleted", now)
	if err != nil {
		t.Fatalf("ContentUnavailable Parse returned Go error: %v", err)
	}
	assertGenericEnvelopeValid(t, unavailPayload, now, "CONTENT_UNAVAILABLE")

	// 7. RateLimited with RetryAfter preserves retry_after_seconds.
	rlParser := NewGenericNamed(&stubExtractor{
		enabled: true,
		extract: func(context.Context, string) (*ytengine.Info, error) {
			return nil, &ytengine.Error{
				Code:       ytengine.CodeRateLimited,
				Message:    "上游访问频率受限，请稍后重试",
				Retryable:  true,
				RetryAfter: 30,
			}
		},
	}, nil, pubResolver)
	rlPayload, err := rlParser.Parse(context.Background(), "https://example.com/video/rl", now)
	if err != nil {
		t.Fatalf("RateLimited Parse returned Go error: %v", err)
	}
	assertGenericEnvelopeValid(t, rlPayload, now, "RATE_LIMITED")
	if unified.Map(rlPayload["error"])["retry_after_seconds"] != 30 {
		t.Fatalf("expected retry_after_seconds=30, got %+v", rlPayload["error"])
	}

	// 8. Generic or core-14 extractor_key returned by yt-dlp -> UNSUPPORTED_PLATFORM.
	for _, extKey := range []string{"Generic", "Youtube", "Twitter", "BiliBili"} {
		blockedExtParser := NewGenericNamed(&stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				return &ytengine.Info{
					ID:           "123",
					ExtractorKey: extKey,
					Formats: []ytengine.Format{
						{
							FormatID: "1",
							URL:      "https://cdn.example.com/v.mp4",
							Ext:      "mp4",
							Protocol: "https",
							VCodec:   "avc1",
							ACodec:   "mp4a",
						},
					},
				}, nil
			},
		}, nil, pubResolver)
		payload, err := blockedExtParser.Parse(context.Background(), "https://example.com/v/123", now)
		if err != nil {
			t.Fatalf("Parse(%s) returned Go error: %v", extKey, err)
		}
		assertGenericEnvelopeValid(t, payload, now, "UNSUPPORTED_PLATFORM")
	}
}

func TestGenericParserUnifiedContractPlatforms(t *testing.T) {
	const now int64 = 1762300800
	pubIP := []netip.Addr{netip.MustParseAddr("93.184.216.34")}
	resolver := stubResolver{
		ips: map[string][]netip.Addr{
			"www.tiktok.com":  pubIP,
			"vimeo.com":       pubIP,
			"www.reddit.com":  pubIP,
			"soundcloud.com":  pubIP,
			"streamable.com":  pubIP,
			"bad.example.com": pubIP,
		},
	}

	t.Run("tiktok-progressive-mp4-with-size-prober", func(t *testing.T) {
		probed := false
		parser := NewGenericNamed(&stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				return &ytengine.Info{
					ID:           "7300000000000000001",
					Title:        "TikTok Dance Clip",
					Uploader:     "creator1",
					ExtractorKey: "TikTok",
					Extractor:    "tiktok",
					Thumbnail:    "https://p16-sign.tiktokcdn.com/cover.jpg",
					Formats: []ytengine.Format{
						{
							FormatID: "download",
							URL:      "https://v16-webapp.tiktokcdn.com/video/clip.mp4",
							Ext:      "mp4",
							Protocol: "https",
							Width:    genInt64Ptr(1080),
							Height:   genInt64Ptr(1920),
							VCodec:   "h264",
							ACodec:   "aac",
						},
					},
				}, nil
			},
		}, func(_ context.Context, rawURL string) (int64, bool) {
			if rawURL == "https://v16-webapp.tiktokcdn.com/video/clip.mp4" {
				probed = true
				return 9876543, true
			}
			return 0, false
		}, resolver)

		payload, err := parser.Parse(context.Background(), "https://www.tiktok.com/@creator1/video/7300000000000000001", now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		assertGenericEnvelopeValid(t, payload, now, "OK")
		if !probed {
			t.Fatal("expected SizeProber to populate missing TikTok MP4 size")
		}
		data := unified.Map(payload["data"])
		if unified.Str(data["platform"]) != "tiktok" || unified.Str(data["content_id"]) != "7300000000000000001" {
			t.Fatalf("unexpected TikTok platform/content_id: %+v", data)
		}
		item := unified.Map(unified.Slice(data["items"])[0])
		src := unified.Map(unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["sources"])[0])
		if src["size_bytes"] != int64(9876543) {
			t.Fatalf("expected probed size_bytes=9876543, got %+v", src)
		}
	})

	t.Run("vimeo-dash-and-hls", func(t *testing.T) {
		parser := NewGenericNamed(&stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				return &ytengine.Info{
					ID:           "987654321",
					Title:        "Vimeo Short Film",
					Uploader:     "Director",
					ExtractorKey: "Vimeo",
					Extractor:    "vimeo",
					Thumbnail:    "https://i.vimeocdn.com/video/thumb.jpg",
					Formats: []ytengine.Format{
						{
							FormatID: "dash-v1080",
							URL:      "https://vod-adaptive.vimeocdn.com/v1080.mp4",
							Ext:      "mp4",
							Protocol: "https",
							Width:    genInt64Ptr(1920),
							Height:   genInt64Ptr(1080),
							VCodec:   "avc1.640028",
							ACodec:   "none",
							Filesize: genInt64Ptr(25000000),
						},
						{
							FormatID: "dash-a128",
							URL:      "https://vod-adaptive.vimeocdn.com/a128.m4a",
							Ext:      "m4a",
							Protocol: "https",
							VCodec:   "none",
							ACodec:   "mp4a.40.2",
							ABR:      genFloat64Ptr(128),
							Filesize: genInt64Ptr(2500000),
						},
						{
							FormatID: "hls-720",
							URL:      "https://vod-adaptive.vimeocdn.com/master_720.m3u8",
							Ext:      "mp4",
							Protocol: "m3u8_native",
							Width:    genInt64Ptr(1280),
							Height:   genInt64Ptr(720),
							VCodec:   "avc1.4d401f",
							ACodec:   "mp4a.40.2",
						},
					},
				}, nil
			},
		}, nil, resolver)

		payload, err := parser.Parse(context.Background(), "https://vimeo.com/987654321", now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		assertGenericEnvelopeValid(t, payload, now, "OK")
		data := unified.Map(payload["data"])
		if unified.Str(data["platform"]) != "vimeo" {
			t.Fatalf("platform = %q, want vimeo", data["platform"])
		}
		if len(unified.Slice(data["attachments"])) != 1 {
			t.Fatalf("expected 1 background_audio attachment for split Vimeo DASH, got %+v", data["attachments"])
		}
	})

	t.Run("reddit-fallback-content-id", func(t *testing.T) {
		source := "https://www.reddit.com/r/videos/comments/abc123/cool_clip/"
		parser := NewGenericNamed(&stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				return &ytengine.Info{
					Title:        "Reddit Clip",
					ExtractorKey: "Reddit",
					Formats: []ytengine.Format{
						{
							FormatID: "fallback-720",
							URL:      "https://v.redd.it/xyz987/DASH_720.mp4",
							Ext:      "mp4",
							Protocol: "https",
							Width:    genInt64Ptr(1280),
							Height:   genInt64Ptr(720),
							VCodec:   "avc1.4d401f",
							ACodec:   "mp4a.40.2",
						},
					},
				}, nil
			},
		}, nil, resolver)

		payload, err := parser.Parse(context.Background(), source, now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		assertGenericEnvelopeValid(t, payload, now, "OK")
		data := unified.Map(payload["data"])
		sum := sha256.Sum256([]byte(source))
		wantID := hex.EncodeToString(sum[:])[:16]
		if unified.Str(data["platform"]) != "reddit" || unified.Str(data["content_id"]) != wantID {
			t.Fatalf("got platform=%v content_id=%v, want reddit / %s", data["platform"], data["content_id"], wantID)
		}
	})

	t.Run("soundcloud-audio-only-contract", func(t *testing.T) {
		parser := NewGenericNamed(&stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				return &ytengine.Info{
					ID:           "1987654321",
					Title:        "Lo-Fi Rain",
					Uploader:     "BeatMaker",
					Duration:     genFloat64Ptr(180),
					Thumbnail:    "https://i1.sndcdn.com/artworks-0001-t500x500.jpg",
					ExtractorKey: "Soundcloud",
					Extractor:    "soundcloud",
					Formats: []ytengine.Format{
						{
							FormatID: "http_mp3_1_0",
							URL:      "https://cf-media.sndcdn.com/lofi.mp3?Policy=ok",
							Ext:      "mp3",
							Protocol: "http",
							VCodec:   "none",
							ACodec:   "mp3",
							ABR:      genFloat64Ptr(128),
							Filesize: genInt64Ptr(2880000),
						},
						{
							FormatID: "http_opus_1_0",
							URL:      "https://cf-media.sndcdn.com/lofi.opus?Policy=ok",
							Ext:      "opus",
							Protocol: "https",
							VCodec:   "none",
							ACodec:   "opus",
							ABR:      genFloat64Ptr(64),
						},
						{
							FormatID: "hls_mp3_1_0",
							URL:      "https://cf-hls-media.sndcdn.com/playlist.m3u8",
							Ext:      "mp3",
							Protocol: "m3u8_native",
							VCodec:   "none",
							ACodec:   "mp3",
						},
					},
				}, nil
			},
		}, nil, resolver)

		payload, err := parser.Parse(context.Background(), "https://soundcloud.com/beatmaker/lo-fi-rain", now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		assertGenericEnvelopeValid(t, payload, now, "OK")
		data := unified.Map(payload["data"])
		if unified.Str(data["platform"]) != "soundcloud" {
			t.Fatalf("platform = %q, want soundcloud", data["platform"])
		}
		item := unified.Map(unified.Slice(data["items"])[0])
		if unified.Str(item["type"]) != "audio" || !strings.HasPrefix(unified.Str(item["id"]), "audio-") {
			t.Fatalf("expected audio item with audio- prefix, got type=%v id=%v", item["type"], item["id"])
		}
		if item["default"] == nil {
			t.Fatalf("expected non-nil default on SoundCloud audio item")
		}
		if len(unified.Slice(item["variants"])) != 2 {
			t.Fatalf("expected 2 downloadable file audio variants (mp3 + opus), got %d", len(unified.Slice(item["variants"])))
		}
	})

	t.Run("progressive-webm-unified-contract", func(t *testing.T) {
		parser := NewGenericNamed(&stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				return &ytengine.Info{
					ID:           "abc999",
					Title:        "WebM Demo",
					ExtractorKey: "Streamable",
					Formats: []ytengine.Format{
						{
							FormatID: "webm-720",
							URL:      "https://cdn-cf-east.streamable.com/video/mp4/abc999.webm",
							Ext:      "webm",
							Protocol: "https",
							Width:    genInt64Ptr(1280),
							Height:   genInt64Ptr(720),
							VCodec:   "vp9",
							ACodec:   "opus",
						},
					},
				}, nil
			},
		}, func(_ context.Context, rawURL string) (int64, bool) {
			if strings.HasSuffix(rawURL, ".webm") {
				return 3333333, true
			}
			return 0, false
		}, resolver)

		payload, err := parser.Parse(context.Background(), "https://streamable.com/abc999", now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		assertGenericEnvelopeValid(t, payload, now, "OK")
		item := unified.Map(unified.Slice(unified.Map(payload["data"])["items"])[0])
		v := unified.Map(unified.Slice(item["variants"])[0])
		meta := unified.Map(v["metadata"])
		if unified.Str(meta["mime_type"]) != "video/webm" || unified.Str(meta["extension"]) != "webm" {
			t.Fatalf("unexpected WebM metadata: %+v", meta)
		}
		src := unified.Map(unified.Slice(unified.Map(v["delivery"])["sources"])[0])
		if src["size_bytes"] != int64(3333333) {
			t.Fatalf("expected probed WebM size_bytes=3333333, got %+v", src)
		}
	})

	t.Run("disallowed-media-urls-stripped", func(t *testing.T) {
		parser := NewGenericNamed(&stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				return &ytengine.Info{
					ID:           "badmedia",
					ExtractorKey: "Vimeo",
					Thumbnail:    "https://127.0.0.1/thumb.jpg",
					Formats: []ytengine.Format{
						{
							FormatID: "1",
							URL:      "https://127.0.0.1/video.mp4",
							Ext:      "mp4",
							Protocol: "https",
							VCodec:   "avc1",
							ACodec:   "mp4a",
						},
						{
							FormatID: "2",
							URL:      "https://snap.dokitool.com/video.mp4",
							Ext:      "mp4",
							Protocol: "https",
							VCodec:   "avc1",
							ACodec:   "mp4a",
						},
					},
				}, nil
			},
		}, nil, resolver)
		payload, err := parser.Parse(context.Background(), "https://bad.example.com/v/1", now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		assertGenericEnvelopeValid(t, payload, now, "NO_MEDIA")
	})
}

func TestGenericParserEndToEndWithEngineExtractorsAndUnsupportedURL(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script fixture requires unix")
	}
	const now int64 = 1762300800

	dir := t.TempDir()
	argsFile := filepath.Join(dir, "captured_args.txt")
	binPath := filepath.Join(dir, "yt-dlp-generic-fake")
	script := "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$@\" > " + "'" + argsFile + "'" + "\n" + `
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *unsupported*)
    echo "ERROR: Unsupported URL: $last" >&2
    exit 1
    ;;
  *)
    cat <<'JSON'
{
  "id": "55555",
  "title": "Named Extractor Clip",
  "extractor_key": "Vimeo",
  "extractor": "vimeo",
  "formats": [
    {
      "format_id": "mp4-720",
      "url": "https://cdn.vimeo.test/v/55555.mp4",
      "ext": "mp4",
      "protocol": "https",
      "width": 1280,
      "height": 720,
      "vcodec": "avc1.4d401f",
      "acodec": "mp4a.40.2",
      "filesize": 1024000
    }
  ]
}
JSON
    ;;
esac
`
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(script))
	hashes := map[string]string{hex.EncodeToString(sum[:]): "yt-dlp-generic-fake"}

	resolver := stubResolver{
		ips: map[string][]netip.Addr{
			"vimeo.com": {netip.MustParseAddr("93.184.216.34")},
		},
	}

	baseEng, err := ytengine.New(ytengine.Config{
		BinaryPath:    binPath,
		AllowedHashes: hashes,
		Resolver:      resolver,
		Timeout:       5 * time.Second,
	})
	if err != nil || !baseEng.Enabled() {
		t.Fatalf("ytengine.New failed: %v", err)
	}
	genericEng := baseEng.
		WithGenericConcurrency(DefaultGenericConcurrency).
		WithTargetPolicy(AllowedGenericInputURL, AllowedGenericOutboundHost).
		WithExtractors(GenericExtractorArgs()...)

	parser := NewGenericNamed(genericEng, nil, resolver)

	// 1. Named extractor succeeds and passes exact --use-extractors selector list.
	payload, err := parser.Parse(context.Background(), "https://vimeo.com/55555", now)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	assertGenericEnvelopeValid(t, payload, now, "OK")
	if got := unified.Str(unified.Map(payload["data"])["platform"]); got != "vimeo" {
		t.Fatalf("platform = %q, want vimeo", got)
	}
	rawArgs, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read captured args: %v", err)
	}
	wantSelector := strings.Join(GenericExtractorArgs(), ",")
	if !strings.Contains(string(rawArgs), "--use-extractors\n"+wantSelector+"\n") {
		t.Fatalf("expected --use-extractors %s in captured args, got:\n%s", wantSelector, string(rawArgs))
	}

	// 2. Subprocess stderr "ERROR: Unsupported URL:" maps cleanly to UNSUPPORTED_PLATFORM.
	unsupPayload, err := parser.Parse(context.Background(), "https://vimeo.com/unsupported/page", now)
	if err != nil {
		t.Fatalf("Parse(unsupported) failed: %v", err)
	}
	assertGenericEnvelopeValid(t, unsupPayload, now, "UNSUPPORTED_PLATFORM")
}
