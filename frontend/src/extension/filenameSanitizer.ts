/**
 * Cross-platform safe filename & relative download path builder for `chrome.downloads.download`.
 *
 * Guarantees:
 * - Strips `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, and ASCII control chars `0x00–0x1f` / `0x7f`.
 * - Rejects/strips `.` and `..` path traversal segments and leading/trailing slashes.
 * - Strips trailing `.` and spaces on every folder & filename stem (Windows filesystem safety).
 * - Prefixes `_` on Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`,
 *   `COM1`–`COM9`, `LPT1`–`LPT9`, case-insensitive, with or without extension).
 * - Truncates by Unicode code points (`Array.from`) — `<= 60` for folder segments,
 *   `<= 100` for file stems — never splitting UTF-16 surrogate pairs.
 */

export const MAX_FOLDER_CODE_POINTS = 60 as const;
export const MAX_STEM_CODE_POINTS = 100 as const;

const FORBIDDEN_SEGMENT_CHARS_RE = /[/\\:*?"<>|\x00-\x1f\x7f]/g;
const WINDOWS_RESERVED_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const TRAILING_DOTS_AND_SPACES_RE = /[. \t\u00a0\u3000]+$/gu;
const LEADING_DOTS_AND_SPACES_RE = /^[. \t\u00a0\u3000]+/gu;

function truncateCodePoints(input: string, maxCodePoints: number): string {
  const limit = Math.max(1, Math.floor(maxCodePoints));
  const codePoints = Array.from(input);
  if (codePoints.length <= limit) {
    return input;
  }
  return codePoints.slice(0, limit).join("");
}

function escapeWindowsReservedName(
  segment: string,
  maxCodePoints: number,
): string {
  if (!WINDOWS_RESERVED_DEVICE_RE.test(segment)) {
    return segment;
  }
  return truncateCodePoints(`_${segment}`, maxCodePoints).replace(
    TRAILING_DOTS_AND_SPACES_RE,
    "",
  );
}

export interface SanitizeSegmentOptions {
  maxCodePoints?: number;
  fallback?: string;
}

/**
 * Sanitizes a single path or filename stem segment (contains zero `/` or `\`).
 */
export function sanitizeFilenameSegment(
  raw: string,
  options?: SanitizeSegmentOptions,
): string {
  const maxCodePoints = options?.maxCodePoints ?? MAX_STEM_CODE_POINTS;
  const fallback = options?.fallback ?? "download";

  if (typeof raw !== "string") {
    return fallback;
  }

  // Strip control characters first, normalize slashes to strip `.` / `..` traversal pieces cleanly
  const withoutControls = raw.replace(/[\x00-\x1f\x7f]/g, "");
  const nonTraversalParts = withoutControls
    .split(/[/\\]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "." && part !== "..");

  let cleaned = nonTraversalParts
    .join(" ")
    .replace(FORBIDDEN_SEGMENT_CHARS_RE, "")
    .replace(/\s+/g, " ")
    .replace(LEADING_DOTS_AND_SPACES_RE, "")
    .replace(TRAILING_DOTS_AND_SPACES_RE, "");

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return fallback;
  }

  cleaned = escapeWindowsReservedName(cleaned, maxCodePoints);
  cleaned = truncateCodePoints(cleaned, maxCodePoints).replace(
    TRAILING_DOTS_AND_SPACES_RE,
    "",
  );
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return fallback;
  }
  // Re-check Windows reserved name in case truncation shortened a longer name to e.g. `CON`
  cleaned = escapeWindowsReservedName(cleaned, maxCodePoints);

  return cleaned || fallback;
}

/**
 * Sanitizes an optional user-configured relative subfolder prefix (e.g. `"DokiTool"` or `"DokiTool/Clips"`).
 * Drops leading/trailing slashes and `.` / `..` segments; caps each folder segment to `<= 60` code points.
 */
export function sanitizeSubfolderPrefix(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    return "";
  }
  const withoutControls = raw.replace(/[\x00-\x1f\x7f]/g, "");
  const safeSegments: string[] = [];

  for (const rawPart of withoutControls.split(/[/\\]+/)) {
    const trimmed = rawPart.trim();
    if (!trimmed || trimmed === "." || trimmed === "..") {
      continue;
    }
    const seg = sanitizeFilenameSegment(trimmed, {
      maxCodePoints: MAX_FOLDER_CODE_POINTS,
      fallback: "",
    });
    if (seg && seg !== "." && seg !== "..") {
      safeSegments.push(seg);
    }
  }

  return safeSegments.join("/");
}

/**
 * Formats a 1-based item index as zero-padded `"001"` (expands width automatically when `totalCount >= 1000`).
 */
export function formatBatchItemIndex(
  index: number,
  totalCount = 0,
  minDigits = 3,
): string {
  const safeIndex =
    Number.isFinite(index) && index >= 1 ? Math.floor(index) : 1;
  const width = Math.max(
    minDigits,
    totalCount > 0 ? String(Math.floor(totalCount)).length : minDigits,
  );
  return String(safeIndex).padStart(width, "0");
}

/**
 * Strict safe allowlist of passive media, subtitle, plain-text, archive, and binary
 * fallback extensions permitted for Chrome extension downloads & ZIP entries.
 * Blocks active/executable suffixes (e.g. html, svg, sh, command, bat, exe, ps1, hta).
 */
export const KNOWN_SAFE_DOWNLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp4",
  "m4v",
  "webm",
  "mov",
  "mkv",
  "m4a",
  "mp3",
  "aac",
  "ogg",
  "opus",
  "wav",
  "flac",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "ts",
  "vtt",
  "srt",
  "txt",
  "zip",
  "bin",
]);

export function isSafeDownloadExtension(rawExt?: string): boolean {
  if (typeof rawExt !== "string") return false;
  const cleaned = rawExt
    .trim()
    .replace(/^\.+/, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
  return Boolean(cleaned) && KNOWN_SAFE_DOWNLOAD_EXTENSIONS.has(cleaned);
}

export function sanitizeFileExtension(
  rawExt?: string,
  fallbackExt = "bin",
): string {
  if (typeof rawExt !== "string") return "";
  const cleaned = rawExt
    .trim()
    .replace(/^\.+/, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase()
    .slice(0, 16);
  if (!cleaned) return "";
  if (KNOWN_SAFE_DOWNLOAD_EXTENSIONS.has(cleaned)) {
    return cleaned;
  }
  const safeFallback =
    typeof fallbackExt === "string" &&
    KNOWN_SAFE_DOWNLOAD_EXTENSIONS.has(fallbackExt.toLowerCase())
      ? fallbackExt.toLowerCase()
      : "bin";
  return safeFallback;
}

export interface BuildSafeDownloadPathParams {
  prefix?: string;
  subfolder?: string;
  stem?: string;
  ext?: string;
  /** Optional 1-based item index (`1` -> `"001"`). */
  index?: number;
  /** Optional total item count used to widen index padding when `>= 1000`. */
  totalCount?: number;
}

/**
 * Builds a clean, traversal-free relative path for `chrome.downloads.download({ filename })`.
 *
 * Examples:
 * - `{ prefix: "DokiTool", subfolder: "图集标题", index: 1, ext: "jpg" }` -> `"DokiTool/图集标题/001.jpg"`
 * - `{ prefix: "", subfolder: "多P合集", index: 2, stem: "第二集", ext: ".mp4" }` -> `"多P合集/002_第二集.mp4"`
 * - `{ stem: "nul", ext: "mp4" }` -> `"_nul.mp4"`
 */
export function buildSafeDownloadPath(
  params: BuildSafeDownloadPathParams,
): string {
  const cleanPrefix = sanitizeSubfolderPrefix(params.prefix ?? "");
  const cleanSubfolder = params.subfolder
    ? sanitizeFilenameSegment(params.subfolder, {
        maxCodePoints: MAX_FOLDER_CODE_POINTS,
        fallback: "",
      })
    : "";

  const cleanExt = sanitizeFileExtension(params.ext, "bin");
  const rawExtLower =
    typeof params.ext === "string"
      ? params.ext
          .trim()
          .replace(/^\.+/, "")
          .replace(/[^A-Za-z0-9]/g, "")
          .toLowerCase()
      : "";
  let rawStem = typeof params.stem === "string" ? params.stem : "";

  // If caller passed a filename with matching `.ext` already attached (e.g. `stem: "nul.mp4", ext: "mp4"`),
  // strip the redundant suffix before re-attaching `.${cleanExt}` so we don't emit `_nul.mp4.mp4`.
  if (
    rawExtLower &&
    rawStem.toLowerCase().endsWith(`.${rawExtLower}`) &&
    rawStem.length > rawExtLower.length + 1
  ) {
    rawStem = rawStem.slice(0, -(rawExtLower.length + 1));
  } else if (
    cleanExt &&
    rawStem.toLowerCase().endsWith(`.${cleanExt}`) &&
    rawStem.length > cleanExt.length + 1
  ) {
    rawStem = rawStem.slice(0, -(cleanExt.length + 1));
  }

  let finalStem: string;
  if (params.index !== undefined) {
    const paddedIndex = formatBatchItemIndex(params.index, params.totalCount);
    const cleanedPart = rawStem
      ? sanitizeFilenameSegment(rawStem, {
          maxCodePoints: MAX_STEM_CODE_POINTS,
          fallback: "",
        })
      : "";
    const combined = cleanedPart ? `${paddedIndex}_${cleanedPart}` : paddedIndex;
    finalStem = sanitizeFilenameSegment(combined, {
      maxCodePoints: MAX_STEM_CODE_POINTS,
      fallback: paddedIndex,
    });
  } else {
    finalStem = sanitizeFilenameSegment(rawStem, {
      maxCodePoints: MAX_STEM_CODE_POINTS,
      fallback: "download",
    });
  }

  const filename = cleanExt ? `${finalStem}.${cleanExt}` : finalStem;
  return [cleanPrefix, cleanSubfolder, filename].filter(Boolean).join("/");
}
