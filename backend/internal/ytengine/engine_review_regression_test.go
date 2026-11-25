package ytengine

import (
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func TestPR36ReviewCounterexamples(t *testing.T) {
	const now int64 = 1762300800

	// 1. Same representation renewal keeps stable source_id on googlevideo.com
	w, h, sz := int64(640), int64(360), int64(28523658)
	opts := AdaptOptions{
		PlatformID: "youtube",
		ContentID:  "aqz-KE-bpKQ",
		SourceURL:  "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
		MaxEntries: 1,
	}
	info1 := &Info{
		ID:    "aqz-KE-bpKQ",
		Title: "Big Buck Bunny",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&ei=E1&ip=1.1.1.1&id=o-1&itag=18&source=youtube&clen=28523658&dur=634.566&lmt=1700000000000000&sig=SIG_A",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w,
				Height:   &h,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: &sz,
			},
		},
	}
	info2 := &Info{
		ID:    "aqz-KE-bpKQ",
		Title: "Big Buck Bunny",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      "https://rr4---sn-ogueln67.googlevideo.com/videoplayback?expire=1762360000&ei=E2&ip=2.2.2.2&id=o-1&itag=18&source=youtube&clen=28523658&dur=634.566&lmt=1700000000000000&sig=SIG_B",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w,
				Height:   &h,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: &sz,
			},
		},
	}
	env1 := AdaptInfo(info1, opts, now)
	env2 := AdaptInfo(info2, opts, now+60)
	def1 := unified.Map(unified.Map(unified.Slice(unified.Map(env1["data"])["items"])[0])["default"])
	def2 := unified.Map(unified.Map(unified.Slice(unified.Map(env2["data"])["items"])[0])["default"])
	if unified.Str(def1["source_id"]) != unified.Str(def2["source_id"]) {
		t.Fatalf("R3 counterexample failed: source_id drifted from %v to %v", def1["source_id"], def2["source_id"])
	}

	// 2 & 3. HTML 200 and invalid 206 Content-Range rejected by ValidateProbedMediaResponse
	if sz, ok := ValidateProbedMediaResponse(http.StatusOK, http.Header{
		"Content-Type":   {"text/html"},
		"Content-Length": {"7"},
	}, []byte("<html/>")); ok || sz != 0 {
		t.Fatalf("R4 counterexample 1 failed: accepted 200 text/html as (%d, %v)", sz, ok)
	}
	if sz, ok := ValidateProbedMediaResponse(http.StatusPartialContent, http.Header{
		"Content-Type":  {"video/mp4"},
		"Content-Range": {"not-a-range/12345"},
	}, []byte{0x00}); ok || sz != 0 {
		t.Fatalf("R4 counterexample 2 failed: accepted invalid 206 Content-Range as (%d, %v)", sz, ok)
	}

	// 4. Multi-entry SelectedIndex preserves original entry position when entry #1 has no formats
	multiOpts := AdaptOptions{
		PlatformID:    "x",
		ContentID:     "1577719286659006464",
		SourceURL:     "https://x.com/u/status/1577719286659006464/video/2",
		SelectedIndex: 2,
		MaxEntries:    4,
	}
	multiInfo := &Info{
		ID:   "1577719286659006464",
		Type: "playlist",
		Entries: []Info{
			{ID: "entry1-empty", Formats: nil},
			{
				ID:    "entry2-valid",
				Title: "Entry Two",
				Formats: []Format{
					{
						FormatID: "http-720",
						URL:      "https://video.twimg.com/ext_tw_video/2/pu/vid/1280x720/v2.mp4",
						Ext:      "mp4",
						Protocol: "https",
						Width:    &w,
						Height:   &h,
						VCodec:   "avc1.640020",
						ACodec:   "mp4a.40.2",
					},
				},
			},
			{
				ID:    "entry3-valid",
				Title: "Entry Three",
				Formats: []Format{
					{
						FormatID: "http-720",
						URL:      "https://video.twimg.com/ext_tw_video/3/pu/vid/1280x720/v3.mp4",
						Ext:      "mp4",
						Protocol: "https",
						Width:    &w,
						Height:   &h,
						VCodec:   "avc1.640020",
						ACodec:   "mp4a.40.2",
					},
				},
			},
		},
	}
	multiEnv := AdaptInfo(multiInfo, multiOpts, now)
	multiData := unified.Map(multiEnv["data"])
	multiItems := unified.Slice(multiData["items"])
	firstSurviving := unified.Map(multiItems[0])
	if unified.Str(multiData["default_item_id"]) != unified.Str(firstSurviving["id"]) || !unified.Equal(firstSurviving["index"], 2) {
		t.Fatalf("R1 counterexample failed: expected default_item_id=%v (index 2), got default_item_id=%v (index=%v)", firstSurviving["id"], multiData["default_item_id"], firstSurviving["index"])
	}
}

func TestPR36Review5785629879Counterexamples(t *testing.T) {
	const now int64 = 1762300800

	// Counterexample 1 (R2-A): External proxy must not bypass controlled outbound boundary
	binPath, hashes := writeFakeYTDLP(t, `echo '{"id":"1","formats":[{"format_id":"18","url":"https://video.twimg.com/v.mp4","ext":"mp4"}]}'`)
	privateResolver := stubResolver{
		ips: map[string][]netip.Addr{
			"x.com":         {netip.MustParseAddr("10.0.0.1")},
			"public.x.com":  {netip.MustParseAddr("93.184.216.34")},
			"private.x.com": {netip.MustParseAddr("10.0.0.1")},
		},
	}
	// New with ProxyURL + Resolver/AllowedOutboundHost must fail closed
	if engWithProxy, err := New(Config{
		BinaryPath:          binPath,
		AllowedHashes:       hashes,
		AllowedOutboundHost: func(h string) bool { return h == "x.com" || strings.HasSuffix(h, ".x.com") },
		Resolver:            privateResolver,
		ProxyURL:            "http://127.0.0.1:18080",
	}); err == nil || engWithProxy.Enabled() {
		t.Fatalf("R2-A failed: expected New with ProxyURL and outbound policy to fail closed, got enabled=%v err=%v", engWithProxy.Enabled(), err)
	}
	// Direct verifyPublicTargetHost & Extract with ProxyURL set on Engine struct must still enforce Resolver and block private IP
	directProxyEng := &Engine{
		enabled:             true,
		binaryPath:          binPath,
		allowedOutboundHost: func(h string) bool { return h == "x.com" || strings.HasSuffix(h, ".x.com") },
		resolver:            privateResolver,
		proxyURL:            "http://127.0.0.1:18080",
		sem:                 make(chan struct{}, 1),
		timeout:             5 * time.Second,
	}
	if err := directProxyEng.verifyPublicTargetHost(context.Background(), "https://x.com/i/status/1"); err == nil || err.Code != CodeUpstreamBlocked {
		t.Fatalf("R2-A failed: verifyPublicTargetHost with ProxyURL bypassed private IP check: %v", err)
	}
	if _, err := directProxyEng.Extract(context.Background(), "https://x.com/i/status/1"); err == nil {
		t.Fatalf("R2-A failed: Extract with ProxyURL and private target IP succeeded unexpectedly")
	}
	// NewHTTPSizeProber with external proxy must fail closed without dialing
	proberWithProxy := NewHTTPSizeProber("http://127.0.0.1:18080", func(string) bool { return true })
	if sz, ok := proberWithProxy(context.Background(), "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/v.mp4"); ok || sz != 0 {
		t.Fatalf("R2-A failed: expected NewHTTPSizeProber with external proxy to fail closed, got (%d, %v)", sz, ok)
	}

	// Counterexamples 2, 3, 4 (R2-B): Gate POST body preservation, HTTP->HTTPS redirect (with real TLS RootCAs), and CONNECT cancellation cleanup
	var gotPostBody string
	upstreamHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/post":
			b, _ := io.ReadAll(r.Body)
			gotPostBody = string(b)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok:" + gotPostBody))
		case "/step1":
			http.Redirect(w, r, "https://public.x.com/step2", http.StatusFound)
		case "/step2":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("https-step2-ok"))
		case "/step1-private":
			http.Redirect(w, r, "https://private.x.com/step2", http.StatusFound)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	upstreamSrv := httptest.NewServer(upstreamHandler)
	defer upstreamSrv.Close()
	upstreamTLS, upstreamCA := newTLSServerForHosts(t, upstreamHandler, "public.x.com")
	defer upstreamTLS.Close()

	srvURL, _ := url.Parse(upstreamSrv.URL)
	tlsURL, _ := url.Parse(upstreamTLS.URL)
	gateEng, err := New(Config{
		BinaryPath:          binPath,
		AllowedHashes:       hashes,
		AllowedOutboundHost: func(h string) bool { return h == "x.com" || strings.HasSuffix(h, ".x.com") },
		Resolver:            privateResolver,
	})
	if err != nil {
		t.Fatalf("New gateEng failed: %v", err)
	}
	gateEng = gateEng.withGateTestHooks(gateTestHooks{
		dialAddr: func(_ netip.Addr, port string) string {
			if port == "443" {
				return tlsURL.Host
			}
			return srvURL.Host
		},
		rootCAs: upstreamCA,
	})

	gateCtx, gateCancel := context.WithCancel(context.Background())
	defer gateCancel()
	gateURL, closeGate, err := gateEng.startOutboundGate(gateCtx)
	if err != nil {
		t.Fatalf("startOutboundGate failed: %v", err)
	}
	defer closeGate()

	parsedGate, _ := url.Parse(gateURL)
	gateClient := &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyURL(parsedGate),
		},
		Timeout: 3 * time.Second,
	}

	// Counterexample 2: POST body "hello=1" preserved through gate
	postResp, err := gateClient.Post("http://public.x.com/post", "application/x-www-form-urlencoded", strings.NewReader("hello=1"))
	if err != nil {
		t.Fatalf("R2-B POST failed: %v", err)
	}
	_ = postResp.Body.Close()
	if postResp.StatusCode != http.StatusOK || gotPostBody != "hello=1" {
		t.Fatalf("R2-B POST body counterexample failed: status=%d gotPostBody=%q, want 'hello=1'", postResp.StatusCode, gotPostBody)
	}

	// Counterexample 3: http://public.x.com/step1 -> 302 https://public.x.com/step2 succeeds, while -> https://private.x.com/step2 is 403
	redirResp, err := gateClient.Get("http://public.x.com/step1")
	if err != nil {
		t.Fatalf("R2-B HTTP->HTTPS redirect request failed: %v", err)
	}
	redirBody, _ := io.ReadAll(redirResp.Body)
	_ = redirResp.Body.Close()
	if redirResp.StatusCode != http.StatusOK || string(redirBody) != "https-step2-ok" {
		t.Fatalf("R2-B HTTP->HTTPS public redirect failed: status=%d body=%q", redirResp.StatusCode, string(redirBody))
	}
	privRedirResp, err := gateClient.Get("http://public.x.com/step1-private")
	if err != nil {
		t.Fatalf("R2-B HTTP->HTTPS private redirect request failed: %v", err)
	}
	_ = privRedirResp.Body.Close()
	if privRedirResp.StatusCode != http.StatusForbidden {
		t.Fatalf("R2-B HTTP->HTTPS private redirect expected 403 Forbidden, got %d", privRedirResp.StatusCode)
	}

	// Counterexample 4: CONNECT tunnel closes within <500ms when cancel() + closeGate() is invoked
	holdLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen holdLn failed: %v", err)
	}
	defer holdLn.Close()
	holdDone := make(chan struct{})
	defer close(holdDone)
	go func() {
		for {
			c, err := holdLn.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				<-holdDone
			}(c)
		}
	}()

	connEng := gateEng.withGateTestHooks(gateTestHooks{
		dialAddr: func(_ netip.Addr, _ string) string {
			return holdLn.Addr().String()
		},
	})
	tunCtx, tunCancel := context.WithCancel(context.Background())
	tunGateURL, closeTunGate, err := connEng.startOutboundGate(tunCtx)
	if err != nil {
		t.Fatalf("startOutboundGate for CONNECT test failed: %v", err)
	}
	tunParsed, _ := url.Parse(tunGateURL)
	tunConn, err := net.DialTimeout("tcp", tunParsed.Host, 2*time.Second)
	if err != nil {
		t.Fatalf("dial tunGate failed: %v", err)
	}
	defer tunConn.Close()
	if _, err := tunConn.Write([]byte("CONNECT public.x.com:443 HTTP/1.1\r\nHost: public.x.com:443\r\nProxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(tunParsed.User.String())) + "\r\n\r\n")); err != nil {
		t.Fatalf("write CONNECT failed: %v", err)
	}
	replyBuf := make([]byte, 128)
	n, err := tunConn.Read(replyBuf)
	if err != nil || !strings.Contains(string(replyBuf[:n]), "200 Connection Established") {
		t.Fatalf("expected 200 Connection Established, got %q (err=%v)", string(replyBuf[:n]), err)
	}
	startCancel := time.Now()
	tunCancel()
	closeTunGate()
	_ = tunConn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	eofBuf := make([]byte, 16)
	_, readErr := tunConn.Read(eofBuf)
	elapsed := time.Since(startCancel)
	if readErr == nil {
		t.Fatalf("R2-B CONNECT cleanup failed: expected tunnel read to return error/EOF after cancel+closeGate")
	}
	if netErr, ok := readErr.(net.Error); ok && netErr.Timeout() {
		t.Fatalf("R2-B CONNECT cleanup failed: tunnel remained open until 500ms deadline (%v)", elapsed)
	}

	// Counterexample 5 (R3): Optional size probe success/failure does not drift source_id, while conflicting size is rejected
	w360, h360, sz360 := int64(640), int64(360), int64(28523658)
	ytOpts := AdaptOptions{
		PlatformID:    "youtube",
		ContentID:     "aqz-KE-bpKQ",
		SourceURL:     "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
		MaxEntries:    1,
		EnableDASHMux: true,
	}
	ytURL := "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=18&source=youtube&clen=28523658&dur=634.566&lmt=1700000000000000&sig=SIG_A"
	envKnownSize := AdaptInfo(&Info{
		ID: "aqz-KE-bpKQ",
		Formats: []Format{{
			FormatID: "18",
			URL:      ytURL,
			Ext:      "mp4",
			Protocol: "https",
			Width:    &w360,
			Height:   &h360,
			VCodec:   "avc1.42001E",
			ACodec:   "mp4a.40.2",
			Filesize: &sz360,
		}},
	}, ytOpts, now)
	envNilSize := AdaptInfo(&Info{
		ID: "aqz-KE-bpKQ",
		Formats: []Format{{
			FormatID: "18",
			URL:      ytURL,
			Ext:      "mp4",
			Protocol: "https",
			Width:    &w360,
			Height:   &h360,
			VCodec:   "avc1.42001E",
			ACodec:   "mp4a.40.2",
			Filesize: nil,
		}},
	}, ytOpts, now)
	defKnown := unified.Map(unified.Map(unified.Slice(unified.Map(envKnownSize["data"])["items"])[0])["default"])
	defNil := unified.Map(unified.Map(unified.Slice(unified.Map(envNilSize["data"])["items"])[0])["default"])
	if unified.Str(defKnown["source_id"]) != unified.Str(defNil["source_id"]) {
		t.Fatalf("R3 counterexample failed: source_id drifted when Filesize toggled nil: %v vs %v", defKnown["source_id"], defNil["source_id"])
	}
	badSz := int64(99999)
	envConflictSize := AdaptInfo(&Info{
		ID: "aqz-KE-bpKQ",
		Formats: []Format{{
			FormatID: "18",
			URL:      ytURL,
			Ext:      "mp4",
			Protocol: "https",
			Width:    &w360,
			Height:   &h360,
			VCodec:   "avc1.42001E",
			ACodec:   "mp4a.40.2",
			Filesize: &badSz,
		}},
	}, ytOpts, now)
	defConflict := unified.Map(unified.Map(unified.Slice(unified.Map(envConflictSize["data"])["items"])[0])["default"])
	if _, hasSize := defConflict["size_bytes"]; hasSize {
		t.Fatalf("R3 counterexample failed: expected conflicting clen vs Filesize to omit size_bytes, got %v", defConflict["size_bytes"])
	}

	// Counterexample 6 (Default selection + 4K metadata): 360p (has_audio=true) + 2160p (3840x2160, has_audio=false)
	w4k, h4k, sz4k := int64(3840), int64(2160), int64(712445280)
	env4K := AdaptInfo(&Info{
		ID:    "aqz-KE-bpKQ",
		Title: "4K Test",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      ytURL,
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w360,
				Height:   &h360,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: &sz360,
			},
			{
				FormatID: "401",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=401&source=youtube&clen=712445280&dur=634.566&lmt=1700000000000000&sig=SIG_B",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w4k,
				Height:   &h4k,
				VCodec:   "av01.0.13M.08",
				ACodec:   "none",
				Filesize: &sz4k,
			},
		},
	}, ytOpts, now)
	if err := unified.ValidateEnvelopeAt(env4K, now); err != nil {
		t.Fatalf("4K envelope validation failed: %v", err)
	}
	item4K := unified.Map(unified.Slice(unified.Map(env4K["data"])["items"])[0])
	def4K := unified.Map(item4K["default"])
	if !strings.Contains(unified.Str(def4K["url"]), "itag=18") {
		t.Fatalf("expected 360p audible variant (itag=18) as item.default, got %+v", def4K)
	}
	variants4K := unified.Slice(item4K["variants"])
	meta4K := unified.Map(unified.Map(variants4K[0])["metadata"])
	if !unified.Equal(meta4K["width"], int64(3840)) || !unified.Equal(meta4K["height"], int64(2160)) {
		t.Fatalf("expected 4K silent variant to preserve metadata.width=3840 and metadata.height=2160, got %+v", meta4K)
	}

	// Counterexample 7 (R4): 206 Partial Content with empty body must be rejected
	if sz, ok := ValidateProbedMediaResponse(http.StatusPartialContent, http.Header{
		"Content-Type":  {"video/mp4"},
		"Content-Range": {"bytes 0-0/12345"},
	}, []byte{}); ok || sz != 0 {
		t.Fatalf("R4 206 empty-body counterexample failed: accepted empty body as (%d, %v)", sz, ok)
	}
}

func TestPR36Review5788284772C1AndExport(t *testing.T) {
	const now int64 = 1762300800
	w360, h360, sz360 := int64(640), int64(360), int64(15048844)
	w720, h720, sz720 := int64(1280), int64(720), int64(42000000)
	w1080, h1080, sz1080 := int64(1920), int64(1080), int64(120000000)
	w4k, h4k, sz4k := int64(3840), int64(2160), int64(712445280)
	szAudio := int64(9800000)

	ytOpts := AdaptOptions{
		PlatformID:    "youtube",
		ContentID:     "aqz-KE-bpKQ",
		SourceURL:     "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
		MaxEntries:    1,
		EnableDASHMux: true,
	}

	// 1. Positive: Audible 360p default + 4K/1080p split silent video-only + M4A audio-only (normal & debug)
	ytAudibleAnd4K := AdaptInfo(&Info{
		ID:       "aqz-KE-bpKQ",
		Title:    "Big Buck Bunny 60fps 4K",
		Uploader: "Blender Foundation",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=18&source=youtube&clen=15048844&dur=634.566&lmt=1700000000000000&sig=SIG_18",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w360,
				Height:   &h360,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: &sz360,
			},
			{
				FormatID: "313",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=313&source=youtube&clen=712445280&dur=634.566&lmt=1700000000000000&sig=SIG_313",
				Ext:      "webm",
				Protocol: "https",
				Width:    &w4k,
				Height:   &h4k,
				VCodec:   "vp9",
				ACodec:   "none",
				Filesize: &sz4k,
			},
			{
				FormatID: "248",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=248&source=youtube&clen=120000000&dur=634.566&lmt=1700000000000000&sig=SIG_248",
				Ext:      "webm",
				Protocol: "https",
				Width:    &w1080,
				Height:   &h1080,
				VCodec:   "vp9",
				ACodec:   "none",
				Filesize: &sz1080,
			},
			{
				FormatID: "140",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=140&source=youtube&clen=9800000&dur=634.566&lmt=1700000000000000&sig=SIG_140",
				Ext:      "m4a",
				Protocol: "https",
				VCodec:   "none",
				ACodec:   "mp4a.40.2",
				Filesize: &szAudio,
			},
		},
	}, ytOpts, now)

	ytNormal := unified.PublicView(ytAudibleAnd4K, false, now)
	ytDebug := unified.PublicView(ytAudibleAnd4K, true, now)
	for viewName, env := range map[string]unified.Object{"normal": ytNormal, "debug": ytDebug} {
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("YouTube %s envelope failed ValidateEnvelopeAt: %v", viewName, err)
		}
	}

	// Negative 1a: Selecting 4K split silent or M4A audio-only when audible 360p exists must be rejected
	for _, badIdx := range []int{0, 3} {
		mutated := unified.Clone(ytNormal)
		it := unified.Map(unified.Slice(unified.Map(mutated["data"])["items"])[0])
		badVar := unified.Map(unified.Slice(it["variants"])[badIdx])
		badSrc := unified.Map(unified.Slice(unified.Map(badVar["delivery"])["sources"])[0])
		it["default"] = unified.Object{
			"variant_id": badVar["id"],
			"source_id":  badSrc["id"],
			"url":        badSrc["url"],
		}
		if err := unified.ValidateEnvelopeAt(mutated, now); err == nil {
			t.Fatalf("expected ValidateEnvelopeAt to reject non-eligible default variant index %d (%s)", badIdx, unified.Str(badVar["label"]))
		}
	}

	// Negative 1b: Two audible complete files (360p + 720p) alongside 4K silent: selecting 360p must be rejected
	ytTwoAudible := AdaptInfo(&Info{
		ID:    "aqz-KE-bpKQ",
		Title: "Two Audible + 4K Silent",
		Formats: []Format{
			{
				FormatID: "18",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=18&source=youtube&clen=15048844&dur=634.566&lmt=1700000000000000&sig=SIG_18",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w360,
				Height:   &h360,
				VCodec:   "avc1.42001E",
				ACodec:   "mp4a.40.2",
				Filesize: &sz360,
			},
			{
				FormatID: "22",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=22&source=youtube&clen=42000000&dur=634.566&lmt=1700000000000000&sig=SIG_22",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w720,
				Height:   &h720,
				VCodec:   "avc1.64001F",
				ACodec:   "mp4a.40.2",
				Filesize: &sz720,
			},
			{
				FormatID: "313",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=313&source=youtube&clen=712445280&dur=634.566&lmt=1700000000000000&sig=SIG_313",
				Ext:      "webm",
				Protocol: "https",
				Width:    &w4k,
				Height:   &h4k,
				VCodec:   "vp9",
				ACodec:   "none",
				Filesize: &sz4k,
			},
		},
	}, ytOpts, now)
	if err := unified.ValidateEnvelopeAt(ytTwoAudible, now); err != nil {
		t.Fatalf("expected 720p audible default to pass ValidateEnvelopeAt: %v", err)
	}
	lowDefault := unified.Clone(ytTwoAudible)
	itLow := unified.Map(unified.Slice(unified.Map(lowDefault["data"])["items"])[0])
	for _, rawV := range unified.Slice(itLow["variants"]) {
		v := unified.Map(rawV)
		if strings.Contains(unified.Str(v["label"]), "360p") {
			src := unified.Map(unified.Slice(unified.Map(v["delivery"])["sources"])[0])
			itLow["default"] = unified.Object{
				"variant_id": v["id"],
				"source_id":  src["id"],
				"url":        src["url"],
			}
		}
	}
	if err := unified.ValidateEnvelopeAt(lowDefault, now); err == nil {
		t.Fatal("expected ValidateEnvelopeAt to reject 360p default when 720p audible complete file is present")
	}

	// 2. Only silent video files: 4K silent selected as default passes; selecting 1080p silent is rejected
	ytOnlySilent := AdaptInfo(&Info{
		ID:    "aqz-KE-bpKQ",
		Title: "Only Silent Video Files",
		Formats: []Format{
			{
				FormatID: "313",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=313&source=youtube&clen=712445280&dur=634.566&lmt=1700000000000000&sig=SIG_313",
				Ext:      "webm",
				Protocol: "https",
				Width:    &w4k,
				Height:   &h4k,
				VCodec:   "vp9",
				ACodec:   "none",
				Filesize: &sz4k,
			},
			{
				FormatID: "248",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=248&source=youtube&clen=120000000&dur=634.566&lmt=1700000000000000&sig=SIG_248",
				Ext:      "webm",
				Protocol: "https",
				Width:    &w1080,
				Height:   &h1080,
				VCodec:   "vp9",
				ACodec:   "none",
				Filesize: &sz1080,
			},
			{
				FormatID: "140",
				URL:      "https://rr2---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1762320000&id=o-1&itag=140&source=youtube&clen=9800000&dur=634.566&lmt=1700000000000000&sig=SIG_140",
				Ext:      "m4a",
				Protocol: "https",
				VCodec:   "none",
				ACodec:   "mp4a.40.2",
				Filesize: &szAudio,
			},
		},
	}, ytOpts, now)
	ytSilentNormal := unified.PublicView(ytOnlySilent, false, now)
	ytSilentDebug := unified.PublicView(ytOnlySilent, true, now)
	for viewName, env := range map[string]unified.Object{"normal": ytSilentNormal, "debug": ytSilentDebug} {
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("only-silent %s envelope failed ValidateEnvelopeAt: %v", viewName, err)
		}
	}
	silentLow := unified.Clone(ytSilentNormal)
	itSilentLow := unified.Map(unified.Slice(unified.Map(silentLow["data"])["items"])[0])
	v1080Silent := unified.Map(unified.Slice(itSilentLow["variants"])[1])
	src1080Silent := unified.Map(unified.Slice(unified.Map(v1080Silent["delivery"])["sources"])[0])
	itSilentLow["default"] = unified.Object{
		"variant_id": v1080Silent["id"],
		"source_id":  src1080Silent["id"],
		"url":        src1080Silent["url"],
	}
	if err := unified.ValidateEnvelopeAt(silentLow, now); err == nil {
		t.Fatal("expected ValidateEnvelopeAt to reject 1080p silent default when 4K silent file is present")
	}

	// 3. Unknown audio (omitted has_audio) is not forged as true, and on Instagram is preferred over silent DASH tracks
	igOpts := AdaptOptions{
		PlatformID:                   "instagram",
		ContentID:                    "CTApqC8BGWd",
		SourceURL:                    "https://www.instagram.com/reel/CTApqC8BGWd/",
		MaxEntries:                   1,
		EnableDASHMux:                true,
		AllowCodecLessProgressiveMP4: true,
	}
	igUnknown := AdaptInfo(&Info{
		ID:    "CTApqC8BGWd",
		Title: "Video by mrcigar",
		Formats: []Format{
			{
				FormatID: "dash-720-silent",
				URL:      "https://scontent-nrt1-1.cdninstagram.com/o1/v/t2/f2/m86/dash720.mp4?efg=eyJ2ZW5jb2RlX3RhZyI6ImRhc2hfaGlnaF8xX3YxIn0&_nc_ht=scontent-nrt1-1.cdninstagram.com&oe=690D8A00",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w720,
				Height:   &h720,
				VCodec:   "avc1.64001F",
				ACodec:   "none",
			},
			{
				FormatID: "1",
				URL:      "https://scontent-nrt1-2.cdninstagram.com/o1/v/t16/f2/m69/10000000_1_n.mp4?efg=eyJ2ZW5jb2RlX3RhZyI6InZ0c192b2RfdXJsZ2VuIn0&_nc_ht=scontent-nrt1-2.cdninstagram.com&oe=690D8A00",
				Ext:      "mp4",
				Protocol: "https",
			},
			{
				FormatID: "dash-audio",
				URL:      "https://scontent-nrt1-1.cdninstagram.com/o1/v/t16/f2/m69/audio.mp4?_nc_ht=scontent-nrt1-1.cdninstagram.com&oe=690D8A00",
				Ext:      "m4a",
				Protocol: "https",
				VCodec:   "none",
				ACodec:   "mp4a.40.5",
			},
		},
	}, igOpts, now)
	igNormal := unified.PublicView(igUnknown, false, now)
	igDebug := unified.PublicView(igUnknown, true, now)
	for viewName, env := range map[string]unified.Object{"normal": igNormal, "debug": igDebug} {
		if err := unified.ValidateEnvelopeAt(env, now); err != nil {
			t.Fatalf("Instagram unknown-audio %s envelope failed ValidateEnvelopeAt: %v", viewName, err)
		}
		item := unified.Map(unified.Slice(unified.Map(env["data"])["items"])[0])
		def := unified.Map(item["default"])
		if def == nil || !strings.Contains(unified.Str(def["url"]), "10000000_1_n.mp4") {
			t.Fatalf("expected Instagram unknown-audio MP4 default in %s view, got %v", viewName, def)
		}
		variants := unified.Slice(item["variants"])
		meta := unified.Map(unified.Map(variants[1])["metadata"])
		if _, exists := meta["has_audio"]; exists {
			t.Fatalf("expected unknown audio to omit has_audio in %s view, got %v", viewName, meta["has_audio"])
		}
	}

	// Unknown audio 360p alongside 4K split silent must NOT be treated as audible complete file
	unknownPlus4KSilent := unified.Clone(ytNormal)
	itUnk := unified.Map(unified.Slice(unified.Map(unknownPlus4KSilent["data"])["items"])[0])
	for _, rawV := range unified.Slice(itUnk["variants"]) {
		v := unified.Map(rawV)
		if strings.Contains(unified.Str(v["label"]), "360p") {
			meta := unified.Map(v["metadata"])
			delete(meta, "has_audio")
			delete(meta, "audio_codec")
		}
	}
	if err := unified.ValidateEnvelopeAt(unknownPlus4KSilent, now); err == nil {
		t.Fatal("expected ValidateEnvelopeAt to reject 360p unknown-audio default when 4K silent file is present")
	}

	if dest := os.Getenv("DOKITOOL_GO_YTDLP_OUTPUT"); dest != "" {
		exports := unified.Array{
			ytNormal,
			ytDebug,
			unified.PublicView(ytTwoAudible, false, now),
			unified.PublicView(ytTwoAudible, true, now),
			ytSilentNormal,
			ytSilentDebug,
			igNormal,
			igDebug,
		}
		raw, err := unified.Encode(exports)
		if err != nil {
			t.Fatalf("encode DOKITOOL_GO_YTDLP_OUTPUT: %v", err)
		}
		if err := os.WriteFile(dest, append(raw, '\n'), 0600); err != nil {
			t.Fatalf("write DOKITOOL_GO_YTDLP_OUTPUT: %v", err)
		}
	}
}

func TestPrA1StderrClassificationAudioProbeAndResolveURLToggle(t *testing.T) {
	// 1. Fine-grained stderr error classification (DRM, geo-restriction, live/offline, WAF/impersonation).
	cases := []struct {
		name      string
		stderr    string
		wantCode  ErrorCode
		retryable bool
		msgSubstr string
	}{
		{
			name:      "drm-protected",
			stderr:    "ERROR: [vimeo] 123: This video is DRM protected",
			wantCode:  CodeUpstreamBlocked,
			retryable: false,
			msgSubstr: "DRM",
		},
		{
			name:      "geo-restricted",
			stderr:    "ERROR: [youtube] abc: The uploader has not made this video available in your country",
			wantCode:  CodeUpstreamBlocked,
			retryable: false,
			msgSubstr: "地区访问限制",
		},
		{
			name:      "live-offline",
			stderr:    "ERROR: [twitch:stream] demo: demo is offline",
			wantCode:  CodeContentUnavailable,
			retryable: false,
			msgSubstr: "直播",
		},
		{
			name:      "premiere-upcoming",
			stderr:    "ERROR: [youtube] xyz: Premieres in 120 minutes",
			wantCode:  CodeContentUnavailable,
			retryable: false,
			msgSubstr: "直播",
		},
		{
			name:      "waf-cloudflare-impersonation",
			stderr:    "ERROR: [tiktok] 999: Unable to download webpage: HTTP Error 403 (caused by Cloudflare challenge; try --impersonate)",
			wantCode:  CodeUpstreamBlocked,
			retryable: false,
			msgSubstr: "人机验证或风控拦截",
		},
		{
			name:      "bot-captcha",
			stderr:    "ERROR: [reddit] 777: Sign in to confirm you're not a bot",
			wantCode:  CodeUpstreamBlocked,
			retryable: false,
			msgSubstr: "人机验证或风控拦截",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyStderr(tc.stderr, nil)
			if got.Code != tc.wantCode || got.Retryable != tc.retryable || !strings.Contains(got.Message, tc.msgSubstr) {
				t.Fatalf("classifyStderr(%q) = {Code:%s Retryable:%v Message:%q}, want {Code:%s Retryable:%v substr:%q}",
					tc.stderr, got.Code, got.Retryable, got.Message, tc.wantCode, tc.retryable, tc.msgSubstr)
			}
		})
	}

	// 2. Audio size probe triggers ONLY when AllowAudioOnly=true, and validates audio magic on 200 OK.
	infoWithAudio := &Info{
		ID: "aud1",
		Formats: []Format{
			{
				FormatID: "mp3-128",
				URL:      "https://cf-media.sndcdn.com/track.mp3",
				Ext:      "mp3",
				Protocol: "https",
				VCodec:   "none",
				ACodec:   "mp3",
			},
		},
	}
	probedCount := 0
	stubProber := func(context.Context, string) (int64, bool) {
		probedCount++
		return 123456, true
	}
	PopulateMissingMP4Sizes(context.Background(), infoWithAudio, stubProber, AdaptOptions{AllowAudioOnly: false})
	if probedCount != 0 || infoWithAudio.Formats[0].Filesize != nil {
		t.Fatalf("AllowAudioOnly=false must not probe audio formats, got count=%d size=%v", probedCount, infoWithAudio.Formats[0].Filesize)
	}
	PopulateMissingMP4Sizes(context.Background(), infoWithAudio, stubProber, AdaptOptions{AllowAudioOnly: true})
	if probedCount != 1 || infoWithAudio.Formats[0].Filesize == nil || *infoWithAudio.Formats[0].Filesize != 123456 {
		t.Fatalf("AllowAudioOnly=true must probe audio formats, got count=%d size=%v", probedCount, infoWithAudio.Formats[0].Filesize)
	}
	for _, audioMagic := range [][]byte{
		append([]byte("ID3\x04\x00\x00\x00\x00\x00\x00"), make([]byte, 16)...),
		append([]byte("OggS\x00\x02\x00\x00\x00\x00\x00\x00"), make([]byte, 16)...),
		append([]byte("fLaC\x00\x00\x00\x22\x10\x00\x10\x00"), make([]byte, 16)...),
		append([]byte("RIFF\x24\x00\x00\x00WAVEfmt "), make([]byte, 16)...),
	} {
		hdr := http.Header{
			"Content-Type":   {"audio/mpeg"},
			"Content-Length": {strconv.Itoa(len(audioMagic))},
		}
		if sz, ok := ValidateProbedMediaResponse(http.StatusOK, hdr, audioMagic); !ok || sz != int64(len(audioMagic)) {
			t.Fatalf("ValidateProbedMediaResponse rejected valid 200 audio magic %q: sz=%d ok=%v", audioMagic[:4], sz, ok)
		}
	}

	// 3. G4: OmitItemResolveURL=false (Tier-1 default) preserves item.resolve_url unchanged.
	const now = int64(1793448000)
	w720, h720 := int64(1280), int64(720)
	sampleInfo := &Info{
		ID:    "fb1",
		Title: "Facebook Clip",
		Formats: []Format{
			{
				FormatID: "hd",
				URL:      "https://video.xx.fbcdn.net/v/t42/clip.mp4",
				Ext:      "mp4",
				Protocol: "https",
				Width:    &w720,
				Height:   &h720,
				VCodec:   "avc1.64001f",
				ACodec:   "mp4a.40.2",
			},
		},
	}
	tier1Env := AdaptInfo(sampleInfo, AdaptOptions{
		PlatformID: "facebook",
		ContentID:  "fb1",
		SourceURL:  "https://www.facebook.com/reel/12345",
	}, now)
	tier1Item := unified.Map(unified.Slice(unified.Map(tier1Env["data"])["items"])[0])
	if !strings.HasPrefix(unified.Str(tier1Item["resolve_url"]), "/api/resolve?") {
		t.Fatalf("Tier-1 default AdaptOptions must preserve item.resolve_url, got %v", tier1Item["resolve_url"])
	}
	if _, hasRefresh := unified.Map(tier1Env["data"])["refresh_url"]; hasRefresh {
		t.Fatalf("Tier-1 default AdaptOptions must not alter data.refresh_url unexpectedly")
	}
}
