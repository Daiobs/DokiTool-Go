/**
 * Post-download saved-filename integrity audit for Chrome MV3 downloads.
 * Detects third-party download-manager extensions overriding `onDeterminingFilename`
 * with a 36-char UUID or unrelated generic filename and emits a non-blocking warning.
 */

export const FILENAME_TAMPER_WARNING_ZH =
  "检测到浏览器内其他下载类扩展改写了保存文件名，可停用冲突下载插件或开启系统另存为直写";

export const FILENAME_TAMPER_WARNING_EN =
  "Another browser download extension rewrote the saved filename. Disable conflicting download extensions or enable Save-As direct write.";

const UUID_FILENAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\s*\(\d+\))?\.[a-z0-9]{1,12}$/i;

const UNIQUIFY_SUFFIX_RE = /\s*\(\d+\)$/;

export function extractPathBasename(rawPath: string | undefined | null): string {
  if (typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const slashIdx = normalized.lastIndexOf("/");
  return slashIdx >= 0 ? normalized.slice(slashIdx + 1) : normalized;
}

function splitStemAndExt(leaf: string): { stem: string; ext: string } {
  const dotIdx = leaf.lastIndexOf(".");
  if (dotIdx > 0 && dotIdx < leaf.length - 1) {
    return {
      stem: leaf.slice(0, dotIdx),
      ext: leaf.slice(dotIdx + 1).toLowerCase(),
    };
  }
  return { stem: leaf, ext: "" };
}

function normalizeStemForComparison(rawStem: string): string {
  return rawStem
    .replace(UNIQUIFY_SUFFIX_RE, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s._\-+()（）[\]【】]+/g, "")
    .trim();
}

export interface FilenameTamperAuditResult {
  tampered: boolean;
  reason?: "uuid_overwrite" | "stem_mismatch";
  warning?: string;
}

export function detectFilenameTampering(
  expectedRelativeFilename: string | undefined | null,
  actualSavedPath: string | undefined | null,
): FilenameTamperAuditResult {
  const expectedLeaf = extractPathBasename(expectedRelativeFilename);
  const actualLeaf = extractPathBasename(actualSavedPath);
  if (!expectedLeaf || !actualLeaf) {
    return { tampered: false };
  }

  if (UUID_FILENAME_RE.test(actualLeaf) && !UUID_FILENAME_RE.test(expectedLeaf)) {
    return {
      tampered: true,
      reason: "uuid_overwrite",
      warning: FILENAME_TAMPER_WARNING_ZH,
    };
  }

  const expectedNorm = normalizeStemForComparison(splitStemAndExt(expectedLeaf).stem);
  const actualNorm = normalizeStemForComparison(splitStemAndExt(actualLeaf).stem);
  if (!expectedNorm || !actualNorm) {
    return { tampered: false };
  }
  if (expectedNorm === actualNorm) {
    return { tampered: false };
  }

  // Tolerate OS path-length truncation or browser-appended suffixes while catching
  // wholesale replacement (e.g. `下载.mp4`, `videoplayback.mp4`, or random hashes).
  const minPrefix = Math.min(expectedNorm.length, actualNorm.length, 6);
  if (
    minPrefix >= 2 &&
    (actualNorm.startsWith(expectedNorm.slice(0, minPrefix)) ||
      expectedNorm.startsWith(actualNorm.slice(0, minPrefix)))
  ) {
    return { tampered: false };
  }
  if (
    expectedNorm.length >= 4 &&
    actualNorm.length >= 4 &&
    (actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm))
  ) {
    return { tampered: false };
  }

  return {
    tampered: true,
    reason: "stem_mismatch",
    warning: FILENAME_TAMPER_WARNING_ZH,
  };
}

export async function auditCompletedDownloadFilename(params: {
  downloadId: number;
  expectedFilename: string;
  deltaFilename?: string;
  observedFilenames: Map<number, string>;
  searchDownloads?: (query: { id?: number }) => Promise<Array<{ id: number; filename?: string }>>;
}): Promise<string | undefined> {
  let actualPath =
    params.deltaFilename || params.observedFilenames.get(params.downloadId) || "";
  params.observedFilenames.delete(params.downloadId);
  if (!actualPath && typeof params.searchDownloads === "function") {
    try {
      const items = await params.searchDownloads({ id: params.downloadId });
      const matched = Array.isArray(items) ? items[0] : undefined;
      if (typeof matched?.filename === "string" && matched.filename.trim()) {
        actualPath = matched.filename.trim();
      }
    } catch {
      // Best-effort lookup; never block download completion.
    }
  }
  if (!actualPath) return undefined;
  const audit = detectFilenameTampering(params.expectedFilename, actualPath);
  return audit.tampered ? audit.warning : undefined;
}
