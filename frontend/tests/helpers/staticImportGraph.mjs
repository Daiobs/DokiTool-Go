import fs from "node:fs";
import path from "node:path";

const RESOLVE_EXTS = [
  "",
  ".ts",
  ".js",
  ".mjs",
  ".json",
  ".vue",
  "/index.ts",
  "/index.js",
  "/index.mjs",
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, prefix) => prefix);
}

/**
 * Extracts runtime (non-`import type` / non-`export type`) ESM specifiers,
 * matching what a bundler retains in its runtime module graph.
 */
function extractRuntimeModuleSpecifiers(strippedSource) {
  const specifiers = [];
  const staticRe =
    /\b(?:import|export)\s+(?!type\b)([^;'"`]*?)\bfrom\s*["']([^"'\n]+)["']/g;
  const sideEffectRe = /(?:^|[;\n])\s*import\s*["']([^"'\n]+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

  let match;
  while ((match = staticRe.exec(strippedSource)) !== null) {
    const clause = match[1].trim();
    // Skip named-only clauses where every binding is `type Foo`
    const braceMatch = clause.match(/^\{([\s\S]*)\}$/);
    if (braceMatch) {
      const items = braceMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length > 0 && items.every((item) => /^type\s+/.test(item))) {
        continue;
      }
    }
    specifiers.push(match[2]);
  }
  while ((match = sideEffectRe.exec(strippedSource)) !== null) {
    specifiers.push(match[1]);
  }
  while ((match = dynamicRe.exec(strippedSource)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveLocal(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const ext of RESOLVE_EXTS) {
    const candidate = base + ext;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Recursively collect all transitive runtime local file paths and bare package
 * specifiers imported from `entryAbsPath` without invoking `esbuild.build()`.
 */
export function collectTransitiveImportGraph(entryAbsPath) {
  const visited = new Set();
  const barePackages = new Set();

  function walk(absPath) {
    const normalized = path.resolve(absPath);
    if (visited.has(normalized)) return;
    visited.add(normalized);
    if (!/\.(?:ts|mts|js|mjs)$/i.test(normalized)) return;

    const stripped = stripComments(fs.readFileSync(normalized, "utf8"));
    for (const specifier of extractRuntimeModuleSpecifiers(stripped)) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const resolved = resolveLocal(normalized, specifier);
        if (resolved) {
          walk(resolved);
        }
      } else {
        barePackages.add(specifier);
      }
    }
  }

  walk(entryAbsPath);
  return [
    ...[...visited].map((p) => p.split(path.sep).join("/")),
    ...barePackages,
  ];
}
