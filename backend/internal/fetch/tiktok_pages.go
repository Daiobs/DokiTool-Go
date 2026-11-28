package fetch

import (
	"context"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	browserhttp "github.com/bogdanfinn/fhttp"
	tlsclient "github.com/bogdanfinn/tls-client"
)

const tiktokChrome131UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

var tiktokPageHosts = AllowHosts("www.tiktok.com")

// NewTikTokPages changes ONLY the HTTPS tiktok-page hydration handshake to
// reuse the bounded Chrome_131 TLS profile already vendored for Xiaohongshu.
// Client.Do still owns URL/DNS/public-IP checks, proxy policy checks, and
// bounded body decoding. Shortlinks, tiktok-play-302 hops, and every other
// purpose retain the standard Go transport.
func NewTikTokPages() *Client {
	client := New()
	client.transport = tiktokPageDispatch(client.pooledRoundTrip, tiktokChrome131RoundTrip)
	client.proxyTransport = tiktokProxyDispatch(client.standardProxyRoundTrip, tiktokChrome131ProxyRoundTrip)
	return client
}

func validateTikTokPageRequest(req *http.Request, policy Policy) bool {
	if req == nil || req.URL == nil || req.URL.Scheme != "https" || !tiktokPageHosts(req.URL.String()) ||
		req.URL.Fragment != "" || req.Method != http.MethodGet || req.ContentLength != 0 ||
		policy.FollowRedirects || policy.StrictMediaHeaders || policy.PartialMediaOnly ||
		policy.Timeout <= 0 || policy.Timeout > 15*time.Second ||
		policy.MaxHeaderBytes <= 0 || policy.MaxHeaderBytes > maxPolicyHeaderBytes {
		return false
	}
	// Strictly anonymous page-only headers: zero Cookie, Authorization, or Range.
	for key := range req.Header {
		switch strings.ToLower(key) {
		case "user-agent", "accept", "accept-language", "accept-encoding":
		default:
			return false
		}
	}
	return true
}

func tiktokPageDispatch(standard, browser roundTrip) roundTrip {
	return func(req *http.Request, ips []netip.Addr, policy Policy) (*http.Response, error) {
		if policy.Purpose != "tiktok-page" {
			return standard(req, ips, policy)
		}
		if !validateTikTokPageRequest(req, policy) {
			return nil, ErrPolicy
		}
		return browser(req, ips, policy)
	}
}

func tiktokProxyDispatch(standard, browser proxyRoundTripFunc) proxyRoundTripFunc {
	return func(req *http.Request, proxyURL *url.URL, policy Policy) (*http.Response, error) {
		if policy.Purpose != "tiktok-page" {
			return standard(req, proxyURL, policy)
		}
		if proxyURL == nil || !validateTikTokPageRequest(req, policy) || !isAllowedProxyTargetHost(req.URL.Hostname()) {
			return nil, ErrPolicy
		}
		return browser(req, proxyURL, policy)
	}
}

func tiktokChrome131RoundTrip(req *http.Request, ips []netip.Addr, policy Policy) (*http.Response, error) {
	return tiktokChrome131WithDial(req, ips, policy, (&net.Dialer{Timeout: 5 * time.Second}).DialContext, nil)
}

func tiktokChrome131WithDial(req *http.Request, ips []netip.Addr, policy Policy,
	dial func(context.Context, string, string) (net.Conn, error), roots *x509.CertPool,
) (*http.Response, error) {
	if !validateTikTokPageRequest(req, policy) || len(ips) == 0 {
		return nil, ErrPolicy
	}
	for _, ip := range ips {
		if !PublicIP(ip) {
			return nil, ErrPolicy
		}
	}
	deadline, exists := req.Context().Deadline()
	if !exists || req.Context().Err() != nil {
		if err := req.Context().Err(); err != nil {
			return nil, err
		}
		return nil, ErrPolicy
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return nil, context.DeadlineExceeded
	}
	orderedIPs := orderIPv4First(ips)
	connections := &xhsConnections{}
	pinned := func(_ context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || !strings.EqualFold(host, req.URL.Hostname()) || port != "443" ||
			(network != "tcp" && network != "tcp4" && network != "tcp6") {
			return nil, ErrPolicy
		}
		var last error
		for i, ip := range orderedIPs {
			if err := req.Context().Err(); err != nil {
				return nil, err
			}
			dialCtx := req.Context()
			var cancel context.CancelFunc
			if rem := len(orderedIPs) - i; rem > 1 {
				dialCtx, cancel = context.WithTimeout(req.Context(), perIPDialTimeout(req.Context(), rem))
			}
			conn, err := dial(dialCtx, "tcp", net.JoinHostPort(ip.String(), "443"))
			if cancel != nil {
				cancel()
			}
			if err != nil {
				last = err
				if req.Context().Err() != nil {
					return nil, req.Context().Err()
				}
				continue
			}
			conn = bindRequestConnection(req.Context(), conn)
			if err := conn.SetDeadline(deadline); err != nil {
				_ = conn.Close()
				return nil, err
			}
			if !connections.add(conn) {
				return nil, context.Canceled
			}
			return conn, nil
		}
		return nil, last
	}
	client, err := tlsclient.NewHttpClient(tlsclient.NewNoopLogger(),
		tlsclient.WithClientProfile(boundedChrome131(policy.MaxHeaderBytes)),
		tlsclient.WithNotFollowRedirects(), tlsclient.WithDisableHttp3(),
		tlsclient.WithDialContext(pinned),
		tlsclient.WithTimeoutMilliseconds(int((remaining+time.Millisecond-1)/time.Millisecond)),
		tlsclient.WithTransportOptions(&tlsclient.TransportOptions{
			RootCAs: roots, DisableCompression: true, DisableKeepAlives: true,
			MaxResponseHeaderBytes: policy.MaxHeaderBytes, ResponseHeaderTimeout: remaining,
		}),
	)
	if err != nil {
		return nil, err
	}
	cleanup := sync.OnceFunc(func() {
		connections.close()
		client.Close()
	})
	return executeTikTokChrome131Request(client, req, cleanup, nil)
}

func tiktokChrome131ProxyRoundTrip(req *http.Request, proxyURL *url.URL, policy Policy) (*http.Response, error) {
	return tiktokChrome131ProxyWithRoots(req, proxyURL, policy, nil)
}

func tiktokChrome131ProxyWithRoots(req *http.Request, proxyURL *url.URL, policy Policy, roots *x509.CertPool) (*http.Response, error) {
	if proxyURL == nil || !validateTikTokPageRequest(req, policy) || !isAllowedProxyTargetHost(req.URL.Hostname()) {
		return nil, ErrPolicy
	}
	deadline, exists := req.Context().Deadline()
	if !exists || req.Context().Err() != nil {
		if err := req.Context().Err(); err != nil {
			return nil, err
		}
		return nil, ErrPolicy
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return nil, context.DeadlineExceeded
	}
	client, err := tlsclient.NewHttpClient(tlsclient.NewNoopLogger(),
		tlsclient.WithClientProfile(boundedChrome131(policy.MaxHeaderBytes)),
		tlsclient.WithNotFollowRedirects(), tlsclient.WithDisableHttp3(),
		tlsclient.WithProxyUrl(proxyURL.String()),
		tlsclient.WithTimeoutMilliseconds(int((remaining+time.Millisecond-1)/time.Millisecond)),
		tlsclient.WithTransportOptions(&tlsclient.TransportOptions{
			RootCAs: roots, DisableCompression: true, DisableKeepAlives: true,
			MaxResponseHeaderBytes: policy.MaxHeaderBytes, ResponseHeaderTimeout: remaining,
		}),
	)
	if err != nil {
		return nil, sanitizeProxyError(err, proxyURL)
	}
	cleanup := sync.OnceFunc(func() {
		client.Close()
	})
	return executeTikTokChrome131Request(client, req, cleanup, proxyURL)
}

func executeTikTokChrome131Request(client tlsclient.HttpClient, req *http.Request, cleanup func(), proxyURL *url.URL) (*http.Response, error) {
	request, err := browserhttp.NewRequestWithContext(req.Context(), http.MethodGet, req.URL.String(), nil)
	if err != nil {
		cleanup()
		return nil, ErrPolicy
	}
	request.Header = make(browserhttp.Header)
	for key, values := range req.Header {
		request.Header[strings.ToLower(key)] = append([]string(nil), values...)
	}
	request.Header["user-agent"] = []string{tiktokChrome131UA}
	request.Header["sec-ch-ua"] = []string{`"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`}
	request.Header["sec-ch-ua-mobile"] = []string{"?0"}
	request.Header["sec-ch-ua-platform"] = []string{`"Windows"`}
	request.Header["upgrade-insecure-requests"] = []string{"1"}
	request.Header["sec-fetch-site"] = []string{"none"}
	request.Header["sec-fetch-mode"] = []string{"navigate"}
	request.Header["sec-fetch-user"] = []string{"?1"}
	request.Header["sec-fetch-dest"] = []string{"document"}
	request.Header["accept-encoding"] = []string{"gzip,deflate"}
	request.Header[browserhttp.HeaderOrderKey] = []string{
		"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests",
		"user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user",
		"sec-fetch-dest", "accept-encoding", "accept-language",
	}
	response, err := client.Do(request)
	if err != nil {
		cleanup()
		if ctxErr := req.Context().Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if proxyURL != nil {
			return nil, sanitizeProxyError(err, proxyURL)
		}
		var requestError *url.Error
		if errors.As(err, &requestError) {
			return nil, requestError.Err
		}
		return nil, err
	}
	if response == nil || response.Body == nil {
		cleanup()
		return nil, errors.New("missing browser page response")
	}
	return &http.Response{
		StatusCode: response.StatusCode, Status: response.Status, Proto: response.Proto,
		ProtoMajor: response.ProtoMajor, ProtoMinor: response.ProtoMinor,
		Header: http.Header(response.Header), Trailer: http.Header(response.Trailer),
		ContentLength: response.ContentLength, Request: req,
		Body: &xhsResponseBody{ReadCloser: response.Body, cleanup: cleanup},
	}, nil
}
