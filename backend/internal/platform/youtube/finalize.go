package youtube

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

type finalizeRequest struct {
	VideoID         string                `json:"video_id"`
	PlayerID        string                `json:"player_id"`
	Title           json.RawMessage       `json:"title"`
	Author          json.RawMessage       `json:"author"`
	DurationSeconds json.RawMessage       `json:"duration_seconds"`
	Thumbnail       json.RawMessage       `json:"thumbnail"`
	Formats         []finalizeFormatInput `json:"formats"`
	AdaptiveFormats []finalizeFormatInput `json:"adaptiveFormats"`
	Captions        json.RawMessage       `json:"captions"`
}

func parseOptionalJSONString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || trimmed[0] != '"' {
		return "", false
	}
	var s string
	if err := json.Unmarshal(trimmed, &s); err != nil {
		return "", false
	}
	return s, true
}

func parseOptionalDurationSeconds(raw json.RawMessage) *float64 {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || trimmed[0] == '"' {
		return nil
	}
	var n int64
	if err := json.Unmarshal(trimmed, &n); err != nil {
		return nil
	}
	if n <= 0 || n > 86400*365 {
		return nil
	}
	dur := float64(n)
	return &dur
}

func sanitizeFinalizeText(raw string, maxRunes int) string {
	var b strings.Builder
	b.Grow(len(raw))
	for _, r := range raw {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
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

type finalizeAudioTrack struct {
	ID             string
	DisplayName    string
	AudioIsDefault *bool
}

type rawFinalizeAudioTrack struct {
	ID             string `json:"id"`
	DisplayName    string `json:"displayName"`
	AudioIsDefault *bool  `json:"audioIsDefault"`
}

// finalizeFormatInput retains only the allowed format fields and discards all others.
type finalizeFormatInput struct {
	Itag            int
	URL             string
	SignatureCipher string
	MimeType        string
	Width           *int64
	Height          *int64
	FPS             *float64
	Bitrate         *int64
	ContentLength   string
	AudioQuality    string
	AudioSampleRate string
	AudioChannels   *int64
	AudioTrack      *finalizeAudioTrack
}

type rawFinalizeFormatFields struct {
	Itag            int             `json:"itag"`
	URL             string          `json:"url"`
	SignatureCipher string          `json:"signatureCipher"`
	MimeType        string          `json:"mimeType"`
	Width           *int64          `json:"width"`
	Height          *int64          `json:"height"`
	FPS             *float64        `json:"fps"`
	Bitrate         *int64          `json:"bitrate"`
	ContentLength   json.RawMessage `json:"contentLength"`
	AudioQuality    string          `json:"audioQuality"`
	AudioSampleRate json.RawMessage `json:"audioSampleRate"`
	AudioChannels   *int64          `json:"audioChannels"`
	AudioTrack      json.RawMessage `json:"audioTrack"`
}

func sanitizeAudioTrackID(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) == 0 || len(trimmed) > 64 {
		return ""
	}
	for i := 0; i < len(trimmed); i++ {
		if trimmed[i] < 0x21 || trimmed[i] > 0x7e {
			return ""
		}
	}
	return trimmed
}

func parseOptionalAudioTrack(raw json.RawMessage) (*finalizeAudioTrack, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	var parsed rawFinalizeAudioTrack
	if err := dec.Decode(&parsed); err != nil {
		return nil, err
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing data in audioTrack")
	}
	cleanID := sanitizeAudioTrackID(parsed.ID)
	cleanName := sanitizeFinalizeText(parsed.DisplayName, 80)
	var isDef *bool
	if parsed.AudioIsDefault != nil {
		v := *parsed.AudioIsDefault
		isDef = &v
	}
	if cleanID == "" && cleanName == "" && isDef == nil {
		return nil, nil
	}
	return &finalizeAudioTrack{
		ID:             cleanID,
		DisplayName:    cleanName,
		AudioIsDefault: isDef,
	}, nil
}

func (f *finalizeFormatInput) UnmarshalJSON(data []byte) error {
	var raw rawFinalizeFormatFields
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	cl, err := parseOptionalDigitString(raw.ContentLength)
	if err != nil {
		return fmt.Errorf("invalid contentLength: %w", err)
	}
	asr, err := parseOptionalDigitString(raw.AudioSampleRate)
	if err != nil {
		return fmt.Errorf("invalid audioSampleRate: %w", err)
	}
	at, err := parseOptionalAudioTrack(raw.AudioTrack)
	if err != nil {
		return fmt.Errorf("invalid audioTrack: %w", err)
	}
	*f = finalizeFormatInput{
		Itag:            raw.Itag,
		URL:             strings.TrimSpace(raw.URL),
		SignatureCipher: strings.TrimSpace(raw.SignatureCipher),
		MimeType:        strings.TrimSpace(raw.MimeType),
		Width:           raw.Width,
		Height:          raw.Height,
		FPS:             raw.FPS,
		Bitrate:         raw.Bitrate,
		ContentLength:   cl,
		AudioQuality:    strings.TrimSpace(raw.AudioQuality),
		AudioSampleRate: asr,
		AudioChannels:   raw.AudioChannels,
		AudioTrack:      at,
	}
	return nil
}

func parseOptionalDigitString(raw json.RawMessage) (string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", nil
	}
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil {
			return "", err
		}
		s = strings.TrimSpace(s)
		if s == "" {
			return "", nil
		}
		if _, err := strconv.ParseInt(s, 10, 64); err != nil {
			return "", err
		}
		return s, nil
	}
	var n int64
	if err := json.Unmarshal(trimmed, &n); err != nil {
		return "", err
	}
	if n < 0 {
		return "", errors.New("negative integer")
	}
	return strconv.FormatInt(n, 10), nil
}

type parsedStreamEntry struct {
	input      finalizeFormatInput
	baseURL    string
	nChallenge string
	sChallenge string
	sigParam   string
}

type decodedFinalizeRequest struct {
	videoID         string
	playerID        string
	title           string
	author          string
	duration        *float64
	thumbnail       string
	formats         []finalizeFormatInput
	adaptiveFormats []finalizeFormatInput
	captions        json.RawMessage
}

// Finalize implements POST /api/youtube/finalize?schema_version=1.0.
// It never makes any network request to googlevideo.com or youtube.com.
func (h *Helper) Finalize(ctx context.Context, body []byte, debug bool) (unified.Object, int) {
	if h == nil || h.sandbox == nil {
		return unified.ContractError("SERVICE_NOT_CONFIGURED", "YouTube 助手服务尚未配置", false), http.StatusServiceUnavailable
	}
	if h.disabled.Load() {
		return unified.ContractError("UPSTREAM_UNAVAILABLE", "YouTube上游服务暂时响应异常，已触发快速保护，请稍后重试", true), http.StatusServiceUnavailable
	}
	decoded, errPayload, errStatus := decodeFinalizeRequest(body)
	if errPayload != nil {
		return errPayload, errStatus
	}

	nowTime := h.now()
	cachedPlayer, ok := h.lookupCachedPlayer(decoded.playerID, nowTime)
	if !ok {
		return unified.ContractError("INVALID_INPUT", "player_id 不在缓存中或已过期，请重新获取上下文", false), http.StatusBadRequest
	}

	totalEntries := len(decoded.formats) + len(decoded.adaptiveFormats)
	if totalEntries == 0 || totalEntries > MaxFinalizeFormatEntries {
		return unified.ContractError("INVALID_INPUT", "媒体流条目数量超出限制", false), http.StatusBadRequest
	}
	allInputs := make([]finalizeFormatInput, 0, totalEntries)
	allInputs = append(allInputs, decoded.formats...)
	allInputs = append(allInputs, decoded.adaptiveFormats...)

	validatedEntries, errPayload, errStatus := validateFinalizeStreamEntries(allInputs, decoded.videoID)
	if errPayload != nil {
		return errPayload, errStatus
	}

	entries := filterMultiAudioStreamEntries(validatedEntries)
	nChallenges, sigChallenges := collectFinalizeChallenges(entries)
	nSolved, sigSolved, err := h.solveFinalizeChallenges(ctx, cachedPlayer, nChallenges, sigChallenges)
	if err != nil {
		return unified.ContractError("UPSTREAM_INVALID_RESPONSE", "YouTube 媒体签名挑战解密失败", false), http.StatusBadGateway
	}

	ytFormats, errPayload, errStatus := applySolvedChallengesToFormats(entries, nSolved, sigSolved)
	if errPayload != nil {
		return errPayload, errStatus
	}

	canonicalWatchURL := "https://www.youtube.com/watch?v=" + decoded.videoID
	info := &ytengine.Info{
		ID:         decoded.videoID,
		Title:      decoded.title,
		Uploader:   decoded.author,
		Duration:   decoded.duration,
		Thumbnail:  decoded.thumbnail,
		WebpageURL: canonicalWatchURL,
		Formats:    ytFormats,
	}
	opts := ytengine.AdaptOptions{
		PlatformID:      "youtube",
		ContentID:       decoded.videoID,
		SourceURL:       canonicalWatchURL,
		MaxEntries:      1,
		AllowedMediaURL: AllowedMediaURL,
		EnableDASHMux:   true,
		EnableHLS:       false,
	}
	subtitleAttachments := extractFinalizeSubtitles(decoded.captions, decoded.videoID, time.Unix(nowTime.Unix(), 0).UTC())
	return buildFinalizeEnvelope(info, opts, subtitleAttachments, nowTime.Unix(), debug)
}

func (h *Helper) solveFinalizeChallenges(
	ctx context.Context,
	player *playerCacheEntry,
	nChallenges, sigChallenges []string,
) (map[string]string, map[string]string, error) {
	nSolved := make(map[string]string, len(nChallenges))
	sigSolved := make(map[string]string, len(sigChallenges))
	var missingN []string
	var missingSig []string

	for _, c := range nChallenges {
		if val, ok := h.challengeCache.Get(player.PlayerID, player.Variant, player.PreprocessedDigest, "n", c); ok {
			nSolved[c] = val
		} else {
			missingN = append(missingN, c)
		}
	}
	for _, c := range sigChallenges {
		if val, ok := h.challengeCache.Get(player.PlayerID, player.Variant, player.PreprocessedDigest, "sig", c); ok {
			sigSolved[c] = val
		} else {
			missingSig = append(missingSig, c)
		}
	}

	if len(missingN) == 0 && len(missingSig) == 0 {
		return nSolved, sigSolved, nil
	}

	freshN, freshSig, err := h.sandbox.Solve(ctx, player.PreprocessedPlayerJS, missingN, missingSig)
	if err != nil {
		return nil, nil, err
	}
	for k, v := range freshN {
		nSolved[k] = v
		h.challengeCache.Put(player.PlayerID, player.Variant, player.PreprocessedDigest, "n", k, v)
	}
	for k, v := range freshSig {
		sigSolved[k] = v
		h.challengeCache.Put(player.PlayerID, player.Variant, player.PreprocessedDigest, "sig", k, v)
	}
	return nSolved, sigSolved, nil
}

func decodeFinalizeRequest(body []byte) (*decodedFinalizeRequest, unified.Object, int) {
	if len(body) == 0 || len(body) > MaxFinalizeBodyBytes {
		return nil, unified.ContractError("INVALID_INPUT", "请求体大小超出限制或为空", false), http.StatusBadRequest
	}

	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var req finalizeRequest
	if err := dec.Decode(&req); err != nil {
		return nil, unified.ContractError("INVALID_INPUT", "请求体格式无效或包含未允许的字段", false), http.StatusBadRequest
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, unified.ContractError("INVALID_INPUT", "请求体包含多余的 JSON 数据", false), http.StatusBadRequest
	}

	videoID := strings.TrimSpace(req.VideoID)
	if !youtubeIDPattern.MatchString(videoID) {
		return nil, unified.ContractError("INVALID_INPUT", "无效的 YouTube video_id", false), http.StatusBadRequest
	}

	resolvedTitle := videoID
	if rawTitle, ok := parseOptionalJSONString(req.Title); ok {
		if cleaned := sanitizeFinalizeText(rawTitle, MaxFinalizeTitleRunes); cleaned != "" {
			resolvedTitle = cleaned
		}
	}

	resolvedAuthor := ""
	if rawAuthor, ok := parseOptionalJSONString(req.Author); ok {
		resolvedAuthor = sanitizeFinalizeText(rawAuthor, MaxFinalizeTitleRunes)
	}

	resolvedDuration := parseOptionalDurationSeconds(req.DurationSeconds)

	resolvedThumbnail := ""
	if rawThumb, ok := parseOptionalJSONString(req.Thumbnail); ok {
		thumb := strings.TrimSpace(rawThumb)
		if thumb != "" && AllowYouTubeThumbnailURL(thumb) {
			resolvedThumbnail = thumb
		}
	}

	return &decodedFinalizeRequest{
		videoID:         videoID,
		playerID:        req.PlayerID,
		title:           resolvedTitle,
		author:          resolvedAuthor,
		duration:        resolvedDuration,
		thumbnail:       resolvedThumbnail,
		formats:         req.Formats,
		adaptiveFormats: req.AdaptiveFormats,
		captions:        req.Captions,
	}, nil, 0
}

func resolveFinalizeStreamURL(item finalizeFormatInput) (streamURL, sigChallenge, sigParam string, errPayload unified.Object) {
	hasURL := item.URL != ""
	hasCipher := item.SignatureCipher != ""
	if hasURL == hasCipher {
		return "", "", "", unified.ContractError("INVALID_INPUT", "媒体流条目必须且只能提供 url 或 signatureCipher 之一", false)
	}
	if !hasCipher {
		return item.URL, "", "sig", nil
	}

	cipherVals, err := url.ParseQuery(item.SignatureCipher)
	if err != nil {
		return "", "", "", unified.ContractError("INVALID_INPUT", "signatureCipher 格式无效", false)
	}
	urls := cipherVals["url"]
	sigs := cipherVals["s"]
	if len(urls) != 1 || strings.TrimSpace(urls[0]) == "" || len(sigs) != 1 || strings.TrimSpace(sigs[0]) == "" {
		return "", "", "", unified.ContractError("INVALID_INPUT", "signatureCipher 缺少有效的 url 或 s 参数", false)
	}
	sigParam = "sig"
	if spVals := cipherVals["sp"]; len(spVals) > 0 {
		if len(spVals) != 1 || (spVals[0] != "sig" && spVals[0] != "signature") {
			return "", "", "", unified.ContractError("INVALID_INPUT", "signatureCipher 包含非法的 sp 参数", false)
		}
		sigParam = spVals[0]
	}
	return strings.TrimSpace(urls[0]), strings.TrimSpace(sigs[0]), sigParam, nil
}

func validateFinalizeStreamEntries(allInputs []finalizeFormatInput, videoID string) ([]parsedStreamEntry, unified.Object, int) {
	validatedEntries := make([]parsedStreamEntry, 0, len(allInputs))
	expectedStreamID := ""

	for _, item := range allInputs {
		if item.Itag <= 0 || item.MimeType == "" {
			return nil, unified.ContractError("INVALID_INPUT", "媒体流条目缺少有效的 itag 或 mimeType", false), http.StatusBadRequest
		}
		streamURL, sigChallenge, sigParam, errPayload := resolveFinalizeStreamURL(item)
		if errPayload != nil {
			return nil, errPayload, http.StatusBadRequest
		}
		if !AllowGooglevideoPlaybackURL(streamURL) {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接必须为 https://*.googlevideo.com/videoplayback", false), http.StatusBadRequest
		}

		parsedU, err := url.Parse(streamURL)
		if err != nil {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接解析失败", false), http.StatusBadRequest
		}
		q := parsedU.Query()

		// Validate the stream's id parameter:
		// Real YouTube TVHTML5 videoplayback URLs carry a signed per-playback session ID
		// (id=o-<44 base64url chars>, signed under sparams=...,id,...) shared across all
		// streams in the response, while synthetic/test URLs may carry id=<video_id>.
		// Reject if id is missing, does not match either video_id or a valid o- playback ID,
		// or differs across streams in the same finalize request.
		idVals := q["id"]
		if len(idVals) != 1 || strings.TrimSpace(idVals[0]) == "" {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接缺少有效的 id 参数", false), http.StatusBadRequest
		}
		streamID := strings.TrimSpace(idVals[0])
		if streamID != videoID && !opaquePlaybackIDPattern.MatchString(streamID) {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接参数 id 与 video_id 不一致", false), http.StatusBadRequest
		}
		if expectedStreamID == "" {
			expectedStreamID = streamID
		} else if streamID != expectedStreamID {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接参数 id 与 video_id 不一致", false), http.StatusBadRequest
		}

		if itagVals := q["itag"]; len(itagVals) != 1 || itagVals[0] != strconv.Itoa(item.Itag) {
			return nil, unified.ContractError("INVALID_INPUT", "媒体链接参数 itag 与条目不一致", false), http.StatusBadRequest
		}

		nVal := ""
		if nVals := q["n"]; len(nVals) > 0 {
			if len(nVals) != 1 || strings.TrimSpace(nVals[0]) == "" {
				return nil, unified.ContractError("INVALID_INPUT", "媒体链接参数 n 无效", false), http.StatusBadRequest
			}
			nVal = strings.TrimSpace(nVals[0])
		}

		validatedEntries = append(validatedEntries, parsedStreamEntry{
			input:      item,
			baseURL:    streamURL,
			nChallenge: nVal,
			sChallenge: sigChallenge,
			sigParam:   sigParam,
		})
	}

	return validatedEntries, nil, 0
}

func collectFinalizeChallenges(entries []parsedStreamEntry) ([]string, []string) {
	var nChallenges []string
	nSeen := make(map[string]bool)
	var sigChallenges []string
	sigSeen := make(map[string]bool)
	for _, entry := range entries {
		if entry.nChallenge != "" && !nSeen[entry.nChallenge] {
			nSeen[entry.nChallenge] = true
			nChallenges = append(nChallenges, entry.nChallenge)
		}
		if entry.sChallenge != "" && !sigSeen[entry.sChallenge] {
			sigSeen[entry.sChallenge] = true
			sigChallenges = append(sigChallenges, entry.sChallenge)
		}
	}
	return nChallenges, sigChallenges
}

func applySolvedChallengesToFormats(entries []parsedStreamEntry, nSolved, sigSolved map[string]string) ([]ytengine.Format, unified.Object, int) {
	ytFormats := make([]ytengine.Format, 0, len(entries))
	itagCounts := make(map[int]int, len(entries))
	for _, entry := range entries {
		finalURL := entry.baseURL
		if entry.nChallenge != "" {
			solvedN := nSolved[entry.nChallenge]
			if solvedN == "" {
				return nil, unified.ContractError("UPSTREAM_INVALID_RESPONSE", "YouTube n 参数解密结果缺失", false), http.StatusBadGateway
			}
			updated, err := setURLQueryParamPreserveOrder(finalURL, "n", solvedN)
			if err != nil {
				return nil, unified.ContractError("INVALID_INPUT", "媒体链接更新失败", false), http.StatusBadRequest
			}
			finalURL = updated
		}
		if entry.sChallenge != "" {
			solvedSig := sigSolved[entry.sChallenge]
			if solvedSig == "" {
				return nil, unified.ContractError("UPSTREAM_INVALID_RESPONSE", "YouTube sig 参数解密结果缺失", false), http.StatusBadGateway
			}
			updated, err := setURLQueryParamPreserveOrder(finalURL, entry.sigParam, solvedSig)
			if err != nil {
				return nil, unified.ContractError("INVALID_INPUT", "媒体链接更新失败", false), http.StatusBadRequest
			}
			finalURL = updated
		}
		if !AllowGooglevideoPlaybackURL(finalURL) {
			return nil, unified.ContractError("INVALID_INPUT", "解密后的媒体链接不合法", false), http.StatusBadRequest
		}

		itagCounts[entry.input.Itag]++
		formatID := strconv.Itoa(entry.input.Itag)
		if count := itagCounts[entry.input.Itag]; count > 1 {
			formatID = fmt.Sprintf("%d-dup%d", entry.input.Itag, count)
		}
		yf, ok := convertToYTFormat(entry.input, formatID, finalURL)
		if !ok {
			return nil, unified.ContractError("INVALID_INPUT", "媒体流 mimeType 或参数无效", false), http.StatusBadRequest
		}
		ytFormats = append(ytFormats, yf)
	}
	return ytFormats, nil, 0
}

func buildFinalizeEnvelope(info *ytengine.Info, opts ytengine.AdaptOptions, subtitleAttachments unified.Array, nowUnix int64, debug bool) (unified.Object, int) {
	payload := ytengine.AdaptInfo(info, opts, nowUnix)
	if unified.Str(payload["code"]) == "OK" && len(subtitleAttachments) > 0 {
		if data := unified.Map(payload["data"]); data != nil {
			existing := unified.Slice(data["attachments"])
			seen := make(map[string]bool, len(existing)+len(subtitleAttachments))
			merged := make(unified.Array, 0, len(existing)+len(subtitleAttachments))
			for _, raw := range existing {
				id := unified.Str(unified.Map(raw)["id"])
				if id != "" {
					seen[id] = true
				}
				merged = append(merged, raw)
			}
			for _, raw := range subtitleAttachments {
				id := unified.Str(unified.Map(raw)["id"])
				if id == "" || seen[id] {
					continue
				}
				seen[id] = true
				merged = append(merged, raw)
			}
			if len(merged) > 0 {
				data["attachments"] = merged
			}
		}
	}
	if err := unified.ValidateEnvelopeAt(payload, nowUnix); err != nil {
		return unified.ContractError("INTERNAL_ERROR", "解析接口合同校验失败", false), http.StatusBadGateway
	}
	status := http.StatusOK
	if unified.Str(payload["code"]) != "OK" {
		status = http.StatusNotFound
	}
	payload = unified.PublicView(payload, debug, nowUnix)
	if err := unified.ValidateEnvelopeAt(payload, nowUnix); err != nil {
		return unified.ContractError("INTERNAL_ERROR", "解析接口合同校验失败", false), http.StatusBadGateway
	}
	return payload, status
}
