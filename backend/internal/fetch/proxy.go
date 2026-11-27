package fetch

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// ProxyProvider returns an outbound proxy URL for a scoped platform metadata
// request; returning (nil, nil) routes directly without a proxy.
// Strictly limited to controlled platform metadata fetches; never used for media streams.
type ProxyProvider interface {
	ProxyFor(ctx context.Context, platform string, purpose string) (*url.URL, error)
}

type proxyRoundTripFunc func(req *http.Request, proxyURL *url.URL, policy Policy) (*http.Response, error)

// DirectProxyProvider always routes outbound requests directly with zero overhead.
type DirectProxyProvider struct{}

// ProxyFor always returns (nil, nil).
func (DirectProxyProvider) ProxyFor(context.Context, string, string) (*url.URL, error) {
	return nil, nil
}

// EnvPlatformProxyProvider is a thin, single-gateway proxy provider configured
// from DOKITOOL_TIKTOK_PROXY_URL. It routes ONLY TikTok page hydration and
// shortlink resolution requests through the configured rotating gateway; all
// other platforms, tiktok-play-302 hops, and media requests remain direct.
type EnvPlatformProxyProvider struct {
	tiktokProxy *url.URL
}

// NewEnvPlatformProxyProvider validates rawTikTokProxyURL and returns a scoped
// ProxyProvider. An empty string yields a no-op provider that routes directly.
func NewEnvPlatformProxyProvider(rawTikTokProxyURL string) (*EnvPlatformProxyProvider, error) {
	for _, r := range rawTikTokProxyURL {
		if r == '\r' || r == '\n' || r == 0 || r == 0x7f || r == '\\' {
			return nil, fmt.Errorf("DOKITOOL_TIKTOK_PROXY_URL contains invalid characters")
		}
	}
	trimmed := strings.TrimSpace(rawTikTokProxyURL)
	if trimmed == "" {
		return &EnvPlatformProxyProvider{}, nil
	}
	for _, r := range trimmed {
		if r <= 0x20 || r == 0x7f || r == '\\' {
			return nil, fmt.Errorf("DOKITOOL_TIKTOK_PROXY_URL contains invalid characters")
		}
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed == nil || parsed.Opaque != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("DOKITOOL_TIKTOK_PROXY_URL must be a valid proxy URL")
	}
	scheme := strings.ToLower(parsed.Scheme)
	switch scheme {
	case "http", "https", "socks5":
	default:
		return nil, fmt.Errorf("DOKITOOL_TIKTOK_PROXY_URL scheme must be http, https, or socks5")
	}
	if strings.TrimSpace(parsed.Hostname()) == "" {
		return nil, fmt.Errorf("DOKITOOL_TIKTOK_PROXY_URL must include a proxy host")
	}
	normalized := *parsed
	normalized.Scheme = scheme
	if parsed.User != nil {
		u := *parsed.User
		normalized.User = &u
	}
	return &EnvPlatformProxyProvider{tiktokProxy: &normalized}, nil
}

// Configured reports whether a TikTok metadata proxy URL is active.
func (p *EnvPlatformProxyProvider) Configured() bool {
	return p != nil && p.tiktokProxy != nil
}

// ProxyFor returns the configured rotating proxy URL ONLY for TikTok hydration
// and shortlink metadata requests. Every other platform and purpose (including
// tiktok-play-302 and media requests) returns (nil, nil).
func (p *EnvPlatformProxyProvider) ProxyFor(_ context.Context, platform string, purpose string) (*url.URL, error) {
	if p == nil || p.tiktokProxy == nil {
		return nil, nil
	}
	if !strings.EqualFold(strings.TrimSpace(platform), "tiktok") {
		return nil, nil
	}
	if purpose != "tiktok-page" && purpose != "tiktok-shortlink" {
		return nil, nil
	}
	cloned := *p.tiktokProxy
	if p.tiktokProxy.User != nil {
		u := *p.tiktokProxy.User
		cloned.User = &u
	}
	return &cloned, nil
}

// WithProxyProvider attaches an optional ProxyProvider to c.
func (c *Client) WithProxyProvider(provider ProxyProvider) *Client {
	if c == nil {
		return nil
	}
	c.proxyProvider = provider
	return c
}

func platformFromPolicy(p Policy) string {
	if plat := strings.ToLower(strings.TrimSpace(p.Platform)); plat != "" {
		return plat
	}
	if strings.HasPrefix(p.Purpose, "tiktok-") {
		return "tiktok"
	}
	return ""
}

func (c *Client) resolveProxy(ctx context.Context, p Policy) (*url.URL, error) {
	if c == nil || c.proxyProvider == nil {
		return nil, nil
	}
	proxyURL, err := c.proxyProvider.ProxyFor(ctx, platformFromPolicy(p), p.Purpose)
	if err != nil {
		return nil, sanitizeProxyError(err, nil)
	}
	if proxyURL == nil {
		return nil, nil
	}
	scheme := strings.ToLower(proxyURL.Scheme)
	if (scheme != "http" && scheme != "https" && scheme != "socks5") || strings.TrimSpace(proxyURL.Hostname()) == "" {
		return nil, ErrPolicy
	}
	return proxyURL, nil
}

var blockedProxyTargetSuffixes = []string{
	".localhost",
	".local",
	".internal",
	".lan",
	".home",
	".arpa",
	".localdomain",
	".corp",
}

// isAllowedProxyTargetHost enforces the non-IP public-FQDN SSRF boundary when
// DNS resolution is delegated to an external proxy gateway.
func isAllowedProxyTargetHost(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if h == "" || h == "localhost" || !strings.Contains(h, ".") {
		return false
	}
	if _, err := netip.ParseAddr(h); err == nil {
		return false
	}
	for _, suffix := range blockedProxyTargetSuffixes {
		if strings.HasSuffix(h, suffix) {
			return false
		}
	}
	return true
}

var embeddedUserinfoPattern = regexp.MustCompile(`(?i)\b(?:https?|socks5h?)://[^\s/@]+@[^\s/]+`)

// sanitizeProxyError strips proxy URLs, hostnames, and credentials (both raw
// and percent-encoded) so proxy secrets can never appear in errors or logs.
func sanitizeProxyError(err error, proxyURL *url.URL) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, context.Canceled):
		return context.Canceled
	case errors.Is(err, context.DeadlineExceeded):
		return context.DeadlineExceeded
	case errors.Is(err, ErrPolicy):
		return ErrPolicy
	case errors.Is(err, ErrLimit):
		return ErrLimit
	case errors.Is(err, ErrRedirect):
		return ErrRedirect
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		err = urlErr.Err
	}
	msg := err.Error()
	msg = embeddedUserinfoPattern.ReplaceAllString(msg, "[redacted-proxy]")
	if proxyURL != nil {
		var redact []string
		addToken := func(s string) {
			if s != "" {
				redact = append(redact, s)
			}
		}
		addToken(proxyURL.String())
		addToken(proxyURL.Redacted())
		if proxyURL.User != nil {
			user := proxyURL.User.Username()
			addToken(user)
			addToken(url.QueryEscape(user))
			addToken(url.PathEscape(user))
			if pass, hasPass := proxyURL.User.Password(); hasPass {
				addToken(pass)
				addToken(url.QueryEscape(pass))
				addToken(url.PathEscape(pass))
			}
		}
		addToken(proxyURL.Host)
		addToken(proxyURL.Hostname())
		for _, tok := range redact {
			msg = strings.ReplaceAll(msg, tok, "[redacted-proxy]")
		}
	}
	msg = strings.TrimSpace(msg)
	if msg == "" {
		return errors.New("outbound proxy request failed")
	}
	return errors.New("outbound proxy request failed: " + msg)
}

func (c *Client) standardProxyRoundTrip(req *http.Request, proxyURL *url.URL, policy Policy) (*http.Response, error) {
	if req == nil || req.URL == nil || proxyURL == nil ||
		policy.FollowRedirects || policy.StrictMediaHeaders || policy.PartialMediaOnly ||
		!isAllowedProxyTargetHost(req.URL.Hostname()) ||
		policy.MaxHeaderBytes <= 0 || policy.MaxHeaderBytes > maxPolicyHeaderBytes {
		return nil, ErrPolicy
	}
	tr := &http.Transport{
		Proxy:                  http.ProxyURL(proxyURL),
		DisableCompression:     true,
		DisableKeepAlives:      true,
		ForceAttemptHTTP2:      true,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  policy.Timeout,
		MaxResponseHeaderBytes: policy.MaxHeaderBytes,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: req.URL.Hostname(),
			RootCAs:    c.tlsRootCAs,
		},
		DialContext: c.dialer(),
	}
	resp, err := tr.RoundTrip(req)
	if err != nil {
		tr.CloseIdleConnections()
		return nil, sanitizeProxyError(err, proxyURL)
	}
	if resp == nil || resp.Body == nil {
		tr.CloseIdleConnections()
		return nil, errors.New("missing upstream proxy response")
	}
	resp.Body = &proxyResponseBody{ReadCloser: resp.Body, cleanup: tr.CloseIdleConnections}
	return resp, nil
}

type proxyResponseBody struct {
	io.ReadCloser
	cleanup func()
}

func (b *proxyResponseBody) Close() error {
	err := b.ReadCloser.Close()
	if b.cleanup != nil {
		b.cleanup()
	}
	return err
}
