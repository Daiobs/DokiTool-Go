package api

import (
	"bufio"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/zuiyou"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type zuiyouHTTPTape struct {
	t                   *testing.T
	responses, requests unified.Array
	next                int
}

func (f *zuiyouHTTPTape) Do(ctx context.Context, request fetch.Request) (fetch.Response, error) {
	f.t.Helper()
	if err := ctx.Err(); err != nil {
		return fetch.Response{}, err
	}
	if _, bounded := ctx.Deadline(); !bounded || f.next >= len(f.responses) || f.next >= len(f.requests) {
		f.t.Fatal("unbounded or unexpected Zuiyou HTTP metadata request")
	}
	want, response := unified.Clone(unified.Map(f.requests[f.next])), unified.Map(f.responses[f.next])
	if request.Method == http.MethodHead {
		unified.Map(want["headers"])["accept"] = "*/*"
	}
	headers := unified.Object{}
	for name, values := range request.Header {
		headers[strings.ToLower(name)] = strings.Join(values, ", ")
	}
	zuiyouHTTPSame(f.t, unified.Object{"url": request.URL, "method": request.Method, "headers": headers,
		"body": string(request.Body), "follow_redirects": request.Policy.FollowRedirects,
		"timeout_seconds": int64(request.Policy.Timeout / time.Second)}, want)
	if request.Policy.Purpose == "" || request.Policy.MaxBytes != 8<<20 || request.Policy.AllowedURL == nil || !request.Policy.AllowedURL(request.URL) || request.Policy.AllowedURL("https://example.com/private") {
		f.t.Fatal("Zuiyou HTTP adapter bypassed outbound policy")
	}
	f.next++
	if message := unified.Str(response["error"]); message != "" {
		return fetch.Response{}, errors.New(message)
	}
	status, _ := unified.PHPInt(response["status"])
	result := fetch.Response{StatusCode: int(status), Header: http.Header{}, Body: []byte(unified.Str(response["body"])), URL: request.URL}
	if request.Method == http.MethodHead {
		parsed, err := http.ReadResponse(bufio.NewReader(strings.NewReader(unified.Str(response["body"]))), &http.Request{Method: http.MethodHead})
		if err != nil {
			f.t.Fatal(err)
		}
		result.Header, result.Body = parsed.Header, nil
		_ = parsed.Body.Close()
	}
	return result, nil
}

func zuiyouHTTPSame(t *testing.T, got, want any) {
	t.Helper()
	if !unified.Equal(got, want) {
		actual, _ := unified.Encode(got)
		expected, _ := unified.Encode(want)
		t.Fatalf("Zuiyou PHP public HTTP mismatch:\nGo  %s\nPHP %s", actual, expected)
	}
}

func TestZuiyouHTTPPHPOracle(t *testing.T) {
	directory := filepath.Join("..", "platform", "zuiyou", "testdata")
	read := func(name string) unified.Object {
		body, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		value, err := unified.Decode(body)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	document, inputs := read("php-baseline.json"), read("inputs.json")
	cases, reviewed := unified.Slice(document["cases"]), unified.Slice(inputs["cases"])
	if document["baseline_commit"] != "25beaee107f8c1a208ced9deb3c637068445e316" || len(cases) != 48 || len(reviewed) != len(cases) {
		t.Fatal("unexpected PHP Zuiyou HTTP oracle inventory")
	}
	registry, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	exports := unified.Array{}
	for index, value := range cases {
		entry := unified.Map(value)
		input, expected := unified.Map(entry["input"]), unified.Map(entry["expected"])
		zuiyouHTTPSame(t, input, unified.Map(reviewed[index])["input"])
		if entry["id"] != unified.Map(reviewed[index])["id"] {
			t.Fatal("oracle case order changed")
		}
		now, _ := unified.PHPInt(input["now"])
		exported := unified.Object{"id": entry["id"]}
		for _, view := range []string{"normal", "debug"} {
			t.Run(unified.Str(entry["id"])+"/"+view, func(t *testing.T) {
				tape := &zuiyouHTTPTape{t: t, responses: unified.Slice(input["http_responses"]), requests: unified.Slice(expected["http_requests"])}
				if expected[view+"_forwarded"] == false {
					tape.responses, tape.requests = unified.Array{}, unified.Array{}
				}
				handler, err := New(registry, map[string]Adapter{"zuiyou": zuiyou.New(tape)}, func() time.Time { return time.Unix(now, 0) }, nil)
				if err != nil {
					t.Fatal(err)
				}
				query := url.Values{"schema_version": {"1.0"}, "url": {unified.Str(input["url"])}}
				if view == "debug" {
					query.Set("debug", "1")
				}
				if input["route"] == "resolve" {
					query.Set("item_id", unified.Str(input["item_id"]))
				}
				recorder := httptest.NewRecorder()
				handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/"+unified.Str(input["route"])+"?"+query.Encode(), nil))
				if tape.next != len(tape.responses) || tape.next != len(tape.requests) {
					t.Fatal("Zuiyou public handler did not consume the exact frozen request sequence")
				}
				for name, want := range map[string]string{"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": ""} {
					if recorder.Header().Get(name) != want {
						t.Fatal("public response header changed", name)
					}
				}
				payload, err := unified.Decode(recorder.Body.Bytes())
				if err != nil {
					t.Fatal(err)
				}
				zuiyouHTTPSame(t, unified.Object{"status": recorder.Code, "payload": payload}, unified.Object{"status": expected[view+"_status"], "payload": expected[view]})
				if err := unified.ValidateEnvelopeAt(payload, now); err != nil {
					t.Fatal(err)
				}
				exported[view] = payload
			})
		}
		exports = append(exports, exported)
	}
	if path := os.Getenv("DOKITOOL_GO_ZUIYOU_OUTPUT"); path != "" && !t.Failed() {
		encoded, err := unified.Encode(unified.Object{"cases": exports})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

type zuiyouExecutorFunc func(context.Context, fetch.Request) (fetch.Response, error)

func (f zuiyouExecutorFunc) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	return f(ctx, req)
}

func TestZuiyouHTTPPublicMediaUpgradesImageURLsWithoutMixedContent(t *testing.T) {
	const now int64 = 1793448000
	registry, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	apiBody := `{"ret":1,"data":{"post":{"id":427896637,"content":"单图测试","member":{"name":"作者","avatar_urls":{"origin":{"urls":["http://bd-tbfile.izuiyou.com/avatar/101?sig=a%2Bb"]}}},"imgs":[{"id":1,"urls":{"origin":{"urls":["http://web-f01.izuiyou.com/img/view/id/427896637?sig=a%2Bb+z"]},"540_webp":{"urls":["http://web-f01.izuiyou.com/img/webp/id/427896637?sig=c%2Fd"]}}}],"videos":{}}}}`
	adapter := zuiyou.NewWithTBVideo(zuiyouExecutorFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		return fetch.Response{StatusCode: http.StatusOK, URL: req.URL, Body: []byte(apiBody)}, nil
	}), true)
	handler, err := New(registry, map[string]Adapter{"zuiyou": adapter}, func() time.Time { return time.Unix(now, 0) }, zuiyou.PreparePublic)
	if err != nil {
		t.Fatal(err)
	}
	q := url.Values{"schema_version": {"1.0"}, "url": {"https://share.xiaochuankeji.cn/hybrid/share/post?pid=427896637"}}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/parse?"+q.Encode(), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	payload, err := unified.Decode(rec.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if err := unified.ValidateEnvelopeAt(payload, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}
	data := unified.Map(payload["data"])
	if got := unified.Str(unified.Map(data["cover"])["url"]); got != "https://web-f01.izuiyou.com/img/webp/id/427896637?sig=c%2Fd" {
		t.Fatalf("cover.url = %q", got)
	}
	if got := unified.Str(unified.Map(unified.Map(data["author"])["avatar"])["url"]); got != "https://bd-tbfile.izuiyou.com/avatar/101?sig=a%2Bb" {
		t.Fatalf("avatar.url = %q", got)
	}
	item := unified.Map(unified.Slice(data["items"])[0])
	const wantImg = "https://web-f01.izuiyou.com/img/view/id/427896637?sig=a%2Bb+z"
	if got := unified.Str(unified.Map(item["default"])["url"]); got != wantImg {
		t.Fatalf("default.url = %q, want %q", got, wantImg)
	}
	src := unified.Map(unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["sources"])[0])
	if got := unified.Str(src["url"]); got != wantImg {
		t.Fatalf("source.url = %q, want %q", got, wantImg)
	}
	if got := unified.Str(src["browser_fetch"]); got != "allowed" {
		t.Fatalf("source.browser_fetch = %q, want allowed", got)
	}
}
