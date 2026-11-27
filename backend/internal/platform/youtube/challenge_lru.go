package youtube

import (
	"container/list"
	"sync"
	"time"
)

type challengeCacheKey struct {
	playerID string
	variant  string
	digest   string
	kind     string
	input    string
}

type challengeCacheEntry struct {
	key       challengeCacheKey
	value     string
	sizeBytes int
	expiresAt time.Time
}

func challengeEntryBytes(key challengeCacheKey, value string) int {
	return len(key.playerID) + len(key.variant) + len(key.digest) + len(key.kind) + len(key.input) + len(value)
}

// challengeLRU is a concurrency-safe bounded LRU cache for deterministic
// (player_id, variant, preprocessed_digest, n/sig input) -> solved outputs.
// Including variant and preprocessed digest guarantees zero cross-variant
// collision if the same player_id ever flips between tv and main scripts.
type challengeLRU struct {
	mu         sync.Mutex
	capacity   int
	maxBytes   int
	ttl        time.Duration
	now        func() time.Time
	totalBytes int
	ll         *list.List
	items      map[challengeCacheKey]*list.Element
	hits       uint64
	misses     uint64
}

func newChallengeLRU(capacity int) *challengeLRU {
	return newChallengeLRUWithConfig(capacity, MaxChallengeCacheBytes, DefaultChallengeCacheTTL, time.Now)
}

func newChallengeLRUWithConfig(capacity, maxBytes int, ttl time.Duration, now func() time.Time) *challengeLRU {
	if capacity <= 0 {
		capacity = MaxChallengeCacheEntries
	}
	if maxBytes <= 0 {
		maxBytes = MaxChallengeCacheBytes
	}
	if ttl <= 0 {
		ttl = DefaultChallengeCacheTTL
	}
	if now == nil {
		now = time.Now
	}
	return &challengeLRU{
		capacity: capacity,
		maxBytes: maxBytes,
		ttl:      ttl,
		now:      now,
		ll:       list.New(),
		items:    make(map[challengeCacheKey]*list.Element),
	}
}

func (c *challengeLRU) removeElementLocked(elem *list.Element) {
	if elem == nil {
		return
	}
	entry := elem.Value.(*challengeCacheEntry)
	c.ll.Remove(elem)
	delete(c.items, entry.key)
	c.totalBytes -= entry.sizeBytes
	if c.totalBytes < 0 {
		c.totalBytes = 0
	}
}

func (c *challengeLRU) Get(playerID, variant, digest, kind, input string) (string, bool) {
	if c == nil || playerID == "" || input == "" {
		return "", false
	}
	key := challengeCacheKey{
		playerID: playerID,
		variant:  variant,
		digest:   digest,
		kind:     kind,
		input:    input,
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.items[key]; ok {
		entry := elem.Value.(*challengeCacheEntry)
		if !entry.expiresAt.IsZero() && !c.now().Before(entry.expiresAt) {
			c.removeElementLocked(elem)
			c.misses++
			return "", false
		}
		c.hits++
		c.ll.MoveToFront(elem)
		return entry.value, true
	}
	c.misses++
	return "", false
}

func (c *challengeLRU) Put(playerID, variant, digest, kind, input, value string) {
	if c == nil || playerID == "" || input == "" || value == "" {
		return
	}
	if len(input) > MaxChallengeSigBytes || len(value) > MaxChallengeOutputBytes {
		return
	}
	key := challengeCacheKey{
		playerID: playerID,
		variant:  variant,
		digest:   digest,
		kind:     kind,
		input:    input,
	}
	sizeBytes := challengeEntryBytes(key, value)
	if sizeBytes > c.maxBytes {
		return
	}
	now := c.now()
	expiresAt := now.Add(c.ttl)
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.items[key]; ok {
		entry := elem.Value.(*challengeCacheEntry)
		c.totalBytes += sizeBytes - entry.sizeBytes
		entry.value = value
		entry.sizeBytes = sizeBytes
		entry.expiresAt = expiresAt
		c.ll.MoveToFront(elem)
	} else {
		elem := c.ll.PushFront(&challengeCacheEntry{
			key:       key,
			value:     value,
			sizeBytes: sizeBytes,
			expiresAt: expiresAt,
		})
		c.items[key] = elem
		c.totalBytes += sizeBytes
	}
	for c.ll.Len() > 0 {
		back := c.ll.Back()
		if back == nil {
			break
		}
		entry := back.Value.(*challengeCacheEntry)
		expired := !entry.expiresAt.IsZero() && !now.Before(entry.expiresAt)
		if c.ll.Len() <= c.capacity && c.totalBytes <= c.maxBytes && !expired {
			break
		}
		c.removeElementLocked(back)
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

func (c *challengeLRU) Bytes() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.totalBytes
}

func (c *challengeLRU) Clear() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ll.Init()
	clear(c.items)
	c.totalBytes = 0
}

func (c *challengeLRU) Stats() (entries int, hits, misses uint64) {
	if c == nil {
		return 0, 0, 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len(), c.hits, c.misses
}
