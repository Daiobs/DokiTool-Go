package youtube

import (
	"container/list"
	"sync"
)

type challengeCacheKey struct {
	playerID string
	variant  string
	digest   string
	kind     string
	input    string
}

type challengeCacheEntry struct {
	key   challengeCacheKey
	value string
}

// challengeLRU is a concurrency-safe bounded LRU cache for deterministic
// (player_id, variant, preprocessed_digest, n/sig input) -> solved outputs.
// Including variant and preprocessed digest guarantees zero cross-variant
// collision if the same player_id ever flips between tv and main scripts.
type challengeLRU struct {
	mu       sync.Mutex
	capacity int
	ll       *list.List
	items    map[challengeCacheKey]*list.Element
	hits     uint64
	misses   uint64
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
		c.hits++
		c.ll.MoveToFront(elem)
		return elem.Value.(*challengeCacheEntry).value, true
	}
	c.misses++
	return "", false
}

func (c *challengeLRU) Put(playerID, variant, digest, kind, input, value string) {
	if c == nil || playerID == "" || input == "" || value == "" {
		return
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

func (c *challengeLRU) Clear() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ll.Init()
	clear(c.items)
}

func (c *challengeLRU) Stats() (entries int, hits, misses uint64) {
	if c == nil {
		return 0, 0, 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len(), c.hits, c.misses
}
