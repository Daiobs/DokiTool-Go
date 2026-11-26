// Package telemetry defines dependency-free read-only telemetry value types
// shared across backend subsystem boundaries without reverse package imports.
package telemetry

// YouTubeHelperMaxChallengeCacheEntries is the single source of truth for the
// deterministic YouTube helper solver LRU entry capacity, shared by
// internal/platform/youtube and cmd/genstatstypes.
const YouTubeHelperMaxChallengeCacheEntries = 4096

// YouTubeHelperStats exposes strictly redacted, closed-vocabulary telemetry for
// GET /api/stats (zero URLs, IPs, error messages, tokens, or local paths).
type YouTubeHelperStats struct {
	Enabled             bool   `json:"enabled"`
	DisabledByConfig    bool   `json:"disabled_by_config"`
	ActivePlayerCached  bool   `json:"active_player_cached"`
	ActiveVariant       string `json:"active_variant"`
	RefreshAttempts     uint64 `json:"refresh_attempts"`
	RefreshSuccesses    uint64 `json:"refresh_successes"`
	RefreshFailures     uint64 `json:"refresh_failures"`
	CooldownSkips       uint64 `json:"cooldown_skips"`
	ConsecutiveFailures int    `json:"consecutive_failures"`
	InCooldown          bool   `json:"in_cooldown"`
	ChallengeLRUEntries int    `json:"challenge_lru_entries"`
	ChallengeLRUHits    uint64 `json:"challenge_lru_hits"`
	ChallengeLRUMisses  uint64 `json:"challenge_lru_misses"`
}
