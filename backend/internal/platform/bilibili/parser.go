// Package bilibili preserves the PHP parser and unified-v1 adapter while
// resolving only the requested part. Network execution remains injected.
package bilibili

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

// defaultDASHGraceTimeout bounds how long Parse waits for the parallel DASH
// playurl response once html5 durl has already returned a usable stream.
const defaultDASHGraceTimeout = 2500 * time.Millisecond

type Parser struct {
	executor         fetch.Executor
	shanghai         ShanghaiResolver
	enableDASH       bool
	dashGraceTimeout time.Duration
}

func New(executor fetch.Executor) *Parser { return &Parser{executor: executor} }

// NewWithShanghai constructs a Bilibili parser that queries Shanghai in parallel
// for domestic *.bilivideo.com routes while keeping Japan's tier list authoritative.
// If shanghai implements BilibiliEnabled() bool and reports false, Shanghai remains disabled.
func NewWithShanghai(executor fetch.Executor, shanghai ShanghaiResolver) *Parser {
	if !shanghaiResolverEnabled(shanghai) {
		shanghai = nil
	}
	return &Parser{executor: executor, shanghai: shanghai}
}

// WithDASH enables or disables parallel zero-cookie DASH playurl fetching
// (fnval=4048&try_look=1) and non-Cartesian DASH adaptation. New defaults to
// disabled to preserve the frozen PHP baseline wire contract.
func (p *Parser) WithDASH(enabled bool) *Parser {
	if p == nil {
		return nil
	}
	p.enableDASH = enabled
	return p
}

// WithDASHGraceTimeout overrides the grace window for waiting on the parallel
// DASH playurl response after html5 durl succeeds. Non-positive durations fall
// back to defaultDASHGraceTimeout.
func (p *Parser) WithDASHGraceTimeout(d time.Duration) *Parser {
	if p == nil {
		return nil
	}
	p.dashGraceTimeout = d
	return p
}

func (p *Parser) effectiveDASHGraceTimeout() time.Duration {
	if p != nil && p.dashGraceTimeout > 0 {
		return p.dashGraceTimeout
	}
	return defaultDASHGraceTimeout
}

var partNumber = regexp.MustCompile(`^[1-9][0-9]{0,5}$`)
var videoID = regexp.MustCompile(`^BV[a-zA-Z0-9]{10}$`)
var videoPath = regexp.MustCompile(`/video/(BV[a-zA-Z0-9]{10})(?:/|$)`)
var videoMeta = regexp.MustCompile(`(?i)<meta\s+[^>]*itemprop="url"\s+[^>]*content="https://www\.bilibili\.com/video/(BV[a-zA-Z0-9]{10})/?"[^>]*>`)

func (p *Parser) Parse(ctx context.Context, input string, now int64) (unified.Object, error) {
	legacy, shCall, err := p.parseLegacyWithShanghai(ctx, input)
	defer shCall.abort()
	if err != nil {
		return nil, err
	}
	legacy, err = legacyWire(legacy)
	if err != nil {
		return nil, err
	}
	code := intValue(legacy["code"])
	raw := unified.Map(legacy["data"])
	if code != 200 || raw == nil {
		return legacyError(code, unified.Str(legacy["msg"])), nil
	}
	var shPlay *ShanghaiPlay
	var finish func(bool)
	if shCall != nil {
		shPlay, finish = shCall.await(ctx)
		if err := ctx.Err(); err != nil {
			if finish != nil {
				finish(false)
			}
			return nil, err
		}
	}
	data, matched := adaptWithOptions(raw, input, now, shPlay, p != nil && p.enableDASH)
	if finish != nil {
		finish(matched)
	}
	if shCall != nil && !matched {
		unified.MarkShanghaiFallback(ctx)
	}
	if len(unified.Slice(data["items"])) == 0 {
		return unified.ContractError("NO_MEDIA", "作品未提供可用媒体", false), nil
	}
	envelope := unified.FinalizeData(data, now)
	if p != nil && p.shanghai != nil {
		annotateBilibiliData(unified.Map(envelope["data"]), now)
	}
	return envelope, nil
}

// parseLegacy retains the private parser boundary for frozen PHP comparison.
// Its bounded context is shared by redirects, the page fallback and both APIs.
func (p *Parser) parseLegacy(parent context.Context, source string) (object, error) {
	out, shCall, err := p.parseLegacyWithShanghai(parent, source)
	shCall.abort()
	return out, err
}

func (p *Parser) parseLegacyWithShanghai(parent context.Context, source string) (object, *shanghaiCall, error) {
	if err := parent.Err(); err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(parent, 35*time.Second)
	defer cancel()
	rawURL := cleanURL(source)
	u, err := url.Parse(rawURL)
	if err != nil || u.Hostname() == "" {
		return legacyFailure(-1, "视频链接不正确"), nil, nil
	}
	if p == nil || p.executor == nil {
		return nil, nil, fmt.Errorf("bilibili request executor is not configured")
	}
	if strings.EqualFold(u.Hostname(), "b23.tv") {
		response, requestErr := p.executor.Do(ctx, shareRequest(rawURL))
		if err := parent.Err(); err != nil {
			return nil, nil, err
		}
		if requestErr != nil || response.URL == "" {
			return legacyFailure(502, "B站短链接解析失败，请重试或使用完整视频链接"), nil, nil
		}
		rawURL = redirectTarget(rawURL, response.URL)
		u, err = url.Parse(rawURL)
	}
	if err != nil || u == nil || !allowedVideoURL(rawURL) || !strings.HasPrefix(u.EscapedPath(), "/video/") {
		return legacyFailure(-1, "好像不是视频链接"), nil, nil
	}
	part, present, scalar := queryPart(u.RawQuery)
	if present && (!scalar || !partNumber.MatchString(part)) {
		return legacyFailure(400, "分P序号无效"), nil, nil
	}
	requested := int64(1)
	if present {
		requested, _ = strconv.ParseInt(part, 10, 64)
	}
	bvid := ""
	if match := videoPath.FindStringSubmatch(u.EscapedPath()); match != nil {
		bvid = match[1]
	}
	if bvid == "" {
		timeout := remaining(ctx, 10*time.Second)
		if timeout < time.Second {
			timeout = time.Second
		}
		response, requestErr := p.executor.Do(ctx, pageRequest(rawURL, timeout))
		if err := parent.Err(); err != nil {
			return nil, nil, err
		}
		if requestErr == nil {
			if match := videoMeta.FindSubmatch(response.Body); match != nil {
				bvid = string(match[1])
			}
		}
	}
	if bvid == "" {
		return legacyFailure(404, "获取视频ID失败"), nil, nil
	}
	view := p.apiRequest(ctx, viewRequest(bvid, remaining(ctx, 20*time.Second)))
	if err := parent.Err(); err != nil {
		return nil, nil, err
	}
	if !strictInteger(view["code"], 0) || !phpArray(view["data"]) {
		return failure(view, "视频信息"), nil, nil
	}
	detail := unified.Map(view["data"])
	var selected object
	for i, value := range unified.Slice(detail["pages"]) {
		page := unified.Map(value)
		if page != nil && intValue(pick(page["page"], i+1)) == requested {
			selected = page
			break
		}
	}
	if len(selected) == 0 || !truthy(selected["cid"]) {
		return legacyFailure(404, "请求的分P不存在"), nil, nil
	}
	var shCall *shanghaiCall
	if p.shanghai != nil {
		if cidInt, ok := parsePositiveCID(selected["cid"]); ok && ValidBVID(bvid) {
			shCall = startShanghaiCall(parent, p.shanghai, bvid, cidInt)
		}
	}
	playTimeout := remaining(ctx, 20*time.Second)
	var dashCh chan object
	var cancelDash context.CancelFunc
	if p.enableDASH {
		var dashCtx context.Context
		dashCtx, cancelDash = context.WithCancel(ctx)
		defer cancelDash()
		dashCh = make(chan object, 1)
		dashReq := dashPlayRequest(bvid, selected["cid"], playTimeout)
		go func() {
			sent := false
			defer func() {
				if recovered := recover(); recovered != nil {
					log.Printf("bilibili: dash playurl goroutine panic recovered: panic_type=%T", recovered)
				}
				if !sent {
					dashCh <- nil
				}
			}()
			res := p.apiRequest(dashCtx, dashReq)
			sent = true
			dashCh <- res
		}()
	}
	play := p.apiRequest(ctx, playRequest(bvid, selected["cid"], playTimeout))
	if err := parent.Err(); err != nil {
		shCall.abort()
		return nil, nil, err
	}
	var dashPlay object
	if dashCh != nil {
		if hasUsableDURL(play) {
			select {
			case dashPlay = <-dashCh:
			default:
				graceTimer := time.NewTimer(p.effectiveDASHGraceTimeout())
				defer graceTimer.Stop()
				select {
				case dashPlay = <-dashCh:
				case <-graceTimer.C:
					cancelDash()
				case <-parent.Done():
					cancelDash()
					shCall.abort()
					return nil, nil, parent.Err()
				}
			}
		} else {
			select {
			case dashPlay = <-dashCh:
			case <-parent.Done():
				cancelDash()
				shCall.abort()
				return nil, nil, parent.Err()
			}
		}
	}
	if err := parent.Err(); err != nil {
		shCall.abort()
		return nil, nil, err
	}
	if p.enableDASH {
		play = mergeDASHPlay(play, dashPlay)
	}
	return buildResponse(detail, bvid, requested, selected, play), shCall, nil
}

func buildResponse(detail object, bvid string, requested int64, selected, play object) object {
	pages := unified.Slice(detail["pages"])
	if pages == nil {
		pages = array{}
	}
	playData := unified.Map(play["data"])
	if playData == nil {
		playData = object{}
	}
	privatePlay := any(array{})
	if phpArray(play["data"]) {
		privatePlay = play["data"]
	}
	stream := unified.Map(first(playData["durl"]))
	mediaURL := unified.MediaURL(stream["url"])
	pageURL := "https://www.bilibili.com/video/" + unified.RFC3986Query(bvid) + "/"
	videos := array{}
	for i, value := range pages {
		page := unified.Map(value)
		if page == nil {
			continue
		}
		number := intValue(pick(page["page"], i+1))
		duration := intValue(pick(page["duration"], 0))
		if duration < 0 {
			duration = 0
		}
		currentURL := ""
		if number == requested {
			currentURL = mediaURL
		}
		videos = append(videos, object{
			"title": stringValue(pick(page["part"], "P"+strconv.FormatInt(number, 10))), "duration": duration,
			"durationFormat": time.Unix(duration, 0).UTC().Format("15:04:05"), "index": number, "page": number,
			"cid": stringValue(pick(page["cid"], "")), "url": currentURL,
			"pageUrl": pageURL + "?p=" + strconv.FormatInt(number, 10), "lazyResolve": number != requested,
		})
	}
	label := quality(playData)
	backups := array{}
	for _, backup := range unified.Slice(stream["backup_url"]) {
		if normalized := unified.MediaURL(backup); normalized != "" && backup != mediaURL {
			backups = append(backups, object{"url": normalized, "label": "备用线路", "quality": label})
		}
	}
	owner := unified.Map(detail["owner"])
	raw := object{
		"type": "video", "title": pick(detail["title"], ""), "cover": pick(detail["pic"], ""),
		"description": pick(detail["desc"], ""), "url": mediaURL, "pageUrl": pageURL + "?p=" + strconv.FormatInt(requested, 10),
		"user":         object{"name": pick(owner["name"], ""), "avatar": pick(owner["face"], "")},
		"video_backup": backups, "duration": selected["duration"], "quality": label,
		"extra": object{"pages": pages, "current_page": requested, "bvid": bvid}, "private_play": privatePlay,
	}
	if !strictInteger(play["code"], 0) || mediaURL == "" && !truthy(child(playData, "dash", "video")) {
		raw["private_error"] = failure(play, "当前分P播放源")
	}
	if phpArray(detail["ugc_season"]) {
		raw["private_collection"] = detail["ugc_season"]
	}
	extra := unified.Map(raw["extra"])
	if phpArray(selected["dimension"]) {
		extra["source_dimension"] = selected["dimension"]
	}
	if _, ok := unified.Numeric(detail["pubdate"]); ok {
		raw["create_time"] = intValue(detail["pubdate"])
	}
	statistics := object{}
	for _, pair := range [][2]string{{"view", "play_count"}, {"reply", "comment_count"}, {"favorite", "collect_count"}, {"share", "share_count"}, {"like", "digg_count"}} {
		value := child(detail, "stat", pair[0])
		if _, ok := unified.Numeric(value); ok {
			statistics[pair[1]] = value
		}
	}
	if len(statistics) > 0 {
		extra["statistics"] = statistics
	}
	if len(videos) > 1 {
		raw["videos"], raw["totalVideos"] = videos, len(videos)
	}
	return object{"code": 200, "msg": "解析成功", "data": raw}
}

func legacyFailure(code int64, message string) object { return object{"code": code, "msg": message} }

func failure(response object, stage string) object {
	httpStatus := intValue(pick(response["_http_status"], 200))
	upstream := response["code"]
	if httpStatus == 401 || httpStatus == 403 || httpStatus == 412 || httpStatus == 429 || anyStrictInteger(upstream, -352, -412, -401, -403, -101) {
		return legacyFailure(503, "B站暂时限制当前服务器访问（"+stage+"），请稍后重试")
	}
	if anyStrictInteger(upstream, -400, -404, 62002, 62004) || httpStatus == 404 {
		return legacyFailure(404, "B站作品不存在、已删除或当前不可见")
	}
	if !strictInteger(pick(response["_transport_errno"], 0), 0) || httpStatus != 200 || upstream == nil {
		return legacyFailure(502, "B站上游连接或响应异常（"+stage+"），请稍后重试")
	}
	return legacyFailure(404, "请求的分P暂时无法获取视频链接")
}

func legacyError(code int64, message string) object {
	contractCode := "UPSTREAM_UNAVAILABLE"
	switch code {
	case -1, 0, 201, 400:
		contractCode = "INVALID_INPUT"
	case 401, 403, 412:
		contractCode = "UPSTREAM_BLOCKED"
	case 404:
		contractCode = "CONTENT_UNAVAILABLE"
	case 429:
		contractCode = "RATE_LIMITED"
	case 408, 504:
		contractCode = "UPSTREAM_TIMEOUT"
	case 502:
		contractCode = "UPSTREAM_INVALID_RESPONSE"
	}
	return unified.ContractError(contractCode, message, contractCode == "RATE_LIMITED" || contractCode == "UPSTREAM_TIMEOUT" || contractCode == "UPSTREAM_UNAVAILABLE")
}

func hasUsableDURL(play object) bool {
	if play == nil || !strictInteger(play["code"], 0) {
		return false
	}
	durl := unified.Slice(child(play, "data", "durl"))
	if len(durl) == 0 {
		return false
	}
	firstPart := unified.Map(durl[0])
	return firstPart != nil && unified.MediaURL(firstPart["url"]) != ""
}

func mergeDASHPlay(play, dashPlay object) object {
	dashData := validDASHPlayData(dashPlay)
	if dashData == nil {
		return play
	}
	dash := unified.Map(dashData["dash"])
	if !strictInteger(play["code"], 0) || unified.Map(play["data"]) == nil {
		synthesized := unified.Clone(dashPlay)
		if synthesized == nil {
			synthesized = object{"code": int64(0), "data": unified.Clone(dashData)}
		}
		return synthesized
	}
	merged := unified.Clone(play)
	playData := unified.Map(merged["data"])
	playData["dash"] = unified.Clone(dash)
	if intValue(playData["quality"]) <= 0 && intValue(dashData["quality"]) > 0 {
		playData["quality"] = dashData["quality"]
	}
	return merged
}

func validDASHPlayData(dashPlay object) object {
	if dashPlay == nil || !strictInteger(dashPlay["code"], 0) {
		return nil
	}
	dashData := unified.Map(dashPlay["data"])
	if dashData == nil {
		return nil
	}
	dash := unified.Map(dashData["dash"])
	if dash == nil {
		return nil
	}
	if !hasValidDASHTrack(unified.Slice(dash["video"])) || !hasValidDASHTrack(unified.Slice(dash["audio"])) {
		return nil
	}
	return dashData
}

func hasValidDASHTrack(entries array) bool {
	for _, entry := range entries {
		raw := unified.Map(entry)
		if raw == nil {
			continue
		}
		primary := pick(raw["baseUrl"], raw["base_url"], "")
		backups := unified.Slice(pick(raw["backupUrl"], raw["backup_url"]))
		if len(filterAndSortBilibiliDashURLs(primary, backups)) > 0 {
			return true
		}
	}
	return false
}

func qualityLabel(qn int64) string {
	labels := map[int64]string{6: "240p", 16: "360p", 32: "480p", 64: "720p", 74: "720p60", 80: "1080p", 112: "1080p+", 116: "1080p60", 120: "4K", 125: "HDR", 126: "Dolby Vision", 127: "8K"}
	return labels[qn]
}

func quality(play object) string {
	if label := qualityLabel(intValue(play["quality"])); label != "" {
		return label
	}
	return "unknown"
}
