package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	// EnvStatsSnapshotPath optionally configures the local JSON file used to persist
	// Asia/Shanghai 30-day daily and 24-hour hourly aggregate stats across restarts.
	// Empty (default) disables disk persistence and keeps stats purely in memory.
	EnvStatsSnapshotPath = "DOKITOOL_STATS_SNAPSHOT_PATH"

	// DefaultStatsSnapshotInterval is the periodic flush interval for stats snapshot persistence.
	DefaultStatsSnapshotInterval = 5 * time.Minute

	// MaxStatsSnapshotBytes caps stats snapshot reads at 2 MiB.
	MaxStatsSnapshotBytes = 2 << 20

	statsSnapshotSchemaVersion = 1
	statsSnapshotTimezone      = "Asia/Shanghai"
)

type persistedDailyPlatform struct {
	Total       uint64            `json:"total"`
	OK          uint64            `json:"ok"`
	Failed      uint64            `json:"failed"`
	ByCode      map[string]uint64 `json:"by_code"`
	LatencyBins [11]uint64        `json:"latency_bins"`
	MaxMS       uint64            `json:"max_ms"`
}

type persistedDailyBucket struct {
	Date         string                            `json:"date"`
	Total        uint64                            `json:"total"`
	OK           uint64                            `json:"ok"`
	Failed       uint64                            `json:"failed"`
	CacheHits    uint64                            `json:"cache_hits"`
	ShanghaiHits uint64                            `json:"shanghai_hits"`
	LatencyBins  [11]uint64                        `json:"latency_bins"`
	MaxMS        uint64                            `json:"max_ms"`
	ByPlatform   map[string]persistedDailyPlatform `json:"by_platform"`
}

type persistedHourlyBucket struct {
	HourStart string `json:"hour_start"`
	Total     uint64 `json:"total"`
	OK        uint64 `json:"ok"`
	Failed    uint64 `json:"failed"`
	CacheHits uint64 `json:"cache_hits"`
}

type persistedStatsSnapshot struct {
	SchemaVersion    int                     `json:"schema_version"`
	Timezone         string                  `json:"timezone"`
	SavedAt          string                  `json:"saved_at"`
	Daily            []persistedDailyBucket  `json:"daily"`
	Hourly           []persistedHourlyBucket `json:"hourly"`
	DynamicPlatforms []string                `json:"dynamic_platforms"`
}

func parseShanghaiDateStrict(raw string) (int64, bool) {
	if len(raw) != 10 {
		return 0, false
	}
	t, err := time.ParseInLocation("2006-01-02", raw, shanghaiZone)
	if err != nil || t.Format("2006-01-02") != raw {
		return 0, false
	}
	return shanghaiDayID(t), true
}

func parseShanghaiHourStrict(raw string) (int64, bool) {
	if raw == "" || len(raw) > 40 {
		return 0, false
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return 0, false
	}
	if t.Minute() != 0 || t.Second() != 0 || t.Nanosecond() != 0 {
		return 0, false
	}
	return shanghaiHourID(t), true
}

func readBoundedStatsSnapshotFile(path string) ([]byte, bool, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		if errors.Is(err, os.ErrPermission) {
			return nil, true, errors.New("stats snapshot file permission denied")
		}
		return nil, true, errors.New("failed to open stats snapshot file")
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, true, errors.New("failed to stat stats snapshot file")
	}
	if !info.Mode().IsRegular() {
		return nil, true, errors.New("stats snapshot path must be a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxStatsSnapshotBytes+1))
	if err != nil {
		return nil, true, errors.New("failed to read stats snapshot file")
	}
	if len(data) > MaxStatsSnapshotBytes {
		return nil, true, fmt.Errorf("stats snapshot exceeds %d bytes", MaxStatsSnapshotBytes)
	}
	return data, true, nil
}

// LoadSnapshot loads non-expired Asia/Shanghai 30-day daily buckets, 24-hour hourly buckets,
// and bounded dynamic platform keys from path.
// An empty path or missing file is treated as a clean cold start (returns nil).
// On read, size, JSON, schema version, or timestamp errors, LoadSnapshot logs a safe warning
// via logf without disclosing local paths or sensitive data, leaves Stats unchanged, and returns the error.
func (s *Stats) LoadSnapshot(path string, logf func(string, ...any)) error {
	if s == nil {
		return nil
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}
	warn := func(err error) error {
		if logf != nil {
			logf("dokitool: stats snapshot load skipped (starting with empty history): %v", err)
		}
		return err
	}

	raw, exists, err := readBoundedStatsSnapshotFile(path)
	if err != nil {
		return warn(err)
	}
	if !exists {
		return nil
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return warn(errors.New("stats snapshot must contain a JSON object"))
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	var doc persistedStatsSnapshot
	if err := dec.Decode(&doc); err != nil {
		return warn(errors.New("stats snapshot JSON decode failed"))
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return warn(errors.New("stats snapshot must contain a single JSON object"))
	}
	if doc.SchemaVersion != statsSnapshotSchemaVersion {
		return warn(fmt.Errorf("unsupported stats snapshot schema_version=%d", doc.SchemaVersion))
	}
	if doc.Timezone != "" && doc.Timezone != statsSnapshotTimezone {
		return warn(errors.New("unsupported stats snapshot timezone"))
	}

	now := s.now()
	todayID := shanghaiDayID(now)
	minDayID := todayID - int64(DailyStatsWindowDays-1)
	curHourID := shanghaiHourID(now)
	minHourID := curHourID - int64(HourlyStatsWindowHours-1)

	newDyn := make(map[string]*dynamicPlatformCounters)
	for _, rawKey := range doc.DynamicPlatforms {
		if corePlatformIndex(rawKey) >= 0 || rawKey == PlatformYTDLPOther {
			continue
		}
		if !IsValidDynamicPlatformKey(rawKey) {
			continue
		}
		if _, exists := newDyn[rawKey]; !exists && len(newDyn) < MaxDynamicPlatforms {
			newDyn[rawKey] = &dynamicPlatformCounters{}
		}
	}

	var newDaily [DailyStatsWindowDays]dailyBucket
	loadedDays := 0
	for _, d := range doc.Daily {
		dayID, ok := parseShanghaiDateStrict(d.Date)
		if !ok {
			return warn(errors.New("stats snapshot contains invalid daily date"))
		}
		if dayID < minDayID || dayID > todayID {
			continue
		}
		slot := &newDaily[dailySlotIndex(dayID)]
		if !slot.valid || slot.dayID != dayID {
			slot.reset(dayID)
			loadedDays++
		}

		var platOKSum, platFailedSum uint64
		for rawPlat, pStats := range d.ByPlatform {
			normPlat := PlatformUnknown
			if corePlatformIndex(rawPlat) >= 0 {
				normPlat = rawPlat
			} else if rawPlat == PlatformYTDLPOther {
				normPlat = PlatformYTDLPOther
			} else if IsValidDynamicPlatformKey(rawPlat) {
				if _, exists := newDyn[rawPlat]; exists {
					normPlat = rawPlat
				} else if len(newDyn) < MaxDynamicPlatforms {
					newDyn[rawPlat] = &dynamicPlatformCounters{}
					normPlat = rawPlat
				} else {
					normPlat = PlatformYTDLPOther
				}
			}

			var codeCounts [numOutcomeCodes]uint64
			var codeSum uint64
			for rawCode, cnt := range pStats.ByCode {
				if cnt == 0 {
					continue
				}
				cIdx := outcomeCodeIndex(rawCode)
				codeCounts[cIdx] += cnt
				codeSum += cnt
			}
			if codeSum == 0 && (pStats.OK > 0 || pStats.Failed > 0) {
				codeCounts[outcomeOKIdx] += pStats.OK
				codeCounts[outcomeInternalErrIdx] += pStats.Failed
				codeSum = pStats.OK + pStats.Failed
			}
			if codeSum == 0 && pStats.Total > 0 {
				codeCounts[outcomeInternalErrIdx] += pStats.Total
				codeSum = pStats.Total
			}
			if codeSum == 0 {
				continue
			}

			rec := slot.getOrCreatePlatform(normPlat)
			for c := 0; c < numOutcomeCodes; c++ {
				rec.byCode[c] += codeCounts[c]
			}
			for b := 0; b < len(rec.latencyBins); b++ {
				rec.latencyBins[b] += pStats.LatencyBins[b]
			}
			if pStats.MaxMS > rec.maxMS {
				rec.maxMS = pStats.MaxMS
			}
			platOKSum += codeCounts[outcomeOKIdx]
			platFailedSum += codeSum - codeCounts[outcomeOKIdx]
		}

		okCount := d.OK
		failCount := d.Failed
		if okCount == 0 && failCount == 0 {
			if platOKSum > 0 || platFailedSum > 0 {
				okCount = platOKSum
				failCount = platFailedSum
			} else if d.Total > 0 {
				failCount = d.Total
			}
		}
		slot.ok += okCount
		slot.failed += failCount
		slot.total += okCount + failCount
		slot.cacheHits += d.CacheHits
		slot.shanghaiHits += d.ShanghaiHits
		for b := 0; b < len(slot.latencyBins); b++ {
			slot.latencyBins[b] += d.LatencyBins[b]
		}
		if d.MaxMS > slot.maxMS {
			slot.maxMS = d.MaxMS
		}
	}

	var newHourly [HourlyStatsWindowHours]hourlyBucket
	loadedHours := 0
	for _, h := range doc.Hourly {
		hourID, ok := parseShanghaiHourStrict(h.HourStart)
		if !ok {
			return warn(errors.New("stats snapshot contains invalid hourly timestamp"))
		}
		if hourID < minHourID || hourID > curHourID {
			continue
		}
		slot := &newHourly[hourlySlotIndex(hourID)]
		if !slot.valid || slot.hourID != hourID {
			slot.reset(hourID)
			loadedHours++
		}
		okCount := h.OK
		failCount := h.Failed
		if okCount == 0 && failCount == 0 && h.Total > 0 {
			failCount = h.Total
		}
		slot.ok += okCount
		slot.failed += failCount
		slot.total += okCount + failCount
		slot.cacheHits += h.CacheHits
	}

	s.mu.Lock()
	s.daily = newDaily
	s.hourly = newHourly
	s.dynamicPlatforms = newDyn
	s.mu.Unlock()

	if logf != nil {
		logf("dokitool: stats snapshot loaded (daily_buckets=%d hourly_buckets=%d dynamic_platforms=%d)", loadedDays, loadedHours, len(newDyn))
	}
	return nil
}

// SaveSnapshot atomically persists active Asia/Shanghai daily/hourly aggregate buckets
// and bounded dynamic platform keys to path using a same-directory temporary file with 0600 permissions,
// Sync, Close, and atomic os.Rename.
func (s *Stats) SaveSnapshot(path string) error {
	if s == nil {
		return nil
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}

	s.saveMu.Lock()
	defer s.saveMu.Unlock()

	now := s.now()
	s.syncShanghaiHits(now)

	todayID := shanghaiDayID(now)
	curHourID := shanghaiHourID(now)

	s.mu.RLock()
	dailyOut := make([]persistedDailyBucket, 0, DailyStatsWindowDays)
	for i := 0; i < DailyStatsWindowDays; i++ {
		dID := todayID - int64(DailyStatsWindowDays-1-i)
		b := &s.daily[dailySlotIndex(dID)]
		if !b.valid || b.dayID != dID {
			continue
		}
		if b.total == 0 && b.cacheHits == 0 && b.shanghaiHits == 0 {
			continue
		}
		byPlat := make(map[string]persistedDailyPlatform, len(b.byPlatform))
		for plat, rec := range b.byPlatform {
			if rec == nil {
				continue
			}
			var pTotal uint64
			byCode := make(map[string]uint64, 4)
			for c := 0; c < numOutcomeCodes; c++ {
				if n := rec.byCode[c]; n > 0 {
					pTotal += n
					byCode[knownOutcomeCodes[c]] = n
				}
			}
			if pTotal == 0 {
				continue
			}
			pOK := rec.byCode[outcomeOKIdx]
			byPlat[plat] = persistedDailyPlatform{
				Total:       pTotal,
				OK:          pOK,
				Failed:      pTotal - pOK,
				ByCode:      byCode,
				LatencyBins: rec.latencyBins,
				MaxMS:       rec.maxMS,
			}
		}
		dailyOut = append(dailyOut, persistedDailyBucket{
			Date:         formatShanghaiDayID(dID),
			Total:        b.total,
			OK:           b.ok,
			Failed:       b.failed,
			CacheHits:    b.cacheHits,
			ShanghaiHits: b.shanghaiHits,
			LatencyBins:  b.latencyBins,
			MaxMS:        b.maxMS,
			ByPlatform:   byPlat,
		})
	}

	hourlyOut := make([]persistedHourlyBucket, 0, HourlyStatsWindowHours)
	for i := 0; i < HourlyStatsWindowHours; i++ {
		hID := curHourID - int64(HourlyStatsWindowHours-1-i)
		b := &s.hourly[hourlySlotIndex(hID)]
		if !b.valid || b.hourID != hID {
			continue
		}
		if b.total == 0 && b.cacheHits == 0 {
			continue
		}
		hourlyOut = append(hourlyOut, persistedHourlyBucket{
			HourStart: formatShanghaiHourID(hID),
			Total:     b.total,
			OK:        b.ok,
			Failed:    b.failed,
			CacheHits: b.cacheHits,
		})
	}

	dynOut := make([]string, 0, len(s.dynamicPlatforms))
	for k := range s.dynamicPlatforms {
		dynOut = append(dynOut, k)
	}
	slices.Sort(dynOut)
	s.mu.RUnlock()

	doc := persistedStatsSnapshot{
		SchemaVersion:    statsSnapshotSchemaVersion,
		Timezone:         statsSnapshotTimezone,
		SavedAt:          now.In(shanghaiZone).Format(time.RFC3339),
		Daily:            dailyOut,
		Hourly:           hourlyOut,
		DynamicPlatforms: dynOut,
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		return errors.New("failed to encode stats snapshot")
	}

	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".dokitool-stats-*.tmp")
	if err != nil {
		return errors.New("failed to create temporary stats snapshot file")
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return errors.New("failed to set permissions on stats snapshot file")
	}
	if _, err := tmp.Write(encoded); err != nil {
		_ = tmp.Close()
		return errors.New("failed to write stats snapshot file")
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return errors.New("failed to sync stats snapshot file")
	}
	if err := tmp.Close(); err != nil {
		return errors.New("failed to close stats snapshot file")
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return errors.New("failed to replace stats snapshot file")
	}
	cleanup = false
	return nil
}

// StartPeriodicSnapshot periodically flushes aggregate stats snapshots to path every interval
// (defaulting to DefaultStatsSnapshotInterval when interval <= 0) until ctx is canceled
// or the returned stop function is called. Calling stop waits for clean exit and is idempotent.
func (s *Stats) StartPeriodicSnapshot(ctx context.Context, path string, interval time.Duration, logf func(string, ...any)) func() {
	path = strings.TrimSpace(path)
	if s == nil || path == "" {
		return func() {}
	}
	if interval <= 0 {
		interval = DefaultStatsSnapshotInterval
	}
	ticker := time.NewTicker(interval)
	stopCh := make(chan struct{})
	doneCh := make(chan struct{})
	go func() {
		defer close(doneCh)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stopCh:
				return
			case <-ticker.C:
				if err := s.SaveSnapshot(path); err != nil && logf != nil {
					logf("dokitool: periodic stats snapshot save failed: %v", err)
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stopCh)
			<-doneCh
		})
	}
}
