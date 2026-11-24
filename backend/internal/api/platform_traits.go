package api

import (
	"net/url"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/instagram"
)

// platformTrait centralizes per-platform admission, parse-cache, TTL, and URL
// canonicalization traits in one declarative table so adding or adjusting a
// platform never drifts across admission.go and cache.go.
//
// Note: unified.requiresAudibleDefault (in internal/unified/select.go) is an
// independent unified-v1 contract rule (#38) governing default file selection
// and intentionally is NOT coupled to this HTTP admission/cache table.
type platformTrait struct {
	// slowEngine routes /api/parse cache misses to the PARSE_SLOW admission pool
	// sized to ytengine subprocess concurrency.
	slowEngine bool
	// strictInput2048 marks cacheable platforms whose parsers reject inputs
	// exceeding maxYTDLPInputBytes (2048 bytes), preventing parseCache from
	// normalizing or serving overlong inputs from a warm entry.
	strictInput2048 bool
	// disableParseCache excludes platforms whose responses carry requester-bound
	// or channel-dependent artifacts:
	//   - weibo: mints HMAC-signed /api/media/weibo?ticket=... relay tickets (and
	//     differs between anonymous visitors and owner-token callers).
	// Note: youtube is allowed into parseCache with a short, dynamically configurable
	// TTL (cache.youtube_parse_ttl, default 120s; 0s disables YouTube caching) while
	// /api/youtube/context and /api/youtube/finalize remain outside parseCache.
	disableParseCache bool
	// shanghaiFallbackShortTTL caps OK parseCache TTL at shanghaiFallbackCacheTTL
	// (15s) when a Shanghai-enabled platform degraded to overseas fallback so the
	// cache self-heals promptly on recovery.
	shanghaiFallbackShortTTL bool
	// maxOKCacheTTL overrides the upper bound for OK responses when > 0 (e.g.
	// genericCacheTTL = 60s for Tier-2 generic fallback).
	maxOKCacheTTL time.Duration
	// canonicalHTTPSHosts maps lowercase HTTP/HTTPS host aliases to their
	// canonical HTTPS host when building parseCache keys.
	canonicalHTTPSHosts map[string]string
	// normalizeCacheURL optionally canonicalizes equivalent post/reel path shapes
	// (e.g. Instagram shortlinks); when handled is false, canonicalHTTPSHosts
	// fallback is applied automatically.
	normalizeCacheURL func(source string) (scheme, host, escapedPath string, handled bool)
}

// PlatformGeneric is the internal Tier-2 routing and API-key scope sentinel
// for named yt-dlp generic fallback requests when DOKITOOL_YTDLP_GENERIC_ENABLED
// is enabled. It is never published in catalog.Envelope() and never returned as
// data.platform in unified-v1 responses.
const PlatformGeneric = "ytdlp_generic"

func normalizeInstagramCacheURL(source string) (string, string, string, bool) {
	if _, canonical, ok := instagram.ExtractPostTarget(source); ok {
		if cu, parseErr := url.Parse(canonical); parseErr == nil {
			return "https", "www.instagram.com", cu.EscapedPath(), true
		}
	}
	return "", "", "", false
}

var platformTraits = map[string]platformTrait{
	"douyin": {
		shanghaiFallbackShortTTL: true,
	},
	"bilibili": {
		shanghaiFallbackShortTTL: true,
	},
	"weibo": {
		disableParseCache: true,
	},
	"x": {
		slowEngine:      true,
		strictInput2048: true,
		canonicalHTTPSHosts: map[string]string{
			"x.com":              "x.com",
			"www.x.com":          "x.com",
			"mobile.x.com":       "x.com",
			"m.x.com":            "x.com",
			"twitter.com":        "x.com",
			"www.twitter.com":    "x.com",
			"mobile.twitter.com": "x.com",
			"m.twitter.com":      "x.com",
			"t.co":               "t.co",
		},
	},
	"youtube": {
		slowEngine:        true,
		strictInput2048:   true,
		disableParseCache: false,
		canonicalHTTPSHosts: map[string]string{
			"www.youtube.com": "www.youtube.com",
			"youtube.com":     "www.youtube.com",
			"m.youtube.com":   "www.youtube.com",
		},
	},
	"instagram": {
		slowEngine:      true,
		strictInput2048: true,
		canonicalHTTPSHosts: map[string]string{
			"www.instagram.com": "www.instagram.com",
			"instagram.com":     "www.instagram.com",
			"m.instagram.com":   "www.instagram.com",
		},
		normalizeCacheURL: normalizeInstagramCacheURL,
	},
	"facebook": {
		slowEngine:      true,
		strictInput2048: true,
		canonicalHTTPSHosts: map[string]string{
			"facebook.com":   "www.facebook.com",
			"m.facebook.com": "www.facebook.com",
		},
	},
	"tumblr": {
		slowEngine:      true,
		strictInput2048: true,
		canonicalHTTPSHosts: map[string]string{
			"tumblr.com": "www.tumblr.com",
		},
	},
	PlatformGeneric: {
		slowEngine:      true,
		strictInput2048: true,
		maxOKCacheTTL:   genericCacheTTL,
	},
}

func traitsForPlatform(platform string) platformTrait {
	return platformTraits[platform]
}

func normalizePlatformCacheURL(platform, source, scheme, host, escapedPath string) (string, string, string) {
	traits := traitsForPlatform(platform)
	if traits.normalizeCacheURL != nil {
		if s, h, p, ok := traits.normalizeCacheURL(source); ok {
			return s, h, p
		}
	}
	if canonicalHost, ok := traits.canonicalHTTPSHosts[host]; ok {
		return "https", canonicalHost, escapedPath
	}
	return scheme, host, escapedPath
}
