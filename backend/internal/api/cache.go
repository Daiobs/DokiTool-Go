package api

import (
	"cmp"
	"container/list"
	"context"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const (
	parseTimeout       = 45 * time.Second
	maxYTDLPInputBytes = 2048

	defaultCacheMaxEntries = 4096
	minCacheMaxEntries     = 1
	maxCacheMaxEntries     = 65536

	defaultCacheMaxBytes int64 = 64 << 20  // 64 MiB
	minCacheMaxBytes     int64 = 1024      // 1 KiB
	maxCacheMaxBytes     int64 = 512 << 20 // 512 MiB

	defaultCacheTTL              = 300 * time.Second
	maxCacheTTL                  = 600 * time.Second
	genericCacheTTL              = 60 * time.Second
	defaultYouTubeParseCacheTTL  = 120 * time.Second
	defaultStaleIfErrorTTL       = 600 * time.Second
	defaultUpstreamBlockedNegTTL = 5 * time.Second
	shanghaiFallbackCacheTTL     = 15 * time.Second
	minCacheTTL                  = 10 * time.Second
	expirySafetyMargin           = 60 * time.Second
	staleExpiryHardMargin        = 15 * time.Second
	contentUnavailableCacheTTL   = 10 * time.Second
)

// CacheConfig bounds the in-process /api/parse and /api/resolve response cache.
type CacheConfig struct {
	Disabled   bool
	MaxEntries int
	MaxBytes   int64
}

// DefaultCacheConfig returns production cache bounds sized for a 13 GB host:
// 4,096 entries and 64 MiB total serialized key+body bytes.
func DefaultCacheConfig() CacheConfig {
	return CacheConfig{
		MaxEntries: defaultCacheMaxEntries,
		MaxBytes:   defaultCacheMaxBytes,
	}
}

// LoadCacheConfig reads DOKITOOL_PARSE_CACHE before server startup.
// Unset or "on" returns DefaultCacheConfig(); "off" disables both parseCache
// and singleflight coalescing; any other value fails startup.
func LoadCacheConfig(getenv func(string) string) (CacheConfig, error) {
	if getenv == nil {
		return CacheConfig{}, fmt.Errorf("missing cache configuration reader")
	}
	switch getenv("DOKITOOL_PARSE_CACHE") {
	case "", "on":
		return DefaultCacheConfig(), nil
	case "off":
		return CacheConfig{Disabled: true}, nil
	default:
		return CacheConfig{}, fmt.Errorf("DOKITOOL_PARSE_CACHE must be on or off")
	}
}

// Validate enforces lower and upper bounds on all cache capacity parameters.
func (c CacheConfig) Validate() error {
	if c.Disabled {
		if c.MaxEntries < 0 || c.MaxEntries > maxCacheMaxEntries {
			return fmt.Errorf("cache max entries must be between 0 and %d when disabled", maxCacheMaxEntries)
		}
		if c.MaxBytes < 0 || c.MaxBytes > maxCacheMaxBytes {
			return fmt.Errorf("cache max bytes must be between 0 and %d when disabled", maxCacheMaxBytes)
		}
		return nil
	}
	if c.MaxEntries < minCacheMaxEntries || c.MaxEntries > maxCacheMaxEntries {
		return fmt.Errorf("cache max entries must be between %d and %d", minCacheMaxEntries, maxCacheMaxEntries)
	}
	if c.MaxBytes < minCacheMaxBytes || c.MaxBytes > maxCacheMaxBytes {
		return fmt.Errorf("cache max bytes must be between %d and %d", minCacheMaxBytes, maxCacheMaxBytes)
	}
	return nil
}

// cacheablePlatform reports whether platform responses may enter parseCache
// according to the declarative platformTraits table in platform_traits.go.
func cacheablePlatform(platform string) bool {
	return platform != "" && !traitsForPlatform(platform).disableParseCache
}

func cacheableRequest(platform, source string) bool {
	if !cacheablePlatform(platform) {
		return false
	}
	if traitsForPlatform(platform).strictInput2048 && len(source) > maxYTDLPInputBytes {
		return false
	}
	return true
}

type cacheKey struct {
	route    string
	platform string
	url      string
	itemID   string
	debug    bool
}

type cachedResponse struct {
	status     int
	code       string
	platform   string
	body       []byte
	retryAfter string
	retryable  bool
}

type cacheEntry struct {
	key           cacheKey
	res           cachedResponse
	freshUntil    time.Time
	hardExpiresAt time.Time
	isOK          bool
	size          int64
	promotedSeq   uint64
	lastHitSeq    atomic.Uint64
}

type inflightCall struct {
	done        chan struct{}
	cancel      context.CancelFunc
	waiters     int
	abandoned   bool
	servedStale bool
	res         cachedResponse
}

type parseCache struct {
	mu         sync.RWMutex
	hitSeq     atomic.Uint64
	cfg        CacheConfig
	lru        *list.List
	entries    map[cacheKey]*list.Element
	inflight   map[cacheKey]*inflightCall
	totalBytes int64
}

func newParseCache(cfg CacheConfig) (*parseCache, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &parseCache{
		cfg:      cfg,
		lru:      list.New(),
		entries:  make(map[cacheKey]*list.Element),
		inflight: make(map[cacheKey]*inflightCall),
	}, nil
}

func cacheEntrySize(key cacheKey, res cachedResponse) int64 {
	return int64(len(key.route) + len(key.platform) + len(key.url) + len(key.itemID) + len(res.platform) + len(res.retryAfter) + len(res.body))
}

func storeHitSeqMonotonic(dst *atomic.Uint64, seq uint64) {
	for {
		prev := dst.Load()
		if seq <= prev || dst.CompareAndSwap(prev, seq) {
			return
		}
	}
}

// getFresh performs a pure read-lock lookup, recording a monotonic hit sequence
// number atomically without taking an exclusive lock or mutating the LRU list.
// Entries past freshUntil return false; entries past hardExpiresAt are lazily evicted under Lock().
func (c *parseCache) getFresh(key cacheKey, now time.Time) (cachedResponse, bool) {
	if c == nil || c.cfg.Disabled {
		return cachedResponse{}, false
	}
	c.mu.RLock()
	elem, ok := c.entries[key]
	if !ok {
		c.mu.RUnlock()
		return cachedResponse{}, false
	}
	entry := elem.Value.(*cacheEntry)
	if !now.Before(entry.freshUntil) {
		c.mu.RUnlock()
		return cachedResponse{}, false
	}
	storeHitSeqMonotonic(&entry.lastHitSeq, c.hitSeq.Add(1))
	res := entry.res
	c.mu.RUnlock()
	return res, true
}

func (c *parseCache) getLocked(key cacheKey, now time.Time) (cachedResponse, bool) {
	if c == nil || c.cfg.Disabled {
		return cachedResponse{}, false
	}
	elem, ok := c.entries[key]
	if !ok {
		return cachedResponse{}, false
	}
	entry := elem.Value.(*cacheEntry)
	if !now.Before(entry.freshUntil) {
		// Retain stale OK entries until hardExpiresAt so runSingleflight or open
		// circuit breakers can serve stale-if-error fallback before media expiry.
		if !now.Before(entry.hardExpiresAt) {
			c.removeElementLocked(elem)
		}
		return cachedResponse{}, false
	}
	seq := c.hitSeq.Add(1)
	storeHitSeqMonotonic(&entry.lastHitSeq, seq)
	entry.promotedSeq = entry.lastHitSeq.Load()
	c.lru.MoveToFront(elem)
	return entry.res, true
}

// getStaleLocked returns an expired-but-still-usable OK cache entry when now is
// strictly before both entry.hardExpiresAt (enforcing the earliest_expires_at - 15s
// ceiling) and entry.freshUntil + maxStaleTTL. Negative caches are never returned as stale.
func (c *parseCache) getStaleLocked(key cacheKey, now time.Time, maxStaleTTL time.Duration) (cachedResponse, bool) {
	if c == nil || c.cfg.Disabled {
		return cachedResponse{}, false
	}
	elem, ok := c.entries[key]
	if !ok {
		return cachedResponse{}, false
	}
	entry := elem.Value.(*cacheEntry)
	if !now.Before(entry.hardExpiresAt) {
		c.removeElementLocked(elem)
		return cachedResponse{}, false
	}
	if !entry.isOK || maxStaleTTL <= 0 || !now.Before(entry.freshUntil.Add(maxStaleTTL)) {
		return cachedResponse{}, false
	}
	seq := c.hitSeq.Add(1)
	storeHitSeqMonotonic(&entry.lastHitSeq, seq)
	entry.promotedSeq = entry.lastHitSeq.Load()
	c.lru.MoveToFront(elem)
	return entry.res, true
}

func (c *parseCache) deleteIfNotFreshLocked(key cacheKey, now time.Time) {
	if c == nil || c.cfg.Disabled {
		return
	}
	elem, ok := c.entries[key]
	if !ok {
		return
	}
	entry := elem.Value.(*cacheEntry)
	if !now.Before(entry.freshUntil) {
		c.removeElementLocked(elem)
	}
}

// fresh reports whether key currently has an unexpired entry without touching
// LRU order or evicting anything; admission uses it only as a routing hint.
func (c *parseCache) fresh(key cacheKey, now time.Time) bool {
	if c == nil || c.cfg.Disabled {
		return false
	}
	c.mu.RLock()
	elem, ok := c.entries[key]
	if !ok {
		c.mu.RUnlock()
		return false
	}
	fresh := now.Before(elem.Value.(*cacheEntry).freshUntil)
	c.mu.RUnlock()
	return fresh
}

// reconcileLRULocked refreshes promotedSeq from atomic read-hit sequences and
// re-links c.lru in strictly descending recency order (MRU at Front, LRU at Back).
// Because c.lru is maintained in descending promotedSeq order and lastHitSeq >= promotedSeq,
// reconciliation only runs during eviction when c.lru.Back() itself has unpromoted read hits.
func (c *parseCache) reconcileLRULocked() {
	n := c.lru.Len()
	if n <= 1 {
		if front := c.lru.Front(); front != nil {
			entry := front.Value.(*cacheEntry)
			if seq := entry.lastHitSeq.Load(); seq > entry.promotedSeq {
				entry.promotedSeq = seq
			}
		}
		return
	}
	elems := make([]*list.Element, 0, n)
	for e := c.lru.Front(); e != nil; e = e.Next() {
		entry := e.Value.(*cacheEntry)
		if seq := entry.lastHitSeq.Load(); seq > entry.promotedSeq {
			entry.promotedSeq = seq
		}
		elems = append(elems, e)
	}
	slices.SortStableFunc(elems, func(a, b *list.Element) int {
		return cmp.Compare(b.Value.(*cacheEntry).promotedSeq, a.Value.(*cacheEntry).promotedSeq)
	})
	for _, e := range elems {
		c.lru.MoveToBack(e)
	}
}

func (c *parseCache) putLocked(key cacheKey, res cachedResponse, freshUntil time.Time) {
	c.putWithStaleLocked(key, res, freshUntil, freshUntil, res.code == "OK")
}

func (c *parseCache) putWithStaleLocked(key cacheKey, res cachedResponse, freshUntil, hardExpiresAt time.Time, isOK bool) {
	if c == nil || c.cfg.Disabled {
		return
	}
	if !isOK || hardExpiresAt.Before(freshUntil) {
		hardExpiresAt = freshUntil
	}
	size := cacheEntrySize(key, res)
	if old, ok := c.entries[key]; ok {
		c.removeElementLocked(old)
	}
	if size > c.cfg.MaxBytes {
		return
	}
	for c.lru.Len() >= c.cfg.MaxEntries || c.totalBytes+size > c.cfg.MaxBytes {
		back := c.lru.Back()
		if back == nil {
			return
		}
		backEntry := back.Value.(*cacheEntry)
		if backEntry.lastHitSeq.Load() > backEntry.promotedSeq {
			c.reconcileLRULocked()
			back = c.lru.Back()
			if back == nil {
				return
			}
		}
		c.removeElementLocked(back)
	}
	seq := c.hitSeq.Add(1)
	entry := &cacheEntry{
		key:           key,
		res:           res,
		freshUntil:    freshUntil,
		hardExpiresAt: hardExpiresAt,
		isOK:          isOK,
		size:          size,
		promotedSeq:   seq,
	}
	entry.lastHitSeq.Store(seq)
	elem := c.lru.PushFront(entry)
	c.entries[key] = elem
	c.totalBytes += size
}

func (c *parseCache) removeElementLocked(elem *list.Element) {
	entry := c.lru.Remove(elem).(*cacheEntry)
	delete(c.entries, entry.key)
	c.totalBytes -= entry.size
}

// purgePlatforms evicts all cached entries (both fresh and stale) belonging to
// any platform listed in platforms so manual emergency disabled_platforms kill-switches
// take immediate effect without waiting for fresh or stale TTL expiry.
func (c *parseCache) purgePlatforms(platforms []string) int {
	if c == nil || c.cfg.Disabled || len(platforms) == 0 {
		return 0
	}
	target := make(map[string]struct{}, len(platforms))
	for _, p := range platforms {
		if p != "" {
			target[p] = struct{}{}
		}
	}
	if len(target) == 0 {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	removed := 0
	for e := c.lru.Front(); e != nil; {
		next := e.Next()
		entry := e.Value.(*cacheEntry)
		if _, match := target[entry.key.platform]; match {
			c.removeElementLocked(e)
			removed++
		}
		e = next
	}
	return removed
}

func (c *parseCache) onWaiterCanceled(key cacheKey, call *inflightCall) {
	var cancel context.CancelFunc
	c.mu.Lock()
	select {
	case <-call.done:
		c.mu.Unlock()
		return
	default:
	}
	call.waiters--
	if call.waiters == 0 && !call.abandoned {
		call.abandoned = true
		if c.inflight[key] == call {
			delete(c.inflight, key)
		}
		cancel = call.cancel
	}
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (c *parseCache) stats() (entries int, totalBytes int64) {
	if c == nil {
		return 0, 0
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.lru.Len(), c.totalBytes
}

func (c *parseCache) configSnapshot() (enabled bool, entries int, totalBytes int64, maxEntries int, maxBytes int64) {
	if c == nil {
		return false, 0, 0, 0, 0
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return !c.cfg.Disabled, c.lru.Len(), c.totalBytes, c.cfg.MaxEntries, c.cfg.MaxBytes
}

// canonicalizeParseInput strips unkeyed URL fragments and standard default
// HTTP/HTTPS ports (:80/:443) — and canonicalizes Instagram extra path segments
// — before dispatching source to platform adapters so cache keys and parser
// inputs stay aligned without shrinking overlong strictInput2048 URLs.
func canonicalizeParseInput(platform, source string) string {
	if traitsForPlatform(platform).strictInput2048 && len(source) > maxYTDLPInputBytes {
		return source
	}
	u, err := url.Parse(source)
	if err != nil || u.Host == "" || u.User != nil || u.Opaque != "" || strings.HasSuffix(u.Host, ":") {
		return source
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	escapedPath := u.EscapedPath()
	if platform == "instagram" && (scheme == "http" || scheme == "https") && port == "" {
		if s, h, p, ok := normalizeInstagramCacheURL(source); ok {
			scheme, host, escapedPath = s, h, p
		}
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	var b strings.Builder
	b.Grow(len(source) + 8)
	b.WriteString(scheme)
	b.WriteString("://")
	b.WriteString(host)
	if port != "" {
		b.WriteByte(':')
		b.WriteString(port)
	}
	b.WriteString(escapedPath)
	if u.ForceQuery || u.RawQuery != "" {
		b.WriteByte('?')
		b.WriteString(u.RawQuery)
	}
	return b.String()
}

// normalizeCacheURL canonicalizes HTTP-equivalent URL syntax and known domain
// aliases without reordering or stripping query parameters (preserving ?p=N,
// duplicate query precedence, xsec_token, modal_id, and path selectors).
func normalizeCacheURL(platform, source string) string {
	if traitsForPlatform(platform).strictInput2048 && len(source) > maxYTDLPInputBytes {
		// Keep a disjoint prefix so >2048-byte inputs rejected by platform parsers
		// never shrink or match a <=2048-byte alias that expanded on rewrite.
		return "overlong:" + source
	}
	u, err := url.Parse(source)
	if err != nil || u.Host == "" || u.User != nil || u.Opaque != "" || strings.HasSuffix(u.Host, ":") {
		return source
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	escapedPath := u.EscapedPath()
	forceQuery := u.ForceQuery
	isStandardHTTP := (scheme == "http" || scheme == "https") && port == ""

	if isStandardHTTP {
		scheme, host, escapedPath = normalizePlatformCacheURL(platform, source, scheme, host, escapedPath)
	}

	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if escapedPath == "" {
		escapedPath = "/"
	}
	var b strings.Builder
	b.Grow(len(source) + 8)
	b.WriteString(scheme)
	b.WriteString("://")
	b.WriteString(host)
	if port != "" {
		b.WriteByte(':')
		b.WriteString(port)
	}
	b.WriteString(escapedPath)
	if forceQuery || u.RawQuery != "" {
		b.WriteByte('?')
		b.WriteString(u.RawQuery)
	}
	return b.String()
}

func defaultRuntimeCachePolicy() RuntimeCachePolicy {
	return RuntimeCachePolicy{
		YouTubeParseTTL:       defaultYouTubeParseCacheTTL,
		StaleIfErrorTTL:       defaultStaleIfErrorTTL,
		UpstreamBlockedNegTTL: defaultUpstreamBlockedNegTTL,
	}
}

// computeCacheTTLForPlatform applies computeCacheTTLForResult using default cache policy.
func computeCacheTTLForPlatform(platform string, payload unified.Object, now time.Time) (time.Duration, bool) {
	return computeCacheTTLForResult(platform, payload, now, false)
}

// computeCacheTTLForResult applies tiered caching TTLs using default cache policy:
//   - Core OK responses: up to 600s (clamped by earliest_expires_at - now - 60s),
//     or 300s default when no expires_at is present.
//   - YouTube OK responses: capped at cache.youtube_parse_ttl (default 120s; 0s disables).
//   - Tier-2 generic OK responses: capped at 60s.
//   - Shanghai-enabled platforms (Douyin / Bilibili) that degraded/fell back to
//     overseas routes: capped at 15s so the cache self-heals promptly on recovery.
//   - CONTENT_UNAVAILABLE: 10s negative cache.
//   - UPSTREAM_BLOCKED: cache.upstream_blocked_neg_ttl negative cache (default 5s; 0s disables).
func computeCacheTTLForResult(platform string, payload unified.Object, now time.Time, shanghaiFallback bool) (time.Duration, bool) {
	freshUntil, _, ok := computeCacheDeadlines(platform, payload, now, shanghaiFallback, defaultRuntimeCachePolicy())
	if !ok {
		return 0, false
	}
	return freshUntil.Sub(now), true
}

// computeCacheDeadlines computes both freshUntil and hardExpiresAt (for stale-if-error).
// IRON RULE: for OK responses with expires_at, hardExpiresAt never exceeds earliest_expires_at - 15s.
// Negative caches (CONTENT_UNAVAILABLE, UPSTREAM_BLOCKED) set hardExpiresAt = freshUntil
// and are never served as stale fallback.
func computeCacheDeadlines(
	platform string,
	payload unified.Object,
	now time.Time,
	shanghaiFallback bool,
	policy RuntimeCachePolicy,
) (freshUntil, hardExpiresAt time.Time, ok bool) {
	switch unified.Str(payload["code"]) {
	case "CONTENT_UNAVAILABLE":
		until := now.Add(contentUnavailableCacheTTL)
		return until, until, true
	case "UPSTREAM_BLOCKED":
		if policy.UpstreamBlockedNegTTL <= 0 {
			return time.Time{}, time.Time{}, false
		}
		until := now.Add(policy.UpstreamBlockedNegTTL)
		return until, until, true
	case "OK":
	default:
		return time.Time{}, time.Time{}, false
	}

	if platform == "youtube" && policy.YouTubeParseTTL <= 0 {
		return time.Time{}, time.Time{}, false
	}
	data := unified.Map(payload["data"])
	if data == nil {
		return time.Time{}, time.Time{}, false
	}
	earliest, hasExpiry, valid := earliestExpiresAt(data)
	if !valid {
		return time.Time{}, time.Time{}, false
	}
	var freshTTL time.Duration
	if !hasExpiry {
		freshTTL = defaultCacheTTL
	} else {
		freshTTL = min(maxCacheTTL, earliest.Sub(now)-expirySafetyMargin)
		if freshTTL < minCacheTTL {
			return time.Time{}, time.Time{}, false
		}
	}

	traits := traitsForPlatform(platform)
	if traits.maxOKCacheTTL > 0 && freshTTL > traits.maxOKCacheTTL {
		freshTTL = traits.maxOKCacheTTL
	}
	if platform == "youtube" && policy.YouTubeParseTTL > 0 && freshTTL > policy.YouTubeParseTTL {
		freshTTL = policy.YouTubeParseTTL
	}
	if shanghaiFallback && traits.shanghaiFallbackShortTTL && freshTTL > shanghaiFallbackCacheTTL {
		freshTTL = shanghaiFallbackCacheTTL
	}

	freshUntil = now.Add(freshTTL)
	hardExpiresAt = freshUntil
	if policy.StaleIfErrorTTL > 0 {
		hardExpiresAt = freshUntil.Add(policy.StaleIfErrorTTL)
	}
	if hasExpiry {
		ceiling := earliest.Add(-staleExpiryHardMargin)
		if ceiling.Before(freshUntil) {
			return time.Time{}, time.Time{}, false
		}
		if ceiling.Before(hardExpiresAt) {
			hardExpiresAt = ceiling
		}
	}
	return freshUntil, hardExpiresAt, true
}

// computeCacheTTL implements base caching TTL bounds:
//   - code == "OK": TTL = min(600s, earliest_expires_at - now - 60s), or 300s
//     when no expires_at exists anywhere in the response; skip if TTL < 10s.
//   - code == "CONTENT_UNAVAILABLE": TTL = 10s.
//   - code == "UPSTREAM_BLOCKED": TTL = 5s (defaultUpstreamBlockedNegTTL).
//   - all other codes: never cached.
func computeCacheTTL(payload unified.Object, now time.Time) (time.Duration, bool) {
	freshUntil, _, ok := computeCacheDeadlines("", payload, now, false, defaultRuntimeCachePolicy())
	if !ok {
		return 0, false
	}
	return freshUntil.Sub(now), true
}

func earliestExpiresAt(data unified.Object) (earliest time.Time, hasExpiry bool, valid bool) {
	valid = true
	observe := func(obj unified.Object) {
		if !valid || obj == nil {
			return
		}
		raw, exists := obj["expires_at"]
		if !exists || raw == nil {
			return
		}
		text, ok := raw.(string)
		if !ok || text == "" {
			valid = false
			return
		}
		parsed, err := time.Parse(time.RFC3339Nano, text)
		if err != nil {
			valid = false
			return
		}
		if !hasExpiry || parsed.Before(earliest) {
			earliest = parsed
			hasExpiry = true
		}
	}

	observe(unified.Map(data["cover"]))
	observe(unified.Map(unified.Map(data["author"])["avatar"]))

	for _, itemVal := range unified.Slice(data["items"]) {
		item := unified.Map(itemVal)
		if item == nil {
			continue
		}
		observe(unified.Map(item["cover"]))
		observe(unified.Map(item["default"]))
		for _, varVal := range unified.Slice(item["variants"]) {
			variant := unified.Map(varVal)
			if variant == nil || unified.Str(variant["state"]) == "deferred" {
				continue
			}
			for _, sources := range unified.DeliverySources(unified.Map(variant["delivery"])) {
				for _, srcVal := range sources {
					observe(unified.Map(srcVal))
				}
			}
		}
	}

	for _, attVal := range unified.Slice(data["attachments"]) {
		att := unified.Map(attVal)
		if att == nil {
			continue
		}
		observe(unified.Map(att["cover"]))
		observe(unified.Map(unified.Map(att["author"])["avatar"]))
		res := unified.Map(att["resource"])
		for _, sources := range unified.DeliverySources(unified.Map(res["delivery"])) {
			for _, srcVal := range sources {
				observe(unified.Map(srcVal))
			}
		}
	}
	return earliest, hasExpiry, valid
}
