package ytengine

import (
	"fmt"
	"math"
	"net/url"
	"strings"
)

func isHLSVideo(f Format) bool {
	if isNoCodec(f.VCodec) {
		return false
	}
	proto := strings.ToLower(strings.TrimSpace(f.Protocol))
	u, err := url.Parse(f.URL)
	urlPath := ""
	if err == nil {
		urlPath = strings.ToLower(u.Path)
	}
	return strings.Contains(proto, "m3u8") || strings.HasSuffix(urlPath, ".m3u8")
}

func isHLSAudioOnly(f Format) bool {
	if !isNoCodec(f.VCodec) {
		return false
	}
	if isNoCodec(f.ACodec) || strings.TrimSpace(f.ACodec) == "" {
		return false
	}
	proto := strings.ToLower(strings.TrimSpace(f.Protocol))
	u, err := url.Parse(f.URL)
	urlPath := ""
	if err == nil {
		urlPath = strings.ToLower(u.Path)
	}
	return strings.Contains(proto, "m3u8") || strings.HasSuffix(urlPath, ".m3u8")
}

func isSingleStreamCombinedMP4HLS(f Format) bool {
	proto := strings.ToLower(strings.TrimSpace(f.Protocol))
	if proto != "m3u8_native" && proto != "m3u8" {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(f.Ext), "mp4") {
		return false
	}
	u, err := url.Parse(f.URL)
	if err != nil {
		return false
	}
	lowerPath := strings.ToLower(u.Path)
	if !strings.Contains(lowerPath, "/fmp4/") || !strings.HasSuffix(lowerPath, ".m3u8") {
		return false
	}
	return cleanCodec(f.VCodec) != "" && cleanCodec(f.ACodec) != ""
}

func hasUnsupportedSingleStreamHLSFormat(entries []Info, parent *Info, allowedMediaURL func(string) bool) bool {
	if parent != nil && parent.IsLive != nil && *parent.IsLive {
		return false
	}
	for _, entry := range entries {
		if entry.IsLive != nil && *entry.IsLive {
			continue
		}
		for _, f := range entry.Formats {
			cleanURL := SanitizeMediaURL(f.URL, allowedMediaURL)
			if cleanURL == "" {
				continue
			}
			f.URL = cleanURL
			if isHLSVideo(f) && !isSingleStreamCombinedMP4HLS(f) {
				return true
			}
		}
	}
	return false
}

func deduplicateSingleStreamHLSFormats(formats []Format) []Format {
	out := make([]Format, 0, len(formats))
	seenTier := make(map[string]bool, len(formats))
	seenURL := make(map[string]bool, len(formats))
	for _, f := range formats {
		if seenURL[f.URL] {
			continue
		}
		seenURL[f.URL] = true
		w, h := derefInt(f.Width), derefInt(f.Height)
		if w > 0 && h > 0 {
			fpsTier := int64(0)
			if fps := math.Round(derefFloat(f.FPS)); fps >= 50 {
				fpsTier = int64(fps)
			}
			key := fmt.Sprintf("%dx%d:%d", w, h, fpsTier)
			if seenTier[key] {
				continue
			}
			seenTier[key] = true
		}
		out = append(out, f)
	}
	return out
}
