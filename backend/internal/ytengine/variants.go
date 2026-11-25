package ytengine

import (
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

var (
	googlevideoEdgePattern = regexp.MustCompile(`^rr[0-9]+---sn-[a-z0-9-]+\.googlevideo\.com$`)
	instagramEdgePattern   = regexp.MustCompile(`^(?:scontent|instagram)[a-z0-9.-]*\.(?:cdninstagram\.com|fbcdn\.net)$`)
)

func boolPtr(v bool) *bool { return &v }

func resolveFormatHasAudio(acodec string) *bool {
	if isNoCodec(acodec) {
		return boolPtr(false)
	}
	if cleanCodec(acodec) != "" {
		return boolPtr(true)
	}
	return nil
}

type classifiedFormats struct {
	mp4       []Format
	dashVideo []Format
	dashAudio []Format
	hlsVideo  []Format
	hlsAudio  []Format
}

func buildEntryVariants(entry, parent *Info, entryKey, itemTitle string, opts AdaptOptions, now int64) (unified.Array, unified.Object) {
	variants, audioAttachment, _ := buildEntryVariantsWithType(entry, parent, entryKey, itemTitle, opts, now)
	return variants, audioAttachment
}

func buildEntryVariantsWithType(entry, parent *Info, entryKey, itemTitle string, opts AdaptOptions, now int64) (unified.Array, unified.Object, string) {
	if opts.SingleStreamHLSOnly {
		variants, audioAttachment := buildSingleStreamHLSVariants(entry, parent, entryKey, opts, now)
		return variants, audioAttachment, "video"
	}

	classified := classifyEntryFormats(entry, opts)
	variants := make(unified.Array, 0, len(classified.mp4)+len(classified.dashVideo)+len(classified.hlsVideo)+1)
	seenVariantIDs := make(map[string]bool)

	dedupedMP4 := deduplicateProgressiveFormats(classified.mp4)
	filteredDASHVideo := filterDASHVideoFormats(classified.dashVideo, dedupedMP4, opts)
	hasSplitSilentTracks := len(filteredDASHVideo) > 0

	// 1. High-Resolution DASH Video-Only Tracks as Directly Downloadable Files (kind == "file", has_audio == false).
	variants = appendDASHVideoVariants(variants, seenVariantIDs, filteredDASHVideo, entryKey, opts, now)

	// 2. Deliverable Progressive MP4/WebM Files with Embedded Audio (kind == "file")
	variants = appendProgressiveMP4Variants(variants, seenVariantIDs, dedupedMP4, hasSplitSilentTracks, entryKey, itemTitle, opts, now)

	// 3. Standalone Audio Tracks (both as downloadable file variants and as a background_audio attachment)
	var audioAttachment unified.Object
	if opts.EnableDASHMux && hasSplitSilentTracks && len(classified.dashAudio) > 0 {
		variants, audioAttachment = appendStandaloneAudioVariantsAndAttachment(
			variants, seenVariantIDs, classified.dashAudio, entry, parent, entryKey, itemTitle, opts, now,
		)
	}

	// 4. Non-single-file HLS variants (kind == "hls", scope == "adaptive")
	if opts.EnableHLS && len(classified.hlsVideo) > 0 {
		variants = appendAdaptiveHLSVariants(variants, seenVariantIDs, classified.hlsVideo, classified.hlsAudio, entryKey, opts, now)
	}

	// 5. Audio-only entries (e.g., SoundCloud / Bandcamp) when explicitly opted in and no video variants exist.
	if opts.AllowAudioOnly && len(variants) == 0 && len(classified.dashAudio) > 0 {
		audioVariants := appendAudioOnlyVariants(variants, seenVariantIDs, classified.dashAudio, entryKey, opts, now)
		if len(audioVariants) > 0 {
			return audioVariants, nil, "audio"
		}
	}

	return variants, audioAttachment, "video"
}

func buildSingleStreamHLSVariants(entry, parent *Info, entryKey string, opts AdaptOptions, now int64) (unified.Array, unified.Object) {
	if (entry.IsLive != nil && *entry.IsLive) || (parent != nil && parent.IsLive != nil && *parent.IsLive) {
		return nil, nil
	}
	var singleHLS []Format
	for _, f := range entry.Formats {
		cleanURL := SanitizeMediaURL(f.URL, opts.AllowedMediaURL)
		if cleanURL == "" {
			continue
		}
		f.URL = cleanURL
		if isSingleStreamCombinedMP4HLS(f) {
			singleHLS = append(singleHLS, f)
		}
	}
	sortFormats(singleHLS)
	deduped := deduplicateSingleStreamHLSFormats(singleHLS)
	variants := make(unified.Array, 0, len(deduped))
	seenVariantIDs := make(map[string]bool, len(deduped))
	for i, f := range deduped {
		formatKey := nonEmptyOr(f.FormatID, fmt.Sprintf("hls-%d", i+1))
		sources := buildFormatSourcesWithContext(f, opts, entryKey, formatKey, "", now)
		if len(sources) == 0 {
			continue
		}
		metadata := buildFormatMetadata(f, boolPtr(true), false)
		variantID := "v-" + shortDigest(opts.PlatformID+":hls-single:"+entryKey+":"+formatKey)
		if seenVariantIDs[variantID] {
			continue
		}
		seenVariantIDs[variantID] = true
		variants = append(variants, unified.Object{
			"id":       variantID,
			"label":    qualityLabel(f, ""),
			"metadata": metadata,
			"delivery": unified.Object{
				"kind":    "hls",
				"scope":   "single",
				"sources": sources,
				"output": unified.Object{
					"container": "mp4",
					"extension": "mp4",
					"mime_type": "video/mp4",
				},
			},
		})
	}
	return variants, nil
}

func shouldInheritEntryDimensions(entry *Info, opts AdaptOptions, hasAnyAudioInEntry bool) bool {
	if entry.Width == nil || entry.Height == nil || *entry.Width <= 0 || *entry.Height <= 0 {
		return false
	}
	uniqueProgressiveMP4URLs := make(map[string]bool)
	for _, f := range entry.Formats {
		cleanURL := SanitizeMediaURL(f.URL, opts.AllowedMediaURL)
		if cleanURL == "" {
			continue
		}
		fCopy := f
		fCopy.URL = cleanURL
		if isProgressiveVideoFormat(fCopy, opts) ||
			(opts.AllowCodecLessProgressiveMP4 && !hasAnyAudioInEntry && isSilentCodecLessMP4(fCopy)) {
			uniqueProgressiveMP4URLs[cleanURL] = true
		}
	}
	return len(uniqueProgressiveMP4URLs) == 1
}

func classifyEntryFormats(entry *Info, opts AdaptOptions) classifiedFormats {
	var out classifiedFormats

	// First pass: check if any audio-bearing format exists in the entry and count
	// distinct progressive MP4 URLs (so top-level dimensions are inherited only when
	// all progressive MP4 entries refer to a single stream rather than distinct SD/HD tiers).
	hasAnyAudioInEntry := false
	for _, f := range entry.Formats {
		if !isNoCodec(f.ACodec) && strings.TrimSpace(f.ACodec) != "" {
			hasAnyAudioInEntry = true
			break
		}
	}
	inheritEntryDimensions := shouldInheritEntryDimensions(entry, opts, hasAnyAudioInEntry)

	for _, f := range entry.Formats {
		cleanURL := SanitizeMediaURL(f.URL, opts.AllowedMediaURL)
		if cleanURL == "" {
			continue
		}
		f.URL = cleanURL

		if isHLSAudioOnly(f) {
			out.hlsAudio = append(out.hlsAudio, f)
			continue
		}
		if isProgressiveVideoFormat(f, opts) ||
			(opts.AllowCodecLessProgressiveMP4 && !hasAnyAudioInEntry && isSilentCodecLessMP4(f)) {
			if inheritEntryDimensions && f.Width == nil && f.Height == nil {
				w, h := *entry.Width, *entry.Height
				f.Width = &w
				f.Height = &h
			}
			out.mp4 = append(out.mp4, f)
			continue
		}
		if isHTTPDASHVideoOnly(f) {
			out.dashVideo = append(out.dashVideo, f)
			continue
		}
		if isHTTPDASHAudioOnly(f) || (opts.AllowAudioOnly && isProgressiveAudioExtensionFormat(f)) {
			out.dashAudio = append(out.dashAudio, f)
			continue
		}
		if isHLSVideo(f) {
			out.hlsVideo = append(out.hlsVideo, f)
			continue
		}
	}

	sortFormats(out.mp4)
	sortDASHVideoFormats(out.dashVideo)
	sortAudioFormats(out.dashAudio)
	sortFormats(out.hlsVideo)
	sortAudioFormats(out.hlsAudio)
	return out
}

func filterDASHVideoFormats(dashVideoFormats, dedupedMP4 []Format, opts AdaptOptions) []Format {
	if !opts.EnableDASHMux || len(dashVideoFormats) == 0 {
		return nil
	}
	var maxMP4Edge int64
	var maxMP4FPS float64
	if len(dedupedMP4) > 0 {
		maxMP4Edge = shortEdge(dedupedMP4[0])
		maxMP4FPS = derefFloat(dedupedMP4[0].FPS)
	}
	dedupedDASH := deduplicateDASHVideoFormats(dashVideoFormats)
	filtered := make([]Format, 0, len(dedupedDASH))
	for _, vf := range dedupedDASH {
		if maxMP4Edge > 0 {
			edge := shortEdge(vf)
			fps := derefFloat(vf.FPS)
			higherFPS := edge == maxMP4Edge && fps > maxMP4FPS+5 && fps >= 50
			if edge <= maxMP4Edge && !higherFPS {
				continue
			}
		}
		filtered = append(filtered, vf)
	}
	return filtered
}

func appendDASHVideoVariants(
	variants unified.Array,
	seenVariantIDs map[string]bool,
	filteredDASHVideo []Format,
	entryKey string,
	opts AdaptOptions,
	now int64,
) unified.Array {
	for i, vf := range filteredDASHVideo {
		videoKey := nonEmptyOr(vf.FormatID, fmt.Sprintf("dashv-%d", i+1))
		sources := buildFormatSourcesWithContext(vf, opts, entryKey, videoKey, "", now)
		if len(sources) == 0 {
			continue
		}
		metadata := buildFormatMetadata(vf, boolPtr(false), true)
		variantID := "v-" + shortDigest(opts.PlatformID+":dashv-file:"+entryKey+":"+videoKey)
		if seenVariantIDs[variantID] {
			continue
		}
		seenVariantIDs[variantID] = true

		variants = append(variants, unified.Object{
			"id":       variantID,
			"label":    qualityLabel(vf, formatSilentVideoSuffix(vf)),
			"metadata": metadata,
			"delivery": unified.Object{
				"kind":    "file",
				"sources": sources,
			},
		})
	}
	return variants
}

func appendProgressiveMP4Variants(
	variants unified.Array,
	seenVariantIDs map[string]bool,
	dedupedMP4 []Format,
	hasSplitSilentTracks bool,
	entryKey, itemTitle string,
	opts AdaptOptions,
	now int64,
) unified.Array {
	for i, f := range dedupedMP4 {
		fallbackExt := "mp4"
		if strings.EqualFold(strings.TrimSpace(f.Ext), "webm") {
			fallbackExt = "webm"
		}
		formatKey := nonEmptyOr(f.FormatID, fmt.Sprintf("%s-%d", fallbackExt, i+1))
		hasAudio := resolveFormatHasAudio(f.ACodec)
		titleForAttachment := ""
		if hasAudio != nil && *hasAudio {
			titleForAttachment = itemTitle
			if opts.PlatformID == "youtube" && titleForAttachment != "" && shortEdge(f) > 0 {
				titleForAttachment = fmt.Sprintf("%s_%dp", titleForAttachment, shortEdge(f))
			}
		}
		sources := buildFormatSourcesWithContext(f, opts, entryKey, formatKey, titleForAttachment, now)
		if len(sources) == 0 {
			continue
		}
		metadata := buildFormatMetadata(f, hasAudio, true)
		variantPrefix := "v-"
		if f.Width == nil || f.Height == nil {
			switch formatIDQualityRank(f.FormatID) {
			case 2:
				variantPrefix = "v-hd-"
			case 1:
				variantPrefix = "v-sd-"
			}
		}
		variantID := variantPrefix + shortDigest(opts.PlatformID+":file:"+entryKey+":"+formatKey)
		if seenVariantIDs[variantID] {
			continue
		}
		seenVariantIDs[variantID] = true

		suffix := ""
		if hasSplitSilentTracks && hasAudio != nil && *hasAudio {
			suffix = "含音频"
		}
		variant := unified.Object{
			"id":       variantID,
			"metadata": metadata,
			"delivery": unified.Object{
				"kind":    "file",
				"sources": sources,
			},
		}
		if label := qualityLabel(f, suffix); label != "" {
			variant["label"] = label
		}
		variants = append(variants, variant)
	}
	return variants
}

func appendStandaloneAudioVariantsAndAttachment(
	variants unified.Array,
	seenVariantIDs map[string]bool,
	dashAudioFormats []Format,
	entry, parent *Info,
	entryKey, itemTitle string,
	opts AdaptOptions,
	now int64,
) (unified.Array, unified.Object) {
	seenAudioContainer := make(map[string]bool, 2)
	for _, candAudio := range dashAudioFormats {
		audioMeta := buildAudioFileMetadata(candAudio)
		audioContainer := unified.Str(audioMeta["container"])
		if audioContainer == "" {
			audioContainer = "mp4"
		}
		if seenAudioContainer[audioContainer] {
			continue
		}
		candKey := nonEmptyOr(candAudio.FormatID, "audio-"+audioContainer)
		audioSources := buildFormatSourcesWithContext(candAudio, opts, entryKey, candKey, "", now)
		if len(audioSources) == 0 {
			continue
		}
		audioVariantID := "v-" + shortDigest(opts.PlatformID+":dasha-file:"+entryKey+":"+candKey)
		if seenVariantIDs[audioVariantID] {
			continue
		}
		seenAudioContainer[audioContainer] = true
		seenVariantIDs[audioVariantID] = true
		variants = append(variants, unified.Object{
			"id":       audioVariantID,
			"label":    formatAudioVariantLabel(candAudio),
			"metadata": audioMeta,
			"delivery": unified.Object{
				"kind":    "file",
				"sources": audioSources,
			},
		})
	}

	var audioAttachment unified.Object
	bestAudio := dashAudioFormats[0]
	audioKey := nonEmptyOr(bestAudio.FormatID, "audio")
	if audioResource := buildMuxTrackResourceWithContext(bestAudio, "audio", opts, entryKey, audioKey, "", now); audioResource != nil {
		attID := "att-" + shortDigest(opts.PlatformID+":att-audio:"+opts.ContentID+":"+entryKey)
		attTitle := formatAudioAttachmentTitle(itemTitle, bestAudio)
		audioAttachment = unified.Object{
			"id":       attID,
			"role":     "background_audio",
			"title":    attTitle,
			"resource": audioResource,
		}
		if author := buildAuthorObject(parent); author != nil {
			audioAttachment["author"] = author
		}
		if cover := pickSingleCover(entry, opts.AllowedMediaURL, now); cover != nil {
			audioAttachment["cover"] = cover
		} else if cover := pickSingleCover(parent, opts.AllowedMediaURL, now); cover != nil {
			audioAttachment["cover"] = cover
		}
	}
	return variants, audioAttachment
}

func appendAudioOnlyVariants(
	variants unified.Array,
	seenVariantIDs map[string]bool,
	dashAudioFormats []Format,
	entryKey string,
	opts AdaptOptions,
	now int64,
) unified.Array {
	seenURL := make(map[string]bool, len(dashAudioFormats))
	seenContainerBitrate := make(map[string]bool, len(dashAudioFormats))
	for i, candAudio := range dashAudioFormats {
		if seenURL[candAudio.URL] {
			continue
		}
		container, extension, mimeType, ok := resolveAudioFileFormatWithCodecFallback(candAudio)
		if !ok {
			continue
		}
		abrKbps := int64(math.Round(derefFloat(pickBitrateKbps(candAudio.ABR, candAudio.TBR))))
		dedupKey := fmt.Sprintf("%s:%d", container, abrKbps)
		if seenContainerBitrate[dedupKey] {
			continue
		}
		candKey := nonEmptyOr(candAudio.FormatID, fmt.Sprintf("audio-%s-%d", extension, i+1))
		audioSources := buildFormatSourcesWithContext(candAudio, opts, entryKey, candKey, "", now)
		if len(audioSources) == 0 {
			continue
		}
		audioVariantID := "v-" + shortDigest(opts.PlatformID+":audio-file:"+entryKey+":"+candKey)
		if seenVariantIDs[audioVariantID] {
			continue
		}
		seenURL[candAudio.URL] = true
		seenContainerBitrate[dedupKey] = true
		seenVariantIDs[audioVariantID] = true
		audioMeta := buildAudioFileMetadataWithFormat(candAudio, container, extension, mimeType)
		variants = append(variants, unified.Object{
			"id":       audioVariantID,
			"label":    formatAudioVariantLabelWithExt(candAudio, extension),
			"metadata": audioMeta,
			"delivery": unified.Object{
				"kind":    "file",
				"sources": audioSources,
			},
		})
	}
	return variants
}

func appendAdaptiveHLSVariants(
	variants unified.Array,
	seenVariantIDs map[string]bool,
	hlsVideoFormats, hlsAudioFormats []Format,
	entryKey string,
	opts AdaptOptions,
	now int64,
) unified.Array {
	var bestHLSAudio *Format
	if len(hlsAudioFormats) > 0 {
		bestHLSAudio = &hlsAudioFormats[0]
	}
	dedupedHLS := deduplicateProgressiveFormats(hlsVideoFormats)
	for i, f := range dedupedHLS {
		formatKey := nonEmptyOr(f.FormatID, fmt.Sprintf("hls-%d", i+1))
		sources := buildFormatSourcesWithContext(f, opts, entryKey, formatKey, "", now)
		if len(sources) == 0 {
			continue
		}
		hasEmbeddedAudio := !isNoCodec(f.ACodec) && strings.TrimSpace(f.ACodec) != ""
		metadata := buildFormatMetadata(f, boolPtr(hasEmbeddedAudio), false)
		variantID := "v-" + shortDigest(opts.PlatformID+":hls:"+entryKey+":"+formatKey)
		if seenVariantIDs[variantID] {
			continue
		}
		seenVariantIDs[variantID] = true

		selection := unified.Object{
			"video_representation_id": formatKey,
		}
		if !hasEmbeddedAudio && bestHLSAudio != nil && strings.TrimSpace(bestHLSAudio.FormatID) != "" {
			selection["audio_representation_id"] = strings.TrimSpace(bestHLSAudio.FormatID)
		}
		variants = append(variants, unified.Object{
			"id":       variantID,
			"label":    qualityLabel(f, "HLS 需合流"),
			"metadata": metadata,
			"delivery": unified.Object{
				"kind":      "hls",
				"scope":     "adaptive",
				"selection": selection,
				"sources":   sources,
				"output": unified.Object{
					"container": "mp4",
					"extension": "mp4",
					"mime_type": "video/mp4",
				},
			},
		})
	}
	return variants
}

func buildMuxTrackResourceWithContext(f Format, role string, opts AdaptOptions, entryKey, formatKey, itemTitle string, now int64) unified.Object {
	sources := buildFormatSourcesWithContext(f, opts, entryKey, formatKey, itemTitle, now)
	if len(sources) == 0 {
		return nil
	}
	metadata := unified.Object{
		"evidence": "upstream",
	}
	if role == "video" {
		metadata["has_audio"] = false
		if f.Width != nil && *f.Width > 0 && f.Height != nil && *f.Height > 0 {
			metadata["width"] = *f.Width
			metadata["height"] = *f.Height
		}
		if f.FPS != nil && *f.FPS > 0 && !math.IsNaN(*f.FPS) && !math.IsInf(*f.FPS, 0) {
			metadata["fps"] = normalizeFPS(*f.FPS)
		}
		if hdr := mapDynamicRange(f.DynamicRange); hdr != "" {
			metadata["hdr_type"] = hdr
		}
		if vc := cleanCodec(f.VCodec); vc != "" {
			metadata["video_codec"] = vc
		}
		if vbr := kbpsToBps(pickBitrateKbps(f.VBR, f.TBR)); vbr > 0 {
			metadata["video_bitrate_bps"] = vbr
		}
	} else {
		metadata["has_audio"] = true
		if ac := cleanCodec(f.ACodec); ac != "" {
			metadata["audio_codec"] = ac
		}
		if abr := kbpsToBps(pickBitrateKbps(f.ABR, f.TBR)); abr > 0 {
			metadata["audio_bitrate_bps"] = abr
		}
		if f.ASR != nil && *f.ASR > 0 {
			metadata["sample_rate_hz"] = *f.ASR
		}
		if f.AudioChannels != nil && *f.AudioChannels > 0 {
			metadata["audio_channels"] = *f.AudioChannels
		}
	}
	return unified.Object{
		"id":       role,
		"role":     role,
		"metadata": metadata,
		"delivery": unified.Object{
			"kind":    "file",
			"sources": sources,
		},
	}
}

func formatSilentVideoSuffix(vf Format) string {
	var parts []string
	if shortEdge(vf) >= 4320 || longEdge(vf) >= 7680 {
		parts = append(parts, "8K")
	} else if shortEdge(vf) >= 2160 || longEdge(vf) >= 3840 {
		parts = append(parts, "4K")
	} else if shortEdge(vf) >= 1440 || longEdge(vf) >= 2560 {
		parts = append(parts, "2K")
	}
	if hdr := mapDynamicRange(vf.DynamicRange); hdr != "" && hdr != "sdr" {
		parts = append(parts, "HDR")
	}
	parts = append(parts, "仅视频无声")
	return strings.Join(parts, " · ")
}

func formatAudioVariantLabel(af Format) string {
	return formatAudioVariantLabelWithExt(af, "")
}

func formatAudioVariantLabelWithExt(af Format, fallbackExt string) string {
	ext := strings.ToUpper(strings.TrimSpace(af.Ext))
	if ext == "" {
		ext = strings.ToUpper(strings.TrimSpace(fallbackExt))
	}
	if ext == "" || ext == "MP4" {
		ext = "M4A"
	}
	if abr := derefFloat(pickBitrateKbps(af.ABR, af.TBR)); abr > 0 {
		return fmt.Sprintf("仅音频 %s (%.0f kbps)", ext, math.Round(abr))
	}
	return "仅音频 " + ext
}

func formatAudioAttachmentTitle(itemTitle string, af Format) string {
	base := strings.TrimSpace(itemTitle)
	if base == "" {
		base = "原声轨"
	}
	ext := strings.ToUpper(strings.TrimSpace(af.Ext))
	if ext == "" || ext == "MP4" {
		ext = "M4A"
	}
	if abr := derefFloat(pickBitrateKbps(af.ABR, af.TBR)); abr > 0 {
		return fmt.Sprintf("%s (%s · %.0f kbps)", base, ext, math.Round(abr))
	}
	return fmt.Sprintf("%s (%s)", base, ext)
}

func resolveAudioFileFormat(af Format) (container, extension, mimeType string, ok bool) {
	switch strings.ToLower(strings.TrimSpace(af.Ext)) {
	case "mp3":
		return "mp3", "mp3", "audio/mpeg", true
	case "m4a", "mp4":
		return "mp4", "m4a", "audio/mp4", true
	case "webm":
		return "webm", "webm", "audio/webm", true
	case "ogg":
		return "ogg", "ogg", "audio/ogg", true
	case "opus":
		return "ogg", "opus", "audio/ogg", true
	case "flac":
		return "flac", "flac", "audio/flac", true
	case "wav":
		return "wav", "wav", "audio/wav", true
	default:
		return "", "", "", false
	}
}

func resolveAudioFileFormatWithCodecFallback(af Format) (container, extension, mimeType string, ok bool) {
	if c, e, m, matched := resolveAudioFileFormat(af); matched {
		return c, e, m, true
	}
	if strings.TrimSpace(af.Ext) != "" {
		return "", "", "", false
	}
	ac := strings.ToLower(cleanCodec(af.ACodec))
	switch {
	case strings.HasPrefix(ac, "mp3"):
		return "mp3", "mp3", "audio/mpeg", true
	case strings.HasPrefix(ac, "mp4a") || strings.HasPrefix(ac, "aac"):
		return "mp4", "m4a", "audio/mp4", true
	case strings.HasPrefix(ac, "opus"):
		return "ogg", "opus", "audio/ogg", true
	case strings.HasPrefix(ac, "vorbis"):
		return "ogg", "ogg", "audio/ogg", true
	case strings.HasPrefix(ac, "flac"):
		return "flac", "flac", "audio/flac", true
	case strings.HasPrefix(ac, "pcm") || strings.HasPrefix(ac, "wav"):
		return "wav", "wav", "audio/wav", true
	default:
		return "", "", "", false
	}
}

func buildAudioFileMetadata(af Format) unified.Object {
	container, extension, mimeType, ok := resolveAudioFileFormat(af)
	if !ok {
		container = "mp4"
		extension = "m4a"
		mimeType = "audio/mp4"
	}
	return buildAudioFileMetadataWithFormat(af, container, extension, mimeType)
}

func buildAudioFileMetadataWithFormat(af Format, container, extension, mimeType string) unified.Object {
	meta := unified.Object{
		"has_audio": true,
		"evidence":  "upstream",
		"container": container,
		"extension": extension,
		"mime_type": mimeType,
	}
	if acodec := cleanCodec(af.ACodec); acodec != "" {
		meta["audio_codec"] = acodec
	}
	if abr := kbpsToBps(pickBitrateKbps(af.ABR, af.TBR)); abr > 0 {
		meta["audio_bitrate_bps"] = abr
	}
	if af.ASR != nil && *af.ASR > 0 {
		meta["sample_rate_hz"] = *af.ASR
	}
	if af.AudioChannels != nil && *af.AudioChannels > 0 {
		meta["audio_channels"] = *af.AudioChannels
	}
	return meta
}

func buildFormatSourcesWithContext(f Format, opts AdaptOptions, entryKey, formatKey, itemTitle string, now int64) unified.Array {
	rawSource := unified.Object{
		"url": decorateYouTubeSourceURL(f.URL, itemTitle),
	}
	urlClen := extractURLClen(f.URL)
	var sizeConflict int64
	if f.Filesize != nil && *f.Filesize > 0 && *f.Filesize <= maxSafeInteger {
		if urlClen > 0 && *f.Filesize != urlClen {
			sizeConflict = *f.Filesize
		} else {
			rawSource["size_bytes"] = *f.Filesize
		}
	}
	if id := buildYTSourceIdentity(f, opts.PlatformID, opts.ContentID, entryKey, formatKey, sizeConflict); id != "" {
		rawSource["private_source_identity"] = id
	}
	return unified.Sources(unified.Array{rawSource}, now)
}

func extractURLClen(rawURL string) int64 {
	u, err := url.Parse(rawURL)
	if err != nil || u.RawQuery == "" {
		return 0
	}
	clenStr := strings.TrimSpace(u.Query().Get("clen"))
	if clenStr == "" {
		return 0
	}
	n, ok := parsePositiveContentLength(clenStr)
	if !ok {
		return 0
	}
	return n
}

func buildYTSourceIdentity(f Format, platformID, contentID, entryKey, formatKey string, sizeConflict int64) string {
	if platformID == "" || contentID == "" || entryKey == "" || f.URL == "" {
		return ""
	}
	canonicalURL := canonicalRenewalURLIdentity(f.URL)
	if canonicalURL == "" {
		return ""
	}
	identity := unified.Array{
		"ytengine-source",
		platformID,
		contentID,
		entryKey,
		formatKey,
		strings.ToLower(strings.TrimSpace(f.Ext)),
		cleanCodec(f.VCodec),
		cleanCodec(f.ACodec),
		derefInt(f.Width),
		derefInt(f.Height),
		canonicalURL,
	}
	if sizeConflict > 0 {
		identity = append(identity, sizeConflict)
	}
	return unified.PHPIdentityJSON(identity, true)
}

func canonicalRenewalURLIdentity(rawURL string) string {
	stripped := unified.SourceIdentity(rawURL)
	u, err := url.Parse(stripped)
	if err != nil {
		return stripped
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	switch {
	case googlevideoEdgePattern.MatchString(host):
		host = "googlevideo.com"
	case instagramEdgePattern.MatchString(host):
		if strings.HasSuffix(host, ".cdninstagram.com") {
			host = "cdninstagram.com"
		} else if strings.HasSuffix(host, ".fbcdn.net") {
			host = "fbcdn.net"
		}
	}
	base := strings.ToLower(u.Scheme) + "://" + host + u.EscapedPath()
	if u.RawQuery == "" {
		return base
	}
	parts := strings.Split(u.RawQuery, "&")
	filtered := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			filtered = append(filtered, p)
		}
	}
	sort.Strings(filtered)
	if len(filtered) == 0 {
		return base
	}
	return base + "?" + strings.Join(filtered, "&")
}

func decorateYouTubeSourceURL(rawURL, itemTitle string) string {
	if strings.TrimSpace(itemTitle) == "" {
		return rawURL
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.RawQuery == "" {
		return rawURL
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host != "googlevideo.com" && !strings.HasSuffix(host, ".googlevideo.com") {
		return rawURL
	}
	q := u.Query()
	if q.Get("title") != "" {
		return rawURL
	}
	for _, param := range strings.Split(q.Get("sparams"), ",") {
		if strings.EqualFold(strings.TrimSpace(param), "title") {
			return rawURL
		}
	}
	cleanTitle := sanitizeDownloadTitle(itemTitle)
	if cleanTitle == "" {
		return rawURL
	}
	return rawURL + "&title=" + url.QueryEscape(cleanTitle)
}

func sanitizeDownloadTitle(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	var b strings.Builder
	lastUnderscore := false
	count := 0
	for _, r := range trimmed {
		if count >= 80 {
			break
		}
		switch {
		case r < 0x20 || r == 0x7f,
			r == '/', r == '\\', r == ':', r == '*', r == '?', r == '"', r == '<', r == '>', r == '|':
			if !lastUnderscore && b.Len() > 0 {
				b.WriteByte('_')
				lastUnderscore = true
				count++
			}
		case r == ' ' || r == '\t':
			if !lastUnderscore && b.Len() > 0 {
				b.WriteByte('_')
				lastUnderscore = true
				count++
			}
		default:
			b.WriteRune(r)
			lastUnderscore = false
			count++
		}
	}
	return strings.Trim(b.String(), "_.")
}

func buildFormatMetadata(f Format, hasAudio *bool, isFile bool) unified.Object {
	meta := unified.Object{
		"evidence": "upstream",
	}
	if hasAudio != nil {
		meta["has_audio"] = *hasAudio
	}
	if isFile {
		ext := strings.ToLower(strings.TrimSpace(f.Ext))
		switch ext {
		case "", "mp4":
			meta["container"] = "mp4"
			meta["extension"] = "mp4"
			meta["mime_type"] = "video/mp4"
		case "webm":
			meta["container"] = "webm"
			meta["extension"] = "webm"
			meta["mime_type"] = "video/webm"
		}
	}
	if f.Width != nil && *f.Width > 0 && f.Height != nil && *f.Height > 0 {
		meta["width"] = *f.Width
		meta["height"] = *f.Height
	}
	if f.FPS != nil && *f.FPS > 0 && !math.IsNaN(*f.FPS) && !math.IsInf(*f.FPS, 0) {
		meta["fps"] = normalizeFPS(*f.FPS)
	}
	if hdr := mapDynamicRange(f.DynamicRange); hdr != "" {
		meta["hdr_type"] = hdr
	}
	if vcodec := cleanCodec(f.VCodec); vcodec != "" {
		meta["video_codec"] = vcodec
	}
	if vbr := kbpsToBps(pickBitrateKbps(f.VBR, f.TBR)); vbr > 0 {
		meta["video_bitrate_bps"] = vbr
	}
	if hasAudio != nil && *hasAudio {
		if acodec := cleanCodec(f.ACodec); acodec != "" {
			meta["audio_codec"] = acodec
		}
		if abr := kbpsToBps(f.ABR); abr > 0 {
			meta["audio_bitrate_bps"] = abr
		}
		if f.ASR != nil && *f.ASR > 0 {
			meta["sample_rate_hz"] = *f.ASR
		}
		if f.AudioChannels != nil && *f.AudioChannels > 0 {
			meta["audio_channels"] = *f.AudioChannels
		}
	}
	return meta
}

func isProgressiveMP4Format(f Format, allowCodecLess bool) bool {
	proto := strings.ToLower(strings.TrimSpace(f.Protocol))
	if proto != "https" && proto != "http" {
		return false
	}
	ext := strings.ToLower(strings.TrimSpace(f.Ext))
	if ext != "mp4" {
		return false
	}
	u, err := url.Parse(f.URL)
	if err != nil {
		return false
	}
	urlPath := strings.ToLower(u.Path)
	if strings.HasSuffix(urlPath, ".m3u8") || strings.HasSuffix(urlPath, ".mpd") {
		return false
	}
	if isNoCodec(f.VCodec) || isNoCodec(f.ACodec) {
		return false
	}
	vc := strings.TrimSpace(f.VCodec)
	ac := strings.TrimSpace(f.ACodec)
	if vc == "" && ac == "" {
		if !allowCodecLess {
			return false
		}
		fid := strings.ToLower(strings.TrimSpace(f.FormatID))
		note := strings.ToLower(strings.TrimSpace(f.FormatNote))
		if strings.HasPrefix(fid, "dash") || strings.Contains(note, "dash") {
			return false
		}
	}
	return true
}

func isProgressiveWebMFormat(f Format) bool {
	proto := strings.ToLower(strings.TrimSpace(f.Protocol))
	if proto != "https" && proto != "http" {
		return false
	}
	if strings.ToLower(strings.TrimSpace(f.Ext)) != "webm" {
		return false
	}
	u, err := url.Parse(f.URL)
	if err != nil {
		return false
	}
	urlPath := strings.ToLower(u.Path)
	if strings.HasSuffix(urlPath, ".m3u8") || strings.HasSuffix(urlPath, ".mpd") {
		return false
	}
	return cleanCodec(f.VCodec) != "" && cleanCodec(f.ACodec) != ""
}

func isProgressiveVideoFormat(f Format, opts AdaptOptions) bool {
	return isProgressiveMP4Format(f, opts.AllowCodecLessProgressiveMP4) ||
		(opts.AllowProgressiveWebM && isProgressiveWebMFormat(f))
}

func isProgressiveAudioExtensionFormat(f Format) bool {
	proto := strings.ToLower(strings.TrimSpace(f.Protocol))
	if proto != "https" && proto != "http" {
		return false
	}
	u, err := url.Parse(f.URL)
	if err != nil {
		return false
	}
	urlPath := strings.ToLower(u.Path)
	if strings.HasSuffix(urlPath, ".m3u8") || strings.HasSuffix(urlPath, ".mpd") {
		return false
	}
	if strings.TrimSpace(f.VCodec) != "" && !isNoCodec(f.VCodec) {
		return false
	}
	if isNoCodec(f.ACodec) {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(f.Ext)) {
	case "mp3", "m4a", "ogg", "opus", "flac", "wav":
		return true
	default:
		return false
	}
}

func isSilentCodecLessMP4(f Format) bool {
	proto := strings.ToLower(strings.TrimSpace(f.Protocol))
	if proto != "https" && proto != "http" {
		return false
	}
	if strings.ToLower(strings.TrimSpace(f.Ext)) != "mp4" {
		return false
	}
	fid := strings.ToLower(strings.TrimSpace(f.FormatID))
	note := strings.ToLower(strings.TrimSpace(f.FormatNote))
	if strings.HasPrefix(fid, "dash") || strings.Contains(note, "dash") {
		return false
	}
	return strings.TrimSpace(f.VCodec) == "" && isNoCodec(f.ACodec)
}

func isHTTPDASHVideoOnly(f Format) bool {
	proto := strings.ToLower(strings.TrimSpace(f.Protocol))
	if proto != "https" && proto != "http" {
		return false
	}
	u, err := url.Parse(f.URL)
	if err != nil {
		return false
	}
	urlPath := strings.ToLower(u.Path)
	if strings.HasSuffix(urlPath, ".m3u8") || strings.HasSuffix(urlPath, ".mpd") {
		return false
	}
	return !isNoCodec(f.VCodec) && strings.TrimSpace(f.VCodec) != "" && isNoCodec(f.ACodec)
}

func isHTTPDASHAudioOnly(f Format) bool {
	proto := strings.ToLower(strings.TrimSpace(f.Protocol))
	if proto != "https" && proto != "http" {
		return false
	}
	u, err := url.Parse(f.URL)
	if err != nil {
		return false
	}
	urlPath := strings.ToLower(u.Path)
	if strings.HasSuffix(urlPath, ".m3u8") || strings.HasSuffix(urlPath, ".mpd") {
		return false
	}
	return isNoCodec(f.VCodec) && !isNoCodec(f.ACodec) && strings.TrimSpace(f.ACodec) != ""
}

func isNoCodec(codec string) bool {
	c := strings.ToLower(strings.TrimSpace(codec))
	return c == "none"
}

func cleanCodec(codec string) string {
	c := strings.TrimSpace(codec)
	if c == "" || strings.EqualFold(c, "none") || strings.EqualFold(c, "unknown") {
		return ""
	}
	return c
}

func formatIDQualityRank(raw string) int {
	id := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case id == "hd" || strings.HasSuffix(id, "_hd") || strings.HasSuffix(id, "-hd"):
		return 2
	case id == "sd" || strings.HasSuffix(id, "_sd") || strings.HasSuffix(id, "-sd"):
		return 1
	default:
		return 0
	}
}

func formatIDQualityLabel(raw string) string {
	switch formatIDQualityRank(raw) {
	case 2:
		return "HD"
	case 1:
		return "SD"
	default:
		return ""
	}
}

func sortFormats(formats []Format) {
	sort.SliceStable(formats, func(i, j int) bool {
		a, b := formats[i], formats[j]
		sa, sb := shortEdge(a), shortEdge(b)
		if sa != sb {
			return sa > sb
		}
		la, lb := longEdge(a), longEdge(b)
		if la != lb {
			return la > lb
		}
		fa, fb := derefFloat(a.FPS), derefFloat(b.FPS)
		if math.Abs(fa-fb) > 0.5 {
			return fa > fb
		}
		ta, tb := derefFloat(a.TBR), derefFloat(b.TBR)
		if ta != tb {
			return ta > tb
		}
		if a.Quality != nil && b.Quality != nil && *a.Quality != *b.Quality {
			return *a.Quality > *b.Quality
		}
		qa, qb := formatIDQualityRank(a.FormatID), formatIDQualityRank(b.FormatID)
		if qa != qb {
			return qa > qb
		}
		return a.FormatID > b.FormatID
	})
}

func sortDASHVideoFormats(formats []Format) {
	sort.SliceStable(formats, func(i, j int) bool {
		a, b := formats[i], formats[j]
		sa, sb := shortEdge(a), shortEdge(b)
		if sa != sb {
			return sa > sb
		}
		la, lb := longEdge(a), longEdge(b)
		if la != lb {
			return la > lb
		}
		fa, fb := math.Round(derefFloat(a.FPS)), math.Round(derefFloat(b.FPS))
		if fa != fb {
			return fa > fb
		}
		// Prefer MP4 container over WebM at identical resolution and framerate
		aMP4 := strings.EqualFold(a.Ext, "mp4")
		bMP4 := strings.EqualFold(b.Ext, "mp4")
		if aMP4 != bMP4 {
			return aMP4
		}
		// Prefer H.264 (avc1) over AV1 over VP9 for broadest playback compatibility
		ca, cb := dashCodecRank(a.VCodec), dashCodecRank(b.VCodec)
		if ca != cb {
			return ca > cb
		}
		ta, tb := derefFloat(pickBitrateKbps(a.VBR, a.TBR)), derefFloat(pickBitrateKbps(b.VBR, b.TBR))
		if ta != tb {
			return ta > tb
		}
		return a.FormatID > b.FormatID
	})
}

func dashCodecRank(vcodec string) int {
	vc := strings.ToLower(strings.TrimSpace(vcodec))
	switch {
	case strings.HasPrefix(vc, "avc1") || strings.HasPrefix(vc, "h264"):
		return 3
	case strings.HasPrefix(vc, "av01") || strings.HasPrefix(vc, "av1"):
		return 2
	case strings.HasPrefix(vc, "vp9") || strings.HasPrefix(vc, "vp09"):
		return 1
	default:
		return 0
	}
}

func derefLangPref(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func baseFormatID(raw string) string {
	base, _, _ := strings.Cut(raw, "-dup")
	return base
}

func sortAudioFormats(formats []Format) {
	sort.SliceStable(formats, func(i, j int) bool {
		a, b := formats[i], formats[j]
		// Prefer original / default audio tracks over dubbed or descriptive tracks.
		lpa, lpb := derefLangPref(a.LanguagePreference), derefLangPref(b.LanguagePreference)
		if lpa != lpb {
			return lpa > lpb
		}
		// Prefer MP4/M4A AAC audio for universal playback compatibility
		aM4A := strings.EqualFold(a.Ext, "m4a") || strings.EqualFold(a.Ext, "mp4")
		bM4A := strings.EqualFold(b.Ext, "m4a") || strings.EqualFold(b.Ext, "mp4")
		if aM4A != bM4A {
			return aM4A
		}
		aAAC := strings.HasPrefix(strings.ToLower(strings.TrimSpace(a.ACodec)), "mp4a")
		bAAC := strings.HasPrefix(strings.ToLower(strings.TrimSpace(b.ACodec)), "mp4a")
		if aAAC != bAAC {
			return aAAC
		}
		aOpus := strings.HasPrefix(strings.ToLower(strings.TrimSpace(a.ACodec)), "opus")
		bOpus := strings.HasPrefix(strings.ToLower(strings.TrimSpace(b.ACodec)), "opus")
		if aOpus != bOpus {
			return aOpus
		}
		// Prefer standard stereo (<= 2ch) over 5.1 surround (6ch) for browser <audio> support
		aStereo := derefInt(a.AudioChannels) == 0 || derefInt(a.AudioChannels) <= 2
		bStereo := derefInt(b.AudioChannels) == 0 || derefInt(b.AudioChannels) <= 2
		if aStereo != bStereo {
			return aStereo
		}
		// Avoid DRC variants if standard track exists
		aDRC := strings.Contains(strings.ToLower(a.FormatID), "drc")
		bDRC := strings.Contains(strings.ToLower(b.FormatID), "drc")
		if aDRC != bDRC {
			return !aDRC
		}
		aa, ab := derefFloat(pickBitrateKbps(a.ABR, a.TBR)), derefFloat(pickBitrateKbps(b.ABR, b.TBR))
		if aa != ab {
			return aa > ab
		}
		return baseFormatID(a.FormatID) > baseFormatID(b.FormatID)
	})
}

func deduplicateProgressiveFormats(formats []Format) []Format {
	out := make([]Format, 0, len(formats))
	seenRes := make(map[string]bool)
	seenURL := make(map[string]bool)
	for _, f := range formats {
		if seenURL[f.URL] {
			continue
		}
		seenURL[f.URL] = true
		w, h := derefInt(f.Width), derefInt(f.Height)
		if w > 0 && h > 0 {
			key := strconv.FormatInt(w, 10) + "x" + strconv.FormatInt(h, 10)
			if seenRes[key] {
				continue
			}
			seenRes[key] = true
		}
		out = append(out, f)
	}
	return out
}

func deduplicateDASHVideoFormats(formats []Format) []Format {
	out := make([]Format, 0, len(formats))
	seenTier := make(map[string]bool)
	seenURL := make(map[string]bool)
	for _, f := range formats {
		if seenURL[f.URL] {
			continue
		}
		seenURL[f.URL] = true
		w, h := derefInt(f.Width), derefInt(f.Height)
		hdr := mapDynamicRange(f.DynamicRange)
		if w > 0 && h > 0 {
			key := fmt.Sprintf("%dx%d:%s", w, h, hdr)
			if seenTier[key] {
				continue
			}
			seenTier[key] = true
		}
		out = append(out, f)
	}
	return out
}

func shortEdge(f Format) int64 {
	w, h := derefInt(f.Width), derefInt(f.Height)
	if w > 0 && h > 0 {
		if w < h {
			return w
		}
		return h
	}
	if h > 0 {
		return h
	}
	return w
}

func longEdge(f Format) int64 {
	w, h := derefInt(f.Width), derefInt(f.Height)
	if w > h {
		return w
	}
	return h
}

func qualityLabel(f Format, suffix string) string {
	edge := shortEdge(f)
	base := ""
	if edge > 0 {
		base = strconv.FormatInt(edge, 10) + "p"
		if fps := math.Round(derefFloat(f.FPS)); fps >= 50 {
			base += strconv.FormatInt(int64(fps), 10)
		}
	} else if u, err := url.Parse(f.URL); err == nil {
		for _, seg := range strings.Split(u.Path, "/") {
			if parts := strings.Split(seg, "x"); len(parts) == 2 {
				w, err1 := strconv.ParseInt(parts[0], 10, 64)
				h, err2 := strconv.ParseInt(parts[1], 10, 64)
				if err1 == nil && err2 == nil && w > 0 && h > 0 {
					minEdge := w
					if h < w {
						minEdge = h
					}
					base = strconv.FormatInt(minEdge, 10) + "p"
					break
				}
			}
		}
	}
	if base == "" {
		base = formatIDQualityLabel(f.FormatID)
	}
	if base == "" {
		if suffix != "" {
			return "自适应 (" + suffix + ")"
		}
		return "默认画质"
	}
	if suffix != "" {
		return base + " (" + suffix + ")"
	}
	return base
}

func mapDynamicRange(raw string) string {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "":
		return ""
	case "SDR":
		return "sdr"
	case "HDR10":
		return "hdr10"
	case "HDR10+":
		return "hdr10_plus"
	case "HLG":
		return "hlg"
	case "DV", "DOLBY VISION", "DOLBY_VISION":
		return "dolby_vision"
	default:
		return "hdr_unknown"
	}
}

func pickBitrateKbps(primary, fallback *float64) *float64 {
	if primary != nil && *primary > 0 {
		return primary
	}
	return fallback
}

func kbpsToBps(kbps *float64) int64 {
	if kbps == nil || *kbps <= 0 || math.IsNaN(*kbps) || math.IsInf(*kbps, 0) {
		return 0
	}
	bps := math.Round(*kbps * 1000)
	if bps < 1 || bps > float64(maxSafeInteger) {
		return 0
	}
	return int64(bps)
}

func normalizeFPS(v float64) any {
	rounded := math.Round(v*1000) / 1000
	if rounded == math.Trunc(rounded) {
		return int64(rounded)
	}
	return rounded
}
