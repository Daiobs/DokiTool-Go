package tiktok

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/urlpolicy"
)

const (
	// MaxFinalizeBodyBytes caps POST /api/tiktok/finalize request payloads.
	MaxFinalizeBodyBytes = 512 << 10

	maxFinalizeResolvedTiers = 16
	maxFinalizeTags          = 64
	maxFinalizeDescRunes     = 2000
	maxFinalizeTitleRunes    = 300
	maxFinalizeNameRunes     = 160
	maxFinalizeSigRunes      = 500
	maxFinalizeIDRunes       = 64
	maxFinalizeUniqueIDRunes = 128
	maxFinalizeTagRunes      = 80
	maxFinalizeDurationSec   = 86400
	maxFinalizeDimension     = 16384
	maxFinalizeBitrate       = 500_000_000
	maxFinalizeDataSize      = 10 << 30
)

type finalizeRequest struct {
	SourceURL     string                    `json:"source_url"`
	VideoDetail   json.RawMessage           `json:"video_detail"`
	ResolvedTiers []finalizeResolvedTierReq `json:"resolved_tiers"`
}

type finalizeResolvedTierReq struct {
	PlayURL   string `json:"play_url"`
	DirectURL string `json:"direct_url"`
}

// Finalize validates a client-submitted TikTok webapp.video-detail payload and
// client-resolved /aweme/v1/play/ direct CDN URLs, then formats a canonical
// unified-v1 response using zero outbound network calls.
func (p *Parser) Finalize(ctx context.Context, body []byte, debug bool) (unified.Object, int) {
	if ctx != nil && ctx.Err() != nil {
		return unified.ContractError("UPSTREAM_TIMEOUT", "TikTok 解析超时，请稍后重试", true), http.StatusGatewayTimeout
	}
	now := p.now().Unix()
	return FinalizePayload(ctx, body, now, debug)
}

// FinalizePayload validates and formats an untrusted TikTok client-assisted
// payload at a deterministic timestamp without making any network requests.
func FinalizePayload(ctx context.Context, body []byte, now int64, debug bool) (unified.Object, int) {
	if ctx != nil && ctx.Err() != nil {
		return unified.ContractError("UPSTREAM_TIMEOUT", "TikTok 解析超时，请稍后重试", true), http.StatusGatewayTimeout
	}
	if len(body) == 0 || len(body) > MaxFinalizeBodyBytes {
		return unified.ContractError("INVALID_INPUT", "请求体大小超出限制或为空", false), http.StatusBadRequest
	}

	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var req finalizeRequest
	if err := dec.Decode(&req); err != nil {
		return unified.ContractError("INVALID_INPUT", "请求体格式无效或包含未允许的字段", false), http.StatusBadRequest
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return unified.ContractError("INVALID_INPUT", "请求体包含多余的 JSON 数据", false), http.StatusBadRequest
	}

	itemID, canonicalURL, isShort, ok := urlpolicy.ExtractTikTokItemTarget(req.SourceURL)
	if !ok || isShort || itemID == "" {
		return unified.ContractError("INVALID_INPUT", "source_url 必须为已展开的 TikTok 作品链接", false), http.StatusBadRequest
	}

	if len(req.ResolvedTiers) > maxFinalizeResolvedTiers {
		return unified.ContractError("INVALID_INPUT", "resolved_tiers 数量超出限制", false), http.StatusBadRequest
	}

	// Validate every submitted resolved tier unconditionally (fail-closed),
	// regardless of whether the work turns out to be Photo Mode or Video Mode.
	resolvedMap := make(map[string]string, len(req.ResolvedTiers))
	for _, entry := range req.ResolvedTiers {
		playURL := strings.TrimSpace(entry.PlayURL)
		directURL := strings.TrimSpace(entry.DirectURL)
		if !isPlayRedirectSourceURL(playURL) {
			return unified.ContractError("INVALID_INPUT", "resolved_tiers.play_url 必须为 https://www.tiktok.com/aweme/v1/play/ 链接", false), http.StatusBadRequest
		}
		if !AllowedMediaURL(directURL) {
			return unified.ContractError("INVALID_INPUT", "resolved_tiers.direct_url 不在允许的无 Cookie 媒体 CDN 白名单内", false), http.StatusBadRequest
		}
		if _, dup := resolvedMap[playURL]; dup {
			return unified.ContractError("INVALID_INPUT", "resolved_tiers 包含重复的 play_url", false), http.StatusBadRequest
		}
		resolvedMap[playURL] = directURL
	}

	trimmedDetail := bytes.TrimSpace(req.VideoDetail)
	if len(trimmedDetail) == 0 || trimmedDetail[0] != '{' {
		return unified.ContractError("INVALID_INPUT", "video_detail 必须为非空 JSON 对象", false), http.StatusBadRequest
	}
	var detail videoDetailScope
	if err := json.Unmarshal(trimmedDetail, &detail); err != nil {
		return unified.ContractError("INVALID_INPUT", "video_detail JSON 格式无效", false), http.StatusBadRequest
	}

	if isUnavailableStatusCode(detail.StatusCode) {
		return unified.ContractError("CONTENT_UNAVAILABLE", "该 TikTok 作品已删除、设为私密或当前区域不可见", false), http.StatusNotFound
	}
	if detail.StatusCode != 0 {
		return unified.ContractError("UPSTREAM_UNAVAILABLE", "TikTok 暂未返回作品数据，请稍后重试", true), http.StatusBadGateway
	}
	if detail.ItemInfo == nil || detail.ItemInfo.ItemStruct == nil {
		return unified.ContractError("INVALID_INPUT", "video_detail 缺少作品详情数据", false), http.StatusBadRequest
	}

	itemStruct := detail.ItemInfo.ItemStruct
	structID := strings.TrimSpace(itemStruct.ID)
	if structID != "" && structID != itemID {
		return unified.ContractError("INVALID_INPUT", "TikTok 作品 ID 与 source_url 不一致", false), http.StatusBadRequest
	}
	itemStruct.ID = itemID

	sanitizeFinalizeItemStruct(itemStruct, now)

	// Photo Mode: zero resolved_tiers allowed/needed.
	if itemStruct.ImagePost != nil && len(itemStruct.ImagePost.Images) > 0 {
		if len(resolvedMap) > 0 {
			return unified.ContractError("INVALID_INPUT", "TikTok 图文作品不接受视频 resolved_tiers", false), http.StatusBadRequest
		}
		payload, ok := formatPhotoPost(itemStruct, canonicalURL, now)
		if !ok {
			return unified.ContractError("NO_MEDIA", "该 TikTok 图文未提供可用的公开图片资源", false), http.StatusNotFound
		}
		return finalizePublicEnvelope(ctx, payload, now, debug)
	}

	// Video Mode: bind every submitted play_url strictly to selected candidates.
	if itemStruct.Video != nil {
		candidates := selectVideoTierCandidates(itemStruct.Video)
		if len(candidates) == 0 {
			return unified.ContractError("NO_MEDIA", "该 TikTok 作品未提供可解析的视频流", false), http.StatusNotFound
		}
		if len(resolvedMap) == 0 {
			return unified.ContractError("INVALID_INPUT", "TikTok 视频作品缺少已解析的 resolved_tiers", false), http.StatusBadRequest
		}

		candidateSet := make(map[string]struct{}, len(candidates))
		for _, c := range candidates {
			candidateSet[c.playURL] = struct{}{}
		}
		for playURL := range resolvedMap {
			if _, matched := candidateSet[playURL]; !matched {
				return unified.ContractError("INVALID_INPUT", "resolved_tiers 包含不属于当前作品候选档位的 play_url", false), http.StatusBadRequest
			}
		}

		resolved := make([]resolvedVideoTier, 0, len(candidates))
		seenDirect := make(map[string]struct{}, len(candidates))
		for _, c := range candidates {
			directURL, exists := resolvedMap[c.playURL]
			if !exists {
				continue
			}
			if _, dup := seenDirect[directURL]; dup {
				continue
			}
			seenDirect[directURL] = struct{}{}
			resolved = append(resolved, resolvedVideoTier{
				candidate: c,
				directURL: directURL,
				expiresAt: parseTikTokURLExpiry(directURL, now),
			})
		}
		if len(resolved) == 0 {
			return unified.ContractError("UPSTREAM_UNAVAILABLE", "TikTok 视频直链解析失败，请稍后重试", true), http.StatusBadGateway
		}
		payload, ok := formatVideoPost(itemStruct, resolved, canonicalURL, now)
		if !ok {
			return unified.ContractError("NO_MEDIA", "该 TikTok 作品未找到可下载的媒体资源", false), http.StatusNotFound
		}
		return finalizePublicEnvelope(ctx, payload, now, debug)
	}

	return unified.ContractError("NO_MEDIA", "该 TikTok 作品未找到可下载的媒体资源", false), http.StatusNotFound
}

func finalizePublicEnvelope(ctx context.Context, payload unified.Object, now int64, debug bool) (unified.Object, int) {
	if ctx != nil && ctx.Err() != nil {
		return unified.ContractError("UPSTREAM_TIMEOUT", "TikTok 解析超时，请稍后重试", true), http.StatusGatewayTimeout
	}
	if err := unified.ValidateEnvelopeAt(payload, now); err != nil {
		return unified.ContractError("INTERNAL_ERROR", "解析接口合同校验失败", false), http.StatusBadGateway
	}
	payload = unified.PublicView(payload, debug, now)
	if err := unified.ValidateEnvelopeAt(payload, now); err != nil {
		return unified.ContractError("INTERNAL_ERROR", "解析接口合同校验失败", false), http.StatusBadGateway
	}
	return payload, http.StatusOK
}

func sanitizeFinalizeText(raw string, maxRunes int) string {
	var b strings.Builder
	b.Grow(len(raw))
	for _, r := range raw {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			if r == '\n' || r == '\r' || r == '\t' {
				b.WriteByte(' ')
			}
			continue
		}
		b.WriteRune(r)
	}
	trimmed := strings.TrimSpace(b.String())
	if trimmed == "" || maxRunes <= 0 {
		return trimmed
	}
	runes := []rune(trimmed)
	if len(runes) > maxRunes {
		trimmed = strings.TrimSpace(string(runes[:maxRunes]))
	}
	return trimmed
}

func clampInt64(v, minVal, maxVal int64) int64 {
	if v < minVal || v > maxVal {
		return 0
	}
	return v
}

func sanitizeFinalizeItemStruct(item *tiktokItemStruct, now int64) {
	if item == nil {
		return
	}
	item.Desc = sanitizeFinalizeText(item.Desc, maxFinalizeDescRunes)
	if ct := int64(item.CreateTime); ct < 1_400_000_000 || (now > 0 && ct > now+365*86400) {
		item.CreateTime = 0
	}
	if item.Author != nil {
		item.Author.ID = sanitizeFinalizeText(item.Author.ID, maxFinalizeIDRunes)
		item.Author.UniqueID = sanitizeFinalizeText(item.Author.UniqueID, maxFinalizeUniqueIDRunes)
		item.Author.Nickname = sanitizeFinalizeText(item.Author.Nickname, maxFinalizeNameRunes)
		item.Author.Signature = sanitizeFinalizeText(item.Author.Signature, maxFinalizeSigRunes)
	}
	if item.Video != nil {
		item.Video.Width = flexInt64(clampInt64(int64(item.Video.Width), 0, maxFinalizeDimension))
		item.Video.Height = flexInt64(clampInt64(int64(item.Video.Height), 0, maxFinalizeDimension))
		item.Video.Duration = flexInt64(clampInt64(int64(item.Video.Duration), 0, maxFinalizeDurationSec))
		item.Video.Bitrate = flexInt64(clampInt64(int64(item.Video.Bitrate), 0, maxFinalizeBitrate))
		for i := range item.Video.BitrateInfo {
			bi := &item.Video.BitrateInfo[i]
			bi.GearName = sanitizeFinalizeText(bi.GearName, 80)
			bi.CodecType = sanitizeFinalizeText(bi.CodecType, 64)
			bi.Bitrate = flexInt64(clampInt64(int64(bi.Bitrate), 0, maxFinalizeBitrate))
			if bi.PlayAddr != nil {
				bi.PlayAddr.Width = flexInt64(clampInt64(int64(bi.PlayAddr.Width), 0, maxFinalizeDimension))
				bi.PlayAddr.Height = flexInt64(clampInt64(int64(bi.PlayAddr.Height), 0, maxFinalizeDimension))
				bi.PlayAddr.DataSize = flexInt64(clampInt64(int64(bi.PlayAddr.DataSize), 0, maxFinalizeDataSize))
			}
		}
	}
	if item.ImagePost != nil {
		item.ImagePost.Title = sanitizeFinalizeText(item.ImagePost.Title, maxFinalizeTitleRunes)
		if len(item.ImagePost.Images) > maxTikTokImages {
			item.ImagePost.Images = item.ImagePost.Images[:maxTikTokImages]
		}
		for i := range item.ImagePost.Images {
			img := &item.ImagePost.Images[i]
			img.ImageWidth = flexInt64(clampInt64(int64(img.ImageWidth), 0, maxFinalizeDimension))
			img.ImageHeight = flexInt64(clampInt64(int64(img.ImageHeight), 0, maxFinalizeDimension))
		}
	}
	if item.Music != nil {
		item.Music.ID = sanitizeFinalizeText(item.Music.ID, maxFinalizeIDRunes)
		item.Music.Title = sanitizeFinalizeText(item.Music.Title, maxFinalizeTitleRunes)
		item.Music.AuthorName = sanitizeFinalizeText(item.Music.AuthorName, maxFinalizeNameRunes)
		item.Music.Duration = flexInt64(clampInt64(int64(item.Music.Duration), 0, maxFinalizeDurationSec))
	}
	if len(item.Challenges) > maxFinalizeTags {
		item.Challenges = item.Challenges[:maxFinalizeTags]
	}
	for i := range item.Challenges {
		item.Challenges[i].Title = sanitizeFinalizeText(item.Challenges[i].Title, maxFinalizeTagRunes)
	}
	if len(item.TextExtra) > maxFinalizeTags {
		item.TextExtra = item.TextExtra[:maxFinalizeTags]
	}
	for i := range item.TextExtra {
		item.TextExtra[i].HashtagName = sanitizeFinalizeText(item.TextExtra[i].HashtagName, maxFinalizeTagRunes)
	}
}
