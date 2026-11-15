package shresolver

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/bilibili"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const (
	ClaimPath            = "/internal/shanghai/claim"
	ResultPath           = "/internal/shanghai/result"
	PullWait             = 15 * time.Second
	PullStaleClaimGrace  = 5 * time.Second
	DefaultPullQueueWait = 300 * time.Millisecond
	pullCapacity         = MaxPullWorkers * 2
	pullQueueCapacity    = MaxPullWorkers * 4
)

// PullJob is a single-use lease. DeadlineMS is absolute; another poll cannot
// extend it. There is no replay or redelivery on worker disconnect.
// Legacy v1 jobs omit Protocol and AwemeID, and Douyin v2 jobs omit TaskType,
// BVID and CID so older workers/brokers with DisallowUnknownFields accept them
// byte-for-byte unchanged.
type PullJob struct {
	Protocol   int    `json:"protocol,omitempty"`
	TaskType   string `json:"task_type,omitempty"`
	TaskID     string `json:"task_id"`
	AttemptID  string `json:"attempt_id"`
	VideoID    string `json:"video_id,omitempty"`
	AwemeID    string `json:"aweme_id,omitempty"`
	BVID       string `json:"bvid,omitempty"`
	CID        int64  `json:"cid,omitempty"`
	DeadlineMS int64  `json:"deadline_ms"`
}

type PullResult struct {
	PullJob
	Result json.RawMessage `json:"result"` // Response (v1), WorkResponse (v2), bilibili.ShanghaiPlay, or null on failure
}

type pullWaiter struct {
	ctx      context.Context
	protocol int
	bilibili bool
	job      chan PullJob
}

type pullTask struct {
	job      PullJob
	ctx      context.Context
	result   chan json.RawMessage
	received bool
}

type pullQueueOutcome struct {
	task *pullTask
	err  error
}

type pullQueueEntry struct {
	ctx      context.Context
	protocol int
	taskType string
	videoID  string
	awemeID  string
	bvid     string
	cid      int64
	ready    chan pullQueueOutcome
	done     bool
}

func supportsTask(headerVal, want string) bool {
	if headerVal == "" || want == "" {
		return false
	}
	for _, token := range strings.Split(headerVal, ",") {
		if strings.TrimSpace(token) == want {
			return true
		}
	}
	return false
}

func waiterMatchesTask(proto int, bilibiliCap bool, taskProto int, taskType string) bool {
	if taskType == TaskBilibili {
		return proto >= ProtocolV2 && bilibiliCap
	}
	if taskProto == ProtocolV2 {
		return proto >= ProtocolV2
	}
	return true
}

// PullBroker matches requests immediately to waiting Shanghai workers, or holds
// requests in a bounded FIFO queue for up to DefaultPullQueueWait when a worker
// has claimed within PullWait+PullStaleClaimGrace so brief worker saturation or
// long-poll reconnects do not lose domestic routes while an offline Shanghai node
// still falls back immediately.
type PullBroker struct {
	responseValidator
	token                   string
	queueWait               time.Duration
	queueCap                int
	claimSlots, resultSlots chan struct{}
	mu                      sync.Mutex
	lastClaimAt             time.Time
	lastBilibiliClaimAt     time.Time
	waiting                 []*pullWaiter
	queue                   []*pullQueueEntry
	pending                 map[string]*pullTask
	stats                   shanghaiCounters
}

func NewPullBroker(token string) (*PullBroker, error) {
	if !ValidToken(token) {
		return nil, errUnavailable
	}
	return &PullBroker{
		responseValidator: newResponseValidator(),
		token:             token,
		queueWait:         DefaultPullQueueWait,
		queueCap:          pullQueueCapacity,
		claimSlots:        make(chan struct{}, pullCapacity),
		resultSlots:       make(chan struct{}, pullCapacity),
		pending:           make(map[string]*pullTask),
	}, nil
}

// WithLookupNetIP overrides host DNS validation for isolated tests and loopback harnesses.
func (b *PullBroker) WithLookupNetIP(fn func(context.Context, string, string) ([]netip.Addr, error)) *PullBroker {
	if b != nil && fn != nil {
		b.lookup = fn
	}
	return b
}

// WithClock overrides wall-clock evaluation for deterministic expiry and queue-idle tests.
func (b *PullBroker) WithClock(now func() time.Time) *PullBroker {
	if b != nil && now != nil {
		b.now = now
	}
	return b
}

func (b *PullBroker) currentTime() time.Time {
	if b.now != nil {
		return b.now()
	}
	return time.Now()
}

func (b *PullBroker) hasRecentClaimLocked() bool {
	if b.lastClaimAt.IsZero() {
		return false
	}
	return b.currentTime().Sub(b.lastClaimAt) <= PullWait+PullStaleClaimGrace
}

func (b *PullBroker) hasRecentBilibiliClaimLocked() bool {
	if b.lastBilibiliClaimAt.IsZero() {
		return false
	}
	return b.currentTime().Sub(b.lastBilibiliClaimAt) <= PullWait+PullStaleClaimGrace
}

func (b *PullBroker) newPullTaskLocked(ctx context.Context, protocol int, taskType, videoID, awemeID, bvid string, cid int64) *pullTask {
	var ids [32]byte
	rand.Read(ids[:])
	deadline, _ := ctx.Deadline()
	job := PullJob{
		TaskID:     hex.EncodeToString(ids[:16]),
		AttemptID:  hex.EncodeToString(ids[16:]),
		DeadlineMS: deadline.UnixMilli(),
	}
	switch {
	case taskType == TaskBilibili:
		job.Protocol = ProtocolV2
		job.TaskType = TaskBilibili
		job.BVID = bvid
		job.CID = cid
	case protocol == ProtocolV2:
		job.Protocol = ProtocolV2
		job.AwemeID = awemeID
	default:
		job.VideoID = videoID
	}
	t := &pullTask{job: job, ctx: ctx, result: make(chan json.RawMessage, 1)}
	b.pending[job.TaskID] = t
	return t
}

func (b *PullBroker) acquireTask(ctx context.Context, protocol int, taskType, videoID, awemeID, bvid string, cid int64) (*pullTask, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	platIdx := platDouyinIdx
	if taskType == TaskBilibili {
		platIdx = platBilibiliIdx
	}

	b.mu.Lock()
	b.waiting = slices.DeleteFunc(b.waiting, func(w *pullWaiter) bool { return w.ctx.Err() != nil })
	b.queue = slices.DeleteFunc(b.queue, func(e *pullQueueEntry) bool { return e.done })

	if len(b.pending) < pullCapacity {
		for i, w := range b.waiting {
			if !waiterMatchesTask(w.protocol, w.bilibili, protocol, taskType) {
				continue
			}
			b.waiting = slices.Delete(b.waiting, i, i+1)
			t := b.newPullTaskLocked(ctx, protocol, taskType, videoID, awemeID, bvid, cid)
			w.job <- t.job
			b.mu.Unlock()
			return t, nil
		}
		if taskType == "" && protocol == ProtocolV2 && len(b.waiting) > 0 {
			// Only legacy v1 workers are waiting; preserve their claim so
			// ResolveOriginal can dispatch a v1 video_id lease after detail completes.
			b.mu.Unlock()
			return nil, douyin.ErrProtocolV1
		}
	} else if len(b.waiting) > 0 {
		b.mu.Unlock()
		return nil, errUnavailable
	}

	wait := b.queueWait
	hasRecent := b.hasRecentClaimLocked()
	if taskType == TaskBilibili {
		hasRecent = b.hasRecentBilibiliClaimLocked()
	}
	if wait <= 0 || b.queueCap <= 0 || len(b.queue) >= b.queueCap || !hasRecent {
		b.mu.Unlock()
		return nil, errUnavailable
	}
	entry := &pullQueueEntry{
		ctx:      ctx,
		protocol: protocol,
		taskType: taskType,
		videoID:  videoID,
		awemeID:  awemeID,
		bvid:     bvid,
		cid:      cid,
		ready:    make(chan pullQueueOutcome, 1),
	}
	b.queue = append(b.queue, entry)
	b.mu.Unlock()

	chIdx := channelIndex(ChannelFromContext(ctx))
	waitStart := time.Now()
	timer := time.NewTimer(wait)
	defer timer.Stop()

	select {
	case out := <-entry.ready:
		waitDur := time.Since(waitStart)
		if err := ctx.Err(); err != nil {
			if out.task != nil {
				b.mu.Lock()
				delete(b.pending, out.task.job.TaskID)
				b.mu.Unlock()
			}
			b.stats.recordQueueWait(chIdx, platIdx, waitDur, queueOutcomeCanceled)
			return nil, err
		}
		if out.task != nil {
			b.stats.recordQueueWait(chIdx, platIdx, waitDur, queueOutcomeGranted)
		} else {
			b.stats.recordQueueWait(chIdx, platIdx, waitDur, queueOutcomeOther)
		}
		return out.task, out.err
	case <-ctx.Done():
		waitDur := time.Since(waitStart)
		b.mu.Lock()
		if !entry.done {
			entry.done = true
			b.queue = slices.DeleteFunc(b.queue, func(v *pullQueueEntry) bool { return v == entry })
			b.mu.Unlock()
			b.stats.recordQueueWait(chIdx, platIdx, waitDur, queueOutcomeCanceled)
			return nil, ctx.Err()
		}
		b.mu.Unlock()
		out := <-entry.ready
		if out.task != nil {
			b.mu.Lock()
			delete(b.pending, out.task.job.TaskID)
			b.mu.Unlock()
		}
		b.stats.recordQueueWait(chIdx, platIdx, waitDur, queueOutcomeCanceled)
		return nil, ctx.Err()
	case <-timer.C:
		waitDur := time.Since(waitStart)
		b.mu.Lock()
		if !entry.done {
			entry.done = true
			b.queue = slices.DeleteFunc(b.queue, func(v *pullQueueEntry) bool { return v == entry })
			b.mu.Unlock()
			b.stats.recordQueueWait(chIdx, platIdx, waitDur, queueOutcomeTimeout)
			return nil, errUnavailable
		}
		b.mu.Unlock()
		out := <-entry.ready
		if err := ctx.Err(); err != nil {
			if out.task != nil {
				b.mu.Lock()
				delete(b.pending, out.task.job.TaskID)
				b.mu.Unlock()
			}
			b.stats.recordQueueWait(chIdx, platIdx, waitDur, queueOutcomeCanceled)
			return nil, err
		}
		if out.task != nil {
			b.stats.recordQueueWait(chIdx, platIdx, waitDur, queueOutcomeGranted)
		} else {
			b.stats.recordQueueWait(chIdx, platIdx, waitDur, queueOutcomeOther)
		}
		return out.task, out.err
	}
}

func (b *PullBroker) ResolveOriginal(parent context.Context, videoID string) (rows []unified.Object, err error) {
	defer func() {
		b.stats.recordResolveOutcome(parent, platDouyinIdx, err)
	}()
	if err = parent.Err(); err != nil {
		return nil, err
	}
	if !ValidVideoID(videoID) {
		return nil, errUnavailable
	}
	ctx, cancel := context.WithTimeout(parent, clientTimeout)
	defer cancel()
	task, err := b.acquireTask(ctx, 0, "", videoID, "", "", 0)
	if err != nil {
		return nil, err
	}
	defer func() {
		b.mu.Lock()
		delete(b.pending, task.job.TaskID)
		b.mu.Unlock()
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case data := <-task.result:
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return b.validateResponse(ctx, videoID, data)
	}
}

func (b *PullBroker) ResolveWork(parent context.Context, awemeID string) (work *douyin.ShanghaiWork, err error) {
	defer func() {
		b.stats.recordResolveOutcome(parent, platDouyinIdx, err)
	}()
	if err = parent.Err(); err != nil {
		return nil, err
	}
	if !douyin.ValidAwemeID(awemeID) {
		return nil, errUnavailable
	}
	ctx, cancel := context.WithTimeout(parent, WorkTimeout)
	defer cancel()
	task, err := b.acquireTask(ctx, ProtocolV2, "", "", awemeID, "", 0)
	if err != nil {
		return nil, err
	}
	defer func() {
		b.mu.Lock()
		delete(b.pending, task.job.TaskID)
		b.mu.Unlock()
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case data := <-task.result:
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return b.validateWorkResponse(ctx, awemeID, data)
	}
}

// ResolveBilibili requests domestic Bilibili stream observations for (bvid, cid)
// within BilibiliTimeout and immediately commits a hit outcome on success.
func (b *PullBroker) ResolveBilibili(parent context.Context, bvid string, cid int64) (*bilibili.ShanghaiPlay, error) {
	play, finish, err := b.ResolveBilibiliPending(parent, bvid, cid)
	if err != nil {
		return nil, err
	}
	if finish != nil {
		finish(true)
	}
	return play, nil
}

// ResolveBilibiliPending requests domestic Bilibili stream observations within
// BilibiliTimeout, deferring hit vs fallback classification until finish(matched)
// is called so quality-tier mismatches with Japan are counted as fallbacks monotonically.
func (b *PullBroker) ResolveBilibiliPending(parent context.Context, bvid string, cid int64) (play *bilibili.ShanghaiPlay, finish func(bool), err error) {
	defer func() {
		if err != nil {
			b.stats.recordResolveOutcome(parent, platBilibiliIdx, err)
		}
	}()
	if err = parent.Err(); err != nil {
		return nil, nil, err
	}
	if !bilibili.ValidBVID(bvid) || !bilibili.ValidCID(cid) {
		return nil, nil, errUnavailable
	}
	ctx, cancel := context.WithTimeout(parent, BilibiliTimeout)
	defer cancel()
	task, err := b.acquireTask(ctx, ProtocolV2, TaskBilibili, "", "", bvid, cid)
	if err != nil {
		return nil, nil, err
	}
	defer func() {
		b.mu.Lock()
		delete(b.pending, task.job.TaskID)
		b.mu.Unlock()
	}()
	select {
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	case data := <-task.result:
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		play, err = b.validateBilibiliResponse(ctx, bvid, cid, data)
		if err != nil {
			return nil, nil, err
		}
		var once sync.Once
		finish = func(matched bool) {
			once.Do(func() {
				if matched {
					b.stats.recordResolveOutcome(parent, platBilibiliIdx, nil)
				} else {
					b.stats.recordResolveOutcome(parent, platBilibiliIdx, errUnavailable)
				}
			})
		}
		return play, finish, nil
	}
}

// ShanghaiStatsSnapshot returns a point-in-time snapshot of PullBroker gauges and per-channel resolution counters.
func (b *PullBroker) ShanghaiStatsSnapshot() StatsSnapshot {
	if b == nil {
		return StatsSnapshot{Mode: "off"}
	}
	b.mu.Lock()
	waitingWorkers := 0
	for _, w := range b.waiting {
		if w.ctx.Err() == nil {
			waitingWorkers++
		}
	}
	queuedTasks := 0
	for _, e := range b.queue {
		if !e.done {
			queuedTasks++
		}
	}
	pendingTasks := len(b.pending)
	b.mu.Unlock()
	return b.stats.snapshot("pull", waitingWorkers, queuedTasks, pendingTasks)
}

// PlatformStatsSnapshot returns per-platform (Douyin vs Bilibili) resolution counters.
func (b *PullBroker) PlatformStatsSnapshot() PlatformBreakdown {
	if b == nil {
		return PlatformBreakdown{}
	}
	return b.stats.platformBreakdown()
}

func (b *PullBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	path := r.URL.EscapedPath()
	if (path != ClaimPath && path != ResultPath) || r.URL.RawQuery != "" || r.URL.ForceQuery {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	auth := r.Header.Values("Authorization")
	if len(auth) != 1 || subtle.ConstantTimeCompare([]byte(auth[0]), []byte("Bearer "+b.token)) != 1 {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	// Waiting claims never consume result slots. These concurrency
	// bounds are independent of user parsing and media streaming admission.
	slots := b.resultSlots
	if path == ClaimPath {
		slots = b.claimSlots
	}
	select {
	case slots <- struct{}{}:
		defer func() { <-slots }()
	default:
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	if path == ClaimPath {
		if r.ContentLength != 0 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		b.claim(w, r)
		return
	}
	b.receive(w, r)
}

func (b *PullBroker) claim(w http.ResponseWriter, r *http.Request) {
	if r.Context().Err() != nil {
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), PullWait)
	defer cancel()
	proto := 1
	if r.Header.Get(ProtocolHeader) == "2" {
		proto = ProtocolV2
	}
	bilibiliCap := proto >= ProtocolV2 && supportsTask(r.Header.Get(TasksHeader), TaskBilibili)

	b.mu.Lock()
	if ctx.Err() != nil {
		b.mu.Unlock()
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	now := b.currentTime()
	b.lastClaimAt = now
	if bilibiliCap {
		b.lastBilibiliClaimAt = now
	}
	for i := 0; i < len(b.queue); {
		e := b.queue[i]
		if e.done {
			b.queue = slices.Delete(b.queue, i, i+1)
			continue
		}
		if err := e.ctx.Err(); err != nil {
			e.done = true
			b.queue = slices.Delete(b.queue, i, i+1)
			e.ready <- pullQueueOutcome{err: err}
			continue
		}
		i++
	}
	if len(b.pending) < pullCapacity {
		for i, e := range b.queue {
			if !waiterMatchesTask(proto, bilibiliCap, e.protocol, e.taskType) {
				continue
			}
			e.done = true
			b.queue = slices.Delete(b.queue, i, i+1)
			t := b.newPullTaskLocked(e.ctx, e.protocol, e.taskType, e.videoID, e.awemeID, e.bvid, e.cid)
			e.ready <- pullQueueOutcome{task: t}
			b.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(w).Encode(t.job); err != nil {
				b.finish(t.job, nil)
			}
			return
		}
	}
	waiter := &pullWaiter{ctx: ctx, protocol: proto, bilibili: bilibiliCap, job: make(chan PullJob, 1)}
	b.waiting = append(b.waiting, waiter)
	if proto < ProtocolV2 && len(b.pending) < pullCapacity {
		for i, e := range b.queue {
			if e.taskType == "" && e.protocol == ProtocolV2 {
				e.done = true
				b.queue = slices.Delete(b.queue, i, i+1)
				e.ready <- pullQueueOutcome{err: douyin.ErrProtocolV1}
				break
			}
		}
	}
	b.mu.Unlock()

	select {
	case job := <-waiter.job:
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(job); err != nil {
			b.finish(job, nil)
		}
	case <-ctx.Done():
		b.mu.Lock()
		b.waiting = slices.DeleteFunc(b.waiting, func(v *pullWaiter) bool { return v == waiter })
		b.mu.Unlock()
		select { // a dispatch and the claim timeout can coincide
		case job := <-waiter.job:
			b.finish(job, nil)
		default:
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (b *PullBroker) receive(w http.ResponseWriter, r *http.Request) {
	// Limit how long a slow sender can occupy one of the result slots.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(3 * time.Second))
	var result PullResult
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxResponseBytes+512))
	d.DisallowUnknownFields()
	if d.Decode(&result) != nil || d.Decode(&struct{}{}) != io.EOF {
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	_ = controller.SetReadDeadline(time.Time{})
	if len(result.Result) == 0 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	limit := maxResponseBytes
	switch result.Protocol {
	case 0:
		limit = maxV1ResponseBytes
	case ProtocolV2:
	default:
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if len(result.Result) > limit {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	switch result.TaskType {
	case "":
		if result.BVID != "" || result.CID != 0 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if !bytes.Equal(result.Result, []byte("null")) {
			if result.Protocol == ProtocolV2 {
				var work struct {
					Protocol int    `json:"protocol"`
					AwemeID  string `json:"aweme_id"`
				}
				if json.Unmarshal(result.Result, &work) != nil || work.Protocol != ProtocolV2 || work.AwemeID != result.AwemeID {
					w.WriteHeader(http.StatusConflict)
					return
				}
			} else {
				var media struct {
					VideoID string `json:"video_id"`
				}
				if json.Unmarshal(result.Result, &media) != nil || media.VideoID != result.VideoID {
					w.WriteHeader(http.StatusConflict)
					return
				}
			}
		}
	case TaskBilibili:
		if result.Protocol != ProtocolV2 || result.VideoID != "" || result.AwemeID != "" ||
			!bilibili.ValidBVID(result.BVID) || !bilibili.ValidCID(result.CID) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if !bytes.Equal(result.Result, []byte("null")) {
			var play struct {
				BVID string `json:"bvid"`
				CID  int64  `json:"cid"`
			}
			if json.Unmarshal(result.Result, &play) != nil || play.BVID != result.BVID || play.CID != result.CID {
				w.WriteHeader(http.StatusConflict)
				return
			}
		}
	default:
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if !b.finish(result.PullJob, result.Result) {
		w.WriteHeader(http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Consume at most one receipt. The original request, not the callback handler,
// owns validation of the candidate with the remainder of its own budget.
func (b *PullBroker) finish(job PullJob, payload json.RawMessage) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	task := b.pending[job.TaskID]
	if task == nil || task.received || job != task.job || task.ctx.Err() != nil || time.Now().UnixMilli() >= task.job.DeadlineMS {
		return false
	}
	task.received = true
	delete(b.pending, job.TaskID)
	if job.TaskType == TaskBilibili {
		b.lastBilibiliClaimAt = b.currentTime()
	}
	task.result <- payload
	return true
}
