#!/usr/bin/env node
/**
 * Automated Architecture Boundary Gate (Post-Issue-33).
 *
 * Enforces:
 * 1. Zero platform-name / CDN-host hardcoding in Web business layers
 *    (`src/components/**`, `src/composables/**`, `src/downloads/**`, `src/services/**`).
 * 2. Single-file line-count complexity caps for refactored modular directories
 *    (`src/core/**` <= 600 lines, `src/extension/bg/**` <= 900 lines,
 *    `src/extension/background.ts` <= 900 lines) AND repo-wide ratchet budget
 *    for all `.ts`, `.js`, and `.vue` files under `src/**` (excluding `*.generated.ts`, default <= 900 lines).
 * 3. Solid `background-color` fallback + `forced-colors` gate for all white-text
 *    `linear-gradient` / `bg-gradient-to-*` CSS rules and Vue templates.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDir, "..");
const srcRoot = path.join(frontendRoot, "src");

const BUSINESS_SCAN_DIRS = [
  "components",
  "composables",
  "downloads",
  "services",
];

const KNOWN_PLATFORM_LITERALS =
  "bilibili|youtube|douyin|xiaohongshu|weibo|kuaishou|pipixia|pipigx|zuiyou|x|instagram|facebook|tumblr|toutiao";

const PLATFORM_HARDCODE_PATTERNS = [
  {
    name: "platform-equality-branch",
    regex: new RegExp(
      `\\bplatform\\s*[!=]==?\\s*["'](?:${KNOWN_PLATFORM_LITERALS})["']`,
      "i",
    ),
  },
  {
    name: "platform-switch-case",
    regex: new RegExp(
      `\\bcase\\s+["'](?:${KNOWN_PLATFORM_LITERALS})["']\\s*:`,
      "i",
    ),
  },
  {
    name: "platform-array-includes",
    regex: new RegExp(
      `\\[[^\\]]*["'](?:${KNOWN_PLATFORM_LITERALS})["'][^\\]]*\\]\\s*\\.includes\\s*\\(`,
      "i",
    ),
  },
  {
    name: "cdn-host-suffix-hardcode",
    regex:
      /\.endsWith\(\s*["']\.(?:bilivideo|googlevideo|toutiaovod|douyinvod|weibocdn|xhscdn|rednotecdn|twimg|kwimgs|ppxvod)/i,
  },
];

const FILE_LINE_LIMITS = [
  { relDir: "core", maxLines: 600 },
  { relDir: path.join("extension", "bg"), maxLines: 900 },
  { relDir: path.join("extension", "planning"), maxLines: 900 },
];

const PLANNING_FORBIDDEN_TARGETS = new Set([
  "extension/extensionDownload",
  "extension/offscreen",
  "extension/dashMuxDownload",
  "extension/opfsStreamTransfer",
  "extension/youtubeExtensionBridge",
]);

const BG_FORBIDDEN_TARGETS = new Set([
  "extension/extensionDownload",
  "extension/offscreen",
]);

const PLANNING_HOST_SIDE_EFFECT_PATTERNS = [
  { name: "chrome-api", regex: /\bchrome\s*\./ },
  { name: "navigator-storage", regex: /\bnavigator\s*\.\s*storage\b/ },
  { name: "navigator-locks", regex: /\bnavigator\s*\.\s*locks\b/ },
  { name: "window-global", regex: /\bwindow\s*\./ },
  { name: "document-global", regex: /\bdocument\s*\./ },
  { name: "fetch-call", regex: /\bfetch\s*\(/ },
];

const SINGLE_FILE_LINE_LIMITS = [
  { relFile: path.join("extension", "background.ts"), maxLines: 900 },
];

export const DEFAULT_SRC_FILE_LINE_LIMIT = 900;

/**
 * Repo-wide single-file line ratchet ceilings for legacy `frontend/src/**` files
 * currently above DEFAULT_SRC_FILE_LINE_LIMIT (900 lines).
 *
 * Policy:
 * - Every new `.ts`, `.js`, or `.vue` file under `frontend/src/**` (excluding `*.generated.ts`)
 *   must stay <= 900 lines.
 * - Legacy oversized files are locked at `ceil_to_10(actual_lines + 50)` (+50 to +59 lines
 *   breathing buffer for routine hotfixes, defensive nil/boundary guards, i18n copy, and
 *   comments, while still hard-blocking 60+ line feature bloat).
 * - Cohesive Split Policy (anti-fragmentation):
 *   * Use the +50-line breathing buffer for routine small fixes and defensive guards.
 *   * NEVER carve out < 60-line non-domain grab-bag files (e.g. `*_helpers2` / `*_misc`)
 *     or delete useful comments / compress multiline guards solely to dodge a line cap.
 *   * Split only when a complete protocol or subsystem responsibility crosses its ceiling,
 *     creating cohesive domain-scoped modules.
 * - When a ratcheted file shrinks to <= 900 lines it PASSES cleanly (with an
 *   informational notice). Deleting a ratcheted file without removing its entry
 *   from this table fails loudly.
 */
export const LEGACY_FILE_LINE_RATCHETS = Object.freeze({
  "src/components/ResultSection.vue": 1840,
  "src/components/result/ResultDetailsSidebar.vue": 1240,
  "src/composables/useMediaDownload.ts": 1680,
  "src/extension/SidePanelApp.vue": 1690,
  "src/extension/components/SidePanelResult.vue": 2850,
  "src/extension/components/SidePanelSettings.vue": 990,
  "src/extension/extensionDownload.ts": 1810,
  "src/extension/opfsStreamTransfer.ts": 1790,
  "src/extension/uiTargetHelpers.ts": 2160,
  "src/extension/urlMatcher.ts": 1160,
  "src/monitor/MonitorApp.vue": 2340,
  "src/utils/youtubeHelperCore.js": 3160,
});

function countSourceLines(raw) {
  if (raw.length === 0) return 0;
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  return normalized.split("\n").length;
}

function toPosixRel(baseDir, absPath) {
  return path.relative(baseDir, absPath).split(path.sep).join("/");
}

function walkFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      results.push(...walkFiles(abs, exts));
    } else if (ent.isFile() && exts.includes(path.extname(ent.name))) {
      results.push(abs);
    }
  }
  return results.sort();
}

function stripCommentsPreserveLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, prefix) => prefix);
}

/**
 * Extracts static and dynamic ESM/TypeScript module specifiers from
 * comment-stripped source (`import ... from "..."`, `export ... from "..."`,
 * side-effect `import "..."`, and `import("...")`).
 */
export function extractModuleSpecifiers(strippedSource) {
  const results = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^;'"`]*?)\bfrom\s*["']([^"'\n]+)["']/g,
    /(?:^|[;\n])\s*import\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(strippedSource)) !== null) {
      const lineNo =
        strippedSource.slice(0, match.index).split("\n").length;
      results.push({ specifier: match[1], lineNo });
    }
  }
  return results;
}

function normalizeResolvedModuleTarget(targetSrcRoot, filePath, specifier) {
  if (!specifier.startsWith(".")) {
    return { isRelative: false, normalized: specifier };
  }
  const absResolved = path.resolve(path.dirname(filePath), specifier);
  const relPosix = toPosixRel(targetSrcRoot, absResolved).replace(
    /\.(?:mts|cts|tsx|ts|mjs|cjs|jsx|js|vue)$/i,
    "",
  );
  return { isRelative: true, normalized: relPosix };
}

function checkExtensionImportDirections(
  targetFrontendRoot,
  targetSrcRoot,
  violations,
) {
  let checked = 0;

  // 4a. src/extension/planning/** must stay pure (no offscreen/bg/JSZip imports or host side effects)
  const planningDir = path.join(targetSrcRoot, "extension", "planning");
  for (const filePath of walkFiles(planningDir, [".ts", ".js"])) {
    checked++;
    const rel = toPosixRel(targetFrontendRoot, filePath);
    const stripped = stripCommentsPreserveLines(fs.readFileSync(filePath, "utf8"));
    for (const { specifier, lineNo } of extractModuleSpecifiers(stripped)) {
      const target = normalizeResolvedModuleTarget(
        targetSrcRoot,
        filePath,
        specifier,
      );
      const isForbidden =
        (!target.isRelative &&
          (target.normalized === "jszip" ||
            target.normalized.startsWith("jszip/"))) ||
        (target.isRelative &&
          (PLANNING_FORBIDDEN_TARGETS.has(target.normalized) ||
            target.normalized === "extension/bg" ||
            target.normalized.startsWith("extension/bg/")));
      if (isForbidden) {
        violations.push(
          `[import-direction] ${rel}:${lineNo}: planning module must not import "${specifier}" (${target.normalized})`,
        );
      }
    }
    const lines = stripped.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const rule of PLANNING_HOST_SIDE_EFFECT_PATTERNS) {
        if (rule.regex.test(lines[i])) {
          violations.push(
            `[planning-host-side-effect] ${rel}:${i + 1} (${rule.name}): pure planning module must not access browser/host side-effect globals`,
          );
        }
      }
    }
  }

  // 4b. src/extension/bg/** must never pull in extensionDownload / offscreen / jszip
  const bgDir = path.join(targetSrcRoot, "extension", "bg");
  for (const filePath of walkFiles(bgDir, [".ts", ".js"])) {
    checked++;
    const rel = toPosixRel(targetFrontendRoot, filePath);
    const stripped = stripCommentsPreserveLines(fs.readFileSync(filePath, "utf8"));
    for (const { specifier, lineNo } of extractModuleSpecifiers(stripped)) {
      const target = normalizeResolvedModuleTarget(
        targetSrcRoot,
        filePath,
        specifier,
      );
      const isForbidden =
        (!target.isRelative &&
          (target.normalized === "jszip" ||
            target.normalized.startsWith("jszip/"))) ||
        (target.isRelative && BG_FORBIDDEN_TARGETS.has(target.normalized));
      if (isForbidden) {
        violations.push(
          `[import-direction] ${rel}:${lineNo}: background module must not import "${specifier}" (${target.normalized}); import from ../planning/* instead`,
        );
      }
    }
  }

  return checked;
}

function extractStyleBlocks(filePath, source) {
  if (!filePath.endsWith(".vue")) {
    return [{ css: source, baseLine: 1 }];
  }
  const blocks = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let match;
  while ((match = re.exec(source)) !== null) {
    const prefix = source.slice(0, match.index);
    const baseLine = prefix.split("\n").length;
    blocks.push({ css: match[1], baseLine });
  }
  return blocks;
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function checkWhiteGradientCssRules(filePath, rawSource, violations) {
  const rel = path.relative(frontendRoot, filePath);
  const blocks = extractStyleBlocks(filePath, rawSource);
  for (const { css, baseLine } of blocks) {
    const cleaned = stripCssComments(css);
    const ruleRe = /([^{}@][^{}]*)\{([^{}]+)\}/g;
    let match;
    while ((match = ruleRe.exec(cleaned)) !== null) {
      const selector = match[1].trim().replace(/\s+/g, " ");
      const body = match[2];
      if (/background-clip\s*:\s*text/i.test(body)) continue;
      const hasGradient = /linear-gradient\s*\(/i.test(body);
      const hasWhiteText =
        /(?:^|[;\s])color\s*:\s*(?:#fff(?:\b|;)|#ffffff(?:\b|;)|white(?:\b|;)|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))/i.test(
          body,
        );
      if (!hasGradient || !hasWhiteText) continue;

      const lineOffset = cleaned.slice(0, match.index).split("\n").length - 1;
      const lineNo = baseLine + lineOffset;

      const bgColorMatches = [
        ...body.matchAll(
          /(?:^|[;\s])background-color\s*:\s*([^;]+)/gi,
        ),
      ];
      const hasSolidBgColor = bgColorMatches.some((m) => {
        const val = m[1].trim().toLowerCase();
        return (
          val !== "" &&
          val !== "transparent" &&
          val !== "none" &&
          val !== "inherit" &&
          val !== "initial" &&
          val !== "unset"
        );
      });

      if (!hasSolidBgColor) {
        violations.push(
          `[css-solid-fallback] ${rel}:${lineNo} (${selector}): white text with linear-gradient lacks non-transparent background-color fallback`,
        );
        continue;
      }

      // Ensure no subsequent `background:` shorthand resets `background-color` back to transparent
      const lastBgColorIdx = Math.max(
        ...bgColorMatches.map((m) => m.index ?? -1),
      );
      const shorthandMatches = [
        ...body.matchAll(/(?:^|[;\s])background\s*:\s*([^;]+)/gi),
      ];
      const overwrittenByShorthand = shorthandMatches.some(
        (m) =>
          (m.index ?? -1) > lastBgColorIdx &&
          /linear-gradient\s*\(/i.test(m[1]),
      );
      if (overwrittenByShorthand) {
        violations.push(
          `[css-solid-fallback] ${rel}:${lineNo} (${selector}): \`background: linear-gradient(...)\` shorthand resets earlier \`background-color\` to transparent; use \`background-image: linear-gradient(...)\``,
        );
      }
    }
  }
}

function checkTailwindGradientWhiteText(filePath, rawSource, violations) {
  const rel = path.relative(frontendRoot, filePath);
  const lines = rawSource.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("bg-gradient-to-")) continue;
    if (!line.includes("text-white")) continue;
    if (line.includes("bg-clip-text")) continue;
    const hasSolidTailwindBg =
      /\bbg-(?:indigo|purple|violet|blue|sky|emerald|green|teal|slate|gray|zinc|neutral|stone|rose|pink|red|amber|orange|black|\[#[^\]]+\])(?:-\d{2,3})?(?:\b|\/)/.test(
        line,
      );
    if (!hasSolidTailwindBg) {
      violations.push(
        `[css-tailwind-solid-fallback] ${rel}:${i + 1}: \`bg-gradient-to-*\` with \`text-white\` lacks solid Tailwind \`bg-<color>\` fallback`,
      );
    }
  }
}

export function runArchitectureBoundaryCheck(options = {}) {
  const checkDist = Boolean(options.checkDist);
  const targetFrontendRoot = options.frontendRoot
    ? path.resolve(options.frontendRoot)
    : frontendRoot;
  const targetSrcRoot = path.join(targetFrontendRoot, "src");
  const defaultLineLimit =
    typeof options.defaultLineLimit === "number"
      ? options.defaultLineLimit
      : DEFAULT_SRC_FILE_LINE_LIMIT;
  const legacyRatchets =
    options.legacyRatchets !== undefined
      ? options.legacyRatchets
      : LEGACY_FILE_LINE_RATCHETS;

  const violations = [];
  const ratchetNotices = [];
  let businessFilesChecked = 0;
  let lineCapFilesChecked = 0;
  let ratchetFilesChecked = 0;
  let cssFilesChecked = 0;

  // 1. Zero platform/CDN-host hardcoding in Web business layers
  for (const relDir of BUSINESS_SCAN_DIRS) {
    const dir = path.join(targetSrcRoot, relDir);
    for (const filePath of walkFiles(dir, [".ts", ".js", ".vue"])) {
      businessFilesChecked++;
      const raw = fs.readFileSync(filePath, "utf8");
      const stripped = stripCommentsPreserveLines(raw);
      const lines = stripped.split("\n");
      const rel = toPosixRel(targetFrontendRoot, filePath);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const rule of PLATFORM_HARDCODE_PATTERNS) {
          if (rule.regex.test(line)) {
            violations.push(
              `[${rule.name}] ${rel}:${i + 1}: ${line.trim().slice(0, 120)}`,
            );
          }
        }
      }
    }
  }

  // 2a. Single-file line-count complexity caps for refactored core/bg modules
  for (const { relDir, maxLines } of FILE_LINE_LIMITS) {
    const dir = path.join(targetSrcRoot, relDir);
    for (const filePath of walkFiles(dir, [".ts", ".js"])) {
      lineCapFilesChecked++;
      const lineCount = countSourceLines(fs.readFileSync(filePath, "utf8"));
      if (lineCount > maxLines) {
        const rel = toPosixRel(targetFrontendRoot, filePath);
        violations.push(
          `[file-line-cap] ${rel}: ${lineCount} lines exceeds limit of ${maxLines}`,
        );
      }
    }
  }
  for (const { relFile, maxLines } of SINGLE_FILE_LINE_LIMITS) {
    const filePath = path.join(targetSrcRoot, relFile);
    if (!fs.existsSync(filePath)) continue;
    lineCapFilesChecked++;
    const lineCount = countSourceLines(fs.readFileSync(filePath, "utf8"));
    if (lineCount > maxLines) {
      const rel = toPosixRel(targetFrontendRoot, filePath);
      violations.push(
        `[file-line-cap] ${rel}: ${lineCount} lines exceeds limit of ${maxLines}`,
      );
    }
  }

  // 2b. Repo-wide single-file ratchet budget across all src/**/*.{ts,js,vue} (excluding *.generated.ts)
  const seenRatchets = new Set();
  for (const filePath of walkFiles(targetSrcRoot, [".ts", ".js", ".vue"])) {
    if (filePath.endsWith(".generated.ts")) continue;
    ratchetFilesChecked++;
    const rel = toPosixRel(targetFrontendRoot, filePath);
    const lineCount = countSourceLines(fs.readFileSync(filePath, "utf8"));
    if (Object.prototype.hasOwnProperty.call(legacyRatchets, rel)) {
      seenRatchets.add(rel);
      const ceiling = legacyRatchets[rel];
      if (lineCount > ceiling) {
        violations.push(
          `[file-line-ratchet] ${rel}: ${lineCount} lines exceeds legacy ratchet ceiling of ${ceiling} (default max ${defaultLineLimit}; refactor instead of growing)`,
        );
      } else if (lineCount <= defaultLineLimit) {
        ratchetNotices.push(
          `${rel}: shrunk to ${lineCount} lines (<= ${defaultLineLimit}); eligible to remove from LEGACY_FILE_LINE_RATCHETS`,
        );
      }
    } else if (lineCount > defaultLineLimit) {
      violations.push(
        `[file-line-ratchet] ${rel}: ${lineCount} lines exceeds default max of ${defaultLineLimit} lines`,
      );
    }
  }
  for (const rel of Object.keys(legacyRatchets).sort()) {
    if (!seenRatchets.has(rel)) {
      violations.push(
        `[file-line-ratchet-stale] ${rel}: entry in LEGACY_FILE_LINE_RATCHETS no longer exists on disk (remove stale entry)`,
      );
    }
  }

  // 3. CSS solid-fallback + forced-colors gate across src/** and dist/assets/*.css
  for (const filePath of walkFiles(targetSrcRoot, [".css", ".vue"])) {
    cssFilesChecked++;
    const raw = fs.readFileSync(filePath, "utf8");
    checkWhiteGradientCssRules(filePath, raw, violations);
    checkTailwindGradientWhiteText(filePath, raw, violations);
  }

  const styleCssPath = path.join(targetSrcRoot, "style.css");
  const styleCss = fs.readFileSync(styleCssPath, "utf8");
  if (!/@media\s*\(\s*forced-colors\s*:\s*active\s*\)/i.test(styleCss)) {
    violations.push(
      "[css-forced-colors] src/style.css: missing `@media (forced-colors: active)` adaptation for primary buttons",
    );
  }
  const designCssPath = path.join(targetSrcRoot, "assets", "design-system.css");
  const designCss = fs.readFileSync(designCssPath, "utf8");
  if (!/@media\s*\(\s*forced-colors\s*:\s*active\s*\)/i.test(designCss)) {
    violations.push(
      "[css-forced-colors] src/assets/design-system.css: missing `@media (forced-colors: active)` adaptation for .ux-btn-primary",
    );
  }

  // Optionally scan built dist/assets/*.css when --check-dist is requested (post-build gate)
  const distAssetsDir = path.join(targetFrontendRoot, "dist", "assets");
  let distCssFilesChecked = 0;
  if (checkDist) {
    for (const filePath of walkFiles(distAssetsDir, [".css"])) {
      distCssFilesChecked++;
      const raw = fs.readFileSync(filePath, "utf8");
      checkWhiteGradientCssRules(filePath, raw, violations);
    }
  }

  // 4. Static ESM/TS import direction & planning host-purity gate
  const importDirectionFilesChecked = checkExtensionImportDirections(
    targetFrontendRoot,
    targetSrcRoot,
    violations,
  );

  return {
    passed: violations.length === 0,
    businessFilesChecked,
    lineCapFilesChecked,
    ratchetFilesChecked,
    ratchetNotices,
    cssFilesChecked,
    distCssFilesChecked,
    importDirectionFilesChecked,
    violations,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const checkDist = process.argv.includes("--check-dist");
  const result = runArchitectureBoundaryCheck({ checkDist });
  for (const note of result.ratchetNotices) {
    console.log(`NOTICE: ${note}`);
  }
  if (!result.passed) {
    console.error(
      `Architecture boundary check FAILED (${result.violations.length} violation(s)):`,
    );
    for (const v of result.violations) {
      console.error(`  - ${v}`);
    }
    process.exit(1);
  }
  console.log(
    `Architecture boundary check PASSED (business=${result.businessFilesChecked}, lineCap=${result.lineCapFilesChecked}, ratchet=${result.ratchetFilesChecked}, css=${result.cssFilesChecked}, distCss=${result.distCssFilesChecked}, importDir=${result.importDirectionFilesChecked})`,
  );
}
