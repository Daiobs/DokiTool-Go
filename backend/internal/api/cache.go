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

	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/instagram"
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

	defaultCacheTTL            = 60 * time.Second
	maxCacheTTL                = 180 * time.Second
	minCacheTTL                = 10 * time.Second
	expirySafetyMargin         = 60 * time.Second
	contentUnavailableCacheTTL = 10 * time.Second
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

// cacheablePlatform excludes platforms whose responses carry requester-bound,
// channel-dependent, or server-egress-IP-bound artifacts:
//   - weibo: mints HMAC-signed /api/media/weibo?ticket=... relay tickets (and
//     differs between anonymous visitors and owner-token callers in PR 5).
//   - youtube: helper sessions use /api/youtube/context + /api/youtube/finalize,
//     and /api/parse yields egress-IP-bound googlevideo.com stream URLs.
func cacheablePlatform(platform string) bool {
	switch platform {
	case "", "weibo", "youtube":
		return false
	default:
		return true
	}
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
	body       []byte
	retryAfter string
}

type cacheEntry struct {
	key         cacheKey
	res         cachedResponse
	expiresAt   time.Time
	size        int64
	promotedSeq uint64
	lastHitSeq  atomic.Uint64
}

type inflightCall struct {
	done      chan struct{}
	cancel    context.CancelFunc
	waiters   int
	abandoned bool
	res       cachedResponse
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
	return int64(len(key.route) + len(key.platform) + len(key.url) + len(key.itemID) + len(res.retryAfter) + len(res.body))
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
// Expired entries return false and are lazily evicted under Lock() on miss/write.
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
	if !now.Before(entry.expiresAt) {
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
	if !now.Before(entry.expiresAt) {
		c.removeElementLocked(elem)
		return cachedResponse{}, false
	}
	seq := c.hitSeq.Add(1)
	storeHitSeqMonotonic(&entry.lastHitSeq, seq)
	entry.promotedSeq = entry.lastHitSeq.Load()
	c.lru.MoveToFront(elem)
	return entry.res, true
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
	fresh := now.Before(elem.Value.(*cacheEntry).expiresAt)
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

func (c *parseCache) putLocked(key cacheKey, res cachedResponse, expiresAt time.Time) {
	if c == nil || c.cfg.Disabled {
		return
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
		key:         key,
		res:         res,
		expiresAt:   expiresAt,
		size:        size,
		promotedSeq: seq,
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
		switch platform {
		case "x":
			switch host {
			case "x.com", "www.x.com", "mobile.x.com", "m.x.com",
				"twitter.com", "www.twitter.com", "mobile.twitter.com", "m.twitter.com":
				host = "x.com"
				scheme = "https"
			case "t.co":
				host = "t.co"
				scheme = "https"
			}
		case "instagram":
			if _, canonical, ok := instagram.ExtractPostTarget(source); ok {
				if cu, parseErr := url.Parse(canonical); parseErr == nil {
					scheme = "https"
					host = "www.instagram.com"
					escapedPath = cu.EscapedPath()
				}
			} else {
				switch host {
				case "www.instagram.com", "instagram.com", "m.instagram.com":
					host = "www.instagram.com"
					scheme = "https"
				}
			}
		case "facebook":
			if host == "facebook.com" || host == "m.facebook.com" {
				host = "www.facebook.com"
				scheme = "https"
			}
		case "tumblr":
			if host == "tumblr.com" {
				host = "www.tumblr.com"
				scheme = "https"
			}
		}
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

// computeCacheTTL implements the Issue #102 PR 1 caching policy:
//   - code == "OK": TTL = min(180s, earliest_expires_at - now - 60s), or 60s
//     when no expires_at exists anywhere in the response; skip if TTL < 10s.
//   - code == "CONTENT_UNAVAILABLE": TTL = 10s.
//   - all other codes: never cached.
func computeCacheTTL(payload unified.Object, now time.Time) (time.Duration, bool) {
	switch unified.Str(payload["code"]) {
	case "CONTENT_UNAVAILABLE":
		return contentUnavailableCacheTTL, true
	case "OK":
	default:
		return 0, false
	}
	data := unified.Map(payload["data"])
	if data == nil {
		return 0, false
	}
	earliest, hasExpiry, valid := earliestExpiresAt(data)
	if !valid {
		return 0, false
	}
	if !hasExpiry {
		return defaultCacheTTL, true
	}
	ttl := min(maxCacheTTL, earliest.Sub(now)-expirySafetyMargin)
	if ttl < minCacheTTL {
		return 0, false
	}
	return ttl, true
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
