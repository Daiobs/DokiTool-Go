package ytgeneric

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

type executorFunc func(context.Context, fetch.Request) (fetch.Response, error)

func (f executorFunc) Do(ctx context.Context, r fetch.Request) (fetch.Response, error) {
	return f(ctx, r)
}

type stubResolver struct {
	ips   map[string][]netip.Addr
	calls *int
}

func (s stubResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	if s.calls != nil {
		*s.calls++
	}
	if addrs, ok := s.ips[host]; ok {
		return addrs, nil
	}
	return nil, errors.New("not found")
}

type stubExtractor struct {
	enabled bool
	extract func(context.Context, string) (*ytengine.Info, error)
}

func (s *stubExtractor) Enabled() bool { return s != nil && s.enabled }

func (s *stubExtractor) Extract(ctx context.Context, rawURL string) (*ytengine.Info, error) {
	if s.extract == nil {
		return nil, &ytengine.Error{Code: ytengine.CodeServiceNotConfigured, Message: "disabled"}
	}
	return s.extract(ctx, rawURL)
}

func TestUniversalAdapterAllowlistAndUnifiedMapping(t *testing.T) {
	const now int64 = 1762300800
	spec := SiteSpec{
		PlatformID:      "vimeo",
		Name:            "Vimeo",
		SiteURL:         "https://vimeo.com",
		InputHosts:      []string{"vimeo.com", ".vimeo.com"},
		MediaHostSuffix: []string{".vimeocdn.com", "vimeo.com"},
		EnableDASHMux:   true,
		EnableHLS:       true,
	}

	w, h := int64(1920), int64(1080)
	sz := int64(15000000)
	parser := New(spec, &stubExtractor{
		enabled: true,
		extract: func(ctx context.Context, rawURL string) (*ytengine.Info, error) {
			return &ytengine.Info{
				ID:        "987654321",
				Title:     "Vimeo Sample",
				Uploader:  "Creator",
				Thumbnail: "https://i.vimeocdn.com/video/thumb.jpg",
				Formats: []ytengine.Format{
					{
						FormatID: "http-1080p",
						URL:      "https://vod-progressive.akamaized.vimeocdn.com/exp=1/sample1080.mp4",
						Ext:      "mp4",
						Protocol: "https",
						Width:    &w,
						Height:   &h,
						VCodec:   "avc1.640028",
						ACodec:   "mp4a.40.2",
						Filesize: &sz,
					},
				},
			}, nil
		},
	}, nil)

	// Reject SSRF / unlisted domains
	for _, bad := range []string{
		"https://127.0.0.1/video/1",
		"https://evil.com/video/1",
		"https://vimeo.com/",
		"file:///etc/passwd",
	} {
		if parser.AllowedInputURL(bad) {
			t.Fatalf("expected %q to be rejected", bad)
		}
	}

	payload, err := parser.Parse(context.Background(), "https://vimeo.com/987654321", now)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	if err := unified.ValidateEnvelopeAt(payload, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}
	data := unified.Map(payload["data"])
	if unified.Str(data["platform"]) != "vimeo" || unified.Str(data["content_id"]) != "987654321" {
		t.Fatalf("unexpected platform/content_id: %+v", data)
	}
}

func TestUniversalAdapterBlocksPrivateIPResolution(t *testing.T) {
	const now int64 = 1762300800
	spec := SiteSpec{
		PlatformID:      "vimeo",
		Name:            "Vimeo",
		SiteURL:         "https://vimeo.com",
		InputHosts:      []string{"vimeo.com", ".vimeo.com"},
		MediaHostSuffix: []string{".vimeocdn.com"},
	}

	for _, privateIP := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"} {
		resolver := stubResolver{
			ips: map[string][]netip.Addr{
				"vimeo.com":        {netip.MustParseAddr(privateIP)},
				"cdn.vimeocdn.com": {netip.MustParseAddr(privateIP)},
			},
		}
		parser := NewWithResolver(spec, &stubExtractor{enabled: true}, nil, resolver)
		payload, err := parser.Parse(context.Background(), "https://vimeo.com/123456", now)
		if err != nil {
			t.Fatalf("unexpected Go error: %v", err)
		}
		if unified.Str(payload["code"]) != "UPSTREAM_BLOCKED" {
			t.Fatalf("expected UPSTREAM_BLOCKED when input host resolves to %s, got %v", privateIP, payload["code"])
		}
		// Media URLs are browser-side links: allowlist syntax only, no DNS.
		if !parser.AllowedMediaURL("https://cdn.vimeocdn.com/video.mp4") {
			t.Fatalf("expected syntax-only AllowedMediaURL to accept allowlisted media host (resolver=%s)", privateIP)
		}
	}
}

func TestParseSitesEnvValidation(t *testing.T) {
	if got := KnownSiteIDs(); !reflect.DeepEqual(got, []string{"facebook", "tumblr"}) {
		t.Fatalf("KnownSiteIDs() = %v, want [facebook tumblr]", got)
	}
	if _, ok := LookupSite("dailymotion"); ok {
		t.Fatal("retired site dailymotion must not be returned by LookupSite")
	}

	specs, err := ParseSitesEnv("")
	if err != nil || len(specs) != 0 {
		t.Fatalf("expected empty env to return no sites, got specs=%v err=%v", specs, err)
	}
	specs, err = ParseSitesEnv("  ")
	if err != nil || len(specs) != 0 {
		t.Fatalf("expected whitespace env to return no sites, got specs=%v err=%v", specs, err)
	}
	specs, err = ParseSitesEnv("facebook, tumblr, facebook")
	if err != nil || len(specs) != 2 {
		t.Fatalf("expected 2 deduplicated sites, got specs=%v err=%v", specs, err)
	}
	gotIDs := []string{specs[0].PlatformID, specs[1].PlatformID}
	wantIDs := []string{"facebook", "tumblr"}
	if !reflect.DeepEqual(gotIDs, wantIDs) {
		t.Fatalf("got IDs %v, want %v", gotIDs, wantIDs)
	}

	// Operational guard: retired "dailymotion" token in legacy DOKITOOL_YTDLP_SITES
	// must be skipped gracefully without failing startup.
	specs, err = ParseSitesEnv("facebook,tumblr,dailymotion")
	if err != nil || len(specs) != 2 {
		t.Fatalf("expected ParseSitesEnv(facebook,tumblr,dailymotion) to skip retired site without error, got specs=%v err=%v", specs, err)
	}
	if got := []string{specs[0].PlatformID, specs[1].PlatformID}; !reflect.DeepEqual(got, wantIDs) {
		t.Fatalf("got IDs %v, want %v", got, wantIDs)
	}
	specs, err = ParseSitesEnv("dailymotion")
	if err != nil || len(specs) != 0 {
		t.Fatalf("expected ParseSitesEnv(dailymotion) to return empty slice without error, got specs=%v err=%v", specs, err)
	}

	for _, invalid := range []string{
		"unknown",
		"pinterest",
		"facebook,unknown",
		"dailymotion,unknown",
		"facebook,,tumblr",
		"facebook,,dailymotion",
		"facebook,",
		"dailymotion,",
		",facebook",
		",dailymotion",
		"FACEBOOK",
		"DAILYMOTION",
	} {
		if _, err := ParseSitesEnv(invalid); err == nil {
			t.Fatalf("expected ParseSitesEnv(%q) to fail", invalid)
		}
	}
}

func TestBuiltinSitesSpecsAndAllowlists(t *testing.T) {
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"facebook", "tumblr"} {
		spec, ok := LookupSite(id)
		if !ok {
			t.Fatalf("missing builtin site %q", id)
		}
		if err := c.Register(spec.CatalogEntry()); err != nil {
			t.Fatalf("catalog.Register(%s) failed: %v", id, err)
		}
	}

	fbSpec, _ := LookupSite("facebook")
	if !reflect.DeepEqual(fbSpec.Extractors, []string{"facebook", "facebook:reel"}) {
		t.Fatalf("unexpected facebook extractors: %v", fbSpec.Extractors)
	}
	tbSpec, _ := LookupSite("tumblr")
	if !reflect.DeepEqual(tbSpec.Extractors, []string{"Tumblr"}) {
		t.Fatalf("unexpected tumblr extractors: %v", tbSpec.Extractors)
	}

	fb := New(fbSpec, nil, nil)
	tb := New(tbSpec, nil, nil)

	// 1. Input URL allowlist positive + negative checks
	inputCases := []struct {
		parser   *Parser
		platform string
		valid    []string
		invalid  []string
	}{
		{
			parser:   fb,
			platform: "facebook",
			valid: []string{
				"https://www.facebook.com/watch/?v=647537299265662",
				"https://www.facebook.com/WatchESLOne/videos/359649331226507/",
				"https://www.facebook.com/reel/1195289147628387",
				"https://facebook.com/watch/?v=647537299265662",
				"https://m.facebook.com/watch/?v=647537299265662",
			},
			invalid: []string{
				"https://fb.watch/abc123/",
				"https://web.facebook.com/watch/?v=647537299265662",
				"https://sub.fb.watch/abc123/",
				"https://www.fb.watch/abc123/",
				"https://evilfb.watch/abc123/",
				"https://fb.watch.evil.com/abc123/",
				"https://fb.watch:8080/abc123/",
				"https://fb.watch:8443/abc123/",
				"https://user:pass@fb.watch/abc123/",
				"https://fb.watch/",
				"https://evilfacebook.com/watch/?v=1",
				"https://evilwww.facebook.com/watch/?v=1",
				"https://www.facebook.com.evil.com/watch/?v=1",
				"https://www.facebook.com:8443/watch/?v=1",
				"https://user:pass@www.facebook.com/watch/?v=1",
				"https://www.facebook.com/",
				"ftp://www.facebook.com/watch/?v=1",
			},
		},
		{
			parser:   tb,
			platform: "tumblr",
			valid: []string{
				"https://maskofthedragon.tumblr.com/post/626907179849564160/mona-talking-in-english",
				"https://bartlebyshop.tumblr.com/post/180294460076/duality-of-bird",
				"https://www.tumblr.com/maskofthedragon/626907179849564160/mona-talking-in-english",
				"https://tumblr.com/post/626907179849564160",
			},
			invalid: []string{
				"https://eviltumblr.com/post/626907179849564160",
				"https://maskofthedragon.tumblr.com.evil.com/post/626907179849564160",
				"https://maskofthedragon.tumblr.com:8443/post/626907179849564160",
				"https://user:pass@maskofthedragon.tumblr.com/post/626907179849564160",
				"https://www.tumblr.com/",
				"https://tumblr.com/",
				"https://maskofthedragon.tumblr.com/",
				"file:///etc/passwd",
			},
		},
	}

	for _, tc := range inputCases {
		for _, u := range tc.valid {
			if !tc.parser.AllowedInputURL(u) {
				t.Fatalf("%s: expected valid input URL %q to be allowed", tc.platform, u)
			}
			if got := c.PlatformForURL(u); got != tc.platform {
				t.Fatalf("%s: catalog.PlatformForURL(%q) = %q, want %q", tc.platform, u, got, tc.platform)
			}
		}
		for _, u := range tc.invalid {
			if tc.parser.AllowedInputURL(u) {
				t.Fatalf("%s: expected invalid input URL %q to be rejected", tc.platform, u)
			}
		}
	}
	if got := c.PlatformForURL("https://fb.watch/abc123/"); got != "facebook" {
		t.Fatalf("catalog.PlatformForURL(fb.watch) = %q, want facebook", got)
	}
	for _, retiredURL := range []string{
		"https://www.dailymotion.com/video/xbs7xfa",
		"https://dailymotion.com/video/xbs7xfa",
		"https://dai.ly/xbs7xfa",
	} {
		if got := c.PlatformForURL(retiredURL); got != "" {
			t.Fatalf("catalog.PlatformForURL(%q) = %q, want empty after retirement", retiredURL, got)
		}
	}

	// 2. Outbound host & media URL allowlist checks (strictly matching P0 proxy logs)
	outboundCases := []struct {
		parser       *Parser
		platform     string
		validHosts   []string
		invalidHosts []string
		validMedia   []string
		invalidMedia []string
	}{
		{
			parser:   fb,
			platform: "facebook",
			validHosts: []string{
				"www.facebook.com",
				"video-nrt6-1.xx.fbcdn.net",
				"scontent-nrt1-2.xx.fbcdn.net",
			},
			invalidHosts: []string{
				"facebook.com",
				"m.facebook.com",
				"fbcdn.net",
				"evilfbcdn.net",
				"www.facebook.com.evil.com",
				"127.0.0.1",
			},
			validMedia: []string{
				"https://video-nrt6-1.xx.fbcdn.net/o1/v/t2/f2/m366/sample.mp4",
				"https://scontent-nrt1-2.xx.fbcdn.net/v/t15.5256-10/thumb.jpg",
			},
			invalidMedia: []string{
				"https://fbcdn.net/sample.mp4",
				"https://www.facebook.com/sample.mp4",
				"https://evilfbcdn.net/sample.mp4",
				"https://video-nrt6-1.xx.fbcdn.net:8443/sample.mp4",
			},
		},
		{
			parser:   tb,
			platform: "tumblr",
			validHosts: []string{
				"maskofthedragon.tumblr.com",
				"bartlebyshop.tumblr.com",
				"www.tumblr.com",
				"va.media.tumblr.com",
				"ve.media.tumblr.com",
				"64.media.tumblr.com",
			},
			invalidHosts: []string{
				"tumblr.com",
				"eviltumblr.com",
				"tumblr.com.evil.com",
				"127.0.0.1",
			},
			validMedia: []string{
				"https://va.media.tumblr.com/tumblr_qfbsolGm3H1r8hd26_720.mp4",
				"https://ve.media.tumblr.com/tumblr_pigdqgqD1d1xdrd7g.mp4",
				"https://64.media.tumblr.com/tumblr_qfbsolGm3H1r8hd26_frame1.jpg",
			},
			invalidMedia: []string{
				"https://media.tumblr.com/sample.mp4",
				"https://maskofthedragon.tumblr.com/sample.mp4",
				"https://tumblr.com/sample.mp4",
				"https://evilmedia.tumblr.com.evil.com/sample.mp4",
			},
		},
	}

	for _, tc := range outboundCases {
		for _, h := range tc.validHosts {
			if !tc.parser.AllowedOutboundHost(h) {
				t.Fatalf("%s: expected outbound host %q to be allowed", tc.platform, h)
			}
		}
		for _, h := range tc.invalidHosts {
			if tc.parser.AllowedOutboundHost(h) {
				t.Fatalf("%s: expected outbound host %q to be rejected", tc.platform, h)
			}
		}
		for _, m := range tc.validMedia {
			if !tc.parser.AllowedMediaURL(m) {
				t.Fatalf("%s: expected media URL %q to be allowed", tc.platform, m)
			}
		}
		for _, m := range tc.invalidMedia {
			if tc.parser.AllowedMediaURL(m) {
				t.Fatalf("%s: expected media URL %q to be rejected", tc.platform, m)
			}
		}
	}
}

func loadFixtureInfo(t *testing.T, filename string) *ytengine.Info {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", filename))
	if err != nil {
		t.Fatalf("read fixture %s: %v", filename, err)
	}
	var info ytengine.Info
	if err := json.Unmarshal(raw, &info); err != nil {
		t.Fatalf("decode fixture %s: %v", filename, err)
	}
	return &info
}

func TestP0FixturesFacebookTumblr(t *testing.T) {
	const now int64 = 1762300800
	publicAddr := []netip.Addr{netip.MustParseAddr("93.184.216.34")}
	pubResolver := stubResolver{
		ips: map[string][]netip.Addr{
			"www.facebook.com":             publicAddr,
			"video-nrt6-1.xx.fbcdn.net":    publicAddr,
			"scontent-nrt1-2.xx.fbcdn.net": publicAddr,
			"maskofthedragon.tumblr.com":   publicAddr,
			"va.media.tumblr.com":          publicAddr,
			"64.media.tumblr.com":          publicAddr,
		},
	}

	// 1. Facebook P0 fixture: codec-less progressive MP4 SD + HD, HD selected as default
	t.Run("facebook", func(t *testing.T) {
		spec, _ := LookupSite("facebook")
		parser := NewWithResolver(spec, &stubExtractor{
			enabled: true,
			extract: func(ctx context.Context, rawURL string) (*ytengine.Info, error) {
				return loadFixtureInfo(t, "facebook.json"), nil
			},
		}, func(ctx context.Context, rawURL string) (int64, bool) {
			if strings.Contains(rawURL, "sample_hd.mp4") {
				return 18450000, true
			}
			if strings.Contains(rawURL, "sample_sd.mp4") {
				return 7210000, true
			}
			return 0, false
		}, pubResolver)

		payload, err := parser.Parse(context.Background(), "https://www.facebook.com/watch/?v=647537299265662", now)
		if err != nil {
			t.Fatalf("facebook Parse failed: %v", err)
		}
		for name, env := range map[string]unified.Object{
			"raw":    payload,
			"normal": unified.PublicView(payload, false, now),
			"debug":  unified.PublicView(payload, true, now),
		} {
			if err := unified.ValidateEnvelopeAt(env, now); err != nil {
				t.Fatalf("facebook %s ValidateEnvelopeAt failed: %v", name, err)
			}
		}
		pub := unified.PublicView(payload, false, now)
		data := unified.Map(pub["data"])
		if unified.Str(data["platform"]) != "facebook" || unified.Str(data["content_id"]) != "647537299265662" {
			t.Fatalf("unexpected facebook data: %+v", data)
		}
		item := unified.Map(unified.Slice(data["items"])[0])
		def := unified.Map(item["default"])
		if def == nil || !strings.Contains(unified.Str(def["url"]), "sample_hd.mp4") {
			t.Fatalf("expected facebook default to select sample_hd.mp4, got %+v", def)
		}
		variants := unified.Slice(item["variants"])
		if len(variants) != 2 {
			t.Fatalf("expected exactly 2 progressive MP4 variants (HD, SD), got %d: %+v", len(variants), variants)
		}
		v0, v1 := unified.Map(variants[0]), unified.Map(variants[1])
		if unified.Str(v0["label"]) != "HD" || unified.Str(v1["label"]) != "SD" {
			t.Fatalf("expected labels [HD, SD], got [%s, %s]", unified.Str(v0["label"]), unified.Str(v1["label"]))
		}
	})

	// 2. Tumblr P0 fixture: codec-less progressive MP4 720p (hd) + 480p (sd), 720p selected as default
	t.Run("tumblr", func(t *testing.T) {
		spec, _ := LookupSite("tumblr")
		parser := NewWithResolver(spec, &stubExtractor{
			enabled: true,
			extract: func(ctx context.Context, rawURL string) (*ytengine.Info, error) {
				return loadFixtureInfo(t, "tumblr.json"), nil
			},
		}, func(ctx context.Context, rawURL string) (int64, bool) {
			if strings.Contains(rawURL, "_720.mp4") {
				return 1428784, true
			}
			if strings.Contains(rawURL, "_480.mp4") {
				return 812000, true
			}
			return 0, false
		}, pubResolver)

		payload, err := parser.Parse(context.Background(), "https://maskofthedragon.tumblr.com/post/626907179849564160/mona-talking-in-english", now)
		if err != nil {
			t.Fatalf("tumblr Parse failed: %v", err)
		}
		for name, env := range map[string]unified.Object{
			"raw":    payload,
			"normal": unified.PublicView(payload, false, now),
			"debug":  unified.PublicView(payload, true, now),
		} {
			if err := unified.ValidateEnvelopeAt(env, now); err != nil {
				t.Fatalf("tumblr %s ValidateEnvelopeAt failed: %v", name, err)
			}
		}
		pub := unified.PublicView(payload, false, now)
		data := unified.Map(pub["data"])
		if unified.Str(data["platform"]) != "tumblr" || unified.Str(data["content_id"]) != "626907179849564160" {
			t.Fatalf("unexpected tumblr data: %+v", data)
		}
		item := unified.Map(unified.Slice(data["items"])[0])
		def := unified.Map(item["default"])
		if def == nil || !strings.Contains(unified.Str(def["url"]), "_720.mp4") {
			t.Fatalf("expected tumblr default to select _720.mp4, got %+v", def)
		}
		variants := unified.Slice(item["variants"])
		if len(variants) != 2 {
			t.Fatalf("expected 2 progressive MP4 variants (720p, 480p), got %d: %+v", len(variants), variants)
		}
		v0, v1 := unified.Map(variants[0]), unified.Map(variants[1])
		if unified.Str(v0["label"]) != "720p" || unified.Str(v1["label"]) != "480p" {
			t.Fatalf("expected labels [720p, 480p], got [%s, %s]", unified.Str(v0["label"]), unified.Str(v1["label"]))
		}
	})
}

func TestBareMobileDomainNormalizationAndShortLinks(t *testing.T) {
	const now int64 = 1762300800
	publicAddr := []netip.Addr{netip.MustParseAddr("93.184.216.34")}
	pubResolver := stubResolver{
		ips: map[string][]netip.Addr{
			"www.facebook.com":             publicAddr,
			"fb.watch":                     publicAddr,
			"video-nrt6-1.xx.fbcdn.net":    publicAddr,
			"scontent-nrt1-2.xx.fbcdn.net": publicAddr,
			"www.tumblr.com":               publicAddr,
			"va.media.tumblr.com":          publicAddr,
			"64.media.tumblr.com":          publicAddr,
		},
	}

	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"facebook", "tumblr"} {
		spec, _ := LookupSite(id)
		if err := c.Register(spec.CatalogEntry()); err != nil {
			t.Fatal(err)
		}
	}

	for _, badCatalogURL := range []string{
		"https://evilfb.watch/abc123",
		"https://fb.watch.evil.com/abc123",
		"https://www.fb.watch/abc123",
		"https://sub.fb.watch/abc123",
		"https://user:pass@fb.watch/abc123",
		"https://fb.watch:8080/abc123",
		"https://fb.watch:8443/abc123",
		"https://web.facebook.com/watch/?v=1",
		"https://www.dailymotion.com/video/xbvrf7u",
		"https://dai.ly/xbvrf7u",
	} {
		if got := c.PlatformForURL(badCatalogURL); got != "" {
			t.Fatalf("catalog.PlatformForURL(%q) = %q, want empty", badCatalogURL, got)
		}
	}

	t.Run("tumblr-bare-domain-normalized-to-www", func(t *testing.T) {
		tbSpec, _ := LookupSite("tumblr")
		var extractedURL string
		p := NewWithResolver(tbSpec, &stubExtractor{
			enabled: true,
			extract: func(_ context.Context, rawURL string) (*ytengine.Info, error) {
				extractedURL = rawURL
				return loadFixtureInfo(t, "tumblr.json"), nil
			},
		}, nil, pubResolver)
		if p.AllowedOutboundHost("tumblr.com") || p.AllowedTargetURL("https://tumblr.com/maskofthedragon/626907179849564160") {
			t.Fatal("bare tumblr.com must never enter yt-dlp target or outbound allowlist")
		}
		res, err := p.Parse(context.Background(), "https://tumblr.com/maskofthedragon/626907179849564160", now)
		if err != nil || unified.Str(res["code"]) != "OK" {
			t.Fatalf("tumblr bare Parse failed: res=%v err=%v", res, err)
		}
		if extractedURL != "https://www.tumblr.com/maskofthedragon/626907179849564160" {
			t.Fatalf("extractedURL = %q, want canonical www.tumblr.com", extractedURL)
		}
	})

	t.Run("facebook-bare-mobile-and-fbwatch-local-hint-zero-outbound", func(t *testing.T) {
		fbSpec, _ := LookupSite("facebook")
		if testP := New(fbSpec, nil, nil); testP.AllowedOutboundHost("fb.watch") || testP.AllowedOutboundHost("facebook.com") || testP.AllowedOutboundHost("m.facebook.com") || testP.AllowedTargetURL("https://fb.watch/abc123/") || testP.AllowedTargetURL("https://m.facebook.com/watch/?v=1") {
			t.Fatal("fb.watch, facebook.com, m.facebook.com must NEVER enter yt-dlp target or outbound allowlists")
		}

		for _, input := range []string{
			"https://facebook.com/watch/?v=647537299265662",
			"https://m.facebook.com/watch/?v=647537299265662",
		} {
			var extractedURL string
			p := NewWithResolver(fbSpec, &stubExtractor{
				enabled: true,
				extract: func(_ context.Context, rawURL string) (*ytengine.Info, error) {
					extractedURL = rawURL
					return loadFixtureInfo(t, "facebook.json"), nil
				},
			}, nil, pubResolver)
			res, err := p.Parse(context.Background(), input, now)
			if err != nil || unified.Str(res["code"]) != "OK" {
				t.Fatalf("Parse(%q) failed: res=%v err=%v", input, res, err)
			}
			if extractedURL != "https://www.facebook.com/watch/?v=647537299265662" {
				t.Fatalf("Parse(%q) passed %q to yt-dlp, want https://www.facebook.com/watch/?v=647537299265662", input, extractedURL)
			}
		}

		// fb.watch short links must still be recognized as Facebook in catalog,
		// return 400 INVALID_INPUT locally with actionable copy, and make ZERO outbound calls.
		httpCalls := 0
		ytdlpCalls := 0
		dnsCalls := 0
		countingResolver := stubResolver{
			ips:   pubResolver.ips,
			calls: &dnsCalls,
		}
		policyP := New(fbSpec, nil, nil)
		prober := ytengine.NewSizeProber(executorFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			httpCalls++
			t.Fatalf("fb.watch must make ZERO outbound HTTP requests, got %s %s", req.Method, req.URL)
			return fetch.Response{}, nil
		}), policyP.MatchMediaURL)
		fbWatchParser := NewWithResolver(fbSpec, &stubExtractor{
			enabled: true,
			extract: func(_ context.Context, rawURL string) (*ytengine.Info, error) {
				ytdlpCalls++
				t.Fatalf("fb.watch must make ZERO yt-dlp invocations, got %q", rawURL)
				return nil, nil
			},
		}, prober, countingResolver)

		for _, shortURL := range []string{
			"https://fb.watch/vtkorrRM0p/",
			"http://fb.watch/vv4KcJ16Ft/",
			"https://FB.WATCH:443/v/abc123/?mibextid=1",
		} {
			if got := c.PlatformForURL(shortURL); got != "facebook" {
				t.Fatalf("catalog.PlatformForURL(%q) = %q, want facebook", shortURL, got)
			}
			res, err := fbWatchParser.Parse(context.Background(), shortURL, now)
			if err != nil {
				t.Fatalf("Parse(%q) unexpected error: %v", shortURL, err)
			}
			if err := unified.ValidateEnvelopeAt(res, now); err != nil {
				t.Fatalf("Parse(%q) ValidateEnvelopeAt failed: %v", shortURL, err)
			}
			errObj := unified.Map(res["error"])
			msg := unified.Str(errObj["message"])
			if unified.Str(res["code"]) != "INVALID_INPUT" || errObj["retryable"] == true {
				t.Fatalf("Parse(%q) = %v, want INVALID_INPUT non-retryable", shortURL, res)
			}
			if msg != fbWatchLocalHint || !strings.Contains(msg, "facebook.com 的完整视频链接") {
				t.Fatalf("Parse(%q) message = %q, want %q", shortURL, msg, fbWatchLocalHint)
			}
			if httpCalls != 0 || ytdlpCalls != 0 || dnsCalls != 0 {
				t.Fatalf("Parse(%q) outbound calls: http=%d ytdlp=%d dns=%d, want 0/0/0", shortURL, httpCalls, ytdlpCalls, dnsCalls)
			}
		}

		// Lookalikes, subdomains, userinfo, non-default ports, and bare root are still rejected with 0 outbound calls.
		for _, rejectedURL := range []string{
			"https://evilfb.watch/abc123/",
			"https://fb.watch.evil.com/abc123/",
			"https://www.fb.watch/abc123/",
			"https://sub.fb.watch/abc123/",
			"https://user:pass@fb.watch/abc123/",
			"https://fb.watch:8080/abc123/",
			"https://fb.watch:8443/abc123/",
			"https://fb.watch/",
		} {
			res, err := fbWatchParser.Parse(context.Background(), rejectedURL, now)
			if err != nil || unified.Str(res["code"]) != "INVALID_INPUT" {
				t.Fatalf("Parse(%q) = %v (err=%v), want INVALID_INPUT", rejectedURL, res, err)
			}
			if httpCalls != 0 || ytdlpCalls != 0 || dnsCalls != 0 {
				t.Fatalf("Parse(%q) outbound calls: http=%d ytdlp=%d dns=%d, want 0/0/0", rejectedURL, httpCalls, ytdlpCalls, dnsCalls)
			}
		}
	})
}

type funcResolver func(ctx context.Context, network, host string) ([]netip.Addr, error)

func (f funcResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return f(ctx, network, host)
}

func TestParserInputDNSBoundedAndMediaHostsSyntaxOnly(t *testing.T) {
	const now int64 = 1762300800
	publicAddr := []netip.Addr{netip.MustParseAddr("93.184.216.34")}
	fbSpec, ok := LookupSite("facebook")
	if !ok {
		t.Fatal("missing facebook spec")
	}

	// (a) A canceled ctx returns immediately even if the input-host DNS lookup hangs.
	t.Run("canceled-ctx-returns-immediately-on-hung-input-dns", func(t *testing.T) {
		inputDNSStarted := make(chan struct{})
		hungInputResolver := funcResolver(func(ctx context.Context, _, _ string) ([]netip.Addr, error) {
			select {
			case <-inputDNSStarted:
			default:
				close(inputDNSStarted)
			}
			<-ctx.Done()
			return nil, ctx.Err()
		})
		p := NewWithResolver(fbSpec, &stubExtractor{enabled: true}, nil, hungInputResolver)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			_, err := p.Parse(ctx, "https://www.facebook.com/watch/?v=647537299265662", now)
			done <- err
		}()
		<-inputDNSStarted
		start := time.Now()
		cancel()
		err := <-done
		if !errors.Is(err, context.Canceled) || time.Since(start) >= 200*time.Millisecond {
			t.Fatalf("canceled input DNS Parse err=%v elapsed=%v, want context.Canceled in <200ms", err, time.Since(start))
		}
	})

	// (b) Only the input host is resolved (with a deadline); 18 formats plus
	// thumbnails on CDN hosts trigger zero additional DNS lookups.
	t.Run("only-input-host-resolved", func(t *testing.T) {
		var (
			mu         sync.Mutex
			hostCounts = make(map[string]int)
			totalCalls atomic.Int32
		)
		countingResolver := funcResolver(func(ctx context.Context, _, host string) ([]netip.Addr, error) {
			if _, hasDeadline := ctx.Deadline(); !hasDeadline {
				t.Errorf("LookupNetIP(%q) called without context deadline", host)
			}
			totalCalls.Add(1)
			mu.Lock()
			hostCounts[host]++
			mu.Unlock()
			return publicAddr, nil
		})

		const cdnHost = "video-nrt6-1.xx.fbcdn.net"
		formats := make([]ytengine.Format, 0, 18)
		for i := 0; i < 18; i++ {
			w := int64(640 + i*16)
			h := int64(360 + i*16)
			var szPtr *int64
			if i%2 == 0 {
				sz := int64(1000000 + i*10000)
				szPtr = &sz
			}
			formats = append(formats, ytengine.Format{
				FormatID: fmt.Sprintf("f-%d", i),
				URL:      fmt.Sprintf("https://%s/o1/v/t2/f2/m366/vid_%d.mp4", cdnHost, i),
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w,
				Height:   &h,
				VCodec:   "avc1.4d401f",
				ACodec:   "mp4a.40.2",
				Filesize: szPtr,
			})
		}
		thumbs := make([]ytengine.Thumbnail, 0, 5)
		for i := 0; i < 5; i++ {
			thumbs = append(thumbs, ytengine.Thumbnail{
				ID:  fmt.Sprintf("th-%d", i),
				URL: fmt.Sprintf("https://%s/v/t15.5256-10/thumb_%d.jpg", cdnHost, i),
			})
		}

		p := NewWithResolver(fbSpec, &stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				return &ytengine.Info{
					ID:         "647537299265662",
					Title:      "Many Formats Same CDN",
					Thumbnail:  fmt.Sprintf("https://%s/v/t15.5256-10/main_thumb.jpg", cdnHost),
					Thumbnails: thumbs,
					Formats:    formats,
				}, nil
			},
		}, func(_ context.Context, rawURL string) (int64, bool) {
			return 2048000, true
		}, countingResolver)

		res, err := p.Parse(context.Background(), "https://www.facebook.com/watch/?v=647537299265662", now)
		if err != nil || unified.Str(res["code"]) != "OK" {
			t.Fatalf("Parse failed: res=%v err=%v", res, err)
		}
		mu.Lock()
		cdnCount := hostCounts[cdnHost]
		fbCount := hostCounts["www.facebook.com"]
		mu.Unlock()
		if cdnCount != 0 || fbCount != 1 || totalCalls.Load() != 1 {
			t.Fatalf("expected exactly 1 DNS lookup (www.facebook.com), got cdn=%d fb=%d total=%d", cdnCount, fbCount, totalCalls.Load())
		}
	})

	// (c) Media/cover hosts that a fake-IP or DNS64 resolver maps to
	// non-public addresses are still delivered: the browser downloads them and
	// the server never fetches them without fetch.Client's own DNS checks.
	t.Run("fake-ip-media-hosts-still-delivered", func(t *testing.T) {
		spec := SiteSpec{
			PlatformID:      "vimeo",
			Name:            "Vimeo",
			SiteURL:         "https://vimeo.com",
			InputHosts:      []string{"vimeo.com", ".vimeo.com"},
			MediaHostSuffix: []string{".vimeocdn.com"},
		}
		w, h := int64(1920), int64(1080)
		sz := int64(12345678)
		fakeIP := []netip.Addr{netip.MustParseAddr("198.18.0.7")}
		p := NewWithResolver(spec, &stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				return &ytengine.Info{
					ID:        "999889",
					Title:     "Fake-IP CDN",
					Thumbnail: "https://i.vimeocdn.com/video/thumb.jpg",
					Formats: []ytengine.Format{{
						FormatID: "http-1080p",
						URL:      "https://cdn.vimeocdn.com/exp=1/sample1080.mp4",
						Ext:      "mp4",
						Protocol: "https",
						Width:    &w,
						Height:   &h,
						VCodec:   "avc1.640028",
						ACodec:   "mp4a.40.2",
						Filesize: &sz,
					}},
				}, nil
			},
		}, nil, stubResolver{ips: map[string][]netip.Addr{
			"vimeo.com":        publicAddr,
			"cdn.vimeocdn.com": fakeIP,
			"i.vimeocdn.com":   fakeIP,
		}})
		res, err := p.Parse(context.Background(), "https://vimeo.com/999889", now)
		if err != nil || unified.Str(res["code"]) != "OK" {
			t.Fatalf("expected OK, got res=%v err=%v", res, err)
		}
		if unified.Map(res["data"])["cover"] == nil {
			t.Fatalf("expected cover to be kept, got %v", res["data"])
		}
		// Syntax rules still apply: off-allowlist hosts and IP literals are rejected.
		if p.AllowedMediaURL("https://evil.example.com/a.mp4") || p.AllowedMediaURL("https://10.0.0.1/a.mp4") {
			t.Fatal("expected off-allowlist or IP-literal media URLs to be rejected")
		}
	})
}

func TestMatchMediaURLSyntaxAndZeroDNS(t *testing.T) {
	fbSpec, ok := LookupSite("facebook")
	if !ok {
		t.Fatal("missing facebook spec")
	}

	var dnsCalls atomic.Int32
	forbidDNS := funcResolver(func(_ context.Context, _, host string) ([]netip.Addr, error) {
		dnsCalls.Add(1)
		t.Errorf("MatchMediaURL must never perform DNS lookup, called for %q", host)
		return nil, errors.New("unexpected dns lookup")
	})

	p := NewWithResolver(fbSpec, nil, nil, forbidDNS)

	var nilParser *Parser
	if nilParser.MatchMediaURL("https://video-nrt6-1.xx.fbcdn.net/sample.mp4") {
		t.Fatal("expected nil *Parser.MatchMediaURL to return false")
	}
	emptySuffixParser := NewWithResolver(SiteSpec{PlatformID: "empty"}, nil, nil, forbidDNS)
	if emptySuffixParser.MatchMediaURL("https://video-nrt6-1.xx.fbcdn.net/sample.mp4") {
		t.Fatal("expected empty MediaHostSuffix MatchMediaURL to return false")
	}

	for _, validURL := range []string{
		"https://video-nrt6-1.xx.fbcdn.net/o1/v/t2/f2/m366/sample.mp4",
		"https://video-nrt6-1.xx.fbcdn.net:443/o1/v/t2/f2/m366/sample.mp4",
		"http://video-nrt6-1.xx.fbcdn.net/o1/v/t2/f2/m366/sample.mp4",
		"http://video-nrt6-1.xx.fbcdn.net:80/o1/v/t2/f2/m366/sample.mp4",
		"HTTPS://SCONTENT-NRT1-2.XX.FBCDN.NET./v/t15.5256-10/thumb.jpg?oe=1",
	} {
		if !p.MatchMediaURL(validURL) {
			t.Fatalf("expected MatchMediaURL(%q) to return true", validURL)
		}
	}

	// Synthetic spec whose MediaHostSuffix would string-match IP literals if netip.ParseAddr were skipped.
	ipRuleParser := NewWithResolver(SiteSpec{
		PlatformID:      "synthetic-ip",
		MediaHostSuffix: []string{"127.0.0.1", ".0.0.1", "::1", "fe80::1%lo0"},
	}, nil, nil, forbidDNS)
	for _, ipURL := range []string{
		"https://127.0.0.1/sample.mp4",
		"https://127.0.0.1./sample.mp4",
		"https://10.0.0.1/sample.mp4",
		"https://[::1]/sample.mp4",
		"https://[fe80::1%25lo0]/sample.mp4",
		"https://[::ffff:127.0.0.1]/sample.mp4",
	} {
		if ipRuleParser.MatchMediaURL(ipURL) {
			t.Fatalf("expected IP literal URL %q to be rejected even when suffix rule matches", ipURL)
		}
	}

	for _, badURL := range []string{
		"",
		"ftp://video-nrt6-1.xx.fbcdn.net/sample.mp4",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"://video-nrt6-1.xx.fbcdn.net/sample.mp4",
		"https:video-nrt6-1.xx.fbcdn.net/sample.mp4",
		"https://video-nrt6-1.xx.fbcdn.net:8443/sample.mp4",
		"https://video-nrt6-1.xx.fbcdn.net:80/sample.mp4",
		"http://video-nrt6-1.xx.fbcdn.net:443/sample.mp4",
		"https://video-nrt6-1.xx.fbcdn.net:0443/sample.mp4",
		"https://video-nrt6-1.xx.fbcdn.net:/sample.mp4",
		"https://video-nrt6-1.xx.fbcdn.net:abc/sample.mp4",
		"https://user:pass@video-nrt6-1.xx.fbcdn.net/sample.mp4",
		"https://user@video-nrt6-1.xx.fbcdn.net/sample.mp4",
		"https://@video-nrt6-1.xx.fbcdn.net/sample.mp4",
		"https:///sample.mp4",
		"https://./sample.mp4",
		"https://video-nrt6-1.xx.fbcdn.net/a b.mp4",
		"https://video-nrt6-1.xx.fbcdn.net/a\\b.mp4",
		"https://127.0.0.1/sample.mp4",
		"https://[::1]/sample.mp4",
		"https://[fe80::1%25lo0]/sample.mp4",
		"https://fbcdn.net/sample.mp4",
		"https://evilfbcdn.net/sample.mp4",
		"https://video-nrt6-1.xx.fbcdn.net.evil.com/sample.mp4",
		"https://www.facebook.com/sample.mp4",
	} {
		if p.MatchMediaURL(badURL) {
			t.Fatalf("expected MatchMediaURL(%q) to return false", badURL)
		}
	}

	if got := dnsCalls.Load(); got != 0 {
		t.Fatalf("MatchMediaURL made %d DNS calls, want 0", got)
	}
}

func TestSizeProberRealWiringMatchMediaURLAndSSRF(t *testing.T) {
	const now int64 = 1762300800
	publicAddr := []netip.Addr{netip.MustParseAddr("93.184.216.34")}
	fbSpec, ok := LookupSite("facebook")
	if !ok {
		t.Fatal("missing facebook spec")
	}

	t.Run("no-uncached-policy-dns-caches-parse-dns-and-aborts-on-ctx-cancel", func(t *testing.T) {
		var policyDNSCalls atomic.Int32
		policyParser := NewWithResolver(fbSpec, nil, nil, funcResolver(func(_ context.Context, _, host string) ([]netip.Addr, error) {
			policyDNSCalls.Add(1)
			t.Errorf("policyParser uncached resolver must NEVER be invoked when wired via MatchMediaURL, got lookup for %q", host)
			return nil, errors.New("unexpected policy resolver call")
		}))

		const cdnHost = "video-nrt6-1.xx.fbcdn.net"
		wantSizes := map[string]int64{}
		formats := make([]ytengine.Format, 0, 6)
		for i := 0; i < 6; i++ {
			w := int64(640 + i*160)
			h := int64(360 + i*90)
			u := fmt.Sprintf("https://%s/o1/v/t2/f2/m366/missing_sz_%d.mp4", cdnHost, i)
			wantSizes[u] = int64(5_000_000 + i*1_000_000)
			formats = append(formats, ytengine.Format{
				FormatID: fmt.Sprintf("mp4-%d", i),
				URL:      u,
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w,
				Height:   &h,
				VCodec:   "avc1.4d401f",
				ACodec:   "mp4a.40.2",
				Filesize: nil,
			})
		}

		var probeHTTPCalls atomic.Int32
		fetchExec := executorFunc(func(ctx context.Context, req fetch.Request) (fetch.Response, error) {
			if req.Policy.AllowedURL == nil || !req.Policy.AllowedURL(req.URL) {
				return fetch.Response{}, fetch.ErrPolicy
			}
			probeHTTPCalls.Add(1)
			total, ok := wantSizes[req.URL]
			if !ok {
				return fetch.Response{}, errors.New("unexpected probe URL")
			}
			return fetch.Response{
				StatusCode: http.StatusPartialContent,
				Header: http.Header{
					"Content-Type":   {"video/mp4"},
					"Content-Range":  {fmt.Sprintf("bytes 0-0/%d", total)},
					"Content-Length": {"1"},
				},
				Body: []byte{0x00},
				URL:  req.URL,
			}, nil
		})

		var (
			dnsMu      sync.Mutex
			hostCounts = make(map[string]int)
			totalDNS   atomic.Int32
		)
		parseResolver := funcResolver(func(ctx context.Context, _, host string) ([]netip.Addr, error) {
			if _, hasDeadline := ctx.Deadline(); !hasDeadline {
				t.Errorf("Parse DNS lookup for %q lacked context deadline", host)
			}
			totalDNS.Add(1)
			dnsMu.Lock()
			hostCounts[host]++
			dnsMu.Unlock()
			return publicAddr, nil
		})

		prober := ytengine.NewSizeProber(fetchExec, policyParser.MatchMediaURL)
		adapter := NewWithResolver(fbSpec, &stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				return &ytengine.Info{
					ID:        "647537299265662",
					Title:     "Missing Filesize Probe Test",
					Thumbnail: fmt.Sprintf("https://%s/v/t15.5256-10/thumb.jpg", cdnHost),
					Formats:   formats,
				}, nil
			},
		}, prober, parseResolver)

		res, err := adapter.Parse(context.Background(), "https://www.facebook.com/watch/?v=647537299265662", now)
		if err != nil || unified.Str(res["code"]) != "OK" {
			t.Fatalf("Parse failed: res=%v err=%v", res, err)
		}
		if err := unified.ValidateEnvelopeAt(res, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		if got := policyDNSCalls.Load(); got != 0 {
			t.Fatalf("policyParser resolver called %d times, want 0", got)
		}
		dnsMu.Lock()
		fbDNS := hostCounts["www.facebook.com"]
		cdnDNS := hostCounts[cdnHost]
		dnsMu.Unlock()
		// Only the yt-dlp input host is resolved by Parse; media hosts are
		// resolved solely inside fetch.Client when actually probed.
		if fbDNS != 1 || cdnDNS != 0 || totalDNS.Load() != 1 {
			t.Fatalf("Parse DNS counts: fb=%d cdn=%d total=%d, want 1/0/1", fbDNS, cdnDNS, totalDNS.Load())
		}
		if got := probeHTTPCalls.Load(); got != 6 {
			t.Fatalf("expected 6 HTTP Range size probes, got %d", got)
		}
		pub := unified.PublicView(res, false, now)
		if err := unified.ValidateEnvelopeAt(pub, now); err != nil {
			t.Fatalf("PublicView ValidateEnvelopeAt failed: %v", err)
		}
		item := unified.Map(unified.Slice(unified.Map(pub["data"])["items"])[0])
		variants := unified.Slice(item["variants"])
		if len(variants) != 6 {
			t.Fatalf("expected 6 variants, got %d", len(variants))
		}
		for idx, rawV := range variants {
			v := unified.Map(rawV)
			src := unified.Map(unified.Slice(unified.Map(v["delivery"])["sources"])[0])
			srcURL := unified.Str(src["url"])
			gotSz, ok := unified.PHPInt(src["size_bytes"])
			if !ok || gotSz != wantSizes[srcURL] {
				t.Fatalf("variant[%d] (%s) size_bytes = %v, want %d", idx, srcURL, src["size_bytes"], wantSizes[srcURL])
			}
		}

		// Verify prompt abort on caller ctx cancellation when DNS hangs inside real SizeProber
		// (wired exactly like cmd/dokitool/main.go with New(spec, nil, nil).MatchMediaURL + fetch.NewWithResolver).
		mainStylePolicy := New(fbSpec, nil, nil)
		probeDNSStarted := make(chan struct{})
		hungFetchResolver := funcResolver(func(ctx context.Context, _, _ string) ([]netip.Addr, error) {
			select {
			case <-probeDNSStarted:
			default:
				close(probeDNSStarted)
			}
			<-ctx.Done()
			return nil, ctx.Err()
		})
		realHungProber := ytengine.NewSizeProber(fetch.NewWithResolver(hungFetchResolver), mainStylePolicy.MatchMediaURL)
		w, h := int64(1280), int64(720)
		adapterHungProbe := NewWithResolver(fbSpec, &stubExtractor{
			enabled: true,
			extract: func(context.Context, string) (*ytengine.Info, error) {
				return &ytengine.Info{
					ID:    "647537299265662",
					Title: "Hung Probe DNS",
					Formats: []ytengine.Format{
						{
							FormatID: "hd",
							URL:      fmt.Sprintf("https://%s/o1/v/t2/f2/m366/hd.mp4", cdnHost),
							Ext:      "mp4",
							Protocol: "https",
							Width:    &w,
							Height:   &h,
							VCodec:   "avc1.4d401f",
							ACodec:   "mp4a.40.2",
							Filesize: nil,
						},
					},
				}, nil
			},
		}, realHungProber, stubResolver{
			ips: map[string][]netip.Addr{
				"www.facebook.com": publicAddr,
				cdnHost:            publicAddr,
			},
		})

		cancelCtx, cancel := context.WithCancel(context.Background())
		errCh := make(chan error, 1)
		go func() {
			_, pErr := adapterHungProbe.Parse(cancelCtx, "https://www.facebook.com/watch/?v=647537299265662", now)
			errCh <- pErr
		}()
		<-probeDNSStarted
		tCancel := time.Now()
		cancel()
		gotErr := <-errCh
		if !errors.Is(gotErr, context.Canceled) || time.Since(tCancel) >= 200*time.Millisecond {
			t.Fatalf("canceled Parse during SizeProber DNS hang: err=%v elapsed=%v, want context.Canceled in <200ms", gotErr, time.Since(tCancel))
		}
	})

	t.Run("ssrf-safety-fetch-client-blocks-private-ip-on-whitelisted-media-host", func(t *testing.T) {
		policyParser := New(fbSpec, nil, nil)
		const mediaURL = "https://video-nrt6-1.xx.fbcdn.net/o1/v/t2/f2/m366/sample.mp4"
		if !policyParser.MatchMediaURL(mediaURL) {
			t.Fatalf("expected %q to pass syntax/whitelist MatchMediaURL", mediaURL)
		}

		for _, tc := range []struct {
			name  string
			addrs []netip.Addr
		}{
			{"loopback-v4", []netip.Addr{netip.MustParseAddr("127.0.0.1")}},
			{"private-10", []netip.Addr{netip.MustParseAddr("10.0.0.1")}},
			{"link-local-metadata", []netip.Addr{netip.MustParseAddr("169.254.169.254")}},
			{"loopback-v6", []netip.Addr{netip.MustParseAddr("::1")}},
			{"mixed-public-and-loopback", []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("127.0.0.1")}},
		} {
			var resolverCalls atomic.Int32
			privResolver := funcResolver(func(_ context.Context, _, host string) ([]netip.Addr, error) {
				if host == "www.facebook.com" {
					return publicAddr, nil
				}
				resolverCalls.Add(1)
				return tc.addrs, nil
			})

			client := fetch.NewWithResolver(privResolver)
			prober := ytengine.NewSizeProber(client, policyParser.MatchMediaURL)

			if sz, ok := prober(context.Background(), mediaURL); ok || sz != 0 {
				t.Fatalf("%s: expected SizeProber to block private IP %v via fetch.Client PublicIP check, got sz=%d ok=%v", tc.name, tc.addrs, sz, ok)
			}
			if resolverCalls.Load() != 1 {
				t.Fatalf("%s: expected fetch.Client resolver to be consulted once before rejecting private IP, got %d", tc.name, resolverCalls.Load())
			}

			// End-to-end Parse: the browser-side link is still returned, but the
			// server never fetched it, so no probed size is attached.
			w, h := int64(1280), int64(720)
			adapter := NewWithResolver(fbSpec, &stubExtractor{
				enabled: true,
				extract: func(context.Context, string) (*ytengine.Info, error) {
					return &ytengine.Info{
						ID:    "647537299265662",
						Title: "Private Media Host",
						Formats: []ytengine.Format{
							{
								FormatID: "hd",
								URL:      mediaURL,
								Ext:      "mp4",
								Protocol: "https",
								Width:    &w,
								Height:   &h,
								VCodec:   "avc1.4d401f",
								ACodec:   "mp4a.40.2",
								Filesize: nil,
							},
						},
					}, nil
				},
			}, prober, privResolver)
			res, err := adapter.Parse(context.Background(), "https://www.facebook.com/watch/?v=647537299265662", now)
			if err != nil {
				t.Fatalf("%s: unexpected error: %v", tc.name, err)
			}
			if unified.Str(res["code"]) != "OK" {
				t.Fatalf("%s: expected OK browser-side link when CDN resolves to %v, got %v", tc.name, tc.addrs, res)
			}
			item := unified.Map(unified.Slice(unified.Map(res["data"])["items"])[0])
			variant := unified.Map(unified.Slice(item["variants"])[0])
			src := unified.Map(unified.Slice(unified.Map(variant["delivery"])["sources"])[0])
			if _, probed := src["size_bytes"]; probed {
				t.Fatalf("%s: private-IP probe must not yield size_bytes, got %v", tc.name, src)
			}
		}
	})
}
