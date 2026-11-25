package youtube

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const (
	// TVHTML5ClientName and TVHTML5ClientVersion are the only allowed Innertube
	// client parameters exposed by /api/youtube/context in Phase 1.
	TVHTML5ClientName    = "TVHTML5"
	TVHTML5ClientVersion = "5.20260707"

	// MaxFinalizeBodyBytes caps POST /api/youtube/finalize request bodies at 512 KiB.
	MaxFinalizeBodyBytes = 512 << 10

	// MaxFinalizeFormatEntries caps combined formats[] + adaptiveFormats[] entries at 256.
	MaxFinalizeFormatEntries = 256

	// MaxFinalizeTitleRunes caps sanitized finalize title/author strings at 200 runes.
	MaxFinalizeTitleRunes = 200

	// DefaultPlayerCacheTTL is the default lifetime of a cached player_id entry.
	DefaultPlayerCacheTTL = 6 * time.Hour

	// MaxPlayerRenewalAge caps how long an unchanged player_id entry can be renewed
	// without re-fetching and re-verifying the upstream player JS script.
	MaxPlayerRenewalAge = 24 * time.Hour

	// SoftRefreshBefore triggers proactive singleflight SWR background refresh
	// this duration before ExpiresAt so users never hit synchronous refresh waits.
	SoftRefreshBefore = time.Hour

	// BackgroundRefreshInterval is the periodic health-check cadence used by
	// StartBackgroundRefresh to keep the active player warm.
	BackgroundRefreshInterval = 30 * time.Minute

	// StalePlayerFallbackWindow is the maximum age past ExpiresAt during which a
	// cached player entry can still be served if refreshing the player fails.
	StalePlayerFallbackWindow = time.Hour

	// MaxChallengeCacheEntries caps the deterministic (player_id, variant, digest, input) solver LRU.
	MaxChallengeCacheEntries = 4096

	maxCachedPlayers = 8
)

var (
	startupPrewarmBackoffs = []time.Duration{
		5 * time.Second,
		15 * time.Second,
		30 * time.Second,
	}
	defaultRefreshFailureBackoffs = []time.Duration{
		5 * time.Second,
		15 * time.Second,
		30 * time.Second,
		60 * time.Second,
	}

	errYouTubeHelperDisabled = errors.New("youtube helper disabled by runtime policy")
	errYouTubeHelperCooldown = errors.New("youtube player refresh in failure cooldown")

	playerIDPattern           = regexp.MustCompile(`^[0-9a-fA-F]{8}$`)
	iframeAPIPlayerIDPattern  = regexp.MustCompile(`(?:\\/s\\/player\\/|/s/player/|player\\/|player/)([0-9a-fA-F]{8})(?:\\/|/)`)
	signatureTimestampPattern = regexp.MustCompile(`(?:signatureTimestamp|sts)\s*:\s*([0-9]{5})\b`)
	googlevideoHostPattern    = regexp.MustCompile(`^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.googlevideo\.com$`)
	opaquePlaybackIDPattern   = regexp.MustCompile(`^o-[A-Za-z0-9_-]{40,48}$`)
	bcp47TagPattern           = regexp.MustCompile(`^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$`)
)

// HelperStatsSnapshot exposes strictly redacted, closed-vocabulary telemetry for
// GET /api/stats (zero URLs, IPs, error messages, tokens, or local paths).
type HelperStatsSnapshot struct {
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

// AllowYouTubePlayerFetchURL restricts server-side player JS discovery and
// download requests strictly to https://www.youtube.com.
func AllowYouTubePlayerFetchURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" {
		return false
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return false
	}
	if port := u.Port(); port != "" && port != "443" {
		return false
	}
	return fetch.AllowHosts("www.youtube.com")(raw)
}

// AllowGooglevideoPlaybackURL validates that raw is strictly an
// https://*.googlevideo.com/videoplayback URL with no userinfo, fragment, or custom port.
func AllowGooglevideoPlaybackURL(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 8192 || strings.Contains(trimmed, "#") {
		return false
	}
	for _, r := range trimmed {
		if r <= 0x20 || r >= 0x7f || r == '\\' {
			return false
		}
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.User != nil || u.Opaque != "" {
		return false
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return false
	}
	if port := u.Port(); port != "" && port != "443" {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if !googlevideoHostPattern.MatchString(host) {
		return false
	}
	return u.Path == "/videoplayback" && u.EscapedPath() == "/videoplayback"
}

// AllowYouTubeThumbnailURL restricts finalize thumbnail URLs to AllowedMediaURL-permitted
// YouTube thumbnail hosts (such as i.ytimg.com).
func AllowYouTubeThumbnailURL(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 2048 || strings.Contains(trimmed, "#") {
		return false
	}
	for _, r := range trimmed {
		if r <= 0x20 || r >= 0x7f || r == '\\' {
			return false
		}
	}
	if !AllowedMediaURL(trimmed) {
		return false
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	return host == "i.ytimg.com" || strings.HasSuffix(host, ".ytimg.com") || host == "img.youtube.com"
}

// Helper serves /api/youtube/context and /api/youtube/finalize using internal/fetch
// (restricted to www.youtube.com) and the zero-permission Deno + ejs sandbox.
type Helper struct {
	executor               fetch.Executor
	sandbox                *EJSSandbox
	now                    func() time.Time
	cacheTTL               time.Duration
	maxPlayerRenewalAge    time.Duration
	softRefreshBefore      time.Duration
	bgRefreshInterval      time.Duration
	prewarmBackoffs        []time.Duration
	refreshFailureBackoffs []time.Duration
	challengeCache         *challengeLRU

	disabled         atomic.Bool
	refreshAttempts  atomic.Uint64
	refreshSuccesses atomic.Uint64
	refreshFailures  atomic.Uint64
	cooldownSkips    atomic.Uint64

	mu                  sync.Mutex
	upstreamAllowed     func() bool
	activeID            string
	cache               map[string]*playerCacheEntry
	order               []string
	refreshCall         *playerRefreshCall
	consecutiveFailures int
	nextRetryAfter      time.Time
	bgCtx               context.Context
	bgWG                sync.WaitGroup
}

// NewHelper creates a YouTube Helper backed by the given fetch.Executor and verified EJSSandbox.
func NewHelper(executor fetch.Executor, sandbox *EJSSandbox, now func() time.Time) (*Helper, error) {
	if executor == nil {
		return nil, errors.New("missing fetch executor")
	}
	if sandbox == nil {
		return nil, errors.New("missing ejs sandbox")
	}
	if now == nil {
		now = time.Now
	}
	return &Helper{
		executor:               executor,
		sandbox:                sandbox,
		now:                    now,
		cacheTTL:               DefaultPlayerCacheTTL,
		maxPlayerRenewalAge:    MaxPlayerRenewalAge,
		softRefreshBefore:      SoftRefreshBefore,
		bgRefreshInterval:      BackgroundRefreshInterval,
		prewarmBackoffs:        append([]time.Duration(nil), startupPrewarmBackoffs...),
		refreshFailureBackoffs: append([]time.Duration(nil), defaultRefreshFailureBackoffs...),
		challengeCache:         newChallengeLRU(MaxChallengeCacheEntries),
		cache:                  make(map[string]*playerCacheEntry),
	}, nil
}

// NewHelperFromEnv constructs a Helper when DOKITOOL_DENO_BINARY and DOKITOOL_EJS_DIR pass verification.
func NewHelperFromEnv(executor fetch.Executor, getenv func(string) string, now func() time.Time) (*Helper, error) {
	sandbox, err := NewEJSSandboxFromEnv(getenv)
	if err != nil {
		return nil, err
	}
	return NewHelper(executor, sandbox, now)
}

// Sandbox returns the underlying verified EJSSandbox.
func (h *Helper) Sandbox() *EJSSandbox {
	if h == nil {
		return nil
	}
	return h.sandbox
}

// SetCacheTTL overrides the player cache TTL (used in tests).
func (h *Helper) SetCacheTTL(ttl time.Duration) {
	if h == nil || ttl <= 0 {
		return
	}
	h.mu.Lock()
	h.cacheTTL = ttl
	h.mu.Unlock()
}

// SetUpstreamAllowed registers a read-only predicate (e.g. circuit breaker / kill-switch
// gate) consulted before issuing background or cold upstream player refreshes.
func (h *Helper) SetUpstreamAllowed(fn func() bool) {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.upstreamAllowed = fn
	h.mu.Unlock()
}

func (h *Helper) isUpstreamAllowedLocked() bool {
	if h == nil || h.disabled.Load() {
		return false
	}
	if h.upstreamAllowed != nil {
		return h.upstreamAllowed()
	}
	return true
}

func (h *Helper) isUpstreamAllowed() bool {
	if h == nil || h.disabled.Load() {
		return false
	}
	h.mu.Lock()
	fn := h.upstreamAllowed
	h.mu.Unlock()
	if fn != nil {
		return fn()
	}
	return true
}

// SetEnabled toggles whether the YouTube helper is allowed to serve requests and
// perform background player refreshes. Disabling immediately invalidates in-memory
// player and challenge caches; re-enabling resets failure cooldown and schedules
// an asynchronous prewarm when the background loop is running.
func (h *Helper) SetEnabled(enabled bool) {
	if h == nil {
		return
	}
	wasDisabled := h.disabled.Swap(!enabled)
	if !enabled {
		h.InvalidateCache()
		return
	}
	if wasDisabled {
		now := h.now()
		h.mu.Lock()
		h.consecutiveFailures = 0
		h.nextRetryAfter = time.Time{}
		if h.bgCtx != nil && h.bgCtx.Err() == nil && h.activeID == "" {
			h.startAsyncRefreshLocked(now)
		}
		h.mu.Unlock()
	}
}

// IsEnabled reports whether the helper is currently enabled (not disabled by runtime kill-switch).
func (h *Helper) IsEnabled() bool {
	return h != nil && !h.disabled.Load()
}

// HasCachedContext reports whether a non-expired player context entry is
// currently cached in memory and can be served without upstream or Deno work.
func (h *Helper) HasCachedContext() bool {
	if h == nil || h.disabled.Load() {
		return false
	}
	now := h.now()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.activeID == "" {
		return false
	}
	existing, ok := h.cache[h.activeID]
	return ok && now.Before(existing.ExpiresAt)
}

// HelperStatsSnapshot returns a point-in-time redacted telemetry snapshot for GET /api/stats.
func (h *Helper) HelperStatsSnapshot() HelperStatsSnapshot {
	if h == nil {
		return HelperStatsSnapshot{}
	}
	now := h.now()
	lruEntries, lruHits, lruMisses := h.challengeCache.Stats()
	h.mu.Lock()
	activeCached := false
	activeVariant := ""
	if h.activeID != "" {
		if existing, ok := h.cache[h.activeID]; ok && now.Before(existing.ExpiresAt) {
			activeCached = true
			activeVariant = existing.Variant
		}
	}
	consecFail := h.consecutiveFailures
	inCooldown := h.isInCooldownLocked(now)
	h.mu.Unlock()
	return HelperStatsSnapshot{
		Enabled:             true,
		DisabledByConfig:    h.disabled.Load(),
		ActivePlayerCached:  activeCached,
		ActiveVariant:       activeVariant,
		RefreshAttempts:     h.refreshAttempts.Load(),
		RefreshSuccesses:    h.refreshSuccesses.Load(),
		RefreshFailures:     h.refreshFailures.Load(),
		CooldownSkips:       h.cooldownSkips.Load(),
		ConsecutiveFailures: consecFail,
		InCooldown:          inCooldown,
		ChallengeLRUEntries: lruEntries,
		ChallengeLRUHits:    lruHits,
		ChallengeLRUMisses:  lruMisses,
	}
}

// Context implements GET /api/youtube/context?schema_version=1.0.
func (h *Helper) Context(ctx context.Context) (unified.Object, int) {
	if h == nil || h.sandbox == nil || h.executor == nil {
		return unified.ContractError("SERVICE_NOT_CONFIGURED", "YouTube 助手服务尚未配置", false), http.StatusServiceUnavailable
	}
	if h.disabled.Load() {
		return unified.ContractError("UPSTREAM_UNAVAILABLE", "YouTube上游服务暂时响应异常，已触发快速保护，请稍后重试", true), http.StatusServiceUnavailable
	}
	entry, err := h.ensureActivePlayer(ctx)
	if err != nil {
		return unified.ContractError("UPSTREAM_UNAVAILABLE", "无法获取 YouTube 播放器上下文，请稍后重试", true), http.StatusBadGateway
	}
	return unified.Object{
		"schema_version": unified.SchemaVersion,
		"code":           "OK",
		"data": unified.Object{
			"player_id":           entry.PlayerID,
			"signature_timestamp": int64(entry.SignatureTimestamp),
			"client": unified.Object{
				"name":    TVHTML5ClientName,
				"version": TVHTML5ClientVersion,
			},
			"expires_at": entry.ExpiresAt.UTC().Format(time.RFC3339),
		},
	}, http.StatusOK
}

// StartBackgroundRefresh launches a non-blocking background goroutine that
// prewarms the active YouTube player immediately on startup (retrying with
// 5s / 15s / 30s backoff on startup failure without blocking server startup)
// and periodically checks every 30m so user requests never hit cold waits.
// The returned stop function cancels background work and waits for clean exit.
func (h *Helper) StartBackgroundRefresh(parent context.Context) func() {
	if h == nil {
		return func() {}
	}
	if parent == nil {
		parent = context.Background()
	}
	bgCtx, cancel := context.WithCancel(parent)
	h.mu.Lock()
	h.bgCtx = bgCtx
	interval := h.bgRefreshInterval
	if interval <= 0 {
		interval = BackgroundRefreshInterval
	}
	backoffs := append([]time.Duration(nil), h.prewarmBackoffs...)
	h.mu.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		// Initial startup prewarm with bounded backoff retries (skipped if youtube is disabled).
		if h.isUpstreamAllowed() {
			for attempt := 0; ; attempt++ {
				if bgCtx.Err() != nil || !h.isUpstreamAllowed() {
					break
				}
				if _, err := h.runSingleflightRefresh(bgCtx); err == nil {
					break
				} else if attempt >= len(backoffs) {
					log.Printf("WARN: youtube helper startup prewarm failed after retries: %v", err)
					break
				} else {
					wait := backoffs[attempt]
					log.Printf("WARN: youtube helper startup prewarm attempt %d failed (%v); retrying in %s", attempt+1, err, wait)
					timer := time.NewTimer(wait)
					select {
					case <-bgCtx.Done():
						timer.Stop()
						return
					case <-timer.C:
					}
				}
			}
		}

		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-bgCtx.Done():
				return
			case <-ticker.C:
				if !h.needsProactiveRefresh() {
					continue
				}
				if _, err := h.runSingleflightRefresh(bgCtx); err != nil && bgCtx.Err() == nil && !errors.Is(err, errYouTubeHelperDisabled) {
					log.Printf("WARN: youtube helper periodic refresh failed: %v", err)
				}
			}
		}
	}()

	var stopOnce sync.Once
	return func() {
		stopOnce.Do(func() {
			cancel()
			<-done
			h.bgWG.Wait()
		})
	}
}
