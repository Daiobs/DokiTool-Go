package weibo

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type stagedWeiboHTTP struct {
	replies []fetch.Response
	calls   []fetch.Request
}

func (s *stagedWeiboHTTP) Do(_ context.Context, r fetch.Request) (fetch.Response, error) {
	s.calls = append(s.calls, r)
	if len(s.replies) == 0 {
		return fetch.Response{}, errors.New("unexpected request")
	}
	answer := s.replies[0]
	s.replies = s.replies[1:]
	return answer, nil
}

func TestWeiboOfficialHTTPGuestCookieFlow(t *testing.T) {
	client := &stagedWeiboHTTP{replies: []fetch.Response{
		{StatusCode: 200, Header: http.Header{}, Body: []byte("<html>Sina Visitor System</html>")},
		{StatusCode: 200, Header: http.Header{}, Body: []byte(`gen_callback({"retcode":20000000,"data":{"tid":"tid123","confidence":85}});`)},
		{StatusCode: 200, Header: http.Header{"Set-Cookie": {"session=legitimate; Domain=.weibo.com; Path=/; Secure", "poison=bad; Domain=com; Path=/; Secure"}}, Body: []byte(`cross_domain({"retcode":20000000});`)},
		{StatusCode: 200, Header: http.Header{}, Body: []byte(`{"ok":1,"idstr":"9007199254740993"}`)},
	}}
	session := newNetworkGuestSession(client)
	session.nonce = func() string { return "0.2" }
	address := "https://weibo.com/ajax/statuses/show?id=9007199254740993"
	result := session.jsonRequest(context.Background(), address, nil, "https://weibo.com/")
	if unified.Map(result["json"]) == nil || !session.attempted {
		t.Fatalf("guest success not retained: %#v", result)
	}
	if len(client.calls) != 4 {
		t.Fatalf("expected 4 real exchanges, got %d", len(client.calls))
	}
	if client.calls[1].URL != "https://passport.weibo.com/visitor/genvisitor" || !strings.HasPrefix(client.calls[2].URL, "https://passport.weibo.com/visitor/visitor?") {
		t.Fatalf("guest endpoints changed: %q %q", client.calls[1].URL, client.calls[2].URL)
	}
	if got := client.calls[3].Header.Get("Cookie"); !strings.Contains(got, "session=legitimate") || strings.Contains(got, "poison") {
		t.Fatalf("guest cookie scope incorrect: %q", got)
	}
	for _, call := range client.calls {
		if !call.Policy.AllowedURL(call.URL) || call.Policy.FollowRedirects || call.Policy.MaxBytes != 2<<20 || call.Policy.Timeout <= 0 || call.Policy.Timeout > 20*time.Second {
			t.Fatalf("unsafe request policy: %#v", call)
		}
		if call.Header.Get("Accept") != "application/json, text/plain, */*" || call.Header.Get("User-Agent") != weiboUserAgent {
			t.Fatalf("official headers changed: %#v", call.Header)
		}
	}
	// Session isolation: a new parse must not inherit a previous visitor token.
	another := &stagedWeiboHTTP{replies: []fetch.Response{{StatusCode: 200, Header: http.Header{}, Body: []byte(`{"ok":1}`)}}}
	_ = newNetworkGuestSession(another).jsonRequest(context.Background(), address, nil, "https://weibo.com/")
	if another.calls[0].Header.Get("Cookie") != "" {
		t.Fatal("cookies leaked to new parse")
	}
}

func TestWeiboOfficialHTTPRedirectScope(t *testing.T) {
	for _, address := range []string{"http://weibo.com/ajax/statuses/show?id=1", "https://weibo.com:444/ajax/statuses/show?id=1", "https://weibo.com/evil", "https://weibo.com@evil.example/ajax/statuses/show?id=1", "https://passport.weibo.com/visitor/genvisitor"} {
		fake := &stagedWeiboHTTP{}
		_, err := newNetworkGuestSession(fake).exchange(context.Background(), address, nil, "https://weibo.com/")
		if !errors.Is(err, fetch.ErrPolicy) || len(fake.calls) != 0 {
			t.Fatalf("unsafe initial URL accepted %q: %v", address, err)
		}
	}
	fake := &stagedWeiboHTTP{replies: []fetch.Response{{StatusCode: 302, Header: http.Header{"Location": {"https://evil.example/download"}}}}}
	_, err := newNetworkGuestSession(fake).exchange(context.Background(), "https://weibo.com/ajax/statuses/show?id=1", nil, "https://weibo.com/")
	if !errors.Is(err, fetch.ErrPolicy) || len(fake.calls) != 1 {
		t.Fatalf("unsafe redirect followed: %v %d", err, len(fake.calls))
	}
	same := &stagedWeiboHTTP{replies: []fetch.Response{
		{StatusCode: 302, Header: http.Header{"Location": {"https://passport.weibo.com/visitor/visitor"}, "Set-Cookie": {"hop=ok; Domain=.weibo.com; Path=/; Secure"}}},
		{StatusCode: 200, Header: http.Header{}, Body: []byte("Sina Visitor System")},
	}}
	reply, err := newNetworkGuestSession(same).exchange(context.Background(), "https://weibo.com/ajax/statuses/show?id=1", nil, "https://weibo.com/")
	if err != nil || reply["url"] != "https://passport.weibo.com/visitor/visitor" || len(same.calls) != 2 || !strings.Contains(same.calls[1].Header.Get("Cookie"), "hop=ok") {
		t.Fatalf("approved redirect/cookie failed: %v, %#v, %#v", err, reply, same.calls)
	}
}

func TestWeiboOfficialHTTPCancelAndBudget(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	fake := &stagedWeiboHTTP{}
	_, err := newNetworkGuestSession(fake).exchange(ctx, "https://weibo.com/ajax/statuses/show?id=1", nil, "https://weibo.com/")
	if !errors.Is(err, context.Canceled) || len(fake.calls) != 0 {
		t.Fatalf("cancellation ignored: %v", err)
	}
	ctx, stop := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer stop()
	fake = &stagedWeiboHTTP{replies: []fetch.Response{{StatusCode: 200, Header: http.Header{}, Body: []byte("{}")}}}
	_, err = newNetworkGuestSession(fake).exchange(ctx, "https://weibo.com/ajax/statuses/show?id=1", nil, "https://weibo.com/")
	if err != nil || len(fake.calls) != 1 || fake.calls[0].Policy.Timeout > 150*time.Millisecond {
		t.Fatalf("budget was reset: %v %#v", err, fake.calls)
	}
}

// The expected strings are frozen PHP getRequestHeaders outputs. The CI oracle
// step regenerates the file with PHP 8.3.6 and compares exact bytes.
func TestPHPWeiboRequestHeaders(t *testing.T) {
	raw, err := os.ReadFile("testdata/php-network-headers.json")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := unified.Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !unified.Equal(payload["schema"], 1) || payload["php_source_commit"] != "25beaee107f8c1a208ced9deb3c637068445e316" {
		t.Fatal("untrusted PHP oracle provenance")
	}
	cases := unified.Slice(payload["cases"])
	if len(cases) != 4 {
		t.Fatalf("unexpected PHP header oracle size: %d", len(cases))
	}
	for _, item := range cases {
		input := unified.Map(item)
		if !unified.Equal(officialWeiboHeaders(unified.Str(input["referer"])), input["expected"]) {
			t.Fatalf("PHP request header mismatch for %s", unified.Str(input["id"]))
		}
	}
}

type funcWeiboExecutor func(context.Context, fetch.Request) (fetch.Response, error)

func (f funcWeiboExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	return f(ctx, req)
}

func TestWeiboVisitorSUBCacheReuseRefreshExpiryAndCoalescing(t *testing.T) {
	const (
		inputURL   = "https://weibo.com/1234567890/AbC"
		statusBody = `{"idstr":"1234567890","text_raw":"缓存测试视频","page_info":{"media_info":{"mp4_hd_url":"https://f.video.weibocdn.com/cached.mp4","video_title":"测试标题","duration":12}},"user":{"screen_name":"测试作者","idstr":"10001"}}`
	)

	var (
		mu             sync.Mutex
		nowTime        = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
		validSUB       = "anon_sub_gen1"
		validSUBP      = "anon_subp_gen1"
		rejectMode     = "visitor" // "visitor" | "403" | "redirect"
		totalCalls     atomic.Int32
		genvisitorCnt  atomic.Int32
		incarnateCnt   atomic.Int32
		statusCalls    atomic.Int32
		incarnateDelay time.Duration
		lastStatusCk   string
	)
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return nowTime
	}

	exec := funcWeiboExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		totalCalls.Add(1)
		switch {
		case req.URL == "https://passport.weibo.com/visitor/genvisitor":
			genvisitorCnt.Add(1)
			return fetch.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{},
				Body:       []byte(`gen_callback({"retcode":20000000,"data":{"tid":"tid-anon-1","new_tid":true,"confidence":100}});`),
				URL:        req.URL,
			}, nil
		case strings.HasPrefix(req.URL, "https://passport.weibo.com/visitor/visitor?"):
			if incarnateDelay > 0 {
				time.Sleep(incarnateDelay)
			}
			incarnateCnt.Add(1)
			mu.Lock()
			sub, subp := validSUB, validSUBP
			mu.Unlock()
			return fetch.Response{
				StatusCode: http.StatusOK,
				Header: http.Header{
					"Set-Cookie": {
						"SUB=" + sub + "; Domain=.weibo.com; Path=/; Secure; HttpOnly",
						"SUBP=" + subp + "; Domain=.weibo.com; Path=/; Secure",
						"OTHER=ignore_me; Domain=.weibo.com; Path=/; Secure",
						"SUB=evil_foreign; Domain=evil.example; Path=/; Secure",
					},
				},
				Body: []byte(`cross_domain({"retcode":20000000});`),
				URL:  req.URL,
			}, nil
		case strings.HasPrefix(req.URL, "https://weibo.com/ajax/statuses/show"):
			statusCalls.Add(1)
			cookie := req.Header.Get("Cookie")
			mu.Lock()
			wantSub, mode := validSUB, rejectMode
			mu.Unlock()
			if strings.Contains(cookie, "SUB="+wantSub) {
				if strings.Contains(cookie, "evil_foreign") {
					t.Errorf("foreign-domain cookie leaked into request: %q", cookie)
				}
				mu.Lock()
				lastStatusCk = cookie
				mu.Unlock()
				return fetch.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{},
					Body:       []byte(statusBody),
					URL:        req.URL,
				}, nil
			}
			switch mode {
			case "403":
				return fetch.Response{StatusCode: http.StatusForbidden, Header: http.Header{}, Body: []byte("forbidden"), URL: req.URL}, nil
			case "redirect":
				return fetch.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": {"https://weibo.com/ajax/statuses/show?id=AbC&loop=1"}}, URL: req.URL}, nil
			default:
				return fetch.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: []byte("<html>Sina Visitor System</html>"), URL: req.URL}, nil
			}
		default:
			return fetch.Response{}, fmt.Errorf("unexpected weibo URL: %s", req.URL)
		}
	})

	parser := New(exec)
	parser.visitors = newVisitorCookieCache(10*time.Minute, clock)

	// 1. Cold parse populates cache via 4 hops (challenge -> genvisitor -> incarnate -> status).
	res1, err := parser.Parse(context.Background(), inputURL, nowTime.Unix())
	if err != nil || res1["code"] != "OK" {
		t.Fatalf("cold parse failed: code=%v err=%v", res1["code"], err)
	}
	if totalCalls.Load() != 4 || genvisitorCnt.Load() != 1 || incarnateCnt.Load() != 1 || statusCalls.Load() != 2 {
		t.Fatalf("cold parse hops mismatch: total=%d gen=%d inc=%d status=%d",
			totalCalls.Load(), genvisitorCnt.Load(), incarnateCnt.Load(), statusCalls.Load())
	}
	// Redaction check: formatting visitor cache must never expose SUB values.
	if formatted := fmt.Sprintf("%v %#v", parser.visitors, parser.visitors); strings.Contains(formatted, "anon_sub_gen1") {
		t.Fatalf("visitorCookieCache leaked SUB in string format: %q", formatted)
	}

	// 2. Warm parse reuses cached SUB/SUBP in strictly 1 hop (zero passport round-trips).
	res2, err := parser.Parse(context.Background(), inputURL, nowTime.Unix())
	if err != nil || res2["code"] != "OK" {
		t.Fatalf("warm parse failed: code=%v err=%v", res2["code"], err)
	}
	if totalCalls.Load() != 5 || genvisitorCnt.Load() != 1 || incarnateCnt.Load() != 1 || statusCalls.Load() != 3 {
		t.Fatalf("warm parse did not reuse cached SUB in 1 hop: total=%d gen=%d inc=%d status=%d",
			totalCalls.Load(), genvisitorCnt.Load(), incarnateCnt.Load(), statusCalls.Load())
	}
	mu.Lock()
	warmCookie := lastStatusCk
	mu.Unlock()
	if !strings.Contains(warmCookie, "SUB=anon_sub_gen1") || !strings.Contains(warmCookie, "SUBP=anon_subp_gen1") || strings.Contains(warmCookie, "OTHER=") {
		t.Fatalf("warm cached request should carry strictly SUB/SUBP, got %q", warmCookie)
	}

	// 3. Upstream rotates valid SUB -> visitor challenge auto-refreshes cache and succeeds.
	mu.Lock()
	validSUB = "anon_sub_gen2"
	validSUBP = "anon_subp_gen2"
	rejectMode = "visitor"
	mu.Unlock()
	res3, err := parser.Parse(context.Background(), inputURL, nowTime.Unix())
	if err != nil || res3["code"] != "OK" {
		t.Fatalf("visitor challenge refresh failed: code=%v err=%v", res3["code"], err)
	}
	if genvisitorCnt.Load() != 2 || incarnateCnt.Load() != 2 {
		t.Fatalf("expected 1 refresh on visitor challenge: gen=%d inc=%d", genvisitorCnt.Load(), incarnateCnt.Load())
	}

	// 4. Upstream rejects stale SUB with HTTP 403 -> invalidates stale gen, refreshes, and succeeds; next call is 1 hop.
	mu.Lock()
	validSUB = "anon_sub_gen3"
	validSUBP = "anon_subp_gen3"
	rejectMode = "403"
	mu.Unlock()
	res4, err := parser.Parse(context.Background(), inputURL, nowTime.Unix())
	if err != nil || res4["code"] != "OK" {
		t.Fatalf("403 stale SUB refresh failed: code=%v err=%v", res4["code"], err)
	}
	if genvisitorCnt.Load() != 3 || incarnateCnt.Load() != 3 {
		t.Fatalf("expected refresh on 403 stale SUB: gen=%d inc=%d", genvisitorCnt.Load(), incarnateCnt.Load())
	}
	beforeWarm := totalCalls.Load()
	if res4Warm, err := parser.Parse(context.Background(), inputURL, nowTime.Unix()); err != nil || res4Warm["code"] != "OK" || totalCalls.Load() != beforeWarm+1 {
		t.Fatalf("post-403-refresh warm call did not use 1 hop: delta=%d err=%v", totalCalls.Load()-beforeWarm, err)
	}

	// 5. Upstream rejects stale SUB with redirect loop -> refreshes and succeeds.
	mu.Lock()
	validSUB = "anon_sub_gen4"
	validSUBP = "anon_subp_gen4"
	rejectMode = "redirect"
	mu.Unlock()
	res5, err := parser.Parse(context.Background(), inputURL, nowTime.Unix())
	if err != nil || res5["code"] != "OK" {
		t.Fatalf("redirect-block stale SUB refresh failed: code=%v err=%v", res5["code"], err)
	}
	if genvisitorCnt.Load() != 4 || incarnateCnt.Load() != 4 {
		t.Fatalf("expected refresh on redirect block: gen=%d inc=%d", genvisitorCnt.Load(), incarnateCnt.Load())
	}

	// 6. TTL expiry (10 minutes): advancing clock past TTL expires cache cleanly.
	mu.Lock()
	nowTime = nowTime.Add(10*time.Minute + time.Second)
	validSUB = "anon_sub_gen5"
	validSUBP = "anon_subp_gen5"
	rejectMode = "visitor"
	mu.Unlock()
	res6, err := parser.Parse(context.Background(), inputURL, nowTime.Unix())
	if err != nil || res6["code"] != "OK" {
		t.Fatalf("post-TTL parse failed: code=%v err=%v", res6["code"], err)
	}
	if genvisitorCnt.Load() != 5 || incarnateCnt.Load() != 5 {
		t.Fatalf("expected fresh startGuest after TTL expiry: gen=%d inc=%d", genvisitorCnt.Load(), incarnateCnt.Load())
	}

	// 7. Concurrent cold start on a fresh Parser coalesces startGuest to a single genvisitor+incarnate pair under -race.
	mu.Lock()
	incarnateDelay = 25 * time.Millisecond
	mu.Unlock()
	genBefore := genvisitorCnt.Load()
	incBefore := incarnateCnt.Load()
	concurrentParser := New(exec)
	concurrentParser.visitors = newVisitorCookieCache(10*time.Minute, clock)

	const workers = 8
	var wg sync.WaitGroup
	errs := make([]error, workers)
	codes := make([]any, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			out, pErr := concurrentParser.Parse(context.Background(), inputURL, nowTime.Unix())
			errs[idx] = pErr
			if out != nil {
				codes[idx] = out["code"]
			}
		}(i)
	}
	wg.Wait()
	for i := 0; i < workers; i++ {
		if errs[i] != nil || codes[i] != "OK" {
			t.Fatalf("concurrent worker %d failed: code=%v err=%v", i, codes[i], errs[i])
		}
	}
	if gotGen, gotInc := genvisitorCnt.Load()-genBefore, incarnateCnt.Load()-incBefore; gotGen != 1 || gotInc != 1 {
		t.Fatalf("expected 8 concurrent cold parses to coalesce into 1 startGuest, got gen=%d inc=%d", gotGen, gotInc)
	}
}
