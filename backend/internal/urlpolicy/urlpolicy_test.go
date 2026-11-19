package urlpolicy_test

import (
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/instagram"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/xiaohongshu"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/youtube"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/urlpolicy"
)

func TestHasUnsafeChars(t *testing.T) {
	safe := []string{
		"",
		"https://rr1---sn-ogueln67.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4",
		"https://sns-v11.rednotecdn.com/stream/01e.mp4?sig=a%2Bb+z",
		"https://example.com/中文路径/file.mp4",
		"!#$%&'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~",
	}
	for _, s := range safe {
		if urlpolicy.HasUnsafeChars(s) {
			t.Fatalf("HasUnsafeChars(%q) = true, want false", s)
		}
	}

	unsafe := []string{
		" ",
		"https://example.com/a b.mp4",
		"https://example.com/a\\b.mp4",
		"https://example.com/\x00a",
		"https://example.com/\ta",
		"https://example.com/\na",
		"https://example.com/\ra",
		"https://example.com/\x1fa",
		"https://example.com/\x7fa",
	}
	for _, s := range unsafe {
		if !urlpolicy.HasUnsafeChars(s) {
			t.Fatalf("HasUnsafeChars(%q) = false, want true", s)
		}
	}
}

func TestHostSuffixURLAndStrictHostRuleURL(t *testing.T) {
	if urlpolicy.HostSuffixURL("https://i.ytimg.com/vi/abc/hqdefault.jpg", nil, ".ytimg.com") {
		t.Fatal("expected empty schemes slice to fail")
	}
	if urlpolicy.HostSuffixURL("https://i.ytimg.com/vi/abc/hqdefault.jpg", urlpolicy.HTTPAndHTTPS) {
		t.Fatal("expected empty suffixes list to fail")
	}
	if urlpolicy.HostSuffixURL("https://i.ytimg.com/vi/abc/hqdefault.jpg", urlpolicy.HTTPAndHTTPS, "", ".") {
		t.Fatal("expected blank/dot-only suffixes to fail")
	}
	// Suffix passed without leading dot still enforces strict subdomain boundary (never partial label).
	if !urlpolicy.HostSuffixURL("https://i.ytimg.com/vi/abc/hqdefault.jpg", urlpolicy.HTTPAndHTTPS, "ytimg.com") {
		t.Fatal("expected subdomain to match normalized suffix")
	}
	if urlpolicy.HostSuffixURL("https://ytimg.com/vi/abc/hqdefault.jpg", urlpolicy.HTTPAndHTTPS, "ytimg.com") {
		t.Fatal("expected bare domain not to match HostSuffixURL")
	}
	if urlpolicy.HostSuffixURL("https://evilytimg.com/vi/abc/hqdefault.jpg", urlpolicy.HTTPAndHTTPS, "ytimg.com") {
		t.Fatal("expected partial-label suffix lookalike to be rejected")
	}

	// ParseStandardURL accepts numeric ":0443"; ParseCanonicalURL rejects non-canonical ":0443".
	if _, ok := urlpolicy.ParseStandardURL("https://i.ytimg.com:0443/a.jpg", urlpolicy.HTTPSOnly); !ok {
		t.Fatal("expected ParseStandardURL to accept numeric port :0443")
	}
	if _, ok := urlpolicy.ParseCanonicalURL("https://i.ytimg.com:0443/a.jpg", urlpolicy.HTTPSOnly); ok {
		t.Fatal("expected ParseCanonicalURL to reject non-canonical port :0443")
	}

	// StrictHostRuleURL enforces maxLen, canonical port, trailing colon, unsafe chars, non-IP, and exact/suffix rules.
	exact8192 := "https://cdn.example.com/" + strings.Repeat("a", 8192-len("https://cdn.example.com/"))
	if !urlpolicy.StrictHostRuleURL(exact8192, urlpolicy.HTTPAndHTTPS, 8192, ".example.com") {
		t.Fatal("expected exact 8192-byte URL to pass StrictHostRuleURL")
	}
	if urlpolicy.StrictHostRuleURL(exact8192+"a", urlpolicy.HTTPAndHTTPS, 8192, ".example.com") {
		t.Fatal("expected 8193-byte URL to fail StrictHostRuleURL")
	}
	if !urlpolicy.StrictHostRuleURL("https://EXAMPLE.COM./video.mp4", urlpolicy.HTTPSOnly, 8192, "example.com") {
		t.Fatal("expected exact host rule with trailing DNS dot to pass StrictHostRuleURL")
	}
	if urlpolicy.StrictHostRuleURL("http://example.com/video.mp4", urlpolicy.HTTPSOnly, 8192, "example.com") {
		t.Fatal("expected http URL to fail HTTPSOnly StrictHostRuleURL")
	}
}

// Verbatim pre-refactor reference implementations for before-vs-after equivalence verification.

func legacyYouTubeAllowedMediaURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || (scheme == "https" && n != 443) || (scheme == "http" && n != 80) {
			return false
		}
	}
	host := strings.ToLower(u.Hostname())
	for _, suffix := range []string{".googlevideo.com", ".ytimg.com", ".ggpht.com", ".googleusercontent.com", ".youtube.com"} {
		if strings.HasSuffix(host, suffix) && len(host) > len(suffix) {
			return true
		}
	}
	return host == "i.ytimg.com" || host == "img.youtube.com"
}

func legacyInstagramAllowedMediaURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || (scheme == "https" && n != 443) || (scheme == "http" && n != 80) {
			return false
		}
	}
	host := strings.ToLower(u.Hostname())
	for _, suffix := range []string{".cdninstagram.com", ".fbcdn.net", ".instagram.com"} {
		if strings.HasSuffix(host, suffix) && len(host) > len(suffix) {
			return true
		}
	}
	return false
}

func legacyYTGenericMatchMediaURL(suffixes []string, isNilParser bool) func(string) bool {
	hostMatchesRule := func(host, rule string) bool {
		h := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
		r := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(rule), "."))
		if h == "" || r == "" {
			return false
		}
		if strings.HasPrefix(r, ".") {
			return strings.HasSuffix(h, r) && len(h) > len(r)
		}
		return h == r
	}
	return func(raw string) bool {
		if isNilParser || len(suffixes) == 0 || len(raw) == 0 || len(raw) > 8192 {
			return false
		}
		for _, r := range raw {
			if r <= 0x20 || r == 0x7f || r == '\\' {
				return false
			}
		}
		u, err := url.Parse(raw)
		if err != nil || u.User != nil || u.Opaque != "" || strings.HasSuffix(u.Host, ":") {
			return false
		}
		scheme := strings.ToLower(u.Scheme)
		if scheme != "http" && scheme != "https" {
			return false
		}
		if port := u.Port(); port != "" {
			if !((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) {
				return false
			}
		}
		rawHost := strings.TrimSpace(u.Hostname())
		host := strings.ToLower(strings.TrimSuffix(rawHost, "."))
		if host == "" {
			return false
		}
		if _, err := netip.ParseAddr(rawHost); err == nil {
			return false
		}
		if _, err := netip.ParseAddr(host); err == nil {
			return false
		}
		for _, s := range suffixes {
			if hostMatchesRule(host, s) {
				return true
			}
		}
		return false
	}
}

var legacyDouyinMediaHost = regexp.MustCompile(`^v[0-9][a-z0-9-]*\.(?:douyinvod\.com|zjcdn\.com)$`)

func legacyDouyinAllowedMediaURL(raw string) bool {
	if len(raw) > 8192 || strings.Contains(raw, "#") || unified.MediaURL(raw) == "" {
		return false
	}
	for _, r := range raw {
		if r <= 0x20 || r == 0x7f || r == '\\' {
			return false
		}
	}
	scheme, remainder, ok := strings.Cut(raw, "://")
	if !ok || scheme != "https" {
		return false
	}
	authority := remainder
	if index := strings.IndexAny(authority, "/?"); index >= 0 {
		authority = authority[:index]
	}
	if strings.Contains(authority, "@") {
		return false
	}
	host, port, hasPort := strings.Cut(authority, ":")
	if hasPort && port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value != 443 {
			return false
		}
	}
	path := remainder[len(authority):]
	path, _, _ = strings.Cut(path, "?")
	return host == "aweme.snssdk.com" && path == "/aweme/v1/play/" || legacyDouyinMediaHost.MatchString(host)
}

func legacyXHSAllowedURL(raw string) bool {
	if unified.MediaURL(raw) == "" {
		return false
	}
	for _, r := range raw {
		if r <= 0x20 || r == 0x7f || r == '\\' {
			return false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || (u.Scheme != "https" && u.Scheme != "http") || (u.Port() != "" && u.Port() != "80" && u.Port() != "443") {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "xiaohongshu.com", "www.xiaohongshu.com", "rednote.com", "www.rednote.com", "xhslink.com", "www.xhslink.com", "xhs.com", "www.xhs.com":
		return true
	}
	return false
}

var legacyXHSMediaPath = regexp.MustCompile(`^/[A-Za-z0-9_/-]+$`)

func legacyXHSAllowedMediaURL(raw string) bool {
	if len(raw) > 8192 || strings.Contains(raw, "#") || unified.MediaURL(raw) == "" {
		return false
	}
	for _, r := range raw {
		if r <= 0x20 || r == 0x7f || r == '\\' {
			return false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Scheme != "https" || (u.Port() != "" && u.Port() != "443") || !legacyXHSMediaPath.MatchString(u.EscapedPath()) || strings.Contains(u.EscapedPath(), "..") {
		return false
	}
	switch u.Hostname() {
	case "sns-video-qn.xhscdn.com", "sns-video-al.xhscdn.com", "sns-video-qc.xhscdn.com", "sns-video-bd.xhscdn.com":
		return true
	}
	return false
}

func legacyXHSAllowedBrowserFetchURL(raw string) bool {
	if len(raw) < 8 || len(raw) > 8192 || strings.Contains(raw, "#") || unified.MediaURL(raw) != raw {
		return false
	}
	for _, r := range raw {
		if r <= 0x20 || r == 0x7f || r == '\\' {
			return false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Scheme != "https" || strings.HasSuffix(u.Host, ":") || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	for _, b := range []byte(u.Host) {
		if b > 127 {
			return false
		}
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return false
	}
	hasSub := func(suffix string) bool {
		if !strings.HasSuffix(host, suffix) || len(host) <= len(suffix) {
			return false
		}
		prefix := host[:len(host)-len(suffix)]
		for _, label := range strings.Split(prefix, ".") {
			if label == "" || label[0] == '-' || label[len(label)-1] == '-' {
				return false
			}
			for i := 0; i < len(label); i++ {
				c := label[i]
				if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
					return false
				}
			}
		}
		return true
	}
	return hasSub(".xhscdn.com") || hasSub(".rednotecdn.com")
}

func TestPlatformAllowlistBeforeAfterEquivalence(t *testing.T) {
	fbSpec, ok := ytgeneric.LookupSite("facebook")
	if !ok {
		t.Fatal("missing facebook spec")
	}
	tbSpec, ok := ytgeneric.LookupSite("tumblr")
	if !ok {
		t.Fatal("missing tumblr spec")
	}
	dmSpec, ok := ytgeneric.LookupSite("dailymotion")
	if !ok {
		t.Fatal("missing dailymotion spec")
	}
	mixedSpec := ytgeneric.SiteSpec{
		PlatformID:      "vimeo",
		MediaHostSuffix: []string{".vimeocdn.com", "vimeo.com"},
	}
	ipSpec := ytgeneric.SiteSpec{
		PlatformID:      "synthetic-ip",
		MediaHostSuffix: []string{"127.0.0.1", ".0.0.1", "::1", "fe80::1%lo0"},
	}
	emptySpec := ytgeneric.SiteSpec{PlatformID: "empty"}
	var nilYTParser *ytgeneric.Parser

	predicates := []struct {
		name   string
		before func(string) bool
		after  func(string) bool
	}{
		{
			name:   "youtube.AllowedMediaURL",
			before: legacyYouTubeAllowedMediaURL,
			after:  youtube.AllowedMediaURL,
		},
		{
			name:   "instagram.AllowedMediaURL",
			before: legacyInstagramAllowedMediaURL,
			after:  instagram.AllowedMediaURL,
		},
		{
			name:   "ytgeneric.facebook.MatchMediaURL",
			before: legacyYTGenericMatchMediaURL(fbSpec.MediaHostSuffix, false),
			after:  ytgeneric.New(fbSpec, nil, nil).MatchMediaURL,
		},
		{
			name:   "ytgeneric.tumblr.MatchMediaURL",
			before: legacyYTGenericMatchMediaURL(tbSpec.MediaHostSuffix, false),
			after:  ytgeneric.New(tbSpec, nil, nil).MatchMediaURL,
		},
		{
			name:   "ytgeneric.dailymotion.MatchMediaURL",
			before: legacyYTGenericMatchMediaURL(dmSpec.MediaHostSuffix, false),
			after:  ytgeneric.New(dmSpec, nil, nil).MatchMediaURL,
		},
		{
			name:   "ytgeneric.mixedExactAndSuffix.MatchMediaURL",
			before: legacyYTGenericMatchMediaURL(mixedSpec.MediaHostSuffix, false),
			after:  ytgeneric.New(mixedSpec, nil, nil).MatchMediaURL,
		},
		{
			name:   "ytgeneric.syntheticIP.MatchMediaURL",
			before: legacyYTGenericMatchMediaURL(ipSpec.MediaHostSuffix, false),
			after:  ytgeneric.New(ipSpec, nil, nil).MatchMediaURL,
		},
		{
			name:   "ytgeneric.empty.MatchMediaURL",
			before: legacyYTGenericMatchMediaURL(nil, false),
			after:  ytgeneric.New(emptySpec, nil, nil).MatchMediaURL,
		},
		{
			name:   "ytgeneric.nil.MatchMediaURL",
			before: legacyYTGenericMatchMediaURL(fbSpec.MediaHostSuffix, true),
			after:  nilYTParser.MatchMediaURL,
		},
		{
			name:   "douyin.AllowedMediaURL",
			before: legacyDouyinAllowedMediaURL,
			after:  douyin.AllowedMediaURL,
		},
		{
			name:   "xiaohongshu.AllowedURL",
			before: legacyXHSAllowedURL,
			after:  xiaohongshu.AllowedURL,
		},
		{
			name:   "xiaohongshu.AllowedMediaURL",
			before: legacyXHSAllowedMediaURL,
			after:  xiaohongshu.AllowedMediaURL,
		},
		{
			name:   "xiaohongshu.AllowedBrowserFetchURL",
			before: legacyXHSAllowedBrowserFetchURL,
			after:  xiaohongshu.AllowedBrowserFetchURL,
		},
	}

	inputs := []string{
		"",
		" ",
		"://invalid",
		"https:///missing-host",
		"https://./dot-only",
		"javascript:alert(1)",
		"https:opaque/path",
		"ftp://i.ytimg.com/vi/abc/hqdefault.jpg",
		"file:///etc/passwd",

		// YouTube cases & edge cases
		"https://rr2---sn-ogueln67.googlevideo.com/videoplayback?itag=18",
		"http://rr2---sn-ogueln67.googlevideo.com:80/videoplayback?itag=18",
		"https://rr2---sn-ogueln67.googlevideo.com:443/videoplayback?itag=18",
		"https://rr2---sn-ogueln67.googlevideo.com:0443/videoplayback?itag=18",
		"https://rr2---sn-ogueln67.googlevideo.com:8443/videoplayback?itag=18",
		"https://rr2---sn-ogueln67.googlevideo.com:/videoplayback?itag=18",
		"https://i.ytimg.com/vi_webp/aqz-KE-bpKQ/maxresdefault.webp",
		"https://img.youtube.com/vi/aqz-KE-bpKQ/0.jpg",
		"https://yt3.ggpht.com/ytc/avatar.jpg",
		"https://lh3.googleusercontent.com/a/photo",
		"https://googlevideo.com/videoplayback",
		"https://youtube.com/watch?v=aqz-KE-bpKQ",
		"https://evilgooglevideo.com/videoplayback",
		"https://i.ytimg.com./vi/aqz-KE-bpKQ/0.jpg",
		"https://i.ytimg.com/a b.jpg",
		"https://i.ytimg.com/a\\b.jpg",
		"https://i.ytimg.com/" + strings.Repeat("a", 8200),
		"https://user:pass@i.ytimg.com/vi/abc/0.jpg",

		// Instagram cases & edge cases
		"https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/s1080.jpg",
		"http://scontent-nrt1-1.cdninstagram.com:80/v/t51.29350-15/s1080.jpg",
		"https://video-nrt6-1.xx.fbcdn.net/o1/v/t2/f2/m366/sample.mp4",
		"https://www.instagram.com/static/img.jpg",
		"https://instagram.com/static/img.jpg",
		"https://cdninstagram.com/v/s1080.jpg",
		"https://evilcdninstagram.com/v/s1080.jpg",
		"https://scontent.cdninstagram.com:0443/v/s1080.jpg",
		"https://scontent.cdninstagram.com:/v/s1080.jpg",

		// ytgeneric cases & edge cases
		"HTTPS://SCONTENT-NRT1-2.XX.FBCDN.NET./v/t15.5256-10/thumb.jpg?oe=1",
		"https://video-nrt6-1.xx.fbcdn.net:0443/sample.mp4",
		"https://video-nrt6-1.xx.fbcdn.net:/sample.mp4",
		"https://video-nrt6-1.xx.fbcdn.net/a b.mp4",
		"https://video-nrt6-1.xx.fbcdn.net/a\\b.mp4",
		"https://video-nrt6-1.xx.fbcdn.net/\x7fa.mp4",
		"https://video-nrt6-1.xx.fbcdn.net/" + strings.Repeat("a", 8200),
		"https://va.media.tumblr.com/tumblr_qfbsolGm3H1r8hd26_720.mp4",
		"https://media.tumblr.com/sample.mp4",
		"https://vod2.cf.dmcdn.net/sec2(tok)/cloud/manifest.m3u8",
		"https://s2.dmcdn.net/v/xbvrdzy/x1080",
		"https://vimeo.com/123456.mp4",
		"https://VIMEO.COM./123456.mp4",
		"https://vod.vimeocdn.com/123456.mp4",
		"https://vimeocdn.com/123456.mp4",
		"https://127.0.0.1/sample.mp4",
		"https://127.0.0.1./sample.mp4",
		"https://10.0.0.1/sample.mp4",
		"https://[::1]/sample.mp4",
		"https://[fe80::1%25lo0]/sample.mp4",
		"https://[::ffff:127.0.0.1]/sample.mp4",

		// Douyin cases & edge cases
		"https://aweme.snssdk.com/aweme/v1/play/?video_id=v0200fg10000",
		"https://aweme.snssdk.com/aweme/v1/play/",
		"https://aweme.snssdk.com/aweme/v1/other",
		"https://v5-test.douyinvod.com/a",
		"https://v5-test.douyinvod.com:443/a",
		"https://v5-test.douyinvod.com:0443/a",
		"https://v5-test.douyinvod.com:444/a",
		"https://v5-test.douyinvod.com:/a",
		"https://v5-hl-mly-ov.zjcdn.com/a",
		"http://v5-test.douyinvod.com/a",
		"HTTPS://v5-test.douyinvod.com/a",
		"https://V5-test.douyinvod.com/a",
		"https://v5-test.douyinvod.com/a#frag",
		"https://v5-test.douyinvod.com/\na",
		"https://v5-test.douyinvod.com/a\\b",
		"https://user@v5-test.douyinvod.com/a",

		// Xiaohongshu cases & edge cases
		"https://www.xiaohongshu.com/explore/6a7e74de0000000033033075",
		"http://www.xiaohongshu.com:80/explore/6a7e74de0000000033033075",
		"http://www.xiaohongshu.com:443/explore/6a7e74de0000000033033075",
		"https://www.xiaohongshu.com:80/explore/6a7e74de0000000033033075",
		"https://www.xiaohongshu.com:0443/explore/6a7e74de0000000033033075",
		"https://xhslink.com/a/abc123",
		"https://www.rednote.com/explore/6a7e74de0000000033033075",
		"https://sns-video-qn.xhscdn.com/spectrum/1040g00g31000000",
		"https://sns-video-al.xhscdn.com:443/stream/110/258/01e_mp4?sign=abc",
		"https://sns-video-al.xhscdn.com:0443/stream/110/258/01e_mp4",
		"https://sns-video-al.xhscdn.com:/stream/110/258/01e_mp4",
		"https://SNS-VIDEO-QN.xhscdn.com/spectrum/1040g00g31000000",
		"https://sns-video-qn.xhscdn.com/spectrum/../secret",
		"https://sns-video-qn.xhscdn.com/spectrum/01e.mp4",
		"https://sns-video-qn.xhscdn.com/spectrum/1040g00g#frag",
		"https://sns-v11.rednotecdn.com/stream/110/258/01e.mp4?sig=a%2Bb+z",
		"https://SNS-V11.rednotecdn.com:443/a",
		"https://ſns-v11.rednotecdn.com/a",
		"https://-bad.xhscdn.com/a",
		"https://xhscdn.com/a",
	}

	for _, p := range predicates {
		t.Run(p.name, func(t *testing.T) {
			for _, raw := range inputs {
				want := p.before(raw)
				got := p.after(raw)
				if got != want {
					t.Fatalf("%s(%q) = %v, want %v (before-vs-after mismatch)", p.name, raw, got, want)
				}
			}
		})
	}
}
