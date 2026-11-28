package telemetry

// TikTokRiskStats exposes strictly redacted, closed-vocabulary anti-bot / WAF
// and 302 telemetry for GET /api/stats (zero URLs, IPs, tokens, or credentials).
type TikTokRiskStats struct {
	ProxyConfigured bool   `json:"proxy_configured"`
	TransportMode   string `json:"transport_mode"`
	HydrationOK     uint64 `json:"hydration_ok"`
	WAFBlocked      uint64 `json:"waf_blocked"`
	ContentNotFound uint64 `json:"content_not_found"`
	Play302OK       uint64 `json:"play_302_ok"`
	Play302Failed   uint64 `json:"play_302_failed"`
}
