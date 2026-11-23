package bilibili

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

type shanghaiTestExecutor func(context.Context, fetch.Request) (fetch.Response, error)

func (f shanghaiTestExecutor) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	return f(ctx, req)
}

func TestValidBVIDAndCID(t *testing.T) {
	for _, valid := range []string{"BV1234567890", "BV1xx411c7mD", "BV1boV66YErZ", "BV1uv411q7Mv"} {
		if !ValidBVID(valid) {
			t.Fatalf("ValidBVID(%q) = false, want true", valid)
		}
	}
	for _, invalid := range []string{
		"",
		"BVabcdefghij",
		"BV2234567890",
		"bv1234567890",
		"BV123456789",
		"BV12345678901",
		"BV12345678_0",
		"BV12345678-0",
		"av170001",
		"https://www.bilibili.com/video/BV1234567890",
	} {
		if ValidBVID(invalid) {
			t.Fatalf("ValidBVID(%q) = true, want false", invalid)
		}
	}
	for _, validCID := range []int64{1, 101, 12345678901} {
		if !ValidCID(validCID) {
			t.Fatalf("ValidCID(%d) = false, want true", validCID)
		}
	}
	for _, invalidCID := range []int64{0, -1, -999999} {
		if ValidCID(invalidCID) {
			t.Fatalf("ValidCID(%d) = true, want false", invalidCID)
		}
	}
}

func TestAllowedAPIURLAndMediaURLValidation(t *testing.T) {
	validAPIs := []string{
		"https://api.bilibili.com/x/web-interface/view?bvid=BV1234567890",
		"https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=3&player=3&qn=112&bvid=BV1234567890&cid=101&platform=html5&high_quality=1",
	}
	for _, u := range validAPIs {
		if !AllowedAPIURL(u) {
			t.Fatalf("AllowedAPIURL(%q) = false, want true", u)
		}
	}
	invalidAPIs := []string{
		"http://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=101",
		"https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1234567890&cid=101",
		"https://api.bilibili.com/x/space/acc/info?mid=1",
		"https://www.bilibili.com/video/BV1234567890/",
		"https://evilapi.bilibili.com/x/player/playurl",
		"https://api.bilibili.com:8443/x/player/playurl",
		"https://user@api.bilibili.com/x/player/playurl",
		"https://api.bilibili.com/x/player/playurl#frag",
	}
	for _, u := range invalidAPIs {
		if AllowedAPIURL(u) {
			t.Fatalf("AllowedAPIURL(%q) = true, want false", u)
		}
	}

	validMedia := []string{
		"https://cn-zjhz-cu-01-01.bilivideo.com/upgcxcode/12/34/101/101-1-64.mp4?deadline=1800007200&upsig=abc",
		"https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/12/34/101/101-1-64.mp4?deadline=4133980800&upsig=def",
		"https://xy123x45x67x89xy.mcdn.bilivideo.com:443/v1/resource/101.m4s?deadline=1800003600",
	}
	for _, u := range validMedia {
		if !AllowedBrowserFetchURL(u) {
			t.Fatalf("AllowedBrowserFetchURL(%q) = false, want true", u)
		}
		exp, ok := MediaURLDeadline(u)
		if !ok || exp <= 0 {
			t.Fatalf("MediaURLDeadline(%q) = (%d, %v), want valid expiry", u, exp, ok)
		}
	}

	invalidMedia := []string{
		"http://cn-zjhz-cu-01-01.bilivideo.com/upgcxcode/12/34/101/101-1-64.mp4?deadline=1800007200",
		"https://bilivideo.com/upgcxcode/12/34/101/101-1-64.mp4?deadline=1800007200",
		"https://evilbilivideo.com/upgcxcode/12/34/101/101-1-64.mp4?deadline=1800007200",
		"https://bilivideo.com.attacker.example/upgcxcode/12/34/101/101-1-64.mp4?deadline=1800007200",
		"https://-bad.bilivideo.com/v.mp4?deadline=1800007200",
		"https://cn..bilivideo.com/v.mp4?deadline=1800007200",
		"https://127.0.0.1/v.mp4?deadline=1800007200",
		"https://user:pass@cn-zjhz-cu-01-01.bilivideo.com/v.mp4?deadline=1800007200",
		"https://cn-zjhz-cu-01-01.bilivideo.com:8443/v.mp4?deadline=1800007200",
		"https://cn-zjhz-cu-01-01.bilivideo.com/v.mp4?deadline=1800007200#frag",
	}
	for _, u := range invalidMedia {
		if AllowedBrowserFetchURL(u) {
			t.Fatalf("AllowedBrowserFetchURL(%q) = true, want false", u)
		}
	}

	badDeadlines := []string{
		"https://cn-zjhz-cu-01-01.bilivideo.com/v.mp4",
		"https://cn-zjhz-cu-01-01.bilivideo.com/v.mp4?deadline=notanumber",
		"https://cn-zjhz-cu-01-01.bilivideo.com/v.mp4?deadline=999999999",
		"https://cn-zjhz-cu-01-01.bilivideo.com/v.mp4?deadline=1800007200&deadline=1800007201",
	}
	for _, u := range badDeadlines {
		if _, ok := MediaURLDeadline(u); ok {
			t.Fatalf("MediaURLDeadline(%q) = true, want false", u)
		}
	}

	validShanghaiUPOS := []string{
		"https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/12/34/101/101-1-64.mp4?deadline=1800007200&upsig=abc",
		"https://upos-sz-mirrorcoso1.bilivideo.com/upgcxcode/12/34/101/101-1-30080.m4s?deadline=1800007200",
		"https://upos-sz-mirrorhw.bilivideo.com:443/upgcxcode/12/34/101/101-1-30280.m4s?deadline=1800007200",
		"https://UPOS-SZ-ESTGOSS.bilivideo.com/upgcxcode/12/34/101/101-1-80.mp4?deadline=1800007200",
	}
	for _, u := range validShanghaiUPOS {
		if !AllowedShanghaiMediaURL(u) {
			t.Fatalf("AllowedShanghaiMediaURL(%q) = false, want true", u)
		}
		if exp, ok := ValidateShanghaiMediaURL(u, true); !ok || exp != 1800007200 {
			t.Fatalf("ValidateShanghaiMediaURL(%q, true) = (%d, %v), want (1800007200, true)", u, exp, ok)
		}
	}

	rejectedShanghai := []string{
		"https://cn-zjhz-cu-01-01.bilivideo.com/upgcxcode/12/34/101/101-1-64.mp4?deadline=1800007200",
		"https://cn-sh-fx-01-01.bilivideo.com/upgcxcode/12/34/101/101-1-80.mp4?deadline=1800007200",
		"https://xy123x45x67x89xy.mcdn.bilivideo.com/v1/resource/101.m4s?deadline=1800007200",
		"https://xy123x45x67x89xy.mcdn.bilivideo.cn/v1/resource/101.m4s?deadline=1800007200",
		"https://upos-sz-mirrorcos.mcdn.bilivideo.com/upgcxcode/101.m4s?deadline=1800007200",
		"https://upos-sz-mirrorcos.bilivideo.cn/upgcxcode/101.m4s?deadline=1800007200",
		"https://upos-.bilivideo.com/upgcxcode/101.mp4?deadline=1800007200",
		"https://upos.bilivideo.com/upgcxcode/101.mp4?deadline=1800007200",
		"http://upos-sz-mirrorcos.bilivideo.com/upgcxcode/101.mp4?deadline=1800007200",
		"https://upos-sz-mirrorcos.bilivideo.com:8443/upgcxcode/101.mp4?deadline=1800007200",
		"https://w9e959o.edge.mountaintoys.cn/pcdn.m4s?deadline=1800007200",
	}
	for _, u := range rejectedShanghai {
		if AllowedShanghaiMediaURL(u) {
			t.Fatalf("AllowedShanghaiMediaURL(%q) = true, want false", u)
		}
		if _, ok := ValidateShanghaiMediaURL(u, false); ok {
			t.Fatalf("ValidateShanghaiMediaURL(%q, false) = true, want false", u)
		}
	}
}

func TestFetchShanghaiPlayOutboundPolicyAndCandidateFiltering(t *testing.T) {
	const (
		bvid      = "BV1234567890"
		cid       = int64(101)
		wantPlay  = "https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=3&player=3&qn=112&bvid=BV1234567890&cid=101&platform=html5&high_quality=1"
		wantDash  = "https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=4048&qn=120&fourk=1&try_look=1&bvid=BV1234567890&cid=101"
		cnDURL    = "https://cn-zjhz-cu-01-01.bilivideo.com/upgcxcode/00/01/101/101-1-64.mp4?deadline=1800007200&upsig=cn_drop"
		goodDURL  = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/01/101/101-1-64.mp4?deadline=1800007200&upsig=dom1"
		goodBack  = "https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/00/01/101/101-1-64.mp4?deadline=1800007200&upsig=dom2"
		uposDashV = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/01/101/101-1-30080.m4s?deadline=1800007200&upsig=dv_upos"
		cnDashV   = "https://cn-zjhz-cu-01-01.bilivideo.com/upgcxcode/00/01/101/101-1-30080.m4s?deadline=1800007200&upsig=dv_cn_drop"
		goodDashA = "https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/00/01/101/101-1-30280.m4s?deadline=1800007200&upsig=da1"
	)

	durlBody := `{
		"code": 0,
		"data": {
			"quality": 64,
			"durl": [{
				"url": "` + cnDURL + `",
				"backup_url": [
					"http://upos-sz-mirrorcos.bilivideo.com/101.mp4?deadline=1800007200",
					"https://xy123.mcdn.bilivideo.com/mcdn.mp4?deadline=1800007200",
					"https://bilivideo.com/apex.mp4?deadline=1800007200",
					"https://evilbilivideo.com/spoof.mp4?deadline=1800007200",
					"https://upos-bad-exp.bilivideo.com/bad.mp4?deadline=bad",
					"` + goodDURL + `",
					"` + goodBack + `",
					"` + goodDURL + `"
				]
			}]
		}
	}`
	dashBody := `{
		"code": 0,
		"data": {
			"quality": 80,
			"dash": {
				"video": [
					{
						"id": 80, "codecid": 7, "codecs": "avc1.640028",
						"baseUrl": "https://w9e959o.edge.mountaintoys.cn/pcdn.m4s?deadline=1800007200",
						"backupUrl": [
							"https://xy123.mcdn.bilivideo.cn/mcdn.m4s?deadline=1800007200",
							"https://xy123.mcdn.bilivideo.com/mcdn2.m4s?deadline=1800007200",
							"` + cnDashV + `",
							"` + uposDashV + `",
							"https://evilbilivideo.com/v.m4s?deadline=1800007200",
							"` + uposDashV + `"
						]
					},
					{"id": 64, "codecid": 7, "codecs": "avc1.64001F", "baseUrl": "https://cn-sh-ct-01-02.bilivideo.com/v64.m4s?deadline=1800007200"}
				],
				"audio": [
					{"id": 30280, "codecid": 0, "codecs": "mp4a.40.2", "base_url": "` + goodDashA + `", "backup_url": ["https://cn-sh-ct-01-02.bilivideo.com/a.m4s?deadline=1800007200", "https://w9e959o.edge.mountaintoys.cn/a.m4s?deadline=1800007200"]}
				]
			}
		}
	}`

	// 0. Default FetchShanghaiPlay (and explicit EnableDASH: false) issues strictly the single durl request (0 DASH calls).
	var defaultPlayCalls, defaultDashCalls atomic.Int32
	defaultExec := shanghaiTestExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		switch req.Policy.Purpose {
		case "bilibili-play":
			defaultPlayCalls.Add(1)
			return fetch.Response{StatusCode: http.StatusOK, Body: []byte(durlBody)}, nil
		case "bilibili-play-dash":
			defaultDashCalls.Add(1)
			return fetch.Response{StatusCode: http.StatusOK, Body: []byte(dashBody)}, nil
		default:
			return fetch.Response{}, errors.New("unexpected purpose: " + req.Policy.Purpose)
		}
	})
	defaultGot, err := FetchShanghaiPlay(context.Background(), defaultExec, bvid, cid)
	if err != nil {
		t.Fatalf("default FetchShanghaiPlay failed: %v", err)
	}
	if defaultPlayCalls.Load() != 1 || defaultDashCalls.Load() != 0 {
		t.Fatalf("default FetchShanghaiPlay playCalls=%d dashCalls=%d, want 1 and 0", defaultPlayCalls.Load(), defaultDashCalls.Load())
	}
	if defaultGot.DURLQuality != 64 || len(defaultGot.DURLPieces) != 1 || len(defaultGot.DashVideo) != 0 || len(defaultGot.DashAudio) != 0 {
		t.Fatalf("unexpected default FetchShanghaiPlay result: %+v", defaultGot)
	}

	// Verify both html5 durl and DASH try_look=1 run concurrently when EnableDASH is true.
	durlEntered := make(chan struct{})
	dashEntered := make(chan struct{})
	bothEntered := make(chan struct{})
	go func() {
		<-durlEntered
		<-dashEntered
		close(bothEntered)
	}()

	var playCalls, dashCalls atomic.Int32
	exec := shanghaiTestExecutor(func(ctx context.Context, req fetch.Request) (fetch.Response, error) {
		if req.Method != http.MethodGet {
			return fetch.Response{}, errors.New("unexpected method: " + req.Method)
		}
		if req.Policy.FollowRedirects {
			return fetch.Response{}, errors.New("Shanghai playurl request must not follow redirects")
		}
		if req.Header.Get("Cookie") != "" {
			return fetch.Response{}, errors.New("Shanghai playurl request must not carry Cookie")
		}
		if req.Policy.AllowedURL == nil || !req.Policy.AllowedURL(req.URL) || req.Policy.AllowedURL("https://www.bilibili.com/video/BV1234567890") {
			return fetch.Response{}, errors.New("Shanghai playurl request AllowedURL policy is not pinned to official API endpoints")
		}
		switch req.Policy.Purpose {
		case "bilibili-play":
			if req.URL != wantPlay {
				return fetch.Response{}, errors.New("unexpected durl URL: " + req.URL)
			}
			if req.Header.Get("User-Agent") != desktopUA ||
				req.Header.Get("Referer") != "https://www.bilibili.com/" ||
				req.Header.Get("Origin") != "https://www.bilibili.com" ||
				req.Header.Get("Accept") != "application/json, text/plain, */*" ||
				req.Header.Get("Accept-Language") != "zh-CN,zh;q=0.9" ||
				req.Header.Get("Accept-Encoding") != "gzip,deflate" {
				return fetch.Response{}, errors.New("unexpected Shanghai durl browser headers")
			}
			playCalls.Add(1)
			close(durlEntered)
			select {
			case <-bothEntered:
			case <-time.After(1500 * time.Millisecond):
				return fetch.Response{}, errors.New("durl and dash did not execute concurrently")
			case <-ctx.Done():
				return fetch.Response{}, ctx.Err()
			}
			return fetch.Response{StatusCode: http.StatusOK, Body: []byte(durlBody)}, nil
		case "bilibili-play-dash":
			if req.URL != wantDash ||
				req.Header.Get("Referer") != "https://www.bilibili.com/" ||
				req.Header.Get("Origin") != "https://www.bilibili.com" ||
				req.Header.Get("User-Agent") != desktopUA ||
				req.Header.Get("Accept") != "application/json, text/plain, */*" ||
				req.Header.Get("Accept-Language") != "zh-CN,zh;q=0.9" ||
				req.Header.Get("Accept-Encoding") != "gzip,deflate" {
				return fetch.Response{}, errors.New("unexpected dash request: " + req.URL)
			}
			dashCalls.Add(1)
			close(dashEntered)
			select {
			case <-bothEntered:
			case <-time.After(1500 * time.Millisecond):
				return fetch.Response{}, errors.New("durl and dash did not execute concurrently")
			case <-ctx.Done():
				return fetch.Response{}, ctx.Err()
			}
			return fetch.Response{StatusCode: http.StatusOK, Body: []byte(dashBody)}, nil
		default:
			return fetch.Response{}, errors.New("unexpected purpose: " + req.Policy.Purpose)
		}
	})

	dashOpts := ShanghaiPlayOptions{EnableDASH: true}
	got, err := FetchShanghaiPlayWithOptions(context.Background(), exec, bvid, cid, dashOpts)
	if err != nil {
		t.Fatalf("FetchShanghaiPlayWithOptions(EnableDASH=true) failed: %v", err)
	}
	if playCalls.Load() != 1 || dashCalls.Load() != 1 {
		t.Fatalf("playCalls=%d dashCalls=%d, want 1 and 1", playCalls.Load(), dashCalls.Load())
	}
	if got.BVID != bvid || got.CID != cid || got.DURLQuality != 64 || len(got.DURLPieces) != 1 {
		t.Fatalf("unexpected DURL summary: %+v", got)
	}
	if len(got.DURLPieces[0].URLs) != 2 || got.DURLPieces[0].URLs[0] != goodDURL || got.DURLPieces[0].URLs[1] != goodBack {
		t.Fatalf("unexpected filtered DURL URLs: %v", got.DURLPieces[0].URLs)
	}
	// Strictly upos-*.bilivideo.com survives on both DURL and DASH; cn-*, mcdn.*, *.bilivideo.cn, and PCDN are 100% filtered out.
	if len(got.DashVideo) != 1 || got.DashVideo[0].ID != 80 || len(got.DashVideo[0].URLs) != 1 ||
		got.DashVideo[0].URLs[0] != uposDashV {
		t.Fatalf("unexpected filtered DashVideo: %+v", got.DashVideo)
	}
	if len(got.DashAudio) != 1 || got.DashAudio[0].ID != 30280 || len(got.DashAudio[0].URLs) != 1 || got.DashAudio[0].URLs[0] != goodDashA {
		t.Fatalf("unexpected filtered DashAudio: %+v", got.DashAudio)
	}

	// Partial failure #1: durl fails while dash succeeds -> still returns DASH routes!
	durlFailsExec := shanghaiTestExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		if req.Policy.Purpose == "bilibili-play" {
			return fetch.Response{StatusCode: http.StatusBadGateway}, nil
		}
		return fetch.Response{StatusCode: http.StatusOK, Body: []byte(dashBody)}, nil
	})
	dashOnlyGot, err := FetchShanghaiPlayWithOptions(context.Background(), durlFailsExec, bvid, cid, dashOpts)
	if err != nil {
		t.Fatalf("expected DASH-only partial success when durl fails, got err=%v", err)
	}
	if len(dashOnlyGot.DURLPieces) != 0 || len(dashOnlyGot.DashVideo) != 1 || len(dashOnlyGot.DashAudio) != 1 {
		t.Fatalf("unexpected DASH-only partial result: %+v", dashOnlyGot)
	}

	// Partial failure #2: dash fails (or panics) while durl succeeds -> still returns DURL routes!
	var logBuf shanghaiLockedLogBuffer
	origOut := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(origOut) })
	dashPanicsExec := shanghaiTestExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		if req.Policy.Purpose == "bilibili-play-dash" {
			panic("shanghai-dash-panic-secret")
		}
		return fetch.Response{StatusCode: http.StatusOK, Body: []byte(durlBody)}, nil
	})
	durlOnlyGot, err := FetchShanghaiPlayWithOptions(context.Background(), dashPanicsExec, bvid, cid, dashOpts)
	if err != nil {
		t.Fatalf("expected DURL-only partial success when dash panics, got err=%v", err)
	}
	if durlOnlyGot.DURLQuality != 64 || len(durlOnlyGot.DURLPieces) != 1 || len(durlOnlyGot.DashVideo) != 0 {
		t.Fatalf("unexpected DURL-only partial result: %+v", durlOnlyGot)
	}
	if strings.Contains(logBuf.String(), "shanghai-dash-panic-secret") {
		t.Fatalf("panic recovery log leaked secret: %q", logBuf.String())
	}

	// All invalid or regional cn-* URLs -> FetchShanghaiPlayWithOptions returns error (empty routes) rather than leaking cn-*.
	cnOnlyExec := shanghaiTestExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		if req.Policy.Purpose == "bilibili-play-dash" {
			return fetch.Response{
				StatusCode: http.StatusOK,
				Body:       []byte(`{"code":0,"data":{"quality":80,"dash":{"video":[{"id":80,"codecid":7,"baseUrl":"` + cnDashV + `","backupUrl":["https://xy123.mcdn.bilivideo.com/v.m4s?deadline=1800007200"]}],"audio":[{"id":30280,"codecid":0,"baseUrl":"https://cn-sh-ct-01-02.bilivideo.com/a.m4s?deadline=1800007200"}]}}}`),
			}, nil
		}
		return fetch.Response{
			StatusCode: http.StatusOK,
			Body:       []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":"` + cnDURL + `","backup_url":["https://xy123.mcdn.bilivideo.com/1.mp4?deadline=1800007200"]}]}}`),
		}, nil
	})
	if got, err := FetchShanghaiPlayWithOptions(context.Background(), cnOnlyExec, bvid, cid, dashOpts); err == nil || got != nil {
		t.Fatalf("expected empty-route error when Shanghai only yields cn-*/mcdn URLs, got play=%+v err=%v", got, err)
	}

	// DURL returns cn-* only while DASH returns upos-* -> DURLPieces stays empty (Japan fallback for default) while DASH keeps upos-*.
	cnDURLUposDashExec := shanghaiTestExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		if req.Policy.Purpose == "bilibili-play-dash" {
			return fetch.Response{StatusCode: http.StatusOK, Body: []byte(dashBody)}, nil
		}
		return fetch.Response{
			StatusCode: http.StatusOK,
			Body:       []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":"` + cnDURL + `"}]}}`),
		}, nil
	})
	cnDURLGot, err := FetchShanghaiPlayWithOptions(context.Background(), cnDURLUposDashExec, bvid, cid, dashOpts)
	if err != nil {
		t.Fatalf("expected DASH-only success when DURL has only cn-*, got err=%v", err)
	}
	if cnDURLGot.DURLQuality != 0 || len(cnDURLGot.DURLPieces) != 0 || len(cnDURLGot.DashVideo) != 1 || cnDURLGot.DashVideo[0].URLs[0] != uposDashV {
		t.Fatalf("unexpected cn-DURL + upos-DASH result: %+v", cnDURLGot)
	}

	// All invalid URLs -> FetchShanghaiPlay returns error rather than empty play.
	allBadExec := shanghaiTestExecutor(func(_ context.Context, _ fetch.Request) (fetch.Response, error) {
		return fetch.Response{
			StatusCode: http.StatusOK,
			Body:       []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":"http://upos-sz-mirrorcos.bilivideo.com/a.mp4"},{"url":"https://evilbilivideo.com/b.mp4"}]}}`),
		}, nil
	})
	if _, err := FetchShanghaiPlay(context.Background(), allBadExec, bvid, cid); err == nil {
		t.Fatal("expected error when all candidate URLs fail validation")
	}

	// Multi-segment DURL with one invalid (or cn-*) segment drops DURLPieces completely rather than shifting piece indices.
	partialSegExec := shanghaiTestExecutor(func(_ context.Context, _ fetch.Request) (fetch.Response, error) {
		return fetch.Response{
			StatusCode: http.StatusOK,
			Body:       []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":"` + goodDURL + `"},{"url":"` + cnDURL + `"}],"dash":{"video":[{"id":80,"codecid":7,"baseUrl":"` + uposDashV + `"}]}}}`),
		}, nil
	})
	partialGot, err := FetchShanghaiPlay(context.Background(), partialSegExec, bvid, cid)
	if err != nil {
		t.Fatalf("partialSegExec failed: %v", err)
	}
	if partialGot.DURLQuality != 0 || len(partialGot.DURLPieces) != 0 || len(partialGot.DashVideo) != 1 {
		t.Fatalf("incomplete multi-segment DURL should be dropped while keeping valid DASH: %+v", partialGot)
	}
}

func TestFetchShanghaiPlayWithOptionsDASHGraceTimeoutAndFallback(t *testing.T) {
	const (
		bvid      = "BV1234567890"
		cid       = int64(101)
		goodDURL  = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/01/101/101-1-64.mp4?deadline=1800007200&upsig=dom1"
		uposDashV = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/01/101/101-1-30080.m4s?deadline=1800007200&upsig=dv"
		uposDashA = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/01/101/101-1-30280.m4s?deadline=1800007200&upsig=da"
	)
	durlBody := `{"code":0,"data":{"quality":64,"durl":[{"url":"` + goodDURL + `"}]}}`
	dashBody := `{"code":0,"data":{"quality":80,"dash":{"video":[{"id":80,"codecid":7,"codecs":"avc1.640028","baseUrl":"` + uposDashV + `"}],"audio":[{"id":30280,"codecid":0,"codecs":"mp4a.40.2","base_url":"` + uposDashA + `"}]}}}`

	t.Run("durl-fast-dash-hangs-grace-cancels-dash", func(t *testing.T) {
		dashCanceled := make(chan error, 1)
		exec := shanghaiTestExecutor(func(reqCtx context.Context, req fetch.Request) (fetch.Response, error) {
			switch req.Policy.Purpose {
			case "bilibili-play":
				time.Sleep(10 * time.Millisecond)
				return fetch.Response{StatusCode: http.StatusOK, Body: []byte(durlBody)}, nil
			case "bilibili-play-dash":
				select {
				case <-reqCtx.Done():
					dashCanceled <- reqCtx.Err()
					return fetch.Response{}, reqCtx.Err()
				case <-time.After(10 * time.Second):
					return fetch.Response{StatusCode: http.StatusOK, Body: []byte(dashBody)}, nil
				}
			default:
				return fetch.Response{}, errors.New("unexpected purpose: " + req.Policy.Purpose)
			}
		})

		start := time.Now()
		got, err := FetchShanghaiPlayWithOptions(context.Background(), exec, bvid, cid, ShanghaiPlayOptions{
			EnableDASH:       true,
			DASHGraceTimeout: 60 * time.Millisecond,
		})
		elapsed := time.Since(start)
		if err != nil {
			t.Fatalf("FetchShanghaiPlayWithOptions failed on DASH grace timeout: %v", err)
		}
		if elapsed >= 300*time.Millisecond {
			t.Fatalf("FetchShanghaiPlayWithOptions took %v, want < 300ms after 60ms grace timeout", elapsed)
		}
		if got.DURLQuality != 64 || len(got.DURLPieces) != 1 || got.DURLPieces[0].URLs[0] != goodDURL {
			t.Fatalf("unexpected DURL result after grace timeout: %+v", got)
		}
		if len(got.DashVideo) != 0 || len(got.DashAudio) != 0 {
			t.Fatalf("expected empty DASH tracks after grace skip, got %+v", got)
		}
		select {
		case cancelErr := <-dashCanceled:
			if !errors.Is(cancelErr, context.Canceled) {
				t.Fatalf("shanghai dashCtx err = %v, want context.Canceled", cancelErr)
			}
		case <-time.After(200 * time.Millisecond):
			t.Fatal("shanghai dashCtx was not canceled when grace timer expired")
		}
	})

	t.Run("durl-fails-dash-succeeds-after-grace", func(t *testing.T) {
		exec := shanghaiTestExecutor(func(reqCtx context.Context, req fetch.Request) (fetch.Response, error) {
			if req.Policy.Purpose == "bilibili-play" {
				return fetch.Response{StatusCode: http.StatusBadGateway}, nil
			}
			select {
			case <-time.After(120 * time.Millisecond):
				return fetch.Response{StatusCode: http.StatusOK, Body: []byte(dashBody)}, nil
			case <-reqCtx.Done():
				return fetch.Response{}, reqCtx.Err()
			}
		})

		got, err := FetchShanghaiPlayWithOptions(context.Background(), exec, bvid, cid, ShanghaiPlayOptions{
			EnableDASH:       true,
			DASHGraceTimeout: 40 * time.Millisecond,
		})
		if err != nil {
			t.Fatalf("expected DASH fallback when durl fails, got err=%v", err)
		}
		if len(got.DURLPieces) != 0 || len(got.DashVideo) != 1 || len(got.DashAudio) != 1 {
			t.Fatalf("unexpected DASH fallback result: %+v", got)
		}
	})

	t.Run("durl-invalid-urls-dash-succeeds-after-grace", func(t *testing.T) {
		exec := shanghaiTestExecutor(func(reqCtx context.Context, req fetch.Request) (fetch.Response, error) {
			if req.Policy.Purpose == "bilibili-play" {
				return fetch.Response{
					StatusCode: http.StatusOK,
					Body:       []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":"https://evilbilivideo.com/v.mp4?deadline=1800007200"}]}}`),
				}, nil
			}
			select {
			case <-time.After(120 * time.Millisecond):
				return fetch.Response{StatusCode: http.StatusOK, Body: []byte(dashBody)}, nil
			case <-reqCtx.Done():
				return fetch.Response{}, reqCtx.Err()
			}
		})

		got, err := FetchShanghaiPlayWithOptions(context.Background(), exec, bvid, cid, ShanghaiPlayOptions{
			EnableDASH:       true,
			DASHGraceTimeout: 40 * time.Millisecond,
		})
		if err != nil {
			t.Fatalf("expected DASH fallback when durl has no valid domestic URLs, got err=%v", err)
		}
		if len(got.DURLPieces) != 0 || len(got.DashVideo) != 1 || len(got.DashAudio) != 1 {
			t.Fatalf("unexpected DASH fallback result: %+v", got)
		}
	})
}

type blockingShanghaiResolver struct {
	started  chan struct{}
	canceled chan error
}

func (r *blockingShanghaiResolver) ResolveBilibili(ctx context.Context, _ string, _ int64) (*ShanghaiPlay, error) {
	close(r.started)
	<-ctx.Done()
	err := ctx.Err()
	r.canceled <- err
	return nil, err
}

type blockingPendingShanghaiResolver struct {
	started  chan struct{}
	canceled chan error
}

func (r *blockingPendingShanghaiResolver) ResolveBilibili(ctx context.Context, bvid string, cid int64) (*ShanghaiPlay, error) {
	play, _, err := r.ResolveBilibiliPending(ctx, bvid, cid)
	return play, err
}

func (r *blockingPendingShanghaiResolver) ResolveBilibiliPending(ctx context.Context, _ string, _ int64) (*ShanghaiPlay, func(bool), error) {
	close(r.started)
	<-ctx.Done()
	err := ctx.Err()
	r.canceled <- err
	return nil, nil, err
}

func TestShanghaiCallAbortCancelsChildContextWithoutCancelingParent(t *testing.T) {
	parent, cancelParent := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelParent()

	// 1. Standard ShanghaiResolver: abort() immediately cancels in-flight ResolveBilibili ctx.
	res1 := &blockingShanghaiResolver{
		started:  make(chan struct{}),
		canceled: make(chan error, 1),
	}
	call1 := startShanghaiCall(parent, res1, "BV1234567890", 101)
	if call1 == nil {
		t.Fatal("expected non-nil shanghaiCall")
	}
	<-res1.started
	call1.abort()
	select {
	case err := <-res1.canceled:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("ResolveBilibili ctx err = %v, want context.Canceled", err)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("abort() did not cancel in-flight ResolveBilibili child context promptly")
	}
	if parent.Err() != nil {
		t.Fatalf("abort() unexpectedly canceled parent context: %v", parent.Err())
	}

	// 2. Pending shanghaiPendingResolver: abort() immediately cancels in-flight ResolveBilibiliPending ctx,
	//    and repeated abort() calls remain idempotent and race-free.
	res2 := &blockingPendingShanghaiResolver{
		started:  make(chan struct{}),
		canceled: make(chan error, 1),
	}
	call2 := startShanghaiCall(parent, res2, "BV1234567890", 101)
	if call2 == nil {
		t.Fatal("expected non-nil pending shanghaiCall")
	}
	<-res2.started
	call2.abort()
	call2.abort()
	select {
	case err := <-res2.canceled:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("ResolveBilibiliPending ctx err = %v, want context.Canceled", err)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("abort() did not cancel in-flight ResolveBilibiliPending child context promptly")
	}
	<-call2.done
	if parent.Err() != nil {
		t.Fatalf("abort() unexpectedly canceled parent context: %v", parent.Err())
	}
}

type shanghaiLockedLogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *shanghaiLockedLogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *shanghaiLockedLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type panickingShanghaiResolver struct {
	ctxCanceled chan struct{}
}

func (r *panickingShanghaiResolver) ResolveBilibili(ctx context.Context, _ string, _ int64) (*ShanghaiPlay, error) {
	go func() {
		<-ctx.Done()
		close(r.ctxCanceled)
	}()
	panic("bili-secret-token-https://sh.example/leak?token=bilisecret1")
}

type panickingPendingShanghaiResolver struct {
	ctxCanceled chan struct{}
}

func (r *panickingPendingShanghaiResolver) ResolveBilibili(ctx context.Context, bvid string, cid int64) (*ShanghaiPlay, error) {
	play, _, err := r.ResolveBilibiliPending(ctx, bvid, cid)
	return play, err
}

func (r *panickingPendingShanghaiResolver) ResolveBilibiliPending(ctx context.Context, _ string, _ int64) (*ShanghaiPlay, func(bool), error) {
	go func() {
		<-ctx.Done()
		close(r.ctxCanceled)
	}()
	panic(errors.New("bili-secret-pending-https://sh.example/leak?token=bilisecret2"))
}

type errorShanghaiResolver struct{}

func (errorShanghaiResolver) ResolveBilibili(context.Context, string, int64) (*ShanghaiPlay, error) {
	return nil, errors.New("shanghai unavailable")
}

func TestShanghaiCallAndParsePanicRecovery(t *testing.T) {
	var logBuf shanghaiLockedLogBuffer
	origOut := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(origOut) })

	exec := shanghaiTestExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		switch req.Policy.Purpose {
		case "bilibili-view":
			return fetch.Response{StatusCode: http.StatusOK, Body: []byte(testView), URL: req.URL}, nil
		case "bilibili-play":
			return fetch.Response{StatusCode: http.StatusOK, Body: []byte(testPlay), URL: req.URL}, nil
		default:
			return fetch.Response{}, errors.New("unexpected purpose: " + req.Policy.Purpose)
		}
	})

	japanBaseline, err := NewWithShanghai(exec, errorShanghaiResolver{}).Parse(context.Background(), testURL, 1800000000)
	if err != nil {
		t.Fatalf("Japan fallback baseline Parse failed: %v", err)
	}

	// 1. Full Parser.Parse with panicking ShanghaiResolver wakes immediately and falls back to Japan.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	panicRes := &panickingShanghaiResolver{ctxCanceled: make(chan struct{})}
	start := time.Now()
	got, err := NewWithShanghai(exec, panicRes).Parse(ctx, testURL, 1800000000)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Parse failed after Shanghai panic: %v", err)
	}
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("Parse blocked for %v after Shanghai panic; expected immediate wakeup well below %v", elapsed, ShanghaiTotalBudget)
	}
	if !unified.Equal(got, japanBaseline) {
		t.Fatalf("Shanghai panic altered Japan fallback result: got=%#v want=%#v", got, japanBaseline)
	}
	select {
	case <-panicRes.ctxCanceled:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("panicking ResolveBilibili child context was not canceled")
	}

	// 2. Direct startShanghaiCall + await with panicking pending resolver sets call.err, cancels child ctx, and wakes await().
	pendingPanicRes := &panickingPendingShanghaiResolver{ctxCanceled: make(chan struct{})}
	call := startShanghaiCall(ctx, pendingPanicRes, "BV1234567890", 101)
	if call == nil {
		t.Fatal("expected non-nil shanghaiCall")
	}
	awaitStart := time.Now()
	play, finish := call.await(ctx)
	if awaitElapsed := time.Since(awaitStart); awaitElapsed >= 500*time.Millisecond {
		t.Fatalf("await() blocked for %v after panic", awaitElapsed)
	}
	if play != nil || finish != nil {
		t.Fatalf("expected (nil, nil) from await() after panic, got play=%+v finish=%v", play, finish != nil)
	}
	call.mu.Lock()
	callErr := call.err
	call.mu.Unlock()
	if callErr == nil {
		t.Fatal("expected non-nil call.err after Shanghai goroutine panic")
	}
	select {
	case <-pendingPanicRes.ctxCanceled:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("panicking ResolveBilibiliPending child context was not canceled")
	}
	if ctx.Err() != nil {
		t.Fatalf("parent context unexpectedly canceled: %v", ctx.Err())
	}

	logged := logBuf.String()
	if strings.Count(logged, "bilibili: shanghai goroutine panic recovered: panic_type=") != 2 {
		t.Fatalf("expected 2 sanitized panic recovery logs, got %q", logged)
	}
	for _, forbidden := range []string{"bili-secret", "bilisecret1", "bilisecret2", "sh.example"} {
		if strings.Contains(logged, forbidden) {
			t.Fatalf("panic recovery log leaked sensitive value %q: %q", forbidden, logged)
		}
	}
}

func TestShanghaiPlayRequestHeadersAndZeroCookie(t *testing.T) {
	shReq := shanghaiPlayRequest("BV1234567890", int64(101), 2500*time.Millisecond)
	dashReq := dashPlayRequest("BV1234567890", int64(101), 2500*time.Millisecond)
	jpReq := playRequest("BV1234567890", int64(101), 20*time.Second)

	for _, tc := range []struct {
		name string
		req  fetch.Request
	}{
		{"shanghaiPlayRequest", shReq},
		{"dashPlayRequest", dashReq},
	} {
		if tc.req.Header.Get("User-Agent") != desktopUA || tc.req.Header.Get("User-Agent") == "" {
			t.Fatalf("%s User-Agent = %q, want desktopUA", tc.name, tc.req.Header.Get("User-Agent"))
		}
		if tc.req.Header.Get("Referer") != "https://www.bilibili.com/" {
			t.Fatalf("%s Referer = %q, want https://www.bilibili.com/", tc.name, tc.req.Header.Get("Referer"))
		}
		if tc.req.Header.Get("Origin") != "https://www.bilibili.com" {
			t.Fatalf("%s Origin = %q, want https://www.bilibili.com", tc.name, tc.req.Header.Get("Origin"))
		}
		if tc.req.Header.Get("Accept") != "application/json, text/plain, */*" {
			t.Fatalf("%s Accept = %q", tc.name, tc.req.Header.Get("Accept"))
		}
		if tc.req.Header.Get("Accept-Language") != "zh-CN,zh;q=0.9" {
			t.Fatalf("%s Accept-Language = %q", tc.name, tc.req.Header.Get("Accept-Language"))
		}
		if tc.req.Header.Get("Accept-Encoding") != "gzip,deflate" {
			t.Fatalf("%s Accept-Encoding = %q", tc.name, tc.req.Header.Get("Accept-Encoding"))
		}
		for k := range tc.req.Header {
			if strings.EqualFold(k, "Cookie") || strings.EqualFold(k, "Authorization") {
				t.Fatalf("%s must not send %s header", tc.name, k)
			}
		}
		if tc.req.Policy.FollowRedirects {
			t.Fatalf("%s must not follow redirects", tc.name)
		}
		if tc.req.Policy.AllowedURL == nil || !tc.req.Policy.AllowedURL(tc.req.URL) {
			t.Fatalf("%s URL rejected by AllowedAPIURL: %q", tc.name, tc.req.URL)
		}
	}

	// Verify Japan PHP-baseline playRequest remains completely untouched.
	if jpReq.Header.Get("User-Agent") != "" || jpReq.Header.Get("Referer") != "" || jpReq.Header.Get("Origin") != "" {
		t.Fatalf("Japan playRequest headers unexpectedly modified: %+v", jpReq.Header)
	}
}
