package api

import (
	"time"

	"github.com/Brilliant666/DokiTool-Go/backend/internal/shresolver"
)

// shanghaiZone is a fixed UTC+8 location with zero host tzdata dependency.
var shanghaiZone = time.FixedZone("Asia/Shanghai", int(shanghaiOffsetSeconds))

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b < 0 {
		q--
	}
	return q
}

func shanghaiDayID(t time.Time) int64 {
	return floorDiv(t.Unix()+shanghaiOffsetSeconds, 86400)
}

func formatShanghaiDayID(dayID int64) string {
	return time.Unix(dayID*86400, 0).UTC().Format("2006-01-02")
}

func shanghaiHourID(t time.Time) int64 {
	return floorDiv(t.Unix(), 3600)
}

func formatShanghaiHourID(hourID int64) string {
	return time.Unix(hourID*3600, 0).In(shanghaiZone).Format(time.RFC3339)
}

func dailySlotIndex(dayID int64) int {
	mod := dayID % DailyStatsWindowDays
	if mod < 0 {
		mod += DailyStatsWindowDays
	}
	return int(mod)
}

func hourlySlotIndex(hourID int64) int {
	mod := hourID % HourlyStatsWindowHours
	if mod < 0 {
		mod += HourlyStatsWindowHours
	}
	return int(mod)
}

type dailyPlatformRecord struct {
	byCode      [numOutcomeCodes]uint64
	latencyBins [11]uint64
	maxMS       uint64
}

func (r *dailyPlatformRecord) snapshot() (DailyPlatformStats, bool) {
	if r == nil {
		return DailyPlatformStats{}, false
	}
	var total uint64
	byCode := make(map[string]uint64, 4)
	for c := 0; c < numOutcomeCodes; c++ {
		if n := r.byCode[c]; n > 0 {
			total += n
			byCode[knownOutcomeCodes[c]] = n
		}
	}
	if total == 0 {
		return DailyPlatformStats{}, false
	}
	okCount := r.byCode[outcomeOKIdx]
	return DailyPlatformStats{
		Total:  total,
		OK:     okCount,
		Failed: total - okCount,
		ByCode: byCode,
		P95MS:  computeLatencyQuantileMS(r.latencyBins, r.maxMS, 95),
	}, true
}

type dailyBucket struct {
	valid        bool
	dayID        int64
	total        uint64
	ok           uint64
	failed       uint64
	cacheHits    uint64
	shanghaiHits uint64
	latencyBins  [11]uint64
	maxMS        uint64
	byPlatform   map[string]*dailyPlatformRecord
}

func (b *dailyBucket) reset(dayID int64) {
	*b = dailyBucket{
		valid: true,
		dayID: dayID,
	}
}

func (b *dailyBucket) getOrCreatePlatform(platform string) *dailyPlatformRecord {
	if b.byPlatform == nil {
		b.byPlatform = make(map[string]*dailyPlatformRecord, 4)
	}
	rec := b.byPlatform[platform]
	if rec == nil {
		rec = &dailyPlatformRecord{}
		b.byPlatform[platform] = rec
	}
	return rec
}

func (b *dailyBucket) snapshotForDay(dayID int64) DailyStatsBucket {
	out := DailyStatsBucket{
		Date:       formatShanghaiDayID(dayID),
		ByPlatform: make(map[string]DailyPlatformStats),
	}
	if !b.valid || b.dayID != dayID {
		return out
	}
	out.Total = b.total
	out.OK = b.ok
	out.Failed = b.failed
	out.CacheHits = b.cacheHits
	out.ShanghaiHits = b.shanghaiHits
	out.LatencyMS = DailyLatencySummary{
		P50MS: computeLatencyQuantileMS(b.latencyBins, b.maxMS, 50),
		P95MS: computeLatencyQuantileMS(b.latencyBins, b.maxMS, 95),
		MaxMS: b.maxMS,
	}
	for plat, rec := range b.byPlatform {
		if ps, nonZero := rec.snapshot(); nonZero {
			out.ByPlatform[plat] = ps
		}
	}
	return out
}

type hourlyBucket struct {
	valid     bool
	hourID    int64
	total     uint64
	ok        uint64
	failed    uint64
	cacheHits uint64
}

func (b *hourlyBucket) reset(hourID int64) {
	*b = hourlyBucket{
		valid:  true,
		hourID: hourID,
	}
}

func (b *hourlyBucket) snapshotForHour(hourID int64) HourlyStatsBucket {
	out := HourlyStatsBucket{
		HourStart: formatShanghaiHourID(hourID),
	}
	if !b.valid || b.hourID != hourID {
		return out
	}
	out.Total = b.total
	out.OK = b.ok
	out.Failed = b.failed
	out.CacheHits = b.cacheHits
	return out
}

func emptyDailyBuckets(now time.Time) []DailyStatsBucket {
	todayID := shanghaiDayID(now)
	out := make([]DailyStatsBucket, DailyStatsWindowDays)
	for i := 0; i < DailyStatsWindowDays; i++ {
		dID := todayID - int64(DailyStatsWindowDays-1-i)
		out[i] = DailyStatsBucket{
			Date:       formatShanghaiDayID(dID),
			ByPlatform: make(map[string]DailyPlatformStats),
		}
	}
	return out
}

func emptyHourlyBuckets(now time.Time) []HourlyStatsBucket {
	curHourID := shanghaiHourID(now)
	out := make([]HourlyStatsBucket, HourlyStatsWindowHours)
	for i := 0; i < HourlyStatsWindowHours; i++ {
		hID := curHourID - int64(HourlyStatsWindowHours-1-i)
		out[i] = HourlyStatsBucket{
			HourStart: formatShanghaiHourID(hID),
		}
	}
	return out
}

func (s *Stats) getDailyBucketLocked(now time.Time) *dailyBucket {
	dayID := shanghaiDayID(now)
	b := &s.daily[dailySlotIndex(dayID)]
	if !b.valid || b.dayID != dayID {
		b.reset(dayID)
	}
	return b
}

func (s *Stats) getHourlyBucketLocked(now time.Time) *hourlyBucket {
	hourID := shanghaiHourID(now)
	b := &s.hourly[hourlySlotIndex(hourID)]
	if !b.valid || b.hourID != hourID {
		b.reset(hourID)
	}
	return b
}

func (s *Stats) recordWindowOutcomeLocked(now time.Time, platform string, cIdx int, elapsed time.Duration) {
	db := s.getDailyBucketLocked(now)
	db.total++
	if cIdx == outcomeOKIdx {
		db.ok++
	} else {
		db.failed++
	}
	observeLatencyBins(&db.latencyBins, &db.maxMS, elapsed)
	prec := db.getOrCreatePlatform(platform)
	prec.byCode[cIdx]++
	observeLatencyBins(&prec.latencyBins, &prec.maxMS, elapsed)

	hb := s.getHourlyBucketLocked(now)
	hb.total++
	if cIdx == outcomeOKIdx {
		hb.ok++
	} else {
		hb.failed++
	}
}

func (s *Stats) readShanghaiSnapshot() (shresolver.StatsSnapshot, uint64, bool) {
	if s == nil || !s.hasShSrc.Load() {
		return shresolver.StatsSnapshot{Mode: "off"}, 0, false
	}
	s.mu.RLock()
	shSrc := s.shSrc
	gen := s.shSrcGen
	s.mu.RUnlock()
	if shSrc == nil {
		return shresolver.StatsSnapshot{Mode: "off"}, gen, false
	}
	return shSrc.ShanghaiStatsSnapshot(), gen, true
}

func (s *Stats) applyShanghaiDeltaLocked(now time.Time, shSnap shresolver.StatsSnapshot, shGen uint64, hasSh bool) {
	if !hasSh || s.shSrc == nil || s.shSrcGen != shGen {
		return
	}
	curHits := shSnap.Total.Hits
	if curHits > s.lastSyncedShanghaiHits {
		delta := curHits - s.lastSyncedShanghaiHits
		s.lastSyncedShanghaiHits = curHits
		s.getDailyBucketLocked(now).shanghaiHits += delta
	}
}

func (s *Stats) syncShanghaiHits(now time.Time) {
	if s == nil || !s.hasShSrc.Load() {
		return
	}
	shSnap, shGen, hasSh := s.readShanghaiSnapshot()
	if !hasSh {
		return
	}
	s.mu.Lock()
	s.applyShanghaiDeltaLocked(now, shSnap, shGen, hasSh)
	s.mu.Unlock()
}
