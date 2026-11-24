package ytengine

import (
	"bytes"
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
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

// gateTestHooks holds test-only transport overrides configured exclusively by
// unexported test helpers within package ytengine. Production engines always
// run with testHooks == nil.
type gateTestHooks struct {
	dialAddr               func(netip.Addr, string) string
	rootCAs                *x509.CertPool
	allowCustomPort        bool
	allowPlaintextFallback bool
}

type gateSession struct {
	taskID              string
	authorization       string
	allowedOutboundHost func(string) bool
	resolver            Resolver
	testHooks           *gateTestHooks
	socketTimeout       time.Duration
	maxStdoutBytes      int64

	listener        *gateListener
	ephemeralServer bool

	ctx       context.Context
	cancel    context.CancelFunc
	stopWatch func() bool
	closeOnce sync.Once

	mu          sync.Mutex
	closing     bool
	nextConnID  uint64
	activeConns map[uint64]func()
	handlers    sync.WaitGroup
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
		if _, err := resolvePublicHostIP(ctx, host, e.allowedOutboundHost, e.resolver); err != nil {
			return &Error{Code: CodeUpstreamBlocked, Message: "目标地址解析到受限网络，已拒绝访问", Retryable: false, Cause: err}
		}
	}
	return nil
}

func resolvePublicHostIP(ctx context.Context, host string, allowedOutboundHost func(string) bool, resolver Resolver) (netip.Addr, error) {
	cleanHost := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if cleanHost == "" {
		return netip.Addr{}, errors.New("empty host")
	}
	if allowedOutboundHost != nil && !allowedOutboundHost(cleanHost) {
		return netip.Addr{}, fmt.Errorf("outbound host %s is not allowlisted", cleanHost)
	}
	if ip, err := netip.ParseAddr(cleanHost); err == nil {
		if !fetch.PublicIP(ip) {
			return netip.Addr{}, fmt.Errorf("non-public IP literal %s", ip)
		}
		return ip.Unmap(), nil
	}
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

func (e *Engine) resolvePublicHostIP(ctx context.Context, host string) (netip.Addr, error) {
	return resolvePublicHostIP(ctx, host, e.allowedOutboundHost, e.resolver)
}

func (s *gateSession) resolvePublicHostIP(ctx context.Context, host string) (netip.Addr, error) {
	return resolvePublicHostIP(ctx, host, s.allowedOutboundHost, s.resolver)
}

func (s *gateSession) validateOutboundPort(port string) error {
	if s.testHooks != nil && s.testHooks.allowCustomPort {
		return nil
	}
	if port != "80" && port != "443" {
		return fmt.Errorf("disallowed outbound port %s", port)
	}
	return nil
}

func (s *gateSession) dialTargetAddr(ip netip.Addr, port string) string {
	if s.testHooks != nil && s.testHooks.dialAddr != nil {
		if custom := s.testHooks.dialAddr(ip, port); custom != "" {
			return custom
		}
	}
	return net.JoinHostPort(ip.String(), port)
}

func (s *gateSession) registerConn(closeConn func()) (func(), bool) {
	s.mu.Lock()
	if s.closing || s.ctx.Err() != nil {
		s.mu.Unlock()
		closeConn()
		return func() {}, false
	}
	s.nextConnID++
	id := s.nextConnID
	s.activeConns[id] = closeConn
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		delete(s.activeConns, id)
		s.mu.Unlock()
	}, true
}

func (s *gateSession) close() {
	s.closeOnce.Do(func() {
		if s.listener != nil {
			s.listener.removeSession(s.taskID)
		}
		s.mu.Lock()
		s.closing = true
		stopWatch := s.stopWatch
		s.stopWatch = nil
		conns := make([]func(), 0, len(s.activeConns))
		for _, fn := range s.activeConns {
			conns = append(conns, fn)
		}
		s.activeConns = make(map[uint64]func())
		s.mu.Unlock()

		if stopWatch != nil {
			stopWatch()
		}
		s.cancel()
		for _, fn := range conns {
			fn()
		}
		if s.ephemeralServer && s.listener != nil {
			_ = s.listener.closeAll()
		}
		s.handlers.Wait()
	})
}

func parseProxyAuthTaskID(authHeader string) (string, bool) {
	if !strings.HasPrefix(authHeader, "Basic ") {
		return "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(authHeader, "Basic "))
	if err != nil {
		return "", false
	}
	username, _, ok := strings.Cut(string(decoded), ":")
	if !ok || !strings.HasPrefix(username, "task-") {
		return "", false
	}
	taskID := strings.TrimPrefix(username, "task-")
	if taskID == "" {
		return "", false
	}
	return taskID, true
}

func writeProxyAuthRequired(w http.ResponseWriter) {
	w.Header().Set("Proxy-Authenticate", `Basic realm="task"`)
	http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
}

func (gl *gateListener) acquireSession(authHeader string) (*gateSession, bool) {
	taskID, ok := parseProxyAuthTaskID(authHeader)
	if !ok {
		return nil, false
	}
	gl.mu.RLock()
	defer gl.mu.RUnlock()
	if gl.closed {
		return nil, false
	}
	sess, ok := gl.sessions[taskID]
	if !ok {
		return nil, false
	}
	if subtle.ConstantTimeCompare([]byte(authHeader), []byte(sess.authorization)) != 1 {
		return nil, false
	}
	sess.mu.Lock()
	if sess.closing {
		sess.mu.Unlock()
		return nil, false
	}
	sess.handlers.Add(1)
	sess.mu.Unlock()
	return sess, true
}

func (gl *gateListener) serveHTTP(w http.ResponseWriter, r *http.Request) {
	authVals := r.Header.Values("Proxy-Authorization")
	if len(authVals) != 1 {
		writeProxyAuthRequired(w)
		return
	}
	sess, ok := gl.acquireSession(authVals[0])
	if !ok {
		writeProxyAuthRequired(w)
		return
	}
	defer sess.handlers.Done()
	r.Header.Del("Proxy-Authorization")
	if r.Method == http.MethodConnect {
		sess.handleConnect(w, r)
		return
	}
	sess.handleHTTP(w, r)
}

func (e *Engine) startOutboundGate(ctx context.Context) (string, func(), error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return "", nil, err
	}

	var (
		gl        *gateListener
		ephemeral bool
		err       error
	)
	if e.gatePorts != nil {
		gl, err = e.gatePorts.pickListener()
		if err != nil {
			return "", nil, err
		}
	} else {
		ln, listenErr := net.Listen("tcp4", "127.0.0.1:0")
		if listenErr != nil {
			return "", nil, listenErr
		}
		gl = newGateListener(ln)
		ephemeral = true
	}

	socketTimeout := time.Duration(defaultSocketTimeoutSec) * time.Second
	if e.socketTimeoutSec > 0 {
		socketTimeout = time.Duration(e.socketTimeoutSec) * time.Second
	}
	maxStdout := e.maxStdoutBytes
	if maxStdout <= 0 {
		maxStdout = defaultMaxStdoutBytes
	}

	taskCtx, cancelTask := context.WithCancel(ctx)
	var (
		credential gateCredential
		sess       *gateSession
	)
	for attempt := 0; attempt < 4; attempt++ {
		credential, err = newGateCredential()
		if err != nil {
			cancelTask()
			if ephemeral {
				_ = gl.closeAll()
			}
			return "", nil, err
		}
		sess = &gateSession{
			taskID:              credential.taskID,
			authorization:       credential.authorization,
			allowedOutboundHost: e.allowedOutboundHost,
			resolver:            e.resolver,
			testHooks:           e.testHooks,
			socketTimeout:       socketTimeout,
			maxStdoutBytes:      maxStdout,
			listener:            gl,
			ephemeralServer:     ephemeral,
			ctx:                 taskCtx,
			cancel:              cancelTask,
			activeConns:         make(map[uint64]func()),
		}
		err = gl.registerSession(sess)
		if err == nil {
			break
		}
		if err.Error() != "duplicate proxy task id" {
			cancelTask()
			if ephemeral {
				_ = gl.closeAll()
			}
			return "", nil, err
		}
	}
	if err != nil {
		cancelTask()
		if ephemeral {
			_ = gl.closeAll()
		}
		return "", nil, err
	}

	closeGate := func() {
		sess.close()
		cancelTask()
	}
	sess.mu.Lock()
	if !sess.closing {
		sess.stopWatch = context.AfterFunc(ctx, closeGate)
	}
	sess.mu.Unlock()

	proxyURL := &url.URL{
		Scheme: "http",
		Host:   gl.addr,
		User:   url.UserPassword(credential.username, credential.password),
	}
	return proxyURL.String(), closeGate, nil
}

func (s *gateSession) handleConnect(w http.ResponseWriter, r *http.Request) {
	reqCtx, reqCancel := context.WithCancel(s.ctx)
	stopReqCancel := context.AfterFunc(r.Context(), reqCancel)
	defer stopReqCancel()
	defer reqCancel()

	host, port, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
		port = "443"
	}
	if err := s.validateOutboundPort(port); err != nil {
		http.Error(w, "upstream blocked by outbound security policy: "+err.Error(), http.StatusForbidden)
		return
	}
	ip, err := s.resolvePublicHostIP(reqCtx, host)
	if err != nil {
		http.Error(w, "upstream blocked by outbound security policy: "+err.Error(), http.StatusForbidden)
		return
	}
	dialer := &net.Dialer{Timeout: s.socketTimeout}
	upstreamConn, err := dialer.DialContext(reqCtx, "tcp", s.dialTargetAddr(ip, port))
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
	clientConn, bufrw, err := hj.Hijack()
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
	unregister, ok := s.registerConn(closeBoth)
	if !ok {
		closeBoth()
		return
	}
	defer unregister()
	defer closeBoth()

	if _, err := clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		return
	}
	var clientReader io.Reader = clientConn
	if bufrw != nil && bufrw.Reader.Buffered() > 0 {
		clientReader = bufrw.Reader
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(upstreamConn, clientReader)
		closeBoth()
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(clientConn, upstreamConn)
		closeBoth()
	}()
	wg.Wait()
}

func (s *gateSession) handleHTTP(w http.ResponseWriter, r *http.Request) {
	reqCtx, reqCancel := context.WithCancel(s.ctx)
	stopReqCancel := context.AfterFunc(r.Context(), reqCancel)
	defer stopReqCancel()
	defer reqCancel()

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
		var unregisterRead func()
		if r.Body != http.NoBody {
			rc := http.NewResponseController(w)
			unreg, ok := s.registerConn(func() {
				_ = rc.SetReadDeadline(time.Now())
			})
			if !ok {
				http.Error(w, "proxy task closed", http.StatusServiceUnavailable)
				return
			}
			unregisterRead = unreg
		}
		b, err := io.ReadAll(io.LimitReader(r.Body, maxGateRequestBodyBytes+1))
		if unregisterRead != nil {
			unregisterRead()
		}
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
	stripCreds := false
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
		if err := s.validateOutboundPort(port); err != nil {
			http.Error(w, "upstream blocked by outbound security policy: "+err.Error(), http.StatusForbidden)
			return
		}
		ip, err := s.resolvePublicHostIP(reqCtx, host)
		if err != nil {
			http.Error(w, "upstream blocked by outbound security policy: "+err.Error(), http.StatusForbidden)
			return
		}
		targetAddr := s.dialTargetAddr(ip, port)
		tlsCfg := &tls.Config{
			ServerName: host,
			MinVersion: tls.VersionTLS12,
		}
		if s.testHooks != nil && s.testHooks.rootCAs != nil {
			tlsCfg.RootCAs = s.testHooks.rootCAs
		}

		var (
			hopConnsMu     sync.Mutex
			hopUnregisters []func()
		)
		unregisterHopConns := func() {
			hopConnsMu.Lock()
			list := hopUnregisters
			hopUnregisters = nil
			hopConnsMu.Unlock()
			for _, fn := range list {
				fn()
			}
		}
		transport := &http.Transport{
			Proxy:             nil,
			DisableKeepAlives: true,
			DialContext: func(dialCtx context.Context, network, _ string) (net.Conn, error) {
				d := &net.Dialer{Timeout: s.socketTimeout}
				conn, dialErr := d.DialContext(dialCtx, network, targetAddr)
				if dialErr != nil {
					return nil, dialErr
				}
				unreg, ok := s.registerConn(func() {
					_ = conn.Close()
				})
				if !ok {
					_ = conn.Close()
					return nil, errors.New("proxy session closed")
				}
				hopConnsMu.Lock()
				hopUnregisters = append(hopUnregisters, unreg)
				hopConnsMu.Unlock()
				return conn, nil
			},
			TLSClientConfig: tlsCfg,
		}
		client := &http.Client{
			Transport: transport,
			Timeout:   s.socketTimeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		buildOutReq := func(reqURL *url.URL) (*http.Request, error) {
			var bodyReader io.Reader
			if len(bodyBytes) > 0 && method != http.MethodGet && method != http.MethodHead {
				bodyReader = bytes.NewReader(bodyBytes)
			}
			req, err := http.NewRequestWithContext(reqCtx, method, reqURL.String(), bodyReader)
			if err != nil {
				return nil, err
			}
			if bodyReader != nil {
				req.ContentLength = int64(len(bodyBytes))
			}
			req.Host = reqURL.Host
			for k, vals := range r.Header {
				if strings.EqualFold(k, "Proxy-Connection") || strings.EqualFold(k, "Proxy-Authorization") {
					continue
				}
				if stripCreds && (strings.EqualFold(k, "Authorization") || strings.EqualFold(k, "Cookie")) {
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
			unregisterHopConns()
			transport.CloseIdleConnections()
			http.Error(w, "upstream blocked by outbound security policy", http.StatusBadRequest)
			return
		}
		resp, err := client.Do(outReq)
		if err != nil && scheme == "https" && s.testHooks != nil && s.testHooks.allowPlaintextFallback {
			plainURL := *curURL
			plainURL.Scheme = "http"
			if fallbackReq, reqErr := buildOutReq(&plainURL); reqErr == nil {
				resp, err = client.Do(fallbackReq)
			}
		}
		if err != nil {
			unregisterHopConns()
			transport.CloseIdleConnections()
			http.Error(w, "upstream request failed", http.StatusBadGateway)
			return
		}
		if isGateRedirect(resp.StatusCode) {
			loc := strings.TrimSpace(resp.Header.Get("Location"))
			_ = resp.Body.Close()
			unregisterHopConns()
			transport.CloseIdleConnections()
			if loc == "" {
				http.Error(w, "upstream redirect missing location", http.StatusBadGateway)
				return
			}
			nextURL, err := curURL.Parse(loc)
			if err != nil {
				http.Error(w, "upstream blocked by outbound security policy: bad redirect", http.StatusForbidden)
				return
			}
			if !strings.EqualFold(nextURL.Host, curURL.Host) ||
				(strings.EqualFold(curURL.Scheme, "https") && strings.EqualFold(nextURL.Scheme, "http")) {
				stripCreds = true
			}
			curURL = nextURL
			if resp.StatusCode == http.StatusSeeOther ||
				((resp.StatusCode == http.StatusMovedPermanently || resp.StatusCode == http.StatusFound) && method == http.MethodPost) {
				method = http.MethodGet
				bodyBytes = nil
			}
			continue
		}
		for k, vals := range resp.Header {
			for _, v := range vals {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, io.LimitReader(resp.Body, s.maxStdoutBytes))
		_ = resp.Body.Close()
		unregisterHopConns()
		transport.CloseIdleConnections()
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
