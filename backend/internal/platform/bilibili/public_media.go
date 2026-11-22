package bilibili

import (
	"context"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

// PreparePublic annotates direct Bilibili CDN media sources:
// https://*.bilivideo.com receives browser_fetch="allowed", and validated
// official Bilibili CDN URLs (*.bilivideo.com, *.bilivideo.cn, *.akamaized.net)
// receive deadline-derived expires_at at the public API boundary while keeping
// frozen PHP baseline outputs untouched.
func PreparePublic(ctx context.Context, platform string, payload unified.Object, now int64) (unified.Object, error) {
	if platform != "bilibili" || payload["code"] != "OK" {
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
	annotateBilibiliData(data, evalNow)
	return result, nil
}

func annotateBilibiliData(data unified.Object, now int64) {
	if data == nil {
		return
	}
	items := unified.Slice(data["items"])
	if len(items) > 0 {
		updated := make(unified.Array, 0, len(items))
		for _, rawItem := range items {
			item := unified.Map(rawItem)
			if item == nil {
				updated = append(updated, rawItem)
				continue
			}
			for _, rawVariant := range unified.Slice(item["variants"]) {
				variant := unified.Map(rawVariant)
				if variant == nil || unified.Str(variant["state"]) == "deferred" {
					continue
				}
				annotateBilibiliDelivery(unified.Map(variant["delivery"]))
			}
			updated = append(updated, unified.SelectDefaultForPlatform("bilibili", item, now))
		}
		data["items"] = updated
	}
	for _, rawAttachment := range unified.Slice(data["attachments"]) {
		resource := unified.Map(unified.Map(rawAttachment)["resource"])
		annotateBilibiliDelivery(unified.Map(resource["delivery"]))
	}
}

func annotateBilibiliDelivery(delivery unified.Object) {
	if delivery == nil {
		return
	}
	for _, group := range unified.DeliverySources(delivery) {
		for _, rawSource := range group {
			source := unified.Map(rawSource)
			if source == nil {
				continue
			}
			if source["access"] != nil && source["access"] != "direct" {
				continue
			}
			rawURL := unified.Str(source["url"])
			if AllowedBrowserFetchURL(rawURL) {
				if source["browser_fetch"] == nil || source["browser_fetch"] == "unknown" {
					source["browser_fetch"] = "allowed"
				}
			}
			if source["expires_at"] == nil {
				if exp, ok := bilibiliMediaURLDeadline(rawURL); ok {
					source["expires_at"] = time.Unix(exp, 0).UTC().Format(time.RFC3339)
				}
			}
		}
	}
}
