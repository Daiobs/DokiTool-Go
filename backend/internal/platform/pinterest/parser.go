// Package pinterest implements zero-cookie native Go parsing for Pinterest Pins
// via the public unauth PinResource endpoint and bounded pin.it shortlink expansion.
package pinterest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/urlpolicy"
)

const (
	pinterestUA         = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
	pinResourceTimeout  = 10 * time.Second
	pinResourceMaxBytes = 2 << 20
	shortLinkHopTimeout = 6 * time.Second
	shortLinkMaxBytes   = 64 << 10
	shortLinkMaxHops    = 3
)

type Parser struct {
	executor fetch.Executor
	clock    func() time.Time
}

func New(executor fetch.Executor) *Parser {
	return NewWithClock(executor, time.Now)
}

func NewWithClock(executor fetch.Executor, clock func() time.Time) *Parser {
	if clock == nil {
		clock = time.Now
	}
	return &Parser{executor: executor, clock: clock}
}

func (p *Parser) Parse(ctx context.Context, input string, now int64) (unified.Object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if p == nil || p.executor == nil {
		return nil, fmt.Errorf("pinterest request executor is not configured")
	}

	pinID, canonicalURL, isShortLink, ok := urlpolicy.ExtractPinterestPinTarget(input)
	if !ok {
		unified.MarkCallerScopedFailure(ctx)
		return unified.ContractError("INVALID_INPUT", "请输入有效的 Pinterest 作品（Pin）链接或 pin.it 短链", false), nil
	}

	if isShortLink {
		resolvedID, resolvedCanon, problem, err := p.resolveShortLink(ctx, canonicalURL)
		if err != nil {
			return nil, err
		}
		if problem != nil {
			return problem, nil
		}
		pinID, canonicalURL = resolvedID, resolvedCanon
	}

	endpoint := buildPinResourceURL(pinID)
	headers := make(http.Header)
	headers.Set("X-Pinterest-PWS-Handler", "www/pin/[id].js")
	headers.Set("X-Requested-With", "XMLHttpRequest")
	headers.Set("Accept", "application/json, text/javascript, */*; q=0.01")
	headers.Set("Accept-Encoding", "gzip, deflate")
	headers.Set("Referer", canonicalURL)
	headers.Set("User-Agent", pinterestUA)
	resp, err := p.executor.Do(ctx, fetch.Request{
		URL:    endpoint,
		Method: http.MethodGet,
		Header: headers,
		Policy: fetch.Policy{
			Purpose:         "pinterest-pin-resource",
			AllowedURL:      fetch.AllowHosts("www.pinterest.com"),
			Timeout:         pinResourceTimeout,
			MaxBytes:        pinResourceMaxBytes,
			FollowRedirects: false,
		},
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if isTimeoutErr(err) {
			return unified.ContractError("UPSTREAM_TIMEOUT", "Pinterest 上游请求超时，请稍后重试", true), nil
		}
		return unified.ContractError("UPSTREAM_UNAVAILABLE", "Pinterest 上游暂时不可用，请稍后重试", true), nil
	}

	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return unified.ContractError("CONTENT_UNAVAILABLE", "该 Pinterest 作品不存在或不可访问", false), nil
	case resp.StatusCode == http.StatusForbidden:
		return unified.ContractError("UPSTREAM_BLOCKED", "Pinterest 暂时拒绝访问，请稍后重试", true), nil
	case resp.StatusCode == http.StatusTooManyRequests:
		return unified.ContractError("RATE_LIMITED", "Pinterest 请求过于频繁，请稍后重试", true), nil
	case resp.StatusCode != http.StatusOK:
		return unified.ContractError("UPSTREAM_UNAVAILABLE", "Pinterest 上游服务暂时不可用，请稍后重试", true), nil
	}

	var env pinResourceEnvelope
	if err := json.Unmarshal(resp.Body, &env); err != nil {
		return unified.ContractError("UPSTREAM_INVALID_RESPONSE", "Pinterest 响应解析失败，请稍后重试", true), nil
	}
	if env.ResourceResponse.Status != "success" || env.ResourceResponse.Data == nil {
		return unified.ContractError("CONTENT_UNAVAILABLE", "该 Pinterest 作品不存在或不可访问", false), nil
	}

	return formatPinData(env.ResourceResponse.Data, pinID, canonicalURL, now), nil
}

func buildPinResourceURL(pinID string) string {
	dataParam := `{"options":{"field_set_key":"unauth_react_main_pin","id":"` + pinID + `"},"context":{}}`
	return "https://www.pinterest.com/resource/PinResource/get/?source_url=" +
		url.QueryEscape("/pin/"+pinID+"/") +
		"&data=" + url.QueryEscape(dataParam)
}

func isAllowedShortLinkHop(raw string, hop int) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && scheme != "http" {
		return false
	}
	if port := u.Port(); port != "" && !((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if hop == 0 {
		return host == "pin.it"
	}
	if host == "api.pinterest.com" {
		return strings.HasPrefix(u.EscapedPath(), "/url_shortener/")
	}
	return host == "pin.it" || urlpolicy.IsPinterestDomain(host)
}

func (p *Parser) resolveShortLink(ctx context.Context, startURL string) (string, string, unified.Object, error) {
	current := startURL
	for hop := 0; hop < shortLinkMaxHops; hop++ {
		if err := ctx.Err(); err != nil {
			return "", "", nil, err
		}
		target := current
		hopIdx := hop
		resp, err := p.executor.Do(ctx, fetch.Request{
			URL:    target,
			Method: http.MethodGet,
			Header: http.Header{
				"Accept":     {"text/html,application/xhtml+xml,*/*;q=0.8"},
				"User-Agent": {pinterestUA},
			},
			Policy: fetch.Policy{
				Purpose: "pinterest-shortlink",
				AllowedURL: func(raw string) bool {
					return raw == target && isAllowedShortLinkHop(raw, hopIdx)
				},
				Timeout:         shortLinkHopTimeout,
				MaxBytes:        shortLinkMaxBytes,
				FollowRedirects: false,
			},
		})
		if err != nil {
			if ctx.Err() != nil {
				return "", "", nil, ctx.Err()
			}
			if isTimeoutErr(err) {
				return "", "", unified.ContractError("UPSTREAM_TIMEOUT", "Pinterest 短链解析超时，请稍后重试", true), nil
			}
			return "", "", unified.ContractError("UPSTREAM_UNAVAILABLE", "Pinterest 短链暂时无法解析，请稍后重试", true), nil
		}

		if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
			unified.MarkCallerScopedFailure(ctx)
			return "", "", unified.ContractError("CONTENT_UNAVAILABLE", "该 Pinterest 短链已失效或作品不存在", false), nil
		}
		if resp.StatusCode == http.StatusForbidden {
			return "", "", unified.ContractError("UPSTREAM_BLOCKED", "Pinterest 暂时拒绝访问，请稍后重试", true), nil
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			return "", "", unified.ContractError("RATE_LIMITED", "Pinterest 请求过于频繁，请稍后重试", true), nil
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			locs := resp.Header.Values("Location")
			if len(locs) != 1 || strings.TrimSpace(locs[0]) == "" {
				unified.MarkCallerScopedFailure(ctx)
				return "", "", unified.ContractError("INVALID_INPUT", "该 Pinterest 短链未指向单个作品（Pin）", false), nil
			}
			base, err := url.Parse(current)
			if err != nil {
				unified.MarkCallerScopedFailure(ctx)
				return "", "", unified.ContractError("INVALID_INPUT", "该 Pinterest 短链未指向单个作品（Pin）", false), nil
			}
			rel, err := url.Parse(strings.TrimSpace(locs[0]))
			if err != nil {
				unified.MarkCallerScopedFailure(ctx)
				return "", "", unified.ContractError("INVALID_INPUT", "该 Pinterest 短链未指向单个作品（Pin）", false), nil
			}
			nextURL := base.ResolveReference(rel).String()
			if pinID, canon, short, ok := urlpolicy.ExtractPinterestPinTarget(nextURL); ok && !short && pinID != "" {
				return pinID, canon, nil, nil
			}
			if !isAllowedShortLinkHop(nextURL, hop+1) {
				unified.MarkCallerScopedFailure(ctx)
				return "", "", unified.ContractError("INVALID_INPUT", "该 Pinterest 短链未指向单个作品（Pin）", false), nil
			}
			current = nextURL
			continue
		}
		break
	}
	unified.MarkCallerScopedFailure(ctx)
	return "", "", unified.ContractError("INVALID_INPUT", "该 Pinterest 短链未指向单个作品（Pin）", false), nil
}

func isTimeoutErr(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}
