package ytengine

import (
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/urlpolicy"
)

const (
	// MaxSubtitleAttachments caps emitted subtitle attachments per adapted envelope.
	MaxSubtitleAttachments = 32

	maxSubtitleURLLength     = 8192
	maxSubtitleLangCodeLen   = 32
	maxSubtitleTitleRunes    = 200
	maxSubtitleExpiresWindow = 30 * 24 * time.Hour
)

type subtitleFormatSpec struct {
	rank      int
	container string
	ext       string
	mimeType  string
}

var (
	subtitleBCP47Pattern    = regexp.MustCompile(`^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$`)
	subtitleDNSLabelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	subtitlePublicTLDRe     = regexp.MustCompile(`^(?:[a-z]{2,}|xn--[a-z0-9-]{2,})$`)

	subtitleFormatSpecs = map[string]subtitleFormatSpec{
		"vtt":   {rank: 1, container: "vtt", ext: "vtt", mimeType: "text/vtt"},
		"srt":   {rank: 2, container: "srt", ext: "srt", mimeType: "application/x-subrip"},
		"ttml":  {rank: 3, container: "ttml", ext: "ttml", mimeType: "application/ttml+xml"},
		"srv3":  {rank: 4, container: "srv3", ext: "srv3", mimeType: "application/xml"},
		"json3": {rank: 5, container: "json3", ext: "json3", mimeType: "application/json"},
	}

	blockedSubtitleHostSuffixes = []string{
		"localhost", "local", "internal", "localdomain", "home.arpa",
		"invalid", "lan", "corp", "intranet", "private", "dokitool.com",
	}

	forbiddenYouTubeSubQueryKeys = map[string]bool{
		"cookie": true, "cookies": true, "authorization": true, "auth": true, "authuser": true,
		"sapisid": true, "sid": true, "hsid": true, "ssid": true, "apisid": true, "lhid": true,
		"access_token": true, "id_token": true, "session": true, "session_token": true, "token": true,
	}

	subtitleLangPriorityMap = map[string]int{
		"zh-hans": 0, "zh-cn": 0, "zh-sg": 0, "zh": 0, "zh-hant": 1, "zh-tw": 1, "zh-hk": 1,
		"en": 2, "en-us": 2, "en-gb": 2, "en-orig": 2, "ja": 3, "ja-jp": 3, "ko": 4, "ko-kr": 4,
	}
)

// AllowPublicSubtitleURL validates that raw is strictly a public https:// URL
// without userinfo, fragment, control/whitespace/backslash chars, non-default
// port, localhost/local suffixes, or IP literals. For youtube.com URLs it
// additionally enforces https://www.youtube.com/api/timedtext and rejects
// credential/cookie/auth-like query parameters.
func AllowPublicSubtitleURL(raw string) bool {
	if raw == "" || len(raw) > maxSubtitleURLLength || strings.Contains(raw, "#") || urlpolicy.HasUnsafeChars(raw) {
		return false
	}
	for _, r := range raw {
		if r >= 0x7f {
			return false
		}
	}
	if unified.MediaURL(raw) != raw {
		return false
	}
	u, ok := urlpolicy.ParseCanonicalURL(raw, urlpolicy.HTTPSOnly)
	if !ok || u.Fragment != "" || strings.HasSuffix(u.Host, ":") {
		return false
	}
	rawHost := strings.TrimSpace(u.Hostname())
	if !isPublicSubtitleHost(rawHost) {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(rawHost, "."))
	if host == "youtube.com" || strings.HasSuffix(host, ".youtube.com") ||
		host == "youtu.be" || strings.HasSuffix(host, ".youtu.be") {
		if !strings.EqualFold(rawHost, "www.youtube.com") ||
			u.Path != "/api/timedtext" || u.EscapedPath() != "/api/timedtext" ||
			hasForbiddenYouTubeSubQueryParam(u.RawQuery) {
			return false
		}
	}
	return true
}

func isPublicSubtitleHost(rawHost string) bool {
	if rawHost == "" || len(rawHost) > 253 {
		return false
	}
	if _, err := netip.ParseAddr(rawHost); err == nil {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(rawHost, "."))
	if host == "" || len(host) > 253 || net.ParseIP(host) != nil {
		return false
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return false
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 || !subtitlePublicTLDRe.MatchString(labels[len(labels)-1]) {
		return false
	}
	for _, label := range labels {
		if !subtitleDNSLabelPattern.MatchString(label) {
			return false
		}
	}
	for _, blocked := range blockedSubtitleHostSuffixes {
		if host == blocked || strings.HasSuffix(host, "."+blocked) {
			return false
		}
	}
	return true
}

func forEachSubtitleQueryParam(rawQuery string, fn func(rawKey, decodedKey, rawVal string, err error) bool) {
	for _, ampPart := range strings.Split(rawQuery, "&") {
		for _, part := range strings.Split(ampPart, ";") {
			if part == "" {
				continue
			}
			rawKey, rawVal, _ := strings.Cut(part, "=")
			decodedKey, err := url.QueryUnescape(rawKey)
			if !fn(rawKey, decodedKey, rawVal, err) {
				return
			}
		}
	}
}

func hasForbiddenYouTubeSubQueryParam(rawQuery string) bool {
	forbidden := false
	forEachSubtitleQueryParam(rawQuery, func(rawKey, decodedKey, _ string, err error) bool {
		if err != nil ||
			forbiddenYouTubeSubQueryKeys[strings.ToLower(strings.TrimSpace(rawKey))] ||
			forbiddenYouTubeSubQueryKeys[strings.ToLower(strings.TrimSpace(decodedKey))] {
			forbidden = true
			return false
		}
		return true
	})
	return forbidden
}

func hasNonEmptySubtitleQueryParam(rawURL, key string) bool {
	u, err := url.Parse(rawURL)
	if err != nil || u.RawQuery == "" {
		return false
	}
	found := false
	forEachSubtitleQueryParam(u.RawQuery, func(rawKey, decodedKey, rawVal string, err error) bool {
		k := decodedKey
		if err != nil {
			k = rawKey
		}
		if !strings.EqualFold(strings.TrimSpace(k), key) {
			return true
		}
		if decodedV, vErr := url.QueryUnescape(rawVal); vErr == nil {
			rawVal = decodedV
		}
		if strings.TrimSpace(rawVal) != "" {
			found = true
			return false
		}
		return true
	})
	return found
}

func hasCredentialSubtitleHeaders(headers map[string]string) bool {
	for k, v := range headers {
		if strings.TrimSpace(v) == "" {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "cookie", "authorization", "proxy-authorization":
			return true
		}
	}
	return false
}

func sanitizeSubtitleLanguageCode(raw string) string {
	cleaned := strings.TrimSpace(strings.ReplaceAll(raw, "_", "-"))
	if len(cleaned) == 0 || len(cleaned) > maxSubtitleLangCodeLen || !subtitleBCP47Pattern.MatchString(cleaned) {
		return ""
	}
	return cleaned
}

func sanitizeSubtitleTitle(raw string) string {
	var b strings.Builder
	b.Grow(len(raw))
	for _, r := range raw {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		b.WriteRune(r)
	}
	trimmed := strings.TrimSpace(b.String())
	if runes := []rune(trimmed); len(runes) > maxSubtitleTitleRunes {
		return strings.TrimSpace(string(runes[:maxSubtitleTitleRunes]))
	}
	return trimmed
}

func subtitleLanguagePriority(langLower string) int {
	if p, ok := subtitleLangPriorityMap[langLower]; ok {
		return p
	}
	if strings.HasPrefix(langLower, "zh-") {
		return 5
	}
	if strings.HasPrefix(langLower, "en-") {
		return 6
	}
	return 10
}

type subtitleCandidate struct {
	language  string
	langLower string
	title     string
	trackKind string
	url       string
	spec      subtitleFormatSpec
}

func collectSubtitleCandidatesFromMap(
	rawMap map[string][]SubtitleTrack,
	trackKind string,
	allowedMediaURL func(string) bool,
	seenLangKind map[string]bool,
	seenKindURL map[string]bool,
) []subtitleCandidate {
	if len(rawMap) == 0 {
		return nil
	}
	keys := make([]string, 0, len(rawMap))
	for k := range rawMap {
		keys = append(keys, k)
	}
	// Prefer non-"-orig" tags before "-orig" siblings so identical URLs collapse onto the cleaner tag.
	sort.Slice(keys, func(i, j int) bool {
		li, lj := strings.ToLower(keys[i]), strings.ToLower(keys[j])
		oi, oj := strings.HasSuffix(li, "-orig"), strings.HasSuffix(lj, "-orig")
		if oi != oj {
			return !oi
		}
		if li != lj {
			return li < lj
		}
		return keys[i] < keys[j]
	})

	out := make([]subtitleCandidate, 0, len(keys))
	for _, rawLang := range keys {
		lang := sanitizeSubtitleLanguageCode(rawLang)
		if lang == "" {
			continue
		}
		langLower := strings.ToLower(lang)
		dedupKey := langLower + "\x00" + trackKind
		if seenLangKind[dedupKey] {
			continue
		}

		var best *subtitleCandidate
		for _, track := range rawMap[rawLang] {
			spec, ok := subtitleFormatSpecs[strings.ToLower(strings.TrimSpace(track.Ext))]
			if !ok {
				continue
			}
			if proto := strings.ToLower(strings.TrimSpace(track.Protocol)); proto != "" && proto != "https" {
				continue
			}
			if hasCredentialSubtitleHeaders(track.HTTPHeaders) ||
				!AllowPublicSubtitleURL(track.URL) ||
				(allowedMediaURL != nil && !allowedMediaURL(track.URL)) ||
				hasNonEmptySubtitleQueryParam(track.URL, "tlang") {
				continue
			}
			if best == nil || spec.rank < best.spec.rank {
				title := sanitizeSubtitleTitle(track.Name)
				if title == "" {
					title = lang
				}
				best = &subtitleCandidate{
					language: lang, langLower: langLower, title: title,
					trackKind: trackKind, url: track.URL, spec: spec,
				}
			}
		}
		if best == nil {
			continue
		}
		urlKey := trackKind + "\x00" + best.url
		if seenKindURL[urlKey] {
			continue
		}
		seenLangKind[dedupKey] = true
		seenKindURL[urlKey] = true
		out = append(out, *best)
	}
	return out
}

func buildSubtitleAttachments(entry, parent *Info, opts AdaptOptions, now time.Time) unified.Array {
	var manualMap, autoMap map[string][]SubtitleTrack
	if entry != nil {
		manualMap, autoMap = entry.Subtitles, entry.AutomaticCaptions
	}
	if len(manualMap) == 0 && len(autoMap) == 0 && parent != nil && parent != entry {
		manualMap, autoMap = parent.Subtitles, parent.AutomaticCaptions
	}
	if len(manualMap) == 0 && len(autoMap) == 0 {
		return nil
	}

	seenLangKind, seenKindURL := make(map[string]bool), make(map[string]bool)
	candidates := make([]subtitleCandidate, 0, len(manualMap)+len(autoMap))
	candidates = append(candidates, collectSubtitleCandidatesFromMap(manualMap, "manual", opts.AllowedMediaURL, seenLangKind, seenKindURL)...)
	candidates = append(candidates, collectSubtitleCandidatesFromMap(autoMap, "auto", opts.AllowedMediaURL, seenLangKind, seenKindURL)...)
	if len(candidates) == 0 {
		return nil
	}

	// Sort candidates deterministically: manual before auto, then preferred/lexicographic language.
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.trackKind != b.trackKind {
			return a.trackKind == "manual"
		}
		if pa, pb := subtitleLanguagePriority(a.langLower), subtitleLanguagePriority(b.langLower); pa != pb {
			return pa < pb
		}
		if a.langLower != b.langLower {
			return a.langLower < b.langLower
		}
		return a.language < b.language
	})
	if len(candidates) > MaxSubtitleAttachments {
		candidates = candidates[:MaxSubtitleAttachments]
	}

	attachments := make(unified.Array, 0, len(candidates))
	for _, c := range candidates {
		attID := "sub-" + shortDigest(opts.PlatformID+":sub:"+opts.ContentID+":"+c.langLower+":"+c.trackKind)
		srcID := "s-" + shortDigest(opts.PlatformID+":sub-src:"+opts.ContentID+":"+c.langLower+":"+c.trackKind)
		meta := unified.Object{"container": c.spec.container, "extension": c.spec.ext, "mime_type": c.spec.mimeType, "evidence": "upstream"}
		src := unified.Object{"id": srcID, "url": c.url, "access": "direct"}
		if exp := urlpolicy.ExtractSubtitleExpiresAt(c.url, now, maxSubtitleExpiresWindow); exp != "" {
			src["expires_at"] = exp
		}
		res := unified.Object{"id": "res-" + attID, "role": "subtitle", "metadata": meta, "delivery": unified.Object{"kind": "file", "sources": unified.Array{src}}}
		attachments = append(attachments, unified.Object{"id": attID, "role": "subtitle", "language": c.language, "title": c.title, "track_kind": c.trackKind, "resource": res})
	}
	return attachments
}
