package xiaohongshu

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/urlpolicy"
)

type xhsMirrorKind uint8

const (
	xhsMirrorImage xhsMirrorKind = iota + 1
	xhsMirrorVideo
)

var (
	xhsDomesticImagePath = regexp.MustCompile(`^/[0-9]{12}/[0-9a-fA-F]{32}/.+$`)
	xhsDomesticVideoPath = regexp.MustCompile(`^/stream/[A-Za-z0-9/_.-]+\.mp4$`)
)

// AllowedBrowserFetchURL reports whether raw is a direct HTTPS Xiaohongshu or
// Rednote CDN media URL (*.xhscdn.com or *.rednotecdn.com) verified to support
// credential-free, Referer-free browser CORS Range reads. Site/page domains
// (*.xiaohongshu.com, *.rednote.com, *.xhslink.com) are excluded.
func AllowedBrowserFetchURL(raw string) bool {
	host, ok := httpsDirectHost(raw)
	if !ok {
		return false
	}
	return hasSubdomain(host, ".xhscdn.com") || hasSubdomain(host, ".rednotecdn.com")
}

// PreparePublic upgrades direct HTTP video and Live Photo motion URLs to HTTPS
// without rewriting signed bytes, prepends verified domestic xhscdn.com mirrors
// for unsigned overseas rednotecdn.com image/video routes, and annotates verified
// CORS-readable HTTPS CDN sources with browser_fetch="allowed" at the public API
// boundary.
func PreparePublic(ctx context.Context, platform string, payload unified.Object, now int64) (unified.Object, error) {
	if platform != "xiaohongshu" || payload["code"] != "OK" {
		return payload, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result := unified.Clone(payload)
	data := unified.Map(result["data"])
	if data == nil {
		return result, nil
	}
	evalNow := now
	if genText := unified.Str(data["generated_at"]); genText != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, genText); err == nil {
			evalNow = parsed.Unix()
		}
	}
	for _, rawItem := range unified.Slice(data["items"]) {
		item := unified.Map(rawItem)
		switch item["type"] {
		case "live_photo":
			for _, v := range unified.Slice(item["variants"]) {
				upgradePair(unified.Map(unified.Map(v)["delivery"]))
			}
		case "video":
			for _, v := range unified.Slice(item["variants"]) {
				upgradeVideoDelivery(unified.Map(unified.Map(v)["delivery"]))
			}
			if defaultProj := unified.Map(item["default"]); defaultProj != nil {
				if defaultProj["access"] == nil || defaultProj["access"] == "direct" {
					if raw, ok := defaultProj["url"].(string); ok {
						defaultProj["url"] = httpsMotionURL(raw)
					}
				}
			}
		}
	}
	prependDomesticXHSMirrors(data, evalNow)
	for _, rawItem := range unified.Slice(data["items"]) {
		item := unified.Map(rawItem)
		for _, rawVariant := range unified.Slice(item["variants"]) {
			markDeliveryBrowserFetch(unified.Map(unified.Map(rawVariant)["delivery"]))
		}
	}
	for _, rawAttachment := range unified.Slice(data["attachments"]) {
		resource := unified.Map(unified.Map(rawAttachment)["resource"])
		markDeliveryBrowserFetch(unified.Map(resource["delivery"]))
	}
	return result, nil
}

func prependDomesticXHSMirrors(data unified.Object, evalNow int64) {
	items := unified.Slice(data["items"])
	for index, rawItem := range items {
		item := unified.Map(rawItem)
		if item == nil {
			continue
		}
		if state := unified.Str(item["state"]); state != "" && state != "ready" {
			continue
		}
		var kind xhsMirrorKind
		switch unified.Str(item["type"]) {
		case "image":
			kind = xhsMirrorImage
		case "video", "live_photo":
			kind = xhsMirrorVideo
		default:
			continue
		}
		changed := false
		for _, rawVariant := range unified.Slice(item["variants"]) {
			variant := unified.Map(rawVariant)
			if variant == nil {
				continue
			}
			if state := unified.Str(variant["state"]); state != "" && state != "ready" {
				continue
			}
			if prependDeliveryDomesticMirrors(unified.Map(variant["delivery"]), kind, evalNow) {
				changed = true
			}
		}
		if changed && (item["type"] == "image" || item["type"] == "video") {
			items[index] = unified.SelectDefault(item, evalNow)
		}
	}
}

func prependDeliveryDomesticMirrors(delivery unified.Object, kind xhsMirrorKind, evalNow int64) bool {
	if delivery == nil {
		return false
	}
	switch unified.Str(delivery["kind"]) {
	case "file":
		return prependFileDomesticMirrors(delivery, kind, evalNow)
	case "pair":
		changed := false
		for _, rawResource := range unified.Slice(delivery["resources"]) {
			resource := unified.Map(rawResource)
			if resource == nil {
				continue
			}
			switch unified.Str(resource["role"]) {
			case "image":
				if prependDeliveryDomesticMirrors(unified.Map(resource["delivery"]), xhsMirrorImage, evalNow) {
					changed = true
				}
			case "motion":
				if prependDeliveryDomesticMirrors(unified.Map(resource["delivery"]), xhsMirrorVideo, evalNow) {
					changed = true
				}
			}
		}
		return changed
	case "mux":
		changed := false
		for _, rawResource := range unified.Slice(delivery["resources"]) {
			resource := unified.Map(rawResource)
			if resource == nil || unified.Str(resource["role"]) != "video" {
				continue
			}
			if prependDeliveryDomesticMirrors(unified.Map(resource["delivery"]), xhsMirrorVideo, evalNow) {
				changed = true
			}
		}
		return changed
	default:
		return false
	}
}

func prependFileDomesticMirrors(file unified.Object, kind xhsMirrorKind, evalNow int64) bool {
	if file == nil || unified.Str(file["kind"]) != "file" {
		return false
	}
	sources := unified.Slice(file["sources"])
	if len(sources) == 0 {
		return false
	}
	seenURLs := make(map[string]bool, len(sources)+1)
	usedIDs := make(map[string]bool, len(sources)+1)
	for _, rawSource := range sources {
		src := unified.Map(rawSource)
		if src == nil {
			continue
		}
		if u := unified.Str(src["url"]); u != "" {
			seenURLs[u] = true
		}
		if id := unified.Str(src["id"]); id != "" {
			usedIDs[id] = true
		}
	}
	var prepended unified.Array
	for _, rawSource := range sources {
		src := unified.Map(rawSource)
		if src == nil {
			continue
		}
		if src["access"] != nil && src["access"] != "direct" {
			continue
		}
		if !unified.SourceUsable(src, evalNow) {
			continue
		}
		mirrorURL, ok := domesticXHSMirrorURL(unified.Str(src["url"]), kind)
		if !ok || seenURLs[mirrorURL] {
			continue
		}
		seenURLs[mirrorURL] = true
		mirror := unified.Clone(src)
		mirror["url"] = mirrorURL
		mirror["id"] = allocateSourceID(mirrorURL, usedIDs)
		delete(mirror, "fallback_urls")
		delete(mirror, "direct_url")
		delete(mirror, "browser_fetch")
		delete(mirror, "availability")
		prepended = append(prepended, mirror)
	}
	if len(prepended) == 0 {
		return false
	}
	updated := make(unified.Array, 0, len(prepended)+len(sources))
	updated = append(updated, prepended...)
	updated = append(updated, sources...)
	if len(updated) > 1 {
		for _, rawSource := range updated {
			src := unified.Map(rawSource)
			if src == nil {
				continue
			}
			if unified.Str(src["id"]) == "" {
				src["id"] = allocateSourceID(unified.Str(src["url"]), usedIDs)
			}
		}
	}
	file["sources"] = updated
	return true
}

func domesticXHSMirrorURL(raw string, kind xhsMirrorKind) (string, bool) {
	if len(raw) < 8 || len(raw) > 8192 || strings.ContainsAny(raw, "?#") || urlpolicy.HasUnsafeChars(raw) || unified.MediaURL(raw) != raw {
		return "", false
	}
	u, ok := urlpolicy.ParseCanonicalURL(raw, urlpolicy.HTTPSOnly)
	if !ok || strings.HasSuffix(u.Host, ":") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", false
	}
	for _, b := range []byte(u.Host) {
		if b > 127 {
			return "", false
		}
	}
	host := strings.ToLower(u.Hostname())
	idx := strings.Index(raw, "://")
	if idx < 0 {
		return "", false
	}
	rest := raw[idx+3:]
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		return "", false
	}
	rawPath := rest[slash:]
	if pathHasDotSegment(rawPath) {
		return "", false
	}
	switch kind {
	case xhsMirrorImage:
		if host == "sns-web-i10.rednotecdn.com" && xhsDomesticImagePath.MatchString(rawPath) {
			return "https://sns-webpic-qc.xhscdn.com" + rawPath, true
		}
	case xhsMirrorVideo:
		if (host == "sns-v11.rednotecdn.com" || host == "sns-v27.rednotecdn.com") && xhsDomesticVideoPath.MatchString(rawPath) {
			return "https://sns-bak-v1.xhscdn.com" + rawPath, true
		}
	}
	return "", false
}

func pathHasDotSegment(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." {
			return true
		}
	}
	return false
}

func sourceIDForURL(raw string) string {
	sum := sha256.Sum256([]byte(unified.SourceIdentity(raw)))
	return "s-" + hex.EncodeToString(sum[:])[:24]
}

func allocateSourceID(raw string, used map[string]bool) string {
	base := sourceIDForURL(raw)
	if !used[base] {
		used[base] = true
		return base
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s-%d", base, i)
		if !used[candidate] {
			used[candidate] = true
			return candidate
		}
	}
}

func upgradeVideoDelivery(delivery unified.Object) {
	if delivery == nil {
		return
	}
	switch unified.Str(delivery["kind"]) {
	case "file":
		upgradeFileSources(delivery)
	case "pair":
		upgradePair(delivery)
	case "mux":
		for _, r := range unified.Slice(delivery["resources"]) {
			upgradeVideoDelivery(unified.Map(unified.Map(r)["delivery"]))
		}
	}
}

func upgradePair(pair unified.Object) {
	if pair["kind"] != "pair" {
		return
	}
	for _, r := range unified.Slice(pair["resources"]) {
		resource := unified.Map(r)
		if resource["role"] != "motion" {
			continue
		}
		file := unified.Map(resource["delivery"])
		if file["kind"] != "file" {
			continue
		}
		upgradeFileSources(file)
	}
}

func upgradeFileSources(file unified.Object) {
	for _, rawSource := range unified.Slice(file["sources"]) {
		source := unified.Map(rawSource)
		if source["access"] != nil && source["access"] != "direct" {
			continue
		}
		if raw, ok := source["url"].(string); ok {
			source["url"] = httpsMotionURL(raw)
		}
		fallbacks := unified.Slice(source["fallback_urls"])
		for i, value := range fallbacks {
			if raw, ok := value.(string); ok {
				fallbacks[i] = httpsMotionURL(raw)
			}
		}
	}
}

func markDeliveryBrowserFetch(delivery unified.Object) {
	if delivery == nil {
		return
	}
	switch unified.Str(delivery["kind"]) {
	case "file":
		for _, rawSource := range unified.Slice(delivery["sources"]) {
			source := unified.Map(rawSource)
			if source == nil {
				continue
			}
			if source["access"] != nil && source["access"] != "direct" {
				continue
			}
			if source["browser_fetch"] != nil && source["browser_fetch"] != "unknown" {
				continue
			}
			if AllowedBrowserFetchURL(unified.Str(source["url"])) {
				source["browser_fetch"] = "allowed"
			}
		}
	case "pair", "mux":
		for _, rawResource := range unified.Slice(delivery["resources"]) {
			markDeliveryBrowserFetch(unified.Map(unified.Map(rawResource)["delivery"]))
		}
	}
}

func httpsDirectHost(raw string) (string, bool) {
	if len(raw) < 8 || len(raw) > 8192 || strings.Contains(raw, "#") || urlpolicy.HasUnsafeChars(raw) || unified.MediaURL(raw) != raw {
		return "", false
	}
	u, ok := urlpolicy.ParseCanonicalURL(raw, urlpolicy.HTTPSOnly)
	if !ok || strings.HasSuffix(u.Host, ":") {
		return "", false
	}
	for _, b := range []byte(u.Host) {
		if b > 127 {
			return "", false
		}
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", false
	}
	return host, true
}

func hasSubdomain(host, suffix string) bool {
	if !strings.HasSuffix(host, suffix) || len(host) <= len(suffix) {
		return false
	}
	prefix := host[:len(host)-len(suffix)]
	for _, label := range strings.Split(prefix, ".") {
		if label == "" || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
				return false
			}
		}
	}
	return true
}

func httpsMotionURL(raw string) string {
	if len(raw) < 7 || !strings.EqualFold(raw[:7], "http://") || urlpolicy.HasUnsafeChars(raw) {
		return raw
	}
	u, err := url.Parse(raw)
	// An explicit port cannot be silently changed while preserving signed URL
	// bytes. Leave unusual/invalid authorities as declared instead of guessing.
	if err != nil || u.User != nil || u.Opaque != "" || u.Hostname() == "" || u.Port() != "" || strings.HasSuffix(u.Host, ":") {
		return raw
	}
	for _, b := range []byte(u.Host) {
		if b > 127 {
			return raw
		}
	}
	// Do not round-trip through URL.String: only the scheme changes; path,
	// escaped bytes, query order and signature text stay byte-for-byte intact.
	return "https" + raw[4:]
}
