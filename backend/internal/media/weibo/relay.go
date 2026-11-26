package weibo

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const (
	mediaBudget            = 300 * time.Second
	mediaWriteBudget       = 310 * time.Second
	mediaSlots             = 12
	defaultRollingWindow   = 30 * time.Second
	defaultRollingMinBytes = 30 * 1024
)

// MediaRelay implements the existing PHP binary response boundary, not the
// unified JSON API and not a general-purpose URL proxy. The only outbound
// target is the exact CDN host authenticated by the PHP-compatible ticket.
type MediaRelay struct {
	key             string
	now             func() time.Time
	lookup          DNSLookup
	open            func(context.Context, string, netip.Addr, string) (*http.Response, error)
	slots           chan struct{}
	writeBudget     time.Duration
	rollingWindow   time.Duration
	rollingMinBytes int64
}

func NewMediaRelay(key string) *MediaRelay {
	return &MediaRelay{
		key: key, now: time.Now, lookup: defaultDNS,
		open: fetch.OpenWeiboMedia, slots: make(chan struct{}, mediaSlots),
		writeBudget:     mediaWriteBudget,
		rollingWindow:   defaultRollingWindow,
		rollingMinBytes: defaultRollingMinBytes,
	}
}

func (m *MediaRelay) effectiveWriteBudget() time.Duration {
	if m != nil && m.writeBudget > 0 {
		return m.writeBudget
	}
	return mediaWriteBudget
}

func (m *MediaRelay) effectiveRollingWindow() time.Duration {
	if m != nil && m.rollingWindow > 0 {
		return m.rollingWindow
	}
	return defaultRollingWindow
}

func (m *MediaRelay) effectiveRollingMinBytes() int64 {
	if m != nil && m.rollingMinBytes > 0 {
		return m.rollingMinBytes
	}
	return defaultRollingMinBytes
}

func mediaError(w http.ResponseWriter, method string, status int, message string) {
	h := w.Header()
	h.Del("Access-Control-Allow-Origin")
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Accept-Ranges", "bytes")
	h.Set("Content-Type", "application/json; charset=utf-8")
	if status == http.StatusMethodNotAllowed {
		h.Set("Allow", "GET, HEAD")
	}
	w.WriteHeader(status)
	if method != http.MethodHead {
		body, _ := json.Marshal(struct {
			Code int    `json:"code"`
			Msg  string `json:"msg"`
			Data any    `json:"data"`
		}{Code: status, Msg: message})
		_, _ = w.Write(body)
	}
}

func planHeaders(plan unified.Object) (http.Header, int, int64, int64, bool) {
	status, ok := unified.PHPInt(plan["status"])
	if !ok || status < 100 || status > 599 {
		return nil, 0, 0, 0, false
	}
	headers := make(http.Header)
	for name, value := range unified.Map(plan["headers"]) {
		headers.Set(name, unified.Str(value))
	}
	length, _ := unified.PHPInt(plan["length"])
	start, _ := unified.PHPInt(plan["start"])
	return headers, int(status), length, start, true
}

func publishMedia(w http.ResponseWriter, status int, headers http.Header) {
	h := w.Header()
	h.Del("Access-Control-Allow-Origin")
	for name, values := range headers {
		for _, value := range values {
			h.Add(name, value)
		}
	}
	w.WriteHeader(status)
}

type mediaFlusher struct {
	target http.ResponseWriter
	bytes  *atomic.Int64
}

func (f mediaFlusher) Write(bytes []byte) (int, error) {
	n, err := f.target.Write(bytes)
	if n > 0 {
		if flush, ok := f.target.(http.Flusher); ok {
			flush.Flush()
		}
		if f.bytes != nil {
			f.bytes.Add(int64(n))
		}
	}
	return n, err
}

// copyLimited bounds memory, duration and the rolling downstream transfer
// minimum. The caller has already verified headers and the optional ftyp
// prefix; if a later read/write fails, it MUST NOT append a JSON error to media.
func copyLimited(
	ctx context.Context,
	cancel context.CancelFunc,
	w http.ResponseWriter,
	body io.Reader,
	remaining int64,
	window time.Duration,
	minBytes int64,
) error {
	if remaining == 0 {
		return nil
	}
	if window <= 0 {
		window = defaultRollingWindow
	}
	if minBytes <= 0 {
		minBytes = defaultRollingMinBytes
	}
	var written atomic.Int64
	complete := make(chan struct{})
	watchdogDone := make(chan struct{})
	go func() {
		defer close(watchdogDone)
		ticker := time.NewTicker(window)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if written.Swap(0) < minBytes {
					cancel()
					// Interrupt a blocked downstream ResponseWriter.Write so stalled
					// readers cannot hold global relay slots until mediaWriteBudget.
					_ = http.NewResponseController(w).SetWriteDeadline(time.Now())
					return
				}
			case <-complete:
				return
			case <-ctx.Done():
				_ = http.NewResponseController(w).SetWriteDeadline(time.Now())
				return
			}
		}
	}()
	defer func() {
		close(complete)
		<-watchdogDone
	}()
	_, err := io.CopyN(mediaFlusher{target: w, bytes: &written}, body, remaining)
	return err
}

func headerMap(in http.Header) map[string]string {
	result := make(map[string]string, len(in))
	for key, values := range in {
		result[strings.ToLower(key)] = strings.Join(values, ", ")
	}
	return result
}

// ServeHTTP honors the 50-second ordinary JSON WriteTimeout without letting
// that deadline truncate the 300-second media budget. Each media response has
// its own explicitly extended write deadline; server shutdown must also have
// a 310-second drain window. HEAD probes eight bytes via GET, as the CDN does
// not support native HEAD, and never writes a response body.
func (m *MediaRelay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if m == nil {
		mediaError(w, r.Method, 503, "微博媒体服务未配置完成")
		return
	}
	query, validQuery := PHPQuery(r.URL.RawQuery)
	if !validQuery {
		query = unified.Object{"unknown": true}
	}
	rangeHeader := r.Header.Get("Range")
	if r.Method == http.MethodGet && len(r.Header.Values("Range")) > 1 {
		rangeHeader = "bytes=0-1,3-4"
	}
	ctx, cancel := context.WithTimeout(r.Context(), mediaBudget)
	defer cancel()
	prepared := Prepare(ctx, r.Method, query, rangeHeader, m.key, m.now().Unix(), m.lookup)
	if prepared["ok"] != true {
		status, ok := unified.PHPInt(prepared["status"])
		if !ok {
			status = 502
		}
		mediaError(w, r.Method, int(status), unified.Str(prepared["message"]))
		return
	}
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(m.effectiveWriteBudget())); err != nil && !errors.Is(err, http.ErrNotSupported) {
		mediaError(w, r.Method, 503, "微博媒体服务暂不可用，请稍后重试")
		return
	}
	select {
	case m.slots <- struct{}{}:
		defer func() { <-m.slots }()
	default:
		mediaError(w, r.Method, 503, "微博媒体服务繁忙，请稍后重试")
		return
	}

	ip, err := netip.ParseAddr(unified.Str(prepared["ip"]))
	if err != nil || !fetch.PublicIP(ip) {
		mediaError(w, r.Method, 502, "微博媒体地址暂不可用，请稍后重试")
		return
	}
	requested := unified.Map(prepared["range"])
	if r.Method == http.MethodHead {
		requested, _ = ParseRange("bytes=0-7")
	}
	upstreamRange := ""
	if requested != nil {
		upstreamRange = unified.Str(requested["header"])
	}
	response, err := m.open(ctx, unified.Str(prepared["url"]), ip, upstreamRange)
	if err != nil || response == nil || response.Body == nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		mediaError(w, r.Method, 502, "微博视频传输未完成，请重试或重新解析")
		return
	}
	defer response.Body.Close()
	plan := ResponsePlan(response.StatusCode, headerMap(response.Header), requested)
	if plan["ok"] != true {
		status, ok := unified.PHPInt(plan["status"])
		if !ok {
			status = 502
		}
		mediaError(w, r.Method, int(status), unified.Str(plan["message"]))
		return
	}
	headers, status, length, start, ok := planHeaders(plan)
	if !ok {
		mediaError(w, r.Method, 502, "微博视频传输未完成，请重试或重新解析")
		return
	}
	if status == http.StatusRequestedRangeNotSatisfiable {
		publishMedia(w, status, headers)
		return
	}

	// Never send an unverified MP4 prefix, even when the CDN advertises the
	// correct status, length and MIME. For non-zero ranges this check is not
	// meaningful; PHP does not impose it on those ranges either.
	var prefix []byte
	if start == 0 && length >= 8 {
		prefix = make([]byte, 8)
		if _, err := io.ReadFull(response.Body, prefix); err != nil || string(prefix[4:8]) != "ftyp" {
			mediaError(w, r.Method, 502, "微博视频传输未完成，请重试或重新解析")
			return
		}
	} else {
		// PHP commits media headers only once the first chunk is available.
		// These ranges cannot carry a complete ftyp signature, but still need
		// a byte before a successful 206 can be published. An empty/erroring
		// upstream body must remain a 502 JSON error before media is committed.
		prefix = make([]byte, 1)
		if _, err := io.ReadFull(response.Body, prefix); err != nil {
			mediaError(w, r.Method, 502, "微博视频传输未完成，请重试或重新解析")
			return
		}
	}
	if r.Method == http.MethodHead {
		match := partialSyntax.FindStringSubmatch(headers.Get("Content-Range"))
		if status != http.StatusPartialContent || match == nil || match[1] != "0" || match[2] != "7" || length != 8 {
			mediaError(w, r.Method, 502, "微博视频元信息暂不可用，请重试或重新解析")
			return
		}
		fullLength, err := strconv.ParseInt(match[3], 10, 64)
		if err != nil || fullLength < 8 || fullLength > maxMediaBytes {
			mediaError(w, r.Method, 502, "微博视频元信息暂不可用，请重试或重新解析")
			return
		}
		headers.Set("Content-Length", strconv.FormatInt(fullLength, 10))
		headers.Del("Content-Range")
		publishMedia(w, http.StatusOK, headers)
		return
	}

	publishMedia(w, status, headers)
	if len(prefix) != 0 {
		if _, err := (mediaFlusher{target: w}).Write(prefix); err != nil {
			return
		}
		length -= int64(len(prefix))
	}
	// After headers or media bytes have been committed, return silently on
	// incomplete upstream data. Appending JSON would corrupt the saved file.
	_ = copyLimited(ctx, cancel, w, response.Body, length, m.effectiveRollingWindow(), m.effectiveRollingMinBytes())
}
