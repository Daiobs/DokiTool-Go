package youtube

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type goldenYouTubeExecutor struct {
	playerID     string
	playerBaseJS []byte
}

func (g *goldenYouTubeExecutor) Do(_ context.Context, req fetch.Request) (fetch.Response, error) {
	if req.Policy.AllowedURL == nil || !req.Policy.AllowedURL(req.URL) {
		return fetch.Response{}, fetch.ErrPolicy
	}
	switch req.URL {
	case "https://www.youtube.com/iframe_api":
		body := `var scriptUrl = 'https:\/\/www.youtube.com\/s\/player\/` + g.playerID + `\/www-widgetapi.vflset\/www-widgetapi.js';`
		return fetch.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/javascript"}},
			Body:       []byte(body),
			URL:        req.URL,
		}, nil
	case "https://www.youtube.com/s/player/" + g.playerID + "/player_ias.vflset/en_US/base.js":
		return fetch.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/javascript"}},
			Body:       g.playerBaseJS,
			URL:        req.URL,
		}, nil
	default:
		return fetch.Response{StatusCode: http.StatusNotFound}, nil
	}
}

func goldenShortDigest(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])[:24]
}

func newGoldenHelper(t *testing.T, playerID string, playerJS []byte, nowFn func() time.Time) *Helper {
	t.Helper()
	sb := newTestSandbox(t)
	if len(playerJS) == 0 {
		raw, err := os.ReadFile(filepath.Join("testdata", "player_base_fixture.js"))
		if err != nil {
			t.Fatalf("read player_base_fixture.js: %v", err)
		}
		playerJS = raw
	}
	h, err := NewHelper(&goldenYouTubeExecutor{
		playerID:     playerID,
		playerBaseJS: playerJS,
	}, sb, nowFn)
	if err != nil {
		t.Fatalf("NewHelper: %v", err)
	}
	if payload, st := h.Context(context.Background()); st != http.StatusOK {
		t.Fatalf("Context warmup status=%d payload=%#v", st, payload)
	}
	return h
}

func assertContractRejection(t *testing.T, payload unified.Object, status, wantStatus int, wantCode, wantMessage string) {
	t.Helper()
	if status != wantStatus {
		t.Fatalf("status = %d, want %d (payload=%#v)", status, wantStatus, payload)
	}
	if gotCode := unified.Str(payload["code"]); gotCode != wantCode {
		t.Fatalf("code = %q, want %q (payload=%#v)", gotCode, wantCode, payload)
	}
	errObj := unified.Map(payload["error"])
	if errObj == nil {
		t.Fatalf("expected non-nil error object in %#v", payload)
	}
	if gotMsg := unified.Str(errObj["message"]); gotMsg != wantMessage {
		t.Fatalf("error.message = %q, want %q", gotMsg, wantMessage)
	}
	if errObj["retryable"] == true {
		t.Fatalf("error.retryable = %v, want omitted/false", errObj["retryable"])
	}
	if unified.Str(errObj["code"]) != wantCode {
		t.Fatalf("error.code = %q, want %q", unified.Str(errObj["code"]), wantCode)
	}
}

func TestFinalizeGoldenValidationOrderAndRejectionMatrix(t *testing.T) {
	if PinnedDenoVersion == "" {
		t.Fatal("expected non-empty PinnedDenoVersion")
	}

	// 1. Nil or unconfigured Helper returns 503 SERVICE_NOT_CONFIGURED before body checks.
	var nilHelper *Helper
	pNil, sNil := nilHelper.Finalize(context.Background(), nil, false)
	assertContractRejection(t, pNil, sNil, http.StatusServiceUnavailable, "SERVICE_NOT_CONFIGURED", "YouTube 助手服务尚未配置")

	unconf := &Helper{}
	pUnconf, sUnconf := unconf.Finalize(context.Background(), nil, false)
	assertContractRejection(t, pUnconf, sUnconf, http.StatusServiceUnavailable, "SERVICE_NOT_CONFIGURED", "YouTube 助手服务尚未配置")

	currentNow := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	helper := newGoldenHelper(t, "a5c2aafe", nil, func() time.Time { return currentNow })

	const validVideoID = "I9JvDaciaFk"
	validProg := map[string]any{
		"itag":     18,
		"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
		"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + validVideoID + "&itag=18&n=CHAL_N_18",
	}

	type errCase struct {
		name        string
		body        []byte
		advanceTime time.Duration
		wantStatus  int
		wantCode    string
		wantMsg     string
	}

	marshalJSON := func(v any) []byte {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("json.Marshal: %v", err)
		}
		return b
	}

	manyFormats := make([]any, MaxFinalizeFormatEntries+1)
	for i := range manyFormats {
		manyFormats[i] = validProg
	}

	cases := []errCase{
		{
			name:       "empty-nil-body",
			body:       nil,
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "请求体大小超出限制或为空",
		},
		{
			name:       "empty-slice-body",
			body:       []byte{},
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "请求体大小超出限制或为空",
		},
		{
			name:       "oversize-body",
			body:       bytes.Repeat([]byte(" "), MaxFinalizeBodyBytes+1),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "请求体大小超出限制或为空",
		},
		{
			name:       "malformed-json",
			body:       []byte(`{"video_id":`),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "请求体格式无效或包含未允许的字段",
		},
		{
			name: "unknown-top-level-field",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats":   []any{validProg},
				"extra_key": true,
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "请求体格式无效或包含未允许的字段",
		},
		{
			name: "invalid-negative-contentLength",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":          18,
						"mimeType":      `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"contentLength": -5,
						"url":           validProg["url"],
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "请求体格式无效或包含未允许的字段",
		},
		{
			name: "invalid-non-numeric-audioSampleRate",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":            140,
						"mimeType":        `audio/mp4; codecs="mp4a.40.2"`,
						"audioSampleRate": "44.1khz",
						"url":             "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + validVideoID + "&itag=140",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "请求体格式无效或包含未允许的字段",
		},
		{
			name: "unknown-audioTrack-field",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":       140,
						"mimeType":   `audio/mp4; codecs="mp4a.40.2"`,
						"url":        "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + validVideoID + "&itag=140",
						"audioTrack": map[string]any{"id": "en.4", "unknown": 1},
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "请求体格式无效或包含未允许的字段",
		},
		{
			name:       "trailing-json-tokens",
			body:       append(marshalJSON(map[string]any{"video_id": validVideoID, "player_id": "a5c2aafe", "formats": []any{validProg}}), []byte(` {"trailing":1}`)...),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "请求体包含多余的 JSON 数据",
		},
		{
			// Validation order: invalid video_id must be rejected BEFORE player_id cache lookup.
			name: "invalid-video-id-checked-before-player-id",
			body: marshalJSON(map[string]any{
				"video_id":  "short",
				"player_id": "missing!",
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "无效的 YouTube video_id",
		},
		{
			name: "invalid-video-id-illegal-chars",
			body: marshalJSON(map[string]any{
				"video_id":  "abc$efghijk",
				"player_id": "a5c2aafe",
				"formats":   []any{validProg},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "无效的 YouTube video_id",
		},
		{
			// Validation order: player_id lookup runs BEFORE empty formats check.
			name: "missing-player-id-checked-before-entry-count",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "",
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "player_id 不在缓存中或已过期，请重新获取上下文",
		},
		{
			name: "uncached-player-id",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "12345678",
				"formats":   []any{validProg},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "player_id 不在缓存中或已过期，请重新获取上下文",
		},
		{
			name:        "expired-player-id",
			body:        marshalJSON(map[string]any{"video_id": validVideoID, "player_id": "a5c2aafe", "formats": []any{validProg}}),
			advanceTime: DefaultPlayerCacheTTL,
			wantStatus:  http.StatusBadRequest,
			wantCode:    "INVALID_INPUT",
			wantMsg:     "player_id 不在缓存中或已过期，请重新获取上下文",
		},
		{
			name: "zero-format-entries",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体流条目数量超出限制",
		},
		{
			name: "exceeding-max-finalize-format-entries",
			body: marshalJSON(map[string]any{
				"video_id":        validVideoID,
				"player_id":       "a5c2aafe",
				"formats":         manyFormats[:2],
				"adaptiveFormats": manyFormats[2:],
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体流条目数量超出限制",
		},
		{
			name: "missing-itag",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     0,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":      validProg["url"],
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体流条目缺少有效的 itag 或 mimeType",
		},
		{
			name: "empty-mimeType",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": "   ",
						"url":      validProg["url"],
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体流条目缺少有效的 itag 或 mimeType",
		},
		{
			name: "neither-url-nor-signatureCipher",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体流条目必须且只能提供 url 或 signatureCipher 之一",
		},
		{
			name: "both-url-and-signatureCipher",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":            18,
						"mimeType":        `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":             validProg["url"],
						"signatureCipher": "s=ABC&sp=sig&url=" + url.QueryEscape(validProg["url"].(string)),
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体流条目必须且只能提供 url 或 signatureCipher 之一",
		},
		{
			name: "signatureCipher-invalid-escape",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":            18,
						"mimeType":        `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"signatureCipher": "s=%zz&url=https%3A%2F%2Frr1---sn-a.googlevideo.com%2Fvideoplayback",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "signatureCipher 格式无效",
		},
		{
			name: "signatureCipher-missing-s",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":            18,
						"mimeType":        `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"signatureCipher": "sp=sig&url=" + url.QueryEscape(validProg["url"].(string)),
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "signatureCipher 缺少有效的 url 或 s 参数",
		},
		{
			name: "signatureCipher-duplicate-url",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":            18,
						"mimeType":        `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"signatureCipher": "s=ABC&url=" + url.QueryEscape(validProg["url"].(string)) + "&url=" + url.QueryEscape(validProg["url"].(string)),
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "signatureCipher 缺少有效的 url 或 s 参数",
		},
		{
			name: "signatureCipher-disallowed-sp",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":            18,
						"mimeType":        `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"signatureCipher": "s=ABC&sp=lsig&url=" + url.QueryEscape(validProg["url"].(string)),
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "signatureCipher 包含非法的 sp 参数",
		},
		{
			name: "signatureCipher-duplicate-sp",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":            18,
						"mimeType":        `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"signatureCipher": "s=ABC&sp=sig&sp=signature&url=" + url.QueryEscape(validProg["url"].(string)),
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "signatureCipher 包含非法的 sp 参数",
		},
		{
			name: "non-googlevideo-host",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":      "https://evil.example.com/videoplayback?id=" + validVideoID + "&itag=18",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体链接必须为 https://*.googlevideo.com/videoplayback",
		},
		{
			name: "googlevideo-custom-port-or-fragment",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com:8443/videoplayback?id=" + validVideoID + "&itag=18",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体链接必须为 https://*.googlevideo.com/videoplayback",
		},
		{
			name: "googlevideo-encoded-slash-path",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/%76ideoplayback?id=" + validVideoID + "&itag=18",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体链接必须为 https://*.googlevideo.com/videoplayback",
		},
		{
			name: "missing-stream-id-query-param",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?itag=18",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体链接缺少有效的 id 参数",
		},
		{
			name: "duplicate-stream-id-query-param",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + validVideoID + "&id=" + validVideoID + "&itag=18",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体链接缺少有效的 id 参数",
		},
		{
			name: "stream-id-neither-video-id-nor-valid-opaque-o-id",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=dQw4w9WgXcQ&itag=18",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体链接参数 id 与 video_id 不一致",
		},
		{
			name: "cross-stream-id-inconsistent-video-id-vs-o-playback-id",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats":   []any{validProg},
				"adaptiveFormats": []any{
					map[string]any{
						"itag":     140,
						"mimeType": `audio/mp4; codecs="mp4a.40.2"`,
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=o-AOdRLkc6ecTboXRtJhNBILt2v8AQeJUCoLbqEckV1dDI&itag=140",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体链接参数 id 与 video_id 不一致",
		},
		{
			name: "cross-stream-id-inconsistent-two-different-o-playback-ids",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=o-AOdRLkc6ecTboXRtJhNBILt2v8AQeJUCoLbqEckV1dDI&itag=18",
					},
				},
				"adaptiveFormats": []any{
					map[string]any{
						"itag":     140,
						"mimeType": `audio/mp4; codecs="mp4a.40.2"`,
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=o-B99RLkc6ecTboXRtJhNBILt2v8AQeJUCoLbqEckV1dZZ&itag=140",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体链接参数 id 与 video_id 不一致",
		},
		{
			name: "itag-query-mismatch",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + validVideoID + "&itag=22",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体链接参数 itag 与条目不一致",
		},
		{
			name: "empty-n-query-param",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + validVideoID + "&itag=18&n=",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体链接参数 n 无效",
		},
		{
			name: "duplicate-n-query-param",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + validVideoID + "&itag=18&n=a&n=b",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体链接参数 n 无效",
		},
		{
			name: "unsupported-mimeType-without-codecs",
			body: marshalJSON(map[string]any{
				"video_id":  validVideoID,
				"player_id": "a5c2aafe",
				"formats": []any{
					map[string]any{
						"itag":     18,
						"mimeType": "video/mp4",
						"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + validVideoID + "&itag=18",
					},
				},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
			wantMsg:    "媒体流 mimeType 或参数无效",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			saved := currentNow
			currentNow = currentNow.Add(tc.advanceTime)
			defer func() { currentNow = saved }()

			payload, status := helper.Finalize(context.Background(), tc.body, false)
			assertContractRejection(t, payload, status, tc.wantStatus, tc.wantCode, tc.wantMsg)
		})
	}
}

func TestFinalizeGoldenMultiAudioFilterDeduplicatedSolveAndOrderedQueryRewrite(t *testing.T) {
	// Custom player JS that:
	// 1. Throws if any dubbed/descriptive challenge ("POISON_*") reaches Solve (proving
	//    filterMultiAudioStreamEntries runs BEFORE collectFinalizeChallenges).
	// 2. Throws if the same n or s challenge is solved more than once in one Solve invocation
	//    (proving nChallenges and sigChallenges are deduplicated).
	// 3. Throws on "TRIGGER_SOLVE_ERR" to test 502 UPSTREAM_INVALID_RESPONSE error mapping.
	strictPlayerJS := []byte(`var _yt_player={};
(function(g){
  var window=this;
  g.sts={signatureTimestamp:20760};
  function U(u){this.m={};}
  U.prototype.set=function(k,v){this.m[k]=v;};
  U.prototype.get=function(k){return this.m[k];};
  U.prototype.clone=function(){return new U("");};
  U.prototype.apply=function(){
    if(this.m.s){
      var d=decodeURIComponent(this.m.s);
      if(d.indexOf("POISON_")===0||d==="TRIGGER_SOLVE_ERR"){throw new Error("rejected s: "+d);}
      globalThis._seenS=globalThis._seenS||{};
      if(globalThis._seenS[d]){throw new Error("duplicate s: "+d);}
      globalThis._seenS[d]=1;
      this.m.s=encodeURIComponent("SOLVED_SIG_"+d.split("").reverse().join(""));
    }
    if(this.m.n){
      var n=this.m.n;
      if(n.indexOf("POISON_")===0||n==="TRIGGER_SOLVE_ERR"){throw new Error("rejected n: "+n);}
      globalThis._seenN=globalThis._seenN||{};
      if(globalThis._seenN[n]){throw new Error("duplicate n: "+n);}
      globalThis._seenN[n]=1;
      this.m.n="SOLVED_N_"+n;
    }
  };
  var makeUrl=function(raw,k,v){
    var u=new U(raw);
    u.set("alr","yes");
    if(k&&v!==undefined){u.set(k,v);}
    return u;
  };
})(_yt_player);`)

	currentNow := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	helper := newGoldenHelper(t, "a5c2aafe", strictPlayerJS, func() time.Time { return currentNow })

	const (
		videoID  = "R3GfuzLMPkA"
		opaqueID = "o-AOdRLkc6ecTboXRtJhNBILt2v8AQeJUCoLbqEckV1dDI"
	)

	// Sanity check: confirm TRIGGER_SOLVE_ERR surfaces 502 UPSTREAM_INVALID_RESPONSE.
	t.Run("sandbox-solve-failure-maps-to-502-upstream-invalid-response", func(t *testing.T) {
		failBody, _ := json.Marshal(map[string]any{
			"video_id":  videoID,
			"player_id": "a5c2aafe",
			"formats": []any{
				map[string]any{
					"itag":     18,
					"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
					"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=18&n=TRIGGER_SOLVE_ERR",
				},
			},
		})
		payload, status := helper.Finalize(context.Background(), failBody, false)
		assertContractRejection(t, payload, status, http.StatusBadGateway, "UPSTREAM_INVALID_RESPONSE", "YouTube 媒体签名挑战解密失败")
	})

	// Golden test: opaque o-... playback ID across streams, case-insensitive player_id,
	// acont=original vs dubbed-auto + descriptive filtering prior to challenge collection,
	// shared n/s challenge deduplication, sp=signature & sp omitted & sp=sig handling,
	// and exact order-preserving query parameter rewrite.
	t.Run("opaque-id-multi-audio-filter-dedup-solve-and-exact-query-order", func(t *testing.T) {
		progURL := "https://rr2---sn-npoe7n7r.googlevideo.com/videoplayback?expire=1794238131&id=" + opaqueID + "&itag=18&n=SHARED_N_A&sparams=expire,id,itag"
		dash1080URL := "https://rr2---sn-npoe7n7r.googlevideo.com/videoplayback?expire=1794238131&id=" + opaqueID + "&itag=137&n=SHARED_N_A&sparams=expire,id,itag"
		dash720URL := "https://rr2---sn-npoe7n7r.googlevideo.com/videoplayback?expire=1794238131&id=" + opaqueID + "&sig=OLD_SIG&itag=136&n=SHARED_N_B&sparams=expire,id,itag"
		dubbedAudioURL := "https://rr2---sn-npoe7n7r.googlevideo.com/videoplayback?expire=1794238131&id=" + opaqueID + "&itag=140&xtags=acont%3Ddubbed-auto%3Alang%3Den&n=POISON_DUB_N"
		descAudioURL := "https://rr2---sn-npoe7n7r.googlevideo.com/videoplayback?expire=1794238131&id=" + opaqueID + "&itag=140&xtags=acont%3Ddescriptive%3Alang%3Den&n=POISON_DESC_N"
		origM4AURL := "https://rr2---sn-npoe7n7r.googlevideo.com/videoplayback?expire=1794238131&id=" + opaqueID + "&itag=140&xtags=acont%3Doriginal%3Alang%3Dja&n=SHARED_N_A&sparams=expire,id,itag"
		origWebMURL := "https://rr2---sn-npoe7n7r.googlevideo.com/videoplayback?expire=1794238131&id=" + opaqueID + "&itag=251&xtags=acont%3Doriginal%3Alang%3Dja"

		body, err := json.Marshal(map[string]any{
			"video_id":         videoID,
			"player_id":        "  A5C2AAFE  ",
			"title":            "  Golden Finalize Test  ",
			"author":           "  Studio Channel  ",
			"duration_seconds": 42,
			"thumbnail":        "https://i.ytimg.com/vi/" + videoID + "/maxresdefault.jpg",
			"formats": []any{
				map[string]any{
					"itag":            18,
					"mimeType":        `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
					"width":           640,
					"height":          360,
					"fps":             30,
					"bitrate":         500000,
					"contentLength":   "2625000",
					"signatureCipher": "s=SIG_123&sp=sig&url=" + url.QueryEscape(progURL),
				},
			},
			"adaptiveFormats": []any{
				// 1080p DASH video using sp=signature and sharing SHARED_N_A + SIG_123.
				map[string]any{
					"itag":            137,
					"mimeType":        `video/mp4; codecs="avc1.640028"`,
					"width":           1920,
					"height":          1080,
					"fps":             60,
					"bitrate":         4200000,
					"contentLength":   22050000,
					"signatureCipher": "s=SIG_123&sp=signature&url=" + url.QueryEscape(dash1080URL),
				},
				// 720p DASH video omitting sp (defaults to "sig", replacing existing sig=OLD_SIG in-place!).
				map[string]any{
					"itag":            136,
					"mimeType":        `video/mp4; codecs="avc1.4d401f"`,
					"width":           1280,
					"height":          720,
					"fps":             30,
					"bitrate":         1800000,
					"signatureCipher": "s=SIG_720&url=" + url.QueryEscape(dash720URL),
				},
				// Auto-dubbed track (higher bitrate + audioIsDefault=true) carrying POISON challenges.
				map[string]any{
					"itag":            140,
					"mimeType":        `audio/mp4; codecs="mp4a.40.2"`,
					"bitrate":         192000,
					"signatureCipher": "s=POISON_DUB_S&sp=sig&url=" + url.QueryEscape(dubbedAudioURL),
					"audioTrack": map[string]any{
						"id":             "en.3",
						"displayName":    "English (auto-dubbed)",
						"audioIsDefault": true,
					},
				},
				// Descriptive track carrying POISON challenges.
				map[string]any{
					"itag":     140,
					"mimeType": `audio/mp4; codecs="mp4a.40.2"`,
					"bitrate":  192000,
					"url":      descAudioURL,
					"audioTrack": map[string]any{
						"id":             "en.desc",
						"displayName":    "English descriptive",
						"audioIsDefault": true,
					},
				},
				// Original Japanese M4A track sharing SHARED_N_A + SIG_123.
				map[string]any{
					"itag":            140,
					"mimeType":        `audio/mp4; codecs="mp4a.40.2"`,
					"bitrate":         128000,
					"audioSampleRate": 44100,
					"audioChannels":   2,
					"signatureCipher": "s=SIG_123&sp=sig&url=" + url.QueryEscape(origM4AURL),
					"audioTrack": map[string]any{
						"id":             "ja.4",
						"displayName":    "Japanese original",
						"audioIsDefault": false,
					},
				},
				// Original Japanese WebM track with direct URL and no n/s challenges.
				map[string]any{
					"itag":     251,
					"mimeType": `audio/webm; codecs="opus"`,
					"bitrate":  160000,
					"url":      origWebMURL,
					"audioTrack": map[string]any{
						"id":             "ja.4",
						"displayName":    "Japanese original",
						"audioIsDefault": false,
					},
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}

		for _, debug := range []bool{false, true} {
			payload, status := helper.Finalize(context.Background(), body, debug)
			if status != http.StatusOK {
				t.Fatalf("debug=%v: Finalize status=%d payload=%#v", debug, status, payload)
			}
			if err := unified.ValidateEnvelopeAt(payload, currentNow.Unix()); err != nil {
				t.Fatalf("debug=%v: ValidateEnvelopeAt failed: %v", debug, err)
			}

			data := unified.Map(payload["data"])
			if unified.Str(data["platform"]) != "youtube" ||
				unified.Str(data["content_id"]) != videoID ||
				unified.Str(data["source_url"]) != "https://www.youtube.com/watch?v="+videoID ||
				unified.Str(data["title"]) != "Golden Finalize Test" {
				t.Fatalf("debug=%v: unexpected top-level data: %#v", debug, data)
			}
			if unified.Str(unified.Map(data["author"])["name"]) != "Studio Channel" {
				t.Fatalf("debug=%v: unexpected author: %#v", debug, data["author"])
			}
			if unified.Str(unified.Map(data["cover"])["url"]) != "https://i.ytimg.com/vi/"+videoID+"/maxresdefault.jpg" {
				t.Fatalf("debug=%v: unexpected cover: %#v", debug, data["cover"])
			}

			items := unified.Slice(data["items"])
			if len(items) != 1 {
				t.Fatalf("debug=%v: items len=%d, want 1", debug, len(items))
			}
			item := unified.Map(items[0])
			if dur, ok := unified.Numeric(item["duration_ms"]); !ok || int64(dur) != 42000 {
				t.Fatalf("debug=%v: duration_ms=%v, want 42000", debug, item["duration_ms"])
			}

			byID := make(map[string]unified.Object)
			for _, rawV := range unified.Slice(item["variants"]) {
				v := unified.Map(rawV)
				byID[unified.Str(v["id"])] = v
			}

			// 1080p DASH variant: n replaced in-place at index 3, signature appended at end, sparams commas preserved!
			id1080 := "v-" + goldenShortDigest("youtube:dashv-file:videoplayback:137")
			v1080, ok := byID[id1080]
			if !ok {
				t.Fatalf("debug=%v: missing 1080p variant %s in %#v", debug, id1080, byID)
			}
			u1080, err := url.Parse(unified.Str(unified.Map(unified.Slice(unified.Map(v1080["delivery"])["sources"])[0])["url"]))
			if err != nil {
				t.Fatal(err)
			}
			wantRawQuery1080 := "expire=1794238131&id=" + opaqueID + "&itag=137&n=SOLVED_N_SHARED_N_A&sparams=expire,id,itag&signature=SOLVED_SIG_321_GIS"
			if u1080.RawQuery != wantRawQuery1080 {
				t.Fatalf("debug=%v: 1080p RawQuery = %q, want exact %q", debug, u1080.RawQuery, wantRawQuery1080)
			}

			// 720p DASH variant: existing sig=OLD_SIG replaced in-place at index 2, n replaced in-place at index 4!
			id720 := "v-" + goldenShortDigest("youtube:dashv-file:videoplayback:136")
			v720, ok := byID[id720]
			if !ok {
				t.Fatalf("debug=%v: missing 720p variant %s", debug, id720)
			}
			u720, err := url.Parse(unified.Str(unified.Map(unified.Slice(unified.Map(v720["delivery"])["sources"])[0])["url"]))
			if err != nil {
				t.Fatal(err)
			}
			wantRawQuery720 := "expire=1794238131&id=" + opaqueID + "&sig=SOLVED_SIG_027_GIS&itag=136&n=SOLVED_N_SHARED_N_B&sparams=expire,id,itag"
			if u720.RawQuery != wantRawQuery720 {
				t.Fatalf("debug=%v: 720p RawQuery = %q, want exact %q", debug, u720.RawQuery, wantRawQuery720)
			}

			// Original Japanese M4A won over dubbed/descriptive; since dubbed/descriptive were filtered BEFORE
			// format conversion, original itag=140 has formatID "140" (NOT "140-dup3")!
			idM4A := "v-" + goldenShortDigest("youtube:dasha-file:videoplayback:140")
			vM4A, ok := byID[idM4A]
			if !ok {
				t.Fatalf("debug=%v: expected filtered original M4A to receive formatID 140 (%s), got keys=%v", debug, idM4A, byID)
			}
			uM4A, err := url.Parse(unified.Str(unified.Map(unified.Slice(unified.Map(vM4A["delivery"])["sources"])[0])["url"]))
			if err != nil {
				t.Fatal(err)
			}
			wantRawQueryM4A := "expire=1794238131&id=" + opaqueID + "&itag=140&xtags=acont%3Doriginal%3Alang%3Dja&n=SOLVED_N_SHARED_N_A&sparams=expire,id,itag&sig=SOLVED_SIG_321_GIS"
			if uM4A.RawQuery != wantRawQueryM4A {
				t.Fatalf("debug=%v: M4A RawQuery = %q, want exact %q", debug, uM4A.RawQuery, wantRawQueryM4A)
			}
		}
	})
}

func TestFinalizeGoldenDuplicateItagDupNNumberingAndMaxBoundary(t *testing.T) {
	currentNow := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	helper := newGoldenHelper(t, "a5c2aafe", nil, func() time.Time { return currentNow })
	const videoID = "dQw4w9WgXcQ"

	// 1. Duplicate itags that survive filtering receive "137", "137-dup2", "137-dup3" and "140", "140-dup2".
	body, err := json.Marshal(map[string]any{
		"video_id":  videoID,
		"player_id": "a5c2aafe",
		"formats": []any{
			map[string]any{
				"itag":     18,
				"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
				"width":    640,
				"height":   360,
				"fps":      30,
				"bitrate":  400000,
				"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=18&n=N18",
			},
		},
		"adaptiveFormats": []any{
			// Three entries sharing itag=137 across distinct resolutions so all 3 survive DASH deduplication.
			map[string]any{
				"itag":     137,
				"mimeType": `video/mp4; codecs="avc1.64001f"`,
				"width":    1280,
				"height":   720,
				"fps":      30,
				"bitrate":  1500000,
				"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=137&tier=720",
			},
			map[string]any{
				"itag":     137,
				"mimeType": `video/mp4; codecs="avc1.640028"`,
				"width":    1920,
				"height":   1080,
				"fps":      30,
				"bitrate":  3000000,
				"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=137&tier=1080",
			},
			map[string]any{
				"itag":     137,
				"mimeType": `video/mp4; codecs="avc1.640033"`,
				"width":    2560,
				"height":   1440,
				"fps":      30,
				"bitrate":  6000000,
				"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=137&tier=1440",
			},
			// Two audio entries without audioTrack/xtags sharing itag=140; second has higher bitrate -> wins as "140-dup2".
			map[string]any{
				"itag":     140,
				"mimeType": `audio/mp4; codecs="mp4a.40.2"`,
				"bitrate":  64000,
				"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=140&abr=64",
			},
			map[string]any{
				"itag":     140,
				"mimeType": `audio/mp4; codecs="mp4a.40.2"`,
				"bitrate":  160000,
				"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=140&abr=160",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	payload, status := helper.Finalize(context.Background(), body, false)
	if status != http.StatusOK {
		t.Fatalf("status=%d payload=%#v", status, payload)
	}
	if err := unified.ValidateEnvelopeAt(payload, currentNow.Unix()); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}

	item := unified.Map(unified.Slice(unified.Map(payload["data"])["items"])[0])
	variantIDs := make(map[string]string)
	for _, rawV := range unified.Slice(item["variants"]) {
		v := unified.Map(rawV)
		srcURL := unified.Str(unified.Map(unified.Slice(unified.Map(v["delivery"])["sources"])[0])["url"])
		variantIDs[unified.Str(v["id"])] = srcURL
	}

	wantDupIDs := map[string]string{
		"v-" + goldenShortDigest("youtube:dashv-file:videoplayback:137"):      "tier=720",
		"v-" + goldenShortDigest("youtube:dashv-file:videoplayback:137-dup2"): "tier=1080",
		"v-" + goldenShortDigest("youtube:dashv-file:videoplayback:137-dup3"): "tier=1440",
		"v-" + goldenShortDigest("youtube:dasha-file:videoplayback:140-dup2"): "abr=160",
	}
	for wantID, wantSubstr := range wantDupIDs {
		gotURL, ok := variantIDs[wantID]
		if !ok {
			t.Fatalf("missing expected variant id %s (for %s); got variants=%v", wantID, wantSubstr, variantIDs)
		}
		if !strings.Contains(gotURL, wantSubstr) {
			t.Fatalf("variant %s URL = %q, want substring %q", wantID, gotURL, wantSubstr)
		}
	}

	// 2. Exact MaxFinalizeFormatEntries (256) entries accepted and validated.
	exactEntries := make([]any, MaxFinalizeFormatEntries)
	for i := range exactEntries {
		exactEntries[i] = map[string]any{
			"itag":     18,
			"mimeType": `video/mp4; codecs="avc1.42001E, mp4a.40.2"`,
			"width":    640,
			"height":   360,
			"url":      "https://rr1---sn-npoe7n7r.googlevideo.com/videoplayback?id=" + videoID + "&itag=18&idx=" + strconv.Itoa(i),
		}
	}
	exactBody, err := json.Marshal(map[string]any{
		"video_id":        videoID,
		"player_id":       "a5c2aafe",
		"formats":         exactEntries[:4],
		"adaptiveFormats": exactEntries[4:],
	})
	if err != nil {
		t.Fatal(err)
	}
	exactPayload, exactStatus := helper.Finalize(context.Background(), exactBody, false)
	if exactStatus != http.StatusOK {
		t.Fatalf("expected 256 entries to succeed, got %d (%#v)", exactStatus, exactPayload)
	}
	if err := unified.ValidateEnvelopeAt(exactPayload, currentNow.Unix()); err != nil {
		t.Fatalf("ValidateEnvelopeAt(256 entries) failed: %v", err)
	}
}
