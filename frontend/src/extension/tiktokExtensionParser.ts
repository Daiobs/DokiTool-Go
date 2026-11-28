// Client-assisted zero-cookie TikTok page hydration & /aweme/v1/play/ resolver
// executed strictly inside the MV3 Offscreen document.
//
// Security boundaries:
// - Strictly zero-cookie (`credentials: "omit"`, `referrerPolicy: "no-referrer"` +
//   DNR Rules 1010/1011 stripping Origin/Cookie for extension-initiated XHR/fetch).
// - Bounded hydration HTML read (4 MiB max) and non-backtracking script tag scan.
// - Explicit post-landing URL allowlist checks on shortlink expansion, hydration
//   landing, and `/aweme/v1/play/` redirects (4 TikTok CDN suffixes only; rejects
//   `*-webapp-prime.tiktok.com` and `tk=tt_chain_token`).
// - Honest disclosure: WHATWG Fetch hides `Location` headers on `redirect: "manual"`
//   (`opaqueredirect`), so the browser automatically follows redirects before
//   exposing the landed `response.url`. Post-redirect domain verification validates
//   the landed origin/URL but is NOT equivalent to server-side hop-by-hop
//   pre-validation.

import { validateApiBaseUrl } from "./hostWhitelist";

export const TIKTOK_HYDRATION_MAX_BYTES = 4 * 1024 * 1024;
export const TIKTOK_PLAY302_MAX_CONCURRENT = 3;
export const TIKTOK_MAX_VIDEO_TIERS = 4;
export const TIKTOK_DEFAULT_FETCH_TIMEOUT_MS = 25_000;
export const TIKTOK_PLAY302_TIER_TIMEOUT_MS = 6_000;

const HYDRATION_SCRIPT_MARKER =
  '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"';
const HYDRATION_SCRIPT_CLOSE = "</script>";
const MAX_WAF_BODY_INSPECT_CHARS = 16 * 1024;
const SLARDAR_WAF_MARKERS = [
  "slardar_us_waf",
  "_wafchallengeid",
  "waf-jschallenge",
  "byted_acrawler",
] as const;

const UNAVAILABLE_STATUS_CODES = new Set([10204, 10216, 10221, 10222]);

const TIKTOK_PARSE_ALLOWED_HOSTS = new Set([
  "www.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "m.tiktok.com",
  "tiktok.com",
]);

const ALLOWED_TIKTOK_CDN_SUFFIXES = [
  ".tiktokcdn.com",
  ".tiktokcdn-us.com",
  ".tiktokcdn-eu.com",
  ".tiktokv.com",
] as const;

const USER_ITEM_RE = /^\/@[^/?#]+\/(?:video|photo)\/([0-9]{5,25})$/;
const SHARE_ITEM_RE = /^\/share\/(?:video|photo)\/([0-9]{5,25})$/;
const EMBED_ITEM_RE = /^\/(?:embed\/v2|player\/v1)\/([0-9]{5,25})$/;
const MOBILE_V_RE = /^\/v\/([0-9]{5,25})(?:\.html)?$/;
const SHORT_CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

export type TikTokClientTarget =
  | {
      kind: "item";
      itemId: string;
      canonicalUrl: string;
    }
  | {
      kind: "shortlink";
      shortUrl: string;
      shortCode: string;
    };

export interface TikTokResolvedTier {
  play_url: string;
  direct_url: string;
}

export interface TikTokClientFetchPayload {
  url: string;
  extraAllowedOrigins?: string[];
}

export interface TikTokClientFetchResult {
  source_url: string;
  video_detail: Record<string, unknown>;
  resolved_tiers: TikTokResolvedTier[];
}

export class TikTokClientParseError extends Error {
  code: string;
  status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "TikTokClientParseError";
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

function hasUnsafeUrlChars(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) {
      return true;
    }
  }
  return false;
}

function extractRawAuthority(raw: string): string {
  const schemeIdx = raw.indexOf("://");
  if (schemeIdx < 0) return "";
  const rest = raw.slice(schemeIdx + 3);
  const slashIdx = rest.search(/[/?#]/);
  return slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
}

function hasRawEmptyPort(raw: string): boolean {
  return extractRawAuthority(raw).endsWith(":");
}

function hasRawUserinfo(raw: string): boolean {
  return extractRawAuthority(raw).includes("@");
}

function isLoopbackExtraOriginMatch(
  parsed: URL,
  extraAllowedOrigins?: string[],
): boolean {
  if (!Array.isArray(extraAllowedOrigins) || extraAllowedOrigins.length === 0) {
    return false;
  }
  for (const rawExtra of extraAllowedOrigins) {
    if (typeof rawExtra !== "string" || !rawExtra.trim()) continue;
    const validated = validateApiBaseUrl(rawExtra);
    if (
      validated.ok &&
      validated.isLoopback &&
      parsed.origin.toLowerCase() === validated.origin.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

function isIpLiteralHost(host: string): boolean {
  if (!host) return true;
  if (host.startsWith("[") || host.includes(":")) return true;
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^(?:0x[0-9a-f]+|\d+)$/i.test(host);
}

/**
 * Validates a TikTok work URL or share shortlink without network I/O.
 * Strictly mirrors `backend/internal/urlpolicy/tiktok.go#ExtractTikTokItemTarget`.
 */
export function extractTikTokTarget(rawUrl: string): TikTokClientTarget | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (
    !trimmed ||
    trimmed.length > 4096 ||
    hasUnsafeUrlChars(trimmed) ||
    hasRawEmptyPort(trimmed)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") return null;
  if (parsed.username || parsed.password || hasRawUserinfo(trimmed)) return null;
  if (parsed.port !== "") return null;

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (host !== "tiktok.com" && !host.endsWith(".tiktok.com")) {
    return null;
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  if (!cleanPath) return null;

  if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
    const seg = cleanPath.startsWith("/") ? cleanPath.slice(1) : cleanPath;
    if (seg && !seg.includes("/") && SHORT_CODE_RE.test(seg)) {
      const prefix = host === "vm.tiktok.com" ? "vm" : "vt";
      return {
        kind: "shortlink",
        shortUrl: `https://${host}/${seg}/`,
        shortCode: `${prefix}:${seg}`,
      };
    }
    return null;
  }

  if (cleanPath.startsWith("/t/")) {
    const seg = cleanPath.slice(3);
    if (seg && !seg.includes("/") && SHORT_CODE_RE.test(seg)) {
      return {
        kind: "shortlink",
        shortUrl: `https://www.tiktok.com/t/${seg}/`,
        shortCode: `t:${seg}`,
      };
    }
    return null;
  }

  const matched =
    USER_ITEM_RE.exec(cleanPath) ||
    SHARE_ITEM_RE.exec(cleanPath) ||
    EMBED_ITEM_RE.exec(cleanPath) ||
    MOBILE_V_RE.exec(cleanPath);
  if (matched) {
    const itemId = matched[1];
    return {
      kind: "item",
      itemId,
      canonicalUrl: `https://www.tiktok.com/@i/video/${itemId}`,
    };
  }

  return null;
}

export function isAllowedTikTokParsePageUrl(
  rawUrl: string,
  extraAllowedOrigins?: string[],
): boolean {
  if (typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (
    !trimmed ||
    trimmed.length > 4096 ||
    hasUnsafeUrlChars(trimmed) ||
    hasRawEmptyPort(trimmed) ||
    trimmed.includes("#")
  ) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || hasRawUserinfo(trimmed)) return false;
  if (isLoopbackExtraOriginMatch(parsed, extraAllowedOrigins)) {
    return true;
  }
  if (parsed.protocol !== "https:" || parsed.port !== "") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  return TIKTOK_PARSE_ALLOWED_HOSTS.has(host);
}

export function isTikTokPlayRedirectSourceUrl(
  rawUrl: string,
  extraAllowedOrigins?: string[],
): boolean {
  if (typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (
    !trimmed ||
    trimmed.length > 4096 ||
    hasUnsafeUrlChars(trimmed) ||
    hasRawEmptyPort(trimmed)
  ) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || hasRawUserinfo(trimmed)) return false;
  if (isLoopbackExtraOriginMatch(parsed, extraAllowedOrigins)) {
    return parsed.pathname.startsWith("/aweme/v1/play/");
  }
  if (parsed.protocol !== "https:" || parsed.port !== "") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  return (
    host === "www.tiktok.com" && parsed.pathname.startsWith("/aweme/v1/play/")
  );
}

/**
 * Strictly mirrors `backend/internal/platform/tiktok/play302.go#AllowedMediaURL`.
 */
export function isAllowedTikTokMediaCdnUrl(
  rawUrl: string,
  extraAllowedOrigins?: string[],
): boolean {
  if (typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (
    !trimmed ||
    trimmed.length > 4096 ||
    hasUnsafeUrlChars(trimmed) ||
    hasRawEmptyPort(trimmed) ||
    trimmed.includes("#")
  ) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || hasRawUserinfo(trimmed)) return false;
  if (isLoopbackExtraOriginMatch(parsed, extraAllowedOrigins)) {
    return true;
  }
  if (parsed.protocol !== "https:" || parsed.port !== "") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || isIpLiteralHost(host)) return false;
  if (
    host === "tiktok.com" ||
    host.endsWith(".tiktok.com") ||
    host.endsWith("-webapp-prime.tiktok.com")
  ) {
    return false;
  }
  const matchedSuffix = ALLOWED_TIKTOK_CDN_SUFFIXES.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );
  if (!matchedSuffix) return false;

  for (const val of parsed.searchParams.getAll("tk")) {
    if (val.trim().toLowerCase() === "tt_chain_token") {
      return false;
    }
  }
  return true;
}

export function isSlardarWafPage(status: number, bodyText: string): boolean {
  if (status === 403 || status === 429) return true;
  if (!bodyText || bodyText.length >= MAX_WAF_BODY_INSPECT_CHARS) return false;
  const lower = bodyText.toLowerCase();
  return SLARDAR_WAF_MARKERS.some((marker) => lower.includes(marker));
}

export function extractTikTokVideoDetailFromHtml(html: string): {
  found: boolean;
  detail: Record<string, unknown> | null;
  parseError?: Error;
} {
  const idx = html.indexOf(HYDRATION_SCRIPT_MARKER);
  if (idx < 0) return { found: false, detail: null };
  const afterMarker = idx + HYDRATION_SCRIPT_MARKER.length;
  const gtOffset = html.indexOf(">", afterMarker);
  if (gtOffset < 0 || gtOffset - afterMarker > 4096) {
    return { found: false, detail: null };
  }
  const closeIdx = html.indexOf(HYDRATION_SCRIPT_CLOSE, gtOffset + 1);
  if (closeIdx < 0) return { found: false, detail: null };
  const rawJson = html.slice(gtOffset + 1, closeIdx).trim();
  if (!rawJson) return { found: false, detail: null };

  try {
    const parsed = JSON.parse(rawJson) as {
      __DEFAULT_SCOPE__?: Record<string, unknown>;
    };
    const scope = parsed?.__DEFAULT_SCOPE__;
    const detail = scope?.["webapp.video-detail"];
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
      return { found: true, detail: null };
    }
    return { found: true, detail: detail as Record<string, unknown> };
  } catch (err) {
    return {
      found: true,
      detail: null,
      parseError: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

function parseFlexInt(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return 0;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

function isUnsupportedCodec(raw: unknown): boolean {
  const lower = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return lower.includes("bytevc2") || lower.includes("vvc");
}

function normalizeVideoCodec(raw: unknown): string {
  const lower = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (
    lower.includes("h265") ||
    lower.includes("hevc") ||
    lower.includes("bytevc1") ||
    lower.includes("hvc1")
  ) {
    return "h265";
  }
  if (lower.includes("h264") || lower.includes("avc")) {
    return "h264";
  }
  if (lower.includes("av1") || lower.includes("av01")) {
    return "av1";
  }
  return "";
}

function findPlayRedirectUrl(
  urlList: unknown,
  extraAllowedOrigins?: string[],
): string {
  if (!Array.isArray(urlList)) return "";
  for (const raw of urlList) {
    if (
      typeof raw === "string" &&
      isTikTokPlayRedirectSourceUrl(raw, extraAllowedOrigins)
    ) {
      return raw.trim();
    }
  }
  return "";
}

interface CandidateTier {
  playUrl: string;
  width: number;
  height: number;
  bitrate: number;
  codec: string;
}

function pixelArea(c: CandidateTier): number {
  return c.width > 0 && c.height > 0 ? c.width * c.height : 0;
}

/**
 * Selects up to 4 representative `/aweme/v1/play/` candidate URLs from
 * `itemStruct.video`, strictly mirroring
 * `backend/internal/platform/tiktok/play302.go#selectVideoTierCandidates`.
 */
export function selectTikTokVideoPlayUrls(
  rawVideo: unknown,
  extraAllowedOrigins?: string[],
): string[] {
  if (!rawVideo || typeof rawVideo !== "object" || Array.isArray(rawVideo)) {
    return [];
  }
  const v = rawVideo as Record<string, unknown>;
  const bitrateInfo = Array.isArray(v.bitrateInfo) ? v.bitrateInfo : [];
  const baseW = parseFlexInt(v.width);
  const baseH = parseFlexInt(v.height);

  const all: CandidateTier[] = [];
  const seenPlay = new Set<string>();

  for (const rawInfo of bitrateInfo) {
    if (!rawInfo || typeof rawInfo !== "object") continue;
    const info = rawInfo as Record<string, unknown>;
    if (isUnsupportedCodec(info.CodecType)) continue;
    const playAddr = info.PlayAddr as Record<string, unknown> | undefined;
    if (!playAddr || typeof playAddr !== "object") continue;
    const playUrl = findPlayRedirectUrl(playAddr.UrlList, extraAllowedOrigins);
    if (!playUrl || seenPlay.has(playUrl)) continue;
    seenPlay.add(playUrl);

    let w = parseFlexInt(playAddr.Width);
    let h = parseFlexInt(playAddr.Height);
    if (w <= 0) w = baseW;
    if (h <= 0) h = baseH;

    all.push({
      playUrl,
      width: w,
      height: h,
      bitrate: parseFlexInt(info.Bitrate),
      codec: normalizeVideoCodec(info.CodecType),
    });
  }

  if (
    all.length === 0 &&
    typeof v.playAddr === "string" &&
    isTikTokPlayRedirectSourceUrl(v.playAddr, extraAllowedOrigins)
  ) {
    all.push({
      playUrl: v.playAddr.trim(),
      width: baseW,
      height: baseH,
      bitrate: parseFlexInt(v.bitrate),
      codec: normalizeVideoCodec(v.codecType),
    });
  }

  if (all.length === 0) return [];

  // Stable descending sort by pixel area, bitrate, then prefer h264 on ties.
  all.sort((a, b) => {
    const pa = pixelArea(a);
    const pb = pixelArea(b);
    if (pa !== pb) return pa > pb ? -1 : 1;
    if (a.bitrate !== b.bitrate) return a.bitrate > b.bitrate ? -1 : 1;
    if (a.codec !== b.codec) {
      if (a.codec === "h264") return -1;
      if (b.codec === "h264") return 1;
    }
    return 0;
  });

  if (all.length <= TIKTOK_MAX_VIDEO_TIERS) {
    return all.map((c) => c.playUrl);
  }

  const pickedIdx: number[] = [];
  const used = new Set<number>();
  const addIdx = (idx: number) => {
    if (
      idx < 0 ||
      idx >= all.length ||
      used.has(idx) ||
      pickedIdx.length >= TIKTOK_MAX_VIDEO_TIERS
    ) {
      return;
    }
    used.add(idx);
    pickedIdx.push(idx);
  };

  // 1. Highest resolution tier
  addIdx(0);

  // 2. Second highest distinct resolution tier (fallback to index 1)
  const topArea = pixelArea(all[0]);
  let secondIdx = -1;
  for (let i = 1; i < all.length; i++) {
    if (pixelArea(all[i]) !== topArea) {
      secondIdx = i;
      break;
    }
  }
  addIdx(secondIdx >= 0 ? secondIdx : 1);

  // 3. Highest resolution H.264 tier
  for (let i = 0; i < all.length; i++) {
    if (!used.has(i) && all[i].codec === "h264") {
      addIdx(i);
      break;
    }
  }

  // 4. Lowest bitrate / smallest resolution tier
  let lowestIdx = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (!used.has(i)) {
      if (lowestIdx < 0) {
        lowestIdx = i;
        continue;
      }
      const cur = all[i];
      const best = all[lowestIdx];
      if (
        (cur.bitrate > 0 && (best.bitrate <= 0 || cur.bitrate < best.bitrate)) ||
        (cur.bitrate === best.bitrate && pixelArea(cur) < pixelArea(best))
      ) {
        lowestIdx = i;
      }
    }
  }
  addIdx(lowestIdx);

  // Fill any remaining slot in quality order
  for (let i = 0; i < all.length && pickedIdx.length < TIKTOK_MAX_VIDEO_TIERS; i++) {
    addIdx(i);
  }

  pickedIdx.sort((a, b) => a - b);
  return pickedIdx.map((idx) => all[idx].playUrl);
}

/**
 * Projects `webapp.video-detail` to the exact subset of fields consumed by
 * `backend/internal/platform/tiktok/hydration.go` so extraneous TikTok page
 * telemetry blobs never inflate the POST /api/tiktok/finalize body.
 */
export function projectVideoDetailForFinalize(
  detail: Record<string, unknown>,
): Record<string, unknown> {
  const statusCode = parseFlexInt(detail.statusCode);
  const statusMsg =
    typeof detail.statusMsg === "string" ? detail.statusMsg : "";
  const itemInfo = detail.itemInfo as Record<string, unknown> | undefined;
  const rawItem =
    itemInfo && typeof itemInfo === "object"
      ? (itemInfo.itemStruct as Record<string, unknown> | undefined)
      : undefined;

  if (!rawItem || typeof rawItem !== "object") {
    return { statusCode, statusMsg };
  }

  const itemStruct: Record<string, unknown> = {};
  for (const key of [
    "id",
    "desc",
    "createTime",
    "author",
    "stats",
    "video",
    "imagePost",
    "music",
    "challenges",
    "textExtra",
  ] as const) {
    if (rawItem[key] !== undefined && rawItem[key] !== null) {
      itemStruct[key] = rawItem[key];
    }
  }

  return {
    statusCode,
    statusMsg,
    itemInfo: { itemStruct },
  };
}

async function readBoundedResponseText(
  resp: Response,
  maxBytes: number,
): Promise<string> {
  if (!resp.body || typeof resp.body.getReader !== "function") {
    const text = await resp.text();
    const byteLen = new TextEncoder().encode(text).byteLength;
    if (byteLen > maxBytes) {
      throw new TikTokClientParseError(
        "UPSTREAM_INVALID_RESPONSE",
        "TikTok 页面响应超出大小限制",
        502,
      );
    }
    return text;
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new TikTokClientParseError(
          "UPSTREAM_INVALID_RESPONSE",
          "TikTok 页面响应超出大小限制",
          502,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function safeCancelBody(resp: Response | null | undefined): void {
  try {
    void resp?.body?.cancel?.().catch(() => {});
  } catch {
    // Ignore already consumed/locked body
  }
}

async function resolveSinglePlay302Tier(
  playUrl: string,
  fetchFn: typeof fetch,
  parentSignal: AbortSignal,
  extraAllowedOrigins?: string[],
): Promise<TikTokResolvedTier | null> {
  if (!isTikTokPlayRedirectSourceUrl(playUrl, extraAllowedOrigins)) {
    return null;
  }
  const tierCtrl = new AbortController();
  const onParentAbort = () => tierCtrl.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    onParentAbort();
  } else {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () => tierCtrl.abort(new Error("TikTok play302 timeout")),
    TIKTOK_PLAY302_TIER_TIMEOUT_MS,
  );
  (timer as { unref?: () => void })?.unref?.();

  let resp: Response | undefined;
  try {
    resp = await fetchFn(playUrl, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: tierCtrl.signal,
    });
    const finalUrl = typeof resp.url === "string" ? resp.url.trim() : "";
    const okStatus = resp.ok;
    // Immediately abort & cancel response body as soon as headers arrive so
    // zero video megabytes are buffered during URL resolution.
    safeCancelBody(resp);
    tierCtrl.abort();

    if (!okStatus || !isAllowedTikTokMediaCdnUrl(finalUrl, extraAllowedOrigins)) {
      return null;
    }
    return {
      play_url: playUrl,
      direct_url: finalUrl,
    };
  } catch {
    safeCancelBody(resp);
    return null;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

async function resolvePlay302TiersConcurrent(
  playUrls: string[],
  fetchFn: typeof fetch,
  signal: AbortSignal,
  extraAllowedOrigins?: string[],
): Promise<TikTokResolvedTier[]> {
  if (playUrls.length === 0) return [];
  const results: Array<TikTokResolvedTier | null> = new Array(
    playUrls.length,
  ).fill(null);
  let nextIdx = 0;

  const workerCount = Math.min(TIKTOK_PLAY302_MAX_CONCURRENT, playUrls.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          if (signal.aborted) return;
          const idx = nextIdx++;
          if (idx >= playUrls.length) return;
          results[idx] = await resolveSinglePlay302Tier(
            playUrls[idx],
            fetchFn,
            signal,
            extraAllowedOrigins,
          );
        }
      })(),
    );
  }
  await Promise.all(workers);

  const out: TikTokResolvedTier[] = [];
  const seenDirect = new Set<string>();
  for (const item of results) {
    if (!item || seenDirect.has(item.direct_url)) continue;
    seenDirect.add(item.direct_url);
    out.push(item);
  }
  return out;
}

export interface FetchTikTokClientPayloadOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Fetches a TikTok work page (expanding shortlinks first when needed) and
 * resolves representative `/aweme/v1/play/` video redirect tiers strictly from
 * the extension Offscreen context with zero cookies.
 */
export async function fetchTikTokClientPayload(
  payload: TikTokClientFetchPayload,
  options?: FetchTikTokClientPayloadOptions,
): Promise<TikTokClientFetchResult> {
  const fetchFn: typeof fetch =
    options?.fetchImpl ??
    ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const extraAllowedOrigins = payload.extraAllowedOrigins;

  const target = extractTikTokTarget(payload.url);
  if (!target) {
    throw new TikTokClientParseError(
      "INVALID_INPUT",
      "请输入有效的 TikTok 视频或图文链接",
      400,
    );
  }

  const controller = new AbortController();
  const parentSignal = options?.signal;
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }
  const timeoutMs = Math.max(
    1000,
    options?.timeoutMs ?? TIKTOK_DEFAULT_FETCH_TIMEOUT_MS,
  );
  const timeout = setTimeout(() => {
    controller.abort(
      new TikTokClientParseError(
        "UPSTREAM_TIMEOUT",
        "TikTok 上游连接超时，请稍后重试",
        504,
      ),
    );
  }, timeoutMs);
  (timeout as { unref?: () => void })?.unref?.();

  const buildFetchError = (err: unknown, fallbackMsg: string): Error => {
    if (err instanceof TikTokClientParseError) return err;
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof TikTokClientParseError
    ) {
      return controller.signal.reason;
    }
    if (parentSignal?.aborted) {
      return new TikTokClientParseError("USER_CANCELLED", "已取消解析", 499);
    }
    return new TikTokClientParseError("UPSTREAM_UNAVAILABLE", fallbackMsg, 502);
  };

  try {
    let canonicalUrl = "";
    let hydrationResp: Response | null = null;

    if (target.kind === "shortlink") {
      let shortResp: Response;
      try {
        shortResp = await fetchFn(target.shortUrl, {
          method: "GET",
          redirect: "follow",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
      } catch (err) {
        throw buildFetchError(err, "TikTok 短链解析失败，请稍后重试");
      }

      const landedUrl =
        typeof shortResp.url === "string" ? shortResp.url.trim() : "";
      if (
        landedUrl &&
        !isAllowedTikTokParsePageUrl(landedUrl, extraAllowedOrigins)
      ) {
        safeCancelBody(shortResp);
        throw new TikTokClientParseError(
          "UPSTREAM_UNAVAILABLE",
          "TikTok 短链跳转目标不在允许域名范围内",
          502,
        );
      }

      if (shortResp.status === 404 || shortResp.status === 410) {
        safeCancelBody(shortResp);
        throw new TikTokClientParseError(
          "CONTENT_UNAVAILABLE",
          "该 TikTok 分享短链已失效或作品不可见",
          404,
        );
      }
      if (shortResp.status === 403 || shortResp.status === 429) {
        safeCancelBody(shortResp);
        throw new TikTokClientParseError(
          "UPSTREAM_BLOCKED",
          "TikTok 当前触发访问验证，请稍后重试",
          403,
        );
      }
      if (shortResp.status >= 500) {
        safeCancelBody(shortResp);
        throw new TikTokClientParseError(
          "UPSTREAM_UNAVAILABLE",
          "TikTok 短链上游服务暂时不可用，请稍后重试",
          502,
        );
      }

      const landedTarget = extractTikTokTarget(landedUrl);
      if (!landedTarget || landedTarget.kind !== "item") {
        safeCancelBody(shortResp);
        throw new TikTokClientParseError(
          "CONTENT_UNAVAILABLE",
          "该 TikTok 分享短链已失效或作品不可见",
          404,
        );
      }
      canonicalUrl = landedTarget.canonicalUrl;

      let landedHost = "";
      try {
        landedHost = new URL(landedUrl).hostname.toLowerCase();
      } catch {
        landedHost = "";
      }
      if (shortResp.ok && landedHost === "www.tiktok.com") {
        hydrationResp = shortResp;
      } else {
        safeCancelBody(shortResp);
      }
    } else {
      canonicalUrl = target.canonicalUrl;
    }

    if (!hydrationResp) {
      try {
        hydrationResp = await fetchFn(canonicalUrl, {
          method: "GET",
          redirect: "follow",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
      } catch (err) {
        throw buildFetchError(err, "TikTok 页面请求失败，请稍后重试");
      }
    }

    const finalPageUrl =
      typeof hydrationResp!.url === "string" ? hydrationResp!.url.trim() : "";
    if (
      finalPageUrl &&
      !isAllowedTikTokParsePageUrl(finalPageUrl, extraAllowedOrigins)
    ) {
      safeCancelBody(hydrationResp);
      throw new TikTokClientParseError(
        "UPSTREAM_UNAVAILABLE",
        "TikTok 页面跳转目标不在允许域名范围内",
        502,
      );
    }

    if (hydrationResp!.status === 403 || hydrationResp!.status === 429) {
      safeCancelBody(hydrationResp);
      throw new TikTokClientParseError(
        "UPSTREAM_BLOCKED",
        "TikTok 当前触发访问验证，请稍后重试",
        403,
      );
    }
    if (hydrationResp!.status === 404 || hydrationResp!.status === 410) {
      safeCancelBody(hydrationResp);
      throw new TikTokClientParseError(
        "CONTENT_UNAVAILABLE",
        "该 TikTok 作品不可见或已被删除",
        404,
      );
    }
    if (hydrationResp!.status >= 500) {
      safeCancelBody(hydrationResp);
      throw new TikTokClientParseError(
        "UPSTREAM_UNAVAILABLE",
        "TikTok 上游服务暂时不可用，请稍后重试",
        502,
      );
    }

    if (finalPageUrl && !isLoopbackExtraOriginMatch(new URL(finalPageUrl), extraAllowedOrigins)) {
      const landedItem = extractTikTokTarget(finalPageUrl);
      if (!landedItem || landedItem.kind !== "item") {
        safeCancelBody(hydrationResp);
        throw new TikTokClientParseError(
          "CONTENT_UNAVAILABLE",
          "该 TikTok 作品不可见或已被删除",
          404,
        );
      }
    }

    const html = await readBoundedResponseText(
      hydrationResp!,
      TIKTOK_HYDRATION_MAX_BYTES,
    );
    const extracted = extractTikTokVideoDetailFromHtml(html);
    if (!extracted.found) {
      if (isSlardarWafPage(hydrationResp!.status, html)) {
        throw new TikTokClientParseError(
          "UPSTREAM_BLOCKED",
          "TikTok 当前触发访问验证，请稍后重试",
          403,
        );
      }
      throw new TikTokClientParseError(
        "UPSTREAM_INVALID_RESPONSE",
        "TikTok 页面数据格式异常，请稍后重试",
        502,
      );
    }
    if (extracted.parseError || !extracted.detail) {
      throw new TikTokClientParseError(
        "UPSTREAM_INVALID_RESPONSE",
        "TikTok 水合数据解析失败，请稍后重试",
        502,
      );
    }

    const detail = extracted.detail;
    const statusCode = parseFlexInt(detail.statusCode);
    if (UNAVAILABLE_STATUS_CODES.has(statusCode)) {
      throw new TikTokClientParseError(
        "CONTENT_UNAVAILABLE",
        "该 TikTok 作品已删除、设为私密或当前区域不可见",
        404,
      );
    }
    if (statusCode !== 0) {
      throw new TikTokClientParseError(
        "UPSTREAM_UNAVAILABLE",
        "TikTok 暂未返回作品数据，请稍后重试",
        502,
      );
    }

    const projected = projectVideoDetailForFinalize(detail);
    const itemInfo = projected.itemInfo as
      | { itemStruct?: Record<string, unknown> }
      | undefined;
    const itemStruct = itemInfo?.itemStruct;
    if (!itemStruct || typeof itemStruct !== "object") {
      throw new TikTokClientParseError(
        "UPSTREAM_UNAVAILABLE",
        "TikTok 暂未返回作品数据，请稍后重试",
        502,
      );
    }

    // Photo Mode: zero /aweme/v1/play/ requests.
    const imagePost = itemStruct.imagePost as
      | { images?: unknown[] }
      | undefined;
    if (Array.isArray(imagePost?.images) && imagePost.images.length > 0) {
      return {
        source_url: canonicalUrl,
        video_detail: projected,
        resolved_tiers: [],
      };
    }

    // Video Mode: resolve representative /aweme/v1/play/ redirect tiers.
    if (itemStruct.video && typeof itemStruct.video === "object") {
      const playUrls = selectTikTokVideoPlayUrls(
        itemStruct.video,
        extraAllowedOrigins,
      );
      if (playUrls.length === 0) {
        throw new TikTokClientParseError(
          "NO_MEDIA",
          "该 TikTok 作品未提供可解析的视频流",
          404,
        );
      }
      const resolvedTiers = await resolvePlay302TiersConcurrent(
        playUrls,
        fetchFn,
        controller.signal,
        extraAllowedOrigins,
      );
      if (resolvedTiers.length === 0) {
        throw new TikTokClientParseError(
          "UPSTREAM_UNAVAILABLE",
          "TikTok 视频直链解析失败，请稍后重试",
          502,
        );
      }
      return {
        source_url: canonicalUrl,
        video_detail: projected,
        resolved_tiers: resolvedTiers,
      };
    }

    throw new TikTokClientParseError(
      "NO_MEDIA",
      "该 TikTok 作品未找到可下载的媒体资源",
      404,
    );
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
