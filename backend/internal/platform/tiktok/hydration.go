package tiktok

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

const (
	hydrationScriptMarker = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"`
	hydrationScriptClose  = `</script>`
	maxWAFBodyInspectSize = 16 << 10
)

var slardarWAFMarkers = [][]byte{
	[]byte("slardar_us_waf"),
	[]byte("_wafchallengeid"),
	[]byte("waf-jschallenge"),
	[]byte("byted_acrawler"),
}

// flexInt64 decodes JSON numbers or numeric strings (TikTok occasionally quotes
// large sizes or counts as strings in hydration JSON).
type flexInt64 int64

func (f *flexInt64) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		*f = 0
		return nil
	}
	if trimmed[0] == '"' && trimmed[len(trimmed)-1] == '"' {
		s, err := strconv.Unquote(string(trimmed))
		if err != nil {
			*f = 0
			return nil
		}
		s = strings.TrimSpace(s)
		if s == "" {
			*f = 0
			return nil
		}
		if v, err := strconv.ParseInt(s, 10, 64); err == nil {
			*f = flexInt64(v)
			return nil
		}
		if fv, err := strconv.ParseFloat(s, 64); err == nil {
			*f = flexInt64(int64(fv))
			return nil
		}
		*f = 0
		return nil
	}
	if v, err := strconv.ParseInt(string(trimmed), 10, 64); err == nil {
		*f = flexInt64(v)
		return nil
	}
	if fv, err := strconv.ParseFloat(string(trimmed), 64); err == nil {
		*f = flexInt64(int64(fv))
		return nil
	}
	*f = 0
	return nil
}

type hydrationEnvelope struct {
	DefaultScope map[string]json.RawMessage `json:"__DEFAULT_SCOPE__"`
}

type videoDetailScope struct {
	StatusCode int              `json:"statusCode"`
	StatusMsg  string           `json:"statusMsg"`
	ItemInfo   *videoDetailInfo `json:"itemInfo"`
}

type videoDetailInfo struct {
	ItemStruct *tiktokItemStruct `json:"itemStruct"`
}

type tiktokItemStruct struct {
	ID         string             `json:"id"`
	Desc       string             `json:"desc"`
	CreateTime flexInt64          `json:"createTime"`
	Author     *tiktokAuthor      `json:"author"`
	Stats      *tiktokStats       `json:"stats"`
	Video      *tiktokVideo       `json:"video"`
	ImagePost  *tiktokImagePost   `json:"imagePost"`
	Music      *tiktokMusic       `json:"music"`
	Challenges []tiktokChallenge  `json:"challenges"`
	TextExtra  []tiktokTextExtra  `json:"textExtra"`
}

type tiktokAuthor struct {
	ID            string `json:"id"`
	UniqueID      string `json:"uniqueId"`
	Nickname      string `json:"nickname"`
	Signature     string `json:"signature"`
	AvatarLarger  string `json:"avatarLarger"`
	AvatarMedium  string `json:"avatarMedium"`
	AvatarThumb   string `json:"avatarThumb"`
}

type tiktokStats struct {
	PlayCount    flexInt64 `json:"playCount"`
	DiggCount    flexInt64 `json:"diggCount"`
	CommentCount flexInt64 `json:"commentCount"`
	ShareCount   flexInt64 `json:"shareCount"`
	CollectCount flexInt64 `json:"collectCount"`
}

type tiktokVideo struct {
	ID          string              `json:"id"`
	Width       flexInt64           `json:"width"`
	Height      flexInt64           `json:"height"`
	Duration    flexInt64           `json:"duration"`
	Ratio       string              `json:"ratio"`
	Cover       string              `json:"cover"`
	OriginCover string              `json:"originCover"`
	DynamicCover string             `json:"dynamicCover"`
	PlayAddr    string              `json:"playAddr"`
	Bitrate     flexInt64           `json:"bitrate"`
	CodecType   string              `json:"codecType"`
	BitrateInfo []tiktokBitrateInfo `json:"bitrateInfo"`
}

type tiktokBitrateInfo struct {
	GearName    string          `json:"GearName"`
	Bitrate     flexInt64       `json:"Bitrate"`
	QualityType flexInt64       `json:"QualityType"`
	CodecType   string          `json:"CodecType"`
	PlayAddr    *tiktokPlayAddr `json:"PlayAddr"`
}

type tiktokPlayAddr struct {
	URI      string    `json:"Uri"`
	URLList  []string  `json:"UrlList"`
	Width    flexInt64 `json:"Width"`
	Height   flexInt64 `json:"Height"`
	DataSize flexInt64 `json:"DataSize"`
	FileHash string    `json:"FileHash"`
}

type tiktokImagePost struct {
	Title  string             `json:"title"`
	Images []tiktokImageEntry `json:"images"`
	Cover  *tiktokImageEntry  `json:"cover"`
}

type tiktokImageEntry struct {
	ImageURL    *tiktokURLList `json:"imageURL"`
	ImageWidth  flexInt64      `json:"imageWidth"`
	ImageHeight flexInt64      `json:"imageHeight"`
}

type tiktokURLList struct {
	URLList []string `json:"urlList"`
}

type tiktokMusic struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	PlayURL     string    `json:"playUrl"`
	AuthorName  string    `json:"authorName"`
	CoverLarge  string    `json:"coverLarge"`
	CoverMedium string    `json:"coverMedium"`
	Duration    flexInt64 `json:"duration"`
}

type tiktokChallenge struct {
	Title string `json:"title"`
}

type tiktokTextExtra struct {
	HashtagName string `json:"hashtagName"`
}

// extractHydrationScriptJSON performs a bounded non-backtracking scan for the
// <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"...>...</script> payload.
func extractHydrationScriptJSON(body []byte) ([]byte, bool) {
	idx := bytes.Index(body, []byte(hydrationScriptMarker))
	if idx < 0 {
		return nil, false
	}
	rest := body[idx+len(hydrationScriptMarker):]
	gt := bytes.IndexByte(rest, '>')
	if gt < 0 || gt > 4096 {
		return nil, false
	}
	rest = rest[gt+1:]
	end := bytes.Index(rest, []byte(hydrationScriptClose))
	if end < 0 {
		return nil, false
	}
	payload := bytes.TrimSpace(rest[:end])
	if len(payload) == 0 {
		return nil, false
	}
	return payload, true
}

// isSlardarWAF detects TikTok's Slardar/ByteDance WAF challenge pages.
func isSlardarWAF(statusCode int, body []byte) bool {
	if statusCode == 403 || statusCode == 429 {
		return true
	}
	if len(body) == 0 || len(body) >= maxWAFBodyInspectSize {
		return false
	}
	lower := bytes.ToLower(body)
	for _, marker := range slardarWAFMarkers {
		if bytes.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func isUnavailableStatusCode(code int) bool {
	switch code {
	case 10204, 10216, 10221, 10222:
		return true
	default:
		return false
	}
}

func parseVideoDetailFromHTML(body []byte) (*videoDetailScope, bool, error) {
	raw, found := extractHydrationScriptJSON(body)
	if !found {
		return nil, false, nil
	}
	var env hydrationEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, true, err
	}
	detailRaw, ok := env.DefaultScope["webapp.video-detail"]
	if !ok || len(bytes.TrimSpace(detailRaw)) == 0 {
		return nil, true, nil
	}
	var detail videoDetailScope
	if err := json.Unmarshal(detailRaw, &detail); err != nil {
		return nil, true, err
	}
	return &detail, true, nil
}
