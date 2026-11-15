package ytengine

import (
	"context"
	"sync/atomic"
	"time"
)

const (
	// ChannelAnonymous identifies public visitor requests without DOKITOOL_OWNER_TOKEN.
	ChannelAnonymous = "anonymous"
	// ChannelOwner identifies requests authenticated with DOKITOOL_OWNER_TOKEN.
	ChannelOwner = "owner"
)

type channelContextKey struct{}

// NormalizeChannel maps any caller string onto the closed two-value channel set.
func NormalizeChannel(channel string) string {
	if channel == ChannelOwner {
		return ChannelOwner
	}
	return ChannelAnonymous
}

// WithChannel annotates ctx with the normalized request channel ("anonymous" or "owner")
// so shared yt-dlp concurrency slot waits can be attributed by channel without import cycles.
func WithChannel(ctx context.Context, channel string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, channelContextKey{}, NormalizeChannel(channel))
}

// ChannelFromContext extracts the normalized request channel ("anonymous" or "owner") from ctx.
func ChannelFromContext(ctx context.Context) string {
	if ctx == nil {
		return ChannelAnonymous
	}
	raw, _ := ctx.Value(channelContextKey{}).(string)
	return NormalizeChannel(raw)
}

const (
	chAnonIdx  = 0
	chOwnerIdx = 1
	numCh      = 2
)

func channelIndex(channel string) int {
	if channel == ChannelOwner {
		return chOwnerIdx
	}
	return chAnonIdx
}

var durationBucketBounds = [10]time.Duration{
	10 * time.Millisecond,
	50 * time.Millisecond,
	100 * time.Millisecond,
	250 * time.Millisecond,
	500 * time.Millisecond,
	1000 * time.Millisecond,
	2500 * time.Millisecond,
	5000 * time.Millisecond,
	10000 * time.Millisecond,
	30000 * time.Millisecond,
}

// HistogramBuckets holds cumulative upper-bound millisecond bucket counts
// matching Prometheus histogram convention (+Inf == total count).
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

// HistogramSnapshot summarizes a millisecond duration distribution.
type HistogramSnapshot struct {
	Count   uint64           `json:"count"`
	SumMS   uint64           `json:"sum_ms"`
	MaxMS   uint64           `json:"max_ms"`
	Buckets HistogramBuckets `json:"buckets"`
}

type atomicHistogram struct {
	sumNs atomic.Uint64
	maxNs atomic.Uint64
	bins  [11]atomic.Uint64
}

func (h *atomicHistogram) observe(d time.Duration) {
	if d < 0 {
		d = 0
	}
	ns := uint64(d.Nanoseconds())
	h.sumNs.Add(ns)
	for {
		cur := h.maxNs.Load()
		if ns <= cur || h.maxNs.CompareAndSwap(cur, ns) {
			break
		}
	}
	idx := len(durationBucketBounds)
	for i, bound := range durationBucketBounds {
		if d <= bound {
			idx = i
			break
		}
	}
	h.bins[idx].Add(1)
}

func (h *atomicHistogram) snapshot() HistogramSnapshot {
	var cum [11]uint64
	var running uint64
	for i := 0; i < len(h.bins); i++ {
		running += h.bins[i].Load()
		cum[i] = running
	}
	return HistogramSnapshot{
		Count: running,
		SumMS: h.sumNs.Load() / 1_000_000,
		MaxMS: h.maxNs.Load() / 1_000_000,
		Buckets: HistogramBuckets{
			LE10:    cum[0],
			LE50:    cum[1],
			LE100:   cum[2],
			LE250:   cum[3],
			LE500:   cum[4],
			LE1000:  cum[5],
			LE2500:  cum[6],
			LE5000:  cum[7],
			LE10000: cum[8],
			LE30000: cum[9],
			Inf:     cum[10],
		},
	}
}

func mergeHistogramSnapshots(a, b HistogramSnapshot) HistogramSnapshot {
	return HistogramSnapshot{
		Count: a.Count + b.Count,
		SumMS: a.SumMS + b.SumMS,
		MaxMS: max(a.MaxMS, b.MaxMS),
		Buckets: HistogramBuckets{
			LE10:    a.Buckets.LE10 + b.Buckets.LE10,
			LE50:    a.Buckets.LE50 + b.Buckets.LE50,
			LE100:   a.Buckets.LE100 + b.Buckets.LE100,
			LE250:   a.Buckets.LE250 + b.Buckets.LE250,
			LE500:   a.Buckets.LE500 + b.Buckets.LE500,
			LE1000:  a.Buckets.LE1000 + b.Buckets.LE1000,
			LE2500:  a.Buckets.LE2500 + b.Buckets.LE2500,
			LE5000:  a.Buckets.LE5000 + b.Buckets.LE5000,
			LE10000: a.Buckets.LE10000 + b.Buckets.LE10000,
			LE30000: a.Buckets.LE30000 + b.Buckets.LE30000,
			Inf:     a.Buckets.Inf + b.Buckets.Inf,
		},
	}
}

// ChannelSlotStatsSnapshot reports yt-dlp concurrency slot acquisitions and
// contended wait statistics for one channel (or the sum across channels).
type ChannelSlotStatsSnapshot struct {
	AcquiredCount uint64            `json:"acquired_count"`
	WaitCount     uint64            `json:"wait_count"`
	CanceledCount uint64            `json:"canceled_count"`
	WaitMSTotal   uint64            `json:"wait_ms_total"`
	WaitMSMax     uint64            `json:"wait_ms_max"`
	WaitMS        HistogramSnapshot `json:"wait_ms"`
}

// SlotChannelBreakdown separates yt-dlp slot contention between anonymous visitors and owner callers.
type SlotChannelBreakdown struct {
	Anonymous ChannelSlotStatsSnapshot `json:"anonymous"`
	Owner     ChannelSlotStatsSnapshot `json:"owner"`
}

// SlotStatsSnapshot reports live gauges and cumulative per-channel wait metrics for the shared yt-dlp semaphore.
type SlotStatsSnapshot struct {
	Enabled          bool                     `json:"enabled"`
	Active           int                      `json:"active"`
	Waiting          int                      `json:"waiting"`
	ConcurrencyLimit int                      `json:"concurrency_limit"`
	Total            ChannelSlotStatsSnapshot `json:"total"`
	ByChannel        SlotChannelBreakdown     `json:"by_channel"`
}

type channelSlotCounters struct {
	waiting  atomic.Int64
	acquired atomic.Uint64
	canceled atomic.Uint64
	waitHist atomicHistogram
}

func (c *channelSlotCounters) snapshot() ChannelSlotStatsSnapshot {
	hist := c.waitHist.snapshot()
	return ChannelSlotStatsSnapshot{
		AcquiredCount: c.acquired.Load(),
		WaitCount:     hist.Count,
		CanceledCount: c.canceled.Load(),
		WaitMSTotal:   hist.SumMS,
		WaitMSMax:     hist.MaxMS,
		WaitMS:        hist,
	}
}

type slotStats struct {
	channels [numCh]channelSlotCounters
}

func newSlotStats() *slotStats {
	return &slotStats{}
}

func (s *slotStats) recordUncontendedAcquire(chIdx int) {
	s.channels[chIdx].acquired.Add(1)
}

func (s *slotStats) incWaiting(chIdx int) {
	s.channels[chIdx].waiting.Add(1)
}

func (s *slotStats) decWaiting(chIdx int) {
	s.channels[chIdx].waiting.Add(-1)
}

func (s *slotStats) recordContendedWait(chIdx int, d time.Duration, canceled bool) {
	c := &s.channels[chIdx]
	if canceled {
		c.canceled.Add(1)
	} else {
		c.acquired.Add(1)
	}
	c.waitHist.observe(d)
}

// StatsSnapshot returns a point-in-time snapshot of shared yt-dlp concurrency slot gauges and per-channel wait counters.
func (e *Engine) StatsSnapshot() SlotStatsSnapshot {
	if e == nil {
		return SlotStatsSnapshot{}
	}
	var out SlotStatsSnapshot
	out.Enabled = e.enabled
	if e.sem != nil {
		out.Active = len(e.sem)
		out.ConcurrencyLimit = cap(e.sem)
	}
	if e.slotStats == nil {
		return out
	}
	anon := e.slotStats.channels[chAnonIdx].snapshot()
	owner := e.slotStats.channels[chOwnerIdx].snapshot()
	waiting := e.slotStats.channels[chAnonIdx].waiting.Load() + e.slotStats.channels[chOwnerIdx].waiting.Load()
	if waiting < 0 {
		waiting = 0
	}
	out.Waiting = int(waiting)
	out.ByChannel = SlotChannelBreakdown{
		Anonymous: anon,
		Owner:     owner,
	}
	mergedHist := mergeHistogramSnapshots(anon.WaitMS, owner.WaitMS)
	out.Total = ChannelSlotStatsSnapshot{
		AcquiredCount: anon.AcquiredCount + owner.AcquiredCount,
		WaitCount:     mergedHist.Count,
		CanceledCount: anon.CanceledCount + owner.CanceledCount,
		WaitMSTotal:   mergedHist.SumMS,
		WaitMSMax:     mergedHist.MaxMS,
		WaitMS:        mergedHist,
	}
	return out
}
