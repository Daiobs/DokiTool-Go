package bilibili

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const (
	// ShanghaiPlayTimeout bounds Shanghai's domestic GET to api.bilibili.com/x/player/playurl.
	// Domestic RTT is ~50-250ms with zero media byte probing, so 2.5s provides ~10x
	// headroom while fitting inside Japan's 3.0s total Shanghai budget.
	ShanghaiPlayTimeout = 2500 * time.Millisecond

	// ShanghaiTotalBudget is the maximum wall-clock budget Japan waits for a Shanghai
	// Bilibili playurl observation (covering the 300ms broker queue wait, 2.5s domestic
	// playurl fetch, and cross-border control-plane RTT).
	ShanghaiTotalBudget = 3000 * time.Millisecond

	// defaultShanghaiDASHGraceTimeout bounds how long Shanghai waits for the parallel
	// domestic DASH playurl response once domestic html5 durl has returned valid pieces.
	// Fits cleanly inside ShanghaiPlayTimeout (2.5s).
	defaultShanghaiDASHGraceTimeout = 1200 * time.Millisecond

	MaxShanghaiDURLPieces = 64
	MaxShanghaiDashTracks = 32
	MaxShanghaiTrackURLs  = 8

	minMediaExpiryUnix int64 = 1000000000
	maxMediaExpiryUnix int64 = 9999999999
)

var (
	errInvalidShanghaiInput = errors.New("invalid Bilibili Shanghai input")
	errShanghaiPlayFailed   = errors.New("Bilibili Shanghai playurl failed")

	shanghaiBVID = regexp.MustCompile(`^BV1[0-9A-Za-z]{9}$`)
)

// ShanghaiDURLPiece holds validated https://upos-*.bilivideo.com URLs for one MP4 segment.
type ShanghaiDURLPiece struct {
	URLs []string `json:"urls"`
}

// ShanghaiDashTrack holds validated https://upos-*.bilivideo.com URLs for one DASH video or audio track.
type ShanghaiDashTrack struct {
	ID      int64    `json:"id"`
	CodecID int64    `json:"codecid,omitempty"`
	Codecs  string   `json:"codecs,omitempty"`
	URLs    []string `json:"urls"`
}

// ShanghaiPlay carries validated domestic Bilibili stream observations for (BVID, CID).
type ShanghaiPlay struct {
	BVID        string              `json:"bvid"`
	CID         int64               `json:"cid"`
	DURLQuality int64               `json:"durl_quality,omitempty"`
	DURLPieces  []ShanghaiDURLPiece `json:"durl_pieces,omitempty"`
	DashVideo   []ShanghaiDashTrack `json:"dash_video,omitempty"`
	DashAudio   []ShanghaiDashTrack `json:"dash_audio,omitempty"`
}

// HasAnyRoute reports whether p contains at least one validated domestic media route.
func (p *ShanghaiPlay) HasAnyRoute() bool {
	if p == nil {
		return false
	}
	return len(p.DURLPieces) > 0 || len(p.DashVideo) > 0 || len(p.DashAudio) > 0
}

// ShanghaiResolver fetches validated domestic Bilibili playurl routes for (bvid, cid).
type ShanghaiResolver interface {
	ResolveBilibili(ctx context.Context, bvid string, cid int64) (*ShanghaiPlay, error)
}

type shanghaiPendingResolver interface {
	ResolveBilibiliPending(ctx context.Context, bvid string, cid int64) (*ShanghaiPlay, func(bool), error)
}

type shanghaiBilibiliSwitch interface {
	BilibiliEnabled() bool
}

func shanghaiResolverEnabled(resolver ShanghaiResolver) bool {
	if resolver == nil {
		return false
	}
	if sw, ok := resolver.(shanghaiBilibiliSwitch); ok {
		return sw.BilibiliEnabled()
	}
	return true
}

type shanghaiCall struct {
	done   chan struct{}
	mu     sync.Mutex
	play   *ShanghaiPlay
	cancel context.CancelFunc
	finish func(bool)
	err    error
	closed bool
}

func startShanghaiCall(parent context.Context, resolver ShanghaiResolver, bvid string, cid int64) *shanghaiCall {
	if !shanghaiResolverEnabled(resolver) || !ValidBVID(bvid) || !ValidCID(cid) {
		return nil
	}
	if parent == nil {
		parent = context.Background()
	}
	call := &shanghaiCall{done: make(chan struct{})}
	go func() {
		defer close(call.done)
		ctx, cancel := context.WithCancel(parent)
		keepCtxAlive := false
		var completed bool
		defer func() {
			if !keepCtxAlive {
				cancel()
			}
		}()
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("bilibili: shanghai goroutine panic recovered: panic_type=%T", recovered)
				if !keepCtxAlive {
					cancel()
				}
				call.mu.Lock()
				call.err = errors.New("bilibili shanghai internal panic")
				call.mu.Unlock()
			} else if !completed {
				if !keepCtxAlive {
					cancel()
				}
				call.mu.Lock()
				if !call.closed && call.err == nil {
					call.err = errors.New("bilibili shanghai internal panic")
				}
				call.mu.Unlock()
			}
		}()
		call.mu.Lock()
		if call.closed {
			completed = true
			call.mu.Unlock()
			return
		}
		call.cancel = cancel
		call.mu.Unlock()
		var (
			play   *ShanghaiPlay
			finish func(bool)
			err    error
		)
		if pending, ok := resolver.(shanghaiPendingResolver); ok {
			play, finish, err = pending.ResolveBilibiliPending(ctx, bvid, cid)
		} else {
			play, err = resolver.ResolveBilibili(ctx, bvid, cid)
		}
		call.mu.Lock()
		if call.closed {
			completed = true
			call.mu.Unlock()
			if finish != nil {
				finish(false)
			}
			return
		}
		if finish != nil && err == nil && play != nil {
			rawFinish := finish
			var finishOnce sync.Once
			finish = func(matched bool) {
				finishOnce.Do(func() {
					rawFinish(matched)
					cancel()
				})
			}
			keepCtxAlive = true
		}
		call.play = play
		call.finish = finish
		call.err = err
		completed = true
		call.mu.Unlock()
	}()
	return call
}

func (c *shanghaiCall) await(parent context.Context) (*ShanghaiPlay, func(bool)) {
	if c == nil {
		return nil, nil
	}
	timer := time.NewTimer(ShanghaiTotalBudget + 200*time.Millisecond)
	defer timer.Stop()
	select {
	case <-c.done:
	case <-timer.C:
		c.abort()
		return nil, nil
	case <-parent.Done():
		c.abort()
		return nil, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.err != nil || c.play == nil {
		fn := c.finish
		c.finish = nil
		c.closed = true
		if fn != nil {
			fn(false)
		}
		return nil, nil
	}
	play := c.play
	fn := c.finish
	c.finish = nil
	c.closed = true
	return play, fn
}

func (c *shanghaiCall) abort() {
	if c == nil {
		return
	}
	c.mu.Lock()
	cancel := c.cancel
	fn := c.finish
	c.cancel = nil
	c.finish = nil
	c.closed = true
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if fn != nil {
		fn(false)
	}
}

func parsePositiveCID(value any) (int64, bool) {
	switch v := value.(type) {
	case int:
		n := int64(v)
		return n, ValidCID(n)
	case int64:
		return v, ValidCID(v)
	case string:
		s := strings.TrimSpace(v)
		n, err := strconv.ParseInt(s, 10, 64)
		return n, err == nil && strconv.FormatInt(n, 10) == s && ValidCID(n)
	default:
		if n, ok := unified.PHPInt(value); ok && strictInteger(value, n) {
			return n, ValidCID(n)
		}
		return 0, false
	}
}

func filterShanghaiURLsAt(urls []string, now int64) []string {
	if len(urls) == 0 {
		return nil
	}
	out := make([]string, 0, min(len(urls), MaxShanghaiTrackURLs))
	seen := make(map[string]bool, len(urls))
	for _, raw := range urls {
		if len(out) >= MaxShanghaiTrackURLs {
			break
		}
		if seen[raw] {
			continue
		}
		exp, ok := ValidateShanghaiMediaURL(raw, false)
		if !ok {
			continue
		}
		if exp > 0 && exp <= now {
			continue
		}
		seen[raw] = true
		out = append(out, raw)
	}
	return out
}

func prependShanghaiSources(shURLs []string, jpSources array, now int64) (array, bool) {
	if len(shURLs) == 0 {
		return jpSources, false
	}
	shInputs := make(array, 0, len(shURLs))
	for _, u := range shURLs {
		shInputs = append(shInputs, u)
	}
	shSources := unified.Sources(shInputs, now)
	if len(shSources) == 0 {
		return jpSources, false
	}
	jpByURL := make(map[string]object, len(jpSources))
	for _, rawJS := range jpSources {
		if js := unified.Map(rawJS); js != nil {
			if u := unified.Str(js["url"]); u != "" {
				if _, exists := jpByURL[u]; !exists {
					jpByURL[u] = js
				}
			}
		}
	}
	merged := make(array, 0, len(shSources)+len(jpSources))
	seenURL := make(map[string]bool, len(shSources)+len(jpSources))
	seenID := make(map[string]bool, len(shSources)+len(jpSources))
	for _, rawSS := range shSources {
		ss := unified.Map(rawSS)
		if ss == nil {
			continue
		}
		u := unified.Str(ss["url"])
		if u == "" || seenURL[u] {
			continue
		}
		chosen := ss
		if existingJP, exists := jpByURL[u]; exists {
			chosen = existingJP
		}
		id := unified.Str(chosen["id"])
		if id != "" && seenID[id] {
			continue
		}
		merged = append(merged, unified.Clone(chosen))
		seenURL[u] = true
		if id != "" {
			seenID[id] = true
		}
	}
	for _, rawJS := range jpSources {
		js := unified.Map(rawJS)
		if js == nil {
			continue
		}
		u := unified.Str(js["url"])
		id := unified.Str(js["id"])
		if u == "" || seenURL[u] || (id != "" && seenID[id]) {
			continue
		}
		merged = append(merged, unified.Clone(js))
		seenURL[u] = true
		if id != "" {
			seenID[id] = true
		}
	}
	return merged, len(merged) > 0
}

func dashCodecFamily(codecs string, codecID int64) string {
	switch codecID {
	case 7:
		return "avc"
	case 12:
		return "hevc"
	case 13:
		return "av1"
	}
	c := strings.ToLower(strings.TrimSpace(codecs))
	if c == "" || c == "0" {
		return ""
	}
	prefix := strings.SplitN(c, ".", 2)[0]
	switch {
	case strings.HasPrefix(prefix, "avc"):
		return "avc"
	case strings.HasPrefix(prefix, "hev"), strings.HasPrefix(prefix, "hvc"):
		return "hevc"
	case strings.HasPrefix(prefix, "av01"):
		return "av1"
	case strings.HasPrefix(prefix, "mp4a"):
		return "mp4a"
	case strings.HasPrefix(prefix, "flac"):
		return "flac"
	case prefix == "ec-3" || prefix == "ac-3":
		return "dolby"
	default:
		return prefix
	}
}

func dashTrackMatch(sh ShanghaiDashTrack, jpRaw object) bool {
	jpID := intValue(jpRaw["id"])
	if jpID <= 0 || sh.ID != jpID {
		return false
	}
	jpCodecID := intValue(jpRaw["codecid"])
	if sh.CodecID > 0 && jpCodecID > 0 {
		return sh.CodecID == jpCodecID
	}
	shFam := dashCodecFamily(sh.Codecs, sh.CodecID)
	jpFam := dashCodecFamily(unified.Str(jpRaw["codecs"]), jpCodecID)
	if shFam != "" || jpFam != "" {
		return shFam != "" && shFam == jpFam
	}
	return true
}

// ValidBVID reports whether bvid matches Bilibili's 12-character BV1[0-9A-Za-z]{9} format.
func ValidBVID(bvid string) bool {
	return shanghaiBVID.MatchString(bvid)
}

// ValidCID reports whether cid is a positive Bilibili part CID.
func ValidCID(cid int64) bool {
	return cid > 0
}

// AllowedBrowserFetchURL reports whether raw is a direct HTTPS Bilibili CDN URL
// under a subdomain of .bilivideo.com (*.bilivideo.com, excluding apex bilivideo.com).
func AllowedBrowserFetchURL(raw string) bool {
	host, ok := httpsDirectHost(raw)
	if !ok {
		return false
	}
	return hasSubdomain(host, ".bilivideo.com")
}

// AllowedShanghaiMediaURL reports whether raw is a direct HTTPS official national
// UPOS backbone Bilibili CDN URL (strictly single-label https://upos-*.bilivideo.com).
// Regional ISP edge nodes (cn-*.bilivideo.com), MCDN (*.mcdn.bilivideo.com),
// *.bilivideo.cn, and third-party PCDN domains are strictly rejected so cross-ISP
// TLS/connection stalls never enter Shanghai routes or become item.default.
func AllowedShanghaiMediaURL(raw string) bool {
	host, ok := httpsDirectHost(raw)
	if !ok || !hasSubdomain(host, ".bilivideo.com") {
		return false
	}
	prefix := host[:len(host)-len(".bilivideo.com")]
	return !strings.Contains(prefix, ".") && strings.HasPrefix(prefix, "upos-") && len(prefix) > len("upos-")
}

// MediaURLDeadline extracts a single unambiguous 10-digit Unix epoch deadline
// query parameter from a validated https://*.bilivideo.com URL.
func MediaURLDeadline(raw string) (int64, bool) {
	if !AllowedBrowserFetchURL(raw) {
		return 0, false
	}
	return parseMediaURLDeadline(raw)
}

func bilibiliMediaURLDeadline(raw string) (int64, bool) {
	if _, ok := bilibiliDashHostTier(raw); !ok {
		return 0, false
	}
	return parseMediaURLDeadline(raw)
}

func parseMediaURLDeadline(raw string) (int64, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.RawQuery == "" {
		return 0, false
	}
	var found bool
	var exp int64
	for _, pair := range strings.Split(u.RawQuery, "&") {
		if pair == "" {
			continue
		}
		key, val, ok := strings.Cut(pair, "=")
		if key != "deadline" {
			continue
		}
		if !ok || found || len(val) != 10 {
			return 0, false
		}
		for i := 0; i < len(val); i++ {
			if val[i] < '0' || val[i] > '9' {
				return 0, false
			}
		}
		n, err := strconv.ParseInt(val, 10, 64)
		if err != nil || n < minMediaExpiryUnix || n > maxMediaExpiryUnix {
			return 0, false
		}
		exp = n
		found = true
	}
	return exp, found
}

// ValidateShanghaiMediaURL checks that raw is a valid https://upos-*.bilivideo.com URL
// carrying a valid deadline query parameter. If raw has no deadline parameter at all,
// requireDeadline controls whether it is rejected.
func ValidateShanghaiMediaURL(raw string, requireDeadline bool) (int64, bool) {
	if !AllowedShanghaiMediaURL(raw) {
		return 0, false
	}
	u, err := url.Parse(raw)
	if err != nil {
		return 0, false
	}
	hasDeadlineKey := false
	for _, pair := range strings.Split(u.RawQuery, "&") {
		key, _, _ := strings.Cut(pair, "=")
		if key == "deadline" {
			hasDeadlineKey = true
			break
		}
	}
	if !hasDeadlineKey {
		if requireDeadline {
			return 0, false
		}
		return 0, true
	}
	exp, ok := MediaURLDeadline(raw)
	return exp, ok
}

// ShanghaiPlayOptions configures optional behavior for FetchShanghaiPlayWithOptions.
// Zero values preserve the default single-request html5 durl fetch (EnableDASH: false).
type ShanghaiPlayOptions struct {
	EnableDASH       bool
	DASHGraceTimeout time.Duration
}

func (o ShanghaiPlayOptions) effectiveDASHGraceTimeout() time.Duration {
	if o.DASHGraceTimeout > 0 {
		return o.DASHGraceTimeout
	}
	return defaultShanghaiDASHGraceTimeout
}

type shanghaiPlayFetchResult struct {
	data object
	err  error
}

// FetchShanghaiPlay queries Bilibili's official non-VIP html5 playurl endpoint
// for (bvid, cid) without cookies, validates every candidate URL strictly against
// https://upos-*.bilivideo.com, and returns the bounded domestic stream set.
// Parallel DASH fetching defaults to disabled; use FetchShanghaiPlayWithOptions
// to opt in.
func FetchShanghaiPlay(ctx context.Context, executor fetch.Executor, bvid string, cid int64) (*ShanghaiPlay, error) {
	return FetchShanghaiPlayWithOptions(ctx, executor, bvid, cid, ShanghaiPlayOptions{})
}

// FetchShanghaiPlayWithOptions queries Bilibili's official non-VIP playurl
// endpoints for (bvid, cid) without cookies, validates every candidate URL
// strictly against https://upos-*.bilivideo.com (rejecting regional cn-* edge
// nodes, MCDN, and PCDN hosts), and returns the bounded domestic stream set.
// When opts.EnableDASH is false, strictly the single html5 durl request is
// issued. When opts.EnableDASH is true, html5 durl and DASH try_look=1 run in
// parallel with a bounded grace timeout once domestic durl succeeds; partial
// failure is tolerated when at least one validated domestic UPOS route is
// obtained. If no valid upos-*.bilivideo.com route exists, an error is returned
// so Japan cleanly falls back to overseas routes.
func FetchShanghaiPlayWithOptions(ctx context.Context, executor fetch.Executor, bvid string, cid int64, opts ShanghaiPlayOptions) (*ShanghaiPlay, error) {
	if executor == nil || !ValidBVID(bvid) || !ValidCID(cid) {
		return nil, errInvalidShanghaiInput
	}
	timeout, err := shanghaiPlayBudget(ctx)
	if err != nil {
		return nil, err
	}

	durlRes, dashRes, durlQuality, durlPieces, err := fetchShanghaiPlayStreams(ctx, executor, bvid, cid, timeout, opts)
	if err != nil {
		return nil, err
	}

	out := &ShanghaiPlay{
		BVID:        bvid,
		CID:         cid,
		DURLQuality: durlQuality,
		DURLPieces:  durlPieces,
	}
	out.DashVideo, out.DashAudio = extractShanghaiDashStreams(dashRes, durlRes)

	if !out.HasAnyRoute() {
		if durlRes.err != nil && (!opts.EnableDASH || dashRes.err != nil) {
			return nil, durlRes.err
		}
		return nil, errShanghaiPlayFailed
	}
	return out, nil
}

func shanghaiPlayBudget(ctx context.Context) (time.Duration, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	timeout := ShanghaiPlayTimeout
	if deadline, ok := ctx.Deadline(); ok {
		rem := time.Until(deadline)
		if rem <= 0 {
			if err := ctx.Err(); err != nil {
				return 0, err
			}
			return 0, context.DeadlineExceeded
		}
		if rem < timeout {
			timeout = rem
		}
	}
	return timeout, nil
}

func fetchShanghaiPlayStreams(
	ctx context.Context,
	executor fetch.Executor,
	bvid string,
	cid int64,
	timeout time.Duration,
	opts ShanghaiPlayOptions,
) (durlRes, dashRes shanghaiPlayFetchResult, durlQuality int64, durlPieces []ShanghaiDURLPiece, err error) {
	var dashCh chan shanghaiPlayFetchResult
	var cancelDash context.CancelFunc
	if opts.EnableDASH {
		var dashCtx context.Context
		dashCtx, cancelDash = context.WithCancel(ctx)
		defer cancelDash()
		dashCh = make(chan shanghaiPlayFetchResult, 1)
		dashReq := dashPlayRequest(bvid, cid, timeout)
		go func() {
			sent := false
			defer func() {
				if recovered := recover(); recovered != nil {
					log.Printf("bilibili: shanghai dash fetch goroutine panic recovered: panic_type=%T", recovered)
				}
				if !sent {
					dashCh <- shanghaiPlayFetchResult{err: errShanghaiPlayFailed}
				}
			}()
			data, dashErr := fetchShanghaiPlayData(dashCtx, executor, dashReq)
			sent = true
			dashCh <- shanghaiPlayFetchResult{data: data, err: dashErr}
		}()
	}

	durlData, durlErr := fetchShanghaiPlayData(ctx, executor, playRequest(bvid, cid, timeout))
	if err := ctx.Err(); err != nil {
		return shanghaiPlayFetchResult{}, shanghaiPlayFetchResult{}, 0, nil, err
	}
	durlRes = shanghaiPlayFetchResult{data: durlData, err: durlErr}
	if durlErr == nil && len(durlData) > 0 {
		durlQuality, durlPieces = extractShanghaiDURLPieces(durlData)
	}

	if dashCh != nil {
		if len(durlPieces) > 0 {
			select {
			case dashRes = <-dashCh:
			default:
				graceTimer := time.NewTimer(opts.effectiveDASHGraceTimeout())
				defer graceTimer.Stop()
				select {
				case dashRes = <-dashCh:
				case <-graceTimer.C:
					cancelDash()
					dashRes = shanghaiPlayFetchResult{err: context.DeadlineExceeded}
				case <-ctx.Done():
					cancelDash()
					return shanghaiPlayFetchResult{}, shanghaiPlayFetchResult{}, 0, nil, ctx.Err()
				}
			}
		} else {
			select {
			case dashRes = <-dashCh:
			case <-ctx.Done():
				cancelDash()
				return shanghaiPlayFetchResult{}, shanghaiPlayFetchResult{}, 0, nil, ctx.Err()
			}
		}
	}

	if err := ctx.Err(); err != nil {
		return shanghaiPlayFetchResult{}, shanghaiPlayFetchResult{}, 0, nil, err
	}
	return durlRes, dashRes, durlQuality, durlPieces, nil
}

func extractShanghaiDURLPieces(durlData object) (int64, []ShanghaiDURLPiece) {
	rawDURL := unified.Slice(durlData["durl"])
	qn := intValue(durlData["quality"])
	if len(rawDURL) == 0 || len(rawDURL) > MaxShanghaiDURLPieces || qn <= 0 || !strictInteger(durlData["quality"], qn) {
		return 0, nil
	}
	pieces := make([]ShanghaiDURLPiece, 0, len(rawDURL))
	for _, entry := range rawDURL {
		part := unified.Map(entry)
		if part == nil {
			return 0, nil
		}
		urls := collectValidDomesticURLs(part["url"], unified.Slice(part["backup_url"]))
		if len(urls) == 0 {
			return 0, nil
		}
		pieces = append(pieces, ShanghaiDURLPiece{URLs: urls})
	}
	return qn, pieces
}

func extractShanghaiDashStreams(dashRes, durlRes shanghaiPlayFetchResult) ([]ShanghaiDashTrack, []ShanghaiDashTrack) {
	var video, audio []ShanghaiDashTrack
	if dashRes.err == nil && len(dashRes.data) > 0 {
		video = extractShanghaiDashTracks(unified.Slice(child(dashRes.data, "dash", "video")))
		audio = extractShanghaiDashTracks(unified.Slice(child(dashRes.data, "dash", "audio")))
	}
	if len(video) == 0 && durlRes.err == nil && len(durlRes.data) > 0 {
		video = extractShanghaiDashTracks(unified.Slice(child(durlRes.data, "dash", "video")))
	}
	if len(audio) == 0 && durlRes.err == nil && len(durlRes.data) > 0 {
		audio = extractShanghaiDashTracks(unified.Slice(child(durlRes.data, "dash", "audio")))
	}
	return video, audio
}

func fetchShanghaiPlayData(ctx context.Context, executor fetch.Executor, req fetch.Request) (object, error) {
	resp, err := executor.Do(ctx, req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK || !utf8.Valid(resp.Body) {
		return nil, errShanghaiPlayFailed
	}
	doc, err := unified.Decode(resp.Body)
	if err != nil || !strictInteger(doc["code"], 0) {
		return nil, errShanghaiPlayFailed
	}
	playData := unified.Map(doc["data"])
	if len(playData) == 0 {
		return nil, errShanghaiPlayFailed
	}
	return playData, nil
}

func extractShanghaiDashTracks(entries array) []ShanghaiDashTrack {
	if len(entries) == 0 {
		return nil
	}
	limit := min(len(entries), MaxShanghaiDashTracks)
	var tracks []ShanghaiDashTrack
	for _, entry := range entries[:limit] {
		raw := unified.Map(entry)
		if raw == nil {
			continue
		}
		id := intValue(raw["id"])
		if id <= 0 || !strictInteger(raw["id"], id) {
			continue
		}
		codecID := intValue(raw["codecid"])
		if codecID < 0 || (raw["codecid"] != nil && !strictInteger(raw["codecid"], codecID)) {
			codecID = 0
		}
		codecs := sanitizeASCIIField(unified.Str(raw["codecs"]), 64)
		primary := pick(raw["baseUrl"], raw["base_url"], "")
		backups := unified.Slice(pick(raw["backupUrl"], raw["backup_url"]))
		urls := collectValidDomesticURLs(primary, backups)
		if len(urls) == 0 {
			continue
		}
		tracks = append(tracks, ShanghaiDashTrack{
			ID:      id,
			CodecID: codecID,
			Codecs:  codecs,
			URLs:    urls,
		})
	}
	return tracks
}

func collectValidDomesticURLs(primary any, backups array) []string {
	var out []string
	seen := map[string]bool{}
	add := func(candidate any) {
		if len(out) >= MaxShanghaiTrackURLs {
			return
		}
		raw, ok := candidate.(string)
		if !ok || raw == "" || seen[raw] {
			return
		}
		// Pre-return check on Shanghai: require official national UPOS backbone
		// https://upos-*.bilivideo.com and reject any malformed deadline query parameter.
		if _, valid := ValidateShanghaiMediaURL(raw, false); !valid {
			return
		}
		seen[raw] = true
		out = append(out, raw)
	}
	add(primary)
	for _, b := range backups {
		add(b)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func sanitizeASCIIField(raw string, maxLen int) string {
	s := strings.TrimSpace(raw)
	if s == "" || s == "0" || len(s) > maxLen {
		return ""
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return ""
		}
	}
	return s
}

func httpsDirectHost(raw string) (string, bool) {
	if len(raw) < 8 || len(raw) > 8192 || strings.Contains(raw, "#") || unified.MediaURL(raw) != raw {
		return "", false
	}
	for _, r := range raw {
		if r <= 0x20 || r == 0x7f || r == '\\' {
			return "", false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Scheme != "https" || strings.HasSuffix(u.Host, ":") || (u.Port() != "" && u.Port() != "443") {
		return "", false
	}
	for _, b := range []byte(u.Host) {
		if b > 127 {
			return "", false
		}
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || net.ParseIP(host) != nil {
		return "", false
	}
	return host, true
}

func hasSubdomain(host, suffix string) bool {
	if !strings.HasSuffix(host, suffix) || len(host) <= len(suffix) {
		return false
	}
	prefix := host[:len(host)-len(suffix)]
	for _, label := range strings.Split(prefix, ".") {
		if label == "" || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
				return false
			}
		}
	}
	return true
}
