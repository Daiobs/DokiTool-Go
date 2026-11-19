package zuiyou

import (
	"context"
	"net/url"
	"strings"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/urlpolicy"
)

// AllowedHTTPSUpgradeURL reports whether raw is a direct HTTP Zuiyou/Xiaochuan
// CDN URL whose scheme can be upgraded in place from http:// to https:// without
// altering path bytes or signed query parameters.
func AllowedHTTPSUpgradeURL(raw string) bool {
	if len(raw) < 7 || len(raw) > 8192 || !strings.EqualFold(raw[:7], "http://") || strings.Contains(raw, "#") || urlpolicy.HasUnsafeChars(raw) {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Hostname() == "" || u.Port() != "" || strings.HasSuffix(u.Host, ":") {
		return false
	}
	for _, b := range []byte(u.Host) {
		if b > 127 {
			return false
		}
	}
	host := strings.ToLower(u.Hostname())
	return isZuiyouCDNHost(host)
}

func isZuiyouCDNHost(host string) bool {
	if hasSubdomain(host, ".izuiyou.com") {
		switch host {
		case "www.izuiyou.com", "share.izuiyou.com", "h5.izuiyou.com", "m.izuiyou.com", "api.izuiyou.com":
			return false
		}
		return true
	}
	if hasSubdomain(host, ".ixiaochuan.cn") {
		return true
	}
	if hasSubdomain(host, ".xiaochuankeji.cn") {
		return host != "share.xiaochuankeji.cn"
	}
	return false
}

// AllowedBrowserFetchURL reports whether raw is a direct HTTPS Zuiyou image/file
// CDN URL (such as web-f*.izuiyou.com, *tbfile.izuiyou.com, file.izuiyou.com, or
// *tbfile.ixiaochuan.cn) verified to return Access-Control-Allow-Origin: * on
// credential-free, Referer-free GET and Range requests. Video CDN hosts
// (web-v*.izuiyou.com, tbvideo.ixiaochuan.cn) and site/share hosts are excluded.
func AllowedBrowserFetchURL(raw string) bool {
	host, ok := httpsDirectHost(raw)
	if !ok {
		return false
	}
	var prefix string
	switch {
	case hasSubdomain(host, ".izuiyou.com"):
		prefix = host[:len(host)-len(".izuiyou.com")]
	case hasSubdomain(host, ".ixiaochuan.cn"):
		prefix = host[:len(host)-len(".ixiaochuan.cn")]
	default:
		return false
	}
	if strings.Contains(prefix, ".") {
		return false
	}
	return strings.HasPrefix(prefix, "web-f") ||
		prefix == "file" ||
		strings.HasSuffix(prefix, "-file") ||
		prefix == "tbfile" ||
		strings.HasSuffix(prefix, "-tbfile") ||
		prefix == "zyvipres"
}

// PreparePublic upgrades direct HTTP Zuiyou CDN URLs (covers, avatars, images,
// and video fallback links) to HTTPS via exact scheme prefix swap without
// rewriting signed query bytes, and annotates verified CORS-readable non-video
// image/file CDN sources with browser_fetch="allowed".
func PreparePublic(ctx context.Context, platform string, payload unified.Object, now int64) (unified.Object, error) {
	if platform != "zuiyou" || payload["code"] != "OK" {
		return payload, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result := unified.Clone(payload)
	data := unified.Map(result["data"])
	upgradeSource(unified.Map(data["cover"]))
	upgradeSource(unified.Map(unified.Map(data["author"])["avatar"]))
	for _, rawItem := range unified.Slice(data["items"]) {
		item := unified.Map(rawItem)
		upgradeSource(unified.Map(item["cover"]))
		for _, rawVariant := range unified.Slice(item["variants"]) {
			upgradeDelivery(unified.Map(unified.Map(rawVariant)["delivery"]))
		}
		if defaultProj := unified.Map(item["default"]); defaultProj != nil {
			if defaultProj["access"] == nil || defaultProj["access"] == "direct" {
				if raw, ok := defaultProj["url"].(string); ok {
					defaultProj["url"] = httpsUpgradeURL(raw)
				}
			}
		}
		if item["type"] != "video" {
			for _, rawVariant := range unified.Slice(item["variants"]) {
				markDeliveryBrowserFetch(unified.Map(unified.Map(rawVariant)["delivery"]))
			}
		}
	}
	for _, rawAttachment := range unified.Slice(data["attachments"]) {
		attachment := unified.Map(rawAttachment)
		upgradeSource(unified.Map(attachment["cover"]))
		upgradeSource(unified.Map(unified.Map(attachment["author"])["avatar"]))
		delivery := unified.Map(unified.Map(attachment["resource"])["delivery"])
		upgradeDelivery(delivery)
		markDeliveryBrowserFetch(delivery)
	}
	return result, nil
}

func upgradeDelivery(delivery unified.Object) {
	if delivery == nil {
		return
	}
	switch unified.Str(delivery["kind"]) {
	case "file":
		for _, rawSource := range unified.Slice(delivery["sources"]) {
			upgradeSource(unified.Map(rawSource))
		}
	case "pair", "mux":
		for _, rawResource := range unified.Slice(delivery["resources"]) {
			upgradeDelivery(unified.Map(unified.Map(rawResource)["delivery"]))
		}
	}
}

func upgradeSource(source unified.Object) {
	if source == nil {
		return
	}
	if source["access"] != nil && source["access"] != "direct" {
		return
	}
	if raw, ok := source["url"].(string); ok {
		source["url"] = httpsUpgradeURL(raw)
	}
	fallbacks := unified.Slice(source["fallback_urls"])
	for i, value := range fallbacks {
		if raw, ok := value.(string); ok {
			fallbacks[i] = httpsUpgradeURL(raw)
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

func httpsUpgradeURL(raw string) string {
	if !AllowedHTTPSUpgradeURL(raw) {
		return raw
	}
	// Do not round-trip through URL.String: only the scheme changes; path,
	// escaped bytes, query order and signature text stay byte-for-byte intact.
	return "https" + raw[4:]
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
