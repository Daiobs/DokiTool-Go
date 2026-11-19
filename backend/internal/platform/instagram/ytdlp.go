package instagram

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

var (
	instagramEdgeHostRegex = regexp.MustCompile(`^(?:scontent|instagram)[a-z0-9.-]*\.(?:cdninstagram\.com|fbcdn\.net)$`)
)

func isInstagramLoginRequiredError(err error) bool {
	if err == nil {
		return false
	}
	var engineErr *ytengine.Error
	if !errors.As(err, &engineErr) {
		return false
	}
	checkLoginPhrases := func(s string, includeGenericLogin bool) bool {
		lower := strings.ToLower(s)
		if strings.Contains(lower, "without being logged-in") ||
			strings.Contains(lower, "empty media response") ||
			strings.Contains(lower, "use --cookies") ||
			strings.Contains(lower, "rate-limit reached or login required") ||
			strings.Contains(lower, "instagram api is not granting access") ||
			strings.Contains(lower, "private account") {
			return true
		}
		if includeGenericLogin && (strings.Contains(lower, "login required") || strings.Contains(lower, "sign in")) {
			return true
		}
		return false
	}
	if engineErr.Cause != nil && checkLoginPhrases(engineErr.Cause.Error(), true) {
		return true
	}
	return checkLoginPhrases(engineErr.Message, false)
}

func (p *Parser) buildNativeEnvelopeWithYTVideos(ctx context.Context, post *nativePost, ytVideos unified.Array, shortcode, sourceURL string, now int64) unified.Object {
	if post == nil || len(post.Items) == 0 {
		return unified.ContractError("NO_MEDIA", "该内容未包含可解析的媒体", false)
	}

	nativeVideoCount := 0
	for _, entry := range post.Items {
		if entry.Kind == "video" && entry.VideoURL != "" {
			nativeVideoCount++
		}
	}
	useYTVideoVariants := len(ytVideos) > 0 && len(ytVideos) == nativeVideoCount
	ytVideoCursor := 0

	items := make(unified.Array, 0, len(post.Items))
	imageItemIDs := make(unified.Array, 0, len(post.Items))

	for idx, entry := range post.Items {
		position := idx + 1
		entryKey := entry.ID
		if entryKey == "" || entryKey == shortcode {
			if u, err := url.Parse(nonEmptyStr(entry.VideoURL, entry.ImageURL)); err == nil && u.Path != "" {
				entryKey = path.Base(u.Path)
			} else {
				entryKey = strconv.Itoa(position)
			}
		}

		if entry.Kind == "video" && entry.VideoURL != "" {
			cleanVideoURL := ytengine.SanitizeMediaURL(entry.VideoURL, AllowedMediaURL)
			if cleanVideoURL == "" {
				continue
			}
			itemID := "video-" + shortHash("instagram:item:"+shortcode+":"+entryKey)
			var variants unified.Array
			if useYTVideoVariants && ytVideoCursor < len(ytVideos) {
				ytItem := unified.Map(ytVideos[ytVideoCursor])
				ytVideoCursor++
				if ytVars := unified.Slice(ytItem["variants"]); len(ytVars) > 0 {
					variants = unified.CloneValue(ytVars).(unified.Array)
				}
			}
			if len(variants) == 0 {
				rawSource := unified.Object{
					"url": cleanVideoURL,
					"private_source_identity": unified.PHPIdentityJSON(unified.Array{
						"instagram-native-video",
						shortcode,
						entryKey,
						canonicalInstagramCDNIdentity(cleanVideoURL),
					}, true),
				}
				if p.sizeProber != nil {
					if sz, ok := p.sizeProber(ctx, cleanVideoURL); ok && sz > 0 {
						rawSource["size_bytes"] = sz
					}
				}
				sources := unified.Sources(unified.Array{rawSource}, now)
				if len(sources) == 0 {
					continue
				}
				meta := unified.Object{
					"evidence":  "upstream",
					"container": "mp4",
					"extension": "mp4",
					"mime_type": "video/mp4",
				}
				label := "默认画质"
				if entry.Width > 0 && entry.Height > 0 {
					meta["width"] = entry.Width
					meta["height"] = entry.Height
					minEdge := entry.Width
					if entry.Height < minEdge {
						minEdge = entry.Height
					}
					label = strconv.FormatInt(minEdge, 10) + "p"
				}
				variantID := "v-" + shortHash("instagram:native-video:"+shortcode+":"+entryKey)
				variant := unified.Object{
					"id":       variantID,
					"label":    label,
					"metadata": meta,
					"delivery": unified.Object{
						"kind":    "file",
						"sources": sources,
					},
				}
				variants = unified.Array{variant}
			}
			item := unified.Object{
				"id":          itemID,
				"type":        "video",
				"index":       int64(position),
				"default":     nil,
				"variants":    variants,
				"resolve_url": unified.ResolveURL(sourceURL, itemID),
			}
			if entry.Duration > 0 {
				durMs := int64(math.Round(entry.Duration * 1000))
				if durMs > 0 {
					item["duration_ms"] = durMs
				}
			}
			if coverSrc := buildCoverSource(nonEmptyStr(entry.ImageURL, post.CoverURL), now); coverSrc != nil {
				item["cover"] = coverSrc
			}
			items = append(items, item)
			continue
		}

		if entry.ImageURL != "" {
			cleanImageURL := ytengine.SanitizeMediaURL(entry.ImageURL, AllowedMediaURL)
			if cleanImageURL == "" {
				continue
			}
			rawSource := unified.Object{
				"url": cleanImageURL,
				"private_source_identity": unified.PHPIdentityJSON(unified.Array{
					"instagram-native-image",
					shortcode,
					entryKey,
					canonicalInstagramCDNIdentity(cleanImageURL),
				}, true),
			}
			sources := unified.Sources(unified.Array{rawSource}, now)
			if len(sources) == 0 {
				continue
			}
			container, ext, mimeType := detectImageFormat(cleanImageURL)
			meta := unified.Object{
				"evidence":  "upstream",
				"container": container,
				"extension": ext,
				"mime_type": mimeType,
			}
			if entry.Width > 0 {
				meta["width"] = entry.Width
			}
			if entry.Height > 0 {
				meta["height"] = entry.Height
			}
			variantID := "img-" + shortHash("instagram:native-image:"+shortcode+":"+entryKey)
			variant := unified.Object{
				"id":       variantID,
				"metadata": meta,
				"delivery": unified.Object{
					"kind":    "file",
					"sources": sources,
				},
			}
			itemID := "image-" + shortHash("instagram:item:"+shortcode+":"+entryKey)
			item := unified.Object{
				"id":          itemID,
				"type":        "image",
				"index":       int64(position),
				"default":     nil,
				"variants":    unified.Array{variant},
				"resolve_url": unified.ResolveURL(sourceURL, itemID),
			}
			items = append(items, item)
			imageItemIDs = append(imageItemIDs, itemID)
		}
	}

	if len(items) == 0 {
		return unified.ContractError("NO_MEDIA", "该内容未包含可解析的媒体", false)
	}

	firstItemID := unified.Str(unified.Map(items[0])["id"])
	data := unified.Object{
		"platform":        "instagram",
		"content_id":      shortcode,
		"source_url":      sourceURL,
		"default_item_id": firstItemID,
		"items":           items,
		"generated_at":    time.Unix(now, 0).UTC().Format("2006-01-02T15:04:05Z"),
	}
	if len(imageItemIDs) > 0 && len(items) > 1 {
		data["groups"] = unified.Array{
			unified.Object{
				"id":          "album",
				"kind":        "album",
				"item_ids":    imageItemIDs,
				"total_count": int64(len(imageItemIDs)),
				"complete":    true,
			},
		}
	}
	if post.Title != "" {
		data["title"] = post.Title
	}
	if post.Description != "" {
		data["description"] = post.Description
	}
	if coverSrc := buildCoverSource(post.CoverURL, now); coverSrc != nil {
		data["cover"] = coverSrc
	}
	if post.AuthorID != "" || post.AuthorName != "" {
		author := unified.Object{}
		if post.AuthorName != "" {
			author["name"] = post.AuthorName
		}
		if post.AuthorID != "" {
			author["id"] = post.AuthorID
		}
		if avatarSrc := buildCoverSource(post.AuthorAvatar, now); avatarSrc != nil {
			author["avatar"] = avatarSrc
		}
		data["author"] = author
	}
	if post.Timestamp > 0 {
		data["published_at"] = time.Unix(post.Timestamp, 0).UTC().Format("2006-01-02T15:04:05Z")
	}
	stats := unified.Object{}
	if post.ViewCount != nil && *post.ViewCount >= 0 {
		stats["views"] = unified.Object{"value": *post.ViewCount}
	}
	if post.LikeCount != nil && *post.LikeCount >= 0 {
		stats["likes"] = unified.Object{"value": *post.LikeCount}
	}
	if post.CommentCount != nil && *post.CommentCount >= 0 {
		stats["comments"] = unified.Object{"value": *post.CommentCount}
	}
	if len(stats) > 0 {
		data["statistics"] = stats
	}

	return unified.FinalizeData(data, now)
}

func buildCoverSource(rawURL string, now int64) unified.Object {
	clean := ytengine.SanitizeMediaURL(rawURL, AllowedMediaURL)
	if clean == "" {
		return nil
	}
	sources := unified.Sources(unified.Array{clean}, now)
	if len(sources) == 0 {
		return nil
	}
	return unified.Map(sources[0])
}

func detectImageFormat(rawURL string) (string, string, string) {
	u, err := url.Parse(rawURL)
	p := strings.ToLower(rawURL)
	if err == nil {
		p = strings.ToLower(u.Path)
	}
	switch {
	case strings.HasSuffix(p, ".webp"):
		return "webp", "webp", "image/webp"
	case strings.HasSuffix(p, ".png"):
		return "png", "png", "image/png"
	default:
		return "jpeg", "jpg", "image/jpeg"
	}
}

func canonicalInstagramCDNIdentity(rawURL string) string {
	stripped := unified.SourceIdentity(rawURL)
	u, err := url.Parse(stripped)
	if err != nil {
		return stripped
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if instagramEdgeHostRegex.MatchString(host) {
		if strings.HasSuffix(host, ".cdninstagram.com") {
			host = "cdninstagram.com"
		} else if strings.HasSuffix(host, ".fbcdn.net") {
			host = "fbcdn.net"
		}
	}
	base := strings.ToLower(u.Scheme) + "://" + host + u.EscapedPath()
	if u.RawQuery == "" {
		return base
	}
	parts := strings.Split(u.RawQuery, "&")
	filtered := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			filtered = append(filtered, p)
		}
	}
	sort.Strings(filtered)
	if len(filtered) == 0 {
		return base
	}
	return base + "?" + strings.Join(filtered, "&")
}

func nonEmptyStr(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func shortHash(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])[:24]
}
