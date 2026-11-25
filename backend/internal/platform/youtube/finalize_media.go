package youtube

import (
	"net/url"
	"strconv"
	"strings"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func isAudioOnlyMimeType(raw string) bool {
	semi := strings.SplitN(raw, ";", 2)
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(semi[0])), "audio/")
}

func isDescriptiveAudioTrack(at *finalizeAudioTrack) bool {
	if at == nil {
		return false
	}
	combined := strings.ToLower(at.ID + " " + at.DisplayName)
	return strings.Contains(combined, "descriptive") || strings.Contains(combined, "description")
}

func isDubbedAudioTrack(at *finalizeAudioTrack) bool {
	if at == nil {
		return false
	}
	combined := strings.ToLower(at.ID + " " + at.DisplayName)
	return strings.Contains(combined, "dubbed") || strings.Contains(combined, "配音")
}

func isOriginalAudioTrack(at *finalizeAudioTrack) bool {
	if at == nil {
		return false
	}
	combined := strings.ToLower(at.ID + " " + at.DisplayName)
	return strings.Contains(combined, "original") || strings.Contains(combined, "原声") || strings.Contains(combined, "原音")
}

type xtagsAudioHints struct {
	lang          string
	isOriginal    bool
	isDescriptive bool
	isDubbed      bool
}

type audioStreamClassification struct {
	hints         xtagsAudioHints
	hasHint       bool
	isOriginal    bool
	isDescriptive bool
	isDubbed      bool
	isDefault     bool
	hasDefault    bool
}

func classifyAudioStream(at *finalizeAudioTrack, rawURL string) audioStreamClassification {
	hints := parseXtagsAudioHints(rawURL)
	isDesc := hints.isDescriptive || isDescriptiveAudioTrack(at)
	isDub := hints.isDubbed || isDubbedAudioTrack(at)
	isOrig := hints.isOriginal || isOriginalAudioTrack(at)
	hasDef := at != nil && at.AudioIsDefault != nil
	isDef := hasDef && *at.AudioIsDefault
	hasHint := at != nil || hints.isOriginal || hints.isDescriptive || hints.isDubbed
	return audioStreamClassification{
		hints:         hints,
		hasHint:       hasHint,
		isOriginal:    isOrig,
		isDescriptive: isDesc,
		isDubbed:      isDub,
		isDefault:     isDef,
		hasDefault:    hasDef,
	}
}

func filterMultiAudioStreamEntries(entries []parsedStreamEntry) []parsedStreamEntry {
	hasAnyHint := false
	hasOriginalClean := false
	hasDefaultClean := false
	hasDefaultNonDescriptive := false
	hasAnyDefault := false
	for _, e := range entries {
		if !isAudioOnlyMimeType(e.input.MimeType) {
			continue
		}
		c := classifyAudioStream(e.input.AudioTrack, e.baseURL)
		if !c.hasHint {
			continue
		}
		hasAnyHint = true
		if c.isOriginal && !c.isDescriptive && !c.isDubbed {
			hasOriginalClean = true
		}
		if c.isDefault {
			hasAnyDefault = true
			if !c.isDescriptive {
				hasDefaultNonDescriptive = true
				if !c.isDubbed {
					hasDefaultClean = true
				}
			}
		}
	}
	if !hasAnyHint || (!hasOriginalClean && !hasDefaultClean && !hasDefaultNonDescriptive && !hasAnyDefault) {
		return entries
	}
	filtered := make([]parsedStreamEntry, 0, len(entries))
	for _, e := range entries {
		if !isAudioOnlyMimeType(e.input.MimeType) {
			filtered = append(filtered, e)
			continue
		}
		c := classifyAudioStream(e.input.AudioTrack, e.baseURL)
		switch {
		case hasOriginalClean:
			if c.isOriginal && !c.isDescriptive && !c.isDubbed {
				filtered = append(filtered, e)
			}
		case hasDefaultClean:
			if c.isDefault && !c.isDescriptive && !c.isDubbed {
				filtered = append(filtered, e)
			}
		case hasDefaultNonDescriptive:
			if c.isDefault && !c.isDescriptive {
				filtered = append(filtered, e)
			}
		case hasAnyDefault:
			if c.isDefault {
				filtered = append(filtered, e)
			}
		}
	}
	return filtered
}

func extractBaseBCP47Language(rawID string) string {
	base, _, _ := strings.Cut(strings.TrimSpace(rawID), ".")
	if bcp47TagPattern.MatchString(base) {
		return base
	}
	return ""
}

func parseXtagsAudioHints(rawURL string) xtagsAudioHints {
	var hints xtagsAudioHints
	u, err := url.Parse(rawURL)
	if err != nil || u.RawQuery == "" {
		return hints
	}
	xtags := strings.TrimSpace(u.Query().Get("xtags"))
	if xtags == "" {
		return hints
	}
	for _, kv := range strings.Split(xtags, ":") {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "lang":
			if candidate := extractBaseBCP47Language(v); candidate != "" {
				hints.lang = candidate
			}
		case "acont":
			hints.isOriginal = false
			hints.isDescriptive = false
			hints.isDubbed = false
			switch strings.ToLower(strings.TrimSpace(v)) {
			case "original":
				hints.isOriginal = true
			case "descriptive":
				hints.isDescriptive = true
			case "dubbed", "dubbed-auto", "secondary":
				hints.isDubbed = true
			}
		}
	}
	return hints
}

func convertToYTFormat(in finalizeFormatInput, formatID, resolvedURL string) (ytengine.Format, bool) {
	ext, vcodec, acodec, hdr, ok := parseYouTubeMimeType(in.MimeType)
	if !ok {
		return ytengine.Format{}, false
	}
	if formatID == "" {
		formatID = strconv.Itoa(in.Itag)
	}
	f := ytengine.Format{
		FormatID:     formatID,
		URL:          resolvedURL,
		Ext:          ext,
		Protocol:     "https",
		VCodec:       vcodec,
		ACodec:       acodec,
		DynamicRange: hdr,
		FormatNote:   in.AudioQuality,
	}
	if vcodec == "none" && acodec != "none" {
		c := classifyAudioStream(in.AudioTrack, resolvedURL)
		if in.AudioTrack != nil {
			if lang := extractBaseBCP47Language(in.AudioTrack.ID); lang != "" {
				f.Language = lang
			}
		}
		if f.Language == "" && c.hints.lang != "" {
			f.Language = c.hints.lang
		}
		switch {
		case c.isOriginal && !c.isDescriptive && !c.isDubbed:
			p := 20
			f.LanguagePreference = &p
		case c.isDefault && !c.isDescriptive && !c.isDubbed:
			p := 10
			f.LanguagePreference = &p
		case c.isDescriptive:
			p := -20
			f.LanguagePreference = &p
		case c.isDubbed || (c.hasDefault && !c.isDefault):
			p := -10
			f.LanguagePreference = &p
		}
	}
	if in.Width != nil && *in.Width > 0 {
		w := *in.Width
		f.Width = &w
	}
	if in.Height != nil && *in.Height > 0 {
		h := *in.Height
		f.Height = &h
	}
	if in.FPS != nil && *in.FPS > 0 {
		fps := *in.FPS
		f.FPS = &fps
	}
	if in.Bitrate != nil && *in.Bitrate > 0 {
		kbps := float64(*in.Bitrate) / 1000.0
		f.TBR = &kbps
		if vcodec != "none" && acodec == "none" {
			vbr := kbps
			f.VBR = &vbr
		} else if vcodec == "none" && acodec != "none" {
			abr := kbps
			f.ABR = &abr
		}
	}
	if in.ContentLength != "" {
		if cl, err := strconv.ParseInt(in.ContentLength, 10, 64); err == nil && cl > 0 {
			f.Filesize = &cl
		}
	}
	if in.AudioSampleRate != "" {
		if asr, err := strconv.ParseInt(in.AudioSampleRate, 10, 64); err == nil && asr > 0 {
			f.ASR = &asr
		}
	}
	if in.AudioChannels != nil && *in.AudioChannels > 0 {
		ch := *in.AudioChannels
		f.AudioChannels = &ch
	}
	return f, true
}

func parseYouTubeMimeType(raw string) (ext, vcodec, acodec, dynamicRange string, ok bool) {
	semi := strings.SplitN(raw, ";", 2)
	mediaType := strings.ToLower(strings.TrimSpace(semi[0]))
	isVideo := false
	isAudioOnly := false
	switch mediaType {
	case "video/mp4":
		ext = "mp4"
		isVideo = true
	case "video/webm":
		ext = "webm"
		isVideo = true
	case "video/3gpp":
		ext = "3gp"
		isVideo = true
	case "audio/mp4":
		ext = "m4a"
		isAudioOnly = true
	case "audio/webm":
		ext = "webm"
		isAudioOnly = true
	default:
		return "", "", "", "", false
	}

	var codecs []string
	if len(semi) == 2 {
		rest := strings.TrimSpace(semi[1])
		if idx := strings.Index(strings.ToLower(rest), "codecs="); idx >= 0 {
			val := strings.TrimSpace(rest[idx+len("codecs="):])
			val = strings.Trim(val, `"'`)
			for _, part := range strings.Split(val, ",") {
				c := strings.TrimSpace(part)
				if c != "" {
					codecs = append(codecs, c)
				}
			}
		}
	}
	if len(codecs) == 0 {
		return "", "", "", "", false
	}

	if isAudioOnly {
		return ext, "none", codecs[0], "", true
	}
	if isVideo {
		vcodec = codecs[0]
		if len(codecs) >= 2 {
			acodec = codecs[1]
		} else {
			acodec = "none"
		}
		vcLower := strings.ToLower(vcodec)
		switch {
		case strings.HasPrefix(vcLower, "vp9.2"), strings.Contains(vcLower, ".10.0.110.09.16."):
			dynamicRange = "HDR10"
		case strings.Contains(vcLower, ".10.0.110.09.18."):
			dynamicRange = "HLG"
		default:
			dynamicRange = "SDR"
		}
		return ext, vcodec, acodec, dynamicRange, true
	}
	return "", "", "", "", false
}

func setURLQueryParamPreserveOrder(rawURL, key, value string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	encodedKV := url.QueryEscape(key) + "=" + url.QueryEscape(value)
	if u.RawQuery == "" {
		u.RawQuery = encodedKV
		return u.String(), nil
	}
	parts := strings.Split(u.RawQuery, "&")
	replaced := false
	out := make([]string, 0, len(parts)+1)
	for _, part := range parts {
		if part == "" {
			continue
		}
		k, _, _ := strings.Cut(part, "=")
		decodedK, err := url.QueryUnescape(k)
		if err != nil {
			decodedK = k
		}
		if decodedK == key {
			if !replaced {
				out = append(out, encodedKV)
				replaced = true
			}
			continue
		}
		out = append(out, part)
	}
	if !replaced {
		out = append(out, encodedKV)
	}
	u.RawQuery = strings.Join(out, "&")
	return u.String(), nil
}
