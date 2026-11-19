package x

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

const (
	fxTwitterEndpointPrefix = "https://api.fxtwitter.com/i/status/"
	fxTwitterHost           = "api.fxtwitter.com"
	fxTwitterTimeout        = 4 * time.Second
	fxTwitterMaxBytes       = 256 << 10 // 256 KiB
	fxTwitterUserAgent      = "DokiTool-Go (+https://snap.dokitool.com)"
	tombstoneBlockedMessage = "该内容受年龄或敏感内容限制，无法解析"
)

var (
	videoDimSegmentPattern  = regexp.MustCompile(`^([1-9][0-9]{1,4})x([1-9][0-9]{1,4})$`)
	safeCodecPattern        = regexp.MustCompile(`^[A-Za-z0-9._-]{1,32}$`)
	errFxTwitterNotFound    = errors.New("x fxtwitter tweet not found")
	errFxTwitterUnavailable = errors.New("x fxtwitter unavailable or rejected")
)

// Only unmarshal tweet text, author, media.photos[], and media.videos[] (including GIF) per Issue #88.
type fxTwitterResponse struct {
	Code  int                    `json:"code"`
	Tweet *fxTwitterTweetPayload `json:"tweet"`
}

type fxTwitterTweetPayload struct {
	Text   string                 `json:"text"`
	Author *fxTwitterAuthor       `json:"author"`
	Media  *fxTwitterMediaPayload `json:"media"`
}

type fxTwitterAuthor struct {
	Name       string `json:"name"`
	ScreenName string `json:"screen_name"`
}

type fxTwitterMediaPayload struct {
	Photos []fxTwitterPhotoPayload `json:"photos"`
	Videos []fxTwitterVideoPayload `json:"videos"`
}

type fxTwitterPhotoPayload struct {
	URL    string `json:"url"`
	Width  int64  `json:"width"`
	Height int64  `json:"height"`
}

type fxTwitterVideoPayload struct {
	ID           string                        `json:"id"`
	Type         string                        `json:"type"`
	URL          string                        `json:"url"`
	ThumbnailURL string                        `json:"thumbnail_url"`
	Duration     float64                       `json:"duration"`
	Width        int64                         `json:"width"`
	Height       int64                         `json:"height"`
	Formats      []fxTwitterVideoFormatPayload `json:"formats"`
	Variants     []fxTwitterVideoVariant       `json:"variants"`
}

type fxTwitterVideoFormatPayload struct {
	URL       string `json:"url"`
	Bitrate   int64  `json:"bitrate"`
	Container string `json:"container"`
	Codec     string `json:"codec"`
	Width     int64  `json:"width"`
	Height    int64  `json:"height"`
	Size      int64  `json:"size"`
}

type fxTwitterVideoVariant struct {
	URL         string `json:"url"`
	Bitrate     int64  `json:"bitrate"`
	ContentType string `json:"content_type"`
}

type fxTwitterTweet struct {
	Text             string
	Author           unified.Object
	AuthorName       string
	AuthorScreenName string
	AuthorURL        string
	Photos           []syndicationPhoto
	Videos           []ytengine.Info
}

func (ft *fxTwitterTweet) photoAt(oneBased int) (syndicationPhoto, bool) {
	if ft == nil || oneBased < 1 || oneBased > len(ft.Photos) {
		return syndicationPhoto{}, false
	}
	return ft.Photos[oneBased-1], true
}

func (ft *fxTwitterTweet) toSyndicationTweet() *syndicationTweet {
	return &syndicationTweet{
		Text:   ft.Text,
		Author: ft.Author,
		Photos: ft.Photos,
	}
}

func (ft *fxTwitterTweet) toYTInfo(tweetID string) *ytengine.Info {
	title := tweetTextTitle(ft.Text, tweetID)
	entries := make([]ytengine.Info, len(ft.Videos))
	copy(entries, ft.Videos)
	for i := range entries {
		if entries[i].DisplayID == "" {
			entries[i].DisplayID = tweetID
		}
		if entries[i].Title == "" {
			entries[i].Title = title
		}
	}
	info := &ytengine.Info{
		ID:          tweetID,
		DisplayID:   tweetID,
		Title:       title,
		Description: ft.Text,
		Uploader:    ft.AuthorName,
		UploaderID:  ft.AuthorScreenName,
		UploaderURL: ft.AuthorURL,
	}
	if len(entries) == 1 {
		single := entries[0]
		single.Title = title
		single.Description = ft.Text
		single.Uploader = ft.AuthorName
		single.UploaderID = ft.AuthorScreenName
		single.UploaderURL = ft.AuthorURL
		return &single
	}
	info.Type = "playlist"
	info.Entries = entries
	return info
}

// AllowedFxTwitterURL restricts TweetTombstone fallback fetches strictly to
// https://api.fxtwitter.com/i/status/<numeric tweetID> on the default HTTPS port
// with no userinfo, query string, fragment, or extra path segments.
func AllowedFxTwitterURL(raw string) bool {
	if raw == "" || len(raw) > 2048 {
		return false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' || r == '?' || r == '#' || r == '@' {
			return false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if !strings.EqualFold(u.Scheme, "https") || u.Port() != "" {
		return false
	}
	if !strings.EqualFold(u.Host, fxTwitterHost) {
		return false
	}
	escapedPath := u.EscapedPath()
	if strings.Contains(escapedPath, "%") || !strings.HasPrefix(escapedPath, "/i/status/") {
		return false
	}
	id := strings.TrimPrefix(escapedPath, "/i/status/")
	return tweetIDPattern.MatchString(id)
}

func tombstoneBlockedError() unified.Object {
	return unified.ContractError("UPSTREAM_BLOCKED", tombstoneBlockedMessage, false)
}

func (p *Parser) resolveTombstone(ctx context.Context, tweetID, source, selectedKind string, selectedIndex int, now int64) (unified.Object, error) {
	if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
		return nil, ctxErr
	}
	if !p.fxtwitterEnabled() || p.fetcher == nil {
		return tombstoneBlockedError(), nil
	}

	fx, err := fetchFxTwitterTweet(ctx, p.fetcher, tweetID)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
			return nil, ctxErr
		}
		if errors.Is(err, errFxTwitterNotFound) {
			return unified.ContractError("CONTENT_UNAVAILABLE", "未找到可用的媒体或该推文已不可访问", false), nil
		}
		return tombstoneBlockedError(), nil
	}

	if selectedKind == "photo" {
		photo, found := fx.photoAt(selectedIndex)
		if !found {
			return unified.ContractError("CONTENT_UNAVAILABLE", fmt.Sprintf("所选第 %d 张图片不存在或不可用", selectedIndex), false), nil
		}
		return buildSyndicationPhotoEnvelope(fx.toSyndicationTweet(), []syndicationPhoto{photo}, tweetID, source, now), nil
	}

	if selectedKind == "video" {
		if len(fx.Videos) == 0 {
			return unified.ContractError("CONTENT_UNAVAILABLE", "未找到可用的视频或该推文已不可访问", false), nil
		}
		info := fx.toYTInfo(tweetID)
		populateMissingMP4Sizes(ctx, info, p.sizeProber)
		adapted := AdaptInfo(info, tweetID, source, selectedIndex, now)
		if unified.Str(adapted["code"]) != "OK" {
			return tombstoneBlockedError(), nil
		}
		return adapted, nil
	}

	if len(fx.Videos) > 0 {
		info := fx.toYTInfo(tweetID)
		populateMissingMP4Sizes(ctx, info, p.sizeProber)
		adapted := adaptInfoWithPhotos(info, fx.Photos, tweetID, source, selectedIndex, now)
		if unified.Str(adapted["code"]) != "OK" {
			return tombstoneBlockedError(), nil
		}
		return adapted, nil
	}

	return buildSyndicationPhotoEnvelope(fx.toSyndicationTweet(), fx.Photos, tweetID, source, now), nil
}

func fetchFxTwitterTweet(ctx context.Context, fetcher fetch.Executor, tweetID string) (*fxTwitterTweet, error) {
	if fetcher == nil || !tweetIDPattern.MatchString(tweetID) {
		return nil, errFxTwitterUnavailable
	}
	reqURL := fxTwitterEndpointPrefix + tweetID
	hdr := make(http.Header)
	hdr.Set("Accept", "application/json")
	hdr.Set("User-Agent", fxTwitterUserAgent)

	resp, err := fetcher.Do(ctx, fetch.Request{
		Method: http.MethodGet,
		URL:    reqURL,
		Header: hdr,
		Policy: fetch.Policy{
			Purpose:          "x_fxtwitter_tombstone",
			AllowedURL:       AllowedFxTwitterURL,
			Timeout:          fxTwitterTimeout,
			MaxBytes:         fxTwitterMaxBytes,
			FollowRedirects:  false,
			ReadRedirectBody: false,
			AutoReferer:      false,
			MaxRedirects:     0,
		},
	})
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(ctxErr, context.Canceled) {
			return nil, ctxErr
		}
		return nil, errFxTwitterUnavailable
	}

	if int64(len(resp.Body)) > fxTwitterMaxBytes {
		return nil, errFxTwitterUnavailable
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, errFxTwitterNotFound
	}
	if resp.StatusCode != http.StatusOK || len(resp.Body) == 0 {
		return nil, errFxTwitterUnavailable
	}

	trimmed := bytes.TrimSpace(resp.Body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, errFxTwitterUnavailable
	}
	var payload fxTwitterResponse
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return nil, errFxTwitterUnavailable
	}
	if payload.Code == http.StatusNotFound {
		return nil, errFxTwitterNotFound
	}
	if (payload.Code != 0 && payload.Code != http.StatusOK) || payload.Tweet == nil {
		return nil, errFxTwitterUnavailable
	}

	authorObj, authorName, authorScreenName, authorURL := sanitizeFxTwitterAuthor(payload.Tweet.Author)
	out := &fxTwitterTweet{
		Text:             cleanThirdPartyText(payload.Tweet.Text, 4000, true),
		Author:           authorObj,
		AuthorName:       authorName,
		AuthorScreenName: authorScreenName,
		AuthorURL:        authorURL,
	}

	if payload.Tweet.Media != nil {
		seenPhotoKeys := make(map[string]int)
		for _, pe := range payload.Tweet.Media.Photos {
			origURL, key, ext, ok := normalizePhotoURLWithKey(pe.URL)
			if !ok {
				continue
			}
			var w, h int64
			if pe.Width > 0 && pe.Width <= 65535 && pe.Height > 0 && pe.Height <= 65535 {
				w, h = pe.Width, pe.Height
			}
			if idx, exists := seenPhotoKeys[key]; exists {
				if out.Photos[idx].Width <= 0 && w > 0 && h > 0 {
					out.Photos[idx].Width = w
					out.Photos[idx].Height = h
				}
				continue
			}
			if len(out.Photos) >= maxTweetVideos {
				break
			}
			seenPhotoKeys[key] = len(out.Photos)
			out.Photos = append(out.Photos, syndicationPhoto{
				Key:     key,
				OrigURL: origURL,
				Ext:     ext,
				Width:   w,
				Height:  h,
			})
		}

		for idx, ve := range payload.Tweet.Media.Videos {
			if len(out.Videos) >= maxTweetVideos {
				break
			}
			if entry, ok := buildFxTwitterVideoEntry(ve, tweetID, idx+1); ok {
				out.Videos = append(out.Videos, entry)
			}
		}
	}

	if len(out.Photos) == 0 && len(out.Videos) == 0 {
		return nil, errFxTwitterUnavailable
	}
	return out, nil
}

func buildFxTwitterVideoEntry(v fxTwitterVideoPayload, tweetID string, position int) (ytengine.Info, bool) {
	isGIF := strings.EqualFold(strings.TrimSpace(v.Type), "gif") || strings.EqualFold(strings.TrimSpace(v.Type), "animated_gif")

	cleanTopURL, _, topOK := sanitizeFxTwitterVideoURL(v.URL)
	if topOK && strings.Contains(cleanTopURL, "/tweet_video/") {
		isGIF = true
	}

	type rawCandidate struct {
		url         string
		bitrate     int64
		container   string
		contentType string
		codec       string
		width       int64
		height      int64
		size        int64
	}

	var candidates []rawCandidate
	for _, f := range v.Formats {
		candidates = append(candidates, rawCandidate{
			url:       f.URL,
			bitrate:   f.Bitrate,
			container: f.Container,
			codec:     f.Codec,
			width:     f.Width,
			height:    f.Height,
			size:      f.Size,
		})
	}
	for _, vr := range v.Variants {
		candidates = append(candidates, rawCandidate{
			url:         vr.URL,
			bitrate:     vr.Bitrate,
			contentType: vr.ContentType,
		})
	}
	if v.URL != "" {
		candidates = append(candidates, rawCandidate{
			url:    v.URL,
			width:  v.Width,
			height: v.Height,
		})
	}

	var (
		mp4Formats []ytengine.Format
		hlsFormats []ytengine.Format
		seenURLs   = make(map[string]bool)
		usedIDs    = make(map[string]bool)
	)

	nextFormatID := func(prefix string, kbps int64, seq int) string {
		var base string
		if kbps > 0 {
			base = fmt.Sprintf("%s-%d", prefix, kbps)
		} else {
			base = fmt.Sprintf("%s-%d", prefix, seq)
		}
		if !usedIDs[base] {
			usedIDs[base] = true
			return base
		}
		id := fmt.Sprintf("%s-%d-%d", prefix, kbps, seq)
		usedIDs[id] = true
		return id
	}

	for i, c := range candidates {
		cleanURL, ext, ok := sanitizeFxTwitterVideoURL(c.url)
		if !ok || seenURLs[cleanURL] {
			continue
		}
		ct := strings.ToLower(strings.TrimSpace(c.contentType))
		cont := strings.ToLower(strings.TrimSpace(c.container))
		if ext == ".mp4" && (strings.Contains(ct, "mpegurl") || cont == "m3u8") {
			continue
		}
		if strings.Contains(cleanURL, "/tweet_video/") {
			isGIF = true
		}
		seenURLs[cleanURL] = true

		w, h := int64(0), int64(0)
		if c.width > 0 && c.width <= 65535 && c.height > 0 && c.height <= 65535 {
			w, h = c.width, c.height
		}
		if w == 0 || h == 0 {
			if parsed, err := url.Parse(cleanURL); err == nil {
				w, h = extractDimensionsFromVideoPath(parsed.Path)
			}
		}
		if (w == 0 || h == 0) && topOK && cleanURL == cleanTopURL && v.Width > 0 && v.Width <= 65535 && v.Height > 0 && v.Height <= 65535 {
			w, h = v.Width, v.Height
		}

		vcodec := sanitizeFxTwitterCodec(c.codec)
		if ext == ".m3u8" && vcodec == "" {
			vcodec = "h264"
		}

		var tbrPtr *float64
		var kbps int64
		if c.bitrate > 0 && c.bitrate <= 500_000_000 {
			tbr := float64(c.bitrate) / 1000.0
			tbrPtr = &tbr
			kbps = c.bitrate / 1000
		}

		var sizePtr *int64
		if c.size > 0 && c.size <= maxSafeInteger {
			sz := c.size
			sizePtr = &sz
		}

		var wPtr, hPtr *int64
		if w > 0 && h > 0 {
			wVal, hVal := w, h
			wPtr, hPtr = &wVal, &hVal
		}

		if ext == ".mp4" {
			acodec := ""
			if isGIF {
				acodec = "none"
			}
			mp4Formats = append(mp4Formats, ytengine.Format{
				FormatID: nextFormatID("http", kbps, i+1),
				URL:      cleanURL,
				Ext:      "mp4",
				Protocol: "https",
				Width:    wPtr,
				Height:   hPtr,
				TBR:      tbrPtr,
				VCodec:   vcodec,
				ACodec:   acodec,
				Filesize: sizePtr,
			})
		} else if ext == ".m3u8" {
			acodec := "mp4a.40.2"
			if isGIF {
				acodec = "none"
			}
			hlsFormats = append(hlsFormats, ytengine.Format{
				FormatID: nextFormatID("hls", kbps, i+1),
				URL:      cleanURL,
				Ext:      "mp4",
				Protocol: "m3u8_native",
				Width:    wPtr,
				Height:   hPtr,
				TBR:      tbrPtr,
				VCodec:   vcodec,
				ACodec:   acodec,
			})
		}
	}

	if len(mp4Formats) == 1 && (mp4Formats[0].Width == nil || mp4Formats[0].Height == nil) &&
		v.Width > 0 && v.Width <= 65535 && v.Height > 0 && v.Height <= 65535 {
		wVal, hVal := v.Width, v.Height
		mp4Formats[0].Width = &wVal
		mp4Formats[0].Height = &hVal
	}
	if isGIF {
		for i := range mp4Formats {
			mp4Formats[i].ACodec = "none"
		}
	}

	formats := make([]ytengine.Format, 0, len(mp4Formats)+len(hlsFormats))
	formats = append(formats, mp4Formats...)
	for _, hf := range hlsFormats {
		// Skip resolution-less master .m3u8 playlists when progressive MP4 files exist.
		if len(mp4Formats) > 0 && (hf.Width == nil || hf.Height == nil) {
			continue
		}
		formats = append(formats, hf)
	}
	if len(formats) == 0 {
		return ytengine.Info{}, false
	}

	entryID := strings.TrimSpace(v.ID)
	if !safeMediaIDPattern.MatchString(entryID) {
		entryID = fmt.Sprintf("%s-%d", tweetID, position)
	}

	var durPtr *float64
	if !isGIF && v.Duration > 0 && !math.IsNaN(v.Duration) && !math.IsInf(v.Duration, 0) && v.Duration <= 86400 {
		dur := v.Duration
		durPtr = &dur
	}

	return ytengine.Info{
		ID:        entryID,
		DisplayID: tweetID,
		Type:      "video",
		Duration:  durPtr,
		Thumbnail: sanitizeFxTwitterCoverURL(v.ThumbnailURL),
		Formats:   formats,
	}, true
}

func sanitizeFxTwitterVideoURL(raw string) (string, string, bool) {
	u, ok := parseStrictHTTPSURL(raw)
	if !ok {
		return "", "", false
	}
	if !strings.EqualFold(u.Hostname(), videoMediaHost) {
		return "", "", false
	}
	escapedPath := u.EscapedPath()
	escapedLower := strings.ToLower(escapedPath)
	if escapedPath == "" || escapedPath == "/" ||
		strings.Contains(escapedLower, "%2e") ||
		strings.Contains(escapedLower, "%2f") ||
		strings.Contains(escapedLower, "%5c") {
		return "", "", false
	}
	for _, seg := range strings.Split(escapedPath, "/") {
		if seg == "." || seg == ".." {
			return "", "", false
		}
	}
	ext := strings.ToLower(path.Ext(u.Path))
	if ext != ".mp4" && ext != ".m3u8" {
		return "", "", false
	}
	u.Scheme = "https"
	u.Host = videoMediaHost
	clean := sanitizeXMediaURL(u.String())
	if clean == "" || unified.Source(clean) == nil {
		return "", "", false
	}
	return clean, ext, true
}

func sanitizeFxTwitterCoverURL(raw string) string {
	u, ok := parseStrictHTTPSURL(raw)
	if !ok {
		return ""
	}
	if !strings.EqualFold(u.Hostname(), pbsMediaHost) {
		return ""
	}
	escapedPath := u.EscapedPath()
	escapedLower := strings.ToLower(escapedPath)
	if escapedPath == "" || escapedPath == "/" ||
		strings.Contains(escapedLower, "%2e") ||
		strings.Contains(escapedLower, "%2f") ||
		strings.Contains(escapedLower, "%5c") {
		return ""
	}
	for _, seg := range strings.Split(escapedPath, "/") {
		if seg == "." || seg == ".." {
			return ""
		}
	}
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(u.Path), "."))
	if ext == "" {
		ext = strings.ToLower(strings.TrimSpace(u.Query().Get("format")))
	}
	switch ext {
	case "jpg", "jpeg", "png", "webp":
	default:
		return ""
	}
	u.Scheme = "https"
	u.Host = pbsMediaHost
	clean := sanitizeXMediaURL(u.String())
	if clean == "" || unified.Source(clean) == nil {
		return ""
	}
	return clean
}

func extractDimensionsFromVideoPath(urlPath string) (int64, int64) {
	for _, seg := range strings.Split(urlPath, "/") {
		m := videoDimSegmentPattern.FindStringSubmatch(seg)
		if len(m) != 3 {
			continue
		}
		w, errW := strconv.ParseInt(m[1], 10, 64)
		h, errH := strconv.ParseInt(m[2], 10, 64)
		if errW == nil && errH == nil && w > 0 && w <= 65535 && h > 0 && h <= 65535 {
			return w, h
		}
	}
	return 0, 0
}

func sanitizeFxTwitterCodec(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || isNoCodec(trimmed) || !safeCodecPattern.MatchString(trimmed) {
		return ""
	}
	return trimmed
}

func sanitizeFxTwitterAuthor(a *fxTwitterAuthor) (unified.Object, string, string, string) {
	if a == nil {
		return nil, "", "", ""
	}
	author := unified.Object{}
	screenName := strings.TrimSpace(a.ScreenName)
	var profileURL string
	if screenNamePattern.MatchString(screenName) && !reservedHandles[strings.ToLower(screenName)] {
		author["id"] = screenName
		profileURL = "https://x.com/" + screenName
		author["url"] = profileURL
	} else {
		screenName = ""
	}
	name := cleanThirdPartyText(a.Name, 80, false)
	if name != "" {
		author["name"] = name
	}
	if len(author) == 0 {
		return nil, "", "", ""
	}
	return author, name, screenName, profileURL
}

func cleanThirdPartyText(raw string, maxRunes int, allowNewlines bool) string {
	if raw == "" {
		return ""
	}
	valid := strings.ToValidUTF8(raw, "")
	valid = strings.ReplaceAll(valid, "\r\n", "\n")
	valid = strings.ReplaceAll(valid, "\r", "\n")
	var b strings.Builder
	b.Grow(len(valid))
	for _, r := range valid {
		if r == '\n' {
			if allowNewlines {
				b.WriteRune('\n')
			} else {
				b.WriteByte(' ')
			}
			continue
		}
		if r == '\t' {
			b.WriteByte(' ')
			continue
		}
		if r < 0x20 || (r >= 0x7f && r <= 0x9f) {
			continue
		}
		b.WriteRune(r)
	}
	cleaned := strings.TrimSpace(b.String())
	if maxRunes > 0 {
		runes := []rune(cleaned)
		if len(runes) > maxRunes {
			cleaned = strings.TrimSpace(string(runes[:maxRunes]))
		}
	}
	return cleaned
}
