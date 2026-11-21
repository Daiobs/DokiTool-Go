package api

import (
	"cmp"
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

const (
	// DefaultStatsLogInterval is the periodic single-line aggregate telemetry log interval in dokitool serve.
	DefaultStatsLogInterval = 5 * time.Minute

	// ChannelAnonymous identifies public visitor requests without DOKITOOL_OWNER_TOKEN.
	ChannelAnonymous = "anonymous"
	// ChannelOwner identifies requests authenticated via DOKITOOL_OWNER_TOKEN.
	ChannelOwner = "owner"

	// PlatformUnknown is the bounded fallback platform label for missing, malformed, or unsupported URLs.
	PlatformUnknown = "unknown"

	// OutcomeUnauthorized records HTTP 401 bearer authentication rejections in telemetry
	// while keeping the public unified-v1 HTTP wire code as INVALID_INPUT.
	OutcomeUnauthorized = "UNAUTHORIZED"

	maxSummaryLogOutcomes = 16
)

const (
	chAnonIdx  = 0
	chOwnerIdx = 1
	numCh      = 2

	numPlatforms    = 15
	numOutcomeCodes = 13
)

// HistogramBuckets aliases ytengine.HistogramBuckets so API telemetry shares one exact schema.
type HistogramBuckets = ytengine.HistogramBuckets

// HistogramSnapshot aliases ytengine.HistogramSnapshot so API telemetry shares one exact schema.
type HistogramSnapshot = ytengine.HistogramSnapshot

var knownPlatforms = [numPlatforms]string{
	"douyin",
	"bilibili",
	"weibo",
	"toutiao",
	"kuaishou",
	"pipixia",
	"pipigx",
	"zuiyou",
	"xiaohongshu",
	"x",
	"youtube",
	"instagram",
	"facebook",
	"tumblr",
	PlatformUnknown,
}

var knownOutcomeCodes = [numOutcomeCodes]string{
	"OK",
	"INVALID_INPUT",
	"UNSUPPORTED_PLATFORM",
	"NO_MEDIA",
	"CONTENT_UNAVAILABLE",
	"UPSTREAM_INVALID_RESPONSE",
	"UPSTREAM_UNAVAILABLE",
	"UPSTREAM_TIMEOUT",
	"UPSTREAM_BLOCKED",
	"RATE_LIMITED",
	"SERVICE_NOT_CONFIGURED",
	"INTERNAL_ERROR",
	OutcomeUnauthorized,
}

// KnownPlatforms returns a copy of the closed 15-element platform vocabulary (14 platforms + "unknown").
func KnownPlatforms() []string {
	out := make([]string, len(knownPlatforms))
	copy(out, knownPlatforms[:])
	return out
}

// KnownOutcomeCodes returns a copy of the closed 13-element outcome code vocabulary.
func KnownOutcomeCodes() []string {
	out := make([]string, len(knownOutcomeCodes))
	copy(out, knownOutcomeCodes[:])
	return out
}

func platformIndex(raw string) int {
	switch raw {
	case "douyin":
		return 0
	case "bilibili":
		return 1
	case "weibo":
		return 2
	case "toutiao":
		return 3
	case "kuaishou":
		return 4
	case "pipixia":
		return 5
	case "pipigx":
		return 6
	case "zuiyou":
		return 7
	case "xiaohongshu":
		return 8
	case "x":
		return 9
	case "youtube":
		return 10
	case "instagram":
		return 11
	case "facebook":
		return 12
	case "tumblr":
		return 13
	default:
		return 14 // PlatformUnknown
	}
}

// NormalizePlatform maps any platform string onto the closed 15-element set.
func NormalizePlatform(raw string) string {
	return knownPlatforms[platformIndex(raw)]
}

func outcomeCodeIndex(raw string) int {
	switch raw {
	case "OK":
		return 0
	case "INVALID_INPUT":
		return 1
	case "UNSUPPORTED_PLATFORM":
		return 2
	case "NO_MEDIA":
		return 3
	case "CONTENT_UNAVAILABLE":
		return 4
	case "UPSTREAM_INVALID_RESPONSE":
		return 5
	case "UPSTREAM_UNAVAILABLE":
		return 6
	case "UPSTREAM_TIMEOUT":
		return 7
	case "UPSTREAM_BLOCKED":
		return 8
	case "RATE_LIMITED":
		return 9
	case "SERVICE_NOT_CONFIGURED":
		return 10
	case "INTERNAL_ERROR":
		return 11
	case OutcomeUnauthorized:
		return 12
	default:
		return 11 // INTERNAL_ERROR
	}
}

// NormalizeOutcomeCode maps any outcome code string onto the closed 13-element set.
func NormalizeOutcomeCode(raw string) string {
	return knownOutcomeCodes[outcomeCodeIndex(raw)]
}

func channelIdx(raw string) int {
	if raw == ChannelOwner {
		return chOwnerIdx
	}
	return chAnonIdx
}

// NormalizeChannel maps any channel string onto "anonymous" or "owner".
func NormalizeChannel(raw string) string {
	if raw == ChannelOwner {
		return ChannelOwner
	}
	return ChannelAnonymous
}

// ChannelFromContext returns "owner" when ctx was authenticated via DOKITOOL_OWNER_TOKEN, else "anonymous".
func ChannelFromContext(ctx context.Context) string {
	if IsOwnerRequest(ctx) {
		return ChannelOwner
	}
	return ChannelAnonymous
}

type parseWallStartKey struct{}

func withParseWallStart(ctx context.Context, start time.Time) context.Context {
	return context.WithValue(ctx, parseWallStartKey{}, start)
}

func parseWallStartFromContext(ctx context.Context, fallback func() time.Time) time.Time {
	if ctx != nil {
		if t, ok := ctx.Value(parseWallStartKey{}).(time.Time); ok && !t.IsZero() {
			return t
		}
	}
	if fallback != nil {
		return fallback()
	}
	return time.Now()
}

var latencyBucketBounds = [10]time.Duration{
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

type apiAtomicHistogram struct {
	sumNs atomic.Uint64
	maxNs atomic.Uint64
	bins  [11]atomic.Uint64
}

func (h *apiAtomicHistogram) observe(d time.Duration) {
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
	idx := len(latencyBucketBounds)
	for i, bound := range latencyBucketBounds {
		if d <= bound {
			idx = i
			break
		}
	}
	h.bins[idx].Add(1)
}

func (h *apiAtomicHistogram) snapshot() HistogramSnapshot {
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

func mergeHistograms(a, b HistogramSnapshot) HistogramSnapshot {
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

func histogramQuantileUpperBound(h HistogramSnapshot, pct uint64) string {
	if h.Count == 0 {
		return "0"
	}
	target := (h.Count*pct + 99) / 100
	if target == 0 {
		target = 1
	}
	steps := [11]struct {
		label string
		cum   uint64
	}{
		{"10", h.Buckets.LE10},
		{"50", h.Buckets.LE50},
		{"100", h.Buckets.LE100},
		{"250", h.Buckets.LE250},
		{"500", h.Buckets.LE500},
		{"1000", h.Buckets.LE1000},
		{"2500", h.Buckets.LE2500},
		{"5000", h.Buckets.LE5000},
		{"10000", h.Buckets.LE10000},
		{"30000", h.Buckets.LE30000},
		{"+Inf", h.Buckets.Inf},
	}
	for _, s := range steps {
		if s.cum >= target {
			return s.label
		}
	}
	return "+Inf"
}

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

// AdmissionStatsSnapshot summarizes the three queued admission pools (fast, slow, owner).
type AdmissionStatsSnapshot struct {
	Fast  AdmissionPoolSnapshot `json:"fast"`
	Slow  AdmissionPoolSnapshot `json:"slow"`
	Owner AdmissionPoolSnapshot `json:"owner"`
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

// StatsSnapshot is the read-only data payload returned by GET /api/stats.
type StatsSnapshot struct {
	StartedAt      string                     `json:"started_at"`
	GeneratedAt    string                     `json:"generated_at"`
	UptimeSeconds  int64                      `json:"uptime_seconds"`
	Requests       RequestStatsSnapshot       `json:"requests"`
	Cache          CacheStatsSnapshot         `json:"cache"`
	Admission      AdmissionStatsSnapshot     `json:"admission"`
	APIKeys        []APIKeyStatsSnapshot      `json:"api_keys"`
	YTDLP          ytengine.SlotStatsSnapshot `json:"ytdlp"`
	Shanghai       shresolver.StatsSnapshot   `json:"shanghai"`
	ParseLatencyMS LatencyStatsSnapshot       `json:"parse_latency_ms"`
}

type cacheAtomicCounters struct {
	hits               atomic.Uint64
	misses             atomic.Uint64
	singleflightShared atomic.Uint64
	uncacheable        atomic.Uint64
}

func (c *cacheAtomicCounters) snapshot() CacheChannelCounts {
	return CacheChannelCounts{
		Hits:               c.hits.Load(),
		Misses:             c.misses.Load(),
		SingleflightShared: c.singleflightShared.Load(),
		Uncacheable:        c.uncacheable.Load(),
	}
}

// Stats collects bounded-cardinality in-process aggregate telemetry across admission,
// caching/singleflight, yt-dlp concurrency slots, and Shanghai resolution.
type Stats struct {
	startedAt time.Time
	clock     func() time.Time

	outcomes [numPlatforms][numOutcomeCodes][numCh]atomic.Uint64
	cacheCh  [numCh]cacheAtomicCounters
	latency  [numCh]apiAtomicHistogram

	mu       sync.RWMutex
	cacheSrc *parseCache
	admSrc   *admission
	ytdlpSrc *ytengine.Engine
	shSrc    shresolver.StatsProvider
}

// NewStats constructs an in-process aggregate telemetry collector.
// When clock is nil, time.Now is used.
func NewStats(clock func() time.Time) *Stats {
	if clock == nil {
		clock = time.Now
	}
	return &Stats{
		startedAt: clock().UTC(),
		clock:     clock,
	}
}

func (s *Stats) now() time.Time {
	if s == nil || s.clock == nil {
		return time.Now()
	}
	return s.clock()
}

func (s *Stats) setCacheSource(c *parseCache) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.cacheSrc = c
	s.mu.Unlock()
}

func (s *Stats) setAdmissionSource(a *admission) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.admSrc = a
	s.mu.Unlock()
}

// SetYTDLPEngine binds the shared yt-dlp Engine so Snapshot and periodic summaries
// include per-channel yt-dlp slot contention counters and live gauges.
func (s *Stats) SetYTDLPEngine(engine *ytengine.Engine) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.ytdlpSrc = engine
	s.mu.Unlock()
}

// SetShanghaiSource binds the Shanghai resolver (*shresolver.PullBroker or *shresolver.Client)
// so Snapshot and periodic summaries include Shanghai hits, queue waits, and fallbacks.
func (s *Stats) SetShanghaiSource(provider shresolver.StatsProvider) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.shSrc = provider
	s.mu.Unlock()
}

// RecordParse records one completed /api/parse or /api/resolve outcome and its latency
// using strictly closed platform, code, and channel indices.
func (s *Stats) RecordParse(platform, code, channel string, elapsed time.Duration) {
	if s == nil {
		return
	}
	pIdx := platformIndex(platform)
	cIdx := outcomeCodeIndex(code)
	ch := channelIdx(channel)
	s.outcomes[pIdx][cIdx][ch].Add(1)
	s.latency[ch].observe(elapsed)
}

func (s *Stats) recordCacheHit(channel string) {
	if s == nil {
		return
	}
	s.cacheCh[channelIdx(channel)].hits.Add(1)
}

func (s *Stats) recordCacheMiss(channel string) {
	if s == nil {
		return
	}
	s.cacheCh[channelIdx(channel)].misses.Add(1)
}

func (s *Stats) recordSingleflightShared(channel string) {
	if s == nil {
		return
	}
	s.cacheCh[channelIdx(channel)].singleflightShared.Add(1)
}

func (s *Stats) recordCacheUncacheable(channel string) {
	if s == nil {
		return
	}
	s.cacheCh[channelIdx(channel)].uncacheable.Add(1)
}

// Snapshot captures a point-in-time read-only view of all aggregate counters and gauges.
func (s *Stats) Snapshot() StatsSnapshot {
	if s == nil {
		now := time.Now().UTC().Format(time.RFC3339)
		return StatsSnapshot{
			StartedAt:   now,
			GeneratedAt: now,
			Requests: RequestStatsSnapshot{
				ByPlatformCodeChannel: make([]PlatformOutcomeCount, 0),
			},
			APIKeys:  make([]APIKeyStatsSnapshot, 0),
			Shanghai: shresolver.StatsSnapshot{Mode: "off"},
		}
	}

	now := s.now().UTC()
	uptime := int64(now.Sub(s.startedAt).Seconds())
	if uptime < 0 {
		uptime = 0
	}

	var anonReq, ownerReq uint64
	cells := make([]PlatformOutcomeCount, 0, 16)
	for p := 0; p < numPlatforms; p++ {
		for c := 0; c < numOutcomeCodes; c++ {
			anonCount := s.outcomes[p][c][chAnonIdx].Load()
			if anonCount > 0 {
				anonReq += anonCount
				cells = append(cells, PlatformOutcomeCount{
					Platform: knownPlatforms[p],
					Code:     knownOutcomeCodes[c],
					Channel:  ChannelAnonymous,
					Count:    anonCount,
				})
			}
			ownerCount := s.outcomes[p][c][chOwnerIdx].Load()
			if ownerCount > 0 {
				ownerReq += ownerCount
				cells = append(cells, PlatformOutcomeCount{
					Platform: knownPlatforms[p],
					Code:     knownOutcomeCodes[c],
					Channel:  ChannelOwner,
					Count:    ownerCount,
				})
			}
		}
	}

	cacheAnon := s.cacheCh[chAnonIdx].snapshot()
	cacheOwner := s.cacheCh[chOwnerIdx].snapshot()
	cacheSnap := CacheStatsSnapshot{
		Total: CacheChannelCounts{
			Hits:               cacheAnon.Hits + cacheOwner.Hits,
			Misses:             cacheAnon.Misses + cacheOwner.Misses,
			SingleflightShared: cacheAnon.SingleflightShared + cacheOwner.SingleflightShared,
			Uncacheable:        cacheAnon.Uncacheable + cacheOwner.Uncacheable,
		},
		ByChannel: CacheChannelBreakdown{
			Anonymous: cacheAnon,
			Owner:     cacheOwner,
		},
	}

	s.mu.RLock()
	cacheSrc := s.cacheSrc
	admSrc := s.admSrc
	ytdlpSrc := s.ytdlpSrc
	shSrc := s.shSrc
	s.mu.RUnlock()

	if cacheSrc != nil {
		cacheSnap.Enabled, cacheSnap.Entries, cacheSnap.Bytes, cacheSnap.MaxEntries, cacheSnap.MaxBytes = cacheSrc.configSnapshot()
	}

	var admSnap AdmissionStatsSnapshot
	apiKeys := make([]APIKeyStatsSnapshot, 0)
	if admSrc != nil {
		admSnap = admSrc.statsSnapshot()
		apiKeys = admSrc.apiKeysStatsSnapshot()
	}

	var ytdlpSnap ytengine.SlotStatsSnapshot
	if ytdlpSrc != nil {
		ytdlpSnap = ytdlpSrc.StatsSnapshot()
	}

	shSnap := shresolver.StatsSnapshot{Mode: "off"}
	if shSrc != nil {
		shSnap = shSrc.ShanghaiStatsSnapshot()
	}

	latAnon := s.latency[chAnonIdx].snapshot()
	latOwner := s.latency[chOwnerIdx].snapshot()
	latTotal := mergeHistograms(latAnon, latOwner)

	return StatsSnapshot{
		StartedAt:     s.startedAt.Format(time.RFC3339),
		GeneratedAt:   now.Format(time.RFC3339),
		UptimeSeconds: uptime,
		Requests: RequestStatsSnapshot{
			Total:                 anonReq + ownerReq,
			ByChannel:             RequestChannelBreakdown{Anonymous: anonReq, Owner: ownerReq},
			ByPlatformCodeChannel: cells,
		},
		Cache:     cacheSnap,
		Admission: admSnap,
		APIKeys:   apiKeys,
		YTDLP:     ytdlpSnap,
		Shanghai:  shSnap,
		ParseLatencyMS: LatencyStatsSnapshot{
			Total:     latTotal,
			ByChannel: LatencyChannelBreakdown{Anonymous: latAnon, Owner: latOwner},
		},
	}
}

// Envelope wraps Snapshot in the standard DokiTool JSON envelope for GET /api/stats.
func (s *Stats) Envelope() unified.Object {
	return unified.Object{
		"schema_version": unified.SchemaVersion,
		"code":           "OK",
		"data":           s.Snapshot(),
	}
}

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
			"cache_hits=%d win_cache_hits=%d cache_misses=%d cache_sf=%d cache_uncacheable=%d cache_entries=%d cache_bytes=%d "+
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
		snap.Cache.Total.Hits, winHits, snap.Cache.Total.Misses, snap.Cache.Total.SingleflightShared, snap.Cache.Total.Uncacheable, snap.Cache.Entries, snap.Cache.Bytes,
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
