package unified

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// SourceUsable is delivery eligibility, not a browser CORS capability check.
func SourceUsable(source Object, now int64) bool {
	if source == nil || Str(source["availability"]) == "unavailable" {
		return false
	}
	if expiry, exists := source["expires_at"]; exists && expiry != nil {
		t, err := time.Parse(time.RFC3339Nano, Str(expiry))
		return err == nil && t.Unix() > now
	}
	return true
}

// DeliverySources returns one ordered alternative-source group per dependency.
func DeliverySources(delivery Object) []Array {
	groups := make([]Array, 0)
	switch Str(delivery["kind"]) {
	case "file", "hls", "dash":
		groups = append(groups, Slice(delivery["sources"]))
	case "segments":
		if init := Map(delivery["init"]); init != nil {
			groups = append(groups, Slice(init["sources"]))
		}
		for _, value := range Slice(delivery["pieces"]) {
			groups = append(groups, Slice(Map(value)["sources"]))
		}
	case "mux", "pair":
		for _, value := range Slice(delivery["resources"]) {
			groups = append(groups, DeliverySources(Map(Map(value)["delivery"]))...)
		}
	}
	return groups
}

func DeliveryUsable(delivery Object, now int64) bool {
	groups := DeliverySources(delivery)
	if len(groups) == 0 {
		return false
	}
	for _, sources := range groups {
		usable := false
		for _, value := range sources {
			if SourceUsable(Map(value), now) {
				usable = true
				break
			}
		}
		if !usable {
			return false
		}
	}
	return true
}

func DeliveryRequires(delivery Object) []string {
	required := map[string]bool{}
	var visit func(Object)
	visit = func(d Object) {
		switch kind := Str(d["kind"]); kind {
		case "hls", "dash":
			required[kind] = true
		case "segments":
			if Str(d["join"]) == "byte_concat" {
				required["segment_byte_concat"] = true
			} else {
				required["segment_remux"] = true
			}
		case "mux", "pair":
			required[kind] = true
			for _, value := range Slice(d["resources"]) {
				visit(Map(Map(value)["delivery"]))
			}
		}
	}
	visit(delivery)
	out := make([]string, 0, len(required))
	for capability := range required {
		out = append(out, capability)
	}
	sort.Strings(out)
	return out
}

func nonNullField(object Object, field string) bool {
	value, exists := object[field]
	return exists && value != nil
}

func objectCopy(object Object) Object {
	if object == nil {
		return Object{}
	}
	return Clone(object)
}

func overlayMetadata(base, overlay Object) Object {
	out := objectCopy(base)
	for field, value := range overlay {
		out[field] = CloneValue(value)
	}
	return out
}

// VariantVideoMetadata declines contradictory geometry instead of choosing a
// scalar winner. A mux can obtain its geometry from its actual video resource.
func VariantVideoMetadata(variant Object) Object {
	metadata := Map(variant["metadata"])
	delivery := Map(variant["delivery"])
	if Str(delivery["kind"]) == "mux" {
		for _, value := range Slice(delivery["resources"]) {
			resource := Map(value)
			if Str(resource["role"]) != "video" {
				continue
			}
			facts := Map(resource["metadata"])
			combined := overlayMetadata(facts, metadata)
			for _, field := range []string{"width", "height"} {
				if nonNullField(Map(metadata["field_conflicts"]), field) || nonNullField(Map(facts["field_conflicts"]), field) ||
					(nonNullField(metadata, field) && nonNullField(facts, field) && !Equal(metadata[field], facts[field])) {
					delete(combined, field)
				}
			}
			return combined
		}
	}
	out := objectCopy(metadata)
	for _, field := range []string{"width", "height"} {
		if nonNullField(Map(metadata["field_conflicts"]), field) {
			delete(out, field)
		}
	}
	return out
}

type variantGeometry struct {
	known      bool
	shortEdge  float64
	longEdge   float64
	ratio      float64
	hasDimPair bool
	isOriginal bool
	id         string
}

func resolveGeometryField(metadata, facts Object, isMux bool, field string) any {
	if nonNullField(Map(metadata["field_conflicts"]), field) {
		return nil
	}
	if isMux {
		if nonNullField(Map(facts["field_conflicts"]), field) {
			return nil
		}
		if nonNullField(metadata, field) && nonNullField(facts, field) && !Equal(metadata[field], facts[field]) {
			return nil
		}
		if val, exists := metadata[field]; exists {
			return val
		}
		return facts[field]
	}
	return metadata[field]
}

// extractVariantGeometry reads spatial geometry and tie-break keys without
// cloning metadata maps, preserving exact VariantVideoMetadata conflict rules.
func extractVariantGeometry(variant Object) variantGeometry {
	metadata := Map(variant["metadata"])
	delivery := Map(variant["delivery"])
	var facts Object
	isMux := false
	if Str(delivery["kind"]) == "mux" {
		for _, value := range Slice(delivery["resources"]) {
			resource := Map(value)
			if Str(resource["role"]) == "video" {
				facts = Map(resource["metadata"])
				isMux = true
				break
			}
		}
	}
	wVal := resolveGeometryField(metadata, facts, isMux, "width")
	hVal := resolveGeometryField(metadata, facts, isMux, "height")
	g := variantGeometry{
		hasDimPair: wVal != nil && hVal != nil,
		isOriginal: Str(variant["provenance"]) == "original_endpoint",
		id:         Str(variant["id"]),
	}
	w, wOK := Numeric(wVal)
	h, hOK := Numeric(hVal)
	if wOK && hOK && w > 0 && h > 0 {
		if w > h {
			w, h = h, w
		}
		g.known = true
		g.shortEdge = w
		g.longEdge = h
		g.ratio = h / w
	}
	return g
}

func compareGeometry(a, b variantGeometry) (int, bool) {
	if !a.known || !b.known {
		return 0, false
	}
	if math.Abs(a.ratio/b.ratio-1) > 0.01 {
		return 0, false
	}
	if a.shortEdge == b.shortEdge && a.longEdge == b.longEdge {
		return 0, true
	}
	if a.shortEdge >= b.shortEdge && a.longEdge >= b.longEdge {
		return 1, true
	}
	if a.shortEdge <= b.shortEdge && a.longEdge <= b.longEdge {
		return -1, true
	}
	return 0, false
}

func geometryBefore(a, b variantGeometry) bool {
	if a.hasDimPair != b.hasDimPair {
		return a.hasDimPair
	}
	if a.isOriginal != b.isOriginal {
		return a.isOriginal
	}
	return comparePHPID(a.id, b.id) < 0
}

// QualityCompare reports spatial dominance; comparable=false is PHP's null.
// No codec, bitrate, label or original-endpoint claim creates higher quality.
func QualityCompare(left, right Object) (comparison int, comparable bool) {
	return compareGeometry(extractVariantGeometry(left), extractVariantGeometry(right))
}

func readyState(object Object) bool {
	return !nonNullField(object, "state") || Str(object["state"]) == "ready"
}

func variantBefore(a, b Object) bool {
	return geometryBefore(extractVariantGeometry(a), extractVariantGeometry(b))
}

var numericID = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
var integralID = regexp.MustCompile(`^[+-]?[0-9]+$`)

// PHP's array spaceship tie-break compares two numeric strings numerically.
// All current generated IDs are opaque prefixes, but legal numeric IDs must not
// select a different default after migrating languages. Overflowing integer
// strings retain PHP's lexical fallback when their floating values coincide.
func comparePHPID(a, b string) int {
	x, y := strings.Trim(a, " \t\r\n\v\f"), strings.Trim(b, " \t\r\n\v\f")
	if !numericID.MatchString(x) || !numericID.MatchString(y) {
		return strings.Compare(a, b)
	}
	xi, xerr := strconv.ParseInt(x, 10, 64)
	yi, yerr := strconv.ParseInt(y, 10, 64)
	if xerr == nil && yerr == nil {
		if xi < yi {
			return -1
		}
		if xi > yi {
			return 1
		}
		return 0
	}
	xf, _ := strconv.ParseFloat(x, 64)
	yf, _ := strconv.ParseFloat(y, 64)
	if xf < yf {
		return -1
	}
	if xf > yf {
		return 1
	}
	xOverflow := integralID.MatchString(x) && xerr != nil
	yOverflow := integralID.MatchString(y) && yerr != nil
	if (xOverflow && yOverflow) || math.IsInf(xf, 0) || math.IsInf(yf, 0) {
		return strings.Compare(a, b)
	}
	if xOverflow && yerr == nil {
		if xf < 0 {
			return -1
		}
		return 1
	}
	if yOverflow && xerr == nil {
		if yf < 0 {
			return 1
		}
		return -1
	}
	return 0
}

// requiresAudibleDefault reports whether default video file selection prefers
// audible files (has_audio: true, with unknown-audio MP4 fallback) over silent
// DASH video-only tracks. The 9 native PHP-baseline platforms (and empty
// platform calls) retain legacy spatial-only selection so frozen baseline
// fixtures whose progressive variants omit has_audio remain unchanged.
func requiresAudibleDefault(platform string) bool {
	switch platform {
	case "",
		"douyin",
		"bilibili",
		"weibo",
		"toutiao",
		"kuaishou",
		"pipixia",
		"pipigx",
		"zuiyou",
		"xiaohongshu":
		return false
	default:
		return true
	}
}

func isAudioOnlyFile(v Object) bool {
	mime := strings.ToLower(strings.TrimSpace(Str(Map(v["metadata"])["mime_type"])))
	return strings.HasPrefix(mime, "audio/")
}

func isAudibleVideoFile(v Object) bool {
	if isAudioOnlyFile(v) {
		return false
	}
	hasAudio, ok := Map(v["metadata"])["has_audio"].(bool)
	return ok && hasAudio
}

func isUnknownAudioMP4VideoFile(v Object) bool {
	if isAudioOnlyFile(v) {
		return false
	}
	meta := Map(v["metadata"])
	if nonNullField(meta, "has_audio") || nonNullField(Map(meta["field_conflicts"]), "has_audio") {
		return false
	}
	mime := strings.ToLower(strings.TrimSpace(Str(meta["mime_type"])))
	container := strings.ToLower(strings.TrimSpace(Str(meta["container"])))
	ext := strings.ToLower(strings.TrimSpace(Str(meta["extension"])))
	return mime == "video/mp4" && container == "mp4" && ext == "mp4"
}

// allowsUnknownAudioMP4Fallback reports whether a platform that may emit
// codec-less progressive MP4s (e.g. Instagram, Facebook, Tumblr, and Tier-2
// ytgeneric extractors) should prefer an unknown-audio MP4 over explicitly
// silent DASH video-only tracks when no has_audio=true variant exists.
// X and YouTube always provide explicit codec metadata and keep strict
// has_audio=true preference so unknown-audio streams never override 4K tracks.
func allowsUnknownAudioMP4Fallback(platform string) bool {
	if !requiresAudibleDefault(platform) {
		return false
	}
	return platform != "x" && platform != "youtube"
}

func defaultEligibleFiles(platform, itemType string, usableFiles []Object) []Object {
	if !requiresAudibleDefault(platform) || itemType != "video" {
		return usableFiles
	}
	audible := make([]Object, 0, len(usableFiles))
	for _, v := range usableFiles {
		if isAudibleVideoFile(v) {
			audible = append(audible, v)
		}
	}
	if len(audible) > 0 {
		return audible
	}
	if allowsUnknownAudioMP4Fallback(platform) {
		unknownMP4 := make([]Object, 0, len(usableFiles))
		for _, v := range usableFiles {
			if isUnknownAudioMP4VideoFile(v) {
				unknownMP4 = append(unknownMP4, v)
			}
		}
		if len(unknownMP4) > 0 {
			return unknownMP4
		}
	}
	nonAudio := make([]Object, 0, len(usableFiles))
	for _, v := range usableFiles {
		if !isAudioOnlyFile(v) {
			nonAudio = append(nonAudio, v)
		}
	}
	if len(nonAudio) > 0 {
		return nonAudio
	}
	return usableFiles
}

// SelectDefault never mutates its input or sorts the displayed candidate list.
func SelectDefault(input Object, now int64) Object {
	return SelectDefaultForPlatform("", input, now)
}

// SelectDefaultForPlatform applies platform-scoped default eligibility rules without mutating input.
func SelectDefaultForPlatform(platform string, input Object, now int64) Object {
	item := objectCopy(input)
	delete(item, "default_unavailable_reason")
	delete(item, "higher_quality_variants")
	item["default"] = nil
	if !readyState(item) {
		reason := "unavailable"
		if Str(item["state"]) == "deferred" {
			reason = "needs_resolve"
		}
		item["default_unavailable_reason"] = reason
		return item
	}
	variants := Slice(item["variants"])
	usableFiles := make([]Object, 0)
	for _, value := range variants {
		v := Map(value)
		if readyState(v) && Str(Map(v["delivery"])["kind"]) == "file" && DeliveryUsable(Map(v["delivery"]), now) {
			usableFiles = append(usableFiles, v)
		}
	}
	eligible := defaultEligibleFiles(platform, Str(item["type"]), usableFiles)
	geoms := make([]variantGeometry, len(eligible))
	knownIndices := make([]int, 0, len(eligible))
	for i, v := range eligible {
		geoms[i] = extractVariantGeometry(v)
		if geoms[i].known {
			knownIndices = append(knownIndices, i)
		}
	}
	type rankedCandidate struct {
		variant Object
		geom    variantGeometry
	}
	highest := make([]rankedCandidate, 0, len(eligible))
	for i, v := range eligible {
		dominated := false
		if geoms[i].known {
			for _, j := range knownIndices {
				if cmp, comparable := compareGeometry(geoms[j], geoms[i]); comparable && cmp == 1 {
					dominated = true
					break
				}
			}
		}
		if !dominated {
			highest = append(highest, rankedCandidate{variant: v, geom: geoms[i]})
		}
	}
	sort.SliceStable(highest, func(i, j int) bool { return geometryBefore(highest[i].geom, highest[j].geom) })
	if len(highest) > 0 {
		selected := highest[0].variant
		selectedGeom := highest[0].geom
		for _, value := range Slice(Map(selected["delivery"])["sources"]) {
			source := Map(value)
			if !SourceUsable(source, now) {
				continue
			}
			projection := Object{"variant_id": selected["id"], "url": source["url"]}
			for _, fields := range [][2]string{{"id", "source_id"}, {"access", "access"}, {"expires_at", "expires_at"}} {
				if nonNullField(source, fields[0]) {
					projection[fields[1]] = source[fields[0]]
				}
			}
			item["default"] = projection
			break
		}
		higher := Array{}
		if selectedGeom.known {
			for _, value := range variants {
				v := Map(value)
				if cmp, comparable := compareGeometry(extractVariantGeometry(v), selectedGeom); !comparable || cmp != 1 || !DeliveryUsable(Map(v["delivery"]), now) {
					continue
				}
				if required := DeliveryRequires(Map(v["delivery"])); len(required) > 0 {
					higher = append(higher, Object{"variant_id": v["id"], "requires": Slice(required)})
				}
			}
		}
		if len(higher) > 0 {
			item["higher_quality_variants"] = higher
		}
		return item
	}
	reason := "unavailable"
	for _, value := range variants {
		if Str(Map(value)["state"]) == "deferred" {
			reason = "needs_resolve"
			break
		}
	}
	for _, value := range variants {
		v := Map(value)
		if Str(v["state"]) == "deferred" {
			continue
		}
		delivery := Map(v["delivery"])
		if DeliveryUsable(delivery, now) {
			reason = "processing_required"
			break
		}
		for _, sources := range DeliverySources(delivery) {
			for _, value := range sources {
				source := Map(value)
				if reason != "needs_resolve" && nonNullField(source, "expires_at") {
					if expiry, err := time.Parse(time.RFC3339Nano, Str(source["expires_at"])); err == nil && expiry.Unix() <= now {
						reason = "needs_refresh"
					}
				}
			}
		}
	}
	item["default_unavailable_reason"] = reason
	return item
}

func FinalizeData(input Object, now int64) Object {
	data := objectCopy(input)
	platform := Str(data["platform"])
	data["generated_at"] = time.Unix(now, 0).UTC().Format(time.RFC3339)
	items := make(Array, 0, len(Slice(data["items"])))
	for _, value := range Slice(data["items"]) {
		items = append(items, SelectDefaultForPlatform(platform, Map(value), now))
	}
	data["items"] = items
	return Object{"schema_version": SchemaVersion, "code": "OK", "data": data}
}

func ContractError(code, message string, retryable bool) Object {
	problem := Object{"code": code, "message": message}
	if retryable {
		problem["retryable"] = true
	}
	return Object{"schema_version": SchemaVersion, "code": code, "error": problem}
}
