package api

import (
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const (
	// CircuitStateClosed indicates normal upstream operation.
	CircuitStateClosed = "closed"
	// CircuitStateOpen indicates fast-fail / stale-fallback protection is active.
	CircuitStateOpen = "open"
	// CircuitStateHalfOpen indicates bounded recovery probing is active.
	CircuitStateHalfOpen = "half_open"

	disabledPlatformRetryAfterSeconds = 30
)

var platformChineseNames = map[string]string{
	"douyin":        "抖音",
	"bilibili":      "B站",
	"weibo":         "微博",
	"toutiao":       "今日头条",
	"kuaishou":      "快手",
	"pipixia":       "皮皮虾",
	"pipigx":        "皮皮搞笑",
	"zuiyou":        "最右",
	"xiaohongshu":   "小红书",
	"pinterest":     "Pinterest",
	"tiktok":        "TikTok",
	"x":             "X",
	"youtube":       "YouTube",
	"instagram":     "Instagram",
	"facebook":      "Facebook",
	"tumblr":        "Tumblr",
	PlatformGeneric: "通用平台",
}

func platformDisplayName(platform string) string {
	if name, ok := platformChineseNames[platform]; ok {
		return name
	}
	return platform
}

// isCircuitBreakerFailure reports whether code represents a genuine upstream or
// system failure eligible to trip the platform circuit breaker.
// User input errors and content-level states (INVALID_INPUT, UNSUPPORTED_PLATFORM,
// NO_MEDIA, CONTENT_UNAVAILABLE, UPSTREAM_BLOCKED, UNAUTHORIZED, RATE_LIMITED)
// are strictly excluded to prevent false positives.
func isCircuitBreakerFailure(code string) bool {
	switch code {
	case "UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE", "UPSTREAM_INVALID_RESPONSE", "INTERNAL_ERROR":
		return true
	default:
		return false
	}
}

type circuitSample struct {
	failed bool
	at     time.Time
}

type platformCircuitState struct {
	state               string
	consecutiveFailures int
	lastFailureAt       time.Time
	window              []circuitSample
	windowHead          int
	windowCount         int
	windowFailures      int
	openUntil           time.Time
	halfOpenInFlight    int
	halfOpenGen         uint64
}

func newPlatformCircuitState(windowSize int) *platformCircuitState {
	if windowSize < 1 {
		windowSize = 1
	}
	return &platformCircuitState{
		state:  CircuitStateClosed,
		window: make([]circuitSample, windowSize),
	}
}

func (s *platformCircuitState) resizeWindow(newSize int) {
	if newSize < 1 {
		newSize = 1
	}
	if len(s.window) == newSize {
		return
	}
	// Preserve the most recent min(windowCount, newSize) samples in chronological order.
	keep := s.windowCount
	if keep > newSize {
		keep = newSize
	}
	startOffset := s.windowCount - keep
	next := make([]circuitSample, newSize)
	failures := 0
	oldLen := len(s.window)
	for i := 0; i < keep; i++ {
		val := s.window[(s.windowHead+startOffset+i)%oldLen]
		next[i] = val
		if val.failed {
			failures++
		}
	}
	s.window = next
	s.windowHead = 0
	s.windowCount = keep
	s.windowFailures = failures
}

func (s *platformCircuitState) pruneExpired(now time.Time, maxAge time.Duration) {
	if maxAge <= 0 {
		return
	}
	cutoff := now.Add(-maxAge)
	n := len(s.window)
	for s.windowCount > 0 && n > 0 {
		oldest := s.window[s.windowHead]
		if !oldest.at.Before(cutoff) {
			break
		}
		if oldest.failed {
			s.windowFailures--
		}
		s.window[s.windowHead] = circuitSample{}
		s.windowHead = (s.windowHead + 1) % n
		s.windowCount--
	}
	if s.windowCount == 0 {
		s.windowHead = 0
		s.windowFailures = 0
	}
	if !s.lastFailureAt.IsZero() && now.Sub(s.lastFailureAt) > maxAge {
		s.consecutiveFailures = 0
		s.lastFailureAt = time.Time{}
	}
}

func (s *platformCircuitState) pushSample(failed bool, at time.Time) {
	n := len(s.window)
	if n == 0 {
		return
	}
	sample := circuitSample{failed: failed, at: at}
	if s.windowCount < n {
		idx := (s.windowHead + s.windowCount) % n
		s.window[idx] = sample
		s.windowCount++
		if failed {
			s.windowFailures++
		}
		return
	}
	if s.window[s.windowHead].failed {
		s.windowFailures--
	}
	s.window[s.windowHead] = sample
	if failed {
		s.windowFailures++
	}
	s.windowHead = (s.windowHead + 1) % n
}

func (s *platformCircuitState) resetWindow() {
	for i := range s.window {
		s.window[i] = circuitSample{}
	}
	s.windowHead = 0
	s.windowCount = 0
	s.windowFailures = 0
}

type circuitBreakerManager struct {
	mu       sync.Mutex
	cfg      CircuitBreakerConfig
	disabled map[string]struct{}
	states   map[string]*platformCircuitState
}

func newCircuitBreakerManager(cfg CircuitBreakerConfig) *circuitBreakerManager {
	if cfg.WindowSize < 1 {
		cfg = DefaultRuntimeConfig().CircuitBreaker
	}
	m := &circuitBreakerManager{
		cfg:      cfg,
		disabled: make(map[string]struct{}, len(cfg.DisabledPlatforms)),
		states:   make(map[string]*platformCircuitState, numCorePlatforms+1),
	}
	for _, p := range cfg.DisabledPlatforms {
		m.disabled[p] = struct{}{}
	}
	for i := 0; i < numCorePlatforms; i++ {
		m.states[knownPlatforms[i]] = newPlatformCircuitState(cfg.WindowSize)
	}
	m.states[PlatformGeneric] = newPlatformCircuitState(cfg.WindowSize)
	return m
}

func (m *circuitBreakerManager) UpdateConfig(cfg CircuitBreakerConfig) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cfg = cfg
	nextDisabled := make(map[string]struct{}, len(cfg.DisabledPlatforms))
	for _, p := range cfg.DisabledPlatforms {
		nextDisabled[p] = struct{}{}
	}
	m.disabled = nextDisabled
	for _, st := range m.states {
		st.resizeWindow(cfg.WindowSize)
		if !cfg.Enabled {
			st.state = CircuitStateClosed
			st.openUntil = time.Time{}
			st.halfOpenInFlight = 0
			st.halfOpenGen++
		}
	}
}

func (m *circuitBreakerManager) sampleMaxAge() time.Duration {
	age := 5 * time.Minute
	if tenOpen := 10 * m.cfg.OpenDuration; tenOpen > age {
		age = tenOpen
	}
	return age
}

// IsDisabled reports whether platform is manually disabled via runtime config
// circuit_breaker.disabled_platforms (distinct from automatic circuit open state).
func (m *circuitBreakerManager) IsDisabled(platform string) bool {
	if m == nil || platform == "" {
		return false
	}
	m.mu.Lock()
	_, disabled := m.disabled[platform]
	m.mu.Unlock()
	return disabled
}

// IsOpen reports whether platform is currently in an active automatic circuit-open
// window at now without mutating half-open probe state. Used by background tasks
// (such as YouTube helper proactive refresh) to stand down during upstream outages.
func (m *circuitBreakerManager) IsOpen(platform string, now time.Time) bool {
	if m == nil || platform == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, disabled := m.disabled[platform]; disabled {
		return true
	}
	if !m.cfg.Enabled {
		return false
	}
	st, ok := m.states[platform]
	if !ok {
		return false
	}
	return st.state == CircuitStateOpen && now.Before(st.openUntil)
}

// Allow checks whether an upstream call for platform is permitted at now.
// When allowed is false, retryAfterSec is >= 1 (30s when disabled_by_config).
// When halfOpenGen > 0, callers MUST call Finish(platform, code, halfOpenGen, finishNow)
// once the upstream call completes so half-open probe capacity never leaks.
func (m *circuitBreakerManager) Allow(platform string, now time.Time) (allowed bool, retryAfterSec int, halfOpenGen uint64) {
	if m == nil {
		return true, 0, 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, disabled := m.disabled[platform]; disabled {
		return false, disabledPlatformRetryAfterSeconds, 0
	}
	if !m.cfg.Enabled {
		return true, 0, 0
	}
	st, ok := m.states[platform]
	if !ok {
		return true, 0, 0
	}
	st.pruneExpired(now, m.sampleMaxAge())
	switch st.state {
	case CircuitStateClosed:
		return true, 0, 0
	case CircuitStateOpen:
		if now.Before(st.openUntil) {
			rem := int(math.Ceil(st.openUntil.Sub(now).Seconds()))
			if rem < 1 {
				rem = 1
			}
			return false, rem, 0
		}
		// Open cooldown elapsed: transition to half_open and admit this caller as probe #1.
		st.state = CircuitStateHalfOpen
		st.halfOpenGen++
		st.halfOpenInFlight = 1
		return true, 0, st.halfOpenGen
	case CircuitStateHalfOpen:
		if st.halfOpenInFlight < m.cfg.HalfOpenMaxProbes {
			st.halfOpenInFlight++
			return true, 0, st.halfOpenGen
		}
		return false, 1, 0
	default:
		st.state = CircuitStateClosed
		return true, 0, 0
	}
}

// Finish records the outcome of a live upstream execution and releases any half-open probe slot.
func (m *circuitBreakerManager) Finish(platform, code string, halfOpenGen uint64, now time.Time) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	st, ok := m.states[platform]
	if !ok {
		return
	}
	isCurrentHalfOpenProbe := halfOpenGen > 0 && st.halfOpenGen == halfOpenGen
	if isCurrentHalfOpenProbe && st.halfOpenInFlight > 0 {
		st.halfOpenInFlight--
	}
	if !m.cfg.Enabled {
		return
	}
	st.pruneExpired(now, m.sampleMaxAge())

	if st.state == CircuitStateHalfOpen && !isCurrentHalfOpenProbe {
		// Ignore stale pre-open requests (halfOpenGen == 0) and probes from
		// superseded half-open generations so they cannot prematurely close or
		// re-open the active probe wave.
		return
	}

	if code == "OK" {
		st.consecutiveFailures = 0
		st.lastFailureAt = time.Time{}
		if st.state == CircuitStateHalfOpen {
			st.state = CircuitStateClosed
			st.openUntil = time.Time{}
			st.halfOpenInFlight = 0
			st.halfOpenGen++
			st.resetWindow()
		}
		st.pushSample(false, now)
		return
	}

	if !isCircuitBreakerFailure(code) {
		// Neutral user/content outcomes (NO_MEDIA, CONTENT_UNAVAILABLE, UPSTREAM_BLOCKED,
		// INVALID_INPUT, UNAUTHORIZED, RATE_LIMITED, canceled) never trip the breaker
		// and never break recovery streaks.
		return
	}

	st.consecutiveFailures++
	st.lastFailureAt = now
	st.pushSample(true, now)

	if st.state == CircuitStateHalfOpen {
		st.state = CircuitStateOpen
		st.openUntil = now.Add(m.cfg.OpenDuration)
		st.halfOpenInFlight = 0
		st.halfOpenGen++
		return
	}
	if st.state == CircuitStateClosed {
		consecTripped := st.consecutiveFailures >= m.cfg.ConsecutiveFailures
		rateTripped := st.windowCount >= m.cfg.WindowSize &&
			float64(st.windowFailures)/float64(st.windowCount) >= m.cfg.FailureRateThreshold
		if consecTripped || rateTripped {
			st.state = CircuitStateOpen
			st.openUntil = now.Add(m.cfg.OpenDuration)
		}
	}
}

func (m *circuitBreakerManager) snapshotPlatformLocked(plat string, now time.Time, maxAge time.Duration) CircuitBreakerPlatformSnapshot {
	st := m.states[plat]
	_, disabled := m.disabled[plat]
	snap := CircuitBreakerPlatformSnapshot{
		Platform:         plat,
		State:            CircuitStateClosed,
		DisabledByConfig: disabled,
	}
	if st != nil {
		st.pruneExpired(now, maxAge)
		snap.ConsecutiveFailures = st.consecutiveFailures
		snap.WindowFailures = st.windowFailures
		snap.WindowTotal = st.windowCount
	}
	if disabled {
		snap.State = CircuitStateOpen
		snap.OpenUntil = ""
	} else if m.cfg.Enabled && st != nil {
		switch st.state {
		case CircuitStateOpen:
			if now.Before(st.openUntil) {
				snap.State = CircuitStateOpen
				snap.OpenUntil = st.openUntil.UTC().Format(time.RFC3339)
			} else {
				snap.State = CircuitStateHalfOpen
				snap.OpenUntil = ""
			}
		case CircuitStateHalfOpen:
			snap.State = CircuitStateHalfOpen
		default:
			snap.State = CircuitStateClosed
		}
	}
	return snap
}

// Snapshot returns the closed 14-element slice of core platform circuit breaker states
// in exact knownPlatforms[:14] order.
func (m *circuitBreakerManager) Snapshot(now time.Time) []CircuitBreakerPlatformSnapshot {
	out := make([]CircuitBreakerPlatformSnapshot, numCorePlatforms)
	if m == nil {
		for i := 0; i < numCorePlatforms; i++ {
			out[i] = CircuitBreakerPlatformSnapshot{
				Platform: knownPlatforms[i],
				State:    CircuitStateClosed,
			}
		}
		return out
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	maxAge := m.sampleMaxAge()
	for i := 0; i < numCorePlatforms; i++ {
		out[i] = m.snapshotPlatformLocked(knownPlatforms[i], now, maxAge)
	}
	return out
}

// GenericSnapshot returns the circuit breaker state for the isolated Tier-2
// generic named-extractor pool ("ytdlp_generic") without altering the fixed
// 14-element core platform array returned by Snapshot.
func (m *circuitBreakerManager) GenericSnapshot(now time.Time) CircuitBreakerPlatformSnapshot {
	if m == nil {
		return CircuitBreakerPlatformSnapshot{
			Platform: PlatformGeneric,
			State:    CircuitStateClosed,
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotPlatformLocked(PlatformGeneric, now, m.sampleMaxAge())
}

func circuitBreakerOpenResponse(platform string, retryAfterSec int) cachedResponse {
	if retryAfterSec < 1 {
		retryAfterSec = 1
	}
	msg := platformDisplayName(platform) + "上游服务暂时响应异常，已触发快速保护，请稍后重试"
	payload := unified.ContractError("UPSTREAM_UNAVAILABLE", msg, true)
	unified.Map(payload["error"])["retry_after_seconds"] = retryAfterSec
	res, _ := encodeResponse(http.StatusServiceUnavailable, payload)
	if platform == PlatformGeneric {
		res.platform = PlatformYTDLPUnmatched
	}
	return res
}
