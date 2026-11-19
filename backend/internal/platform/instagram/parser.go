// Package instagram implements the Instagram Reels, Post, and Carousel parser
// backed by the hardened internal yt-dlp metadata engine, an anonymous native
// fallback pipeline (Embed Captioned + GraphQL), and the unified-v1 contract.
package instagram

import (
	"context"
	"errors"
	"log"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/urlpolicy"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

var (
	shortcodePattern        = regexp.MustCompile(`^[A-Za-z0-9_-]{5,32}$`)
	privateShortcodePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{33,80}$`)
	storySegmentPattern     = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
)

const (
	instagramLoginBlockedMessage = "需要登录，暂不支持"
	nativeSupplementTimeout      = 3 * time.Second
	maxCarouselEntries           = 10
)

// Parser adapts yt-dlp -J metadata and anonymous native Instagram responses
// (Captioned Embed + GraphQL) for Reels, Posts, and Carousels into unified-v1.
type Parser struct {
	engine            ytengine.Extractor
	sizeProber        ytengine.SizeProber
	fetcher           fetch.Executor
	supplementTimeout time.Duration
}

// New creates an Instagram platform parser bound to the given ytengine.Extractor.
func New(engine ytengine.Extractor) *Parser {
	return &Parser{engine: engine}
}

// NewWithSizeProber creates an Instagram platform parser that probes exact byte
// lengths for progressive MP4 formats on cdninstagram.com.
func NewWithSizeProber(engine ytengine.Extractor, prober ytengine.SizeProber) *Parser {
	return &Parser{engine: engine, sizeProber: prober}
}

// NewWithFetcher creates an Instagram platform parser with both yt-dlp extraction
// and SSRF-safe anonymous native extraction (Embed Captioned + GraphQL).
func NewWithFetcher(engine ytengine.Extractor, prober ytengine.SizeProber, fetcher fetch.Executor) *Parser {
	return &Parser{engine: engine, sizeProber: prober, fetcher: fetcher}
}

// WithFetcher returns a copy of the Parser configured with an SSRF-safe fetch.Executor
// for anonymous native Embed/GraphQL extraction when yt-dlp is unavailable or
// encounters photo/carousel posts or login walls.
func (p *Parser) WithFetcher(fetcher fetch.Executor) *Parser {
	if p == nil {
		return &Parser{fetcher: fetcher}
	}
	cp := *p
	cp.fetcher = fetcher
	return &cp
}

// ExtractPostTarget validates an Instagram Post/Reel URL and returns:
//   - shortcode: the post/reel shortcode
//   - canonicalURL: the sanitized URL safe to pass to yt-dlp
//   - ok: whether the input URL is a valid Instagram post/reel URL
func ExtractPostTarget(raw string) (string, string, bool) {
	if unified.MediaURL(raw) == "" || len(raw) > 2048 {
		return "", "", false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' {
			return "", "", false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" {
		return "", "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", "", false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || (scheme == "https" && n != 443) || (scheme == "http" && n != 80) {
			return "", "", false
		}
	}

	host := strings.ToLower(u.Hostname())
	switch host {
	case "instagram.com", "www.instagram.com", "m.instagram.com":
	default:
		return "", "", false
	}

	segments := splitNonEmptyPath(u.EscapedPath())
	var kind, shortcode string

	switch {
	case len(segments) >= 2 && isInstagramPostKind(segments[0]):
		kind = normalizeKind(segments[0])
		shortcode = segments[1]
	case len(segments) >= 3 && isInstagramPostKind(segments[1]):
		kind = normalizeKind(segments[1])
		shortcode = segments[2]
	default:
		return "", "", false
	}

	if !shortcodePattern.MatchString(shortcode) {
		return "", "", false
	}
	canonicalURL := "https://www.instagram.com/" + kind + "/" + shortcode + "/"
	return shortcode, canonicalURL, true
}

func requiresLoginInstagramURL(raw string) bool {
	if unified.MediaURL(raw) == "" || len(raw) > 2048 {
		return false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' {
			return false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || (scheme == "https" && n != 443) || (scheme == "http" && n != 80) {
			return false
		}
	}
	switch strings.ToLower(u.Hostname()) {
	case "instagram.com", "www.instagram.com", "m.instagram.com":
	default:
		return false
	}

	segments := splitNonEmptyPath(u.EscapedPath())
	if len(segments) >= 2 && strings.EqualFold(segments[0], "stories") && storySegmentPattern.MatchString(segments[1]) {
		return true
	}
	if len(segments) >= 2 && isInstagramPostKind(segments[0]) && privateShortcodePattern.MatchString(segments[1]) {
		return true
	}
	if len(segments) >= 3 && isInstagramPostKind(segments[1]) && privateShortcodePattern.MatchString(segments[2]) {
		return true
	}
	return false
}

func isInstagramPostKind(seg string) bool {
	switch strings.ToLower(seg) {
	case "p", "reel", "reels", "tv":
		return true
	default:
		return false
	}
}

func normalizeKind(seg string) string {
	switch strings.ToLower(seg) {
	case "reel", "reels":
		return "reel"
	case "tv":
		return "tv"
	default:
		return "p"
	}
}

func isReelOrTVCanonical(canonicalURL string) bool {
	return strings.Contains(canonicalURL, "/reel/") || strings.Contains(canonicalURL, "/tv/")
}

// AllowedTargetURL enforces that only canonical Instagram post/reel URLs reach ytengine.
func AllowedTargetURL(raw string) bool {
	_, canonical, ok := ExtractPostTarget(raw)
	return ok && raw == canonical
}

// AllowedOutboundHost restricts yt-dlp subprocess outbound connections to official Instagram/Meta CDN domains.
func AllowedOutboundHost(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	for _, domain := range []string{"instagram.com", "cdninstagram.com", "fbcdn.net"} {
		if h == domain || strings.HasSuffix(h, "."+domain) {
			return true
		}
	}
	return false
}

// AllowedPageURL restricts native Embed and GraphQL HTTP requests to official Instagram HTTPS web hosts.
func AllowedPageURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" {
		return false
	}
	if strings.ToLower(u.Scheme) != "https" {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n != 443 {
			return false
		}
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	return host == "www.instagram.com" || host == "instagram.com" || host == "i.instagram.com"
}

// AllowedMediaURL restricts public media and cover URLs to official Instagram CDN hosts.
func AllowedMediaURL(raw string) bool {
	return urlpolicy.HostSuffixURL(raw, urlpolicy.HTTPAndHTTPS,
		".cdninstagram.com", ".fbcdn.net", ".instagram.com")
}

func splitNonEmptyPath(escapedPath string) []string {
	trimmed := strings.Trim(escapedPath, "/")
	if trimmed == "" {
		return nil
	}
	parts := strings.Split(trimmed, "/")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			return nil
		}
		out = append(out, p)
	}
	return out
}

func (p *Parser) effectiveSupplementTimeout() time.Duration {
	if p != nil && p.supplementTimeout > 0 {
		return p.supplementTimeout
	}
	return nativeSupplementTimeout
}

// Parse extracts Instagram Reel/Post/Carousel metadata via the 3-tier pipeline
// (ytengine yt-dlp -> anonymous Captioned Embed -> anonymous GraphQL) and
// formats a unified-v1 envelope.
func (p *Parser) Parse(ctx context.Context, source string, now int64) (unified.Object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	shortcode, canonicalURL, ok := ExtractPostTarget(source)
	if !ok {
		if requiresLoginInstagramURL(source) {
			return unified.ContractError("UPSTREAM_BLOCKED", instagramLoginBlockedMessage, false), nil
		}
		return unified.ContractError("INVALID_INPUT", "请输入有效的 Instagram 帖子或 Reels 链接", false), nil
	}
	engineReady := p != nil && p.engine != nil && p.engine.Enabled()
	fetcherReady := p != nil && p.fetcher != nil
	if !engineReady && !fetcherReady {
		return unified.ContractError("SERVICE_NOT_CONFIGURED", "当前平台解析服务暂不可用", false), nil
	}

	opts := ytengine.AdaptOptions{
		PlatformID:                   "instagram",
		ContentID:                    shortcode,
		SourceURL:                    source,
		MaxEntries:                   maxCarouselEntries,
		AllowedMediaURL:              AllowedMediaURL,
		EnableDASHMux:                true,
		EnableHLS:                    false,
		AllowCodecLessProgressiveMP4: true,
	}

	type nativeFetchResult struct {
		post     *nativePost
		loginReq bool
		ok       bool
		err      error
	}
	var (
		nativeCh        chan nativeFetchResult
		cancelNative    context.CancelFunc
		supplementTimer *time.Timer
	)
	if engineReady && fetcherReady && !isReelOrTVCanonical(canonicalURL) {
		var nativeCtx context.Context
		nativeCtx, cancelNative = context.WithCancel(ctx)
		defer cancelNative()
		nativeCh = make(chan nativeFetchResult, 1)
		supplementTimer = time.NewTimer(p.effectiveSupplementTimeout())
		defer supplementTimer.Stop()
		go func() {
			var completed bool
			defer func() {
				if recovered := recover(); recovered != nil {
					log.Printf("instagram: native fetch goroutine panic recovered: panic_type=%T", recovered)
					nativeCh <- nativeFetchResult{err: errors.New("instagram native fetch internal panic")}
				} else if !completed {
					nativeCh <- nativeFetchResult{err: errors.New("instagram native fetch internal panic")}
				}
			}()
			post, loginReq, ok := p.fetchNativePost(nativeCtx, shortcode, false)
			completed = true
			nativeCh <- nativeFetchResult{post: post, loginReq: loginReq, ok: ok}
		}()
	}

	var ytErr error
	if engineReady {
		info, err := p.engine.Extract(ctx, canonicalURL)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
				return nil, ctxErr
			}
			var engineErr *ytengine.Error
			if errors.As(err, &engineErr) && engineErr.LocalBusy {
				resp := unified.ContractError(string(engineErr.Code), engineErr.Message, engineErr.Retryable)
				if engineErr.Retryable && engineErr.RetryAfter > 0 {
					unified.Map(resp["error"])["retry_after_seconds"] = engineErr.RetryAfter
				}
				return resp, nil
			}
			ytErr = err
		} else {
			ytengine.PopulateMissingMP4Sizes(ctx, info, p.sizeProber, opts)
			adapted := ytengine.AdaptInfo(info, opts, now)
			if unified.Str(adapted["code"]) == "OK" {
				if nativeCh != nil {
					ytItems := unified.Slice(unified.Map(adapted["data"])["items"])
					if len(ytItems) < maxCarouselEntries {
						var res nativeFetchResult
						var gotNative bool
						select {
						case res = <-nativeCh:
							gotNative = true
						default:
							select {
							case res = <-nativeCh:
								gotNative = true
							case <-supplementTimer.C:
								cancelNative()
							case <-ctx.Done():
								cancelNative()
							}
						}
						if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
							return nil, ctxErr
						}
						if gotNative && res.err == nil && res.ok && res.post != nil &&
							len(res.post.Items) > 1 && (res.post.hasImage() || len(res.post.Items) > len(ytItems)) {
							if merged := p.buildNativeEnvelopeWithYTVideos(ctx, res.post, ytItems, shortcode, source, now); unified.Str(merged["code"]) == "OK" {
								return merged, nil
							}
						}
					} else {
						cancelNative()
					}
				}
				return adapted, nil
			}
			if !fetcherReady {
				return adapted, nil
			}
		}
	}

	var nativeLoginRequired bool
	if fetcherReady {
		var (
			nativeEnv unified.Object
			loginReq  bool
			nativeOK  bool
		)
		if nativeCh != nil {
			select {
			case res := <-nativeCh:
				loginReq = res.loginReq
				if res.err == nil && res.ok && res.post != nil && len(res.post.Items) > 0 {
					if env := p.buildNativeEnvelope(ctx, res.post, shortcode, source, now); unified.Str(env["code"]) == "OK" {
						nativeEnv = env
						nativeOK = true
					}
				}
			case <-ctx.Done():
				cancelNative()
			}
		} else {
			nativeEnv, loginReq, nativeOK = p.extractNativeWithStatus(ctx, shortcode, canonicalURL, source, now)
		}
		if nativeOK {
			return nativeEnv, nil
		}
		nativeLoginRequired = loginReq
		if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
			return nil, ctxErr
		}
	}

	if nativeLoginRequired || isInstagramLoginRequiredError(ytErr) {
		return unified.ContractError("UPSTREAM_BLOCKED", instagramLoginBlockedMessage, false), nil
	}

	if ytErr != nil {
		var engineErr *ytengine.Error
		if errors.As(ytErr, &engineErr) {
			resp := unified.ContractError(string(engineErr.Code), engineErr.Message, engineErr.Retryable)
			if engineErr.Retryable && engineErr.RetryAfter > 0 {
				unified.Map(resp["error"])["retry_after_seconds"] = engineErr.RetryAfter
			}
			return resp, nil
		}
	}
	return unified.ContractError("UPSTREAM_UNAVAILABLE", "当前平台解析服务暂不可用，请稍后重试", true), nil
}
