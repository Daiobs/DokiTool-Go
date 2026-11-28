package weibo

import (
	"context"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

// AllowedMediaURL validates fixed-provider Weibo CDN video URLs (`https://*.weibocdn.com`)
// without userinfo, fragments, control characters, non-standard ports, or IP literals.
func AllowedMediaURL(raw string) bool {
	if len(raw) > 4096 || strings.Contains(raw, "#") || unified.MediaURL(raw) == "" {
		return false
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' {
			return false
		}
	}
	separator := strings.Index(raw, "://")
	if separator < 0 {
		return false
	}
	path := strings.IndexAny(raw[separator+3:], "/?#")
	if path < 0 || raw[separator+3+path] != '/' {
		return false
	}
	u, err := url.Parse(raw[:separator+3+path])
	if err != nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host == "" {
		return false
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return false
	}
	if !strings.HasSuffix(host, ".weibocdn.com") || len(host) <= len(".weibocdn.com") {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n != 443 {
			return false
		}
	}
	return true
}

// upgradeWeiboHTTPToHTTPS losslessly upgrades cleartext http://*.weibocdn.com
// URLs (without explicit ports, userinfo, fragments, or non-ASCII characters)
// to https:// while preserving exact path, percent-encoding, and query bytes.
func upgradeWeiboHTTPToHTTPS(raw string) string {
	if len(raw) < 7 || !strings.EqualFold(raw[:7], "http://") {
		return raw
	}
	for _, r := range raw {
		if r <= 0x20 || r >= 0x7f || r == '\\' || r == '#' {
			return raw
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Port() != "" || strings.HasSuffix(u.Host, ":") {
		return raw
	}
	host := strings.ToLower(u.Hostname())
	if !strings.HasSuffix(host, ".weibocdn.com") || len(host) <= len(".weibocdn.com") {
		return raw
	}
	return "https" + raw[4:]
}

// PreparePublic validates fixed-provider Weibo video URLs, upgrades http:// to
// https://, marks each usable source as direct + browser_fetch=blocked (matching
// TikTok's zero-relay extension-direct contract), and reselects defaults.
func PreparePublic(ctx context.Context, platform string, payload unified.Object, now int64) (unified.Object, error) {
	if platform != "weibo" || payload["code"] != "OK" {
		return payload, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result := unified.Clone(payload)
	recognized := 0
	items := unified.Slice(unified.Map(result["data"])["items"])
	for index, rawItem := range items {
		item := unified.Map(rawItem)
		for _, rawVariant := range unified.Slice(item["variants"]) {
			variant := unified.Map(rawVariant)
			if variant["state"] != nil && variant["state"] != "ready" {
				continue
			}
			prepareDirectDeliverySources(unified.Map(variant["delivery"]), &recognized)
		}
		items[index] = unified.SelectDefault(item, now)
	}
	if recognized == 0 {
		return unified.ContractError("UPSTREAM_INVALID_RESPONSE", "微博暂未提供本站支持的视频源，请稍后重试", true), nil
	}
	return result, nil
}

func prepareDirectDeliverySources(delivery unified.Object, recognized *int) {
	if delivery == nil {
		return
	}
	for _, value := range unified.Slice(delivery["sources"]) {
		prepareDirectSource(unified.Map(value), recognized)
	}
	if init := unified.Map(delivery["init"]); init != nil {
		for _, value := range unified.Slice(init["sources"]) {
			prepareDirectSource(unified.Map(value), recognized)
		}
	}
	for _, rawPiece := range unified.Slice(delivery["pieces"]) {
		for _, value := range unified.Slice(unified.Map(rawPiece)["sources"]) {
			prepareDirectSource(unified.Map(value), recognized)
		}
	}
	for _, rawResource := range unified.Slice(delivery["resources"]) {
		prepareDirectDeliverySources(unified.Map(unified.Map(rawResource)["delivery"]), recognized)
	}
}

func prepareDirectSource(source unified.Object, recognized *int) {
	if source == nil {
		return
	}
	raw := upgradeWeiboHTTPToHTTPS(unified.Str(source["url"]))
	if !AllowedMediaURL(raw) {
		source["availability"] = "unavailable"
		delete(source, "direct_url")
		return
	}
	source["url"] = raw
	source["access"] = "direct"
	source["browser_fetch"] = "blocked"
	delete(source, "direct_url")
	*recognized = *recognized + 1
	if previous, ok := source["expires_at"]; ok && previous != nil {
		if _, err := time.Parse(time.RFC3339Nano, unified.Str(previous)); err != nil {
			source["availability"] = "unavailable"
		}
	}
}
