package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

// TikTokFinalizer serves POST /api/tiktok/finalize?schema_version=1.0 using
// pure CPU validation and unified-v1 formatting with zero outbound calls.
type TikTokFinalizer interface {
	Finalize(ctx context.Context, body []byte, debug bool) (unified.Object, int)
}

// SetTikTokFinalizer registers or clears the client-assisted TikTok finalize
// handler. When unset, POST /api/tiktok/finalize returns 404.
func (h *Handler) SetTikTokFinalizer(finalizer TikTokFinalizer) {
	if h == nil {
		return
	}
	h.tiktokFinalizer = finalizer
}

const (
	maxTikTokFinalizeBodyBytes       = 512 << 10
	defaultTikTokFinalizeReadTimeout = 5 * time.Second
)

func (h *Handler) tiktokFinalizeReadTimeout() time.Duration {
	if h != nil && h.finalizeReadTimeout > 0 {
		return h.finalizeReadTimeout
	}
	return defaultTikTokFinalizeReadTimeout
}

func (h *Handler) serveTikTokHelper(w http.ResponseWriter, r *http.Request) {
	if h.tiktokFinalizer == nil {
		sendError(w, 404, "接口不存在")
		return
	}
	if allowed, _ := h.enforcePlatformPolicy(w, r, tiktokHelper, "tiktok"); !allowed {
		return
	}
	if r.URL.EscapedPath() != "/api/tiktok/finalize" {
		sendError(w, 404, "接口不存在")
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		sendError(w, 405, "仅支持 POST 请求")
		return
	}
	version, scalar := queryValue(r.URL.RawQuery, "schema_version")
	if !scalar || version != unified.SchemaVersion {
		sendError(w, 409, schemaVersionConflictMessage(r.Context()))
		return
	}
	if r.Body == nil {
		if r.ProtoMajor == 1 {
			r.Close = true
			w.Header().Set("Connection", "close")
		}
		sendError(w, 400, "请求体不能为空")
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(h.tiktokFinalizeReadTimeout()))
	limitedBody := http.MaxBytesReader(w, r.Body, maxTikTokFinalizeBodyBytes)
	body, err := io.ReadAll(limitedBody)
	if err != nil {
		if r.ProtoMajor == 1 {
			r.Close = true
			w.Header().Set("Connection", "close")
		}
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			sendError(w, 400, "请求体超出 512 KiB 限制")
		} else {
			sendError(w, 400, "读取请求体失败")
		}
		if r.ProtoMajor == 1 {
			_ = controller.SetReadDeadline(time.Now())
		}
		_ = limitedBody.Close()
		return
	}
	if err := limitedBody.Close(); err != nil {
		if r.ProtoMajor == 1 {
			r.Close = true
			w.Header().Set("Connection", "close")
		}
		sendError(w, 400, "读取请求体失败")
		return
	}
	_ = controller.SetReadDeadline(time.Time{})
	debug, _ := queryValue(r.URL.RawQuery, "debug")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	payload, status := h.tiktokFinalizer.Finalize(ctx, body, debug == "1")
	send(w, status, payload)
}
