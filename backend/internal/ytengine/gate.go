package ytengine

import (
	"bytes"
	"context"
	"crypto/subtle"
	"crypto/tls"
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

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
)

// Resolver resolves outbound hostnames to IP addresses for SSRF and DNS-rebinding checks.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

func (e *Engine) verifyPublicTargetHost(ctx context.Context, rawURL string) *Error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return &Error{Code: CodeInvalidInput, Message: "请输入对应平台的有效分享链接"}
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host == "" {
		return &Error{Code: CodeInvalidInput, Message: "请输入对应平台的有效分享链接"}
	}
	if e.allowedOutboundHost != nil && !e.allowedOutboundHost(host) {
		return &Error{Code: CodeUpstreamBlocked, Message: "目标地址不在受控出站白名单内", Retryable: false}
	}
	if e.resolver != nil || e.allowedOutboundHost != nil {
		if _, err := e.resolvePublicHostIP(ctx, host); err != nil {
			return &Error{Code: CodeUpstreamBlocked, Message: "目标地址解析到受限网络，已拒绝访问", Retryable: false, Cause: err}
		}
	}
	return nil
}

func (e *Engine) resolvePublicHostIP(ctx context.Context, host string) (netip.Addr, error) {
	cleanHost := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if cleanHost == "" {
		return netip.Addr{}, errors.New("empty host")
	}
	if e.allowedOutboundHost != nil && !e.allowedOutboundHost(cleanHost) {
		return netip.Addr{}, fmt.Errorf("outbound host %s is not allowlisted", cleanHost)
	}
	if ip, err := netip.ParseAddr(cleanHost); err == nil {
		if !fetch.PublicIP(ip) {
			return netip.Addr{}, fmt.Errorf("non-public IP literal %s", ip)
		}
		return ip.Unmap(), nil
	}
	resolver := e.resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	ips, err := resolver.LookupNetIP(ctx, "ip", cleanHost)
	if err != nil || len(ips) == 0 {
		return netip.Addr{}, fmt.Errorf("resolve outbound host %s: %w", cleanHost, err)
	}
	for _, ip := range ips {
		if !fetch.PublicIP(ip) {
			return netip.Addr{}, fmt.Errorf("host %s resolved to non-public IP %s", cleanHost, ip)
		}
	}
	return ips[0].Unmap(), nil
}

func (e *Engine) validateOutboundPort(port string) error {
	if e.dialAddr != nil {
		return nil
	}
	if port != "80" && port != "443" {
		return fmt.Errorf("disallowed outbound port %s", port)
	}
	return nil
}

func (e *Engine) dialTargetAddr(ip netip.Addr, port string) string {
	if e.dialAddr != nil {
		if custom := e.dialAddr(ip, port); custom != "" {
			return custom
		}
	}
	return net.JoinHostPort(ip.String(), port)
}

func (e *Engine) startOutboundGate(ctx context.Context) (string, func(), error) {
	ln, releasePort, err := e.gatePorts.listen()
	if err != nil {
		return "", nil, err
	}
	credential, err := newGateCredential()
	if err != nil {
		_ = ln.Close()
		releasePort()
		return "", nil, err
	}
	ctx, cancelGate := context.WithCancel(ctx)
	socketTimeout := time.Duration(defaultSocketTimeoutSec) * time.Second
	if e.socketTimeoutSec > 0 {
		socketTimeout = time.Duration(e.socketTimeoutSec) * time.Second
	}

	var (
		mu          sync.Mutex
		nextConnID  uint64
		activeConns = make(map[uint64]func())
		closeOnce   sync.Once
		gateClosed  = make(chan struct{})
		closing     bool
		handlers    sync.WaitGroup
	)
	registerTunnel := func(closeTunnel func()) func() {
		mu.Lock()
		select {
		case <-gateClosed:
			mu.Unlock()
			closeTunnel()
			return func() {}
		default:
		}
		if ctx.Err() != nil {
			mu.Unlock()
			closeTunnel()
			return func() {}
		}
		nextConnID++
		id := nextConnID
		activeConns[id] = closeTunnel
		mu.Unlock()
		return func() {
			mu.Lock()
			delete(activeConns, id)
			mu.Unlock()
		}
	}

	srv := &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			if closing {
				mu.Unlock()
				http.Error(w, "proxy task closed", http.StatusServiceUnavailable)
				return
			}
			handlers.Add(1)
			mu.Unlock()
			defer handlers.Done()
			if len(r.Header.Values("Proxy-Authorization")) != 1 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Proxy-Authorization")), []byte(credential.authorization)) != 1 {
				w.Header().Set("Proxy-Authenticate", `Basic realm="task"`)
				http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
				return
			}
			r.Header.Del("Proxy-Authorization")
			if r.Method == http.MethodConnect {
				e.handleGateConnect(ctx, w, r, socketTimeout, registerTunnel)
				return
			}
			e.handleGateHTTP(ctx, w, r, socketTimeout)
		}),
	}
	go func() {
		_ = srv.Serve(ln)
	}()

	closeFn := func() {
		closeOnce.Do(func() {
			mu.Lock()
			closing = true
			mu.Unlock()
			cancelGate()
			close(gateClosed)
			_ = ln.Close()
			_ = srv.Close()
			mu.Lock()
			conns := make([]func(), 0, len(activeConns))
			for _, fn := range activeConns {
				conns = append(conns, fn)
			}
			activeConns = make(map[uint64]func())
			mu.Unlock()
			for _, fn := range conns {
				fn()
			}
			handlers.Wait()
			releasePort()
		})
	}
	go func() {
		select {
		case <-ctx.Done():
			closeFn()
		case <-gateClosed:
		}
	}()
	proxyURL := &url.URL{Scheme: "http", Host: ln.Addr().String(), User: url.UserPassword("task", credential.password)}
	return proxyURL.String(), closeFn, nil
}

func (e *Engine) handleGateConnect(ctx context.Context, w http.ResponseWriter, r *http.Request, timeout time.Duration, registerTunnel func(func()) func()) {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
		port = "443"
	}
	if err := e.validateOutboundPort(port); err != nil {
		http.Error(w, "upstream blocked by outbound security policy: "+err.Error(), http.StatusForbidden)
		return
	}
	ip, err := e.resolvePublicHostIP(ctx, host)
	if err != nil {
		http.Error(w, "upstream blocked by outbound security policy: "+err.Error(), http.StatusForbidden)
		return
	}
	dialer := &net.Dialer{Timeout: timeout}
	upstreamConn, err := dialer.DialContext(ctx, "tcp", e.dialTargetAddr(ip, port))
	if err != nil {
		http.Error(w, "upstream connection failed", http.StatusBadGateway)
		return
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		_ = upstreamConn.Close()
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hj.Hijack()
	if err != nil {
		_ = upstreamConn.Close()
		return
	}

	var closeBothOnce sync.Once
	closeBoth := func() {
		closeBothOnce.Do(func() {
			_ = clientConn.Close()
			_ = upstreamConn.Close()
		})
	}
	if registerTunnel != nil {
		unregister := registerTunnel(closeBoth)
		defer unregister()
	}
	defer closeBoth()

	_, _ = clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(upstreamConn, clientConn)
		closeBoth()
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(clientConn, upstreamConn)
		closeBoth()
	}()
	wg.Wait()
}

func (e *Engine) handleGateHTTP(ctx context.Context, w http.ResponseWriter, r *http.Request, timeout time.Duration) {
	if r.URL == nil || !r.URL.IsAbs() {
		http.Error(w, "upstream blocked by outbound security policy: absolute URL required", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodOptions:
	default:
		http.Error(w, "upstream blocked by outbound security policy: method not allowed", http.StatusMethodNotAllowed)
		return
	}

	const (
		maxHops                 = 5
		maxGateRequestBodyBytes = 1 << 20
	)
	var bodyBytes []byte
	if r.Body != nil {
		defer r.Body.Close()
		b, err := io.ReadAll(io.LimitReader(r.Body, maxGateRequestBodyBytes+1))
		if err != nil {
			http.Error(w, "failed to read request body", http.StatusBadRequest)
			return
		}
		if len(b) > maxGateRequestBodyBytes {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		bodyBytes = b
	}

	curURL := r.URL
	method := r.Method
	for hop := 0; hop <= maxHops; hop++ {
		scheme := strings.ToLower(curURL.Scheme)
		if scheme != "http" && scheme != "https" {
			http.Error(w, "upstream blocked by outbound security policy: invalid scheme", http.StatusForbidden)
			return
		}
		host := curURL.Hostname()
		port := curURL.Port()
		if port == "" {
			if scheme == "https" {
				port = "443"
			} else {
				port = "80"
			}
		}
		if err := e.validateOutboundPort(port); err != nil {
			http.Error(w, "upstream blocked by outbound security policy: "+err.Error(), http.StatusForbidden)
			return
		}
		ip, err := e.resolvePublicHostIP(ctx, host)
		if err != nil {
			http.Error(w, "upstream blocked by outbound security policy: "+err.Error(), http.StatusForbidden)
			return
		}
		targetAddr := e.dialTargetAddr(ip, port)
		transport := &http.Transport{
			Proxy:             nil,
			DisableKeepAlives: true,
			DialContext: func(dialCtx context.Context, network, _ string) (net.Conn, error) {
				d := &net.Dialer{Timeout: timeout}
				return d.DialContext(dialCtx, network, targetAddr)
			},
			TLSClientConfig: &tls.Config{
				ServerName:         host,
				MinVersion:         tls.VersionTLS12,
				InsecureSkipVerify: e.dialAddr != nil,
			},
		}
		client := &http.Client{
			Transport: transport,
			Timeout:   timeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		buildOutReq := func(reqURL *url.URL) (*http.Request, error) {
			var bodyReader io.Reader
			if len(bodyBytes) > 0 && method != http.MethodGet && method != http.MethodHead {
				bodyReader = bytes.NewReader(bodyBytes)
			}
			req, err := http.NewRequestWithContext(ctx, method, reqURL.String(), bodyReader)
			if err != nil {
				return nil, err
			}
			if bodyReader != nil {
				req.ContentLength = int64(len(bodyBytes))
			}
			req.Host = curURL.Host
			for k, vals := range r.Header {
				if strings.EqualFold(k, "Proxy-Connection") || strings.EqualFold(k, "Proxy-Authorization") {
					continue
				}
				if bodyReader == nil && (strings.EqualFold(k, "Content-Length") || strings.EqualFold(k, "Content-Type") || strings.EqualFold(k, "Transfer-Encoding")) {
					continue
				}
				for _, v := range vals {
					req.Header.Add(k, v)
				}
			}
			return req, nil
		}
		outReq, err := buildOutReq(curURL)
		if err != nil {
			http.Error(w, "upstream blocked by outbound security policy", http.StatusBadRequest)
			return
		}
		resp, err := client.Do(outReq)
		if err != nil && scheme == "https" && e.dialAddr != nil {
			plainURL := *curURL
			plainURL.Scheme = "http"
			if fallbackReq, reqErr := buildOutReq(&plainURL); reqErr == nil {
				resp, err = client.Do(fallbackReq)
			}
		}
		if err != nil {
			http.Error(w, "upstream request failed", http.StatusBadGateway)
			return
		}
		if isGateRedirect(resp.StatusCode) {
			loc := strings.TrimSpace(resp.Header.Get("Location"))
			_ = resp.Body.Close()
			if loc == "" {
				http.Error(w, "upstream redirect missing location", http.StatusBadGateway)
				return
			}
			nextURL, err := curURL.Parse(loc)
			if err != nil {
				http.Error(w, "upstream blocked by outbound security policy: bad redirect", http.StatusForbidden)
				return
			}
			curURL = nextURL
			if resp.StatusCode == http.StatusSeeOther ||
				((resp.StatusCode == http.StatusMovedPermanently || resp.StatusCode == http.StatusFound) && method == http.MethodPost) {
				method = http.MethodGet
				bodyBytes = nil
			}
			continue
		}
		defer resp.Body.Close()
		for k, vals := range resp.Header {
			for _, v := range vals {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, io.LimitReader(resp.Body, e.maxStdoutBytes))
		return
	}
	http.Error(w, "upstream blocked by outbound security policy: too many redirects", http.StatusForbidden)
}

func isGateRedirect(code int) bool {
	switch code {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	default:
		return false
	}
}
