/**
 * Pure bilingual subtitle cue alignment kernel.
 *
 * Uses a flat Float64Array max-end tournament segment tree to skip all expired
 * secondary cues (sEnd < minEnd) in O(log M) time without consuming scan budget,
 * paired with long-lived banner tiering and Sørensen–Dice normalized scoring.
 *
 * Complexity:
 * - Preprocessing: O(M log M) sort + Theta(M) flat Float64Array segment tree.
 * - Worst-case query per primary cue: O(B log M) with B = MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE (512),
 *   evaluating at most 2 * B (1,024) candidates per primary cue (<= 512 alive pre-window via
 *   head-256 + tail-256 + <= 512 in-window).
 */

/** Per-window candidate scan cap in mergeBilingualCues (two disjoint windows <= 2x per cue). */
export const MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE = 512;

const BILINGUAL_TOLERANCE_MS = 1500;
const BILINGUAL_BANNER_EXCESS_MS = 6000;

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

interface IndexedSecondaryCue {
  cue: SubtitleCue;
  origIdx: number;
  sStart: number;
  sEnd: number;
  sEndEff: number;
  sDurEff: number;
  sMid: number;
}

interface OverlapCandidate {
  cue: SubtitleCue;
  bannerTier: 0 | 1;
  overlap: number;
  sDurEff: number;
  midDiff: number;
  origIdx: number;
}

interface NearestCandidate {
  cue: SubtitleCue;
  gap: number;
  startDiff: number;
  origIdx: number;
}

interface BilingualMatchState {
  bestOverlap: OverlapCandidate | null;
  nearestLocal: NearestCandidate | null;
  nearestAny: NearestCandidate | null;
}

const normCue = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

function buildSegMaxEnd(sec: IndexedSecondaryCue[]): { tree: Float64Array; base: number } {
  let base = 1;
  while (base < sec.length) base <<= 1;
  const tree = new Float64Array(base << 1);
  tree.fill(-Infinity);
  for (let i = 0; i < sec.length; i++) tree[base + i] = sec[i].sEnd;
  for (let i = base - 1; i >= 1; i--) {
    const l = tree[i << 1];
    const r = tree[(i << 1) | 1];
    tree[i] = l >= r ? l : r;
  }
  return { tree, base };
}

/** Returns the smallest index j >= max(0, from) with sec[j].sEnd >= minEnd, or n if none. */
function nextAliveIdx(tree: Float64Array, base: number, n: number, from: number, minEnd: number): number {
  let i = Math.max(0, from);
  if (i >= n || tree[1] < minEnd) return n;
  i += base;
  while (true) {
    while ((i & 1) === 0 && tree[i] < minEnd) i >>= 1;
    if (tree[i] >= minEnd) {
      while (i < base) {
        i <<= 1;
        if (tree[i] < minEnd) i |= 1;
      }
      return i - base < n ? i - base : n;
    }
    if ((i & (i + 1)) === 0) return n;
    i = (i >> 1) + 1;
  }
}

/** Returns the largest index j in [minIdx, min(n, before)) with sec[j].sEnd >= minEnd, or -1 if none. */
function prevAliveIdx(
  tree: Float64Array, base: number, n: number, before: number, minIdx: number, minEnd: number,
): number {
  let i = Math.min(n, before) - 1;
  if (i < minIdx || i < 0 || tree[1] < minEnd) return -1;
  i += base;
  while (true) {
    while ((i & 1) === 1 && i > 1 && tree[i] < minEnd) i >>= 1;
    if (tree[i] >= minEnd) {
      while (i < base) {
        i = (i << 1) | 1;
        if (tree[i] < minEnd) i ^= 1;
      }
      return i - base >= minIdx ? i - base : -1;
    }
    if ((i & (i - 1)) === 0) return -1;
    i = (i >> 1) - 1;
  }
}

function lowerBoundStart(sec: IndexedSecondaryCue[], fromIdx: number, targetStart: number): number {
  if (fromIdx >= sec.length || sec[fromIdx].sStart >= targetStart) return fromIdx;
  let lo = fromIdx + 1;
  let hi = sec.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sec[mid].sStart < targetStart) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function isBetterOverlap(
  tier: 0 | 1, overlap: number, sDur: number, midDiff: number, origIdx: number,
  prev: OverlapCandidate, pDur: number,
): boolean {
  if (tier !== prev.bannerTier) return tier < prev.bannerTier;
  if (sDur === prev.sDurEff) {
    if (overlap !== prev.overlap) return overlap > prev.overlap;
  } else {
    const lhs = overlap * (pDur + prev.sDurEff);
    const rhs = prev.overlap * (pDur + sDur);
    if (Number.isSafeInteger(lhs) && Number.isSafeInteger(rhs)) {
      if (lhs !== rhs) return lhs > rhs;
    } else {
      const diff = overlap / (pDur + sDur) - prev.overlap / (pDur + prev.sDurEff);
      if (Math.abs(diff) > 1e-12) return diff > 0;
    }
  }
  return midDiff !== prev.midDiff ? midDiff < prev.midDiff : origIdx < prev.origIdx;
}

function evaluateBilingualCandidate(
  s: IndexedSecondaryCue, pStart: number, pEnd: number, pEndEff: number, pDurEff: number, pMid: number, minEnd: number,
  state: BilingualMatchState,
): void {
  if (s.sEnd < minEnd) return;
  const overlap = Math.min(pEndEff, s.sEndEff) - Math.max(pStart, s.sStart);
  if (overlap > 0) {
    const bannerTier: 0 | 1 = (s.sDurEff - overlap) > BILINGUAL_BANNER_EXCESS_MS && overlap * 4 < s.sDurEff ? 1 : 0;
    const midDiff = Math.abs(pMid - s.sMid);
    if (!state.bestOverlap || isBetterOverlap(bannerTier, overlap, s.sDurEff, midDiff, s.origIdx, state.bestOverlap, pDurEff)) {
      state.bestOverlap = { cue: s.cue, bannerTier, overlap, sDurEff: s.sDurEff, midDiff, origIdx: s.origIdx };
    }
    return;
  }
  if (state.bestOverlap?.bannerTier === 0) return;
  const gap = Math.max(0, Math.max(pStart, s.sStart) - Math.min(pEnd, s.sEnd));
  if (gap > BILINGUAL_TOLERANCE_MS) return;
  const startDiff = Math.abs(pStart - s.sStart);
  const isLocal = s.sDurEff <= BILINGUAL_BANNER_EXCESS_MS * 2;
  const prev = isLocal ? state.nearestLocal : state.nearestAny;
  if (!prev || gap < prev.gap || (gap === prev.gap && (startDiff < prev.startDiff || (startDiff === prev.startDiff && s.origIdx < prev.origIdx)))) {
    const next: NearestCandidate = { cue: s.cue, gap, startDiff, origIdx: s.origIdx };
    if (isLocal) state.nearestLocal = next;
    else state.nearestAny = next;
  }
}

export function mergeBilingualCues(
  primary: SubtitleCue[],
  secondary: SubtitleCue[],
  stats?: { totalScans: number; maxScansPerCue: number },
): SubtitleCue[] {
  if (stats) stats.totalScans = stats.maxScansPerCue = 0;
  if (!primary.length) return secondary.map((c) => ({ ...c }));
  if (!secondary.length) return primary.map((c) => ({ ...c }));

  const sec: IndexedSecondaryCue[] = [];
  for (let i = 0; i < secondary.length; i++) {
    const cue = secondary[i];
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs)) continue;
    const sStart = Math.max(0, cue.startMs);
    const sEnd = Math.max(sStart, cue.endMs);
    const sEndEff = Math.max(sEnd, sStart + 1);
    sec.push({ cue, origIdx: i, sStart, sEnd, sEndEff, sDurEff: sEndEff - sStart, sMid: (sStart + sEnd) / 2 });
  }
  sec.sort((a, b) => a.sStart - b.sStart || a.origIdx - b.origIdx);

  const { tree: segTree, base: segBase } = sec.length > 0 ? buildSegMaxEnd(sec) : { tree: new Float64Array(0), base: 0 };
  const headCap = MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE >>> 1;
  let left = 0;
  let prevPStart = -Infinity;

  return primary.map((p) => {
    const pStart = Math.max(0, p.startMs);
    const pEnd = Math.max(pStart, p.endMs);
    const pEndEff = Math.max(pEnd, pStart + 1);
    const pDurEff = pEndEff - pStart;
    const pMid = (pStart + pEnd) / 2;
    const state: BilingualMatchState = { bestOverlap: null, nearestLocal: null, nearestAny: null };

    if (Number.isFinite(pStart) && Number.isFinite(pEnd) && sec.length > 0) {
      const minEnd = pStart - BILINGUAL_TOLERANCE_MS;
      const maxStart = pEnd + BILINGUAL_TOLERANCE_MS;
      left = nextAliveIdx(segTree, segBase, sec.length, pStart < prevPStart ? 0 : left, minEnd);
      prevPStart = pStart;

      // Invariant: for k < left, sec[k].sStart <= sec[k].sEnd < minEnd, so nearIdx >= left
      // and pre-window [left, nearIdx) is strictly disjoint from in-window [nearIdx, n).
      const nearIdx = lowerBoundStart(sec, left, minEnd);
      let preScanned = 0;
      let h = left;
      while (h < nearIdx && preScanned < headCap) {
        evaluateBilingualCandidate(sec[h], pStart, pEnd, pEndEff, pDurEff, pMid, minEnd, state);
        preScanned++;
        h = nextAliveIdx(segTree, segBase, sec.length, h + 1, minEnd);
      }
      if (h < nearIdx) {
        let t = prevAliveIdx(segTree, segBase, sec.length, nearIdx, h, minEnd);
        while (t >= h && preScanned < MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE) {
          evaluateBilingualCandidate(sec[t], pStart, pEnd, pEndEff, pDurEff, pMid, minEnd, state);
          preScanned++;
          t = prevAliveIdx(segTree, segBase, sec.length, t, h, minEnd);
        }
      }

      const nearEnd = Math.min(sec.length, nearIdx + MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE);
      let nearScanned = 0;
      for (let j = nearIdx; j < nearEnd; j++) {
        nearScanned++;
        const s = sec[j];
        if (s.sStart > maxStart) break;
        evaluateBilingualCandidate(s, pStart, pEnd, pEndEff, pDurEff, pMid, minEnd, state);
      }
      if (stats) {
        const scans = preScanned + nearScanned;
        stats.totalScans += scans;
        if (scans > stats.maxScansPerCue) stats.maxScansPerCue = scans;
      }
    }
    const pText = p.text.trim();
    const chosen = (state.bestOverlap?.bannerTier === 0 ? state.bestOverlap.cue : null)
      ?? state.nearestLocal?.cue ?? state.bestOverlap?.cue ?? state.nearestAny?.cue;
    const sText = chosen?.text.trim() || "";
    if (!sText) return { startMs: pStart, endMs: pEnd, text: pText };
    const normS = normCue(sText);
    const lines = new Set(pText.split("\n").map(normCue));
    return { startMs: pStart, endMs: pEnd, text: normCue(pText) === normS || lines.has(normS) ? pText : `${pText}\n${sText}` };
  });
}
