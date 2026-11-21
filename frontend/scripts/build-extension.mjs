import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import * as esbuild from "esbuild";
import JSZip from "jszip";
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

const ZIP_LOCAL_FILE_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const ZIP_VERSION_MADE_BY_UNIX = (3 << 8) | 20;
const ZIP_VERSION_NEEDED = 20;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_DOS_TIME_FIXED = 0x0000; // 00:00:00
const ZIP_DOS_DATE_FIXED = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
const ZIP_POSIX_FILE_ATTR = (0o100644 << 16) >>> 0;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function computeCrc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function normalizeZipEntryPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new Error("ZIP entry path must be a non-empty string");
  }
  const posix = rawPath.replaceAll("\\", "/");
  if (
    posix.startsWith("/") ||
    posix.endsWith("/") ||
    posix.includes("\0") ||
    posix.includes("//")
  ) {
    throw new Error(`Invalid ZIP entry path: ${rawPath}`);
  }
  for (const segment of posix.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Unsafe ZIP entry path: ${rawPath}`);
    }
  }
  return posix;
}

export function createDeterministicZipBuffer(entries) {
  if (!entries || typeof entries[Symbol.iterator] !== "function") {
    throw new Error("createDeterministicZipBuffer requires an iterable of entries");
  }

  const normalized = [];
  for (const entry of entries) {
    const rawPath = entry?.path ?? entry?.name;
    const posixPath = normalizeZipEntryPath(rawPath);
    const rawData = entry?.data;
    let dataBuf;
    if (Buffer.isBuffer(rawData)) {
      dataBuf = rawData;
    } else if (typeof rawData === "string") {
      dataBuf = Buffer.from(rawData, "utf8");
    } else if (rawData instanceof Uint8Array) {
      dataBuf = Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength);
    } else {
      throw new Error(`Invalid ZIP entry data for ${posixPath}`);
    }
    normalized.push({
      posixPath,
      nameBuf: Buffer.from(posixPath, "utf8"),
      dataBuf,
    });
  }

  // Sort strictly by UTF-8 byte / Unicode code point order (locale-independent)
  normalized.sort((a, b) => Buffer.compare(a.nameBuf, b.nameBuf));

  if (normalized.length > 0xffff) {
    throw new Error(`ZIP entry count ${normalized.length} exceeds PKZIP 2.0 limit`);
  }

  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].posixPath === normalized[i - 1].posixPath) {
      throw new Error(`Duplicate ZIP entry path: ${normalized[i].posixPath}`);
    }
  }

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const { posixPath, nameBuf, dataBuf } of normalized) {
    if (nameBuf.length > 0xffff) {
      throw new Error(`ZIP entry filename too long: ${posixPath}`);
    }
    if (dataBuf.length > 0xffffffff) {
      throw new Error(`ZIP entry exceeds 4 GiB PKZIP 2.0 limit: ${posixPath}`);
    }

    const crc = computeCrc32(dataBuf);
    const deflated = zlib.deflateRawSync(dataBuf, { level: 9 });
    const useDeflate = deflated.length < dataBuf.length;
    const method = useDeflate ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORE;
    const payload = useDeflate ? deflated : dataBuf;

    if (localOffset > 0xffffffff) {
      throw new Error("ZIP archive offset exceeds 4 GiB PKZIP 2.0 limit");
    }

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER_SIG, 0);
    localHeader.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
    localHeader.writeUInt16LE(ZIP_FLAG_UTF8, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(ZIP_DOS_TIME_FIXED, 10);
    localHeader.writeUInt16LE(ZIP_DOS_DATE_FIXED, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuf, payload);

    // Central Directory File Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_DIR_HEADER_SIG, 0);
    centralHeader.writeUInt16LE(ZIP_VERSION_MADE_BY_UNIX, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION_NEEDED, 6);
    centralHeader.writeUInt16LE(ZIP_FLAG_UTF8, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(ZIP_DOS_TIME_FIXED, 12);
    centralHeader.writeUInt16LE(ZIP_DOS_DATE_FIXED, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(ZIP_POSIX_FILE_ATTR, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralParts.push(centralHeader, nameBuf);
    localOffset += localHeader.length + nameBuf.length + payload.length;
  }

  let centralSize = 0;
  for (const part of centralParts) {
    centralSize += part.length;
  }
  if (localOffset > 0xffffffff || centralSize > 0xffffffff) {
    throw new Error("ZIP central directory exceeds 4 GiB PKZIP 2.0 limit");
  }

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_END_OF_CENTRAL_DIR_SIG, 0);
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(normalized.length, 8);
  eocd.writeUInt16LE(normalized.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function validateExtensionManifest(manifest, { devLoopback = false } = {}) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest.json must be a JSON object");
  }

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
  validateExtensionManifest(manifest, { devLoopback });

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

export async function packageExtensionZip(outDir = defaultOutDir, zipPath) {
  if (typeof zipPath !== "string" || zipPath.trim() === "") {
    throw new Error("packageExtensionZip requires a non-empty zipPath");
  }

  const resolvedOutDir = path.resolve(outDir);
  const resolvedZipPath = path.resolve(zipPath);
  const allFiles = await collectFilesRecursive(resolvedOutDir);
  if (allFiles.length === 0) {
    throw new Error(`Cannot package empty directory: ${resolvedOutDir}`);
  }

  const entries = [];
  for (const absFile of allFiles) {
    const relPosix = path
      .relative(resolvedOutDir, absFile)
      .split(path.sep)
      .join("/");
    const data = await fsp.readFile(absFile);
    entries.push({ path: relPosix, data });
  }

  const zipBuffer = createDeterministicZipBuffer(entries);
  await fsp.mkdir(path.dirname(resolvedZipPath), { recursive: true });

  const tmpPath = `${resolvedZipPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(tmpPath, zipBuffer);
    await fsp.rename(tmpPath, resolvedZipPath);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  const sha256 = crypto.createHash("sha256").update(zipBuffer).digest("hex");
  return {
    zipPath: resolvedZipPath,
    sizeBytes: zipBuffer.length,
    sha256,
    entryCount: entries.length,
  };
}

export async function verifyExtensionZip(zipPath, expectedOutDir) {
  if (typeof zipPath !== "string" || zipPath.trim() === "") {
    throw new Error("verifyExtensionZip requires a non-empty zipPath");
  }

  const resolvedZipPath = path.resolve(zipPath);
  const zipBuffer = await fsp.readFile(resolvedZipPath);
  if (
    zipBuffer.length < 22 ||
    zipBuffer[0] !== 0x50 ||
    zipBuffer[1] !== 0x4b ||
    zipBuffer[2] !== 0x03 ||
    zipBuffer[3] !== 0x04
  ) {
    throw new Error(`Invalid PKZIP magic header in ${resolvedZipPath}`);
  }

  const archive = await JSZip.loadAsync(zipBuffer);
  const zipFiles = new Map();
  for (const [entryName, zipEntry] of Object.entries(archive.files)) {
    if (zipEntry.dir) {
      throw new Error(`Unexpected directory entry in extension ZIP: ${entryName}`);
    }
    const normalized = normalizeZipEntryPath(entryName);
    if (normalized !== entryName) {
      throw new Error(`Non-POSIX entry path in extension ZIP: ${entryName}`);
    }
    zipFiles.set(entryName, zipEntry);
  }

  const manifestEntry = zipFiles.get("manifest.json");
  if (!manifestEntry) {
    throw new Error(
      "Extension ZIP must contain manifest.json directly at archive root (no wrapping top-level folder)",
    );
  }

  const manifestText = await manifestEntry.async("string");
  const manifest = JSON.parse(manifestText);
  validateExtensionManifest(manifest, { devLoopback: false });

  const requiredFiles = [
    "manifest.json",
    "background.js",
    "sidepanel.html",
    "offscreen.html",
    ...ICON_SIZES.map((s) => `icons/icon-${s}.png`),
  ];
  for (const rel of requiredFiles) {
    const entry = zipFiles.get(rel);
    if (!entry) {
      throw new Error(`Missing required root artifact in extension ZIP: ${rel}`);
    }
    const bytes = await entry.async("nodebuffer");
    if (bytes.length === 0) {
      throw new Error(`Empty required artifact in extension ZIP: ${rel}`);
    }
  }

  if (expectedOutDir) {
    const resolvedExpectedDir = path.resolve(expectedOutDir);
    const expectedFiles = await collectFilesRecursive(resolvedExpectedDir);
    const expectedMap = new Map();
    for (const absFile of expectedFiles) {
      const relPosix = path
        .relative(resolvedExpectedDir, absFile)
        .split(path.sep)
        .join("/");
      expectedMap.set(relPosix, absFile);
    }

    const missing = [...expectedMap.keys()].filter((rel) => !zipFiles.has(rel));
    const extra = [...zipFiles.keys()].filter((rel) => !expectedMap.has(rel));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `Extension ZIP entry set mismatch (missing=${missing.join(",")}; extra=${extra.join(",")})`,
      );
    }

    for (const [rel, absFile] of expectedMap.entries()) {
      const [actualBytes, expectedBytes] = await Promise.all([
        zipFiles.get(rel).async("nodebuffer"),
        fsp.readFile(absFile),
      ]);
      if (Buffer.compare(actualBytes, expectedBytes) !== 0) {
        throw new Error(`Extension ZIP byte content mismatch for ${rel}`);
      }
    }
  }

  const sha256 = crypto.createHash("sha256").update(zipBuffer).digest("hex");
  return {
    zipPath: resolvedZipPath,
    sizeBytes: zipBuffer.length,
    sha256,
    entryCount: zipFiles.size,
    manifest,
  };
}

export async function buildExtension({
  devLoopback = false,
  outDir = defaultOutDir,
  zipOut = null,
  quiet = false,
} = {}) {
  const resolvedZipOut =
    typeof zipOut === "string" && zipOut.trim() !== ""
      ? path.resolve(zipOut)
      : null;

  if (devLoopback && resolvedZipOut) {
    throw new Error(
      "Refusing to package a --dev-loopback test build into a distributable ZIP archive",
    );
  }

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

  let zip = null;
  if (resolvedZipOut) {
    const packaged = await packageExtensionZip(resolvedOutDir, resolvedZipOut);
    await verifyExtensionZip(resolvedZipOut, resolvedOutDir);
    zip = packaged;
    if (!quiet) {
      console.log(
        `[build:extension] Packaged deterministic ZIP -> ${packaged.zipPath} (${packaged.sizeBytes} bytes, sha256=${packaged.sha256})`,
      );
    }
  }

  return {
    outDir: resolvedOutDir,
    manifest: verification.manifest,
    checkedFiles: verification.checkedFiles,
    zip,
  };
}

function parseCliArgs(argv) {
  let devLoopback = false;
  let outDir = defaultOutDir;
  let zipOut = null;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dev-loopback") {
      devLoopback = true;
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "--out-dir") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
        throw new Error("Missing value for --out-dir");
      }
      outDir = path.resolve(argv[++i]);
    } else if (arg.startsWith("--out-dir=")) {
      const value = arg.slice("--out-dir=".length).trim();
      if (!value) {
        throw new Error("Missing value for --out-dir");
      }
      outDir = path.resolve(value);
    } else if (arg === "--zip-out") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
        throw new Error("Missing value for --zip-out");
      }
      zipOut = path.resolve(argv[++i]);
    } else if (arg.startsWith("--zip-out=")) {
      const value = arg.slice("--zip-out=".length).trim();
      if (!value) {
        throw new Error("Missing value for --zip-out");
      }
      zipOut = path.resolve(value);
    } else {
      throw new Error(`Unknown CLI flag: ${arg}`);
    }
  }
  return { devLoopback, outDir, zipOut, quiet };
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
