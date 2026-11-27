package api

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
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

	// PlatformYTDLPOther is the bounded spill bucket for valid dynamic platform keys beyond MaxDynamicPlatforms.
	PlatformYTDLPOther = "ytdlp_other"

	// PlatformYTDLPUnmatched is the dedicated bounded telemetry bucket for Tier-2 generic parse
	// failures where no named yt-dlp extractor matched (decoupled from pre-routing "unknown").
	PlatformYTDLPUnmatched = "ytdlp_unmatched"

	// MaxDynamicPlatforms caps the number of distinct non-core dynamic platform keys retained in telemetry.
	MaxDynamicPlatforms = 64

	// DailyStatsWindowDays is the fixed number of Asia/Shanghai calendar days retained in daily stats.
	DailyStatsWindowDays = 30

	// HourlyStatsWindowHours is the fixed number of Asia/Shanghai clock hours retained in hourly stats.
	HourlyStatsWindowHours = 24

	// OutcomeUnauthorized records HTTP 401 bearer authentication rejections in telemetry
	// while keeping the public unified-v1 HTTP wire code as INVALID_INPUT.
	OutcomeUnauthorized = "UNAUTHORIZED"

	maxSummaryLogOutcomes = 16
)

const (
	chAnonIdx  = 0
	chOwnerIdx = 1
	numCh      = 2

	numCorePlatforms   = 15
	platformUnknownIdx = 15
	numPlatforms       = 16

	outcomeOKIdx          = 0
	outcomeInternalErrIdx = 11
	numOutcomeCodes       = 13

	shanghaiOffsetSeconds int64 = 8 * 3600
)

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
	"pinterest",
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

// KnownPlatforms returns a copy of the closed 16-element platform vocabulary (15 platforms + "unknown").
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

func corePlatformIndex(raw string) int {
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
	case "pinterest":
		return 9
	case "x":
		return 10
	case "youtube":
		return 11
	case "instagram":
		return 12
	case "facebook":
		return 13
	case "tumblr":
		return 14
	default:
		return -1
	}
}

func platformIndex(raw string) int {
	if idx := corePlatformIndex(raw); idx >= 0 {
		return idx
	}
	return platformUnknownIdx
}

// IsValidDynamicPlatformKey reports whether raw is a valid bounded dynamic platform identifier
// matching ^[a-z0-9][a-z0-9_:-]{0,31}$ and excluding reserved meta tokens ("", "all", "unknown").
func IsValidDynamicPlatformKey(raw string) bool {
	if len(raw) == 0 || len(raw) > 32 {
		return false
	}
	if raw == "all" || raw == PlatformUnknown {
		return false
	}
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		isLower := c >= 'a' && c <= 'z'
		isDigit := c >= '0' && c <= '9'
		if i == 0 {
			if !isLower && !isDigit {
				return false
			}
			continue
		}
		if !isLower && !isDigit && c != '_' && c != ':' && c != '-' {
			return false
		}
	}
	return true
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

type cacheAtomicCounters struct {
	hits               atomic.Uint64
	staleHits          atomic.Uint64
	misses             atomic.Uint64
	singleflightShared atomic.Uint64
	uncacheable        atomic.Uint64
}

func (c *cacheAtomicCounters) snapshot() CacheChannelCounts {
	return CacheChannelCounts{
		Hits:               c.hits.Load(),
		StaleHits:          c.staleHits.Load(),
		Misses:             c.misses.Load(),
		SingleflightShared: c.singleflightShared.Load(),
		Uncacheable:        c.uncacheable.Load(),
	}
}

type dynamicPlatformCounters struct {
	outcomes [numOutcomeCodes][numCh]uint64
}

// Stats collects bounded-cardinality in-process aggregate telemetry across admission,
// caching/singleflight, yt-dlp concurrency slots, Shanghai resolution, and Asia/Shanghai time windows.
type Stats struct {
	startedAt time.Time
	clock     func() time.Time

	outcomes [numPlatforms][numOutcomeCodes][numCh]atomic.Uint64
	cacheCh  [numCh]cacheAtomicCounters
	latency  [numCh]apiAtomicHistogram
	hasShSrc atomic.Bool

	saveMu sync.Mutex

	mu                     sync.RWMutex
	cacheSrc               *parseCache
	admSrc                 *admission
	cbSrc                  *circuitBreakerManager
	ytdlpSrc               *ytengine.Engine
	ytdlpGenericSrc        YTDLPStatsSource
	ytdlpCompartmentsWired bool
	ytdlpYoutubeSrc        YTDLPStatsSource
	ytdlpSocialSrc         YTDLPStatsSource
	ytdlpGenericCompSrc    YTDLPStatsSource
	ytHelperSrc            YouTubeHelperStatsSource
	shSrc                  shresolver.StatsProvider
	shSrcGen               uint64
	lastSyncedShanghaiHits uint64
	runtimeCfg             RuntimeConfigSnapshot
	runtimePolicy          RuntimePolicySummary

	dynamicPlatforms map[string]*dynamicPlatformCounters
	dynamicOther     dynamicPlatformCounters
	dynamicUnmatched dynamicPlatformCounters
	daily            [DailyStatsWindowDays]dailyBucket
	hourly           [HourlyStatsWindowHours]hourlyBucket
}

// NewStats constructs an in-process aggregate telemetry collector.
// When clock is nil, time.Now is used.
func NewStats(clock func() time.Time) *Stats {
	if clock == nil {
		clock = time.Now
	}
	return &Stats{
		startedAt:        clock().UTC(),
		clock:            clock,
		runtimePolicy:    defaultRuntimePolicySummary(),
		dynamicPlatforms: make(map[string]*dynamicPlatformCounters),
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

func (s *Stats) setCircuitBreakerSource(cb *circuitBreakerManager) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.cbSrc = cb
	s.mu.Unlock()
}

func sanitizeYTDLPStatsSource(src YTDLPStatsSource) YTDLPStatsSource {
	if eng, ok := src.(*ytengine.Engine); ok && eng == nil {
		return nil
	}
	return src
}

// SetYTDLPCompartmentSources binds optional per-compartment yt-dlp slot stats
// sources (youtube, social, generic) so GET /api/stats reflects both admission
// and ytengine compartment slot watermarks.
func (s *Stats) SetYTDLPCompartmentSources(youtube, social, generic YTDLPStatsSource) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.ytdlpCompartmentsWired = true
	s.ytdlpYoutubeSrc = sanitizeYTDLPStatsSource(youtube)
	s.ytdlpSocialSrc = sanitizeYTDLPStatsSource(social)
	s.ytdlpGenericCompSrc = sanitizeYTDLPStatsSource(generic)
	s.mu.Unlock()
}

func (s *Stats) syncRuntimePolicyFromAdmissionConfig(cfg AdmissionConfig) {
	if s == nil {
		return
	}
	s.mu.Lock()
	if !s.runtimePolicy.ConfigFileActive {
		if cfg.YouTubeSlowParse.GlobalConcurrency >= 1 {
			s.runtimePolicy.YouTubeSlots = cfg.YouTubeSlowParse.GlobalConcurrency
		}
		if cfg.SlowParse.GlobalConcurrency >= 1 {
			s.runtimePolicy.SocialSlots = cfg.SlowParse.GlobalConcurrency
		}
		if cfg.GenericSlowParse.GlobalConcurrency >= 1 {
			s.runtimePolicy.GenericSlots = cfg.GenericSlowParse.GlobalConcurrency
		}
		if cfg.YouTubeEJS.GlobalConcurrency >= 1 {
			s.runtimePolicy.YouTubeEJSConcurrency = cfg.YouTubeEJS.GlobalConcurrency
		}
		if cfg.FastPerPlatformMaxConcurrency >= MinFastPerPlatformMaxConcurrency {
			s.runtimePolicy.FastPerPlatformMaxConcurrency = cfg.FastPerPlatformMaxConcurrency
		}
	}
	s.mu.Unlock()
}

func (s *Stats) applyRuntimePolicy(cfg RuntimeConfig, fromFile bool, isReload bool) {
	if s == nil {
		return
	}
	nowStr := s.now().UTC().Format(time.RFC3339)
	s.mu.Lock()
	reloadCount := s.runtimePolicy.ReloadCount
	lastReloadedAt := s.runtimePolicy.LastReloadedAt
	if isReload {
		reloadCount++
		lastReloadedAt = nowStr
	}
	s.runtimePolicy = runtimePolicySummaryFromConfig(cfg, fromFile, reloadCount, lastReloadedAt)
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

// SetGenericYTDLPEngine binds the isolated Tier-2 generic yt-dlp slot stats source
// so Snapshot includes per-channel generic slot gauges and wait counters.
func (s *Stats) SetGenericYTDLPEngine(src YTDLPStatsSource) {
	if s == nil {
		return
	}
	if eng, ok := src.(*ytengine.Engine); ok && eng == nil {
		src = nil
	}
	s.mu.Lock()
	s.ytdlpGenericSrc = src
	s.mu.Unlock()
}

// SetYouTubeHelperSource binds the YouTube helper stats source so GET /api/stats
// exposes proactive refresh counts, cooldown skips, active variant, and challenge LRU telemetry.
func (s *Stats) SetYouTubeHelperSource(src YouTubeHelperStatsSource) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.ytHelperSrc = src
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
	s.shSrcGen++
	s.lastSyncedShanghaiHits = 0
	s.mu.Unlock()
	s.hasShSrc.Store(provider != nil)
}

// SetRuntimeConfig records the strictly redacted read-only runtime switches exposed by GET /api/stats.
func (s *Stats) SetRuntimeConfig(cfg RuntimeConfigSnapshot) {
	if s == nil {
		return
	}
	cfg.Version = sanitizeVersionString(cfg.Version)
	cfg.ShanghaiMode = normalizeShanghaiMode(cfg.ShanghaiMode)
	cfg.XHSTransport = normalizeXHSTransport(cfg.XHSTransport)
	s.mu.Lock()
	s.runtimeCfg = cfg
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

	now := s.now()
	shSnap, shGen, hasSh := s.readShanghaiSnapshot()
	s.mu.Lock()
	s.recordWindowOutcomeLocked(now, knownPlatforms[pIdx], cIdx, elapsed)
	s.applyShanghaiDeltaLocked(now, shSnap, shGen, hasSh)
	s.mu.Unlock()
}

// RecordDynamicParse records one completed parse outcome supporting both core platforms and
// bounded dynamic platform keys (up to MaxDynamicPlatforms distinct keys; excess keys spill to ytdlp_other).
func (s *Stats) RecordDynamicParse(platform, code, channel string, elapsed time.Duration) {
	if s == nil {
		return
	}
	cIdx := outcomeCodeIndex(code)
	ch := channelIdx(channel)
	s.latency[ch].observe(elapsed)

	now := s.now()
	shSnap, shGen, hasSh := s.readShanghaiSnapshot()

	if pIdx := corePlatformIndex(platform); pIdx >= 0 {
		s.outcomes[pIdx][cIdx][ch].Add(1)
		s.mu.Lock()
		s.recordWindowOutcomeLocked(now, knownPlatforms[pIdx], cIdx, elapsed)
		s.applyShanghaiDeltaLocked(now, shSnap, shGen, hasSh)
		s.mu.Unlock()
		return
	}
	if !IsValidDynamicPlatformKey(platform) {
		s.outcomes[platformUnknownIdx][cIdx][ch].Add(1)
		s.mu.Lock()
		s.recordWindowOutcomeLocked(now, PlatformUnknown, cIdx, elapsed)
		s.applyShanghaiDeltaLocked(now, shSnap, shGen, hasSh)
		s.mu.Unlock()
		return
	}

	s.mu.Lock()
	recordedPlat := platform
	if platform == PlatformYTDLPOther {
		s.dynamicOther.outcomes[cIdx][ch]++
	} else if platform == PlatformYTDLPUnmatched {
		s.dynamicUnmatched.outcomes[cIdx][ch]++
	} else {
		if s.dynamicPlatforms == nil {
			s.dynamicPlatforms = make(map[string]*dynamicPlatformCounters)
		}
		rec, exists := s.dynamicPlatforms[platform]
		if !exists {
			if len(s.dynamicPlatforms) < MaxDynamicPlatforms {
				rec = &dynamicPlatformCounters{}
				s.dynamicPlatforms[platform] = rec
			} else {
				recordedPlat = PlatformYTDLPOther
			}
		}
		if rec != nil {
			rec.outcomes[cIdx][ch]++
		} else {
			s.dynamicOther.outcomes[cIdx][ch]++
		}
	}
	s.recordWindowOutcomeLocked(now, recordedPlat, cIdx, elapsed)
	s.applyShanghaiDeltaLocked(now, shSnap, shGen, hasSh)
	s.mu.Unlock()
}

func (s *Stats) recordCacheHit(channel string) {
	if s == nil {
		return
	}
	s.cacheCh[channelIdx(channel)].hits.Add(1)
	now := s.now()
	s.mu.Lock()
	s.getDailyBucketLocked(now).cacheHits++
	s.getHourlyBucketLocked(now).cacheHits++
	s.mu.Unlock()
}

func (s *Stats) recordCacheStaleHit(channel string) {
	if s == nil {
		return
	}
	s.cacheCh[channelIdx(channel)].staleHits.Add(1)
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
