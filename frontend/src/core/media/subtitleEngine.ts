import type { Attachment, UnifiedMedia } from "../../types/media";
import { deliveryRoutes, getSubtitleTrackKind } from "../../utils/mediaContract";

/** Hard client-side byte cap per subtitle track fetch (5 MiB, Guardrail G5). */
export const MAX_SUBTITLE_TRACK_BYTES = 5 * 1024 * 1024;
/** Per-window candidate scan cap in mergeBilingualCues (two disjoint windows <= 2x per cue). */
export const MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE = 512;

const MAX_PROJECTED_TRACKS = 64;
const MAX_CUE_TIME_MS = 86_400_000_000;
const BILINGUAL_TOLERANCE_MS = 1500;
const MAX_STEM_CODEPOINTS = 64;

const FORMAT_RANK: Record<string, number> = { vtt: 0, srt: 1, ttml: 2, srv3: 3, json3: 4, xml: 5 };
const MIME_TO_FORMAT: Record<string, string> = {
  "text/vtt": "vtt", "application/x-subrip": "srt", "text/srt": "srt",
  "application/ttml+xml": "ttml", "application/xml": "xml", "text/xml": "xml", "application/json": "json3",
};
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const XML_UNSAFE_RE = /<!(?:DOCTYPE|ENTITY)\b/i;
const VTT_TIME_RE = /(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{1,3})/;
const CLOCK_RE = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/;
const OFFSET_RE = /^(\d+(?:\.\d+)?)(h|m|s|ms)$/i;
const STRICT_FINITE_NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ILLEGAL_FN_RE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

export interface ProjectedYouTubeCaptions {
  playerCaptionsTracklistRenderer: { captionTracks: Array<Record<string, unknown>> };
}
export interface SubtitleTrackOption {
  id: string; attachment: Attachment; label: string; language: string;
  trackKind: "manual" | "auto" | "unknown"; format: string; url: string; routes: string[];
}
export interface SubtitleCue { startMs: number; endMs: number; text: string; }
export interface SubtitleDownloadResult {
  content: string; filename: string; mimeType: string; extension: "vtt" | "srt"; cueCount: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const codedErr = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });
const cmpAscii = (a: string, b: string): number => {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la === lb ? 0 : !la ? 1 : !lb ? -1 : la < lb ? -1 : 1;
};

function projectCaptionName(rawName: unknown): unknown {
  if (typeof rawName === "string") return rawName.trim() || undefined;
  if (!isObj(rawName)) return undefined;
  const out: Record<string, unknown> = {};
  if (typeof rawName.simpleText === "string" && rawName.simpleText.trim()) out.simpleText = rawName.simpleText.trim();
  if (Array.isArray(rawName.runs)) {
    const runs = rawName.runs
      .filter((r): r is Record<string, string> => isObj(r) && typeof r.text === "string")
      .map((r) => ({ text: r.text }));
    if (runs.length) out.runs = runs;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Projects raw YouTube `captions` strictly to `{ playerCaptionsTracklistRenderer: { captionTracks } }`,
 * explicitly stripping `translationLanguages` and bloated renderer fields so finalize stays tiny.
 */
export function projectYouTubeCaptionsForFinalize(rawCaptions: unknown): ProjectedYouTubeCaptions | undefined {
  if (!isObj(rawCaptions)) return undefined;
  const renderer = isObj(rawCaptions.playerCaptionsTracklistRenderer) ? rawCaptions.playerCaptionsTracklistRenderer : null;
  const rawTracks = Array.isArray(renderer?.captionTracks)
    ? renderer.captionTracks
    : Array.isArray(rawCaptions.captionTracks)
      ? rawCaptions.captionTracks
      : null;
  if (!rawTracks?.length) return undefined;

  const captionTracks: Array<Record<string, unknown>> = [];
  for (const rawTrack of rawTracks) {
    if (captionTracks.length >= MAX_PROJECTED_TRACKS) break;
    if (!isObj(rawTrack)) continue;
    const baseUrl = typeof rawTrack.baseUrl === "string" ? rawTrack.baseUrl.trim() : "";
    if (!baseUrl) continue;
    const projected: Record<string, unknown> = { baseUrl };
    const name = projectCaptionName(rawTrack.name);
    if (name !== undefined) projected.name = name;
    for (const key of ["vssId", "languageCode", "kind"] as const) {
      if (typeof rawTrack[key] === "string" && (rawTrack[key] as string).trim()) {
        projected[key] = (rawTrack[key] as string).trim();
      }
    }
    if (typeof rawTrack.isTranslatable === "boolean") projected.isTranslatable = rawTrack.isTranslatable;
    captionTracks.push(projected);
  }
  return captionTracks.length ? { playerCaptionsTracklistRenderer: { captionTracks } } : undefined;
}

function inferSubtitleFormat(att: Attachment, primaryUrl: string): string {
  const meta = att.resource?.metadata;
  for (const raw of [meta?.extension, meta?.container]) {
    const clean = String(raw || "").trim().toLowerCase().replace(/^\.+/, "");
    if (clean in FORMAT_RANK) return clean;
  }
  const mime = String(meta?.mime_type || "").split(";")[0].trim().toLowerCase();
  if (mime in MIME_TO_FORMAT) return MIME_TO_FORMAT[mime];
  try {
    const u = new URL(primaryUrl);
    const fmt = (u.searchParams.get("fmt") || "").trim().toLowerCase();
    if (fmt in FORMAT_RANK) return fmt;
    const ext = u.pathname.includes(".") ? u.pathname.slice(u.pathname.lastIndexOf(".") + 1).toLowerCase() : "";
    if (ext in FORMAT_RANK) return ext;
  } catch {}
  return "vtt";
}

export function listSubtitleTracks(media: UnifiedMedia | null | undefined, apiOrigin?: string): SubtitleTrackOption[] {
  const attachments = Array.isArray(media?.attachments) ? media.attachments : [];
  const ctx = apiOrigin ? { apiOrigin } : {};
  const indexed: Array<{ kindRank: number; fmtRank: number; index: number; option: SubtitleTrackOption }> = [];

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const delivery = att?.role === "subtitle" ? att.resource?.delivery : undefined;
    if (!delivery || delivery.kind !== "file" || !Array.isArray(delivery.sources)) continue;
    let routes: string[];
    try {
      routes = deliveryRoutes(delivery.sources, ctx);
    } catch {
      continue;
    }
    if (!routes.length) continue;
    const trackKind = getSubtitleTrackKind(att) ?? "unknown";
    const format = inferSubtitleFormat(att, routes[0]);
    const language = String(att.language || "").trim();
    const label = String(att.title || "").trim() || language || att.id || `Subtitle ${i + 1}`;
    indexed.push({
      kindRank: trackKind === "manual" ? 0 : trackKind === "unknown" ? 1 : 2,
      fmtRank: FORMAT_RANK[format] ?? 99,
      index: i,
      option: { id: att.id || `subtitle-${i + 1}`, attachment: att, label, language, trackKind, format, url: routes[0], routes },
    });
  }
  indexed.sort(
    (a, b) =>
      a.kindRank - b.kindRank ||
      a.fmtRank - b.fmtRank ||
      cmpAscii(a.option.language, b.option.language) ||
      cmpAscii(a.option.label, b.option.label) ||
      a.index - b.index,
  );
  return indexed.map((entry) => entry.option);
}

function decodeHtmlEntitiesOnce(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, body: string) => {
    const lower = body.toLowerCase();
    if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower];
    const cp = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

function cleanCueText(raw: string, allowDoubleDecode = false): string {
  const noTags = String(raw || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  let decoded = decodeHtmlEntitiesOnce(noTags);
  if (allowDoubleDecode && decoded.includes("&")) decoded = decodeHtmlEntitiesOnce(decoded);
  return decoded
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function safeFiniteMs(raw: unknown, scale = 1): number | null {
  let num: number;
  if (typeof raw === "number") {
    num = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || !STRICT_FINITE_NUM_RE.test(trimmed)) return null;
    num = Number(trimmed);
  } else {
    return null;
  }
  const scaled = num * scale;
  return Number.isFinite(scaled) && scaled >= 0 && scaled <= MAX_CUE_TIME_MS ? Math.round(scaled) : null;
}

function hmsToMs(hStr: string | undefined, mStr: string, sStr: string, fStr: string | undefined): number | null {
  const total =
    ((Number.parseInt(hStr || "0", 10) * 3600 + Number.parseInt(mStr, 10) * 60 + Number.parseInt(sStr, 10)) * 1000) +
    Number.parseInt((fStr || "0").padEnd(3, "0").slice(0, 3), 10);
  return Number.isFinite(total) && total >= 0 && total <= MAX_CUE_TIME_MS ? total : null;
}

function parseXmlTimeMs(raw: string | undefined): number | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const clock = CLOCK_RE.exec(text);
  if (clock) return hmsToMs(clock[1], clock[2], clock[3], clock[4]);
  const off = OFFSET_RE.exec(text);
  if (off) {
    const u = off[2].toLowerCase();
    return safeFiniteMs(off[1], u === "h" ? 3_600_000 : u === "m" ? 60_000 : u === "s" ? 1000 : 1);
  }
  return safeFiniteMs(text, 1000);
}

function parseXmlSubtitles(rawText: string): SubtitleCue[] {
  if (XML_UNSAFE_RE.test(rawText)) throw new Error("Subtitle XML contains forbidden DOCTYPE or ENTITY declaration");
  const cues: SubtitleCue[] = [];
  const elemRe = /<(p|text)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let match = elemRe.exec(rawText); match; match = elemRe.exec(rawText)) {
    const tag = match[1].toLowerCase();
    const attrs: Record<string, string> = {};
    attrRe.lastIndex = 0;
    for (let am = attrRe.exec(match[2]); am; am = attrRe.exec(match[2])) {
      attrs[am[1].toLowerCase()] = am[2] ?? am[3] ?? "";
    }
    let startMs: number | null = null;
    let endMs: number | null = null;
    if (tag === "p" && "t" in attrs) {
      startMs = safeFiniteMs(attrs.t, 1);
      endMs = startMs === null ? null : startMs + (("d" in attrs ? safeFiniteMs(attrs.d, 1) : 0) ?? 0);
    } else if (tag === "p" && "begin" in attrs) {
      startMs = parseXmlTimeMs(attrs.begin);
      endMs = startMs === null
        ? null
        : "end" in attrs
          ? (parseXmlTimeMs(attrs.end) ?? startMs)
          : startMs + ("dur" in attrs ? (parseXmlTimeMs(attrs.dur) ?? 0) : 0);
    } else if (tag === "text" && "start" in attrs) {
      startMs = safeFiniteMs(attrs.start, 1000);
      endMs = startMs === null ? null : startMs + (("dur" in attrs ? safeFiniteMs(attrs.dur, 1000) : 0) ?? 0);
    }
    if (startMs === null) continue;
    const text = cleanCueText(match[3], true);
    if (text) cues.push({ startMs, endMs: Math.max(startMs, endMs ?? startMs), text });
  }
  return cues;
}

function parseJson3Subtitles(rawText: string): SubtitleCue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return [];
  }
  if (!isObj(parsed) || !Array.isArray(parsed.events)) return [];
  const cues: SubtitleCue[] = [];
  for (const ev of parsed.events) {
    if (!isObj(ev) || !Array.isArray(ev.segs)) continue;
    const startMs = safeFiniteMs(ev.tStartMs, 1);
    if (startMs === null) continue;
    const durMs = safeFiniteMs(ev.dDurationMs, 1) ?? 0;
    const rawSeg = ev.segs.map((s) => (isObj(s) && typeof s.utf8 === "string" ? s.utf8 : "")).join("");
    const text = cleanCueText(rawSeg, false);
    if (text) cues.push({ startMs, endMs: Math.max(startMs, startMs + durMs), text });
  }
  return cues;
}

function parseVttOrSrtSubtitles(rawText: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of rawText.split(/\n(?:[ \t]*\n)+/)) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (!lines.length || /^(?:WEBVTT|NOTE|STYLE|REGION)\b/i.test(lines[0].trim())) continue;
    const timeIdx = lines.slice(0, 2).findIndex((l) => VTT_TIME_RE.test(l));
    const m = timeIdx >= 0 ? VTT_TIME_RE.exec(lines[timeIdx]) : null;
    if (!m) continue;
    const startMs = hmsToMs(m[1], m[2], m[3], m[4]);
    const endMs = hmsToMs(m[5], m[6], m[7], m[8]);
    if (startMs === null || endMs === null) continue;
    const text = cleanCueText(lines.slice(timeIdx + 1).join("\n"), false);
    if (text) cues.push({ startMs, endMs: Math.max(startMs, endMs), text });
  }
  return cues;
}

export function parseSubtitleCues(rawText: string, formatHint?: string): SubtitleCue[] {
  const normalized = String(rawText || "").replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  const trimmed = normalized.trim();
  if (!trimmed) return [];
  const fmt = String(formatHint || "").trim().toLowerCase();
  if (fmt === "json3" || trimmed.startsWith("{")) return parseJson3Subtitles(trimmed);
  if (["xml", "ttml", "srv3", "srv2", "srv1"].includes(fmt) || trimmed.startsWith("<")) return parseXmlSubtitles(trimmed);
  return parseVttOrSrtSubtitles(normalized);
}

function formatTs(ms: number, sep: "." | ","): string {
  const c = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(Math.floor(c / 3_600_000))}:${p2(Math.floor((c % 3_600_000) / 60_000))}:${p2(Math.floor((c % 60_000) / 1000))}${sep}${String(c % 1000).padStart(3, "0")}`;
}

function formatCueBlocks(cues: SubtitleCue[], sep: "." | ",", numbered: boolean): string[] {
  const blocks: string[] = [];
  for (const cue of cues) {
    const text = String(cue.text || "").trim();
    if (!text) continue;
    const startMs = Number.isFinite(cue.startMs) ? Math.max(0, Math.round(cue.startMs)) : 0;
    const endMs = Number.isFinite(cue.endMs) ? Math.max(startMs, Math.round(cue.endMs)) : startMs;
    const line = `${formatTs(startMs, sep)} --> ${formatTs(endMs, sep)}\n${text}`;
    blocks.push(numbered ? `${blocks.length + 1}\n${line}` : line);
  }
  return blocks;
}

export const formatCuesAsVtt = (cues: SubtitleCue[]): string =>
  `${["WEBVTT", ...formatCueBlocks(cues, ".", false)].join("\n\n")}\n`;

export const formatCuesAsSrt = (cues: SubtitleCue[]): string => {
  const blocks = formatCueBlocks(cues, ",", true);
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
};

const normCue = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

interface IndexedSecondaryCue {
  cue: SubtitleCue; origIdx: number; sStart: number; sEnd: number; sEndEff: number; sMid: number;
}
interface BilingualMatchState {
  bestOverlap: { cue: SubtitleCue; overlap: number; midDiff: number; origIdx: number } | null;
  nearest: { cue: SubtitleCue; gap: number; startDiff: number; origIdx: number } | null;
}

function lowerBoundPrefixMaxEnd(prefixMaxEnd: number[], minEnd: number): number {
  let lo = 0, hi = prefixMaxEnd.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prefixMaxEnd[mid] < minEnd) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundStart(sec: IndexedSecondaryCue[], fromIdx: number, targetStart: number): number {
  if (fromIdx >= sec.length || sec[fromIdx].sStart >= targetStart) return fromIdx;
  let lo = fromIdx + 1, hi = sec.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sec[mid].sStart < targetStart) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function evaluateBilingualCandidate(
  s: IndexedSecondaryCue,
  pStart: number, pEnd: number, pEndEff: number, pMid: number, minEnd: number,
  state: BilingualMatchState,
): void {
  if (s.sEnd < minEnd) return;
  const overlap = Math.min(pEndEff, s.sEndEff) - Math.max(pStart, s.sStart);
  if (overlap > 0) {
    const midDiff = Math.abs(pMid - s.sMid);
    const prev = state.bestOverlap;
    if (!prev || overlap > prev.overlap || (overlap === prev.overlap && (midDiff < prev.midDiff || (midDiff === prev.midDiff && s.origIdx < prev.origIdx)))) {
      state.bestOverlap = { cue: s.cue, overlap, midDiff, origIdx: s.origIdx };
    }
    return;
  }
  if (state.bestOverlap) return;
  const gap = Math.max(0, Math.max(pStart, s.sStart) - Math.min(pEnd, s.sEnd));
  if (gap <= BILINGUAL_TOLERANCE_MS) {
    const startDiff = Math.abs(pStart - s.sStart);
    const prev = state.nearest;
    if (!prev || gap < prev.gap || (gap === prev.gap && (startDiff < prev.startDiff || (startDiff === prev.startDiff && s.origIdx < prev.origIdx)))) {
      state.nearest = { cue: s.cue, gap, startDiff, origIdx: s.origIdx };
    }
  }
}

export function mergeBilingualCues(
  primary: SubtitleCue[], secondary: SubtitleCue[], stats?: { totalScans: number; maxScansPerCue: number },
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
    sec.push({ cue, origIdx: i, sStart, sEnd, sEndEff: Math.max(sEnd, sStart + 1), sMid: (sStart + sEnd) / 2 });
  }
  sec.sort((a, b) => a.sStart - b.sStart || a.origIdx - b.origIdx);

  const prefixMaxEnd = new Array<number>(sec.length);
  let runningMaxEnd = -1;
  for (let i = 0; i < sec.length; i++) {
    if (sec[i].sEnd > runningMaxEnd) runningMaxEnd = sec[i].sEnd;
    prefixMaxEnd[i] = runningMaxEnd;
  }

  let left = 0, prevPStart = -Infinity;

  return primary.map((p) => {
    const pStart = Math.max(0, p.startMs);
    const pEnd = Math.max(pStart, p.endMs);
    const pEndEff = Math.max(pEnd, pStart + 1);
    const pMid = (pStart + pEnd) / 2;
    const state: BilingualMatchState = { bestOverlap: null, nearest: null };

    if (Number.isFinite(pStart) && Number.isFinite(pEnd) && sec.length > 0) {
      const minEnd = pStart - BILINGUAL_TOLERANCE_MS;
      const maxStart = pEnd + BILINGUAL_TOLERANCE_MS;
      if (pStart < prevPStart) left = lowerBoundPrefixMaxEnd(prefixMaxEnd, minEnd);
      else while (left < sec.length && prefixMaxEnd[left] < minEnd) left++;
      prevPStart = pStart;

      // Invariant: for k < left, sec[k].sStart <= sec[k].sEnd <= prefixMaxEnd[k] < minEnd,
      // so nearIdx >= left and the two bounded scan windows are strictly disjoint.
      const nearIdx = lowerBoundStart(sec, left, minEnd);
      const leadEnd = Math.min(nearIdx, left + MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE);
      for (let j = left; j < leadEnd; j++) evaluateBilingualCandidate(sec[j], pStart, pEnd, pEndEff, pMid, minEnd, state);
      const nearEnd = Math.min(sec.length, nearIdx + MAX_BILINGUAL_CANDIDATE_SCANS_PER_CUE);
      let nearScanned = 0;
      for (let j = nearIdx; j < nearEnd; j++) {
        nearScanned++;
        const s = sec[j];
        if (s.sStart > maxStart) break;
        evaluateBilingualCandidate(s, pStart, pEnd, pEndEff, pMid, minEnd, state);
      }
      if (stats) {
        const scans = (leadEnd - left) + nearScanned;
        stats.totalScans += scans;
        if (scans > stats.maxScansPerCue) stats.maxScansPerCue = scans;
      }
    }
    const pText = p.text.trim();
    const sText = (state.bestOverlap?.cue ?? state.nearest?.cue)?.text.trim() || "";
    if (!sText) return { startMs: pStart, endMs: pEnd, text: pText };
    const normS = normCue(sText);
    const lines = new Set(pText.split("\n").map(normCue));
    return { startMs: pStart, endMs: pEnd, text: normCue(pText) === normS || lines.has(normS) ? pText : `${pText}\n${sText}` };
  });
}

async function readResponseUtf8Bounded(resp: Response, maxBytes: number): Promise<string> {
  const lenHeader = resp.headers?.get?.("content-length")?.trim();
  if (lenHeader && Number.isFinite(Number(lenHeader)) && Number(lenHeader) > maxBytes) {
    await resp.body?.cancel?.().catch(() => {});
    throw codedErr("SUBTITLE_TOO_LARGE", `Subtitle exceeds ${maxBytes} bytes`);
  }
  if (resp.body && typeof resp.body.getReader === "function") {
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw codedErr("SUBTITLE_TOO_LARGE", `Subtitle exceeds ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder("utf-8").decode(merged);
  }
  const bytes = typeof resp.arrayBuffer === "function"
    ? new Uint8Array(await resp.arrayBuffer())
    : new TextEncoder().encode(await resp.text());
  if (bytes.byteLength > maxBytes) throw codedErr("SUBTITLE_TOO_LARGE", `Subtitle exceeds ${maxBytes} bytes`);
  return new TextDecoder("utf-8").decode(bytes);
}

export async function fetchSubtitleTrackText(
  url: string,
  options?: { fetchImpl?: typeof fetch; signal?: AbortSignal; maxBytes?: number; routes?: string[] },
): Promise<string> {
  const maxBytes =
    typeof options?.maxBytes === "number" && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : MAX_SUBTITLE_TRACK_BYTES;
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw codedErr("SUBTITLE_FETCH_FAILED", "fetch API is unavailable");

  const candidates = [...new Set([url, ...(options?.routes || [])])]
    .map((r) => String(r || "").trim())
    .filter((r) => {
      try {
        const u = new URL(r);
        return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
      } catch { return false; }
    });
  if (!candidates.length) throw codedErr("SUBTITLE_INVALID_URL", "No valid subtitle URL available");

  let lastErr: unknown = null;
  for (const route of candidates) {
    try {
      const resp = await fetchImpl(route, {
        method: "GET", credentials: "omit", referrerPolicy: "no-referrer",
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (!resp.ok) { lastErr = codedErr("SUBTITLE_HTTP_ERROR", `Subtitle HTTP ${resp.status}`); continue; }
      return await readResponseUtf8Bounded(resp, maxBytes);
    } catch (err: unknown) {
      const coded = err as { name?: string; code?: string } | null;
      if (coded?.name === "AbortError" || coded?.code === "SUBTITLE_TOO_LARGE") throw err;
      lastErr = err;
    }
  }
  if (lastErr instanceof Error) throw codedErr((lastErr as { code?: string }).code || "SUBTITLE_FETCH_FAILED", lastErr.message);
  throw codedErr("SUBTITLE_FETCH_FAILED", "Failed to fetch subtitle track");
}

export function buildSubtitleFilename(
  baseTitle: string, primaryLang: string, secondaryLang: string | undefined, format: "vtt" | "srt",
): string {
  const ext: "vtt" | "srt" = format === "srt" ? "srt" : "vtt";
  const stripped = String(baseTitle || "").trim().replace(/\.(?:vtt|srt|ttml|srv3|xml)$/i, "");
  const stem = [...stripped.replace(ILLEGAL_FN_RE, "").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "")]
    .slice(0, MAX_STEM_CODEPOINTS).join("").trim() || "subtitle";
  const cleanTag = (raw: string | undefined) =>
    String(raw || "").trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  const p = cleanTag(primaryLang);
  const s = cleanTag(secondaryLang);
  const suffix = p && s && p.toLowerCase() !== s.toLowerCase() ? `.${p}_${s}` : p ? `.${p}` : s ? `.${s}` : "";
  return `${stem}${suffix}.${ext}`;
}

export async function buildSubtitleDownloadResult(params: {
  primaryTrack: SubtitleTrackOption; secondaryTrack?: SubtitleTrackOption | null;
  targetFormat: "vtt" | "srt"; baseTitle: string;
  fetchTrackText?: (track: SubtitleTrackOption) => Promise<string>;
  fetchImpl?: typeof fetch; signal?: AbortSignal; maxBytes?: number;
}): Promise<SubtitleDownloadResult> {
  const ext: "vtt" | "srt" = params.targetFormat === "srt" ? "srt" : "vtt";
  const loadText = (track: SubtitleTrackOption) =>
    params.fetchTrackText
      ? params.fetchTrackText(track)
      : fetchSubtitleTrackText(track.url, {
          fetchImpl: params.fetchImpl, signal: params.signal, maxBytes: params.maxBytes, routes: track.routes,
        });
  const secondary = params.secondaryTrack && params.secondaryTrack.id !== params.primaryTrack.id ? params.secondaryTrack : null;
  const [primaryRaw, secondaryRaw] = await Promise.all([
    loadText(params.primaryTrack), secondary ? loadText(secondary) : Promise.resolve(""),
  ]);
  const primaryCues = parseSubtitleCues(primaryRaw, params.primaryTrack.format);
  const cues = secondary ? mergeBilingualCues(primaryCues, parseSubtitleCues(secondaryRaw, secondary.format)) : primaryCues;
  return {
    content: ext === "srt" ? formatCuesAsSrt(cues) : formatCuesAsVtt(cues),
    filename: buildSubtitleFilename(
      params.baseTitle,
      params.primaryTrack.language || params.primaryTrack.label,
      secondary ? secondary.language || secondary.label : undefined,
      ext,
    ),
    mimeType: ext === "srt" ? "application/x-subrip;charset=utf-8" : "text/vtt;charset=utf-8",
    extension: ext,
    cueCount: cues.length,
  };
}
