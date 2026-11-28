package api

import (
	"net/http"
)

// RuntimeConfigObserver is notified whenever ApplyRuntimeConfig applies a validated
// startup or SIGHUP runtime policy update. Subsystems that hold platform caches or
// background refresh loops register an observer so emergency switches (such as
// disabled_platforms) propagate automatically without ad-hoc callsite wiring.
type RuntimeConfigObserver interface {
	OnRuntimeConfig(cfg RuntimeConfig)
}

// RuntimeConfigObserverFunc adapts a function to RuntimeConfigObserver.
type RuntimeConfigObserverFunc func(cfg RuntimeConfig)

// OnRuntimeConfig invokes f(cfg).
func (f RuntimeConfigObserverFunc) OnRuntimeConfig(cfg RuntimeConfig) {
	if f != nil {
		f(cfg)
	}
}

// routePolicy declares the platform governance invariants for each route kind in
// classify(). Exhaustive coverage across 0..routeCount-1 is enforced by unit tests
// so newly added platform subsystems cannot bypass kill-switch or credential checks.
type routePolicy struct {
	staticPlatform      string
	dynamicPlatform     bool
	enforceKillSwitch   bool
	enforcePlatformAuth bool
	nonPlatformReason   string
}

var routePolicies = [routeCount]routePolicy{
	unknown: {
		nonPlatformReason: "rejected with 404 before platform dispatch",
	},
	parser: {
		dynamicPlatform:     true,
		enforceKillSwitch:   true,
		enforcePlatformAuth: true,
	},
	catalogRoute: {
		nonPlatformReason: "public static platform capability catalog",
	},
	legacy: {
		nonPlatformReason: "deprecated 410 endpoints performing zero upstream calls",
	},
	telemetry: {
		nonPlatformReason: "anonymous client download telemetry receiver",
	},
	youtubeHelper: {
		staticPlatform:      "youtube",
		enforceKillSwitch:   true,
		enforcePlatformAuth: true,
	},
	tiktokHelper: {
		staticPlatform:      "tiktok",
		enforceKillSwitch:   true,
		enforcePlatformAuth: true,
	},
	statsRoute: {
		nonPlatformReason: "owner-only operational telemetry endpoint",
	},
}

func policyForRoute(kind route) routePolicy {
	if kind < 0 || kind >= routeCount {
		return routePolicies[unknown]
	}
	return routePolicies[kind]
}

// enforcePlatformPolicy is the single mandatory platform gate enforced across all
// platform-scoped routes (parse/resolve, YouTube helper, Weibo relay, and any future
// platform subsystem). When rejected it writes the canonical HTTP response and
// returns allowed=false; callers must stop processing immediately.
func (h *Handler) enforcePlatformPolicy(w http.ResponseWriter, r *http.Request, kind route, platform string) (allowed bool, rejectedCode string) {
	pol := policyForRoute(kind)
	if platform == "" {
		platform = pol.staticPlatform
	}
	if platform == "" {
		return true, ""
	}

	if pol.enforcePlatformAuth && !authAllowsPlatform(r.Context(), platform) {
		if authKey, viaAdm := authKeyFromContext(r.Context()); authKey != nil && !viaAdm {
			authKey.recordUnauthorized()
		}
		sendError(w, http.StatusUnauthorized, "当前凭据无权访问该平台")
		return false, OutcomeUnauthorized
	}

	if pol.enforceKillSwitch && h != nil && h.cb.IsDisabled(platform) {
		res := circuitBreakerOpenResponse(platform, disabledPlatformRetryAfterSeconds)
		writeResponse(w, res)
		return false, res.code
	}

	return true, ""
}
