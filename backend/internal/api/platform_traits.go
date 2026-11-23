package api

// platformTrait centralizes per-platform admission and parse-cache traits for
// ytengine / yt-dlp backed platforms so adding a slow-engine platform updates
// one table instead of drifting across admission.go and cache.go.
//
// Note: unified.requiresAudibleDefault (in internal/unified/select.go) is an
// independent unified-v1 contract rule (#38) governing default file selection
// and intentionally is NOT coupled to this HTTP admission/cache table.
type platformTrait struct {
	// slowEngine routes /api/parse cache misses to the PARSE_SLOW admission pool
	// sized to ytengine subprocess concurrency.
	slowEngine bool
	// strictInput2048 marks cacheable platforms whose parsers reject inputs
	// exceeding maxYTDLPInputBytes (2048 bytes), preventing parseCache from
	// normalizing or serving overlong inputs from a warm entry.
	// YouTube sets slowEngine: true and strictInput2048: false because
	// cacheablePlatform("youtube") is already false (egress-IP-bound stream URLs
	// and helper sessions never enter parseCache), while youtube.ExtractVideoTarget
	// enforces its own 2048-byte input cap directly on every request.
	strictInput2048 bool
}

// PlatformGeneric is the internal Tier-2 routing and API-key scope sentinel
// for named yt-dlp generic fallback requests when DOKITOOL_YTDLP_GENERIC_ENABLED
// is enabled. It is never published in catalog.Envelope() and never returned as
// data.platform in unified-v1 responses.
const PlatformGeneric = "ytdlp_generic"

var platformTraits = map[string]platformTrait{
	"x":             {slowEngine: true, strictInput2048: true},
	"youtube":       {slowEngine: true, strictInput2048: false},
	"instagram":     {slowEngine: true, strictInput2048: true},
	"facebook":      {slowEngine: true, strictInput2048: true},
	"tumblr":        {slowEngine: true, strictInput2048: true},
	PlatformGeneric: {slowEngine: true, strictInput2048: true},
}

func traitsForPlatform(platform string) platformTrait {
	return platformTraits[platform]
}
