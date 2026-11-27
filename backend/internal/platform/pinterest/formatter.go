package pinterest

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const maxPinterestItems = 50

type pinResourceEnvelope struct {
	ResourceResponse struct {
		Status string       `json:"status"`
		Data   *pinDataNode `json:"data"`
	} `json:"resource_response"`
}

type pinDataNode struct {
	ID              string                  `json:"id"`
	Title           string                  `json:"title"`
	GridTitle       string                  `json:"grid_title"`
	Description     string                  `json:"description"`
	CloseupUnified  string                  `json:"closeup_unified_description"`
	CreatedAt       string                  `json:"created_at"`
	Images          map[string]pinImageSpec `json:"images"`
	Videos          *pinVideoContainer      `json:"videos"`
	StoryPinData    *pinStoryData           `json:"story_pin_data"`
	Pinner          *pinUserNode            `json:"pinner"`
	NativeCreator   *pinUserNode            `json:"native_creator"`
	AggregatedStats *pinAggregatedData      `json:"aggregated_pin_data"`
	ReactionCounts  map[string]int64        `json:"reaction_counts"`
}

type pinImageSpec struct {
	URL    string `json:"url"`
	Width  int64  `json:"width"`
	Height int64  `json:"height"`
}

type pinVideoContainer struct {
	VideoList map[string]pinVideoItem `json:"video_list"`
}

type pinVideoItem struct {
	URL       string  `json:"url"`
	Width     int64   `json:"width"`
	Height    int64   `json:"height"`
	Duration  float64 `json:"duration"`
	Thumbnail string  `json:"thumbnail"`
}

type pinStoryData struct {
	Metadata *struct {
		PinTitle string `json:"pin_title"`
	} `json:"metadata"`
	Pages []pinStoryPage `json:"pages"`
}

type pinStoryPage struct {
	Image  *pinStoryImage  `json:"image"`
	Blocks []pinStoryBlock `json:"blocks"`
}

type pinStoryBlock struct {
	BlockType int                `json:"block_type"`
	Image     *pinStoryImage     `json:"image"`
	Video     *pinVideoContainer `json:"video"`
}

type pinStoryImage struct {
	Images map[string]pinImageSpec `json:"images"`
}

type pinUserNode struct {
	ID               string `json:"id"`
	FullName         string `json:"full_name"`
	Username         string `json:"username"`
	ImageMediumURL   string `json:"image_medium_url"`
	ImageSmallURL    string `json:"image_small_url"`
	ImageLargeURL    string `json:"image_large_url"`
}

type pinAggregatedData struct {
	AggregatedStats *struct {
		Saves int64 `json:"saves"`
		Done  int64 `json:"done"`
	} `json:"aggregated_stats"`
	CommentCount int64 `json:"comment_count"`
}

func sanitizePinimgURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 4096 || unified.MediaURL(trimmed) != trimmed {
		return ""
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.User != nil || u.Opaque != "" || strings.ToLower(u.Scheme) != "https" {
		return ""
	}
	if port := u.Port(); port != "" && port != "443" {
		return ""
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if !strings.HasSuffix(host, ".pinimg.com") || len(host) <= len(".pinimg.com") {
		return ""
	}
	return trimmed
}

func pickBestImageSpec(images map[string]pinImageSpec) (pinImageSpec, bool) {
	if len(images) == 0 {
		return pinImageSpec{}, false
	}
	for _, key := range []string{"originals", "orig"} {
		if spec, ok := images[key]; ok {
			if clean := sanitizePinimgURL(spec.URL); clean != "" {
				spec.URL = clean
				return spec, true
			}
		}
	}
	keys := make([]string, 0, len(images))
	for k := range images {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var best pinImageSpec
	bestArea := int64(-1)
	found := false
	for _, k := range keys {
		spec := images[k]
		clean := sanitizePinimgURL(spec.URL)
		if clean == "" {
			continue
		}
		area := spec.Width * spec.Height
		if !found || area > bestArea {
			spec.URL = clean
			best = spec
			bestArea = area
			found = true
		}
	}
	return best, found
}

func inferImageExtAndMime(rawURL string) (string, string) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "jpg", "image/jpeg"
	}
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(u.Path)), ".")
	switch ext {
	case "png":
		return "png", "image/png"
	case "webp":
		return "webp", "image/webp"
	case "gif":
		return "gif", "image/gif"
	case "jpeg", "jpg":
		return "jpg", "image/jpeg"
	default:
		return "jpg", "image/jpeg"
	}
}

func isMP4URL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	return strings.HasSuffix(strings.ToLower(u.Path), ".mp4")
}

func isM3U8URL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	return strings.HasSuffix(strings.ToLower(u.Path), ".m3u8")
}

func videoQualityLabel(w, h int64) string {
	if w > 0 && h > 0 {
		shortSide := w
		if h < shortSide {
			shortSide = h
		}
		return strconv.FormatInt(shortSide, 10) + "p"
	}
	return "视频"
}

func shortHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:16]
}

func buildCoverObject(spec pinImageSpec) unified.Object {
	return unified.Object{
		"url":    spec.URL,
		"access": "direct",
	}
}

func buildImageItem(spec pinImageSpec, index int, sourceURL string) unified.Object {
	ext, mimeType := inferImageExtAndMime(spec.URL)
	meta := unified.Object{
		"extension": ext,
		"mime_type": mimeType,
	}
	if spec.Width > 0 {
		meta["width"] = spec.Width
	}
	if spec.Height > 0 {
		meta["height"] = spec.Height
	}
	if spec.Width > 0 || spec.Height > 0 {
		meta["evidence"] = "upstream"
	}
	itemID := "image-" + strconv.Itoa(index)
	variant := unified.Object{
		"id":       "orig-" + shortHash(spec.URL),
		"label":    "原图",
		"metadata": meta,
		"delivery": unified.Object{
			"kind": "file",
			"sources": unified.Array{
				unified.Object{
					"url":    spec.URL,
					"access": "direct",
				},
			},
		},
	}
	return unified.Object{
		"id":          itemID,
		"type":        "image",
		"index":       index,
		"default":     nil,
		"cover":       buildCoverObject(spec),
		"variants":    unified.Array{variant},
		"resolve_url": unified.ResolveURL(sourceURL, itemID),
	}
}

type classifiedVideos struct {
	mp4s  []pinVideoItem
	m3u8s []pinVideoItem
}

func classifyVideoList(videoList map[string]pinVideoItem) classifiedVideos {
	var out classifiedVideos
	if len(videoList) == 0 {
		return out
	}
	keys := make([]string, 0, len(videoList))
	for k := range videoList {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	seenMP4 := map[string]bool{}
	seenM3U8 := map[string]bool{}
	for _, k := range keys {
		item := videoList[k]
		clean := sanitizePinimgURL(item.URL)
		if clean == "" {
			continue
		}
		item.URL = clean
		switch {
		case isMP4URL(clean):
			if !seenMP4[clean] {
				seenMP4[clean] = true
				out.mp4s = append(out.mp4s, item)
			}
		case isM3U8URL(clean):
			if !seenM3U8[clean] {
				seenM3U8[clean] = true
				out.m3u8s = append(out.m3u8s, item)
			}
		}
	}

	sort.SliceStable(out.mp4s, func(i, j int) bool {
		ai := out.mp4s[i].Width * out.mp4s[i].Height
		aj := out.mp4s[j].Width * out.mp4s[j].Height
		if ai != aj {
			return ai > aj
		}
		return out.mp4s[i].URL < out.mp4s[j].URL
	})
	sort.SliceStable(out.m3u8s, func(i, j int) bool {
		ai := out.m3u8s[i].Width * out.m3u8s[i].Height
		aj := out.m3u8s[j].Width * out.m3u8s[j].Height
		if ai != aj {
			return ai > aj
		}
		return out.m3u8s[i].URL < out.m3u8s[j].URL
	})
	return out
}

func buildMP4VideoItem(mp4s []pinVideoItem, cover unified.Object, index int, sourceURL string) unified.Object {
	variants := make(unified.Array, 0, len(mp4s))
	var durMS int64
	for _, v := range mp4s {
		if durMS == 0 && v.Duration > 0 {
			durMS = int64(math.Round(v.Duration))
		}
		meta := unified.Object{
			"container": "mp4",
			"extension": "mp4",
			"mime_type": "video/mp4",
			"has_audio": true,
			"evidence":  "upstream",
		}
		if v.Width > 0 {
			meta["width"] = v.Width
		}
		if v.Height > 0 {
			meta["height"] = v.Height
		}
		if v.Duration > 0 {
			if d := int64(math.Round(v.Duration)); d > 0 {
				meta["duration_ms"] = d
			}
		}
		variants = append(variants, unified.Object{
			"id":       "mp4-" + shortHash(v.URL),
			"label":    videoQualityLabel(v.Width, v.Height),
			"metadata": meta,
			"delivery": unified.Object{
				"kind": "file",
				"sources": unified.Array{
					unified.Object{
						"url":    v.URL,
						"access": "direct",
					},
				},
			},
		})
	}
	itemID := "video-" + strconv.Itoa(index)
	item := unified.Object{
		"id":          itemID,
		"type":        "video",
		"index":       index,
		"default":     nil,
		"variants":    variants,
		"resolve_url": unified.ResolveURL(sourceURL, itemID),
	}
	if cover != nil {
		item["cover"] = unified.CloneValue(cover)
	}
	if durMS > 0 {
		item["duration_ms"] = durMS
	}
	return item
}

func buildHLSVideoItem(m3u8s []pinVideoItem, cover unified.Object, index int, sourceURL string) unified.Object {
	variants := make(unified.Array, 0, len(m3u8s))
	var durMS int64
	for _, v := range m3u8s {
		if durMS == 0 && v.Duration > 0 {
			durMS = int64(math.Round(v.Duration))
		}
		meta := unified.Object{
			"container": "hls",
			"extension": "m3u8",
			"mime_type": "application/vnd.apple.mpegurl",
		}
		if v.Duration > 0 {
			if d := int64(math.Round(v.Duration)); d > 0 {
				meta["duration_ms"] = d
				meta["evidence"] = "upstream"
			}
		}
		variants = append(variants, unified.Object{
			"id":       "hls-" + shortHash(v.URL),
			"label":    "HLS " + videoQualityLabel(v.Width, v.Height),
			"metadata": meta,
			"delivery": unified.Object{
				"kind":  "hls",
				"scope": "adaptive",
				"sources": unified.Array{
					unified.Object{
						"url":    v.URL,
						"access": "direct",
					},
				},
			},
		})
	}
	itemID := "video-" + strconv.Itoa(index)
	item := unified.Object{
		"id":                         itemID,
		"type":                       "video",
		"index":                      index,
		"default":                    nil,
		"default_unavailable_reason": "processing_required",
		"variants":                   variants,
		"resolve_url":                unified.ResolveURL(sourceURL, itemID),
	}
	if cover != nil {
		item["cover"] = unified.CloneValue(cover)
	}
	if durMS > 0 {
		item["duration_ms"] = durMS
	}
	return item
}

func parsePinterestTimestamp(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	for _, layout := range []string{time.RFC1123Z, time.RFC1123, time.RFC822Z, time.RFC822, time.RFC3339} {
		if t, err := time.Parse(layout, trimmed); err == nil {
			return t.UTC().Format(time.RFC3339)
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func buildAuthor(pin *pinDataNode) unified.Object {
	user := pin.NativeCreator
	if user == nil || (strings.TrimSpace(user.FullName) == "" && strings.TrimSpace(user.Username) == "") {
		user = pin.Pinner
	}
	if user == nil {
		return nil
	}
	author := unified.Object{}
	if id := strings.TrimSpace(user.ID); id != "" {
		author["id"] = id
	}
	if name := firstNonEmpty(user.FullName, user.Username); name != "" {
		author["name"] = name
	}
	if username := strings.TrimSpace(user.Username); username != "" && !strings.ContainsAny(username, " /?#\\") {
		author["url"] = "https://www.pinterest.com/" + username + "/"
	}
	for _, av := range []string{user.ImageLargeURL, user.ImageMediumURL, user.ImageSmallURL} {
		if clean := sanitizePinimgURL(av); clean != "" {
			author["avatar"] = unified.Object{"url": clean, "access": "direct"}
			break
		}
	}
	if len(author) == 0 {
		return nil
	}
	return author
}

func formatPinData(pin *pinDataNode, requestedPinID, sourceURL string, now int64) unified.Object {
	contentID := firstNonEmpty(pin.ID, requestedPinID)
	storyTitle := ""
	if pin.StoryPinData != nil && pin.StoryPinData.Metadata != nil {
		storyTitle = pin.StoryPinData.Metadata.PinTitle
	}
	title := firstNonEmpty(pin.Title, pin.GridTitle, storyTitle, pin.Description, pin.CloseupUnified)
	desc := firstNonEmpty(pin.Description, pin.CloseupUnified)

	var rootCoverSpec pinImageSpec
	var hasRootCover bool
	var rootCover unified.Object
	if spec, ok := pickBestImageSpec(pin.Images); ok {
		rootCoverSpec = spec
		hasRootCover = true
		rootCover = buildCoverObject(spec)
	}

	items := unified.Array{}
	seenImageURLs := map[string]bool{}
	hasHLSOnlyWarning := false

	appendImage := func(spec pinImageSpec) {
		if len(items) >= maxPinterestItems || spec.URL == "" || seenImageURLs[spec.URL] {
			return
		}
		seenImageURLs[spec.URL] = true
		items = append(items, buildImageItem(spec, len(items)+1, sourceURL))
	}

	// Priority 1: Standard Video Pin.
	if pin.Videos != nil && len(pin.Videos.VideoList) > 0 {
		classified := classifyVideoList(pin.Videos.VideoList)
		if len(classified.mp4s) > 0 {
			items = append(items, buildMP4VideoItem(classified.mp4s, rootCover, 1, sourceURL))
		} else if len(classified.m3u8s) > 0 {
			if hasRootCover {
				appendImage(rootCoverSpec)
			}
			items = append(items, buildHLSVideoItem(classified.m3u8s, rootCover, len(items)+1, sourceURL))
			hasHLSOnlyWarning = true
		}
	}

	// Priority 2: Story / Idea Pin (multi-page).
	if len(items) == 0 && pin.StoryPinData != nil && len(pin.StoryPinData.Pages) > 0 {
		for _, page := range pin.StoryPinData.Pages {
			if len(items) >= maxPinterestItems {
				break
			}
			var pageCoverSpec pinImageSpec
			var hasPageCover bool
			if page.Image != nil {
				if spec, ok := pickBestImageSpec(page.Image.Images); ok {
					pageCoverSpec = spec
					hasPageCover = true
				}
			}
			pageAdded := false
			for _, block := range page.Blocks {
				if len(items) >= maxPinterestItems {
					break
				}
				if block.Video != nil && len(block.Video.VideoList) > 0 {
					classified := classifyVideoList(block.Video.VideoList)
					var blockCoverSpec pinImageSpec
					var hasBlockCover bool
					if block.Image != nil {
						if spec, ok := pickBestImageSpec(block.Image.Images); ok {
							blockCoverSpec = spec
							hasBlockCover = true
						}
					}
					if !hasBlockCover && hasPageCover {
						blockCoverSpec = pageCoverSpec
						hasBlockCover = true
					}
					if !hasBlockCover && hasRootCover {
						blockCoverSpec = rootCoverSpec
						hasBlockCover = true
					}
					var blockCover unified.Object
					if hasBlockCover {
						blockCover = buildCoverObject(blockCoverSpec)
					}
					if len(classified.mp4s) > 0 {
						items = append(items, buildMP4VideoItem(classified.mp4s, blockCover, len(items)+1, sourceURL))
						pageAdded = true
					} else if len(classified.m3u8s) > 0 {
						if hasBlockCover {
							appendImage(blockCoverSpec)
						}
						if len(items) < maxPinterestItems {
							items = append(items, buildHLSVideoItem(classified.m3u8s, blockCover, len(items)+1, sourceURL))
						}
						hasHLSOnlyWarning = true
						pageAdded = true
					}
					continue
				}
				if block.Image != nil {
					if spec, ok := pickBestImageSpec(block.Image.Images); ok {
						appendImage(spec)
						pageAdded = true
					}
				}
			}
			if !pageAdded && hasPageCover {
				appendImage(pageCoverSpec)
			}
		}
	}

	// Priority 3: Static image Pin / external embed cover fallback.
	if len(items) == 0 && hasRootCover {
		appendImage(rootCoverSpec)
	}

	if len(items) == 0 {
		return unified.ContractError("NO_MEDIA", "该 Pinterest 作品未提供可用视频或图片", false)
	}

	data := unified.Object{
		"platform":        "pinterest",
		"content_id":      contentID,
		"source_url":      sourceURL,
		"refresh_url":     "/api/parse?schema_version=1.0&url=" + unified.RFC3986Query(sourceURL),
		"items":           items,
		"default_item_id": unified.Str(unified.Map(items[0])["id"]),
	}
	if title != "" {
		data["title"] = title
	}
	if desc != "" {
		data["description"] = desc
	}
	if author := buildAuthor(pin); author != nil {
		data["author"] = author
	}
	if rootCover != nil {
		data["cover"] = rootCover
	}
	if published := parsePinterestTimestamp(pin.CreatedAt); published != "" {
		data["published_at"] = published
	}
	stats := unified.Object{}
	if pin.AggregatedStats != nil {
		if pin.AggregatedStats.AggregatedStats != nil && pin.AggregatedStats.AggregatedStats.Saves > 0 {
			stats["saves"] = unified.Object{"value": pin.AggregatedStats.AggregatedStats.Saves, "state": "known"}
		}
		if pin.AggregatedStats.CommentCount > 0 {
			stats["comments"] = unified.Object{"value": pin.AggregatedStats.CommentCount, "state": "known"}
		}
	}
	if len(pin.ReactionCounts) > 0 {
		var likes int64
		for _, n := range pin.ReactionCounts {
			if n > 0 {
				likes += n
			}
		}
		if likes > 0 {
			stats["likes"] = unified.Object{"value": likes, "state": "known"}
		}
	}
	if len(stats) > 0 {
		data["statistics"] = stats
	}
	if len(items) > 1 {
		itemIDs := make(unified.Array, 0, len(items))
		for _, it := range items {
			itemIDs = append(itemIDs, unified.Str(unified.Map(it)["id"]))
		}
		data["groups"] = unified.Array{
			unified.Object{
				"id":          "album",
				"kind":        "album",
				"item_ids":    itemIDs,
				"total_count": int64(len(items)),
				"complete":    true,
			},
		}
	}

	env := unified.FinalizeData(data, now)
	if hasHLSOnlyWarning {
		env["warnings"] = unified.Array{
			unified.Object{
				"code":    "HLS_SPLIT_AUDIO_LIMITED",
				"message": "该 Story 视频仅提供音画分离 HLS 流，已同步保留原图封面",
			},
		}
	}
	return env
}
