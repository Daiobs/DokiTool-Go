package ytgeneric

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"strings"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

// DefaultGenericConcurrency is the default isolated concurrency limit for
// Tier-2 yt-dlp generic named extractors.
const DefaultGenericConcurrency = 2

// PlatformUnmatched is the dedicated bounded telemetry bucket for Tier-2 generic
// parse failures where no named yt-dlp extractor matched (decoupled from pre-routing
// invalid inputs recorded under "unknown").
const PlatformUnmatched = "ytdlp_unmatched"

// GenericExtractorArgs returns the hardened --use-extractors selector list for
// Tier-2 generic named extraction: allow all named yt-dlp extractors ("default")
// while explicitly disabling the catch-all generic HTML scraper ("-generic") and
// all Tier-1 core-16 extractor families so core platforms never route through Tier-2.
func GenericExtractorArgs() []string {
	return []string{
		"default",
		"-generic",
		"-douyin.*",
		"-iesdouyin.*",
		"-bilibili.*",
		"-weibo.*",
		"-toutiao.*",
		"-kuaishou.*",
		"-pipixia.*",
		"-pipigx.*",
		"-zuiyou.*",
		"-xiaohongshu.*",
		"-rednote.*",
		"-pinterest.*",
		"-tiktok.*",
		"-twitter.*",
		"-youtube.*",
		"-instagram.*",
		"-facebook.*",
		"-tumblr.*",
	}
}

// AllowedGenericOutboundHost validates whether host is a syntactically valid
// public multi-label DNS domain permitted for Tier-2 outbound/media access.
// IP literals, single-label hosts, invalid DNS labels, local/internal/reserved
// suffixes, and DokiTool's own domains are rejected fail-closed.
func AllowedGenericOutboundHost(host string) bool {
	if host == "" {
		return false
	}
	for i := 0; i < len(host); i++ {
		if host[i] <= 0x20 || host[i] >= 0x7f {
			return false
		}
	}
	h := strings.ToLower(strings.TrimSuffix(host, "."))
	if len(h) == 0 || len(h) > 253 {
		return false
	}
	if _, err := netip.ParseAddr(h); err == nil {
		return false
	}
	if net.ParseIP(h) != nil {
		return false
	}
	if !strings.ContainsRune(h, '.') {
		return false
	}

	labels := strings.Split(h, ".")
	if len(labels) < 2 {
		return false
	}
	for _, label := range labels {
		if !isValidDNSLabel(label) {
			return false
		}
	}
	if !isValidPublicTLD(labels[len(labels)-1]) {
		return false
	}

	if h == "localhost" || strings.HasSuffix(h, ".localhost") ||
		h == "local" || strings.HasSuffix(h, ".local") ||
		h == "internal" || strings.HasSuffix(h, ".internal") ||
		h == "localdomain" || strings.HasSuffix(h, ".localdomain") ||
		h == "home.arpa" || strings.HasSuffix(h, ".home.arpa") ||
		h == "invalid" || strings.HasSuffix(h, ".invalid") ||
		h == "lan" || strings.HasSuffix(h, ".lan") ||
		h == "corp" || strings.HasSuffix(h, ".corp") ||
		h == "intranet" || strings.HasSuffix(h, ".intranet") ||
		h == "private" || strings.HasSuffix(h, ".private") ||
		h == "dokitool.com" || strings.HasSuffix(h, ".dokitool.com") {
		return false
	}
	return true
}

func isValidDNSLabel(label string) bool {
	if len(label) < 1 || len(label) > 63 {
		return false
	}
	if label[0] == '-' || label[len(label)-1] == '-' {
		return false
	}
	for i := 0; i < len(label); i++ {
		c := label[i]
		isLower := c >= 'a' && c <= 'z'
		isDigit := c >= '0' && c <= '9'
		if !isLower && !isDigit && c != '-' {
			return false
		}
	}
	return true
}

func isValidPublicTLD(tld string) bool {
	if len(tld) < 2 {
		return false
	}
	if strings.HasPrefix(tld, "xn--") {
		return len(tld) >= 5
	}
	for i := 0; i < len(tld); i++ {
		if tld[i] < 'a' || tld[i] > 'z' {
			return false
		}
	}
	return true
}

// NormalizeGenericInputURL validates and normalizes a user-supplied Tier-2 URL.
// Fragments, userinfo, non-default ports, unsafe characters, private/local/self
// hosts, IP literals, and bare root URLs without path or query are rejected.
func NormalizeGenericInputURL(raw string) (string, bool) {
	if raw == "" || len(raw) > 2048 || strings.HasPrefix(raw, "-") {
		return "", false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' || r == '#' {
			return "", false
		}
	}
	if unified.MediaURL(raw) == "" {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Fragment != "" {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	if strings.HasSuffix(u.Host, ":") {
		return "", false
	}
	if port := u.Port(); port != "" {
		if !((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) {
			return "", false
		}
	}
	rawHost := u.Hostname()
	if !AllowedGenericOutboundHost(rawHost) {
		return "", false
	}
	if strings.Trim(u.EscapedPath(), "/") == "" && u.RawQuery == "" {
		return "", false
	}
	u.Scheme = scheme
	u.Host = strings.ToLower(strings.TrimSuffix(rawHost, "."))
	return u.String(), true
}

// AllowedGenericInputURL reports whether raw passes NormalizeGenericInputURL.
func AllowedGenericInputURL(raw string) bool {
	_, ok := NormalizeGenericInputURL(raw)
	return ok
}

// AllowedGenericMediaURL validates a Tier-2 media or thumbnail URL syntactically.
func AllowedGenericMediaURL(raw string) bool {
	if raw == "" || len(raw) > 8192 {
		return false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' || r == '#' {
			return false
		}
	}
	if unified.MediaURL(raw) == "" {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Fragment != "" {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return false
	}
	if strings.HasSuffix(u.Host, ":") {
		return false
	}
	if port := u.Port(); port != "" {
		if !((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) {
			return false
		}
	}
	return AllowedGenericOutboundHost(u.Hostname())
}

var blockedCoreExtractorFamilies = []string{
	"douyin",
	"iesdouyin",
	"bilibili",
	"bili",
	"weibo",
	"toutiao",
	"kuaishou",
	"pipixia",
	"pipigx",
	"zuiyou",
	"xiaohongshu",
	"rednote",
	"pinterest",
	"tiktok",
	"twitter",
	"youtube",
	"instagram",
	"facebook",
	"tumblr",
}

var blockedNormalizedPlatforms = map[string]bool{
	"generic":         true,
	"all":             true,
	"unknown":         true,
	"ytdlp_generic":   true,
	"ytdlp_other":     true,
	"ytdlp_unmatched": true,
	"douyin":          true,
	"iesdouyin":       true,
	"bilibili":        true,
	"bili":            true,
	"weibo":           true,
	"toutiao":         true,
	"kuaishou":        true,
	"pipixia":         true,
	"pipigx":          true,
	"zuiyou":          true,
	"xiaohongshu":     true,
	"rednote":         true,
	"pinterest":       true,
	"tiktok":          true,
	"twitter":         true,
	"x":               true,
	"youtube":         true,
	"instagram":       true,
	"facebook":        true,
	"tumblr":          true,
}

func isBlockedExtractorIdentity(raw string) bool {
	lower := strings.ToLower(strings.TrimSpace(raw))
	if lower == "" {
		return false
	}
	if lower == "generic" || strings.HasPrefix(lower, "generic:") {
		return true
	}
	head := lower
	if idx := strings.IndexAny(head, ":_-"); idx >= 0 {
		head = head[:idx]
	}
	if head == "x" || head == "generic" {
		return true
	}
	for _, fam := range blockedCoreExtractorFamilies {
		if head == fam || strings.HasPrefix(lower, fam) {
			return true
		}
	}
	return false
}

// NormalizeExtractorPlatform maps yt-dlp extractor_key / extractor names onto a
// canonical dynamic platform identifier matching ^[a-z][a-z0-9_]{0,31}$, while
// rejecting generic fallback and all Tier-1 core-16 extractor families.
func NormalizeExtractorPlatform(extractorKey, extractor string) string {
	if isBlockedExtractorIdentity(extractorKey) || isBlockedExtractorIdentity(extractor) {
		return ""
	}
	raw := strings.ToLower(strings.TrimSpace(extractorKey))
	if raw == "" {
		raw = strings.ToLower(strings.TrimSpace(extractor))
	}
	if raw == "" {
		return ""
	}

	var b strings.Builder
	b.Grow(len(raw))
	lastUnderscore := false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		isLower := c >= 'a' && c <= 'z'
		isDigit := c >= '0' && c <= '9'
		if isLower || isDigit {
			b.WriteByte(c)
			lastUnderscore = false
		} else if !lastUnderscore {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	clean := strings.Trim(b.String(), "_")
	if clean == "" || blockedNormalizedPlatforms[clean] {
		return ""
	}
	if clean[0] >= '0' && clean[0] <= '9' {
		clean = "site_" + clean
	}
	if len(clean) > 32 {
		clean = clean[:32]
	}
	clean = strings.TrimRight(clean, "_")
	if len(clean) == 0 || len(clean) > 32 || blockedNormalizedPlatforms[clean] {
		return ""
	}
	if clean[0] < 'a' || clean[0] > 'z' {
		return ""
	}
	for i := 1; i < len(clean); i++ {
		c := clean[i]
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
			return ""
		}
	}
	return clean
}

// GenericParser implements api.Adapter for Tier-2 named yt-dlp extractors.
type GenericParser struct {
	engine     ytengine.Extractor
	sizeProber ytengine.SizeProber
	resolver   ytengine.Resolver
}

// NewGenericNamed creates a Tier-2 generic named-extractor parser.
func NewGenericNamed(engine ytengine.Extractor, prober ytengine.SizeProber, resolver ytengine.Resolver) *GenericParser {
	return &GenericParser{
		engine:     engine,
		sizeProber: prober,
		resolver:   resolver,
	}
}

func (p *GenericParser) verifyPublicHost(ctx context.Context, host string) (bool, error) {
	if p == nil || p.resolver == nil {
		return true, nil
	}
	cleanHost := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if !AllowedGenericOutboundHost(cleanHost) {
		return false, nil
	}
	ips, err := p.resolver.LookupNetIP(ctx, "ip", cleanHost)
	if err != nil {
		return false, err
	}
	if len(ips) == 0 {
		return false, nil
	}
	for _, ip := range ips {
		if !fetch.PublicIP(ip) {
			return false, nil
		}
	}
	return true, nil
}

// ExtractExtractorFromStderr extracts the yt-dlp extractor identifier from
// stderr lines formatted as "ERROR: [<extractor>] ..." or "WARNING: [<extractor>] ...".
func ExtractExtractorFromStderr(stderr string) string {
	return ytengine.ExtractExtractorFromStderr(stderr)
}

// AttributeGenericFailurePlatform resolves the bounded telemetry platform bucket for
// a Tier-2 extraction error:
//   - If a named yt-dlp extractor is identifiable (via structured ytengine.Error.Extractor
//     or stderr "ERROR: [<extractor>]" / "WARNING: [<extractor>]") and passes
//     NormalizeExtractorPlatform, returns that normalized platform ID (e.g. "vimeo", "tiktok").
//   - Otherwise (Unsupported URL, [generic], core-16 extractor, empty/unrecognized stderr,
//     or DNS/SSRF/outbound-host rejections), returns PlatformUnmatched ("ytdlp_unmatched").
func AttributeGenericFailurePlatform(err error) string {
	if err == nil {
		return PlatformUnmatched
	}
	var engineErr *ytengine.Error
	if errors.As(err, &engineErr) && engineErr != nil {
		if raw := strings.TrimSpace(engineErr.Extractor); raw != "" {
			if norm := NormalizeExtractorPlatform(raw, ""); norm != "" {
				return norm
			}
			return PlatformUnmatched
		}
		if engineErr.Cause != nil {
			if raw := ytengine.ExtractExtractorFromStderr(engineErr.Cause.Error()); raw != "" {
				if norm := NormalizeExtractorPlatform(raw, ""); norm != "" {
					return norm
				}
				return PlatformUnmatched
			}
		}
		return PlatformUnmatched
	}
	if raw := ytengine.ExtractExtractorFromStderr(err.Error()); raw != "" {
		if norm := NormalizeExtractorPlatform(raw, ""); norm != "" {
			return norm
		}
	}
	return PlatformUnmatched
}

// Parse validates the input URL, enforces public-IP DNS resolution, extracts
// metadata via named yt-dlp extractors, and adapts the result to unified-v1.
func (p *GenericParser) Parse(ctx context.Context, source string, now int64) (unified.Object, error) {
	payload, _, err := p.ParseWithPlatform(ctx, source, now)
	return payload, err
}

// ParseWithPlatform performs Tier-2 generic parsing and returns both the unified-v1
// payload and the attributed bounded platform identifier for telemetry (a normalized
// named platform ID on success or extractor-matched failure, or PlatformUnmatched).
func (p *GenericParser) ParseWithPlatform(ctx context.Context, source string, now int64) (unified.Object, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, PlatformUnmatched, err
	}
	cleanURL, ok := NormalizeGenericInputURL(source)
	if !ok {
		return unified.ContractError("INVALID_INPUT", "请输入有效的公网分享链接", false), PlatformUnmatched, nil
	}
	if p == nil || p.engine == nil || !p.engine.Enabled() {
		return unified.ContractError("SERVICE_NOT_CONFIGURED", "当前平台解析服务暂不可用", false), PlatformUnmatched, nil
	}

	parsedURL, err := url.Parse(cleanURL)
	inputOK := false
	var lookupErr error
	if err == nil {
		lookupCtx, cancel := context.WithTimeout(ctx, defaultInputDNSTimeout)
		inputOK, lookupErr = p.verifyPublicHost(lookupCtx, parsedURL.Hostname())
		cancel()
	}
	if !inputOK {
		if ctxErr := ctx.Err(); ctxErr != nil {
			if errors.Is(ctxErr, context.Canceled) {
				return nil, PlatformUnmatched, ctxErr
			}
			return unified.ContractError("UPSTREAM_TIMEOUT", "解析超时，请稍后重试", true), PlatformUnmatched, nil
		}
		if errors.Is(lookupErr, context.DeadlineExceeded) {
			unified.MarkCallerScopedFailure(ctx)
			return unified.ContractError("UPSTREAM_TIMEOUT", "解析超时，请稍后重试", true), PlatformUnmatched, nil
		}
		return unified.ContractError("UPSTREAM_BLOCKED", "目标地址解析到受限网络，已拒绝访问", false), PlatformUnmatched, nil
	}

	info, err := p.engine.Extract(ctx, cleanURL)
	if err != nil {
		attributed := AttributeGenericFailurePlatform(err)
		if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
			return nil, attributed, ctxErr
		}
		var engineErr *ytengine.Error
		if errors.As(err, &engineErr) {
			if engineErr.UnsupportedURL {
				return unified.ContractError("UNSUPPORTED_PLATFORM", "暂不支持该平台链接解析", false), attributed, nil
			}
			resp := unified.ContractError(string(engineErr.Code), engineErr.Message, engineErr.Retryable)
			if engineErr.Retryable && engineErr.RetryAfter > 0 {
				unified.Map(resp["error"])["retry_after_seconds"] = engineErr.RetryAfter
			}
			return resp, attributed, nil
		}
		return unified.ContractError("UPSTREAM_UNAVAILABLE", "当前平台解析服务暂不可用，请稍后重试", true), attributed, nil
	}
	if info == nil {
		return unified.ContractError("UPSTREAM_INVALID_RESPONSE", "解析器返回数据为空", false), PlatformUnmatched, nil
	}

	platformID := NormalizeExtractorPlatform(info.ExtractorKey, info.Extractor)
	if platformID == "" {
		return unified.ContractError("UNSUPPORTED_PLATFORM", "暂不支持该平台链接解析", false), PlatformUnmatched, nil
	}

	contentID := strings.TrimSpace(info.DisplayID)
	if contentID == "" {
		contentID = strings.TrimSpace(info.ID)
	}
	if contentID == "" {
		sum := sha256.Sum256([]byte(cleanURL))
		contentID = hex.EncodeToString(sum[:])[:16]
	}

	opts := ytengine.AdaptOptions{
		PlatformID:                   platformID,
		ContentID:                    contentID,
		SourceURL:                    source,
		MaxEntries:                   4,
		AllowedMediaURL:              AllowedGenericMediaURL,
		EnableDASHMux:                true,
		EnableHLS:                    true,
		AllowCodecLessProgressiveMP4: true,
		AllowAudioOnly:               true,
		AllowProgressiveWebM:         true,
		OmitItemResolveURL:           true,
	}
	ytengine.PopulateMissingMP4Sizes(ctx, info, p.sizeProber, opts)
	if ctxErr := ctx.Err(); ctxErr != nil {
		if errors.Is(ctxErr, context.Canceled) {
			return nil, platformID, ctxErr
		}
		return unified.ContractError("UPSTREAM_TIMEOUT", "解析超时，请稍后重试", true), platformID, nil
	}
	adapted := ytengine.AdaptInfo(info, opts, now)
	if ctxErr := ctx.Err(); ctxErr != nil {
		if errors.Is(ctxErr, context.Canceled) {
			return nil, platformID, ctxErr
		}
		return unified.ContractError("UPSTREAM_TIMEOUT", "解析超时，请稍后重试", true), platformID, nil
	}
	return adapted, platformID, nil
}
