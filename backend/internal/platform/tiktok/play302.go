package tiktok

import (
	"context"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const (
	play302MaxConcurrent = 3
	play302HopTimeout    = 4 * time.Second
	play302MaxBytes      = 64 << 10
	maxVideoTiers        = 4
)

var allowedTikTokCDNSuffixes = []string{
	".tiktokcdn.com",
	".tiktokcdn-us.com",
	".tiktokcdn-eu.com",
	".tiktokv.com",
}

// AllowedMediaURL enforces the strict TikTok cookie-free CDN boundary aligned
// with the Chrome extension's hostWhitelist.ts and DNR RULE 1009.
// It explicitly rejects *-webapp-prime.tiktok.com and tk=tt_chain_token URLs
// which require authenticated/session cookies.
func AllowedMediaURL(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 4096 {
		return false
	}
	for _, r := range trimmed {
		if r <= 0x20 || r >= 0x7f || r == '\\' || r == '#' {
			return false
		}
	}
	// Ensure every accepted CDN URL is a strict subset of unified.MediaURL
	// (printable ASCII, valid DNS labels, no userinfo) so valid client/upstream
	// media URLs can never trigger 502 contract failures during envelope validation.
	if unified.MediaURL(trimmed) != trimmed {
		return false
	}
	u, err := url.Parse(trimmed)
	if err != nil || u == nil || u.Opaque != "" || u.User != nil {
		return false
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return false
	}
	if port := u.Port(); port != "" && port != "443" {
		return false
	}
	if strings.HasSuffix(u.Host, ":") {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host == "" {
		return false
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return false
	}
	// Explicitly block webapp-prime cookie-bound endpoints.
	if strings.HasSuffix(host, "-webapp-prime.tiktok.com") || host == "tiktok.com" || strings.HasSuffix(host, ".tiktok.com") {
		return false
	}
	matched := false
	for _, suffix := range allowedTikTokCDNSuffixes {
		if strings.HasSuffix(host, suffix) && len(host) > len(suffix) {
			matched = true
			break
		}
	}
	if !matched {
		return false
	}
	// Fail-closed rejection of cookie-bound tt_chain_token query parameter across
	// both '&' and ';' separators, malformed percent escapes, and case variants.
	if u.RawQuery != "" && hasChainTokenQueryParam(u.RawQuery) {
		return false
	}
	return true
}

func hasChainTokenQueryParam(rawQuery string) bool {
	for _, pair := range strings.FieldsFunc(rawQuery, func(r rune) bool {
		return r == '&' || r == ';'
	}) {
		if pair == "" {
			continue
		}
		rawKey, rawVal, hasEq := strings.Cut(pair, "=")
		if !hasEq {
			continue
		}
		key, err := url.QueryUnescape(rawKey)
		if err != nil {
			key = rawKey
		}
		if !strings.EqualFold(strings.TrimSpace(key), "tk") {
			continue
		}
		val, err := url.QueryUnescape(rawVal)
		if err != nil {
			val = rawVal
		}
		if strings.EqualFold(strings.TrimSpace(val), "tt_chain_token") {
			return true
		}
	}
	return false
}

func isPlayRedirectSourceURL(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 4096 {
		return false
	}
	u, err := url.Parse(trimmed)
	if err != nil || u == nil || u.Opaque != "" || u.User != nil {
		return false
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return false
	}
	if port := u.Port(); port != "" && port != "443" {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	return host == "www.tiktok.com" && strings.HasPrefix(u.Path, "/aweme/v1/play/")
}

func findPlayRedirectURL(urls []string) string {
	for _, raw := range urls {
		if isPlayRedirectSourceURL(raw) {
			return strings.TrimSpace(raw)
		}
	}
	return ""
}

func isUnsupportedCodec(raw string) bool {
	lower := strings.ToLower(strings.TrimSpace(raw))
	return strings.Contains(lower, "bytevc2") || strings.Contains(lower, "vvc")
}

func normalizeVideoCodec(raw string) string {
	lower := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case strings.Contains(lower, "h265"), strings.Contains(lower, "hevc"), strings.Contains(lower, "bytevc1"), strings.Contains(lower, "hvc1"):
		return "h265"
	case strings.Contains(lower, "h264"), strings.Contains(lower, "avc"):
		return "h264"
	case strings.Contains(lower, "av1"), strings.Contains(lower, "av01"):
		return "av1"
	default:
		return ""
	}
}

type videoTierCandidate struct {
	playURL  string
	width    int64
	height   int64
	bitrate  int64
	dataSize int64
	codec    string
	gearName string
}

func (c videoTierCandidate) pixelArea() int64 {
	if c.width > 0 && c.height > 0 {
		return c.width * c.height
	}
	return 0
}

func (c videoTierCandidate) shortEdge() int64 {
	if c.width > 0 && c.height > 0 {
		if c.width < c.height {
			return c.width
		}
		return c.height
	}
	if c.height > 0 {
		return c.height
	}
	return c.width
}

func selectVideoTierCandidates(v *tiktokVideo) []videoTierCandidate {
	if v == nil {
		return nil
	}
	all := make([]videoTierCandidate, 0, len(v.BitrateInfo)+1)
	seenPlay := make(map[string]struct{})
	for _, info := range v.BitrateInfo {
		if isUnsupportedCodec(info.CodecType) || info.PlayAddr == nil {
			continue
		}
		playURL := findPlayRedirectURL(info.PlayAddr.URLList)
		if playURL == "" {
			continue
		}
		if _, dup := seenPlay[playURL]; dup {
			continue
		}
		seenPlay[playURL] = struct{}{}
		w := int64(info.PlayAddr.Width)
		h := int64(info.PlayAddr.Height)
		if w <= 0 {
			w = int64(v.Width)
		}
		if h <= 0 {
			h = int64(v.Height)
		}
		all = append(all, videoTierCandidate{
			playURL:  playURL,
			width:    w,
			height:   h,
			bitrate:  int64(info.Bitrate),
			dataSize: int64(info.PlayAddr.DataSize),
			codec:    normalizeVideoCodec(info.CodecType),
			gearName: strings.TrimSpace(info.GearName),
		})
	}
	if len(all) == 0 && isPlayRedirectSourceURL(v.PlayAddr) {
		all = append(all, videoTierCandidate{
			playURL: strings.TrimSpace(v.PlayAddr),
			width:   int64(v.Width),
			height:  int64(v.Height),
			bitrate: int64(v.Bitrate),
			codec:   normalizeVideoCodec(v.CodecType),
		})
	}
	if len(all) == 0 {
		return nil
	}

	// Sort descending by pixel area, then bitrate, then prefer h264 on exact ties.
	slices.SortStableFunc(all, func(a, b videoTierCandidate) int {
		if pa, pb := a.pixelArea(), b.pixelArea(); pa != pb {
			if pa > pb {
				return -1
			}
			return 1
		}
		if a.bitrate != b.bitrate {
			if a.bitrate > b.bitrate {
				return -1
			}
			return 1
		}
		if a.codec != b.codec {
			if a.codec == "h264" {
				return -1
			}
			if b.codec == "h264" {
				return 1
			}
		}
		return 0
	})

	if len(all) <= maxVideoTiers {
		return all
	}

	pickedIdx := make([]int, 0, maxVideoTiers)
	used := make(map[int]bool, maxVideoTiers)
	addIdx := func(idx int) {
		if idx < 0 || idx >= len(all) || used[idx] || len(pickedIdx) >= maxVideoTiers {
			return
		}
		used[idx] = true
		pickedIdx = append(pickedIdx, idx)
	}

	// 1. Highest resolution tier
	addIdx(0)

	// 2. Second highest distinct resolution tier (fallback to index 1)
	topArea := all[0].pixelArea()
	secondIdx := -1
	for i := 1; i < len(all); i++ {
		if all[i].pixelArea() != topArea {
			secondIdx = i
			break
		}
	}
	if secondIdx >= 0 {
		addIdx(secondIdx)
	} else {
		addIdx(1)
	}

	// 3. Highest resolution H.264 tier
	for i := 0; i < len(all); i++ {
		if !used[i] && all[i].codec == "h264" {
			addIdx(i)
			break
		}
	}

	// 4. Lowest bitrate / smallest resolution tier
	lowestIdx := -1
	for i := len(all) - 1; i >= 0; i-- {
		if !used[i] {
			if lowestIdx < 0 {
				lowestIdx = i
				continue
			}
			cur := all[i]
			best := all[lowestIdx]
			if (cur.bitrate > 0 && (best.bitrate <= 0 || cur.bitrate < best.bitrate)) ||
				(cur.bitrate == best.bitrate && cur.pixelArea() < best.pixelArea()) {
				lowestIdx = i
			}
		}
	}
	addIdx(lowestIdx)

	// Fill any remaining slot up to maxVideoTiers in quality order.
	for i := 0; i < len(all) && len(pickedIdx) < maxVideoTiers; i++ {
		addIdx(i)
	}

	slices.Sort(pickedIdx)
	out := make([]videoTierCandidate, 0, len(pickedIdx))
	for _, idx := range pickedIdx {
		out = append(out, all[idx])
	}
	return out
}

type resolvedVideoTier struct {
	candidate videoTierCandidate
	directURL string
	expiresAt string
}

// resolvePlay302Tiers resolves selected /aweme/v1/play/ candidates concurrently
// (maxConcurrent=3, plain GET with NO Range header and NO Cookie, 4s/hop).
func (p *Parser) resolvePlay302Tiers(ctx context.Context, candidates []videoTierCandidate, now int64) []resolvedVideoTier {
	if len(candidates) == 0 {
		return nil
	}
	results := make([]*resolvedVideoTier, len(candidates))
	sem := make(chan struct{}, play302MaxConcurrent)
	var wg sync.WaitGroup

	for i, cand := range candidates {
		wg.Add(1)
		go func(idx int, c videoTierCandidate) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				p.play302Failed.Add(1)
				return
			}
			directURL, ok := p.resolveSinglePlay302(ctx, c.playURL)
			if !ok {
				p.play302Failed.Add(1)
				return
			}
			p.play302OK.Add(1)
			exp := parseTikTokURLExpiry(directURL, now)
			results[idx] = &resolvedVideoTier{
				candidate: c,
				directURL: directURL,
				expiresAt: exp,
			}
		}(i, cand)
	}
	wg.Wait()

	out := make([]resolvedVideoTier, 0, len(candidates))
	seenDirect := make(map[string]struct{}, len(candidates))
	for _, r := range results {
		if r == nil {
			continue
		}
		if _, dup := seenDirect[r.directURL]; dup {
			continue
		}
		seenDirect[r.directURL] = struct{}{}
		out = append(out, *r)
	}
	return out
}

func (p *Parser) resolveSinglePlay302(ctx context.Context, playURL string) (string, bool) {
	if !isPlayRedirectSourceURL(playURL) {
		return "", false
	}
	headers := make(http.Header)
	headers.Set("User-Agent", tiktokBrowserUA)
	headers.Set("Referer", "https://www.tiktok.com/")
	// Deliberately NO Range header and NO Cookie header.

	resp, err := p.executor.Do(ctx, fetch.Request{
		Method: http.MethodGet,
		URL:    playURL,
		Header: headers,
		Policy: fetch.Policy{
			Platform:        "tiktok",
			Purpose:         "tiktok-play-302",
			AllowedURL:      fetch.AllowHosts("www.tiktok.com"),
			Timeout:         play302HopTimeout,
			MaxBytes:        play302MaxBytes,
			FollowRedirects: false,
		},
	})
	if err != nil {
		return "", false
	}
	if resp.StatusCode != http.StatusMovedPermanently &&
		resp.StatusCode != http.StatusFound &&
		resp.StatusCode != http.StatusTemporaryRedirect {
		return "", false
	}
	locs := resp.Header.Values("Location")
	if len(locs) != 1 {
		return "", false
	}
	loc := strings.TrimSpace(locs[0])
	if !AllowedMediaURL(loc) {
		return "", false
	}
	return loc, true
}

// parseTikTokURLExpiry extracts RFC3339 expires_at from either:
//  1. TikTok CDN hex path timestamp `/<32hex>/<8hex>/video/tos/...` when
//     now-86400 <= exp < now+7*86400; or
//  2. decimal `x-expires` query parameter in [1_500_000_000, now+365*86400).
//
// Timestamp recognition is decoupled from current validity so expired and
// near-expiry URLs retain expires_at for unified.SelectDefault and parseCache.
func parseTikTokURLExpiry(rawURL string, now int64) string {
	u, err := url.Parse(rawURL)
	if err != nil || u == nil {
		return ""
	}
	if exp, ok := parseHexPathExpiry(u.Path, now); ok {
		return time.Unix(exp, 0).UTC().Format(time.RFC3339)
	}
	if q := u.Query().Get("x-expires"); q != "" {
		if exp, parseErr := strconv.ParseInt(strings.TrimSpace(q), 10, 64); parseErr == nil &&
			exp >= 1_500_000_000 && exp < now+365*86400 {
			return time.Unix(exp, 0).UTC().Format(time.RFC3339)
		}
	}
	return ""
}

func parseHexPathExpiry(urlPath string, now int64) (int64, bool) {
	trimmed := strings.TrimPrefix(urlPath, "/")
	parts := strings.Split(trimmed, "/")
	// Expected shape: <32hex>/<8hex>/video/tos/...
	if len(parts) < 4 {
		return 0, false
	}
	if len(parts[0]) != 32 || !isLowerOrUpperHex(parts[0]) {
		return 0, false
	}
	if len(parts[1]) != 8 || !isLowerOrUpperHex(parts[1]) {
		return 0, false
	}
	if parts[2] != "video" || parts[3] != "tos" {
		return 0, false
	}
	exp, err := strconv.ParseInt(parts[1], 16, 64)
	if err != nil {
		return 0, false
	}
	if exp >= now-86400 && exp < now+7*86400 {
		return exp, true
	}
	return 0, false
}

func isLowerOrUpperHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return len(s) > 0
}
