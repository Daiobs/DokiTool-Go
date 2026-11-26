package weibo

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"
)

const mediaFixture = "https://f.video.weibocdn.com/synthetic.mp4?media_id=fixture&template=1080&ssig=synthetic"

func relayFixture(t *testing.T) (*MediaRelay, string) {
	t.Helper()
	key := strings.Repeat("t", 32)
	path, ok := Sign(mediaFixture, key, 1793361600, nil)
	if !ok {
		t.Fatal("cannot sign test URL")
	}
	relay := NewMediaRelay(key)
	relay.now = func() time.Time { return time.Unix(1793361600, 0) }
	relay.lookup = func(_ context.Context, host string) ([]netip.Addr, error) {
		if host != "f.video.weibocdn.com" {
			t.Fatal("unexpected DNS host:", host)
		}
		return []netip.Addr{netip.MustParseAddr("2001:4860:4860::8888"), netip.MustParseAddr("8.8.8.8")}, nil
	}
	return relay, path
}

func fakeMedia(status int, length string, contentRange string, body string) *http.Response {
	h := make(http.Header)
	h.Set("Content-Type", "video/mp4")
	if length != "" {
		h.Set("Content-Length", length)
	}
	if contentRange != "" {
		h.Set("Content-Range", contentRange)
	}
	return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(body))}
}

func TestMediaRelayFullAndRangeStreams(t *testing.T) {
	const body = "\x00\x00\x00\x0cftypDATA"
	for _, tc := range []struct {
		name, requested, upstream, expectedBody string
		status                                  int
		length, contentRange                    string
	}{
		{"full", "", body, body, 200, "12", ""},
		{"from-start", "bytes=0-7", body[:8], body[:8], 206, "8", "bytes 0-7/12"},
		{"interior", "bytes=4-7", body[4:8], body[4:8], 206, "4", "bytes 4-7/12"},
		{"suffix", "bytes=-4", body[8:], body[8:], 206, "4", "bytes 8-11/12"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			relay, path := relayFixture(t)
			resolved := 0
			relay.open = func(_ context.Context, raw string, address netip.Addr, byteRange string) (*http.Response, error) {
				resolved++
				if raw != mediaFixture || address.String() != "8.8.8.8" || byteRange != tc.requested {
					t.Fatalf("media target/range changed: %q %v %q", raw, address, byteRange)
				}
				return fakeMedia(tc.status, tc.length, tc.contentRange, tc.upstream), nil
			}
			req := httptest.NewRequest(http.MethodGet, path, nil)
			if tc.requested != "" {
				req.Header.Set("Range", tc.requested)
			}
			w := httptest.NewRecorder()
			relay.ServeHTTP(w, req)
			if w.Code != tc.status || w.Body.String() != tc.expectedBody || resolved != 1 {
				t.Fatalf("stream status=%d body=%q opens=%d", w.Code, w.Body.String(), resolved)
			}
			if w.Header().Get("Content-Type") != "video/mp4" || w.Header().Get("Content-Length") != tc.length || w.Header().Get("X-Accel-Buffering") != "no" || w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatalf("unexpected media headers: %v", w.Header())
			}
		})
	}
}

func TestMediaRelayHeadUsesEightByteGetProbe(t *testing.T) {
	relay, path := relayFixture(t)
	relay.open = func(_ context.Context, _ string, _ netip.Addr, byteRange string) (*http.Response, error) {
		if byteRange != "bytes=0-7" {
			t.Fatalf("HEAD request did not use bounded GET probe: %q", byteRange)
		}
		return fakeMedia(206, "8", "bytes 0-7/120", "\x00\x00\x00\x08ftyp"), nil
	}
	req := httptest.NewRequest(http.MethodHead, path, nil)
	req.Header.Set("Range", "bytes=0-999")
	w := httptest.NewRecorder()
	relay.ServeHTTP(w, req)
	if w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != "120" || w.Header().Get("Content-Range") != "" {
		t.Fatalf("HEAD metadata not reconstructed: code=%d headers=%v body=%s", w.Code, w.Header(), w.Body.String())
	}
}

func TestMediaRelayUnsatisfiedRange(t *testing.T) {
	relay, path := relayFixture(t)
	relay.open = func(_ context.Context, _ string, _ netip.Addr, byteRange string) (*http.Response, error) {
		if byteRange != "bytes=100-200" {
			t.Fatal("range lost")
		}
		return fakeMedia(416, "", "bytes */12", ""), nil
	}
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Range", "bytes=100-200")
	w := httptest.NewRecorder()
	relay.ServeHTTP(w, req)
	if w.Code != 416 || w.Body.Len() != 0 || w.Header().Get("Content-Range") != "bytes */12" || w.Header().Get("Content-Length") != "0" {
		t.Fatalf("416 protocol changed: %d %v %q", w.Code, w.Header(), w.Body.String())
	}
}

func TestMediaRelayRejectsUnverifiedBytesAndNoJSONAfterCommit(t *testing.T) {
	for _, tc := range []struct {
		name, contentType, body, length string
		expectedCode                    int
		expectedBytes                   string
	}{
		{"invalid-ftyp", "video/mp4", "\x00\x00\x00\x0cNOPEdata", "12", 502, ""},
		{"wrong-mime", "text/html", "<html>error</html>", "18", 502, ""},
		{"short-stream", "video/mp4", "\x00\x00\x00\x0cftyp", "12", 200, "\x00\x00\x00\x0cftyp"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			relay, path := relayFixture(t)
			relay.open = func(_ context.Context, _ string, _ netip.Addr, _ string) (*http.Response, error) {
				response := fakeMedia(200, tc.length, "", tc.body)
				response.Header.Set("Content-Type", tc.contentType)
				return response, nil
			}
			w := httptest.NewRecorder()
			relay.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
			if w.Code != tc.expectedCode {
				t.Fatalf("code=%d, want %d, body=%q", w.Code, tc.expectedCode, w.Body.String())
			}
			if tc.expectedCode == 200 {
				if w.Body.String() != tc.expectedBytes {
					t.Fatalf("truncated stream appended JSON: %q", w.Body.String())
				}
			} else {
				var envelope struct {
					Code int             `json:"code"`
					Msg  string          `json:"msg"`
					Data json.RawMessage `json:"data"`
				}
				if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil || envelope.Code != tc.expectedCode || string(envelope.Data) != "null" {
					t.Fatalf("media error not PHP legacy JSON: %q %v", w.Body.String(), err)
				}
			}
		})
	}
}

func TestMediaRelayAuthorizationAndMethodBoundary(t *testing.T) {
	relay, path := relayFixture(t)
	relay.open = func(context.Context, string, netip.Addr, string) (*http.Response, error) {
		t.Fatal("unauthorized request reached media network")
		return nil, errors.New("unexpected")
	}
	tests := []struct {
		name, method, path string
		code               int
	}{
		{"post", "POST", path, 405},
		{"unknown-param", "GET", path + "&url=https://evil.test/x", 400},
		{"invalid-ticket", "GET", "/api/media/weibo?ticket=invalid", 403},
		{"missing-ticket", "GET", "/api/media/weibo", 400},
		{"multi-range", "GET", path, 416},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			if tc.name == "multi-range" {
				req.Header.Add("Range", "bytes=0-7")
				req.Header.Add("Range", "bytes=8-11")
			}
			w := httptest.NewRecorder()
			relay.ServeHTTP(w, req)
			if w.Code != tc.code {
				t.Errorf("unexpected code %d want %d: %s", w.Code, tc.code, w.Body.String())
			}
			if tc.code == 405 && w.Header().Get("Allow") != "GET, HEAD" {
				t.Error("Allow GET/HEAD not set")
			}
		})
	}
	relay.key = "short"
	w := httptest.NewRecorder()
	relay.ServeHTTP(w, httptest.NewRequest(http.MethodHead, path, nil))
	if w.Code != 503 || w.Body.Len() != 0 {
		t.Errorf("invalid media key: status=%d body=%q", w.Code, w.Body.String())
	}
}

func TestMediaRelayUpstreamFailuresStayOutOfJSONContract(t *testing.T) {
	relay, path := relayFixture(t)
	relay.open = func(context.Context, string, netip.Addr, string) (*http.Response, error) {
		return nil, errors.New("synthetic failure")
	}
	w := httptest.NewRecorder()
	relay.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	if w.Code != 502 {
		t.Fatal("transport failure returned", w.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if got := payload["code"]; got != float64(502) {
		t.Fatal("legacy code changed:", got)
	}
	if payload["data"] != nil || payload["msg"] == nil {
		t.Fatal("legacy media contract broken")
	}
}

func TestMediaRelayMaxLengthRejectedBeforeBody(t *testing.T) {
	relay, path := relayFixture(t)
	relay.open = func(context.Context, string, netip.Addr, string) (*http.Response, error) {
		return fakeMedia(200, strconv.FormatInt(maxMediaBytes+1, 10), "", ""), nil
	}
	w := httptest.NewRecorder()
	relay.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	if w.Code != 413 || !strings.Contains(w.Body.String(), "1 GiB") {
		t.Fatalf("oversize media not rejected: %d %s", w.Code, w.Body.String())
	}
}

func TestMediaRelayStalledDownstreamReaderReleasesSlotAtWatchdog(t *testing.T) {
	relay, path := relayFixture(t)
	relay.rollingWindow = 120 * time.Millisecond
	relay.rollingMinBytes = 30 * 1024
	relay.writeBudget = 10 * time.Second

	// Stream a 32 MiB synthetic MP4 (exceeds loopback TCP buffers) so the server
	// blocks inside ResponseWriter.Write once the client stops reading.
	const totalBytes = 32 << 20
	var upstreamCanceled int32
	relay.open = func(ctx context.Context, _ string, _ netip.Addr, _ string) (*http.Response, error) {
		pr, pw := io.Pipe()
		go func() {
			defer pw.Close()
			header := []byte("\x00\x00\x00\x0cftypisom")
			if _, err := pw.Write(header); err != nil {
				return
			}
			chunk := make([]byte, 32*1024)
			for rem := totalBytes - len(header); rem > 0; {
				select {
				case <-ctx.Done():
					upstreamCanceled = 1
					_ = pw.CloseWithError(ctx.Err())
					return
				default:
				}
				n := len(chunk)
				if rem < n {
					n = rem
				}
				if _, err := pw.Write(chunk[:n]); err != nil {
					return
				}
				rem -= n
			}
		}()
		h := make(http.Header)
		h.Set("Content-Type", "video/mp4")
		h.Set("Content-Length", strconv.Itoa(totalBytes))
		return &http.Response{StatusCode: http.StatusOK, Header: h, Body: pr}, nil
	}

	handlerDone := make(chan time.Duration, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		relay.ServeHTTP(w, r)
		handlerDone <- time.Since(start)
	}))
	defer srv.Close()

	// Client reads headers then pauses without draining body (stalled downstream reader).
	resp, err := srv.Client().Get(srv.URL + path)
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	select {
	case elapsed := <-handlerDone:
		if elapsed >= 3*time.Second {
			t.Fatalf("handler held relay slot too long (%v); expected watchdog abort well below writeBudget", elapsed)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("handler stayed blocked in stalled ResponseWriter.Write past watchdog (NV-02)")
	}
	if len(relay.slots) != 0 {
		t.Fatalf("expected all relay slots released, still occupied: %d", len(relay.slots))
	}
	_ = upstreamCanceled
}
