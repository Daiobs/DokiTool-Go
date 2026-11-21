package api

import (
	"container/list"
	"context"
	"crypto/subtle"
	"fmt"
	"math"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

type route uint8

const (
	unknown route = iota
	parser
	catalogRoute
	legacy
	telemetry
	media
	youtubeHelper
	statsRoute
)

// Match the same exact escaped paths for admission and dispatch.
func classify(path string) route {
	switch path {
	case "/api/parse", "/api/resolve":
		return parser
	case "/api/youtube/context", "/api/youtube/finalize":
		return youtubeHelper
	case "/api/platforms":
		return catalogRoute
	case "/api/stats":
		return statsRoute
	case "/api/short_videos", "/api/douyin", "/api/ksjx", "/api/bilibili", "/api/xhsjx", "/api/toutiao":
		return legacy
	case tbvideoOutcomePath:
		return telemetry
	case "/api/media/weibo":
		return media
	default:
		return unknown
	}
}

const clientHeader = "X-DokiTool-Client-IP"
const edgeHeader = "X-DokiTool-Edge-Key"
const serverWriteWindow = 50 * time.Second

type ownerContextKey struct{}
type authMetaContextKey struct{}

type authContextMeta struct {
	id           string
	role         string
	key          *apiKeyEntry
	viaAdmission bool
}

// WithOwnerRequest marks a request context as authenticated with the owner role
// and propagates the "owner" channel identity to shared downstream subsystems.
func WithOwnerRequest(ctx context.Context) context.Context {
	ctx = context.WithValue(ctx, ownerContextKey{}, true)
	if _, ok := ctx.Value(authMetaContextKey{}).(authContextMeta); !ok {
		ctx = context.WithValue(ctx, authMetaContextKey{}, authContextMeta{
			id:   "owner",
			role: RoleOwner,
		})
	}
	ctx = ytengine.WithChannel(ctx, ytengine.ChannelOwner)
	ctx = shresolver.WithChannel(ctx, shresolver.ChannelOwner)
	return ctx
}

func withAuthenticatedKey(ctx context.Context, key *apiKeyEntry, viaAdmission bool) context.Context {
	if key == nil {
		return WithOwnerRequest(ctx)
	}
	ctx = context.WithValue(ctx, ownerContextKey{}, true)
	ctx = context.WithValue(ctx, authMetaContextKey{}, authContextMeta{
		id:           key.id,
		role:         key.role,
		key:          key,
		viaAdmission: viaAdmission,
	})
	ctx = ytengine.WithChannel(ctx, ytengine.ChannelOwner)
	ctx = shresolver.WithChannel(ctx, shresolver.ChannelOwner)
	return ctx
}

// IsOwnerRequest reports whether ctx belongs to an authenticated API key request
// (owner, agent, or friend), enabling direct Weibo CDN URLs without media relay.
func IsOwnerRequest(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	ok, _ := ctx.Value(ownerContextKey{}).(bool)
	return ok
}

// AuthKeyIDFromContext returns the authenticated API key id on ctx, or "" if anonymous.
func AuthKeyIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	meta, _ := ctx.Value(authMetaContextKey{}).(authContextMeta)
	return meta.id
}

// AuthRoleFromContext returns the authenticated API key role on ctx, or "" if anonymous.
func AuthRoleFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	meta, _ := ctx.Value(authMetaContextKey{}).(authContextMeta)
	return meta.role
}

func authKeyFromContext(ctx context.Context) (*apiKeyEntry, bool) {
	if ctx == nil {
		return nil, false
	}
	meta, _ := ctx.Value(authMetaContextKey{}).(authContextMeta)
	return meta.key, meta.viaAdmission
}

func authAllowsPlatform(ctx context.Context, platform string) bool {
	key, _ := authKeyFromContext(ctx)
	return key.AllowsPlatform(platform)
}

// WithAdmission wraps the production HTTP entry point. All limits are local
// to one serving instance; the pools share neither clients nor leases.
func WithAdmission(next, pullControl http.Handler, mode, edgeKey string) (http.Handler, error) {
	return WithAdmissionConfig(next, pullControl, mode, edgeKey, DefaultAdmissionConfig())
}

// WithAdmissionConfig preserves trusted client identity while giving each route
// its own independently tunable visitor and service budgets.
func WithAdmissionConfig(next, pullControl http.Handler, mode, edgeKey string, config AdmissionConfig) (http.Handler, error) {
	return WithAdmissionWithOwner(next, pullControl, mode, edgeKey, config, OwnerAuth{})
}

// WithAdmissionWithOwner configures admission control with an optional owner
// bearer channel backed by its own dedicated concurrency pool and wait queue.
func WithAdmissionWithOwner(next, pullControl http.Handler, mode, edgeKey string, config AdmissionConfig, owner OwnerAuth) (http.Handler, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	return WithAdmissionWithRegistry(next, pullControl, mode, edgeKey, config, NewAPIKeyRegistryFromOwnerAuth(config, owner))
}

// WithAdmissionWithRegistry configures admission control with a multi-key SHA-256
// bearer registry and isolated per-key execution pools.
func WithAdmissionWithRegistry(next, pullControl http.Handler, mode, edgeKey string, config AdmissionConfig, registry *APIKeyRegistry) (http.Handler, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	switch mode {
	case "direct":
		if edgeKey != "" {
			return nil, fmt.Errorf("SNAP_INGRESS_KEY requires -client-identity caddy")
		}
	case "caddy":
		if len(edgeKey) < 32 || len(edgeKey) > 512 || strings.IndexFunc(edgeKey, func(r rune) bool { return r < 33 || r > 126 }) >= 0 {
			return nil, fmt.Errorf("caddy identity requires a 32–512 byte printable SNAP_INGRESS_KEY without spaces")
		}
	default:
		return nil, fmt.Errorf("client-identity must be direct or caddy")
	}
	if registry == nil {
		registry = buildAPIKeyRegistry(nil)
	}
	var st *Stats
	if sp, ok := next.(interface{ Stats() *Stats }); ok && sp.Stats() != nil {
		st = sp.Stats()
	} else {
		st = NewStats(nil)
	}
	ownerFallback := newOwnerPool(config.OwnerConcurrency, config.OwnerQueueWait, config.OwnerQueueSize)
	if ownerKey, ok := registry.byID["owner"]; ok && ownerKey != nil && ownerKey.pool != nil {
		ownerFallback = ownerKey.pool
	}
	adm := &admission{
		next:        next,
		pullControl: pullControl,
		edgeKey:     edgeKey,
		now:         time.Now,
		stats:       st,
		public:      newConfiguredPool(config.Parse, config.MaxClients),
		resolve:     newConfiguredPool(config.Resolve, config.MaxClients),
		slow:        newConfiguredPool(config.SlowParse, config.MaxClients),
		catalog:     newConfiguredPool(config.Catalog, config.MaxClients),
		reports:     newConfiguredPool(config.Reports, config.MaxClients),
		relay:       newConfiguredPool(config.Relay, config.MaxClients),
		owner:       ownerFallback,
	}
	adm.keys.Store(registry)
	st.setAdmissionSource(adm)
	return adm, nil
}

// ReloadAPIKeys atomically replaces the active APIKeyRegistry on an admission
// handler while preserving cumulative per-key counters for matching key IDs.
func ReloadAPIKeys(handler http.Handler, next *APIKeyRegistry) bool {
	adm, ok := handler.(*admission)
	if !ok || adm == nil || next == nil {
		return false
	}
	adm.reloadAPIKeys(next)
	return true
}

type admission struct {
	next, pullControl                              http.Handler
	edgeKey                                        string
	now                                            func() time.Time
	stats                                          *Stats
	public, resolve, slow, catalog, relay, reports *pool
	owner                                          *keyPool
	reloadMu                                       sync.Mutex
	keys                                           atomic.Pointer[APIKeyRegistry]
}

func (a *admission) reloadAPIKeys(next *APIKeyRegistry) {
	if a == nil || next == nil {
		return
	}
	a.reloadMu.Lock()
	defer a.reloadMu.Unlock()
	prev := a.keys.Load()
	next.carryOverCountersFrom(prev)
	a.keys.Store(next)
}

type parseStatusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *parseStatusWriter) WriteHeader(code int) {
	if !w.wrote {
		w.status = code
		w.wrote = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *parseStatusWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.status = http.StatusOK
		w.wrote = true
	}
	return w.ResponseWriter.Write(p)
}

func (w *parseStatusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *parseStatusWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (a *admission) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	wallStart := time.Now()
	path := r.URL.EscapedPath()
	kind := classify(path)
	client := a.client(r)
	// These headers authenticate only this hop and never belong to an upstream.
	r.Header.Del(edgeHeader)
	r.Header.Del(clientHeader)
	// Long polls and result submissions authenticate the ingress hop as usual.
	// The control handler enforces its own bearer, byte, time and concurrency limits.
	if a.pullControl != nil && (path == shresolver.ClaimPath || path == shresolver.ResultPath) {
		if !client.IsValid() {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		a.pullControl.ServeHTTP(w, r)
		return
	}
	if kind == unknown {
		a.next.ServeHTTP(w, r)
		return
	}
	if !client.IsValid() {
		if kind == parser {
			a.stats.RecordParse(a.parsePlatform(r.URL.RawQuery), "SERVICE_NOT_CONFIGURED", ChannelAnonymous, time.Since(wallStart))
		}
		rejectAdmission(w, r, kind, http.StatusServiceUnavailable, 30)
		return
	}
	authValues := r.Header.Values("Authorization")
	r.Header.Del("Authorization")
	reg := a.keys.Load()
	if kind == statsRoute {
		if len(authValues) == 0 {
			if retry := a.public.chargeClient(client, a.now()); retry > 0 {
				rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
				return
			}
			rejectUnauthorized(w, r, kind)
			return
		}
		key, ok := reg.authenticate(authValues)
		if !ok {
			if retry := a.public.chargeClient(client, a.now()); retry > 0 {
				rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
				return
			}
			rejectUnauthorized(w, r, kind)
			return
		}
		if key.role != RoleOwner {
			if retry := key.pool.chargeFastRead(a.now()); retry > 0 {
				key.recordRateLimited()
				rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
				return
			}
			key.recordUnauthorized()
			rejectUnauthorizedWithMessage(w, r, kind, "当前凭据无权访问统计接口")
			return
		}
		r = r.WithContext(withAuthenticatedKey(r.Context(), key, true))
		a.next.ServeHTTP(w, r)
		return
	}
	if len(authValues) > 0 {
		key, ok := reg.authenticate(authValues)
		if !ok {
			retry := a.public.chargeClient(client, a.now())
			if retry > 0 {
				if kind == parser {
					a.stats.RecordParse(a.parsePlatform(r.URL.RawQuery), "RATE_LIMITED", ChannelAnonymous, time.Since(wallStart))
				}
				rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
				return
			}
			if kind == parser {
				a.stats.RecordParse(a.parsePlatform(r.URL.RawQuery), OutcomeUnauthorized, ChannelAnonymous, time.Since(wallStart))
			}
			rejectUnauthorized(w, r, kind)
			return
		}
		r = r.WithContext(withAuthenticatedKey(r.Context(), key, true))
		if kind != media && kind != telemetry {
			a.serveAuthenticated(w, r, key, kind, path, wallStart)
			return
		}
	}
	budget := a.selectPool(r, kind, path)
	if budget.queueWait > 0 {
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(budget.queueWait + serverWriteWindow))
	}
	release, retry, canceled := budget.acquireContext(r.Context(), client, a.now())
	if canceled {
		return
	}
	if retry > 0 {
		if kind == parser {
			a.stats.RecordParse(a.parsePlatform(r.URL.RawQuery), "RATE_LIMITED", ChannelAnonymous, time.Since(wallStart))
		}
		rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
		return
	}
	defer release()
	if budget.queueWait > 0 {
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(serverWriteWindow))
	}
	if kind == parser {
		r = r.WithContext(withParseWallStart(r.Context(), wallStart))
	}
	a.next.ServeHTTP(w, r)
}

func (a *admission) serveAuthenticated(
	w http.ResponseWriter,
	r *http.Request,
	key *apiKeyEntry,
	kind route,
	path string,
	wallStart time.Time,
) {
	// 1. Enforce optional per-key platform allowlist before fast-path or pool slot acquisition.
	if kind == youtubeHelper && !key.AllowsPlatform("youtube") {
		if retry := key.pool.chargeFastRead(a.now()); retry > 0 {
			key.recordRateLimited()
			rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
			return
		}
		key.recordUnauthorized()
		rejectUnauthorizedWithMessage(w, r, kind, "当前凭据无权访问该平台")
		return
	}
	var parsedPlatform string
	if kind == parser {
		parsedPlatform = a.parsePlatform(r.URL.RawQuery)
		if parsedPlatform != "" && !key.AllowsPlatform(parsedPlatform) {
			if retry := key.pool.chargeFastRead(a.now()); retry > 0 {
				key.recordRateLimited()
				a.stats.RecordParse(parsedPlatform, "RATE_LIMITED", ChannelOwner, time.Since(wallStart))
				rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
				return
			}
			key.recordUnauthorized()
			a.stats.RecordParse(parsedPlatform, OutcomeUnauthorized, ChannelOwner, time.Since(wallStart))
			rejectUnauthorizedWithMessage(w, r, kind, "当前凭据无权访问该平台")
			return
		}
	}

	// 2. Zero-slot fast-path for /api/platforms and cached /api/youtube/context.
	if kind == catalogRoute || (kind == youtubeHelper && r.Method == http.MethodGet && path == "/api/youtube/context" && a.hasCachedYouTubeContext()) {
		if retry := key.pool.chargeFastRead(a.now()); retry > 0 {
			key.recordRateLimited()
			rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
			return
		}
		a.next.ServeHTTP(w, r)
		return
	}

	// 3. Zero-TOCTOU post-auth cache fast-path for fresh GET /api/parse and /api/resolve hits.
	if kind == parser && r.Method == http.MethodGet && a.hasFreshCachedParse(path, r.URL.RawQuery) {
		if retry := key.pool.chargeFastRead(a.now()); retry > 0 {
			key.recordRateLimited()
			a.stats.RecordParse(parsedPlatform, "RATE_LIMITED", ChannelOwner, time.Since(wallStart))
			rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
			return
		}
		if a.tryServeFreshCachedParse(w, r, key, wallStart) {
			return
		}
		// Entry expired at the exact nanosecond boundary: fall through into key.pool acquire.
	}

	// 4. Uncached parse / helper / legacy path via isolated per-key execution pool.
	isSlow := kind == youtubeHelper || (kind == parser && traitsForPlatform(parsedPlatform).slowEngine)
	if key.pool.queueWait > 0 {
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(key.pool.queueWait + serverWriteWindow))
	}
	release, retry, canceled := key.pool.acquireAt(r.Context(), a.now(), isSlow)
	if canceled {
		return
	}
	if retry > 0 {
		key.recordRateLimited()
		if kind == parser {
			a.stats.RecordParse(parsedPlatform, "RATE_LIMITED", ChannelOwner, time.Since(wallStart))
		}
		rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
		return
	}
	defer release()
	if key.pool.queueWait > 0 {
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(serverWriteWindow))
	}
	if kind == parser {
		r = r.WithContext(withParseWallStart(r.Context(), wallStart))
		recW := &parseStatusWriter{ResponseWriter: w}
		a.next.ServeHTTP(recW, r)
		if recW.wrote {
			key.recordParseStatus(recW.status)
		}
		return
	}
	a.next.ServeHTTP(w, r)
}

func (a *admission) selectPool(r *http.Request, kind route, path string) *pool {
	switch kind {
	case media:
		return a.relay
	case telemetry:
		return a.reports
	case catalogRoute:
		return a.catalog
	case youtubeHelper:
		if r.Method == http.MethodGet && path == "/api/youtube/context" && a.hasCachedYouTubeContext() {
			return a.catalog
		}
		return a.slow
	case parser:
		if r.Method != http.MethodGet {
			return a.public
		}
		// Fresh cache hits do no upstream work; charge them like catalog reads.
		if a.hasFreshCachedParse(path, r.URL.RawQuery) {
			return a.catalog
		}
		if traitsForPlatform(a.parsePlatform(r.URL.RawQuery)).slowEngine {
			return a.slow
		}
		if path == "/api/resolve" {
			return a.resolve
		}
		return a.public
	default:
		return a.public
	}
}

func (a *admission) hasFreshCachedParse(path, rawQuery string) bool {
	checker, ok := a.next.(interface{ HasFreshCachedParse(string, string) bool })
	return ok && checker.HasFreshCachedParse(path, rawQuery)
}

func (a *admission) tryServeFreshCachedParse(w http.ResponseWriter, r *http.Request, key *apiKeyEntry, wallStart time.Time) bool {
	fastServer, ok := a.next.(interface {
		tryServeFreshCachedParse(http.ResponseWriter, *http.Request, *apiKeyEntry, time.Time) bool
	})
	return ok && fastServer.tryServeFreshCachedParse(w, r, key, wallStart)
}

func (a *admission) hasCachedYouTubeContext() bool {
	checker, ok := a.next.(interface{ HasCachedYouTubeContext() bool })
	return ok && checker.HasCachedYouTubeContext()
}

func (a *admission) parsePlatform(rawQuery string) string {
	classifier, ok := a.next.(interface{ ParsePlatform(string) string })
	if !ok {
		return ""
	}
	return classifier.ParsePlatform(rawQuery)
}

func (a *admission) client(r *http.Request) netip.Addr {
	peer, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}
	}
	ip := peer.Addr().Unmap()
	if a.edgeKey != "" {
		keys, clients := r.Header.Values(edgeHeader), r.Header.Values(clientHeader)
		if !ip.IsLoopback() || len(keys) != 1 || len(clients) != 1 ||
			subtle.ConstantTimeCompare([]byte(keys[0]), []byte(a.edgeKey)) != 1 {
			return netip.Addr{}
		}
		ip, err = netip.ParseAddr(clients[0])
		if err != nil {
			return netip.Addr{}
		}
		ip = ip.Unmap()
	} else if len(r.Header.Values(edgeHeader)) != 0 || len(r.Header.Values(clientHeader)) != 0 {
		// A proxy accidentally paired with direct mode must not collapse
		// all users into one loopback identity.
		return netip.Addr{}
	}
	if ip.Zone() != "" {
		return netip.Addr{}
	}
	if ip.Is6() {
		return netip.PrefixFrom(ip, 64).Masked().Addr()
	}
	return ip
}

type bucket struct {
	tokens float64
	at     time.Time
}

func (b bucket) available(now time.Time, burst, rate float64) float64 {
	if b.at.IsZero() {
		return burst
	}
	return min(burst, b.tokens+max(0, now.Sub(b.at).Seconds())*rate)
}

type clientState struct {
	bucket
	ip       netip.Addr
	active   int
	idleElem *list.Element
}

type poolWaiter struct {
	elem    *list.Element
	granted chan struct{}
}

type admQueueOutcome uint8

const (
	admQueueGranted admQueueOutcome = iota
	admQueueTimeout
	admQueueCanceled
)

type poolQueueCounters struct {
	granted   atomic.Uint64
	timeout   atomic.Uint64
	full      atomic.Uint64
	canceled  atomic.Uint64
	waitNsSum atomic.Uint64
	waitNsMax atomic.Uint64
}

func (q *poolQueueCounters) recordWait(d time.Duration, out admQueueOutcome) {
	if d < 0 {
		d = 0
	}
	switch out {
	case admQueueGranted:
		q.granted.Add(1)
	case admQueueTimeout:
		q.timeout.Add(1)
	case admQueueCanceled:
		q.canceled.Add(1)
	}
	ns := uint64(d.Nanoseconds())
	q.waitNsSum.Add(ns)
	for {
		cur := q.waitNsMax.Load()
		if ns <= cur || q.waitNsMax.CompareAndSwap(cur, ns) {
			break
		}
	}
}

func (q *poolQueueCounters) snapshot(active, queued, concLimit, queueLimit int) AdmissionPoolSnapshot {
	granted := q.granted.Load()
	timeout := q.timeout.Load()
	canceled := q.canceled.Load()
	return AdmissionPoolSnapshot{
		Active:           active,
		Queued:           queued,
		ConcurrencyLimit: concLimit,
		QueueLimit:       queueLimit,
		Waited:           granted + timeout + canceled,
		Granted:          granted,
		Timeout:          timeout,
		Full:             q.full.Load(),
		Canceled:         canceled,
		WaitMSTotal:      q.waitNsSum.Load() / 1_000_000,
		WaitMSMax:        q.waitNsMax.Load() / 1_000_000,
	}
}

// Only the short accounting transaction is serialized. No lock is held
// during parsing, upstream reads, queue waits, or writes to the client.
type pool struct {
	mu                                               sync.Mutex
	clientBurst, clientRate, globalBurst, globalRate float64
	clientSlots, globalSlots, maxClients, active     int
	queueWait                                        time.Duration
	queueSize                                        int
	global                                           bucket
	clients                                          map[netip.Addr]*clientState
	idle                                             list.List
	waiters                                          list.List
	queueStats                                       poolQueueCounters
}

func newConfiguredPool(c PoolConfig, maxClients int) *pool {
	p := newPool(c.ClientBurst, c.ClientRPS, c.GlobalBurst, c.GlobalRPS,
		c.ClientConcurrency, c.GlobalConcurrency, maxClients)
	p.queueWait = c.QueueWait
	p.queueSize = c.QueueSize
	return p
}

func newPool(clientBurst, clientRate, globalBurst, globalRate float64, clientSlots, globalSlots, maxClients int) *pool {
	return &pool{
		clientBurst: clientBurst,
		clientRate:  clientRate,
		globalBurst: globalBurst,
		globalRate:  globalRate,
		clientSlots: clientSlots,
		globalSlots: globalSlots,
		maxClients:  maxClients,
		clients:     make(map[netip.Addr]*clientState),
	}
}

func (p *pool) acquire(ip netip.Addr, now time.Time) (release func(), retrySeconds int) {
	release, retry, _ := p.acquireContext(context.Background(), ip, now)
	return release, retry
}

func (p *pool) acquireContext(ctx context.Context, ip netip.Addr, now time.Time) (release func(), retrySeconds int, canceled bool) {
	if ctx.Err() != nil {
		return nil, 0, true
	}
	p.mu.Lock()
	// Concurrent arrivals can obtain the lock in a different order than
	// their timestamps; never credit the same interval twice.
	if now.Before(p.global.at) {
		now = p.global.at
	}
	c := p.clients[ip]
	if c == nil && len(p.clients) >= p.maxClients && p.idle.Front() == nil {
		p.mu.Unlock()
		return nil, 60, false
	}
	local := p.clientBurst
	if c != nil {
		local = c.available(now, p.clientBurst, p.clientRate)
	}
	global := p.global.available(now, p.globalBurst, p.globalRate)
	if local < 1 || global < 1 {
		if c != nil && c.idleElem != nil {
			p.idle.MoveToBack(c.idleElem)
		}
		p.mu.Unlock()
		return nil, int(math.Ceil(max(1, (1-local)/p.clientRate, (1-global)/p.globalRate))), false
	}
	if c != nil && c.active >= p.clientSlots {
		p.mu.Unlock()
		return nil, 1, false
	}

	canQueue := p.queueWait > 0 && p.queueSize > 0 && p.waiters.Len() < p.queueSize
	if p.active >= p.globalSlots && !canQueue {
		if c != nil && c.idleElem != nil {
			p.idle.MoveToBack(c.idleElem)
		}
		p.queueStats.full.Add(1)
		p.mu.Unlock()
		return nil, 1, false
	}

	if c == nil {
		for len(p.clients) >= p.maxClients {
			front := p.idle.Front()
			if front == nil {
				p.mu.Unlock()
				return nil, 60, false
			}
			victim := p.idle.Remove(front).(*clientState)
			victim.idleElem = nil
			delete(p.clients, victim.ip)
		}
		c = &clientState{ip: ip}
		p.clients[ip] = c
	}
	if c.idleElem != nil {
		p.idle.Remove(c.idleElem)
		c.idleElem = nil
	}
	c.bucket = bucket{tokens: local - 1, at: now}
	p.global = bucket{tokens: global - 1, at: now}
	c.active++

	if p.active < p.globalSlots {
		p.active++
		p.mu.Unlock()
		return p.makeRelease(c), 0, false
	}

	w := &poolWaiter{granted: make(chan struct{}, 1)}
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
			p.releaseSlot(c)
			p.queueStats.recordWait(elapsed, admQueueCanceled)
			return nil, 0, true
		}
		p.queueStats.recordWait(elapsed, admQueueGranted)
		return p.makeRelease(c), 0, false

	case <-ctx.Done():
		elapsed := time.Since(waitStart)
		p.mu.Lock()
		if w.elem != nil {
			p.waiters.Remove(w.elem)
			w.elem = nil
			c.active--
			if c.active == 0 && p.clients[c.ip] == c {
				c.idleElem = p.idle.PushBack(c)
			}
			p.mu.Unlock()
			p.queueStats.recordWait(elapsed, admQueueCanceled)
			return nil, 0, true
		}
		p.mu.Unlock()
		<-w.granted
		p.releaseSlot(c)
		p.queueStats.recordWait(time.Since(waitStart), admQueueCanceled)
		return nil, 0, true

	case <-timer.C:
		elapsed := time.Since(waitStart)
		p.mu.Lock()
		if w.elem != nil {
			p.waiters.Remove(w.elem)
			w.elem = nil
			c.active--
			if c.active == 0 && p.clients[c.ip] == c {
				c.idleElem = p.idle.PushBack(c)
			}
			p.mu.Unlock()
			p.queueStats.recordWait(elapsed, admQueueTimeout)
			return nil, 1, false
		}
		p.mu.Unlock()
		<-w.granted
		elapsed = time.Since(waitStart)
		if ctx.Err() != nil {
			p.releaseSlot(c)
			p.queueStats.recordWait(elapsed, admQueueCanceled)
			return nil, 0, true
		}
		p.queueStats.recordWait(elapsed, admQueueGranted)
		return p.makeRelease(c), 0, false
	}
}

func (p *pool) makeRelease(c *clientState) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			p.releaseSlot(c)
		})
	}
}

func (p *pool) releaseSlot(c *clientState) {
	p.mu.Lock()
	defer p.mu.Unlock()
	c.active--
	if c.active == 0 && p.clients[c.ip] == c {
		c.idleElem = p.idle.PushBack(c)
	}
	if front := p.waiters.Front(); front != nil {
		w := p.waiters.Remove(front).(*poolWaiter)
		w.elem = nil
		w.granted <- struct{}{}
		return
	}
	p.active--
}

// chargeClient deducts one token from the visitor's per-IP abuse budget without
// consuming global service tokens or concurrency leases. Failed authentication
// attempts therefore throttle the caller IP without starving other visitors.
func (p *pool) chargeClient(ip netip.Addr, now time.Time) (retrySeconds int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if now.Before(p.global.at) {
		now = p.global.at
	}
	c := p.clients[ip]
	if c != nil && now.Before(c.bucket.at) {
		now = c.bucket.at
	}
	if c == nil && len(p.clients) >= p.maxClients && p.idle.Front() == nil {
		return 60
	}
	local := p.clientBurst
	if c != nil {
		local = c.available(now, p.clientBurst, p.clientRate)
	}
	if local < 1 {
		if c != nil && c.idleElem != nil {
			p.idle.MoveToBack(c.idleElem)
		}
		return int(math.Ceil(max(1, (1-local)/p.clientRate)))
	}
	if c == nil {
		for len(p.clients) >= p.maxClients {
			front := p.idle.Front()
			if front == nil {
				return 60
			}
			victim := p.idle.Remove(front).(*clientState)
			victim.idleElem = nil
			delete(p.clients, victim.ip)
		}
		c = &clientState{ip: ip}
		p.clients[ip] = c
		c.idleElem = p.idle.PushBack(c)
	} else if c.idleElem != nil {
		p.idle.MoveToBack(c.idleElem)
	}
	c.bucket = bucket{tokens: local - 1, at: now}
	return 0
}

func (p *pool) statsSnapshot() AdmissionPoolSnapshot {
	if p == nil {
		return AdmissionPoolSnapshot{}
	}
	p.mu.Lock()
	active := p.active
	queued := p.waiters.Len()
	concLimit := p.globalSlots
	queueLimit := p.queueSize
	p.mu.Unlock()
	return p.queueStats.snapshot(active, queued, concLimit, queueLimit)
}

func (a *admission) statsSnapshot() AdmissionStatsSnapshot {
	if a == nil {
		return AdmissionStatsSnapshot{}
	}
	return AdmissionStatsSnapshot{
		Fast:  a.public.statsSnapshot(),
		Slow:  a.slow.statsSnapshot(),
		Owner: a.keys.Load().ownerStatsSnapshot(a.owner),
	}
}

func (a *admission) apiKeysStatsSnapshot() []APIKeyStatsSnapshot {
	if a == nil {
		return make([]APIKeyStatsSnapshot, 0)
	}
	return a.keys.Load().snapshots()
}

func rejectUnauthorized(w http.ResponseWriter, r *http.Request, kind route) {
	rejectUnauthorizedWithMessage(w, r, kind, "认证凭据无效")
}

func rejectUnauthorizedWithMessage(w http.ResponseWriter, r *http.Request, kind route, message string) {
	payload := unified.Object{"code": http.StatusUnauthorized, "msg": message, "data": nil}
	if kind == parser || kind == catalogRoute || kind == youtubeHelper || kind == statsRoute {
		payload = contractErrorForStatus(http.StatusUnauthorized, message)
	}
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	send(w, http.StatusUnauthorized, payload)
}

func rejectAdmission(w http.ResponseWriter, r *http.Request, kind route, status, retry int) {
	label := "解析"
	if kind == media {
		label = "媒体"
	}
	code, message := "RATE_LIMITED", label+"请求过于频繁，请稍后重试"
	if status == http.StatusServiceUnavailable {
		code, message = "SERVICE_NOT_CONFIGURED", label+"服务暂时不可用，请稍后重试"
	}
	w.Header().Set("Retry-After", strconv.Itoa(retry))
	payload := unified.Object{"code": status, "msg": message, "data": nil}
	if kind == parser || kind == catalogRoute || kind == youtubeHelper || kind == statsRoute {
		payload = unified.ContractError(code, message, status == 429)
		if status == 429 {
			unified.Map(payload["error"])["retry_after_seconds"] = retry
		}
	}
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(status)
		return
	}
	send(w, status, payload)
}
