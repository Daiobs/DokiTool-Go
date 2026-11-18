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

func isSlowParsePlatform(platform string) bool {
	switch platform {
	case "x", "youtube", "instagram", "facebook", "tumblr", "dailymotion":
		return true
	default:
		return false
	}
}

const clientHeader = "X-DokiTool-Client-IP"
const edgeHeader = "X-DokiTool-Edge-Key"
const serverWriteWindow = 50 * time.Second

type ownerContextKey struct{}

// WithOwnerRequest marks a request context as authenticated via DOKITOOL_OWNER_TOKEN
// and propagates the "owner" channel identity to shared downstream subsystems.
func WithOwnerRequest(ctx context.Context) context.Context {
	ctx = context.WithValue(ctx, ownerContextKey{}, true)
	ctx = ytengine.WithChannel(ctx, ytengine.ChannelOwner)
	ctx = shresolver.WithChannel(ctx, shresolver.ChannelOwner)
	return ctx
}

// IsOwnerRequest reports whether ctx belongs to an authenticated owner request.
func IsOwnerRequest(ctx context.Context) bool {
	ok, _ := ctx.Value(ownerContextKey{}).(bool)
	return ok
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
	var st *Stats
	if sp, ok := next.(interface{ Stats() *Stats }); ok && sp.Stats() != nil {
		st = sp.Stats()
	} else {
		st = NewStats(nil)
	}
	adm := &admission{
		next:        next,
		pullControl: pullControl,
		edgeKey:     edgeKey,
		ownerAuth:   owner,
		now:         time.Now,
		stats:       st,
		public:      newConfiguredPool(config.Parse, config.MaxClients),
		slow:        newConfiguredPool(config.SlowParse, config.MaxClients),
		catalog:     newConfiguredPool(config.Catalog, config.MaxClients),
		reports:     newConfiguredPool(config.Reports, config.MaxClients),
		relay:       newConfiguredPool(config.Relay, config.MaxClients),
		owner:       newOwnerPool(config.OwnerConcurrency, config.OwnerQueueWait, config.OwnerQueueSize),
	}
	st.setAdmissionSource(adm)
	return adm, nil
}

type admission struct {
	next, pullControl                     http.Handler
	edgeKey                               string
	ownerAuth                             OwnerAuth
	now                                   func() time.Time
	stats                                 *Stats
	public, slow, catalog, relay, reports *pool
	owner                                 *ownerPool
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
	if kind == statsRoute {
		if len(authValues) == 0 || !a.ownerAuth.verifyHeader(authValues) {
			retry := a.public.chargeClient(client, a.now())
			if retry > 0 {
				rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
				return
			}
			rejectUnauthorized(w, r, kind)
			return
		}
		r = r.WithContext(WithOwnerRequest(r.Context()))
		a.next.ServeHTTP(w, r)
		return
	}
	if len(authValues) > 0 {
		if !a.ownerAuth.verifyHeader(authValues) {
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
		r = r.WithContext(WithOwnerRequest(r.Context()))
		if kind != media && kind != telemetry {
			if a.owner.queueWait > 0 {
				_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(a.owner.queueWait + serverWriteWindow))
			}
			release, retry, canceled := a.owner.acquireContext(r.Context())
			if canceled {
				return
			}
			if retry > 0 {
				if kind == parser {
					a.stats.RecordParse(a.parsePlatform(r.URL.RawQuery), "RATE_LIMITED", ChannelOwner, time.Since(wallStart))
				}
				rejectAdmission(w, r, kind, http.StatusTooManyRequests, retry)
				return
			}
			defer release()
			if a.owner.queueWait > 0 {
				_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(serverWriteWindow))
			}
			if kind == parser {
				r = r.WithContext(withParseWallStart(r.Context(), wallStart))
			}
			a.next.ServeHTTP(w, r)
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
		if r.Method == http.MethodGet && isSlowParsePlatform(a.parsePlatform(r.URL.RawQuery)) {
			return a.slow
		}
		return a.public
	default:
		return a.public
	}
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

type ownerPool struct {
	mu         sync.Mutex
	slots      int
	active     int
	queueWait  time.Duration
	queueSize  int
	waiters    list.List
	queueStats poolQueueCounters
}

func newOwnerPool(slots int, queueWait time.Duration, queueSize int) *ownerPool {
	return &ownerPool{
		slots:     slots,
		queueWait: queueWait,
		queueSize: queueSize,
	}
}

func (p *ownerPool) acquireContext(ctx context.Context) (release func(), retrySeconds int, canceled bool) {
	if ctx.Err() != nil {
		return nil, 0, true
	}
	p.mu.Lock()
	if p.active < p.slots {
		p.active++
		p.mu.Unlock()
		return p.makeRelease(), 0, false
	}
	if p.queueWait <= 0 || p.queueSize <= 0 || p.waiters.Len() >= p.queueSize {
		p.queueStats.full.Add(1)
		p.mu.Unlock()
		return nil, 1, false
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
			p.releaseSlot()
			p.queueStats.recordWait(elapsed, admQueueCanceled)
			return nil, 0, true
		}
		p.queueStats.recordWait(elapsed, admQueueGranted)
		return p.makeRelease(), 0, false

	case <-ctx.Done():
		elapsed := time.Since(waitStart)
		p.mu.Lock()
		if w.elem != nil {
			p.waiters.Remove(w.elem)
			w.elem = nil
			p.mu.Unlock()
			p.queueStats.recordWait(elapsed, admQueueCanceled)
			return nil, 0, true
		}
		p.mu.Unlock()
		<-w.granted
		p.releaseSlot()
		p.queueStats.recordWait(time.Since(waitStart), admQueueCanceled)
		return nil, 0, true

	case <-timer.C:
		elapsed := time.Since(waitStart)
		p.mu.Lock()
		if w.elem != nil {
			p.waiters.Remove(w.elem)
			w.elem = nil
			p.mu.Unlock()
			p.queueStats.recordWait(elapsed, admQueueTimeout)
			return nil, 1, false
		}
		p.mu.Unlock()
		<-w.granted
		elapsed = time.Since(waitStart)
		if ctx.Err() != nil {
			p.releaseSlot()
			p.queueStats.recordWait(elapsed, admQueueCanceled)
			return nil, 0, true
		}
		p.queueStats.recordWait(elapsed, admQueueGranted)
		return p.makeRelease(), 0, false
	}
}

func (p *ownerPool) makeRelease() func() {
	var once sync.Once
	return func() {
		once.Do(p.releaseSlot)
	}
}

func (p *ownerPool) releaseSlot() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if front := p.waiters.Front(); front != nil {
		w := p.waiters.Remove(front).(*poolWaiter)
		w.elem = nil
		w.granted <- struct{}{}
		return
	}
	p.active--
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

func (p *ownerPool) statsSnapshot() AdmissionPoolSnapshot {
	if p == nil {
		return AdmissionPoolSnapshot{}
	}
	p.mu.Lock()
	active := p.active
	queued := p.waiters.Len()
	concLimit := p.slots
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
		Owner: a.owner.statsSnapshot(),
	}
}

func rejectUnauthorized(w http.ResponseWriter, r *http.Request, kind route) {
	const message = "认证凭据无效"
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
