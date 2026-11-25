package youtube

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
)

type playerCacheEntry struct {
	PlayerID             string
	Variant              string
	PreprocessedDigest   string
	SignatureTimestamp   int
	RawPlayerJS          string
	PreprocessedPlayerJS string
	FirstFetchedAt       time.Time
	FetchedAt            time.Time
	ExpiresAt            time.Time
	StaleUntil           time.Time
}

type playerRefreshCall struct {
	done  chan struct{}
	entry *playerCacheEntry
	err   error
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

func preprocessedDigestHex16(preprocessed string) string {
	sum := sha256.Sum256([]byte(preprocessed))
	return hex.EncodeToString(sum[:8])
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

func (h *Helper) effectiveMaxRenewalAgeLocked() time.Duration {
	if h.maxPlayerRenewalAge <= 0 {
		return MaxPlayerRenewalAge
	}
	return h.maxPlayerRenewalAge
}

func (h *Helper) failureCooldownDurationLocked(consecutive int) time.Duration {
	backoffs := h.refreshFailureBackoffs
	if len(backoffs) == 0 {
		return 0
	}
	if consecutive <= 1 {
		return backoffs[0]
	}
	idx := consecutive - 1
	if idx >= len(backoffs) {
		idx = len(backoffs) - 1
	}
	return backoffs[idx]
}

func (h *Helper) isInCooldownLocked(now time.Time) bool {
	return !h.nextRetryAfter.IsZero() && now.Before(h.nextRetryAfter)
}

func (h *Helper) needsProactiveRefresh() bool {
	if h == nil || !h.isUpstreamAllowed() {
		return false
	}
	now := h.now()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.isInCooldownLocked(now) {
		return false
	}
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

func (h *Helper) startAsyncRefreshLocked(now time.Time) {
	if h.refreshCall != nil || h.isInCooldownLocked(now) || !h.isUpstreamAllowedLocked() {
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

// runSingleflightRefresh joins or starts a singleflight refresh without checking
// cooldown; intended only for startup prewarm (which applies its own backoff) and
// internal callers that have already checked cooldown state.
func (h *Helper) runSingleflightRefresh(ctx context.Context) (*playerCacheEntry, error) {
	if !h.isUpstreamAllowed() {
		return nil, errYouTubeHelperDisabled
	}
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
	h.refreshAttempts.Add(1)
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
	now := h.now()
	if err == nil && entry != nil {
		h.refreshSuccesses.Add(1)
		h.mu.Lock()
		h.consecutiveFailures = 0
		h.nextRetryAfter = time.Time{}
		h.mu.Unlock()
	} else {
		h.refreshFailures.Add(1)
		h.mu.Lock()
		// Record failure cooldown whenever the detached refresh base stayed active
		// (i.e. not server shutdown, pre-canceled entry, or deliberate kill-switch
		// disablement). A caller canceling mid-flight while refreshBase stays alive
		// still completed a real upstream failure/timeout and must feed cooldown.
		if refreshBase.Err() == nil && !errors.Is(err, errYouTubeHelperDisabled) {
			h.consecutiveFailures++
			if cooldown := h.failureCooldownDurationLocked(h.consecutiveFailures); cooldown > 0 {
				h.nextRetryAfter = now.Add(cooldown)
			}
		}
		if fallbackStaleOnErr && !h.disabled.Load() && h.activeID != "" {
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
	if h.disabled.Load() {
		return nil, errYouTubeHelperDisabled
	}
	now := h.now()
	h.mu.Lock()
	if h.activeID != "" {
		if existing, ok := h.cache[h.activeID]; ok {
			softBefore := h.effectiveSoftRefreshBeforeLocked()
			if now.Before(existing.ExpiresAt) {
				if softBefore > 0 && !now.Before(existing.ExpiresAt.Add(-softBefore)) {
					h.startAsyncRefreshLocked(now)
				}
				h.mu.Unlock()
				return existing, nil
			}
			if !now.After(existing.StaleUntil) {
				h.startAsyncRefreshLocked(now)
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
	if !h.isUpstreamAllowedLocked() {
		h.mu.Unlock()
		return nil, errYouTubeHelperDisabled
	}
	if h.isInCooldownLocked(now) {
		h.cooldownSkips.Add(1)
		h.mu.Unlock()
		return nil, errYouTubeHelperCooldown
	}
	call := &playerRefreshCall{done: make(chan struct{})}
	h.refreshCall = call
	h.mu.Unlock()

	return h.executeRefreshCall(ctx, call, true)
}

func (h *Helper) refreshActivePlayer(ctx context.Context) (*playerCacheEntry, error) {
	if !h.isUpstreamAllowed() {
		return nil, errYouTubeHelperDisabled
	}
	playerID, err := h.fetchCurrentPlayerID(ctx)
	if err != nil {
		return nil, err
	}

	now := h.now()
	h.mu.Lock()
	maxRenewalAge := h.effectiveMaxRenewalAgeLocked()
	if existing, ok := h.cache[playerID]; ok && !now.After(existing.StaleUntil) {
		firstFetched := existing.FirstFetchedAt
		if firstFetched.IsZero() {
			firstFetched = existing.FetchedAt
		}
		if now.Sub(firstFetched) < maxRenewalAge {
			expiresAt := now.Add(h.cacheTTL)
			renewed := *existing
			renewed.FirstFetchedAt = firstFetched
			renewed.FetchedAt = now
			renewed.ExpiresAt = expiresAt
			renewed.StaleUntil = expiresAt.Add(StalePlayerFallbackWindow)
			h.storeCacheEntryLocked(&renewed)
			h.activeID = playerID
			h.mu.Unlock()
			return &renewed, nil
		}
	}
	h.mu.Unlock()

	rawJS, sts, preprocessed, variantName, err := h.fetchAndPreprocessPlayerJS(ctx, playerID)
	if err != nil {
		return nil, err
	}
	digest := preprocessedDigestHex16(preprocessed)

	now = h.now()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.disabled.Load() {
		return nil, errYouTubeHelperDisabled
	}
	expiresAt := now.Add(h.cacheTTL)
	entry := &playerCacheEntry{
		PlayerID:             playerID,
		Variant:              variantName,
		PreprocessedDigest:   digest,
		SignatureTimestamp:   sts,
		RawPlayerJS:          rawJS,
		PreprocessedPlayerJS: preprocessed,
		FirstFetchedAt:       now,
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
	if h.disabled.Load() {
		return nil, false
	}
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

// InvalidateCache clears all cached player scripts, challenge LRU entries, and
// failure cooldown state. Invoked automatically when the youtube platform is
// disabled via runtime kill-switch.
func (h *Helper) InvalidateCache() {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.activeID = ""
	clear(h.cache)
	h.order = nil
	h.consecutiveFailures = 0
	h.nextRetryAfter = time.Time{}
	h.mu.Unlock()
	h.challengeCache.Clear()
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

func (h *Helper) fetchAndPreprocessPlayerJS(ctx context.Context, playerID string) (string, int, string, string, error) {
	var errs []string
	for idx, variant := range playerJSVariants {
		if ctx.Err() != nil {
			return "", 0, "", "", ctx.Err()
		}
		rawJS, sts, err := h.fetchPlayerJSVariant(ctx, playerID, variant)
		if err != nil {
			if ctx.Err() != nil {
				return "", 0, "", "", ctx.Err()
			}
			errs = append(errs, fmt.Sprintf("%s fetch: %v", variant.name, err))
			continue
		}
		preprocessed, err := h.sandbox.PreprocessAndProbePlayer(ctx, rawJS)
		if err != nil {
			if ctx.Err() != nil {
				return "", 0, "", "", ctx.Err()
			}
			errs = append(errs, fmt.Sprintf("%s preprocess/probe: %v", variant.name, err))
			continue
		}
		if idx > 0 && len(errs) > 0 {
			log.Printf("WARN: youtube helper player %s fell back to %s variant after %s", playerID, variant.name, strings.Join(errs, "; "))
		}
		return rawJS, sts, preprocessed, variant.name, nil
	}
	return "", 0, "", "", fmt.Errorf("preprocess player %s failed across variants (%s)", playerID, strings.Join(errs, "; "))
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
