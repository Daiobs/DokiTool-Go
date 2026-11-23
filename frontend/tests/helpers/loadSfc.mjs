import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parse, compileScript } from "@vue/compiler-sfc";
import { transformWithEsbuild } from "vite";

const EXTENSIONS = [
  "",
  ".ts",
  ".js",
  ".mjs",
  ".vue",
  ".json",
  "/index.ts",
  "/index.js",
  "/index.mjs",
];

const REQUIRE_SPECIFIER_RE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
const compiledCache = new Map();
let scopeCounter = 0;

function toFilePath(input) {
  if (input instanceof URL) return fileURLToPath(input);
  if (typeof input === "string" && input.startsWith("file://")) {
    return fileURLToPath(new URL(input));
  }
  return path.resolve(String(input));
}

async function fileExists(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function resolveLocalFile(specifier, importerFile) {
  const base = path.resolve(path.dirname(importerFile), specifier);
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function compileFileToCjs(filePath) {
  const source = await readFile(filePath, "utf8");
  const cached = compiledCache.get(filePath);
  if (cached && cached.source === source) {
    return cached;
  }

  let code;
  if (filePath.endsWith(".json")) {
    code = `module.exports = ${source};`;
  } else if (filePath.endsWith(".vue")) {
    const { descriptor } = parse(source, { filename: filePath });
    const isTs =
      descriptor.scriptSetup?.lang === "ts" ||
      descriptor.script?.lang === "ts";
    const script = compileScript(descriptor, {
      id: `sfc-${++scopeCounter}`,
      inlineTemplate: true,
      templateOptions: {
        compilerOptions: { hoistStatic: false },
      },
    });
    const out = await transformWithEsbuild(
      script.content,
      `${filePath}.${isTs ? "ts" : "js"}`,
      {
        loader: isTs ? "ts" : "js",
        format: "cjs",
        supported: { "dynamic-import": false },
      },
    );
    code = out.code;
  } else {
    const isTs = filePath.endsWith(".ts");
    const out = await transformWithEsbuild(source, filePath, {
      loader: isTs ? "ts" : "js",
      format: "cjs",
      supported: { "dynamic-import": false },
    });
    code = out.code;
  }

  const specifiers = new Set();
  for (const match of code.matchAll(REQUIRE_SPECIFIER_RE)) {
    specifiers.add(match[1]);
  }
  const record = { source, code, specifiers: [...specifiers] };
  compiledCache.set(filePath, record);
  return record;
}

function normalizeInjectedModule(mod) {
  if (
    mod &&
    (typeof mod === "object" || typeof mod === "function") &&
    !("__esModule" in mod) &&
    "default" in mod
  ) {
    return { __esModule: true, ...mod };
  }
  return mod;
}

/**
 * Compile and evaluate a Vue SFC (and all transitive local `.vue` / `.ts` / `.js`
 * subcomponents & helpers) as real modules in Node tests without empty stubs.
 */
export async function loadSfcModule(entryUrlOrPath, options = {}) {
  const entryFile = toFilePath(entryUrlOrPath);
  const rawModules = options.modules || {};
  const customResolve = options.resolve;

  const resolvedOverrideByPath = new Map();
  for (const [spec, value] of Object.entries(rawModules)) {
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const target = await resolveLocalFile(spec, entryFile);
      if (target) {
        resolvedOverrideByPath.set(target, normalizeInjectedModule(value));
      }
    }
  }

  const compiledGraph = new Map();
  const resolvedEdges = new Map();

  async function visit(filePath) {
    if (compiledGraph.has(filePath)) return;
    const record = await compileFileToCjs(filePath);
    compiledGraph.set(filePath, record);
    const edges = new Map();
    resolvedEdges.set(filePath, edges);

    for (const spec of record.specifiers) {
      if (customResolve) {
        const hooked = customResolve(spec, filePath);
        if (hooked !== undefined) continue;
      }
      if (Object.hasOwn(rawModules, spec) && filePath === entryFile) {
        continue;
      }
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const childPath = await resolveLocalFile(spec, filePath);
        if (childPath) {
          edges.set(spec, childPath);
          if (!resolvedOverrideByPath.has(childPath)) {
            await visit(childPath);
          }
        }
      }
    }
  }

  await visit(entryFile);

  const evaluated = new Map();
  function evaluateFile(filePath) {
    if (evaluated.has(filePath)) {
      return evaluated.get(filePath).exports;
    }
    const record = compiledGraph.get(filePath);
    if (!record) {
      throw new Error(`Missing compiled module for ${filePath}`);
    }
    const mod = { exports: {} };
    evaluated.set(filePath, mod);
    const localRequire = createRequire(filePath);
    const edges = resolvedEdges.get(filePath) || new Map();

    const runtimeRequire = (spec) => {
      if (customResolve) {
        const hooked = customResolve(spec, filePath);
        if (hooked !== undefined) return normalizeInjectedModule(hooked);
      }
      if (filePath === entryFile && Object.hasOwn(rawModules, spec)) {
        return normalizeInjectedModule(rawModules[spec]);
      }
      const targetPath = edges.get(spec);
      if (targetPath) {
        if (resolvedOverrideByPath.has(targetPath)) {
          return resolvedOverrideByPath.get(targetPath);
        }
        return evaluateFile(targetPath);
      }
      if (Object.hasOwn(rawModules, spec)) {
        return normalizeInjectedModule(rawModules[spec]);
      }
      return localRequire(spec);
    };

    new Function("require", "module", "exports", record.code)(
      runtimeRequire,
      mod,
      mod.exports,
    );
    return mod.exports;
  }

  return evaluateFile(entryFile);
}

export async function loadSfc(entryUrlOrPath, options = {}) {
  const exportsObj = await loadSfcModule(entryUrlOrPath, options);
  return exportsObj.default ?? exportsObj;
}
