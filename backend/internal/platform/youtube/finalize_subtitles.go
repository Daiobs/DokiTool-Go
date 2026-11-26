package youtube

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const (
	// MaxFinalizeCaptionTracksInspected caps raw captionTracks inspected per finalize request.
	MaxFinalizeCaptionTracksInspected = 64

	// MaxFinalizeSubtitleAttachments caps emitted subtitle attachments per finalize response.
	MaxFinalizeSubtitleAttachments = 32

	maxTimedtextURLLength            = 8192
	maxSubtitleLangCodeLen           = 32
	timedtextCanonicalPath           = "/api/timedtext"
	timedtextCanonicalHost           = "www.youtube.com"
	maxFinalizeSubtitleExpiresWindow = 30 * 24 * time.Hour
)

var (
	forbiddenTimedtextQueryKeys = map[string]bool{
		"cookie":        true,
		"cookies":       true,
		"authorization": true,
		"auth":          true,
		"authuser":      true,
		"sapisid":       true,
		"sid":           true,
		"hsid":          true,
		"ssid":          true,
		"apisid":        true,
		"lhid":          true,
		"access_token":  true,
		"id_token":      true,
		"session":       true,
		"session_token": true,
		"token":         true,
	}
)

// AllowYouTubeTimedtextURL validates that raw is strictly a public
// https://www.youtube.com/api/timedtext URL with no userinfo, fragment,
// non-default port, control/whitespace/backslash chars, or credential query keys.
func AllowYouTubeTimedtextURL(raw string) bool {
	if raw == "" || len(raw) > maxTimedtextURLLength {
		return false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' || r == '#' {
			return false
		}
	}
	if unified.MediaURL(raw) != raw {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Fragment != "" {
		return false
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return false
	}
	if strings.HasSuffix(u.Host, ":") {
		return false
	}
	if port := u.Port(); port != "" && port != "443" {
		return false
	}
	if !strings.EqualFold(u.Hostname(), timedtextCanonicalHost) {
		return false
	}
	if u.Path != timedtextCanonicalPath || u.EscapedPath() != timedtextCanonicalPath {
		return false
	}
	return !hasForbiddenTimedtextQueryParam(u.RawQuery)
}

func hasForbiddenTimedtextQueryParam(rawQuery string) bool {
	if rawQuery == "" {
		return false
	}
	for _, ampPart := range strings.Split(rawQuery, "&") {
		for _, part := range strings.Split(ampPart, ";") {
			if part == "" {
				continue
			}
			rawKey, _, _ := strings.Cut(part, "=")
			if forbiddenTimedtextQueryKeys[strings.ToLower(strings.TrimSpace(rawKey))] {
				return true
			}
			decodedKey, err := url.QueryUnescape(rawKey)
			if err != nil {
				return true
			}
			if forbiddenTimedtextQueryKeys[strings.ToLower(strings.TrimSpace(decodedKey))] {
				return true
			}
		}
	}
	return false
}

type rawFinalizeCaptions struct {
	PlayerCaptionsTracklistRenderer *struct {
		CaptionTracks []json.RawMessage `json:"captionTracks"`
	} `json:"playerCaptionsTracklistRenderer"`
	CaptionTracks []json.RawMessage `json:"captionTracks"`
}

type rawFinalizeCaptionTrack struct {
	BaseURL      string          `json:"baseUrl"`
	LanguageCode string          `json:"languageCode"`
	Kind         string          `json:"kind"`
	Name         json.RawMessage `json:"name"`
}

type rawCaptionTrackName struct {
	SimpleText string `json:"simpleText"`
	Runs       []struct {
		Text string `json:"text"`
	} `json:"runs"`
}

type finalizeSubtitleCandidate struct {
	language  string
	langLower string
	title     string
	trackKind string
	url       string
	ext       string
	mimeType  string
	rank      int
	expiresAt string
}

func extractCaptionTrackTitle(rawName json.RawMessage) string {
	trimmed := bytes.TrimSpace(rawName)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	if trimmed[0] == '"' {
		var plain string
		if err := json.Unmarshal(trimmed, &plain); err != nil {
			return ""
		}
		return sanitizeFinalizeText(plain, MaxFinalizeTitleRunes)
	}
	var obj rawCaptionTrackName
	if err := json.Unmarshal(trimmed, &obj); err != nil {
		return ""
	}
	if clean := sanitizeFinalizeText(obj.SimpleText, MaxFinalizeTitleRunes); clean != "" {
		return clean
	}
	if len(obj.Runs) == 0 {
		return ""
	}
	var b strings.Builder
	for _, run := range obj.Runs {
		b.WriteString(run.Text)
	}
	return sanitizeFinalizeText(b.String(), MaxFinalizeTitleRunes)
}

func sanitizeCaptionLanguageCode(raw string) string {
	cleaned := strings.TrimSpace(strings.ReplaceAll(raw, "_", "-"))
	if len(cleaned) == 0 || len(cleaned) > maxSubtitleLangCodeLen {
		return ""
	}
	if !bcp47TagPattern.MatchString(cleaned) {
		return ""
	}
	return cleaned
}

func hasNonEmptyCaptionQueryParam(rawQuery, key string) bool {
	if rawQuery == "" {
		return false
	}
	for _, part := range strings.Split(rawQuery, "&") {
		if part == "" {
			continue
		}
		rawK, rawV, hasVal := strings.Cut(part, "=")
		decodedK, err := url.QueryUnescape(rawK)
		if err != nil {
			decodedK = rawK
		}
		if !strings.EqualFold(strings.TrimSpace(decodedK), key) {
			continue
		}
		if !hasVal {
			continue
		}
		decodedV, err := url.QueryUnescape(rawV)
		if err != nil {
			decodedV = rawV
		}
		if strings.TrimSpace(decodedV) != "" {
			return true
		}
	}
	return false
}

func mapTimedtextFormatMetadata(rawFmt string) (ext, mimeType string, rank int, ok bool) {
	switch strings.ToLower(strings.TrimSpace(rawFmt)) {
	case "vtt":
		return "vtt", "text/vtt", 1, true
	case "srt":
		return "srt", "application/x-subrip", 2, true
	case "ttml":
		return "ttml", "application/ttml+xml", 3, true
	case "srv3":
		return "srv3", "application/xml", 4, true
	case "json3":
		return "json3", "application/json", 5, true
	case "srv2", "srv1", "xml":
		return "xml", "application/xml", 6, true
	default:
		return "", "", 0, false
	}
}

// extractFinalizeSubtitleExpiresAt parses Unix-second expire/expires query params and
// returns RFC3339 UTC only when strictly inside (now, now+30d]; returns "" otherwise.
func extractFinalizeSubtitleExpiresAt(rawURL string, now time.Time) string {
	if now.IsZero() {
		return ""
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.RawQuery == "" {
		return ""
	}
	maxExp := now.Add(maxFinalizeSubtitleExpiresWindow)
	var earliest time.Time
	for _, ampPart := range strings.Split(u.RawQuery, "&") {
		for _, part := range strings.Split(ampPart, ";") {
			if part == "" {
				continue
			}
			rawK, rawV, hasVal := strings.Cut(part, "=")
			if !hasVal {
				continue
			}
			decodedK, kErr := url.QueryUnescape(rawK)
			if kErr != nil {
				decodedK = rawK
			}
			keyLower := strings.ToLower(strings.TrimSpace(decodedK))
			if keyLower != "expire" && keyLower != "expires" {
				continue
			}
			val := rawV
			if decodedV, vErr := url.QueryUnescape(rawV); vErr == nil {
				val = decodedV
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

// ensureTimedtextFormatURL returns a validated timedtext URL without mutating any
// existing signed query parameter. It appends fmt=vtt only when fmt is absent AND
// fmt is not listed in sparams. Unknown explicit fmt values are rejected (ok=false).
func ensureTimedtextFormatURL(rawURL string) (finalURL, ext, mimeType string, rank int, ok bool) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", "", "", 0, false
	}
	var existingFmt string
	hasFmtParam := false
	fmtSigned := false
	for _, part := range strings.Split(u.RawQuery, "&") {
		if part == "" {
			continue
		}
		rawK, rawV, _ := strings.Cut(part, "=")
		decodedK, err := url.QueryUnescape(rawK)
		if err != nil {
			decodedK = rawK
		}
		keyLower := strings.ToLower(strings.TrimSpace(decodedK))
		switch keyLower {
		case "fmt":
			hasFmtParam = true
			if decodedV, err := url.QueryUnescape(rawV); err == nil {
				existingFmt = strings.TrimSpace(decodedV)
			} else {
				existingFmt = strings.TrimSpace(rawV)
			}
		case "sparams":
			decodedV, err := url.QueryUnescape(rawV)
			if err != nil {
				decodedV = rawV
			}
			for _, sp := range strings.Split(decodedV, ",") {
				if strings.EqualFold(strings.TrimSpace(sp), "fmt") {
					fmtSigned = true
					break
				}
			}
		}
	}
	if hasFmtParam {
		e, m, r, valid := mapTimedtextFormatMetadata(existingFmt)
		if !valid {
			return "", "", "", 0, false
		}
		return rawURL, e, m, r, true
	}
	if fmtSigned {
		return rawURL, "xml", "application/xml", 6, true
	}
	var candidate string
	switch {
	case u.RawQuery == "":
		candidate = rawURL + "?fmt=vtt"
	case strings.HasSuffix(rawURL, "&") || strings.HasSuffix(rawURL, "?"):
		candidate = rawURL + "fmt=vtt"
	default:
		candidate = rawURL + "&fmt=vtt"
	}
	if !AllowYouTubeTimedtextURL(candidate) {
		return rawURL, "xml", "application/xml", 6, true
	}
	return candidate, "vtt", "text/vtt", 1, true
}

func captionLanguagePriority(langLower string) int {
	switch langLower {
	case "zh-hans", "zh-cn", "zh-sg", "zh":
		return 0
	case "zh-hant", "zh-tw", "zh-hk":
		return 1
	case "en", "en-us", "en-gb", "en-orig":
		return 2
	case "ja", "ja-jp":
		return 3
	case "ko", "ko-kr":
		return 4
	}
	switch {
	case strings.HasPrefix(langLower, "zh-"):
		return 5
	case strings.HasPrefix(langLower, "en-"):
		return 6
	default:
		return 10
	}
}

func shortFinalizeDigest(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])[:24]
}

// extractFinalizeSubtitles parses optional client-submitted YouTube captionTracks
// into validated, rank-deduplicated, deterministically sorted Unified-v1 subtitle
// attachments. Invalid tracks are silently skipped without failing finalization.
func extractFinalizeSubtitles(rawCaptions json.RawMessage, videoID string, now time.Time) unified.Array {
	trimmed := bytes.TrimSpace(rawCaptions)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	var parsed rawFinalizeCaptions
	if err := json.Unmarshal(trimmed, &parsed); err != nil {
		return nil
	}
	var rawTracks []json.RawMessage
	if parsed.PlayerCaptionsTracklistRenderer != nil && len(parsed.PlayerCaptionsTracklistRenderer.CaptionTracks) > 0 {
		rawTracks = parsed.PlayerCaptionsTracklistRenderer.CaptionTracks
	} else if len(parsed.CaptionTracks) > 0 {
		rawTracks = parsed.CaptionTracks
	}
	if len(rawTracks) == 0 {
		return nil
	}
	if len(rawTracks) > MaxFinalizeCaptionTracksInspected {
		rawTracks = rawTracks[:MaxFinalizeCaptionTracksInspected]
	}

	candidates := make([]finalizeSubtitleCandidate, 0, len(rawTracks))
	bestByLangKind := make(map[string]int, len(rawTracks))

	for _, rawEntry := range rawTracks {
		var track rawFinalizeCaptionTrack
		if err := json.Unmarshal(rawEntry, &track); err != nil {
			continue
		}
		if !AllowYouTubeTimedtextURL(track.BaseURL) {
			continue
		}
		parsedURL, err := url.Parse(track.BaseURL)
		if err != nil {
			continue
		}
		if hasNonEmptyCaptionQueryParam(parsedURL.RawQuery, "tlang") {
			continue
		}
		lang := sanitizeCaptionLanguageCode(track.LanguageCode)
		if lang == "" {
			lang = sanitizeCaptionLanguageCode(parsedURL.Query().Get("lang"))
		}
		if lang == "" {
			continue
		}
		trackKind := "manual"
		if strings.EqualFold(strings.TrimSpace(track.Kind), "asr") ||
			strings.EqualFold(strings.TrimSpace(parsedURL.Query().Get("kind")), "asr") {
			trackKind = "auto"
		}
		finalURL, ext, mimeType, rank, ok := ensureTimedtextFormatURL(track.BaseURL)
		if !ok {
			continue
		}
		langLower := strings.ToLower(lang)
		dedupKey := langLower + "\x00" + trackKind
		if prevIdx, exists := bestByLangKind[dedupKey]; exists && rank >= candidates[prevIdx].rank {
			continue
		}

		title := extractCaptionTrackTitle(track.Name)
		if title == "" {
			title = lang
		}
		cand := finalizeSubtitleCandidate{
			language:  lang,
			langLower: langLower,
			title:     title,
			trackKind: trackKind,
			url:       finalURL,
			ext:       ext,
			mimeType:  mimeType,
			rank:      rank,
			expiresAt: extractFinalizeSubtitleExpiresAt(finalURL, now),
		}
		if prevIdx, exists := bestByLangKind[dedupKey]; exists {
			candidates[prevIdx] = cand
		} else {
			bestByLangKind[dedupKey] = len(candidates)
			candidates = append(candidates, cand)
		}
	}

	if len(candidates) == 0 {
		return nil
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.trackKind != b.trackKind {
			return a.trackKind == "manual"
		}
		pa, pb := captionLanguagePriority(a.langLower), captionLanguagePriority(b.langLower)
		if pa != pb {
			return pa < pb
		}
		if a.langLower != b.langLower {
			return a.langLower < b.langLower
		}
		return a.language < b.language
	})

	if len(candidates) > MaxFinalizeSubtitleAttachments {
		candidates = candidates[:MaxFinalizeSubtitleAttachments]
	}

	attachments := make(unified.Array, 0, len(candidates))
	for _, c := range candidates {
		attID := "sub-" + shortFinalizeDigest("youtube:sub:"+videoID+":"+c.langLower+":"+c.trackKind)
		srcID := "s-" + shortFinalizeDigest("youtube:sub-src:"+videoID+":"+c.langLower+":"+c.trackKind)
		src := unified.Object{
			"id":     srcID,
			"url":    c.url,
			"access": "direct",
		}
		if c.expiresAt != "" {
			src["expires_at"] = c.expiresAt
		}
		attachments = append(attachments, unified.Object{
			"id":         attID,
			"role":       "subtitle",
			"language":   c.language,
			"title":      c.title,
			"track_kind": c.trackKind,
			"resource": unified.Object{
				"id":   "res-" + attID,
				"role": "subtitle",
				"metadata": unified.Object{
					"container": c.ext,
					"extension": c.ext,
					"mime_type": c.mimeType,
					"evidence":  "upstream",
				},
				"delivery": unified.Object{
					"kind":    "file",
					"sources": unified.Array{src},
				},
			},
		})
	}
	return attachments
}
