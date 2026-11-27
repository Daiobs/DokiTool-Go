package tiktok

import (
	"container/list"
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/telemetry"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/urlpolicy"
)

const (
	tiktokBrowserUA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
	hydrationTimeout     = 12 * time.Second
	hydrationMaxBytes    = 4 << 20
	shortlinkTimeout     = 6 * time.Second
	shortlinkMaxHops     = 3
	shortlinkMaxBytes    = 64 << 10
	shortlinkCacheMax    = 2048
	shortlinkCacheTTL    = time.Hour
	defaultDirectRPM     = 6.0
	defaultDirectBurst   = 6
)

var shortlinkAllowedHosts = fetch.AllowHosts(
	"vm.tiktok.com",
	"vt.tiktok.com",
	"www.tiktok.com",
	"m.tiktok.com",
	"tiktok.com",
)

// Parser parses TikTok videos and Photo Mode albums using zero-cookie page
// hydration and cookie-free /aweme/v1/play/ 302 resolution.
type Parser struct {
	executor        fetch.Executor
	clock           func() time.Time
	shortLinks      *shortLinkCache
	limiter         *tokenBucket
	proxyConfigured bool
	transportMode   string

	hydrationOK     atomic.Uint64
	wafBlocked      atomic.Uint64
	contentNotFound atomic.Uint64
	play302OK       atomic.Uint64
	play302Failed   atomic.Uint64
}

// New constructs a TikTok parser with bounded shortlink caching (2048 entries, 1h TTL)
// and a default direct-mode burst guardrail (6 req/min, burst 6).
func New(executor fetch.Executor) *Parser {
	return &Parser{
		executor:      executor,
		clock:         time.Now,
		shortLinks:    newShortLinkCache(shortlinkCacheMax, shortlinkCacheTTL),
		limiter:       newTokenBucket(defaultDirectRPM/60.0, defaultDirectBurst),
		transportMode: "standard",
	}
}

// WithClock overrides the time source for deterministic testing.
func (p *Parser) WithClock(clock func() time.Time) *Parser {
	if p == nil {
		return nil
	}
	if clock != nil {
		p.clock = clock
	}
	return p
}

// WithDirectRateLimit configures or disables (ratePerMin <= 0) the direct-mode
// token bucket guardrail.
func (p *Parser) WithDirectRateLimit(ratePerMin float64, burst int) *Parser {
	if p == nil {
		return nil
	}
	if ratePerMin <= 0 {
		p.limiter = nil
		return p
	}
	if burst < 1 {
		burst = 1
	}
	p.limiter = newTokenBucket(ratePerMin/60.0, burst)
	return p
}

// WithProxyConfigured marks whether an external rotating proxy is configured
// for TikTok metadata hydration (disabling the single-IP direct-mode bucket).
func (p *Parser) WithProxyConfigured(configured bool) *Parser {
	if p == nil {
		return nil
	}
	p.proxyConfigured = configured
	return p
}

// WithTransportMode records the configured hydration transport mode ("standard" or "chrome131").
func (p *Parser) WithTransportMode(mode string) *Parser {
	if p == nil {
		return nil
	}
	if mode == "chrome131" {
		p.transportMode = "chrome131"
	} else {
		p.transportMode = "standard"
	}
	return p
}

// TikTokRiskStatsSnapshot returns a strictly redacted telemetry snapshot for /api/stats.
func (p *Parser) TikTokRiskStatsSnapshot() telemetry.TikTokRiskStats {
	if p == nil {
		return telemetry.TikTokRiskStats{TransportMode: "standard"}
	}
	mode := p.transportMode
	if mode == "" {
		mode = "standard"
	}
	return telemetry.TikTokRiskStats{
		ProxyConfigured: p.proxyConfigured,
		TransportMode:   mode,
		HydrationOK:     p.hydrationOK.Load(),
		WAFBlocked:      p.wafBlocked.Load(),
		ContentNotFound: p.contentNotFound.Load(),
		Play302OK:       p.play302OK.Load(),
		Play302Failed:   p.play302Failed.Load(),
	}
}

func (p *Parser) now() time.Time {
	if p != nil && p.clock != nil {
		return p.clock()
	}
	return time.Now()
}

// Parse resolves a TikTok video, photo, or shortlink URL into a unified-v1 envelope.
func (p *Parser) Parse(ctx context.Context, source string, now int64) (unified.Object, error) {
	if p == nil || p.executor == nil {
		return unified.ContractError("SERVICE_NOT_CONFIGURED", "TikTok 解析器尚未配置", false), nil
	}
	if now <= 0 {
		now = p.now().Unix()
	}

	itemID, canonicalURL, isShort, ok := urlpolicy.ExtractTikTokItemTarget(source)
	if !ok {
		unified.MarkCallerScopedFailure(ctx)
		return unified.ContractError("INVALID_INPUT", "请输入有效的 TikTok 视频或图文链接", false), nil
	}

	if isShort {
		resolvedID, resolvedCanon, errObj, err := p.resolveShortLink(ctx, source, canonicalURL, now)
		if err != nil {
			return nil, err
		}
		if errObj != nil {
			return errObj, nil
		}
		itemID = resolvedID
		canonicalURL = resolvedCanon
	}

	if !p.proxyConfigured && p.limiter != nil {
		if !p.limiter.Allow(p.now()) {
			return unified.ContractError("RATE_LIMITED", "TikTok 直连解析频率受限，请稍后重试", true), nil
		}
	}

	headers := make(http.Header)
	headers.Set("User-Agent", tiktokBrowserUA)
	headers.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	headers.Set("Accept-Language", "en-US,en;q=0.9")
	headers.Set("Accept-Encoding", "gzip, deflate")

	resp, err := p.executor.Do(ctx, fetch.Request{
		Method: http.MethodGet,
		URL:    canonicalURL,
		Header: headers,
		Policy: fetch.Policy{
			Purpose:         "tiktok-page",
			AllowedURL:      fetch.AllowHosts("www.tiktok.com"),
			Timeout:         hydrationTimeout,
			MaxBytes:        hydrationMaxBytes,
			FollowRedirects: false,
		},
	})
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return nil, err
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return unified.ContractError("UPSTREAM_TIMEOUT", "TikTok 上游连接超时，请稍后重试", true), nil
		}
		return unified.ContractError("UPSTREAM_UNAVAILABLE", "TikTok 页面请求失败，请稍后重试", true), nil
	}

	if resp.StatusCode == http.StatusMovedPermanently ||
		resp.StatusCode == http.StatusFound ||
		resp.StatusCode == http.StatusSeeOther ||
		resp.StatusCode == http.StatusTemporaryRedirect ||
		resp.StatusCode == http.StatusPermanentRedirect {
		p.contentNotFound.Add(1)
		return unified.ContractError("CONTENT_UNAVAILABLE", "该 TikTok 作品不可见或已被删除", false), nil
	}

	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		p.wafBlocked.Add(1)
		return unified.ContractError("UPSTREAM_BLOCKED", "TikTok 当前触发访问验证，请稍后重试", true), nil
	}

	detail, found, parseErr := parseVideoDetailFromHTML(resp.Body)
	if !found {
		if isSlardarWAF(resp.StatusCode, resp.Body) {
			p.wafBlocked.Add(1)
			return unified.ContractError("UPSTREAM_BLOCKED", "TikTok 当前触发访问验证，请稍后重试", true), nil
		}
		return unified.ContractError("UPSTREAM_INVALID_RESPONSE", "TikTok 页面数据格式异常，请稍后重试", true), nil
	}
	if parseErr != nil {
		return unified.ContractError("UPSTREAM_INVALID_RESPONSE", "TikTok 水合数据解析失败，请稍后重试", true), nil
	}
	if detail == nil {
		return unified.ContractError("UPSTREAM_INVALID_RESPONSE", "TikTok 页面未包含作品详情数据，请稍后重试", true), nil
	}

	if isUnavailableStatusCode(detail.StatusCode) {
		p.contentNotFound.Add(1)
		return unified.ContractError("CONTENT_UNAVAILABLE", "该 TikTok 作品已删除、设为私密或当前区域不可见", false), nil
	}
	if detail.StatusCode != 0 || detail.ItemInfo == nil || detail.ItemInfo.ItemStruct == nil {
		return unified.ContractError("UPSTREAM_UNAVAILABLE", "TikTok 暂未返回作品数据，请稍后重试", true), nil
	}

	p.hydrationOK.Add(1)
	itemStruct := detail.ItemInfo.ItemStruct
	if strings.TrimSpace(itemStruct.ID) == "" {
		itemStruct.ID = itemID
	}

	// Photo Mode: zero 302 calls.
	if itemStruct.ImagePost != nil && len(itemStruct.ImagePost.Images) > 0 {
		if payload, ok := formatPhotoPost(itemStruct, canonicalURL, now); ok {
			return payload, nil
		}
		return unified.ContractError("NO_MEDIA", "该 TikTok 图文未提供可用的公开图片资源", false), nil
	}

	// Video Mode: 0-Cookie /aweme/v1/play/ 302 resolution.
	if itemStruct.Video != nil {
		candidates := selectVideoTierCandidates(itemStruct.Video)
		if len(candidates) == 0 {
			return unified.ContractError("NO_MEDIA", "该 TikTok 作品未提供可解析的视频流", false), nil
		}
		resolved := p.resolvePlay302Tiers(ctx, candidates, now)
		if len(resolved) == 0 {
			return unified.ContractError("UPSTREAM_UNAVAILABLE", "TikTok 视频直链解析失败，请稍后重试", true), nil
		}
		if payload, ok := formatVideoPost(itemStruct, resolved, canonicalURL, now); ok {
			return payload, nil
		}
	}

	return unified.ContractError("NO_MEDIA", "该 TikTok 作品未找到可下载的媒体资源", false), nil
}

func (p *Parser) resolveShortLink(ctx context.Context, rawSource, startURL string, now int64) (string, string, unified.Object, error) {
	shortCode, hasCode := urlpolicy.ExtractTikTokShortCode(rawSource)
	if hasCode && p.shortLinks != nil {
		if cachedID, hit := p.shortLinks.Get(shortCode, now); hit {
			return cachedID, "https://www.tiktok.com/@i/video/" + cachedID, nil, nil
		}
	}

	current := startURL
	for hop := 0; hop < shortlinkMaxHops; hop++ {
		headers := make(http.Header)
		headers.Set("User-Agent", tiktokBrowserUA)
		headers.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
		resp, err := p.executor.Do(ctx, fetch.Request{
			Method: http.MethodGet,
			URL:    current,
			Header: headers,
			Policy: fetch.Policy{
				Purpose:         "tiktok-shortlink",
				AllowedURL:      shortlinkAllowedHosts,
				Timeout:         shortlinkTimeout,
				MaxBytes:        shortlinkMaxBytes,
				FollowRedirects: false,
			},
		})
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return "", "", nil, err
			}
			if errors.Is(err, context.DeadlineExceeded) {
				return "", "", unified.ContractError("UPSTREAM_TIMEOUT", "TikTok 短链跳转超时，请稍后重试", true), nil
			}
			return "", "", unified.ContractError("UPSTREAM_UNAVAILABLE", "TikTok 短链解析失败，请稍后重试", true), nil
		}
		if resp.StatusCode != http.StatusMovedPermanently &&
			resp.StatusCode != http.StatusFound &&
			resp.StatusCode != http.StatusSeeOther &&
			resp.StatusCode != http.StatusTemporaryRedirect &&
			resp.StatusCode != http.StatusPermanentRedirect {
			break
		}
		loc := strings.TrimSpace(resp.Header.Get("Location"))
		if loc == "" {
			break
		}
		base, err := url.Parse(current)
		if err != nil {
			break
		}
		nextURL, err := base.Parse(loc)
		if err != nil {
			break
		}
		nextStr := nextURL.String()
		if !shortlinkAllowedHosts(nextStr) {
			break
		}
		id, canon, nextIsShort, targetOK := urlpolicy.ExtractTikTokItemTarget(nextStr)
		if targetOK && !nextIsShort && id != "" {
			if hasCode && p.shortLinks != nil {
				p.shortLinks.Set(shortCode, id, now)
			}
			return id, canon, nil, nil
		}
		if !targetOK || !nextIsShort {
			// Landed on homepage (/?_r=1) or a non-work page.
			unified.MarkCallerScopedFailure(ctx)
			p.contentNotFound.Add(1)
			return "", "", unified.ContractError("CONTENT_UNAVAILABLE", "该 TikTok 分享短链已失效或作品不可见", false), nil
		}
		current = nextStr
	}

	unified.MarkCallerScopedFailure(ctx)
	p.contentNotFound.Add(1)
	return "", "", unified.ContractError("CONTENT_UNAVAILABLE", "该 TikTok 分享短链已失效或作品不可见", false), nil
}

// shortLinkCache is a bounded LRU with TTL mapping shortCode -> itemID.
type shortLinkCache struct {
	mu      sync.Mutex
	max     int
	ttlSec  int64
	order   *list.List
	entries map[string]*list.Element
}

type shortLinkEntry struct {
	key       string
	itemID    string
	expiresAt int64
}

func newShortLinkCache(max int, ttl time.Duration) *shortLinkCache {
	if max <= 0 {
		max = shortlinkCacheMax
	}
	ttlSec := int64(ttl / time.Second)
	if ttlSec <= 0 {
		ttlSec = int64(shortlinkCacheTTL / time.Second)
	}
	return &shortLinkCache{
		max:     max,
		ttlSec:  ttlSec,
		order:   list.New(),
		entries: make(map[string]*list.Element),
	}
}

func (c *shortLinkCache) Get(key string, now int64) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	elem, ok := c.entries[key]
	if !ok {
		return "", false
	}
	ent := elem.Value.(*shortLinkEntry)
	if ent.expiresAt <= now {
		c.order.Remove(elem)
		delete(c.entries, key)
		return "", false
	}
	c.order.MoveToFront(elem)
	return ent.itemID, true
}

func (c *shortLinkCache) Set(key, itemID string, now int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.entries[key]; ok {
		ent := elem.Value.(*shortLinkEntry)
		ent.itemID = itemID
		ent.expiresAt = now + c.ttlSec
		c.order.MoveToFront(elem)
		return
	}
	if c.order.Len() >= c.max {
		if oldest := c.order.Back(); oldest != nil {
			ent := oldest.Value.(*shortLinkEntry)
			delete(c.entries, ent.key)
			c.order.Remove(oldest)
		}
	}
	elem := c.order.PushFront(&shortLinkEntry{
		key:       key,
		itemID:    itemID,
		expiresAt: now + c.ttlSec,
	})
	c.entries[key] = elem
}

// tokenBucket implements a lightweight thread-safe token bucket guardrail for
// direct-mode TikTok hydration requests.
type tokenBucket struct {
	mu         sync.Mutex
	ratePerSec float64
	burst      float64
	tokens     float64
	last       time.Time
}

func newTokenBucket(ratePerSec float64, burst int) *tokenBucket {
	return &tokenBucket{
		ratePerSec: ratePerSec,
		burst:      float64(burst),
		tokens:     float64(burst),
	}
}

func (b *tokenBucket) Allow(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.last.IsZero() {
		b.last = now
	} else if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens += elapsed * b.ratePerSec
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
		b.last = now
	}
	if b.tokens < 1.0 {
		return false
	}
	b.tokens -= 1.0
	return true
}
