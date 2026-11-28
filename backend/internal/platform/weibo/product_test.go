package weibo

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

// The private responses are independent frozen PHP 8.3.6 formatter results;
// never generate adapter expectations from Go itself.
func TestWeiboProductAdapterConsumesPHPFormatter(t *testing.T) {
	body, err := os.ReadFile("testdata/php-formatter-baseline.json")
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := unified.Decode(body)
	if err != nil {
		t.Fatal(err)
	}
	if fixture["php_source_commit"] != "25beaee107f8c1a208ced9deb3c637068445e316" {
		t.Fatal("wrong PHP baseline")
	}
	cases := unified.Slice(fixture["cases"])
	if len(cases) != 29 {
		t.Fatalf("lost formatter cases: %d", len(cases))
	}
	for _, value := range cases {
		entry := unified.Map(value)
		t.Run(unified.Str(entry["id"]), func(t *testing.T) {
			legacy := unified.Clone(unified.Map(entry["expected"]))
			now := int64(1730000000)
			output := adaptLegacy(legacy, "https://weibo.com/1234567890/A1B2C3D4", now)
			if err := unified.ValidateEnvelopeAt(output, now); err != nil {
				t.Fatalf("adapter/schema mismatch: %v", err)
			}
			if output["code"] == "OK" {
				data := unified.Map(output["data"])
				if data["platform"] != "weibo" || len(unified.Slice(data["items"])) == 0 {
					t.Fatal("invalid work inventory")
				}
			}
			if !unified.Equal(legacy, entry["expected"]) {
				t.Fatal("private parser output mutated")
			}
		})
	}
}

func TestWeiboPreparePublicKeepsStableDirectSourceAndDefault(t *testing.T) {
	const raw = "https://f.video.weibocdn.com/hd.mp4?token=fixed"
	now := int64(1730000000)
	legacy := unified.Object{"code": 200, "data": unified.Object{
		"type": "video", "url": raw,
		"video_backup": unified.Array{
			unified.Object{"url": raw, "quality": "1080p", "width": 1920, "height": 1080},
			unified.Object{"url": "https://example.com/foreign.mp4", "quality": "360p"},
		},
	}}
	original := adaptLegacy(legacy, "https://weibo.com/1234567/AbC", now)
	snapshot := unified.Clone(original)
	prepared, err := PreparePublic(context.Background(), "weibo", original, now)
	if err != nil {
		t.Fatal(err)
	}
	item := unified.Map(unified.Slice(unified.Map(prepared["data"])["items"])[0])
	variants := unified.Slice(item["variants"])
	if len(variants) != 2 {
		t.Fatalf("lost variant candidates: %d", len(variants))
	}
	first := unified.Map(variants[0])
	source := unified.Map(unified.Slice(unified.Map(first["delivery"])["sources"])[0])
	if source["url"] != raw || source["access"] != "direct" || source["browser_fetch"] != "blocked" {
		t.Fatalf("unexpected direct source projection: %#v", source)
	}
	if _, hasDirect := source["direct_url"]; hasDirect {
		t.Fatalf("direct Weibo source must not carry redundant direct_url: %#v", source)
	}
	oldItem := unified.Map(unified.Slice(unified.Map(snapshot["data"])["items"])[0])
	oldVariant := unified.Map(unified.Slice(oldItem["variants"])[0])
	oldSource := unified.Map(unified.Slice(unified.Map(oldVariant["delivery"])["sources"])[0])
	if source["id"] != oldSource["id"] || first["id"] != oldVariant["id"] {
		t.Fatal("PreparePublic changed identity")
	}
	foreign := unified.Map(unified.Slice(unified.Map(unified.Map(variants[1])["delivery"])["sources"])[0])
	if foreign["availability"] != "unavailable" {
		t.Fatal("foreign source remained available")
	}
	if !unified.Equal(original, snapshot) {
		t.Fatal("PreparePublic mutated private inventory")
	}
	view := unified.PublicView(prepared, false, now)
	if err := unified.ValidateEnvelopeAt(view, now); err != nil {
		t.Fatal(err)
	}
	publicItem := unified.Map(unified.Slice(unified.Map(view["data"])["items"])[0])
	selected := unified.Map(publicItem["default"])
	if selected["url"] != raw || selected["source_id"] != source["id"] || selected["access"] == "relay" {
		t.Fatalf("default selection lost direct source: %#v", selected)
	}
	if len(unified.Slice(publicItem["variants"])) > len(variants) {
		t.Fatal("filtered view invented variants")
	}
}

// Two credential generations of a selected rendition must still address the
// same explicit choice via renewal.go's AllowedMediaURL check.
func TestWeiboLPRefreshPreservesExplicitFile(t *testing.T) {
	const file = "https://f.video.weibocdn.com/ab/object540.mp4?media_id=12345&template=540p&label=video"
	const now = int64(1730000000)
	type choice struct{ variant, source string }
	publicChoices := func(urls ...string) []choice {
		t.Helper()
		var candidates unified.Array
		for _, raw := range urls {
			candidates = append(candidates, unified.Object{"url": raw, "width": 540, "height": 960, "size": 844977})
		}
		legacy := unified.Object{"code": 200, "data": unified.Object{"url": urls[0], "video_backup": candidates}}
		out, err := PreparePublic(context.Background(), "weibo", adaptLegacy(legacy, "https://weibo.com/tv/show/1034:12345", now), now)
		if err != nil {
			t.Fatal(err)
		}
		out = unified.PublicView(out, false, now)
		if err := unified.ValidateEnvelopeAt(out, now); err != nil {
			t.Fatal(err)
		}
		item := unified.Map(unified.Slice(unified.Map(out["data"])["items"])[0])
		variants := unified.Slice(item["variants"])
		if len(variants) != len(urls) {
			t.Fatalf("lost candidates: got %d, want %d", len(variants), len(urls))
		}
		var got []choice
		for i, v := range variants {
			variant := unified.Map(v)
			sources := unified.Slice(unified.Map(variant["delivery"])["sources"])
			if len(sources) != 1 {
				t.Fatal("unexpected source merge")
			}
			source := unified.Map(sources[0])
			if unified.Str(source["url"]) != urls[i] || source["browser_fetch"] != "blocked" {
				t.Fatalf("delivery did not preserve exact incoming URL or browser_fetch=blocked: %#v", source)
			}
			got = append(got, choice{unified.Str(variant["id"]), unified.Str(source["id"])})
		}
		return got
	}
	const old = "&lp=oldRoute&uid=oldGuest&ab=trial-a&Expires=1900000010&ssig=old&KID=k"
	const fresh = "&lp=newRoute&uid=nextGuest&ab=trial-b&Expires=1900000020&ssig=new&KID=k"
	const plain = "&Expires=1900000010&ssig=other&KID=k"
	first := publicChoices(file+plain, file+old)
	next := publicChoices(file+fresh, file+plain)
	if first[1] != next[0] || first[0] != next[1] {
		t.Fatalf("refresh changed a choice: before %v, reordered after %v", first, next)
	}
	if publicChoices(file + strings.Replace(fresh, "newRoute", "oldRoute", 1))[0] != first[1] {
		t.Fatal("client query changes with an unchanged lp lost the explicit file")
	}
	for _, raw := range []string{
		strings.Replace(file, "object540", "other540", 1) + fresh,
		strings.Replace(file, "12345", "12346", 1) + fresh,
		strings.Replace(file, "540p", "other", 1) + fresh,
		file + "&extra=content" + fresh,
		file + strings.Replace(fresh, "&uid=nextGuest", "", 1),
	} {
		if publicChoices(raw)[0] == first[1] {
			t.Fatal("unrelated content inherited explicit choice")
		}
	}
	for _, other := range []string{fresh, strings.Replace(fresh, "newRoute", "oldRoute", 1)} {
		ambiguous := publicChoices(file+old, file+other)
		if ambiguous[0] == ambiguous[1] || ambiguous[0] == first[1] || ambiguous[1] == first[1] {
			t.Fatal("two simultaneously distinct observations must remain distinct from the unambiguous choice")
		}
	}
	for _, unproven := range []string{
		strings.Replace(file, "/ab/object540.mp4", "/other/shape", 1),
		strings.Replace(file, "template=", "other=", 1),
		file + "&lp=another",
	} {
		if publicChoices(unproven + old)[0] == publicChoices(unproven + fresh)[0] {
			t.Fatal("an unfamiliar or ambiguous URL shape lost its original identity")
		}
	}
}

func TestWeiboForeignOnlyFailsClosed(t *testing.T) {
	now := int64(1730000000)
	raw := unified.Object{"code": 200, "data": unified.Object{"type": "video",
		"video_backup": unified.Array{unified.Object{"url": "https://example.com/video.mp4"}}}}
	payload := adaptLegacy(raw, "https://weibo.com/1234567/AbC", now)
	result, err := PreparePublic(context.Background(), "weibo", payload, now)
	if err != nil || result["code"] != "UPSTREAM_INVALID_RESPONSE" {
		t.Fatal("unsupported provider not rejected")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := PreparePublic(ctx, "weibo", payload, now); err == nil {
		t.Fatal("canceled PreparePublic ran")
	}
}

func TestWeiboPreparePublicDirectURLUpgradeAndAllowedBoundary(t *testing.T) {
	const (
		now        int64 = 1730000000
		rawHTTP          = "http://f.video.weibocdn.com/hd.mp4?Expires=1900000000&ssig=a%2Bb+c"
		wantHTTPS        = "https://f.video.weibocdn.com/hd.mp4?Expires=1900000000&ssig=a%2Bb+c"
		badPort          = "http://f.video.weibocdn.com:80/bad.mp4"
		badForeign       = "https://evil.example.com/bad.mp4"
	)
	legacy := unified.Object{"code": 200, "data": unified.Object{
		"type": "video",
		"url":  rawHTTP,
		"video_backup": unified.Array{
			unified.Object{"url": rawHTTP, "quality": "1080p", "width": 1920, "height": 1080},
			unified.Object{"url": badPort, "quality": "720p", "width": 1280, "height": 720},
			unified.Object{"url": badForeign, "quality": "360p", "width": 640, "height": 360},
		},
	}}
	original := adaptLegacy(legacy, "https://weibo.com/1234567/AbC", now)
	prepared, err := PreparePublic(context.Background(), "weibo", original, now)
	if err != nil {
		t.Fatal(err)
	}
	view := unified.PublicView(prepared, false, now)
	if err := unified.ValidateEnvelopeAt(view, now); err != nil {
		t.Fatalf("PublicView failed validation: %v", err)
	}
	item := unified.Map(unified.Slice(unified.Map(view["data"])["items"])[0])
	def := unified.Map(item["default"])
	if def["url"] != wantHTTPS || def["access"] == "relay" {
		t.Fatalf("item.default must be direct HTTPS %q, got %#v", wantHTTPS, def)
	}
	if _, hasDirect := def["direct_url"]; hasDirect {
		t.Fatalf("item.default must not carry direct_url: %#v", def)
	}
	variants := unified.Slice(item["variants"])
	if len(variants) != 3 {
		t.Fatalf("expected all 3 variants preserved in PublicView, got %d", len(variants))
	}
	src := unified.Map(unified.Slice(unified.Map(unified.Map(variants[0])["delivery"])["sources"])[0])
	if src["availability"] == "unavailable" || src["url"] != wantHTTPS || src["browser_fetch"] != "blocked" {
		t.Fatalf("variants[0] source expected direct HTTPS + browser_fetch=blocked: %#v", src)
	}
	if _, hasDirect := src["direct_url"]; hasDirect {
		t.Fatalf("direct source must not emit redundant direct_url: %#v", src)
	}
	for _, idx := range []int{1, 2} {
		badSrc := unified.Map(unified.Slice(unified.Map(unified.Map(variants[idx])["delivery"])["sources"])[0])
		if badSrc["availability"] != "unavailable" {
			t.Fatalf("variants[%d] source availability = %v, want unavailable (%#v)", idx, badSrc["availability"], badSrc)
		}
		if _, hasDirect := badSrc["direct_url"]; hasDirect {
			t.Fatalf("variants[%d] rejected source must not carry direct_url: %#v", idx, badSrc)
		}
	}

	// AllowedMediaURL boundary checks.
	if !AllowedMediaURL("https://f.video.weibocdn.com/o0/abc.mp4") || !AllowedMediaURL("https://g.us.sinaimg.weibocdn.com/a.mp4") {
		t.Fatal("valid *.weibocdn.com URLs rejected")
	}
	for _, bad := range []string{
		"http://f.video.weibocdn.com/o0/abc.mp4",
		"https://weibocdn.com/o0/abc.mp4",
		"https://user:pass@f.video.weibocdn.com/o0/abc.mp4",
		"https://f.video.weibocdn.com:8443/o0/abc.mp4",
		"https://f.video.weibocdn.com/o0/abc.mp4#frag",
		"https://evil.example.com/o0/abc.mp4",
	} {
		if AllowedMediaURL(bad) {
			t.Fatalf("disallowed URL accepted: %q", bad)
		}
	}
}
