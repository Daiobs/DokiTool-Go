package api

import (
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	apitelemetry "github.com/Brilliant666/DokiTool-Go/backend/internal/telemetry"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

// YouTubeHelperStatsSnapshot is the stable HTTP /api/stats DTO for YouTube helper
// refresh/cooldown/LRU telemetry, decoupled from internal/platform/youtube.
type YouTubeHelperStatsSnapshot struct {
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

// YouTubeHelperStatsSource provides a point-in-time redacted YouTube helper telemetry snapshot.
type YouTubeHelperStatsSource interface {
	HelperStatsSnapshot() apitelemetry.YouTubeHelperStats
}

// TikTokRiskStatsSnapshot is the stable HTTP /api/stats DTO for TikTok
// anti-bot / WAF and play-302 telemetry, decoupled from internal/platform/tiktok.
type TikTokRiskStatsSnapshot struct {
	ProxyConfigured bool   `json:"proxy_configured"`
	TransportMode   string `json:"transport_mode"`
	HydrationOK     uint64 `json:"hydration_ok"`
	WAFBlocked      uint64 `json:"waf_blocked"`
	ContentNotFound uint64 `json:"content_not_found"`
	Play302OK       uint64 `json:"play_302_ok"`
	Play302Failed   uint64 `json:"play_302_failed"`
}

// TikTokRiskStatsSource provides a point-in-time redacted TikTok risk telemetry snapshot.
type TikTokRiskStatsSource interface {
	TikTokRiskStatsSnapshot() apitelemetry.TikTokRiskStats
}

// HistogramBuckets is the stable HTTP /api/stats cumulative millisecond histogram DTO.
type HistogramBuckets struct {
	LE10    uint64 `json:"<=10"`
	LE50    uint64 `json:"<=50"`
	LE100   uint64 `json:"<=100"`
	LE250   uint64 `json:"<=250"`
	LE500   uint64 `json:"<=500"`
	LE1000  uint64 `json:"<=1000"`
	LE2500  uint64 `json:"<=2500"`
	LE5000  uint64 `json:"<=5000"`
	LE10000 uint64 `json:"<=10000"`
	LE30000 uint64 `json:"<=30000"`
	Inf     uint64 `json:"+Inf"`
}

// HistogramSnapshot is the stable HTTP /api/stats duration distribution DTO.
type HistogramSnapshot struct {
	Count   uint64           `json:"count"`
	SumMS   uint64           `json:"sum_ms"`
	MaxMS   uint64           `json:"max_ms"`
	Buckets HistogramBuckets `json:"buckets"`
}

// ChannelSlotStatsSnapshot is the stable HTTP /api/stats DTO for per-channel
// yt-dlp slot acquisitions and contended wait statistics.
type ChannelSlotStatsSnapshot struct {
	AcquiredCount uint64            `json:"acquired_count"`
	WaitCount     uint64            `json:"wait_count"`
	CanceledCount uint64            `json:"canceled_count"`
	WaitMSTotal   uint64            `json:"wait_ms_total"`
	WaitMSMax     uint64            `json:"wait_ms_max"`
	WaitMS        HistogramSnapshot `json:"wait_ms"`
}

// YTDLPChannelBreakdown separates yt-dlp slot contention by caller channel.
type YTDLPChannelBreakdown struct {
	Anonymous ChannelSlotStatsSnapshot `json:"anonymous"`
	Owner     ChannelSlotStatsSnapshot `json:"owner"`
}

// YTDLPSlotStatsSnapshot is the stable HTTP /api/stats DTO for yt-dlp semaphore telemetry.
type YTDLPSlotStatsSnapshot struct {
	Enabled          bool                     `json:"enabled"`
	Active           int                      `json:"active"`
	Waiting          int                      `json:"waiting"`
	ConcurrencyLimit int                      `json:"concurrency_limit"`
	Total            ChannelSlotStatsSnapshot `json:"total"`
	ByChannel        YTDLPChannelBreakdown    `json:"by_channel"`
}

// ShanghaiChannelStats is the stable HTTP /api/stats DTO for one Shanghai exit channel slice.
type ShanghaiChannelStats struct {
	Hits             uint64 `json:"hits"`
	Fallbacks        uint64 `json:"fallbacks"`
	Canceled         uint64 `json:"canceled"`
	QueueWaits       uint64 `json:"queue_waits"`
	QueueGranted     uint64 `json:"queue_granted"`
	QueueTimeouts    uint64 `json:"queue_timeouts"`
	QueueWaitMSTotal uint64 `json:"queue_wait_ms_total"`
	QueueWaitMSMax   uint64 `json:"queue_wait_ms_max"`
}

// ShanghaiChannelBreakdown separates Shanghai metrics between anonymous and owner callers.
type ShanghaiChannelBreakdown struct {
	Anonymous ShanghaiChannelStats `json:"anonymous"`
	Owner     ShanghaiChannelStats `json:"owner"`
}

// ShanghaiPlatformBreakdown separates Shanghai metrics by platform.
type ShanghaiPlatformBreakdown struct {
	Douyin   ShanghaiChannelStats `json:"douyin"`
	Bilibili ShanghaiChannelStats `json:"bilibili"`
}

// ShanghaiStatsSnapshot is the stable HTTP /api/stats DTO for Shanghai exit telemetry.
type ShanghaiStatsSnapshot struct {
	Enabled        bool                      `json:"enabled"`
	Mode           string                    `json:"mode"`
	WaitingWorkers int                       `json:"waiting_workers"`
	QueuedTasks    int                       `json:"queued_tasks"`
	PendingTasks   int                       `json:"pending_tasks"`
	Total          ShanghaiChannelStats      `json:"total"`
	ByChannel      ShanghaiChannelBreakdown  `json:"by_channel"`
	ByPlatform     ShanghaiPlatformBreakdown `json:"by_platform"`
}

func toAPIYouTubeHelperStats(in apitelemetry.YouTubeHelperStats) YouTubeHelperStatsSnapshot {
	return YouTubeHelperStatsSnapshot{
		Enabled:             in.Enabled,
		DisabledByConfig:    in.DisabledByConfig,
		ActivePlayerCached:  in.ActivePlayerCached,
		ActiveVariant:       in.ActiveVariant,
		RefreshAttempts:     in.RefreshAttempts,
		RefreshSuccesses:    in.RefreshSuccesses,
		RefreshFailures:     in.RefreshFailures,
		CooldownSkips:       in.CooldownSkips,
		ConsecutiveFailures: in.ConsecutiveFailures,
		InCooldown:          in.InCooldown,
		ChallengeLRUEntries: in.ChallengeLRUEntries,
		ChallengeLRUHits:    in.ChallengeLRUHits,
		ChallengeLRUMisses:  in.ChallengeLRUMisses,
	}
}

func toAPITikTokRiskStats(in apitelemetry.TikTokRiskStats) TikTokRiskStatsSnapshot {
	mode := "standard"
	if in.TransportMode == "chrome131" {
		mode = "chrome131"
	}
	return TikTokRiskStatsSnapshot{
		ProxyConfigured: in.ProxyConfigured,
		TransportMode:   mode,
		HydrationOK:     in.HydrationOK,
		WAFBlocked:      in.WAFBlocked,
		ContentNotFound: in.ContentNotFound,
		Play302OK:       in.Play302OK,
		Play302Failed:   in.Play302Failed,
	}
}

func toAPIHistogramSnapshot(in ytengine.HistogramSnapshot) HistogramSnapshot {
	return HistogramSnapshot{
		Count: in.Count,
		SumMS: in.SumMS,
		MaxMS: in.MaxMS,
		Buckets: HistogramBuckets{
			LE10:    in.Buckets.LE10,
			LE50:    in.Buckets.LE50,
			LE100:   in.Buckets.LE100,
			LE250:   in.Buckets.LE250,
			LE500:   in.Buckets.LE500,
			LE1000:  in.Buckets.LE1000,
			LE2500:  in.Buckets.LE2500,
			LE5000:  in.Buckets.LE5000,
			LE10000: in.Buckets.LE10000,
			LE30000: in.Buckets.LE30000,
			Inf:     in.Buckets.Inf,
		},
	}
}

func toAPIChannelSlotStats(in ytengine.ChannelSlotStatsSnapshot) ChannelSlotStatsSnapshot {
	return ChannelSlotStatsSnapshot{
		AcquiredCount: in.AcquiredCount,
		WaitCount:     in.WaitCount,
		CanceledCount: in.CanceledCount,
		WaitMSTotal:   in.WaitMSTotal,
		WaitMSMax:     in.WaitMSMax,
		WaitMS:        toAPIHistogramSnapshot(in.WaitMS),
	}
}

func toAPIYTDLPSlotStats(in ytengine.SlotStatsSnapshot) YTDLPSlotStatsSnapshot {
	return YTDLPSlotStatsSnapshot{
		Enabled:          in.Enabled,
		Active:           in.Active,
		Waiting:          in.Waiting,
		ConcurrencyLimit: in.ConcurrencyLimit,
		Total:            toAPIChannelSlotStats(in.Total),
		ByChannel: YTDLPChannelBreakdown{
			Anonymous: toAPIChannelSlotStats(in.ByChannel.Anonymous),
			Owner:     toAPIChannelSlotStats(in.ByChannel.Owner),
		},
	}
}

func toAPIShanghaiChannelStats(in shresolver.ChannelStatsSnapshot) ShanghaiChannelStats {
	return ShanghaiChannelStats{
		Hits:             in.Hits,
		Fallbacks:        in.Fallbacks,
		Canceled:         in.Canceled,
		QueueWaits:       in.QueueWaits,
		QueueGranted:     in.QueueGranted,
		QueueTimeouts:    in.QueueTimeouts,
		QueueWaitMSTotal: in.QueueWaitMSTotal,
		QueueWaitMSMax:   in.QueueWaitMSMax,
	}
}

func toAPIShanghaiStats(in shresolver.StatsSnapshot) ShanghaiStatsSnapshot {
	return ShanghaiStatsSnapshot{
		Enabled:        in.Enabled,
		Mode:           in.Mode,
		WaitingWorkers: in.WaitingWorkers,
		QueuedTasks:    in.QueuedTasks,
		PendingTasks:   in.PendingTasks,
		Total:          toAPIShanghaiChannelStats(in.Total),
		ByChannel: ShanghaiChannelBreakdown{
			Anonymous: toAPIShanghaiChannelStats(in.ByChannel.Anonymous),
			Owner:     toAPIShanghaiChannelStats(in.ByChannel.Owner),
		},
		ByPlatform: ShanghaiPlatformBreakdown{
			Douyin:   toAPIShanghaiChannelStats(in.ByPlatform.Douyin),
			Bilibili: toAPIShanghaiChannelStats(in.ByPlatform.Bilibili),
		},
	}
}
