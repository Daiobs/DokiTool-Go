package api

import (
	"slices"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/youtube"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

// YouTubeHelperStatsSnapshot aliases youtube.HelperStatsSnapshot so /api/stats
// exposes YouTube helper refresh/cooldown/LRU telemetry with one canonical schema.
type YouTubeHelperStatsSnapshot = youtube.HelperStatsSnapshot

// YouTubeHelperStatsSource provides a point-in-time redacted YouTube helper telemetry snapshot.
type YouTubeHelperStatsSource interface {
	HelperStatsSnapshot() youtube.HelperStatsSnapshot
}

// HistogramBuckets aliases ytengine.HistogramBuckets so API telemetry shares one exact schema.
type HistogramBuckets = ytengine.HistogramBuckets

// HistogramSnapshot aliases ytengine.HistogramSnapshot so API telemetry shares one exact schema.
type HistogramSnapshot = ytengine.HistogramSnapshot

// PlatformOutcomeCount reports one non-zero cell in the bounded platform × code × channel cube.
type PlatformOutcomeCount struct {
	Platform string `json:"platform"`
	Code     string `json:"code"`
	Channel  string `json:"channel"`
	Count    uint64 `json:"count"`
}

// RequestChannelBreakdown separates total parse/resolve request counts by channel.
type RequestChannelBreakdown struct {
	Anonymous uint64 `json:"anonymous"`
	Owner     uint64 `json:"owner"`
}

// RequestStatsSnapshot summarizes parse/resolve request outcomes across closed dimensions.
type RequestStatsSnapshot struct {
	Total                 uint64                  `json:"total"`
	ByChannel             RequestChannelBreakdown `json:"by_channel"`
	ByPlatformCodeChannel []PlatformOutcomeCount  `json:"by_platform_code_channel"`
}

// CacheChannelCounts reports parseCache and singleflight outcomes for one channel (or total).
type CacheChannelCounts struct {
	Hits               uint64 `json:"hits"`
	StaleHits          uint64 `json:"stale_hits"`
	Misses             uint64 `json:"misses"`
	SingleflightShared uint64 `json:"singleflight_shared"`
	Uncacheable        uint64 `json:"uncacheable"`
}

// CacheChannelBreakdown separates parseCache outcomes between anonymous visitors and owner callers.
type CacheChannelBreakdown struct {
	Anonymous CacheChannelCounts `json:"anonymous"`
	Owner     CacheChannelCounts `json:"owner"`
}

// CacheStatsSnapshot reports live LRU occupancy and cumulative cache/singleflight outcomes.
type CacheStatsSnapshot struct {
	Enabled    bool                  `json:"enabled"`
	Entries    int                   `json:"entries"`
	Bytes      int64                 `json:"bytes"`
	MaxEntries int                   `json:"max_entries"`
	MaxBytes   int64                 `json:"max_bytes"`
	Total      CacheChannelCounts    `json:"total"`
	ByChannel  CacheChannelBreakdown `json:"by_channel"`
}

// AdmissionPoolSnapshot reports live concurrency/queue gauges and cumulative queue outcomes for one pool.
type AdmissionPoolSnapshot struct {
	Active           int    `json:"active"`
	Queued           int    `json:"queued"`
	ConcurrencyLimit int    `json:"concurrency_limit"`
	QueueLimit       int    `json:"queue_limit"`
	Waited           uint64 `json:"waited"`
	Granted          uint64 `json:"granted"`
	Timeout          uint64 `json:"timeout"`
	Full             uint64 `json:"full"`
	Canceled         uint64 `json:"canceled"`
	WaitMSTotal      uint64 `json:"wait_ms_total"`
	WaitMSMax        uint64 `json:"wait_ms_max"`
}

// AdmissionStatsSnapshot summarizes the four queued admission pools (fast, slow, generic_slow, owner).
type AdmissionStatsSnapshot struct {
	Fast        AdmissionPoolSnapshot `json:"fast"`
	Slow        AdmissionPoolSnapshot `json:"slow"`
	GenericSlow AdmissionPoolSnapshot `json:"generic_slow"`
	Owner       AdmissionPoolSnapshot `json:"owner"`
}

// LatencyChannelBreakdown separates parse/resolve latency distributions by channel.
type LatencyChannelBreakdown struct {
	Anonymous HistogramSnapshot `json:"anonymous"`
	Owner     HistogramSnapshot `json:"owner"`
}

// LatencyStatsSnapshot summarizes end-to-end parse/resolve latency distributions.
type LatencyStatsSnapshot struct {
	Total     HistogramSnapshot       `json:"total"`
	ByChannel LatencyChannelBreakdown `json:"by_channel"`
}

// DailyLatencySummary reports daily millisecond latency percentiles and maximum.
type DailyLatencySummary struct {
	P50MS uint64 `json:"p50_ms"`
	P95MS uint64 `json:"p95_ms"`
	MaxMS uint64 `json:"max_ms"`
}

// DailyPlatformStats reports per-platform daily aggregate counts, outcome code breakdown, and P95 latency.
type DailyPlatformStats struct {
	Total  uint64            `json:"total"`
	OK     uint64            `json:"ok"`
	Failed uint64            `json:"failed"`
	ByCode map[string]uint64 `json:"by_code"`
	P95MS  uint64            `json:"p95_ms"`
}

// DailyStatsBucket reports one Asia/Shanghai (UTC+8) natural day aggregate bucket.
type DailyStatsBucket struct {
	Date         string                        `json:"date"`
	Total        uint64                        `json:"total"`
	OK           uint64                        `json:"ok"`
	Failed       uint64                        `json:"failed"`
	CacheHits    uint64                        `json:"cache_hits"`
	ShanghaiHits uint64                        `json:"shanghai_hits"`
	LatencyMS    DailyLatencySummary           `json:"latency_ms"`
	ByPlatform   map[string]DailyPlatformStats `json:"by_platform"`
}

// HourlyStatsBucket reports one Asia/Shanghai (UTC+8) clock hour aggregate bucket.
type HourlyStatsBucket struct {
	HourStart string `json:"hour_start"`
	Total     uint64 `json:"total"`
	OK        uint64 `json:"ok"`
	Failed    uint64 `json:"failed"`
	CacheHits uint64 `json:"cache_hits"`
}

// RuntimeConfigSnapshot exposes strictly redacted, read-only deployment feature switches.
// It never includes URLs, IPs, tokens, secrets, or local file paths.
type RuntimeConfigSnapshot struct {
	Version                 string `json:"version"`
	ShanghaiMode            string `json:"shanghai_mode"`
	ShanghaiBilibili        bool   `json:"shanghai_bilibili"`
	BilibiliDASH            bool   `json:"bilibili_dash"`
	YouTubeHelper           bool   `json:"youtube_helper"`
	XHSTransport            string `json:"xhs_transport"`
	YTDLPEnabled            bool   `json:"ytdlp_enabled"`
	YTDLPGenericEnabled     bool   `json:"ytdlp_generic_enabled"`
	TBVideoPipigx           bool   `json:"tbvideo_pipigx"`
	TBVideoZuiyou           bool   `json:"tbvideo_zuiyou"`
	StatsPersistenceEnabled bool   `json:"stats_persistence_enabled"`
}

// YTDLPStatsSource provides a point-in-time yt-dlp concurrency slot snapshot.
type YTDLPStatsSource interface {
	StatsSnapshot() ytengine.SlotStatsSnapshot
}

// YTDLPCompartmentPoolSnapshot reports live occupancy, limits, and cumulative queue
// outcomes for one isolated yt-dlp or YouTube EJS compartment pool.
type YTDLPCompartmentPoolSnapshot struct {
	Enabled          bool   `json:"enabled"`
	Active           int    `json:"active"`
	Queued           int    `json:"queued"`
	ConcurrencyLimit int    `json:"concurrency_limit"`
	QueueLimit       int    `json:"queue_limit"`
	Waited           uint64 `json:"waited"`
	Granted          uint64 `json:"granted"`
	Timeout          uint64 `json:"timeout"`
	Full             uint64 `json:"full"`
	Canceled         uint64 `json:"canceled"`
	WaitMSTotal      uint64 `json:"wait_ms_total"`
	WaitMSMax        uint64 `json:"wait_ms_max"`
}

// YTDLPPoolsSnapshot summarizes the four decoupled yt-dlp / YouTube EJS compartment pools.
type YTDLPPoolsSnapshot struct {
	YouTube    YTDLPCompartmentPoolSnapshot `json:"youtube"`
	Social     YTDLPCompartmentPoolSnapshot `json:"social"`
	Generic    YTDLPCompartmentPoolSnapshot `json:"generic"`
	YouTubeEJS YTDLPCompartmentPoolSnapshot `json:"youtube_ejs"`
}

// CircuitBreakerPlatformSnapshot reports the current circuit breaker state for one core platform.
type CircuitBreakerPlatformSnapshot struct {
	Platform            string `json:"platform"`
	State               string `json:"state"`
	ConsecutiveFailures int    `json:"consecutive_failures"`
	WindowFailures      int    `json:"window_failures"`
	WindowTotal         int    `json:"window_total"`
	OpenUntil           string `json:"open_until"`
	DisabledByConfig    bool   `json:"disabled_by_config"`
}

// RuntimePolicySummary exposes the strictly redacted active runtime hot-config policy
// (zero file paths or secrets).
type RuntimePolicySummary struct {
	ConfigFileActive              bool     `json:"config_file_active"`
	ReloadCount                   uint64   `json:"reload_count"`
	LastReloadedAt                string   `json:"last_reloaded_at"`
	YouTubeSlots                  int      `json:"youtube_slots"`
	SocialSlots                   int      `json:"social_slots"`
	GenericSlots                  int      `json:"generic_slots"`
	YouTubeEJSConcurrency         int      `json:"youtube_ejs_concurrency"`
	FastPerPlatformMaxConcurrency int      `json:"fast_per_platform_max_concurrency"`
	CircuitBreakerEnabled         bool     `json:"circuit_breaker_enabled"`
	DisabledPlatforms             []string `json:"disabled_platforms"`
	YouTubeParseTTLSeconds        int      `json:"youtube_parse_ttl_seconds"`
	StaleIfErrorTTLSeconds        int      `json:"stale_if_error_ttl_seconds"`
	UpstreamBlockedNegTTLSeconds  int      `json:"upstream_blocked_neg_ttl_seconds"`
}

func defaultRuntimePolicySummary() RuntimePolicySummary {
	def := DefaultRuntimeConfig()
	return runtimePolicySummaryFromConfig(def, false, 0, "")
}

func runtimePolicySummaryFromConfig(cfg RuntimeConfig, fromFile bool, reloadCount uint64, lastReloadedAt string) RuntimePolicySummary {
	disabled := make([]string, len(cfg.CircuitBreaker.DisabledPlatforms))
	copy(disabled, cfg.CircuitBreaker.DisabledPlatforms)
	return RuntimePolicySummary{
		ConfigFileActive:              fromFile,
		ReloadCount:                   reloadCount,
		LastReloadedAt:                lastReloadedAt,
		YouTubeSlots:                  cfg.YTDLP.YouTubeSlots,
		SocialSlots:                   cfg.YTDLP.SocialSlots,
		GenericSlots:                  cfg.YTDLP.GenericSlots,
		YouTubeEJSConcurrency:         cfg.YTDLP.YouTubeEJSConcurrency,
		FastPerPlatformMaxConcurrency: cfg.FastPool.PerPlatformMaxConcurrency,
		CircuitBreakerEnabled:         cfg.CircuitBreaker.Enabled,
		DisabledPlatforms:             disabled,
		YouTubeParseTTLSeconds:        int(cfg.Cache.YouTubeParseTTL / time.Second),
		StaleIfErrorTTLSeconds:        int(cfg.Cache.StaleIfErrorTTL / time.Second),
		UpstreamBlockedNegTTLSeconds:  int(cfg.Cache.UpstreamBlockedNegTTL / time.Second),
	}
}

func cloneRuntimePolicySummary(in RuntimePolicySummary) RuntimePolicySummary {
	out := in
	if in.DisabledPlatforms == nil {
		out.DisabledPlatforms = make([]string, 0)
	} else {
		out.DisabledPlatforms = slices.Clone(in.DisabledPlatforms)
	}
	return out
}

// StatsSnapshot is the read-only data payload returned by GET /api/stats.
type StatsSnapshot struct {
	StartedAt       string                           `json:"started_at"`
	GeneratedAt     string                           `json:"generated_at"`
	UptimeSeconds   int64                            `json:"uptime_seconds"`
	Requests        RequestStatsSnapshot             `json:"requests"`
	Cache           CacheStatsSnapshot               `json:"cache"`
	Admission       AdmissionStatsSnapshot           `json:"admission"`
	APIKeys         []APIKeyStatsSnapshot            `json:"api_keys"`
	YTDLP           ytengine.SlotStatsSnapshot       `json:"ytdlp"`
	YTDLPGeneric    ytengine.SlotStatsSnapshot       `json:"ytdlp_generic"`
	YTDLPPools      YTDLPPoolsSnapshot               `json:"ytdlp_pools"`
	YouTubeHelper   YouTubeHelperStatsSnapshot       `json:"youtube_helper"`
	CircuitBreakers []CircuitBreakerPlatformSnapshot `json:"circuit_breakers"`
	RuntimePolicy   RuntimePolicySummary             `json:"runtime_policy"`
	Shanghai        shresolver.StatsSnapshot         `json:"shanghai"`
	ParseLatencyMS  LatencyStatsSnapshot             `json:"parse_latency_ms"`
	Runtime         RuntimeConfigSnapshot            `json:"runtime"`
	Daily           []DailyStatsBucket               `json:"daily"`
	Hourly          []HourlyStatsBucket              `json:"hourly"`
}
