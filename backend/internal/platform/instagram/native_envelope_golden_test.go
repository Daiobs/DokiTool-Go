package instagram

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func assertValidPublicAndDebugEnvelope(t *testing.T, env unified.Object, now int64) {
	t.Helper()
	if err := unified.ValidateEnvelopeAt(env, now); err != nil {
		t.Fatalf("ValidateEnvelopeAt(internal) failed: %v (env=%#v)", err, env)
	}
	for _, debug := range []bool{false, true} {
		view := unified.PublicView(env, debug, now)
		if err := unified.ValidateEnvelopeAt(view, now); err != nil {
			t.Fatalf("ValidateEnvelopeAt(PublicView debug=%v) failed: %v (view=%#v)", debug, err, view)
		}
	}
}

func TestNativeEnvelopeGoldenEmptyAndDisallowedURLFiltering(t *testing.T) {
	const (
		now       int64 = 1763200000
		shortcode       = "C9GoldenEmpty"
		sourceURL       = "https://www.instagram.com/p/C9GoldenEmpty/"
	)
	p := New(nil)

	cases := []struct {
		name string
		post *nativePost
	}{
		{
			name: "nil-post",
			post: nil,
		},
		{
			name: "empty-items",
			post: &nativePost{ID: "1", Shortcode: shortcode},
		},
		{
			name: "all-items-disallowed-or-empty-urls",
			post: &nativePost{
				ID:        "2",
				Shortcode: shortcode,
				Items: []nativeMediaItem{
					{
						ID:       "bad-vid-1",
						Kind:     "video",
						VideoURL: "https://evil.example.com/v/video.mp4",
						ImageURL: "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/valid_poster.jpg",
					},
					{
						ID:       "bad-img-2",
						Kind:     "image",
						ImageURL: "http://127.0.0.1:8080/internal.jpg",
					},
					{
						ID:   "empty-3",
						Kind: "video",
					},
				},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := p.buildNativeEnvelopeWithYTVideos(context.Background(), tc.post, nil, shortcode, sourceURL, now)
			if err := unified.ValidateEnvelopeAt(env, now); err != nil {
				t.Fatalf("ValidateEnvelopeAt failed on NO_MEDIA envelope: %v", err)
			}
			if gotCode := unified.Str(env["code"]); gotCode != "NO_MEDIA" {
				t.Fatalf("code = %q, want NO_MEDIA (env=%#v)", gotCode, env)
			}
			errObj := unified.Map(env["error"])
			if unified.Str(errObj["code"]) != "NO_MEDIA" || unified.Str(errObj["message"]) != "该内容未包含可解析的媒体" || errObj["retryable"] == true {
				t.Fatalf("unexpected error payload: %#v", errObj)
			}
		})
	}

	// Partial disallowed item filtering preserves valid items, original 1-based position index,
	// and falls through to ImageURL when Kind=="video" has empty VideoURL.
	t.Run("partial-disallowed-items-and-metadata-url-sanitization", func(t *testing.T) {
		post := &nativePost{
			ID:           "3",
			Shortcode:    shortcode,
			Title:        "Sanitized Post",
			CoverURL:     "https://evil.example.com/cover.jpg",
			AuthorID:     "creator_1",
			AuthorName:   "Creator One",
			AuthorAvatar: "https://evil.example.com/avatar.jpg",
			Items: []nativeMediaItem{
				{
					ID:       "bad-vid-1",
					Kind:     "video",
					VideoURL: "https://evil.example.com/bad.mp4",
					ImageURL: "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/ignored_poster.jpg",
				},
				{
					// Kind=="video" with empty VideoURL falls through to ImageURL as an image item at index 2.
					ID:       "vid-without-url-2",
					Kind:     "video",
					VideoURL: "",
					ImageURL: "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/fallback_slide2.jpg",
					Width:    1080,
					Height:   1350,
				},
				{
					ID:       "bad-img-3",
					Kind:     "image",
					ImageURL: "ftp://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/bad_scheme.jpg",
				},
				{
					ID:       "good-vid-4",
					Kind:     "video",
					VideoURL: "https://scontent-nrt1-1.cdninstagram.com/o1/v/t16/f2/m69/good_slide4.mp4",
					Width:    1920,
					Height:   1080,
				},
			},
		}

		env := p.buildNativeEnvelopeWithYTVideos(context.Background(), post, nil, shortcode, sourceURL, now)
		assertValidPublicAndDebugEnvelope(t, env, now)

		data := unified.Map(unified.PublicView(env, false, now)["data"])
		if _, hasCover := data["cover"]; hasCover {
			t.Fatalf("expected disallowed post.CoverURL to be omitted, got %#v", data["cover"])
		}
		author := unified.Map(data["author"])
		if unified.Str(author["id"]) != "creator_1" || unified.Str(author["name"]) != "Creator One" {
			t.Fatalf("unexpected author: %#v", author)
		}
		if _, hasAvatar := author["avatar"]; hasAvatar {
			t.Fatalf("expected disallowed AuthorAvatar to be omitted, got %#v", author["avatar"])
		}

		items := unified.Slice(data["items"])
		if len(items) != 2 {
			t.Fatalf("items len = %d, want 2 (%#v)", len(items), items)
		}
		it0 := unified.Map(items[0])
		it1 := unified.Map(items[1])
		if unified.Str(it0["type"]) != "image" || it0["index"] != int64(2) {
			t.Fatalf("item[0] = %#v, want image with index=2", it0)
		}
		if unified.Str(it1["type"]) != "video" || it1["index"] != int64(4) {
			t.Fatalf("item[1] = %#v, want video with index=4", it1)
		}
		// Landscape 1920x1080 video uses short-edge 1080p label and omits cover when both entry.ImageURL & valid post.CoverURL are absent.
		vidVar := unified.Map(unified.Slice(it1["variants"])[0])
		if unified.Str(vidVar["label"]) != "1080p" {
			t.Fatalf("landscape video label = %q, want 1080p", unified.Str(vidVar["label"]))
		}
		if _, hasItemCover := it1["cover"]; hasItemCover {
			t.Fatalf("expected item cover omitted when entry.ImageURL is empty and post.CoverURL is disallowed")
		}
	})
}

func TestNativeEnvelopeGoldenPureVideoEntryKeysSizeProberAndMetadataParity(t *testing.T) {
	const (
		now       int64 = 1763200000
		shortcode       = "CTApqC8BGWd"
		sourceURL       = "https://www.instagram.com/reel/CTApqC8BGWd/"
	)

	var probedURLs []string
	p := NewWithSizeProber(nil, func(_ context.Context, rawURL string) (int64, bool) {
		probedURLs = append(probedURLs, rawURL)
		if strings.Contains(rawURL, "probed_720.mp4") {
			return 4718592, true
		}
		return 0, false
	})

	views := int64(98765)
	likes := int64(4321)
	comments := int64(0) // 0 must still be emitted because *count >= 0!

	// entry.ID == shortcode triggers path.Base(u.Path) entryKey resolution ("probed_720.mp4").
	post := &nativePost{
		ID:           "3001",
		Shortcode:    shortcode,
		Title:        "Reel Title",
		Description:  "Reel Title\nFull multi-line caption",
		AuthorID:     "doki_author",
		AuthorName:   "Doki Author",
		AuthorAvatar: "https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-19/avatar_pic.jpg",
		CoverURL:     "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/post_cover.jpg",
		Timestamp:    1762000000, // 2025-11-01T12:26:40Z
		ViewCount:    &views,
		LikeCount:    &likes,
		CommentCount: &comments,
		Items: []nativeMediaItem{
			{
				ID:       shortcode,
				Kind:     "video",
				VideoURL: "https://scontent-lax3-1.cdninstagram.com/o1/v/t16/f2/m69/probed_720.mp4?oe=690D9EC0&oh=00_AYB111",
				ImageURL: "", // Empty entry.ImageURL falls back to post.CoverURL!
				Width:    720,
				Height:   1280,
				Duration: 14.2566, // Rounds to 14257 ms
			},
		},
	}

	env := p.buildNativeEnvelope(context.Background(), post, shortcode, sourceURL, now)
	assertValidPublicAndDebugEnvelope(t, env, now)

	if len(probedURLs) != 1 || !strings.Contains(probedURLs[0], "probed_720.mp4") {
		t.Fatalf("expected sizeProber called once for probed_720.mp4, got %v", probedURLs)
	}

	pub := unified.PublicView(env, false, now)
	data := unified.Map(pub["data"])

	wantEntryKey := "probed_720.mp4"
	wantItemID := "video-" + shortHash("instagram:item:"+shortcode+":"+wantEntryKey)
	wantVarID := "v-" + shortHash("instagram:native-video:"+shortcode+":"+wantEntryKey)

	if unified.Str(data["platform"]) != "instagram" ||
		unified.Str(data["content_id"]) != shortcode ||
		unified.Str(data["source_url"]) != sourceURL ||
		unified.Str(data["default_item_id"]) != wantItemID ||
		unified.Str(data["generated_at"]) != "2025-11-15T09:46:40Z" ||
		unified.Str(data["published_at"]) != "2025-11-01T12:26:40Z" ||
		unified.Str(data["title"]) != "Reel Title" ||
		unified.Str(data["description"]) != "Reel Title\nFull multi-line caption" {
		t.Fatalf("unexpected envelope metadata: %#v", data)
	}
	if _, hasGroups := data["groups"]; hasGroups {
		t.Fatalf("pure video post must omit groups, got %#v", data["groups"])
	}
	if unified.Str(unified.Map(data["cover"])["url"]) != post.CoverURL {
		t.Fatalf("unexpected data.cover: %#v", data["cover"])
	}

	author := unified.Map(data["author"])
	if unified.Str(author["id"]) != "doki_author" ||
		unified.Str(author["name"]) != "Doki Author" ||
		unified.Str(unified.Map(author["avatar"])["url"]) != post.AuthorAvatar {
		t.Fatalf("unexpected data.author: %#v", author)
	}

	stats := unified.Map(data["statistics"])
	if unified.Map(stats["views"])["value"] != int64(98765) ||
		unified.Map(stats["likes"])["value"] != int64(4321) ||
		unified.Map(stats["comments"])["value"] != int64(0) {
		t.Fatalf("unexpected data.statistics: %#v", stats)
	}

	item := unified.Map(unified.Slice(data["items"])[0])
	if unified.Str(item["id"]) != wantItemID ||
		unified.Str(item["type"]) != "video" ||
		item["index"] != int64(1) ||
		item["duration_ms"] != int64(14257) ||
		unified.Str(item["resolve_url"]) != unified.ResolveURL(sourceURL, wantItemID) {
		t.Fatalf("unexpected video item: %#v", item)
	}
	if unified.Str(unified.Map(item["cover"])["url"]) != post.CoverURL {
		t.Fatalf("expected video item cover to fall back to post.CoverURL, got %#v", item["cover"])
	}
	def := unified.Map(item["default"])
	if unified.Str(def["variant_id"]) != wantVarID {
		t.Fatalf("default.variant_id = %q, want %q", unified.Str(def["variant_id"]), wantVarID)
	}

	variant := unified.Map(unified.Slice(item["variants"])[0])
	if unified.Str(variant["id"]) != wantVarID || unified.Str(variant["label"]) != "720p" {
		t.Fatalf("unexpected variant id/label: %#v", variant)
	}
	meta := unified.Map(variant["metadata"])
	if unified.Str(meta["container"]) != "mp4" ||
		unified.Str(meta["extension"]) != "mp4" ||
		unified.Str(meta["mime_type"]) != "video/mp4" ||
		meta["width"] != int64(720) ||
		meta["height"] != int64(1280) {
		t.Fatalf("unexpected video metadata: %#v", meta)
	}
	if _, hasAudio := meta["has_audio"]; hasAudio {
		t.Fatalf("native video metadata must omit has_audio, got %#v", meta)
	}
	src := unified.Map(unified.Slice(unified.Map(variant["delivery"])["sources"])[0])
	if src["size_bytes"] != int64(4718592) {
		t.Fatalf("expected probed size_bytes=4718592, got %#v", src)
	}

	// Dimensionless video + empty URL path fallback to position string ("1") + negative stats omitted.
	t.Run("dimensionless-video-default-label-and-position-entryKey", func(t *testing.T) {
		neg := int64(-1)
		dimlessPost := &nativePost{
			ID:        "3002",
			Shortcode: shortcode,
			LikeCount: &neg,
			Items: []nativeMediaItem{
				{
					ID:       "", // Empty ID + empty URL path -> entryKey = "1"
					Kind:     "video",
					VideoURL: "https://scontent-lax3-1.cdninstagram.com?id=root_stream",
					ImageURL: "https://scontent-lax3-1.cdninstagram.com/v/t51.29350-15/item_specific_cover.jpg",
					Width:    720,
					Height:   0,      // Incomplete dimensions -> "默认画质" and no width/height
					Duration: 0.0001, // Rounds to 0ms -> duration_ms omitted
				},
			},
		}
		dimEnv := p.buildNativeEnvelope(context.Background(), dimlessPost, shortcode, sourceURL, now)
		assertValidPublicAndDebugEnvelope(t, dimEnv, now)

		dimData := unified.Map(unified.PublicView(dimEnv, false, now)["data"])
		if _, hasStats := dimData["statistics"]; hasStats {
			t.Fatalf("expected negative statistics omitted, got %#v", dimData["statistics"])
		}
		dimItem := unified.Map(unified.Slice(dimData["items"])[0])
		wantPosItemID := "video-" + shortHash("instagram:item:"+shortcode+":1")
		if unified.Str(dimItem["id"]) != wantPosItemID {
			t.Fatalf("item.id = %q, want %q (position entryKey=1)", unified.Str(dimItem["id"]), wantPosItemID)
		}
		if _, hasDur := dimItem["duration_ms"]; hasDur {
			t.Fatalf("expected sub-0.5ms duration_ms omitted, got %v", dimItem["duration_ms"])
		}
		if !strings.Contains(unified.Str(unified.Map(dimItem["cover"])["url"]), "item_specific_cover.jpg") {
			t.Fatalf("expected entry.ImageURL to take precedence over post.CoverURL, got %#v", dimItem["cover"])
		}
		dimVar := unified.Map(unified.Slice(dimItem["variants"])[0])
		if unified.Str(dimVar["label"]) != "默认画质" {
			t.Fatalf("label = %q, want 默认画质", unified.Str(dimVar["label"]))
		}
		dimMeta := unified.Map(dimVar["metadata"])
		if _, hasW := dimMeta["width"]; hasW {
			t.Fatalf("expected width omitted on incomplete video dimensions, got %#v", dimMeta)
		}
	})
}

func TestNativeEnvelopeGoldenPureAlbumSingleImageAndMultiVideoGroups(t *testing.T) {
	const (
		now       int64 = 1763200000
		shortcode       = "DaBUYYOjNgA"
		sourceURL       = "https://www.instagram.com/p/DaBUYYOjNgA/"
	)
	p := New(nil)

	// 1. Single image post: groups MUST be omitted because len(items) == 1.
	t.Run("single-image-omits-album-group-and-supports-width-only", func(t *testing.T) {
		singlePost := &nativePost{
			ID:         "4001",
			Shortcode:  shortcode,
			AuthorName: "NameOnly",
			Items: []nativeMediaItem{
				{
					ID:       "img-only-1",
					Kind:     "image",
					ImageURL: "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/single.jpg?stp=dst-jpg",
					Width:    1080,
					Height:   0,
				},
			},
		}
		env := p.buildNativeEnvelope(context.Background(), singlePost, shortcode, sourceURL, now)
		assertValidPublicAndDebugEnvelope(t, env, now)
		data := unified.Map(unified.PublicView(env, false, now)["data"])
		if _, hasGroups := data["groups"]; hasGroups {
			t.Fatalf("single-image post must omit groups, got %#v", data["groups"])
		}
		author := unified.Map(data["author"])
		if unified.Str(author["name"]) != "NameOnly" {
			t.Fatalf("unexpected author: %#v", author)
		}
		if _, hasAuthorID := author["id"]; hasAuthorID {
			t.Fatalf("expected empty AuthorID omitted, got %#v", author)
		}
		meta := unified.Map(unified.Map(unified.Slice(unified.Map(unified.Slice(data["items"])[0])["variants"])[0])["metadata"])
		if meta["width"] != int64(1080) {
			t.Fatalf("expected width=1080 on image, got %#v", meta)
		}
		if _, hasH := meta["height"]; hasH {
			t.Fatalf("expected height=0 omitted on image, got %#v", meta)
		}
	})

	// 2. Pure multi-image album (3 images: jpg, webp, png) emits groups[0].kind == "album".
	t.Run("pure-multi-image-album-formats-and-group-contract", func(t *testing.T) {
		albumPost := &nativePost{
			ID:        "4002",
			Shortcode: shortcode,
			AuthorID:  "id_only_user",
			Items: []nativeMediaItem{
				{
					ID:       "slide-1",
					Kind:     "image",
					ImageURL: "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/photo1.jpg",
					Width:    1440,
					Height:   1800,
				},
				{
					ID:       "slide-2",
					Kind:     "image",
					ImageURL: "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/photo2.WEBP?efg=abc",
					Width:    1440,
					Height:   1800,
				},
				{
					ID:       "slide-3",
					Kind:     "image",
					ImageURL: "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/photo3.Png",
					Width:    1080,
					Height:   1080,
				},
			},
		}
		env := p.buildNativeEnvelope(context.Background(), albumPost, shortcode, sourceURL, now)
		assertValidPublicAndDebugEnvelope(t, env, now)

		data := unified.Map(unified.PublicView(env, false, now)["data"])
		items := unified.Slice(data["items"])
		if len(items) != 3 {
			t.Fatalf("items len = %d, want 3", len(items))
		}

		wantFormats := [][3]string{
			{"jpeg", "jpg", "image/jpeg"},
			{"webp", "webp", "image/webp"},
			{"png", "png", "image/png"},
		}
		wantIDs := make([]string, 3)
		for i, wf := range wantFormats {
			it := unified.Map(items[i])
			entryKey := albumPost.Items[i].ID
			wantID := "image-" + shortHash("instagram:item:"+shortcode+":"+entryKey)
			wantVarID := "img-" + shortHash("instagram:native-image:"+shortcode+":"+entryKey)
			wantIDs[i] = wantID
			if unified.Str(it["id"]) != wantID || unified.Str(it["type"]) != "image" || it["index"] != int64(i+1) {
				t.Fatalf("slide %d unexpected item: %#v", i+1, it)
			}
			v := unified.Map(unified.Slice(it["variants"])[0])
			if unified.Str(v["id"]) != wantVarID {
				t.Fatalf("slide %d variant.id = %q, want %q", i+1, unified.Str(v["id"]), wantVarID)
			}
			m := unified.Map(v["metadata"])
			if unified.Str(m["container"]) != wf[0] || unified.Str(m["extension"]) != wf[1] || unified.Str(m["mime_type"]) != wf[2] {
				t.Fatalf("slide %d metadata = %#v, want %v", i+1, m, wf)
			}
		}

		groups := unified.Slice(data["groups"])
		if len(groups) != 1 {
			t.Fatalf("groups len = %d, want 1 (%#v)", len(groups), groups)
		}
		grp := unified.Map(groups[0])
		if unified.Str(grp["id"]) != "album" ||
			unified.Str(grp["kind"]) != "album" ||
			grp["total_count"] != int64(3) ||
			grp["complete"] != true {
			t.Fatalf("unexpected album group: %#v", grp)
		}
		gotGroupIDs := unified.Slice(grp["item_ids"])
		if len(gotGroupIDs) != 3 ||
			unified.Str(gotGroupIDs[0]) != wantIDs[0] ||
			unified.Str(gotGroupIDs[1]) != wantIDs[1] ||
			unified.Str(gotGroupIDs[2]) != wantIDs[2] {
			t.Fatalf("group.item_ids = %#v, want %v", gotGroupIDs, wantIDs)
		}
	})

	// 3. Multi-video carousel with zero images omits album group because len(imageItemIDs) == 0.
	t.Run("multi-video-zero-images-omits-album-group", func(t *testing.T) {
		twoVideoPost := &nativePost{
			ID:        "4003",
			Shortcode: shortcode,
			Items: []nativeMediaItem{
				{ID: "v1", Kind: "video", VideoURL: "https://scontent-nrt1-1.cdninstagram.com/o1/v/t16/f2/m69/v1.mp4", Width: 720, Height: 1280},
				{ID: "v2", Kind: "video", VideoURL: "https://scontent-nrt1-1.cdninstagram.com/o1/v/t16/f2/m69/v2.mp4", Width: 720, Height: 1280},
			},
		}
		env := p.buildNativeEnvelope(context.Background(), twoVideoPost, shortcode, sourceURL, now)
		assertValidPublicAndDebugEnvelope(t, env, now)
		data := unified.Map(unified.PublicView(env, false, now)["data"])
		if _, hasGroups := data["groups"]; hasGroups {
			t.Fatalf("expected multi-video post with 0 images to omit groups, got %#v", data["groups"])
		}
	})
}

func TestNativeEnvelopeGoldenMixedCarouselYTVideosMatchVsMismatch(t *testing.T) {
	const (
		now       int64 = 1763200000
		shortcode       = "DIqghhpok2K"
		sourceURL       = "https://www.instagram.com/p/DIqghhpok2K/"
	)

	makeMixedPost := func() *nativePost {
		return &nativePost{
			ID:        "5001",
			Shortcode: shortcode,
			Title:     "Mixed Carousel",
			CoverURL:  "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/main_cover.jpg",
			Items: []nativeMediaItem{
				{
					ID:       "vid-1",
					Kind:     "video",
					VideoURL: "https://scontent-nrt1-1.cdninstagram.com/o1/v/t16/f2/m69/native_v1.mp4",
					ImageURL: "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/v1_cover.jpg",
					Width:    720,
					Height:   1280,
					Duration: 8.4,
				},
				{
					ID:       "img-2",
					Kind:     "image",
					ImageURL: "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/img2.jpg",
					Width:    1080,
					Height:   1350,
				},
				{
					ID:       "vid-3",
					Kind:     "video",
					VideoURL: "https://scontent-nrt1-1.cdninstagram.com/o1/v/t16/f2/m69/native_v3.mp4",
					ImageURL: "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/v3_cover.jpg",
					Width:    1920,
					Height:   1080,
					Duration: 12.0,
				},
				{
					ID:       "img-4",
					Kind:     "image",
					ImageURL: "https://scontent-nrt1-1.cdninstagram.com/v/t51.29350-15/img4.webp",
					Width:    1080,
					Height:   1350,
				},
			},
		}
	}

	makeYTVariant := func(variantID, label, mediaURL string, w, h, sizeBytes int64) unified.Object {
		sources := unified.Sources(unified.Array{
			unified.Object{
				"url":        mediaURL,
				"size_bytes": sizeBytes,
			},
		}, now)
		return unified.Object{
			"id":    variantID,
			"label": label,
			"metadata": unified.Object{
				"evidence":  "upstream",
				"container": "mp4",
				"extension": "mp4",
				"mime_type": "video/mp4",
				"width":     w,
				"height":    h,
				"has_audio": true,
			},
			"delivery": unified.Object{
				"kind":    "file",
				"sources": sources,
			},
		}
	}

	// 1. ytVideos count match (2 == 2): replaces video variants in order, clones variants deeply,
	// does NOT call sizeProber, and groups[0].item_ids contains ONLY the 2 image items.
	t.Run("ytVideos-count-match-replaces-and-clones-variants-without-probing", func(t *testing.T) {
		var probeCalls atomic.Int32
		p := NewWithSizeProber(nil, func(_ context.Context, _ string) (int64, bool) {
			probeCalls.Add(1)
			return 999999, true
		})

		ytVideos := unified.Array{
			unified.Object{
				"variants": unified.Array{
					makeYTVariant("v-yt-1080", "1080p (含音频)", "https://scontent-nrt1-2.cdninstagram.com/o1/v/t16/f2/m69/yt_v1_1080.mp4", 1080, 1920, 8100000),
				},
			},
			unified.Object{
				"variants": unified.Array{
					makeYTVariant("v-yt-2160", "4K (含音频)", "https://scontent-nrt1-2.cdninstagram.com/o1/v/t16/f2/m69/yt_v3_2160.mp4", 3840, 2160, 16200000),
				},
			},
		}

		env := p.buildNativeEnvelopeWithYTVideos(context.Background(), makeMixedPost(), ytVideos, shortcode, sourceURL, now)
		if probeCalls.Load() != 0 {
			t.Fatalf("expected 0 sizeProber calls when ytVideos supply non-empty variants, got %d", probeCalls.Load())
		}

		// Mutate caller's ytVideos in-place to prove CloneValue isolation.
		unified.Map(unified.Slice(unified.Map(ytVideos[0])["variants"])[0])["label"] = "MUTATED_AFTER_CALL"

		assertValidPublicAndDebugEnvelope(t, env, now)
		data := unified.Map(unified.PublicView(env, false, now)["data"])
		items := unified.Slice(data["items"])
		if len(items) != 4 {
			t.Fatalf("items len = %d, want 4", len(items))
		}

		v1 := unified.Map(items[0])
		img2 := unified.Map(items[1])
		v3 := unified.Map(items[2])
		img4 := unified.Map(items[3])

		if unified.Str(unified.Map(v1["default"])["url"]) != "https://scontent-nrt1-2.cdninstagram.com/o1/v/t16/f2/m69/yt_v1_1080.mp4" {
			t.Fatalf("video 1 did not use ytVideos[0] variant: %#v", v1)
		}
		if gotLabel := unified.Str(unified.Map(unified.Slice(v1["variants"])[0])["label"]); gotLabel != "1080p (含音频)" {
			t.Fatalf("video 1 variant label = %q, want unmutated '1080p (含音频)'", gotLabel)
		}
		if unified.Str(unified.Map(v3["default"])["url"]) != "https://scontent-nrt1-2.cdninstagram.com/o1/v/t16/f2/m69/yt_v3_2160.mp4" {
			t.Fatalf("video 3 did not use ytVideos[1] variant: %#v", v3)
		}

		groups := unified.Slice(data["groups"])
		if len(groups) != 1 {
			t.Fatalf("expected 1 album group, got %#v", groups)
		}
		grp := unified.Map(groups[0])
		grpIDs := unified.Slice(grp["item_ids"])
		if unified.Str(grp["kind"]) != "album" ||
			grp["total_count"] != int64(2) ||
			len(grpIDs) != 2 ||
			unified.Str(grpIDs[0]) != unified.Str(img2["id"]) ||
			unified.Str(grpIDs[1]) != unified.Str(img4["id"]) {
			t.Fatalf("expected album group with [img2, img4], got %#v", grp)
		}
	})

	// 2. ytVideos count match where one ytVideo entry has empty variants falls back to native video + sizeProber for that item only.
	t.Run("ytVideos-count-match-empty-item-variants-falls-back-per-item", func(t *testing.T) {
		var probed []string
		p := NewWithSizeProber(nil, func(_ context.Context, rawURL string) (int64, bool) {
			probed = append(probed, rawURL)
			return 5550000, true
		})

		ytVideos := unified.Array{
			unified.Object{
				"variants": unified.Array{
					makeYTVariant("v-yt-1080", "1080p (含音频)", "https://scontent-nrt1-2.cdninstagram.com/o1/v/t16/f2/m69/yt_v1_1080.mp4", 1080, 1920, 8100000),
				},
			},
			unified.Object{
				"variants": unified.Array{}, // Empty variants -> fallback to native_v3.mp4!
			},
		}

		env := p.buildNativeEnvelopeWithYTVideos(context.Background(), makeMixedPost(), ytVideos, shortcode, sourceURL, now)
		assertValidPublicAndDebugEnvelope(t, env, now)
		if len(probed) != 1 || !strings.Contains(probed[0], "native_v3.mp4") {
			t.Fatalf("expected sizeProber called only for fallback native_v3.mp4, got %v", probed)
		}
	})

	// 3. ytVideos count mismatch (1 vs 2, and 3 vs 2): ignores ytVideos completely, falls back to native videos with sizeProber & short-edge labels.
	for _, tc := range []struct {
		name     string
		ytVideos unified.Array
	}{
		{
			name: "fewer-ytVideos-than-native-videos-1-vs-2",
			ytVideos: unified.Array{
				unified.Object{
					"variants": unified.Array{
						makeYTVariant("v-yt-1", "1080p", "https://scontent-nrt1-2.cdninstagram.com/o1/v/t16/f2/m69/yt_unused.mp4", 1080, 1920, 8100000),
					},
				},
			},
		},
		{
			name: "more-ytVideos-than-native-videos-3-vs-2",
			ytVideos: unified.Array{
				unified.Object{"variants": unified.Array{makeYTVariant("v-yt-1", "1080p", "https://scontent-nrt1-2.cdninstagram.com/o1/v/t16/f2/m69/yt_unused1.mp4", 1080, 1920, 1)}},
				unified.Object{"variants": unified.Array{makeYTVariant("v-yt-2", "1080p", "https://scontent-nrt1-2.cdninstagram.com/o1/v/t16/f2/m69/yt_unused2.mp4", 1080, 1920, 1)}},
				unified.Object{"variants": unified.Array{makeYTVariant("v-yt-3", "1080p", "https://scontent-nrt1-2.cdninstagram.com/o1/v/t16/f2/m69/yt_unused3.mp4", 1080, 1920, 1)}},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var probed []string
			p := NewWithSizeProber(nil, func(_ context.Context, rawURL string) (int64, bool) {
				probed = append(probed, rawURL)
				if strings.Contains(rawURL, "native_v1.mp4") {
					return 3100000, true
				}
				if strings.Contains(rawURL, "native_v3.mp4") {
					return 6200000, true
				}
				return 0, false
			})

			env := p.buildNativeEnvelopeWithYTVideos(context.Background(), makeMixedPost(), tc.ytVideos, shortcode, sourceURL, now)
			assertValidPublicAndDebugEnvelope(t, env, now)

			if len(probed) != 2 {
				t.Fatalf("expected sizeProber called for both native videos on mismatch, got %v", probed)
			}

			data := unified.Map(unified.PublicView(env, false, now)["data"])
			items := unified.Slice(data["items"])
			v1 := unified.Map(items[0])
			v3 := unified.Map(items[2])

			v1Var := unified.Map(unified.Slice(v1["variants"])[0])
			v3Var := unified.Map(unified.Slice(v3["variants"])[0])
			if !strings.Contains(unified.Str(unified.Map(v1["default"])["url"]), "native_v1.mp4") || unified.Str(v1Var["label"]) != "720p" {
				t.Fatalf("video 1 fallback mismatch: %#v", v1)
			}
			if !strings.Contains(unified.Str(unified.Map(v3["default"])["url"]), "native_v3.mp4") || unified.Str(v3Var["label"]) != "1080p" {
				t.Fatalf("video 3 fallback mismatch: %#v", v3)
			}
			v1Src := unified.Map(unified.Slice(unified.Map(v1Var["delivery"])["sources"])[0])
			v3Src := unified.Map(unified.Slice(unified.Map(v3Var["delivery"])["sources"])[0])
			if v1Src["size_bytes"] != int64(3100000) || v3Src["size_bytes"] != int64(6200000) {
				t.Fatalf("expected probed sizes 3100000 & 6200000, got %v & %v", v1Src["size_bytes"], v3Src["size_bytes"])
			}
		})
	}
}
