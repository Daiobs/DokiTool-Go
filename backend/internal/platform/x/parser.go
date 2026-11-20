// Package x implements the X / Twitter video parser backed by the hardened
// internal yt-dlp metadata engine.
package x

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

const (
	maxTweetVideos = 4

	TombstoneFallbackOff       = "off"
	TombstoneFallbackFxTwitter = "fxtwitter"

	tCoHost             = "t.co"
	tCoExpandTimeout    = 5 * time.Second
	tCoExpandMaxBytes   = 64 << 10 // 64 KiB
	tCoInvalidTargetMsg = "该 t.co 短链未指向有效的 X / Twitter 帖子"
)

var (
	tweetIDPattern            = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
	screenNamePattern         = regexp.MustCompile(`^[A-Za-z0-9_]{1,30}$`)
	tCoCodePattern            = regexp.MustCompile(`^[A-Za-z0-9]{1,32}$`)
	tCoMetaTagPattern         = regexp.MustCompile(`(?is)<meta\b(?:"[^"]*"|'[^']*'|[^>"'])*>`)
	tCoHTMLAttrPattern        = regexp.MustCompile(`(?is)([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>` + "`" + `]+))`)
	tCoMetaRefreshURLPattern  = regexp.MustCompile(`(?is)(?:^|;)\s*url\s*=\s*(.*)$`)
	tCoLocationReplacePattern = regexp.MustCompile(`(?:^|[^A-Za-z0-9_$])(?:(?:window|document|self|top)\.)?location\.replace\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*\)`)
	reservedHandles           = map[string]bool{
		"home":          true,
		"explore":       true,
		"search":        true,
		"notifications": true,
		"messages":      true,
		"settings":      true,
		"compose":       true,
		"intent":        true,
		"hashtag":       true,
		"tos":           true,
		"privacy":       true,
	}
)

// Parser adapts yt-dlp -J metadata and public syndication photo metadata for
// X / Twitter status URLs into unified-v1.
type Parser struct {
	engine            ytengine.Extractor
	sizeProber        SizeProber
	fetcher           fetch.Executor
	supplementTimeout time.Duration
	tombstoneFallback string
}

// New creates an X platform parser bound to the given ytengine.Extractor.
func New(engine ytengine.Extractor) *Parser {
	return &Parser{engine: engine}
}

// NewWithSizeProber creates an X platform parser that optionally probes exact byte
// lengths for progressive MP4 formats when yt-dlp leaves Filesize unset.
func NewWithSizeProber(engine ytengine.Extractor, prober SizeProber) *Parser {
	return &Parser{engine: engine, sizeProber: prober}
}

// NewWithFetcher creates an X platform parser with yt-dlp video extraction,
// optional progressive MP4 size probing, and SSRF-safe syndication photo extraction.
func NewWithFetcher(engine ytengine.Extractor, prober SizeProber, fetcher fetch.Executor) *Parser {
	return &Parser{engine: engine, sizeProber: prober, fetcher: fetcher}
}

// WithFetcher returns a copy of the Parser configured with an SSRF-safe fetch.Executor
// for anonymous syndication photo extraction on pure-image, mixed, and /photo/<N> URLs.
func (p *Parser) WithFetcher(fetcher fetch.Executor) *Parser {
	if p == nil {
		return &Parser{fetcher: fetcher}
	}
	cp := *p
	cp.fetcher = fetcher
	return &cp
}

// ValidateTombstoneFallback validates the -x-tombstone-fallback startup flag.
func ValidateTombstoneFallback(mode string) error {
	switch mode {
	case TombstoneFallbackOff, TombstoneFallbackFxTwitter:
		return nil
	default:
		return fmt.Errorf("x-tombstone-fallback must be %s or %s", TombstoneFallbackOff, TombstoneFallbackFxTwitter)
	}
}

// WithTombstoneFallback returns a copy of the Parser configured with the given
// TweetTombstone fallback mode ("off" or "fxtwitter").
func (p *Parser) WithTombstoneFallback(mode string) (*Parser, error) {
	if err := ValidateTombstoneFallback(mode); err != nil {
		return nil, err
	}
	var cp Parser
	if p != nil {
		cp = *p
	}
	cp.tombstoneFallback = mode
	return &cp, nil
}

// TombstoneFallback reports the configured TweetTombstone fallback mode ("off" or "fxtwitter").
func (p *Parser) TombstoneFallback() string {
	if p != nil && p.tombstoneFallback == TombstoneFallbackFxTwitter {
		return TombstoneFallbackFxTwitter
	}
	return TombstoneFallbackOff
}

func (p *Parser) fxtwitterEnabled() bool {
	return p != nil && p.tombstoneFallback == TombstoneFallbackFxTwitter
}

// ExtractTweetTarget validates an X / Twitter status URL and returns:
//   - tweetID: the numeric status ID
//   - canonicalURL: the sanitized URL safe to pass to yt-dlp
//   - selectedIndex: optional 1-based /video/<N> or /photo/<N> index (0 if absent)
//   - ok: whether the input URL is a valid X status URL
func ExtractTweetTarget(raw string) (string, string, int, bool) {
	tweetID, canonicalURL, _, selectedIndex, ok := extractTweetTarget(raw)
	return tweetID, canonicalURL, selectedIndex, ok
}

func extractTweetTarget(raw string) (string, string, string, int, bool) {
	if unified.MediaURL(raw) == "" || len(raw) > 2048 {
		return "", "", "", 0, false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' {
			return "", "", "", 0, false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" {
		return "", "", "", 0, false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", "", "", 0, false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || (scheme == "https" && n != 443) || (scheme == "http" && n != 80) {
			return "", "", "", 0, false
		}
	}
	host := strings.ToLower(u.Hostname())
	switch host {
	case "x.com", "www.x.com", "mobile.x.com", "m.x.com",
		"twitter.com", "www.twitter.com", "mobile.twitter.com", "m.twitter.com":
	default:
		return "", "", "", 0, false
	}

	segments := splitNonEmptyPath(u.EscapedPath())
	var tweetID string
	var tail []string

	switch {
	case len(segments) >= 3 && strings.EqualFold(segments[0], "i") &&
		(strings.EqualFold(segments[1], "status") || strings.EqualFold(segments[1], "statuses")):
		tweetID = segments[2]
		tail = segments[3:]
	case len(segments) >= 4 && strings.EqualFold(segments[0], "i") &&
		strings.EqualFold(segments[1], "web") &&
		(strings.EqualFold(segments[2], "status") || strings.EqualFold(segments[2], "statuses")):
		tweetID = segments[3]
		tail = segments[4:]
	case len(segments) >= 3 &&
		(strings.EqualFold(segments[1], "status") || strings.EqualFold(segments[1], "statuses")):
		handle := segments[0]
		if !screenNamePattern.MatchString(handle) || reservedHandles[strings.ToLower(handle)] {
			return "", "", "", 0, false
		}
		tweetID = segments[2]
		tail = segments[3:]
	default:
		return "", "", "", 0, false
	}

	if !tweetIDPattern.MatchString(tweetID) {
		return "", "", "", 0, false
	}

	selectedKind := ""
	selectedIndex := 0
	if len(tail) > 0 {
		if len(tail) != 2 {
			return "", "", "", 0, false
		}
		kind := strings.ToLower(tail[0])
		if kind != "video" && kind != "photo" {
			return "", "", "", 0, false
		}
		idx, err := strconv.Atoi(tail[1])
		if err != nil || idx < 1 || idx > maxTweetVideos {
			return "", "", "", 0, false
		}
		selectedKind = kind
		selectedIndex = idx
	}

	canonicalURL := "https://x.com/i/status/" + tweetID
	return tweetID, canonicalURL, selectedKind, selectedIndex, true
}

// AllowedTCoURL validates whether raw is a syntactically safe HTTP/HTTPS t.co
// shortlink URL with exact host t.co, standard port, no userinfo, length <= 2048,
// and a single-segment alphanumeric code of 1..32 characters.
func AllowedTCoURL(raw string) bool {
	_, ok := extractTCoCode(raw)
	return ok
}

func extractTCoCode(raw string) (string, bool) {
	if raw == "" || len(raw) > 2048 {
		return "", false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' {
			return "", false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || strings.HasSuffix(u.Host, ":") {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	if !strings.EqualFold(u.Hostname(), tCoHost) {
		return "", false
	}
	if port := u.Port(); port != "" {
		if !((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) {
			return "", false
		}
	}
	escapedPath := u.EscapedPath()
	if !strings.HasPrefix(escapedPath, "/") || strings.Contains(escapedPath, "%") ||
		strings.HasPrefix(escapedPath, "//") || strings.HasSuffix(escapedPath, "//") {
		return "", false
	}
	code := strings.TrimSuffix(escapedPath[1:], "/")
	if !tCoCodePattern.MatchString(code) {
		return "", false
	}
	return code, true
}

func isTCoHostURL(raw string) bool {
	sep := strings.Index(raw, "://")
	if sep <= 0 {
		return false
	}
	rest := raw[sep+3:]
	if end := strings.IndexAny(rest, "/?#"); end >= 0 {
		rest = rest[:end]
	}
	if at := strings.LastIndexByte(rest, '@'); at >= 0 {
		rest = rest[at+1:]
	}
	host := rest
	if h, _, err := net.SplitHostPort(rest); err == nil {
		host = h
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return host == tCoHost || strings.HasSuffix(host, "."+tCoHost)
}

func (p *Parser) expandTCoURL(ctx context.Context, code string) (string, string, string, int, string, unified.Object, error) {
	if p == nil || p.fetcher == nil {
		return "", "", "", 0, "", unified.ContractError("UPSTREAM_UNAVAILABLE", "当前平台解析服务暂不可用，请稍后重试", true), nil
	}
	reqURL := "https://" + tCoHost + "/" + code
	hdr := make(http.Header)
	hdr.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	hdr.Set("Accept-Language", "en-US,en;q=0.9")

	hopCtx, cancel := context.WithTimeout(ctx, tCoExpandTimeout)
	defer cancel()

	resp, err := p.fetcher.Do(hopCtx, fetch.Request{
		Method: http.MethodGet,
		URL:    reqURL,
		Header: hdr,
		Policy: fetch.Policy{
			Purpose:          "x_tco_expand",
			AllowedURL:       AllowedTCoURL,
			Timeout:          tCoExpandTimeout,
			MaxBytes:         tCoExpandMaxBytes,
			FollowRedirects:  false,
			ReadRedirectBody: false,
			AutoReferer:      false,
			MaxRedirects:     0,
		},
	})
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
			return "", "", "", 0, "", nil, ctxErr
		}
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(hopCtx.Err(), context.DeadlineExceeded) {
			return "", "", "", 0, "", unified.ContractError("UPSTREAM_TIMEOUT", "上游短链展开超时，请稍后重试", true), nil
		}
		if errors.Is(err, fetch.ErrLimit) || errors.Is(err, fetch.ErrPolicy) {
			return "", "", "", 0, "", unified.ContractError("UPSTREAM_INVALID_RESPONSE", "上游短链响应异常或超出大小限制", false), nil
		}
		return "", "", "", 0, "", unified.ContractError("UPSTREAM_UNAVAILABLE", "当前平台解析服务暂不可用，请稍后重试", true), nil
	}

	var candidate string
	switch resp.StatusCode {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		locations := resp.Header.Values("Location")
		if len(locations) != 1 || strings.TrimSpace(locations[0]) == "" {
			return "", "", "", 0, "", unified.ContractError("UPSTREAM_INVALID_RESPONSE", "上游短链重定向响应缺少有效目标", false), nil
		}
		candidate = strings.TrimSpace(locations[0])
	case http.StatusOK:
		if len(bytes.TrimSpace(resp.Body)) == 0 {
			return "", "", "", 0, "", unified.ContractError("UPSTREAM_INVALID_RESPONSE", "上游短链响应为空", false), nil
		}
		candidate = extractTCoHTMLRedirectTarget(resp.Body)
		if candidate == "" {
			return "", "", "", 0, "", unified.ContractError("INVALID_INPUT", tCoInvalidTargetMsg, false), nil
		}
	case http.StatusNotFound, http.StatusGone:
		return "", "", "", 0, "", unified.ContractError("CONTENT_UNAVAILABLE", "短链不存在或已失效", false), nil
	case http.StatusTooManyRequests:
		return "", "", "", 0, "", unified.ContractError("RATE_LIMITED", "上游访问频率受限，请稍后重试", true), nil
	case http.StatusUnauthorized, http.StatusForbidden:
		return "", "", "", 0, "", unified.ContractError("UPSTREAM_BLOCKED", "该短链受访问限制，无法解析", false), nil
	case http.StatusGatewayTimeout:
		return "", "", "", 0, "", unified.ContractError("UPSTREAM_TIMEOUT", "上游短链展开超时，请稍后重试", true), nil
	default:
		if resp.StatusCode >= 500 {
			return "", "", "", 0, "", unified.ContractError("UPSTREAM_UNAVAILABLE", "当前平台解析服务暂不可用，请稍后重试", true), nil
		}
		return "", "", "", 0, "", unified.ContractError("UPSTREAM_INVALID_RESPONSE", "上游短链响应状态异常", false), nil
	}

	if _, _, _, ok := ExtractTweetTarget(candidate); !ok {
		return "", "", "", 0, "", unified.ContractError("INVALID_INPUT", tCoInvalidTargetMsg, false), nil
	}
	tweetID, canonicalURL, selectedKind, selectedIndex, ok := extractTweetTarget(candidate)
	if !ok {
		return "", "", "", 0, "", unified.ContractError("INVALID_INPUT", tCoInvalidTargetMsg, false), nil
	}
	expandedSource := canonicalURL
	if selectedKind != "" && selectedIndex > 0 {
		expandedSource = fmt.Sprintf("%s/%s/%d", canonicalURL, selectedKind, selectedIndex)
	}
	return tweetID, canonicalURL, selectedKind, selectedIndex, expandedSource, nil, nil
}

func extractTCoHTMLRedirectTarget(body []byte) string {
	htmlText := string(body)
	for _, tag := range tCoMetaTagPattern.FindAllString(htmlText, -1) {
		var isRefresh bool
		var contentVal string
		var hasContent bool
		for _, attr := range tCoHTMLAttrPattern.FindAllStringSubmatch(tag, -1) {
			name := attr[1]
			val := attr[2]
			if val == "" {
				val = attr[3]
			}
			if val == "" {
				val = attr[4]
			}
			if strings.EqualFold(name, "http-equiv") && strings.EqualFold(strings.TrimSpace(html.UnescapeString(val)), "refresh") {
				isRefresh = true
			} else if strings.EqualFold(name, "content") && !hasContent {
				contentVal = val
				hasContent = true
			}
		}
		if isRefresh {
			if hasContent {
				if u := parseMetaRefreshURL(contentVal); u != "" {
					return u
				}
			}
			break
		}
	}

	if m := tCoLocationReplacePattern.FindStringSubmatch(htmlText); len(m) == 3 {
		rawLiteral := m[1]
		if rawLiteral == "" {
			rawLiteral = m[2]
		}
		if unescaped, ok := unescapeJSStringLiteral(rawLiteral); ok && unescaped != "" {
			return unescaped
		}
	}
	return ""
}

func parseMetaRefreshURL(content string) string {
	unescaped := html.UnescapeString(content)
	m := tCoMetaRefreshURLPattern.FindStringSubmatch(unescaped)
	if len(m) != 2 {
		return ""
	}
	target := strings.TrimSpace(m[1])
	if len(target) > 0 && (target[0] == '\'' || target[0] == '"') {
		quote := target[0]
		rest := target[1:]
		if end := strings.IndexByte(rest, quote); end >= 0 {
			target = rest[:end]
		} else {
			target = rest
		}
	}
	return strings.TrimSpace(target)
}

func unescapeJSStringLiteral(raw string) (string, bool) {
	var b strings.Builder
	b.Grow(len(raw))
	for i := 0; i < len(raw); i++ {
		ch := raw[i]
		if ch != '\\' {
			b.WriteByte(ch)
			continue
		}
		i++
		if i >= len(raw) {
			return "", false
		}
		switch raw[i] {
		case '\\', '/', '"', '\'':
			b.WriteByte(raw[i])
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 't':
			b.WriteByte('\t')
		case 'v':
			b.WriteByte('\v')
		case 'x':
			if i+2 >= len(raw) {
				return "", false
			}
			v, err := strconv.ParseUint(raw[i+1:i+3], 16, 8)
			if err != nil {
				return "", false
			}
			b.WriteRune(rune(v))
			i += 2
		case 'u':
			if i+4 >= len(raw) {
				return "", false
			}
			u1, err := strconv.ParseUint(raw[i+1:i+5], 16, 16)
			if err != nil {
				return "", false
			}
			i += 4
			r := rune(u1)
			if utf16.IsSurrogate(r) && i+6 < len(raw) && raw[i+1] == '\\' && raw[i+2] == 'u' {
				if u2, err2 := strconv.ParseUint(raw[i+3:i+7], 16, 16); err2 == nil {
					if combined := utf16.DecodeRune(r, rune(u2)); combined != '\uFFFD' {
						r = combined
						i += 6
					}
				}
			}
			b.WriteRune(r)
		default:
			b.WriteByte(raw[i])
		}
	}
	return strings.TrimSpace(b.String()), true
}

// AllowedTargetURL enforces that only canonical X status URLs reach ytengine.
func AllowedTargetURL(raw string) bool {
	_, canonical, _, ok := ExtractTweetTarget(raw)
	return ok && raw == canonical
}

// AllowedOutboundHost restricts yt-dlp subprocess outbound connections to official X/Twitter domains.
func AllowedOutboundHost(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	for _, domain := range []string{"x.com", "twitter.com", "twimg.com"} {
		if h == domain || strings.HasSuffix(h, "."+domain) {
			return true
		}
	}
	return false
}

// AllowedExtractors returns the Twitter-family yt-dlp extractor names verified
// from pinned yt-dlp 2026.10.26 (--list-extractors), excluding generic and
// twitter:shortener (t.co) so embedded external links never fall back to generic.
func AllowedExtractors() []string {
	return []string{
		"twitter",
		"twitter:amplify",
		"twitter:broadcast",
		"twitter:card",
		"twitter:spaces",
	}
}

func isPureSyndicationPhotoTweet(st *syndicationTweet) bool {
	return st != nil && !st.Tombstone && len(st.Photos) > 0 && !st.HasVideo
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
	return syndicationSupplementTimeout
}

func (p *Parser) handleExtractError(ctx context.Context, err error) (unified.Object, error) {
	if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
		return nil, ctxErr
	}
	var engineErr *ytengine.Error
	if errors.As(err, &engineErr) {
		resp := unified.ContractError(string(engineErr.Code), engineErr.Message, engineErr.Retryable)
		if engineErr.Retryable && engineErr.RetryAfter > 0 {
			unified.Map(resp["error"])["retry_after_seconds"] = engineErr.RetryAfter
		}
		return resp, nil
	}
	return unified.ContractError("UPSTREAM_UNAVAILABLE", "当前平台解析服务暂不可用，请稍后重试", true), nil
}

type parseTarget struct {
	tweetID       string
	canonicalURL  string
	source        string
	selectedKind  string
	selectedIndex int
}

type syndicationResult struct {
	tweet *syndicationTweet
	err   error
}

type ytExtractResult struct {
	info *ytengine.Info
	err  error
}

type syndicationAsyncState struct {
	ch                <-chan syndicationResult
	cancel            context.CancelFunc
	timer             *time.Timer
	got               bool
	res               syndicationResult
	supplementExpired bool
}

func (s *syndicationAsyncState) awaitFull(ctx context.Context) (*syndicationTweet, error) {
	if !s.got {
		select {
		case s.res = <-s.ch:
			s.got = true
		case <-ctx.Done():
			s.cancel()
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, errSyndicationTimeout
			}
			return nil, ctx.Err()
		}
	}
	return s.res.tweet, s.res.err
}

// Parse extracts X / Twitter status metadata, prioritizing the official
// login-free syndication endpoint for video and photo tweets before falling
// back to ytengine when syndication fails or lacks complete video metadata.
func (p *Parser) Parse(ctx context.Context, source string, now int64) (unified.Object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	target, errEnv, err := p.resolveParseTarget(ctx, source)
	if err != nil || errEnv != nil {
		return errEnv, err
	}

	// /photo/<N>: fetch photo list directly from public syndication without spawning yt-dlp.
	if target.selectedKind == "photo" && p.fetcher != nil {
		return p.parseSelectedPhoto(ctx, target.tweetID, target.source, target.selectedIndex, now)
	}
	if p.fetcher == nil {
		info, err := p.engine.Extract(ctx, target.canonicalURL)
		if err != nil {
			return p.handleExtractError(ctx, err)
		}
		populateMissingMP4Sizes(ctx, info, p.sizeProber)
		return AdaptInfo(info, target.tweetID, target.source, target.selectedIndex, now), nil
	}

	synCh, cancelSyn := p.startSyndicationAsync(ctx, target.tweetID)
	defer cancelSyn()

	supplementTimer := time.NewTimer(p.effectiveSupplementTimeout())
	defer supplementTimer.Stop()

	synState := &syndicationAsyncState{ch: synCh, cancel: cancelSyn, timer: supplementTimer}

	// Stage 1: Try official login-free syndication first without spawning yt-dlp.
	if stage1Env, done, stage1Err := p.awaitStage1Syndication(ctx, synState, target, now); done {
		return stage1Env, stage1Err
	}

	// Stage 2: Syndication failed, timed out past supplementTimeout, returned
	// Tombstone, or lacked complete video metadata -> fall back to yt-dlp.
	ytCh, cancelYT := p.startYTDLPExtractAsync(ctx, target.canonicalURL)
	defer cancelYT()

	ytRes, raceEnv, done, raceErr := p.awaitStage2YTDLPOrFastPath(ctx, synState, ytCh, cancelYT, target, now)
	if done {
		return raceEnv, raceErr
	}

	if ytRes.err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
			return nil, ctxErr
		}
		var engineErr *ytengine.Error
		hasEngineErr := errors.As(ytRes.err, &engineErr)
		if hasEngineErr && engineErr.LocalBusy {
			cancelSyn()
			return p.handleExtractError(ctx, ytRes.err)
		}
		noContent := hasEngineErr && engineErr.Code == ytengine.CodeContentUnavailable
		return p.resolvePostYTDLPFallback(ctx, synState, target, now, noContent, nil, ytRes.err)
	}

	info := ytRes.info
	populateMissingMP4Sizes(ctx, info, p.sizeProber)
	adapted := AdaptInfo(info, target.tweetID, target.source, target.selectedIndex, now)
	if unified.Str(adapted["code"]) == "OK" {
		return p.attachSyndicationPhotosIfReady(ctx, synState, info, adapted, target, now)
	}

	return p.resolvePostYTDLPFallback(ctx, synState, target, now, unified.Str(adapted["code"]) == "NO_MEDIA", adapted, nil)
}

func (p *Parser) resolveParseTarget(ctx context.Context, source string) (parseTarget, unified.Object, error) {
	if isTCoHostURL(source) {
		code, validTCo := extractTCoCode(source)
		if !validTCo {
			return parseTarget{}, unified.ContractError("INVALID_INPUT", "请输入有效的 X (Twitter) 推文链接", false), nil
		}
		if p == nil || p.fetcher == nil {
			return parseTarget{}, unified.ContractError("UPSTREAM_UNAVAILABLE", "当前平台解析服务暂不可用，请稍后重试", true), nil
		}
		if p.engine == nil || !p.engine.Enabled() {
			return parseTarget{}, unified.ContractError("SERVICE_NOT_CONFIGURED", "当前平台解析服务暂不可用", false), nil
		}
		tweetID, canonicalURL, selectedKind, selectedIndex, expandedSource, errEnv, expandErr := p.expandTCoURL(ctx, code)
		if expandErr != nil {
			return parseTarget{}, nil, expandErr
		}
		if errEnv != nil {
			return parseTarget{}, errEnv, nil
		}
		return parseTarget{
			tweetID:       tweetID,
			canonicalURL:  canonicalURL,
			source:        expandedSource,
			selectedKind:  selectedKind,
			selectedIndex: selectedIndex,
		}, nil, nil
	}

	tweetID, canonicalURL, selectedKind, selectedIndex, ok := extractTweetTarget(source)
	if !ok {
		return parseTarget{}, unified.ContractError("INVALID_INPUT", "请输入有效的 X (Twitter) 推文链接", false), nil
	}
	if p == nil || p.engine == nil || !p.engine.Enabled() {
		return parseTarget{}, unified.ContractError("SERVICE_NOT_CONFIGURED", "当前平台解析服务暂不可用", false), nil
	}
	return parseTarget{
		tweetID:       tweetID,
		canonicalURL:  canonicalURL,
		source:        source,
		selectedKind:  selectedKind,
		selectedIndex: selectedIndex,
	}, nil, nil
}

func (p *Parser) parseSelectedPhoto(ctx context.Context, tweetID, source string, selectedIndex int, now int64) (unified.Object, error) {
	st, synErr := fetchSyndicationTweet(ctx, p.fetcher, tweetID)
	if synErr != nil {
		if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
			return nil, ctxErr
		}
		return syndicationContractError(synErr), nil
	}
	if st != nil && st.Tombstone {
		return p.resolveTombstone(ctx, tweetID, source, "photo", selectedIndex, now)
	}
	photo, found := st.photoAt(selectedIndex)
	if !found {
		return unified.ContractError("CONTENT_UNAVAILABLE", fmt.Sprintf("所选第 %d 张图片不存在或不可用", selectedIndex), false), nil
	}
	return buildSyndicationPhotoEnvelope(st, []syndicationPhoto{photo}, tweetID, source, now), nil
}

func canSyndicationFastPath(st *syndicationTweet) bool {
	if st == nil || st.Tombstone {
		return false
	}
	return st.canUseSyndicationVideos() || isPureSyndicationPhotoTweet(st)
}

func (p *Parser) trySyndicationFastPath(ctx context.Context, st *syndicationTweet, target parseTarget, now int64) (unified.Object, bool) {
	if st == nil || st.Tombstone {
		return nil, false
	}
	if st.canUseSyndicationVideos() {
		info := st.toYTInfo(target.tweetID)
		populateMissingMP4Sizes(ctx, info, p.sizeProber)
		adapted := adaptInfoWithPhotos(info, st.Photos, target.tweetID, target.source, target.selectedIndex, now)
		if unified.Str(adapted["code"]) == "OK" {
			return adapted, true
		}
		return nil, false
	}
	if isPureSyndicationPhotoTweet(st) {
		if target.selectedKind == "video" {
			return unified.ContractError("CONTENT_UNAVAILABLE", "未找到可用的视频或该推文已不可访问", false), true
		}
		return buildSyndicationPhotoEnvelope(st, st.Photos, target.tweetID, target.source, now), true
	}
	return nil, false
}

func (p *Parser) startSyndicationAsync(parentCtx context.Context, tweetID string) (<-chan syndicationResult, context.CancelFunc) {
	synCtx, cancelSyn := context.WithCancel(parentCtx)
	synCh := make(chan syndicationResult, 1)
	fetcher := p.fetcher
	go func() {
		var completed bool
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("x: syndication goroutine panic recovered: panic_type=%T", recovered)
				synCh <- syndicationResult{err: errors.New("x syndication internal panic")}
			} else if !completed {
				synCh <- syndicationResult{err: errors.New("x syndication internal panic")}
			}
		}()
		st, synErr := fetchSyndicationTweet(synCtx, fetcher, tweetID)
		completed = true
		synCh <- syndicationResult{tweet: st, err: synErr}
	}()
	return synCh, cancelSyn
}

func (p *Parser) startYTDLPExtractAsync(parentCtx context.Context, canonicalURL string) (<-chan ytExtractResult, context.CancelFunc) {
	ytCtx, cancelYT := context.WithCancel(parentCtx)
	ytCh := make(chan ytExtractResult, 1)
	engine := p.engine
	go func() {
		var completed bool
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("x: ytdlp goroutine panic recovered: panic_type=%T", recovered)
				ytCh <- ytExtractResult{err: errors.New("x ytdlp internal panic")}
			} else if !completed {
				ytCh <- ytExtractResult{err: errors.New("x ytdlp internal panic")}
			}
		}()
		info, ytErr := engine.Extract(ytCtx, canonicalURL)
		completed = true
		ytCh <- ytExtractResult{info: info, err: ytErr}
	}()
	return ytCh, cancelYT
}

func (p *Parser) awaitStage1Syndication(
	ctx context.Context,
	syn *syndicationAsyncState,
	target parseTarget,
	now int64,
) (unified.Object, bool, error) {
	select {
	case syn.res = <-syn.ch:
		syn.got = true
		if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
			return nil, true, ctxErr
		}
		if syn.res.err == nil && canSyndicationFastPath(syn.res.tweet) {
			if fastEnv, ok := p.trySyndicationFastPath(ctx, syn.res.tweet, target, now); ok {
				if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
					return nil, true, ctxErr
				}
				return fastEnv, true, nil
			}
		}
		return nil, false, nil
	case <-syn.timer.C:
		syn.supplementExpired = true
		return nil, false, nil
	case <-ctx.Done():
		syn.cancel()
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, true, ctx.Err()
		}
		return unified.ContractError("UPSTREAM_TIMEOUT", "上游解析超时，请稍后重试", true), true, nil
	}
}

func (p *Parser) awaitStage2YTDLPOrFastPath(
	ctx context.Context,
	syn *syndicationAsyncState,
	ytCh <-chan ytExtractResult,
	cancelYT context.CancelFunc,
	target parseTarget,
	now int64,
) (ytExtractResult, unified.Object, bool, error) {
	var (
		gotYT bool
		ytRes ytExtractResult
	)
	if !syn.got {
		select {
		case syn.res = <-syn.ch:
			syn.got = true
			if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
				cancelYT()
				return ytExtractResult{}, nil, true, ctxErr
			}
			if syn.res.err == nil && canSyndicationFastPath(syn.res.tweet) {
				select {
				case ytRes = <-ytCh:
					gotYT = true
					var engineErr *ytengine.Error
					if ytRes.err != nil && errors.As(ytRes.err, &engineErr) && engineErr.LocalBusy {
						env, err := p.handleExtractError(ctx, ytRes.err)
						return ytExtractResult{}, env, true, err
					}
				default:
				}
				cancelYT()
				if fastEnv, ok := p.trySyndicationFastPath(ctx, syn.res.tweet, target, now); ok {
					if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
						return ytExtractResult{}, nil, true, ctxErr
					}
					return ytExtractResult{}, fastEnv, true, nil
				}
			}
		case ytRes = <-ytCh:
			gotYT = true
		case <-ctx.Done():
			cancelYT()
			syn.cancel()
			if errors.Is(ctx.Err(), context.Canceled) {
				return ytExtractResult{}, nil, true, ctx.Err()
			}
			return ytExtractResult{}, unified.ContractError("UPSTREAM_TIMEOUT", "上游解析超时，请稍后重试", true), true, nil
		}
	}
	if !gotYT {
		select {
		case ytRes = <-ytCh:
		case <-ctx.Done():
			cancelYT()
			syn.cancel()
			if errors.Is(ctx.Err(), context.Canceled) {
				return ytExtractResult{}, nil, true, ctx.Err()
			}
			return ytExtractResult{}, unified.ContractError("UPSTREAM_TIMEOUT", "上游解析超时，请稍后重试", true), true, nil
		}
	}
	return ytRes, nil, false, nil
}

func (p *Parser) attachSyndicationPhotosIfReady(
	ctx context.Context,
	syn *syndicationAsyncState,
	info *ytengine.Info,
	adapted unified.Object,
	target parseTarget,
	now int64,
) (unified.Object, error) {
	if !syn.got {
		if syn.supplementExpired {
			select {
			case syn.res = <-syn.ch:
				syn.got = true
			default:
				syn.cancel()
			}
		} else {
			select {
			case syn.res = <-syn.ch:
				syn.got = true
			case <-syn.timer.C:
				syn.cancel()
			case <-ctx.Done():
				syn.cancel()
			}
		}
	}
	if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
		return nil, ctxErr
	}
	if target.selectedKind == "" && syn.got && syn.res.err == nil && syn.res.tweet != nil && len(syn.res.tweet.Photos) > 0 {
		withPhotos := adaptInfoWithPhotos(info, syn.res.tweet.Photos, target.tweetID, target.source, target.selectedIndex, now)
		if unified.Str(withPhotos["code"]) == "OK" {
			return withPhotos, nil
		}
	}
	return adapted, nil
}

func (p *Parser) resolvePostYTDLPFallback(
	ctx context.Context,
	syn *syndicationAsyncState,
	target parseTarget,
	now int64,
	ytReportedNoContent bool,
	adaptedFallback unified.Object,
	ytErr error,
) (unified.Object, error) {
	st, synErr := syn.awaitFull(ctx)
	if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
		return nil, ctxErr
	}
	if synErr == nil && canSyndicationFastPath(st) {
		if fastEnv, ok := p.trySyndicationFastPath(ctx, st, target, now); ok {
			if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
				return nil, ctxErr
			}
			return fastEnv, nil
		}
	}
	if synErr == nil && st != nil && st.Tombstone {
		return p.resolveTombstone(ctx, target.tweetID, target.source, target.selectedKind, target.selectedIndex, now)
	}
	if target.selectedKind == "" && ytReportedNoContent {
		if synErr == nil && isPureTextSyndicationTweet(st) {
			return unified.ContractError("NO_MEDIA", "作品未提供可用媒体", false), nil
		}
		if synErr != nil && !errors.Is(synErr, errSyndicationNotFound) {
			return syndicationContractError(synErr), nil
		}
	}
	if ytErr != nil {
		return p.handleExtractError(ctx, ytErr)
	}
	return adaptedFallback, nil
}

func isPureTextSyndicationTweet(st *syndicationTweet) bool {
	return st != nil && !st.Tombstone && len(st.Photos) == 0 && !st.HasVideo && !st.HasCard && !st.HasQuotedMedia
}
