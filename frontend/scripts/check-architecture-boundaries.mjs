#!/usr/bin/env node
/**
 * Automated Architecture Boundary Gate (Post-Issue-33).
 *
 * Enforces:
 * 1. Zero platform-name / CDN-host hardcoding in Web business layers
 *    (`src/components/**`, `src/composables/**`, `src/downloads/**`, `src/services/**`).
 * 2. Single-file line-count complexity caps for refactored modular directories
 *    (`src/core/**` <= 600 lines, `src/extension/bg/**` <= 900 lines).
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
];

const SINGLE_FILE_LINE_LIMITS = [
  { relFile: path.join("extension", "background.ts"), maxLines: 900 },
];

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
  const violations = [];
  let businessFilesChecked = 0;
  let lineCapFilesChecked = 0;
  let cssFilesChecked = 0;

  // 1. Zero platform/CDN-host hardcoding in Web business layers
  for (const relDir of BUSINESS_SCAN_DIRS) {
    const dir = path.join(srcRoot, relDir);
    for (const filePath of walkFiles(dir, [".ts", ".js", ".vue"])) {
      businessFilesChecked++;
      const raw = fs.readFileSync(filePath, "utf8");
      const stripped = stripCommentsPreserveLines(raw);
      const lines = stripped.split("\n");
      const rel = path.relative(frontendRoot, filePath);
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

  // 2. Single-file line-count complexity caps for refactored core/bg modules
  for (const { relDir, maxLines } of FILE_LINE_LIMITS) {
    const dir = path.join(srcRoot, relDir);
    for (const filePath of walkFiles(dir, [".ts", ".js"])) {
      lineCapFilesChecked++;
      const lineCount = fs.readFileSync(filePath, "utf8").split("\n").length;
      if (lineCount > maxLines) {
        const rel = path.relative(frontendRoot, filePath);
        violations.push(
          `[file-line-cap] ${rel}: ${lineCount} lines exceeds limit of ${maxLines}`,
        );
      }
    }
  }
  for (const { relFile, maxLines } of SINGLE_FILE_LINE_LIMITS) {
    const filePath = path.join(srcRoot, relFile);
    if (!fs.existsSync(filePath)) continue;
    lineCapFilesChecked++;
    const lineCount = fs.readFileSync(filePath, "utf8").split("\n").length;
    if (lineCount > maxLines) {
      const rel = path.relative(frontendRoot, filePath);
      violations.push(
        `[file-line-cap] ${rel}: ${lineCount} lines exceeds limit of ${maxLines}`,
      );
    }
  }

  // 3. CSS solid-fallback + forced-colors gate across src/** and dist/assets/*.css
  for (const filePath of walkFiles(srcRoot, [".css", ".vue"])) {
    cssFilesChecked++;
    const raw = fs.readFileSync(filePath, "utf8");
    checkWhiteGradientCssRules(filePath, raw, violations);
    checkTailwindGradientWhiteText(filePath, raw, violations);
  }

  const styleCss = fs.readFileSync(path.join(srcRoot, "style.css"), "utf8");
  if (!/@media\s*\(\s*forced-colors\s*:\s*active\s*\)/i.test(styleCss)) {
    violations.push(
      "[css-forced-colors] src/style.css: missing `@media (forced-colors: active)` adaptation for primary buttons",
    );
  }
  const designCss = fs.readFileSync(
    path.join(srcRoot, "assets", "design-system.css"),
    "utf8",
  );
  if (!/@media\s*\(\s*forced-colors\s*:\s*active\s*\)/i.test(designCss)) {
    violations.push(
      "[css-forced-colors] src/assets/design-system.css: missing `@media (forced-colors: active)` adaptation for .ux-btn-primary",
    );
  }

  // Optionally scan built dist/assets/*.css when --check-dist is requested (post-build gate)
  const distAssetsDir = path.join(frontendRoot, "dist", "assets");
  let distCssFilesChecked = 0;
  if (checkDist) {
    for (const filePath of walkFiles(distAssetsDir, [".css"])) {
      distCssFilesChecked++;
      const raw = fs.readFileSync(filePath, "utf8");
      checkWhiteGradientCssRules(filePath, raw, violations);
    }
  }

  return {
    passed: violations.length === 0,
    businessFilesChecked,
    lineCapFilesChecked,
    cssFilesChecked,
    distCssFilesChecked,
    violations,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const checkDist = process.argv.includes("--check-dist");
  const result = runArchitectureBoundaryCheck({ checkDist });
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
    `Architecture boundary check PASSED (business=${result.businessFilesChecked}, lineCap=${result.lineCapFilesChecked}, css=${result.cssFilesChecked}, distCss=${result.distCssFilesChecked})`,
  );
}
