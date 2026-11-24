package pipigx

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type stubPostExecutor struct {
	body string
}

func (s stubPostExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	if err := ctx.Err(); err != nil {
		return fetch.Response{}, err
	}
	if req.Method != http.MethodPost || req.URL != endpoint || req.Policy.FollowRedirects {
		return fetch.Response{}, fmt.Errorf("unexpected pipigx request: %s %s", req.Method, req.URL)
	}
	return fetch.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{},
		Body:       []byte(s.body),
		URL:        req.URL,
	}, nil
}

func TestPipigxPostPathPIDAndVerifiedHTTPSMediaUpgrade(t *testing.T) {
	for _, tc := range []struct {
		raw     string
		wantPID int64
		wantMID int64
		wantOK  bool
	}{
		{"https://h5.pipigx.com/pp/post/860538173891?mid=987654321", 860538173891, 987654321, true},
		{"https://h5.pipigx.com/pp/post/860538173891/?mid=0", 860538173891, 0, true},
		{"https://h5.pipigx.com/pp/post/860538173891", 860538173891, 0, true},
		{"https://h5.pipigx.com/pp/post/860538173891/?utm_source=share", 860538173891, 0, true},
		{"https://h5.pipigx.com/pp/post/0?mid=1", 0, 0, false},
		{"https://h5.pipigx.com/pp/post/0123?mid=1", 0, 0, false},
		{"https://h5.pipigx.com/pp/post/860538173891/extra?mid=1", 0, 0, false},
		{"https://h5.pipigx.com/pp/post/860538173891?mid[]=1", 0, 0, false},
		{"https://h5.pipigx.com/share?pid=860538173891", 0, 0, false},
	} {
		pid, mid, ok := ExtractParams(tc.raw)
		if ok != tc.wantOK || pid != tc.wantPID || mid != tc.wantMID {
			t.Fatalf("ExtractParams(%q) = (%d, %d, %v), want (%d, %d, %v)", tc.raw, pid, mid, ok, tc.wantPID, tc.wantMID, tc.wantOK)
		}
	}

	const now int64 = 1793361600
	for _, host := range []string{"video01.szsttkj.com", "video03.szsttkj.com", "xlal-ppvideo.szsttkj.com"} {
		t.Run(host, func(t *testing.T) {
			upstreamBody := fmt.Sprintf(`{"data":{"post":{"content":"皮皮搞笑样本","videos":{"2494755117":{"vid":2494755117,"thumb":12345,"url":"http://%[1]s/zyvqwz/264/sample?auth_key=abc","urlwm":"http://%[1]s/zywmvd/sample"}}}}}`+"\n", host)
			p := NewWithTBVideo(stubPostExecutor{body: upstreamBody}, true)
			link := "https://h5.pipigx.com/pp/post/860538173891?mid=123"
			res, err := p.Parse(context.Background(), link, now)
			if err != nil || unified.Str(res["code"]) != "OK" {
				t.Fatalf("Parse(%s) failed: res=%v err=%v", link, res, err)
			}
			pub := unified.PublicView(res, false, now)
			if err := unified.ValidateEnvelopeAt(pub, now); err != nil {
				t.Fatalf("ValidateEnvelopeAt failed: %v", err)
			}
			item := unified.Map(unified.Slice(unified.Map(pub["data"])["items"])[0])
			wantHTTPS := fmt.Sprintf("https://%s/zyvqwz/264/sample?auth_key=abc", host)
			if got := unified.Str(unified.Map(item["default"])["url"]); got != wantHTTPS {
				t.Fatalf("default.url = %q, want %q", got, wantHTTPS)
			}
			src := unified.Map(unified.Slice(unified.Map(unified.Map(unified.Slice(item["variants"])[0])["delivery"])["sources"])[0])
			if got := unified.Str(src["url"]); got != wantHTTPS {
				t.Fatalf("variant source.url = %q, want %q", got, wantHTTPS)
			}
		})
	}
}
