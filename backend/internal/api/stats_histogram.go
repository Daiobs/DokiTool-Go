package api

import (
	"sync/atomic"
	"time"
)

var latencyBucketBounds = [10]time.Duration{
	10 * time.Millisecond,
	50 * time.Millisecond,
	100 * time.Millisecond,
	250 * time.Millisecond,
	500 * time.Millisecond,
	1000 * time.Millisecond,
	2500 * time.Millisecond,
	5000 * time.Millisecond,
	10000 * time.Millisecond,
	30000 * time.Millisecond,
}

var latencyBucketUpperMS = [10]uint64{
	10,
	50,
	100,
	250,
	500,
	1000,
	2500,
	5000,
	10000,
	30000,
}

func observeLatencyBins(bins *[11]uint64, maxMS *uint64, d time.Duration) {
	if d < 0 {
		d = 0
	}
	ms := uint64(d / time.Millisecond)
	if ms > *maxMS {
		*maxMS = ms
	}
	idx := len(latencyBucketBounds)
	for i, bound := range latencyBucketBounds {
		if d <= bound {
			idx = i
			break
		}
	}
	bins[idx]++
}

func computeLatencyQuantileMS(bins [11]uint64, maxMS uint64, pct uint64) uint64 {
	var total uint64
	for _, n := range bins {
		total += n
	}
	if total == 0 {
		return 0
	}
	q, r := total/100, total%100
	target := q*pct + (r*pct+99)/100
	if target == 0 {
		target = 1
	}
	var cum uint64
	for i := 0; i < len(latencyBucketUpperMS); i++ {
		cum += bins[i]
		if cum >= target {
			if latencyBucketUpperMS[i] > maxMS {
				return maxMS
			}
			return latencyBucketUpperMS[i]
		}
	}
	return maxMS
}

type apiAtomicHistogram struct {
	sumNs atomic.Uint64
	maxNs atomic.Uint64
	bins  [11]atomic.Uint64
}

func (h *apiAtomicHistogram) observe(d time.Duration) {
	if d < 0 {
		d = 0
	}
	ns := uint64(d.Nanoseconds())
	h.sumNs.Add(ns)
	for {
		cur := h.maxNs.Load()
		if ns <= cur || h.maxNs.CompareAndSwap(cur, ns) {
			break
		}
	}
	idx := len(latencyBucketBounds)
	for i, bound := range latencyBucketBounds {
		if d <= bound {
			idx = i
			break
		}
	}
	h.bins[idx].Add(1)
}

func (h *apiAtomicHistogram) snapshot() HistogramSnapshot {
	var cum [11]uint64
	var running uint64
	for i := 0; i < len(h.bins); i++ {
		running += h.bins[i].Load()
		cum[i] = running
	}
	return HistogramSnapshot{
		Count: running,
		SumMS: h.sumNs.Load() / 1_000_000,
		MaxMS: h.maxNs.Load() / 1_000_000,
		Buckets: HistogramBuckets{
			LE10:    cum[0],
			LE50:    cum[1],
			LE100:   cum[2],
			LE250:   cum[3],
			LE500:   cum[4],
			LE1000:  cum[5],
			LE2500:  cum[6],
			LE5000:  cum[7],
			LE10000: cum[8],
			LE30000: cum[9],
			Inf:     cum[10],
		},
	}
}

func mergeHistograms(a, b HistogramSnapshot) HistogramSnapshot {
	return HistogramSnapshot{
		Count: a.Count + b.Count,
		SumMS: a.SumMS + b.SumMS,
		MaxMS: max(a.MaxMS, b.MaxMS),
		Buckets: HistogramBuckets{
			LE10:    a.Buckets.LE10 + b.Buckets.LE10,
			LE50:    a.Buckets.LE50 + b.Buckets.LE50,
			LE100:   a.Buckets.LE100 + b.Buckets.LE100,
			LE250:   a.Buckets.LE250 + b.Buckets.LE250,
			LE500:   a.Buckets.LE500 + b.Buckets.LE500,
			LE1000:  a.Buckets.LE1000 + b.Buckets.LE1000,
			LE2500:  a.Buckets.LE2500 + b.Buckets.LE2500,
			LE5000:  a.Buckets.LE5000 + b.Buckets.LE5000,
			LE10000: a.Buckets.LE10000 + b.Buckets.LE10000,
			LE30000: a.Buckets.LE30000 + b.Buckets.LE30000,
			Inf:     a.Buckets.Inf + b.Buckets.Inf,
		},
	}
}

func histogramQuantileUpperBound(h HistogramSnapshot, pct uint64) string {
	if h.Count == 0 {
		return "0"
	}
	target := (h.Count*pct + 99) / 100
	if target == 0 {
		target = 1
	}
	steps := [11]struct {
		label string
		cum   uint64
	}{
		{"10", h.Buckets.LE10},
		{"50", h.Buckets.LE50},
		{"100", h.Buckets.LE100},
		{"250", h.Buckets.LE250},
		{"500", h.Buckets.LE500},
		{"1000", h.Buckets.LE1000},
		{"2500", h.Buckets.LE2500},
		{"5000", h.Buckets.LE5000},
		{"10000", h.Buckets.LE10000},
		{"30000", h.Buckets.LE30000},
		{"+Inf", h.Buckets.Inf},
	}
	for _, s := range steps {
		if s.cum >= target {
			return s.label
		}
	}
	return "+Inf"
}
