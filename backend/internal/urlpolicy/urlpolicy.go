// Package urlpolicy provides pure-syntax URL scheme, port, unsafe-character,
// and host-suffix validation helpers shared across platform allowlists.
package urlpolicy

import (
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// Standard scheme slices for URL allowlists.
var (
	HTTPAndHTTPS = []string{"http", "https"}
	HTTPSOnly    = []string{"https"}
)

// HasUnsafeChars reports whether raw contains ASCII control bytes (<= 0x20 or
// 0x7f), spaces, or backslashes.
func HasUnsafeChars(raw string) bool {
	for _, r := range raw {
		if r <= 0x20 || r == 0x7f || r == '\\' {
			return true
		}
	}
	return false
}

func allowsScheme(scheme string, schemes []string) bool {
	if scheme != "http" && scheme != "https" {
		return false
	}
	for _, s := range schemes {
		if scheme == s {
			return true
		}
	}
	return false
}

// ParseStandardURL parses raw as an HTTP/HTTPS URL without userinfo or opaque
// data whose lowercased scheme is listed in schemes and whose port is empty or
// numerically equal to the scheme's default port (80 for http, 443 for https).
func ParseStandardURL(raw string, schemes []string) (*url.URL, bool) {
	if len(schemes) == 0 {
		return nil, false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" {
		return nil, false
	}
	scheme := strings.ToLower(u.Scheme)
	if !allowsScheme(scheme, schemes) {
		return nil, false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || (scheme == "https" && n != 443) || (scheme == "http" && n != 80) {
			return nil, false
		}
	}
	return u, true
}

// ParseCanonicalURL parses raw as an HTTP/HTTPS URL without userinfo or opaque
// data whose lowercased scheme is listed in schemes and whose port is empty or
// the canonical decimal default port ("80" for http, "443" for https).
func ParseCanonicalURL(raw string, schemes []string) (*url.URL, bool) {
	if len(schemes) == 0 {
		return nil, false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" {
		return nil, false
	}
	scheme := strings.ToLower(u.Scheme)
	if !allowsScheme(scheme, schemes) {
		return nil, false
	}
	if port := u.Port(); port != "" {
		if !((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) {
			return nil, false
		}
	}
	return u, true
}

// HostSuffixURL reports whether raw passes ParseStandardURL(raw, schemes) and
// its lowercased hostname is a strict subdomain of at least one suffix in
// suffixes (each normalized to have a leading dot, e.g. ".googlevideo.com").
func HostSuffixURL(raw string, schemes []string, suffixes ...string) bool {
	if len(suffixes) == 0 {
		return false
	}
	u, ok := ParseStandardURL(raw, schemes)
	if !ok {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, suffix := range suffixes {
		s := strings.ToLower(strings.TrimSpace(suffix))
		if s == "" || s == "." {
			continue
		}
		if !strings.HasPrefix(s, ".") {
			s = "." + s
		}
		if strings.HasSuffix(host, s) && len(host) > len(s) {
			return true
		}
	}
	return false
}

// MatchHostRule matches host against rule after trimming whitespace, stripping
// a single trailing DNS dot, and lowercasing. A leading-dot rule (".fbcdn.net")
// matches strict subdomains only; a bare rule ("vimeo.com") matches exact host.
func MatchHostRule(host, rule string) bool {
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

// StrictHostRuleURL validates raw syntactically (non-empty, length <= maxLen
// when maxLen > 0, no unsafe chars, ParseCanonicalURL, no trailing ':' on Host,
// non-IP hostname) and matches its hostname against rules via MatchHostRule.
func StrictHostRuleURL(raw string, schemes []string, maxLen int, rules ...string) bool {
	if len(rules) == 0 || len(raw) == 0 || (maxLen > 0 && len(raw) > maxLen) {
		return false
	}
	if HasUnsafeChars(raw) {
		return false
	}
	u, ok := ParseCanonicalURL(raw, schemes)
	if !ok || strings.HasSuffix(u.Host, ":") {
		return false
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
	for _, rule := range rules {
		if MatchHostRule(host, rule) {
			return true
		}
	}
	return false
}
