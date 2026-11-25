package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"slices"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
)

// YouTubeHelper serves /api/youtube/context and /api/youtube/finalize when
// DOKITOOL_YOUTUBE_HELPER is enabled and runtime verification succeeds.
type YouTubeHelper interface {
	Context(context.Context) (unified.Object, int)
	Finalize(ctx context.Context, body []byte, debug bool) (unified.Object, int)
}

// SetYouTubeHelper registers the browser-assisted YouTube context/finalize handler.
// When unset, /api/youtube/context and /api/youtube/finalize return 404.
// Registration automatically binds runtime kill-switch/circuit-breaker governance
// and /api/stats telemetry so callers cannot forget cross-cutting wiring.
func (h *Handler) SetYouTubeHelper(helper YouTubeHelper) {
	if h == nil {
		return
	}
	h.youtubeHelper = helper
	if helper == nil {
		h.stats.SetYouTubeHelperSource(nil)
		return
	}
	if src, ok := helper.(YouTubeHelperStatsSource); ok {
		h.stats.SetYouTubeHelperSource(src)
	}
	if gated, ok := helper.(interface{ SetUpstreamAllowed(func() bool) }); ok {
		gated.SetUpstreamAllowed(func() bool {
			return !h.cb.IsDisabled("youtube") && !h.cb.IsOpen("youtube", h.now())
		})
	}
	if toggle, ok := helper.(interface{ SetEnabled(bool) }); ok {
		toggle.SetEnabled(!h.cb.IsDisabled("youtube"))
		h.RegisterRuntimeConfigObserver(RuntimeConfigObserverFunc(func(cfg RuntimeConfig) {
			toggle.SetEnabled(!slices.Contains(cfg.CircuitBreaker.DisabledPlatforms, "youtube"))
		}))
	}
}

// HasCachedYouTubeContext reports whether the configured YouTube helper currently
// holds a fresh in-memory player context that can be served without upstream/Deno work.
func (h *Handler) HasCachedYouTubeContext() bool {
	if h == nil || h.youtubeHelper == nil || h.cb.IsDisabled("youtube") {
		return false
	}
	if checker, ok := h.youtubeHelper.(interface{ HasCachedContext() bool }); ok {
		return checker.HasCachedContext()
	}
	return false
}

const (
	maxYouTubeFinalizeBodyBytes       = 512 << 10
	defaultYouTubeFinalizeReadTimeout = 5 * time.Second
)

func (h *Handler) youtubeFinalizeReadTimeout() time.Duration {
	if h != nil && h.finalizeReadTimeout > 0 {
		return h.finalizeReadTimeout
	}
	return defaultYouTubeFinalizeReadTimeout
}

func (h *Handler) serveYouTubeHelper(w http.ResponseWriter, r *http.Request) {
	if h.youtubeHelper == nil {
		sendError(w, 404, "接口不存在")
		return
	}
	if allowed, _ := h.enforcePlatformPolicy(w, r, youtubeHelper, "youtube"); !allowed {
		return
	}
	switch r.URL.EscapedPath() {
	case "/api/youtube/context":
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			sendError(w, 405, "仅支持 GET 请求")
			return
		}
		version, scalar := queryValue(r.URL.RawQuery, "schema_version")
		if !scalar || version != unified.SchemaVersion {
			sendError(w, 409, schemaVersionConflictMessage(r.Context()))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		payload, status := h.youtubeHelper.Context(ctx)
		send(w, status, payload)
	case "/api/youtube/finalize":
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
		_ = controller.SetReadDeadline(time.Now().Add(h.youtubeFinalizeReadTimeout()))
		limitedBody := http.MaxBytesReader(w, r.Body, maxYouTubeFinalizeBodyBytes)
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
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		payload, status := h.youtubeHelper.Finalize(ctx, body, debug == "1")
		send(w, status, payload)
	default:
		sendError(w, 404, "接口不存在")
	}
}
