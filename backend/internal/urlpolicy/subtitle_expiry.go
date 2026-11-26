package urlpolicy

import (
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ExtractSubtitleExpiresAt parses Unix-second "expire" / "expires" query
// parameters from rawURL (splitting on both '&' and ';') and returns the
// earliest valid timestamp strictly inside (now, now+maxWindow] formatted as
// UTC RFC3339. It returns "" when now is zero, maxWindow <= 0, rawURL cannot be
// parsed or has no query string, or no matching parameter falls in the window.
func ExtractSubtitleExpiresAt(rawURL string, now time.Time, maxWindow time.Duration) string {
	if now.IsZero() || maxWindow <= 0 {
		return ""
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.RawQuery == "" {
		return ""
	}
	maxExp := now.Add(maxWindow)
	var earliest time.Time
	for _, ampPart := range strings.Split(u.RawQuery, "&") {
		for _, part := range strings.Split(ampPart, ";") {
			if part == "" {
				continue
			}
			rawKey, rawVal, hasVal := strings.Cut(part, "=")
			if !hasVal {
				continue
			}
			key := rawKey
			if decodedKey, kErr := url.QueryUnescape(rawKey); kErr == nil {
				key = decodedKey
			}
			keyLower := strings.ToLower(strings.TrimSpace(key))
			if keyLower != "expire" && keyLower != "expires" {
				continue
			}
			val := rawVal
			if decodedVal, vErr := url.QueryUnescape(rawVal); vErr == nil {
				val = decodedVal
			}
			sec, parseErr := strconv.ParseInt(strings.TrimSpace(val), 10, 64)
			if parseErr != nil || sec <= 0 {
				continue
			}
			expTime := time.Unix(sec, 0).UTC()
			if !expTime.After(now) || expTime.After(maxExp) {
				continue
			}
			if earliest.IsZero() || expTime.Before(earliest) {
				earliest = expTime
			}
		}
	}
	if earliest.IsZero() {
		return ""
	}
	return earliest.Format(time.RFC3339)
}
