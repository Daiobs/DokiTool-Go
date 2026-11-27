package urlpolicy

import (
	"net/url"
	"regexp"
	"strings"
)

var (
	tiktokUserItemPattern  = regexp.MustCompile(`^/@[^/?#]+/(?:video|photo)/([0-9]{5,25})$`)
	tiktokShareItemPattern = regexp.MustCompile(`^/share/(?:video|photo)/([0-9]{5,25})$`)
	tiktokEmbedItemPattern = regexp.MustCompile(`^/(?:embed/v2|player/v1)/([0-9]{5,25})$`)
	tiktokMobileVPattern   = regexp.MustCompile(`^/v/([0-9]{5,25})(?:\.html)?$`)
	tiktokShortCodePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{4,64}$`)
)

// IsTikTokDomain reports whether host is tiktok.com or any subdomain thereof.
func IsTikTokDomain(host string) bool {
	lower := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	return lower == "tiktok.com" || strings.HasSuffix(lower, ".tiktok.com")
}

// ExtractTikTokItemTarget validates a TikTok URL without network I/O and either:
//   - extracts a numeric item ID and normalizes all long-link forms (/video/, /photo/,
//     /share/, /embed/v2/, /player/v1/, m.tiktok.com/v/<id>.html) to
//     "https://www.tiktok.com/@i/video/<itemID>" (isShortLink=false), or
//   - recognizes a vm.tiktok.com/<code>, vt.tiktok.com/<code>, or (www.)tiktok.com/t/<code>
//     shortlink (itemID="", isShortLink=true).
func ExtractTikTokItemTarget(raw string) (itemID string, canonicalURL string, isShortLink bool, ok bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 4096 {
		return "", "", false, false
	}
	for _, r := range trimmed {
		if r <= 0x20 || r == 0x7f || r == '\\' {
			return "", "", false, false
		}
	}
	u, err := url.Parse(trimmed)
	if err != nil || u == nil || u.Opaque != "" || u.User != nil {
		return "", "", false, false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", "", false, false
	}
	if port := u.Port(); port != "" {
		if (scheme == "https" && port != "443") || (scheme == "http" && port != "80") {
			return "", "", false, false
		}
	}
	if strings.HasSuffix(u.Host, ":") {
		return "", "", false, false
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if !IsTikTokDomain(host) {
		return "", "", false, false
	}

	cleanPath := strings.TrimRight(u.EscapedPath(), "/")
	if cleanPath == "" {
		return "", "", false, false
	}

	// Shortlinks: vm.tiktok.com/<code>, vt.tiktok.com/<code>
	if host == "vm.tiktok.com" || host == "vt.tiktok.com" {
		seg := strings.TrimPrefix(cleanPath, "/")
		if seg != "" && !strings.Contains(seg, "/") && tiktokShortCodePattern.MatchString(seg) {
			return "", "https://" + host + "/" + seg + "/", true, true
		}
		return "", "", false, false
	}

	// Shortlink: tiktok.com/t/<code> or www.tiktok.com/t/<code> or m.tiktok.com/t/<code>
	if strings.HasPrefix(cleanPath, "/t/") {
		seg := strings.TrimPrefix(cleanPath, "/t/")
		if seg != "" && !strings.Contains(seg, "/") && tiktokShortCodePattern.MatchString(seg) {
			return "", "https://www.tiktok.com/t/" + seg + "/", true, true
		}
		return "", "", false, false
	}

	if m := tiktokUserItemPattern.FindStringSubmatch(cleanPath); len(m) == 2 {
		return m[1], "https://www.tiktok.com/@i/video/" + m[1], false, true
	}
	if m := tiktokShareItemPattern.FindStringSubmatch(cleanPath); len(m) == 2 {
		return m[1], "https://www.tiktok.com/@i/video/" + m[1], false, true
	}
	if m := tiktokEmbedItemPattern.FindStringSubmatch(cleanPath); len(m) == 2 {
		return m[1], "https://www.tiktok.com/@i/video/" + m[1], false, true
	}
	if m := tiktokMobileVPattern.FindStringSubmatch(cleanPath); len(m) == 2 {
		return m[1], "https://www.tiktok.com/@i/video/" + m[1], false, true
	}

	return "", "", false, false
}

// ExtractTikTokShortCode returns a stable normalized shortlink key (e.g. "vm:ZM8abc123",
// "vt:ZS9xyz", "t:ZT8def") when raw is a supported TikTok shortlink.
func ExtractTikTokShortCode(raw string) (string, bool) {
	_, canonical, isShort, ok := ExtractTikTokItemTarget(raw)
	if !ok || !isShort {
		return "", false
	}
	u, err := url.Parse(canonical)
	if err != nil {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	cleanPath := strings.Trim(u.EscapedPath(), "/")
	switch host {
	case "vm.tiktok.com":
		return "vm:" + cleanPath, true
	case "vt.tiktok.com":
		return "vt:" + cleanPath, true
	default:
		if strings.HasPrefix(cleanPath, "t/") {
			return "t:" + strings.TrimPrefix(cleanPath, "t/"), true
		}
	}
	return "", false
}
