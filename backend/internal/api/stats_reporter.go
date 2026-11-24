package api

import (
	"cmp"
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

// SummaryReporter formats strictly redacted single-line aggregate telemetry log entries,
// tracking deltas since the previous tick alongside cumulative process totals.
type SummaryReporter struct {
	mu       sync.Mutex
	stats    *Stats
	lastAt   time.Time
	lastAnon uint64
	lastOwn  uint64
	lastHits uint64
	lastSH   uint64
}

// NewSummaryReporter creates a stateful periodic summary line formatter for stats.
func NewSummaryReporter(stats *Stats) *SummaryReporter {
	var start time.Time
	if stats != nil {
		start = stats.startedAt
	} else {
		start = time.Now().UTC()
	}
	return &SummaryReporter{
		stats:  stats,
		lastAt: start,
	}
}

func subClampUint64(cur, prev uint64) uint64 {
	if cur >= prev {
		return cur - prev
	}
	return 0
}

// FormatLine emits strictly one single-line key=value summary containing only integer
// counters and closed-vocabulary enum identifiers (never IPs, URLs, tokens, or error messages).
func (r *SummaryReporter) FormatLine() string {
	r.mu.Lock()
	defer r.mu.Unlock()

	var snap StatsSnapshot
	var now time.Time
	if r.stats != nil {
		now = r.stats.now().UTC()
		snap = r.stats.Snapshot()
	} else {
		now = time.Now().UTC()
		snap = (*Stats)(nil).Snapshot()
	}

	windowSec := int64(now.Sub(r.lastAt).Seconds())
	if windowSec < 0 {
		windowSec = 0
	}
	winAnon := subClampUint64(snap.Requests.ByChannel.Anonymous, r.lastAnon)
	winOwn := subClampUint64(snap.Requests.ByChannel.Owner, r.lastOwn)
	winHits := subClampUint64(snap.Cache.Total.Hits, r.lastHits)
	winSH := subClampUint64(snap.Shanghai.Total.Hits, r.lastSH)

	r.lastAt = now
	r.lastAnon = snap.Requests.ByChannel.Anonymous
	r.lastOwn = snap.Requests.ByChannel.Owner
	r.lastHits = snap.Cache.Total.Hits
	r.lastSH = snap.Shanghai.Total.Hits

	sortedCells := slices.Clone(snap.Requests.ByPlatformCodeChannel)
	slices.SortFunc(sortedCells, func(a, b PlatformOutcomeCount) int {
		if c := cmp.Compare(b.Count, a.Count); c != 0 {
			return c
		}
		if c := cmp.Compare(a.Platform, b.Platform); c != 0 {
			return c
		}
		if c := cmp.Compare(a.Code, b.Code); c != 0 {
			return c
		}
		return cmp.Compare(a.Channel, b.Channel)
	})
	if len(sortedCells) > maxSummaryLogOutcomes {
		sortedCells = sortedCells[:maxSummaryLogOutcomes]
	}
	outcomesField := "none"
	if len(sortedCells) > 0 {
		var ob strings.Builder
		for i, cell := range sortedCells {
			if i > 0 {
				ob.WriteByte(',')
			}
			// Re-normalize defensively so only closed compile-time enum tokens can appear.
			ob.WriteString(NormalizePlatform(cell.Platform))
			ob.WriteByte(':')
			ob.WriteString(NormalizeOutcomeCode(cell.Code))
			ob.WriteByte(':')
			ob.WriteString(NormalizeChannel(cell.Channel))
			ob.WriteByte('=')
			fmt.Fprintf(&ob, "%d", cell.Count)
		}
		outcomesField = ob.String()
	}

	latAnon := snap.ParseLatencyMS.ByChannel.Anonymous
	latOwn := snap.ParseLatencyMS.ByChannel.Owner

	line := fmt.Sprintf(
		"dokitool: stats_summary uptime_s=%d window_s=%d "+
			"req_total=%d req_anon=%d req_owner=%d win_req_anon=%d win_req_owner=%d "+
			"cache_hits=%d cache_stale_hits=%d win_cache_hits=%d cache_misses=%d cache_sf=%d cache_uncacheable=%d cache_entries=%d cache_bytes=%d "+
			"adm_fast_active=%d adm_fast_queued=%d adm_fast_waits=%d adm_fast_timeout=%d adm_fast_full=%d adm_fast_wait_ms=%d "+
			"adm_slow_active=%d adm_slow_queued=%d adm_slow_waits=%d adm_slow_timeout=%d adm_slow_full=%d adm_slow_wait_ms=%d "+
			"adm_owner_active=%d adm_owner_queued=%d adm_owner_waits=%d adm_owner_timeout=%d adm_owner_full=%d adm_owner_wait_ms=%d "+
			"ytdlp_active=%d ytdlp_waiting=%d ytdlp_anon_waits=%d ytdlp_anon_wait_ms=%d ytdlp_anon_max_ms=%d ytdlp_owner_waits=%d ytdlp_owner_wait_ms=%d ytdlp_owner_max_ms=%d "+
			"sh_hits=%d win_sh_hits=%d sh_fallbacks=%d sh_douyin_hits=%d sh_douyin_fallbacks=%d sh_bilibili_hits=%d sh_bilibili_fallbacks=%d sh_queue_waits=%d sh_queue_wait_ms=%d "+
			"lat_anon_count=%d lat_anon_p50_le_ms=%s lat_anon_p95_le_ms=%s lat_anon_max_ms=%d "+
			"lat_owner_count=%d lat_owner_p50_le_ms=%s lat_owner_p95_le_ms=%s lat_owner_max_ms=%d "+
			"outcomes=%s",
		snap.UptimeSeconds, windowSec,
		snap.Requests.Total, snap.Requests.ByChannel.Anonymous, snap.Requests.ByChannel.Owner, winAnon, winOwn,
		snap.Cache.Total.Hits, snap.Cache.Total.StaleHits, winHits, snap.Cache.Total.Misses, snap.Cache.Total.SingleflightShared, snap.Cache.Total.Uncacheable, snap.Cache.Entries, snap.Cache.Bytes,
		snap.Admission.Fast.Active, snap.Admission.Fast.Queued, snap.Admission.Fast.Waited, snap.Admission.Fast.Timeout, snap.Admission.Fast.Full, snap.Admission.Fast.WaitMSTotal,
		snap.Admission.Slow.Active, snap.Admission.Slow.Queued, snap.Admission.Slow.Waited, snap.Admission.Slow.Timeout, snap.Admission.Slow.Full, snap.Admission.Slow.WaitMSTotal,
		snap.Admission.Owner.Active, snap.Admission.Owner.Queued, snap.Admission.Owner.Waited, snap.Admission.Owner.Timeout, snap.Admission.Owner.Full, snap.Admission.Owner.WaitMSTotal,
		snap.YTDLP.Active, snap.YTDLP.Waiting,
		snap.YTDLP.ByChannel.Anonymous.WaitCount, snap.YTDLP.ByChannel.Anonymous.WaitMSTotal, snap.YTDLP.ByChannel.Anonymous.WaitMSMax,
		snap.YTDLP.ByChannel.Owner.WaitCount, snap.YTDLP.ByChannel.Owner.WaitMSTotal, snap.YTDLP.ByChannel.Owner.WaitMSMax,
		snap.Shanghai.Total.Hits, winSH, snap.Shanghai.Total.Fallbacks,
		snap.Shanghai.ByPlatform.Douyin.Hits, snap.Shanghai.ByPlatform.Douyin.Fallbacks,
		snap.Shanghai.ByPlatform.Bilibili.Hits, snap.Shanghai.ByPlatform.Bilibili.Fallbacks,
		snap.Shanghai.Total.QueueWaits, snap.Shanghai.Total.QueueWaitMSTotal,
		latAnon.Count, histogramQuantileUpperBound(latAnon, 50), histogramQuantileUpperBound(latAnon, 95), latAnon.MaxMS,
		latOwn.Count, histogramQuantileUpperBound(latOwn, 50), histogramQuantileUpperBound(latOwn, 95), latOwn.MaxMS,
		outcomesField,
	)
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(line)
}

// FormatSummaryLine formats a one-off single-line summary snapshot without advancing periodic window state.
func (s *Stats) FormatSummaryLine() string {
	return NewSummaryReporter(s).FormatLine()
}

// StartPeriodicLog starts a background goroutine that logs one single-line summary every interval
// until ctx is canceled or the returned stop function is called. Calling stop waits for clean exit.
func (s *Stats) StartPeriodicLog(ctx context.Context, interval time.Duration, logf func(string, ...any)) func() {
	if s == nil || interval <= 0 || logf == nil {
		return func() {}
	}
	ticker := time.NewTicker(interval)
	stopCh := make(chan struct{})
	doneCh := make(chan struct{})
	reporter := NewSummaryReporter(s)
	go func() {
		defer close(doneCh)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stopCh:
				return
			case <-ticker.C:
				logf("%s", reporter.FormatLine())
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stopCh)
			<-doneCh
		})
	}
}

func (h *Handler) serveStats(w http.ResponseWriter, r *http.Request) {
	if !IsOwnerRequest(r.Context()) {
		rejectUnauthorized(w, r, statsRoute)
		return
	}
	if AuthRoleFromContext(r.Context()) != RoleOwner {
		rejectUnauthorizedWithMessage(w, r, statsRoute, "当前凭据无权访问统计接口")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		sendError(w, http.StatusMethodNotAllowed, "仅支持 GET 请求")
		return
	}
	if rawQuery := r.URL.RawQuery; rawQuery != "" {
		for _, pair := range strings.Split(rawQuery, "&") {
			if pair == "" {
				sendError(w, http.StatusBadRequest, "不支持的查询参数")
				return
			}
			key := formDecode(strings.SplitN(pair, "=", 2)[0])
			if key != "schema_version" {
				sendError(w, http.StatusBadRequest, "不支持的查询参数")
				return
			}
		}
		version, scalar := queryValue(rawQuery, "schema_version")
		if !scalar || version != unified.SchemaVersion {
			sendError(w, http.StatusConflict, "接口版本已更新，请等待当前下载结束后刷新页面")
			return
		}
	} else if r.URL.ForceQuery {
		sendError(w, http.StatusBadRequest, "不支持的查询参数")
		return
	}
	send(w, http.StatusOK, h.stats.Envelope())
}
