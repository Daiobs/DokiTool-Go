package urlpolicy

import (
	"net/url"
	"regexp"
	"strings"
)

var instagramShortcodePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{5,32}$`)

func isInstagramPostKind(seg string) bool {
	switch strings.ToLower(seg) {
	case "p", "reel", "reels", "tv":
		return true
	default:
		return false
	}
}

func normalizeInstagramKind(seg string) string {
	switch strings.ToLower(seg) {
	case "reel", "reels":
		return "reel"
	case "tv":
		return "tv"
	default:
		return "p"
	}
}

func splitNonEmptyInstagramPath(escapedPath string) []string {
	trimmed := strings.Trim(escapedPath, "/")
	if trimmed == "" {
		return nil
	}
	parts := strings.Split(trimmed, "/")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			return nil
		}
		out = append(out, p)
	}
	return out
}

// ExtractInstagramPostTarget validates an Instagram Post/Reel/TV URL syntactically
// (without network I/O or runtime state) and returns:
//   - shortcode: the post/reel/tv shortcode
//   - canonicalURL: the canonical https://www.instagram.com/{kind}/{shortcode}/ URL
//   - ok: whether raw is a valid Instagram post/reel/tv URL
func ExtractInstagramPostTarget(raw string) (string, string, bool) {
	if raw == "" || len(raw) > 2048 {
		return "", "", false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' {
			return "", "", false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || strings.HasSuffix(u.Host, ":") {
		return "", "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", "", false
	}
	if port := u.Port(); port != "" {
		if !((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) {
			return "", "", false
		}
	}

	host := strings.ToLower(u.Hostname())
	isShortDomain := false
	switch host {
	case "instagram.com", "www.instagram.com", "m.instagram.com":
	case "instagr.am", "www.instagr.am":
		isShortDomain = true
	default:
		return "", "", false
	}

	segments := splitNonEmptyInstagramPath(u.EscapedPath())
	var kind, shortcode string

	if isShortDomain {
		if len(segments) != 2 || !isInstagramPostKind(segments[0]) {
			return "", "", false
		}
		kind = normalizeInstagramKind(segments[0])
		shortcode = segments[1]
	} else {
		switch {
		case len(segments) >= 2 && isInstagramPostKind(segments[0]):
			kind = normalizeInstagramKind(segments[0])
			shortcode = segments[1]
		case len(segments) >= 3 && isInstagramPostKind(segments[1]):
			kind = normalizeInstagramKind(segments[1])
			shortcode = segments[2]
		default:
			return "", "", false
		}
	}

	if !instagramShortcodePattern.MatchString(shortcode) {
		return "", "", false
	}
	canonicalURL := "https://www.instagram.com/" + kind + "/" + shortcode + "/"
	return shortcode, canonicalURL, true
}
