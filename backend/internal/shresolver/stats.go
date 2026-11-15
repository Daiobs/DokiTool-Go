package shresolver

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
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
// so Shanghai resolution outcomes can be attributed per channel without import cycles.
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

	platDouyinIdx   = 0
	platBilibiliIdx = 1
	numPlat         = 2
)

func channelIndex(channel string) int {
	if channel == ChannelOwner {
		return chOwnerIdx
	}
	return chAnonIdx
}

type queueOutcome uint8

const (
	queueOutcomeOther queueOutcome = iota
	queueOutcomeGranted
	queueOutcomeTimeout
	queueOutcomeCanceled
)

// ChannelStatsSnapshot reports Shanghai resolution outcomes and 300ms broker queue
// wait metrics for one channel (or the sum across channels).
type ChannelStatsSnapshot struct {
	Hits             uint64 `json:"hits"`
	Fallbacks        uint64 `json:"fallbacks"`
	Canceled         uint64 `json:"canceled"`
	QueueWaits       uint64 `json:"queue_waits"`
	QueueGranted     uint64 `json:"queue_granted"`
	QueueTimeouts    uint64 `json:"queue_timeouts"`
	QueueWaitMSTotal uint64 `json:"queue_wait_ms_total"`
	QueueWaitMSMax   uint64 `json:"queue_wait_ms_max"`
}

// ChannelBreakdown separates Shanghai resolution metrics between anonymous visitors and owner callers.
type ChannelBreakdown struct {
	Anonymous ChannelStatsSnapshot `json:"anonymous"`
	Owner     ChannelStatsSnapshot `json:"owner"`
}

// PlatformBreakdown separates Shanghai resolution metrics by platform (Douyin vs Bilibili).
type PlatformBreakdown struct {
	Douyin   ChannelStatsSnapshot `json:"douyin"`
	Bilibili ChannelStatsSnapshot `json:"bilibili"`
}

// StatsSnapshot reports live gauges and cumulative counters for the Shanghai domestic exit channel.
type StatsSnapshot struct {
	Enabled        bool                 `json:"enabled"`
	Mode           string               `json:"mode"`
	WaitingWorkers int                  `json:"waiting_workers"`
	QueuedTasks    int                  `json:"queued_tasks"`
	PendingTasks   int                  `json:"pending_tasks"`
	Total          ChannelStatsSnapshot `json:"total"`
	ByChannel      ChannelBreakdown     `json:"by_channel"`
	ByPlatform     PlatformBreakdown    `json:"by_platform"`
}

// StatsProvider is implemented by Shanghai resolvers (*PullBroker and *Client)
// that expose aggregate telemetry snapshots.
type StatsProvider interface {
	ShanghaiStatsSnapshot() StatsSnapshot
}

type channelCounters struct {
	hits           atomic.Uint64
	fallbacks      atomic.Uint64
	canceled       atomic.Uint64
	queueWaits     atomic.Uint64
	queueGranted   atomic.Uint64
	queueTimeouts  atomic.Uint64
	queueWaitNsSum atomic.Uint64
	queueWaitNsMax atomic.Uint64
}

func (c *channelCounters) snapshot() ChannelStatsSnapshot {
	return ChannelStatsSnapshot{
		Hits:             c.hits.Load(),
		Fallbacks:        c.fallbacks.Load(),
		Canceled:         c.canceled.Load(),
		QueueWaits:       c.queueWaits.Load(),
		QueueGranted:     c.queueGranted.Load(),
		QueueTimeouts:    c.queueTimeouts.Load(),
		QueueWaitMSTotal: c.queueWaitNsSum.Load() / 1_000_000,
		QueueWaitMSMax:   c.queueWaitNsMax.Load() / 1_000_000,
	}
}

type shanghaiCounters struct {
	channels  [numCh]channelCounters
	platforms [numPlat]channelCounters
}

func recordCounterQueueWait(c *channelCounters, d time.Duration, outcome queueOutcome) {
	c.queueWaits.Add(1)
	switch outcome {
	case queueOutcomeGranted:
		c.queueGranted.Add(1)
	case queueOutcomeTimeout:
		c.queueTimeouts.Add(1)
	}
	ns := uint64(d.Nanoseconds())
	c.queueWaitNsSum.Add(ns)
	for {
		cur := c.queueWaitNsMax.Load()
		if ns <= cur || c.queueWaitNsMax.CompareAndSwap(cur, ns) {
			break
		}
	}
}

func (s *shanghaiCounters) recordQueueWait(chIdx, platIdx int, d time.Duration, outcome queueOutcome) {
	if d < 0 {
		d = 0
	}
	recordCounterQueueWait(&s.channels[chIdx], d, outcome)
	recordCounterQueueWait(&s.platforms[platIdx], d, outcome)
}

func (s *shanghaiCounters) recordResolveOutcome(parent context.Context, platIdx int, err error) {
	chIdx := channelIndex(ChannelFromContext(parent))
	if err == nil {
		s.channels[chIdx].hits.Add(1)
		s.platforms[platIdx].hits.Add(1)
		return
	}
	if errors.Is(err, douyin.ErrProtocolV1) {
		return
	}
	if parent != nil && parent.Err() != nil {
		s.channels[chIdx].canceled.Add(1)
		s.platforms[platIdx].canceled.Add(1)
		return
	}
	s.channels[chIdx].fallbacks.Add(1)
	s.platforms[platIdx].fallbacks.Add(1)
}

func (s *shanghaiCounters) platformBreakdown() PlatformBreakdown {
	return PlatformBreakdown{
		Douyin:   s.platforms[platDouyinIdx].snapshot(),
		Bilibili: s.platforms[platBilibiliIdx].snapshot(),
	}
}

func (s *shanghaiCounters) snapshot(mode string, waitingWorkers, queuedTasks, pendingTasks int) StatsSnapshot {
	anon := s.channels[chAnonIdx].snapshot()
	owner := s.channels[chOwnerIdx].snapshot()
	return StatsSnapshot{
		Enabled:        true,
		Mode:           mode,
		WaitingWorkers: waitingWorkers,
		QueuedTasks:    queuedTasks,
		PendingTasks:   pendingTasks,
		ByChannel: ChannelBreakdown{
			Anonymous: anon,
			Owner:     owner,
		},
		ByPlatform: s.platformBreakdown(),
		Total: ChannelStatsSnapshot{
			Hits:             anon.Hits + owner.Hits,
			Fallbacks:        anon.Fallbacks + owner.Fallbacks,
			Canceled:         anon.Canceled + owner.Canceled,
			QueueWaits:       anon.QueueWaits + owner.QueueWaits,
			QueueGranted:     anon.QueueGranted + owner.QueueGranted,
			QueueTimeouts:    anon.QueueTimeouts + owner.QueueTimeouts,
			QueueWaitMSTotal: anon.QueueWaitMSTotal + owner.QueueWaitMSTotal,
			QueueWaitMSMax:   max(anon.QueueWaitMSMax, owner.QueueWaitMSMax),
		},
	}
}
