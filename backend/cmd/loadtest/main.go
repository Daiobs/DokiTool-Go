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
	Profile          string       `json:"profile"`
	TargetRPS        float64      `json:"target_rps"`
	AchievedRPS      float64      `json:"achieved_rps"`
	DurationSec      float64      `json:"duration_sec"`
	Overall          classSummary `json:"overall"`
	Fast             classSummary `json:"fast_and_shanghai"`
	Slow             classSummary `json:"slow_ytdlp"`
	PeakHeapAllocMiB float64      `json:"peak_heap_alloc_mib"`
	PeakSysMiB       float64      `json:"peak_sys_mib"`
	PeakGoroutines   int          `json:"peak_goroutines"`
	EndGoroutines    int          `json:"end_goroutines"`
	FastUpstreams    int64        `json:"fast_upstream_calls"`
	SlowUpstreams    int64        `json:"slow_upstream_calls"`
	ShanghaiHits     int64        `json:"shanghai_resolved_hits"`
	ShanghaiMisses   int64        `json:"shanghai_fallback_misses"`
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

	profile := fs.String("profile", "current", "preset profile: current (post-PR4), baseline (pre-PR4), or pre-102")
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
	bearerEnv := fs.String("bearer-env", "", "optional env var name holding a Bearer token to attach on requests")
	jsonOut := fs.Bool("json", false, "emit JSON results to stdout")

	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if fs.NArg() != 0 {
		return config{}, errors.New("unexpected positional arguments")
	}
	switch *profile {
	case "current", "baseline", "pre-102":
	default:
		return config{}, errors.New("profile must be current, baseline, or pre-102")
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

type requestSpec struct {
	route  string
	rawURL string
	itemID string
	isSlow bool
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
		upReq, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamBaseURL+"/upstream/shanghai?aweme_id="+url.QueryEscape(job.AwemeID), nil)
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
			work := shresolver.WorkResponse{
				Protocol: shresolver.ProtocolV2,
				AwemeID:  job.AwemeID,
				VideoID:  "v0200fg10000" + job.AwemeID,
			}
			if encoded, err := json.Marshal(work); err == nil {
				resultRaw = encoded
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

	var fastUpstreamCalls atomic.Int64
	var slowUpstreamCalls atomic.Int64
	var shanghaiHits atomic.Int64
	var shanghaiMisses atomic.Int64

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
	case "current":
		if ytdlpConc == 0 {
			ytdlpConc = 6
		}
		if shWorkers == 0 {
			shWorkers = 6
		}
		waitOnYTDLP = true
		limits.SlowParse.GlobalConcurrency = ytdlpConc
	}

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
		} else {
			shanghaiMisses.Add(1)
		}
		return syntheticEnvelope("douyin", source, now, "aweme-"+awemeID), nil
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

	adapters := map[string]api.Adapter{
		"douyin":      douyinAdapter,
		"bilibili":    fastAdapter("bilibili", "part-1", "part-2"),
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

	handler, err := api.NewWithCacheConfig(cat, adapters, time.Now, nil, cacheCfg)
	if err != nil {
		return tierResult{}, err
	}

	var next http.Handler = handler
	if singleSharedPool {
		// Wrap handler in a plain HandlerFunc to exercise pre-PR4 single-pool routing.
		next = http.HandlerFunc(handler.ServeHTTP)
	}
	entry, err := api.WithAdmissionConfig(next, broker, "caddy", edgeKey, limits)
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
	loadClient := newLoopbackClient(1024, 20*time.Second)
	bearerValue := ""
	if cfg.bearerEnv != "" {
		bearerValue = strings.TrimSpace(os.Getenv(cfg.bearerEnv))
	}

	type obs struct {
		status int
		latMS  float64
		isSlow bool
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
	var coldCounter uint64 = 100_000
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

		idx := seq
		seq++
		slot := int(idx % 100)
		var workNum uint64
		if rng.Float64() < cfg.hotRatio {
			workNum = zipf.Uint64() + 1
		} else {
			coldCounter++
			workNum = coldCounter
		}
		spec := buildRequestSpec(slot, workNum)
		clientIP := clientIPForIndex(idx, cfg.clients)

		reqWG.Add(1)
		go func(sp requestSpec, ip string) {
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
			if bearerValue != "" {
				req.Header.Set("Authorization", "Bearer "+bearerValue)
			}
			resp, err := loadClient.Do(req)
			status := 0
			if err == nil && resp != nil {
				status = resp.StatusCode
				_, _ = io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}
			lat := float64(time.Since(t0).Microseconds()) / 1000.0
			obsMu.Lock()
			records = append(records, obs{status: status, latMS: lat, isSlow: sp.isSlow})
			obsMu.Unlock()
		}(spec, clientIP)
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
		Profile:          cfg.profile,
		TargetRPS:        targetRPS,
		AchievedRPS:      float64(len(records)) / sendElapsed,
		DurationSec:      elapsed,
		Overall:          summarize(func(obs) bool { return true }),
		Fast:             summarize(func(o obs) bool { return !o.isSlow }),
		Slow:             summarize(func(o obs) bool { return o.isSlow }),
		PeakHeapAllocMiB: float64(atomic.LoadUint64(&peakHeap)) / (1024 * 1024),
		PeakSysMiB:       float64(atomic.LoadUint64(&peakSys)) / (1024 * 1024),
		PeakGoroutines:   int(peakGoroutines.Load()),
		EndGoroutines:    endGoroutines,
		FastUpstreams:    fastUpstreamCalls.Load(),
		SlowUpstreams:    slowUpstreamCalls.Load(),
		ShanghaiHits:     shanghaiHits.Load(),
		ShanghaiMisses:   shanghaiMisses.Load(),
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
	fmt.Fprintf(out, "### Profile: `%s` (duration=%s, fast=%s, slow=%s, shanghai=%s, hot=%.0f%%, clients=%d)\n\n",
		cfg.profile, cfg.duration, cfg.fastLatency, cfg.slowLatency, cfg.shanghaiLatency, cfg.hotRatio*100, cfg.clients)
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
