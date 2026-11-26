// Stateless validation, URL/ID parsing, semver comparison, and sanitization
// helpers shared by the DokiTool YouTube userscript, extension, and Web UI.

export const MIN_YOUTUBE_HELPER_VERSION = "1.3.1";
export const MAX_HELPER_TITLE_CHARS = 200;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const TVHTML5_VERSION_RE = /^(?:7\.[0-9]{8}\.[0-9]{2}\.[0-9]{2}|5\.[0-9]{8})$/;
const GOOGLEVIDEO_HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.googlevideo\.com$/;
const YTIMG_HOST_RE = /^(?:i|img|[a-z0-9-]+)\.ytimg\.com$/;
const SEMVER_RE = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;
const VISITOR_DATA_TOKEN_RE = /Cg[A-Za-z0-9_-]{8,1024}(?:%3D|=)*/;
const VISITOR_DATA_EXACT_RE = /^Cg[A-Za-z0-9_-]{8,1024}(?:%3D|=)*$/;

export function isValidYouTubeVideoId(videoId) {
  return typeof videoId === "string" && VIDEO_ID_RE.test(videoId);
}

export function extractYouTubeVideoId(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim() || rawUrl.length > 2048) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }
  if (parsed.username || parsed.password) {
    return "";
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  let candidate = "";
  if (host === "youtu.be" || host === "www.youtu.be") {
    if (segments.length === 1) candidate = segments[0];
  } else if (
    ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(
      host,
    )
  ) {
    if (segments.length === 1 && segments[0].toLowerCase() === "watch") {
      candidate = parsed.searchParams.get("v") || "";
    } else if (
      segments.length === 2 &&
      ["shorts", "embed", "live", "v"].includes(segments[0].toLowerCase())
    ) {
      candidate = segments[1];
    }
  }
  return isValidYouTubeVideoId(candidate) ? candidate : "";
}

export function isValidSignatureTimestamp(sts) {
  return (
    typeof sts === "number" &&
    Number.isInteger(sts) &&
    sts >= 10000 &&
    sts <= 999999
  );
}

export function isValidTVHTML5Client(client) {
  if (!client || typeof client !== "object") return false;
  return (
    client.name === "TVHTML5" &&
    typeof client.version === "string" &&
    TVHTML5_VERSION_RE.test(client.version)
  );
}

export function isValidGooglevideoPlaybackUrl(rawUrl) {
  if (
    typeof rawUrl !== "string" ||
    !rawUrl.trim() ||
    rawUrl.length > 8192 ||
    rawUrl.includes("#")
  ) {
    return false;
  }
  for (let i = 0; i < rawUrl.length; i++) {
    const code = rawUrl.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f || code === 0x5c) {
      return false;
    }
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== "443") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!GOOGLEVIDEO_HOST_RE.test(host)) return false;
  return parsed.pathname === "/videoplayback";
}

export function isValidYouTubeThumbnailUrl(rawUrl) {
  if (
    typeof rawUrl !== "string" ||
    !rawUrl.trim() ||
    rawUrl.length > 2048 ||
    rawUrl.includes("#")
  ) {
    return false;
  }
  for (let i = 0; i < rawUrl.length; i++) {
    const code = rawUrl.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f || code === 0x5c) {
      return false;
    }
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== "443") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return YTIMG_HOST_RE.test(host) || host === "img.youtube.com";
}

export function compareSemver(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return NaN;
  const ma = SEMVER_RE.exec(a.trim());
  const mb = SEMVER_RE.exec(b.trim());
  if (!ma || !mb) return NaN;
  for (let i = 1; i <= 3; i++) {
    const na = Number(ma[i]);
    const nb = Number(mb[i]);
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export function isHelperVersionSupported(
  version,
  minVersion = MIN_YOUTUBE_HELPER_VERSION,
) {
  const cmp = compareSemver(version, minVersion);
  return !Number.isNaN(cmp) && cmp >= 0;
}

export function isValidVisitorDataToken(token) {
  return typeof token === "string" && VISITOR_DATA_EXACT_RE.test(token.trim());
}

export function extractVisitorDataFromSwResponse(rawText) {
  if (typeof rawText !== "string" || !rawText) return "";
  const stripped = rawText.replace(/^\)\]\}'\s*/, "");
  try {
    const parsed = JSON.parse(stripped);
    const candidate =
      parsed?.[0]?.[2]?.[6] || parsed?.[0]?.[2]?.[0]?.[0]?.[13] || "";
    if (typeof candidate === "string" && isValidVisitorDataToken(candidate)) {
      return candidate.trim();
    }
  } catch {
    // Fall back to regex extraction below
  }
  const match = VISITOR_DATA_TOKEN_RE.exec(rawText);
  return match && isValidVisitorDataToken(match[0]) ? match[0] : "";
}

export function sanitizeHelperFilename(rawName) {
  if (typeof rawName !== "string") {
    return { ok: false, filename: "", error: "文件名无效" };
  }
  const trimmed = rawName.trim();
  if (!trimmed || trimmed.length > 512) {
    return { ok: false, filename: "", error: "文件名长度无效" };
  }
  const lower = trimmed.toLowerCase();
  let ext = "";
  if (lower.endsWith(".mp4")) {
    ext = ".mp4";
  } else if (lower.endsWith(".m4a")) {
    ext = ".m4a";
  } else if (lower.endsWith(".webm")) {
    ext = ".webm";
  } else {
    return {
      ok: false,
      filename: "",
      error: "仅允许保存 .mp4、.m4a 或 .webm 后缀的文件",
    };
  }
  const stemRaw = trimmed.slice(0, trimmed.length - ext.length);
  const cleanedStem = stemRaw
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 120);
  const safeStem = cleanedStem || "youtube_media";
  return { ok: true, filename: `${safeStem}${ext}` };
}

export function sanitizeHelperText(raw, maxChars = MAX_HELPER_TITLE_CHARS) {
  if (typeof raw !== "string") return "";
  const stripped = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!stripped || maxChars <= 0) return stripped;
  const chars = Array.from(stripped);
  if (chars.length > maxChars) {
    return chars.slice(0, maxChars).join("").trim();
  }
  return stripped;
}
