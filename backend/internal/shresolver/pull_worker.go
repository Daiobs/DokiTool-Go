package shresolver

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/bilibili"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
)

const (
	MinPullWorkers     = 1
	DefaultPullWorkers = 3
	MaxPullWorkers     = 8

	pullWorkers = DefaultPullWorkers
)

var errPullAuth = errors.New("Shanghai pull credential rejected")

// PullWorker runs concurrent lease loops (DefaultPullWorkers by default, bounded
// to MinPullWorkers..MaxPullWorkers). Only the pinned Japanese control endpoints
// receive its bearer. Detail lookups and media probes use separate transports.
type PullWorker struct {
	origin       string
	token        string
	workers      int
	control      fetch.Executor
	detail       fetch.Executor
	bilibili     fetch.Executor
	bilibiliDASH bool
	probe        originalProbe
}

func NewPullWorker(origin, token string, control fetch.Executor, p originalProbe) (*PullWorker, error) {
	return newPullWorker(origin, token, control, nil, nil, p)
}

func NewPullWorkerWithDetail(origin, token string, control, detail fetch.Executor, p originalProbe) (*PullWorker, error) {
	if detail == nil {
		return nil, errors.New("invalid Shanghai pull configuration")
	}
	return newPullWorker(origin, token, control, detail, detail, p)
}

func newPullWorker(origin, token string, control, detail, bilibiliExec fetch.Executor, p originalProbe) (*PullWorker, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil ||
		(u.EscapedPath() != "" && u.EscapedPath() != "/") || u.RawQuery != "" || u.ForceQuery || strings.Contains(origin, "#") ||
		!fetch.AllowHosts(u.Hostname())(origin) || !ValidToken(token) || control == nil || p == nil {
		return nil, errors.New("invalid Shanghai pull configuration")
	}
	if ip, err := netip.ParseAddr(u.Hostname()); err == nil && !fetch.PublicIP(ip) {
		return nil, errors.New("pull origin requires a public address")
	}
	return &PullWorker{
		origin:   "https://" + u.Host,
		token:    token,
		workers:  DefaultPullWorkers,
		control:  control,
		detail:   detail,
		bilibili: wrapBilibiliExecutor(bilibiliExec),
		probe:    p,
	}, nil
}

// WithBilibili overrides the Bilibili API executor on w (nil disables Bilibili task advertisement).
func (w *PullWorker) WithBilibili(exec fetch.Executor) *PullWorker {
	if w == nil {
		return nil
	}
	w.bilibili = wrapBilibiliExecutor(exec)
	return w
}

// WithBilibiliDASH enables or disables parallel Bilibili DASH playurl fetching on w.
// Defaults to false so disabled deployments issue strictly the single html5 durl request.
func (w *PullWorker) WithBilibiliDASH(enabled bool) *PullWorker {
	if w == nil {
		return nil
	}
	w.bilibiliDASH = enabled
	return w
}

// BilibiliDASHEnabled reports whether w fetches Bilibili DASH playurl in parallel.
func (w *PullWorker) BilibiliDASHEnabled() bool {
	return w != nil && w.bilibiliDASH
}

// WithWorkers configures the number of concurrent pull lease loops within
// [MinPullWorkers, MaxPullWorkers].
func (w *PullWorker) WithWorkers(n int) (*PullWorker, error) {
	if w == nil || n < MinPullWorkers || n > MaxPullWorkers {
		return nil, fmt.Errorf("Shanghai pull workers must be between %d and %d", MinPullWorkers, MaxPullWorkers)
	}
	w.workers = n
	return w, nil
}

func (w *PullWorker) supportedTasksHeader() string {
	if w.bilibili == nil {
		return ""
	}
	if w.detail != nil {
		return TaskDouyin + "," + TaskBilibili
	}
	return TaskBilibili
}

func (w *PullWorker) post(ctx context.Context, path string, body []byte, timeout time.Duration) (fetch.Response, error) {
	target := w.origin + path
	h := http.Header{"Authorization": {"Bearer " + w.token}, "Content-Type": {"application/json"}}
	if path == ClaimPath {
		if w.detail != nil || w.bilibili != nil {
			h.Set(ProtocolHeader, "2")
		}
		if tasks := w.supportedTasksHeader(); tasks != "" {
			h.Set(TasksHeader, tasks)
		}
	}
	resp, err := w.control.Do(ctx, fetch.Request{URL: target, Method: http.MethodPost, Body: body, Header: h,
		Policy: fetch.Policy{Purpose: "douyin-original-pull", Timeout: timeout, MaxBytes: 1024, MaxHeaderBytes: 8192,
			AllowedURL: func(raw string) bool { return raw == target }}})
	if err == nil && (resp.StatusCode == 401 || resp.StatusCode == 403) {
		return resp, errPullAuth
	}
	return resp, err
}

func validLeaseID(s string) bool {
	if len(s) != 32 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// runOnce never retries a claimed task or replays its result on another lease.
// The boolean result reports whether ClaimPath delivered a valid lease; post-claim
// task timeouts or result callback errors still return claimed=true so the caller
// immediately claims the next job without backoff.
func (w *PullWorker) runOnce(ctx context.Context) (bool, error) {
	res, err := w.post(ctx, ClaimPath, nil, PullWait+10*time.Second)
	if err != nil {
		return false, err
	}
	if res.StatusCode == http.StatusNoContent {
		return false, nil
	}
	if res.StatusCode != http.StatusOK {
		return false, errUnavailable
	}
	var job PullJob
	d := json.NewDecoder(bytes.NewReader(res.Body))
	d.DisallowUnknownFields()
	if d.Decode(&job) != nil || d.Decode(&struct{}{}) != io.EOF || !validLeaseID(job.TaskID) || !validLeaseID(job.AttemptID) {
		return false, errUnavailable
	}
	switch job.Protocol {
	case 0:
		if job.TaskType != "" || job.AwemeID != "" || job.BVID != "" || job.CID != 0 || !ValidVideoID(job.VideoID) {
			return false, errUnavailable
		}
	case ProtocolV2:
		switch job.TaskType {
		case "", TaskDouyin:
			if w.detail == nil || job.VideoID != "" || job.BVID != "" || job.CID != 0 || !douyin.ValidAwemeID(job.AwemeID) {
				return false, errUnavailable
			}
		case TaskBilibili:
			if w.bilibili == nil || job.VideoID != "" || job.AwemeID != "" || !bilibili.ValidBVID(job.BVID) || !bilibili.ValidCID(job.CID) {
				return false, errUnavailable
			}
		default:
			return false, errUnavailable
		}
	default:
		return false, errUnavailable
	}
	deadline := time.UnixMilli(job.DeadlineMS)
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return true, errUnavailable
	}
	msg := PullResult{PullJob: job, Result: json.RawMessage("null")}
	var leaseBudget time.Duration
	switch job.Protocol {
	case 0:
		leaseBudget = min(remaining, clientTimeout)
		lease, cancel := context.WithTimeout(ctx, leaseBudget)
		defer cancel()
		out, probeErr := probeOriginal(lease, w.probe, job.VideoID)
		if err := lease.Err(); err != nil {
			return true, err
		}
		if probeErr == nil {
			raw, err := json.Marshal(out)
			if err == nil && len(raw) <= maxV1ResponseBytes {
				msg.Result = raw
			}
		}
		body, err := json.Marshal(msg)
		if err != nil {
			return true, err
		}
		ack, err := w.post(lease, ResultPath, body, clientTimeout)
		if err != nil {
			return true, err
		}
		if ack.StatusCode != http.StatusNoContent && ack.StatusCode != http.StatusConflict {
			return true, errUnavailable
		}
		return true, nil
	case ProtocolV2:
		if job.TaskType == TaskBilibili {
			leaseBudget = min(remaining, BilibiliTimeout)
			lease, cancel := context.WithTimeout(ctx, leaseBudget)
			defer cancel()
			out, playErr := resolveBilibili(lease, w.bilibili, job.BVID, job.CID, w.bilibiliDASH)
			if err := lease.Err(); err != nil {
				return true, err
			}
			if playErr == nil && out != nil && out.HasAnyRoute() {
				raw, err := json.Marshal(out)
				if err == nil && len(raw) <= maxResponseBytes {
					msg.Result = raw
				}
			}
			body, err := json.Marshal(msg)
			if err != nil {
				return true, err
			}
			ack, err := w.post(lease, ResultPath, body, BilibiliTimeout)
			if err != nil {
				return true, err
			}
			if ack.StatusCode != http.StatusNoContent && ack.StatusCode != http.StatusConflict {
				return true, errUnavailable
			}
			return true, nil
		}
		leaseBudget = min(remaining, WorkTimeout)
		lease, cancel := context.WithTimeout(ctx, leaseBudget)
		defer cancel()
		out, workErr := resolveWork(lease, w.detail, w.probe, job.AwemeID)
		if err := lease.Err(); err != nil {
			return true, err
		}
		if workErr == nil {
			raw, err := json.Marshal(out)
			if err == nil && len(raw) <= maxResponseBytes {
				msg.Result = raw
			}
		}
		body, err := json.Marshal(msg)
		if err != nil {
			return true, err
		}
		ack, err := w.post(lease, ResultPath, body, WorkTimeout)
		if err != nil {
			return true, err
		}
		if ack.StatusCode != http.StatusNoContent && ack.StatusCode != http.StatusConflict {
			return true, errUnavailable
		}
		return true, nil
	default:
		return false, errUnavailable
	}
}

func (w *PullWorker) runLoop(ctx context.Context) error {
	backoff := time.Second
	fastEmpty := 0
	for ctx.Err() == nil {
		start := time.Now()
		claimed, err := w.runOnce(ctx)
		if ctx.Err() != nil {
			break
		}
		if errors.Is(err, errPullAuth) {
			return err
		}
		if claimed || (err == nil && time.Since(start) >= PullWait/2) {
			backoff = time.Second
			fastEmpty = 0
			continue
		}
		if err == nil && time.Since(start) < time.Second {
			fastEmpty++
			if fastEmpty >= 3 {
				fastEmpty = 0
				if closer, ok := w.control.(interface{ CloseIdleConnections() }); ok {
					closer.CloseIdleConnections()
				}
				log.Print("shanghai-resolver: consecutive fast empty 204 claims; closing idle connections")
			}
		} else {
			fastEmpty = 0
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		backoff = min(2*backoff, 10*time.Second)
	}
	return ctx.Err()
}

func (w *PullWorker) Run(ctx context.Context) error {
	if w == nil || w.workers < MinPullWorkers || w.workers > MaxPullWorkers {
		return fmt.Errorf("Shanghai pull workers must be between %d and %d", MinPullWorkers, MaxPullWorkers)
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var (
		wg        sync.WaitGroup
		fatalOnce sync.Once
		fatalErr  error
	)
	for range w.workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := w.runLoop(runCtx); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
				fatalOnce.Do(func() {
					fatalErr = err
					cancel()
				})
			}
		}()
	}
	wg.Wait()
	if fatalErr != nil {
		return fatalErr
	}
	return ctx.Err()
}
