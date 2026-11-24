package ytengine

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// gateListener owns one loopback HTTP proxy listener and the isolated per-task
// sessions currently bound to that listener.
type gateListener struct {
	port int
	addr string
	ln   net.Listener
	srv  *http.Server

	mu       sync.RWMutex
	closed   bool
	sessions map[string]*gateSession
}

func newGateListener(ln net.Listener) *gateListener {
	port := 0
	if tcpAddr, ok := ln.Addr().(*net.TCPAddr); ok {
		port = tcpAddr.Port
	}
	gl := &gateListener{
		port:     port,
		addr:     ln.Addr().String(),
		ln:       ln,
		sessions: make(map[string]*gateSession),
	}
	gl.srv = &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		Handler:           http.HandlerFunc(gl.serveHTTP),
	}
	go func() {
		_ = gl.srv.Serve(ln)
	}()
	return gl
}

func (gl *gateListener) registerSession(sess *gateSession) error {
	gl.mu.Lock()
	defer gl.mu.Unlock()
	if gl.closed {
		return errors.New("outbound gateway is closed")
	}
	if _, exists := gl.sessions[sess.taskID]; exists {
		return errors.New("duplicate proxy task id")
	}
	gl.sessions[sess.taskID] = sess
	return nil
}

func (gl *gateListener) removeSession(taskID string) {
	gl.mu.Lock()
	delete(gl.sessions, taskID)
	gl.mu.Unlock()
}

func (gl *gateListener) sessionCount() int {
	gl.mu.RLock()
	n := len(gl.sessions)
	gl.mu.RUnlock()
	return n
}

func (gl *gateListener) closeAll() error {
	gl.mu.Lock()
	if gl.closed {
		gl.mu.Unlock()
		return nil
	}
	gl.closed = true
	sessions := make([]*gateSession, 0, len(gl.sessions))
	for _, sess := range gl.sessions {
		sessions = append(sessions, sess)
	}
	gl.sessions = make(map[string]*gateSession)
	gl.mu.Unlock()

	var firstErr error
	if err := gl.ln.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		firstErr = err
	}
	if err := gl.srv.Close(); err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, http.ErrServerClosed) && firstErr == nil {
		firstErr = err
	}
	for _, sess := range sessions {
		sess.close()
	}
	return firstErr
}

// gatePortPool manages persistent multiplexed fixed-port loopback proxy listeners
// shared by the base engine and all derived copies (WithTargetPolicy, WithExtractors,
// WithSlotPool, WithCompartment, WithGenericConcurrency).
// An empty configuration (nil gatePortPool) retains dynamic 127.0.0.1:0 per-task listening.
type gatePortPool struct {
	mu        sync.Mutex
	ports     []int
	listeners []*gateListener
	nextIdx   uint64
	closed    bool
}

func parseGatePorts(raw string) ([]int, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var ports []int
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" || strings.IndexFunc(part, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
			return nil, errors.New("DOKITOOL_YTDLP_GATE_PORTS must be comma-separated decimal ports")
		}
		port, err := strconv.Atoi(part)
		if err != nil {
			return nil, errors.New("DOKITOOL_YTDLP_GATE_PORTS contains an invalid port")
		}
		ports = append(ports, port)
	}
	return ports, nil
}

func newGatePortPool(ports []int) (*gatePortPool, error) {
	if len(ports) == 0 {
		return nil, nil
	}
	if len(ports) > maxAllowedConcurrency {
		return nil, fmt.Errorf("DOKITOOL_YTDLP_GATE_PORTS count must be between 1 and %d", maxAllowedConcurrency)
	}
	seen := make(map[int]bool, len(ports))
	for _, port := range ports {
		if port < 1024 || port > 65535 || seen[port] {
			return nil, errors.New("DOKITOOL_YTDLP_GATE_PORTS must contain unique ports between 1024 and 65535")
		}
		seen[port] = true
	}
	return &gatePortPool{ports: append([]int(nil), ports...)}, nil
}

func (p *gatePortPool) ensureStartedLocked() error {
	if p.closed {
		return errors.New("outbound gateway is closed")
	}
	if len(p.listeners) > 0 {
		return nil
	}
	var skippedPorts []int
	for _, port := range p.ports {
		ln, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			// Never connect to an existing service or fall back to :0.
			skippedPorts = append(skippedPorts, port)
			continue
		}
		p.listeners = append(p.listeners, newGateListener(ln))
	}
	if len(p.listeners) == 0 {
		return errors.New("configured loopback gateway ports are busy or unavailable")
	}
	if len(skippedPorts) > 0 {
		log.Printf("dokitool: yt-dlp outbound gateway skipped busy ports %v (listening on %d/%d configured ports)", skippedPorts, len(p.listeners), len(p.ports))
	}
	return nil
}

func (p *gatePortPool) pickListener() (*gateListener, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.ensureStartedLocked(); err != nil {
		return nil, err
	}
	gl := p.listeners[p.nextIdx%uint64(len(p.listeners))]
	p.nextIdx++
	return gl, nil
}

func (p *gatePortPool) activeSessionCount() int {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	listeners := append([]*gateListener(nil), p.listeners...)
	p.mu.Unlock()
	total := 0
	for _, gl := range listeners {
		total += gl.sessionCount()
	}
	return total
}

func (p *gatePortPool) Close() error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	listeners := p.listeners
	p.listeners = nil
	p.mu.Unlock()

	var firstErr error
	for _, gl := range listeners {
		if err := gl.closeAll(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

type gateCredential struct {
	taskID        string
	username      string
	password      string
	authorization string
}

func newGateCredential() (gateCredential, error) {
	var idBytes [8]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		return gateCredential{}, errors.New("generate proxy task id failed")
	}
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return gateCredential{}, errors.New("generate proxy task credential failed")
	}
	taskID := hex.EncodeToString(idBytes[:])
	username := "task-" + taskID
	password := base64.RawURLEncoding.EncodeToString(entropy[:])
	return gateCredential{
		taskID:        taskID,
		username:      username,
		password:      password,
		authorization: "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password)),
	}, nil
}
