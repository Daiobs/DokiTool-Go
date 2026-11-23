package ytengine

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
)

const (
	sizeProbeTotalTimeout = 1500 * time.Millisecond
	sizeProbeConcurrency  = 4
	maxProbedURLs         = 12
	maxProbeBodyBytes     = 4096
)

var (
	strictContentRangePattern = regexp.MustCompile(`^bytes 0-([0-9]{1,4})/([1-9][0-9]{0,15})$`)
	strictPositiveIntPattern  = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
)

// SizeProber resolves the exact byte length of a progressive MP4 URL.
// Returning (0, false) leaves the format's Filesize unset (fail-soft).
type SizeProber func(ctx context.Context, rawURL string) (int64, bool)

// NewSizeProber creates a bounded, no-redirect HTTP Range size prober backed by
// fetch.Executor (enforcing public-IP DNS verification, pinned IP dialing, and
// no environment proxy inheritance) and strict media header/magic validation.
func NewSizeProber(executor fetch.Executor, allowedMediaURL func(string) bool) SizeProber {
	if executor == nil {
		executor = fetch.New()
	}
	return func(ctx context.Context, rawURL string) (int64, bool) {
		cleanURL := SanitizeMediaURL(rawURL, allowedMediaURL)
		if cleanURL == "" {
			return 0, false
		}
		resp, err := executor.Do(ctx, fetch.Request{
			Method: http.MethodGet,
			URL:    cleanURL,
			Header: http.Header{
				"Range":           {"bytes=0-0"},
				"Accept":          {"*/*"},
				"Accept-Encoding": {"identity"},
			},
			Policy: fetch.Policy{
				Purpose: "ytengine_size_probe",
				AllowedURL: func(candidate string) bool {
					return SanitizeMediaURL(candidate, allowedMediaURL) != ""
				},
				Timeout:         sizeProbeTotalTimeout,
				MaxBytes:        maxProbeBodyBytes,
				FollowRedirects: false,
			},
		})
		if err != nil {
			return 0, false
		}
		return ValidateProbedMediaResponse(resp.StatusCode, resp.Header, resp.Body)
	}
}

// NewHTTPSizeProber creates a bounded, no-redirect HTTP Range size prober
// restricted to URLs permitted by allowedMediaURL. When proxyURL is empty, it
// delegates directly to NewSizeProber(fetch.New(), allowedMediaURL) and never
// inherits environment proxies. When proxyURL is non-empty, it fails closed
// (returning a no-op prober) rather than bypassing fetch.Executor's hop-by-hop
// DNS and public-IP boundary.
func NewHTTPSizeProber(proxyURL string, allowedMediaURL func(string) bool) SizeProber {
	if strings.TrimSpace(proxyURL) != "" {
		return func(context.Context, string) (int64, bool) { return 0, false }
	}
	return NewSizeProber(fetch.New(), allowedMediaURL)
}

// ValidateProbedMediaResponse validates an HTTP Range probe response and extracts
// an exact media byte size only when headers and body prove a genuine media response.
func ValidateProbedMediaResponse(status int, headers http.Header, body []byte) (int64, bool) {
	if !validCriticalProbeHeaders(headers) {
		return 0, false
	}
	encoding := strings.ToLower(strings.TrimSpace(headers.Get("Content-Encoding")))
	if encoding != "" && encoding != "identity" {
		return 0, false
	}
	if !isAllowedMediaContentType(headers.Get("Content-Type")) {
		return 0, false
	}

	switch status {
	case http.StatusPartialContent:
		cr := strings.TrimSpace(headers.Get("Content-Range"))
		m := strictContentRangePattern.FindStringSubmatch(cr)
		if m == nil {
			return 0, false
		}
		end, err1 := strconv.ParseInt(m[1], 10, 64)
		total, err2 := strconv.ParseInt(m[2], 10, 64)
		if err1 != nil || err2 != nil || end < 0 || total <= end || total > maxSafeInteger {
			return 0, false
		}
		expectedWindow := end + 1
		if cl := strings.TrimSpace(headers.Get("Content-Length")); cl != "" {
			clVal, ok := parsePositiveContentLength(cl)
			if !ok || clVal != expectedWindow {
				return 0, false
			}
		}
		if int64(len(body)) != expectedWindow {
			return 0, false
		}
		return total, true

	case http.StatusOK:
		if strings.TrimSpace(headers.Get("Content-Range")) != "" ||
			strings.TrimSpace(headers.Get("Transfer-Encoding")) != "" {
			return 0, false
		}
		size, ok := parsePositiveContentLength(headers.Get("Content-Length"))
		if !ok || size < 12 || size > maxProbeBodyBytes || int64(len(body)) != size {
			return 0, false
		}
		if !hasValidMediaMagic(body) {
			return 0, false
		}
		return size, true
	}
	return 0, false
}

func validCriticalProbeHeaders(headers http.Header) bool {
	for _, name := range []string{"Content-Length", "Content-Range", "Content-Encoding", "Content-Type", "Transfer-Encoding"} {
		values := headers.Values(name)
		if len(values) > 1 {
			return false
		}
		if len(values) == 1 && name != "Content-Type" && strings.Contains(values[0], ",") {
			return false
		}
	}
	return true
}

func isAllowedMediaContentType(raw string) bool {
	ct := strings.ToLower(strings.TrimSpace(strings.Split(raw, ";")[0]))
	if ct == "" {
		return false
	}
	return strings.HasPrefix(ct, "video/") ||
		strings.HasPrefix(ct, "audio/") ||
		ct == "application/mp4" ||
		ct == "application/octet-stream"
}

func hasValidMediaMagic(body []byte) bool {
	if len(body) >= 12 && bytes.Equal(body[4:8], []byte("ftyp")) {
		return true
	}
	if len(body) >= 4 && bytes.Equal(body[:4], []byte{0x1a, 0x45, 0xdf, 0xa3}) {
		return true
	}
	return false
}

func parsePositiveContentLength(raw string) (int64, bool) {
	trimmed := strings.TrimSpace(raw)
	if !strictPositiveIntPattern.MatchString(trimmed) {
		return 0, false
	}
	n, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil || n <= 0 || n > maxSafeInteger {
		return 0, false
	}
	return n, true
}

// PopulateMissingMP4Sizes concurrently probes exact byte lengths for progressive MP4
// formats that lack an exact Filesize from yt-dlp. Any probe failure is ignored (fail-soft).
func PopulateMissingMP4Sizes(ctx context.Context, info *Info, prober SizeProber, opts AdaptOptions) {
	if info == nil || prober == nil || opts.SingleStreamHLSOnly {
		return
	}
	maxEntries := opts.MaxEntries
	if maxEntries <= 0 {
		maxEntries = 4
	}
	var entries []*Info
	if len(info.Entries) > 0 {
		limit := len(info.Entries)
		if limit > maxEntries {
			limit = maxEntries
		}
		for i := 0; i < limit; i++ {
			entries = append(entries, &info.Entries[i])
		}
	} else {
		entries = []*Info{info}
	}

	var uniqueURLs []string
	seen := make(map[string]bool)
	for _, entry := range entries {
		for _, f := range entry.Formats {
			if f.Filesize != nil && *f.Filesize > 0 {
				continue
			}
			cleanURL := SanitizeMediaURL(f.URL, opts.AllowedMediaURL)
			if cleanURL == "" {
				continue
			}
			fCopy := f
			fCopy.URL = cleanURL
			if !isProgressiveVideoFormat(fCopy, opts) {
				continue
			}
			if !seen[cleanURL] {
				seen[cleanURL] = true
				uniqueURLs = append(uniqueURLs, cleanURL)
				if len(uniqueURLs) >= maxProbedURLs {
					break
				}
			}
		}
		if len(uniqueURLs) >= maxProbedURLs {
			break
		}
	}

	if len(uniqueURLs) == 0 {
		return
	}

	probeCtx, cancel := context.WithTimeout(ctx, sizeProbeTotalTimeout)
	defer cancel()

	var (
		mu      sync.Mutex
		results = make(map[string]int64, len(uniqueURLs))
		sem     = make(chan struct{}, sizeProbeConcurrency)
		wg      sync.WaitGroup
	)

	for _, targetURL := range uniqueURLs {
		wg.Add(1)
		go func(u string) {
			defer wg.Done()
			defer func() {
				if recovered := recover(); recovered != nil {
					log.Printf("ytengine: size probe goroutine panic recovered: panic_type=%T", recovered)
				}
			}()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-probeCtx.Done():
				return
			}
			if size, ok := prober(probeCtx, u); ok && size > 0 && size <= maxSafeInteger {
				mu.Lock()
				results[u] = size
				mu.Unlock()
			}
		}(targetURL)
	}
	wg.Wait()

	if len(results) == 0 {
		return
	}

	for _, entry := range entries {
		for i := range entry.Formats {
			f := &entry.Formats[i]
			if f.Filesize != nil && *f.Filesize > 0 {
				continue
			}
			cleanURL := SanitizeMediaURL(f.URL, opts.AllowedMediaURL)
			if size, ok := results[cleanURL]; ok {
				sz := size
				f.Filesize = &sz
			}
		}
	}
}
