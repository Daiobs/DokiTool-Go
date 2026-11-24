package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/catalog"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/fetch"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/instagram"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/x"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/platform/ytgeneric"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func loadCacheTestCatalog(t *testing.T) *catalog.Catalog {
	t.Helper()
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, extra := range []unified.Object{
		catalog.XPlatform(),
		catalog.YouTubePlatform(),
		catalog.InstagramPlatform(),
	} {
		if err := c.Register(extra); err != nil {
			t.Fatal(err)
		}
	}
	for _, siteID := range []string{"facebook", "tumblr"} {
		spec, ok := ytgeneric.LookupSite(siteID)
		if !ok {
			t.Fatalf("missing builtin site %q", siteID)
		}
		if err := c.Register(spec.CatalogEntry()); err != nil {
			t.Fatal(err)
		}
	}
	return c
}

func loadDouyinSampleEnvelope(t *testing.T) unified.Object {
	t.Helper()
	raw, err := os.ReadFile("../../../docs/schema/unified-v1/examples/01-douyin-quality-and-cdn.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := unified.Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func makeSyntheticEnvelope(platform, sourceURL string, now int64, expiresAt string, itemIDs ...string) unified.Object {
	if len(itemIDs) == 0 {
		itemIDs = []string{"item-1"}
	}
	items := make(unified.Array, 0, len(itemIDs))
	for i, id := range itemIDs {
		src := unified.Object{
			"id":  "s-" + id,
			"url": "https://cdn.example.com/" + platform + "/" + id + ".mp4",
		}
		def := unified.Object{
			"variant_id": "v-" + id,
			"source_id":  "s-" + id,
			"url":        "https://cdn.example.com/" + platform + "/" + id + ".mp4",
			"access":     "direct",
		}
		if expiresAt != "" {
			src["expires_at"] = expiresAt
			def["expires_at"] = expiresAt
		}
		items = append(items, unified.Object{
			"id":          id,
			"index":       i + 1,
			"type":        "video",
			"source_url":  sourceURL,
			"resolve_url": unified.ResolveURL(sourceURL, id),
			"default":     def,
			"variants": unified.Array{
				unified.Object{
					"id": "v-" + id,
					"metadata": unified.Object{
						"container": "mp4",
						"extension": "mp4",
						"mime_type": "video/mp4",
						"width":     1920,
						"height":    1080,
						"has_audio": true,
						"evidence":  "upstream",
					},
					"delivery": unified.Object{
						"kind":    "file",
						"sources": unified.Array{src},
					},
				},
			},
		})
	}
	data := unified.Object{
		"platform":        platform,
		"source_url":      sourceURL,
		"refresh_url":     "/api/parse?schema_version=1.0&url=" + unified.RFC3986Query(sourceURL),
		"generated_at":    time.Unix(now, 0).UTC().Format(time.RFC3339),
		"default_item_id": itemIDs[0],
		"items":           items,
	}
	return unified.Object{
		"schema_version": "1.0",
		"code":           "OK",
		"data":           data,
	}
}

func TestCacheConfigValidation(t *testing.T) {
	c := loadCacheTestCatalog(t)
	def := DefaultCacheConfig()
	if err := def.Validate(); err != nil {
		t.Fatalf("DefaultCacheConfig failed validation: %v", err)
	}
	if def.MaxEntries != 4096 || def.MaxBytes != 64<<20 || def.Disabled {
		t.Fatalf("unexpected DefaultCacheConfig: %+v", def)
	}

	if err := (CacheConfig{Disabled: true}).Validate(); err != nil {
		t.Fatalf("Disabled CacheConfig failed validation: %v", err)
	}

	invalidConfigs := []CacheConfig{
		{MaxEntries: 0, MaxBytes: 64 << 20},
		{MaxEntries: -1, MaxBytes: 64 << 20},
		{MaxEntries: maxCacheMaxEntries + 1, MaxBytes: 64 << 20},
		{MaxEntries: 128, MaxBytes: 0},
		{MaxEntries: 128, MaxBytes: minCacheMaxBytes - 1},
		{MaxEntries: 128, MaxBytes: maxCacheMaxBytes + 1},
		{Disabled: true, MaxEntries: -1, MaxBytes: 0},
		{Disabled: true, MaxEntries: maxCacheMaxEntries + 1, MaxBytes: 0},
		{Disabled: true, MaxEntries: 0, MaxBytes: -1},
		{Disabled: true, MaxEntries: 0, MaxBytes: maxCacheMaxBytes + 1},
	}
	for i, bad := range invalidConfigs {
		if err := bad.Validate(); err == nil {
			t.Fatalf("case %d (%+v): expected Validate error, got nil", i, bad)
		}
		if h, err := NewWithCacheConfig(c, nil, time.Now, nil, bad); err == nil || h != nil {
			t.Fatalf("case %d (%+v): expected NewWithCacheConfig failure, got h=%v err=%v", i, bad, h, err)
		}
	}
}

func TestParseCache50ConcurrentRequestsCoalesceToSingleUpstreamParse(t *testing.T) {
	const baseNow int64 = 1793448000
	c := loadCacheTestCatalog(t)

	var (
		upstreamCalls atomic.Int32
		startedOnce   sync.Once
		started       = make(chan struct{})
		release       = make(chan struct{})
	)
	adapter := AdapterFunc(func(ctx context.Context, source string, now int64) (unified.Object, error) {
		upstreamCalls.Add(1)
		startedOnce.Do(func() { close(started) })
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return makeSyntheticEnvelope("x", source, now, "", "tweet-vid-1", "tweet-vid-2"), nil
	})

	h, err := New(c, map[string]Adapter{"x": adapter}, func() time.Time { return time.Unix(baseNow, 0) }, nil)
	if err != nil {
		t.Fatal(err)
	}

	variants := []string{
		"https://x.com/user/status/1800000000000000001",
		"HTTPS://X.COM:443/user/status/1800000000000000001#top",
		"https://twitter.com/user/status/1800000000000000001",
		"https://mobile.x.com/user/status/1800000000000000001",
		"分享推文 https://www.x.com/user/status/1800000000000000001！",
	}

	const concurrency = 50
	recorders := make([]*httptest.ResponseRecorder, concurrency)
	var wg sync.WaitGroup
	wg.Add(concurrency)
	for i := 0; i < concurrency; i++ {
		recorders[i] = httptest.NewRecorder()
		go func(idx int) {
			defer wg.Done()
			q := url.Values{
				"schema_version": {"1.0"},
				"url":            {variants[idx%len(variants)]},
			}
			if idx%2 == 1 {
				q.Set("platform", "x")
			}
			req := httptest.NewRequest(http.MethodGet, "/api/parse?"+q.Encode(), nil)
			h.ServeHTTP(recorders[idx], req)
		}(i)
	}

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for upstream parse to start")
	}
	// Allow remaining concurrent goroutines to arrive and join the singleflight group.
	time.Sleep(25 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := upstreamCalls.Load(); got != 1 {
		t.Fatalf("expected 50 concurrent identical requests to trigger 1 upstream parse, got %d", got)
	}
	firstBody := recorders[0].Body.Bytes()
	for i, rec := range recorders {
		if rec.Code != http.StatusOK {
			t.Fatalf("caller %d status=%d body=%s", i, rec.Code, rec.Body.String())
		}
		if !bytes.Equal(rec.Body.Bytes(), firstBody) {
			t.Fatalf("caller %d received non-identical body", i)
		}
	}

	// Also verify 50 concurrent /api/resolve requests on an uncached URL + item_id trigger 1 upstream parse.
	var (
		resolveCalls   atomic.Int32
		resolveStarted sync.Once
		resStartCh     = make(chan struct{})
		resReleaseCh   = make(chan struct{})
	)
	hResolve, err := New(c, map[string]Adapter{
		"x": AdapterFunc(func(ctx context.Context, source string, now int64) (unified.Object, error) {
			resolveCalls.Add(1)
			resolveStarted.Do(func() { close(resStartCh) })
			select {
			case <-resReleaseCh:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return makeSyntheticEnvelope("x", source, now, "", "tweet-vid-1", "tweet-vid-2"), nil
		}),
	}, func() time.Time { return time.Unix(baseNow, 0) }, nil)
	if err != nil {
		t.Fatal(err)
	}
	resRecs := make([]*httptest.ResponseRecorder, concurrency)
	wg.Add(concurrency)
	for i := 0; i < concurrency; i++ {
		resRecs[i] = httptest.NewRecorder()
		go func(idx int) {
			defer wg.Done()
			q := url.Values{
				"schema_version": {"1.0"},
				"url":            {variants[idx%len(variants)]},
				"item_id":        {"tweet-vid-2"},
			}
			hResolve.ServeHTTP(resRecs[idx], httptest.NewRequest(http.MethodGet, "/api/resolve?"+q.Encode(), nil))
		}(i)
	}
	<-resStartCh
	time.Sleep(25 * time.Millisecond)
	close(resReleaseCh)
	wg.Wait()
	if got := resolveCalls.Load(); got != 1 {
		t.Fatalf("expected 50 concurrent /api/resolve requests to trigger 1 upstream parse, got %d", got)
	}
	for i, rec := range resRecs {
		if rec.Code != http.StatusOK {
			t.Fatalf("resolve caller %d status=%d", i, rec.Code)
		}
	}
}

func TestNormalizeCacheURLAliasesAndDistinctQueries(t *testing.T) {
	equivalentGroups := []struct {
		platform string
		inputs   []string
		want     string
	}{
		{
			platform: "x",
			inputs: []string{
				"https://x.com/user/status/123",
				"http://x.com:80/user/status/123",
				"HTTPS://WWW.X.COM:443/user/status/123#reply",
				"https://twitter.com/user/status/123",
				"https://www.twitter.com/user/status/123",
				"https://mobile.twitter.com/user/status/123",
				"https://m.twitter.com/user/status/123",
				"https://mobile.x.com/user/status/123",
				"https://m.x.com/user/status/123",
			},
			want: "https://x.com/user/status/123",
		},
		{
			platform: "x",
			inputs: []string{
				"https://t.co/AbCdEf12",
				"http://t.co:80/AbCdEf12",
				"HTTPS://T.CO:443/AbCdEf12#share",
			},
			want: "https://t.co/AbCdEf12",
		},
		{
			platform: "instagram",
			inputs: []string{
				"https://instagram.com/reel/CTApqC8BGWd/",
				"https://m.instagram.com/reel/CTApqC8BGWd/",
				"http://www.instagram.com:80/reel/CTApqC8BGWd/",
				"https://www.instagram.com:443/reel/CTApqC8BGWd/#ig",
				"https://www.instagram.com/reels/CTApqC8BGWd",
				"https://instagr.am/reel/CTApqC8BGWd/",
				"https://instagr.am/reel/CTApqC8BGWd",
				"https://www.instagr.am/reels/CTApqC8BGWd",
				"http://INSTAGR.AM:80/reel/CTApqC8BGWd#ig",
			},
			want: "https://www.instagram.com/reel/CTApqC8BGWd/",
		},
		{
			platform: "instagram",
			inputs: []string{
				"https://www.instagram.com/p/aye83DjauH/",
				"https://www.instagram.com/p/aye83DjauH",
				"https://instagr.am/p/aye83DjauH/",
				"https://instagr.am/p/aye83DjauH",
				"https://www.instagr.am/p/aye83DjauH/",
			},
			want: "https://www.instagram.com/p/aye83DjauH/",
		},
		{
			platform: "instagram",
			inputs: []string{
				"https://www.instagram.com/tv/aye83DjauH/",
				"https://instagr.am/tv/aye83DjauH",
				"https://www.instagr.am/tv/aye83DjauH/",
			},
			want: "https://www.instagram.com/tv/aye83DjauH/",
		},
		{
			platform: "facebook",
			inputs: []string{
				"https://facebook.com/reel/1517545242764683",
				"https://m.facebook.com/reel/1517545242764683",
				"https://www.facebook.com/reel/1517545242764683#t=1",
			},
			want: "https://www.facebook.com/reel/1517545242764683",
		},
		{
			platform: "tumblr",
			inputs: []string{
				"https://tumblr.com/blog/123",
				"https://www.tumblr.com/blog/123",
			},
			want: "https://www.tumblr.com/blog/123",
		},
	}
	for _, grp := range equivalentGroups {
		for _, in := range grp.inputs {
			if got := normalizeCacheURL(grp.platform, in); got != grp.want {
				t.Fatalf("normalizeCacheURL(%q, %q) = %q, want %q", grp.platform, in, got, grp.want)
			}
		}
	}

	// >2048-byte inputs on strict platforms MUST NEVER collide with <=2048-byte keys
	// (including when a valid <=2048-byte bare tumblr.com URL expands to www.tumblr.com).
	validShortExpanded := "https://tumblr.com/blog/123?" + strings.Repeat("a", 2018)  // len == 2045 <= 2048
	invalidExpanded := "https://www.tumblr.com/blog/123?" + strings.Repeat("a", 2018) // len == 2049 > 2048
	if normalizeCacheURL("tumblr", validShortExpanded) == normalizeCacheURL("tumblr", invalidExpanded) {
		t.Fatal("overlong tumblr URL collided with expanded valid bare tumblr.com URL")
	}

	// Distinct media selectors / query tokens / case-sensitive t.co codes / non-standard ports MUST remain distinct.
	if normalizeCacheURL("x", "https://x.com/u/status/1/photo/1") == normalizeCacheURL("x", "https://x.com/u/status/1/photo/2") {
		t.Fatal("X /photo/1 and /photo/2 collided")
	}
	if normalizeCacheURL("x", "https://t.co/AbCd") == normalizeCacheURL("x", "https://t.co/abcd") {
		t.Fatal("case-sensitive t.co/AbCd and t.co/abcd collided")
	}
	if normalizeCacheURL("x", "https://t.co:8443/AbCd") == normalizeCacheURL("x", "https://t.co/AbCd") ||
		normalizeCacheURL("x", "http://t.co:443/AbCd") == normalizeCacheURL("x", "https://t.co/AbCd") {
		t.Fatal("non-standard t.co port collided with valid t.co cache key")
	}
	if normalizeCacheURL("instagram", "https://instagr.am:8443/p/aye83DjauH/") == normalizeCacheURL("instagram", "https://www.instagram.com/p/aye83DjauH/") ||
		normalizeCacheURL("instagram", "https://instagr.am/someuser/p/aye83DjauH/") == normalizeCacheURL("instagram", "https://www.instagram.com/p/aye83DjauH/") ||
		normalizeCacheURL("instagram", "https://foo.instagr.am/p/aye83DjauH/") == normalizeCacheURL("instagram", "https://www.instagram.com/p/aye83DjauH/") {
		t.Fatal("invalid instagr.am path/subdomain/port collided with canonical www.instagram.com cache key")
	}
	if normalizeCacheURL("xiaohongshu", "https://www.xiaohongshu.com/explore/1?xsec_token=a") ==
		normalizeCacheURL("xiaohongshu", "https://www.xiaohongshu.com/explore/1?xsec_token=b") {
		t.Fatal("XHS xsec_token collided")
	}
}

func TestWarmCacheDoesNotBypassPlatformURLValidation(t *testing.T) {
	const nowUnix int64 = 1793448000
	c := loadCacheTestCatalog(t)

	w720, h720 := int64(1280), int64(720)
	dur := 10.0
	tbr := 1800.0

	mkExtractor := func(mediaURL, thumbURL string, counter *atomic.Int32) ytengine.Extractor {
		return &stubXExtractor{
			enabled: true,
			extract: func(_ context.Context, rawURL string) (*ytengine.Info, error) {
				if counter != nil {
					counter.Add(1)
				}
				return &ytengine.Info{
					ID:         "vid123456",
					DisplayID:  "vid123456",
					Title:      "Sample",
					Duration:   &dur,
					Thumbnail:  thumbURL,
					WebpageURL: rawURL,
					Formats: []ytengine.Format{
						{
							FormatID: "mp4-720p",
							URL:      mediaURL,
							Ext:      "mp4",
							Protocol: "https",
							Width:    &w720,
							Height:   &h720,
							TBR:      &tbr,
							VCodec:   "avc1.64001f",
							ACodec:   "mp4a.40.2",
						},
					},
				}, nil
			},
		}
	}

	fbSpec, _ := ytgeneric.LookupSite("facebook")
	tumblrSpec, _ := ytgeneric.LookupSite("tumblr")

	h, err := New(c, map[string]Adapter{
		"x":         x.New(mkExtractor("https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4", "https://pbs.twimg.com/media/a.jpg", nil)),
		"instagram": instagram.New(mkExtractor("https://scontent.cdninstagram.com/v/t50.2886-16/100_n.mp4", "https://scontent.cdninstagram.com/v/t51.2885-15/100_n.jpg", nil)),
		"facebook":  ytgeneric.NewWithResolver(fbSpec, mkExtractor("https://video.xx.fbcdn.net/v/t42.1790-2/100_n.mp4", "https://scontent.xx.fbcdn.net/v/t15.5256-10/100_n.jpg", nil), nil, staticPublicResolver{}),
		"tumblr":    ytgeneric.NewWithResolver(tumblrSpec, mkExtractor("https://va.media.tumblr.com/tumblr_abc_720.mp4", "https://64.media.tumblr.com/thumb.jpg", nil), nil, staticPublicResolver{}),
	}, func() time.Time { return time.Unix(nowUnix, 0) }, nil)
	if err != nil {
		t.Fatal(err)
	}

	callParse := func(rawURL string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		q := url.Values{"schema_version": {"1.0"}, "url": {rawURL}}
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?"+q.Encode(), nil))
		return w
	}

	// Warm valid <=2048-byte URLs on all 4 strict cacheable platforms, then verify >2048-byte
	// inputs STILL return 400 INVALID_INPUT (both shrinkage and bare-domain expansion cases).
	qPad := strings.Repeat("a", 2020)
	longBareValid := "https://tumblr.com/blog/123456?" + strings.Repeat("b", 2015) // 2046 bytes <= 2048
	for _, warmURL := range []string{
		"https://x.com/user/status/1577719286659006464",
		"https://x.com/user/status/1577719286659006464?" + strings.Repeat("q", 1995),
		"https://www.instagram.com/reel/CTApqC8BGWd/",
		"https://www.facebook.com/reel/1517545242764683",
		"https://www.tumblr.com/blog/123456",
		longBareValid,
	} {
		if len(warmURL) > maxYTDLPInputBytes {
			t.Fatalf("test bug: warmURL len=%d > %d", len(warmURL), maxYTDLPInputBytes)
		}
		if w := callParse(warmURL); w.Code != http.StatusOK {
			t.Fatalf("warm %q status=%d body=%s", warmURL, w.Code, w.Body.String())
		}
	}

	overlongCases := []string{
		"https://x.com/user/status/1577719286659006464#" + qPad,
		"https://mobile.twitter.com:443/user/status/1577719286659006464?" + strings.Repeat("q", 1995),
		"https://m.x.com:443/user/status/1577719286659006464#" + qPad,
		"https://m.instagram.com:443/reel/CTApqC8BGWd/#" + qPad,
		"https://m.facebook.com:443/reel/1517545242764683#" + qPad,
		"https://tumblr.com:443/blog/123456#" + qPad,
		"https://www.tumblr.com/blog/123456?" + strings.Repeat("b", 2015), // 2050 bytes > 2048, matches expanded longBareValid!
	}
	for _, overlong := range overlongCases {
		if len(overlong) <= maxYTDLPInputBytes {
			t.Fatalf("test bug: overlong len=%d <= %d: %q", len(overlong), maxYTDLPInputBytes, overlong)
		}
		w := callParse(overlong)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("warm cache bypassed >2048-byte rejection for len=%d (%s...): status=%d body=%s",
				len(overlong), overlong[:48], w.Code, w.Body.String())
		}
	}
}

type cacheFakeFetcher func(context.Context, fetch.Request) (fetch.Response, error)

func (f cacheFakeFetcher) Do(ctx context.Context, req fetch.Request) (fetch.Response, error) {
	return f(ctx, req)
}

func TestShortlinksCacheEquivalenceAndCaseSensitivity(t *testing.T) {
	const nowUnix int64 = 1793448000
	c := loadCacheTestCatalog(t)

	var igCalls, xTCoUpperCalls, xTCoLowerCalls atomic.Int32
	w720, h720 := int64(1280), int64(720)
	dur := 8.0
	tbr := 1800.0

	igAdapter := instagram.New(&stubXExtractor{
		enabled: true,
		extract: func(_ context.Context, rawURL string) (*ytengine.Info, error) {
			igCalls.Add(1)
			return &ytengine.Info{
				ID:         "CTApqC8BGWd",
				Title:      "IG Shortlink Reel",
				Duration:   &dur,
				Thumbnail:  "https://scontent.cdninstagram.com/v/t51.2885-15/100_n.jpg",
				WebpageURL: rawURL,
				Formats: []ytengine.Format{
					{
						FormatID: "0",
						URL:      "https://scontent.cdninstagram.com/v/t50.2886-16/100_n.mp4",
						Ext:      "mp4",
						Protocol: "https",
						Width:    &w720,
						Height:   &h720,
						TBR:      &tbr,
					},
				},
			}, nil
		},
	})

	xAdapter := x.NewWithFetcher(
		&stubXExtractor{
			enabled: true,
			extract: func(_ context.Context, rawURL string) (*ytengine.Info, error) {
				id := strings.TrimPrefix(rawURL, "https://x.com/i/status/")
				return &ytengine.Info{
					ID:        id,
					DisplayID: id,
					Title:     "Tweet " + id,
					Duration:  &dur,
					Thumbnail: "https://pbs.twimg.com/media/a.jpg",
					Formats: []ytengine.Format{
						{
							FormatID: "http-720",
							URL:      "https://video.twimg.com/ext_tw_video/" + id + "/pu/vid/1280x720/a.mp4",
							Ext:      "mp4",
							Protocol: "https",
							Width:    &w720,
							Height:   &h720,
							TBR:      &tbr,
							VCodec:   "avc1.64001f",
							ACodec:   "mp4a.40.2",
						},
					},
				}, nil
			},
		},
		nil,
		cacheFakeFetcher(func(_ context.Context, req fetch.Request) (fetch.Response, error) {
			switch req.URL {
			case "https://t.co/AbCd":
				xTCoUpperCalls.Add(1)
				hdr := make(http.Header)
				hdr.Set("Location", "https://x.com/user/status/1800000000000000001")
				return fetch.Response{StatusCode: http.StatusMovedPermanently, Header: hdr, URL: req.URL}, nil
			case "https://t.co/abcd":
				xTCoLowerCalls.Add(1)
				hdr := make(http.Header)
				hdr.Set("Location", "https://x.com/user/status/1800000000000000002")
				return fetch.Response{StatusCode: http.StatusMovedPermanently, Header: hdr, URL: req.URL}, nil
			default:
				return fetch.Response{StatusCode: http.StatusNotFound, URL: req.URL}, nil
			}
		}),
	)

	h, err := New(c, map[string]Adapter{
		"instagram": igAdapter,
		"x":         xAdapter,
	}, func() time.Time { return time.Unix(nowUnix, 0) }, nil)
	if err != nil {
		t.Fatal(err)
	}

	doParse := func(rawURL string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		q := url.Values{"schema_version": {"1.0"}, "url": {rawURL}}
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/parse?"+q.Encode(), nil))
		return w
	}

	// 1. Instagram shortlink & canonical URL share exact cache entry; invalid instagr.am variants still 400.
	for _, eq := range []string{
		"https://instagr.am/reels/CTApqC8BGWd",
		"https://www.instagr.am/reel/CTApqC8BGWd/",
		"https://www.instagram.com/reel/CTApqC8BGWd/",
	} {
		if w := doParse(eq); w.Code != http.StatusOK {
			t.Fatalf("parse %q status=%d body=%s", eq, w.Code, w.Body.String())
		}
	}
	if igCalls.Load() != 1 {
		t.Fatalf("expected instagr.am and www.instagram.com to coalesce into 1 upstream call, got %d", igCalls.Load())
	}
	for _, badIG := range []string{
		"https://instagr.am/someuser/reel/CTApqC8BGWd/",
		"https://foo.instagr.am/reel/CTApqC8BGWd/",
		"https://instagr.am:8443/reel/CTApqC8BGWd/",
	} {
		if w := doParse(badIG); w.Code != http.StatusBadRequest {
			t.Fatalf("warm cache must not accept invalid %q: got status=%d body=%s", badIG, w.Code, w.Body.String())
		}
	}

	// 2. t.co cache key normalizes scheme/host/port while strictly preserving case-sensitive path code.
	wUpper1 := doParse("https://t.co/AbCd")
	wUpper2 := doParse("http://T.CO:80/AbCd#frag")
	wLower := doParse("https://t.co/abcd")
	if wUpper1.Code != http.StatusOK || wUpper2.Code != http.StatusOK || wLower.Code != http.StatusOK {
		t.Fatalf("unexpected statuses: upper1=%d upper2=%d lower=%d", wUpper1.Code, wUpper2.Code, wLower.Code)
	}
	if xTCoUpperCalls.Load() != 1 || xTCoLowerCalls.Load() != 1 {
		t.Fatalf("expected 1 call for AbCd and 1 call for abcd, got upper=%d lower=%d", xTCoUpperCalls.Load(), xTCoLowerCalls.Load())
	}
	envUpper, _ := unified.Decode(wUpper2.Body.Bytes())
	envLower, _ := unified.Decode(wLower.Body.Bytes())
	if unified.Str(unified.Map(envUpper["data"])["content_id"]) != "1800000000000000001" ||
		unified.Str(unified.Map(envLower["data"])["content_id"]) != "1800000000000000002" {
		t.Fatalf("case-sensitive t.co responses cross-contaminated: upper=%v lower=%v", envUpper["data"], envLower["data"])
	}
	if wBadPort := doParse("https://t.co:8443/AbCd"); wBadPort.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-standard port https://t.co:8443/AbCd, got %d", wBadPort.Code)
	}
}
