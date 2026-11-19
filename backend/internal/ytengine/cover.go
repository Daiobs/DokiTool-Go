package ytengine

import (
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func pickCoverObject(info *Info, entries []Info, allowedMediaURL func(string) bool, now int64) unified.Object {
	if c := pickSingleCover(info, allowedMediaURL, now); c != nil {
		return c
	}
	for i := range entries {
		if c := pickSingleCover(&entries[i], allowedMediaURL, now); c != nil {
			return c
		}
	}
	return nil
}

func pickSingleCover(info *Info, allowedMediaURL func(string) bool, now int64) unified.Object {
	if info == nil {
		return nil
	}
	if clean := SanitizeMediaURL(info.Thumbnail, allowedMediaURL); clean != "" {
		sources := unified.Sources(unified.Array{clean}, now)
		if len(sources) > 0 {
			return unified.Map(sources[0])
		}
	}
	for i := len(info.Thumbnails) - 1; i >= 0; i-- {
		if clean := SanitizeMediaURL(info.Thumbnails[i].URL, allowedMediaURL); clean != "" {
			sources := unified.Sources(unified.Array{clean}, now)
			if len(sources) > 0 {
				return unified.Map(sources[0])
			}
		}
	}
	return nil
}
