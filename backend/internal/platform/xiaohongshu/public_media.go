package xiaohongshu

import (
	"context"
	"net/url"
	"strings"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/urlpolicy"
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
// without rewriting signed bytes, and annotates verified CORS-readable HTTPS
// CDN sources with browser_fetch="allowed" at the public API boundary.
func PreparePublic(ctx context.Context, platform string, payload unified.Object, now int64) (unified.Object, error) {
	if platform != "xiaohongshu" || payload["code"] != "OK" {
		return payload, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result := unified.Clone(payload)
	data := unified.Map(result["data"])
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
