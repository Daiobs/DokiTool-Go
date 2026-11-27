package api

import (
	"bytes"
	"container/list"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/bearer"
)

const (
	// EnvAPIKeysFile points to an optional JSON manifest declaring named SHA-256 API keys.
	EnvAPIKeysFile = "DOKITOOL_API_KEYS_FILE"

	// MaxAPIKeys caps total configured API keys (implicit DOKITOOL_OWNER_TOKEN + file entries).
	MaxAPIKeys = 64

	// MaxAPIKeysFileBytes bounds the DOKITOOL_API_KEYS_FILE manifest size read from disk.
	MaxAPIKeysFileBytes = 64 << 10

	// RoleOwner grants full API access including GET /api/stats.
	RoleOwner = "owner"
	// RoleAgent grants automation parse/resolve/catalog access without /api/stats.
	RoleAgent = "agent"
	// RoleFriend grants low-rate shared parse/resolve/catalog access without /api/stats.
	RoleFriend = "friend"
)

const (
	defaultAgentConcurrency     = 4
	maxAgentConcurrency         = 32
	defaultAgentSlowConcurrency = 1
	maxAgentSlowConcurrency     = 24
	defaultAgentRPS             = 5.0
	maxAgentRPS                 = 1000.0
	defaultAgentBurst           = 16
	maxAgentBurst               = 1000
	defaultAgentQueueSize       = 128
	maxAgentQueueSize           = 4096
	defaultAgentQueueWait       = 45 * time.Second
	maxAgentQueueWait           = 120 * time.Second

	defaultFriendConcurrency     = 2
	maxFriendConcurrency         = 16
	defaultFriendSlowConcurrency = 1
	maxFriendSlowConcurrency     = 16
	defaultFriendRPS             = 1.0
	maxFriendRPS                 = 100.0
	defaultFriendBurst           = 6
	maxFriendBurst               = 200
	defaultFriendQueueSize       = 16
	maxFriendQueueSize           = 512
	defaultFriendQueueWait       = 15 * time.Second
	maxFriendQueueWait           = 60 * time.Second

	maxOwnerSlowConcurrency = 24
	maxOwnerRPS             = 1000.0
	maxOwnerBurst           = 1000

	minFastReadRPS   = 20.0
	minFastReadBurst = 64.0
)

var apiKeyIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

var allowedKeyPlatforms = map[string]struct{}{
	"douyin":        {},
	"bilibili":      {},
	"weibo":         {},
	"toutiao":       {},
	"kuaishou":      {},
	"pipixia":       {},
	"pipigx":        {},
	"zuiyou":        {},
	"xiaohongshu":   {},
	"pinterest":     {},
	"tiktok":        {},
	"x":             {},
	"youtube":       {},
	"instagram":     {},
	"facebook":      {},
	"tumblr":        {},
	PlatformGeneric: {},
}

var dedicatedSystemEnvKeys = [4]string{
	"SNAP_INGRESS_KEY",
	"SNAP_MEDIA_SIGNING_KEY",
	"DOKITOOL_SHANGHAI_TOKEN",
	"DOKITOOL_SHANGHAI_PULL_TOKEN",
}

// APIKeyStatsSnapshot reports non-secret configuration and runtime telemetry for one API key.
type APIKeyStatsSnapshot struct {
	ID                   string `json:"id"`
	Role                 string `json:"role"`
	Enabled              bool   `json:"enabled"`
	Active               int    `json:"active"`
	SlowActive           int    `json:"slow_active"`
	Queued               int    `json:"queued"`
	ConcurrencyLimit     int    `json:"concurrency_limit"`
	SlowConcurrencyLimit int    `json:"slow_concurrency_limit"`
	QueueLimit           int    `json:"queue_limit"`
	RequestsTotal        uint64 `json:"requests_total"`
	OK                   uint64 `json:"ok"`
	Errors               uint64 `json:"errors"`
	CacheHits            uint64 `json:"cache_hits"`
	RateLimited          uint64 `json:"rate_limited"`
	Unauthorized         uint64 `json:"unauthorized"`
	Waited               uint64 `json:"waited"`
	Granted              uint64 `json:"granted"`
	Timeout              uint64 `json:"timeout"`
	Full                 uint64 `json:"full"`
	Canceled             uint64 `json:"canceled"`
	WaitMSTotal          uint64 `json:"wait_ms_total"`
	WaitMSMax            uint64 `json:"wait_ms_max"`
}

type rawAPIKeysManifest struct {
	Keys *[]*rawAPIKeyEntry `json:"keys"`
}

type rawAPIKeyEntry struct {
	ID              string   `json:"id"`
	Role            string   `json:"role"`
	Enabled         *bool    `json:"enabled"`
	TokenSHA256     string   `json:"token_sha256"`
	Concurrency     *int     `json:"concurrency"`
	SlowConcurrency *int     `json:"slow_concurrency"`
	RPS             *float64 `json:"rps"`
	Burst           *int     `json:"burst"`
	QueueSize       *int     `json:"queue_size"`
	QueueWait       *string  `json:"queue_wait"`
	Platforms       []string `json:"platforms"`
}

type keyCounters struct {
	requestsTotal atomic.Uint64
	ok            atomic.Uint64
	errors        atomic.Uint64
	cacheHits     atomic.Uint64
	rateLimited   atomic.Uint64
	unauthorized  atomic.Uint64
	queueStats    poolQueueCounters
}

type keyWaiter struct {
	elem    *list.Element
	isSlow  bool
	granted chan struct{}
}

type keyPool struct {
	mu              sync.Mutex
	concurrency     int
	slowConcurrency int
	rps             float64
	burst           float64
	fastRPS         float64
	fastBurst       float64
	queueSize       int
	queueWait       time.Duration

	active     int
	slowActive int
	parseRate  bucket
	fastRate   bucket
	waiters    list.List
	counters   *keyCounters
}

func newKeyPool(concurrency, slowConcurrency int, rps float64, burst, queueSize int, queueWait time.Duration, counters *keyCounters) *keyPool {
	if counters == nil {
		counters = &keyCounters{}
	}
	var fastRPS, fastBurst float64
	if rps > 0 {
		fastRPS = max(rps*4, minFastReadRPS)
		fastBurst = max(float64(burst)*4, minFastReadBurst)
	}
	return &keyPool{
		concurrency:     concurrency,
		slowConcurrency: slowConcurrency,
		rps:             rps,
		burst:           float64(burst),
		fastRPS:         fastRPS,
		fastBurst:       fastBurst,
		queueSize:       queueSize,
		queueWait:       queueWait,
		counters:        counters,
	}
}

func newOwnerPool(slots int, queueWait time.Duration, queueSize int) *keyPool {
	return newKeyPool(slots, 0, 0, 0, queueSize, queueWait, &keyCounters{})
}

func boundedRetrySeconds(deficitTokens, rate float64) int {
	waitSec := math.Ceil(max(1, deficitTokens/rate))
	if math.IsNaN(waitSec) || math.IsInf(waitSec, 0) || waitSec > 86400 {
		return 86400
	}
	return int(waitSec)
}

func (p *keyPool) currentQueueWait() time.Duration {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	d := p.queueWait
	p.mu.Unlock()
	return d
}

// reconfigure updates quota parameters in-place under p.mu so SIGHUP reloads
// preserve active concurrency leases, queued FIFO waiters, and rate buckets.
func (p *keyPool) reconfigure(concurrency, slowConcurrency int, rps float64, burst, queueSize int, queueWait time.Duration) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	var fastRPS, fastBurst float64
	if rps > 0 {
		fastRPS = max(rps*4, minFastReadRPS)
		fastBurst = max(float64(burst)*4, minFastReadBurst)
	}
	p.concurrency = concurrency
	p.slowConcurrency = slowConcurrency
	p.rps = rps
	p.burst = float64(burst)
	p.fastRPS = fastRPS
	p.fastBurst = fastBurst
	p.queueSize = queueSize
	p.queueWait = queueWait

	if p.rps <= 0 {
		p.parseRate = bucket{}
		p.fastRate = bucket{}
	} else {
		if !p.parseRate.at.IsZero() && p.parseRate.tokens > p.burst {
			p.parseRate.tokens = p.burst
		}
		if !p.fastRate.at.IsZero() && p.fastRate.tokens > p.fastBurst {
			p.fastRate.tokens = p.fastBurst
		}
	}
	p.wakeEligibleWaitersLocked()
}

func (p *keyPool) chargeFastRead(now time.Time) int {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.rps <= 0 {
		return 0
	}
	if now.Before(p.fastRate.at) {
		now = p.fastRate.at
	}
	avail := p.fastRate.available(now, p.fastBurst, p.fastRPS)
	if avail < 1 {
		return boundedRetrySeconds(1-avail, p.fastRPS)
	}
	p.fastRate = bucket{tokens: avail - 1, at: now}
	return 0
}

func (p *keyPool) canRunLocked(isSlow bool) bool {
	if p.active >= p.concurrency {
		return false
	}
	if isSlow && p.slowConcurrency > 0 && p.slowActive >= p.slowConcurrency {
		return false
	}
	return true
}

func (p *keyPool) hasEligibleWaiterLocked(isSlow bool) bool {
	for e := p.waiters.Front(); e != nil; e = e.Next() {
		w := e.Value.(*keyWaiter)
		if w.isSlow == isSlow && p.canRunLocked(w.isSlow) {
			return true
		}
	}
	return false
}

func (p *keyPool) acquireContext(ctx context.Context) (release func(), retrySeconds int, canceled bool) {
	return p.acquireAt(ctx, time.Now(), false)
}

func (p *keyPool) acquireAt(ctx context.Context, now time.Time, isSlow bool) (release func(), retrySeconds int, canceled bool) {
	if ctx.Err() != nil {
		return nil, 0, true
	}
	p.mu.Lock()
	var avail float64
	if p.rps > 0 {
		if now.Before(p.parseRate.at) {
			now = p.parseRate.at
		}
		avail = p.parseRate.available(now, p.burst, p.rps)
		if avail < 1 {
			retry := boundedRetrySeconds(1-avail, p.rps)
			p.mu.Unlock()
			return nil, retry, false
		}
	}

	immediate := p.canRunLocked(isSlow) && !p.hasEligibleWaiterLocked(isSlow)
	if !immediate && (p.queueWait <= 0 || p.queueSize <= 0 || p.waiters.Len() >= p.queueSize) {
		p.counters.queueStats.full.Add(1)
		p.mu.Unlock()
		return nil, 1, false
	}

	if p.rps > 0 {
		p.parseRate = bucket{tokens: avail - 1, at: now}
	}
	if immediate {
		p.active++
		if isSlow {
			p.slowActive++
		}
		p.mu.Unlock()
		return p.makeRelease(isSlow), 0, false
	}

	w := &keyWaiter{
		isSlow:  isSlow,
		granted: make(chan struct{}, 1),
	}
	w.elem = p.waiters.PushBack(w)
	waitDur := p.queueWait
	p.mu.Unlock()

	waitStart := time.Now()
	timer := time.NewTimer(waitDur)
	defer timer.Stop()

	select {
	case <-w.granted:
		elapsed := time.Since(waitStart)
		if ctx.Err() != nil {
			p.releaseSlot(isSlow)
			p.counters.queueStats.recordWait(elapsed, admQueueCanceled)
			return nil, 0, true
		}
		p.counters.queueStats.recordWait(elapsed, admQueueGranted)
		return p.makeRelease(isSlow), 0, false

	case <-ctx.Done():
		elapsed := time.Since(waitStart)
		p.mu.Lock()
		if w.elem != nil {
			p.waiters.Remove(w.elem)
			w.elem = nil
			p.mu.Unlock()
			p.counters.queueStats.recordWait(elapsed, admQueueCanceled)
			return nil, 0, true
		}
		p.mu.Unlock()
		<-w.granted
		p.releaseSlot(isSlow)
		p.counters.queueStats.recordWait(time.Since(waitStart), admQueueCanceled)
		return nil, 0, true

	case <-timer.C:
		elapsed := time.Since(waitStart)
		p.mu.Lock()
		if w.elem != nil {
			p.waiters.Remove(w.elem)
			w.elem = nil
			p.mu.Unlock()
			p.counters.queueStats.recordWait(elapsed, admQueueTimeout)
			return nil, 1, false
		}
		p.mu.Unlock()
		<-w.granted
		elapsed = time.Since(waitStart)
		if ctx.Err() != nil {
			p.releaseSlot(isSlow)
			p.counters.queueStats.recordWait(elapsed, admQueueCanceled)
			return nil, 0, true
		}
		p.counters.queueStats.recordWait(elapsed, admQueueGranted)
		return p.makeRelease(isSlow), 0, false
	}
}

func (p *keyPool) makeRelease(wasSlow bool) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			p.releaseSlot(wasSlow)
		})
	}
}

func (p *keyPool) wakeEligibleWaitersLocked() {
	for e := p.waiters.Front(); e != nil; {
		next := e.Next()
		w := e.Value.(*keyWaiter)
		if p.canRunLocked(w.isSlow) {
			p.waiters.Remove(e)
			w.elem = nil
			p.active++
			if w.isSlow {
				p.slowActive++
			}
			w.granted <- struct{}{}
		}
		e = next
	}
}

func (p *keyPool) releaseSlot(wasSlow bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.active--
	if wasSlow {
		p.slowActive--
	}
	p.wakeEligibleWaitersLocked()
}

func (p *keyPool) statsSnapshot() AdmissionPoolSnapshot {
	if p == nil {
		return AdmissionPoolSnapshot{}
	}
	p.mu.Lock()
	active := p.active
	queued := p.waiters.Len()
	concLimit := p.concurrency
	queueLimit := p.queueSize
	p.mu.Unlock()
	return p.counters.queueStats.snapshot(active, queued, concLimit, queueLimit)
}

type apiKeyEntry struct {
	id         string
	role       string
	enabled    bool
	isImplicit bool
	digest     [32]byte
	platforms  map[string]struct{} // nil means all platforms allowed
	pool       *keyPool
	counters   *keyCounters
}

func (k *apiKeyEntry) String() string {
	if k == nil {
		return "apiKeyEntry{nil}"
	}
	return fmt.Sprintf("apiKeyEntry{id:%s,role:%s,enabled:%t}", k.id, k.role, k.enabled)
}

func (k *apiKeyEntry) GoString() string {
	return k.String()
}

func (k *apiKeyEntry) AllowsPlatform(platform string) bool {
	if k == nil || len(k.platforms) == 0 {
		return true
	}
	_, ok := k.platforms[platform]
	return ok
}

func (k *apiKeyEntry) recordUnauthorized() {
	if k == nil || k.counters == nil {
		return
	}
	k.counters.requestsTotal.Add(1)
	k.counters.unauthorized.Add(1)
}

func (k *apiKeyEntry) recordRateLimited() {
	if k == nil || k.counters == nil {
		return
	}
	k.counters.requestsTotal.Add(1)
	k.counters.rateLimited.Add(1)
}

func (k *apiKeyEntry) recordCachedParseStatus(status int) {
	if k == nil || k.counters == nil {
		return
	}
	k.counters.requestsTotal.Add(1)
	k.counters.cacheHits.Add(1)
	if status < 400 {
		k.counters.ok.Add(1)
	} else {
		k.counters.errors.Add(1)
	}
}

func (k *apiKeyEntry) recordParseStatus(status int) {
	if k == nil || k.counters == nil {
		return
	}
	k.counters.requestsTotal.Add(1)
	if status == 401 {
		k.counters.unauthorized.Add(1)
	} else if status < 400 {
		k.counters.ok.Add(1)
	} else {
		k.counters.errors.Add(1)
	}
}

func (k *apiKeyEntry) snapshot() APIKeyStatsSnapshot {
	if k == nil {
		return APIKeyStatsSnapshot{}
	}
	k.pool.mu.Lock()
	active := k.pool.active
	slowActive := k.pool.slowActive
	queued := k.pool.waiters.Len()
	concLimit := k.pool.concurrency
	slowLimit := k.pool.slowConcurrency
	queueLimit := k.pool.queueSize
	k.pool.mu.Unlock()

	qSnap := k.counters.queueStats.snapshot(active, queued, concLimit, queueLimit)
	return APIKeyStatsSnapshot{
		ID:                   k.id,
		Role:                 k.role,
		Enabled:              k.enabled,
		Active:               active,
		SlowActive:           slowActive,
		Queued:               queued,
		ConcurrencyLimit:     concLimit,
		SlowConcurrencyLimit: slowLimit,
		QueueLimit:           queueLimit,
		RequestsTotal:        k.counters.requestsTotal.Load(),
		OK:                   k.counters.ok.Load(),
		Errors:               k.counters.errors.Load(),
		CacheHits:            k.counters.cacheHits.Load(),
		RateLimited:          k.counters.rateLimited.Load(),
		Unauthorized:         k.counters.unauthorized.Load(),
		Waited:               qSnap.Waited,
		Granted:              qSnap.Granted,
		Timeout:              qSnap.Timeout,
		Full:                 qSnap.Full,
		Canceled:             qSnap.Canceled,
		WaitMSTotal:          qSnap.WaitMSTotal,
		WaitMSMax:            qSnap.WaitMSMax,
	}
}

// APIKeyRegistry holds an immutable, validated set of SHA-256 API keys and their isolated execution pools.
type APIKeyRegistry struct {
	allKeys       []*apiKeyEntry
	byID          map[string]*apiKeyEntry
	activeDigests [][32]byte
	activeKeys    []*apiKeyEntry
}

func (r *APIKeyRegistry) String() string {
	if r == nil {
		return "APIKeyRegistry{keys:0}"
	}
	return fmt.Sprintf("APIKeyRegistry{keys:%d,active:%d}", len(r.allKeys), len(r.activeKeys))
}

func (r *APIKeyRegistry) GoString() string {
	return r.String()
}

// Len returns the total number of configured API keys (enabled and disabled).
func (r *APIKeyRegistry) Len() int {
	if r == nil {
		return 0
	}
	return len(r.allKeys)
}

func buildAPIKeyRegistry(entries []*apiKeyEntry) *APIKeyRegistry {
	reg := &APIKeyRegistry{
		allKeys:       entries,
		byID:          make(map[string]*apiKeyEntry, len(entries)),
		activeDigests: make([][32]byte, 0, len(entries)),
		activeKeys:    make([]*apiKeyEntry, 0, len(entries)),
	}
	for _, entry := range entries {
		reg.byID[entry.id] = entry
		if entry.enabled {
			reg.activeDigests = append(reg.activeDigests, entry.digest)
			reg.activeKeys = append(reg.activeKeys, entry)
		}
	}
	return reg
}

// NewAPIKeyRegistryFromOwnerAuth adapts a single legacy OwnerAuth credential into an APIKeyRegistry.
func NewAPIKeyRegistryFromOwnerAuth(cfg AdmissionConfig, owner OwnerAuth) *APIKeyRegistry {
	if !owner.Enabled() {
		return buildAPIKeyRegistry(nil)
	}
	conc := cfg.OwnerConcurrency
	if conc < 1 {
		conc = DefaultOwnerConcurrency
	}
	counters := &keyCounters{}
	entry := &apiKeyEntry{
		id:         "owner",
		role:       RoleOwner,
		enabled:    true,
		isImplicit: true,
		digest:     owner.digest,
		pool:       newKeyPool(conc, 0, 0, 0, cfg.OwnerQueueSize, cfg.OwnerQueueWait, counters),
		counters:   counters,
	}
	return buildAPIKeyRegistry([]*apiKeyEntry{entry})
}

func (r *APIKeyRegistry) authenticate(values []string) (*apiKeyEntry, bool) {
	if r == nil || len(r.activeDigests) == 0 {
		return nil, false
	}
	candidate, ok := bearer.ExtractBearerToken(values, MaxOwnerAuthHeaderBytes)
	if !ok {
		return nil, false
	}
	idx, matched := bearer.MatchDigestConstantTime(candidate, r.activeDigests)
	if !matched || idx < 0 || idx >= len(r.activeKeys) {
		return nil, false
	}
	return r.activeKeys[idx], true
}

func (r *APIKeyRegistry) carryOverStateFrom(prev *APIKeyRegistry) {
	if r == nil || prev == nil {
		return
	}
	for _, entry := range r.allKeys {
		old, ok := prev.byID[entry.id]
		if !ok || old == nil {
			continue
		}
		if old.counters != nil {
			entry.counters = old.counters
		}
		if old.pool != nil {
			if entry.pool != nil {
				old.pool.reconfigure(
					entry.pool.concurrency,
					entry.pool.slowConcurrency,
					entry.pool.rps,
					int(math.Round(entry.pool.burst)),
					entry.pool.queueSize,
					entry.pool.queueWait,
				)
			}
			entry.pool = old.pool
			if entry.counters == nil && old.pool.counters != nil {
				entry.counters = old.pool.counters
			}
		} else if entry.pool != nil && entry.counters != nil {
			entry.pool.counters = entry.counters
		}
	}
}

func (r *APIKeyRegistry) snapshots() []APIKeyStatsSnapshot {
	if r == nil || len(r.allKeys) == 0 {
		return make([]APIKeyStatsSnapshot, 0)
	}
	out := make([]APIKeyStatsSnapshot, len(r.allKeys))
	for i, k := range r.allKeys {
		out[i] = k.snapshot()
	}
	return out
}

func (r *APIKeyRegistry) ownerStatsSnapshot(fallback *keyPool) AdmissionPoolSnapshot {
	if r != nil {
		var found bool
		var agg AdmissionPoolSnapshot
		for _, k := range r.allKeys {
			if k.role != RoleOwner {
				continue
			}
			s := k.pool.statsSnapshot()
			found = true
			agg.Active += s.Active
			agg.Queued += s.Queued
			agg.ConcurrencyLimit += s.ConcurrencyLimit
			agg.QueueLimit += s.QueueLimit
			agg.Waited += s.Waited
			agg.Granted += s.Granted
			agg.Timeout += s.Timeout
			agg.Full += s.Full
			agg.Canceled += s.Canceled
			agg.WaitMSTotal += s.WaitMSTotal
			if s.WaitMSMax > agg.WaitMSMax {
				agg.WaitMSMax = s.WaitMSMax
			}
		}
		if found {
			return agg
		}
	}
	return fallback.statsSnapshot()
}

// LoadAPIKeyRegistry loads and validates DOKITOOL_OWNER_TOKEN and DOKITOOL_API_KEYS_FILE,
// enforcing role defaults/bounds, duplicate ID/digest rejection, and dedicated-credential
// isolation against system ingress/media/Shanghai secrets.
func LoadAPIKeyRegistry(getenv func(string) string, cfg AdmissionConfig) (*APIKeyRegistry, error) {
	if getenv == nil {
		return nil, errors.New("missing API key configuration reader")
	}
	ownerAuth, err := LoadOwnerAuth(getenv)
	if err != nil {
		return nil, err
	}

	var rawManifestBytes []byte
	hasFile := false
	if rawPath := getenv(EnvAPIKeysFile); rawPath != "" {
		trimmed := strings.TrimSpace(rawPath)
		if trimmed == "" {
			return nil, errors.New("DOKITOOL_API_KEYS_FILE must not be whitespace")
		}
		data, readErr := readBoundedAPIKeysFile(trimmed)
		if readErr != nil {
			return nil, readErr
		}
		rawManifestBytes = data
		hasFile = true
	}

	return ParseAPIKeyRegistry(rawManifestBytes, hasFile, ownerAuth, cfg, getenv)
}

func readBoundedAPIKeysFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("DOKITOOL_API_KEYS_FILE does not exist")
		}
		if errors.Is(err, os.ErrPermission) {
			return nil, errors.New("DOKITOOL_API_KEYS_FILE permission denied")
		}
		return nil, errors.New("failed to open DOKITOOL_API_KEYS_FILE")
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, errors.New("failed to stat DOKITOOL_API_KEYS_FILE")
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("DOKITOOL_API_KEYS_FILE must be a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxAPIKeysFileBytes+1))
	if err != nil {
		return nil, errors.New("failed to read DOKITOOL_API_KEYS_FILE")
	}
	if len(data) > MaxAPIKeysFileBytes {
		return nil, fmt.Errorf("DOKITOOL_API_KEYS_FILE exceeds %d bytes", MaxAPIKeysFileBytes)
	}
	return data, nil
}

// ParseAPIKeyRegistry validates an in-memory DOKITOOL_API_KEYS_FILE payload alongside
// an optional implicit OwnerAuth credential and system secret environment reader.
func ParseAPIKeyRegistry(manifestJSON []byte, hasManifest bool, ownerAuth OwnerAuth, cfg AdmissionConfig, getenv func(string) string) (*APIKeyRegistry, error) {
	var entries []*apiKeyEntry
	seenIDs := make(map[string]struct{})

	ownerConc := cfg.OwnerConcurrency
	if ownerConc < 1 {
		ownerConc = DefaultOwnerConcurrency
	}
	if ownerConc > MaxOwnerConcurrency {
		return nil, fmt.Errorf("DOKITOOL_OWNER_CONCURRENCY must be an integer between 1 and %d", MaxOwnerConcurrency)
	}
	if cfg.OwnerQueueSize < 0 || cfg.OwnerQueueSize > MaxOwnerQueueSize {
		return nil, fmt.Errorf("DOKITOOL_OWNER_QUEUE_SIZE must be an integer between 0 and %d", MaxOwnerQueueSize)
	}
	if cfg.OwnerQueueWait < 0 || cfg.OwnerQueueWait > MaxOwnerQueueWait {
		return nil, fmt.Errorf("DOKITOOL_OWNER_QUEUE_WAIT must be a duration between 0s and %s", MaxOwnerQueueWait)
	}

	if ownerAuth.Enabled() {
		counters := &keyCounters{}
		entries = append(entries, &apiKeyEntry{
			id:         "owner",
			role:       RoleOwner,
			enabled:    true,
			isImplicit: true,
			digest:     ownerAuth.digest,
			pool:       newKeyPool(ownerConc, 0, 0, 0, cfg.OwnerQueueSize, cfg.OwnerQueueWait, counters),
			counters:   counters,
		})
		seenIDs["owner"] = struct{}{}
	}

	if hasManifest {
		if len(manifestJSON) > MaxAPIKeysFileBytes {
			return nil, fmt.Errorf("DOKITOOL_API_KEYS_FILE exceeds %d bytes", MaxAPIKeysFileBytes)
		}
		trimmed := bytes.TrimSpace(manifestJSON)
		if len(trimmed) == 0 || trimmed[0] != '{' {
			return nil, errors.New("DOKITOOL_API_KEYS_FILE must contain a JSON object")
		}
		dec := json.NewDecoder(bytes.NewReader(trimmed))
		dec.DisallowUnknownFields()
		var doc rawAPIKeysManifest
		if err := dec.Decode(&doc); err != nil {
			return nil, sanitizeManifestDecodeError(err)
		}
		var trailing any
		if err := dec.Decode(&trailing); err != io.EOF {
			return nil, errors.New("DOKITOOL_API_KEYS_FILE must contain a single JSON object without trailing tokens")
		}
		if doc.Keys == nil {
			return nil, errors.New("DOKITOOL_API_KEYS_FILE missing required \"keys\" array")
		}
		rawKeys := *doc.Keys
		if len(entries)+len(rawKeys) > MaxAPIKeys {
			return nil, fmt.Errorf("configured API keys exceed maximum %d", MaxAPIKeys)
		}

		for idx, rk := range rawKeys {
			if rk == nil {
				return nil, fmt.Errorf("DOKITOOL_API_KEYS_FILE keys[%d] must be a JSON object", idx)
			}
			parsed, err := validateRawAPIKeyEntry(idx, rk, ownerConc, cfg)
			if err != nil {
				return nil, err
			}
			if _, exists := seenIDs[parsed.id]; exists {
				return nil, fmt.Errorf("duplicate API key id %q", parsed.id)
			}
			seenIDs[parsed.id] = struct{}{}
			entries = append(entries, parsed)
		}
	}

	// Enforce unique digests across ALL keys (including disabled keys and implicit "owner").
	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if subtle.ConstantTimeCompare(entries[i].digest[:], entries[j].digest[:]) == 1 {
				return nil, fmt.Errorf("duplicate token_sha256 digest between API keys %q and %q", entries[i].id, entries[j].id)
			}
		}
	}

	// Enforce dedicated credentials against system secrets.
	if getenv != nil {
		for _, sysKey := range dedicatedSystemEnvKeys {
			other := getenv(sysKey)
			if other == "" {
				continue
			}
			otherDigest := bearer.Digest(other)
			for _, entry := range entries {
				if subtle.ConstantTimeCompare(entry.digest[:], otherDigest[:]) == 1 {
					if entry.isImplicit {
						return nil, errors.New("DOKITOOL_OWNER_TOKEN requires a dedicated credential")
					}
					return nil, fmt.Errorf("DOKITOOL_API_KEYS_FILE key %q requires a dedicated credential", entry.id)
				}
			}
		}
	}

	return buildAPIKeyRegistry(entries), nil
}

func sanitizeManifestDecodeError(err error) error {
	msg := err.Error()
	if strings.Contains(msg, `unknown field "token"`) {
		return errors.New(`DOKITOOL_API_KEYS_FILE rejects plaintext "token" field; use "token_sha256"`)
	}
	if strings.HasPrefix(msg, "json: unknown field ") {
		return errors.New("DOKITOOL_API_KEYS_FILE contains an unknown JSON field")
	}
	return errors.New("DOKITOOL_API_KEYS_FILE contains invalid JSON syntax or field types")
}

func validateRawAPIKeyEntry(idx int, rk *rawAPIKeyEntry, ownerConc int, cfg AdmissionConfig) (*apiKeyEntry, error) {
	if !apiKeyIDPattern.MatchString(rk.ID) {
		return nil, fmt.Errorf("DOKITOOL_API_KEYS_FILE keys[%d] has invalid id (must match ^[a-z0-9][a-z0-9_-]{0,31}$)", idx)
	}
	id := rk.ID

	digest, err := bearer.ParseDigestHex(rk.TokenSHA256)
	if err != nil {
		return nil, fmt.Errorf("API key %q: %w", id, err)
	}

	enabled := true
	if rk.Enabled != nil {
		enabled = *rk.Enabled
	}

	var (
		concurrency, maxConc     int
		slowConcurrency, maxSlow int
		rps, maxRPS              float64
		burst, maxBurst          int
		queueSize, maxQueueSize  int
		queueWait, maxQueueWait  time.Duration
		allowZeroRPS             bool
	)

	switch rk.Role {
	case RoleOwner:
		concurrency, maxConc = ownerConc, MaxOwnerConcurrency
		slowConcurrency, maxSlow = 0, maxOwnerSlowConcurrency
		rps, maxRPS = 0, maxOwnerRPS
		burst, maxBurst = 0, maxOwnerBurst
		queueSize, maxQueueSize = cfg.OwnerQueueSize, MaxOwnerQueueSize
		queueWait, maxQueueWait = cfg.OwnerQueueWait, MaxOwnerQueueWait
		allowZeroRPS = true
	case RoleAgent:
		concurrency, maxConc = defaultAgentConcurrency, maxAgentConcurrency
		slowConcurrency, maxSlow = defaultAgentSlowConcurrency, maxAgentSlowConcurrency
		rps, maxRPS = defaultAgentRPS, maxAgentRPS
		burst, maxBurst = defaultAgentBurst, maxAgentBurst
		queueSize, maxQueueSize = defaultAgentQueueSize, maxAgentQueueSize
		queueWait, maxQueueWait = defaultAgentQueueWait, maxAgentQueueWait
	case RoleFriend:
		concurrency, maxConc = defaultFriendConcurrency, maxFriendConcurrency
		slowConcurrency, maxSlow = defaultFriendSlowConcurrency, maxFriendSlowConcurrency
		rps, maxRPS = defaultFriendRPS, maxFriendRPS
		burst, maxBurst = defaultFriendBurst, maxFriendBurst
		queueSize, maxQueueSize = defaultFriendQueueSize, maxFriendQueueSize
		queueWait, maxQueueWait = defaultFriendQueueWait, maxFriendQueueWait
	default:
		return nil, fmt.Errorf("API key %q: role must be owner, agent, or friend", id)
	}

	if rk.Concurrency != nil {
		concurrency = *rk.Concurrency
	}
	if concurrency < 1 || concurrency > maxConc {
		return nil, fmt.Errorf("API key %q: concurrency must be between 1 and %d", id, maxConc)
	}

	if rk.SlowConcurrency != nil {
		slowConcurrency = *rk.SlowConcurrency
	}
	if slowConcurrency < 0 || slowConcurrency > maxSlow || slowConcurrency > concurrency {
		return nil, fmt.Errorf("API key %q: slow_concurrency must be between 0 and min(%d, concurrency)", id, maxSlow)
	}

	if rk.RPS != nil {
		rps = *rk.RPS
	}
	if math.IsNaN(rps) || math.IsInf(rps, 0) {
		return nil, fmt.Errorf("API key %q: rps must be a finite number", id)
	}
	if allowZeroRPS {
		if rps < 0 || rps > maxRPS {
			return nil, fmt.Errorf("API key %q: rps must be 0 or in (0, %g]", id, maxRPS)
		}
	} else if rps <= 0 || rps > maxRPS {
		return nil, fmt.Errorf("API key %q: rps must be in (0, %g]", id, maxRPS)
	}

	if rk.Burst != nil {
		burst = *rk.Burst
	}
	if rps == 0 {
		if burst != 0 {
			return nil, fmt.Errorf("API key %q: burst must be 0 when rps is 0", id)
		}
	} else if burst < 1 || burst > maxBurst {
		return nil, fmt.Errorf("API key %q: burst must be between 1 and %d", id, maxBurst)
	}

	if rk.QueueSize != nil {
		queueSize = *rk.QueueSize
	}
	if queueSize < 0 || queueSize > maxQueueSize {
		return nil, fmt.Errorf("API key %q: queue_size must be between 0 and %d", id, maxQueueSize)
	}

	if rk.QueueWait != nil {
		rawWait := strings.TrimSpace(*rk.QueueWait)
		if rawWait == "" {
			return nil, fmt.Errorf("API key %q: queue_wait must be a valid duration", id)
		}
		if rawWait == "0" {
			queueWait = 0
		} else {
			parsedWait, err := time.ParseDuration(rawWait)
			if err != nil {
				return nil, fmt.Errorf("API key %q: queue_wait must be a valid duration", id)
			}
			queueWait = parsedWait
		}
	}
	if queueWait < 0 || queueWait > maxQueueWait {
		return nil, fmt.Errorf("API key %q: queue_wait must be between 0s and %s", id, maxQueueWait)
	}

	var platSet map[string]struct{}
	if len(rk.Platforms) > 0 {
		platSet = make(map[string]struct{}, len(rk.Platforms))
		for _, p := range rk.Platforms {
			if _, ok := allowedKeyPlatforms[p]; !ok {
				return nil, fmt.Errorf("API key %q: unsupported platform in allowlist", id)
			}
			if _, dup := platSet[p]; dup {
				return nil, fmt.Errorf("API key %q: duplicate platform %q in allowlist", id, p)
			}
			platSet[p] = struct{}{}
		}
	}

	counters := &keyCounters{}
	return &apiKeyEntry{
		id:        id,
		role:      rk.Role,
		enabled:   enabled,
		digest:    digest,
		platforms: platSet,
		pool:      newKeyPool(concurrency, slowConcurrency, rps, burst, queueSize, queueWait, counters),
		counters:  counters,
	}, nil
}
