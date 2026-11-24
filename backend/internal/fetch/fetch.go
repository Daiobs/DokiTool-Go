// Package fetch provides bounded metadata requests. Policy stays outside the
// replaceable HTTP handshake/transport so a future TLS implementation must keep
// the same URL, DNS, redirect, byte and cancellation boundaries.
package fetch

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"container/list"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"
)

var (
	ErrPolicy   = errors.New("outbound request rejected by policy")
	ErrLimit    = errors.New("upstream response exceeds byte limit")
	ErrRedirect = errors.New("upstream redirect limit exceeded")
)

type Policy struct {
	Purpose            string
	AllowedURL         func(string) bool
	RewriteRedirect    func(string) string
	Timeout            time.Duration
	MaxBytes           int64
	MaxHeaderBytes     int64
	StrictMediaHeaders bool
	// PartialMediaOnly refuses complete media before buffering the body.
	PartialMediaOnly bool
	FollowRedirects  bool
	AutoReferer      bool
	// ReadRedirectBody retains bounded bodies only when redirects are not
	// followed. It never authorizes a Location, and HEAD never reads a body.
	ReadRedirectBody bool
	MaxRedirects     int
}

type Request struct {
	URL    string
	Method string
	Header http.Header
	Body   []byte
	Policy Policy
}

type Response struct {
	StatusCode int
	Header     http.Header
	Body       []byte
	URL        string
	// History contains approved redirect targets in encounter order.
	History []string
}

// Executor is injected into platform parsers. It is not a public proxy API.
type Executor interface {
	Do(context.Context, Request) (Response, error)
}

// Resolver resolves outbound hostnames to IP addresses for hop-by-hop public-IP checks.
type Resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}
type roundTrip func(*http.Request, []netip.Addr, Policy) (*http.Response, error)

const (
	maxPooledTransports   = 64
	maxPolicyHeaderBytes  = 64 << 10
	defaultDNSCacheTTL    = 30 * time.Second
	maxDNSCacheEntries    = 512
	pooledIdleConnTimeout = 120 * time.Second
)

type transportKey struct {
	host string
	port string
	ip   string
}

type pooledTransportEntry struct {
	key       transportKey
	transport *http.Transport
}

type dnsCacheEntry struct {
	host      string
	ips       []netip.Addr
	expiresAt time.Time
}

type Client struct {
	resolver  Resolver
	transport roundTrip

	dial           func(context.Context, string, string) (net.Conn, error)
	tlsRootCAs     *x509.CertPool
	maxPoolEntries int
	now            func() time.Time
	dnsCacheTTL    time.Duration
	maxDNSEntries  int

	poolMu  sync.Mutex
	pool    map[transportKey]*list.Element
	poolLRU *list.List

	dnsMu    sync.Mutex
	dnsCache map[string]*list.Element
	dnsLRU   *list.List
}

func New() *Client {
	return NewWithResolver(net.DefaultResolver).WithDNSCache(defaultDNSCacheTTL)
}

// NewWithResolver creates a Client using r for hop-by-hop DNS resolution while
// retaining all URL, PublicIP, pinned-IP dialing, and response-size boundaries.
func NewWithResolver(r Resolver) *Client {
	if r == nil {
		r = net.DefaultResolver
	}
	c := &Client{
		resolver:      r,
		now:           time.Now,
		maxDNSEntries: maxDNSCacheEntries,
		pool:          make(map[transportKey]*list.Element),
		poolLRU:       list.New(),
		dnsCache:      make(map[string]*list.Element),
		dnsLRU:        list.New(),
	}
	c.transport = c.pooledRoundTrip
	return c
}

// WithDNSCache enables or disables the bounded short-lived public-IP DNS cache.
// Only validated all-public lookups are cached; errors, empty results, and any
// private/reserved IP results are never cached, and every cached IP is still
// re-checked with PublicIP before dialing.
func (c *Client) WithDNSCache(ttl time.Duration) *Client {
	if c == nil {
		return nil
	}
	c.dnsMu.Lock()
	if ttl <= 0 {
		c.dnsCacheTTL = 0
		c.dnsCache = make(map[string]*list.Element)
		c.dnsLRU = list.New()
	} else {
		c.dnsCacheTTL = ttl
		if c.maxDNSEntries <= 0 {
			c.maxDNSEntries = maxDNSCacheEntries
		}
		if c.dnsCache == nil {
			c.dnsCache = make(map[string]*list.Element)
			c.dnsLRU = list.New()
		}
	}
	c.dnsMu.Unlock()
	return c
}

func (c *Client) currentTime() time.Time {
	if c != nil && c.now != nil {
		return c.now()
	}
	return time.Now()
}

func (c *Client) lookupPublicIPs(ctx context.Context, host string) ([]netip.Addr, error) {
	key := strings.ToLower(strings.TrimSuffix(host, "."))
	c.dnsMu.Lock()
	ttl := c.dnsCacheTTL
	if ttl > 0 && c.dnsCache != nil {
		if elem, ok := c.dnsCache[key]; ok {
			entry := elem.Value.(*dnsCacheEntry)
			if c.currentTime().Before(entry.expiresAt) {
				c.dnsLRU.MoveToFront(elem)
				cached := append([]netip.Addr(nil), entry.ips...)
				c.dnsMu.Unlock()
				if len(cached) == 0 {
					return nil, ErrPolicy
				}
				for _, ip := range cached {
					if !PublicIP(ip) {
						return nil, ErrPolicy
					}
				}
				return cached, nil
			}
			c.dnsLRU.Remove(elem)
			delete(c.dnsCache, key)
		}
	}
	c.dnsMu.Unlock()

	ips, err := c.resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, ErrPolicy
	}
	for _, ip := range ips {
		if !PublicIP(ip) {
			if ttl > 0 {
				c.dnsMu.Lock()
				if elem, ok := c.dnsCache[key]; ok {
					c.dnsLRU.Remove(elem)
					delete(c.dnsCache, key)
				}
				c.dnsMu.Unlock()
			}
			return nil, ErrPolicy
		}
	}
	if ttl > 0 {
		c.dnsMu.Lock()
		if c.dnsCacheTTL > 0 {
			if c.dnsCache == nil {
				c.dnsCache = make(map[string]*list.Element)
				c.dnsLRU = list.New()
			}
			if old, ok := c.dnsCache[key]; ok {
				c.dnsLRU.Remove(old)
				delete(c.dnsCache, key)
			}
			limit := c.maxDNSEntries
			if limit <= 0 {
				limit = maxDNSCacheEntries
			}
			for c.dnsLRU.Len() >= limit {
				oldest := c.dnsLRU.Back()
				if oldest == nil {
					break
				}
				c.dnsLRU.Remove(oldest)
				delete(c.dnsCache, oldest.Value.(*dnsCacheEntry).host)
			}
			stored := append([]netip.Addr(nil), ips...)
			elem := c.dnsLRU.PushFront(&dnsCacheEntry{
				host:      key,
				ips:       stored,
				expiresAt: c.currentTime().Add(c.dnsCacheTTL),
			})
			c.dnsCache[key] = elem
		}
		c.dnsMu.Unlock()
	}
	return ips, nil
}

// CloseIdleConnections closes all idle Keep-Alive connections in the client's
// bounded transport pool. Active in-flight requests are unaffected.
func (c *Client) CloseIdleConnections() {
	if c == nil {
		return
	}
	c.poolMu.Lock()
	transports := make([]*http.Transport, 0, len(c.pool))
	for _, elem := range c.pool {
		transports = append(transports, elem.Value.(*pooledTransportEntry).transport)
	}
	c.poolMu.Unlock()
	for _, tr := range transports {
		tr.CloseIdleConnections()
	}
}

// AllowHosts validates server-side request targets separately from the input
// platform registry and URLs merely returned to a browser. Suffix entries begin
// with a dot and include the apex; all other entries are exact hosts.
func AllowHosts(hosts ...string) func(string) bool {
	return func(raw string) bool {
		u, err := checkedURL(raw)
		if err != nil {
			return false
		}
		host := strings.ToLower(u.Hostname())
		for _, allowed := range hosts {
			if strings.HasPrefix(allowed, ".") {
				if host == allowed[1:] || strings.HasSuffix(host, allowed) {
					return true
				}
			} else if host == allowed {
				return true
			}
		}
		return false
	}
}

func checkedURL(raw string) (*url.URL, error) {
	if len(raw) > 8192 {
		return nil, ErrPolicy
	}
	for _, r := range raw {
		if r <= 0x20 || r == 0x7f || r == '\\' {
			return nil, ErrPolicy
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Hostname() == "" || u.Opaque != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, ErrPolicy
	}
	if port := u.Port(); port != "" && !((u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80")) {
		return nil, ErrPolicy
	}
	return u, nil
}

// PublicIP uses the same reserved-network boundary as the PHP media service.
// IPv4-mapped IPv6 is rejected, rather than silently reinterpreted.
func PublicIP(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" || ip.Is4In6() {
		return false
	}
	if ip.Is4() {
		for _, prefix := range blocked4 {
			if prefix.Contains(ip) {
				return false
			}
		}
		return true
	}
	if !global6.Contains(ip) {
		return false
	}
	for _, prefix := range blocked6 {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

var global6 = netip.MustParsePrefix("2000::/3")
var blocked4 = prefixes("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3")
var blocked6 = prefixes("2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20")

func prefixes(values ...string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		out = append(out, netip.MustParsePrefix(value))
	}
	return out
}

func (c *Client) Do(parent context.Context, in Request) (Response, error) {
	p := in.Policy
	if p.AllowedURL == nil || p.Purpose == "" || p.Timeout <= 0 || p.Timeout > 45*time.Second || p.MaxBytes < 1 || p.MaxBytes > 8<<20 || p.MaxHeaderBytes < 0 || p.MaxHeaderBytes > maxPolicyHeaderBytes || p.MaxRedirects < 0 || p.MaxRedirects > 5 {
		return Response{}, ErrPolicy
	}
	if p.MaxHeaderBytes == 0 {
		p.MaxHeaderBytes = maxPolicyHeaderBytes
	}
	ctx, cancel := context.WithTimeout(parent, p.Timeout)
	defer cancel()
	method := in.Method
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodHead && method != http.MethodPost {
		return Response{}, ErrPolicy
	}
	if len(in.Body) > 1<<20 {
		return Response{}, ErrLimit
	}
	headers := in.Header.Clone()
	if headers == nil {
		headers = make(http.Header)
	}
	// Manual decoding gives identical bounds with caller-specified gzip/deflate.
	if headers.Get("Accept-Encoding") == "" {
		headers.Set("Accept-Encoding", "identity")
	}
	current, body := in.URL, in.Body
	history := []string{}
	for hop := 0; ; hop++ {
		if err := ctx.Err(); err != nil {
			return Response{}, err
		}
		u, err := checkedURL(current)
		if err != nil || !p.AllowedURL(current) {
			return Response{}, ErrPolicy
		}
		ips, err := c.lookupPublicIPs(ctx, u.Hostname())
		if err != nil {
			return Response{}, err
		}
		req, err := http.NewRequestWithContext(ctx, method, current, bytes.NewReader(body))
		if err != nil {
			return Response{}, err
		}
		req.Header = headers.Clone()
		response, err := c.transport(req, ips, p)
		if err != nil {
			return Response{}, err
		}
		if response == nil || response.Body == nil {
			return Response{}, fmt.Errorf("missing upstream response")
		}
		if !p.StrictMediaHeaders && p.MaxHeaderBytes < maxPolicyHeaderBytes && minHeaderWireBytes(response.Header) > p.MaxHeaderBytes {
			response.Body.Close()
			return Response{}, errors.New("net/http: server responded with more than allowed bytes of response headers")
		}
		out := Response{StatusCode: response.StatusCode, Header: response.Header.Clone(), URL: current, History: append([]string(nil), history...)}
		isRedirect := response.StatusCode == 301 || response.StatusCode == 302 || response.StatusCode == 303 || response.StatusCode == 307 || response.StatusCode == 308
		if isRedirect && p.FollowRedirects {
			response.Body.Close()
			if hop >= p.MaxRedirects {
				return Response{}, ErrRedirect
			}
			locations := response.Header.Values("Location")
			if len(locations) != 1 || locations[0] == "" {
				return Response{}, ErrRedirect
			}
			relative, err := url.Parse(locations[0])
			if err != nil {
				return Response{}, ErrRedirect
			}
			next := u.ResolveReference(relative)
			originalHost, originalScheme := next.Host, next.Scheme
			if p.RewriteRedirect != nil {
				if rewritten := p.RewriteRedirect(next.String()); rewritten != next.String() {
					parsed, err := url.Parse(rewritten)
					if err != nil {
						return Response{}, ErrPolicy
					}
					next = parsed
				}
			}
			if p.AutoReferer {
				// Match libcurl AUTOREFERER, including cross-origin and HTTPS to
				// HTTP redirects. Every target is still checked before DNS/IO.
				// Userinfo and fragments must never enter the Referer header.
				previous := *u
				previous.User, previous.Fragment, previous.RawFragment = nil, "", ""
				headers.Set("Referer", previous.String())
			}
			crossHost := !strings.EqualFold(originalHost, u.Host) || !strings.EqualFold(next.Host, u.Host)
			downgraded := strings.EqualFold(u.Scheme, "https") && (strings.EqualFold(originalScheme, "http") || strings.EqualFold(next.Scheme, "http"))
			if crossHost || downgraded {
				headers.Del("Authorization")
				headers.Del("Proxy-Authorization")
				headers.Del("Cookie")
			}
			if (response.StatusCode == 301 || response.StatusCode == 302 || response.StatusCode == 303) && method != http.MethodHead {
				method, body = http.MethodGet, nil
				headers.Del("Content-Type")
			}
			current = next.String()
			history = append(history, current)
			continue
		}
		if method == http.MethodHead || (isRedirect && !p.ReadRedirectBody) {
			response.Body.Close()
			return out, nil
		}
		if p.PartialMediaOnly {
			var start, end, total int64
			span := response.Header.Get("Content-Range")
			n, scanErr := fmt.Sscanf(span, "bytes %d-%d/%d", &start, &end, &total)
			if response.StatusCode != http.StatusPartialContent || scanErr != nil || n != 3 || start < 0 || end < start || end >= total || end-start+1 >= total || fmt.Sprintf("bytes %d-%d/%d", start, end, total) != span {
				response.Body.Close()
				return Response{}, ErrPolicy
			}
		}
		out.Body, err = readBody(response.Body, response.Header.Get("Content-Encoding"), p.MaxBytes)
		response.Body.Close()
		if err != nil {
			return Response{}, err
		}
		if p.StrictMediaHeaders {
			if err := mergeMediaTrailers(out.Header, response.Trailer); err != nil {
				return Response{}, err
			}
		}
		return out, nil
	}
}

type pinnedDialError struct {
	err error
}

func (e *pinnedDialError) Error() string { return e.err.Error() }
func (e *pinnedDialError) Unwrap() error { return e.err }

func (c *Client) dialer() func(context.Context, string, string) (net.Conn, error) {
	if c != nil && c.dial != nil {
		return c.dial
	}
	return (&net.Dialer{Timeout: 5 * time.Second}).DialContext
}

// pooledRoundTrip reuses Keep-Alive connections strictly within the same
// (lowercaseHost, port, verifiedIP) boundary after Do has resolved DNS and
// checked PublicIP on every hop. StrictMediaHeaders stays unpooled so raw wire
// header inspection remains completely isolated per request.
func (c *Client) pooledRoundTrip(req *http.Request, ips []netip.Addr, policy Policy) (*http.Response, error) {
	if policy.StrictMediaHeaders {
		return roundTripWithDialAndRoots(req, ips, policy, c.dialer(), c.tlsRootCAs)
	}
	if req == nil || req.URL == nil || len(ips) == 0 || (req.URL.Scheme != "https" && req.URL.Scheme != "http") {
		return nil, ErrPolicy
	}
	for _, ip := range ips {
		if !PublicIP(ip) {
			return nil, ErrPolicy
		}
	}
	lowerHost := strings.ToLower(req.URL.Hostname())
	port := req.URL.Port()
	if port == "" {
		if req.URL.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	if lowerHost == "" || !((req.URL.Scheme == "https" && port == "443") || (req.URL.Scheme == "http" && port == "80")) {
		return nil, ErrPolicy
	}
	if lowerAuthority := strings.ToLower(req.URL.Host); req.URL.Host != lowerAuthority {
		cloned := req.Clone(req.Context())
		cloned.URL.Host = lowerAuthority
		cloned.Host = strings.ToLower(req.Host)
		req = cloned
	}
	orderedIPs := c.preferPooledIP(lowerHost, port, ips)
	var lastErr error
	for i, ip := range orderedIPs {
		if err := req.Context().Err(); err != nil {
			return nil, err
		}
		attempt := req
		if i > 0 {
			attempt = req.Clone(req.Context())
			if req.GetBody != nil {
				bodyCopy, err := req.GetBody()
				if err != nil {
					return nil, err
				}
				attempt.Body = bodyCopy
			}
		}
		tr := c.pooledTransport(lowerHost, port, ip)
		resp, err := tr.RoundTrip(attempt)
		if err == nil {
			return resp, nil
		}
		if req.Context().Err() != nil {
			return nil, req.Context().Err()
		}
		var dialErr *pinnedDialError
		if !errors.As(err, &dialErr) {
			return nil, err
		}
		lastErr = err
	}
	return nil, lastErr
}

func (c *Client) preferPooledIP(lowerHost, port string, ips []netip.Addr) []netip.Addr {
	if len(ips) <= 1 {
		return ips
	}
	c.poolMu.Lock()
	hitIdx := -1
	if c.pool != nil {
		for i, ip := range ips {
			key := transportKey{host: lowerHost, port: port, ip: ip.String()}
			if elem, ok := c.pool[key]; ok {
				c.poolLRU.MoveToFront(elem)
				hitIdx = i
				break
			}
		}
	}
	c.poolMu.Unlock()
	if hitIdx <= 0 {
		return ips
	}
	ordered := make([]netip.Addr, 0, len(ips))
	ordered = append(ordered, ips[hitIdx])
	ordered = append(ordered, ips[:hitIdx]...)
	ordered = append(ordered, ips[hitIdx+1:]...)
	return ordered
}

func (c *Client) pooledTransport(lowerHost, port string, ip netip.Addr) *http.Transport {
	key := transportKey{host: lowerHost, port: port, ip: ip.String()}
	var evicted []*http.Transport

	c.poolMu.Lock()
	if c.pool == nil {
		c.pool = make(map[transportKey]*list.Element)
		c.poolLRU = list.New()
	}
	if elem, ok := c.pool[key]; ok {
		c.poolLRU.MoveToFront(elem)
		tr := elem.Value.(*pooledTransportEntry).transport
		c.poolMu.Unlock()
		return tr
	}
	limit := c.maxPoolEntries
	if limit <= 0 {
		limit = maxPooledTransports
	}
	for c.poolLRU.Len() >= limit {
		oldest := c.poolLRU.Back()
		if oldest == nil {
			break
		}
		c.poolLRU.Remove(oldest)
		entry := oldest.Value.(*pooledTransportEntry)
		delete(c.pool, entry.key)
		evicted = append(evicted, entry.transport)
	}
	tr := c.newPooledTransport(lowerHost, port, ip)
	elem := c.poolLRU.PushFront(&pooledTransportEntry{key: key, transport: tr})
	c.pool[key] = elem
	c.poolMu.Unlock()

	for _, old := range evicted {
		old.CloseIdleConnections()
	}
	return tr
}

func (c *Client) newPooledTransport(lowerHost, port string, verifiedIP netip.Addr) *http.Transport {
	pinnedAddr := net.JoinHostPort(verifiedIP.String(), port)
	dial := c.dialer()
	dialPinned := func(dialCtx context.Context, network, address string) (net.Conn, error) {
		if !PublicIP(verifiedIP) || (network != "tcp" && network != "tcp4" && network != "tcp6") {
			return nil, ErrPolicy
		}
		dialHost, dialPort, err := net.SplitHostPort(address)
		if err != nil || !strings.EqualFold(dialHost, lowerHost) || dialPort != port {
			return nil, ErrPolicy
		}
		boundCtx, cancel := context.WithTimeout(dialCtx, 5*time.Second)
		defer cancel()
		conn, err := dial(boundCtx, "tcp", pinnedAddr)
		if err != nil {
			return nil, &pinnedDialError{err: err}
		}
		return conn, nil
	}
	return &http.Transport{
		Proxy:              nil,
		DisableCompression: true,
		DisableKeepAlives:  false,
		// Keep ALPN h2 offered like the pre-pool transport did: a custom
		// DialContext/TLSClientConfig would otherwise silently downgrade every
		// non-strict request to HTTP/1.1 and change the upstream fingerprint.
		ForceAttemptHTTP2:      true,
		MaxIdleConns:           4,
		MaxIdleConnsPerHost:    4,
		IdleConnTimeout:        pooledIdleConnTimeout,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  20 * time.Second,
		MaxResponseHeaderBytes: maxPolicyHeaderBytes,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: lowerHost,
			RootCAs:    c.tlsRootCAs,
		},
		DialContext: dialPinned,
	}
}

func minHeaderWireBytes(headers http.Header) int64 {
	var total int64
	for key, values := range headers {
		for _, value := range values {
			total += int64(len(key) + len(value) + 2)
		}
	}
	return total
}

// One transport per outbound hop keeps DNS checks and the actual socket bound
// together. A platform cannot enable environment proxies, redirects or cookies.
// The transport replacement point receives only already approved IPs.
func standardRoundTrip(req *http.Request, ips []netip.Addr, policy Policy) (*http.Response, error) {
	return roundTripWithDial(req, ips, policy, (&net.Dialer{Timeout: 5 * time.Second}).DialContext)
}

func roundTripWithDial(req *http.Request, ips []netip.Addr, policy Policy, dial func(context.Context, string, string) (net.Conn, error)) (*http.Response, error) {
	return roundTripWithDialAndRoots(req, ips, policy, dial, nil)
}

func roundTripWithDialAndRoots(req *http.Request, ips []netip.Addr, policy Policy, dial func(context.Context, string, string) (net.Conn, error), roots *x509.CertPool) (*http.Response, error) {
	host, port := req.URL.Hostname(), req.URL.Port()
	if port == "" {
		if req.URL.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	dialPinned := func(ctx context.Context, network, address string) (net.Conn, error) {
		wanted := net.JoinHostPort(host, port)
		if address != wanted {
			return nil, ErrPolicy
		}
		var last error
		for _, ip := range ips {
			// net/http may detach its dial context for connection reuse. These
			// per-request transports instead share the original request budget.
			conn, err := dial(req.Context(), "tcp", net.JoinHostPort(ip.String(), port))
			if err == nil {
				return bindRequestConnection(req.Context(), conn), nil
			}
			last = err
			if req.Context().Err() != nil {
				return nil, req.Context().Err()
			}
		}
		return nil, last
	}
	transport := &http.Transport{
		Proxy: nil, DisableCompression: true, DisableKeepAlives: true,
		TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 20 * time.Second,
		MaxResponseHeaderBytes: policy.MaxHeaderBytes, ForceAttemptHTTP2: true,
		DialContext: dialPinned,
	}
	if policy.StrictMediaHeaders {
		// HTTP/1.1 is explicit for strict media probes: net/http otherwise merges
		// duplicate identical Content-Length before exposing Response.Header.
		// Inspect bounded plaintext headers before the standard parser does so.
		transport.ForceAttemptHTTP2 = false
		transport.ReadBufferSize = int(policy.MaxHeaderBytes)
		transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			conn, err := dialPinned(ctx, network, address)
			if err != nil {
				return nil, err
			}
			return newMediaHeaderConn(conn, policy.MaxHeaderBytes), nil
		}
		transport.DialTLSContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			conn, err := dialPinned(ctx, network, address)
			if err != nil {
				return nil, err
			}
			secure := tls.Client(conn, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}, RootCAs: roots})
			handshake, cancel := context.WithTimeout(req.Context(), 5*time.Second)
			defer cancel()
			if err := secure.HandshakeContext(handshake); err != nil {
				conn.Close()
				return nil, err
			}
			return newMediaHeaderConn(secure, policy.MaxHeaderBytes), nil
		}
	}
	// http.Transport retains the original URL hostname for TLS SNI and
	// certificate verification; no InsecureSkipVerify or IP URL substitution.
	return transport.RoundTrip(req)
}

// Closing or cancelling a request also closes an in-flight standard-library
// TLS handshake, whose internal dial context can outlive RoundTrip's return.
type requestConnection struct {
	net.Conn
	stop func() bool
}

func bindRequestConnection(ctx context.Context, conn net.Conn) net.Conn {
	return &requestConnection{Conn: conn, stop: context.AfterFunc(ctx, func() { _ = conn.Close() })}
}
func (c *requestConnection) Close() error { c.stop(); return c.Conn.Close() }

func mergeMediaTrailers(headers, trailers http.Header) error {
	for _, key := range []string{"Location", "Content-Range", "Content-Length", "Content-Type", "Content-Encoding"} {
		values := trailers.Values(key)
		if len(values) == 0 {
			continue
		}
		if len(values) != 1 || len(headers.Values(key)) != 0 {
			return ErrMediaHeaders
		}
		headers.Set(key, values[0])
	}
	return nil
}

func readBody(body io.Reader, encoding string, limit int64) ([]byte, error) {
	wire, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(wire)) > limit {
		return nil, ErrLimit
	}
	var decoded io.ReadCloser
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "identity":
		return wire, nil
	case "gzip":
		decoded, err = gzip.NewReader(bytes.NewReader(wire))
	case "deflate":
		decoded, err = zlib.NewReader(bytes.NewReader(wire))
		if err != nil {
			decoded, err = flate.NewReader(bytes.NewReader(wire)), nil
		}
	default:
		return nil, fmt.Errorf("unsupported response content encoding")
	}
	if err != nil {
		return nil, err
	}
	defer decoded.Close()
	value, err := io.ReadAll(io.LimitReader(decoded, limit+1))
	if int64(len(value)) > limit {
		return nil, ErrLimit
	}
	return value, err
}
