#!/usr/bin/env node
/**
 * Automated Architecture Boundary Gate (Post-Issue-33).
 *
 * Enforces:
 * 1. Zero platform-name / CDN-host hardcoding in Web business layers
 *    (`src/components/**`, `src/composables/**`, `src/downloads/**`, `src/services/**`).
 * 2. Solid `background-color` fallback + `forced-colors` gate for all white-text
 *    `linear-gradient` / `bg-gradient-to-*` CSS rules and Vue templates (plus `--check-dist`).
 * 3. Static ESM/TS import direction & host-purity boundaries for `src/extension/planning/**`,
 *    `src/extension/bg/**`, and pure SFC view models (`monitorViewModel.ts`, `sidePanelResultModel.ts`).
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
  "bilibili|youtube|douyin|xiaohongshu|weibo|kuaishou|pipixia|pipigx|zuiyou|pinterest|tiktok|x|instagram|facebook|tumblr|toutiao";

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
      /\.endsWith\(\s*["']\.(?:bilivideo|googlevideo|toutiaovod|douyinvod|weibocdn|xhscdn|rednotecdn|twimg|kwimgs|ppxvod|pinimg|tiktokcdn|tiktokv)/i,
  },
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

const PURE_VIEW_MODEL_FILES = [
  path.join("monitor", "monitorViewModel.ts"),
  path.join("extension", "sidePanelResultModel.ts"),
];

const VIEW_MODEL_FORBIDDEN_PACKAGES = new Set(["vue", "pinia", "jszip"]);

const VIEW_MODEL_FORBIDDEN_TARGETS = new Set([
  "extension/extensionDownload",
  "extension/offscreen",
  "extension/dashMuxDownload",
  "extension/opfsStreamTransfer",
  "extension/youtubeExtensionBridge",
  "extension/storage",
  "monitor/monitorStorage",
]);

const PLANNING_HOST_SIDE_EFFECT_PATTERNS = [
  { name: "chrome-api", regex: /\bchrome\s*\./ },
  { name: "navigator-storage", regex: /\bnavigator\s*\.\s*storage\b/ },
  { name: "navigator-locks", regex: /\bnavigator\s*\.\s*locks\b/ },
  { name: "window-global", regex: /\bwindow\s*\./ },
  { name: "document-global", regex: /\bdocument\s*\./ },
  { name: "fetch-call", regex: /\bfetch\s*\(/ },
];

const VIEW_MODEL_HOST_SIDE_EFFECT_PATTERNS = [
  ...PLANNING_HOST_SIDE_EFFECT_PATTERNS,
  { name: "web-storage", regex: /\b(?:localStorage|sessionStorage)\b/ },
];

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

  // 4c. Pure extracted SFC view models (monitorViewModel.ts, sidePanelResultModel.ts)
  // must remain strictly unidirectional and host-pure (no .vue/vue/side-effect imports or DOM/Chrome globals)
  for (const relModel of PURE_VIEW_MODEL_FILES) {
    const filePath = path.join(targetSrcRoot, relModel);
    if (!fs.existsSync(filePath)) continue;
    checked++;
    const rel = toPosixRel(targetFrontendRoot, filePath);
    const stripped = stripCommentsPreserveLines(fs.readFileSync(filePath, "utf8"));
    for (const { specifier, lineNo } of extractModuleSpecifiers(stripped)) {
      const target = normalizeResolvedModuleTarget(
        targetSrcRoot,
        filePath,
        specifier,
      );
      const isVueSfc = /\.vue$/i.test(specifier);
      const pkgRoot = !target.isRelative ? target.normalized.split("/")[0] : "";
      const isForbidden =
        isVueSfc ||
        (!target.isRelative && VIEW_MODEL_FORBIDDEN_PACKAGES.has(pkgRoot)) ||
        (target.isRelative &&
          (VIEW_MODEL_FORBIDDEN_TARGETS.has(target.normalized) ||
            target.normalized === "extension/bg" ||
            target.normalized.startsWith("extension/bg/")));
      if (isForbidden) {
        violations.push(
          `[view-model-import-direction] ${rel}:${lineNo}: pure view-model must not import "${specifier}" (${target.normalized})`,
        );
      }
    }
    const lines = stripped.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const rule of VIEW_MODEL_HOST_SIDE_EFFECT_PATTERNS) {
        if (rule.regex.test(lines[i])) {
          violations.push(
            `[view-model-host-side-effect] ${rel}:${i + 1} (${rule.name}): pure view-model must not access browser/DOM/Chrome side-effect globals`,
          );
        }
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

  const violations = [];
  let businessFilesChecked = 0;
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

  // 2. CSS solid-fallback + forced-colors gate across src/** and dist/assets/*.css
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
    `Architecture boundary check PASSED (business=${result.businessFilesChecked}, css=${result.cssFilesChecked}, distCss=${result.distCssFilesChecked}, importDir=${result.importDirectionFilesChecked})`,
  );
}
