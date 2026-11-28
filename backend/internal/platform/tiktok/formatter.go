package tiktok

import (
	"fmt"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const maxTikTokImages = 35

func formatPhotoPost(item *tiktokItemStruct, canonicalURL string, now int64) (unified.Object, bool) {
	if item == nil || item.ImagePost == nil || len(item.ImagePost.Images) == 0 {
		return nil, false
	}
	limit := len(item.ImagePost.Images)
	if limit > maxTikTokImages {
		limit = maxTikTokImages
	}
	items := make(unified.Array, 0, limit)
	itemIDs := make(unified.Array, 0, limit)
	var firstCover string

	for i := 0; i < limit; i++ {
		img := item.ImagePost.Images[i]
		if img.ImageURL == nil {
			continue
		}
		imgURL := selectBestPhotoURL(img.ImageURL.URLList)
		if imgURL == "" {
			continue
		}
		if firstCover == "" {
			firstCover = imgURL
		}
		ext, mimeType := inferImageFormat(imgURL)
		src := unified.Object{
			"id":            fmt.Sprintf("img-%d-src-1", len(items)+1),
			"url":           imgURL,
			"access":        "direct",
			"browser_fetch": "allowed",
		}
		if exp := parseTikTokURLExpiry(imgURL, now); exp != "" {
			src["expires_at"] = exp
		}
		meta := unified.Object{
			"extension": ext,
			"mime_type": mimeType,
			"evidence":  "upstream",
		}
		if img.ImageWidth > 0 {
			meta["width"] = int64(img.ImageWidth)
		}
		if img.ImageHeight > 0 {
			meta["height"] = int64(img.ImageHeight)
		}
		variantID := fmt.Sprintf("img-%d-orig", len(items)+1)
		itemID := fmt.Sprintf("image-%d", len(items)+1)
		entry := unified.Object{
			"id":    itemID,
			"index": len(items) + 1,
			"type":  "image",
			"state": "ready",
			"variants": unified.Array{
				unified.Object{
					"id":       variantID,
					"label":    "原图",
					"metadata": meta,
					"delivery": unified.Object{
						"kind":    "file",
						"sources": unified.Array{src},
					},
				},
			},
		}
		items = append(items, unified.SelectDefault(entry, now))
		itemIDs = append(itemIDs, itemID)
	}
	if len(items) == 0 {
		return nil, false
	}

	data := buildCommonWorkData(item, canonicalURL, firstCover, now)
	data["items"] = items
	data["default_item_id"] = unified.Str(unified.Map(items[0])["id"])
	if len(items) > 1 {
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
	return unified.FinalizeData(data, now), true
}

func formatVideoPost(item *tiktokItemStruct, tiers []resolvedVideoTier, canonicalURL string, now int64) (unified.Object, bool) {
	if item == nil || len(tiers) == 0 {
		return nil, false
	}
	variants := make(unified.Array, 0, len(tiers))
	for i, tier := range tiers {
		c := tier.candidate
		src := unified.Object{
			"id":            fmt.Sprintf("v-%d-src-1", i+1),
			"url":           tier.directURL,
			"access":        "direct",
			"browser_fetch": "blocked",
		}
		if c.dataSize > 0 {
			src["size_bytes"] = c.dataSize
		}
		if tier.expiresAt != "" {
			src["expires_at"] = tier.expiresAt
		}
		meta := unified.Object{
			"has_audio": true,
			"container": "mp4",
			"extension": "mp4",
			"mime_type": "video/mp4",
			"evidence":  "upstream",
		}
		if c.width > 0 {
			meta["width"] = c.width
		}
		if c.height > 0 {
			meta["height"] = c.height
		}
		if c.bitrate > 0 {
			meta["bitrate_bps"] = c.bitrate
		}
		if c.codec != "" {
			meta["video_codec"] = c.codec
		}
		label := formatVideoTierLabel(c)
		variants = append(variants, unified.Object{
			"id":       fmt.Sprintf("v-%d", i+1),
			"label":    label,
			"metadata": meta,
			"delivery": unified.Object{
				"kind":    "file",
				"sources": unified.Array{src},
			},
		})
	}

	coverURL := selectVideoCoverURL(item.Video)
	videoItem := unified.Object{
		"id":       "video-1",
		"index":    1,
		"type":     "video",
		"state":    "ready",
		"variants": variants,
	}
	if item.Video != nil && item.Video.Duration > 0 {
		videoItem["duration_ms"] = int64(item.Video.Duration) * 1000
	}
	if coverURL != "" {
		videoItem["cover"] = buildAllowedSource(coverURL, now)
	}
	videoItem = unified.SelectDefault(videoItem, now)

	data := buildCommonWorkData(item, canonicalURL, coverURL, now)
	data["items"] = unified.Array{videoItem}
	data["default_item_id"] = "video-1"
	return unified.FinalizeData(data, now), true
}

func buildCommonWorkData(item *tiktokItemStruct, canonicalURL, coverURL string, now int64) unified.Object {
	title := strings.TrimSpace(item.Desc)
	if title == "" && item.ImagePost != nil {
		title = strings.TrimSpace(item.ImagePost.Title)
	}
	if title == "" {
		title = "TikTok " + strings.TrimSpace(item.ID)
	}
	data := unified.Object{
		"platform":    "tiktok",
		"content_id":  strings.TrimSpace(item.ID),
		"source_url":  canonicalURL,
		"refresh_url": "/api/parse?schema_version=1.0&url=" + unified.RFC3986Query(canonicalURL),
		"title":       title,
	}
	if desc := strings.TrimSpace(item.Desc); desc != "" && desc != title {
		data["description"] = desc
	}
	if item.CreateTime > 0 {
		data["published_at"] = time.Unix(int64(item.CreateTime), 0).UTC().Format(time.RFC3339)
	}
	if coverURL != "" {
		data["cover"] = buildAllowedSource(coverURL, now)
	}
	if author := buildAuthor(item.Author, now); author != nil {
		data["author"] = author
	}
	if stats := buildStatistics(item.Stats); stats != nil {
		data["statistics"] = stats
	}
	if tags := extractTags(item); len(tags) > 0 {
		data["tags"] = tags
	}
	if musicAtt := buildMusicAttachment(item.Music, now); musicAtt != nil {
		data["attachments"] = unified.Array{musicAtt}
	}
	return data
}

func buildAllowedSource(rawURL string, now int64) unified.Object {
	src := unified.Object{
		"url":           rawURL,
		"access":        "direct",
		"browser_fetch": "allowed",
	}
	if exp := parseTikTokURLExpiry(rawURL, now); exp != "" {
		src["expires_at"] = exp
	}
	return src
}

func buildAuthor(a *tiktokAuthor, now int64) unified.Object {
	if a == nil {
		return nil
	}
	name := strings.TrimSpace(a.Nickname)
	if name == "" {
		name = strings.TrimSpace(a.UniqueID)
	}
	if name == "" && strings.TrimSpace(a.ID) == "" {
		return nil
	}
	out := unified.Object{}
	if id := strings.TrimSpace(a.ID); id != "" {
		out["id"] = id
	}
	if name != "" {
		out["name"] = name
	}
	if sig := strings.TrimSpace(a.Signature); sig != "" {
		out["description"] = sig
	}
	if uid := strings.TrimSpace(a.UniqueID); uid != "" && !strings.ContainsAny(uid, " \t\r\n/?#\\") {
		out["url"] = "https://www.tiktok.com/@" + uid
	}
	for _, candidate := range []string{a.AvatarLarger, a.AvatarMedium, a.AvatarThumb} {
		if AllowedMediaURL(candidate) {
			out["avatar"] = buildAllowedSource(strings.TrimSpace(candidate), now)
			break
		}
	}
	return out
}

func buildStatistics(st *tiktokStats) unified.Object {
	if st == nil {
		return nil
	}
	knownCount := func(v int64) unified.Object {
		if v < 0 {
			v = 0
		}
		return unified.Object{"value": v, "state": "known"}
	}
	return unified.Object{
		"plays":    knownCount(int64(st.PlayCount)),
		"likes":    knownCount(int64(st.DiggCount)),
		"comments": knownCount(int64(st.CommentCount)),
		"shares":   knownCount(int64(st.ShareCount)),
		"saves":    knownCount(int64(st.CollectCount)),
	}
}

func extractTags(item *tiktokItemStruct) unified.Array {
	seen := make(map[string]struct{})
	tags := make(unified.Array, 0)
	add := func(raw string) {
		name := strings.TrimSpace(strings.TrimPrefix(raw, "#"))
		if name == "" {
			return
		}
		lower := strings.ToLower(name)
		if _, dup := seen[lower]; dup {
			return
		}
		seen[lower] = struct{}{}
		tags = append(tags, name)
	}
	for _, ch := range item.Challenges {
		add(ch.Title)
	}
	for _, te := range item.TextExtra {
		add(te.HashtagName)
	}
	return tags
}

func buildMusicAttachment(m *tiktokMusic, now int64) unified.Object {
	if m == nil {
		return nil
	}
	playURL := strings.TrimSpace(m.PlayURL)
	if !AllowedMediaURL(playURL) {
		return nil
	}
	ext, mimeType := inferAudioFormat(playURL)
	src := unified.Object{
		"id":            "music-src-1",
		"url":           playURL,
		"access":        "direct",
		"browser_fetch": "allowed",
	}
	if exp := parseTikTokURLExpiry(playURL, now); exp != "" {
		src["expires_at"] = exp
	}
	meta := unified.Object{
		"has_audio": true,
		"extension": ext,
		"mime_type": mimeType,
		"evidence":  "upstream",
	}
	if m.Duration > 0 {
		meta["duration_ms"] = int64(m.Duration) * 1000
	}
	att := unified.Object{
		"id":   "music-1",
		"role": "background_audio",
		"resource": unified.Object{
			"id":       "music-res-1",
			"role":     "audio",
			"metadata": meta,
			"delivery": unified.Object{
				"kind":    "file",
				"sources": unified.Array{src},
			},
		},
	}
	if title := strings.TrimSpace(m.Title); title != "" {
		att["title"] = title
	}
	if authorName := strings.TrimSpace(m.AuthorName); authorName != "" {
		att["author"] = unified.Object{"name": authorName}
	}
	for _, c := range []string{m.CoverLarge, m.CoverMedium} {
		if AllowedMediaURL(c) {
			att["cover"] = buildAllowedSource(strings.TrimSpace(c), now)
			break
		}
	}
	return att
}

func selectVideoCoverURL(v *tiktokVideo) string {
	if v == nil {
		return ""
	}
	for _, raw := range []string{v.OriginCover, v.Cover, v.DynamicCover} {
		if AllowedMediaURL(raw) {
			return strings.TrimSpace(raw)
		}
	}
	return ""
}

func selectBestPhotoURL(urls []string) string {
	var best string
	bestScore := -1
	for _, raw := range urls {
		trimmed := strings.TrimSpace(raw)
		if !AllowedMediaURL(trimmed) {
			continue
		}
		lower := strings.ToLower(trimmed)
		score := 0
		isHEIC := strings.Contains(lower, ".heic") || strings.Contains(lower, ".heif")
		switch {
		case !isHEIC && (strings.Contains(lower, ".jpeg") || strings.Contains(lower, ".jpg")):
			score = 40
		case !isHEIC && strings.Contains(lower, ".webp"):
			score = 30
		case !isHEIC && strings.Contains(lower, "tplv-photomode-image"):
			score = 35
		case !isHEIC:
			score = 20
		default:
			score = 1
		}
		if score > bestScore {
			bestScore = score
			best = trimmed
		}
	}
	return best
}

func inferImageFormat(rawURL string) (string, string) {
	lower := strings.ToLower(rawURL)
	if u, err := url.Parse(rawURL); err == nil {
		lower = strings.ToLower(u.Path)
	}
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(lower)), ".")
	switch ext {
	case "png":
		return "png", "image/png"
	case "webp":
		return "webp", "image/webp"
	case "gif":
		return "gif", "image/gif"
	case "heic", "heif":
		return "heic", "image/heic"
	default:
		return "jpg", "image/jpeg"
	}
}

func inferAudioFormat(rawURL string) (string, string) {
	lower := strings.ToLower(rawURL)
	if u, err := url.Parse(rawURL); err == nil {
		lower = strings.ToLower(u.Path)
	}
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(lower)), ".")
	switch ext {
	case "m4a":
		return "m4a", "audio/mp4"
	case "aac":
		return "aac", "audio/aac"
	case "ogg", "opus":
		return "ogg", "audio/ogg"
	default:
		return "mp3", "audio/mpeg"
	}
}

func formatVideoTierLabel(c videoTierCandidate) string {
	edge := c.shortEdge()
	var resLabel string
	switch {
	case edge >= 2160:
		resLabel = "4K"
	case edge >= 1440:
		resLabel = "1440p"
	case edge >= 1080:
		resLabel = "1080p"
	case edge >= 720:
		resLabel = "720p"
	case edge >= 540:
		resLabel = "540p"
	case edge >= 480:
		resLabel = "480p"
	case edge > 0:
		resLabel = fmt.Sprintf("%dp", edge)
	default:
		resLabel = "视频"
	}
	switch c.codec {
	case "h265":
		return resLabel + " HEVC"
	case "h264":
		return resLabel + " H.264"
	case "av1":
		return resLabel + " AV1"
	default:
		return resLabel
	}
}
