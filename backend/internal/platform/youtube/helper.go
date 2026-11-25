package youtube

import (
	"bytes"
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
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

	// SoftRefreshBefore triggers proactive singleflight SWR background refresh
	// this duration before ExpiresAt so users never hit synchronous refresh waits.
	SoftRefreshBefore = time.Hour

	// BackgroundRefreshInterval is the periodic health-check cadence used by
	// StartBackgroundRefresh to keep the active player warm.
	BackgroundRefreshInterval = 30 * time.Minute

	// StalePlayerFallbackWindow is the maximum age past ExpiresAt during which a
	// cached player entry can still be served if refreshing the player fails.
	StalePlayerFallbackWindow = time.Hour

	// MaxChallengeCacheEntries caps the deterministic (player_id, input) solver LRU.
	MaxChallengeCacheEntries = 4096

	maxCachedPlayers = 8
)

var startupPrewarmBackoffs = []time.Duration{
	5 * time.Second,
	15 * time.Second,
	30 * time.Second,
}

var (
	playerIDPattern           = regexp.MustCompile(`^[0-9a-fA-F]{8}$`)
	iframeAPIPlayerIDPattern  = regexp.MustCompile(`(?:\\/s\\/player\\/|/s/player/|player\\/|player/)([0-9a-fA-F]{8})(?:\\/|/)`)
	signatureTimestampPattern = regexp.MustCompile(`(?:signatureTimestamp|sts)\s*:\s*([0-9]{5})\b`)
	googlevideoHostPattern    = regexp.MustCompile(`^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.googlevideo\.com$`)
	opaquePlaybackIDPattern   = regexp.MustCompile(`^o-[A-Za-z0-9_-]{40,48}$`)
	bcp47TagPattern           = regexp.MustCompile(`^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$`)
)

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

type playerCacheEntry struct {
	PlayerID             string
	SignatureTimestamp   int
	RawPlayerJS          string
	PreprocessedPlayerJS string
	FetchedAt            time.Time
	ExpiresAt            time.Time
	StaleUntil           time.Time
}

type playerRefreshCall struct {
	done  chan struct{}
	entry *playerCacheEntry
	err   error
}

type challengeCacheKey struct {
	playerID string
	kind     string
	input    string
}

type challengeCacheEntry struct {
	key   challengeCacheKey
	value string
}

// challengeLRU is a concurrency-safe bounded LRU cache for deterministic
// (player_id, n/sig input) -> solved challenge outputs.
type challengeLRU struct {
	mu       sync.Mutex
	capacity int
	ll       *list.List
	items    map[challengeCacheKey]*list.Element
}

func newChallengeLRU(capacity int) *challengeLRU {
	if capacity <= 0 {
		capacity = MaxChallengeCacheEntries
	}
	return &challengeLRU{
		capacity: capacity,
		ll:       list.New(),
		items:    make(map[challengeCacheKey]*list.Element),
	}
}

func (c *challengeLRU) Get(playerID, kind, input string) (string, bool) {
	if c == nil || playerID == "" || input == "" {
		return "", false
	}
	key := challengeCacheKey{playerID: playerID, kind: kind, input: input}
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.items[key]; ok {
		c.ll.MoveToFront(elem)
		return elem.Value.(*challengeCacheEntry).value, true
	}
	return "", false
}

func (c *challengeLRU) Put(playerID, kind, input, value string) {
	if c == nil || playerID == "" || input == "" || value == "" {
		return
	}
	key := challengeCacheKey{playerID: playerID, kind: kind, input: input}
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.items[key]; ok {
		elem.Value.(*challengeCacheEntry).value = value
		c.ll.MoveToFront(elem)
		return
	}
	elem := c.ll.PushFront(&challengeCacheEntry{key: key, value: value})
	c.items[key] = elem
	for c.ll.Len() > c.capacity {
		back := c.ll.Back()
		if back == nil {
			break
		}
		c.ll.Remove(back)
		delete(c.items, back.Value.(*challengeCacheEntry).key)
	}
}

func (c *challengeLRU) Len() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}

// Helper serves /api/youtube/context and /api/youtube/finalize using internal/fetch
// (restricted to www.youtube.com) and the zero-permission Deno + ejs sandbox.
type Helper struct {
	executor          fetch.Executor
	sandbox           *EJSSandbox
	now               func() time.Time
	cacheTTL          time.Duration
	softRefreshBefore time.Duration
	bgRefreshInterval time.Duration
	prewarmBackoffs   []time.Duration
	challengeCache    *challengeLRU

	mu          sync.Mutex
	activeID    string
	cache       map[string]*playerCacheEntry
	order       []string
	refreshCall *playerRefreshCall
	bgCtx       context.Context
	bgWG        sync.WaitGroup
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
		executor:          executor,
		sandbox:           sandbox,
		now:               now,
		cacheTTL:          DefaultPlayerCacheTTL,
		softRefreshBefore: SoftRefreshBefore,
		bgRefreshInterval: BackgroundRefreshInterval,
		prewarmBackoffs:   append([]time.Duration(nil), startupPrewarmBackoffs...),
		challengeCache:    newChallengeLRU(MaxChallengeCacheEntries),
		cache:             make(map[string]*playerCacheEntry),
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

// HasCachedContext reports whether a non-expired player context entry is
// currently cached in memory and can be served without upstream or Deno work.
func (h *Helper) HasCachedContext() bool {
	if h == nil {
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

// Context implements GET /api/youtube/context?schema_version=1.0.
func (h *Helper) Context(ctx context.Context) (unified.Object, int) {
	if h == nil || h.sandbox == nil || h.executor == nil {
		return unified.ContractError("SERVICE_NOT_CONFIGURED", "YouTube 助手服务尚未配置", false), http.StatusServiceUnavailable
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
		// Initial startup prewarm with bounded backoff retries.
		for attempt := 0; ; attempt++ {
			if bgCtx.Err() != nil {
				return
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
				if _, err := h.runSingleflightRefresh(bgCtx); err != nil && bgCtx.Err() == nil {
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

func (h *Helper) effectiveSoftRefreshBeforeLocked() time.Duration {
	if h.softRefreshBefore <= 0 || h.cacheTTL <= 0 {
		return 0
	}
	if h.softRefreshBefore >= h.cacheTTL {
		return h.cacheTTL / 2
	}
	return h.softRefreshBefore
}

func (h *Helper) needsProactiveRefresh() bool {
	if h == nil {
		return false
	}
	now := h.now()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.activeID == "" {
		return true
	}
	existing, ok := h.cache[h.activeID]
	if !ok {
		return true
	}
	softBefore := h.effectiveSoftRefreshBeforeLocked()
	return !now.Before(existing.ExpiresAt.Add(-softBefore))
}

func (h *Helper) startAsyncRefreshLocked() {
	if h.refreshCall != nil {
		return
	}
	call := &playerRefreshCall{done: make(chan struct{})}
	h.refreshCall = call
	parentCtx := h.bgCtx
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	h.bgWG.Add(1)
	go func() {
		defer h.bgWG.Done()
		h.executeRefreshCall(parentCtx, call, false)
	}()
}

func (h *Helper) runSingleflightRefresh(ctx context.Context) (*playerCacheEntry, error) {
	h.mu.Lock()
	if h.refreshCall != nil {
		call := h.refreshCall
		h.mu.Unlock()
		select {
		case <-call.done:
			return call.entry, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &playerRefreshCall{done: make(chan struct{})}
	h.refreshCall = call
	h.mu.Unlock()
	return h.executeRefreshCall(ctx, call, true)
}

func (h *Helper) executeRefreshCall(ctx context.Context, call *playerRefreshCall, fallbackStaleOnErr bool) (*playerCacheEntry, error) {
	var (
		entry    *playerCacheEntry
		err      error
		finished bool
	)
	defer func() {
		h.mu.Lock()
		if !finished && err == nil {
			err = errors.New("youtube player refresh aborted unexpectedly")
		}
		call.entry = entry
		call.err = err
		if h.refreshCall == call {
			h.refreshCall = nil
		}
		close(call.done)
		h.mu.Unlock()
	}()

	h.mu.Lock()
	bgCtx := h.bgCtx
	h.mu.Unlock()
	refreshBase := bgCtx
	if refreshBase == nil {
		refreshBase = context.WithoutCancel(ctx)
	}
	if ctx.Err() != nil {
		refreshBase = ctx
	}
	refreshCtx, cancel := context.WithTimeout(refreshBase, 35*time.Second)
	defer cancel()

	entry, err = h.refreshActivePlayer(refreshCtx)
	if err != nil && fallbackStaleOnErr {
		h.mu.Lock()
		now := h.now()
		if h.activeID != "" {
			if stale, ok := h.cache[h.activeID]; ok && !now.After(stale.StaleUntil) {
				served := *stale
				graceExpiry := now.Add(5 * time.Minute)
				if graceExpiry.After(stale.StaleUntil) {
					graceExpiry = stale.StaleUntil
				}
				if graceExpiry.After(served.ExpiresAt) {
					served.ExpiresAt = graceExpiry
					h.storeCacheEntryLocked(&served)
				}
				log.Printf("WARN: youtube player refresh failed (%v); continuing with stale player %s", err, stale.PlayerID)
				entry = &served
				err = nil
			}
		}
		h.mu.Unlock()
	}
	finished = true

	if ctxErr := ctx.Err(); ctxErr != nil && entry == nil {
		return nil, ctxErr
	}
	return entry, err
}

func (h *Helper) ensureActivePlayer(ctx context.Context) (*playerCacheEntry, error) {
	now := h.now()
	h.mu.Lock()
	if h.activeID != "" {
		if existing, ok := h.cache[h.activeID]; ok {
			softBefore := h.effectiveSoftRefreshBeforeLocked()
			if now.Before(existing.ExpiresAt) {
				if softBefore > 0 && !now.Before(existing.ExpiresAt.Add(-softBefore)) {
					h.startAsyncRefreshLocked()
				}
				h.mu.Unlock()
				return existing, nil
			}
			if !now.After(existing.StaleUntil) {
				h.startAsyncRefreshLocked()
				served := *existing
				graceExpiry := now.Add(5 * time.Minute)
				if graceExpiry.After(existing.StaleUntil) {
					graceExpiry = existing.StaleUntil
				}
				if graceExpiry.After(served.ExpiresAt) {
					served.ExpiresAt = graceExpiry
					h.storeCacheEntryLocked(&served)
				}
				h.mu.Unlock()
				return &served, nil
			}
		}
	}
	if h.refreshCall != nil {
		call := h.refreshCall
		h.mu.Unlock()
		select {
		case <-call.done:
			return call.entry, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &playerRefreshCall{done: make(chan struct{})}
	h.refreshCall = call
	h.mu.Unlock()

	return h.executeRefreshCall(ctx, call, true)
}

func (h *Helper) refreshActivePlayer(ctx context.Context) (*playerCacheEntry, error) {
	playerID, err := h.fetchCurrentPlayerID(ctx)
	if err != nil {
		return nil, err
	}

	now := h.now()
	h.mu.Lock()
	if existing, ok := h.cache[playerID]; ok && !now.After(existing.StaleUntil) {
		expiresAt := now.Add(h.cacheTTL)
		renewed := *existing
		renewed.FetchedAt = now
		renewed.ExpiresAt = expiresAt
		renewed.StaleUntil = expiresAt.Add(StalePlayerFallbackWindow)
		h.storeCacheEntryLocked(&renewed)
		h.activeID = playerID
		h.mu.Unlock()
		return &renewed, nil
	}
	h.mu.Unlock()

	rawJS, sts, preprocessed, err := h.fetchAndPreprocessPlayerJS(ctx, playerID)
	if err != nil {
		return nil, err
	}

	now = h.now()
	h.mu.Lock()
	defer h.mu.Unlock()
	expiresAt := now.Add(h.cacheTTL)
	entry := &playerCacheEntry{
		PlayerID:             playerID,
		SignatureTimestamp:   sts,
		RawPlayerJS:          rawJS,
		PreprocessedPlayerJS: preprocessed,
		FetchedAt:            now,
		ExpiresAt:            expiresAt,
		StaleUntil:           expiresAt.Add(StalePlayerFallbackWindow),
	}
	h.storeCacheEntryLocked(entry)
	h.activeID = playerID
	return entry, nil
}

func (h *Helper) storeCacheEntryLocked(entry *playerCacheEntry) {
	if _, exists := h.cache[entry.PlayerID]; !exists {
		h.order = append(h.order, entry.PlayerID)
	}
	h.cache[entry.PlayerID] = entry
	for len(h.order) > maxCachedPlayers {
		evict := h.order[0]
		h.order = h.order[1:]
		if evict != entry.PlayerID {
			delete(h.cache, evict)
		}
	}
}

func (h *Helper) lookupCachedPlayer(playerID string, now time.Time) (*playerCacheEntry, bool) {
	id := strings.ToLower(strings.TrimSpace(playerID))
	if !playerIDPattern.MatchString(id) {
		return nil, false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	entry, ok := h.cache[id]
	if !ok || !now.Before(entry.ExpiresAt) {
		return nil, false
	}
	return entry, true
}

func (h *Helper) fetchCurrentPlayerID(ctx context.Context) (string, error) {
	resp, err := h.executor.Do(ctx, fetch.Request{
		Method: http.MethodGet,
		URL:    "https://www.youtube.com/iframe_api",
		Header: http.Header{
			"Accept":          {"*/*"},
			"Accept-Language": {"en-US,en;q=0.9"},
		},
		Policy: fetch.Policy{
			Purpose:         "youtube.context.iframe_api",
			AllowedURL:      AllowYouTubePlayerFetchURL,
			Timeout:         10 * time.Second,
			MaxBytes:        256 << 10,
			FollowRedirects: true,
			MaxRedirects:    2,
		},
	})
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("iframe_api returned status %d", resp.StatusCode)
	}
	m := iframeAPIPlayerIDPattern.FindSubmatch(resp.Body)
	if m == nil {
		return "", errors.New("player_id not found in iframe_api")
	}
	return strings.ToLower(string(m[1])), nil
}

type playerJSVariant struct {
	name    string
	urlPath string
}

// playerJSVariants lists YouTube player script variants in preference order.
// The TV variant matches our TVHTML5 Innertube client stack and mirrors
// yt-dlp's default player_js_variant ("tv"), avoiding main-variant AST
// regressions in yt-dlp/ejs (e.g. yt-dlp/ejs#79 on player b485e332) while
// keeping the classic web base.js as an automatic fallback.
var playerJSVariants = []playerJSVariant{
	{name: "tv", urlPath: "tv-player-ias.vflset/tv-player-ias.js"},
	{name: "main", urlPath: "player_ias.vflset/en_US/base.js"},
}

func (h *Helper) fetchAndPreprocessPlayerJS(ctx context.Context, playerID string) (string, int, string, error) {
	var errs []string
	for idx, variant := range playerJSVariants {
		if ctx.Err() != nil {
			return "", 0, "", ctx.Err()
		}
		rawJS, sts, err := h.fetchPlayerJSVariant(ctx, playerID, variant)
		if err != nil {
			if ctx.Err() != nil {
				return "", 0, "", ctx.Err()
			}
			errs = append(errs, fmt.Sprintf("%s fetch: %v", variant.name, err))
			continue
		}
		preprocessed, err := h.sandbox.PreprocessPlayer(ctx, rawJS)
		if err != nil {
			if ctx.Err() != nil {
				return "", 0, "", ctx.Err()
			}
			errs = append(errs, fmt.Sprintf("%s preprocess: %v", variant.name, err))
			continue
		}
		if idx > 0 && len(errs) > 0 {
			log.Printf("WARN: youtube helper player %s fell back to %s variant after %s", playerID, variant.name, strings.Join(errs, "; "))
		}
		return rawJS, sts, preprocessed, nil
	}
	return "", 0, "", fmt.Errorf("preprocess player %s failed across variants (%s)", playerID, strings.Join(errs, "; "))
}

func (h *Helper) fetchPlayerJSVariant(ctx context.Context, playerID string, variant playerJSVariant) (string, int, error) {
	targetURL := fmt.Sprintf("https://www.youtube.com/s/player/%s/%s", playerID, variant.urlPath)
	resp, err := h.executor.Do(ctx, fetch.Request{
		Method: http.MethodGet,
		URL:    targetURL,
		Header: http.Header{
			"Accept":          {"*/*"},
			"Accept-Language": {"en-US,en;q=0.9"},
		},
		Policy: fetch.Policy{
			Purpose:         "youtube.context.player_js",
			AllowedURL:      AllowYouTubePlayerFetchURL,
			Timeout:         15 * time.Second,
			MaxBytes:        6 << 20,
			FollowRedirects: true,
			MaxRedirects:    2,
		},
	})
	if err != nil {
		return "", 0, err
	}
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("player %s variant returned status %d", variant.name, resp.StatusCode)
	}
	m := signatureTimestampPattern.FindSubmatch(resp.Body)
	if m == nil {
		return "", 0, fmt.Errorf("signatureTimestamp not found in player %s variant", variant.name)
	}
	sts, err := strconv.Atoi(string(m[1]))
	if err != nil || sts <= 0 {
		return "", 0, fmt.Errorf("invalid signatureTimestamp in player %s variant", variant.name)
	}
	return string(resp.Body), sts, nil
}

type finalizeRequest struct {
	VideoID         string                `json:"video_id"`
	PlayerID        string                `json:"player_id"`
	Title           json.RawMessage       `json:"title"`
	Author          json.RawMessage       `json:"author"`
	DurationSeconds json.RawMessage       `json:"duration_seconds"`
	Thumbnail       json.RawMessage       `json:"thumbnail"`
	Formats         []finalizeFormatInput `json:"formats"`
	AdaptiveFormats []finalizeFormatInput `json:"adaptiveFormats"`
}

func parseOptionalJSONString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || trimmed[0] != '"' {
		return "", false
	}
	var s string
	if err := json.Unmarshal(trimmed, &s); err != nil {
		return "", false
	}
	return s, true
}

func parseOptionalDurationSeconds(raw json.RawMessage) *float64 {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || trimmed[0] == '"' {
		return nil
	}
	var n int64
	if err := json.Unmarshal(trimmed, &n); err != nil {
		return nil
	}
	if n <= 0 || n > 86400*365 {
		return nil
	}
	dur := float64(n)
	return &dur
}

func sanitizeFinalizeText(raw string, maxRunes int) string {
	var b strings.Builder
	b.Grow(len(raw))
	for _, r := range raw {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		b.WriteRune(r)
	}
	trimmed := strings.TrimSpace(b.String())
	if trimmed == "" || maxRunes <= 0 {
		return trimmed
	}
	runes := []rune(trimmed)
	if len(runes) > maxRunes {
		trimmed = strings.TrimSpace(string(runes[:maxRunes]))
	}
	return trimmed
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

type finalizeAudioTrack struct {
	ID             string
	DisplayName    string
	AudioIsDefault *bool
}

type rawFinalizeAudioTrack struct {
	ID             string `json:"id"`
	DisplayName    string `json:"displayName"`
	AudioIsDefault *bool  `json:"audioIsDefault"`
}

// finalizeFormatInput retains only the allowed format fields and discards all others.
type finalizeFormatInput struct {
	Itag            int
	URL             string
	SignatureCipher string
	MimeType        string
	Width           *int64
	Height          *int64
	FPS             *float64
	Bitrate         *int64
	ContentLength   string
	AudioQuality    string
	AudioSampleRate string
	AudioChannels   *int64
	AudioTrack      *finalizeAudioTrack
}

type rawFinalizeFormatFields struct {
	Itag            int             `json:"itag"`
	URL             string          `json:"url"`
	SignatureCipher string          `json:"signatureCipher"`
	MimeType        string          `json:"mimeType"`
	Width           *int64          `json:"width"`
	Height          *int64          `json:"height"`
	FPS             *float64        `json:"fps"`
	Bitrate         *int64          `json:"bitrate"`
	ContentLength   json.RawMessage `json:"contentLength"`
	AudioQuality    string          `json:"audioQuality"`
	AudioSampleRate json.RawMessage `json:"audioSampleRate"`
	AudioChannels   *int64          `json:"audioChannels"`
	AudioTrack      json.RawMessage `json:"audioTrack"`
}

func sanitizeAudioTrackID(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) == 0 || len(trimmed) > 64 {
		return ""
	}
	for i := 0; i < len(trimmed); i++ {
		if trimmed[i] < 0x21 || trimmed[i] > 0x7e {
			return ""
		}
	}
	return trimmed
}

func parseOptionalAudioTrack(raw json.RawMessage) (*finalizeAudioTrack, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	var parsed rawFinalizeAudioTrack
	if err := dec.Decode(&parsed); err != nil {
		return nil, err
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing data in audioTrack")
	}
	cleanID := sanitizeAudioTrackID(parsed.ID)
	cleanName := sanitizeFinalizeText(parsed.DisplayName, 80)
	var isDef *bool
	if parsed.AudioIsDefault != nil {
		v := *parsed.AudioIsDefault
		isDef = &v
	}
	if cleanID == "" && cleanName == "" && isDef == nil {
		return nil, nil
	}
	return &finalizeAudioTrack{
		ID:             cleanID,
		DisplayName:    cleanName,
		AudioIsDefault: isDef,
	}, nil
}

func (f *finalizeFormatInput) UnmarshalJSON(data []byte) error {
	var raw rawFinalizeFormatFields
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	cl, err := parseOptionalDigitString(raw.ContentLength)
	if err != nil {
		return fmt.Errorf("invalid contentLength: %w", err)
	}
	asr, err := parseOptionalDigitString(raw.AudioSampleRate)
	if err != nil {
		return fmt.Errorf("invalid audioSampleRate: %w", err)
	}
	at, err := parseOptionalAudioTrack(raw.AudioTrack)
	if err != nil {
		return fmt.Errorf("invalid audioTrack: %w", err)
	}
	*f = finalizeFormatInput{
		Itag:            raw.Itag,
		URL:             strings.TrimSpace(raw.URL),
		SignatureCipher: strings.TrimSpace(raw.SignatureCipher),
		MimeType:        strings.TrimSpace(raw.MimeType),
		Width:           raw.Width,
		Height:          raw.Height,
		FPS:             raw.FPS,
		Bitrate:         raw.Bitrate,
		ContentLength:   cl,
		AudioQuality:    strings.TrimSpace(raw.AudioQuality),
		AudioSampleRate: asr,
		AudioChannels:   raw.AudioChannels,
		AudioTrack:      at,
	}
	return nil
}

func parseOptionalDigitString(raw json.RawMessage) (string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", nil
	}
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil {
			return "", err
		}
		s = strings.TrimSpace(s)
		if s == "" {
			return "", nil
		}
		if _, err := strconv.ParseInt(s, 10, 64); err != nil {
			return "", err
		}
		return s, nil
	}
	var n int64
	if err := json.Unmarshal(trimmed, &n); err != nil {
		return "", err
	}
	if n < 0 {
		return "", errors.New("negative integer")
	}
	return strconv.FormatInt(n, 10), nil
}

type parsedStreamEntry struct {
	input      finalizeFormatInput
	baseURL    string
	nChallenge string
	sChallenge string
	sigParam   string
}

type decodedFinalizeRequest struct {
	videoID         string
	playerID        string
	title           string
	author          string
	duration        *float64
	thumbnail       string
	formats         []finalizeFormatInput
	adaptiveFormats []finalizeFormatInput
}

// Finalize implements POST /api/youtube/finalize?schema_version=1.0.
// It never makes any network request to googlevideo.com.
func (h *Helper) Finalize(ctx context.Context, body []byte, debug bool) (unified.Object, int) {
	if h == nil || h.sandbox == nil {
		return unified.ContractError("SERVICE_NOT_CONFIGURED", "YouTube 助手服务尚未配置", false), http.StatusServiceUnavailable
	}
	decoded, errPayload, errStatus := decodeFinalizeRequest(body)
	if errPayload != nil {
		return errPayload, errStatus
	}

	nowTime := h.now()
	cachedPlayer, ok := h.lookupCachedPlayer(decoded.playerID, nowTime)
	if !ok {
		return unified.ContractError("INVALID_INPUT", "player_id 不在缓存中或已过期，请重新获取上下文", false), http.StatusBadRequest
	}

	totalEntries := len(decoded.formats) + len(decoded.adaptiveFormats)
	if totalEntries == 0 || totalEntries > MaxFinalizeFormatEntries {
		return unified.ContractError("INVALID_INPUT", "媒体流条目数量超出限制", false), http.StatusBadRequest
	}
	allInputs := make([]finalizeFormatInput, 0, totalEntries)
	allInputs = append(allInputs, decoded.formats...)
	allInputs = append(allInputs, decoded.adaptiveFormats...)

	validatedEntries, errPayload, errStatus := validateFinalizeStreamEntries(allInputs, decoded.videoID)
	if errPayload != nil {
		return errPayload, errStatus
	}

	entries := filterMultiAudioStreamEntries(validatedEntries)
	nChallenges, sigChallenges := collectFinalizeChallenges(entries)
	nSolved, sigSolved, err := h.solveFinalizeChallenges(ctx, cachedPlayer, nChallenges, sigChallenges)
	if err != nil {
		return unified.ContractError("UPSTREAM_INVALID_RESPONSE", "YouTube 媒体签名挑战解密失败", false), http.StatusBadGateway
	}

	ytFormats, errPayload, errStatus := applySolvedChallengesToFormats(entries, nSolved, sigSolved)
	if errPayload != nil {
		return errPayload, errStatus
	}

	canonicalWatchURL := "https://www.youtube.com/watch?v=" + decoded.videoID
	info := &ytengine.Info{
		ID:         decoded.videoID,
		Title:      decoded.title,
		Uploader:   decoded.author,
		Duration:   decoded.duration,
		Thumbnail:  decoded.thumbnail,
		WebpageURL: canonicalWatchURL,
		Formats:    ytFormats,
	}
	opts := ytengine.AdaptOptions{
		PlatformID:      "youtube",
		ContentID:       decoded.videoID,
		SourceURL:       canonicalWatchURL,
		MaxEntries:      1,
		AllowedMediaURL: AllowedMediaURL,
		EnableDASHMux:   true,
		EnableHLS:       false,
	}
	return buildFinalizeEnvelope(info, opts, nowTime.Unix(), debug)
}

func (h *Helper) solveFinalizeChallenges(
	ctx context.Context,
	player *playerCacheEntry,
	nChallenges, sigChallenges []string,
) (map[string]string, map[string]string, error) {
	nSolved := make(map[string]string, len(nChallenges))
	sigSolved := make(map[string]string, len(sigChallenges))
	var missingN []string
	var missingSig []string

	for _, c := range nChallenges {
		if val, ok := h.challengeCache.Get(player.PlayerID, "n", c); ok {
			nSolved[c] = val
		} else {
			missingN = append(missingN, c)
		}
	}
	for _, c := range sigChallenges {
		if val, ok := h.challengeCache.Get(player.PlayerID, "sig", c); ok {
			sigSolved[c] = val
		} else {
			missingSig = append(missingSig, c)
		}
	}

	if len(missingN) == 0 && len(missingSig) == 0 {
		return nSolved, sigSolved, nil
	}

	freshN, freshSig, err := h.sandbox.Solve(ctx, player.PreprocessedPlayerJS, missingN, missingSig)
	if err != nil {
		return nil, nil, err
	}
	for k, v := range freshN {
		nSolved[k] = v
		h.challengeCache.Put(player.PlayerID, "n", k, v)
	}
	for k, v := range freshSig {
		sigSolved[k] = v
		h.challengeCache.Put(player.PlayerID, "sig", k, v)
	}
	return nSolved, sigSolved, nil
}

func decodeFinalizeRequest(body []byte) (*decodedFinalizeRequest, unified.Object, int) {
	if len(body) == 0 || len(body) > MaxFinalizeBodyBytes {
		return nil, unified.ContractError("INVALID_INPUT", "请求体大小超出限制或为空", false), http.StatusBadRequest
	}

	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var req finalizeRequest
	if err := dec.Decode(&req); err != nil {
		return nil, unified.ContractError("INVALID_INPUT", "请求体格式无效或包含未允许的字段", false), http.StatusBadRequest
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, unified.ContractError("INVALID_INPUT", "请求体包含多余的 JSON 数据", false), http.StatusBadRequest
	}

	videoID := strings.TrimSpace(req.VideoID)
	if !youtubeIDPattern.MatchString(videoID) {
		return nil, unified.ContractError("INVALID_INPUT", "无效的 YouTube video_id", false), http.StatusBadRequest
	}

	resolvedTitle := videoID
	if rawTitle, ok := parseOptionalJSONString(req.Title); ok {
		if cleaned := sanitizeFinalizeText(rawTitle, MaxFinalizeTitleRunes); cleaned != "" {
			resolvedTitle = cleaned
		}
	}

	resolvedAuthor := ""
	if rawAuthor, ok := parseOptionalJSONString(req.Author); ok {
		resolvedAuthor = sanitizeFinalizeText(rawAuthor, MaxFinalizeTitleRunes)
	}

	resolvedDuration := parseOptionalDurationSeconds(req.DurationSeconds)

	resolvedThumbnail := ""
	if rawThumb, ok := parseOptionalJSONString(req.Thumbnail); ok {
		thumb := strings.TrimSpace(rawThumb)
		if thumb != "" && AllowYouTubeThumbnailURL(thumb) {
			resolvedThumbnail = thumb
		}
	}

	return &decodedFinalizeRequest{
		videoID:         videoID,
		playerID:        req.PlayerID,
		title:           resolvedTitle,
		author:          resolvedAuthor,
		duration:        resolvedDuration,
		thumbnail:       resolvedThumbnail,
		formats:         req.Formats,
		adaptiveFormats: req.AdaptiveFormats,
	}, nil, 0
}

func resolveFinalizeStreamURL(item finalizeFormatInput) (streamURL, sigChallenge, sigParam string, errPayload unified.Object) {
	hasURL := item.URL != ""
	hasCipher := item.SignatureCipher != ""
	if hasURL == hasCipher {
		return "", "", "", unified.ContractError("INVALID_INPUT", "媒体流条目必须且只能提供 url 或 signatureCipher 之一", false)
	}
	if !hasCipher {
		return item.URL, "", "sig", nil
	}

	cipherVals, err := url.ParseQuery(item.SignatureCipher)
	if err != nil {
		return "", "", "", unified.ContractError("INVALID_INPUT", "signatureCipher 格式无效", false)
	}
	urls := cipherVals["url"]
	sigs := cipherVals["s"]
	if len(urls) != 1 || strings.TrimSpace(urls[0]) == "" || len(sigs) != 1 || strings.TrimSpace(sigs[0]) == "" {
		return "", "", "", unified.ContractError("INVALID_INPUT", "signatureCipher 缺少有效的 url 或 s 参数", false)
	}
	sigParam = "sig"
	if spVals := cipherVals["sp"]; len(spVals) > 0 {
		if len(spVals) != 1 || (spVals[0] != "sig" && spVals[0] != "signature") {
			return "", "", "", unified.ContractError("INVALID_INPUT", "signatureCipher 包含非法的 sp 参数", false)
		}
		sigParam = spVals[0]
	}
	return strings.TrimSpace(urls[0]), strings.TrimSpace(sigs[0]), sigParam, nil
}

func validateFinalizeStreamEntries(allInputs []finalizeFormatInput, videoID string) ([]parsedStreamEntry, unified.Object, int) {
	validatedEntries := make([]parsedStreamEntry, 0, len(allInputs))
	expectedStreamID := ""

	for _, item := range allInputs {
		if item.Itag <= 0 || item.MimeType == "" {
			return nil, unified.ContractError("INVALID_INPUT", "媒体流条目缺少有效的 itag 或 mimeType", false), http.StatusBadRequest
		}
		streamURL, sigChallenge, sigParam, errPayload := resolveFinalizeStreamURL(item)
		if errPayload != nil {
			return nil, errPayload, http.StatusBadRequest
		}
		if !AllowGooglevideoPlaybackURL(streamURL) {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接必须为 https://*.googlevideo.com/videoplayback", false), http.StatusBadRequest
		}

		parsedU, err := url.Parse(streamURL)
		if err != nil {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接解析失败", false), http.StatusBadRequest
		}
		q := parsedU.Query()

		// Validate the stream's id parameter:
		// Real YouTube TVHTML5 videoplayback URLs carry a signed per-playback session ID
		// (id=o-<44 base64url chars>, signed under sparams=...,id,...) shared across all
		// streams in the response, while synthetic/test URLs may carry id=<video_id>.
		// Reject if id is missing, does not match either video_id or a valid o- playback ID,
		// or differs across streams in the same finalize request.
		idVals := q["id"]
		if len(idVals) != 1 || strings.TrimSpace(idVals[0]) == "" {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接缺少有效的 id 参数", false), http.StatusBadRequest
		}
		streamID := strings.TrimSpace(idVals[0])
		if streamID != videoID && !opaquePlaybackIDPattern.MatchString(streamID) {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接参数 id 与 video_id 不一致", false), http.StatusBadRequest
		}
		if expectedStreamID == "" {
			expectedStreamID = streamID
		} else if streamID != expectedStreamID {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接参数 id 与 video_id 不一致", false), http.StatusBadRequest
		}

		if itagVals := q["itag"]; len(itagVals) != 1 || itagVals[0] != strconv.Itoa(item.Itag) {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接参数 itag 与条目不一致", false), http.StatusBadRequest
		}

		nVal := ""
		if nVals := q["n"]; len(nVals) > 0 {
			if len(nVals) != 1 || strings.TrimSpace(nVals[0]) == "" {
				return nil, unified.ContractError("INVALID_INPUT", "媒体链接参数 n 无效", false), http.StatusBadRequest
			}
			nVal = strings.TrimSpace(nVals[0])
		}

		validatedEntries = append(validatedEntries, parsedStreamEntry{
			input:      item,
			baseURL:    streamURL,
			nChallenge: nVal,
			sChallenge: sigChallenge,
			sigParam:   sigParam,
		})
	}

	return validatedEntries, nil, 0
}

func collectFinalizeChallenges(entries []parsedStreamEntry) ([]string, []string) {
	var nChallenges []string
	nSeen := make(map[string]bool)
	var sigChallenges []string
	sigSeen := make(map[string]bool)
	for _, entry := range entries {
		if entry.nChallenge != "" && !nSeen[entry.nChallenge] {
			nSeen[entry.nChallenge] = true
			nChallenges = append(nChallenges, entry.nChallenge)
		}
		if entry.sChallenge != "" && !sigSeen[entry.sChallenge] {
			sigSeen[entry.sChallenge] = true
			sigChallenges = append(sigChallenges, entry.sChallenge)
		}
	}
	return nChallenges, sigChallenges
}

func applySolvedChallengesToFormats(entries []parsedStreamEntry, nSolved, sigSolved map[string]string) ([]ytengine.Format, unified.Object, int) {
	ytFormats := make([]ytengine.Format, 0, len(entries))
	itagCounts := make(map[int]int, len(entries))
	for _, entry := range entries {
		finalURL := entry.baseURL
		if entry.nChallenge != "" {
			solvedN := nSolved[entry.nChallenge]
			if solvedN == "" {
				return nil, unified.ContractError("UPSTREAM_INVALID_RESPONSE", "YouTube n 参数解密结果缺失", false), http.StatusBadGateway
			}
			updated, err := setURLQueryParamPreserveOrder(finalURL, "n", solvedN)
			if err != nil {
				return nil, unified.ContractError("INVALID_INPUT", "媒体链接更新失败", false), http.StatusBadRequest
			}
			finalURL = updated
		}
		if entry.sChallenge != "" {
			solvedSig := sigSolved[entry.sChallenge]
			if solvedSig == "" {
				return nil, unified.ContractError("UPSTREAM_INVALID_RESPONSE", "YouTube sig 参数解密结果缺失", false), http.StatusBadGateway
			}
			updated, err := setURLQueryParamPreserveOrder(finalURL, entry.sigParam, solvedSig)
			if err != nil {
				return nil, unified.ContractError("INVALID_INPUT", "媒体链接更新失败", false), http.StatusBadRequest
			}
			finalURL = updated
		}
		if !AllowGooglevideoPlaybackURL(finalURL) {
			return nil, unified.ContractError("INVALID_INPUT", "解密后的媒体链接不合法", false), http.StatusBadRequest
		}

		itagCounts[entry.input.Itag]++
		formatID := strconv.Itoa(entry.input.Itag)
		if count := itagCounts[entry.input.Itag]; count > 1 {
			formatID = fmt.Sprintf("%d-dup%d", entry.input.Itag, count)
		}
		yf, ok := convertToYTFormat(entry.input, formatID, finalURL)
		if !ok {
			return nil, unified.ContractError("INVALID_INPUT", "媒体流 mimeType 或参数无效", false), http.StatusBadRequest
		}
		ytFormats = append(ytFormats, yf)
	}
	return ytFormats, nil, 0
}

func buildFinalizeEnvelope(info *ytengine.Info, opts ytengine.AdaptOptions, nowUnix int64, debug bool) (unified.Object, int) {
	payload := ytengine.AdaptInfo(info, opts, nowUnix)
	if err := unified.ValidateEnvelopeAt(payload, nowUnix); err != nil {
		return unified.ContractError("INTERNAL_ERROR", "解析接口合同校验失败", false), http.StatusBadGateway
	}
	status := http.StatusOK
	if unified.Str(payload["code"]) != "OK" {
		status = http.StatusNotFound
	}
	payload = unified.PublicView(payload, debug, nowUnix)
	if err := unified.ValidateEnvelopeAt(payload, nowUnix); err != nil {
		return unified.ContractError("INTERNAL_ERROR", "解析接口合同校验失败", false), http.StatusBadGateway
	}
	return payload, status
}

func isAudioOnlyMimeType(raw string) bool {
	semi := strings.SplitN(raw, ";", 2)
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(semi[0])), "audio/")
}

func isDescriptiveAudioTrack(at *finalizeAudioTrack) bool {
	if at == nil {
		return false
	}
	combined := strings.ToLower(at.ID + " " + at.DisplayName)
	return strings.Contains(combined, "descriptive") || strings.Contains(combined, "description")
}

func isDubbedAudioTrack(at *finalizeAudioTrack) bool {
	if at == nil {
		return false
	}
	combined := strings.ToLower(at.ID + " " + at.DisplayName)
	return strings.Contains(combined, "dubbed") || strings.Contains(combined, "配音")
}

func isOriginalAudioTrack(at *finalizeAudioTrack) bool {
	if at == nil {
		return false
	}
	combined := strings.ToLower(at.ID + " " + at.DisplayName)
	return strings.Contains(combined, "original") || strings.Contains(combined, "原声") || strings.Contains(combined, "原音")
}

type xtagsAudioHints struct {
	lang          string
	isOriginal    bool
	isDescriptive bool
	isDubbed      bool
}

type audioStreamClassification struct {
	hints         xtagsAudioHints
	hasHint       bool
	isOriginal    bool
	isDescriptive bool
	isDubbed      bool
	isDefault     bool
	hasDefault    bool
}

func classifyAudioStream(at *finalizeAudioTrack, rawURL string) audioStreamClassification {
	hints := parseXtagsAudioHints(rawURL)
	isDesc := hints.isDescriptive || isDescriptiveAudioTrack(at)
	isDub := hints.isDubbed || isDubbedAudioTrack(at)
	isOrig := hints.isOriginal || isOriginalAudioTrack(at)
	hasDef := at != nil && at.AudioIsDefault != nil
	isDef := hasDef && *at.AudioIsDefault
	hasHint := at != nil || hints.isOriginal || hints.isDescriptive || hints.isDubbed
	return audioStreamClassification{
		hints:         hints,
		hasHint:       hasHint,
		isOriginal:    isOrig,
		isDescriptive: isDesc,
		isDubbed:      isDub,
		isDefault:     isDef,
		hasDefault:    hasDef,
	}
}

func filterMultiAudioStreamEntries(entries []parsedStreamEntry) []parsedStreamEntry {
	hasAnyHint := false
	hasOriginalClean := false
	hasDefaultClean := false
	hasDefaultNonDescriptive := false
	hasAnyDefault := false
	for _, e := range entries {
		if !isAudioOnlyMimeType(e.input.MimeType) {
			continue
		}
		c := classifyAudioStream(e.input.AudioTrack, e.baseURL)
		if !c.hasHint {
			continue
		}
		hasAnyHint = true
		if c.isOriginal && !c.isDescriptive && !c.isDubbed {
			hasOriginalClean = true
		}
		if c.isDefault {
			hasAnyDefault = true
			if !c.isDescriptive {
				hasDefaultNonDescriptive = true
				if !c.isDubbed {
					hasDefaultClean = true
				}
			}
		}
	}
	if !hasAnyHint || (!hasOriginalClean && !hasDefaultClean && !hasDefaultNonDescriptive && !hasAnyDefault) {
		return entries
	}
	filtered := make([]parsedStreamEntry, 0, len(entries))
	for _, e := range entries {
		if !isAudioOnlyMimeType(e.input.MimeType) {
			filtered = append(filtered, e)
			continue
		}
		c := classifyAudioStream(e.input.AudioTrack, e.baseURL)
		switch {
		case hasOriginalClean:
			if c.isOriginal && !c.isDescriptive && !c.isDubbed {
				filtered = append(filtered, e)
			}
		case hasDefaultClean:
			if c.isDefault && !c.isDescriptive && !c.isDubbed {
				filtered = append(filtered, e)
			}
		case hasDefaultNonDescriptive:
			if c.isDefault && !c.isDescriptive {
				filtered = append(filtered, e)
			}
		case hasAnyDefault:
			if c.isDefault {
				filtered = append(filtered, e)
			}
		}
	}
	return filtered
}

func extractBaseBCP47Language(rawID string) string {
	base, _, _ := strings.Cut(strings.TrimSpace(rawID), ".")
	if bcp47TagPattern.MatchString(base) {
		return base
	}
	return ""
}

func parseXtagsAudioHints(rawURL string) xtagsAudioHints {
	var hints xtagsAudioHints
	u, err := url.Parse(rawURL)
	if err != nil || u.RawQuery == "" {
		return hints
	}
	xtags := strings.TrimSpace(u.Query().Get("xtags"))
	if xtags == "" {
		return hints
	}
	for _, kv := range strings.Split(xtags, ":") {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "lang":
			if candidate := extractBaseBCP47Language(v); candidate != "" {
				hints.lang = candidate
			}
		case "acont":
			hints.isOriginal = false
			hints.isDescriptive = false
			hints.isDubbed = false
			switch strings.ToLower(strings.TrimSpace(v)) {
			case "original":
				hints.isOriginal = true
			case "descriptive":
				hints.isDescriptive = true
			case "dubbed", "dubbed-auto", "secondary":
				hints.isDubbed = true
			}
		}
	}
	return hints
}

func convertToYTFormat(in finalizeFormatInput, formatID, resolvedURL string) (ytengine.Format, bool) {
	ext, vcodec, acodec, hdr, ok := parseYouTubeMimeType(in.MimeType)
	if !ok {
		return ytengine.Format{}, false
	}
	if formatID == "" {
		formatID = strconv.Itoa(in.Itag)
	}
	f := ytengine.Format{
		FormatID:     formatID,
		URL:          resolvedURL,
		Ext:          ext,
		Protocol:     "https",
		VCodec:       vcodec,
		ACodec:       acodec,
		DynamicRange: hdr,
		FormatNote:   in.AudioQuality,
	}
	if vcodec == "none" && acodec != "none" {
		c := classifyAudioStream(in.AudioTrack, resolvedURL)
		if in.AudioTrack != nil {
			if lang := extractBaseBCP47Language(in.AudioTrack.ID); lang != "" {
				f.Language = lang
			}
		}
		if f.Language == "" && c.hints.lang != "" {
			f.Language = c.hints.lang
		}
		switch {
		case c.isOriginal && !c.isDescriptive && !c.isDubbed:
			p := 20
			f.LanguagePreference = &p
		case c.isDefault && !c.isDescriptive && !c.isDubbed:
			p := 10
			f.LanguagePreference = &p
		case c.isDescriptive:
			p := -20
			f.LanguagePreference = &p
		case c.isDubbed || (c.hasDefault && !c.isDefault):
			p := -10
			f.LanguagePreference = &p
		}
	}
	if in.Width != nil && *in.Width > 0 {
		w := *in.Width
		f.Width = &w
	}
	if in.Height != nil && *in.Height > 0 {
		h := *in.Height
		f.Height = &h
	}
	if in.FPS != nil && *in.FPS > 0 {
		fps := *in.FPS
		f.FPS = &fps
	}
	if in.Bitrate != nil && *in.Bitrate > 0 {
		kbps := float64(*in.Bitrate) / 1000.0
		f.TBR = &kbps
		if vcodec != "none" && acodec == "none" {
			vbr := kbps
			f.VBR = &vbr
		} else if vcodec == "none" && acodec != "none" {
			abr := kbps
			f.ABR = &abr
		}
	}
	if in.ContentLength != "" {
		if cl, err := strconv.ParseInt(in.ContentLength, 10, 64); err == nil && cl > 0 {
			f.Filesize = &cl
		}
	}
	if in.AudioSampleRate != "" {
		if asr, err := strconv.ParseInt(in.AudioSampleRate, 10, 64); err == nil && asr > 0 {
			f.ASR = &asr
		}
	}
	if in.AudioChannels != nil && *in.AudioChannels > 0 {
		ch := *in.AudioChannels
		f.AudioChannels = &ch
	}
	return f, true
}

func parseYouTubeMimeType(raw string) (ext, vcodec, acodec, dynamicRange string, ok bool) {
	semi := strings.SplitN(raw, ";", 2)
	mediaType := strings.ToLower(strings.TrimSpace(semi[0]))
	isVideo := false
	isAudioOnly := false
	switch mediaType {
	case "video/mp4":
		ext = "mp4"
		isVideo = true
	case "video/webm":
		ext = "webm"
		isVideo = true
	case "video/3gpp":
		ext = "3gp"
		isVideo = true
	case "audio/mp4":
		ext = "m4a"
		isAudioOnly = true
	case "audio/webm":
		ext = "webm"
		isAudioOnly = true
	default:
		return "", "", "", "", false
	}

	var codecs []string
	if len(semi) == 2 {
		rest := strings.TrimSpace(semi[1])
		if idx := strings.Index(strings.ToLower(rest), "codecs="); idx >= 0 {
			val := strings.TrimSpace(rest[idx+len("codecs="):])
			val = strings.Trim(val, `"'`)
			for _, part := range strings.Split(val, ",") {
				c := strings.TrimSpace(part)
				if c != "" {
					codecs = append(codecs, c)
				}
			}
		}
	}
	if len(codecs) == 0 {
		return "", "", "", "", false
	}

	if isAudioOnly {
		return ext, "none", codecs[0], "", true
	}
	if isVideo {
		vcodec = codecs[0]
		if len(codecs) >= 2 {
			acodec = codecs[1]
		} else {
			acodec = "none"
		}
		vcLower := strings.ToLower(vcodec)
		switch {
		case strings.HasPrefix(vcLower, "vp9.2"), strings.Contains(vcLower, ".10.0.110.09.16."):
			dynamicRange = "HDR10"
		case strings.Contains(vcLower, ".10.0.110.09.18."):
			dynamicRange = "HLG"
		default:
			dynamicRange = "SDR"
		}
		return ext, vcodec, acodec, dynamicRange, true
	}
	return "", "", "", "", false
}

func setURLQueryParamPreserveOrder(rawURL, key, value string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	encodedKV := url.QueryEscape(key) + "=" + url.QueryEscape(value)
	if u.RawQuery == "" {
		u.RawQuery = encodedKV
		return u.String(), nil
	}
	parts := strings.Split(u.RawQuery, "&")
	replaced := false
	out := make([]string, 0, len(parts)+1)
	for _, part := range parts {
		if part == "" {
			continue
		}
		k, _, _ := strings.Cut(part, "=")
		decodedK, err := url.QueryUnescape(k)
		if err != nil {
			decodedK = k
		}
		if decodedK == key {
			if !replaced {
				out = append(out, encodedKV)
				replaced = true
			}
			continue
		}
		out = append(out, part)
	}
	if !replaced {
		out = append(out, encodedKV)
	}
	u.RawQuery = strings.Join(out, "&")
	return u.String(), nil
}
