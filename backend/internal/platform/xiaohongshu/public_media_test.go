package xiaohongshu

import (
	"context"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func TestAllowedBrowserFetchURL(t *testing.T) {
	allowed := []string{
		"https://sns-video-qn.xhscdn.com/spectrum/1040g00g31000000",
		"https://sns-video-al.xhscdn.com/spectrum/1040g00g31000000",
		"https://sns-video-qc.xhscdn.com/spectrum/1040g00g31000000",
		"https://sns-video-bd.xhscdn.com/spectrum/1040g00g31000000",
		"https://sns-video-v6.xhscdn.com/stream/110/258/01e.mp4?sign=abc&t=69000000",
		"https://sns-bak-v1.xhscdn.com/stream/110/258/01e.mp4?sign=abc&t=69000000",
		"https://sns-webpic-qc.xhscdn.com/20261114/notes_pre_post/abc!nd_dft_wlteh_webp_3",
		"https://sns-img-hw.xhscdn.com/notes_pre_post/abc?imageView2/2/w/0/format/jpg",
		"https://sns-v11.rednotecdn.com/stream/110/258/01e.mp4?sig=a%2Bb+z",
		"https://sns-v27.rednotecdn.com/stream/110/258/01e.mp4?sig=a%2Bb+z",
		"https://sns-web-i10.rednotecdn.com/notes_pre_post/abc!nd_dft_wlteh_webp_3",
		"https://SNS-V11.rednotecdn.com:443/a",
	}
	for _, raw := range allowed {
		if !AllowedBrowserFetchURL(raw) {
			t.Fatalf("expected %q to allow browser_fetch", raw)
		}
	}

	rejected := []string{
		"http://sns-v11.rednotecdn.com/stream/01e.mp4",
		"http://sns-video-qn.xhscdn.com/spectrum/1040g00g",
		"https://xhscdn.com/spectrum/1040g00g",
		"https://rednotecdn.com/stream/01e.mp4",
		"https://.xhscdn.com/a",
		"https://..xhscdn.com/a",
		"https://-bad.xhscdn.com/a",
		"https://ci.xiaohongshu.com/abc?imageView2/2/w/0/format/jpg",
		"https://www.xiaohongshu.com/explore/6a7e74de0000000033033075",
		"https://creator.xiaohongshu.com/publish/publish",
		"https://www.rednote.com/explore/6a7e74de0000000033033075",
		"https://sns-v11.rednotecdn.com:8443/a",
		"https://sns-v11.rednotecdn.com:/a",
		"https://user@sns-v11.rednotecdn.com/a",
		"https://sns-v11.rednotecdn.com/a#frag",
		"https://ſns-v11.rednotecdn.com/a",
		"https://media.example.test/a.mp4",
		"",
	}
	for _, raw := range rejected {
		if AllowedBrowserFetchURL(raw) {
			t.Fatalf("expected %q not to allow browser_fetch", raw)
		}
	}
}

func TestPreparePublicLiveMotionHTTPS(t *testing.T) {
	cases := []struct {
		raw       string
		want      string
		wantFetch string
	}{
		{"http://sns-v11.rednotecdn.com/a%2fb?x=%2B&x=1&empty=", "https://sns-v11.rednotecdn.com/a%2fb?x=%2B&x=1&empty=", "allowed"},
		{"http://sns-v27.rednotecdn.com/z?foo=1", "https://sns-v27.rednotecdn.com/z?foo=1", "allowed"},
		{"https://sns-v11.rednotecdn.com/a%2fb?x=%2B&x=1&empty=", "https://sns-v11.rednotecdn.com/a%2fb?x=%2B&x=1&empty=", "allowed"},
		{"http://sns-v28.rednotecdn.com/new%2Fobject?sig=a%2Bb+z&part=1&part=2&empty=", "https://sns-v28.rednotecdn.com/new%2Fobject?sig=a%2Bb+z&part=1&part=2&empty=", "allowed"},
		{"http://media.new-provider.example.test/a?token=%2b%2B", "https://media.new-provider.example.test/a?token=%2b%2B", ""},
		{"HTTP://New-Node.example.test/a?sig=A%2Fz", "https://New-Node.example.test/a?sig=A%2Fz", ""},
		{"http:///missing-host", "http:///missing-host", ""},
		{"http://new-node.example.test:/a", "http://new-node.example.test:/a", ""},
		{"http://new-node.example.test:8080/a", "http://new-node.example.test:8080/a", ""},
		{"http://new-node.example.test/a\u007f", "http://new-node.example.test/a\u007f", ""},
		{"http://user@sns-v11.rednotecdn.com/a", "http://user@sns-v11.rednotecdn.com/a", ""},
		{"http://sns-v11.rednotecdn.com:80/a", "http://sns-v11.rednotecdn.com:80/a", ""},
		{"http://sns-v11.rednotecdn.com\\@evil.test/a", "http://sns-v11.rednotecdn.com\\@evil.test/a", ""},
		{"http://SNS-V11.rednotecdn.com/a", "https://SNS-V11.rednotecdn.com/a", "allowed"},
		{"http://ſns-v11.rednotecdn.com/a", "http://ſns-v11.rednotecdn.com/a", ""},
		{"", "", ""},
	}
	source := func(id, address string) unified.Object {
		return unified.Object{"id": id, "url": address, "access": "direct", "expires_at": "2030-01-01T00:00:00Z"}
	}
	sources := unified.Array{}
	for i, c := range cases {
		sources = append(sources, source(string(rune('a'+i)), c.raw))
	}
	sources = append(sources, unified.Object{"id": "relay", "url": cases[0].raw, "access": "relay", "availability": "unavailable", "expires_at": "2027-01-01T00:00:00Z"})
	// Same-source credential routes are mapped in place too, never sorted or dropped.
	unified.Map(sources[0])["fallback_urls"] = unified.Array{
		"http://future-a.example.test/path?sig=old%2Btoken",
		"https://future-b.example.test/path?sig=new+token",
	}
	motion := unified.Object{"id": "motion", "role": "motion", "delivery": unified.Object{"kind": "file", "sources": sources}}
	image := unified.Object{"id": "image", "role": "image", "delivery": unified.Object{"kind": "file", "sources": unified.Array{source("still", cases[0].raw)}}}
	pair := unified.Object{"kind": "pair", "resources": unified.Array{image, motion}}
	item := unified.Object{"id": "live", "type": "live_photo", "default": nil, "variants": unified.Array{unified.Object{"id": "v", "delivery": pair}, unified.Object{"id": "v2", "delivery": unified.Clone(pair)}}}
	nonMediaItem := unified.Object{"id": "still-item", "type": "image", "variants": unified.Array{unified.Object{"delivery": unified.Clone(pair)}}}
	payload := unified.Object{"code": "OK", "data": unified.Object{"cover": unified.Object{"url": cases[0].raw}, "items": unified.Array{item, nonMediaItem}}}
	before := unified.Clone(payload)
	got, err := PreparePublic(context.Background(), "xiaohongshu", payload, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(payload, before) {
		t.Fatal("input mutated")
	}
	expected := unified.Clone(before)
	variants := unified.Slice(unified.Map(unified.Slice(unified.Map(expected["data"])["items"])[0])["variants"])
	actualVariants := unified.Slice(unified.Map(unified.Slice(unified.Map(got["data"])["items"])[0])["variants"])
	for n, v := range variants {
		resource := unified.Map(unified.Slice(unified.Map(unified.Map(v)["delivery"])["resources"])[1])
		expectedSources := unified.Slice(unified.Map(resource["delivery"])["sources"])
		unified.Map(expectedSources[0])["fallback_urls"] = unified.Array{
			"https://future-a.example.test/path?sig=old%2Btoken",
			"https://future-b.example.test/path?sig=new+token",
		}
		actualResource := unified.Map(unified.Slice(unified.Map(unified.Map(actualVariants[n])["delivery"])["resources"])[1])
		actualSources := unified.Slice(unified.Map(actualResource["delivery"])["sources"])
		for i, c := range cases {
			unified.Map(expectedSources[i])["url"] = c.want
			if c.wantFetch != "" {
				unified.Map(expectedSources[i])["browser_fetch"] = c.wantFetch
			}
			if address := unified.Map(actualSources[i])["url"]; address != c.want {
				t.Errorf("variant %d source %d: got %q want %q", n, i, address, c.want)
			}
		}
	}
	// On non-live_photo / non-video items (e.g. type=="image"), http:// URLs are not upgraded,
	// while already-HTTPS direct sources on verified CDN hosts receive browser_fetch: "allowed".
	nonMediaExpectedVariant := unified.Map(unified.Slice(unified.Map(unified.Slice(unified.Map(expected["data"])["items"])[1])["variants"])[0])
	nonMediaExpectedResource := unified.Map(unified.Slice(unified.Map(nonMediaExpectedVariant["delivery"])["resources"])[1])
	nonMediaExpectedSources := unified.Slice(unified.Map(nonMediaExpectedResource["delivery"])["sources"])
	unified.Map(nonMediaExpectedSources[2])["browser_fetch"] = "allowed"
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("public payload differs from expected:\ngot:  %#v\nwant: %#v", got, expected)
	}
	again, err := PreparePublic(context.Background(), "xiaohongshu", got, 0)
	if err != nil || !reflect.DeepEqual(again, got) {
		t.Fatal("not idempotent", err)
	}
	other, err := PreparePublic(context.Background(), "douyin", payload, 0)
	if err != nil || !reflect.DeepEqual(other, before) {
		t.Fatal("other platform changed", err)
	}
}

func TestPreparePublicVideoHTTPSUpgradeAndBrowserFetch(t *testing.T) {
	const now int64 = 1793448000

	t.Run("original-plus-http-transcode-routes", func(t *testing.T) {
		const html = `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"6a7e74de0000000033033075":{"note":{"noteId":"6a7e74de0000000033033075","type":"video","title":"XHS video","video":{"media":{"stream":{"h264":[{"masterUrl":"http://sns-v11.rednotecdn.com/stream/110/258/01e.mp4?sig=a%2Bb+z","backupUrls":["http://sns-v27.rednotecdn.com/stream/110/258/01e.mp4?sig=a%2Bb+z"],"width":720,"height":1280,"size":6134169}]}},"consumer":{"originVideoKey":"spectrum/1040g00g31000000"}}}}}}};</script>`
		mp4Header := append([]byte{0, 0, 0, 24}, []byte("ftypisom\x00\x00\x02\x00isomiso2")...)
		executor := requestFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			if req.Policy.Purpose == "media-probe" {
				if req.URL == "https://sns-video-qc.xhscdn.com/spectrum/1040g00g31000000" {
					return fetch.Response{StatusCode: http.StatusForbidden}, nil
				}
				return fetch.Response{StatusCode: http.StatusPartialContent, Body: mp4Header}, nil
			}
			return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(html)}, nil
		})
		parsed, err := New(executor).Parse(context.Background(), "https://www.xiaohongshu.com/explore/6a7e74de0000000033033075", now)
		if err != nil || parsed["code"] != "OK" {
			t.Fatalf("Parse failed: code=%v err=%v", parsed["code"], err)
		}

		out, err := PreparePublic(context.Background(), "xiaohongshu", parsed, now)
		if err != nil {
			t.Fatalf("PreparePublic failed: %v", err)
		}
		if err := unified.ValidateEnvelopeAt(out, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed after PreparePublic: %v", err)
		}
		publicOut := unified.PublicView(out, false, now)
		if err := unified.ValidateEnvelopeAt(publicOut, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed after PublicView: %v", err)
		}

		item := unified.Map(unified.Slice(unified.Map(publicOut["data"])["items"])[0])
		variants := unified.Slice(item["variants"])
		if len(variants) != 2 {
			t.Fatalf("expected 2 variants, got %d", len(variants))
		}
		transcodeSources := unified.Slice(unified.Map(unified.Map(variants[0])["delivery"])["sources"])
		wantTranscode := []string{
			"https://sns-v11.rednotecdn.com/stream/110/258/01e.mp4?sig=a%2Bb+z",
			"https://sns-v27.rednotecdn.com/stream/110/258/01e.mp4?sig=a%2Bb+z",
		}
		if len(transcodeSources) != 2 {
			t.Fatalf("expected 2 transcode sources, got %d", len(transcodeSources))
		}
		for i, want := range wantTranscode {
			src := unified.Map(transcodeSources[i])
			if got := unified.Str(src["url"]); got != want {
				t.Fatalf("transcode source[%d] url=%q, want %q", i, got, want)
			}
			if got := unified.Str(src["browser_fetch"]); got != "allowed" {
				t.Fatalf("transcode source[%d] browser_fetch=%q, want allowed", i, got)
			}
		}

		origSources := unified.Slice(unified.Map(unified.Map(variants[1])["delivery"])["sources"])
		if len(origSources) != 4 {
			t.Fatalf("expected 4 original xhscdn sources, got %d", len(origSources))
		}
		for i, raw := range origSources {
			src := unified.Map(raw)
			if got := unified.Str(src["browser_fetch"]); got != "allowed" {
				t.Fatalf("original source[%d] (%s) browser_fetch=%q, want allowed", i, unified.Str(src["url"]), got)
			}
		}
	})

	t.Run("http-only-video-updates-default-projection-and-preserves-explicit-browser-fetch", func(t *testing.T) {
		const html = `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"6a0000000000000000000001":{"note":{"noteId":"6a0000000000000000000001","type":"video","title":"HTTP-only video","video":{"media":{"stream":{"h264":[{"masterUrl":"http://sns-v11.rednotecdn.com/stream/only.mp4?sig=a%2Bb+z","backupUrls":["http://sns-v27.rednotecdn.com/stream/only.mp4?sig=a%2Bb+z","https://ci.xiaohongshu.com/non-cors-range.mp4"],"width":720,"height":1280}]}}}}}}}}</script>`
		executor := requestFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(html)}, nil
		})
		parsed, err := New(executor).Parse(context.Background(), "https://www.xiaohongshu.com/explore/6a0000000000000000000001", now)
		if err != nil || parsed["code"] != "OK" {
			t.Fatalf("Parse failed: code=%v err=%v", parsed["code"], err)
		}

		// Mark second source as explicitly blocked to ensure PreparePublic never overwrites it.
		v0 := unified.Map(unified.Slice(unified.Map(unified.Slice(unified.Map(parsed["data"])["items"])[0])["variants"])[0])
		sList := unified.Slice(unified.Map(v0["delivery"])["sources"])
		unified.Map(sList[1])["browser_fetch"] = "blocked"

		out, err := PreparePublic(context.Background(), "xiaohongshu", parsed, now)
		if err != nil {
			t.Fatalf("PreparePublic failed: %v", err)
		}
		if err := unified.ValidateEnvelopeAt(out, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed after PreparePublic: %v", err)
		}
		item := unified.Map(unified.Slice(unified.Map(out["data"])["items"])[0])
		if got := unified.Str(unified.Map(item["default"])["url"]); got != "https://sns-v11.rednotecdn.com/stream/only.mp4?sig=a%2Bb+z" {
			t.Fatalf("item.default.url = %q, want upgraded https URL", got)
		}
		gotSources := unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["sources"])
		if got := unified.Str(unified.Map(gotSources[0])["browser_fetch"]); got != "allowed" {
			t.Fatalf("source[0] browser_fetch=%q, want allowed", got)
		}
		if got := unified.Str(unified.Map(gotSources[1])["browser_fetch"]); got != "blocked" {
			t.Fatalf("source[1] explicit blocked overwritten: got %q", got)
		}
		if got := unified.Str(unified.Map(gotSources[1])["url"]); got != "https://sns-v27.rednotecdn.com/stream/only.mp4?sig=a%2Bb+z" {
			t.Fatalf("source[1] url=%q, want https upgrade", got)
		}
		if got := unified.Str(unified.Map(gotSources[2])["browser_fetch"]); got != "" {
			t.Fatalf("ci.xiaohongshu.com source[2] must not be marked allowed, got %q", got)
		}
	})
}

func TestDomesticXHSMirrorURL(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		kind   xhsMirrorKind
		want   string
		wantOK bool
	}{
		{
			name:   "image-valid-lowercase-hex",
			raw:    "https://sns-web-i10.rednotecdn.com/202611220730/0123456789abcdef0123456789abcdef/notes_pre_post/1040g!nd_dft_wlteh_webp_3",
			kind:   xhsMirrorImage,
			want:   "https://sns-webpic-qc.xhscdn.com/202611220730/0123456789abcdef0123456789abcdef/notes_pre_post/1040g!nd_dft_wlteh_webp_3",
			wantOK: true,
		},
		{
			name:   "image-valid-uppercase-hex-host-default-port",
			raw:    "https://SNS-WEB-I10.rednotecdn.com:443/202611220730/ABCDEF0123456789ABCDEF0123456789/pic.webp",
			kind:   xhsMirrorImage,
			want:   "https://sns-webpic-qc.xhscdn.com/202611220730/ABCDEF0123456789ABCDEF0123456789/pic.webp",
			wantOK: true,
		},
		{
			name:   "video-valid-v11",
			raw:    "https://sns-v11.rednotecdn.com/stream/110/258/01e7f_258.mp4",
			kind:   xhsMirrorVideo,
			want:   "https://sns-bak-v1.xhscdn.com/stream/110/258/01e7f_258.mp4",
			wantOK: true,
		},
		{
			name:   "video-valid-v27-uppercase-default-port",
			raw:    "https://SNS-V27.rednotecdn.com:443/stream/1/110/258/01e-a.b_c.mp4",
			kind:   xhsMirrorVideo,
			want:   "https://sns-bak-v1.xhscdn.com/stream/1/110/258/01e-a.b_c.mp4",
			wantOK: true,
		},
		// Strict negative guards
		{
			name: "image-with-query-sign-rejected",
			raw:  "https://sns-web-i10.rednotecdn.com/202611220730/0123456789abcdef0123456789abcdef/pic.webp?sign=abc",
			kind: xhsMirrorImage,
		},
		{
			name: "image-with-empty-query-rejected",
			raw:  "https://sns-web-i10.rednotecdn.com/202611220730/0123456789abcdef0123456789abcdef/pic.webp?",
			kind: xhsMirrorImage,
		},
		{
			name: "image-with-fragment-rejected",
			raw:  "https://sns-web-i10.rednotecdn.com/202611220730/0123456789abcdef0123456789abcdef/pic.webp#frag",
			kind: xhsMirrorImage,
		},
		{
			name: "image-with-userinfo-rejected",
			raw:  "https://user@sns-web-i10.rednotecdn.com/202611220730/0123456789abcdef0123456789abcdef/pic.webp",
			kind: xhsMirrorImage,
		},
		{
			name: "image-with-non-default-port-rejected",
			raw:  "https://sns-web-i10.rednotecdn.com:8443/202611220730/0123456789abcdef0123456789abcdef/pic.webp",
			kind: xhsMirrorImage,
		},
		{
			name: "image-http-rejected",
			raw:  "http://sns-web-i10.rednotecdn.com/202611220730/0123456789abcdef0123456789abcdef/pic.webp",
			kind: xhsMirrorImage,
		},
		{
			name: "image-other-host-rejected",
			raw:  "https://sns-web-i11.rednotecdn.com/202611220730/0123456789abcdef0123456789abcdef/pic.webp",
			kind: xhsMirrorImage,
		},
		{
			name: "image-bad-path-no-timestamp-rejected",
			raw:  "https://sns-web-i10.rednotecdn.com/notes_pre_post/abc!nd_dft_wlteh_webp_3",
			kind: xhsMirrorImage,
		},
		{
			name: "image-bad-path-11-digits-rejected",
			raw:  "https://sns-web-i10.rednotecdn.com/20261122073/0123456789abcdef0123456789abcdef/pic.webp",
			kind: xhsMirrorImage,
		},
		{
			name: "image-bad-path-non-hex-rejected",
			raw:  "https://sns-web-i10.rednotecdn.com/202611220730/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/pic.webp",
			kind: xhsMirrorImage,
		},
		{
			name: "image-bad-path-empty-tail-rejected",
			raw:  "https://sns-web-i10.rednotecdn.com/202611220730/0123456789abcdef0123456789abcdef/",
			kind: xhsMirrorImage,
		},
		{
			name: "image-dotdot-traversal-rejected",
			raw:  "https://sns-web-i10.rednotecdn.com/202611220730/0123456789abcdef0123456789abcdef/../secret",
			kind: xhsMirrorImage,
		},
		{
			name: "video-with-query-sign-rejected",
			raw:  "https://sns-v11.rednotecdn.com/stream/110/258/01e.mp4?sign=abc",
			kind: xhsMirrorVideo,
		},
		{
			name: "video-with-query-sig-rejected",
			raw:  "https://sns-v27.rednotecdn.com/stream/110/258/01e.mp4?sig=a%2Bb+z",
			kind: xhsMirrorVideo,
		},
		{
			name: "video-with-empty-query-rejected",
			raw:  "https://sns-v11.rednotecdn.com/stream/110/258/01e.mp4?",
			kind: xhsMirrorVideo,
		},
		{
			name: "video-with-fragment-rejected",
			raw:  "https://sns-v11.rednotecdn.com/stream/110/258/01e.mp4#t=1",
			kind: xhsMirrorVideo,
		},
		{
			name: "video-with-userinfo-rejected",
			raw:  "https://user@sns-v11.rednotecdn.com/stream/110/258/01e.mp4",
			kind: xhsMirrorVideo,
		},
		{
			name: "video-with-non-default-port-rejected",
			raw:  "https://sns-v11.rednotecdn.com:8443/stream/110/258/01e.mp4",
			kind: xhsMirrorVideo,
		},
		{
			name: "video-with-trailing-colon-rejected",
			raw:  "https://sns-v11.rednotecdn.com:/stream/110/258/01e.mp4",
			kind: xhsMirrorVideo,
		},
		{
			name: "video-other-rednotecdn-host-rejected",
			raw:  "https://sns-v28.rednotecdn.com/stream/110/258/01e.mp4",
			kind: xhsMirrorVideo,
		},
		{
			name: "video-xhscdn-v6-never-rewritten",
			raw:  "https://sns-video-v6.xhscdn.com/stream/110/258/01e.mp4",
			kind: xhsMirrorVideo,
		},
		{
			name: "video-non-stream-path-rejected",
			raw:  "https://sns-v11.rednotecdn.com/spectrum/1040g00g31000000.mp4",
			kind: xhsMirrorVideo,
		},
		{
			name: "video-non-mp4-rejected",
			raw:  "https://sns-v11.rednotecdn.com/stream/110/258/01e.m3u8",
			kind: xhsMirrorVideo,
		},
		{
			name: "video-dotdot-traversal-rejected",
			raw:  "https://sns-v11.rednotecdn.com/stream/../01e.mp4",
			kind: xhsMirrorVideo,
		},
		{
			name: "cross-kind-image-on-video-rejected",
			raw:  "https://sns-web-i10.rednotecdn.com/202611220730/0123456789abcdef0123456789abcdef/pic.webp",
			kind: xhsMirrorVideo,
		},
		{
			name: "cross-kind-video-on-image-rejected",
			raw:  "https://sns-v11.rednotecdn.com/stream/110/258/01e.mp4",
			kind: xhsMirrorImage,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := domesticXHSMirrorURL(tc.raw, tc.kind)
			if ok != tc.wantOK || got != tc.want {
				t.Fatalf("domesticXHSMirrorURL(%q, %d) = (%q, %v), want (%q, %v)", tc.raw, tc.kind, got, ok, tc.want, tc.wantOK)
			}
			if strings.Contains(got, "sns-video-v6.xhscdn.com") {
				t.Fatalf("must never emit sns-video-v6.xhscdn.com: %q", got)
			}
		})
	}
}

func TestPreparePublicPrependDomesticXHSMirrors(t *testing.T) {
	const now int64 = 1793448000

	assertUniqueIDsAndBrowserFetch := func(t *testing.T, sources unified.Array, wantURLs []string) {
		t.Helper()
		if len(sources) != len(wantURLs) {
			t.Fatalf("sources len = %d, want %d (%#v)", len(sources), len(wantURLs), sources)
		}
		seenIDs := map[string]bool{}
		for i, wantURL := range wantURLs {
			src := unified.Map(sources[i])
			gotURL := unified.Str(src["url"])
			if gotURL != wantURL {
				t.Fatalf("source[%d].url = %q, want %q", i, gotURL, wantURL)
			}
			if gotFetch := unified.Str(src["browser_fetch"]); gotFetch != "allowed" {
				t.Fatalf("source[%d].browser_fetch = %q, want allowed", i, gotFetch)
			}
			if len(sources) > 1 {
				id := unified.Str(src["id"])
				if id == "" {
					t.Fatalf("source[%d] missing required id when len(sources)>1: %#v", i, src)
				}
				if seenIDs[id] {
					t.Fatalf("duplicate source id %q in %#v", id, sources)
				}
				seenIDs[id] = true
			}
		}
	}

	t.Run("image-album-rednotecdn-prepends-webpic-qc-and-aligns-default", func(t *testing.T) {
		const (
			unsignedPath = "/202611220730/0123456789abcdef0123456789abcdef/notes_pre_post/1040g!nd_dft_wlteh_webp_3"
			unsignedHTTP = "http://sns-web-i10.rednotecdn.com" + unsignedPath
			unsignedOrig = "https://sns-web-i10.rednotecdn.com" + unsignedPath
			unsignedCN   = "https://sns-webpic-qc.xhscdn.com" + unsignedPath
			signedOrig   = "https://sns-web-i10.rednotecdn.com/202611220730/0123456789abcdef0123456789abcdef/notes_pre_post/signed!nd_dft?sign=abc"
			legacyOrig   = "https://sns-web-i10.rednotecdn.com/notes_pre_post/legacy!nd_dft"
		)
		html := `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"6a7e74de0000000033033071":{"note":{"noteId":"6a7e74de0000000033033071","type":"normal","title":"XHS images","imageList":[{"url":"","urlDefault":"` + unsignedHTTP + `"},{"url":"","urlDefault":"` + signedOrig + `"},{"url":"","urlDefault":"` + legacyOrig + `"}]}}}}};</script>`
		executor := requestFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(html)}, nil
		})
		parsed, err := New(executor).Parse(context.Background(), "https://www.xiaohongshu.com/explore/6a7e74de0000000033033071", now)
		if err != nil || parsed["code"] != "OK" {
			t.Fatalf("Parse failed: code=%v err=%v", parsed["code"], err)
		}
		before := unified.Clone(parsed)

		out, err := PreparePublic(context.Background(), "xiaohongshu", parsed, now)
		if err != nil {
			t.Fatalf("PreparePublic failed: %v", err)
		}
		if !reflect.DeepEqual(parsed, before) {
			t.Fatal("PreparePublic mutated input")
		}
		if err := unified.ValidateEnvelopeAt(out, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt(out) failed: %v", err)
		}
		for _, debug := range []bool{false, true} {
			pub := unified.PublicView(out, debug, now)
			if err := unified.ValidateEnvelopeAt(pub, now); err != nil {
				t.Fatalf("ValidateEnvelopeAt(PublicView debug=%v) failed: %v", debug, err)
			}
			items := unified.Slice(unified.Map(pub["data"])["items"])
			if len(items) != 3 {
				t.Fatalf("expected 3 image items, got %d", len(items))
			}

			// Item 0: unsigned sns-web-i10.rednotecdn.com -> prepends sns-webpic-qc.xhscdn.com + aligns default + unique IDs
			img0 := unified.Map(items[0])
			img0Sources := unified.Slice(unified.Map(unified.Map(unified.Slice(img0["variants"])[0])["delivery"])["sources"])
			assertUniqueIDsAndBrowserFetch(t, img0Sources, []string{unsignedCN, unsignedOrig})
			def0 := unified.Map(img0["default"])
			if unified.Str(def0["url"]) != unsignedCN || unified.Str(def0["source_id"]) != unified.Str(unified.Map(img0Sources[0])["id"]) {
				t.Fatalf("image-1 default mismatch: got %#v, want url=%q source_id=%q", def0, unsignedCN, unified.Map(img0Sources[0])["id"])
			}

			// Item 1: query-signed -> untouched (1 source)
			img1 := unified.Map(items[1])
			img1Sources := unified.Slice(unified.Map(unified.Map(unified.Slice(img1["variants"])[0])["delivery"])["sources"])
			assertUniqueIDsAndBrowserFetch(t, img1Sources, []string{signedOrig})
			if unified.Str(unified.Map(img1["default"])["url"]) != signedOrig {
				t.Fatalf("signed image default changed: %#v", img1["default"])
			}

			// Item 2: non-matching path -> untouched (1 source)
			img2 := unified.Map(items[2])
			img2Sources := unified.Slice(unified.Map(unified.Map(unified.Slice(img2["variants"])[0])["delivery"])["sources"])
			assertUniqueIDsAndBrowserFetch(t, img2Sources, []string{legacyOrig})
		}

		// Idempotency check
		again, err := PreparePublic(context.Background(), "xiaohongshu", out, now)
		if err != nil || !reflect.DeepEqual(again, out) {
			t.Fatalf("PreparePublic not idempotent for images: err=%v", err)
		}
	})

	t.Run("video-unsigned-rednotecdn-prepends-deduplicated-bak-v1-and-aligns-default", func(t *testing.T) {
		const (
			streamPath = "/stream/110/258/01e7f_258.mp4"
			v11HTTP    = "http://sns-v11.rednotecdn.com" + streamPath
			v27HTTP    = "http://sns-v27.rednotecdn.com" + streamPath
			v11HTTPS   = "https://sns-v11.rednotecdn.com" + streamPath
			v27HTTPS   = "https://sns-v27.rednotecdn.com" + streamPath
			bakV1CN    = "https://sns-bak-v1.xhscdn.com" + streamPath
		)
		html := `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"6a7e74de0000000033033072":{"note":{"noteId":"6a7e74de0000000033033072","type":"video","title":"XHS unsigned video","video":{"media":{"stream":{"h264":[{"masterUrl":"` + v11HTTP + `","backupUrls":["` + v27HTTP + `"],"width":720,"height":1280,"size":5000000}]}}}}}}}};</script>`
		executor := requestFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(html)}, nil
		})
		parsed, err := New(executor).Parse(context.Background(), "https://www.xiaohongshu.com/explore/6a7e74de0000000033033072", now)
		if err != nil || parsed["code"] != "OK" {
			t.Fatalf("Parse failed: code=%v err=%v", parsed["code"], err)
		}
		origSources := unified.Slice(unified.Map(unified.Map(unified.Slice(unified.Map(unified.Slice(unified.Map(parsed["data"])["items"])[0])["variants"])[0])["delivery"])["sources"])
		origID0 := unified.Str(unified.Map(origSources[0])["id"])
		origID1 := unified.Str(unified.Map(origSources[1])["id"])

		out, err := PreparePublic(context.Background(), "xiaohongshu", parsed, now)
		if err != nil {
			t.Fatalf("PreparePublic failed: %v", err)
		}
		if err := unified.ValidateEnvelopeAt(out, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt(out) failed: %v", err)
		}
		pub := unified.PublicView(out, false, now)
		if err := unified.ValidateEnvelopeAt(pub, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt(pub) failed: %v", err)
		}
		encoded, _ := unified.Encode(pub)
		if strings.Contains(string(encoded), "sns-video-v6.xhscdn.com") {
			t.Fatalf("must never emit sns-video-v6.xhscdn.com: %s", encoded)
		}

		item := unified.Map(unified.Slice(unified.Map(pub["data"])["items"])[0])
		sources := unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["sources"])
		assertUniqueIDsAndBrowserFetch(t, sources, []string{bakV1CN, v11HTTPS, v27HTTPS})
		if unified.Str(unified.Map(sources[1])["id"]) != origID0 || unified.Str(unified.Map(sources[2])["id"]) != origID1 {
			t.Fatalf("original source IDs changed: got (%q, %q), want (%q, %q)", unified.Map(sources[1])["id"], unified.Map(sources[2])["id"], origID0, origID1)
		}
		def := unified.Map(item["default"])
		if unified.Str(def["url"]) != bakV1CN || unified.Str(def["source_id"]) != unified.Str(unified.Map(sources[0])["id"]) {
			t.Fatalf("video default mismatch: got %#v, want url=%q source_id=%q", def, bakV1CN, unified.Map(sources[0])["id"])
		}

		again, err := PreparePublic(context.Background(), "xiaohongshu", out, now)
		if err != nil || !reflect.DeepEqual(again, out) {
			t.Fatalf("PreparePublic not idempotent for video: err=%v", err)
		}
	})

	t.Run("video-signed-and-other-hosts-untouched", func(t *testing.T) {
		const (
			signedV11 = "http://sns-v11.rednotecdn.com/stream/110/258/01e.mp4?sign=xyz"
			otherV28  = "http://sns-v28.rednotecdn.com/stream/110/258/01e.mp4"
		)
		html := `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"6a7e74de0000000033033073":{"note":{"noteId":"6a7e74de0000000033033073","type":"video","title":"XHS signed+other","video":{"media":{"stream":{"h264":[{"masterUrl":"` + signedV11 + `","backupUrls":["` + otherV28 + `"],"width":720,"height":1280}]}}}}}}}};</script>`
		executor := requestFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(html)}, nil
		})
		parsed, err := New(executor).Parse(context.Background(), "https://www.xiaohongshu.com/explore/6a7e74de0000000033033073", now)
		if err != nil || parsed["code"] != "OK" {
			t.Fatalf("Parse failed: code=%v err=%v", parsed["code"], err)
		}
		out, err := PreparePublic(context.Background(), "xiaohongshu", parsed, now)
		if err != nil {
			t.Fatalf("PreparePublic failed: %v", err)
		}
		if err := unified.ValidateEnvelopeAt(out, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		item := unified.Map(unified.Slice(unified.Map(out["data"])["items"])[0])
		sources := unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["sources"])
		assertUniqueIDsAndBrowserFetch(t, sources, []string{
			"https://sns-v11.rednotecdn.com/stream/110/258/01e.mp4?sign=xyz",
			"https://sns-v28.rednotecdn.com/stream/110/258/01e.mp4",
		})
		if unified.Str(unified.Map(item["default"])["url"]) != "https://sns-v11.rednotecdn.com/stream/110/258/01e.mp4?sign=xyz" {
			t.Fatalf("unexpected default change: %#v", item["default"])
		}
	})

	t.Run("live-photo-unsigned-image-and-motion-both-prepend-mirrors", func(t *testing.T) {
		const (
			imgPath    = "/202611220730/0123456789abcdef0123456789abcdef/1040g00831live!nd_dft_wlteh_webp_3"
			imgHTTP    = "http://sns-web-i10.rednotecdn.com" + imgPath
			imgOrig    = "https://sns-web-i10.rednotecdn.com" + imgPath
			imgCN      = "https://sns-webpic-qc.xhscdn.com" + imgPath
			motionPath = "/stream/110/258/live01.mp4"
			v11HTTP    = "http://sns-v11.rednotecdn.com" + motionPath
			v27HTTP    = "http://sns-v27.rednotecdn.com" + motionPath
			v11HTTPS   = "https://sns-v11.rednotecdn.com" + motionPath
			v27HTTPS   = "https://sns-v27.rednotecdn.com" + motionPath
			bakV1CN    = "https://sns-bak-v1.xhscdn.com" + motionPath
		)
		html := `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"6a7e74de0000000033033074":{"note":{"noteId":"6a7e74de0000000033033074","type":"normal","title":"XHS live photo","imageList":[{"url":"","urlDefault":"` + imgHTTP + `","stream":{"h264":[{"masterUrl":"` + v11HTTP + `","backupUrls":["` + v27HTTP + `"],"width":720,"height":960}]}}]}}}}};</script>`
		executor := requestFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(html)}, nil
		})
		parsed, err := New(executor).Parse(context.Background(), "https://www.xiaohongshu.com/explore/6a7e74de0000000033033074", now)
		if err != nil || parsed["code"] != "OK" {
			t.Fatalf("Parse failed: code=%v err=%v", parsed["code"], err)
		}
		out, err := PreparePublic(context.Background(), "xiaohongshu", parsed, now)
		if err != nil {
			t.Fatalf("PreparePublic failed: %v", err)
		}
		if err := unified.ValidateEnvelopeAt(out, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt(out) failed: %v", err)
		}
		for _, debug := range []bool{false, true} {
			pub := unified.PublicView(out, debug, now)
			if err := unified.ValidateEnvelopeAt(pub, now); err != nil {
				t.Fatalf("ValidateEnvelopeAt(PublicView debug=%v) failed: %v", debug, err)
			}
			item := unified.Map(unified.Slice(unified.Map(pub["data"])["items"])[0])
			if unified.Str(item["type"]) != "live_photo" || item["default"] != nil || unified.Str(item["default_unavailable_reason"]) != "processing_required" {
				t.Fatalf("live_photo envelope invariant broken: %#v", item)
			}
			resources := unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["resources"])
			if len(resources) != 2 {
				t.Fatalf("expected 2 pair resources, got %d", len(resources))
			}
			for _, rawRes := range resources {
				res := unified.Map(rawRes)
				srcs := unified.Slice(unified.Map(res["delivery"])["sources"])
				switch unified.Str(res["role"]) {
				case "image":
					assertUniqueIDsAndBrowserFetch(t, srcs, []string{imgCN, imgOrig})
				case "motion":
					assertUniqueIDsAndBrowserFetch(t, srcs, []string{bakV1CN, v11HTTPS, v27HTTPS})
				default:
					t.Fatalf("unexpected pair role: %q", res["role"])
				}
			}
		}

		again, err := PreparePublic(context.Background(), "xiaohongshu", out, now)
		if err != nil || !reflect.DeepEqual(again, out) {
			t.Fatalf("PreparePublic not idempotent for live_photo: err=%v", err)
		}
	})

	t.Run("cloned-mirror-strips-cross-origin-fallbacks-and-skips-unavailable", func(t *testing.T) {
		const (
			goodPath = "/stream/110/258/ok.mp4"
			deadPath = "/stream/110/258/dead.mp4"
			goodOrig = "https://sns-v11.rednotecdn.com" + goodPath
			goodAlt  = "https://sns-v11.rednotecdn.com" + goodPath + "?alt=1"
			goodCN   = "https://sns-bak-v1.xhscdn.com" + goodPath
			deadOrig = "https://sns-v27.rednotecdn.com" + deadPath
		)
		payload := unified.FinalizeData(unified.Object{
			"platform":   "xiaohongshu",
			"source_url": "https://www.xiaohongshu.com/explore/6a7e74de0000000033033079",
			"items": unified.Array{
				unified.Object{
					"id":      "video",
					"type":    "video",
					"default": nil,
					"variants": unified.Array{
						unified.Object{
							"id": "v-main",
							"delivery": unified.Object{
								"kind": "file",
								"sources": unified.Array{
									unified.Object{"id": "s-dead", "url": deadOrig, "availability": "unavailable"},
									unified.Object{"id": "s-good", "url": goodOrig, "fallback_urls": unified.Array{goodAlt}},
								},
							},
						},
					},
				},
			},
		}, now)
		out, err := PreparePublic(context.Background(), "xiaohongshu", payload, now)
		if err != nil {
			t.Fatalf("PreparePublic failed: %v", err)
		}
		if err := unified.ValidateEnvelopeAt(out, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed (likely cross-origin fallback leak): %v", err)
		}
		item := unified.Map(unified.Slice(unified.Map(out["data"])["items"])[0])
		sources := unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["sources"])
		if len(sources) != 3 {
			t.Fatalf("expected 3 sources [cn-good, dead, orig-good], got %d: %#v", len(sources), sources)
		}
		cnSrc := unified.Map(sources[0])
		if unified.Str(cnSrc["url"]) != goodCN {
			t.Fatalf("sources[0].url = %q, want %q", cnSrc["url"], goodCN)
		}
		if _, hasFB := cnSrc["fallback_urls"]; hasFB {
			t.Fatalf("cloned domestic mirror must not inherit cross-origin fallback_urls: %#v", cnSrc)
		}
		if unified.Str(unified.Map(item["default"])["url"]) != goodCN {
			t.Fatalf("default.url = %q, want %q", unified.Map(item["default"])["url"], goodCN)
		}
	})
}
