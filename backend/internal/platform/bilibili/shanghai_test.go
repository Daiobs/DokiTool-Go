package bilibili

import (
	"context"
	"net/http"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
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
}

func TestFetchShanghaiPlayOutboundPolicyAndCandidateFiltering(t *testing.T) {
	const (
		bvid      = "BV1234567890"
		cid       = int64(101)
		wantPlay  = "https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=3&player=3&qn=112&bvid=BV1234567890&cid=101&platform=html5&high_quality=1"
		goodDURL  = "https://cn-zjhz-cu-01-01.bilivideo.com/upgcxcode/00/01/101/101-1-64.mp4?deadline=1800007200&upsig=dom1"
		goodBack  = "https://cn-sh-ct-01-02.bilivideo.com/upgcxcode/00/01/101/101-1-64.mp4?deadline=1800007200&upsig=dom2"
		goodDashV = "https://cn-zjhz-cu-01-01.bilivideo.com/upgcxcode/00/01/101/101-1-30080.m4s?deadline=1800007200&upsig=dv1"
		goodDashA = "https://cn-zjhz-cu-01-01.bilivideo.com/upgcxcode/00/01/101/101-1-30280.m4s?deadline=1800007200&upsig=da1"
	)

	body := `{
		"code": 0,
		"data": {
			"quality": 64,
			"durl": [{
				"url": "http://cn-insecure.bilivideo.com/101.mp4?deadline=1800007200",
				"backup_url": [
					"https://bilivideo.com/apex.mp4?deadline=1800007200",
					"https://evilbilivideo.com/spoof.mp4?deadline=1800007200",
					"https://cn-bad-exp.bilivideo.com/bad.mp4?deadline=bad",
					"` + goodDURL + `",
					"` + goodBack + `",
					"` + goodDURL + `"
				]
			}],
			"dash": {
				"video": [
					{"id": 80, "codecid": 7, "codecs": "avc1.640028", "baseUrl": "` + goodDashV + `", "backupUrl": ["https://evilbilivideo.com/v.m4s?deadline=1800007200"]},
					{"id": 64, "codecid": 7, "codecs": "avc1.64001F", "baseUrl": "http://cn-http.bilivideo.com/v.m4s?deadline=1800007200"}
				],
				"audio": [
					{"id": 30280, "codecid": 0, "codecs": "mp4a.40.2", "base_url": "` + goodDashA + `"}
				]
			}
		}
	}`

	var called int
	exec := shanghaiTestExecutor(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
		called++
		if req.Method != http.MethodGet || req.URL != wantPlay {
			t.Fatalf("unexpected Shanghai playurl request: method=%s url=%s", req.Method, req.URL)
		}
		if req.Policy.FollowRedirects {
			t.Fatal("Shanghai playurl request must not follow redirects")
		}
		if req.Header.Get("Cookie") != "" {
			t.Fatal("Shanghai playurl request must not carry Cookie")
		}
		if req.Policy.AllowedURL == nil || !req.Policy.AllowedURL(wantPlay) || req.Policy.AllowedURL("https://www.bilibili.com/video/BV1234567890") {
			t.Fatal("Shanghai playurl request AllowedURL policy is not pinned to official API endpoints")
		}
		return fetch.Response{StatusCode: http.StatusOK, Body: []byte(body)}, nil
	})

	got, err := FetchShanghaiPlay(context.Background(), exec, bvid, cid)
	if err != nil {
		t.Fatalf("FetchShanghaiPlay failed: %v", err)
	}
	if called != 1 {
		t.Fatalf("called = %d, want 1", called)
	}
	if got.BVID != bvid || got.CID != cid || got.DURLQuality != 64 || len(got.DURLPieces) != 1 {
		t.Fatalf("unexpected DURL summary: %+v", got)
	}
	if len(got.DURLPieces[0].URLs) != 2 || got.DURLPieces[0].URLs[0] != goodDURL || got.DURLPieces[0].URLs[1] != goodBack {
		t.Fatalf("unexpected filtered DURL URLs: %v", got.DURLPieces[0].URLs)
	}
	if len(got.DashVideo) != 1 || got.DashVideo[0].ID != 80 || len(got.DashVideo[0].URLs) != 1 || got.DashVideo[0].URLs[0] != goodDashV {
		t.Fatalf("unexpected filtered DashVideo: %+v", got.DashVideo)
	}
	if len(got.DashAudio) != 1 || got.DashAudio[0].ID != 30280 || len(got.DashAudio[0].URLs) != 1 || got.DashAudio[0].URLs[0] != goodDashA {
		t.Fatalf("unexpected filtered DashAudio: %+v", got.DashAudio)
	}

	// All invalid URLs -> FetchShanghaiPlay returns error rather than empty play.
	allBadExec := shanghaiTestExecutor(func(_ context.Context, _ fetch.Request) (fetch.Response, error) {
		return fetch.Response{
			StatusCode: http.StatusOK,
			Body:       []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":"http://cn.bilivideo.com/a.mp4"},{"url":"https://evilbilivideo.com/b.mp4"}]}}`),
		}, nil
	})
	if _, err := FetchShanghaiPlay(context.Background(), allBadExec, bvid, cid); err == nil {
		t.Fatal("expected error when all candidate URLs fail validation")
	}

	// Multi-segment DURL with one invalid segment drops DURLPieces completely rather than shifting piece indices.
	partialSegExec := shanghaiTestExecutor(func(_ context.Context, _ fetch.Request) (fetch.Response, error) {
		return fetch.Response{
			StatusCode: http.StatusOK,
			Body:       []byte(`{"code":0,"data":{"quality":64,"durl":[{"url":"` + goodDURL + `"},{"url":"https://evilbilivideo.com/seg2.mp4"}],"dash":{"video":[{"id":80,"codecid":7,"baseUrl":"` + goodDashV + `"}]}}}`),
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
