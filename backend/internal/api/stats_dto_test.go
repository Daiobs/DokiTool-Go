package api

import (
	"encoding/json"
	"net/url"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/instagram"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	apitelemetry "github.com/Brilliant666/DokiTool-Go/backend/internal/telemetry"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/urlpolicy"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func TestStatsDTOJSONWireEquivalenceWithSubsystemSnapshots(t *testing.T) {
	ytIn := apitelemetry.YouTubeHelperStats{
		Enabled:             true,
		DisabledByConfig:    false,
		ActivePlayerCached:  true,
		ActiveVariant:       "tv",
		RefreshAttempts:     7,
		RefreshSuccesses:    6,
		RefreshFailures:     1,
		CooldownSkips:       2,
		ConsecutiveFailures: 1,
		InCooldown:          false,
		ChallengeLRUEntries: 42,
		ChallengeLRUHits:    100,
		ChallengeLRUMisses:  15,
	}
	assertJSONEqual(t, "YouTubeHelperStats", ytIn, toAPIYouTubeHelperStats(ytIn))

	ttIn := apitelemetry.TikTokRiskStats{
		ProxyConfigured: true,
		TransportMode:   "chrome131",
		HydrationOK:     12,
		WAFBlocked:      3,
		ContentNotFound: 2,
		Play302OK:       40,
		Play302Failed:   1,
	}
	assertJSONEqual(t, "TikTokRiskStats", ttIn, toAPITikTokRiskStats(ttIn))

	slotIn := ytengine.SlotStatsSnapshot{
		Enabled:          true,
		Active:           2,
		Waiting:          1,
		ConcurrencyLimit: 4,
		Total: ytengine.ChannelSlotStatsSnapshot{
			AcquiredCount: 11,
			WaitCount:     3,
			CanceledCount: 1,
			WaitMSTotal:   910,
			WaitMSMax:     420,
			WaitMS: ytengine.HistogramSnapshot{
				Count: 3,
				SumMS: 910,
				MaxMS: 420,
				Buckets: ytengine.HistogramBuckets{
					LE10: 0, LE50: 1, LE100: 1, LE250: 2, LE500: 3,
					LE1000: 3, LE2500: 3, LE5000: 3, LE10000: 3, LE30000: 3, Inf: 3,
				},
			},
		},
		ByChannel: ytengine.SlotChannelBreakdown{
			Anonymous: ytengine.ChannelSlotStatsSnapshot{AcquiredCount: 8, WaitCount: 2, WaitMSTotal: 600, WaitMSMax: 420},
			Owner:     ytengine.ChannelSlotStatsSnapshot{AcquiredCount: 3, WaitCount: 1, CanceledCount: 1, WaitMSTotal: 310, WaitMSMax: 310},
		},
	}
	assertJSONEqual(t, "YTDLPSlotStats", slotIn, toAPIYTDLPSlotStats(slotIn))

	shIn := shresolver.StatsSnapshot{
		Enabled:        true,
		Mode:           "pull",
		WaitingWorkers: 1,
		QueuedTasks:    2,
		PendingTasks:   3,
		Total:          shresolver.ChannelStatsSnapshot{Hits: 9, Fallbacks: 1, Canceled: 0, QueueWaits: 4, QueueGranted: 3, QueueTimeouts: 1, QueueWaitMSTotal: 550, QueueWaitMSMax: 300},
		ByChannel: shresolver.ChannelBreakdown{
			Anonymous: shresolver.ChannelStatsSnapshot{Hits: 6, Fallbacks: 1},
			Owner:     shresolver.ChannelStatsSnapshot{Hits: 3},
		},
		ByPlatform: shresolver.PlatformBreakdown{
			Douyin:   shresolver.ChannelStatsSnapshot{Hits: 5},
			Bilibili: shresolver.ChannelStatsSnapshot{Hits: 4, Fallbacks: 1},
		},
	}
	assertJSONEqual(t, "ShanghaiStats", shIn, toAPIShanghaiStats(shIn))
}

func assertJSONEqual(t *testing.T, label string, src any, dst any) {
	t.Helper()
	wantBytes, err := json.Marshal(src)
	if err != nil {
		t.Fatalf("%s marshal src: %v", label, err)
	}
	gotBytes, err := json.Marshal(dst)
	if err != nil {
		t.Fatalf("%s marshal dst: %v", label, err)
	}
	if string(gotBytes) != string(wantBytes) {
		t.Fatalf("%s JSON mismatch:\n got: %s\nwant: %s", label, string(gotBytes), string(wantBytes))
	}
}

func TestInstagramCacheKeyParityWithURLPolicy(t *testing.T) {
	samples := []string{
		"https://www.instagram.com/p/aye83DjauH/",
		"https://instagram.com/p/aye83DjauH?utm_source=share#top",
		"https://m.instagram.com/reel/CTApqC8BGWd/?hl=en",
		"http://www.instagram.com:80/reels/CTApqC8BGWd",
		"https://www.instagram.com:443/tv/aye83DjauH/#frag",
		"https://www.instagram.com/creator_name/p/aye83DjauH/?img_index=1",
		"https://www.instagram.com/creator_name/reel/CTApqC8BGWd/",
		"https://instagr.am/p/aye83DjauH/?foo=bar",
		"https://www.instagr.am/reel/CTApqC8BGWd/#x",
		"https://instagr.am/creator/p/aye83DjauH/",
		"https://foo.instagr.am/p/aye83DjauH/",
		"https://www.instagram.com:8443/p/aye83DjauH/",
	}
	for _, raw := range samples {
		idA, canonA, okA := urlpolicy.ExtractInstagramPostTarget(raw)
		idB, canonB, okB := instagram.ExtractPostTarget(raw)
		if idA != idB || canonA != canonB || okA != okB {
			t.Fatalf("parity mismatch for %q: urlpolicy=(%q,%q,%v) vs instagram=(%q,%q,%v)",
				raw, idA, canonA, okA, idB, canonB, okB)
		}
		if okA {
			got := normalizeCacheURL("instagram", raw)
			wantCacheKey := canonA
			if parsed, err := url.Parse(raw); err == nil && parsed.RawQuery != "" {
				wantCacheKey += "?" + parsed.RawQuery
			}
			if got != wantCacheKey {
				t.Fatalf("normalizeCacheURL(%q) = %q, want %q", raw, got, wantCacheKey)
			}
		}
	}
}
