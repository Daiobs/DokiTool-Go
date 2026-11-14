package xiaohongshu

import (
	"context"
	"net/http"
	"reflect"
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
