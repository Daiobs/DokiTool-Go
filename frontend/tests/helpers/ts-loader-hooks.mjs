import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "esbuild";

const EXTENSIONS = [
  "",
  ".ts",
  ".js",
  ".mjs",
  ".json",
  "/index.ts",
  "/index.js",
  "/index.mjs",
];

const transformCache = new Map();

function isFileSync(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveFileCandidate(basePath) {
  for (const ext of EXTENSIONS) {
    const candidate = basePath + ext;
    if (isFileSync(candidate)) {
      return candidate;
    }
  }
  if (basePath.endsWith(".js")) {
    const tsCandidate = `${basePath.slice(0, -3)}.ts`;
    if (isFileSync(tsCandidate)) {
      return tsCandidate;
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const isFileUrl = specifier.startsWith("file://");

  if (isRelative || isFileUrl) {
    const [rawPathSpec, rawQuery] = specifier.split("?", 2);
    let basePath = null;
    let parentQuery = "";

    if (isFileUrl) {
      basePath = fileURLToPath(rawPathSpec);
    } else if (context.parentURL && context.parentURL.startsWith("file://")) {
      const parentUrl = new URL(context.parentURL);
      parentQuery = parentUrl.search;
      basePath = path.resolve(
        path.dirname(fileURLToPath(parentUrl)),
        rawPathSpec,
      );
    }

    if (basePath) {
      const resolvedPath = resolveFileCandidate(basePath);
      if (resolvedPath) {
        let targetUrl = pathToFileURL(resolvedPath).href;
        if (rawQuery !== undefined) {
          targetUrl += `?${rawQuery}`;
        } else if (
          isRelative &&
          parentQuery &&
          parentQuery.includes("isolate=")
        ) {
          targetUrl += parentQuery;
        }
        return { url: targetUrl, shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file://")) {
    const parsedUrl = new URL(url);
    const filePath = fileURLToPath(parsedUrl);

    if (filePath.endsWith(".ts") || filePath.endsWith(".mts")) {
      const source = fs.readFileSync(filePath, "utf8");
      const cached = transformCache.get(filePath);
      let code;
      if (cached && cached.source === source) {
        code = cached.code;
      } else {
        const result = transformSync(source, {
          loader: "ts",
          format: "esm",
          target: "esnext",
          sourcemap: "inline",
          sourcefile: filePath,
          define: {
            "import.meta.env": "{}",
            __VUE_OPTIONS_API__: "true",
            __VUE_PROD_DEVTOOLS__: "false",
          },
        });
        code = result.code;
        transformCache.set(filePath, { source, code });
      }
      return {
        format: "module",
        shortCircuit: true,
        source: code,
      };
    }

    if (
      filePath.endsWith(".json") &&
      context.importAttributes?.type !== "json"
    ) {
      const rawJson = fs.readFileSync(filePath, "utf8");
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${rawJson};\n`,
      };
    }
  }

  return nextLoad(url, context);
}
