import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import sharp from "sharp";
import { build as viteBuild } from "vite";
import vue from "@vitejs/plugin-vue";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDir, "..");
const extensionSrcDir = path.join(frontendRoot, "src", "extension");
const defaultOutDir = path.join(frontendRoot, "dist-extension");
const faviconSourcePath = path.join(
  frontendRoot,
  "brand-originals",
  "dokitool-favicon.png",
);
const mediabunnyLicensePath = path.join(
  frontendRoot,
  "public",
  "licenses",
  "mediabunny-MPL-2.0.txt",
);

export const ICON_SIZES = Object.freeze([16, 32, 48, 128]);

export const EXPECTED_PERMISSIONS = Object.freeze([
  "sidePanel",
  "offscreen",
  "downloads",
  "storage",
  "contextMenus",
  "tabs",
  "declarativeNetRequestWithHostAccess",
]);

export const FORBIDDEN_PERMISSIONS = Object.freeze([
  "cookies",
  "webRequest",
  "webRequestBlocking",
  "scripting",
  "debugger",
  "declarativeNetRequest",
  "browsingData",
  "history",
  "webNavigation",
]);

export const FORBIDDEN_HOST_WILDCARDS = Object.freeze([
  "<all_urls>",
  "*://*/*",
  "http://*/*",
  "https://*/*",
]);

async function loadHostWhitelistModule() {
  const hostWhitelistEntry = path.join(extensionSrcDir, "hostWhitelist.ts");
  const bundled = await esbuild.build({
    entryPoints: [hostWhitelistEntry],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "es2022",
  });
  const code = bundled.outputFiles?.[0]?.text;
  if (!code) {
    throw new Error("Failed to bundle hostWhitelist.ts for manifest generation");
  }
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

export async function createExtensionManifest({ devLoopback = false } = {}) {
  const pkgRaw = await fsp.readFile(
    path.join(frontendRoot, "package.json"),
    "utf8",
  );
  const pkg = JSON.parse(pkgRaw);
  const hostWhitelist = await loadHostWhitelistModule();
  const { host_permissions, optional_host_permissions } =
    hostWhitelist.buildManifestHostPermissions({ devLoopback });

  const iconMap = {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  };

  return {
    manifest_version: 3,
    name: "DokiTool 素材下载助手",
    version: String(pkg.version || "1.0.0"),
    description:
      "DokiTool 多平台无水印短视频、图集、实况照片与 YouTube 4K60 无损合流侧边栏下载扩展（零 Cookie、显式白名单、后台保活落盘）",
    permissions: [...EXPECTED_PERMISSIONS],
    icons: iconMap,
    action: {
      default_title: "打开 DokiTool 侧边栏",
      default_icon: iconMap,
    },
    side_panel: {
      default_path: "sidepanel.html",
    },
    background: {
      service_worker: "background.js",
      type: "module",
    },
    commands: {
      "open-dokitool-sidepanel": {
        suggested_key: {
          default: "Alt+Shift+D",
          mac: "Alt+Shift+D",
        },
        description: "打开 DokiTool 侧边栏并解析当前标签页",
      },
    },
    host_permissions,
    optional_host_permissions,
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
  };
}

async function generateExtensionIcons(outDir) {
  const iconsDir = path.join(outDir, "icons");
  await fsp.mkdir(iconsDir, { recursive: true });
  for (const size of ICON_SIZES) {
    const outFile = path.join(iconsDir, `icon-${size}.png`);
    await sharp(faviconSourcePath)
      .resize(size, size, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(outFile);
  }
}

async function collectFilesRecursive(dir) {
  const results = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFilesRecursive(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function verifyExtensionDist(
  outDir = defaultOutDir,
  { devLoopback = false } = {},
) {
  const manifestPath = path.join(outDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing manifest.json at ${manifestPath}`);
  }

  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));

  if (manifest.manifest_version !== 3) {
    throw new Error(
      `Expected manifest_version === 3, got ${manifest.manifest_version}`,
    );
  }

  if (!manifest.name || typeof manifest.name !== "string") {
    throw new Error("manifest.name must be a non-empty string");
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ""))) {
    throw new Error(`Invalid MV3 manifest.version: ${manifest.version}`);
  }

  if (manifest.content_scripts !== undefined) {
    throw new Error("manifest.content_scripts must be undefined (zero content script injection)");
  }

  if (!Array.isArray(manifest.permissions)) {
    throw new Error("manifest.permissions must be an array");
  }
  for (const forbiddenPerm of FORBIDDEN_PERMISSIONS) {
    if (manifest.permissions.includes(forbiddenPerm)) {
      throw new Error(
        `Forbidden permission present in manifest.permissions: ${forbiddenPerm}`,
      );
    }
  }
  const missingPerms = EXPECTED_PERMISSIONS.filter(
    (p) => !manifest.permissions.includes(p),
  );
  const unexpectedPerms = manifest.permissions.filter(
    (p) => !EXPECTED_PERMISSIONS.includes(p),
  );
  if (missingPerms.length > 0 || unexpectedPerms.length > 0) {
    throw new Error(
      `manifest.permissions mismatch (missing=${missingPerms.join(",")}; unexpected=${unexpectedPerms.join(",")})`,
    );
  }

  if (!Array.isArray(manifest.host_permissions) || manifest.host_permissions.length === 0) {
    throw new Error("manifest.host_permissions must be a non-empty array");
  }
  if (!Array.isArray(manifest.optional_host_permissions)) {
    throw new Error("manifest.optional_host_permissions must be an array");
  }

  const validHostPattern = /^https?:\/\/(?:\*\.)?[a-z0-9.-]+\/\*$/;
  for (const list of [manifest.host_permissions, manifest.optional_host_permissions]) {
    for (const pattern of list) {
      if (FORBIDDEN_HOST_WILDCARDS.includes(pattern)) {
        throw new Error(`Forbidden wildcard host permission: ${pattern}`);
      }
      if (!validHostPattern.test(pattern)) {
        throw new Error(`Malformed host permission pattern: ${pattern}`);
      }
    }
  }

  const hasLoopbackInHostPerms = manifest.host_permissions.some(
    (p) => p.includes("127.0.0.1") || p.includes("localhost"),
  );
  if (!devLoopback && hasLoopbackInHostPerms) {
    throw new Error(
      "Production manifest.host_permissions must NOT include 127.0.0.1 or localhost",
    );
  }
  if (!devLoopback) {
    const opt = manifest.optional_host_permissions;
    if (
      opt.length !== 2 ||
      !opt.includes("http://127.0.0.1/*") ||
      !opt.includes("http://localhost/*")
    ) {
      throw new Error(
        "Production manifest.optional_host_permissions must contain exact loopback entries",
      );
    }
  }

  const csp = manifest.content_security_policy?.extension_pages;
  if (csp !== "script-src 'self'; object-src 'self';") {
    throw new Error(
      `Invalid content_security_policy.extension_pages: ${String(csp)}`,
    );
  }

  if (
    manifest.background?.service_worker !== "background.js" ||
    manifest.background?.type !== "module"
  ) {
    throw new Error("manifest.background must declare module service_worker background.js");
  }
  if (manifest.side_panel?.default_path !== "sidepanel.html") {
    throw new Error("manifest.side_panel.default_path must equal sidepanel.html");
  }

  const requiredFiles = [
    "manifest.json",
    "background.js",
    "sidepanel.html",
    "offscreen.html",
    ...ICON_SIZES.map((s) => `icons/icon-${s}.png`),
  ];
  for (const rel of requiredFiles) {
    const abs = path.join(outDir, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).size === 0) {
      throw new Error(`Missing or empty required extension build artifact: ${rel}`);
    }
  }

  const allFiles = await collectFilesRecursive(outDir);
  const externalScriptTagRe =
    /<script\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i;
  const inlineScriptTagRe = /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i;
  const externalStylesheetTagRe =
    /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i;
  const externalCssImportRe =
    /@import\s+(?:url\(\s*)?["']?\s*(?:https?:)?\/\//i;
  const externalCssUrlRe = /url\(\s*["']?\s*(?:https?:)?\/\//i;
  const unsafeEvalRe = /unsafe-eval/i;

  for (const filePath of allFiles) {
    const ext = path.extname(filePath).toLowerCase();
    if (![".html", ".js", ".mjs", ".css"].includes(ext)) continue;

    const relPath = path.relative(outDir, filePath);
    const content = await fsp.readFile(filePath, "utf8");

    if (unsafeEvalRe.test(content)) {
      throw new Error(`Forbidden unsafe-eval detected in ${relPath}`);
    }
    if (ext === ".html") {
      if (externalScriptTagRe.test(content)) {
        throw new Error(`External script URL detected in ${relPath}`);
      }
      if (inlineScriptTagRe.test(content)) {
        throw new Error(
          `Inline <script> tag violating MV3 CSP detected in ${relPath}`,
        );
      }
      if (externalStylesheetTagRe.test(content)) {
        throw new Error(`External <link> URL detected in ${relPath}`);
      }
    }
    if (ext === ".css") {
      if (externalCssImportRe.test(content) || externalCssUrlRe.test(content)) {
        throw new Error(`External CSS asset URL detected in ${relPath}`);
      }
    }
    if (ext === ".js" || ext === ".mjs") {
      if (externalScriptTagRe.test(content) || externalStylesheetTagRe.test(content)) {
        throw new Error(`External script/stylesheet tag loader detected in ${relPath}`);
      }
    }
  }

  return {
    manifest,
    checkedFiles: allFiles.length,
  };
}

export async function buildExtension({
  devLoopback = false,
  outDir = defaultOutDir,
  quiet = false,
} = {}) {
  const resolvedOutDir = path.resolve(outDir);
  await fsp.rm(resolvedOutDir, { recursive: true, force: true });
  await fsp.mkdir(resolvedOutDir, { recursive: true });

  // 1. Build SidePanel + Offscreen HTML & local assets via Vite
  await viteBuild({
    configFile: false,
    root: extensionSrcDir,
    base: "./",
    publicDir: false,
    logLevel: quiet ? "silent" : "warn",
    plugins: [vue()],
    resolve: {
      alias: {
        "@": path.join(frontendRoot, "src"),
      },
    },
    css: {
      postcss: {
        plugins: [],
      },
    },
    build: {
      outDir: resolvedOutDir,
      emptyOutDir: false,
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 1200,
      target: "es2022",
      modulePreload: {
        polyfill: false,
      },
      rollupOptions: {
        input: {
          sidepanel: path.join(extensionSrcDir, "sidepanel.html"),
          offscreen: path.join(extensionSrcDir, "offscreen.html"),
        },
      },
    },
  });

  // 2. Bundle MV3 Service Worker (`background.ts` -> `background.js`, ESM ES2022)
  await esbuild.build({
    entryPoints: [path.join(extensionSrcDir, "background.ts")],
    outfile: path.join(resolvedOutDir, "background.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    charset: "utf8",
    legalComments: "inline",
  });

  // 3. Generate MV3 extension PNG icons (16/32/48/128) from brand original
  await generateExtensionIcons(resolvedOutDir);

  // 4. Copy Mediabunny MPL-2.0 license notice into extension bundle
  if (fs.existsSync(mediabunnyLicensePath)) {
    const destLicenseDir = path.join(resolvedOutDir, "licenses");
    await fsp.mkdir(destLicenseDir, { recursive: true });
    await fsp.copyFile(
      mediabunnyLicensePath,
      path.join(destLicenseDir, "mediabunny-MPL-2.0.txt"),
    );
  }

  // 5. Emit manifest.json
  const manifest = await createExtensionManifest({ devLoopback });
  await fsp.writeFile(
    path.join(resolvedOutDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  // 6. Run post-build static security gates
  const verification = await verifyExtensionDist(resolvedOutDir, {
    devLoopback,
  });

  if (!quiet) {
    const modeLabel = devLoopback ? "dev-loopback (TEST ONLY)" : "production";
    console.log(
      `[build:extension] Built MV3 extension (${modeLabel}) -> ${resolvedOutDir} (${verification.checkedFiles} files verified)`,
    );
  }

  return {
    outDir: resolvedOutDir,
    manifest: verification.manifest,
    checkedFiles: verification.checkedFiles,
  };
}

function parseCliArgs(argv) {
  let devLoopback = false;
  let outDir = defaultOutDir;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dev-loopback") {
      devLoopback = true;
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "--out-dir" && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    } else if (arg.startsWith("--out-dir=")) {
      outDir = path.resolve(arg.slice("--out-dir=".length));
    } else {
      throw new Error(`Unknown CLI flag: ${arg}`);
    }
  }
  return { devLoopback, outDir, quiet };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const cliOpts = parseCliArgs(process.argv.slice(2));
    await buildExtension(cliOpts);
  } catch (err) {
    console.error(
      `[build:extension] FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
