package bilibili

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type executorFunc func(context.Context, fetch.Request) (fetch.Response, error)

func (f executorFunc) Do(ctx context.Context, request fetch.Request) (fetch.Response, error) {
	return f(ctx, request)
}

const testURL = "https://www.bilibili.com/video/BV1234567890/"
const testView = `{"code":0,"data":{"title":"Example","pages":[{"page":1,"cid":101,"part":"One"},{"page":2,"cid":102,"part":"Two"}]}}`
const testPlay = `{"code":0,"data":{"quality":64,"durl":[{"url":"https://upos-test.bilivideo.com/video.mp4","width":1280,"height":720}]}}`

func TestOrdinaryRequestWireDoesNotAddGoUserAgent(t *testing.T) {
	for _, input := range []fetch.Request{shareRequest("https://b23.tv/test"), viewRequest("BV1234567890", 20*time.Second), playRequest("BV1234567890", "101", 20*time.Second), pageRequest("https://www.bilibili.com/video/av123", 10*time.Second)} {
		t.Run(input.Policy.Purpose, func(t *testing.T) {
			request, err := http.NewRequest(input.Method, input.URL, nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header = input.Header.Clone()
			var wire bytes.Buffer
			if err := request.Write(&wire); err != nil {
				t.Fatal(err)
			}
			headers, _, _ := strings.Cut(wire.String(), "\r\n\r\n")
			if input.Policy.Purpose == "bilibili-page" {
				if !strings.Contains(headers, "\r\nUser-Agent: "+desktopUA+"\r\n") {
					t.Fatal("HTML fallback lost its PHP desktop User-Agent")
				}
			} else if strings.Contains(strings.ToLower(headers), "\r\nuser-agent:") {
				t.Fatalf("ordinary PHP-equivalent request acquired a User-Agent on the wire: %s", headers)
			}
		})
	}
}

func TestShareRedirectFragmentIsAllowedButNeverSent(t *testing.T) {
	target := "https://www.bilibili.com/video/av123?p=2&track=%23#discard"
	for _, policy := range []fetch.Policy{shareRequest("https://b23.tv/test").Policy, pageRequest(testURL, 10*time.Second).Policy} {
		if !policy.AllowedURL(target) {
			t.Fatal("legitimate redirect fragment rejected before PHP-equivalent cleanup")
		}
	}
	request, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	var wire bytes.Buffer
	if err := request.Write(&wire); err != nil {
		t.Fatal(err)
	}
	requestLine, _, _ := strings.Cut(wire.String(), "\r\n")
	if requestLine != "GET /video/av123?p=2&track=%23 HTTP/1.1" {
		t.Fatalf("fragment altered request bytes: %s", requestLine)
	}
	if AllowedAPIURL("https://api.bilibili.com/x/web-interface/view?bvid=BV1234567890#discard") {
		t.Fatal("metadata API unexpectedly accepts fragments")
	}
}

func TestPHPPartQueryNameAndAssignmentBoundaries(t *testing.T) {
	cases := []struct {
		query, value    string
		present, scalar bool
	}{
		{"p=2&p[=3", "2", true, true},
		{"p%00=2", "2", true, true},
		{"p=2&p[x]=3&p=1", "1", true, true},
		{"p[=3", "", false, false},
		{"p=2&p[]=3", "3", true, false},
		{"%20p=2", "2", true, true},
		{"p=2%00", "2\x00", true, true},
	}
	for _, c := range cases {
		t.Run(c.query, func(t *testing.T) {
			value, present, scalar := queryPart(c.query)
			if value != c.value || present != c.present || scalar != c.scalar {
				t.Fatalf("p selection got (%q,%v,%v), want (%q,%v,%v)", value, present, scalar, c.value, c.present, c.scalar)
			}
		})
	}
}

func TestShortLinkPOverrideRetainsTrackingOrderAndArrayValues(t *testing.T) {
	got := redirectTarget("https://b23.tv/test?p=2", "https://www.bilibili.com/video/av123/?p=3&track=a%26b&foo[]=first&foo[]=second&tail=~#discard")
	want := "https://www.bilibili.com/video/av123/?p=2&track=a%26b&foo%5B0%5D=first&foo%5B1%5D=second&tail=%7E"
	if got != want {
		t.Fatalf("redirect reserialization lost query facts: got %s; want %s", got, want)
	}
	value, present, scalar := queryPart(strings.SplitN(got, "?", 2)[1])
	if value != "2" || !present || !scalar {
		t.Fatal("short-link p override changed target part")
	}
}

func TestRequestPolicyKeepsMetadataOnApprovedOrigins(t *testing.T) {
	for _, raw := range []string{testURL, "https://m.bilibili.com/video/av123", "http://bilibili.com/video/BV1234567890", "https://b23.tv/test", "https://www.bilibili.com/video/av123?p=2#discard"} {
		t.Run("allow/"+raw, func(t *testing.T) {
			if !allowedShareURL(raw) {
				t.Fatal("approved share host rejected")
			}
		})
	}
	for _, raw := range []string{"https://bilibili.com.evil.test/video/BV1234567890", "https://api.bilibili.com/x/web-interface/view", "https://127.0.0.1/a", "https://localhost/a", "https://user@b23.tv/a", "https://b23.tv:444/a", "https://b23.tv/a\\b", "https://b23.tv/a\nb", "https://other.bilibili.com/video/BV1234567890"} {
		t.Run("reject/"+raw, func(t *testing.T) {
			if allowedShareURL(raw) {
				t.Fatal("unapproved share target accepted")
			}
		})
	}
	for _, raw := range []string{"https://api.bilibili.com/x/web-interface/view?bvid=BV1234567890", "https://api.bilibili.com/x/player/playurl?cid=101"} {
		if !AllowedAPIURL(raw) {
			t.Fatalf("approved API rejected: %s", raw)
		}
	}
	for _, raw := range []string{testURL, "http://api.bilibili.com/x/web-interface/view", "https://api.bilibili.com/x/other", "https://api.bilibili.com/x/player%2fplayurl", "https://api.bilibili.com.evil.test/x/player/playurl", "https://user@api.bilibili.com/x/player/playurl", "https://api.bilibili.com/x/player/playurl#fragment"} {
		if AllowedAPIURL(raw) {
			t.Fatalf("unapproved API accepted: %s", raw)
		}
	}
	for _, request := range []fetch.Request{viewRequest("BV1234567890", 20*time.Second), playRequest("BV1234567890", "00102", 20*time.Second)} {
		if request.Policy.FollowRedirects || request.Method != http.MethodGet || request.Policy.MaxBytes > 8<<20 || request.Policy.Timeout > 20*time.Second {
			t.Fatalf("unbounded API request: %#v", request)
		}
		for _, name := range []string{"Cookie", "Authorization", "User-Agent", "Referer"} {
			if request.Header.Get(name) != "" {
				t.Fatalf("API introduces %s", name)
			}
		}
	}
}

func TestCancellationStopsEveryRequestBoundary(t *testing.T) {
	for _, boundary := range []string{"before", "share", "page", "view", "play"} {
		t.Run(boundary, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			input := testURL
			if boundary == "share" {
				input = "https://b23.tv/test"
			}
			if boundary == "page" {
				input = "https://www.bilibili.com/video/av123"
			}
			calls := 0
			parser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
				calls++
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > 35*time.Second {
					t.Fatal("parser lacks its shared deadline")
				}
				if request.Policy.Purpose == "bilibili-"+boundary {
					cancel()
					return fetch.Response{}, ctx.Err()
				}
				if request.Policy.Purpose != "bilibili-view" {
					t.Fatalf("unexpected request after cancellation: %s", request.Policy.Purpose)
				}
				return fetch.Response{StatusCode: 200, Body: []byte(testView), URL: request.URL}, nil
			}))
			if boundary == "before" {
				cancel()
			}
			payload, err := parser.Parse(ctx, input, 1793361600)
			if !errors.Is(err, context.Canceled) || payload != nil {
				t.Fatalf("cancellation hidden: payload=%#v err=%v", payload, err)
			}
			want := 1
			if boundary == "before" {
				want = 0
			}
			if boundary == "play" {
				want = 2
			}
			if calls != want {
				t.Fatalf("request count after cancellation: got %d want %d", calls, want)
			}
		})
	}
}

func TestExpiredBudgetDoesNotStartAnotherAPIRequest(t *testing.T) {
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	parser := New(executorFunc(func(context.Context, fetch.Request) (fetch.Response, error) {
		t.Fatal("expired parser budget started a network request")
		return fetch.Response{}, nil
	}))
	response := parser.apiRequest(ctx, viewRequest("BV1234567890", remaining(ctx, 20*time.Second)))
	if failure(response, "视频信息")["code"] != int64(502) {
		t.Fatal("expired API budget did not produce the legacy transport failure")
	}
}

func TestConcurrentParseKeepsPartSelectionIsolated(t *testing.T) {
	parser := New(executorFunc(func(ctx context.Context, request fetch.Request) (fetch.Response, error) {
		body := testView
		if request.Policy.Purpose == "bilibili-play" {
			body = testPlay
			if strings.Contains(request.URL, "cid=102&") {
				body = strings.ReplaceAll(testPlay, "video.mp4", "part2.mp4")
			}
		}
		return fetch.Response{StatusCode: 200, Body: []byte(body), URL: request.URL}, nil
	}))
	var workers sync.WaitGroup
	results := make(chan error, 12)
	for i := 0; i < 12; i++ {
		part := i%2 + 1
		workers.Add(1)
		go func() {
			defer workers.Done()
			payload, err := parser.Parse(context.Background(), fmt.Sprintf("%s?p=%d", testURL, part), 1793361600)
			if err == nil {
				data := unified.Map(payload["data"])
				wantID := fmt.Sprintf("BV1234567890-p%d", part)
				items := unified.Slice(data["items"])
				if len(items) != 2 || data["default_item_id"] != wantID {
					err = fmt.Errorf("concurrent parse selected another part: %#v", data)
				} else {
					current := unified.Map(items[part-1])
					wantURL := "https://upos-test.bilivideo.com/video.mp4"
					if part == 2 {
						wantURL = "https://upos-test.bilivideo.com/part2.mp4"
					}
					if child(current, "default", "url") != wantURL || unified.Map(items[2-part])["state"] != "deferred" {
						err = fmt.Errorf("concurrent parser borrowed another part's source: %#v", items)
					}
				}
			}
			results <- err
		}()
	}
	workers.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestDASHPlayRequestPolicyAndHeaders(t *testing.T) {
	req := dashPlayRequest("BV1GJ411x7h7", int64(101), 15*time.Second)
	wantURL := "https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=4048&qn=120&fourk=1&try_look=1&bvid=BV1GJ411x7h7&cid=101"
	if req.URL != wantURL {
		t.Fatalf("dashPlayRequest URL = %q, want %q", req.URL, wantURL)
	}
	if req.Method != http.MethodGet {
		t.Fatalf("method = %q, want GET", req.Method)
	}
	if req.Header.Get("User-Agent") != desktopUA {
		t.Fatalf("User-Agent = %q, want desktopUA", req.Header.Get("User-Agent"))
	}
	if req.Header.Get("Referer") != "https://www.bilibili.com/" {
		t.Fatalf("Referer = %q, want https://www.bilibili.com/", req.Header.Get("Referer"))
	}
	if req.Header.Get("Accept-Encoding") != "gzip,deflate" {
		t.Fatalf("Accept-Encoding = %q, want gzip,deflate", req.Header.Get("Accept-Encoding"))
	}
	for _, forbidden := range []string{"Cookie", "Authorization"} {
		if req.Header.Get(forbidden) != "" {
			t.Fatalf("dashPlayRequest must not send %s header", forbidden)
		}
	}
	if req.Policy.Purpose != "bilibili-play-dash" || req.Policy.FollowRedirects || req.Policy.MaxBytes > 8<<20 || req.Policy.Timeout != 15*time.Second {
		t.Fatalf("unexpected dashPlayRequest policy: %+v", req.Policy)
	}
	if req.Policy.AllowedURL == nil || !req.Policy.AllowedURL(wantURL) || req.Policy.AllowedURL("https://www.bilibili.com/video/BV1GJ411x7h7/") {
		t.Fatal("dashPlayRequest AllowedURL is not pinned to AllowedAPIURL")
	}
}

func TestFilterAndSortBilibiliDashURLs(t *testing.T) {
	const (
		pcdn     = "https://w9e959o.edge.mountaintoys.cn/upgcxcode/101.m4s?deadline=1800007200"
		mcdnCN   = "https://xy123x45x67x89xy.mcdn.bilivideo.cn/v1/resource/101.m4s?deadline=1800007200"
		akamai   = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/101.m4s?deadline=1800007200"
		cnEdge   = "https://cn-sh-ct-01-02.bilivideo.com/upgcxcode/101.m4s?deadline=1800007200"
		upos1    = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-a.m4s?deadline=1800007200"
		upos2    = "https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/101-b.m4s?deadline=1800007200"
		httpBad  = "http://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101.m4s?deadline=1800007200"
		ipBad    = "https://127.0.0.1/upgcxcode/101.m4s?deadline=1800007200"
		ipv6Bad  = "https://[::1]/upgcxcode/101.m4s?deadline=1800007200"
		userBad  = "https://user:pass@upos-sz-mirrorcosov.bilivideo.com/101.m4s"
		fragBad  = "https://upos-sz-mirrorcosov.bilivideo.com/101.m4s#frag"
		portBad  = "https://upos-sz-mirrorcosov.bilivideo.com:8443/101.m4s"
		apexCom  = "https://bilivideo.com/101.m4s"
		apexCN   = "https://bilivideo.cn/101.m4s"
		apexAkam = "https://akamaized.net/101.m4s"
		spoof    = "https://evilbilivideo.com/101.m4s"
	)

	got := filterAndSortBilibiliDashURLs(pcdn, array{
		mcdnCN,
		akamai,
		httpBad,
		ipBad,
		ipv6Bad,
		userBad,
		fragBad,
		portBad,
		apexCom,
		apexCN,
		apexAkam,
		spoof,
		cnEdge,
		upos1,
		upos2,
		upos1, // duplicate
		mcdnCN,
	})

	want := []string{upos1, upos2, cnEdge, akamai, mcdnCN}
	if len(got) != len(want) {
		t.Fatalf("filtered len = %d (%v), want %d (%v)", len(got), got, len(want), want)
	}
	for i := range want {
		if unified.Str(got[i]) != want[i] {
			t.Fatalf("got[%d] = %q, want %q (all=%v)", i, unified.Str(got[i]), want[i], got)
		}
	}

	if none := filterAndSortBilibiliDashURLs(pcdn, array{httpBad, ipBad, spoof}); len(none) != 0 {
		t.Fatalf("expected nil/empty when all URLs invalid, got %v", none)
	}
}

func TestWithDASHParallelNonCartesianAdaptationAndAttachments(t *testing.T) {
	if (*Parser)(nil).WithDASH(true) != nil {
		t.Fatal("(*Parser)(nil).WithDASH(true) must return nil")
	}

	const (
		now        int64 = 1800000000
		dl         int64 = 1800007200
		bvid             = "BV1234567890"
		durlURL          = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-1-64.mp4?deadline=1800007200"
		v80AVCLo         = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-80-avc-lo.m4s?deadline=1800007200"
		v80AVCHi         = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-80-avc-hi.m4s?deadline=1800007200"
		v80AVCMCDN       = "https://xy123.mcdn.bilivideo.cn/upgcxcode/101-80-avc-hi.m4s?deadline=1800007200"
		v80HEVC          = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/101-80-hevc.m4s?deadline=1800007200"
		v80AV1           = "https://cn-sh-ct-01.bilivideo.com/upgcxcode/101-80-av1.m4s?deadline=1800007200"
		v64AVC           = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-64-avc.m4s?deadline=1800007200"
		v32AVC           = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-32-avc.m4s?deadline=1800007200"
		a30280           = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-30280.m4s?deadline=1800007200"
		a30232           = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-30232.m4s?deadline=1800007200"
		a30216           = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-30216.m4s?deadline=1800007200"
		aFLAC            = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-30251.m4s?deadline=1800007200"
		pcdnURL          = "https://w9e959o.edge.mountaintoys.cn/upgcxcode/101-pcdn.m4s?deadline=1800007200"
	)

	durlJSON, _ := json.Marshal(map[string]any{
		"code": 0,
		"data": map[string]any{
			"quality": 64,
			"format":  "mp4720",
			"durl": []map[string]any{{
				"url":    durlURL,
				"width":  1280,
				"height": 720,
				"size":   5242880,
				"length": 60000,
			}},
		},
	})

	dashJSON, _ := json.Marshal(map[string]any{
		"code": 0,
		"data": map[string]any{
			"quality": 80,
			"dash": map[string]any{
				"video": []map[string]any{
					// Deliberately unsorted + duplicate (80, avc) + PCDN baseUrl!
					{"id": 32, "codecid": 7, "codecs": "avc1.64001E", "width": 852, "height": 480, "frameRate": "30000/1001", "bandwidth": 600000, "baseUrl": v32AVC},
					{"id": 80, "codecid": 13, "codecs": "av01.0.08M.08", "width": 1920, "height": 1080, "frameRate": "29.412", "bandwidth": 1500000, "baseUrl": v80AV1},
					{"id": 80, "codecid": 7, "codecs": "avc1.640028", "width": 1920, "height": 1080, "frameRate": "29.412", "bandwidth": 1800000, "baseUrl": v80AVCLo},
					{"id": 80, "codecid": 12, "codecs": "hev1.1.6.L120.90", "width": 1920, "height": 1080, "frame_rate": "30000/1001", "bandwidth": 1900000, "baseUrl": pcdnURL, "backupUrl": []string{v80HEVC}},
					{"id": 80, "codecid": 7, "codecs": "avc1.640028", "width": 1920, "height": 1080, "frameRate": "29.412", "bandwidth": 2630000, "baseUrl": pcdnURL, "backupUrl": []string{v80AVCMCDN, v80AVCHi}},
					{"id": 64, "codecid": 7, "codecs": "avc1.64001F", "width": 1280, "height": 720, "frameRate": "30", "bandwidth": 1200000, "baseUrl": v64AVC},
				},
				"audio": []map[string]any{
					{"id": 30216, "codecid": 0, "codecs": "mp4a.40.2", "bandwidth": 65000, "baseUrl": a30216},
					{"id": 30251, "codecid": 0, "codecs": "fLaC", "bandwidth": 900000, "baseUrl": aFLAC},
					{"id": 30280, "codecid": 0, "codecs": "mp4a.40.2", "bandwidth": 203000, "baseUrl": pcdnURL, "backupUrl": []string{a30280}},
					{"id": 30232, "codecid": 0, "codecs": "mp4a.40.2", "bandwidth": 134000, "baseUrl": a30232},
				},
			},
		},
	})

	// 1. Default New(executor) makes zero DASH requests and emits zero attachments.
	var defaultDashCalls atomic.Int32
	defaultExec := executorFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		switch req.Policy.Purpose {
		case "bilibili-view":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
		case "bilibili-play":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: durlJSON}, nil
		case "bilibili-play-dash":
			defaultDashCalls.Add(1)
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: dashJSON}, nil
		default:
			return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
		}
	})
	defaultEnv, err := New(defaultExec).Parse(context.Background(), testURL, now)
	if err != nil {
		t.Fatalf("default Parse failed: %v", err)
	}
	if defaultDashCalls.Load() != 0 {
		t.Fatalf("default New(executor) unexpectedly issued %d DASH calls", defaultDashCalls.Load())
	}
	if unified.Map(defaultEnv["data"])["attachments"] != nil {
		t.Fatal("default New(executor) unexpectedly emitted attachments")
	}

	// 2. WithDASH(true) executes playRequest and dashPlayRequest concurrently!
	playEntered := make(chan struct{})
	dashEntered := make(chan struct{})
	bothEntered := make(chan struct{})
	go func() {
		<-playEntered
		<-dashEntered
		close(bothEntered)
	}()

	parallelExec := executorFunc(func(ctx context.Context, req fetch.Request) (fetch.Response, error) {
		switch req.Policy.Purpose {
		case "bilibili-view":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
		case "bilibili-play":
			close(playEntered)
			select {
			case <-bothEntered:
			case <-time.After(1500 * time.Millisecond):
				return fetch.Response{}, errors.New("playRequest and dashPlayRequest did not run in parallel")
			case <-ctx.Done():
				return fetch.Response{}, ctx.Err()
			}
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: durlJSON}, nil
		case "bilibili-play-dash":
			close(dashEntered)
			select {
			case <-bothEntered:
			case <-time.After(1500 * time.Millisecond):
				return fetch.Response{}, errors.New("playRequest and dashPlayRequest did not run in parallel")
			case <-ctx.Done():
				return fetch.Response{}, ctx.Err()
			}
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: dashJSON}, nil
		default:
			return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
		}
	})

	rawEnv, err := New(parallelExec).WithDASH(true).Parse(context.Background(), testURL, now)
	if err != nil {
		t.Fatalf("WithDASH(true) Parse failed: %v", err)
	}
	if err := unified.ValidateEnvelopeAt(rawEnv, now); err != nil {
		t.Fatalf("raw envelope validation failed: %v", err)
	}

	pubEnv, err := PreparePublic(context.Background(), "bilibili", rawEnv, now)
	if err != nil {
		t.Fatalf("PreparePublic failed: %v", err)
	}
	if err := unified.ValidateEnvelopeAt(pubEnv, now); err != nil {
		t.Fatalf("PreparePublic envelope validation failed: %v", err)
	}

	normalView := unified.PublicView(pubEnv, false, now)
	debugView := unified.PublicView(pubEnv, true, now)
	if err := unified.ValidateEnvelopeAt(normalView, now); err != nil {
		t.Fatalf("PublicView(normal) validation failed: %v", err)
	}
	if err := unified.ValidateEnvelopeAt(debugView, now); err != nil {
		t.Fatalf("PublicView(debug) validation failed: %v", err)
	}

	// Verify debug view has 1 durl + 5 deduplicated DASH mux variants (NOT 6x4=24!).
	debugData := unified.Map(debugView["data"])
	debugItem := unified.Map(unified.Slice(debugData["items"])[0])
	debugVariants := unified.Slice(debugItem["variants"])
	if len(debugVariants) != 6 {
		t.Fatalf("debug variants len = %d, want 6 (1 durl + 5 deduped mux)", len(debugVariants))
	}

	wantMuxIDs := []string{"dash-80-avc", "dash-80-hevc", "dash-80-av1", "dash-64-avc", "dash-32-avc"}
	wantLabels := []string{"1080p", "1080p", "1080p", "720p", "480p"}
	for i, wantID := range wantMuxIDs {
		v := unified.Map(debugVariants[i+1])
		if gotID := unified.Str(v["id"]); gotID != wantID {
			t.Fatalf("mux[%d].id = %q, want %q", i, gotID, wantID)
		}
		if gotLabel := unified.Str(v["label"]); gotLabel != wantLabels[i] {
			t.Fatalf("mux[%d].label = %q, want %q", i, gotLabel, wantLabels[i])
		}
		delivery := unified.Map(v["delivery"])
		if unified.Str(delivery["kind"]) != "mux" {
			t.Fatalf("mux[%d].delivery.kind = %q, want mux", i, unified.Str(delivery["kind"]))
		}
		resources := unified.Slice(delivery["resources"])
		if len(resources) != 2 {
			t.Fatalf("mux[%d].resources len = %d, want 2", i, len(resources))
		}
		vidRes := unified.Map(resources[0])
		audRes := unified.Map(resources[1])
		vidMeta := unified.Map(vidRes["metadata"])
		audMeta := unified.Map(audRes["metadata"])
		varMeta := unified.Map(v["metadata"])

		// Video resource must never carry has_audio or audio fields.
		if vidMeta["has_audio"] != nil || vidMeta["audio_codec"] != nil || vidMeta["audio_bitrate_bps"] != nil {
			t.Fatalf("mux[%d] video resource leaked audio metadata: %v", i, vidMeta)
		}
		// Audio resource must carry only audio metadata (30280 mp4a m4a).
		if audMeta["has_audio"] != true || unified.Str(audMeta["audio_codec"]) != "mp4a.40.2" ||
			intValue(audMeta["audio_bitrate_bps"]) != 203000 ||
			unified.Str(audMeta["container"]) != "m4a" || unified.Str(audMeta["extension"]) != "m4a" || unified.Str(audMeta["mime_type"]) != "audio/mp4" {
			t.Fatalf("mux[%d] unexpected audio metadata: %v", i, audMeta)
		}
		if audMeta["width"] != nil || audMeta["height"] != nil || audMeta["video_codec"] != nil {
			t.Fatalf("mux[%d] audio resource leaked video metadata: %v", i, audMeta)
		}
		// Combined variant metadata must expose both video and audio facts cleanly.
		if varMeta["has_audio"] != true || unified.Str(varMeta["container"]) != "mp4" ||
			unified.Str(varMeta["extension"]) != "mp4" || unified.Str(varMeta["mime_type"]) != "video/mp4" ||
			unified.Str(varMeta["evidence"]) != "upstream" ||
			unified.Str(varMeta["audio_codec"]) != "mp4a.40.2" || intValue(varMeta["audio_bitrate_bps"]) != 203000 {
			t.Fatalf("mux[%d] unexpected combined metadata: %v", i, varMeta)
		}
	}

	// Verify dash-80-avc kept the higher-bandwidth duplicate (2630000), filtered out PCDN,
	// sorted upos-*.bilivideo.com before *.mcdn.bilivideo.cn, and annotated expires_at on both!
	avc80 := unified.Map(debugVariants[1])
	if gotBW := intValue(unified.Map(avc80["metadata"])["video_bitrate_bps"]); gotBW != 2630000 {
		t.Fatalf("dash-80-avc video_bitrate_bps = %d, want 2630000 (highest bandwidth duplicate)", gotBW)
	}
	if gotFPS, ok := unified.Numeric(unified.Map(avc80["metadata"])["fps"]); !ok || math.Abs(gotFPS-29.412) > 0.001 {
		t.Fatalf("dash-80-avc fps = %v, want 29.412", unified.Map(avc80["metadata"])["fps"])
	}
	avc80VidSrcs := unified.Slice(unified.Map(unified.Map(unified.Slice(unified.Map(avc80["delivery"])["resources"])[0])["delivery"])["sources"])
	if len(avc80VidSrcs) != 2 ||
		unified.Str(unified.Map(avc80VidSrcs[0])["url"]) != v80AVCHi ||
		unified.Str(unified.Map(avc80VidSrcs[1])["url"]) != v80AVCMCDN {
		t.Fatalf("dash-80-avc video sources = %v, want [upos, mcdn.bilivideo.cn]", avc80VidSrcs)
	}
	wantExp := time.Unix(dl, 0).UTC().Format(time.RFC3339)
	if unified.Str(unified.Map(avc80VidSrcs[0])["browser_fetch"]) != "allowed" || unified.Str(unified.Map(avc80VidSrcs[0])["expires_at"]) != wantExp {
		t.Fatalf("upos source annotations = %v", avc80VidSrcs[0])
	}
	if unified.Map(avc80VidSrcs[1])["browser_fetch"] != nil || unified.Str(unified.Map(avc80VidSrcs[1])["expires_at"]) != wantExp {
		t.Fatalf("bilivideo.cn source should get expires_at without browser_fetch=allowed, got %v", avc80VidSrcs[1])
	}

	// Verify dash-80-hevc parsed fraction frame_rate "30000/1001" AND annotated expires_at on *.akamaized.net!
	hevc80 := unified.Map(debugVariants[2])
	if gotFPS, ok := unified.Numeric(unified.Map(hevc80["metadata"])["fps"]); !ok || math.Abs(gotFPS-30000.0/1001.0) > 0.001 {
		t.Fatalf("dash-80-hevc fps = %v, want 30000/1001", unified.Map(hevc80["metadata"])["fps"])
	}
	hevcSrc0 := unified.Map(unified.Slice(unified.Map(unified.Map(unified.Slice(unified.Map(hevc80["delivery"])["resources"])[0])["delivery"])["sources"])[0])
	if unified.Str(hevcSrc0["url"]) != v80HEVC || unified.Str(hevcSrc0["expires_at"]) != wantExp || hevcSrc0["browser_fetch"] != nil {
		t.Fatalf("akamaized.net source annotations = %v", hevcSrc0)
	}

	// Verify default points to durl file and higher_quality_variants contains the three 1080p mux variants!
	normalItem := unified.Map(unified.Slice(unified.Map(normalView["data"])["items"])[0])
	if unified.Str(unified.Map(normalItem["default"])["url"]) != durlURL {
		t.Fatalf("default.url = %q, want durl %q", unified.Str(unified.Map(normalItem["default"])["url"]), durlURL)
	}
	higher := unified.Slice(normalItem["higher_quality_variants"])
	if len(higher) != 3 {
		t.Fatalf("higher_quality_variants len = %d (%v), want 3 (1080p avc/hevc/av1)", len(higher), higher)
	}
	for i, wantID := range []string{"dash-80-avc", "dash-80-hevc", "dash-80-av1"} {
		entry := unified.Map(higher[i])
		reqs := unified.Slice(entry["requires"])
		if unified.Str(entry["variant_id"]) != wantID || len(reqs) != 1 || unified.Str(reqs[0]) != "mux" {
			t.Fatalf("higher[%d] = %v, want {variant_id:%s, requires:[mux]}", i, entry, wantID)
		}
	}

	// Verify top-level attachments contains the standalone M4A audio attachment with expires_at!
	attachments := unified.Slice(unified.Map(normalView["data"])["attachments"])
	if len(attachments) != 1 {
		t.Fatalf("attachments len = %d, want 1", len(attachments))
	}
	att := unified.Map(attachments[0])
	if unified.Str(att["id"]) != "bilibili-audio-"+bvid+"-p1" || unified.Str(att["role"]) != "background_audio" || unified.Str(att["title"]) != "原声音频 (M4A)" {
		t.Fatalf("unexpected audio attachment: %v", att)
	}
	attSrc0 := unified.Map(unified.Slice(unified.Map(unified.Map(att["resource"])["delivery"])["sources"])[0])
	if unified.Str(attSrc0["url"]) != a30280 || unified.Str(attSrc0["expires_at"]) != wantExp {
		t.Fatalf("unexpected audio attachment source: %v", attSrc0)
	}
}

func TestWithDASHResilientDegradation(t *testing.T) {
	const now int64 = 1800000000
	const (
		durlURL = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-1-64.mp4?deadline=1800007200"
		vidURL  = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-80-avc.m4s?deadline=1800007200"
		audURL  = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-30280.m4s?deadline=1800007200"
	)
	durlBody := `{"code":0,"data":{"quality":64,"durl":[{"url":"` + durlURL + `","width":1280,"height":720}]}}`
	dashOKBody := `{"code":0,"data":{"quality":80,"dash":{"video":[{"id":80,"codecid":7,"codecs":"avc1.640028","width":1920,"height":1080,"bandwidth":2000000,"baseUrl":"` + vidURL + `"}],"audio":[{"id":30280,"codecid":0,"codecs":"mp4a.40.2","bandwidth":192000,"baseUrl":"` + audURL + `"}]}}}`

	// 1. DASH failure cases must silently preserve durl untouched.
	var logBuf shanghaiLockedLogBuffer
	origOut := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(origOut) })

	dashFailCases := []struct {
		name string
		fn   func() (fetch.Response, error)
	}{
		{"network-error", func() (fetch.Response, error) { return fetch.Response{}, errors.New("dial timeout") }},
		{"non-zero-code", func() (fetch.Response, error) {
			return fetch.Response{StatusCode: 200, Body: []byte(`{"code":-412}`)}, nil
		}},
		{"empty-dash", func() (fetch.Response, error) {
			return fetch.Response{StatusCode: 200, Body: []byte(`{"code":0,"data":{"dash":{"video":[],"audio":[]}}}`)}, nil
		}},
		{"pcdn-only-dash", func() (fetch.Response, error) {
			return fetch.Response{StatusCode: 200, Body: []byte(`{"code":0,"data":{"dash":{"video":[{"id":80,"baseUrl":"https://x.edge.mountaintoys.cn/v.m4s"}],"audio":[{"id":30280,"baseUrl":"https://x.edge.mountaintoys.cn/a.m4s"}]}}}`)}, nil
		}},
		{"goroutine-panic", func() (fetch.Response, error) { panic("dash-panic-secret-value") }},
	}
	for _, tc := range dashFailCases {
		t.Run("dash-fails/"+tc.name, func(t *testing.T) {
			exec := executorFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
				switch req.Policy.Purpose {
				case "bilibili-view":
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
				case "bilibili-play":
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(durlBody)}, nil
				case "bilibili-play-dash":
					return tc.fn()
				default:
					return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
				}
			})
			env, err := New(exec).WithDASH(true).Parse(context.Background(), testURL, now)
			if err != nil {
				t.Fatalf("Parse failed on %s: %v", tc.name, err)
			}
			if err := unified.ValidateEnvelopeAt(env, now); err != nil {
				t.Fatalf("ValidateEnvelopeAt failed on %s: %v", tc.name, err)
			}
			data := unified.Map(env["data"])
			if data["attachments"] != nil {
				t.Fatalf("expected no attachments on fallback %s, got %v", tc.name, data["attachments"])
			}
			item := unified.Map(unified.Slice(data["items"])[0])
			if unified.Str(unified.Map(item["default"])["url"]) != durlURL || len(unified.Slice(item["variants"])) != 1 {
				t.Fatalf("expected clean durl fallback on %s, got item=%v", tc.name, item)
			}
		})
	}
	if strings.Contains(logBuf.String(), "dash-panic-secret-value") {
		t.Fatalf("DASH panic recovery log leaked secret: %q", logBuf.String())
	}

	// 2. When html5 durl fails while DASH succeeds, play is synthesized so DASH still works!
	t.Run("durl-fails-dash-succeeds", func(t *testing.T) {
		exec := executorFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			switch req.Policy.Purpose {
			case "bilibili-view":
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
			case "bilibili-play":
				return fetch.Response{StatusCode: 502, URL: req.URL}, nil
			case "bilibili-play-dash":
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(dashOKBody)}, nil
			default:
				return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
			}
		})
		env, err := New(exec).WithDASH(true).Parse(context.Background(), testURL, now)
		if err != nil {
			t.Fatalf("Parse failed when durl failed and dash succeeded: %v", err)
		}
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		data := unified.Map(env["data"])
		item := unified.Map(unified.Slice(data["items"])[0])
		if item["default"] != nil || unified.Str(item["default_unavailable_reason"]) != "processing_required" {
			t.Fatalf("expected null default with processing_required, got item=%v", item)
		}
		variants := unified.Slice(item["variants"])
		if len(variants) != 1 || unified.Str(unified.Map(variants[0])["id"]) != "dash-80-avc" {
			t.Fatalf("expected single dash-80-avc mux variant, got %v", variants)
		}
		if len(unified.Slice(data["attachments"])) != 1 {
			t.Fatalf("expected standalone audio attachment, got %v", data["attachments"])
		}
	})

	// 3. Audio fallback: when no mp4a track exists, selects highest bandwidth valid audio track.
	t.Run("audio-fallback-non-mp4a", func(t *testing.T) {
		dashNonMP4A := `{"code":0,"data":{"quality":80,"dash":{"video":[{"id":80,"codecid":7,"codecs":"avc1.640028","width":1920,"height":1080,"bandwidth":2000000,"baseUrl":"` + vidURL + `"}],"audio":[{"id":30250,"codecs":"ec-3","bandwidth":384000,"baseUrl":"https://upos-sz-mirrorcosov.bilivideo.com/a-low.m4s?deadline=1800007200"},{"id":30251,"codecs":"fLaC","bandwidth":900000,"baseUrl":"https://upos-sz-mirrorcosov.bilivideo.com/a-hi.m4s?deadline=1800007200"}]}}}`
		exec := executorFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			switch req.Policy.Purpose {
			case "bilibili-view":
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
			case "bilibili-play":
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(durlBody)}, nil
			case "bilibili-play-dash":
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(dashNonMP4A)}, nil
			default:
				return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
			}
		})
		env, err := New(exec).WithDASH(true).Parse(context.Background(), testURL, now)
		if err != nil {
			t.Fatalf("Parse failed: %v", err)
		}
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		att := unified.Map(unified.Slice(unified.Map(env["data"])["attachments"])[0])
		attSrc := unified.Map(unified.Slice(unified.Map(unified.Map(att["resource"])["delivery"])["sources"])[0])
		if unified.Str(attSrc["url"]) != "https://upos-sz-mirrorcosov.bilivideo.com/a-hi.m4s?deadline=1800007200" {
			t.Fatalf("expected highest-bandwidth fallback audio track, got %v", attSrc)
		}
	})

	// 4. Context cancellation stops cleanly without blocking.
	t.Run("context-canceled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		exec := executorFunc(func(reqCtx context.Context, req fetch.Request) (fetch.Response, error) {
			if req.Policy.Purpose == "bilibili-view" {
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
			}
			cancel()
			<-reqCtx.Done()
			return fetch.Response{}, reqCtx.Err()
		})
		payload, err := New(exec).WithDASH(true).Parse(ctx, testURL, now)
		if !errors.Is(err, context.Canceled) || payload != nil {
			t.Fatalf("expected context.Canceled with nil payload, got payload=%v err=%v", payload, err)
		}
	})
}

type staticPendingShanghaiResolver struct {
	play    *ShanghaiPlay
	matched atomic.Bool
}

func (r *staticPendingShanghaiResolver) ResolveBilibili(context.Context, string, int64) (*ShanghaiPlay, error) {
	return r.play, nil
}

func (r *staticPendingShanghaiResolver) ResolveBilibiliPending(context.Context, string, int64) (*ShanghaiPlay, func(bool), error) {
	return r.play, func(m bool) { r.matched.Store(m) }, nil
}

func TestWithDASHShanghaiRouteMerge(t *testing.T) {
	const (
		now     int64 = 1800000000
		shDURL        = "https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/101-64.mp4?deadline=1800007200"
		jpDURL        = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-64.mp4?deadline=1800007200"
		shVid80       = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/101-80-avc.m4s?deadline=1800007200"
		jpVid80       = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-80-avc.m4s?deadline=1800007200"
		shAud         = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/101-30280.m4s?deadline=1800007200"
		jpAud         = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-30280.m4s?deadline=1800007200"
	)

	jpExec := executorFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		switch req.Policy.Purpose {
		case "bilibili-view":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
		case "bilibili-play":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":"` + jpDURL + `","width":1280,"height":720}]}}`)}, nil
		case "bilibili-play-dash":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(`{"code":0,"data":{"quality":80,"dash":{"video":[{"id":80,"codecid":7,"codecs":"avc1.640028","width":1920,"height":1080,"bandwidth":2200000,"baseUrl":"` + jpVid80 + `"}],"audio":[{"id":30280,"codecid":0,"codecs":"mp4a.40.2","bandwidth":192000,"baseUrl":"` + jpAud + `"}]}}}`)}, nil
		default:
			return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
		}
	})

	shRes := &staticPendingShanghaiResolver{
		play: &ShanghaiPlay{
			BVID:        "BV1234567890",
			CID:         101,
			DURLQuality: 64,
			DURLPieces:  []ShanghaiDURLPiece{{URLs: []string{shDURL}}},
			DashVideo:   []ShanghaiDashTrack{{ID: 80, CodecID: 7, Codecs: "avc1.640028", URLs: []string{shVid80}}},
			DashAudio:   []ShanghaiDashTrack{{ID: 30280, Codecs: "mp4a.40.2", URLs: []string{shAud}}},
		},
	}

	env, err := NewWithShanghai(jpExec, shRes).WithDASH(true).Parse(context.Background(), testURL, now)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	if err := unified.ValidateEnvelopeAt(env, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}
	if !shRes.matched.Load() {
		t.Fatal("expected Shanghai finish(true) on DASH+DURL match")
	}

	data := unified.Map(env["data"])
	item := unified.Map(unified.Slice(data["items"])[0])
	variants := unified.Slice(item["variants"])
	if len(variants) != 2 {
		t.Fatalf("variants len = %d, want 2", len(variants))
	}
	muxRes := unified.Slice(unified.Map(unified.Map(variants[1])["delivery"])["resources"])
	vidSrcs := unified.Slice(unified.Map(unified.Map(muxRes[0])["delivery"])["sources"])
	audSrcs := unified.Slice(unified.Map(unified.Map(muxRes[1])["delivery"])["sources"])
	if len(vidSrcs) != 2 || unified.Str(unified.Map(vidSrcs[0])["url"]) != shVid80 || unified.Str(unified.Map(vidSrcs[1])["url"]) != jpVid80 {
		t.Fatalf("unexpected merged DASH video sources: %v", vidSrcs)
	}
	if len(audSrcs) != 2 || unified.Str(unified.Map(audSrcs[0])["url"]) != shAud || unified.Str(unified.Map(audSrcs[1])["url"]) != jpAud {
		t.Fatalf("unexpected merged DASH audio sources: %v", audSrcs)
	}
	attSrcs := unified.Slice(unified.Map(unified.Map(unified.Map(unified.Slice(data["attachments"])[0])["resource"])["delivery"])["sources"])
	if len(attSrcs) != 2 || unified.Str(unified.Map(attSrcs[0])["url"]) != shAud || unified.Str(unified.Map(attSrcs[1])["url"]) != jpAud {
		t.Fatalf("unexpected merged audio attachment sources: %v", attSrcs)
	}
}

func TestWithDASHDURLWithoutDimensionsGetsSameQNDASHGeometry(t *testing.T) {
	const (
		now     int64 = 1800000000
		durlURL       = "https://upos-sz-estgoss.bilivideo.com/upgcxcode/101-64.mp4?deadline=1800007200"
		v80AVC        = "https://upos-sz-mirrorhwo1.bilivideo.com/upgcxcode/101-80-avc.m4s?deadline=1800007200"
		v80HEVC       = "https://upos-sz-mirrorhwo1.bilivideo.com/upgcxcode/101-80-hevc.m4s?deadline=1800007200"
		v80AV1        = "https://upos-sz-mirrorhwo1.bilivideo.com/upgcxcode/101-80-av1.m4s?deadline=1800007200"
		v64AVC        = "https://upos-sz-mirrorhwo1.bilivideo.com/upgcxcode/101-64-avc.m4s?deadline=1800007200"
		v64HEVC       = "https://upos-sz-mirrorhwo1.bilivideo.com/upgcxcode/101-64-hevc.m4s?deadline=1800007200"
		a30280        = "https://upos-sz-mirrorcoso1.bilivideo.com/upgcxcode/101-30280.m4s?deadline=1800007200"
	)

	// Real Bilibili html5 playurl omits width/height on durl[0].
	durlBody := `{"code":0,"data":{"quality":64,"format":"mp4720","durl":[{"order":1,"length":212000,"size":51973319,"url":"` + durlURL + `"}]}}`
	dashBody := `{"code":0,"data":{"quality":80,"dash":{"video":[` +
		`{"id":80,"codecid":7,"codecs":"avc1.640032","width":1920,"height":1080,"bandwidth":2600000,"baseUrl":"` + v80AVC + `"},` +
		`{"id":80,"codecid":12,"codecs":"hev1.1.6.L150.90","width":1920,"height":1080,"bandwidth":1900000,"baseUrl":"` + v80HEVC + `"},` +
		`{"id":80,"codecid":13,"codecs":"av01.0.08M.08","width":1920,"height":1080,"bandwidth":1500000,"baseUrl":"` + v80AV1 + `"},` +
		`{"id":64,"codecid":7,"codecs":"avc1.640028","width":1280,"height":720,"bandwidth":1200000,"baseUrl":"` + v64AVC + `"},` +
		`{"id":64,"codecid":12,"codecs":"hev1.1.6.L120.90","width":1280,"height":720,"bandwidth":900000,"baseUrl":"` + v64HEVC + `"}` +
		`],"audio":[{"id":30280,"codecid":0,"codecs":"mp4a.40.2","bandwidth":203000,"baseUrl":"` + a30280 + `"}]}}}`

	exec := executorFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		switch req.Policy.Purpose {
		case "bilibili-view":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
		case "bilibili-play":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(durlBody)}, nil
		case "bilibili-play-dash":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(dashBody)}, nil
		default:
			return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
		}
	})

	rawEnv, err := New(exec).WithDASH(true).Parse(context.Background(), testURL, now)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	pubEnv, err := PreparePublic(context.Background(), "bilibili", rawEnv, now)
	if err != nil {
		t.Fatalf("PreparePublic failed: %v", err)
	}
	view := unified.PublicView(pubEnv, false, now)
	if err := unified.ValidateEnvelopeAt(view, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt failed: %v", err)
	}

	item := unified.Map(unified.Slice(unified.Map(view["data"])["items"])[0])
	variants := unified.Slice(item["variants"])
	durlVar := unified.Map(variants[0])
	durlMeta := unified.Map(durlVar["metadata"])
	if intValue(durlMeta["width"]) != 1280 || intValue(durlMeta["height"]) != 720 {
		t.Fatalf("durl variant metadata = %v, want 1280x720 from same-qn DASH", durlMeta)
	}
	higher := unified.Slice(item["higher_quality_variants"])
	if len(higher) != 3 {
		t.Fatalf("higher_quality_variants len = %d (%v), want 3 (1080p avc/hevc/av1)", len(higher), higher)
	}
	for i, wantID := range []string{"dash-80-avc", "dash-80-hevc", "dash-80-av1"} {
		entry := unified.Map(higher[i])
		reqs := unified.Slice(entry["requires"])
		if unified.Str(entry["variant_id"]) != wantID || len(reqs) != 1 || unified.Str(reqs[0]) != "mux" {
			t.Fatalf("higher[%d] = %v, want {variant_id:%s, requires:[mux]}", i, entry, wantID)
		}
	}

	// Conflicting same-qn DASH dimensions must refuse to guess width/height.
	conflictDash := `{"code":0,"data":{"quality":80,"dash":{"video":[` +
		`{"id":80,"codecid":7,"codecs":"avc1.640032","width":1920,"height":1080,"bandwidth":2600000,"baseUrl":"` + v80AVC + `"},` +
		`{"id":64,"codecid":7,"codecs":"avc1.640028","width":1280,"height":720,"bandwidth":1200000,"baseUrl":"` + v64AVC + `"},` +
		`{"id":64,"codecid":12,"codecs":"hev1.1.6.L120.90","width":1280,"height":718,"bandwidth":900000,"baseUrl":"` + v64HEVC + `"}` +
		`],"audio":[{"id":30280,"codecid":0,"codecs":"mp4a.40.2","bandwidth":203000,"baseUrl":"` + a30280 + `"}]}}}`
	conflictExec := executorFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		switch req.Policy.Purpose {
		case "bilibili-view":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
		case "bilibili-play":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(durlBody)}, nil
		case "bilibili-play-dash":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(conflictDash)}, nil
		default:
			return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
		}
	})
	conflictEnv, err := New(conflictExec).WithDASH(true).Parse(context.Background(), testURL, now)
	if err != nil {
		t.Fatalf("conflict Parse failed: %v", err)
	}
	if err := unified.ValidateEnvelopeAt(conflictEnv, now); err != nil {
		t.Fatalf("conflict ValidateEnvelopeAt failed: %v", err)
	}
	conflictItem := unified.Map(unified.Slice(unified.Map(conflictEnv["data"])["items"])[0])
	conflictDURL := unified.Map(unified.Slice(conflictItem["variants"])[0])
	if unified.Map(conflictDURL["metadata"])["width"] != nil || conflictItem["higher_quality_variants"] != nil {
		t.Fatalf("conflicting same-qn DASH should not assign geometry or higher_quality_variants: durl=%v higher=%v", conflictDURL["metadata"], conflictItem["higher_quality_variants"])
	}
}

func TestWithDASHGraceTimeoutAfterDURLSuccessAndFallbackOnDURLFailure(t *testing.T) {
	if (*Parser)(nil).WithDASHGraceTimeout(time.Second) != nil {
		t.Fatal("(*Parser)(nil).WithDASHGraceTimeout must return nil")
	}

	const (
		now     int64 = 1800000000
		durlURL       = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-64.mp4?deadline=1800007200"
		vidURL        = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-80-avc.m4s?deadline=1800007200"
		audURL        = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-30280.m4s?deadline=1800007200"
	)
	durlBody := `{"code":0,"data":{"quality":64,"durl":[{"url":"` + durlURL + `","width":1280,"height":720}]}}`
	dashBody := `{"code":0,"data":{"quality":80,"dash":{"video":[{"id":80,"codecid":7,"codecs":"avc1.640028","width":1920,"height":1080,"bandwidth":2200000,"baseUrl":"` + vidURL + `"}],"audio":[{"id":30280,"codecid":0,"codecs":"mp4a.40.2","bandwidth":192000,"baseUrl":"` + audURL + `"}]}}}`

	t.Run("durl-fast-dash-hangs-grace-cancels-dash", func(t *testing.T) {
		dashCanceled := make(chan error, 1)
		exec := executorFunc(func(reqCtx context.Context, req fetch.Request) (fetch.Response, error) {
			switch req.Policy.Purpose {
			case "bilibili-view":
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
			case "bilibili-play":
				time.Sleep(10 * time.Millisecond)
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(durlBody)}, nil
			case "bilibili-play-dash":
				select {
				case <-reqCtx.Done():
					dashCanceled <- reqCtx.Err()
					return fetch.Response{}, reqCtx.Err()
				case <-time.After(10 * time.Second):
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(dashBody)}, nil
				}
			default:
				return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
			}
		})

		start := time.Now()
		env, err := New(exec).WithDASH(true).WithDASHGraceTimeout(60*time.Millisecond).Parse(context.Background(), testURL, now)
		elapsed := time.Since(start)
		if err != nil {
			t.Fatalf("Parse failed on DASH grace timeout: %v", err)
		}
		if elapsed >= 300*time.Millisecond {
			t.Fatalf("Parse took %v, want < 300ms after 60ms grace timeout", elapsed)
		}
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		data := unified.Map(env["data"])
		if data["attachments"] != nil {
			t.Fatalf("expected 0 attachments after DASH grace skip, got %v", data["attachments"])
		}
		item := unified.Map(unified.Slice(data["items"])[0])
		if unified.Str(unified.Map(item["default"])["url"]) != durlURL || len(unified.Slice(item["variants"])) != 1 {
			t.Fatalf("expected clean 720p durl fallback after DASH grace skip, got item=%v", item)
		}
		select {
		case cancelErr := <-dashCanceled:
			if !errors.Is(cancelErr, context.Canceled) {
				t.Fatalf("dashCtx err = %v, want context.Canceled", cancelErr)
			}
		case <-time.After(200 * time.Millisecond):
			t.Fatal("dashCtx was not canceled when grace timer expired")
		}
	})

	t.Run("durl-fails-dash-succeeds-after-grace", func(t *testing.T) {
		exec := executorFunc(func(reqCtx context.Context, req fetch.Request) (fetch.Response, error) {
			switch req.Policy.Purpose {
			case "bilibili-view":
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
			case "bilibili-play":
				return fetch.Response{StatusCode: 502, URL: req.URL}, nil
			case "bilibili-play-dash":
				select {
				case <-time.After(120 * time.Millisecond):
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(dashBody)}, nil
				case <-reqCtx.Done():
					return fetch.Response{}, reqCtx.Err()
				}
			default:
				return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
			}
		})

		env, err := New(exec).WithDASH(true).WithDASHGraceTimeout(40*time.Millisecond).Parse(context.Background(), testURL, now)
		if err != nil {
			t.Fatalf("Parse failed when durl failed and dash succeeded after grace: %v", err)
		}
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		data := unified.Map(env["data"])
		item := unified.Map(unified.Slice(data["items"])[0])
		variants := unified.Slice(item["variants"])
		if len(variants) != 1 || unified.Str(unified.Map(variants[0])["id"]) != "dash-80-avc" {
			t.Fatalf("expected DASH fallback variant after durl 502, got %v", variants)
		}
		if len(unified.Slice(data["attachments"])) != 1 {
			t.Fatalf("expected standalone audio attachment on DASH fallback, got %v", data["attachments"])
		}
	})

	t.Run("durl-empty-url-dash-succeeds-after-grace", func(t *testing.T) {
		exec := executorFunc(func(reqCtx context.Context, req fetch.Request) (fetch.Response, error) {
			switch req.Policy.Purpose {
			case "bilibili-view":
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
			case "bilibili-play":
				return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":""}]}}`)}, nil
			case "bilibili-play-dash":
				select {
				case <-time.After(120 * time.Millisecond):
					return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(dashBody)}, nil
				case <-reqCtx.Done():
					return fetch.Response{}, reqCtx.Err()
				}
			default:
				return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
			}
		})

		env, err := New(exec).WithDASH(true).WithDASHGraceTimeout(40*time.Millisecond).Parse(context.Background(), testURL, now)
		if err != nil {
			t.Fatalf("Parse failed when durl had empty url and dash succeeded after grace: %v", err)
		}
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt failed: %v", err)
		}
		item := unified.Map(unified.Slice(unified.Map(env["data"])["items"])[0])
		variants := unified.Slice(item["variants"])
		if len(variants) != 1 || unified.Str(unified.Map(variants[0])["id"]) != "dash-80-avc" {
			t.Fatalf("expected DASH fallback variant when durl url is empty, got %v", variants)
		}
	})
}

func TestDisabledDASHIgnoresUpgradedShanghaiDASHTracks(t *testing.T) {
	const (
		now     int64 = 1800000000
		shDURL        = "https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/101-64.mp4?deadline=1800007200"
		jpDURL        = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/101-64.mp4?deadline=1800007200"
		shVid80       = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/101-80-avc.m4s?deadline=1800007200"
		shAud         = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/101-30280.m4s?deadline=1800007200"
	)

	var dashCalls atomic.Int32
	jpExec := executorFunc(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		switch req.Policy.Purpose {
		case "bilibili-view":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(testView)}, nil
		case "bilibili-play":
			return fetch.Response{StatusCode: 200, URL: req.URL, Body: []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":"` + jpDURL + `","width":1280,"height":720}]}}`)}, nil
		case "bilibili-play-dash":
			dashCalls.Add(1)
			return fetch.Response{}, errors.New("unexpected DASH call when enableDASH=false")
		default:
			return fetch.Response{}, fmt.Errorf("unexpected purpose: %s", req.Policy.Purpose)
		}
	})
	shRes := &staticPendingShanghaiResolver{
		play: &ShanghaiPlay{
			BVID:        "BV1234567890",
			CID:         101,
			DURLQuality: 64,
			DURLPieces:  []ShanghaiDURLPiece{{URLs: []string{shDURL}}},
			DashVideo:   []ShanghaiDashTrack{{ID: 80, CodecID: 7, Codecs: "avc1.640028", URLs: []string{shVid80}}},
			DashAudio:   []ShanghaiDashTrack{{ID: 30280, Codecs: "mp4a.40.2", URLs: []string{shAud}}},
		},
	}

	env, err := NewWithShanghai(jpExec, shRes).WithDASH(false).Parse(context.Background(), testURL, now)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	if dashCalls.Load() != 0 {
		t.Fatalf("dashCalls = %d, want 0 when DASH disabled", dashCalls.Load())
	}
	if !shRes.matched.Load() {
		t.Fatal("expected Shanghai finish(true) on DURL match")
	}
	data := unified.Map(env["data"])
	if data["attachments"] != nil {
		t.Fatalf("expected 0 attachments when DASH disabled, got %v", data["attachments"])
	}
	item := unified.Map(unified.Slice(data["items"])[0])
	variants := unified.Slice(item["variants"])
	if len(variants) != 1 {
		t.Fatalf("variants len = %d, want 1 (durl only, ignoring Shanghai DASH)", len(variants))
	}
	srcs := unified.Slice(unified.Map(unified.Map(variants[0])["delivery"])["sources"])
	if len(srcs) != 2 || unified.Str(unified.Map(srcs[0])["url"]) != shDURL || unified.Str(unified.Map(srcs[1])["url"]) != jpDURL {
		t.Fatalf("unexpected DURL sources: %v", srcs)
	}
	encoded, _ := unified.Encode(env)
	if strings.Contains(string(encoded), shVid80) || strings.Contains(string(encoded), shAud) {
		t.Fatalf("Shanghai DASH URLs leaked into payload when DASH disabled: %s", string(encoded))
	}
}

func TestAdaptDASHModernAudioLessDegradation(t *testing.T) {
	const now int64 = 1800000000
	play := object{
		"dash": object{
			"video": array{
				object{"id": int64(80), "codecid": int64(7), "codecs": "avc1.640028", "width": int64(1920), "height": int64(1080), "bandwidth": int64(2000000), "baseUrl": "https://upos-sz-mirrorcosov.bilivideo.com/v80.m4s?deadline=1800007200"},
			},
			"audio": array{},
		},
	}

	if variants, matched, audio := adaptDASHModern(play, now, nil, true); len(variants) != 0 || matched || audio != nil {
		t.Fatalf("hasDURL=true with no audio: got (%v, %v, %v), want (nil, false, nil)", variants, matched, audio)
	}

	variants, matched, audio := adaptDASHModern(play, now, nil, false)
	if matched || audio != nil || len(variants) != 1 {
		t.Fatalf("hasDURL=false with no audio: got (%v, %v, %v), want 1 deferred variant", variants, matched, audio)
	}
	v := unified.Map(variants[0])
	if unified.Str(v["id"]) != "dash-80-avc" || unified.Str(v["state"]) != "deferred" || unified.Str(child(v, "reason", "code")) != "MISSING_AUDIO_TRACK" {
		t.Fatalf("unexpected deferred variant: %v", v)
	}
}
