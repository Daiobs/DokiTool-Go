package bilibili

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

func adapt(raw object, sourceURL string, now int64) object {
	data, _ := adaptWithOptions(raw, sourceURL, now, nil, false)
	return data
}

func adaptWithOptions(raw object, sourceURL string, now int64, shPlay *ShanghaiPlay, enableDASH bool) (object, bool) {
	raw = unified.Clone(raw)
	raw["author"] = pick(raw["user"], object{})
	data := unified.WorkMetadata("bilibili", raw, sourceURL)
	bvid := unified.Str(child(raw, "extra", "bvid"))
	current := intValue(pick(child(raw, "extra", "current_page"), 1))
	data["content_id"] = bvid
	items, partIDs := array{}, array{}
	known := map[string]bool{}
	matchedShanghai := false
	var bestAudioAttachment object
	for i, value := range unified.Slice(child(raw, "extra", "pages")) {
		page := unified.Map(value)
		number := intValue(pick(page["page"], i+1))
		id := bvid + "-p" + strconv.FormatInt(number, 10)
		pageURL := "https://www.bilibili.com/video/" + unified.RFC3986Query(bvid) + "/?p=" + strconv.FormatInt(number, 10)
		item := object{"id": id, "type": "video", "index": number, "default": nil, "source_url": pageURL, "resolve_url": unified.ResolveURL(pageURL, id)}
		if title, ok := unified.Text(page["part"]); ok && title != "0" {
			item["title"] = title
		}
		if duration, ok := unified.Numeric(page["duration"]); ok && duration > 0 {
			item["duration_ms"] = int64(unified.PHPRound(duration*1000, 0))
		}
		if number == current {
			vars, matched, bestAudio := variantsWithOptions(raw, bvid, number, page["cid"], now, shPlay, enableDASH)
			if len(vars) == 0 {
				delete(item, "resolve_url")
				item["state"] = "unavailable"
				item["error"] = object{"code": "CONTENT_UNAVAILABLE", "message": "当前分P未提供完整媒体描述"}
			} else {
				item["variants"] = vars
				if matched {
					matchedShanghai = true
				}
				if enableDASH && bestAudio != nil {
					bestAudioAttachment = object{
						"id":       "bilibili-audio-" + bvid + "-p" + strconv.FormatInt(current, 10),
						"role":     "background_audio",
						"title":    "原声音频 (M4A)",
						"resource": unified.Clone(bestAudio),
					}
				}
			}
		} else {
			item["state"] = "deferred"
		}
		items = append(items, item)
		partIDs = append(partIDs, id)
		known[id] = true
	}
	data["default_item_id"] = bvid + "-p" + strconv.FormatInt(current, 10)
	groups := array{object{"id": "parts", "kind": "multipart", "item_ids": partIDs, "complete": true, "total_count": len(items)}}
	for sectionIndex, value := range unified.Slice(child(raw, "private_collection", "sections")) {
		section := unified.Map(value)
		members, seen := array{}, map[string]bool{}
		for _, value := range unified.Slice(section["episodes"]) {
			episode := unified.Map(value)
			episodeID := unified.Str(pick(episode["bvid"], child(episode, "arc", "bvid")))
			if !videoID.MatchString(episodeID) {
				continue
			}
			id := episodeID + "-p1"
			if !seen[id] {
				members = append(members, id)
				seen[id] = true
			}
			if known[id] {
				continue
			}
			known[id] = true
			pageURL := "https://www.bilibili.com/video/" + episodeID + "/?p=1"
			item := object{"id": id, "type": "video", "state": "deferred", "default": nil, "source_url": pageURL, "resolve_url": unified.ResolveURL(pageURL, id)}
			if title, ok := unified.Text(pick(episode["title"], child(episode, "arc", "title"))); ok && title != "0" {
				item["title"] = title
			}
			if cover := unified.Source(child(episode, "arc", "pic")); cover != nil {
				item["cover"] = cover
			}
			items = append(items, item)
		}
		if len(members) > 0 {
			group := object{"id": "collection-" + strconv.Itoa(sectionIndex), "kind": "collection", "item_ids": members, "complete": false}
			if title, ok := unified.Text(section["title"]); ok && title != "0" {
				group["title"] = title
			}
			groups = append(groups, group)
		}
	}
	data["items"], data["groups"] = items, groups
	if bestAudioAttachment != nil {
		attachments := append(array{}, unified.Slice(data["attachments"])...)
		attachments = append(attachments, bestAudioAttachment)
		data["attachments"] = attachments
	}
	return data, matchedShanghai
}

func variantsWithOptions(raw object, bvid string, page int64, cid any, now int64, shPlay *ShanghaiPlay, enableDASH bool) (array, bool, object) {
	if shPlay != nil {
		if cidInt, ok := parsePositiveCID(cid); !ok || shPlay.BVID != bvid || shPlay.CID != cidInt {
			shPlay = nil
		}
	}
	if raw["private_error"] != nil {
		return array{}, false, nil
	}
	play := unified.Map(raw["private_play"])
	if len(play) == 0 {
		sources := append(array{object{"url": raw["url"]}}, unified.Slice(raw["video_backup"])...)
		return unified.FileVariants(array{object{"url": raw["url"], "sources": sources, "label": pick(raw["quality"], "规格未知")}}, now), false, nil
	}
	result := array{}
	matchedAny := false
	jpQuality := intValue(play["quality"])
	durl := unified.Slice(play["durl"])
	if len(durl) == 1 {
		part := unified.Map(durl[0])
		candidate := object{"sources": partSources(part), "label": pick(raw["quality"], "规格未知")}
		markSingleDURL(candidate, bvid, page, stringValue(cid), play, part)
		// PHP array union keeps the first fact: part before play, video before audio.
		union(candidate, unified.VideoFacts(part), unified.VideoFacts(play), unified.AudioFacts(part), unified.AudioFacts(play))
		if enableDASH && candidate["width"] == nil && candidate["height"] == nil {
			if w, h, ok := dashQualityDimensions(play, jpQuality); ok {
				candidate["width"] = w
				candidate["height"] = h
			}
		}
		result = unified.FileVariants(array{candidate}, now)
		if shPlay != nil && jpQuality > 0 && shPlay.DURLQuality == jpQuality && len(shPlay.DURLPieces) == 1 && len(result) == 1 {
			shURLs := filterShanghaiURLsAt(shPlay.DURLPieces[0].URLs, now)
			if len(shURLs) > 0 {
				delivery := unified.Map(unified.Map(result[0])["delivery"])
				if merged, ok := prependShanghaiSources(shURLs, unified.Slice(delivery["sources"]), now); ok {
					delivery["sources"] = merged
					matchedAny = true
				}
			}
		}
	} else if len(durl) > 1 {
		shPiecesMatch := shPlay != nil && jpQuality > 0 && shPlay.DURLQuality == jpQuality && len(shPlay.DURLPieces) == len(durl)
		shFilteredPieces := make([][]string, len(durl))
		if shPiecesMatch {
			for i := range durl {
				shFilteredPieces[i] = filterShanghaiURLsAt(shPlay.DURLPieces[i].URLs, now)
				if len(shFilteredPieces[i]) == 0 {
					shPiecesMatch = false
					break
				}
			}
		}
		pieces := array{}
		for i, value := range durl {
			part := unified.Map(value)
			jpPieceSources := unified.Sources(partSources(part), now)
			if shPiecesMatch {
				if merged, ok := prependShanghaiSources(shFilteredPieces[i], jpPieceSources, now); ok {
					jpPieceSources = merged
					matchedAny = true
				}
			}
			piece := object{"index": i + 1, "sources": jpPieceSources}
			if length, ok := unified.Numeric(part["length"]); ok && length > 0 {
				piece["duration_ms"] = intValue(part["length"])
			}
			pieces = append(pieces, piece)
		}
		result = append(result, object{"id": "segments", "delivery": object{"kind": "segments", "pieces": pieces, "join": "remux", "output": output()}})
	}

	if enableDASH {
		dashVariants, dashMatched, bestAudio := adaptDASHModern(play, now, shPlay, len(result) > 0)
		result = append(result, dashVariants...)
		if dashMatched {
			matchedAny = true
		}
		return result, matchedAny, bestAudio
	}

	type dashAudioOption struct {
		resource object
		digest   string
		matched  bool
	}
	audioOptions := make([]dashAudioOption, 0)
	for _, value := range unified.Slice(child(play, "dash", "audio")) {
		rawAudio := unified.Map(value)
		resource := track(rawAudio, "audio", now)
		if resource == nil {
			continue
		}
		audioDigest := digest(unified.PHPIdentityJSON(unified.ResourceIdentity(resource), false))
		audioMatched := false
		if shPlay != nil {
			var shURLs []string
			for _, shTrack := range shPlay.DashAudio {
				if dashTrackMatch(shTrack, rawAudio) {
					shURLs = append(shURLs, shTrack.URLs...)
				}
			}
			shURLs = filterShanghaiURLsAt(shURLs, now)
			if len(shURLs) > 0 {
				delivery := unified.Map(resource["delivery"])
				if merged, ok := prependShanghaiSources(shURLs, unified.Slice(delivery["sources"]), now); ok {
					delivery["sources"] = merged
					audioMatched = true
				}
			}
		}
		audioOptions = append(audioOptions, dashAudioOption{resource: resource, digest: audioDigest, matched: audioMatched})
	}
	for _, value := range unified.Slice(child(play, "dash", "video")) {
		rawVideo := unified.Map(value)
		video := track(rawVideo, "video", now)
		if video == nil {
			continue
		}
		variantID := "mux-" + digest(unified.PHPIdentityJSON(unified.ResourceIdentity(video), false))
		if len(audioOptions) == 0 {
			result = append(result, object{"id": variantID, "state": "deferred", "reason": object{"code": "MISSING_AUDIO_TRACK", "message": "未取得可确认的完整音视频组合，暂不可下载"}})
			continue
		}
		videoMatched := false
		if shPlay != nil {
			var shURLs []string
			for _, shTrack := range shPlay.DashVideo {
				if dashTrackMatch(shTrack, rawVideo) {
					shURLs = append(shURLs, shTrack.URLs...)
				}
			}
			shURLs = filterShanghaiURLsAt(shURLs, now)
			if len(shURLs) > 0 {
				delivery := unified.Map(video["delivery"])
				if merged, ok := prependShanghaiSources(shURLs, unified.Slice(delivery["sources"]), now); ok {
					delivery["sources"] = merged
					videoMatched = true
				}
			}
		}
		for _, audio := range audioOptions {
			id := variantID + "-" + audio.digest
			variant := object{"id": id, "delivery": object{"kind": "mux", "resources": array{unified.Clone(video), unified.Clone(audio.resource)}, "output": output()}}
			if video["metadata"] != nil {
				variant["metadata"] = unified.CloneValue(video["metadata"])
			}
			result = append(result, variant)
			if videoMatched || audio.matched {
				matchedAny = true
			}
		}
	}
	return result, matchedAny, nil
}

func bilibiliDashHostTier(raw string) (int, bool) {
	host, ok := httpsDirectHost(raw)
	if !ok {
		return 0, false
	}
	switch {
	case hasSubdomain(host, ".bilivideo.com") && strings.HasPrefix(host, "upos-"):
		return 0, true
	case hasSubdomain(host, ".bilivideo.com"):
		return 1, true
	case hasSubdomain(host, ".akamaized.net"):
		return 2, true
	case hasSubdomain(host, ".bilivideo.cn"):
		return 3, true
	default:
		return 0, false
	}
}

// filterAndSortBilibiliDashURLs keeps only official Bilibili HTTPS CDN hosts,
// dropping unknown third-party PCDN domains, IP literals, non-HTTPS URLs,
// userinfo, and fragments. URLs are deduplicated and ordered by tier:
// Tier 1: upos-*.bilivideo.com -> other *.bilivideo.com -> *.akamaized.net;
// Tier 2: *.bilivideo.cn.
func filterAndSortBilibiliDashURLs(primary any, backups array) array {
	var buckets [4]array
	seen := map[string]bool{}
	add := func(candidate any) {
		raw, ok := candidate.(string)
		if !ok || raw == "" || seen[raw] {
			return
		}
		tier, allowed := bilibiliDashHostTier(raw)
		if !allowed {
			return
		}
		seen[raw] = true
		buckets[tier] = append(buckets[tier], raw)
	}
	add(primary)
	for _, b := range backups {
		add(b)
	}
	total := len(buckets[0]) + len(buckets[1]) + len(buckets[2]) + len(buckets[3])
	if total == 0 {
		return nil
	}
	out := make(array, 0, total)
	for i := range buckets {
		out = append(out, buckets[i]...)
	}
	return out
}

// dashQualityDimensions returns the unanimous upstream (width, height) reported
// by Bilibili's DASH video tracks for the same quality tier (qn) on this cid.
// Real Bilibili html5 durl responses omit width/height on durl[0]; pairing the
// same-qn DASH geometry lets unified.SelectDefault compare durl against higher
// DASH tiers and populate higher_quality_variants without guessing dimensions.
func dashQualityDimensions(play object, qn int64) (int64, int64, bool) {
	if qn <= 0 {
		return 0, 0, false
	}
	var width, height int64
	found := false
	for _, value := range unified.Slice(child(play, "dash", "video")) {
		rawVideo := unified.Map(value)
		if rawVideo == nil || intValue(rawVideo["id"]) != qn {
			continue
		}
		w, wOK := unified.Numeric(rawVideo["width"])
		h, hOK := unified.Numeric(rawVideo["height"])
		if !wOK || !hOK || w <= 0 || h <= 0 {
			continue
		}
		wi, hi := intValue(rawVideo["width"]), intValue(rawVideo["height"])
		if !found {
			width, height, found = wi, hi, true
			continue
		}
		if wi != width || hi != height {
			return 0, 0, false
		}
	}
	return width, height, found
}

func dashAudioIDRank(id int64) int {
	switch id {
	case 30280:
		return 3
	case 30232:
		return 2
	case 30216:
		return 1
	default:
		return 0
	}
}

func dashVideoCodecRank(codecFam string) int {
	switch codecFam {
	case "avc":
		return 3
	case "hevc":
		return 2
	case "av1":
		return 1
	default:
		return 0
	}
}

func dashVariantCodecKey(codecs string, codecID int64) string {
	fam := dashCodecFamily(codecs, codecID)
	var b strings.Builder
	for i := 0; i < len(fam); i++ {
		c := fam[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			b.WriteByte(c)
		}
	}
	if b.Len() > 0 {
		return b.String()
	}
	if codecID > 0 {
		return "c" + strconv.FormatInt(codecID, 10)
	}
	return "unknown"
}

func adaptDASHModern(play object, now int64, shPlay *ShanghaiPlay, hasDURL bool) (array, bool, object) {
	type dashAudioCandidate struct {
		raw       object
		resource  object
		isMP4A    bool
		idRank    int
		bandwidth int64
	}
	var bestAudio *dashAudioCandidate
	for _, value := range unified.Slice(child(play, "dash", "audio")) {
		rawAudio := unified.Map(value)
		if rawAudio == nil {
			continue
		}
		resource := dashTrack(rawAudio, "audio", now)
		if resource == nil {
			continue
		}
		fam := dashCodecFamily(unified.Str(rawAudio["codecs"]), intValue(rawAudio["codecid"]))
		cand := dashAudioCandidate{
			raw:       rawAudio,
			resource:  resource,
			isMP4A:    fam == "mp4a",
			idRank:    dashAudioIDRank(intValue(rawAudio["id"])),
			bandwidth: intValue(rawAudio["bandwidth"]),
		}
		if bestAudio == nil ||
			(cand.isMP4A != bestAudio.isMP4A && cand.isMP4A) ||
			(cand.isMP4A == bestAudio.isMP4A && (cand.idRank > bestAudio.idRank || (cand.idRank == bestAudio.idRank && cand.bandwidth > bestAudio.bandwidth))) {
			picked := cand
			bestAudio = &picked
		}
	}

	audioMatched := false
	if bestAudio != nil && shPlay != nil {
		var shURLs []string
		for _, shTrack := range shPlay.DashAudio {
			if dashTrackMatch(shTrack, bestAudio.raw) {
				shURLs = append(shURLs, shTrack.URLs...)
			}
		}
		shURLs = filterShanghaiURLsAt(shURLs, now)
		if len(shURLs) > 0 {
			delivery := unified.Map(bestAudio.resource["delivery"])
			if merged, ok := prependShanghaiSources(shURLs, unified.Slice(delivery["sources"]), now); ok {
				delivery["sources"] = merged
				audioMatched = true
			}
		}
	}

	type dashVideoKey struct {
		qn       int64
		codecKey string
	}
	type dashVideoCandidate struct {
		raw       object
		resource  object
		qn        int64
		codecKey  string
		codecRank int
		pixels    int64
		bandwidth int64
	}
	byKey := make(map[dashVideoKey]int)
	videos := make([]dashVideoCandidate, 0)
	for _, value := range unified.Slice(child(play, "dash", "video")) {
		rawVideo := unified.Map(value)
		if rawVideo == nil {
			continue
		}
		qn := intValue(rawVideo["id"])
		if qn <= 0 {
			continue
		}
		resource := dashTrack(rawVideo, "video", now)
		if resource == nil {
			continue
		}
		codecID := intValue(rawVideo["codecid"])
		codecKey := dashVariantCodecKey(unified.Str(rawVideo["codecs"]), codecID)
		w, h := intValue(rawVideo["width"]), intValue(rawVideo["height"])
		pixels := int64(0)
		if w > 0 && h > 0 {
			pixels = w * h
		}
		cand := dashVideoCandidate{
			raw:       rawVideo,
			resource:  resource,
			qn:        qn,
			codecKey:  codecKey,
			codecRank: dashVideoCodecRank(codecKey),
			pixels:    pixels,
			bandwidth: intValue(rawVideo["bandwidth"]),
		}
		key := dashVideoKey{qn: qn, codecKey: codecKey}
		if idx, exists := byKey[key]; exists {
			if cand.bandwidth > videos[idx].bandwidth {
				videos[idx] = cand
			}
			continue
		}
		byKey[key] = len(videos)
		videos = append(videos, cand)
	}

	if len(videos) == 0 {
		return nil, false, nil
	}

	sort.SliceStable(videos, func(i, j int) bool {
		a, b := videos[i], videos[j]
		if a.qn != b.qn {
			return a.qn > b.qn
		}
		if a.codecRank != b.codecRank {
			return a.codecRank > b.codecRank
		}
		if a.pixels != b.pixels {
			return a.pixels > b.pixels
		}
		if a.bandwidth != b.bandwidth {
			return a.bandwidth > b.bandwidth
		}
		return a.codecKey < b.codecKey
	})

	if bestAudio == nil {
		if hasDURL {
			return nil, false, nil
		}
		out := make(array, 0, len(videos))
		for _, v := range videos {
			id := "dash-" + strconv.FormatInt(v.qn, 10) + "-" + v.codecKey
			out = append(out, object{"id": id, "state": "deferred", "reason": object{"code": "MISSING_AUDIO_TRACK", "message": "未取得可确认的完整音视频组合，暂不可下载"}})
		}
		return out, false, nil
	}

	out := make(array, 0, len(videos))
	matchedAny := false
	audioMeta := unified.Map(bestAudio.resource["metadata"])
	for _, v := range videos {
		videoMatched := false
		if shPlay != nil {
			var shURLs []string
			for _, shTrack := range shPlay.DashVideo {
				if dashTrackMatch(shTrack, v.raw) {
					shURLs = append(shURLs, shTrack.URLs...)
				}
			}
			shURLs = filterShanghaiURLsAt(shURLs, now)
			if len(shURLs) > 0 {
				delivery := unified.Map(v.resource["delivery"])
				if merged, ok := prependShanghaiSources(shURLs, unified.Slice(delivery["sources"]), now); ok {
					delivery["sources"] = merged
					videoMatched = true
				}
			}
		}
		id := "dash-" + strconv.FormatInt(v.qn, 10) + "-" + v.codecKey
		variant := object{
			"id": id,
			"delivery": object{
				"kind":      "mux",
				"resources": array{unified.Clone(v.resource), unified.Clone(bestAudio.resource)},
				"output":    output(),
			},
			"metadata": buildMuxVariantMetadata(unified.Map(v.resource["metadata"]), audioMeta),
		}
		label := qualityLabel(v.qn)
		if label == "" {
			if h := intValue(v.raw["height"]); h > 0 {
				label = strconv.FormatInt(h, 10) + "p"
			}
		}
		if label != "" {
			variant["label"] = label
		}
		out = append(out, variant)
		if videoMatched || audioMatched {
			matchedAny = true
		}
	}
	return out, matchedAny, bestAudio.resource
}

func dashTrack(raw object, role string, now int64) object {
	sourceInputs := filterAndSortBilibiliDashURLs(pick(raw["baseUrl"], raw["base_url"], ""), unified.Slice(pick(raw["backupUrl"], raw["backup_url"])))
	sources := unified.Sources(sourceInputs, now)
	if len(sources) == 0 {
		return nil
	}
	resource := object{"id": role, "role": role, "delivery": object{"kind": "file", "sources": sources}}
	metadata := object{"evidence": "upstream"}
	if role == "video" {
		union(metadata, unified.VideoFacts(raw))
		if metadata["fps"] == nil {
			for _, field := range []string{"fps", "frameRate", "frame_rate", "video_fps"} {
				if s, ok := raw[field].(string); ok {
					if fps, ok := unified.FrameRate(strings.TrimSpace(s)); ok {
						metadata["fps"] = fps
						break
					}
				}
			}
		}
		if metadata["hdr_type"] == nil && (intValue(raw["id"]) == 125 || intValue(raw["id"]) == 126) {
			metadata["hdr_type"] = "hdr_unknown"
			if intValue(raw["id"]) == 126 {
				metadata["hdr_type"] = "dolby_vision"
			}
		}
		for _, field := range []string{"width", "height"} {
			if n, ok := unified.Numeric(raw[field]); ok && n > 0 {
				metadata[field] = intValue(raw[field])
			}
		}
		if codec, ok := unified.Text(raw["codecs"]); ok && codec != "0" {
			metadata["video_codec"] = codec
		}
		if bandwidth, ok := unified.Numeric(raw["bandwidth"]); ok && bandwidth > 0 {
			metadata["video_bitrate_bps"] = intValue(raw["bandwidth"])
		}
		delete(metadata, "has_audio")
	} else {
		union(metadata, unified.AudioFacts(raw))
		metadata["has_audio"] = true
		metadata["container"] = "m4a"
		metadata["extension"] = "m4a"
		metadata["mime_type"] = "audio/mp4"
		if codec, ok := unified.Text(raw["codecs"]); ok && codec != "0" {
			metadata["audio_codec"] = codec
		}
		if bandwidth, ok := unified.Numeric(raw["bandwidth"]); ok && bandwidth > 0 {
			metadata["audio_bitrate_bps"] = intValue(raw["bandwidth"])
		}
	}
	if len(metadata) > 1 {
		resource["metadata"] = metadata
	}
	return resource
}

func buildMuxVariantMetadata(videoMeta, audioMeta object) object {
	meta := object{
		"has_audio": true,
		"container": "mp4",
		"extension": "mp4",
		"mime_type": "video/mp4",
		"evidence":  "upstream",
	}
	for _, field := range []string{"width", "height", "fps", "hdr_type", "video_codec", "video_bitrate_bps"} {
		if v, exists := videoMeta[field]; exists && v != nil {
			meta[field] = unified.CloneValue(v)
		}
	}
	for _, field := range []string{"audio_codec", "audio_bitrate_bps", "audio_channels", "audio_language", "audio_language_role", "sample_rate_hz"} {
		if v, exists := audioMeta[field]; exists && v != nil {
			meta[field] = unified.CloneValue(v)
		}
	}
	return meta
}

func partSources(part object) array {
	return append(array{object{"url": part["url"], "size": part["size"]}}, unified.Slice(part["backup_url"])...)
}

func track(raw object, role string, now int64) object {
	sourceInputs := append(array{pick(raw["baseUrl"], raw["base_url"], "")}, unified.Slice(pick(raw["backupUrl"], raw["backup_url"]))...)
	sources := unified.Sources(sourceInputs, now)
	if len(sources) == 0 {
		return nil
	}
	resource := object{"id": role, "role": role, "delivery": object{"kind": "file", "sources": sources}}
	metadata := object{"evidence": "upstream"}
	if role == "video" {
		union(metadata, unified.VideoFacts(raw))
		if metadata["hdr_type"] == nil && (intValue(raw["id"]) == 125 || intValue(raw["id"]) == 126) {
			metadata["hdr_type"] = "hdr_unknown"
			if intValue(raw["id"]) == 126 {
				metadata["hdr_type"] = "dolby_vision"
			}
		}
		for _, field := range []string{"width", "height"} {
			if n, ok := unified.Numeric(raw[field]); ok && n > 0 {
				metadata[field] = intValue(raw[field])
			}
		}
		if codec, ok := unified.Text(raw["codecs"]); ok && codec != "0" {
			metadata["video_codec"] = codec
		}
		if bandwidth, ok := unified.Numeric(raw["bandwidth"]); ok && bandwidth > 0 {
			metadata["video_bitrate_bps"] = intValue(raw["bandwidth"])
		}
	} else {
		union(metadata, unified.AudioFacts(raw))
		if codec, ok := unified.Text(raw["codecs"]); ok && codec != "0" {
			metadata["audio_codec"] = codec
		}
		if bandwidth, ok := unified.Numeric(raw["bandwidth"]); ok && bandwidth > 0 {
			metadata["audio_bitrate_bps"] = intValue(raw["bandwidth"])
		}
	}
	if len(metadata) > 1 {
		resource["metadata"] = metadata
	}
	return resource
}

func output() object { return object{"container": "mp4", "extension": "mp4", "mime_type": "video/mp4"} }
func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:24]
}
func union(target object, values ...object) {
	for _, value := range values {
		for field, fact := range value {
			if _, exists := target[field]; !exists {
				target[field] = unified.CloneValue(fact)
			}
		}
	}
}
