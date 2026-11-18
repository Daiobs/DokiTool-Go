// Command loadtest drives mixed local fake-upstream traffic (fast pure-Go
// platforms, slow yt-dlp platforms, and the Shanghai PullBroker channel)
// strictly over 127.0.0.1 loopback sockets. No external DNS or network
// connections are permitted.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	mrand "math/rand"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/api"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/bilibili"
	weiboplatform "github.com/Brilliant666/DokiTool-Go/backend/internal/platform/weibo"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type config struct {
	profile          string
	rpsList          []float64
	duration         time.Duration
	fastLatency      time.Duration
	slowLatency      time.Duration
	shanghaiLatency  time.Duration
	hotRatio         float64
	hotURLs          int
	clients          int
	cacheMode        string
	ytdlpConcurrency int
	shanghaiWorkers  int
	ownerRatio       float64
	ownerConcurrency int
	bearerEnv        string
	jsonOutput       bool
}

type classSummary struct {
	Requests  int64   `json:"requests"`
	OK        int64   `json:"ok"`
	RateLimit int64   `json:"rate_limited_429"`
	OtherErr  int64   `json:"other_errors"`
	OKPct     float64 `json:"ok_pct"`
	R429Pct   float64 `json:"rate_limited_429_pct"`
	OtherPct  float64 `json:"other_err_pct"`
	P50MS     float64 `json:"p50_ms"`
	P95MS     float64 `json:"p95_ms"`
	OKP50MS   float64 `json:"ok_p50_ms"`
	OKP95MS   float64 `json:"ok_p95_ms"`
}

type tierResult struct {
	Profile                string       `json:"profile"`
	TargetRPS              float64      `json:"target_rps"`
	AchievedRPS            float64      `json:"achieved_rps"`
	DurationSec            float64      `json:"duration_sec"`
	Overall                classSummary `json:"overall"`
	Fast                   classSummary `json:"fast_and_shanghai"`
	Slow                   classSummary `json:"slow_ytdlp"`
	OwnerAgent             classSummary `json:"owner_agent"`
	Anonymous              classSummary `json:"anonymous_visitors"`
	WeiboOwnerDirect       int64        `json:"weibo_owner_direct_ok"`
	WeiboAnonRelay         int64        `json:"weibo_anon_relay_ok"`
	PeakHeapAllocMiB       float64      `json:"peak_heap_alloc_mib"`
	PeakSysMiB             float64      `json:"peak_sys_mib"`
	PeakGoroutines         int          `json:"peak_goroutines"`
	EndGoroutines          int          `json:"end_goroutines"`
	FastUpstreams          int64        `json:"fast_upstream_calls"`
	SlowUpstreams          int64        `json:"slow_upstream_calls"`
	ShanghaiHits           int64        `json:"shanghai_resolved_hits"`
	ShanghaiMisses         int64        `json:"shanghai_fallback_misses"`
	ShanghaiDouyinHits     int64        `json:"shanghai_douyin_hits"`
	ShanghaiBilibiliHits   int64        `json:"shanghai_bilibili_hits"`
	ShanghaiBilibiliMisses int64        `json:"shanghai_bilibili_fallback_misses"`
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "loadtest: %v\n", err)
		os.Exit(1)
	}
}

func parseConfig(args []string) (config, error) {
	fs := flag.NewFlagSet("loadtest", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	profile := fs.String("profile", "current", "preset profile: current (post-PR4), baseline (pre-PR4), pre-102, pre-pr5, or post-pr5")
	rpsRaw := fs.String("rps", "5,25,60,120", "comma-separated target req/s tiers")
	duration := fs.Duration("duration", 120*time.Second, "duration per RPS tier")
	fastLatency := fs.Duration("fast-latency", 500*time.Millisecond, "simulated pure-Go upstream parse latency")
	slowLatency := fs.Duration("slow-latency", 3000*time.Millisecond, "simulated yt-dlp extraction latency")
	shanghaiLatency := fs.Duration("shanghai-latency", 550*time.Millisecond, "simulated Shanghai domestic resolve latency")
	hotRatio := fs.Float64("hot-ratio", 0.35, "fraction of requests hitting Zipfian hot URL set (0..1)")
	hotURLs := fs.Int("hot-urls", 512, "size of hot URL working set")
	clients := fs.Int("clients", 8192, "distinct simulated client IPs")
	cacheMode := fs.String("cache", "auto", "parse cache mode: auto, on, or off")
	ytdlpConc := fs.Int("ytdlp-concurrency", 0, "override yt-dlp concurrency (0 = profile default)")
	shWorkers := fs.Int("shanghai-workers", 0, "override Shanghai pull worker count (0 = profile default)")
	ownerRatio := fs.Float64("owner-ratio", -1, "fraction of single-IP batch agent requests in [0,1] (-1 = profile default)")
	ownerConc := fs.Int("owner-concurrency", 0, "override DOKITOOL_OWNER_CONCURRENCY (0 = profile default 8)")
	bearerEnv := fs.String("bearer-env", "", "optional env var name holding a Bearer token to attach on requests")
	jsonOut := fs.Bool("json", false, "emit JSON results to stdout")

	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if fs.NArg() != 0 {
		return config{}, errors.New("unexpected positional arguments")
	}
	switch *profile {
	case "current", "baseline", "pre-102", "pre-pr5", "post-pr5":
	default:
		return config{}, errors.New("profile must be current, baseline, pre-102, pre-pr5, or post-pr5")
	}
	if *duration <= 0 || *duration > 30*time.Minute {
		return config{}, errors.New("duration must be between 1ms and 30m")
	}
	if *fastLatency < 0 || *fastLatency > 30*time.Second || *slowLatency < 0 || *slowLatency > 30*time.Second || *shanghaiLatency < 0 || *shanghaiLatency > 30*time.Second {
		return config{}, errors.New("simulated latencies must be between 0s and 30s")
	}
	if math.IsNaN(*hotRatio) || *hotRatio < 0 || *hotRatio > 1 {
		return config{}, errors.New("hot-ratio must be between 0 and 1")
	}
	if math.IsNaN(*ownerRatio) || (*ownerRatio != -1 && (*ownerRatio < 0 || *ownerRatio > 1)) {
		return config{}, errors.New("owner-ratio must be -1 or between 0 and 1")
	}
	if *hotURLs < 8 || *hotURLs > 65536 {
		return config{}, errors.New("hot-urls must be between 8 and 65536")
	}
	if *clients < 1 || *clients > 65536 {
		return config{}, errors.New("clients must be between 1 and 65536")
	}
	switch *cacheMode {
	case "auto", "on", "off":
	default:
		return config{}, errors.New("cache must be auto, on, or off")
	}
	if *ytdlpConc < 0 || *ytdlpConc > 24 {
		return config{}, errors.New("ytdlp-concurrency must be between 0 and 24")
	}
	if *shWorkers < 0 || *shWorkers > shresolver.MaxPullWorkers {
		return config{}, fmt.Errorf("shanghai-workers must be between 0 and %d", shresolver.MaxPullWorkers)
	}
	if *ownerConc < 0 || *ownerConc > api.MaxOwnerConcurrency {
		return config{}, fmt.Errorf("owner-concurrency must be between 0 and %d", api.MaxOwnerConcurrency)
	}

	var tiers []float64
	for _, part := range strings.Split(*rpsRaw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		v, err := strconv.ParseFloat(part, 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 || v > 5000 {
			return config{}, errors.New("each rps tier must be a number in (0, 5000]")
		}
		tiers = append(tiers, v)
	}
	if len(tiers) == 0 {
		return config{}, errors.New("at least one rps tier is required")
	}

	effOwnerRatio := *ownerRatio
	if effOwnerRatio < 0 {
		if *profile == "pre-pr5" || *profile == "post-pr5" {
			effOwnerRatio = 0.5
		} else {
			effOwnerRatio = 0
		}
	}

	return config{
		profile:          *profile,
		rpsList:          tiers,
		duration:         *duration,
		fastLatency:      *fastLatency,
		slowLatency:      *slowLatency,
		shanghaiLatency:  *shanghaiLatency,
		hotRatio:         *hotRatio,
		hotURLs:          *hotURLs,
		clients:          *clients,
		cacheMode:        *cacheMode,
		ytdlpConcurrency: *ytdlpConc,
		shanghaiWorkers:  *shWorkers,
		ownerRatio:       effOwnerRatio,
		ownerConcurrency: *ownerConc,
		bearerEnv:        *bearerEnv,
		jsonOutput:       *jsonOut,
	}, nil
}

func run(args []string, out io.Writer) error {
	cfg, err := parseConfig(args)
	if err != nil {
		return err
	}

	results := make([]tierResult, 0, len(cfg.rpsList))
	for _, rps := range cfg.rpsList {
		res, err := runTier(cfg, rps)
		if err != nil {
			return err
		}
		results = append(results, res)
	}

	if cfg.jsonOutput {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(results)
	}
	printMarkdownReport(out, cfg, results)
	return nil
}

func randomHex(numBytes int) (string, error) {
	buf := make([]byte, numBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// newLoopbackClient builds an HTTP client whose DialContext refuses any
// non-loopback target, guaranteeing zero external network or DNS traffic.
func newLoopbackClient(maxConns int, timeout time.Duration) *http.Client {
	var dialer net.Dialer
	tr := &http.Transport{
		MaxIdleConns:        maxConns,
		MaxIdleConnsPerHost: maxConns,
		IdleConnTimeout:     30 * time.Second,
		DisableCompression:  true,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			ip, err := netip.ParseAddr(host)
			if err != nil || !ip.IsLoopback() {
				return nil, errors.New("loadtest: non-loopback dial forbidden")
			}
			return dialer.DialContext(ctx, network, address)
		},
	}
	return &http.Client{Transport: tr, Timeout: timeout}
}

func sleepContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func loadFullCatalog() (*catalog.Catalog, error) {
	c, err := catalog.Load()
	if err != nil {
		return nil, err
	}
	for _, extra := range []unified.Object{
		catalog.XPlatform(),
		catalog.YouTubePlatform(),
		catalog.InstagramPlatform(),
	} {
		if err := c.Register(extra); err != nil {
			return nil, err
		}
	}
	for _, id := range []string{"facebook", "tumblr", "dailymotion"} {
		spec, ok := ytgeneric.LookupSite(id)
		if !ok {
			return nil, fmt.Errorf("missing builtin site %q", id)
		}
		if err := c.Register(spec.CatalogEntry()); err != nil {
			return nil, err
		}
	}
	return c, nil
}

func syntheticEnvelope(platform, sourceURL string, now int64, itemIDs ...string) unified.Object {
	if len(itemIDs) == 0 {
		itemIDs = []string{"item-1"}
	}
	expiresAt := time.Unix(now+120, 0).UTC().Format(time.RFC3339)
	items := make(unified.Array, 0, len(itemIDs))
	for i, id := range itemIDs {
		mediaURL := "https://cdn.example.com/" + platform + "/" + id + ".mp4"
		src := unified.Object{
			"id":         "s-" + id,
			"url":        mediaURL,
			"expires_at": expiresAt,
		}
		def := unified.Object{
			"variant_id": "v-" + id,
			"source_id":  "s-" + id,
			"url":        mediaURL,
			"access":     "direct",
			"expires_at": expiresAt,
		}
		items = append(items, unified.Object{
			"id":          id,
			"index":       i + 1,
			"type":        "video",
			"source_url":  sourceURL,
			"resolve_url": unified.ResolveURL(sourceURL, id),
			"default":     def,
			"variants": unified.Array{
				unified.Object{
					"id": "v-" + id,
					"metadata": unified.Object{
						"container": "mp4",
						"extension": "mp4",
						"mime_type": "video/mp4",
						"width":     1920,
						"height":    1080,
						"has_audio": true,
						"evidence":  "upstream",
					},
					"delivery": unified.Object{
						"kind":    "file",
						"sources": unified.Array{src},
					},
				},
			},
		})
	}
	return unified.Object{
		"schema_version": "1.0",
		"code":           "OK",
		"data": unified.Object{
			"platform":        platform,
			"source_url":      sourceURL,
			"refresh_url":     "/api/parse?schema_version=1.0&url=" + unified.RFC3986Query(sourceURL),
			"generated_at":    time.Unix(now, 0).UTC().Format(time.RFC3339),
			"default_item_id": itemIDs[0],
			"items":           items,
		},
	}
}

func syntheticBilibiliEnvelope(sourceURL string, now int64, shPlay *bilibili.ShanghaiPlay, itemIDs ...string) unified.Object {
	if len(itemIDs) == 0 {
		itemIDs = []string{"part-1"}
	}
	dl := now + 7200
	items := make(unified.Array, 0, len(itemIDs))
	for i, id := range itemIDs {
		jpURL := fmt.Sprintf("https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/00/01/%d/%d-1-80.mp4?deadline=%d", i+1, i+1, dl)
		var rawSources unified.Array
		if shPlay != nil && len(shPlay.DURLPieces) > 0 {
			for _, u := range shPlay.DURLPieces[0].URLs {
				rawSources = append(rawSources, u)
			}
		}
		rawSources = append(rawSources, jpURL)
		srcs := unified.Sources(rawSources, now)
		items = append(items, unified.Object{
			"id":          id,
			"index":       i + 1,
			"type":        "video",
			"source_url":  sourceURL,
			"resolve_url": unified.ResolveURL(sourceURL, id),
			"variants": unified.Array{
				unified.Object{
					"id": "v-" + id,
					"metadata": unified.Object{
						"container": "mp4",
						"extension": "mp4",
						"mime_type": "video/mp4",
						"width":     1920,
						"height":    1080,
						"has_audio": true,
						"evidence":  "upstream",
					},
					"delivery": unified.Object{
						"kind":    "file",
						"sources": srcs,
					},
				},
			},
		})
	}
	return unified.FinalizeData(unified.Object{
		"platform":        "bilibili",
		"source_url":      sourceURL,
		"refresh_url":     "/api/parse?schema_version=1.0&url=" + unified.RFC3986Query(sourceURL),
		"default_item_id": itemIDs[0],
		"items":           items,
	}, now)
}

type requestSpec struct {
	route   string
	rawURL  string
	itemID  string
	isSlow  bool
	isWeibo bool
}

func buildRequestSpec(slot int, workNum uint64) requestSpec {
	// Interleaved 20-slot deterministic cycle:
	//   9 slots  (45%): Fast pure-Go platforms (bilibili parse + resolve, kuaishou, xiaohongshu, toutiao)
	//   6 slots  (30%): Douyin + Shanghai PullBroker channel
	//   5 slots  (25%): Slow yt-dlp platforms (x, instagram)
	switch slot % 20 {
	case 0, 8:
		return requestSpec{
			route:  "/api/parse",
			rawURL: fmt.Sprintf("https://www.bilibili.com/video/BV1xx411c%03d?p=%d", workNum%900+100, workNum),
		}
	case 4:
		return requestSpec{
			route:  "/api/resolve",
			rawURL: fmt.Sprintf("https://www.bilibili.com/video/BV1yy411c%03d?p=%d", workNum%900+100, workNum),
			itemID: "part-2",
		}
	case 2, 12:
		return requestSpec{
			route:  "/api/parse",
			rawURL: fmt.Sprintf("https://www.kuaishou.com/short-video/3xload%d", workNum),
		}
	case 6, 15:
		return requestSpec{
			route:  "/api/parse",
			rawURL: fmt.Sprintf("https://www.xiaohongshu.com/explore/66a000%010d", workNum),
		}
	case 10, 18:
		return requestSpec{
			route:  "/api/parse",
			rawURL: fmt.Sprintf("https://www.toutiao.com/video/%d/", 7300000000000000000+workNum),
		}
	case 1, 5, 9, 13, 16, 19:
		awemeID := 7400000000000000000 + workNum
		return requestSpec{
			route:  "/api/parse",
			rawURL: fmt.Sprintf("https://www.douyin.com/video/%019d", awemeID),
		}
	case 3, 11, 17:
		return requestSpec{
			route:  "/api/parse",
			rawURL: fmt.Sprintf("https://x.com/loadtest/status/%d", 1800000000000000000+workNum),
			isSlow: true,
		}
	default: // 7, 14
		return requestSpec{
			route:  "/api/parse",
			rawURL: fmt.Sprintf("https://www.instagram.com/reel/Cload%08d/", workNum),
			isSlow: true,
		}
	}
}

func buildPR5RequestSpec(slot int, workNum uint64) requestSpec {
	// Interleaved 20-slot deterministic cycle including Weibo relay/direct verification:
	//   9 slots  (45%): Fast pure-Go platforms (bilibili parse + resolve, weibo, kuaishou, xiaohongshu, toutiao)
	//   6 slots  (30%): Douyin + Shanghai PullBroker channel
	//   5 slots  (25%): Slow yt-dlp platforms (x, instagram)
	switch slot % 20 {
	case 2, 12:
		return requestSpec{
			route:   "/api/parse",
			rawURL:  fmt.Sprintf("https://weibo.com/1234567890/%d", 5000000000000000+workNum),
			isWeibo: true,
		}
	case 6:
		return requestSpec{
			route:  "/api/parse",
			rawURL: fmt.Sprintf("https://www.kuaishou.com/short-video/3xload%d", workNum),
		}
	default:
		return buildRequestSpec(slot, workNum)
	}
}

type loopbackWeiboExecutor struct {
	fetchUpstream func(ctx context.Context, path string) error
	body          []byte
}

func (e loopbackWeiboExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	if err := e.fetchUpstream(ctx, "/upstream/fast?platform=weibo"); err != nil {
		return fetch.Response{}, err
	}
	return fetch.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{},
		Body:       e.body,
		URL:        req.URL,
	}, nil
}

func clientIPForIndex(idx uint64, totalClients int) string {
	n := int(idx % uint64(totalClients))
	b2 := (n / 254) % 256
	b3 := (n % 254) + 1
	return fmt.Sprintf("198.18.%d.%d", b2, b3)
}

func runShanghaiWorkerLoop(
	ctx context.Context,
	client *http.Client,
	apiBaseURL string,
	upstreamBaseURL string,
	edgeKey string,
	pullToken string,
	workerIP string,
) {
	for ctx.Err() == nil {
		claimReq, err := http.NewRequestWithContext(ctx, http.MethodPost, apiBaseURL+shresolver.ClaimPath, nil)
		if err != nil {
			return
		}
		claimReq.Header.Set("X-DokiTool-Edge-Key", edgeKey)
		claimReq.Header.Set("X-DokiTool-Client-IP", workerIP)
		claimReq.Header.Set("Authorization", "Bearer "+pullToken)
		claimReq.Header.Set("Content-Type", "application/json")
		claimReq.Header.Set(shresolver.ProtocolHeader, "2")
		claimReq.Header.Set(shresolver.TasksHeader, "douyin,bilibili")

		resp, err := client.Do(claimReq)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			_ = sleepContext(ctx, 20*time.Millisecond)
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()

		if resp.StatusCode == http.StatusNoContent {
			continue
		}
		if resp.StatusCode != http.StatusOK {
			_ = sleepContext(ctx, 20*time.Millisecond)
			continue
		}

		var job shresolver.PullJob
		if err := json.Unmarshal(body, &job); err != nil {
			continue
		}

		// Simulate Shanghai domestic upstream resolution over 127.0.0.1.
		shQuery := "aweme_id=" + url.QueryEscape(job.AwemeID)
		if job.TaskType == shresolver.TaskBilibili {
			shQuery = "task=bilibili&bvid=" + url.QueryEscape(job.BVID) + "&cid=" + strconv.FormatInt(job.CID, 10)
		}
		upReq, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamBaseURL+"/upstream/shanghai?"+shQuery, nil)
		if err != nil {
			return
		}
		upResp, upErr := client.Do(upReq)
		if upResp != nil {
			_, _ = io.Copy(io.Discard, upResp.Body)
			upResp.Body.Close()
		}

		resultRaw := json.RawMessage("null")
		if upErr == nil && upResp != nil && upResp.StatusCode == http.StatusOK {
			if job.TaskType == shresolver.TaskBilibili {
				dl := time.Now().Unix() + 7200
				shURL := fmt.Sprintf("https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/00/01/%d/%d-1-80.mp4?deadline=%d", job.CID, job.CID, dl)
				play := bilibili.ShanghaiPlay{
					BVID:        job.BVID,
					CID:         job.CID,
					DURLQuality: 80,
					DURLPieces:  []bilibili.ShanghaiDURLPiece{{URLs: []string{shURL}}},
				}
				if encoded, err := json.Marshal(play); err == nil {
					resultRaw = encoded
				}
			} else {
				work := shresolver.WorkResponse{
					Protocol: shresolver.ProtocolV2,
					AwemeID:  job.AwemeID,
					VideoID:  "v0200fg10000" + job.AwemeID,
				}
				if encoded, err := json.Marshal(work); err == nil {
					resultRaw = encoded
				}
			}
		}

		payload, err := json.Marshal(shresolver.PullResult{
			PullJob: job,
			Result:  resultRaw,
		})
		if err != nil {
			continue
		}
		resReq, err := http.NewRequestWithContext(ctx, http.MethodPost, apiBaseURL+shresolver.ResultPath, bytes.NewReader(payload))
		if err != nil {
			return
		}
		resReq.Header.Set("X-DokiTool-Edge-Key", edgeKey)
		resReq.Header.Set("X-DokiTool-Client-IP", workerIP)
		resReq.Header.Set("Authorization", "Bearer "+pullToken)
		resReq.Header.Set("Content-Type", "application/json")
		ack, err := client.Do(resReq)
		if ack != nil {
			_, _ = io.Copy(io.Discard, ack.Body)
			ack.Body.Close()
		}
		if err != nil && ctx.Err() != nil {
			return
		}
	}
}

func runTier(cfg config, targetRPS float64) (tierResult, error) {
	runtime.GC()

	edgeKey, err := randomHex(32)
	if err != nil {
		return tierResult{}, err
	}
	pullToken, err := randomHex(32)
	if err != nil {
		return tierResult{}, err
	}
	mediaSigningKey, err := randomHex(32)
	if err != nil {
		return tierResult{}, err
	}
	runtimeOwnerToken, err := randomHex(32)
	if err != nil {
		return tierResult{}, err
	}

	var fastUpstreamCalls atomic.Int64
	var slowUpstreamCalls atomic.Int64
	var shanghaiHits atomic.Int64
	var shanghaiMisses atomic.Int64
	var shanghaiDouyinHits atomic.Int64
	var shanghaiBilibiliHits atomic.Int64
	var shanghaiBilibiliMisses atomic.Int64
	var weiboOwnerDirect atomic.Int64
	var weiboAnonRelay atomic.Int64

	// 1. Start local 127.0.0.1 fake upstream server.
	upstreamMux := http.NewServeMux()
	upstreamMux.HandleFunc("/upstream/fast", func(w http.ResponseWriter, r *http.Request) {
		fastUpstreamCalls.Add(1)
		if err := sleepContext(r.Context(), cfg.fastLatency); err != nil {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	upstreamMux.HandleFunc("/upstream/slow", func(w http.ResponseWriter, r *http.Request) {
		slowUpstreamCalls.Add(1)
		if err := sleepContext(r.Context(), cfg.slowLatency); err != nil {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	upstreamMux.HandleFunc("/upstream/shanghai", func(w http.ResponseWriter, r *http.Request) {
		if err := sleepContext(r.Context(), cfg.shanghaiLatency); err != nil {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	upstreamLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return tierResult{}, err
	}
	upstreamSrv := &http.Server{Handler: upstreamMux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = upstreamSrv.Serve(upstreamLn) }()
	defer func() {
		shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = upstreamSrv.Shutdown(shutCtx)
	}()
	upstreamBase := "http://" + upstreamLn.Addr().String()

	// 2. Configure profile parameters.
	ytdlpConc := cfg.ytdlpConcurrency
	shWorkers := cfg.shanghaiWorkers
	waitOnYTDLP := true
	cacheDisabled := false
	limits := api.DefaultAdmissionConfig()
	singleSharedPool := false

	switch cfg.profile {
	case "pre-102":
		if ytdlpConc == 0 {
			ytdlpConc = 2
		}
		if shWorkers == 0 {
			shWorkers = 3
		}
		waitOnYTDLP = false
		cacheDisabled = true
		singleSharedPool = true
		limits.Parse.GlobalConcurrency = 16
		limits.Parse.GlobalRPS = 10
		limits.Parse.GlobalBurst = 20
		limits.Parse.QueueWait = 0
		limits.Parse.QueueSize = 0
	case "baseline":
		if ytdlpConc == 0 {
			ytdlpConc = 2
		}
		if shWorkers == 0 {
			shWorkers = 3
		}
		waitOnYTDLP = false
		singleSharedPool = true
		limits.Parse.GlobalConcurrency = 16
		limits.Parse.GlobalRPS = 10
		limits.Parse.GlobalBurst = 20
		limits.Parse.QueueWait = 0
		limits.Parse.QueueSize = 0
	case "current", "pre-pr5", "post-pr5":
		if ytdlpConc == 0 {
			ytdlpConc = 6
		}
		if shWorkers == 0 {
			shWorkers = 6
		}
		waitOnYTDLP = true
		limits.SlowParse.GlobalConcurrency = ytdlpConc
	}
	if cfg.ownerConcurrency > 0 {
		limits.OwnerConcurrency = cfg.ownerConcurrency
	}
	enableOwnerChannel := cfg.profile == "post-pr5"
	isPR5Mix := cfg.profile == "pre-pr5" || cfg.profile == "post-pr5" || cfg.ownerRatio > 0

	if cfg.cacheMode == "on" {
		cacheDisabled = false
	} else if cfg.cacheMode == "off" {
		cacheDisabled = true
	}

	cacheCfg := api.DefaultCacheConfig()
	if cacheDisabled {
		cacheCfg = api.CacheConfig{Disabled: true}
	}

	// 3. Build catalog, Shanghai PullBroker, and fake-upstream adapters.
	cat, err := loadFullCatalog()
	if err != nil {
		return tierResult{}, err
	}
	broker, err := shresolver.NewPullBroker(pullToken)
	if err != nil {
		return tierResult{}, err
	}
	broker.WithLookupNetIP(func(_ context.Context, _, _ string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
	}).WithBilibili(true)

	adapterClient := newLoopbackClient(256, 30*time.Second)
	ytdlpSem := make(chan struct{}, ytdlpConc)

	fetchFakeUpstream := func(ctx context.Context, path string) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamBase+path, nil)
		if err != nil {
			return err
		}
		resp, err := adapterClient.Do(req)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("upstream status %d", resp.StatusCode)
		}
		return nil
	}

	fastAdapter := func(platform string, itemIDs ...string) api.Adapter {
		return api.AdapterFunc(func(ctx context.Context, source string, now int64) (unified.Object, error) {
			if err := fetchFakeUpstream(ctx, "/upstream/fast?platform="+platform); err != nil {
				if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
					return unified.ContractError("UPSTREAM_TIMEOUT", "上游请求超时", true), nil
				}
				return nil, err
			}
			return syntheticEnvelope(platform, source, now, itemIDs...), nil
		})
	}

	douyinAdapter := api.AdapterFunc(func(ctx context.Context, source string, now int64) (unified.Object, error) {
		awemeID := "7400000000000000001"
		if idx := strings.LastIndexByte(source, '/'); idx >= 0 && len(source[idx+1:]) == 19 {
			awemeID = source[idx+1:]
		}
		shDone := make(chan error, 1)
		go func() {
			_, err := broker.ResolveWork(ctx, awemeID)
			shDone <- err
		}()
		if err := fetchFakeUpstream(ctx, "/upstream/fast?platform=douyin"); err != nil {
			return unified.ContractError("UPSTREAM_TIMEOUT", "上游请求超时", true), nil
		}
		if err := <-shDone; err == nil {
			shanghaiHits.Add(1)
			shanghaiDouyinHits.Add(1)
		} else {
			shanghaiMisses.Add(1)
		}
		return syntheticEnvelope("douyin", source, now, "aweme-"+awemeID), nil
	})

	bilibiliAdapter := api.AdapterFunc(func(ctx context.Context, source string, now int64) (unified.Object, error) {
		bvid := "BV1xx411c100"
		if u, err := url.Parse(source); err == nil {
			if seg := strings.TrimPrefix(u.Path, "/video/"); len(seg) >= 12 && bilibili.ValidBVID(seg[:12]) {
				bvid = seg[:12]
			}
		}
		const cid int64 = 1001
		type biliSHRes struct {
			play *bilibili.ShanghaiPlay
			err  error
		}
		shDone := make(chan biliSHRes, 1)
		go func() {
			play, err := broker.ResolveBilibili(ctx, bvid, cid)
			shDone <- biliSHRes{play: play, err: err}
		}()
		if err := fetchFakeUpstream(ctx, "/upstream/fast?platform=bilibili"); err != nil {
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				return unified.ContractError("UPSTREAM_TIMEOUT", "上游请求超时", true), nil
			}
			return nil, err
		}
		res := <-shDone
		env := syntheticBilibiliEnvelope(source, now, res.play, "part-1", "part-2")
		if res.err == nil && res.play != nil && res.play.HasAnyRoute() {
			shanghaiHits.Add(1)
			shanghaiBilibiliHits.Add(1)
		} else {
			shanghaiMisses.Add(1)
			shanghaiBilibiliMisses.Add(1)
		}
		return env, nil
	})

	slowAdapter := func(platform string) api.Adapter {
		return api.AdapterFunc(func(ctx context.Context, source string, now int64) (unified.Object, error) {
			if waitOnYTDLP {
				select {
				case ytdlpSem <- struct{}{}:
				case <-ctx.Done():
					return unified.ContractError("UPSTREAM_TIMEOUT", "解析等待超时", true), nil
				}
			} else {
				select {
				case ytdlpSem <- struct{}{}:
				default:
					errPayload := unified.ContractError("RATE_LIMITED", "当前解析请求较多，请稍后再试", true)
					unified.Map(errPayload["error"])["retry_after_seconds"] = 1
					return errPayload, nil
				}
			}
			defer func() { <-ytdlpSem }()

			if err := fetchFakeUpstream(ctx, "/upstream/slow?platform="+platform); err != nil {
				return unified.ContractError("UPSTREAM_TIMEOUT", "解析执行超时", true), nil
			}
			return syntheticEnvelope(platform, source, now, "yt-"+platform), nil
		})
	}

	const syntheticWeiboJSON = `{"idstr":"1234567890","text_raw":"loadtest","page_info":{"media_info":{"mp4_hd_url":"https://f.video.weibocdn.com/loadtest.mp4?size=1080","video_title":"loadtest","duration":16}},"user":{"screen_name":"loadtest","idstr":"1"}}`
	weiboAdapter := weiboplatform.New(loopbackWeiboExecutor{
		fetchUpstream: fetchFakeUpstream,
		body:          []byte(syntheticWeiboJSON),
	})

	adapters := map[string]api.Adapter{
		"douyin":      douyinAdapter,
		"bilibili":    bilibiliAdapter,
		"weibo":       weiboAdapter,
		"toutiao":     fastAdapter("toutiao"),
		"kuaishou":    fastAdapter("kuaishou"),
		"pipixia":     fastAdapter("pipixia"),
		"pipigx":      fastAdapter("pipigx"),
		"zuiyou":      fastAdapter("zuiyou"),
		"xiaohongshu": fastAdapter("xiaohongshu"),
		"x":           slowAdapter("x"),
		"youtube":     slowAdapter("youtube"),
		"instagram":   slowAdapter("instagram"),
		"facebook":    slowAdapter("facebook"),
		"tumblr":      slowAdapter("tumblr"),
		"dailymotion": slowAdapter("dailymotion"),
	}

	var weiboMedia api.PublicMedia
	if enableOwnerChannel {
		weiboMedia = weiboplatform.PreparePublicWithOwner(mediaSigningKey, api.IsOwnerRequest)
	} else {
		weiboMedia = weiboplatform.PreparePublic(mediaSigningKey)
	}
	publicMedia := func(ctx context.Context, platform string, payload unified.Object, now int64) (unified.Object, error) {
		if platform == "bilibili" {
			return bilibili.PreparePublic(ctx, platform, payload, now)
		}
		return weiboMedia(ctx, platform, payload, now)
	}

	handler, err := api.NewWithCacheConfig(cat, adapters, time.Now, publicMedia, cacheCfg)
	if err != nil {
		return tierResult{}, err
	}
	handler.Stats().SetShanghaiSource(broker)

	var next http.Handler = handler
	if singleSharedPool {
		// Wrap handler in a plain HandlerFunc to exercise pre-PR4 single-pool routing.
		next = http.HandlerFunc(handler.ServeHTTP)
	}
	var ownerAuth api.OwnerAuth
	if enableOwnerChannel {
		ownerAuth, err = api.NewOwnerAuth(runtimeOwnerToken)
		if err != nil {
			return tierResult{}, err
		}
	}
	entry, err := api.WithAdmissionWithOwner(next, broker, "caddy", edgeKey, limits, ownerAuth)
	if err != nil {
		return tierResult{}, err
	}

	apiLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return tierResult{}, err
	}
	apiSrv := &http.Server{
		Handler:           entry,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      50 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() { _ = apiSrv.Serve(apiLn) }()
	defer func() {
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = apiSrv.Shutdown(shutCtx)
	}()
	apiBase := "http://" + apiLn.Addr().String()

	// 4. Start simulated Shanghai pull workers and wait briefly for initial long-poll registration.
	workerCtx, cancelWorkers := context.WithCancel(context.Background())
	var workerWG sync.WaitGroup
	shClient := newLoopbackClient(shWorkers*2+4, shresolver.PullWait+10*time.Second)
	for i := 0; i < shWorkers; i++ {
		workerWG.Add(1)
		workerIP := fmt.Sprintf("198.51.100.%d", 200+i)
		go func(ip string) {
			defer workerWG.Done()
			runShanghaiWorkerLoop(workerCtx, shClient, apiBase, upstreamBase, edgeKey, pullToken, ip)
		}(workerIP)
	}
	time.Sleep(40 * time.Millisecond)

	// 5. Runtime memory & goroutine sampler.
	var peakHeap uint64
	var peakSys uint64
	var peakGoroutines atomic.Int64
	sampleStop := make(chan struct{})
	var sampleWG sync.WaitGroup
	sampleWG.Add(1)
	go func() {
		defer sampleWG.Done()
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			var ms runtime.MemStats
			runtime.ReadMemStats(&ms)
			for {
				cur := atomic.LoadUint64(&peakHeap)
				if ms.HeapAlloc <= cur || atomic.CompareAndSwapUint64(&peakHeap, cur, ms.HeapAlloc) {
					break
				}
			}
			for {
				cur := atomic.LoadUint64(&peakSys)
				if ms.Sys <= cur || atomic.CompareAndSwapUint64(&peakSys, cur, ms.Sys) {
					break
				}
			}
			g := int64(runtime.NumGoroutine())
			for {
				cur := peakGoroutines.Load()
				if g <= cur || peakGoroutines.CompareAndSwap(cur, g) {
					break
				}
			}
			select {
			case <-sampleStop:
				return
			case <-ticker.C:
			}
		}
	}()

	// 6. Open-loop Poisson/paced load generator.
	clientTimeout := 20 * time.Second
	if enableOwnerChannel {
		clientTimeout = limits.OwnerQueueWait + 55*time.Second
	}
	loadClient := newLoopbackClient(1024, clientTimeout)
	bearerValue := ""
	if cfg.bearerEnv != "" {
		bearerValue = strings.TrimSpace(os.Getenv(cfg.bearerEnv))
	}

	type obs struct {
		status  int
		latMS   float64
		isSlow  bool
		isOwner bool
	}
	expectedTotal := int(math.Ceil(targetRPS*cfg.duration.Seconds())) + 64
	var obsMu sync.Mutex
	records := make([]obs, 0, expectedTotal)

	rng := mrand.New(mrand.NewSource(10204))
	zipf := mrand.NewZipf(rng, 1.15, 1.0, uint64(cfg.hotURLs-1))

	var reqWG sync.WaitGroup
	startTime := time.Now()
	endTime := startTime.Add(cfg.duration)
	interval := time.Duration(float64(time.Second) / targetRPS)
	if interval < time.Microsecond {
		interval = time.Microsecond
	}

	var seq uint64
	var ownerSeq uint64
	var anonSeq uint64
	var ownerAcc float64
	var coldCounter uint64 = 100_000
	const ownerAgentIP = "198.18.255.250"
	nextSend := startTime
	for {
		now := time.Now()
		if !now.Before(endTime) {
			break
		}
		if wait := nextSend.Sub(now); wait > 0 {
			time.Sleep(wait)
			if !time.Now().Before(endTime) {
				break
			}
		}
		nextSend = nextSend.Add(interval)

		seq++
		isOwnerReq := false
		if cfg.ownerRatio > 0 {
			ownerAcc += cfg.ownerRatio
			if ownerAcc+1e-9 >= 1.0 {
				ownerAcc -= 1.0
				isOwnerReq = true
			}
		}
		var slot int
		var clientIP string
		if isOwnerReq {
			slot = int(ownerSeq % 100)
			ownerSeq++
			clientIP = ownerAgentIP
		} else {
			slot = int(anonSeq % 100)
			clientIP = clientIPForIndex(anonSeq, cfg.clients)
			anonSeq++
		}

		var workNum uint64
		if rng.Float64() < cfg.hotRatio {
			workNum = zipf.Uint64() + 1
		} else {
			coldCounter++
			workNum = coldCounter
		}
		var spec requestSpec
		if isPR5Mix {
			spec = buildPR5RequestSpec(slot, workNum)
		} else {
			spec = buildRequestSpec(slot, workNum)
		}

		reqWG.Add(1)
		go func(sp requestSpec, ip string, ownerCall bool) {
			defer reqWG.Done()
			t0 := time.Now()
			target := apiBase + sp.route + "?schema_version=1.0&url=" + url.QueryEscape(sp.rawURL)
			if sp.itemID != "" {
				target += "&item_id=" + url.QueryEscape(sp.itemID)
			}
			req, err := http.NewRequest(http.MethodGet, target, nil)
			if err != nil {
				return
			}
			req.Header.Set("X-DokiTool-Edge-Key", edgeKey)
			req.Header.Set("X-DokiTool-Client-IP", ip)
			if ownerCall && enableOwnerChannel {
				req.Header.Set("Authorization", "Bearer "+runtimeOwnerToken)
			} else if bearerValue != "" {
				req.Header.Set("Authorization", "Bearer "+bearerValue)
			}
			resp, err := loadClient.Do(req)
			status := 0
			if err == nil && resp != nil {
				status = resp.StatusCode
				if sp.isWeibo && status == http.StatusOK {
					b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
					bodyStr := string(b)
					if strings.Contains(bodyStr, "/api/media/weibo?ticket=") {
						weiboAnonRelay.Add(1)
					} else if strings.Contains(bodyStr, "https://f.video.weibocdn.com/") {
						weiboOwnerDirect.Add(1)
					}
				} else {
					_, _ = io.Copy(io.Discard, resp.Body)
				}
				resp.Body.Close()
			}
			lat := float64(time.Since(t0).Microseconds()) / 1000.0
			obsMu.Lock()
			records = append(records, obs{status: status, latMS: lat, isSlow: sp.isSlow, isOwner: ownerCall})
			obsMu.Unlock()
		}(spec, clientIP, isOwnerReq)
	}

	sendElapsed := time.Since(startTime).Seconds()
	reqWG.Wait()
	elapsed := time.Since(startTime).Seconds()

	close(sampleStop)
	sampleWG.Wait()

	cancelWorkers()
	shClient.CloseIdleConnections()
	loadClient.CloseIdleConnections()
	adapterClient.CloseIdleConnections()
	workerWG.Wait()
	time.Sleep(20 * time.Millisecond)
	endGoroutines := runtime.NumGoroutine()

	summarize := func(filter func(obs) bool) classSummary {
		var s classSummary
		lats := make([]float64, 0, len(records))
		okLats := make([]float64, 0, len(records))
		for _, r := range records {
			if !filter(r) {
				continue
			}
			s.Requests++
			lats = append(lats, r.latMS)
			switch r.status {
			case http.StatusOK:
				s.OK++
				okLats = append(okLats, r.latMS)
			case http.StatusTooManyRequests:
				s.RateLimit++
			default:
				s.OtherErr++
			}
		}
		if s.Requests > 0 {
			s.OKPct = float64(s.OK) * 100 / float64(s.Requests)
			s.R429Pct = float64(s.RateLimit) * 100 / float64(s.Requests)
			s.OtherPct = float64(s.OtherErr) * 100 / float64(s.Requests)
			slices.Sort(lats)
			s.P50MS = percentileSorted(lats, 0.50)
			s.P95MS = percentileSorted(lats, 0.95)
		}
		if len(okLats) > 0 {
			slices.Sort(okLats)
			s.OKP50MS = percentileSorted(okLats, 0.50)
			s.OKP95MS = percentileSorted(okLats, 0.95)
		}
		return s
	}

	return tierResult{
		Profile:                cfg.profile,
		TargetRPS:              targetRPS,
		AchievedRPS:            float64(len(records)) / sendElapsed,
		DurationSec:            elapsed,
		Overall:                summarize(func(obs) bool { return true }),
		Fast:                   summarize(func(o obs) bool { return !o.isSlow }),
		Slow:                   summarize(func(o obs) bool { return o.isSlow }),
		OwnerAgent:             summarize(func(o obs) bool { return o.isOwner }),
		Anonymous:              summarize(func(o obs) bool { return !o.isOwner }),
		WeiboOwnerDirect:       weiboOwnerDirect.Load(),
		WeiboAnonRelay:         weiboAnonRelay.Load(),
		PeakHeapAllocMiB:       float64(atomic.LoadUint64(&peakHeap)) / (1024 * 1024),
		PeakSysMiB:             float64(atomic.LoadUint64(&peakSys)) / (1024 * 1024),
		PeakGoroutines:         int(peakGoroutines.Load()),
		EndGoroutines:          endGoroutines,
		FastUpstreams:          fastUpstreamCalls.Load(),
		SlowUpstreams:          slowUpstreamCalls.Load(),
		ShanghaiHits:           shanghaiHits.Load(),
		ShanghaiMisses:         shanghaiMisses.Load(),
		ShanghaiDouyinHits:     shanghaiDouyinHits.Load(),
		ShanghaiBilibiliHits:   shanghaiBilibiliHits.Load(),
		ShanghaiBilibiliMisses: shanghaiBilibiliMisses.Load(),
	}, nil
}

func percentileSorted(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(math.Ceil(p*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

func printMarkdownReport(out io.Writer, cfg config, results []tierResult) {
	fmt.Fprintf(out, "### Profile: `%s` (duration=%s, fast=%s, slow=%s, shanghai=%s, hot=%.0f%%, clients=%d, owner_ratio=%.0f%%)\n\n",
		cfg.profile, cfg.duration, cfg.fastLatency, cfg.slowLatency, cfg.shanghaiLatency, cfg.hotRatio*100, cfg.clients, cfg.ownerRatio*100)
	if cfg.ownerRatio > 0 {
		fmt.Fprintln(out, "| Target RPS | Send RPS | Total Reqs | Overall 200 % | 429 % | Other Err % | All p50 / p95 (ms) | 200-OK p50 / p95 (ms) | Owner Agent 200 % (OK p95) | Anonymous 200 % (OK p95) | Weibo Direct / Relay | Peak Heap / Sys (MiB) | Peak / End Goroutines |")
		fmt.Fprintln(out, "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
		for _, r := range results {
			fmt.Fprintf(out, "| %.0f | %.1f | %d | %.2f%% | %.2f%% | %.2f%% | %.1f / %.1f | %.1f / %.1f | %.2f%% (%.1fms) | %.2f%% (%.1fms) | %d / %d | %.2f / %.2f | %d / %d |\n",
				r.TargetRPS,
				r.AchievedRPS,
				r.Overall.Requests,
				r.Overall.OKPct,
				r.Overall.R429Pct,
				r.Overall.OtherPct,
				r.Overall.P50MS, r.Overall.P95MS,
				r.Overall.OKP50MS, r.Overall.OKP95MS,
				r.OwnerAgent.OKPct, r.OwnerAgent.OKP95MS,
				r.Anonymous.OKPct, r.Anonymous.OKP95MS,
				r.WeiboOwnerDirect, r.WeiboAnonRelay,
				r.PeakHeapAllocMiB, r.PeakSysMiB,
				r.PeakGoroutines,
				r.EndGoroutines,
			)
		}
		return
	}
	fmt.Fprintln(out, "| Target RPS | Send RPS | Total Reqs | 200 OK % | 429 % | Other Err % | All p50 / p95 (ms) | 200-OK p50 / p95 (ms) | Fast 200 % (OK p95) | Slow 200 % (OK p95) | Peak Heap / Sys (MiB) | Peak / End Goroutines |")
	fmt.Fprintln(out, "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
	for _, r := range results {
		fmt.Fprintf(out, "| %.0f | %.1f | %d | %.2f%% | %.2f%% | %.2f%% | %.1f / %.1f | %.1f / %.1f | %.2f%% (%.1fms) | %.2f%% (%.1fms) | %.2f / %.2f | %d / %d |\n",
			r.TargetRPS,
			r.AchievedRPS,
			r.Overall.Requests,
			r.Overall.OKPct,
			r.Overall.R429Pct,
			r.Overall.OtherPct,
			r.Overall.P50MS, r.Overall.P95MS,
			r.Overall.OKP50MS, r.Overall.OKP95MS,
			r.Fast.OKPct, r.Fast.OKP95MS,
			r.Slow.OKPct, r.Slow.OKP95MS,
			r.PeakHeapAllocMiB, r.PeakSysMiB,
			r.PeakGoroutines,
			r.EndGoroutines,
		)
	}
}
