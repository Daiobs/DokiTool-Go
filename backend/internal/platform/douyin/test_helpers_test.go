package douyin

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type fixtureExecutor struct {
	t         *testing.T
	responses array
	requests  array
	position  int
}

func fixtureHeader(fields object) http.Header {
	result := http.Header{}
	for key, value := range fields {
		if values := unified.Slice(value); values != nil {
			for _, value := range values {
				result.Add(key, unified.Str(value))
			}
		} else {
			result.Set(key, unified.Str(value))
		}
	}
	return result
}

func (f *fixtureExecutor) Do(ctx context.Context, request fetch.Request) (fetch.Response, error) {
	f.t.Helper()
	if err := ctx.Err(); err != nil {
		return fetch.Response{}, err
	}
	if request.Policy.Purpose == "" || request.Policy.AllowedURL == nil || !request.Policy.AllowedURL(request.URL) || request.Policy.Timeout <= 0 || request.Policy.MaxBytes <= 0 {
		f.t.Fatalf("missing or violated request bounds: %s %s", request.Method, request.URL)
	}
	headers := object{}
	for key, values := range request.Header {
		headers[strings.ToLower(key)] = strings.Join(values, ", ")
	}
	f.requests = append(f.requests, object{"method": request.Method, "url": request.URL, "headers": headers, "follow_redirects": request.Policy.FollowRedirects})
	if f.position >= len(f.responses) {
		f.t.Fatalf("unexpected outbound request: %s %s", request.Method, request.URL)
	}
	want := unified.Map(f.responses[f.position])
	f.position++
	if request.Method != unified.Str(want["method"]) || request.URL != unified.Str(want["url"]) {
		f.t.Fatalf("request %d: got %s %s; want %s %s", f.position, request.Method, request.URL, unified.Str(want["method"]), unified.Str(want["url"]))
	}
	if message := unified.Str(want["error"]); message != "" {
		return fetch.Response{}, errors.New(message)
	}
	status, _ := unified.Numeric(want["status"])
	response := fetch.Response{StatusCode: int(status), Header: fixtureHeader(unified.Map(want["headers"])), Body: []byte(unified.Str(want["body"])), URL: request.URL}
	if value := unified.Str(want["final_url"]); value != "" {
		response.URL = value
	}
	for _, value := range unified.Slice(want["history"]) {
		response.History = append(response.History, unified.Str(value))
	}
	return response, nil
}

type fixtureProber struct {
	t        *testing.T
	results  array
	requests array
	position int
}

func (p *fixtureProber) Probe(ctx context.Context, raw string) (object, error) {
	p.t.Helper()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p.requests = append(p.requests, raw)
	if p.position >= len(p.results) {
		p.t.Fatalf("unexpected probe: %s", raw)
	}
	want := unified.Map(p.results[p.position])
	p.position++
	if raw != unified.Str(want["url"]) {
		p.t.Fatalf("probe %d: got %s; want %s", p.position, raw, unified.Str(want["url"]))
	}
	if message := unified.Str(want["error"]); message != "" {
		return nil, errors.New(message)
	}
	return unified.Clone(unified.Map(want["result"])), nil
}

func phpDouyinFixtures(t *testing.T) array {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "php-douyin", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := unified.Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	if !unified.Equal(manifest["format_version"], 1) {
		t.Fatal("unsupported fixture manifest")
	}
	return unified.Slice(manifest["cases"])
}

func firstDifference(got, want any, path string) string {
	if unified.Equal(got, want) {
		return ""
	}
	a, b := unified.Map(got), unified.Map(want)
	if a != nil && b != nil {
		keys := map[string]bool{}
		for key := range a {
			keys[key] = true
		}
		for key := range b {
			keys[key] = true
		}
		ordered := make([]string, 0, len(keys))
		for key := range keys {
			ordered = append(ordered, key)
		}
		sort.Strings(ordered)
		for _, key := range ordered {
			av, ap := a[key]
			bv, bp := b[key]
			if ap != bp {
				return fmt.Sprintf("%s.%s: present got=%v want=%v", path, key, ap, bp)
			}
			if difference := firstDifference(av, bv, path+"."+key); difference != "" {
				return difference
			}
		}
	}
	x, y := unified.Slice(got), unified.Slice(want)
	if x != nil && y != nil {
		if len(x) != len(y) {
			return fmt.Sprintf("%s: array length got=%d want=%d", path, len(x), len(y))
		}
		for i := range x {
			if difference := firstDifference(x[i], y[i], fmt.Sprintf("%s[%d]", path, i)); difference != "" {
				return difference
			}
		}
	}
	return fmt.Sprintf("%s: got %#v (%T); want %#v (%T)", path, got, got, want, want)
}

func requireSameWire(t *testing.T, got, want any) {
	t.Helper()
	if difference := firstDifference(got, want, "$"); difference != "" {
		t.Fatal(difference)
	}
}
