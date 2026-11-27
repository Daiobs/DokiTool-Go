package urlpolicy

import (
	"net/url"
	"regexp"
	"strings"
)

var (
	pinterestPinPathPattern  = regexp.MustCompile(`^/pin/(?:[^/?#]*--)?(\d{5,25})(?:/|$)`)
	pinterestShortPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{3,32}$`)
	pinterestRegionalDomains = []string{
		"pinterest.com",
		"pinterest.co.uk",
		"pinterest.ca",
		"pinterest.jp",
		"pinterest.de",
		"pinterest.fr",
		"pinterest.es",
		"pinterest.it",
		"pinterest.com.au",
		"pinterest.com.mx",
	}
)

// IsPinterestDomain reports whether host is a known Pinterest regional apex or subdomain
// (excluding pin.it shortlink domain).
func IsPinterestDomain(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if h == "" {
		return false
	}
	for _, d := range pinterestRegionalDomains {
		if h == d || strings.HasSuffix(h, "."+d) {
			return true
		}
	}
	return false
}

// ExtractPinterestPinTarget validates a Pinterest Pin or pin.it shortlink URL
// syntactically (without network I/O) and returns:
//   - pinID: numeric Pin ID for long links (empty for pin.it shortlinks)
//   - canonicalURL: https://www.pinterest.com/pin/<pinID>/ for long links, or
//     https://pin.it/<code> for shortlinks
//   - isShortLink: true when raw is a pin.it shortlink
//   - ok: whether raw is a syntactically valid Pin or pin.it shortlink URL
func ExtractPinterestPinTarget(raw string) (pinID string, canonicalURL string, isShortLink bool, ok bool) {
	if raw == "" || len(raw) > 2048 {
		return "", "", false, false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' {
			return "", "", false, false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || strings.HasSuffix(u.Host, ":") {
		return "", "", false, false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", "", false, false
	}
	if port := u.Port(); port != "" {
		if !((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) {
			return "", "", false, false
		}
	}

	host := strings.ToLower(u.Hostname())
	if host == "pin.it" {
		trimmed := strings.Trim(u.EscapedPath(), "/")
		if trimmed == "" {
			return "", "", false, false
		}
		segs := strings.Split(trimmed, "/")
		if len(segs) == 0 || segs[0] == "" || !pinterestShortPattern.MatchString(segs[0]) {
			return "", "", false, false
		}
		return "", "https://pin.it/" + segs[0], true, true
	}

	if !IsPinterestDomain(host) {
		return "", "", false, false
	}
	m := pinterestPinPathPattern.FindStringSubmatch(u.EscapedPath())
	if m == nil {
		return "", "", false, false
	}
	pinID = m[1]
	return pinID, "https://www.pinterest.com/pin/" + pinID + "/", false, true
}
