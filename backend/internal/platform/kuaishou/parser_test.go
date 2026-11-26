package kuaishou

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

type executorFunc func(context.Context, fetch.Request) (fetch.Response, error)

func (f executorFunc) Do(ctx context.Context, request fetch.Request) (fetch.Response, error) {
	return f(ctx, request)
}

func TestCallerCancellationStopsAfterHEAD(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	parser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
		calls++
		if request.Method != http.MethodHead {
			t.Fatal("page request started after caller cancellation")
		}
		cancel()
		return fetch.Response{StatusCode: 200, URL: "https://www.kuaishou.com/short-video/test"}, nil
	}))
	payload, err := parser.Parse(ctx, "https://v.kuaishou.com/test", 1793361600)
	if !errors.Is(err, context.Canceled) || payload != nil || calls != 1 {
		t.Fatalf("cancellation: calls=%d payload=%v error=%v", calls, payload, err)
	}
}

func TestRejectedInputNeverStartsTransport(t *testing.T) {
	for _, input := range []string{"https://kuaishou.com.attacker.example/short-video/test", "https://user@www.kuaishou.com/short-video/test", "https://www.kuaishou.com:8080/short-video/test", "http://127.0.0.1/short-video/test"} {
		t.Run(input, func(t *testing.T) {
			parser := New(executorFunc(func(context.Context, fetch.Request) (fetch.Response, error) {
				t.Fatal("unapproved input started transport")
				return fetch.Response{}, nil
			}))
			payload, err := parser.Parse(context.Background(), input, 1793361600)
			if err != nil || payload["code"] != "INVALID_INPUT" {
				t.Fatalf("invalid input: %v %v", payload, err)
			}
		})
	}
}

func TestUntrustedEffectiveURLCannotStartPage(t *testing.T) {
	calls := 0
	parser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
		calls++
		return fetch.Response{StatusCode: 200, URL: "https://example.invalid/private"}, nil
	}))
	payload, err := parser.Parse(context.Background(), "https://v.kuaishou.com/test", 1793361600)
	if err != nil || payload["code"] != "INVALID_INPUT" || calls != 1 {
		t.Fatalf("effective URL escaped authorization: calls=%d payload=%v err=%v", calls, payload, err)
	}
}

func TestShortShareCanReachOfficialMobilePhotoPage(t *testing.T) {
	const share = "https://v.kuaishou.com/test"
	const page = "https://sample.m.chenzhongtech.com/fw/photo/ksExample?first=a%2Fb&first=c"
	const html = `<script>window.INIT_STATE = {"tusjoh-a":{"photo":{"photoType":"VIDEO","mainMvUrls":[{"url":"https://media.example.test/kuaishou.mp4"}]}}};</script>`
	calls := 0
	parser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
		calls++
		if request.Method == http.MethodHead {
			if request.URL != share || !request.Policy.AllowedURL(page) {
				return fetch.Response{}, fetch.ErrPolicy
			}
			for _, unsafe := range []string{
				"http://sample.m.chenzhongtech.com/fw/photo/id",
				"https://sample.m.chenzhongtech.com:444/fw/photo/id",
				"https://user@sample.m.chenzhongtech.com/fw/photo/id",
				"https://sample.m.chenzhongtech.com.example.org/fw/photo/id",
				"https://sample.m.chenzhongtech.com/private/path",
				"https://sample.m.chenzhongtech.com/fw/photo/%2e%2e",
				"https://sample.m.chenzhongtech.com/fw/photo/id#fragment",
			} {
				if request.Policy.AllowedURL(unsafe) {
					t.Fatal("mobile page policy admitted a non-work destination")
				}
			}
			return fetch.Response{StatusCode: 200, URL: page, History: []string{page}}, nil
		}
		if request.Method != http.MethodGet || request.URL != page || !request.Policy.AllowedURL(page) {
			t.Fatal("page GET did not preserve the approved redirect and query")
		}
		return fetch.Response{StatusCode: 200, URL: page, Body: []byte(html)}, nil
	}))
	payload, err := parser.Parse(context.Background(), share, 1793361600)
	if err != nil || payload["code"] != "OK" || calls != 2 {
		t.Fatalf("mobile work was not parsed: calls=%d code=%v err=%v", calls, payload["code"], err)
	}
	payload, err = parser.Parse(context.Background(), page, 1793361600)
	if err != nil || payload["code"] != "INVALID_INPUT" || calls != 2 {
		t.Fatal("mobile landing page became a directly accepted input")
	}
}

func TestDesktopShortVideoSkipsFirstHopAndStripsQuery(t *testing.T) {
	const (
		desktopWithQ   = "https://www.kuaishou.com/short-video/3xngkmw8vacriqu?x=y&cc=share_copylink"
		rewrittenPhoto = "https://c.kuaishou.com/fw/photo/3xngkmw8vacriqu"
		html           = `<script>window.INIT_STATE = {"tusjoh-a":{"photo":{"photoType":"VIDEO","caption":"快手桌面端直连样本","mainMvUrls":[{"url":"https://media.example.test/kuaishou-desktop.mp4"}]}}};</script>`
	)

	var wireCalls []string
	parser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
		if strings.Contains(request.URL, "www.kuaishou.com") {
			t.Fatalf("unexpected request sent to www.kuaishou.com: %s %s", request.Method, request.URL)
		}
		if !request.Policy.AllowedURL(request.URL) {
			return fetch.Response{}, fetch.ErrPolicy
		}
		wireCalls = append(wireCalls, request.Method+" "+request.URL)
		if request.Method == http.MethodHead && request.URL == rewrittenPhoto {
			return fetch.Response{StatusCode: 200, URL: request.URL}, nil
		}
		if request.Method == http.MethodGet && request.URL == rewrittenPhoto {
			return fetch.Response{StatusCode: 200, URL: request.URL, Body: []byte(html)}, nil
		}
		t.Fatalf("unexpected outbound request: %s %s", request.Method, request.URL)
		return fetch.Response{}, nil
	}))

	payload, err := parser.Parse(context.Background(), desktopWithQ, 1793361600)
	if err != nil || payload["code"] != "OK" {
		t.Fatalf("desktop short-video direct rewrite failed: code=%v err=%v", payload["code"], err)
	}
	wantCalls := []string{
		"HEAD " + rewrittenPhoto,
		"GET " + rewrittenPhoto,
	}
	if strings.Join(wireCalls, "\n") != strings.Join(wantCalls, "\n") {
		t.Fatalf("unexpected outbound request sequence:\ngot:  %v\nwant: %v", wireCalls, wantCalls)
	}
}

func TestShareRedirectsToDesktopShortVideoOrGifshowMobilePhotoPage(t *testing.T) {
	const (
		share          = "https://v.kuaishou.com/test"
		desktopWithQ   = "https://www.kuaishou.com/short-video/3xngkmw8vacriqu?x=y&cc=share_copylink"
		gifshowWithQ   = "https://m.gifshow.com/fw/photo/3xngkmw8vacriqu?x=y&cc=share_copylink"
		rewrittenPhoto = "https://c.kuaishou.com/fw/photo/3xngkmw8vacriqu"
		html           = `<script>window.INIT_STATE = {"tusjoh-a":{"photo":{"photoType":"VIDEO","caption":"快手跳转改写样本","mainMvUrls":[{"url":"https://media.example.test/kuaishou-desktop.mp4"}]}}};</script>`
	)

	for _, redirectTarget := range []string{desktopWithQ, gifshowWithQ} {
		t.Run(redirectTarget, func(t *testing.T) {
			var wireCalls []string
			parser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
				if request.Policy.RewriteRedirect == nil {
					t.Fatal("missing kuaishou redirect rewrite hook")
				}
				current := request.URL
				var history []string
				for hop := 0; ; hop++ {
					if strings.Contains(current, "www.kuaishou.com") || strings.Contains(current, "m.gifshow.com") {
						t.Fatalf("unrewritten unstable host dialed on hop %d: %s %s", hop, request.Method, current)
					}
					if !request.Policy.AllowedURL(current) {
						return fetch.Response{}, fetch.ErrPolicy
					}
					wireCalls = append(wireCalls, request.Method+" "+current)
					if request.Method == http.MethodHead && current == share {
						next := request.Policy.RewriteRedirect(redirectTarget)
						history = append(history, next)
						current = next
						continue
					}
					if request.Method == http.MethodHead && current == rewrittenPhoto {
						return fetch.Response{StatusCode: 200, URL: current, History: history}, nil
					}
					if request.Method == http.MethodGet && current == rewrittenPhoto {
						return fetch.Response{StatusCode: 200, URL: current, Body: []byte(html)}, nil
					}
					t.Fatalf("unexpected outbound hop %d: %s %s", hop, request.Method, current)
				}
			}))

			payload, err := parser.Parse(context.Background(), share, 1793361600)
			if err != nil || payload["code"] != "OK" {
				t.Fatalf("redirect rewrite failed for %q: code=%v err=%v", redirectTarget, payload["code"], err)
			}
			wantCalls := []string{
				"HEAD " + share,
				"HEAD " + rewrittenPhoto,
				"GET " + rewrittenPhoto,
			}
			if strings.Join(wireCalls, "\n") != strings.Join(wantCalls, "\n") {
				t.Fatalf("unexpected outbound request sequence:\ngot:  %v\nwant: %v", wireCalls, wantCalls)
			}
		})
	}

	if got := rewriteGifshowRedirect("https://m.gifshow.com/fw/photo/3xngkmw8vacriqu/?x=y"); got != rewrittenPhoto {
		t.Fatalf("trailing slash and query were not normalized: got %q want %q", got, rewrittenPhoto)
	}
	for _, trailing := range []string{
		"https://www.kuaishou.com/short-video/3xngkmw8vacriqu/",
		"https://www.kuaishou.com/short-video/3xngkmw8vacriqu/?x=y",
	} {
		if got := rewriteDesktopShortVideo(trailing); got != rewrittenPhoto+"/" {
			t.Fatalf("rewriteDesktopShortVideo(%q) = %q, want %q", trailing, got, rewrittenPhoto+"/")
		}
	}

	// Non-matching desktop short-video variants must not be rewritten as input or redirect.
	for _, unchanged := range []string{
		"https://www.kuaishou.com/short-video/",
		"https://www.kuaishou.com/short-video/%2e%2e?x=y",
		"https://www.kuaishou.com/short-video/bad.id?x=y",
		"https://www.kuaishou.com/short-video/bad$id?x=y",
		"https://www.kuaishou.com/short-video/3xngkmw8vacriqu/extra",
		"https://www.kuaishou.com/short-video/3xngkmw8vacriqu//",
		"https://www.kuaishou.com/prefix/short-video/3xngkmw8vacriqu",
		"http://www.kuaishou.com/short-video/3xngkmw8vacriqu?x=y",
		"https://www.kuaishou.com:443/short-video/3xngkmw8vacriqu?x=y",
		"https://www.kuaishou.com:8443/short-video/3xngkmw8vacriqu?x=y",
		"https://user@www.kuaishou.com/short-video/3xngkmw8vacriqu?x=y",
		"https://sub.www.kuaishou.com/short-video/3xngkmw8vacriqu?x=y",
		"https://www.kuaishou.com/short-video/3xngkmw8vacriqu#fragment",
	} {
		t.Run("not-rewritten/"+unchanged, func(t *testing.T) {
			if got := rewriteDesktopShortVideo(unchanged); got != unchanged {
				t.Fatalf("rewriteDesktopShortVideo(%q) = %q, want unchanged", unchanged, got)
			}
			if got := rewriteKuaishouRedirect(unchanged); got != unchanged {
				t.Fatalf("rewriteKuaishouRedirect(%q) = %q, want unchanged", unchanged, got)
			}
			if allowedInput(unchanged) {
				var firstURL string
				probe := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
					firstURL = request.URL
					return fetch.Response{}, errors.New("stop after first hop")
				}))
				_, _ = probe.Parse(context.Background(), unchanged, 1793361600)
				if firstURL != unchanged {
					t.Fatalf("direct input %q was rewritten to %q", unchanged, firstURL)
				}
			}
		})
	}

	// Non-matching paths and unsafe m.gifshow.com variants must never be rewritten or admitted.
	for _, rejected := range []string{
		"https://m.gifshow.com/private/path?x=y",
		"https://m.gifshow.com/fw/photo/%2e%2e?x=y",
		"https://m.gifshow.com/fw/photo/",
		"https://m.gifshow.com/fw/photo/3xngkmw8vacriqu/extra",
		"http://m.gifshow.com/fw/photo/3xngkmw8vacriqu?x=y",
		"https://m.gifshow.com:8443/fw/photo/3xngkmw8vacriqu?x=y",
		"https://user@m.gifshow.com/fw/photo/3xngkmw8vacriqu?x=y",
		"https://sub.m.gifshow.com/fw/photo/3xngkmw8vacriqu?x=y",
		"https://m.gifshow.com.example.org/fw/photo/3xngkmw8vacriqu?x=y",
		"https://m.gifshow.com/fw/photo/3xngkmw8vacriqu#fragment",
	} {
		t.Run(rejected, func(t *testing.T) {
			hopCalls := 0
			rejectParser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
				current := request.URL
				for {
					if !request.Policy.AllowedURL(current) {
						return fetch.Response{}, fetch.ErrPolicy
					}
					hopCalls++
					if hopCalls == 1 {
						current = request.Policy.RewriteRedirect(rejected)
						continue
					}
					t.Fatalf("unapproved redirect %q reached second request %q", rejected, current)
				}
			}))
			got, err := rejectParser.Parse(context.Background(), share, 1793361600)
			if err != nil || got["code"] != "INVALID_INPUT" || hopCalls != 1 {
				t.Fatalf("unapproved redirect %q was not rejected after first hop: calls=%d payload=%v err=%v", rejected, hopCalls, got, err)
			}
		})
	}

	// Direct m.gifshow.com user input must remain rejected before starting transport.
	directParser := New(executorFunc(func(context.Context, fetch.Request) (fetch.Response, error) {
		t.Fatal("m.gifshow.com started outbound transport")
		return fetch.Response{}, nil
	}))
	directPayload, err := directParser.Parse(context.Background(), "https://m.gifshow.com/fw/photo/3xngkmw8vacriqu", 1793361600)
	if err != nil || directPayload["code"] != "INVALID_INPUT" {
		t.Fatalf("m.gifshow.com became a directly accepted input: payload=%v err=%v", directPayload, err)
	}
}

func TestDesktopShareCodeDirectAndRedirectRewrite(t *testing.T) {
	const (
		now               = 1793361600
		desktopShareWithQ = "https://www.kuaishou.com/f/X-FJK5jXh9dH27s?x=y&cc=share_copylink"
		rewrittenShare    = "https://c.kuaishou.com/f/X-FJK5jXh9dH27s"
		mobileLanding     = "https://sample.m.chenzhongtech.com/fw/photo/3xsrqr3u2bfjrem?cc=share_im"
		vShare            = "https://v.kuaishou.com/test"
		html              = `<script>window.INIT_STATE = {"tusjoh-a":{"photo":{"photoType":"VIDEO","caption":"快手 /f/ 桌面分享短码样本","mainMvUrls":[{"url":"https://media.example.test/kuaishou-f-share.mp4"}]}}};</script>`
	)

	// 1. Direct input https://www.kuaishou.com/f/<shortcode>?... skips www.kuaishou.com first hop
	// and sends HEAD https://c.kuaishou.com/f/<shortcode> directly.
	var directCalls []string
	directParser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
		if strings.Contains(request.URL, "www.kuaishou.com") {
			t.Fatalf("unexpected request sent to www.kuaishou.com: %s %s", request.Method, request.URL)
		}
		if !request.Policy.AllowedURL(request.URL) {
			return fetch.Response{}, fetch.ErrPolicy
		}
		directCalls = append(directCalls, request.Method+" "+request.URL)
		if request.Method == http.MethodHead && request.URL == rewrittenShare {
			next := request.Policy.RewriteRedirect(mobileLanding)
			if !request.Policy.AllowedURL(next) {
				return fetch.Response{}, fetch.ErrPolicy
			}
			directCalls = append(directCalls, request.Method+" "+next)
			return fetch.Response{StatusCode: http.StatusOK, URL: next, History: []string{next}}, nil
		}
		if request.Method == http.MethodGet && request.URL == mobileLanding {
			return fetch.Response{StatusCode: http.StatusOK, URL: mobileLanding, Body: []byte(html)}, nil
		}
		t.Fatalf("unexpected outbound request: %s %s", request.Method, request.URL)
		return fetch.Response{}, nil
	}))

	directPayload, err := directParser.Parse(context.Background(), desktopShareWithQ, now)
	if err != nil || directPayload["code"] != "OK" {
		t.Fatalf("desktop /f/ direct rewrite failed: code=%v err=%v", directPayload["code"], err)
	}
	for _, debug := range []bool{false, true} {
		view := unified.PublicView(directPayload, debug, now)
		if err := unified.ValidateEnvelopeAt(view, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt(debug=%v) failed: %v", debug, err)
		}
		if gotSource := unified.Str(unified.Map(view["data"])["source_url"]); gotSource != desktopShareWithQ {
			t.Fatalf("expected original source_url %q preserved, got %q", desktopShareWithQ, gotSource)
		}
	}
	wantDirectCalls := []string{
		"HEAD " + rewrittenShare,
		"HEAD " + mobileLanding,
		"GET " + mobileLanding,
	}
	if strings.Join(directCalls, "\n") != strings.Join(wantDirectCalls, "\n") {
		t.Fatalf("unexpected direct /f/ outbound sequence:\ngot:  %v\nwant: %v", directCalls, wantDirectCalls)
	}

	// 2. Redirect hop to https://www.kuaishou.com/f/<shortcode>?... is also rewritten
	// to https://c.kuaishou.com/f/<shortcode> before dialing.
	var redirectCalls []string
	redirectParser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
		if request.Policy.RewriteRedirect == nil {
			t.Fatal("missing kuaishou redirect rewrite hook")
		}
		current := request.URL
		var history []string
		for hop := 0; ; hop++ {
			if strings.Contains(current, "www.kuaishou.com") || strings.Contains(current, "m.gifshow.com") {
				t.Fatalf("unrewritten unstable host dialed on hop %d: %s %s", hop, request.Method, current)
			}
			if !request.Policy.AllowedURL(current) {
				return fetch.Response{}, fetch.ErrPolicy
			}
			redirectCalls = append(redirectCalls, request.Method+" "+current)
			if request.Method == http.MethodHead && current == vShare {
				next := request.Policy.RewriteRedirect(desktopShareWithQ)
				history = append(history, next)
				current = next
				continue
			}
			if request.Method == http.MethodHead && current == rewrittenShare {
				next := request.Policy.RewriteRedirect(mobileLanding)
				history = append(history, next)
				current = next
				continue
			}
			if request.Method == http.MethodHead && current == mobileLanding {
				return fetch.Response{StatusCode: http.StatusOK, URL: current, History: history}, nil
			}
			if request.Method == http.MethodGet && current == mobileLanding {
				return fetch.Response{StatusCode: http.StatusOK, URL: current, Body: []byte(html)}, nil
			}
			t.Fatalf("unexpected outbound hop %d: %s %s", hop, request.Method, current)
		}
	}))

	redirectPayload, err := redirectParser.Parse(context.Background(), vShare, now)
	if err != nil || redirectPayload["code"] != "OK" {
		t.Fatalf("redirect to desktop /f/ rewrite failed: code=%v err=%v", redirectPayload["code"], err)
	}
	wantRedirectCalls := []string{
		"HEAD " + vShare,
		"HEAD " + rewrittenShare,
		"HEAD " + mobileLanding,
		"GET " + mobileLanding,
	}
	if strings.Join(redirectCalls, "\n") != strings.Join(wantRedirectCalls, "\n") {
		t.Fatalf("unexpected redirect /f/ outbound sequence:\ngot:  %v\nwant: %v", redirectCalls, wantRedirectCalls)
	}

	for _, trailing := range []string{
		"https://www.kuaishou.com/f/X-FJK5jXh9dH27s/",
		"https://www.kuaishou.com/f/X-FJK5jXh9dH27s/?x=y&cc=share_copylink",
	} {
		if got := rewriteDesktopShare(trailing); got != rewrittenShare {
			t.Fatalf("rewriteDesktopShare(%q) = %q, want %q", trailing, got, rewrittenShare)
		}
	}

	// 3. Negative cases: invalid shortcode, extra path segment, double trailing slash, non-HTTPS,
	// explicit port, userinfo, subdomain, and #fragment must never be rewritten.
	for _, unchanged := range []string{
		"https://www.kuaishou.com/f/",
		"https://www.kuaishou.com/f/%2e%2e?x=y",
		"https://www.kuaishou.com/f/bad.id?x=y",
		"https://www.kuaishou.com/f/bad$id?x=y",
		"https://www.kuaishou.com/f/X-FJK5jXh9dH27s/extra",
		"https://www.kuaishou.com/f/X-FJK5jXh9dH27s//",
		"https://www.kuaishou.com/prefix/f/X-FJK5jXh9dH27s",
		"http://www.kuaishou.com/f/X-FJK5jXh9dH27s?x=y",
		"https://www.kuaishou.com:443/f/X-FJK5jXh9dH27s?x=y",
		"https://www.kuaishou.com:8443/f/X-FJK5jXh9dH27s?x=y",
		"https://user@www.kuaishou.com/f/X-FJK5jXh9dH27s?x=y",
		"https://sub.www.kuaishou.com/f/X-FJK5jXh9dH27s?x=y",
		"https://www.kuaishou.com/f/X-FJK5jXh9dH27s#fragment",
		"https://www.kuaishou.com/f/X-FJK5jXh9dH27s#",
	} {
		t.Run("not-rewritten/"+unchanged, func(t *testing.T) {
			if got := rewriteDesktopShare(unchanged); got != unchanged {
				t.Fatalf("rewriteDesktopShare(%q) = %q, want unchanged", unchanged, got)
			}
			if got := rewriteKuaishouDirectInput(unchanged); got != unchanged {
				t.Fatalf("rewriteKuaishouDirectInput(%q) = %q, want unchanged", unchanged, got)
			}
			if got := rewriteKuaishouRedirect(unchanged); got != unchanged {
				t.Fatalf("rewriteKuaishouRedirect(%q) = %q, want unchanged", unchanged, got)
			}
			if allowedInput(unchanged) {
				var firstURL string
				probe := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
					firstURL = request.URL
					return fetch.Response{}, errors.New("stop after first hop")
				}))
				_, _ = probe.Parse(context.Background(), unchanged, now)
				if firstURL != unchanged {
					t.Fatalf("direct input %q was rewritten to %q", unchanged, firstURL)
				}
			}
		})
	}
}

func TestParseKeepsHEADAndGETRequestBoundaries(t *testing.T) {
	const target = "https://www.kuaishou.com/short-video/test"
	calls := 0
	parser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
		calls++
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 40*time.Second || request.Policy.Timeout != 20*time.Second || request.Policy.MaxBytes != 8<<20 || !request.Policy.FollowRedirects || request.Policy.MaxRedirects != 5 {
			t.Error("original bounded request semantics changed")
		}
		if calls == 1 {
			if request.Method != http.MethodHead || request.Policy.AutoReferer || len(request.Header.Values("Cookie")) != 0 {
				t.Error("HEAD acquired page settings")
			}
			return fetch.Response{StatusCode: 200, URL: target}, nil
		}
		if request.Method != http.MethodGet || !request.Policy.AutoReferer || request.Header.Get("Cookie") != "" || len(request.Header.Values("Cookie")) != 1 || request.URL != target {
			t.Error("GET lost effective target, automatic Referer or empty configured Cookie")
		}
		return fetch.Response{StatusCode: 200, URL: target, Body: []byte("<html>no metadata</html>")}, nil
	}))
	payload, err := parser.Parse(context.Background(), "https://v.kuaishou.com/test", 1793361600)
	if err != nil || payload["code"] != "CONTENT_UNAVAILABLE" || calls != 2 {
		t.Fatalf("bounded flow: calls=%d payload=%v err=%v", calls, payload, err)
	}
}

func TestMalformedRequiredShapesAreNotEmptySuccess(t *testing.T) {
	for _, raw := range []string{
		"null", "true",
		`{"tusjoh-a":{"photo":{"photoType":"VIDEO","mainMvUrls":"not-an-array"}}}`,
		`{"tusjoh-a":{"photo":{"ext_params":{"atlas":{"list":"not-an-array"}}}}}`,
	} {
		t.Run(raw, func(t *testing.T) {
			payload, err := fromInitState("<script>window.INIT_STATE = " + raw + ";</script>")
			if err == nil || payload != nil {
				t.Fatalf("required shape error was swallowed: %v %v", payload, err)
			}
		})
	}
}

func TestOversizedInjectedPageRemainsRejected(t *testing.T) {
	const target = "https://www.kuaishou.com/short-video/test"
	calls := 0
	parser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
		calls++
		response := fetch.Response{StatusCode: 200, URL: target}
		if request.Method == http.MethodGet {
			response.Body = []byte(strings.Repeat("x", (8<<20)+1))
		}
		return response, nil
	}))
	payload, err := parser.Parse(context.Background(), target, 1793361600)
	if err != nil || payload["code"] != "UPSTREAM_UNAVAILABLE" || calls != 2 {
		t.Fatalf("oversized metadata was parsed: calls=%d payload=%v err=%v", calls, payload, err)
	}
}

func TestAllowedBrowserFetchURL(t *testing.T) {
	allowed := []string{
		"https://v1.kwaicdn.com/upic/2026/11/14/01/video.mp4?pkey=abc",
		"https://v23-3.kwaicdn.com/upic/2026/11/14/01/video.mp4?pkey=abc",
		"https://v2-zj-shun.kwaicdn.com/upic/2026/11/14/01/video.mp4?Aecs=1",
		"https://txmov2.a.kwimgs.com/upic/2026/11/14/01/video.mp4",
		"https://tymov2.a.kwimgs.com/upic/2026/11/14/01/video.mp4",
		"https://hw.a.yximgs.com/upic/2026/11/14/01/audio.m4a",
		"https://p2.a.yximgs.com/upic/2026/11/14/01/image.webp",
		"https://V23-3.KWAICDN.COM:443/upic/video.mp4",
	}
	for _, raw := range allowed {
		if !AllowedBrowserFetchURL(raw) {
			t.Fatalf("expected %q to allow browser_fetch", raw)
		}
	}

	rejected := []string{
		"http://tx2.a.yximgs.com/ufile/atlas/img.webp",
		"http://txmov2.a.kwimgs.com/ufile/atlas/music.m4a",
		"http://v1.kwaicdn.com/upic/video.mp4",
		"https://kwaicdn.com/upic/video.mp4",
		"https://kwimgs.com/upic/video.mp4",
		"https://yximgs.com/upic/video.mp4",
		"https://.kwaicdn.com/upic/video.mp4",
		"https://www.kuaishou.com/short-video/3xngkmw8vacriqu",
		"https://c.kuaishou.com/fw/photo/3xngkmw8vacriqu",
		"https://m.gifshow.com/fw/photo/3xngkmw8vacriqu",
		"https://sample.m.chenzhongtech.com/fw/photo/3xngkmw8vacriqu",
		"https://v1.kwaicdn.com:8443/upic/video.mp4",
		"https://user@v1.kwaicdn.com/upic/video.mp4",
		"https://v1.kwaicdn.com/upic/video.mp4#frag",
		"https://media.example.test/kuaishou.mp4",
		"",
	}
	for _, raw := range rejected {
		if AllowedBrowserFetchURL(raw) {
			t.Fatalf("expected %q not to allow browser_fetch", raw)
		}
	}
}

func TestPreparePublicMarksKuaishouCDNSources(t *testing.T) {
	const (
		now    int64 = 1793361600
		target       = "https://c.kuaishou.com/fw/photo/3xngkmw8vacriqu"
		html         = `<script>window.INIT_STATE = {"tusjoh-a":{"photo":{"photoType":"VIDEO","caption":"multi route","music":{"name":"bgm","audioUrls":[{"url":"https://hw.a.yximgs.com/bgm.m4a"}]},"mainMvUrls":[{"url":"https://v1.kwaicdn.com/main1.mp4"},{"url":"https://v23-3.kwaicdn.com/main2.mp4"},{"url":"https://txmov2.a.kwimgs.com/main3.mp4"},{"url":"http://txmov2.a.kwimgs.com/plain-http.mp4"},{"url":"https://media.example.test/unverified.mp4"}]}}};</script>`
	)
	parser := New(executorFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		if req.Method == http.MethodHead {
			return fetch.Response{StatusCode: 200, URL: target}, nil
		}
		return fetch.Response{StatusCode: 200, URL: target, Body: []byte(html)}, nil
	}))
	parsed, err := parser.Parse(context.Background(), "https://www.kuaishou.com/short-video/3xngkmw8vacriqu", now)
	if err != nil || parsed["code"] != "OK" {
		t.Fatalf("Parse failed: code=%v err=%v", parsed["code"], err)
	}
	before := unified.Clone(parsed)
	out, err := PreparePublic(context.Background(), "kuaishou", parsed, now)
	if err != nil {
		t.Fatalf("PreparePublic failed: %v", err)
	}
	if !unified.Equal(parsed, before) {
		t.Fatal("input envelope mutated in place")
	}
	if err := unified.ValidateEnvelopeAt(out, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}

	sources := unified.Slice(unified.Map(unified.Map(unified.Slice(unified.Map(unified.Slice(unified.Map(out["data"])["items"])[0])["variants"])[0])["delivery"])["sources"])
	wantFetch := []string{"allowed", "allowed", "allowed", "", ""}
	if len(sources) != len(wantFetch) {
		t.Fatalf("expected %d sources, got %d", len(wantFetch), len(sources))
	}
	for i, want := range wantFetch {
		if got := unified.Str(unified.Map(sources[i])["browser_fetch"]); got != want {
			t.Fatalf("source[%d] (%s) browser_fetch=%q, want %q", i, unified.Str(unified.Map(sources[i])["url"]), got, want)
		}
	}
	attSources := unified.Slice(unified.Map(unified.Map(unified.Map(unified.Slice(unified.Map(out["data"])["attachments"])[0])["resource"])["delivery"])["sources"])
	if got := unified.Str(unified.Map(attSources[0])["browser_fetch"]); got != "allowed" {
		t.Fatalf("attachment source browser_fetch=%q, want allowed", got)
	}

	// Explicit blocked or relay sources must never be overwritten.
	synthetic := unified.Clone(parsed)
	synSources := unified.Slice(unified.Map(unified.Map(unified.Slice(unified.Map(unified.Slice(unified.Map(synthetic["data"])["items"])[0])["variants"])[0])["delivery"])["sources"])
	unified.Map(synSources[0])["browser_fetch"] = "blocked"
	unified.Map(synSources[1])["browser_fetch"] = "unknown"
	synOut, err := PreparePublic(context.Background(), "kuaishou", synthetic, now)
	if err != nil {
		t.Fatal(err)
	}
	gotSyn := unified.Slice(unified.Map(unified.Map(unified.Slice(unified.Map(unified.Slice(unified.Map(synOut["data"])["items"])[0])["variants"])[0])["delivery"])["sources"])
	if got := unified.Str(unified.Map(gotSyn[0])["browser_fetch"]); got != "blocked" {
		t.Fatalf("blocked overwritten: %q", got)
	}
	if got := unified.Str(unified.Map(gotSyn[1])["browser_fetch"]); got != "allowed" {
		t.Fatalf("unknown not upgraded to allowed: %q", got)
	}

	other, err := PreparePublic(context.Background(), "douyin", parsed, now)
	if err != nil || !unified.Equal(other, before) {
		t.Fatal("non-kuaishou payload changed")
	}
}

func TestContentIDStopsAtFragment(t *testing.T) {
	kind, id := contentID("https://www.kuaishou.com/short-video/3xsynthetic7#testfrag")
	if kind != "short-video" || id != "3xsynthetic7" {
		t.Fatalf("contentID with fragment = (%q, %q), want (short-video, 3xsynthetic7)", kind, id)
	}
	kind, id = contentID("https://c.kuaishou.com/fw/photo/3xsynthetic7?a=1#frag")
	if kind != "fw-photo" || id != "3xsynthetic7" {
		t.Fatalf("contentID with query+fragment = (%q, %q), want (fw-photo, 3xsynthetic7)", kind, id)
	}
}
