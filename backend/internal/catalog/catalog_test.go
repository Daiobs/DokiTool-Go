package catalog

import (
	"os"
	"reflect"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/config"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func TestCatalogUsesSingleRegistry(t *testing.T) {
	canonical, err := os.ReadFile("../../config/platforms.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(canonical) != string(config.Platforms()) {
		t.Fatal("embedded registry differs from sole registry")
	}
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := os.ReadFile("../../testdata/php-baseline/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	oracle, err := unified.Decode(baseline)
	if err != nil || !unified.Equal(c.Envelope(), oracle["expected"]) {
		t.Fatal("public catalogue differs from frozen PHP output")
	}
	rows := unified.Slice(unified.Map(c.Envelope()["data"])["platforms"])
	if len(rows) != 9 || unified.Map(rows[0])["id"] != "douyin" {
		t.Fatal("catalog order/size changed")
	}
	for _, value := range rows {
		row := unified.Map(value)
		if len(row) != 5 || row["file"] != nil || row["adapter"] != nil || row["domains"] != nil {
			t.Fatal("private registry field published")
		}
	}
}

func TestInputDomainBoundary(t *testing.T) {
	c, _ := Load()
	for raw, expected := range map[string]string{
		"https://www.douyin.com/video/a%ZZ": "douyin",
		"https://a..douyin.com/video/123":   "", "https://-.douyin.com/video/123": "",
		"https://www.douyin.com/video/中文": "", "https://www.douyin.com/video/%E4%B8%AD": "douyin",
		"https://v.douyin.com/share/": "douyin", "https://WWW.DOUYIN.COM:443/video/123": "douyin", "http://b23.tv/x?p=2": "bilibili", "https://www.rednote.com/explore/a": "xiaohongshu",
		"https://douyin.com.evil.example/video/1": "", "https://notdouyin.com/": "", "https://evil.example/?next=https://douyin.com": "", "https://user@douyin.com/": "", "https://douyin.com:8443/": "", "https://douyin.com\\@evil.example/": "", "file://douyin.com/": "", "https://douyin.com./": "",
		"https://share.xiaochuankeji.cn/hybrid/share/post?pid=163566379": "zuiyou",
		"http://SHARE.XIAOCHUANKEJI.CN:80/detail/163566379":              "zuiyou",
		"https://sub.share.xiaochuankeji.cn/hybrid/share/post?pid=1":     "",
		"https://www.share.xiaochuankeji.cn/hybrid/share/post?pid=1":     "",
		"https://xiaochuankeji.cn/hybrid/share/post?pid=1":               "",
		"https://evilshare.xiaochuankeji.cn/hybrid/share/post?pid=1":     "",
		"https://share.xiaochuankeji.cn.evil.com/hybrid/share/post":      "",
		"https://user:pass@share.xiaochuankeji.cn/hybrid/share/post":     "",
		"https://share.xiaochuankeji.cn:8080/hybrid/share/post":          "",
		"https://share.xiaochuankeji.cn:8443/hybrid/share/post":          "",
	} {
		if actual := c.PlatformForURL(raw); actual != expected {
			t.Errorf("%s => %q want %q", raw, actual, expected)
		}
	}

	if err := c.Register(XPlatform()); err != nil {
		t.Fatal(err)
	}
	if err := c.Register(InstagramPlatform()); err != nil {
		t.Fatal(err)
	}
	for raw, expected := range map[string]string{
		"https://t.co/Zgzhvix8ES":                 "x",
		"http://T.CO:80/Zgzhvix8ES":               "x",
		"https://sub.t.co/Zgzhvix8ES":             "x",
		"https://t.co:8443/Zgzhvix8ES":            "",
		"https://user@t.co/Zgzhvix8ES":            "",
		"https://nott.co/Zgzhvix8ES":              "",
		"https://t.co.evil.example/Zgzhvix8ES":    "",
		"https://instagr.am/p/aye83DjauH/":        "instagram",
		"https://www.instagr.am/reel/CTApqC8BGWd": "instagram",
		"http://INSTAGR.AM:80/tv/aye83DjauH/":     "instagram",
		"https://foo.instagr.am/p/aye83DjauH/":    "instagram",
		"https://instagr.am:8443/p/aye83DjauH/":   "",
		"https://user@instagr.am/p/aye83DjauH/":   "",
		"https://notinstagr.am/p/aye83DjauH/":     "",
		"https://instagr.am.evil.example/p/abc/":  "",
	} {
		if actual := c.PlatformForURL(raw); actual != expected {
			t.Errorf("%s => %q want %q", raw, actual, expected)
		}
	}
}

func TestCatalogExtraRegistryAndFacebookExactHost(t *testing.T) {
	canonicalExtra, err := os.ReadFile("../../config/platforms_extra.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(canonicalExtra) != string(config.PlatformsExtra()) {
		t.Fatal("embedded platforms_extra.json differs from canonical file")
	}

	wantExtraIDs := []string{"x", "youtube", "instagram", "facebook", "tumblr"}
	if got := ExtraPlatformIDs(); !reflect.DeepEqual(got, wantExtraIDs) {
		t.Fatalf("ExtraPlatformIDs() = %v, want %v", got, wantExtraIDs)
	}
	if _, ok := ExtraPlatform("unknown"); ok {
		t.Fatal("ExtraPlatform(unknown) must return ok=false")
	}

	// Convenience helpers must stay identical to ExtraPlatform and return defensive copies.
	for id, fn := range map[string]func() unified.Object{
		"x":         XPlatform,
		"youtube":   YouTubePlatform,
		"instagram": InstagramPlatform,
	} {
		extra, ok := ExtraPlatform(id)
		if !ok {
			t.Fatalf("ExtraPlatform(%q) returned ok=false", id)
		}
		got := fn()
		if !unified.Equal(got, extra) {
			t.Fatalf("%s helper %v != ExtraPlatform(%q) %v", id, got, id, extra)
		}
		got["name"] = "mutated"
		if unified.Str(fn()["name"]) == "mutated" {
			t.Fatalf("%s helper returned shared mutable map", id)
		}
	}

	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range wantExtraIDs {
		entry, ok := ExtraPlatform(id)
		if !ok {
			t.Fatalf("missing extra platform %q", id)
		}
		if _, leaked := entry["display_domains"]; leaked {
			t.Fatalf("ExtraPlatform(%q) must not include frontend-only display_domains in runtime catalog entry", id)
		}
		if err := c.Register(entry); err != nil {
			t.Fatalf("Register(%q) failed: %v", id, err)
		}
	}

	rows := unified.Slice(unified.Map(c.Envelope()["data"])["platforms"])
	if len(rows) != 14 {
		t.Fatalf("expected 14 registered platforms, got %d", len(rows))
	}
	for _, value := range rows {
		row := unified.Map(value)
		if len(row) != 5 || row["domains"] != nil || row["exact_domains"] != nil || row["display_domains"] != nil {
			t.Fatalf("private routing field leaked into Envelope(): %+v", row)
		}
	}

	// Trap 2 regression guard: Facebook MUST use exact_domains only, never suffix-matching
	// display_domains like facebook.com, so subdomains such as developers.facebook.com are rejected.
	for raw, expected := range map[string]string{
		"https://www.facebook.com/watch/?v=647537299265662": "facebook",
		"https://facebook.com/watch/?v=647537299265662":     "facebook",
		"https://m.facebook.com/watch/?v=647537299265662":   "facebook",
		"https://fb.watch/abc123/":                          "facebook",
		"https://developers.facebook.com/docs/video":        "",
		"https://business.facebook.com/watch/?v=1":          "",
		"https://graph.facebook.com/v18.0/video":            "",
		"https://web.facebook.com/watch/?v=647537299265662": "",
		"https://sub.fb.watch/abc123/":                      "",
		"https://www.fb.watch/abc123/":                      "",
		"https://evilfacebook.com/watch/?v=1":               "",
		"https://facebook.com.evil.example/watch/?v=1":      "",
		"https://tumblr.com/post/626907179849564160":        "tumblr",
		"https://www.tumblr.com/post/626907179849564160":    "tumblr",
		"https://blog.tumblr.com/post/626907179849564160":   "tumblr",
		"https://eviltumblr.com/post/626907179849564160":    "",
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ":       "youtube",
		"https://youtu.be/dQw4w9WgXcQ":                      "youtube",
		"https://x.com/user/status/12345":                   "x",
		"https://twitter.com/user/status/12345":             "x",
	} {
		if actual := c.PlatformForURL(raw); actual != expected {
			t.Errorf("PlatformForURL(%q) = %q, want %q", raw, actual, expected)
		}
	}
}

func TestDecodeExtraConfigValidation(t *testing.T) {
	invalidConfigs := map[string]string{
		"unknown-field":       `{"extra_platforms":[],"unexpected":true}`,
		"empty-extra":         `{"exact_domain_additions":{},"extra_platforms":[]}`,
		"duplicate-id":        `{"extra_platforms":[{"id":"x","name":"X","site_url":"https://x.com/","icon":"x","capabilities":["video"],"domains":["x.com"]},{"id":"x","name":"X2","site_url":"https://x.com/","icon":"x","capabilities":["video"],"domains":["twitter.com"]}]}`,
		"uppercase-domain":    `{"extra_platforms":[{"id":"x","name":"X","site_url":"https://x.com/","icon":"x","capabilities":["video"],"domains":["X.COM"]}]}`,
		"missing-all-domains": `{"extra_platforms":[{"id":"x","name":"X","site_url":"https://x.com/","icon":"x","capabilities":["video"],"domains":[],"exact_domains":[]}]}`,
		"empty-addition-list": `{"exact_domain_additions":{"zuiyou":[]},"extra_platforms":[{"id":"x","name":"X","site_url":"https://x.com/","icon":"x","capabilities":["video"],"domains":["x.com"]}]}`,
		"trailing-json":       `{"extra_platforms":[{"id":"x","name":"X","site_url":"https://x.com/","icon":"x","capabilities":["video"],"domains":["x.com"]}]} {}`,
	}
	for name, raw := range invalidConfigs {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeExtraConfig([]byte(raw)); err == nil {
				t.Fatalf("expected decodeExtraConfig(%s) to fail", name)
			}
		})
	}
}
