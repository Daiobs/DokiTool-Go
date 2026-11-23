// Shared yt-dlp -J to unified-v1 conversion pipeline and fail-soft size prober.
package ytengine

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

const (
	maxSafeInteger int64 = 9007199254740991
)

// AdaptOptions configures how yt-dlp -J Info is converted into a unified-v1 envelope.
type AdaptOptions struct {
	PlatformID                   string
	ContentID                    string
	SourceURL                    string
	SelectedIndex                int
	MaxEntries                   int
	AllowedMediaURL              func(string) bool
	EnableDASHMux                bool
	EnableHLS                    bool
	AllowCodecLessProgressiveMP4 bool
	SingleStreamHLSOnly          bool
	AllowAudioOnly               bool
	AllowProgressiveWebM         bool
}

// SanitizeMediaURL strips URL fragments and validates the URL against allowedMediaURL.
func SanitizeMediaURL(raw string, allowedMediaURL func(string) bool) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if before, _, found := strings.Cut(trimmed, "#"); found {
		trimmed = before
	}
	if unified.MediaURL(trimmed) == "" {
		return ""
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.User != nil || u.Opaque != "" {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	if allowedMediaURL != nil && !allowedMediaURL(trimmed) {
		return ""
	}
	return trimmed
}

// AdaptInfo converts yt-dlp -J metadata into a unified-v1 envelope.
func AdaptInfo(info *Info, opts AdaptOptions, now int64) unified.Object {
	if info == nil {
		return unified.ContractError("UPSTREAM_INVALID_RESPONSE", "解析器返回数据为空", false)
	}
	maxEntries := opts.MaxEntries
	if maxEntries <= 0 {
		maxEntries = 4
	}

	var entries []Info
	if len(info.Entries) > 0 {
		limit := len(info.Entries)
		if limit > maxEntries {
			limit = maxEntries
		}
		entries = info.Entries[:limit]
	} else {
		entries = []Info{*info}
	}

	items := make(unified.Array, 0, len(entries)+1)
	attachments := make(unified.Array, 0, 1)
	seenItemIDs := make(map[string]bool, len(entries)+1)
	seenAttachmentIDs := make(map[string]bool, 1)
	selectedItemID := ""
	hasDeliverableItem := false

	for idx, entry := range entries {
		position := idx + 1
		item, att := buildEntryVideoItem(&entry, info, opts, position, len(entries), now)
		if item == nil {
			if opts.SelectedIndex > 0 && position == opts.SelectedIndex {
				unavail := buildUnavailableEntryVideoItem(&entry, info, opts, position, len(entries), now)
				if unavail != nil {
					unavailID := unified.Str(unavail["id"])
					if unavailID != "" && !seenItemIDs[unavailID] {
						seenItemIDs[unavailID] = true
						items = append(items, unavail)
						selectedItemID = unavailID
					}
				}
			}
			continue
		}
		itemID := unified.Str(item["id"])
		if itemID == "" || seenItemIDs[itemID] {
			continue
		}
		seenItemIDs[itemID] = true
		hasDeliverableItem = true
		items = append(items, item)
		if att != nil {
			attID := unified.Str(att["id"])
			if attID != "" && !seenAttachmentIDs[attID] {
				seenAttachmentIDs[attID] = true
				attachments = append(attachments, att)
			}
		}
		if opts.SelectedIndex > 0 && position == opts.SelectedIndex {
			selectedItemID = itemID
		}
	}

	if !hasDeliverableItem {
		if opts.SingleStreamHLSOnly && hasUnsupportedSingleStreamHLSFormat(entries, info, opts.AllowedMediaURL) {
			return unified.ContractError("NO_MEDIA", "暂不支持该视频的非 fMP4（TS-HLS）流媒体格式", false)
		}
		if opts.AllowAudioOnly {
			return unified.ContractError("NO_MEDIA", "该内容未包含可解析的视频或音频媒体", false)
		}
		return unified.ContractError("NO_MEDIA", "该内容未包含可解析的视频媒体", false)
	}

	if opts.SelectedIndex > len(entries) {
		unavailID := "video-" + shortDigest(fmt.Sprintf("%s:item:%s:unavailable-%d", opts.PlatformID, opts.ContentID, opts.SelectedIndex))
		if !seenItemIDs[unavailID] {
			seenItemIDs[unavailID] = true
			items = append(items, unified.Object{
				"id":                         unavailID,
				"type":                       "video",
				"index":                      int64(opts.SelectedIndex),
				"default":                    nil,
				"state":                      "unavailable",
				"default_unavailable_reason": "unavailable",
				"error": unified.Object{
					"code":    "CONTENT_UNAVAILABLE",
					"message": fmt.Sprintf("所选第 %d 个视频不存在或不可用", opts.SelectedIndex),
				},
			})
			selectedItemID = unavailID
		}
	}

	if selectedItemID == "" {
		selectedItemID = unified.Str(unified.Map(items[0])["id"])
	}

	data := unified.Object{
		"platform":        opts.PlatformID,
		"content_id":      opts.ContentID,
		"source_url":      opts.SourceURL,
		"default_item_id": selectedItemID,
		"items":           items,
		"generated_at":    time.Unix(now, 0).UTC().Format("2006-01-02T15:04:05Z"),
	}
	if len(attachments) > 0 {
		data["attachments"] = attachments
	}

	if title := cleanDisplayTitle(info, opts.ContentID); title != "" {
		data["title"] = title
	}
	if desc := strings.TrimSpace(info.Description); desc != "" {
		data["description"] = desc
	}
	if cover := pickCoverObject(info, entries, opts.AllowedMediaURL, now); cover != nil {
		data["cover"] = cover
	}
	if author := buildAuthorObject(info); author != nil {
		data["author"] = author
	}
	if publishedAt := formatTimestamp(info.Timestamp, entries); publishedAt != "" {
		data["published_at"] = publishedAt
	}
	if stats := buildStatisticsObject(info, entries); len(stats) > 0 {
		data["statistics"] = stats
	}

	return unified.FinalizeData(data, now)
}

func buildUnavailableEntryVideoItem(entry, parent *Info, opts AdaptOptions, position, total int, now int64) unified.Object {
	entryKey := "video-" + strconv.Itoa(position)
	if entry != nil {
		entryKey = resolveEntryKey(entry, opts.ContentID, position)
	}
	itemID := "video-" + shortDigest(opts.PlatformID+":item:"+opts.ContentID+":"+entryKey)
	item := unified.Object{
		"id":                         itemID,
		"type":                       "video",
		"index":                      int64(position),
		"default":                    nil,
		"state":                      "unavailable",
		"default_unavailable_reason": "unavailable",
		"error": unified.Object{
			"code":    "CONTENT_UNAVAILABLE",
			"message": fmt.Sprintf("所选第 %d 个视频不存在或不可用", position),
		},
	}
	if entry != nil {
		if itemTitle := resolveItemTitle(entry, parent, opts.ContentID, position, total); itemTitle != "" {
			item["title"] = itemTitle
		}
		if durationMs := resolveDurationMs(entry.Duration); durationMs > 0 {
			item["duration_ms"] = durationMs
		}
		if cover := pickSingleCover(entry, opts.AllowedMediaURL, now); cover != nil {
			item["cover"] = cover
		} else if cover := pickSingleCover(parent, opts.AllowedMediaURL, now); cover != nil {
			item["cover"] = cover
		}
	}
	return item
}

func buildEntryVideoItem(entry, parent *Info, opts AdaptOptions, position, total int, now int64) (unified.Object, unified.Object) {
	if entry == nil {
		return nil, nil
	}
	entryKey := resolveEntryKey(entry, opts.ContentID, position)
	itemTitle := resolveItemTitle(entry, parent, opts.ContentID, position, total)
	variants, audioAttachment, itemType := buildEntryVariantsWithType(entry, parent, entryKey, itemTitle, opts, now)
	if len(variants) == 0 {
		return nil, nil
	}
	if itemType == "" {
		itemType = "video"
	}
	itemPrefix := "video-"
	if itemType == "audio" {
		itemPrefix = "audio-"
	}

	itemID := itemPrefix + shortDigest(opts.PlatformID+":item:"+opts.ContentID+":"+entryKey)
	item := unified.Object{
		"id":          itemID,
		"type":        itemType,
		"index":       int64(position),
		"default":     nil,
		"variants":    variants,
		"resolve_url": unified.ResolveURL(opts.SourceURL, itemID),
	}

	if itemTitle != "" {
		item["title"] = itemTitle
	}
	if durationMs := resolveDurationMs(entry.Duration); durationMs > 0 {
		item["duration_ms"] = durationMs
	} else if total == 1 {
		if parentDuration := resolveDurationMs(parent.Duration); parentDuration > 0 {
			item["duration_ms"] = parentDuration
		}
	}
	if cover := pickSingleCover(entry, opts.AllowedMediaURL, now); cover != nil {
		item["cover"] = cover
	} else if cover := pickSingleCover(parent, opts.AllowedMediaURL, now); cover != nil {
		item["cover"] = cover
	}
	return item, audioAttachment
}

func resolveDurationMs(dur *float64) int64 {
	if dur == nil || *dur <= 0 || math.IsNaN(*dur) || math.IsInf(*dur, 0) {
		return 0
	}
	ms := math.Round(*dur * 1000)
	if ms < 1 || ms > float64(maxSafeInteger) {
		return 0
	}
	return int64(ms)
}

func cleanDisplayTitle(info *Info, contentID string) string {
	for _, candidate := range []string{info.Title, info.Fulltitle, info.Description} {
		trimmed := strings.TrimSpace(candidate)
		if trimmed != "" {
			return trimmed
		}
	}
	return contentID
}

func resolveItemTitle(entry, parent *Info, contentID string, position, total int) string {
	if t := strings.TrimSpace(entry.Title); t != "" {
		return t
	}
	base := cleanDisplayTitle(parent, contentID)
	if total > 1 {
		return fmt.Sprintf("%s #%d", base, position)
	}
	return base
}

func resolveEntryKey(entry *Info, contentID string, position int) string {
	if id := strings.TrimSpace(entry.ID); id != "" && id != contentID {
		return id
	}
	for _, f := range entry.Formats {
		if u, err := url.Parse(f.URL); err == nil && u.Path != "" {
			return path.Base(u.Path)
		}
	}
	return "video-" + strconv.Itoa(position)
}

func buildAuthorObject(info *Info) unified.Object {
	if info == nil {
		return nil
	}
	author := unified.Object{}
	name := strings.TrimSpace(info.Uploader)
	if name == "" {
		name = strings.TrimSpace(info.Channel)
	}
	if name != "" {
		author["name"] = name
	}
	id := strings.TrimSpace(info.UploaderID)
	if id == "" {
		id = strings.TrimSpace(info.ChannelID)
	}
	if id != "" {
		author["id"] = id
	}
	if len(author) == 0 {
		return nil
	}
	return author
}

func formatTimestamp(primary *float64, entries []Info) string {
	ts := derefFloat(primary)
	if ts <= 0 {
		for _, e := range entries {
			if v := derefFloat(e.Timestamp); v > 0 {
				ts = v
				break
			}
		}
	}
	if ts <= 0 || math.IsNaN(ts) || math.IsInf(ts, 0) {
		return ""
	}
	sec := int64(math.Round(ts))
	if sec <= 0 {
		return ""
	}
	return time.Unix(sec, 0).UTC().Format("2006-01-02T15:04:05Z")
}

func buildStatisticsObject(info *Info, entries []Info) unified.Object {
	stats := unified.Object{}
	addStat := func(key string, ptr *int64) {
		if ptr != nil && *ptr >= 0 && *ptr <= maxSafeInteger {
			stats[key] = unified.Object{"value": *ptr}
		}
	}
	if info != nil {
		addStat("views", info.ViewCount)
		addStat("likes", info.LikeCount)
		addStat("comments", info.CommentCount)
		addStat("shares", info.RepostCount)
	}
	if len(stats) == 0 && len(entries) > 0 {
		first := entries[0]
		addStat("views", first.ViewCount)
		addStat("likes", first.LikeCount)
		addStat("comments", first.CommentCount)
		addStat("shares", first.RepostCount)
	}
	return stats
}

func derefInt(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func derefFloat(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func nonEmptyOr(val, fallback string) string {
	trimmed := strings.TrimSpace(val)
	if trimmed != "" {
		return trimmed
	}
	return fallback
}

func shortDigest(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])[:24]
}
