// Package api preserves the public unified-v1 HTTP boundary.
// Adapters execute in process; no PHP loopback or compatibility response is used.
package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type Adapter interface {
	Parse(context.Context, string, int64) (unified.Object, error)
}
type AdapterFunc func(context.Context, string, int64) (unified.Object, error)

func (f AdapterFunc) Parse(ctx context.Context, source string, now int64) (unified.Object, error) {
	return f(ctx, source, now)
}

type attributedAdapter interface {
	ParseWithPlatform(context.Context, string, int64) (unified.Object, string, error)
}

// PublicMedia applies provider-specific source eligibility/signing before public
// filtering. A future Weibo registration must provide this boundary as well.
type PublicMedia func(context.Context, string, unified.Object, int64) (unified.Object, error)

// YouTubeHelper serves /api/youtube/context and /api/youtube/finalize when
// DOKITOOL_YOUTUBE_HELPER is enabled and runtime verification succeeds.
type YouTubeHelper interface {
	Context(context.Context) (unified.Object, int)
	Finalize(ctx context.Context, body []byte, debug bool) (unified.Object, int)
}

type Handler struct {
	catalog             *catalog.Catalog
	adapters            map[string]Adapter
	genericAdapter      Adapter
	now                 func() time.Time
	publicMedia         PublicMedia
	weiboRelay          http.Handler
	youtubeHelper       YouTubeHelper
	finalizeReadTimeout time.Duration
	cache               *parseCache
	stats               *Stats
	panicLogf           func(string, ...any)
}

func New(c *catalog.Catalog, adapters map[string]Adapter, now func() time.Time, media PublicMedia) (*Handler, error) {
	return NewWithCacheConfig(c, adapters, now, media, DefaultCacheConfig())
}

func NewWithCacheConfig(c *catalog.Catalog, adapters map[string]Adapter, now func() time.Time, media PublicMedia, cacheCfg CacheConfig) (*Handler, error) {
	if c == nil {
		return nil, fmt.Errorf("missing catalog")
	}
	cache, err := newParseCache(cacheCfg)
	if err != nil {
		return nil, err
	}
	registered := make(map[string]Adapter, len(adapters))
	for id, adapter := range adapters {
		if !c.Has(id) || adapter == nil {
			return nil, fmt.Errorf("invalid adapter registration %q", id)
		}
		if id == "weibo" && media == nil {
			return nil, fmt.Errorf("weibo requires signed-media preparation")
		}
		registered[id] = adapter
	}
	if now == nil {
		now = time.Now
	}
	stats := NewStats(nil)
	stats.setCacheSource(cache)
	return &Handler{
		catalog:             c,
		adapters:            registered,
		now:                 now,
		publicMedia:         media,
		finalizeReadTimeout: defaultYouTubeFinalizeReadTimeout,
		cache:               cache,
		stats:               stats,
		panicLogf:           log.Printf,
	}, nil
}

// Stats returns the handler's bounded-cardinality in-process telemetry collector.
func (h *Handler) Stats() *Stats {
	if h == nil {
		return nil
	}
	return h.stats
}

// SetWeiboRelay registers a binary-only handler before server startup.
// Its response is never passed through the unified JSON encoder.
func (h *Handler) SetWeiboRelay(relay http.Handler) { h.weiboRelay = relay }

// SetYouTubeHelper registers the browser-assisted YouTube context/finalize handler.
// When unset, /api/youtube/context and /api/youtube/finalize return 404.
func (h *Handler) SetYouTubeHelper(helper YouTubeHelper) { h.youtubeHelper = helper }

// SetGenericAdapter registers the optional Tier-2 named-extractor yt-dlp fallback
// adapter before server startup. When unset, non-catalog URLs return UNSUPPORTED_PLATFORM.
func (h *Handler) SetGenericAdapter(adapter Adapter) {
	if h == nil {
		return
	}
	h.genericAdapter = adapter
}

// GenericEnabled reports whether the optional Tier-2 generic named-extractor fallback is active.
func (h *Handler) GenericEnabled() bool {
	return h != nil && h.genericAdapter != nil
}

func (h *Handler) adapterForPlatform(platform string) Adapter {
	if h == nil {
		return nil
	}
	if platform == PlatformGeneric {
		return h.genericAdapter
	}
	return h.adapters[platform]
}

func (h *Handler) recordParseTelemetry(routePlatform, dynamicPlatform, code, channel string, elapsed time.Duration) {
	if routePlatform == PlatformGeneric {
		if dynamicPlatform != "" && IsValidDynamicPlatformKey(dynamicPlatform) {
			h.stats.RecordDynamicParse(dynamicPlatform, code, channel, elapsed)
		} else {
			h.stats.RecordParse(PlatformUnknown, code, channel, elapsed)
		}
		return
	}
	h.stats.RecordParse(routePlatform, code, channel, elapsed)
}

// HasCachedYouTubeContext reports whether the configured YouTube helper currently
// holds a fresh in-memory player context that can be served without upstream/Deno work.
func (h *Handler) HasCachedYouTubeContext() bool {
	if h == nil || h.youtubeHelper == nil {
		return false
	}
	if checker, ok := h.youtubeHelper.(interface{ HasCachedContext() bool }); ok {
		return checker.HasCachedContext()
	}
	return false
}

func (h *Handler) deriveCacheableParseKey(path, rawQuery string) (cacheKey, string, bool) {
	if h == nil || h.catalog == nil || h.cache == nil || h.cache.cfg.Disabled {
		return cacheKey{}, "", false
	}
	if path != "/api/parse" && path != "/api/resolve" {
		return cacheKey{}, "", false
	}
	if version, ok := queryValue(rawQuery, "schema_version"); !ok || version != unified.SchemaVersion {
		return cacheKey{}, "", false
	}
	input, scalar := queryValue(rawQuery, "url")
	source := InputURL(input)
	if !scalar || source == "" || !h.catalog.ValidInputURL(source) {
		return cacheKey{}, "", false
	}
	requested, requestedScalar := queryValue(rawQuery, "platform")
	if !queryPresent(rawQuery, "platform") {
		requested, requestedScalar = "all", true
	}
	if !requestedScalar {
		return cacheKey{}, "", false
	}
	platform := h.catalog.PlatformForURL(source)
	if platform == "" {
		if h.genericAdapter == nil || path != "/api/parse" || requested != "all" || !ytgeneric.AllowedGenericInputURL(source) {
			return cacheKey{}, "", false
		}
		platform = PlatformGeneric
	} else {
		if h.adapters[platform] == nil {
			return cacheKey{}, "", false
		}
		if requested != "all" && (requested != platform || !h.catalog.Has(requested)) {
			return cacheKey{}, "", false
		}
	}
	if !cacheableRequest(platform, source) {
		return cacheKey{}, "", false
	}
	itemID := ""
	if path == "/api/resolve" {
		id, ok := queryValue(rawQuery, "item_id")
		if !ok || id == "" || len(id) > 256 {
			return cacheKey{}, "", false
		}
		itemID = id
	}
	debug, _ := queryValue(rawQuery, "debug")
	return cacheKey{
		route:    path,
		platform: platform,
		url:      normalizeCacheURL(platform, source),
		itemID:   itemID,
		debug:    debug == "1",
	}, platform, true
}

// HasFreshCachedParse reports whether a GET /api/parse or /api/resolve request
// would be answered from a fresh cache entry. Admission then charges the cheap
// catalog budget instead of a parse token, so revisiting or re-downloading an
// already parsed link does not hit the per-IP parse limit. It mirrors all
// pre-cache validation guards and cache key derivation in ServeHTTP so invalid
// requests never masquerade as cache hits, and it never mutates the cache.
func (h *Handler) HasFreshCachedParse(path, rawQuery string) bool {
	ck, _, ok := h.deriveCacheableParseKey(path, rawQuery)
	return ok && h.cache.fresh(ck, h.now())
}

// tryServeFreshCachedParse serves an authenticated GET /api/parse or /api/resolve
// directly from parseCache under RLock without acquiring a keyPool concurrency slot.
// If the entry expired at the exact nanosecond boundary, it returns false without
// writing to w so admission falls through into keyPool slot acquisition.
func (h *Handler) tryServeFreshCachedParse(w http.ResponseWriter, r *http.Request, key *apiKeyEntry, wallStart time.Time) bool {
	if r.Method != http.MethodGet {
		return false
	}
	ck, platform, ok := h.deriveCacheableParseKey(r.URL.EscapedPath(), r.URL.RawQuery)
	if !ok {
		return false
	}
	if key != nil && !key.AllowsPlatform(platform) {
		key.recordUnauthorized()
		h.recordParseTelemetry(platform, "", OutcomeUnauthorized, ChannelOwner, time.Since(wallStart))
		rejectUnauthorizedWithMessage(w, r, parser, "当前凭据无权访问该平台")
		return true
	}
	res, fresh := h.cache.getFresh(ck, h.now())
	if !fresh {
		return false
	}
	h.stats.recordCacheHit(ChannelOwner)
	h.recordParseTelemetry(platform, res.platform, res.code, ChannelOwner, time.Since(wallStart))
	if key != nil {
		key.recordCachedParseStatus(res.status)
	}
	writeResponse(w, res)
	return true
}

// ClassifyParseRoute classifies a parse/resolve request into Tier-1 catalog
// platform or Tier-2 generic named-extractor fallback.
func (h *Handler) ClassifyParseRoute(path, rawQuery string) (platform string, isGeneric bool) {
	if h == nil || h.catalog == nil {
		return "", false
	}
	input, scalar := queryValue(rawQuery, "url")
	if !scalar || input == "" {
		return "", false
	}
	source := InputURL(input)
	if source == "" {
		return "", false
	}
	if p := h.catalog.PlatformForURL(source); p != "" {
		return p, false
	}
	requested, requestedScalar := queryValue(rawQuery, "platform")
	if !queryPresent(rawQuery, "platform") {
		requested, requestedScalar = "all", true
	}
	if h.genericAdapter != nil && path == "/api/parse" && requestedScalar && requested == "all" && h.catalog.ValidInputURL(source) && ytgeneric.AllowedGenericInputURL(source) {
		return PlatformGeneric, true
	}
	return "", false
}

// ParsePlatform reports the registered catalog platform matched by a scalar url
// query parameter, or "" when the URL is missing, malformed, or unsupported.
func (h *Handler) ParsePlatform(rawQuery string) string {
	if h == nil || h.catalog == nil {
		return ""
	}
	input, scalar := queryValue(rawQuery, "url")
	if !scalar || input == "" {
		return ""
	}
	return h.catalog.PlatformForURL(InputURL(input))
}

var shareURL = regexp.MustCompile(`(?i)https?://[^\s"'<>\p{Han}\x{2014}\x{2018}-\x{201D}\x{2026}\x{203B}\x{3000}-\x{303F}\x{FE10}-\x{FE1F}\x{FE30}-\x{FE6F}\x{FF00}-\x{FFEF}]+`)

func InputURL(input string) string {
	if len(input) > 8192 {
		return ""
	}
	return strings.TrimRight(shareURL.FindString(strings.TrimSpace(input)), "'\"，。；,.;!?！？）)")
}

// PHP query variables use the last assignment and reject arrays where scalars
// are required. Keep that behavior for url[]=, repeated keys and debug=1.
func queryValue(raw, name string) (string, bool) {
	value, scalar := "", false
	for _, pair := range strings.Split(raw, "&") {
		parts := strings.SplitN(pair, "=", 2)
		key := formDecode(parts[0])
		if key == name {
			value, scalar = "", true
			if len(parts) == 2 {
				value = formDecode(parts[1])
			}
		} else if strings.HasPrefix(key, name+"[") {
			value, scalar = "", false
		}
	}
	return value, scalar
}

func formDecode(value string) string {
	if decoded, err := url.QueryUnescape(value); err == nil {
		return decoded
	}
	// urldecode keeps malformed percent sequences but still decodes valid ones.
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '+' {
			out.WriteByte(' ')
			continue
		}
		if value[i] == '%' && i+2 < len(value) {
			if decoded, err := url.QueryUnescape(value[i : i+3]); err == nil {
				out.WriteString(decoded)
				i += 2
				continue
			}
		}
		out.WriteByte(value[i])
	}
	return out.String()
}

func Status(payload unified.Object) int {
	switch unified.Str(payload["code"]) {
	case "OK":
		return 200
	case "INVALID_INPUT", "UNSUPPORTED_PLATFORM":
		return 400
	case "NO_MEDIA", "CONTENT_UNAVAILABLE":
		return 404
	case "UPSTREAM_BLOCKED":
		return 403
	case "RATE_LIMITED":
		return 429
	case "UPSTREAM_TIMEOUT":
		return 504
	case "SERVICE_NOT_CONFIGURED":
		return 503
	case "INTERNAL_ERROR":
		return 500
	default:
		return 502
	}
}

var internalEncodeErrorBody = []byte(`{"schema_version":"1.0","code":"INTERNAL_ERROR","error":{"code":"INTERNAL_ERROR","message":"响应编码失败"}}`)

func encodeResponse(status int, payload unified.Object) (cachedResponse, bool) {
	body, err := unified.Encode(payload)
	if err != nil {
		return cachedResponse{status: 500, code: "INTERNAL_ERROR", body: internalEncodeErrorBody}, false
	}
	code := NormalizeOutcomeCode(unified.Str(payload["code"]))
	retryAfter := ""
	if unified.Str(payload["code"]) != "OK" {
		if seconds, ok := unified.Numeric(unified.Map(payload["error"])["retry_after_seconds"]); ok && seconds >= 1 {
			retryAfter = strconv.FormatInt(int64(seconds), 10)
		}
	}
	return cachedResponse{status: status, code: code, body: body, retryAfter: retryAfter}, true
}

func writeResponse(w http.ResponseWriter, res cachedResponse) {
	if res.retryAfter != "" && w.Header().Get("Retry-After") == "" {
		w.Header().Set("Retry-After", res.retryAfter)
	}
	w.Header().Del("Access-Control-Allow-Origin")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(res.status)
	_, _ = w.Write(res.body)
}

func send(w http.ResponseWriter, status int, payload unified.Object) {
	res, _ := encodeResponse(status, payload)
	writeResponse(w, res)
}

func contractErrorForStatus(status int, message string) unified.Object {
	code := "UPSTREAM_INVALID_RESPONSE"
	switch status {
	case 400, 401, 404, 405, 409, 410:
		code = "INVALID_INPUT"
	case 403:
		code = "UPSTREAM_BLOCKED"
	case 429:
		code = "RATE_LIMITED"
	case 500:
		code = "INTERNAL_ERROR"
	case 503:
		code = "SERVICE_NOT_CONFIGURED"
	case 504:
		code = "UPSTREAM_TIMEOUT"
	}
	out := unified.ContractError(code, message, status == 429 || status == 502 || status == 504)
	if status == http.StatusUnauthorized {
		unified.Map(out["error"])["retryable"] = false
	}
	return out
}

func sendError(w http.ResponseWriter, status int, message string) {
	send(w, status, contractErrorForStatus(status, message))
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.EscapedPath()
	kind := classify(path)
	switch kind {
	case statsRoute:
		h.serveStats(w, r)
		return
	case telemetry:
		receiveTBVideoOutcome(w, r, tbvideoLogger)
		return
	case legacy:
		sendError(w, 410, "接口已更新，请等待当前下载结束后刷新页面")
		return
	case media:
		if h.weiboRelay != nil {
			h.weiboRelay.ServeHTTP(w, r)
			return
		}
		sendError(w, 503, "微博播放服务尚未配置，请联系站点维护者")
		return
	case youtubeHelper:
		h.serveYouTubeHelper(w, r)
		return
	case parser, catalogRoute:
	default:
		sendError(w, 404, "接口不存在")
		return
	}
	isParse := kind == parser
	var wallStart time.Time
	var channel string
	if isParse {
		wallStart = parseWallStartFromContext(r.Context(), nil)
		channel = ChannelFromContext(r.Context())
	}
	if r.Method != http.MethodGet {
		if isParse {
			h.stats.RecordParse(h.ParsePlatform(r.URL.RawQuery), "INVALID_INPUT", channel, time.Since(wallStart))
		}
		w.Header().Set("Allow", "GET")
		sendError(w, 405, "仅支持 GET 请求")
		return
	}
	version, scalar := queryValue(r.URL.RawQuery, "schema_version")
	if !scalar || version != unified.SchemaVersion {
		if isParse {
			h.stats.RecordParse(h.ParsePlatform(r.URL.RawQuery), "INVALID_INPUT", channel, time.Since(wallStart))
		}
		sendError(w, 409, "接口版本已更新，请等待当前下载结束后刷新页面")
		return
	}
	if path == "/api/platforms" {
		send(w, 200, h.catalog.Envelope())
		return
	}
	input, scalar := queryValue(r.URL.RawQuery, "url")
	source := InputURL(input)
	platform := h.catalog.PlatformForURL(source)
	requested, requestedScalar := queryValue(r.URL.RawQuery, "platform")
	// Absence is different from an explicit array assignment.
	if !queryPresent(r.URL.RawQuery, "platform") {
		requested, requestedScalar = "all", true
	}
	if !scalar || source == "" || !requestedScalar || !h.catalog.ValidInputURL(source) {
		h.stats.RecordParse(platform, "INVALID_INPUT", channel, time.Since(wallStart))
		sendError(w, 400, "请输入对应平台的有效分享链接")
		return
	}
	if platform == "" {
		if h.genericAdapter != nil && path == "/api/parse" && requested == "all" {
			if !ytgeneric.AllowedGenericInputURL(source) {
				h.stats.RecordParse(PlatformUnknown, "INVALID_INPUT", channel, time.Since(wallStart))
				sendError(w, 400, "请输入有效的公网分享链接")
				return
			}
			platform = PlatformGeneric
		} else {
			h.stats.RecordParse(platform, "UNSUPPORTED_PLATFORM", channel, time.Since(wallStart))
			send(w, 400, unified.ContractError("UNSUPPORTED_PLATFORM", "暂不支持该平台链接解析", false))
			return
		}
	} else {
		if requested != "all" && !h.catalog.Has(requested) {
			h.stats.RecordParse(platform, "UNSUPPORTED_PLATFORM", channel, time.Since(wallStart))
			send(w, 400, unified.ContractError("UNSUPPORTED_PLATFORM", "暂不支持该平台链接解析", false))
			return
		}
		if requested != "all" && requested != platform {
			h.stats.RecordParse(platform, "INVALID_INPUT", channel, time.Since(wallStart))
			sendError(w, 400, "链接与所选平台不匹配，请切换对应平台或选择自动识别")
			return
		}
	}
	if !authAllowsPlatform(r.Context(), platform) {
		if authKey, viaAdm := authKeyFromContext(r.Context()); authKey != nil && !viaAdm {
			authKey.recordUnauthorized()
		}
		h.recordParseTelemetry(platform, "", OutcomeUnauthorized, channel, time.Since(wallStart))
		sendError(w, http.StatusUnauthorized, "当前凭据无权访问该平台")
		return
	}
	itemID, scalarID := queryValue(r.URL.RawQuery, "item_id")
	if path == "/api/resolve" && (!scalarID || itemID == "" || len(itemID) > 256) {
		h.stats.RecordParse(platform, "INVALID_INPUT", channel, time.Since(wallStart))
		sendError(w, 400, "缺少有效的媒体条目标识")
		return
	}
	adapter := h.adapterForPlatform(platform)
	if adapter == nil {
		h.recordParseTelemetry(platform, "", "SERVICE_NOT_CONFIGURED", channel, time.Since(wallStart))
		sendError(w, 503, "解析服务未配置完成")
		return
	}
	debug, _ := queryValue(r.URL.RawQuery, "debug")
	debugView := debug == "1"
	resolveItemID := ""
	if path == "/api/resolve" {
		resolveItemID = itemID
	}
	if h.cache == nil || h.cache.cfg.Disabled || !cacheableRequest(platform, source) {
		h.stats.recordCacheUncacheable(channel)
		ctx, cancel := context.WithTimeout(r.Context(), parseTimeout)
		defer cancel()
		res := h.runUncachedParse(ctx, path, platform, source, resolveItemID, debugView)
		h.recordParseTelemetry(platform, res.platform, res.code, channel, time.Since(wallStart))
		writeResponse(w, res)
		return
	}
	key := cacheKey{
		route:    path,
		platform: platform,
		url:      normalizeCacheURL(platform, source),
		itemID:   resolveItemID,
		debug:    debugView,
	}
	h.serveCachedParse(w, r, key, path, platform, source, resolveItemID, debugView, channel, wallStart)
}

func (h *Handler) serveCachedParse(
	w http.ResponseWriter,
	r *http.Request,
	key cacheKey,
	path, platform, source, itemID string,
	debug bool,
	channel string,
	wallStart time.Time,
) {
	if res, ok := h.cache.getFresh(key, h.now()); ok {
		h.stats.recordCacheHit(channel)
		if authKey, _ := authKeyFromContext(r.Context()); authKey != nil {
			authKey.counters.cacheHits.Add(1)
		}
		h.recordParseTelemetry(platform, res.platform, res.code, channel, time.Since(wallStart))
		writeResponse(w, res)
		return
	}
	h.cache.mu.Lock()
	if res, ok := h.cache.getLocked(key, h.now()); ok {
		h.cache.mu.Unlock()
		h.stats.recordCacheHit(channel)
		if authKey, _ := authKeyFromContext(r.Context()); authKey != nil {
			authKey.counters.cacheHits.Add(1)
		}
		h.recordParseTelemetry(platform, res.platform, res.code, channel, time.Since(wallStart))
		writeResponse(w, res)
		return
	}
	if r.Context().Err() != nil {
		h.cache.mu.Unlock()
		return
	}
	call, joining := h.cache.inflight[key]
	if !joining {
		execCtx, execCancel := context.WithTimeout(context.WithoutCancel(r.Context()), parseTimeout)
		call = &inflightCall{
			done:    make(chan struct{}),
			cancel:  execCancel,
			waiters: 1,
		}
		h.cache.inflight[key] = call
		h.cache.mu.Unlock()
		h.stats.recordCacheMiss(channel)
		go h.runSingleflight(execCtx, execCancel, key, call, path, platform, source, itemID, debug)
	} else {
		call.waiters++
		h.cache.mu.Unlock()
		h.stats.recordSingleflightShared(channel)
	}

	select {
	case <-call.done:
		h.recordParseTelemetry(platform, call.res.platform, call.res.code, channel, time.Since(wallStart))
		writeResponse(w, call.res)
	case <-r.Context().Done():
		h.cache.onWaiterCanceled(key, call)
	}
}

func (h *Handler) internalErrorResponse() cachedResponse {
	res, _ := encodeResponse(http.StatusInternalServerError, contractErrorForStatus(http.StatusInternalServerError, "解析服务内部错误"))
	return res
}

func (h *Handler) logRecoveredParsePanic(platform string, p any) {
	logf := log.Printf
	if h != nil && h.panicLogf != nil {
		logf = h.panicLogf
	}
	logf("dokitool: parse panic recovered: platform=%s panic_type=%T", platform, p)
}

func (h *Handler) runUncachedParse(
	ctx context.Context,
	path, platform, source, itemID string,
	debug bool,
) (res cachedResponse) {
	var completed bool
	defer func() {
		if p := recover(); p != nil {
			h.logRecoveredParsePanic(platform, p)
			res = h.internalErrorResponse()
		} else if !completed {
			res = h.internalErrorResponse()
		}
	}()
	res, _, _ = h.executeParse(ctx, path, platform, source, itemID, debug, h.now())
	completed = true
	return res
}

func (h *Handler) runSingleflight(
	ctx context.Context,
	cancel context.CancelFunc,
	key cacheKey,
	call *inflightCall,
	path, platform, source, itemID string,
	debug bool,
) {
	var (
		res       cachedResponse
		finishNow time.Time
		ttl       time.Duration
		cacheable bool
		completed bool
	)
	defer func() {
		if p := recover(); p != nil {
			res = h.internalErrorResponse()
			cacheable = false
			h.logRecoveredParsePanic(platform, p)
		} else if !completed {
			res = h.internalErrorResponse()
			cacheable = false
		}

		h.cache.mu.Lock()
		if h.cache.inflight[key] == call {
			delete(h.cache.inflight, key)
		}
		if !call.abandoned && ctx.Err() == nil && cacheable {
			h.cache.putLocked(key, res, finishNow.Add(ttl))
		}
		call.res = res
		close(call.done)
		h.cache.mu.Unlock()
		cancel()
	}()

	var (
		payload unified.Object
		encOK   bool
	)
	parseCtx, shanghaiFallback := unified.WithShanghaiFallbackTracker(ctx)
	res, payload, encOK = h.executeParse(parseCtx, path, platform, source, itemID, debug, h.now())
	finishNow = h.now()
	if encOK && payload != nil {
		ttl, cacheable = computeCacheTTLForResult(platform, payload, finishNow, shanghaiFallback())
	}
	completed = true
}

func (h *Handler) resolveGenericFailurePlatform(attributed string) string {
	if attributed != "" &&
		attributed != PlatformGeneric &&
		attributed != PlatformYTDLPOther &&
		attributed != PlatformYTDLPUnmatched &&
		attributed != "generic" &&
		IsValidDynamicPlatformKey(attributed) &&
		corePlatformIndex(attributed) < 0 &&
		(h == nil || h.catalog == nil || !h.catalog.Has(attributed)) {
		return attributed
	}
	return PlatformYTDLPUnmatched
}

func (h *Handler) executeParse(
	ctx context.Context,
	path, platform, source, itemID string,
	debug bool,
	nowTime time.Time,
) (res cachedResponse, retPayload unified.Object, retOK bool) {
	defer func() {
		if p := recover(); p != nil {
			h.logRecoveredParsePanic(platform, p)
			res = h.internalErrorResponse()
			if platform == PlatformGeneric {
				res.platform = PlatformYTDLPUnmatched
			}
			retPayload = nil
			retOK = false
		}
	}()
	errorResult := func(status int, message, failurePlatform string) (cachedResponse, unified.Object, bool) {
		res, _ := encodeResponse(status, contractErrorForStatus(status, message))
		if platform == PlatformGeneric {
			res.platform = h.resolveGenericFailurePlatform(failurePlatform)
		}
		return res, nil, false
	}
	adapter := h.adapterForPlatform(platform)
	if adapter == nil {
		return errorResult(503, "解析服务未配置完成", "")
	}
	now := nowTime.Unix()

	var (
		payload            unified.Object
		attributedPlatform string
		err                error
	)
	if platform == PlatformGeneric {
		if aa, ok := adapter.(attributedAdapter); ok {
			payload, attributedPlatform, err = aa.ParseWithPlatform(ctx, source, now)
		} else {
			payload, err = adapter.Parse(ctx, source, now)
		}
	} else {
		payload, err = adapter.Parse(ctx, source, now)
	}
	if err != nil {
		return errorResult(502, "上游返回不完整或不符合媒体合同的数据", attributedPlatform)
	}
	if err := unified.ValidateEnvelopeAt(payload, now); err != nil {
		return errorResult(502, "解析接口合同校验失败", attributedPlatform)
	}
	status := Status(payload)
	if status != 200 {
		res, ok := encodeResponse(status, payload)
		if platform == PlatformGeneric {
			res.platform = h.resolveGenericFailurePlatform(attributedPlatform)
		}
		return res, payload, ok
	}
	data := unified.Map(payload["data"])
	actualPlatform := unified.Str(data["platform"])
	if platform == PlatformGeneric {
		if !IsValidDynamicPlatformKey(actualPlatform) ||
			corePlatformIndex(actualPlatform) >= 0 ||
			h.catalog.Has(actualPlatform) ||
			actualPlatform == "generic" ||
			actualPlatform == PlatformGeneric ||
			actualPlatform == PlatformYTDLPOther ||
			actualPlatform == PlatformYTDLPUnmatched {
			return errorResult(502, "内部解析接口平台不一致", "")
		}
	} else if actualPlatform != platform {
		return errorResult(502, "内部解析接口平台不一致", "")
	}
	if h.publicMedia != nil {
		targetPlatform := platform
		if platform == PlatformGeneric {
			targetPlatform = actualPlatform
		}
		payload, err = h.publicMedia(ctx, targetPlatform, payload, now)
		if err != nil {
			return errorResult(503, "媒体服务尚未配置，请联系站点维护者", actualPlatform)
		}
		if err := unified.ValidateEnvelopeAt(payload, now); err != nil {
			return errorResult(502, "解析接口合同校验失败", actualPlatform)
		}
		if status := Status(payload); status != 200 {
			res, ok := encodeResponse(status, payload)
			if platform == PlatformGeneric {
				res.platform = actualPlatform
			}
			return res, payload, ok
		}
		if unified.Str(unified.Map(payload["data"])["platform"]) != targetPlatform {
			return errorResult(502, "内部解析接口平台不一致", actualPlatform)
		}
	}
	payload = unified.PublicView(payload, debug, now)
	if path == "/api/resolve" {
		found := false
		data = unified.Map(payload["data"])
		for _, value := range unified.Slice(data["items"]) {
			item := unified.Map(value)
			if unified.Str(item["id"]) == itemID && (item["state"] == nil || item["state"] == "ready") {
				found = true
				break
			}
		}
		if !found {
			notFound := unified.ContractError("CONTENT_UNAVAILABLE", "请求的媒体条目暂时不可用", false)
			res, ok := encodeResponse(404, notFound)
			return res, notFound, ok
		}
		data["default_item_id"] = itemID
	}
	if err := unified.ValidateEnvelopeAt(payload, now); err != nil {
		return errorResult(502, "解析接口合同校验失败", actualPlatform)
	}
	res, ok := encodeResponse(200, payload)
	if platform == PlatformGeneric && ok {
		res.platform = actualPlatform
	}
	return res, payload, ok
}

func queryPresent(raw, name string) bool {
	for _, pair := range strings.Split(raw, "&") {
		key := formDecode(strings.SplitN(pair, "=", 2)[0])
		if key == name || strings.HasPrefix(key, name+"[") {
			return true
		}
	}
	return false
}

const (
	maxYouTubeFinalizeBodyBytes       = 512 << 10
	defaultYouTubeFinalizeReadTimeout = 5 * time.Second
)

func (h *Handler) youtubeFinalizeReadTimeout() time.Duration {
	if h != nil && h.finalizeReadTimeout > 0 {
		return h.finalizeReadTimeout
	}
	return defaultYouTubeFinalizeReadTimeout
}

func (h *Handler) serveYouTubeHelper(w http.ResponseWriter, r *http.Request) {
	if h.youtubeHelper == nil {
		sendError(w, 404, "接口不存在")
		return
	}
	if !authAllowsPlatform(r.Context(), "youtube") {
		if authKey, viaAdm := authKeyFromContext(r.Context()); authKey != nil && !viaAdm {
			authKey.recordUnauthorized()
		}
		sendError(w, http.StatusUnauthorized, "当前凭据无权访问该平台")
		return
	}
	switch r.URL.EscapedPath() {
	case "/api/youtube/context":
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			sendError(w, 405, "仅支持 GET 请求")
			return
		}
		version, scalar := queryValue(r.URL.RawQuery, "schema_version")
		if !scalar || version != unified.SchemaVersion {
			sendError(w, 409, "接口版本已更新，请等待当前下载结束后刷新页面")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		payload, status := h.youtubeHelper.Context(ctx)
		send(w, status, payload)
	case "/api/youtube/finalize":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			sendError(w, 405, "仅支持 POST 请求")
			return
		}
		version, scalar := queryValue(r.URL.RawQuery, "schema_version")
		if !scalar || version != unified.SchemaVersion {
			sendError(w, 409, "接口版本已更新，请等待当前下载结束后刷新页面")
			return
		}
		if r.Body == nil {
			if r.ProtoMajor == 1 {
				r.Close = true
				w.Header().Set("Connection", "close")
			}
			sendError(w, 400, "请求体不能为空")
			return
		}
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(h.youtubeFinalizeReadTimeout()))
		limitedBody := http.MaxBytesReader(w, r.Body, maxYouTubeFinalizeBodyBytes)
		body, err := io.ReadAll(limitedBody)
		if err != nil {
			if r.ProtoMajor == 1 {
				r.Close = true
				w.Header().Set("Connection", "close")
			}
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				sendError(w, 400, "请求体超出 512 KiB 限制")
			} else {
				sendError(w, 400, "读取请求体失败")
			}
			if r.ProtoMajor == 1 {
				_ = controller.SetReadDeadline(time.Now())
			}
			_ = limitedBody.Close()
			return
		}
		if err := limitedBody.Close(); err != nil {
			if r.ProtoMajor == 1 {
				r.Close = true
				w.Header().Set("Connection", "close")
			}
			sendError(w, 400, "读取请求体失败")
			return
		}
		_ = controller.SetReadDeadline(time.Time{})
		debug, _ := queryValue(r.URL.RawQuery, "debug")
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		payload, status := h.youtubeHelper.Finalize(ctx, body, debug == "1")
		send(w, status, payload)
	default:
		sendError(w, 404, "接口不存在")
	}
}
