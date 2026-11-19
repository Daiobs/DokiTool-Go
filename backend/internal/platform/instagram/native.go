package instagram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

var (
	embedContextJSONPattern   = regexp.MustCompile(`"contextJSON"\s*:\s*("(?:\\.|[^"\\])*")`)
	embedVideoURLPattern      = regexp.MustCompile(`"video_url"\s*:\s*("(?:\\.|[^"\\])*")`)
	embedImgElementPattern    = regexp.MustCompile(`(?is)<img\b[^>]*class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]*>`)
	embedSrcAttrPattern       = regexp.MustCompile(`(?is)(?:^|[\s/])src=["']([^"']+)["']`)
	embedSrcsetAttrPattern    = regexp.MustCompile(`(?is)(?:^|[\s/])srcset=["']([^"']+)["']`)
	embedWidthAttrPattern     = regexp.MustCompile(`(?is)(?:^|[\s/])width\s*=\s*(?:"([0-9]+)"|'([0-9]+)'|([0-9]+)(?:[\s/>]|$))`)
	embedHeightAttrPattern    = regexp.MustCompile(`(?is)(?:^|[\s/])height\s*=\s*(?:"([0-9]+)"|'([0-9]+)'|([0-9]+)(?:[\s/>]|$))`)
	errInstagramLoginRequired = errors.New("instagram login required")
)

const (
	instagramAppID      = "936619743392459"
	instagramASBDID     = "129477"
	instagramDefaultLSD = "AVqbxe3J_YA"
	instagramGraphDocID = "8845758582119845"
	nativeFetchTimeout  = 10 * time.Second
	nativeMaxBodyBytes  = 2 << 20 // 2 MiB
)

type nativeMediaItem struct {
	ID       string
	Kind     string // "video" or "image"
	VideoURL string
	ImageURL string
	Width    int64
	Height   int64
	Duration float64
}

type nativePost struct {
	ID              string
	Shortcode       string
	Title           string
	Description     string
	AuthorID        string
	AuthorName      string
	AuthorAvatar    string
	CoverURL        string
	Timestamp       int64
	LikeCount       *int64
	CommentCount    *int64
	ViewCount       *int64
	FromContextJSON bool
	Items           []nativeMediaItem
}

func (np *nativePost) hasVideo() bool {
	if np == nil {
		return false
	}
	for _, it := range np.Items {
		if it.Kind == "video" && it.VideoURL != "" {
			return true
		}
	}
	return false
}

func (np *nativePost) hasImage() bool {
	if np == nil {
		return false
	}
	for _, it := range np.Items {
		if it.Kind == "image" && it.ImageURL != "" {
			return true
		}
	}
	return false
}

func (p *Parser) extractNativeWithStatus(ctx context.Context, shortcode, canonicalURL, sourceURL string, now int64) (unified.Object, bool, bool) {
	needVideo := isReelOrTVCanonical(canonicalURL)
	post, loginReq, ok := p.fetchNativePost(ctx, shortcode, needVideo)
	if !ok || post == nil || len(post.Items) == 0 {
		return nil, loginReq, false
	}
	if env := p.buildNativeEnvelope(ctx, post, shortcode, sourceURL, now); unified.Str(env["code"]) == "OK" {
		return env, false, true
	}
	return nil, loginReq, false
}

func (p *Parser) fetchNativePost(ctx context.Context, shortcode string, needVideo bool) (*nativePost, bool, bool) {
	var loginReq bool

	// Tier 1: Captioned Embed endpoint (GET /p/{shortcode}/embed/captioned/)
	embedPost, embedErr := p.fetchEmbedCaptioned(ctx, shortcode)
	if errors.Is(embedErr, errInstagramLoginRequired) {
		loginReq = true
	}
	if embedErr == nil && embedPost != nil && len(embedPost.Items) > 0 {
		if embedPost.FromContextJSON && (!needVideo || embedPost.hasVideo()) {
			return embedPost, false, true
		}
	}

	if ctx.Err() != nil {
		return nil, loginReq, false
	}

	// Tier 2: Anonymous GraphQL endpoint (POST /api/graphql PolarisPostActionLoadPostQueryQuery)
	// Invoked when Embed lacked contextJSON (e.g., single-image post missing width/height/caption
	// or Reel poster-only fallback) or failed altogether.
	gqlPost, gqlErr := p.fetchAnonymousGraphQL(ctx, shortcode)
	if gqlErr == nil && gqlPost != nil && len(gqlPost.Items) > 0 {
		if !needVideo || gqlPost.hasVideo() || embedPost == nil {
			return gqlPost, false, true
		}
	}
	if errors.Is(gqlErr, errInstagramLoginRequired) {
		loginReq = true
	}

	if embedErr == nil && embedPost != nil && len(embedPost.Items) > 0 && (!needVideo || embedPost.hasVideo()) {
		return embedPost, false, true
	}
	return nil, loginReq, false
}

func (p *Parser) fetchEmbedCaptioned(ctx context.Context, shortcode string) (*nativePost, error) {
	embedURL := "https://www.instagram.com/p/" + shortcode + "/embed/captioned/"
	hdr := make(http.Header)
	hdr.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	hdr.Set("Accept-Language", "en-US,en;q=0.9")
	hdr.Set("Referer", "https://www.instagram.com/")
	resp, err := p.fetcher.Do(ctx, fetch.Request{
		Method: http.MethodGet,
		URL:    embedURL,
		Header: hdr,
		Policy: fetch.Policy{
			Purpose:         "instagram_embed_captioned",
			AllowedURL:      AllowedPageURL,
			Timeout:         nativeFetchTimeout,
			MaxBytes:        nativeMaxBodyBytes,
			FollowRedirects: true,
			MaxRedirects:    3,
		},
	})
	if err != nil || resp.StatusCode != http.StatusOK || len(resp.Body) == 0 {
		return nil, fmt.Errorf("embed request failed")
	}
	return parseInstagramEmbedHTML(string(resp.Body), shortcode)
}

func (p *Parser) fetchAnonymousGraphQL(ctx context.Context, shortcode string) (*nativePost, error) {
	varsJSON, err := json.Marshal(map[string]any{
		"shortcode": shortcode,
	})
	if err != nil {
		return nil, err
	}
	form := url.Values{}
	form.Set("av", "0")
	form.Set("lsd", instagramDefaultLSD)
	form.Set("fb_api_caller_class", "RelayModern")
	form.Set("fb_api_req_friendly_name", "PolarisPostActionLoadPostQueryQuery")
	form.Set("variables", string(varsJSON))
	form.Set("server_timestamps", "true")
	form.Set("doc_id", instagramGraphDocID)

	hdr := make(http.Header)
	hdr.Set("Content-Type", "application/x-www-form-urlencoded")
	hdr.Set("Accept", "*/*")
	hdr.Set("Accept-Language", "en-US,en;q=0.9")
	hdr.Set("X-IG-App-ID", instagramAppID)
	hdr.Set("X-FB-LSD", instagramDefaultLSD)
	hdr.Set("X-ASBD-ID", instagramASBDID)
	hdr.Set("X-Requested-With", "XMLHttpRequest")
	hdr.Set("Sec-Fetch-Site", "same-origin")
	hdr.Set("Referer", "https://www.instagram.com/p/"+shortcode+"/")

	resp, err := p.fetcher.Do(ctx, fetch.Request{
		Method: http.MethodPost,
		URL:    "https://www.instagram.com/api/graphql",
		Header: hdr,
		Body:   []byte(form.Encode()),
		Policy: fetch.Policy{
			Purpose:         "instagram_graphql_anonymous",
			AllowedURL:      AllowedPageURL,
			Timeout:         nativeFetchTimeout,
			MaxBytes:        nativeMaxBodyBytes,
			FollowRedirects: false,
		},
	})
	if err != nil || resp.StatusCode != http.StatusOK || len(resp.Body) == 0 {
		return nil, fmt.Errorf("graphql request failed")
	}
	return parseInstagramGraphQLJSON(resp.Body, shortcode)
}

func parseInstagramEmbedHTML(rawHTML, shortcode string) (*nativePost, error) {
	if m := embedContextJSONPattern.FindStringSubmatch(rawHTML); len(m) == 2 {
		var decodedContext string
		if err := json.Unmarshal([]byte(m[1]), &decodedContext); err == nil && decodedContext != "" {
			var root map[string]any
			if err := json.Unmarshal([]byte(decodedContext), &root); err == nil {
				if mediaNode := extractEmbedMediaNode(root); mediaNode != nil {
					if post, err := parseGraphMediaNode(mediaNode, shortcode); err == nil && len(post.Items) > 0 {
						post.FromContextJSON = true
						return post, nil
					}
				}
			}
		}
	}

	// Fallback: direct extraction of video_url / EmbeddedMediaImage (preferring highest srcset candidate)
	var items []nativeMediaItem
	coverURL, coverW, coverH := extractBestEmbeddedMediaImage(rawHTML)

	if m := embedVideoURLPattern.FindStringSubmatch(rawHTML); len(m) == 2 {
		var rawVideoURL string
		if err := json.Unmarshal([]byte(m[1]), &rawVideoURL); err == nil {
			rawVideoURL = html.UnescapeString(strings.TrimSpace(rawVideoURL))
			if clean := ytengine.SanitizeMediaURL(rawVideoURL, AllowedMediaURL); clean != "" {
				items = append(items, nativeMediaItem{
					ID:       shortcode,
					Kind:     "video",
					VideoURL: clean,
					ImageURL: coverURL,
				})
			}
		}
	}
	if len(items) == 0 && coverURL != "" {
		items = append(items, nativeMediaItem{
			ID:       shortcode,
			Kind:     "image",
			ImageURL: coverURL,
			Width:    coverW,
			Height:   coverH,
		})
	}
	if len(items) == 0 {
		lowerHTML := strings.ToLower(rawHTML)
		if strings.Contains(lowerHTML, "this account is private") ||
			strings.Contains(lowerHTML, "log in to watch") ||
			strings.Contains(lowerHTML, "log in to continue") {
			return nil, errInstagramLoginRequired
		}
		return nil, errors.New("no media found in embed html")
	}
	return &nativePost{
		ID:        shortcode,
		Shortcode: shortcode,
		Title:     "Instagram Post " + shortcode,
		CoverURL:  coverURL,
		Items:     items,
	}, nil
}

func parseEmbedIntAttr(tag string, pattern *regexp.Regexp) int64 {
	m := pattern.FindStringSubmatch(tag)
	if len(m) == 0 {
		return 0
	}
	for _, group := range m[1:] {
		if group == "" {
			continue
		}
		if parsed, err := strconv.ParseInt(group, 10, 64); err == nil && parsed > 0 && parsed <= 100000 {
			return parsed
		}
	}
	return 0
}

func extractBestEmbeddedMediaImage(rawHTML string) (string, int64, int64) {
	tag := embedImgElementPattern.FindString(rawHTML)
	if tag == "" {
		return "", 0, 0
	}
	imgW := parseEmbedIntAttr(tag, embedWidthAttrPattern)
	imgH := parseEmbedIntAttr(tag, embedHeightAttrPattern)

	var srcURL string
	if m := embedSrcAttrPattern.FindStringSubmatch(tag); len(m) == 2 {
		rawSrc := html.UnescapeString(strings.TrimSpace(m[1]))
		srcURL = ytengine.SanitizeMediaURL(rawSrc, AllowedMediaURL)
	}
	if m := embedSrcsetAttrPattern.FindStringSubmatch(tag); len(m) == 2 {
		rawSrcset := html.UnescapeString(m[1])
		var bestURL string
		var bestW int64
		for _, part := range strings.Split(rawSrcset, ",") {
			fields := strings.Fields(strings.TrimSpace(part))
			if len(fields) == 0 {
				continue
			}
			clean := ytengine.SanitizeMediaURL(fields[0], AllowedMediaURL)
			if clean == "" {
				continue
			}
			var w int64
			if len(fields) >= 2 && strings.HasSuffix(strings.ToLower(fields[1]), "w") {
				if parsed, err := strconv.ParseInt(strings.TrimSuffix(strings.ToLower(fields[1]), "w"), 10, 64); err == nil && parsed > 0 && parsed <= 100000 {
					w = parsed
				}
			}
			if bestURL == "" || w > bestW {
				bestW = w
				bestURL = clean
			}
		}
		if bestURL != "" {
			if bestW > 0 {
				var resolvedH int64
				if imgH > 0 && (imgW == bestW || (imgW == 0 && bestURL == srcURL)) {
					resolvedH = imgH
				}
				return bestURL, bestW, resolvedH
			}
			if srcURL == "" || bestURL == srcURL {
				return bestURL, imgW, imgH
			}
			return bestURL, 0, 0
		}
	}
	if srcURL == "" {
		return "", 0, 0
	}
	return srcURL, imgW, imgH
}

func extractEmbedMediaNode(root map[string]any) map[string]any {
	if gql, ok := root["gql_data"].(map[string]any); ok {
		if sm, ok := gql["shortcode_media"].(map[string]any); ok {
			return sm
		}
		if xdt, ok := gql["xdt_shortcode_media"].(map[string]any); ok {
			return xdt
		}
	}
	if sm, ok := root["shortcode_media"].(map[string]any); ok {
		return sm
	}
	if ctxObj, ok := root["context"].(map[string]any); ok {
		if media, ok := ctxObj["media"].(map[string]any); ok {
			return media
		}
	}
	return nil
}

func parseInstagramGraphQLJSON(body []byte, shortcode string) (*nativePost, error) {
	trimmed := strings.TrimSpace(string(body))
	trimmed = strings.TrimPrefix(trimmed, "for (;;);")
	var root map[string]any
	if err := json.Unmarshal([]byte(trimmed), &root); err != nil {
		return nil, err
	}
	data, _ := root["data"].(map[string]any)
	if data == nil {
		return nil, errors.New("missing graphql data")
	}
	for _, key := range []string{"xdt_shortcode_media", "shortcode_media"} {
		if node, ok := data[key].(map[string]any); ok && node != nil {
			return parseGraphMediaNode(node, shortcode)
		}
	}
	if _, hasErrors := root["errors"]; !hasErrors {
		for _, key := range []string{"xdt_shortcode_media", "shortcode_media"} {
			if val, exists := data[key]; exists && val == nil {
				return nil, errInstagramLoginRequired
			}
		}
	}
	return nil, errors.New("missing shortcode_media node")
}

func parseGraphMediaNode(node map[string]any, fallbackShortcode string) (*nativePost, error) {
	if node == nil {
		return nil, errors.New("nil media node")
	}
	shortcode := strField(node, "shortcode", "code")
	if shortcode == "" {
		shortcode = fallbackShortcode
	}
	postID := strField(node, "id", "pk")
	if postID == "" {
		postID = shortcode
	}

	caption := extractCaptionText(node)
	ownerID, ownerName, ownerAvatar := extractOwnerInfo(node)
	coverURL := extractBestDisplayURL(node)
	takenAt := int64Field(node, "taken_at_timestamp", "taken_at")
	likes := optionalCountField(node, "edge_media_preview_like", "likes")
	comments := optionalCountField(node, "edge_media_to_parent_comment", "edge_media_to_comment", "comments")
	views := optionalDirectIntField(node, "video_view_count", "play_count")

	var items []nativeMediaItem
	children := extractSidecarChildren(node)
	if len(children) > 0 {
		for idx, child := range children {
			if len(items) >= maxCarouselEntries {
				break
			}
			item, ok := parseSingleMediaNode(child, fmt.Sprintf("%s-%d", shortcode, idx+1))
			if ok {
				items = append(items, item)
			}
		}
	} else {
		if item, ok := parseSingleMediaNode(node, shortcode); ok {
			items = append(items, item)
		}
	}

	if len(items) == 0 {
		return nil, errors.New("no valid media items in node")
	}
	if coverURL == "" && len(items) > 0 {
		coverURL = items[0].ImageURL
	}
	title := firstLineTitle(caption, ownerName, shortcode)
	return &nativePost{
		ID:           postID,
		Shortcode:    shortcode,
		Title:        title,
		Description:  caption,
		AuthorID:     ownerID,
		AuthorName:   ownerName,
		AuthorAvatar: ownerAvatar,
		CoverURL:     coverURL,
		Timestamp:    takenAt,
		LikeCount:    likes,
		CommentCount: comments,
		ViewCount:    views,
		Items:        items,
	}, nil
}

func parseSingleMediaNode(node map[string]any, defaultID string) (nativeMediaItem, bool) {
	id := strField(node, "id", "pk", "shortcode")
	if id == "" {
		id = defaultID
	}
	nodeW, nodeH := extractDimensions(node)
	displayURL, imgW, imgH := extractBestImageCandidate(node)
	videoURL := ytengine.SanitizeMediaURL(html.UnescapeString(strField(node, "video_url")), AllowedMediaURL)
	typename := strings.ToLower(strField(node, "__typename"))
	isVideo, _ := node["is_video"].(bool)
	dur := floatField(node, "video_duration")

	if (videoURL != "") && (isVideo || strings.Contains(typename, "video") || videoURL != "") {
		vw, vh := nodeW, nodeH
		if vw <= 0 || vh <= 0 {
			vw, vh = imgW, imgH
		}
		return nativeMediaItem{
			ID:       id,
			Kind:     "video",
			VideoURL: videoURL,
			ImageURL: displayURL,
			Width:    vw,
			Height:   vh,
			Duration: dur,
		}, true
	}
	if displayURL != "" {
		if imgW <= 0 || imgH <= 0 {
			imgW, imgH = nodeW, nodeH
		}
		return nativeMediaItem{
			ID:       id,
			Kind:     "image",
			ImageURL: displayURL,
			Width:    imgW,
			Height:   imgH,
		}, true
	}
	return nativeMediaItem{}, false
}

func extractSidecarChildren(node map[string]any) []map[string]any {
	for _, key := range []string{"edge_sidecar_to_children", "carousel_media"} {
		raw := node[key]
		if edgeMap, ok := raw.(map[string]any); ok {
			if edges, ok := edgeMap["edges"].([]any); ok {
				out := make([]map[string]any, 0, len(edges))
				for _, e := range edges {
					if em, ok := e.(map[string]any); ok {
						if child, ok := em["node"].(map[string]any); ok && child != nil {
							out = append(out, child)
						} else {
							out = append(out, em)
						}
					}
				}
				if len(out) > 0 {
					return out
				}
			}
		}
		if arr, ok := raw.([]any); ok {
			out := make([]map[string]any, 0, len(arr))
			for _, elem := range arr {
				if child, ok := elem.(map[string]any); ok && child != nil {
					out = append(out, child)
				}
			}
			if len(out) > 0 {
				return out
			}
		}
	}
	return nil
}

func extractBestDisplayURL(node map[string]any) string {
	bestURL, _, _ := extractBestImageCandidate(node)
	return bestURL
}

// extractBestImageCandidate selects the highest pixel-area candidate across
// display_resources, image_versions2.candidates, and display_url/display_src/thumbnail_src.
// Strict > comparison preserves uncropped aspect ratios (e.g. 1080x1350 over trailing 1080x1080).
func extractBestImageCandidate(node map[string]any) (string, int64, int64) {
	var bestURL string
	var bestW, bestH, bestArea int64

	consider := func(rawURL string, w, h int64) {
		clean := ytengine.SanitizeMediaURL(html.UnescapeString(rawURL), AllowedMediaURL)
		if clean == "" {
			return
		}
		var area int64
		if w > 0 && h > 0 {
			area = w * h
		}
		if bestURL == "" || area > bestArea {
			bestURL = clean
			bestW = w
			bestH = h
			bestArea = area
		}
	}

	if resList, ok := node["display_resources"].([]any); ok {
		for _, r := range resList {
			rm, ok := r.(map[string]any)
			if !ok {
				continue
			}
			consider(
				strField(rm, "src", "url"),
				int64Field(rm, "config_width", "width"),
				int64Field(rm, "config_height", "height"),
			)
		}
	}
	if iv2, ok := node["image_versions2"].(map[string]any); ok {
		if cands, ok := iv2["candidates"].([]any); ok {
			for _, c := range cands {
				cm, ok := c.(map[string]any)
				if !ok {
					continue
				}
				consider(
					strField(cm, "url", "src"),
					int64Field(cm, "width", "config_width"),
					int64Field(cm, "height", "config_height"),
				)
			}
		}
	}
	nodeW, nodeH := extractDimensions(node)
	for _, key := range []string{"display_url", "display_src", "thumbnail_src"} {
		consider(strField(node, key), nodeW, nodeH)
	}

	if (bestW <= 0 || bestH <= 0) && nodeW > 0 && nodeH > 0 {
		bestW, bestH = nodeW, nodeH
	}
	return bestURL, bestW, bestH
}

func extractDimensions(node map[string]any) (int64, int64) {
	if dim, ok := node["dimensions"].(map[string]any); ok {
		w := int64Field(dim, "width")
		h := int64Field(dim, "height")
		if w > 0 && h > 0 {
			return w, h
		}
	}
	w := int64Field(node, "original_width", "width")
	h := int64Field(node, "original_height", "height")
	if w > 0 && h > 0 {
		return w, h
	}
	return 0, 0
}

func extractCaptionText(node map[string]any) string {
	if capEdge, ok := node["edge_media_to_caption"].(map[string]any); ok {
		if edges, ok := capEdge["edges"].([]any); ok && len(edges) > 0 {
			if em, ok := edges[0].(map[string]any); ok {
				if n, ok := em["node"].(map[string]any); ok {
					if t := strings.TrimSpace(strField(n, "text")); t != "" {
						return t
					}
				}
			}
		}
	}
	if capMap, ok := node["caption"].(map[string]any); ok {
		if t := strings.TrimSpace(strField(capMap, "text")); t != "" {
			return t
		}
	}
	return strings.TrimSpace(strField(node, "caption", "title"))
}

func extractOwnerInfo(node map[string]any) (string, string, string) {
	owner, _ := node["owner"].(map[string]any)
	if owner == nil {
		return "", "", ""
	}
	id := strField(owner, "username", "id")
	name := strField(owner, "full_name", "username")
	if name == "" {
		name = id
	}
	avatar := ytengine.SanitizeMediaURL(html.UnescapeString(strField(owner, "profile_pic_url")), AllowedMediaURL)
	return id, name, avatar
}

func firstLineTitle(caption, authorName, shortcode string) string {
	for _, line := range strings.Split(caption, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			if len([]rune(trimmed)) > 80 {
				return string([]rune(trimmed)[:80])
			}
			return trimmed
		}
	}
	if authorName != "" {
		return "Post by " + authorName
	}
	return shortcode
}

func strField(m map[string]any, keys ...string) string {
	for _, k := range keys {
		switch v := m[k].(type) {
		case string:
			if s := strings.TrimSpace(v); s != "" {
				return s
			}
		case json.Number:
			if s := strings.TrimSpace(v.String()); s != "" {
				return s
			}
		}
	}
	return ""
}

func int64Field(m map[string]any, keys ...string) int64 {
	for _, k := range keys {
		if n, ok := unified.Numeric(m[k]); ok && n > 0 {
			if iv, ok := unified.PHPInt(m[k]); ok && iv > 0 {
				return iv
			}
		}
	}
	return 0
}

func floatField(m map[string]any, keys ...string) float64 {
	for _, k := range keys {
		if n, ok := unified.Numeric(m[k]); ok && n > 0 && !math.IsNaN(n) && !math.IsInf(n, 0) {
			return n
		}
	}
	return 0
}

func optionalCountField(m map[string]any, keys ...string) *int64 {
	for _, k := range keys {
		if sub, ok := m[k].(map[string]any); ok {
			if n, ok := unified.Numeric(sub["count"]); ok && n >= 0 {
				if iv, ok := unified.PHPInt(sub["count"]); ok && iv >= 0 {
					return &iv
				}
			}
		}
	}
	return nil
}

func optionalDirectIntField(m map[string]any, keys ...string) *int64 {
	for _, k := range keys {
		if n, ok := unified.Numeric(m[k]); ok && n >= 0 {
			if iv, ok := unified.PHPInt(m[k]); ok && iv >= 0 {
				return &iv
			}
		}
	}
	return nil
}

func (p *Parser) buildNativeEnvelope(ctx context.Context, post *nativePost, shortcode, sourceURL string, now int64) unified.Object {
	return p.buildNativeEnvelopeWithYTVideos(ctx, post, nil, shortcode, sourceURL, now)
}
