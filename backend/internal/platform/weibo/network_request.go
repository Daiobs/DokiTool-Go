package weibo

import (
	"context"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const defaultVisitorCacheTTL = 10 * time.Minute

var weiboCookieURL = &url.URL{Scheme: "https", Host: "weibo.com", Path: "/"}

// visitorCookieCache caches ONLY server-generated anonymous Weibo visitor
// cookies (SUB / SUBP) obtained from official passport.weibo.com/visitor/*
// responses. It is strictly in-memory, never persisted to disk, never logged,
// and never stores user-supplied cookies.
type visitorCookieCache struct {
	mu         sync.Mutex
	ttl        time.Duration
	now        func() time.Time
	gen        uint64
	cookies    []*http.Cookie
	expiresAt  time.Time
	refreshing chan struct{}
}

func newVisitorCookieCache(ttl time.Duration, now func() time.Time) *visitorCookieCache {
	if ttl <= 0 {
		ttl = defaultVisitorCacheTTL
	}
	if now == nil {
		now = time.Now
	}
	return &visitorCookieCache{ttl: ttl, now: now}
}

func (c *visitorCookieCache) String() string   { return "visitorCookieCache{redacted}" }
func (c *visitorCookieCache) GoString() string { return c.String() }

func (c *visitorCookieCache) currentTime() time.Time {
	if c != nil && c.now != nil {
		return c.now()
	}
	return time.Now()
}

func cloneVisitorCookies(src []*http.Cookie) []*http.Cookie {
	if len(src) == 0 {
		return nil
	}
	out := make([]*http.Cookie, len(src))
	for i, ck := range src {
		cp := *ck
		out[i] = &cp
	}
	return out
}

func (c *visitorCookieCache) get() ([]*http.Cookie, uint64, bool) {
	if c == nil {
		return nil, 0, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.cookies) == 0 || !c.currentTime().Before(c.expiresAt) {
		return nil, 0, false
	}
	return cloneVisitorCookies(c.cookies), c.gen, true
}

func (c *visitorCookieCache) refresh(
	ctx context.Context,
	staleGen uint64,
	runStartGuest func(context.Context) (visitorCookies []*http.Cookie, expiry time.Time, ok bool),
) (cookies []*http.Cookie, gen uint64, ok bool, ran bool) {
	if c == nil {
		visitorCookies, _, guestOK := runStartGuest(ctx)
		return visitorCookies, 0, guestOK, true
	}
	for {
		if ctx.Err() != nil {
			return nil, 0, false, false
		}
		c.mu.Lock()
		if staleGen != 0 && c.gen == staleGen {
			c.cookies = nil
			c.expiresAt = time.Time{}
		}
		if len(c.cookies) > 0 && c.currentTime().Before(c.expiresAt) && (staleGen == 0 || c.gen != staleGen) {
			got := cloneVisitorCookies(c.cookies)
			gotGen := c.gen
			c.mu.Unlock()
			return got, gotGen, true, false
		}
		if c.refreshing != nil {
			waitCh := c.refreshing
			c.mu.Unlock()
			select {
			case <-waitCh:
				continue
			case <-ctx.Done():
				return nil, 0, false, false
			}
		}
		ch := make(chan struct{})
		c.refreshing = ch
		c.mu.Unlock()

		var (
			freshCookies []*http.Cookie
			cookieExpiry time.Time
			guestOK      bool
		)
		func() {
			defer func() {
				c.mu.Lock()
				if guestOK && len(freshCookies) > 0 {
					now := c.currentTime()
					exp := now.Add(c.ttl)
					if !cookieExpiry.IsZero() && cookieExpiry.Before(exp) {
						exp = cookieExpiry
					}
					if now.Before(exp) {
						c.gen++
						c.cookies = cloneVisitorCookies(freshCookies)
						c.expiresAt = exp
						gen = c.gen
					}
				}
				c.refreshing = nil
				close(ch)
				c.mu.Unlock()
			}()
			freshCookies, cookieExpiry, guestOK = runStartGuest(ctx)
		}()
		return cloneVisitorCookies(freshCookies), gen, guestOK, true
	}
}

func validAnonymousCookieValue(v string) bool {
	if len(v) == 0 || len(v) > 512 {
		return false
	}
	for _, r := range v {
		if r <= 0x20 || r >= 0x7f || r == ';' {
			return false
		}
	}
	return true
}

func extractAnonymousVisitorCookies(raw []*http.Cookie, now time.Time) ([]*http.Cookie, time.Time) {
	var (
		sub        *http.Cookie
		subp       *http.Cookie
		earliest   time.Time
		hasEarliest bool
	)
	for _, ck := range raw {
		if ck == nil || (ck.Name != "SUB" && ck.Name != "SUBP") {
			continue
		}
		if ck.MaxAge < 0 || (!ck.Expires.IsZero() && !now.Before(ck.Expires)) {
			continue
		}
		if !validAnonymousCookieValue(ck.Value) {
			continue
		}
		var exp time.Time
		if ck.MaxAge > 0 {
			exp = now.Add(time.Duration(ck.MaxAge) * time.Second)
		} else if !ck.Expires.IsZero() {
			exp = ck.Expires
		}
		if !exp.IsZero() && (!hasEarliest || exp.Before(earliest)) {
			earliest = exp
			hasEarliest = true
		}
		normalized := &http.Cookie{
			Name:     ck.Name,
			Value:    ck.Value,
			Domain:   ".weibo.com",
			Path:     "/",
			Secure:   true,
			HttpOnly: true,
		}
		if ck.Name == "SUB" {
			sub = normalized
		} else {
			subp = normalized
		}
	}
	if sub == nil {
		return nil, time.Time{}
	}
	if subp != nil {
		return []*http.Cookie{sub, subp}, earliest
	}
	return []*http.Cookie{sub}, earliest
}

// Network requests are one parsing operation's ephemeral guest session. The
// caller supplies the 35-second total parse context; metadata requests retain
// the 20-second per-hop cap and the existing bound DNS/socket/TLS fetch layer.
// No request-scoped cookies or user-supplied URLs escape this session.
type guestHTTP struct {
	executor  fetch.Executor
	jar       *cookiejar.Jar
	onCookies func([]*http.Cookie)
}

func newNetworkGuestSession(executor fetch.Executor) *guestSession {
	jar, _ := cookiejar.New(nil)
	return newGuestSession((&guestHTTP{executor: executor, jar: jar}).exchange)
}

func newCachedNetworkGuestSession(executor fetch.Executor, cache *visitorCookieCache) *guestSession {
	jar, _ := cookiejar.New(nil)
	httpClient := &guestHTTP{executor: executor, jar: jar}
	session := newGuestSession(httpClient.exchange)
	if cache == nil {
		return session
	}
	var seededGen uint64
	if cached, gen, ok := cache.get(); ok {
		jar.SetCookies(weiboCookieURL, cached)
		seededGen = gen
		session.seededFromCache = true
	}
	session.refreshGuest = func(ctx context.Context, guestReferer string) bool {
		var leaderJar *cookiejar.Jar
		cookies, newGen, ok, ran := cache.refresh(ctx, seededGen, func(refreshCtx context.Context) ([]*http.Cookie, time.Time, bool) {
			freshJar, _ := cookiejar.New(nil)
			var seen []*http.Cookie
			refreshHTTP := &guestHTTP{
				executor: executor,
				jar:      freshJar,
				onCookies: func(batch []*http.Cookie) {
					seen = append(seen, batch...)
				},
			}
			refreshSession := newGuestSession(refreshHTTP.exchange)
			if session.nonce != nil {
				refreshSession.nonce = session.nonce
			}
			if !refreshSession.startGuest(refreshCtx, guestReferer) {
				return nil, time.Time{}, false
			}
			leaderJar = freshJar
			visitorCookies, exp := extractAnonymousVisitorCookies(seen, cache.currentTime())
			return visitorCookies, exp, true
		})
		if !ok {
			return false
		}
		if ran && leaderJar != nil {
			httpClient.jar = leaderJar
		} else {
			freshJar, _ := cookiejar.New(nil)
			if len(cookies) > 0 {
				freshJar.SetCookies(weiboCookieURL, cookies)
			}
			httpClient.jar = freshJar
		}
		seededGen = newGen
		return true
	}
	return session
}

const weiboUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// This ordered list comes from the frozen PHP getRequestHeaders() product helper.
func officialWeiboHeaders(referer string) []string {
	return []string{"Referer: " + referer, "Accept: application/json, text/plain, */*", "User-Agent: " + weiboUserAgent}
}

func weiboMetadataURL(raw string) bool {
	if len(raw) > 8192 || strings.ContainsAny(raw, "\\\r\n\t ") {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Fragment != "" || u.RawFragment != "" || u.Scheme != "https" || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	switch u.Hostname() {
	case "weibo.com", "passport.weibo.com":
		return true
	}
	return false
}

func weiboFirstRequestURL(raw string, post *string) bool {
	if !weiboMetadataURL(raw) {
		return false
	}
	u, _ := url.Parse(raw)
	switch u.Hostname() + u.EscapedPath() {
	case "weibo.com/ajax/statuses/show", "passport.weibo.com/visitor/visitor":
		return post == nil
	case "weibo.com/tv/api/component", "passport.weibo.com/visitor/genvisitor":
		return post != nil
	}
	return false
}

// The jar is per parse invocation, and cannot accept a public-suffix cookie or
// a cookie for an unrelated host. The ordinary fetch layer does not manage
// cookies; they are deliberately forwarded on each individually approved hop.
func safeWeiboCookies(headers http.Header) []*http.Cookie {
	response := http.Response{Header: headers}
	var accepted []*http.Cookie
	for _, cookie := range response.Cookies() {
		if cookie.Domain != "" {
			domain := strings.TrimPrefix(strings.ToLower(cookie.Domain), ".")
			if domain != "weibo.com" && domain != "passport.weibo.com" {
				continue
			}
		}
		accepted = append(accepted, cookie)
	}
	return accepted
}

func (g *guestHTTP) exchange(ctx context.Context, address string, post *string, referer string) (unified.Object, error) {
	if g == nil || g.executor == nil || g.jar == nil || !weiboFirstRequestURL(address, post) || !weiboMetadataURL(referer) {
		return nil, fetch.ErrPolicy
	}
	method := http.MethodGet
	if post != nil {
		method = http.MethodPost
	}
	body := []byte(nil)
	if post != nil {
		body = []byte(*post)
	}
	current := address
	for hop := 0; hop <= 3; hop++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !weiboMetadataURL(current) {
			return nil, fetch.ErrPolicy
		}
		budget := 20 * time.Second
		if deadline, ok := ctx.Deadline(); ok {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return nil, context.DeadlineExceeded
			}
			if remaining < budget {
				budget = remaining
			}
		}
		target, _ := url.Parse(current)
		headers := make(http.Header)
		for _, entry := range officialWeiboHeaders(referer) {
			key, value, _ := strings.Cut(entry, ": ")
			headers.Set(key, value)
		}
		if method == http.MethodPost {
			headers.Set("Content-Type", "application/x-www-form-urlencoded")
		}
		if cookies := g.jar.Cookies(target); len(cookies) != 0 {
			request := &http.Request{Header: make(http.Header)}
			for _, cookie := range cookies {
				request.AddCookie(cookie)
			}
			headers.Set("Cookie", request.Header.Get("Cookie"))
		}
		reply, err := g.executor.Do(ctx, fetch.Request{
			URL: current, Method: method, Header: headers, Body: body,
			Policy: fetch.Policy{
				Purpose: "weibo-metadata", AllowedURL: weiboMetadataURL,
				Timeout: budget, MaxBytes: 2 << 20, FollowRedirects: false,
			},
		})
		if err != nil {
			return nil, err
		}
		accepted := safeWeiboCookies(reply.Header)
		g.jar.SetCookies(target, accepted)
		if g.onCookies != nil && len(accepted) > 0 {
			g.onCookies(accepted)
		}
		if reply.StatusCode == http.StatusMovedPermanently || reply.StatusCode == http.StatusFound || reply.StatusCode == http.StatusSeeOther || reply.StatusCode == http.StatusTemporaryRedirect || reply.StatusCode == http.StatusPermanentRedirect {
			if hop == 3 {
				return nil, fetch.ErrRedirect
			}
			locations := reply.Header.Values("Location")
			if len(locations) != 1 || locations[0] == "" {
				return nil, fetch.ErrRedirect
			}
			redirect, err := url.Parse(locations[0])
			if err != nil {
				return nil, fetch.ErrRedirect
			}
			next := target.ResolveReference(redirect).String()
			if !weiboMetadataURL(next) {
				return nil, fetch.ErrPolicy
			}
			current = next
			if reply.StatusCode <= http.StatusSeeOther && method == http.MethodPost {
				method, body = http.MethodGet, nil
			}
			continue
		}
		return unified.Object{"body": string(reply.Body), "error": false, "status": reply.StatusCode, "url": current}, nil
	}
	return nil, errors.New("unreachable weibo redirect state")
}
