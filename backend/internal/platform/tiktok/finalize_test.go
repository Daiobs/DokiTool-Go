package tiktok

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func extractFixtureVideoDetailRaw(t *testing.T, fixtureName string) json.RawMessage {
	t.Helper()
	html := readFixture(t, fixtureName)
	raw, ok := extractHydrationScriptJSON(html)
	if !ok {
		t.Fatalf("fixture %s missing hydration script", fixtureName)
	}
	var env hydrationEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("fixture %s unmarshal envelope: %v", fixtureName, err)
	}
	detail, ok := env.DefaultScope["webapp.video-detail"]
	if !ok {
		t.Fatalf("fixture %s missing webapp.video-detail", fixtureName)
	}
	return detail
}

func TestFinalizeVideoAndPhotoZeroOutboundAndParity(t *testing.T) {
	now := int64(1795700000)
	expUnix := now + 21600
	expHex := fmt.Sprintf("%08x", expUnix)

	var networkHits atomic.Int32
	failExec := &stubExecutor{
		fn: func(context.Context, fetch.Request, fetch.Policy) (fetch.Response, error) {
			networkHits.Add(1)
			return fetch.Response{}, fmt.Errorf("Finalize must make zero outbound network calls")
		},
	}
	p := New(failExec).WithClock(func() time.Time { return time.Unix(now, 0) })

	t.Run("VideoModeZeroOutbound", func(t *testing.T) {
		detailRaw := extractFixtureVideoDetailRaw(t, "video_post.html")
		reqBody, err := json.Marshal(map[string]any{
			"source_url":   "https://m.tiktok.com/v/7345678901234567890.html?foo=1",
			"video_detail": detailRaw,
			"resolved_tiers": []map[string]string{
				{
					"play_url":   "https://www.tiktok.com/aweme/v1/play/?video_id=tier_1080_hevc",
					"direct_url": fmt.Sprintf("https://v16m-default.tiktokcdn-us.com/0123456789abcdef0123456789abcdef/%s/video/tos/useast5/1080.mp4", expHex),
				},
				{
					"play_url":   "https://www.tiktok.com/aweme/v1/play/?video_id=tier_720_hevc",
					"direct_url": fmt.Sprintf("https://v16-web-newkey.tiktokcdn.com/fedcba9876543210fedcba9876543210/%s/video/tos/useast2a/720.mp4", expHex),
				},
				{
					"play_url":   "https://www.tiktok.com/aweme/v1/play/?video_id=tier_540_h264",
					"direct_url": fmt.Sprintf("https://v19-web-newkey.tiktokcdn-eu.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/%s/video/tos/no1a/540.mp4", expHex),
				},
				{
					"play_url":   "https://www.tiktok.com/aweme/v1/play/?video_id=tier_360_low",
					"direct_url": fmt.Sprintf("https://v16-cold.tiktokv.com/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/%s/video/tos/alisg/360.mp4", expHex),
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}

		payload, status := p.Finalize(context.Background(), reqBody, false)
		if status != http.StatusOK || unified.Str(payload["code"]) != "OK" {
			t.Fatalf("status=%d payload=%+v", status, payload)
		}
		if err := unified.ValidateEnvelopeAt(payload, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		if networkHits.Load() != 0 {
			t.Fatalf("expected 0 outbound calls, got %d", networkHits.Load())
		}

		data := unified.Map(payload["data"])
		if unified.Str(data["platform"]) != "tiktok" || unified.Str(data["content_id"]) != "7345678901234567890" {
			t.Fatalf("unexpected platform/content_id: %+v", data)
		}
		if unified.Str(data["source_url"]) != "https://www.tiktok.com/@i/video/7345678901234567890" {
			t.Fatalf("unexpected canonical source_url: %q", data["source_url"])
		}
		items := unified.Slice(data["items"])
		if len(items) != 1 {
			t.Fatalf("items len=%d, want 1", len(items))
		}
		variants := unified.Slice(unified.Map(items[0])["variants"])
		if len(variants) != 4 {
			t.Fatalf("variants len=%d, want 4", len(variants))
		}
		wantExp := time.Unix(expUnix, 0).UTC().Format(time.RFC3339)
		for i, rv := range variants {
			src := unified.Map(unified.Slice(unified.Map(unified.Map(rv)["delivery"])["sources"])[0])
			if unified.Str(src["browser_fetch"]) != "blocked" || unified.Str(src["access"]) != "direct" {
				t.Errorf("variant[%d] access/browser_fetch = (%q,%q), want (direct,blocked)", i, src["access"], src["browser_fetch"])
			}
			if unified.Str(src["expires_at"]) != wantExp {
				t.Errorf("variant[%d] expires_at = %q, want %q", i, src["expires_at"], wantExp)
			}
		}

		// Client finalize must not spoof server-side direct/proxy TikTokRiskStats counters.
		st := p.TikTokRiskStatsSnapshot()
		if st.HydrationOK != 0 || st.Play302OK != 0 || st.WAFBlocked != 0 || st.ContentNotFound != 0 {
			t.Fatalf("Finalize must not mutate server-side TikTokRiskStats, got %+v", st)
		}
	})

	t.Run("PhotoModeZeroResolvedTiers", func(t *testing.T) {
		detailRaw := extractFixtureVideoDetailRaw(t, "photo_post.html")
		reqBody, err := json.Marshal(map[string]any{
			"source_url":     "https://www.tiktok.com/@photo_artist/photo/7399999999999999999",
			"video_detail":   detailRaw,
			"resolved_tiers": []any{},
		})
		if err != nil {
			t.Fatal(err)
		}
		payload, status := FinalizePayload(context.Background(), reqBody, 1791001000, false)
		if status != http.StatusOK || unified.Str(payload["code"]) != "OK" {
			t.Fatalf("status=%d payload=%+v", status, payload)
		}
		if err := unified.ValidateEnvelopeAt(payload, 1791001000); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		data := unified.Map(payload["data"])
		items := unified.Slice(data["items"])
		if len(items) != 2 {
			t.Fatalf("items len=%d, want 2", len(items))
		}
		for i, ri := range items {
			v := unified.Map(unified.Slice(unified.Map(ri)["variants"])[0])
			src := unified.Map(unified.Slice(unified.Map(v["delivery"])["sources"])[0])
			if unified.Str(src["browser_fetch"]) != "allowed" {
				t.Errorf("photo item[%d] browser_fetch=%q, want allowed", i, src["browser_fetch"])
			}
			if strings.Contains(unified.Str(src["url"]), ".heic") {
				t.Errorf("photo item[%d] unexpectedly picked HEIC: %s", i, src["url"])
			}
		}
		groups := unified.Slice(data["groups"])
		if len(groups) != 1 || unified.Str(unified.Map(groups[0])["kind"]) != "album" {
			t.Fatalf("expected album group, got %+v", groups)
		}
	})
}

func TestFinalizeUntrustedInputSecurityAndErrors(t *testing.T) {
	now := int64(1795700000)
	videoDetail := extractFixtureVideoDetailRaw(t, "video_post.html")
	photoDetail := extractFixtureVideoDetailRaw(t, "photo_post.html")
	validTier := map[string]string{
		"play_url":   "https://www.tiktok.com/aweme/v1/play/?video_id=tier_1080_hevc",
		"direct_url": "https://v16m-default.tiktokcdn-us.com/0123456789abcdef0123456789abcdef/6b09f2e5/video/tos/useast5/1080.mp4",
	}

	mustMarshal := func(v any) []byte {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	cases := []struct {
		name       string
		body       []byte
		wantStatus int
		wantCode   string
	}{
		{
			name:       "EmptyBody",
			body:       nil,
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name:       "OversizedBody",
			body:       make([]byte, MaxFinalizeBodyBytes+1),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name:       "UnknownTopLevelField",
			body:       mustMarshal(map[string]any{"source_url": "https://www.tiktok.com/@i/video/7345678901234567890", "video_detail": videoDetail, "resolved_tiers": []any{validTier}, "extra": 1}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name:       "TrailingJSON",
			body:       append(mustMarshal(map[string]any{"source_url": "https://www.tiktok.com/@i/video/7345678901234567890", "video_detail": videoDetail, "resolved_tiers": []any{validTier}}), []byte(" {}")...),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name:       "ShortlinkSourceURLRejected",
			body:       mustMarshal(map[string]any{"source_url": "https://vm.tiktok.com/ZM8abc123/", "video_detail": videoDetail, "resolved_tiers": []any{validTier}}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name:       "ProfileSourceURLRejected",
			body:       mustMarshal(map[string]any{"source_url": "https://www.tiktok.com/@creator_demo", "video_detail": videoDetail, "resolved_tiers": []any{validTier}}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name:       "ItemIDMismatchRejected",
			body:       mustMarshal(map[string]any{"source_url": "https://www.tiktok.com/@i/video/9999999999999999999", "video_detail": videoDetail, "resolved_tiers": []any{validTier}}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name: "WebappPrimeDirectURLRejected",
			body: mustMarshal(map[string]any{
				"source_url":   "https://www.tiktok.com/@i/video/7345678901234567890",
				"video_detail": videoDetail,
				"resolved_tiers": []map[string]string{{
					"play_url":   "https://www.tiktok.com/aweme/v1/play/?video_id=tier_1080_hevc",
					"direct_url": "https://v16-webapp-prime.tiktok.com/video/tos/a.mp4",
				}},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name: "ChainTokenDirectURLRejected",
			body: mustMarshal(map[string]any{
				"source_url":   "https://www.tiktok.com/@i/video/7345678901234567890",
				"video_detail": videoDetail,
				"resolved_tiers": []map[string]string{{
					"play_url":   "https://www.tiktok.com/aweme/v1/play/?video_id=tier_1080_hevc",
					"direct_url": "https://v16-web-newkey.tiktokcdn.com/video/tos/a.mp4?tk=tt_chain_token",
				}},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name: "PrivateIPDirectURLRejected",
			body: mustMarshal(map[string]any{
				"source_url":   "https://www.tiktok.com/@i/video/7345678901234567890",
				"video_detail": videoDetail,
				"resolved_tiers": []map[string]string{{
					"play_url":   "https://www.tiktok.com/aweme/v1/play/?video_id=tier_1080_hevc",
					"direct_url": "https://127.0.0.1/video/tos/a.mp4",
				}},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name: "ForeignPlayURLRejected",
			body: mustMarshal(map[string]any{
				"source_url":   "https://www.tiktok.com/@i/video/7345678901234567890",
				"video_detail": videoDetail,
				"resolved_tiers": []map[string]string{{
					"play_url":   "https://evil.example/aweme/v1/play/?video_id=tier_1080_hevc",
					"direct_url": validTier["direct_url"],
				}},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name: "UnrelatedPlayURLNotInCandidatesRejected",
			body: mustMarshal(map[string]any{
				"source_url":   "https://www.tiktok.com/@i/video/7345678901234567890",
				"video_detail": videoDetail,
				"resolved_tiers": []map[string]string{{
					"play_url":   "https://www.tiktok.com/aweme/v1/play/?video_id=other_video_id",
					"direct_url": validTier["direct_url"],
				}},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name: "FilteredVVCPlayURLRejected",
			body: mustMarshal(map[string]any{
				"source_url":   "https://www.tiktok.com/@i/video/7345678901234567890",
				"video_detail": videoDetail,
				"resolved_tiers": []map[string]string{{
					"play_url":   "https://www.tiktok.com/aweme/v1/play/?video_id=vvc_skip",
					"direct_url": validTier["direct_url"],
				}},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name: "DuplicatePlayURLRejected",
			body: mustMarshal(map[string]any{
				"source_url":     "https://www.tiktok.com/@i/video/7345678901234567890",
				"video_detail":   videoDetail,
				"resolved_tiers": []map[string]string{validTier, validTier},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name:       "VideoModeMissingResolvedTiers",
			body:       mustMarshal(map[string]any{"source_url": "https://www.tiktok.com/@i/video/7345678901234567890", "video_detail": videoDetail, "resolved_tiers": []any{}}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name:       "PhotoModeRejectsNonEmptyResolvedTiers",
			body:       mustMarshal(map[string]any{"source_url": "https://www.tiktok.com/@photo_artist/photo/7399999999999999999", "video_detail": photoDetail, "resolved_tiers": []any{validTier}}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name: "UnavailableStatus10204",
			body: mustMarshal(map[string]any{
				"source_url":     "https://www.tiktok.com/@i/video/7345678901234567890",
				"video_detail":   map[string]any{"statusCode": 10204, "statusMsg": "item doesn't exist"},
				"resolved_tiers": []any{},
			}),
			wantStatus: http.StatusNotFound,
			wantCode:   "CONTENT_UNAVAILABLE",
		},
		{
			name: "NonZeroUpstreamStatus",
			body: mustMarshal(map[string]any{
				"source_url":     "https://www.tiktok.com/@i/video/7345678901234567890",
				"video_detail":   map[string]any{"statusCode": 10223, "statusMsg": "temporary"},
				"resolved_tiers": []any{},
			}),
			wantStatus: http.StatusBadGateway,
			wantCode:   "UPSTREAM_UNAVAILABLE",
		},
		{
			name: "MissingItemStruct",
			body: mustMarshal(map[string]any{
				"source_url":     "https://www.tiktok.com/@i/video/7345678901234567890",
				"video_detail":   map[string]any{"statusCode": 0},
				"resolved_tiers": []any{},
			}),
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_INPUT",
		},
		{
			name: "NoMediaPhotoWithOnlyForeignImages",
			body: mustMarshal(map[string]any{
				"source_url": "https://www.tiktok.com/@i/photo/7399999999999999999",
				"video_detail": map[string]any{
					"statusCode": 0,
					"itemInfo": map[string]any{
						"itemStruct": map[string]any{
							"id": "7399999999999999999",
							"imagePost": map[string]any{
								"images": []map[string]any{{
									"imageURL": map[string]any{"urlList": []string{"https://evil.example/a.jpg"}},
								}},
							},
						},
					},
				},
				"resolved_tiers": []any{},
			}),
			wantStatus: http.StatusNotFound,
			wantCode:   "NO_MEDIA",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload, status := FinalizePayload(context.Background(), tc.body, now, false)
			if status != tc.wantStatus || unified.Str(payload["code"]) != tc.wantCode {
				t.Fatalf("got (status=%d, code=%q), want (status=%d, code=%q); payload=%+v",
					status, unified.Str(payload["code"]), tc.wantStatus, tc.wantCode, payload)
			}
		})
	}

	t.Run("SanitizesControlCharsAndImplausibleCreateTime", func(t *testing.T) {
		body := mustMarshal(map[string]any{
			"source_url": "https://www.tiktok.com/@i/photo/7399999999999999999",
			"video_detail": map[string]any{
				"statusCode": 0,
				"itemInfo": map[string]any{
					"itemStruct": map[string]any{
						"id":         "7399999999999999999",
						"desc":       "Hello\x00\u202e\nWorld",
						"createTime": 9999999999999,
						"author": map[string]any{
							"id":       "123\x07",
							"uniqueId": "bad/handle?x=1",
							"nickname": "Nick\x00Name",
						},
						"imagePost": map[string]any{
							"images": []map[string]any{{
								"imageWidth":  1080,
								"imageHeight": 1440,
								"imageURL": map[string]any{
									"urlList": []string{"https://p16-common-sign.tiktokcdn-us.com/tos-useast5/img.jpeg?x-expires=1800000000"},
								},
							}},
						},
					},
				},
			},
			"resolved_tiers": []any{},
		})
		payload, status := FinalizePayload(context.Background(), body, now, false)
		if status != http.StatusOK || unified.Str(payload["code"]) != "OK" {
			t.Fatalf("status=%d payload=%+v", status, payload)
		}
		data := unified.Map(payload["data"])
		if got := unified.Str(data["title"]); got != "Hello World" {
			t.Errorf("sanitized title = %q, want %q", got, "Hello World")
		}
		if _, hasPub := data["published_at"]; hasPub {
			t.Errorf("implausible createTime should omit published_at, got %v", data["published_at"])
		}
		author := unified.Map(data["author"])
		if got := unified.Str(author["name"]); got != "NickName" {
			t.Errorf("sanitized author.name = %q, want %q", got, "NickName")
		}
		if author["url"] != nil {
			t.Errorf("unsafe uniqueId should omit author.url, got %v", author["url"])
		}
	})

	t.Run("P1_RejectsChainTokenBypassAndNonAsciiOrInvalidDnsCdnUrls", func(t *testing.T) {
		badDirectURLs := []string{
			"https://v16-web-newkey.tiktokcdn.com/video/tos/a.mp4?a=1;b=2&tk=tt_chain_token",
			"https://v16-web-newkey.tiktokcdn.com/video/tos/a.mp4?bad=%ZZ&tk=tt_chain_token",
			"https://v16-web-newkey.tiktokcdn.com/video/tos/a.mp4?TK=tt_chain_token",
			"https://v16-web-newkey.tiktokcdn.com/video/tos/a.mp4?tk=TT_CHAIN_TOKEN",
			"https://..tiktokcdn.com/video/tos/a.mp4",
			"https://_bad.tiktokcdn.com/video/tos/a.mp4",
			"https://v16-web-newkey.tiktokcdn.com/video/tos/café.mp4",
		}
		for _, badURL := range badDirectURLs {
			if AllowedMediaURL(badURL) {
				t.Errorf("AllowedMediaURL(%q) = true, want false", badURL)
			}
			body := mustMarshal(map[string]any{
				"source_url":   "https://www.tiktok.com/@i/video/7345678901234567890",
				"video_detail": videoDetail,
				"resolved_tiers": []map[string]string{{
					"play_url":   "https://www.tiktok.com/aweme/v1/play/?video_id=tier_1080_hevc",
					"direct_url": badURL,
				}},
			})
			payload, status := FinalizePayload(context.Background(), body, now, false)
			if status != http.StatusBadRequest || unified.Str(payload["code"]) != "INVALID_INPUT" {
				t.Errorf("direct_url=%q: got (status=%d, code=%q), want (400, INVALID_INPUT)",
					badURL, status, unified.Str(payload["code"]))
			}
		}
	})

	t.Run("P1_NonAsciiOrNbspAuthorUniqueIdAndMalformedOptionalAssetNever502", func(t *testing.T) {
		for _, uid := range []string{"用户_1", "café_creator", "nbsp\u00a0user"} {
			body := mustMarshal(map[string]any{
				"source_url": "https://www.tiktok.com/@i/photo/7399999999999999999",
				"video_detail": map[string]any{
					"statusCode": 0,
					"itemInfo": map[string]any{
						"itemStruct": map[string]any{
							"id":   "7399999999999999999",
							"desc": "Unicode handle safety",
							"author": map[string]any{
								"id":           "6900000000000000002",
								"uniqueId":     uid,
								"nickname":     "Creator",
								"avatarLarger": "https://_bad.tiktokcdn.com/avatar.jpeg",
							},
							"imagePost": map[string]any{
								"images": []map[string]any{{
									"imageWidth":  1080,
									"imageHeight": 1440,
									"imageURL": map[string]any{
										"urlList": []string{
											"https://v16.tiktokcdn.com/tos/café.jpeg",
											"https://p16-common-sign.tiktokcdn-us.com/tos-useast5/img.jpeg?x-expires=1800000000",
										},
									},
								}},
							},
						},
					},
				},
				"resolved_tiers": []any{},
			})
			payload, status := FinalizePayload(context.Background(), body, now, false)
			if status != http.StatusOK || unified.Str(payload["code"]) != "OK" {
				t.Fatalf("uniqueId=%q: got (status=%d, code=%q), want (200, OK); payload=%+v",
					uid, status, unified.Str(payload["code"]), payload)
			}
			author := unified.Map(unified.Map(payload["data"])["author"])
			if author["url"] != nil {
				t.Errorf("non-ASCII/NBSP uniqueId=%q should omit author.url, got %v", uid, author["url"])
			}
			if author["avatar"] != nil {
				t.Errorf("malformed _bad.tiktokcdn.com avatar should be skipped, got %v", author["avatar"])
			}
		}
	})
}
