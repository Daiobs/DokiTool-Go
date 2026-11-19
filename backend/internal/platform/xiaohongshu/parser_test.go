package xiaohongshu

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type requestFunc func(context.Context, fetch.Request) (fetch.Response, error)

func (f requestFunc) Do(ctx context.Context, request fetch.Request) (fetch.Response, error) {
	return f(ctx, request)
}

const controlledNote = `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc123":{"note":{"noteId":"abc123","type":"video","title":"Synthetic note","video":{"media":{"stream":{"h264":[{"masterUrl":"https://sns-video-qn.xhscdn.com/synthetic/720.mp4","width":1280,"height":720}]}},"consumer":{"originVideoKey":"synthetic/original"}}}}}}};</script>`

func TestXiaohongshuCancellationStopsPageAndProbeFallbacks(t *testing.T) {
	for _, phase := range []string{"before", "page", "probe"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			executor := requestFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
				calls++
				if phase == "page" || request.Policy.Purpose == "media-probe" {
					cancel()
					return fetch.Response{}, ctx.Err()
				}
				return fetch.Response{StatusCode: 200, URL: request.URL, Body: []byte(controlledNote)}, nil
			})
			if phase == "before" {
				cancel()
			}
			_, err := New(executor).Parse(ctx, "https://www.xiaohongshu.com/explore/abc123", 1793361600)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("caller cancellation was masked: %v", err)
			}
			if want := map[string]int{"before": 0, "page": 1, "probe": 2}[phase]; calls != want {
				t.Fatalf("fallback continued after cancellation: %d requests, want %d", calls, want)
			}
		})
	}
}

func TestXiaohongshuOptionalProbeFailurePreservesVerifiedStreams(t *testing.T) {
	pages, probes := 0, 0
	executor := requestFunc(func(_ context.Context, request fetch.Request) (fetch.Response, error) {
		if request.Policy.Purpose == "media-probe" {
			probes++
			return fetch.Response{}, context.DeadlineExceeded
		}
		pages++
		return fetch.Response{StatusCode: http.StatusOK, URL: request.URL, Body: []byte(controlledNote)}, nil
	})
	legacy, err := NewWithClock(executor, func() time.Time { return time.Unix(100, 0) }).parseLegacy(context.Background(), "https://www.xiaohongshu.com/explore/abc123")
	if err != nil || legacy["code"] != 200 || pages != 1 || probes != 4 {
		t.Fatalf("optional enhancement replaced a usable page: pages=%d probes=%d legacy=%v err=%v", pages, probes, legacy, err)
	}
	candidates := unified.Slice(unified.Map(legacy["data"])["video_candidates"])
	if len(candidates) != 2 || unified.Map(candidates[0])["width"] != int64(1280) || unified.Map(candidates[0])["height"] != int64(720) {
		t.Fatal("upstream representation was lost after optional probe failure")
	}
	original := unified.Map(candidates[1])
	if original["width"] != nil || original["height"] != nil || len(unified.Slice(original["sources"])) != 4 {
		t.Fatal("unmeasured original inferred dimensions or lost its source candidates")
	}
}

func TestXiaohongshuPageRejectsUnapprovedRedirectWithoutFetchingIt(t *testing.T) {
	calls := 0
	executor := requestFunc(func(_ context.Context, request fetch.Request) (fetch.Response, error) {
		calls++
		if !strings.Contains(request.URL, "xiaohongshu.com") && !strings.Contains(request.URL, "rednote.com") {
			t.Fatal("foreign redirect reached transport")
		}
		return fetch.Response{StatusCode: 302, URL: request.URL, Header: http.Header{"Location": {"https://unapproved.example/private"}}}, nil
	})
	payload, err := New(executor).Parse(context.Background(), "https://www.xiaohongshu.com/explore/abc123", 1793361600)
	if err != nil || payload["code"] != "UPSTREAM_INVALID_RESPONSE" || calls != 2 {
		t.Fatalf("unexpected redirect result: %v %v calls=%d", payload, err, calls)
	}
}

func TestXiaohongshuMalformedConcatenatedImageCannotRecurse(t *testing.T) {
	if got := processImageURL("3https://sns-img-hw.xhscdn.com/example.jpg"); got != "" {
		t.Fatalf("malformed concatenated URL was retained: %q", got)
	}
}

// Rednote can explicitly return url:"" alongside usable rendition URLs.
// Keep those endpoints and their query bytes in image-list order, including
// the still half of a Live Photo; do not infer motion from image count.
func TestEmptyImageURLRetainsDeclaredRenditions(t *testing.T) {
	const first = "https://cdn.example/notes_pre_post/one!original?sig=a%2Bb&k=x+y"
	const second = "https://cdn.example/notes_pre_post/two!preview?sig=z"
	const motion = "https://media.example/motion.mp4"
	for _, live := range []bool{false, true} {
		stream := ""
		if live {
			stream = `,"stream":{"h264":[{"masterUrl":"` + motion + `"}]}`
		}
		html := `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"sample":{"note":{"noteId":"sample","type":"normal","imageList":[` +
			`{"url":"","urlDefault":"http://cdn.example/notes_pre_post/one!original?sig=a%2Bb&k=x+y","urlPre":"` + second + `"` + stream + `},` +
			`{"url":"","urlDefault":"","urlPre":"` + second + `"}]}}}}};</script>`
		executor := requestFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(html)}, nil
		})
		work, err := New(executor).Parse(context.Background(), "https://www.xiaohongshu.com/explore/sample", 1793361600)
		if err != nil || work["code"] != "OK" {
			t.Fatalf("live=%t: expected media, got %v (%v)", live, work["code"], err)
		}
		data := unified.Map(work["data"])
		items := unified.Slice(data["items"])
		if len(items) != 2 || unified.Map(data["cover"])["url"] != first {
			t.Fatalf("live=%t: wrong cover or number of images", live)
		}
		for n, want := range []string{first, second} {
			item := unified.Map(items[n])
			variant := unified.Map(unified.Slice(item["variants"])[0])
			delivery := unified.Map(variant["delivery"])
			if live && n == 0 {
				if item["type"] != "live_photo" || delivery["kind"] != "pair" {
					t.Fatal("missing Live Photo pair")
				}
				resources := unified.Slice(delivery["resources"])
				if len(resources) != 2 {
					t.Fatal("missing still or motion")
				}
				motionFile := unified.Map(unified.Map(resources[1])["delivery"])
				if src := unified.Map(unified.Slice(motionFile["sources"])[0]); src["url"] != motion {
					t.Fatal("motion no longer belongs to the original still")
				}
				delivery = unified.Map(unified.Map(resources[0])["delivery"])
			} else if item["type"] != "image" {
				t.Fatalf("unexpected item type %v", item["type"])
			}
			if source := unified.Map(unified.Slice(delivery["sources"])[0]); source["url"] != want {
				t.Fatalf("live=%t: image %d lost its declared source", live, n)
			}
		}
	}
}

func TestMissingXsecTokenPromptsAppShareLink(t *testing.T) {
	p := New(requestFunc(func(_ context.Context, r fetch.Request) (fetch.Response, error) {
		return fetch.Response{
			StatusCode: 200,
			Body:       []byte(`<!doctype html><html><body><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{}}}</script></body></html>`),
			URL:        r.URL,
		}, nil
	}))
	res, err := p.Parse(context.Background(), "https://www.xiaohongshu.com/explore/66a1b2c3d4e5f6a7b8c9d0e1", 1793361600)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := unified.Str(res["code"]); got != "INVALID_INPUT" {
		t.Fatalf("code = %q, want INVALID_INPUT (res=%+v)", got, res)
	}
	msg := unified.Str(unified.Map(res["error"])["message"])
	if !strings.Contains(msg, "App") || !strings.Contains(msg, "分享链接") {
		t.Fatalf("expected prompt to copy share link from App, got %q", msg)
	}
}

func TestShortLinkRedirectReusesLandingBodyOrFallsBack(t *testing.T) {
	const (
		now          int64 = 1793361600
		shortURL           = "https://xhslink.com/a/short01"
		aliasURL           = "https://xhs.com/a/short01"
		canonicalURL       = "https://www.xiaohongshu.com/explore/abc123?xsec_token=tok_valid&xsec_source=pc_feed"
		rednoteURL         = "https://www.rednote.com/explore/abc123?xsec_token=tok_valid&xsec_source=pc_feed"
		noteHTML           = `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc123":{"note":{"noteId":"abc123","type":"video","title":"Short-link note","video":{"media":{"stream":{"h264":[{"masterUrl":"https://sns-video-qn.xhscdn.com/synthetic/720.mp4","width":1280,"height":720}]}}}}}}}};</script>`
	)

	t.Run("200-landing-with-valid-initial-state-avoids-second-canonical-get", func(t *testing.T) {
		for _, input := range []string{shortURL, aliasURL} {
			var pageURLs []string
			p := New(requestFunc(func(_ context.Context, r fetch.Request) (fetch.Response, error) {
				if r.Policy.Purpose != "xiaohongshu-page" {
					t.Fatalf("unexpected purpose %q", r.Policy.Purpose)
				}
				pageURLs = append(pageURLs, r.URL)
				switch r.URL {
				case shortURL:
					return fetch.Response{
						StatusCode: http.StatusFound,
						Header:     http.Header{"Location": {canonicalURL}},
						URL:        r.URL,
					}, nil
				case canonicalURL:
					return fetch.Response{
						StatusCode: http.StatusOK,
						Body:       []byte(noteHTML),
						URL:        r.URL,
					}, nil
				default:
					t.Fatalf("unexpected redundant canonical page GET: %s", r.URL)
					return fetch.Response{}, nil
				}
			}))
			got, err := p.Parse(context.Background(), input, now)
			if err != nil {
				t.Fatalf("input=%s unexpected error: %v", input, err)
			}
			if unified.Str(got["code"]) != "OK" {
				t.Fatalf("input=%s expected code OK, got %v", input, got["code"])
			}
			if len(pageURLs) != 2 || pageURLs[0] != shortURL || pageURLs[1] != canonicalURL {
				t.Fatalf("input=%s expected exactly 1 canonical page fetch after 302 ([%s, %s]), got %v", input, shortURL, canonicalURL, pageURLs)
			}
		}
	})

	t.Run("200-landing-without-initial-state-falls-back-to-canonical-fetch", func(t *testing.T) {
		for _, landingBody := range []string{
			`<!doctype html><html><body><script>location.replace("/explore/abc123")</script></body></html>`,
			``,
			`<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{}}};</script>`,
		} {
			var pageURLs []string
			p := New(requestFunc(func(_ context.Context, r fetch.Request) (fetch.Response, error) {
				pageURLs = append(pageURLs, r.URL)
				switch r.URL {
				case shortURL:
					return fetch.Response{
						StatusCode: http.StatusFound,
						Header:     http.Header{"Location": {canonicalURL}},
						URL:        r.URL,
					}, nil
				case canonicalURL:
					return fetch.Response{
						StatusCode: http.StatusOK,
						Body:       []byte(landingBody),
						URL:        r.URL,
					}, nil
				case rednoteURL:
					return fetch.Response{
						StatusCode: http.StatusOK,
						Body:       []byte(noteHTML),
						URL:        r.URL,
					}, nil
				default:
					t.Fatalf("unexpected URL %s", r.URL)
					return fetch.Response{}, nil
				}
			}))
			got, err := p.Parse(context.Background(), shortURL, now)
			if err != nil || unified.Str(got["code"]) != "OK" {
				t.Fatalf("landingBody=%q expected fallback OK, got code=%v err=%v", landingBody, got["code"], err)
			}
			if len(pageURLs) != 3 || pageURLs[2] != rednoteURL {
				t.Fatalf("landingBody=%q expected fallback to %s, got %v", landingBody, rednoteURL, pageURLs)
			}
		}
	})

	t.Run("non-200-redirect-stop-falls-back-to-canonical-fetch", func(t *testing.T) {
		var pageURLs []string
		p := New(requestFunc(func(_ context.Context, r fetch.Request) (fetch.Response, error) {
			pageURLs = append(pageURLs, r.URL)
			switch r.URL {
			case shortURL:
				return fetch.Response{
					StatusCode: http.StatusFound,
					Header:     http.Header{"Location": {canonicalURL}},
					URL:        r.URL,
				}, nil
			case canonicalURL:
				// Simulate redirect chain stopping on a 302 without Location header.
				return fetch.Response{
					StatusCode: http.StatusFound,
					Body:       []byte(noteHTML),
					URL:        r.URL,
				}, nil
			case rednoteURL:
				return fetch.Response{
					StatusCode: http.StatusOK,
					Body:       []byte(noteHTML),
					URL:        r.URL,
				}, nil
			default:
				t.Fatalf("unexpected URL %s", r.URL)
				return fetch.Response{}, nil
			}
		}))
		got, err := p.Parse(context.Background(), shortURL, now)
		if err != nil || unified.Str(got["code"]) != "OK" {
			t.Fatalf("expected fallback OK after 302 stop, got code=%v err=%v", got["code"], err)
		}
		if len(pageURLs) != 3 || pageURLs[2] != rednoteURL {
			t.Fatalf("expected fallback to %s, got %v", rednoteURL, pageURLs)
		}
	})
}

func TestShortLinkSecondHopSecurityRedirectRetainsNoteURLAndMapsUpstreamBlocked(t *testing.T) {
	const (
		now          int64 = 1793361600
		shortURL           = "http://xhslink.com/o/6JXkFnl35ex"
		canonicalURL       = "https://www.xiaohongshu.com/discovery/item/abc123?xsec_token=tok%2Bvalid+1%3D&xsec_source=pc_share"
		rednoteURL         = "https://www.rednote.com/discovery/item/abc123?xsec_token=tok%2Bvalid+1%3D&xsec_source=pc_share"
		secRelPath         = "/404/sec_verify_token?redirectPath=https%3A%2F%2Fwww.xiaohongshu.com%2Fdiscovery%2Fitem%2Fabc123&error_code=300031&error_msg=sec"
		secXHSURL          = "https://www.xiaohongshu.com" + secRelPath
		secRednote         = "https://www.rednote.com" + secRelPath
		noteHTML           = `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc123":{"note":{"noteId":"abc123","type":"video","title":"Recovered via rednote","video":{"media":{"stream":{"h264":[{"masterUrl":"https://sns-video-qn.xhscdn.com/synthetic/720.mp4","width":1280,"height":720}]}}}}}}}};</script>`
	)

	t.Run("rednote-succeeds-after-xhs-second-hop-sec-redirect", func(t *testing.T) {
		var pageURLs []string
		p := New(requestFunc(func(_ context.Context, r fetch.Request) (fetch.Response, error) {
			pageURLs = append(pageURLs, r.URL)
			switch r.URL {
			case shortURL:
				return fetch.Response{
					StatusCode: http.StatusFound,
					Header:     http.Header{"Location": {canonicalURL}},
					URL:        r.URL,
				}, nil
			case canonicalURL:
				return fetch.Response{
					StatusCode: http.StatusFound,
					Header:     http.Header{"Location": {secRelPath}},
					URL:        r.URL,
				}, nil
			case secXHSURL:
				return fetch.Response{
					StatusCode: http.StatusNotFound,
					Body:       []byte(`<html><body>security block</body></html>`),
					URL:        r.URL,
				}, nil
			case rednoteURL:
				return fetch.Response{
					StatusCode: http.StatusOK,
					Body:       []byte(noteHTML),
					URL:        r.URL,
				}, nil
			default:
				t.Fatalf("unexpected request URL: %s", r.URL)
				return fetch.Response{}, nil
			}
		}))
		got, err := p.Parse(context.Background(), shortURL, now)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if unified.Str(got["code"]) != "OK" {
			t.Fatalf("expected OK when rednote succeeds, got %#v", got)
		}
		if title := unified.Str(unified.Map(got["data"])["title"]); title != "Recovered via rednote" {
			t.Fatalf("title = %q, want Recovered via rednote", title)
		}
		wantOrder := []string{shortURL, canonicalURL, secXHSURL, rednoteURL}
		if len(pageURLs) != len(wantOrder) {
			t.Fatalf("pageURLs = %v, want %v", pageURLs, wantOrder)
		}
		for i, want := range wantOrder {
			if pageURLs[i] != want {
				t.Fatalf("pageURLs[%d] = %q, want %q", i, pageURLs[i], want)
			}
		}
	})

	t.Run("both-hosts-blocked-returns-upstream-blocked-not-invalid-input", func(t *testing.T) {
		for _, rednoteMode := range []string{"sec-302-to-200", "sec-302-to-404", "direct-403"} {
			t.Run(rednoteMode, func(t *testing.T) {
				var pageURLs []string
				p := New(requestFunc(func(_ context.Context, r fetch.Request) (fetch.Response, error) {
					pageURLs = append(pageURLs, r.URL)
					switch r.URL {
					case shortURL:
						return fetch.Response{
							StatusCode: http.StatusFound,
							Header:     http.Header{"Location": {canonicalURL}},
							URL:        r.URL,
						}, nil
					case canonicalURL:
						return fetch.Response{
							StatusCode: http.StatusFound,
							Header:     http.Header{"Location": {secRelPath}},
							URL:        r.URL,
						}, nil
					case secXHSURL:
						return fetch.Response{
							StatusCode: http.StatusOK,
							Body:       []byte(`<html><body>sec page</body></html>`),
							URL:        r.URL,
						}, nil
					case rednoteURL:
						if rednoteMode == "direct-403" {
							return fetch.Response{StatusCode: http.StatusForbidden, URL: r.URL}, nil
						}
						return fetch.Response{
							StatusCode: http.StatusFound,
							Header:     http.Header{"Location": {secRelPath}},
							URL:        r.URL,
						}, nil
					case secRednote:
						st := http.StatusOK
						if rednoteMode == "sec-302-to-404" {
							st = http.StatusNotFound
						}
						return fetch.Response{
							StatusCode: st,
							Body:       []byte(`<html><body>rednote sec page</body></html>`),
							URL:        r.URL,
						}, nil
					default:
						t.Fatalf("unexpected request URL (already-blocked xhs must not be retried): %s", r.URL)
						return fetch.Response{}, nil
					}
				}))
				got, err := p.Parse(context.Background(), shortURL, now)
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if err := unified.ValidateEnvelopeAt(got, now); err != nil {
					t.Fatalf("ValidateEnvelopeAt failed: %v", err)
				}
				if code := unified.Str(got["code"]); code != "UPSTREAM_BLOCKED" {
					t.Fatalf("code = %q, want UPSTREAM_BLOCKED (payload=%#v)", code, got)
				}
			})
		}
	})

	t.Run("direct-403-on-canonical-landing-skips-xhs-retry-and-falls-back-straight-to-rednote", func(t *testing.T) {
		for _, rednoteSucceeds := range []bool{true, false} {
			name := "rednote-200"
			if !rednoteSucceeds {
				name = "rednote-404-still-skips-xhs-retry"
			}
			t.Run(name, func(t *testing.T) {
				var pageURLs []string
				p := New(requestFunc(func(_ context.Context, r fetch.Request) (fetch.Response, error) {
					pageURLs = append(pageURLs, r.URL)
					switch r.URL {
					case shortURL:
						return fetch.Response{
							StatusCode: http.StatusFound,
							Header:     http.Header{"Location": {canonicalURL}},
							URL:        r.URL,
						}, nil
					case canonicalURL:
						return fetch.Response{
							StatusCode: http.StatusForbidden,
							Body:       []byte(`<html><body>403 forbidden</body></html>`),
							URL:        r.URL,
						}, nil
					case rednoteURL:
						if rednoteSucceeds {
							return fetch.Response{
								StatusCode: http.StatusOK,
								Body:       []byte(noteHTML),
								URL:        r.URL,
							}, nil
						}
						return fetch.Response{
							StatusCode: http.StatusNotFound,
							Body:       []byte(`<html><body>not found</body></html>`),
							URL:        r.URL,
						}, nil
					default:
						t.Fatalf("unexpected request URL: %s", r.URL)
						return fetch.Response{}, nil
					}
				}))
				got, err := p.Parse(context.Background(), shortURL, now)
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				// Exactly 1 request to shortURL + 1 request to xiaohongshu + 1 fallback request to rednote (no second xiaohongshu fetch!)
				wantOrder := []string{shortURL, canonicalURL, rednoteURL}
				if len(pageURLs) != len(wantOrder) {
					t.Fatalf("pageURLs = %v, want %v", pageURLs, wantOrder)
				}
				for i, want := range wantOrder {
					if pageURLs[i] != want {
						t.Fatalf("pageURLs[%d] = %q, want %q", i, pageURLs[i], want)
					}
				}
				if rednoteSucceeds {
					if unified.Str(got["code"]) != "OK" {
						t.Fatalf("expected OK when rednote succeeds, got %#v", got)
					}
				} else {
					if unified.Str(got["code"]) != "UPSTREAM_BLOCKED" {
						t.Fatalf("expected UPSTREAM_BLOCKED when xhs returned 403 and rednote failed, got %#v", got)
					}
				}
			})
		}
	})
}
