// dokitool serves the production Go API behind an authenticated loopback edge.
// The frozen PHP tree is a behavior reference, not a runtime dependency.
package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/api"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/bearer"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/media/weibo"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/bilibili"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/douyin"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/instagram"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/kuaishou"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/pinterest"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/pipigx"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/pipixia"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/tiktok"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/toutiao"
	weiboplatform "github.com/Brilliant666/DokiTool-Go/backend/internal/platform/weibo"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/x"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/xiaohongshu"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/youtube"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/zuiyou"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/probe"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

// preparePublicMedia keeps platform-specific transformations at the public boundary.
func preparePublicMedia(key string) api.PublicMedia {
	weibo := weiboplatform.PreparePublicWithOwner(key, api.IsOwnerRequest)
	return func(ctx context.Context, platform string, payload unified.Object, now int64) (unified.Object, error) {
		switch platform {
		case "douyin":
			return douyin.PreparePublic(ctx, platform, payload, now)
		case "bilibili":
			return bilibili.PreparePublic(ctx, platform, payload, now)
		case "xiaohongshu":
			return xiaohongshu.PreparePublic(ctx, platform, payload, now)
		case "kuaishou":
			return kuaishou.PreparePublic(ctx, platform, payload, now)
		case "pipixia":
			return pipixia.PreparePublic(ctx, platform, payload, now)
		case "zuiyou":
			return zuiyou.PreparePublic(ctx, platform, payload, now)
		default:
			return weibo(ctx, platform, payload, now)
		}
	}
}

var version = "development"

func main() {
	if err := run(os.Args[1:]); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run(args []string) error {
	command := "serve"
	if len(args) > 0 && (args[0] == "" || args[0][0] != '-') {
		command, args = args[0], args[1:]
	}
	if command == "version" {
		fmt.Println(version)
		return nil
	}
	if command == "hash-token" {
		return runHashToken(args, os.Stdin, os.Stdout)
	}
	if command == "validate" {
		body, err := io.ReadAll(io.LimitReader(os.Stdin, (8<<20)+1))
		if err != nil {
			return err
		}
		if len(body) > 8<<20 {
			return fmt.Errorf("input exceeds 8 MiB")
		}
		value, err := unified.Decode(body)
		if err != nil {
			return err
		}
		if err := unified.ValidateEnvelope(value); err != nil {
			return err
		}
		return emit(value)
	}
	c, err := catalog.Load()
	if err != nil {
		return err
	}
	if command == "catalog" {
		return emit(c.Envelope())
	}
	if command != "serve" {
		return fmt.Errorf("unknown command %q (serve, catalog, validate, hash-token, version)", command)
	}
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	listen := flags.String("listen", "127.0.0.1:9082", "loopback API listener; use an authenticated edge for public traffic")
	xhsTransport := flags.String("xhs-page-transport", "standard", "XHS HTTPS pages only: standard or chrome131")
	xTombstoneFallback := flags.String("x-tombstone-fallback", x.TombstoneFallbackOff, "X TweetTombstone metadata fallback: off or fxtwitter")
	clientIdentity := flags.String("client-identity", "direct", "client identity for admission: direct or authenticated caddy")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments")
	}
	host, port, err := net.SplitHostPort(*listen)
	number, numberErr := strconv.Atoi(port)
	ip := net.ParseIP(host)
	if err != nil || numberErr != nil || number < 1024 || number > 65535 || ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("listen must use an explicit loopback IP and port 1024–65535")
	}
	xhsExecutor, err := newXHSExecutor(*xhsTransport)
	if err != nil {
		return err
	}
	if err := x.ValidateTombstoneFallback(*xTombstoneFallback); err != nil {
		return err
	}
	cacheCfg, err := api.LoadCacheConfig(os.Getenv)
	if err != nil {
		return err
	}
	executor := fetch.New()
	japan := probe.New(executor, douyin.AllowedMediaURL)
	shanghai, control, err := configureShanghai(executor, os.Getenv)
	if err != nil {
		return err
	}
	bilibiliDASH, err := parseBilibiliDASH(os.Getenv)
	if err != nil {
		return err
	}
	douyinParser, bilibiliParser := newShanghaiParsers(executor, japan, shanghai, bilibiliDASH)
	pipigxSave, err := enableTBVideo("DOKITOOL_TBVIDEO_REWRITE_PIPIGX")
	if err != nil {
		return err
	}
	zuiyouSave, err := enableTBVideo("DOKITOOL_TBVIDEO_REWRITE_ZUIYOU")
	if err != nil {
		return err
	}
	tiktokParser := tiktok.New(executor)
	if rpm, burst, set, rpmErr := parseTikTokDirectRPM(os.Getenv); rpmErr != nil {
		return rpmErr
	} else if set {
		tiktokParser.WithDirectRateLimit(rpm, burst)
	}
	adapters := map[string]api.Adapter{
		"douyin":      douyinParser,
		"bilibili":    bilibiliParser,
		"weibo":       weiboplatform.New(executor),
		"toutiao":     toutiao.New(executor),
		"kuaishou":    kuaishou.New(executor),
		"pipixia":     pipixia.New(executor),
		"pipigx":      pipigx.NewWithTBVideo(executor, pipigxSave),
		"zuiyou":      zuiyou.NewWithTBVideo(executor, zuiyouSave),
		"xiaohongshu": xiaohongshu.New(xhsExecutor),
		"pinterest":   pinterest.New(executor),
		"tiktok":      tiktokParser,
	}
	runtimeCfg, runtimeFromFile, err := api.LoadRuntimeConfig(os.Getenv)
	if err != nil {
		return err
	}
	limits, err := api.LoadAdmissionConfig(os.Getenv)
	if err != nil {
		return err
	}
	if runtimeFromFile {
		api.ApplyRuntimeConfigToAdmissionConfig(&limits, runtimeCfg)
	}
	ytCfg, err := configureYTDLPFullWithRuntime(c, adapters, executor, *xTombstoneFallback, os.Getenv, limits, runtimeCfg, runtimeFromFile)
	if err != nil {
		return err
	}
	defer func() { _ = ytCfg.Close() }()
	handler, err := api.NewWithCacheConfig(c, adapters, time.Now, preparePublicMedia(os.Getenv("SNAP_MEDIA_SIGNING_KEY")), cacheCfg)
	if err != nil {
		return err
	}
	handler.Stats().SetTikTokRiskSource(tiktokParser)
	if ytCfg.genericAdapter != nil {
		handler.SetGenericAdapter(ytCfg.genericAdapter)
	}
	if ytCfg.socialEngine != nil {
		handler.Stats().SetYTDLPEngine(ytCfg.socialEngine)
	} else if ytCfg.engine != nil {
		handler.Stats().SetYTDLPEngine(ytCfg.engine)
	}
	if ytCfg.genericEngine != nil {
		handler.Stats().SetGenericYTDLPEngine(ytCfg.genericEngine)
	}
	if ytCfg.engine != nil {
		handler.Stats().SetYTDLPCompartmentSources(ytCfg.youtubeEngine, ytCfg.socialEngine, ytCfg.genericEngine)
	}
	shanghaiMode := "off"
	shanghaiBilibili := false
	if sp, ok := shanghai.(shresolver.StatsProvider); ok {
		handler.Stats().SetShanghaiSource(sp)
		shanghaiMode = sp.ShanghaiStatsSnapshot().Mode
	}
	if sw, ok := shanghai.(interface{ BilibiliEnabled() bool }); ok {
		shanghaiBilibili = sw.BilibiliEnabled()
	}
	ytHelper, youtubeHelperEnabled, err := configureYouTubeHelperWithState(c, handler, executor, os.Getenv)
	if err != nil {
		return err
	}
	statsSnapshotPath := strings.TrimSpace(os.Getenv(api.EnvStatsSnapshotPath))
	handler.Stats().SetRuntimeConfig(api.RuntimeConfigSnapshot{
		Version:                 version,
		ShanghaiMode:            shanghaiMode,
		ShanghaiBilibili:        shanghaiBilibili,
		BilibiliDASH:            bilibiliDASH,
		YouTubeHelper:           youtubeHelperEnabled,
		XHSTransport:            *xhsTransport,
		YTDLPEnabled:            ytCfg.engine != nil,
		YTDLPGenericEnabled:     handler.GenericEnabled(),
		TBVideoPipigx:           pipigxSave,
		TBVideoZuiyou:           zuiyouSave,
		StatsPersistenceEnabled: statsSnapshotPath != "",
	})
	// The route is present even without a configured key, where it returns the
	// PHP-compatible legacy 503 media envelope without issuing network calls.
	handler.SetWeiboRelay(weibo.NewMediaRelay(os.Getenv("SNAP_MEDIA_SIGNING_KEY")))
	keyRegistry, err := api.LoadAPIKeyRegistry(os.Getenv, limits)
	if err != nil {
		return err
	}
	entry, err := api.WithAdmissionWithRegistry(handler, control, *clientIdentity, os.Getenv("SNAP_INGRESS_KEY"), limits, keyRegistry)
	if err != nil {
		return err
	}
	if runtimeFromFile {
		api.ApplyRuntimeConfig(entry, handler, runtimeCfg, true, false)
	}
	if statsSnapshotPath != "" {
		_ = handler.Stats().LoadSnapshot(statsSnapshotPath, log.Printf)
	}
	server := &http.Server{Addr: *listen, Handler: entry, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 50 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	sighup := make(chan os.Signal, 1)
	signal.Notify(sighup, syscall.SIGHUP)
	defer signal.Stop(sighup)
	stopReloader := startSignalReloader(ctx, sighup, entry, handler, &ytCfg, os.Getenv, limits, log.Printf)
	defer stopReloader()
	stopStatsLog := handler.Stats().StartPeriodicLog(ctx, api.DefaultStatsLogInterval, log.Printf)
	defer stopStatsLog()
	stopStatsSnap := handler.Stats().StartPeriodicSnapshot(ctx, statsSnapshotPath, api.DefaultStatsSnapshotInterval, log.Printf)
	defer stopStatsSnap()
	if ytHelper != nil {
		stopYouTubeRefresh := ytHelper.StartBackgroundRefresh(ctx)
		defer stopYouTubeRefresh()
	}
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	log.Printf("DokiTool Go API %s listening on %s; admission=%+v", version, *listen, limits)
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 310*time.Second)
		defer cancel()
		shutdownErr := server.Shutdown(shutdown)
		stopStatsSnap()
		if statsSnapshotPath != "" {
			if saveErr := handler.Stats().SaveSnapshot(statsSnapshotPath); saveErr != nil {
				log.Printf("dokitool: final stats snapshot save failed: %v", saveErr)
			}
		}
		return shutdownErr
	}
}

func parseShanghaiBilibili(getenv func(string) string) (bool, error) {
	raw := getenv("DOKITOOL_SHANGHAI_BILIBILI")
	if raw == "" {
		return false, nil
	}
	enabled, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("DOKITOOL_SHANGHAI_BILIBILI must be a boolean")
	}
	return enabled, nil
}

func parseBilibiliDASH(getenv func(string) string) (bool, error) {
	raw := getenv("DOKITOOL_BILIBILI_DASH")
	if raw == "" {
		return false, nil
	}
	enabled, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("DOKITOOL_BILIBILI_DASH must be a boolean")
	}
	return enabled, nil
}

func parseTikTokDirectRPM(getenv func(string) string) (rpm float64, burst int, set bool, err error) {
	raw := strings.TrimSpace(getenv("DOKITOOL_TIKTOK_DIRECT_RPM"))
	if raw == "" {
		return 0, 0, false, nil
	}
	v, parseErr := strconv.ParseFloat(raw, 64)
	if parseErr != nil || v < 0 || v > 600 {
		return 0, 0, false, fmt.Errorf("DOKITOOL_TIKTOK_DIRECT_RPM must be a number in 0..600")
	}
	b := int(v)
	if b < 1 {
		b = 1
	}
	if b > 6 {
		b = 6
	}
	return v, b, true, nil
}

func newShanghaiParsers(executor fetch.Executor, japan *probe.Probe, shanghai douyin.OriginalResolver, bilibiliDASH bool) (*douyin.Parser, *bilibili.Parser) {
	douyinParser := douyin.New(executor, japan)
	bilibiliParser := bilibili.New(executor)
	if shanghai != nil {
		douyinParser = douyin.NewWithOriginalResolver(executor, japan.WithFingerprint(), shanghai)
		if biliShanghai, ok := shanghai.(bilibili.ShanghaiResolver); ok {
			if sw, hasSwitch := shanghai.(interface{ BilibiliEnabled() bool }); !hasSwitch || sw.BilibiliEnabled() {
				bilibiliParser = bilibili.NewWithShanghai(executor, biliShanghai)
			}
		}
	}
	return douyinParser, bilibiliParser.WithDASH(bilibiliDASH)
}

// An existing #27 endpoint remains opt-in for direct mode. Pull never invokes that endpoint.
// Bilibili resolution via Shanghai defaults to disabled unless DOKITOOL_SHANGHAI_BILIBILI is true.
func configureShanghai(executor fetch.Executor, getenv func(string) string) (douyin.OriginalResolver, http.Handler, error) {
	bilibiliEnabled, err := parseShanghaiBilibili(getenv)
	if err != nil {
		return nil, nil, err
	}
	mode, endpoint := getenv("DOKITOOL_SHANGHAI_MODE"), getenv("DOKITOOL_SHANGHAI_ENDPOINT")
	switch mode {
	case "off":
		return nil, nil, nil
	case "", "direct":
		if mode == "" && endpoint == "" {
			return nil, nil, nil
		}
		token := getenv("DOKITOOL_SHANGHAI_TOKEN")
		if mode == "direct" && token != "" {
			for _, key := range []string{"SNAP_INGRESS_KEY", "SNAP_MEDIA_SIGNING_KEY", "DOKITOOL_SHANGHAI_PULL_TOKEN", "DOKITOOL_OWNER_TOKEN"} {
				if subtle.ConstantTimeCompare([]byte(token), []byte(getenv(key))) == 1 {
					return nil, nil, errors.New("direct mode requires a dedicated Shanghai token")
				}
			}
		}
		client, err := shresolver.NewClient(endpoint, token, executor)
		if err != nil {
			if mode == "" {
				// Retain the legacy fail-soft behavior for pre-mode deployments.
				log.Print("Shanghai original resolver disabled: invalid configuration")
				return nil, nil, nil
			}
			return nil, nil, err
		}
		client.WithBilibili(bilibiliEnabled)
		return client, nil, nil
	case "pull":
		if endpoint != "" {
			return nil, nil, errors.New("remove DOKITOOL_SHANGHAI_ENDPOINT before enabling pull mode")
		}
		token := getenv("DOKITOOL_SHANGHAI_PULL_TOKEN")
		for _, key := range []string{"SNAP_INGRESS_KEY", "SNAP_MEDIA_SIGNING_KEY", "DOKITOOL_SHANGHAI_TOKEN", "DOKITOOL_OWNER_TOKEN"} {
			if token != "" && subtle.ConstantTimeCompare([]byte(token), []byte(getenv(key))) == 1 {
				return nil, nil, errors.New("pull mode requires a dedicated control credential")
			}
		}
		broker, err := shresolver.NewPullBroker(token)
		if err != nil {
			return nil, nil, err
		}
		broker.WithBilibili(bilibiliEnabled)
		return broker, broker, nil
	default:
		return nil, nil, errors.New("DOKITOOL_SHANGHAI_MODE must be off, direct or pull")
	}
}

func runHashToken(args []string, stdin io.Reader, stdout io.Writer) error {
	if len(args) > 0 {
		return errors.New("hash-token reads from stdin; do not pass token in arguments")
	}
	if stdin == nil || stdout == nil {
		return errors.New("missing hash-token streams")
	}
	rawBytes, err := io.ReadAll(io.LimitReader(stdin, bearer.MaxTokenBytes+3))
	if err != nil {
		return errors.New("failed to read token from stdin")
	}
	raw := string(rawBytes)
	if strings.HasSuffix(raw, "\r\n") {
		raw = raw[:len(raw)-2]
	} else if strings.HasSuffix(raw, "\n") {
		raw = raw[:len(raw)-1]
	}
	if err := bearer.ValidateToken(raw); err != nil {
		return err
	}
	sum := bearer.Digest(raw)
	_, err = fmt.Fprintf(stdout, "%x\n", sum)
	return err
}

func reloadAPIKeysOnce(entry http.Handler, getenv func(string) string, limits api.AdmissionConfig, logf func(string, ...any)) bool {
	next, err := api.LoadAPIKeyRegistry(getenv, limits)
	if err != nil {
		if logf != nil {
			logf("dokitool: api keys reload rejected (keeping previous configuration): %v", err)
		}
		return false
	}
	if !api.ReloadAPIKeys(entry, next) {
		return false
	}
	if logf != nil {
		logf("dokitool: api keys reloaded (keys=%d)", next.Len())
	}
	return true
}

func reloadRuntimeConfigOnce(
	entry http.Handler,
	handler *api.Handler,
	ytCfg *ytdlpConfigResult,
	getenv func(string) string,
	logf func(string, ...any),
) bool {
	if getenv == nil || strings.TrimSpace(getenv(api.EnvRuntimeConfigFile)) == "" {
		return false
	}
	next, fromFile, err := api.LoadRuntimeConfig(getenv)
	if err != nil {
		if logf != nil {
			logf("dokitool: runtime config reload rejected (keeping previous configuration): %v", err)
		}
		return false
	}
	var hook api.RuntimeConfigCommitHook
	if ytCfg != nil {
		hook = func(cfg api.RuntimeConfig) error {
			return ytCfg.SetCompartmentLimits(cfg.YTDLP.YouTubeSlots, cfg.YTDLP.SocialSlots, cfg.YTDLP.GenericSlots)
		}
	}
	if err := api.ApplyRuntimeConfigWithHook(entry, handler, next, fromFile, true, hook); err != nil {
		if logf != nil {
			if errors.Is(err, errCompartmentRollbackFailed) {
				logf("dokitool: CRITICAL runtime config reload rollback failed; compartment limits may be partially mutated — re-apply valid runtime config or restart process: %v", err)
			} else {
				logf("dokitool: runtime config reload rejected (previous configuration preserved): %v", err)
			}
		}
		return false
	}
	if logf != nil {
		var gen uint64
		if handler != nil {
			gen = handler.RuntimeConfigGeneration()
		}
		logf("dokitool: runtime config reloaded (gen=%d yt=%d social=%d generic=%d ejs=%d fast_per_platform=%d cb_enabled=%t disabled=%d)",
			gen,
			next.YTDLP.YouTubeSlots,
			next.YTDLP.SocialSlots,
			next.YTDLP.GenericSlots,
			next.YTDLP.YouTubeEJSConcurrency,
			next.FastPool.PerPlatformMaxConcurrency,
			next.CircuitBreaker.Enabled,
			len(next.CircuitBreaker.DisabledPlatforms),
		)
	}
	return true
}

func startAPIKeySignalReloader(
	ctx context.Context,
	sigCh <-chan os.Signal,
	entry http.Handler,
	getenv func(string) string,
	limits api.AdmissionConfig,
	logf func(string, ...any),
) func() {
	return startSignalReloader(ctx, sigCh, entry, nil, nil, getenv, limits, logf)
}

func startSignalReloader(
	ctx context.Context,
	sigCh <-chan os.Signal,
	entry http.Handler,
	handler *api.Handler,
	ytCfg *ytdlpConfigResult,
	getenv func(string) string,
	limits api.AdmissionConfig,
	logf func(string, ...any),
) func() {
	stopCh := make(chan struct{})
	doneCh := make(chan struct{})
	go func() {
		defer close(doneCh)
		for {
			select {
			case <-ctx.Done():
				return
			case <-stopCh:
				return
			case _, ok := <-sigCh:
				if !ok {
					return
				}
				reloadAPIKeysOnce(entry, getenv, limits, logf)
				reloadRuntimeConfigOnce(entry, handler, ytCfg, getenv, logf)
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stopCh)
			<-doneCh
		})
	}
}

func newXHSExecutor(mode string) (fetch.Executor, error) {
	switch mode {
	case "standard":
		return fetch.New(), nil
	case "chrome131":
		return fetch.NewXiaohongshuPages(), nil
	default:
		return nil, fmt.Errorf("xhs-page-transport must be standard or chrome131")
	}
}

func emit(value any) error {
	encoded, err := unified.Encode(value)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(os.Stdout, string(encoded))
	return err
}

// The two deployment switches apply independently when the API process starts.
func enableTBVideo(key string) (bool, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return true, nil
	}
	enabled, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return enabled, nil
}

// configureYTDLPX optionally registers the X / Twitter, YouTube, Instagram, and
// DOKITOOL_YTDLP_SITES platforms when their respective switches are enabled
// and the shared yt-dlp binary preflight succeeds.
// Production defaults all switches to off.
func configureYTDLPX(c *catalog.Catalog, adapters map[string]api.Adapter, executor fetch.Executor, getenv func(string) string) error {
	return configureYTDLPWithOptions(c, adapters, executor, x.TombstoneFallbackOff, getenv)
}

func configureYTDLPWithOptions(c *catalog.Catalog, adapters map[string]api.Adapter, executor fetch.Executor, xTombstoneFallback string, getenv func(string) string) error {
	_, err := configureYTDLPWithEngine(c, adapters, executor, xTombstoneFallback, getenv)
	return err
}

type ytdlpConfigResult struct {
	engine           *ytengine.Engine
	youtubeEngine    *ytengine.Engine
	socialEngine     *ytengine.Engine
	genericEngine    *ytengine.Engine
	genericAdapter   api.Adapter
	testBuildTargets func(ytSlots, socialSlots, genericSlots int) []compartmentLimitTarget
}

func (r *ytdlpConfigResult) Close() error {
	if r == nil || r.engine == nil {
		return nil
	}
	return r.engine.Close()
}

var errCompartmentRollbackFailed = errors.New("compartment rollback failed")

type compartmentLimiter interface {
	ConcurrencyLimit() int
	SetConcurrencyLimit(int) error
}

type compartmentLimitTarget struct {
	name    string
	limiter compartmentLimiter
	prev    int
	next    int
}

// applyCompartmentLimitTargets updates each ytengine compartment limit in-place
// sequentially under the caller's serialized reload lock. If any compartment fails,
// previously mutated compartments are rolled back in reverse order on a best-effort
// basis; any rollback failure is wrapped with errCompartmentRollbackFailed and joined
// into the returned error so callers can emit a CRITICAL operator alert.
func applyCompartmentLimitTargets(targets []compartmentLimitTarget) error {
	for i, t := range targets {
		if t.limiter == nil {
			continue
		}
		if err := t.limiter.SetConcurrencyLimit(t.next); err != nil {
			errs := []error{fmt.Errorf("compartment %s resize failed: %w", t.name, err)}
			for j := i - 1; j >= 0; j-- {
				if targets[j].limiter == nil || targets[j].prev < 1 {
					continue
				}
				if rbErr := targets[j].limiter.SetConcurrencyLimit(targets[j].prev); rbErr != nil {
					errs = append(errs, fmt.Errorf("%w (%s): %w", errCompartmentRollbackFailed, targets[j].name, rbErr))
				}
			}
			return errors.Join(errs...)
		}
	}
	return nil
}

func (r *ytdlpConfigResult) SetCompartmentLimits(ytSlots, socialSlots, genericSlots int) error {
	if r == nil {
		return nil
	}
	if r.testBuildTargets != nil {
		return applyCompartmentLimitTargets(r.testBuildTargets(ytSlots, socialSlots, genericSlots))
	}
	var targets []compartmentLimitTarget
	if r.youtubeEngine != nil {
		targets = append(targets, compartmentLimitTarget{name: "youtube", limiter: r.youtubeEngine, prev: r.youtubeEngine.ConcurrencyLimit(), next: ytSlots})
	}
	if r.socialEngine != nil {
		targets = append(targets, compartmentLimitTarget{name: "social", limiter: r.socialEngine, prev: r.socialEngine.ConcurrencyLimit(), next: socialSlots})
	}
	if r.genericEngine != nil {
		targets = append(targets, compartmentLimitTarget{name: "generic", limiter: r.genericEngine, prev: r.genericEngine.ConcurrencyLimit(), next: genericSlots})
	}
	return applyCompartmentLimitTargets(targets)
}

func parseYTDLPGenericConcurrency(getenv func(string) string) (int, error) {
	raw := strings.TrimSpace(getenv("DOKITOOL_YTDLP_GENERIC_CONCURRENCY"))
	if raw == "" {
		return ytgeneric.DefaultGenericConcurrency, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > ytengine.MaxConcurrency {
		return 0, fmt.Errorf("DOKITOOL_YTDLP_GENERIC_CONCURRENCY must be an integer between 1 and %d", ytengine.MaxConcurrency)
	}
	return value, nil
}

func configureYTDLPWithEngine(c *catalog.Catalog, adapters map[string]api.Adapter, executor fetch.Executor, xTombstoneFallback string, getenv func(string) string) (*ytengine.Engine, error) {
	res, err := configureYTDLPFull(c, adapters, executor, xTombstoneFallback, getenv)
	if err != nil {
		return nil, err
	}
	return res.engine, nil
}

func configureYTDLPFull(c *catalog.Catalog, adapters map[string]api.Adapter, executor fetch.Executor, xTombstoneFallback string, getenv func(string) string) (ytdlpConfigResult, error) {
	limits, err := api.LoadAdmissionConfig(getenv)
	if err != nil {
		return ytdlpConfigResult{}, err
	}
	return configureYTDLPFullWithRuntime(c, adapters, executor, xTombstoneFallback, getenv, limits, api.DefaultRuntimeConfig(), false)
}

func configureYTDLPFullWithRuntime(
	c *catalog.Catalog,
	adapters map[string]api.Adapter,
	executor fetch.Executor,
	xTombstoneFallback string,
	getenv func(string) string,
	limits api.AdmissionConfig,
	runtimeCfg api.RuntimeConfig,
	runtimeFromFile bool,
) (ytdlpConfigResult, error) {
	if err := x.ValidateTombstoneFallback(xTombstoneFallback); err != nil {
		return ytdlpConfigResult{}, err
	}
	parseSwitch := func(key string) (bool, error) {
		raw := getenv(key)
		if raw == "" {
			return false, nil
		}
		enabled, err := strconv.ParseBool(raw)
		if err != nil {
			return false, fmt.Errorf("%s must be a boolean", key)
		}
		return enabled, nil
	}

	xEnabled, err := parseSwitch("DOKITOOL_YTDLP_X_ENABLED")
	if err != nil {
		return ytdlpConfigResult{}, err
	}
	ytEnabled, err := parseSwitch("DOKITOOL_YTDLP_YOUTUBE_ENABLED")
	if err != nil {
		return ytdlpConfigResult{}, err
	}
	igEnabled, err := parseSwitch("DOKITOOL_YTDLP_INSTAGRAM_ENABLED")
	if err != nil {
		return ytdlpConfigResult{}, err
	}
	genericEnabled, err := parseSwitch("DOKITOOL_YTDLP_GENERIC_ENABLED")
	if err != nil {
		return ytdlpConfigResult{}, err
	}
	genericConc, err := parseYTDLPGenericConcurrency(getenv)
	if err != nil {
		return ytdlpConfigResult{}, err
	}
	genericSites, err := ytgeneric.ParseSitesEnv(getenv("DOKITOOL_YTDLP_SITES"))
	if err != nil {
		return ytdlpConfigResult{}, err
	}
	if !xEnabled && !ytEnabled && !igEnabled && len(genericSites) == 0 && !genericEnabled {
		return ytdlpConfigResult{}, nil
	}

	baseEngine, err := ytengine.NewFromEnv(getenv, nil)
	if err != nil || !baseEngine.Enabled() {
		log.Printf("dokitool: yt-dlp engine preflight failed (platforms not registered in catalog): %v", err)
		return ytdlpConfigResult{}, nil
	}
	log.Printf("dokitool: yt-dlp shared engine verified (version=%s, asset=%s, sha256=%s, zipapp=%t)",
		ytengine.PinnedVersion, baseEngine.BinaryAsset(), baseEngine.BinarySHA256(), baseEngine.UsingPythonZipapp())

	youtubeSlots := ytengine.DefaultYouTubeSlots
	socialSlots := ytengine.DefaultSocialSlots
	if runtimeFromFile {
		youtubeSlots = runtimeCfg.YTDLP.YouTubeSlots
		socialSlots = runtimeCfg.YTDLP.SocialSlots
		genericConc = runtimeCfg.YTDLP.GenericSlots
	} else {
		if limits.YouTubeSlowParse.GlobalConcurrency >= 1 {
			youtubeSlots = limits.YouTubeSlowParse.GlobalConcurrency
		}
		if limits.SlowParse.GlobalConcurrency >= 1 {
			socialSlots = limits.SlowParse.GlobalConcurrency
		}
		if limits.GenericSlowParse.GlobalConcurrency >= 1 {
			genericConc = limits.GenericSlowParse.GlobalConcurrency
		}
	}

	var socialEngine *ytengine.Engine
	if xEnabled || igEnabled || len(genericSites) > 0 {
		socialEngine = baseEngine.WithCompartment(socialSlots)
	}
	var youtubeEngine *ytengine.Engine
	if ytEnabled {
		youtubeEngine = baseEngine.WithCompartment(youtubeSlots)
	}

	if xEnabled {
		if err := c.Register(catalog.XPlatform()); err != nil {
			return ytdlpConfigResult{}, err
		}
		xEngine := newXEngine(socialEngine)
		xParser, err := x.NewWithSizeProber(xEngine, x.NewSizeProber(executor)).
			WithFetcher(executor).
			WithTombstoneFallback(xTombstoneFallback)
		if err != nil {
			return ytdlpConfigResult{}, err
		}
		adapters["x"] = xParser
	}
	if ytEnabled {
		if err := c.Register(catalog.YouTubePlatform()); err != nil {
			return ytdlpConfigResult{}, err
		}
		ytEngine := youtubeEngine.WithTargetPolicy(youtube.AllowedTargetURL, youtube.AllowedOutboundHost)
		adapters["youtube"] = youtube.NewWithSizeProber(ytEngine, ytengine.NewSizeProber(executor, youtube.AllowedMediaURL))
	}
	if igEnabled {
		if err := c.Register(catalog.InstagramPlatform()); err != nil {
			return ytdlpConfigResult{}, err
		}
		igEngine := socialEngine.WithTargetPolicy(instagram.AllowedTargetURL, instagram.AllowedOutboundHost)
		adapters["instagram"] = instagram.NewWithSizeProber(igEngine, ytengine.NewSizeProber(executor, instagram.AllowedMediaURL)).WithFetcher(executor)
	}
	for _, spec := range genericSites {
		if err := c.Register(spec.CatalogEntry()); err != nil {
			return ytdlpConfigResult{}, err
		}
		policyParser := ytgeneric.New(spec, nil, nil)
		siteEngine := socialEngine.
			WithTargetPolicy(policyParser.AllowedTargetURL, policyParser.AllowedOutboundHost).
			WithExtractors(spec.Extractors...)
		var prober ytengine.SizeProber
		if !spec.SingleStreamHLSOnly {
			prober = ytengine.NewSizeProber(executor, policyParser.MatchMediaURL)
		}
		adapters[spec.PlatformID] = ytgeneric.NewWithResolver(spec, siteEngine, prober, net.DefaultResolver)
	}

	res := ytdlpConfigResult{
		engine:        baseEngine,
		youtubeEngine: youtubeEngine,
		socialEngine:  socialEngine,
	}
	if genericEnabled {
		genericEngine := baseEngine.
			WithGenericConcurrency(genericConc).
			WithTargetPolicy(ytgeneric.AllowedGenericInputURL, ytgeneric.AllowedGenericOutboundHost).
			WithExtractors(ytgeneric.GenericExtractorArgs()...)
		res.genericEngine = genericEngine
		res.genericAdapter = ytgeneric.NewGenericNamed(
			genericEngine,
			ytengine.NewSizeProber(executor, ytgeneric.AllowedGenericMediaURL),
			net.DefaultResolver,
		)
		log.Printf("dokitool: yt-dlp generic named-extractor fallback enabled (concurrency=%d)", genericConc)
	}
	return res, nil
}

func newXEngine(baseEngine *ytengine.Engine) *ytengine.Engine {
	return baseEngine.
		WithTargetPolicy(x.AllowedTargetURL, x.AllowedOutboundHost).
		WithExtractors(x.AllowedExtractors()...)
}

// configureYouTubeHelper optionally enables /api/youtube/context and
// /api/youtube/finalize when DOKITOOL_YOUTUBE_HELPER is true and the pinned
// Deno + yt-dlp/ejs runtime assets pass SHA-256 verification.
// Verification failure disables only the YouTube helper without affecting other platforms.
func configureYouTubeHelper(c *catalog.Catalog, handler *api.Handler, executor fetch.Executor, getenv func(string) string) error {
	_, _, err := configureYouTubeHelperWithState(c, handler, executor, getenv)
	return err
}

func configureYouTubeHelperWithState(c *catalog.Catalog, handler *api.Handler, executor fetch.Executor, getenv func(string) string) (*youtube.Helper, bool, error) {
	raw := getenv("DOKITOOL_YOUTUBE_HELPER")
	if raw == "" {
		return nil, false, nil
	}
	enabled, err := strconv.ParseBool(raw)
	if err != nil {
		return nil, false, fmt.Errorf("DOKITOOL_YOUTUBE_HELPER must be a boolean")
	}
	if !enabled {
		return nil, false, nil
	}
	helper, err := youtube.NewHelperFromEnv(executor, getenv, time.Now)
	if err != nil {
		log.Printf("dokitool: youtube helper runtime preflight failed (youtube helper disabled): %v", err)
		return nil, false, nil
	}
	if c != nil && !c.Has("youtube") {
		if err := c.Register(catalog.YouTubePlatform()); err != nil {
			return nil, false, err
		}
	}
	sb := helper.Sandbox()
	log.Printf("dokitool: youtube helper runtime verified (deno_version=%s, deno_asset=%s, deno_sha256=%s, ejs_version=%s, lib_sha256=%s, core_sha256=%s)",
		youtube.PinnedDenoVersion, sb.DenoAsset(), sb.DenoSHA256(), youtube.PinnedEJSVersion, sb.LibSHA256(), sb.CoreSHA256())
	handler.SetYouTubeHelper(helper)
	return helper, true, nil
}
