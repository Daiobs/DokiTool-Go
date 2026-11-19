package zuiyou

import (
	"context"
	"net/http"
	"reflect"
	"strconv"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func TestAllowedBrowserFetchURL(t *testing.T) {
	allowed := []string{
		"https://web-f01.izuiyou.com/img/view/id/101?sig=a%2Bb+z",
		"https://web-f02.izuiyou.com/img/view/id/102",
		"https://bd-tbfile.izuiyou.com/img/avatar/id/201",
		"https://tbfile.izuiyou.com/img/view/id/202",
		"https://file.izuiyou.com/img/frame/id/203",
		"https://zyvipres.izuiyou.com/badge/1.png",
		"https://tbfile.ixiaochuan.cn/img/view/id/204",
		"https://WEB-F01.izuiyou.com:443/img/view/id/205",
	}
	for _, raw := range allowed {
		if !AllowedBrowserFetchURL(raw) {
			t.Fatalf("expected %q to allow browser_fetch", raw)
		}
	}

	rejected := []string{
		"http://web-f01.izuiyou.com/img/view/id/101",
		"https://web-v01.izuiyou.com/zyvd/12/34/abcd?auth_key=1",
		"https://tbvideo.ixiaochuan.cn/zyvd/12/34/abcd",
		"https://www.izuiyou.com/detail/123",
		"https://share.izuiyou.com/hybrid/share/post?pid=123",
		"https://h5.izuiyou.com/hybrid/share/post?pid=123",
		"https://share.xiaochuankeji.cn/hybrid/share/post?pid=123",
		"https://izuiyou.com/img/1",
		"https://sub.web-f01.izuiyou.com/img/1",
		"https://web-f01.izuiyou.com:8443/img/1",
		"https://web-f01.izuiyou.com:/img/1",
		"https://user@web-f01.izuiyou.com/img/1",
		"https://web-f01.izuiyou.com/img/1#frag",
		"https://images.example/img/1",
		"",
	}
	for _, raw := range rejected {
		if AllowedBrowserFetchURL(raw) {
			t.Fatalf("expected %q not to allow browser_fetch", raw)
		}
	}
}

func TestAllowedHTTPSUpgradeURL(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"http://web-f01.izuiyou.com/img/frame/id/123?sig=a%2Bb+z&empty=", "https://web-f01.izuiyou.com/img/frame/id/123?sig=a%2Bb+z&empty="},
		{"HTTP://bd-tbfile.izuiyou.com/avatar/1?x=%2F", "https://bd-tbfile.izuiyou.com/avatar/1?x=%2F"},
		{"http://tbfile.ixiaochuan.cn/img/1", "https://tbfile.ixiaochuan.cn/img/1"},
		{"http://web-v01.izuiyou.com/zyvd/ab/cd/ef?auth_key=1-0-abc", "https://web-v01.izuiyou.com/zyvd/ab/cd/ef?auth_key=1-0-abc"},
		{"http://cdn.xiaochuankeji.cn/cover/1.webp", "https://cdn.xiaochuankeji.cn/cover/1.webp"},
		{"https://web-f01.izuiyou.com/img/1", "https://web-f01.izuiyou.com/img/1"},
		{"http://share.izuiyou.com/hybrid/share/post?pid=1", "http://share.izuiyou.com/hybrid/share/post?pid=1"},
		{"http://share.xiaochuankeji.cn/hybrid/share/post?pid=1", "http://share.xiaochuankeji.cn/hybrid/share/post?pid=1"},
		{"http://web-f01.izuiyou.com:8080/img/1", "http://web-f01.izuiyou.com:8080/img/1"},
		{"http://web-f01.izuiyou.com:80/img/1", "http://web-f01.izuiyou.com:80/img/1"},
		{"http://user@web-f01.izuiyou.com/img/1", "http://user@web-f01.izuiyou.com/img/1"},
		{"http://images.example/img/1", "http://images.example/img/1"},
	}
	for _, tc := range cases {
		if got := httpsUpgradeURL(tc.raw); got != tc.want {
			t.Fatalf("httpsUpgradeURL(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

type zuiyouTestExecutor func(context.Context, fetch.Request) (fetch.Response, error)

func (f zuiyouTestExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	return f(ctx, req)
}

func TestPreparePublicNineImageAlbumUpgradesHTTPSAndMarksBrowserFetch(t *testing.T) {
	const now int64 = 1793448000
	imgsJSON := ""
	for i := 1; i <= 9; i++ {
		if i > 1 {
			imgsJSON += ","
		}
		idx := strconv.Itoa(i)
		imgsJSON += `{"id":` + idx + `,"urls":{"origin":{"urls":["http://web-f01.izuiyou.com/img/view/id/900` + idx + `?sig=a%2Bb+` + idx + `&empty="]},"540_webp":{"urls":["http://web-f01.izuiyou.com/img/webp/id/900` + idx + `?sig=c%2Fd"]}}}`
	}
	apiBody := `{"ret":1,"data":{"post":{"id":427997933,"content":"九图测试","member":{"name":"作者","avatar_urls":{"origin":{"urls":["http://bd-tbfile.izuiyou.com/avatar/1001?sig=av%2B1"]}}},"imgs":[` + imgsJSON + `],"videos":{}}}}`

	p := NewWithTBVideo(zuiyouTestExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(apiBody)}, nil
	}), true)

	parsed, err := p.Parse(context.Background(), "https://share.xiaochuankeji.cn/hybrid/share/post?pid=427997933", now)
	if err != nil || parsed["code"] != "OK" {
		t.Fatalf("Parse failed: code=%v err=%v", parsed["code"], err)
	}
	before := unified.Clone(parsed)

	prepared, err := PreparePublic(context.Background(), "zuiyou", parsed, now)
	if err != nil {
		t.Fatalf("PreparePublic failed: %v", err)
	}
	if !reflect.DeepEqual(parsed, before) {
		t.Fatal("PreparePublic mutated input payload")
	}
	if err := unified.ValidateEnvelopeAt(prepared, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt after PreparePublic failed: %v", err)
	}
	pub := unified.PublicView(prepared, false, now)
	if err := unified.ValidateEnvelopeAt(pub, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt after PublicView failed: %v", err)
	}

	data := unified.Map(pub["data"])
	if got := unified.Str(unified.Map(data["cover"])["url"]); got != "https://web-f01.izuiyou.com/img/webp/id/9001?sig=c%2Fd" {
		t.Fatalf("data.cover.url = %q", got)
	}
	if got := unified.Str(unified.Map(unified.Map(data["author"])["avatar"])["url"]); got != "https://bd-tbfile.izuiyou.com/avatar/1001?sig=av%2B1" {
		t.Fatalf("data.author.avatar.url = %q", got)
	}

	items := unified.Slice(data["items"])
	if len(items) != 9 {
		t.Fatalf("items len = %d, want 9", len(items))
	}
	for i, rawItem := range items {
		idx := strconv.Itoa(i + 1)
		wantURL := "https://web-f01.izuiyou.com/img/view/id/900" + idx + "?sig=a%2Bb+" + idx + "&empty="
		item := unified.Map(rawItem)
		if got := unified.Str(unified.Map(item["default"])["url"]); got != wantURL {
			t.Fatalf("item[%d].default.url = %q, want %q", i, got, wantURL)
		}
		src := unified.Map(unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["sources"])[0])
		if got := unified.Str(src["url"]); got != wantURL {
			t.Fatalf("item[%d] source.url = %q, want %q", i, got, wantURL)
		}
		if got := unified.Str(src["browser_fetch"]); got != "allowed" {
			t.Fatalf("item[%d] source.browser_fetch = %q, want allowed", i, got)
		}
	}

	// Idempotency and non-zuiyou platform pass-through.
	again, err := PreparePublic(context.Background(), "zuiyou", prepared, now)
	if err != nil || !reflect.DeepEqual(again, prepared) {
		t.Fatalf("PreparePublic not idempotent: err=%v", err)
	}
	other, err := PreparePublic(context.Background(), "pipigx", parsed, now)
	if err != nil || !reflect.DeepEqual(other, before) {
		t.Fatalf("PreparePublic modified non-zuiyou payload: err=%v", err)
	}
}

func TestPreparePublicVideoKeepsManualWithoutBrowserFetchAllowed(t *testing.T) {
	const now int64 = 1793448000
	apiBody := `{"ret":1,"data":{"post":{"id":427804147,"content":"视频测试","member":{"name":"作者","avatar_urls":{"origin":{"urls":["http://bd-tbfile.izuiyou.com/avatar/2001"]}}},"imgs":[{"id":77,"urls":{"origin":{"urls":["http://web-f01.izuiyou.com/img/view/id/77"]},"540_webp":{"urls":["http://web-f01.izuiyou.com/img/webp/id/77"]}}}],"videos":{"77":{"url":"http://web-v01.izuiyou.com/zyvd/aa/bb/ccdd?auth_key=1-0-xyz","dur":15}}}}}`

	p := NewWithTBVideo(zuiyouTestExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(apiBody)}, nil
	}), false)

	parsed, err := p.Parse(context.Background(), "https://share.xiaochuankeji.cn/hybrid/share/post?pid=427804147", now)
	if err != nil || parsed["code"] != "OK" {
		t.Fatalf("Parse failed: code=%v err=%v", parsed["code"], err)
	}
	prepared, err := PreparePublic(context.Background(), "zuiyou", parsed, now)
	if err != nil {
		t.Fatalf("PreparePublic failed: %v", err)
	}
	if err := unified.ValidateEnvelopeAt(prepared, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}

	data := unified.Map(prepared["data"])
	item := unified.Map(unified.Slice(data["items"])[0])
	const wantVideoURL = "https://web-v01.izuiyou.com/zyvd/aa/bb/ccdd?auth_key=1-0-xyz"
	if got := unified.Str(unified.Map(item["default"])["url"]); got != wantVideoURL {
		t.Fatalf("video item.default.url = %q, want %q", got, wantVideoURL)
	}
	src := unified.Map(unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["sources"])[0])
	if got := unified.Str(src["url"]); got != wantVideoURL {
		t.Fatalf("video source.url = %q, want %q", got, wantVideoURL)
	}
	if got := unified.Str(src["browser_fetch"]); got != "" {
		t.Fatalf("video source must NOT set browser_fetch=allowed, got %q", got)
	}
	tb := unified.Map(unified.Map(data["extra"])["tbvideo"])
	if tb == nil || unified.Str(tb["pid"]) != "427804147" {
		t.Fatalf("expected extra.tbvideo preserved, got %#v", tb)
	}
}
