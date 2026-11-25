package api

import (
	"slices"
	"strings"
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/unified"
	"github.com/Brilliant666/DokiTool-Go/backend/internal/ytengine"
)

func sanitizeVersionString(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "unknown"
	}
	var b strings.Builder
	b.Grow(len(trimmed))
	for i := 0; i < len(trimmed); i++ {
		c := trimmed[i]
		if c >= 0x20 && c != 0x7f {
			b.WriteByte(c)
		}
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return "unknown"
	}
	if len(out) > 64 {
		out = out[:64]
	}
	return out
}

func normalizeShanghaiMode(raw string) string {
	switch raw {
	case "direct", "pull":
		return raw
	default:
		return "off"
	}
}

func normalizeXHSTransport(raw string) string {
	if raw == "chrome131" {
		return "chrome131"
	}
	return "standard"
}

func normalizeRuntimeConfig(cfg RuntimeConfigSnapshot, shSnap shresolver.StatsSnapshot, hasShSrc bool) RuntimeConfigSnapshot {
	cfg.Version = sanitizeVersionString(cfg.Version)
	cfg.ShanghaiMode = normalizeShanghaiMode(cfg.ShanghaiMode)
	if cfg.ShanghaiMode == "off" && hasShSrc {
		if inferred := normalizeShanghaiMode(shSnap.Mode); inferred != "off" {
			cfg.ShanghaiMode = inferred
		}
	}
	cfg.XHSTransport = normalizeXHSTransport(cfg.XHSTransport)
	return cfg
}

func buildYTDLPCompartmentSnapshot(
	admPool AdmissionPoolSnapshot,
	hasAdm bool,
	slotSrc YTDLPStatsSource,
	fallbackEnabled bool,
) YTDLPCompartmentPoolSnapshot {
	out := YTDLPCompartmentPoolSnapshot{
		Enabled:          fallbackEnabled,
		Active:           admPool.Active,
		Queued:           admPool.Queued,
		ConcurrencyLimit: admPool.ConcurrencyLimit,
		QueueLimit:       admPool.QueueLimit,
		Waited:           admPool.Waited,
		Granted:          admPool.Granted,
		Timeout:          admPool.Timeout,
		Full:             admPool.Full,
		Canceled:         admPool.Canceled,
		WaitMSTotal:      admPool.WaitMSTotal,
		WaitMSMax:        admPool.WaitMSMax,
	}
	if slotSrc != nil {
		slotSnap := slotSrc.StatsSnapshot()
		out.Enabled = slotSnap.Enabled
		if !hasAdm {
			out.Active = slotSnap.Active
			out.Queued = slotSnap.Waiting
			out.ConcurrencyLimit = slotSnap.ConcurrencyLimit
			out.Waited = slotSnap.Total.WaitCount
			out.WaitMSTotal = slotSnap.Total.WaitMSTotal
			out.WaitMSMax = slotSnap.Total.WaitMSMax
		} else {
			if slotSnap.Active > out.Active {
				out.Active = slotSnap.Active
			}
			if slotSnap.Waiting > out.Queued {
				out.Queued = slotSnap.Waiting
			}
		}
	}
	return out
}

// Snapshot captures a point-in-time read-only view of all aggregate counters and gauges.
func (s *Stats) Snapshot() StatsSnapshot {
	if s == nil {
		nowRaw := time.Now()
		nowStr := nowRaw.UTC().Format(time.RFC3339)
		shOff := shresolver.StatsSnapshot{Mode: "off"}
		return StatsSnapshot{
			StartedAt:   nowStr,
			GeneratedAt: nowStr,
			Requests: RequestStatsSnapshot{
				ByPlatformCodeChannel: make([]PlatformOutcomeCount, 0),
			},
			APIKeys:         make([]APIKeyStatsSnapshot, 0),
			CircuitBreakers: (*circuitBreakerManager)(nil).Snapshot(nowRaw),
			RuntimePolicy:   defaultRuntimePolicySummary(),
			Shanghai:        shOff,
			Runtime:         normalizeRuntimeConfig(RuntimeConfigSnapshot{}, shOff, false),
			Daily:           emptyDailyBuckets(nowRaw),
			Hourly:          emptyHourlyBuckets(nowRaw),
		}
	}

	nowRaw := s.now()
	now := nowRaw.UTC()
	uptime := int64(now.Sub(s.startedAt).Seconds())
	if uptime < 0 {
		uptime = 0
	}

	var anonReq, ownerReq uint64
	cells := make([]PlatformOutcomeCount, 0, 16)
	for p := 0; p < numPlatforms; p++ {
		for c := 0; c < numOutcomeCodes; c++ {
			anonCount := s.outcomes[p][c][chAnonIdx].Load()
			if anonCount > 0 {
				anonReq += anonCount
				cells = append(cells, PlatformOutcomeCount{
					Platform: knownPlatforms[p],
					Code:     knownOutcomeCodes[c],
					Channel:  ChannelAnonymous,
					Count:    anonCount,
				})
			}
			ownerCount := s.outcomes[p][c][chOwnerIdx].Load()
			if ownerCount > 0 {
				ownerReq += ownerCount
				cells = append(cells, PlatformOutcomeCount{
					Platform: knownPlatforms[p],
					Code:     knownOutcomeCodes[c],
					Channel:  ChannelOwner,
					Count:    ownerCount,
				})
			}
		}
	}

	cacheAnon := s.cacheCh[chAnonIdx].snapshot()
	cacheOwner := s.cacheCh[chOwnerIdx].snapshot()
	cacheSnap := CacheStatsSnapshot{
		Total: CacheChannelCounts{
			Hits:               cacheAnon.Hits + cacheOwner.Hits,
			StaleHits:          cacheAnon.StaleHits + cacheOwner.StaleHits,
			Misses:             cacheAnon.Misses + cacheOwner.Misses,
			SingleflightShared: cacheAnon.SingleflightShared + cacheOwner.SingleflightShared,
			Uncacheable:        cacheAnon.Uncacheable + cacheOwner.Uncacheable,
		},
		ByChannel: CacheChannelBreakdown{
			Anonymous: cacheAnon,
			Owner:     cacheOwner,
		},
	}

	s.mu.RLock()
	cacheSrc := s.cacheSrc
	admSrc := s.admSrc
	cbSrc := s.cbSrc
	ytdlpSrc := s.ytdlpSrc
	ytdlpGenericSrc := s.ytdlpGenericSrc
	ytdlpCompartmentsWired := s.ytdlpCompartmentsWired
	ytdlpYoutubeSrc := s.ytdlpYoutubeSrc
	ytdlpSocialSrc := s.ytdlpSocialSrc
	ytdlpGenericCompSrc := s.ytdlpGenericCompSrc
	ytHelperSrc := s.ytHelperSrc
	shSrc := s.shSrc
	shGen := s.shSrcGen
	s.mu.RUnlock()

	if cacheSrc != nil {
		cacheSnap.Enabled, cacheSnap.Entries, cacheSnap.Bytes, cacheSnap.MaxEntries, cacheSnap.MaxBytes = cacheSrc.configSnapshot()
	}

	var admSnap AdmissionStatsSnapshot
	var admYT, admSocial, admGeneric, admEJS AdmissionPoolSnapshot
	apiKeys := make([]APIKeyStatsSnapshot, 0)
	if admSrc != nil {
		admSnap = admSrc.statsSnapshot()
		admYT, admSocial, admGeneric, admEJS = admSrc.compartmentAdmissionSnapshots()
		apiKeys = admSrc.apiKeysStatsSnapshot()
	}

	var ytdlpSnap ytengine.SlotStatsSnapshot
	if ytdlpSrc != nil {
		ytdlpSnap = ytdlpSrc.StatsSnapshot()
	}

	var ytdlpGenericSnap ytengine.SlotStatsSnapshot
	if ytdlpGenericSrc != nil {
		ytdlpGenericSnap = ytdlpGenericSrc.StatsSnapshot()
	}

	var ytHelperSnap YouTubeHelperStatsSnapshot
	if ytHelperSrc != nil {
		ytHelperSnap = ytHelperSrc.HelperStatsSnapshot()
	}

	cbSnaps := cbSrc.Snapshot(nowRaw)

	shSnap := shresolver.StatsSnapshot{Mode: "off"}
	if shSrc != nil {
		shSnap = shSrc.ShanghaiStatsSnapshot()
	}

	s.mu.Lock()
	s.applyShanghaiDeltaLocked(nowRaw, shSnap, shGen, shSrc != nil)

	if len(s.dynamicPlatforms) > 0 {
		dynKeys := make([]string, 0, len(s.dynamicPlatforms))
		for k := range s.dynamicPlatforms {
			dynKeys = append(dynKeys, k)
		}
		slices.Sort(dynKeys)
		for _, k := range dynKeys {
			rec := s.dynamicPlatforms[k]
			for c := 0; c < numOutcomeCodes; c++ {
				if anonCount := rec.outcomes[c][chAnonIdx]; anonCount > 0 {
					anonReq += anonCount
					cells = append(cells, PlatformOutcomeCount{
						Platform: k,
						Code:     knownOutcomeCodes[c],
						Channel:  ChannelAnonymous,
						Count:    anonCount,
					})
				}
				if ownerCount := rec.outcomes[c][chOwnerIdx]; ownerCount > 0 {
					ownerReq += ownerCount
					cells = append(cells, PlatformOutcomeCount{
						Platform: k,
						Code:     knownOutcomeCodes[c],
						Channel:  ChannelOwner,
						Count:    ownerCount,
					})
				}
			}
		}
	}
	for c := 0; c < numOutcomeCodes; c++ {
		if anonCount := s.dynamicOther.outcomes[c][chAnonIdx]; anonCount > 0 {
			anonReq += anonCount
			cells = append(cells, PlatformOutcomeCount{
				Platform: PlatformYTDLPOther,
				Code:     knownOutcomeCodes[c],
				Channel:  ChannelAnonymous,
				Count:    anonCount,
			})
		}
		if ownerCount := s.dynamicOther.outcomes[c][chOwnerIdx]; ownerCount > 0 {
			ownerReq += ownerCount
			cells = append(cells, PlatformOutcomeCount{
				Platform: PlatformYTDLPOther,
				Code:     knownOutcomeCodes[c],
				Channel:  ChannelOwner,
				Count:    ownerCount,
			})
		}
	}
	for c := 0; c < numOutcomeCodes; c++ {
		if anonCount := s.dynamicUnmatched.outcomes[c][chAnonIdx]; anonCount > 0 {
			anonReq += anonCount
			cells = append(cells, PlatformOutcomeCount{
				Platform: PlatformYTDLPUnmatched,
				Code:     knownOutcomeCodes[c],
				Channel:  ChannelAnonymous,
				Count:    anonCount,
			})
		}
		if ownerCount := s.dynamicUnmatched.outcomes[c][chOwnerIdx]; ownerCount > 0 {
			ownerReq += ownerCount
			cells = append(cells, PlatformOutcomeCount{
				Platform: PlatformYTDLPUnmatched,
				Code:     knownOutcomeCodes[c],
				Channel:  ChannelOwner,
				Count:    ownerCount,
			})
		}
	}

	todayID := shanghaiDayID(nowRaw)
	daily := make([]DailyStatsBucket, DailyStatsWindowDays)
	for i := 0; i < DailyStatsWindowDays; i++ {
		dID := todayID - int64(DailyStatsWindowDays-1-i)
		daily[i] = s.daily[dailySlotIndex(dID)].snapshotForDay(dID)
	}

	curHourID := shanghaiHourID(nowRaw)
	hourly := make([]HourlyStatsBucket, HourlyStatsWindowHours)
	for i := 0; i < HourlyStatsWindowHours; i++ {
		hID := curHourID - int64(HourlyStatsWindowHours-1-i)
		hourly[i] = s.hourly[hourlySlotIndex(hID)].snapshotForHour(hID)
	}

	runtimeCfg := normalizeRuntimeConfig(s.runtimeCfg, shSnap, shSrc != nil)
	runtimePolicy := cloneRuntimePolicySummary(s.runtimePolicy)
	s.mu.Unlock()

	genericSrcForComp := ytdlpGenericCompSrc
	if !ytdlpCompartmentsWired && genericSrcForComp == nil {
		genericSrcForComp = ytdlpGenericSrc
	}
	ytFallbackEnabled := !ytdlpCompartmentsWired && (runtimeCfg.YTDLPEnabled || ytdlpSnap.Enabled)
	socialFallbackEnabled := !ytdlpCompartmentsWired && (runtimeCfg.YTDLPEnabled || ytdlpSnap.Enabled)
	genericFallbackEnabled := !ytdlpCompartmentsWired && (runtimeCfg.YTDLPGenericEnabled || ytdlpGenericSnap.Enabled)
	ytdlpPools := YTDLPPoolsSnapshot{
		YouTube:    buildYTDLPCompartmentSnapshot(admYT, admSrc != nil, ytdlpYoutubeSrc, ytFallbackEnabled),
		Social:     buildYTDLPCompartmentSnapshot(admSocial, admSrc != nil, ytdlpSocialSrc, socialFallbackEnabled),
		Generic:    buildYTDLPCompartmentSnapshot(admGeneric, admSrc != nil, genericSrcForComp, genericFallbackEnabled),
		YouTubeEJS: buildYTDLPCompartmentSnapshot(admEJS, admSrc != nil, nil, runtimeCfg.YouTubeHelper),
	}

	latAnon := s.latency[chAnonIdx].snapshot()
	latOwner := s.latency[chOwnerIdx].snapshot()
	latTotal := mergeHistograms(latAnon, latOwner)

	return StatsSnapshot{
		StartedAt:     s.startedAt.Format(time.RFC3339),
		GeneratedAt:   now.Format(time.RFC3339),
		UptimeSeconds: uptime,
		Requests: RequestStatsSnapshot{
			Total:                 anonReq + ownerReq,
			ByChannel:             RequestChannelBreakdown{Anonymous: anonReq, Owner: ownerReq},
			ByPlatformCodeChannel: cells,
		},
		Cache:           cacheSnap,
		Admission:       admSnap,
		APIKeys:         apiKeys,
		YTDLP:           ytdlpSnap,
		YTDLPGeneric:    ytdlpGenericSnap,
		YTDLPPools:      ytdlpPools,
		YouTubeHelper:   ytHelperSnap,
		CircuitBreakers: cbSnaps,
		RuntimePolicy:   runtimePolicy,
		Shanghai:        shSnap,
		ParseLatencyMS: LatencyStatsSnapshot{
			Total:     latTotal,
			ByChannel: LatencyChannelBreakdown{Anonymous: latAnon, Owner: latOwner},
		},
		Runtime: runtimeCfg,
		Daily:   daily,
		Hourly:  hourly,
	}
}

// Envelope wraps Snapshot in the standard DokiTool JSON envelope for GET /api/stats.
func (s *Stats) Envelope() unified.Object {
	return unified.Object{
		"schema_version": unified.SchemaVersion,
		"code":           "OK",
		"data":           s.Snapshot(),
	}
}
