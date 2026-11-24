#!/usr/bin/env node
/**
 * Offline unit & loopback mock headless Chrome tests for scripts/prod-smoke/stage2_browser.mjs.
 *
 * Zero external network requests and zero third-party dependencies.
 * - Pure unit tests always execute (suitable for CI `repo-contracts` via DOKITOOL_STAGE2_SKIP_BROWSER=1).
 * - Loopback mock headless Chrome E2E tests execute whenever Chrome is available
 *   (and are enforced via DOKITOOL_STAGE2_REQUIRE_BROWSER=1 in CI `frontend-and-browser`).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import {
  DOKITOOL_EXTENSION_ID,
  EXPECTED_BRIDGE_CAPABILITIES,
  MANDATORY_HEADLESS_FLAGS,
  RedactionViolationError,
  Stage2Error,
  assertPathNotGitTracked,
  discoverChromeBinary,
  parseCliArgs,
  parseZipBuffer,
  renderJsonReport,
  renderMarkdownReport,
  resolveProxyConfig,
  runStage2,
  sanitizeHostname,
  sanitizeText,
  scanSensitiveOutput,
  syncExtensionAtomic,
  validateBaseUrl,
  validateExtensionArchive,
  validateProxyUrl,
  verifyRedactedOutput,
} from "./stage2_browser.mjs";

const TEST_MANIFEST_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1H7x6y1gizzFTJNvaVoImjO/bVzcAK2Yf2yVsV/8Cci1ODkiJbJkEm0B5BdLh8TCfvaIh2KvO170x8/xCkI1vGQwVqYTRfFUffTXAfPRPt0ih4IPmkfR4Onof0b1avZ8zD76WxRb0fv094afOItMzygdpHeCL50v1gCvIazVo6b+B5ZgX+WTtp2u/ULNvjiE9Cz0cPUepsgoNov0kRG3sK2e58YO0pRBxrd4dwZFxTNzWekYEmmxMDeZGqUaSRClSXeQVw+lSM3NsvXzxK2tlPbbt0DH2MXiR0SQcmvbvP40H0AamKLWYcJTEYCsMbVBRWuXMagJr9/kEtXA6sNYrQIDAQAB";

const MINI_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082",
  "hex",
);

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");

function buildTestZip(entries, { useDeflate = true } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data, methodOverride, crcOverride } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    const crc = crcOverride !== undefined ? crcOverride >>> 0 : zlib.crc32(dataBuf) >>> 0;
    const method = methodOverride !== undefined ? methodOverride : useDeflate ? 8 : 0;
    const payload = method === 8 ? zlib.deflateRawSync(dataBuf) : dataBuf;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function buildValidExtensionManifest(overrides = {}) {
  return {
    manifest_version: 3,
    key: TEST_MANIFEST_PUBLIC_KEY,
    name: "DokiTool Test Extension",
    version: "4.2.0",
    permissions: [
      "sidePanel",
      "offscreen",
      "downloads",
      "storage",
      "contextMenus",
      "tabs",
      "declarativeNetRequestWithHostAccess",
    ],
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
    side_panel: { default_path: "sidepanel.html" },
    background: { service_worker: "background.js", type: "module" },
    host_permissions: ["https://snap.dokitool.com/*"],
    optional_host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    externally_connectable: {
      matches: ["https://snap.dokitool.com/*"],
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
    ...overrides,
  };
}

function buildValidExtensionZip(manifestOverrides = {}, extraEntries = []) {
  const manifest = buildValidExtensionManifest(manifestOverrides);
  const backgroundJs = `
chrome.runtime.onMessageExternal.addListener((req, _sender, sendResponse) => {
  if (req && req.type === "WEB_EXT_PING") {
    const m = chrome.runtime.getManifest();
    sendResponse({
      ok: true,
      data: {
        version: m.version,
        extensionId: chrome.runtime.id,
        capabilities: ${JSON.stringify([...EXPECTED_BRIDGE_CAPABILITIES])},
      },
    });
    return true;
  }
  sendResponse({ ok: false, error: "unsupported" });
  return true;
});
`;
  const entries = [
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "background.js", data: backgroundJs },
    { name: "sidepanel.html", data: "<!doctype html><title>Sidepanel</title>" },
    { name: "offscreen.html", data: "<!doctype html><title>Offscreen</title>" },
    { name: "icons/icon-16.png", data: MINI_PNG },
    { name: "icons/icon-32.png", data: MINI_PNG },
    { name: "icons/icon-48.png", data: MINI_PNG },
    { name: "icons/icon-128.png", data: MINI_PNG },
    ...extraEntries,
  ];
  return buildTestZip(entries);
}

// ============================================================================
// 1. Pure Offline Unit Tests
// ============================================================================

describe("CLI parsing and URL/proxy security boundaries", () => {
  test("parses valid defaults and rejects unsafe flag combinations", () => {
    const def = parseCliArgs([]);
    assert.equal(def.baseUrl, "https://snap.dokitool.com");
    assert.equal(def.profile, "lite");
    assert.equal(def.skipHttpChecks, false);
    assert.equal(def.withMuxSave, false);
    assert.equal(def.format, "both");

    const full = parseCliArgs([
      "--profile=full",
      "--with-mux-save",
      "--skip-http-checks",
      "--timeout",
      "45",
      "--expected-ext-files=13",
      "--format=md",
    ]);
    assert.equal(full.profile, "full");
    assert.equal(full.withMuxSave, true);
    assert.equal(full.skipHttpChecks, true);
    assert.equal(full.timeoutSeconds, 45);
    assert.equal(full.expectedExtFiles, 13);
    assert.equal(full.format, "md");

    assert.throws(() => parseCliArgs(["--profile", "turbo"]), Stage2Error);
    assert.throws(() => parseCliArgs(["--with-mux-save"]), /requires --profile full/);
    assert.throws(() => parseCliArgs(["--unknown-flag"]), Stage2Error);
    assert.throws(() => parseCliArgs(["--timeout", "0"]), Stage2Error);
    assert.throws(() => parseCliArgs(["--expected-ext-files", "0"]), Stage2Error);
    assert.throws(() => parseCliArgs(["--base-url"]), Stage2Error);
    assert.throws(() => parseCliArgs(["--format", "xml"]), Stage2Error);
  });

  test("validateBaseUrl accepts safe origins and rejects credentials, paths, or remote HTTP", () => {
    const prod = validateBaseUrl("https://snap.dokitool.com/");
    assert.equal(prod.origin, "https://snap.dokitool.com");
    assert.equal(prod.isLoopback, false);
    assert.equal(prod.targetHost, "snap.dokitool.com");

    const localIp = validateBaseUrl("http://127.0.0.1:8080");
    assert.equal(localIp.isLoopback, true);
    assert.equal(localIp.targetHost, "<ip-redacted>");

    const localName = validateBaseUrl("http://localhost:3000");
    assert.equal(localName.isLoopback, true);
    assert.equal(localName.targetHost, "localhost");

    for (const bad of [
      "http://snap.dokitool.com",
      "https://user:pass@snap.dokitool.com",
      "https://user@snap.dokitool.com",
      "https://@snap.dokitool.com",
      "https://snap.dokitool.com/monitor",
      "https://snap.dokitool.com/?debug=1",
      "https://snap.dokitool.com/#hash",
      "ftp://snap.dokitool.com",
      "not-a-url",
    ]) {
      assert.throws(() => validateBaseUrl(bad), Stage2Error, `must reject ${bad}`);
    }
  });

  test("proxy validation rejects credentials and honors loopback & NO_PROXY bypass", () => {
    for (const bad of [
      "http://alice:secret@127.0.0.1:8080",
      "http://alice@proxy.internal:3128",
      "http://@proxy.internal:3128",
      "socks5://127.0.0.1:1080",
      "http://proxy.internal:8080/path",
    ]) {
      assert.throws(() => validateProxyUrl(bad), Stage2Error, `must reject ${bad}`);
    }

    const remoteTarget = validateBaseUrl("https://snap.dokitool.com");
    const loopTarget = validateBaseUrl("http://127.0.0.1:9999");

    // Credentials in --proxy are rejected even when targeting loopback.
    assert.throws(
      () =>
        resolveProxyConfig({
          cliProxy: "http://u:p@127.0.0.1:8888",
          env: {},
          target: loopTarget,
        }),
      /credentials are forbidden/,
    );

    // Credentials in env HTTPS_PROXY are rejected for remote targets.
    assert.throws(
      () =>
        resolveProxyConfig({
          cliProxy: "",
          env: { HTTPS_PROXY: "http://u:p@127.0.0.1:8888" },
          target: remoteTarget,
        }),
      /credentials are forbidden/,
    );

    // Loopback target always bypasses env proxy.
    const loopRes = resolveProxyConfig({
      cliProxy: "",
      env: { HTTP_PROXY: "http://127.0.0.1:8888", HTTPS_PROXY: "http://127.0.0.1:8888" },
      target: loopTarget,
    });
    assert.equal(loopRes.proxy, null);
    assert.equal(loopRes.mode, "direct");
    assert.equal(loopRes.forceNoProxy, true);

    // NO_PROXY bypasses env proxy on suffix match.
    const bypassRes = resolveProxyConfig({
      cliProxy: "",
      env: {
        HTTPS_PROXY: "http://127.0.0.1:8888",
        NO_PROXY: "localhost,.dokitool.com",
      },
      target: remoteTarget,
    });
    assert.equal(bypassRes.proxy, null);
    assert.equal(bypassRes.mode, "direct");

    // Valid env proxy without NO_PROXY match is selected cleanly.
    const activeEnvRes = resolveProxyConfig({
      cliProxy: "",
      env: { HTTPS_PROXY: "http://127.0.0.1:8888" },
      target: remoteTarget,
    });
    assert.equal(activeEnvRes.mode, "env-proxy");
    assert.equal(activeEnvRes.proxy.port, 8888);
  });
});

describe("Fail-closed redaction scanner & receipt rendering", () => {
  test("intercepts URLs, IPv4/IPv6, tokens, Bearer, ticket, sig, query strings, and local paths", () => {
    const leaks = [
      ["URL", "checked https://snap.dokitool.com/index.html ok"],
      ["WS URL", "connected ws://127.0.0.1:9222/devtools"],
      ["IPv4", "resolved 203.0.113.42 in 10ms"],
      ["IPv4 loopback", "server on 127.0.0.1 ok"],
      ["IPv6", "peer [2001:db8::1] connected"],
      ["xsec_token", "param xsec_token=AB123456"],
      ["owner_token", "field owner_token: secret"],
      ["Bearer", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9"],
      ["ticket", "weibo ticket=abc123456"],
      ["sign", "cdn sign=deadbeef01"],
      ["sig", "param sig=xyz987"],
      ["query string", "/api/parse?url=abc"],
      ["macOS path", "binary at /Users/alice/work/chrome"],
      ["Linux home path", "cached under /home/runner/.cache/ms-playwright"],
      ["Windows path", "saved in C:\\Users\\bob\\Downloads\\file.mp4"],
      ["Windows JSON escaped path", '"note": "C:\\\\Users\\\\bob\\\\Downloads"'],
      ["relay path", "hit /api/media/weibo directly"],
    ];

    for (const [label, sample] of leaks) {
      assert.throws(
        () => verifyRedactedOutput(sample, { homeDir: "/custom/home/dir" }),
        RedactionViolationError,
        `expected scanner to reject ${label}: ${sample}`,
      );
      const scrubbed = sanitizeText(sample);
      const remaining = scanSensitiveOutput(scrubbed, { homeDir: "/custom/home/dir" });
      assert.deepEqual(
        remaining,
        [],
        `sanitizeText should scrub ${label} completely (got: ${scrubbed}, violations: ${remaining})`,
      );
    }
  });

  test("allows clean Chrome versions, semver, UTC timestamps, and sanitized hostnames", () => {
    const clean = [
      "target_host: snap.dokitool.com",
      "generated_at_utc: 2026-11-24T08:09:48Z",
      "browser_version: HeadlessChrome/149.0.7827.55",
      "extension_version: 4.2.0",
      "workerBuild=downloads-20261124.2",
      "media_hostnames: upos-sz-mirrorcosov.bilivideo.com, rr4---sn-ajoguc-5t.googlevideo.com",
    ].join("\n");
    assert.deepEqual(scanSensitiveOutput(clean, { homeDir: "/Users/fakeuser" }), []);
    assert.equal(sanitizeHostname("127.0.0.1"), "<ip-redacted>");
    assert.equal(sanitizeHostname("https://SNAP.DokiTool.com:443/path"), "https");
    assert.equal(sanitizeHostname("SNAP.DOKITOOL.COM."), "snap.dokitool.com");
  });

  test("renders compliant Markdown & JSON receipts and fails closed if tainted", () => {
    const baseReport = {
      schema_version: "1.0",
      tool: "stage2_browser",
      profile: "lite",
      skip_http_checks: false,
      release_tag: "build-c41fffd",
      source_sha: "c41fffde9b006020e4e985e8b1b06c2524561bc6",
      generated_at_utc: "2026-11-24T06:00:00Z",
      target_host: "snap.dokitool.com",
      elapsed_ms: 8250,
      passed: true,
      environment: {
        platform: "darwin",
        arch: "arm64",
        browser_version: "HeadlessChrome/149.0.7827.55",
        headless_flags: [...MANDATORY_HEADLESS_FLAGS],
        proxy_mode: "direct",
        extension_version: "4.2.0",
        extension_id: DOKITOOL_EXTENSION_ID,
        residual_chrome: 0,
      },
      redaction_scan: { passed: true, sensitive_items: 0 },
      summary: { total: 2, pass: 2, fail: 0, skip: 0 },
      checks: [
        {
          id: "artifact_extension_zip",
          group: "artifact_verify",
          status: "PASS",
          elapsed_ms: 320,
          media_hostnames: [],
          note: "size=471581B, files=13, v4.2.0",
        },
        {
          id: "ext_bridge_handshake",
          group: "official_extension_chrome",
          status: "PASS",
          elapsed_ms: 1900,
          media_hostnames: ["snap.dokitool.com"],
          note: "WEB_EXT_PING ok (v4.2.0), csp=0",
        },
      ],
    };

    const jsonOut = renderJsonReport(baseReport, { homeDir: "/Users/fakeuser" });
    const mdOut = renderMarkdownReport(baseReport, { homeDir: "/Users/fakeuser" });
    assert.ok(mdOut.includes("## 发布回执（阶段二：无头静默浏览器复测）"));
    assert.ok(mdOut.includes("`build-c41fffd` (`c41fffd`)"));
    assert.ok(mdOut.includes("RESIDUAL_CHROME=0"));
    assert.ok(mdOut.includes("脱敏扫描: 0 敏感项"));
    assert.ok(mdOut.includes("| `artifact_extension_zip` |"));
    assert.equal(JSON.parse(jsonOut).passed, true);

    const tainted = structuredClone(baseReport);
    tainted.checks[0].note = "leaked /Users/alice/secret.key";
    assert.throws(
      () => renderJsonReport(tainted, { homeDir: "/Users/fakeuser" }),
      RedactionViolationError,
    );
    assert.throws(
      () => renderMarkdownReport(tainted, { homeDir: "/Users/fakeuser" }),
      RedactionViolationError,
    );
  });
});

describe("Chrome auto-discovery, ZIP validation, and --sync-local-extension safety", () => {
  test("discovers highest Playwright chromium revision before system fallback", () => {
    const fakeHome = "/virtual-home";
    const cacheRoot = path.join(fakeHome, "Library", "Caches", "ms-playwright");
    const rev1217 = path.join(
      cacheRoot,
      "chromium-1217",
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
    const rev1240 = path.join(
      cacheRoot,
      "chromium-1240",
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
    const fakeFiles = new Set([cacheRoot, rev1217, rev1240]);

    const picked = discoverChromeBinary({
      env: {},
      platform: "darwin",
      arch: "arm64",
      homeDir: fakeHome,
      existsSync: (p) => fakeFiles.has(p),
      readdirSync: () => ["chromium-1217", "chromium-900", "chromium-1240", "ffmpeg-1011"],
      isExecutable: (p) => p === rev1217 || p === rev1240,
    });
    assert.equal(picked.source, "playwright-cache");
    assert.equal(picked.revision, 1240);
    assert.equal(picked.path, rev1240);

    // DOKITOOL_CHROME_BIN takes precedence over Playwright cache.
    const customBin = "/opt/custom/chrome";
    const fromEnv = discoverChromeBinary({
      env: { DOKITOOL_CHROME_BIN: customBin },
      platform: "darwin",
      arch: "arm64",
      homeDir: fakeHome,
      isExecutable: (p) => p === path.resolve(customBin),
    });
    assert.equal(fromEnv.source, "env");
    assert.equal(fromEnv.path, path.resolve(customBin));
  });

  test("validates extension ZIP integrity and rejects security violations", () => {
    const prodTarget = validateBaseUrl("https://snap.dokitool.com");
    const validZip = buildValidExtensionZip();
    const sha = crypto.createHash("sha256").update(validZip).digest("hex");
    const manifestData = {
      artifacts: {
        "dokitool-chrome-extension.zip": { sha256: sha, size_bytes: validZip.length },
      },
      frontend_dist_files: {
        "helper/dokitool-chrome-extension.zip": sha,
      },
    };

    const info = validateExtensionArchive(validZip, {
      target: prodTarget,
      manifestData,
      expectedExtVersion: "4.2.0",
      expectedExtFiles: 8,
    });
    assert.equal(info.extensionId, DOKITOOL_EXTENSION_ID);
    assert.equal(info.version, "4.2.0");
    assert.equal(info.fileCount, 8);
    assert.equal(info.manifestVerifiedAgainstRelease, true);

    // Rejects SHA mismatch vs release manifest.
    assert.throws(
      () =>
        validateExtensionArchive(validZip, {
          target: prodTarget,
          manifestData: {
            artifacts: {
              "dokitool-chrome-extension.zip": {
                sha256: "0".repeat(64),
                size_bytes: validZip.length,
              },
            },
          },
        }),
      /SHA-256 mismatch/,
    );

    // Rejects forbidden permissions / content_scripts / wildcards / monitor.html.
    assert.throws(
      () =>
        validateExtensionArchive(
          buildValidExtensionZip({ permissions: ["cookies", "storage"] }),
          { target: prodTarget },
        ),
      /forbidden permission.*cookies/,
    );
    assert.throws(
      () =>
        validateExtensionArchive(
          buildValidExtensionZip({ content_scripts: [{ matches: ["https://snap.dokitool.com/*"], js: ["a.js"] }] }),
          { target: prodTarget },
        ),
      /content_scripts/,
    );
    assert.throws(
      () =>
        validateExtensionArchive(
          buildValidExtensionZip({ host_permissions: ["<all_urls>"] }),
          { target: prodTarget },
        ),
      /wildcard host permission/,
    );
    assert.throws(
      () =>
        validateExtensionArchive(
          buildValidExtensionZip({
            externally_connectable: {
              matches: ["https://snap.dokitool.com/*", "https://evil.example/*"],
            },
          }),
          { target: prodTarget },
        ),
      /externally_connectable/,
    );
    assert.throws(
      () =>
        validateExtensionArchive(
          buildValidExtensionZip({}, [{ name: "monitor.html", data: "<html></html>" }]),
          { target: prodTarget },
        ),
      /monitor bundle/,
    );

    // Rejects corrupt CRC and zip-slip entry paths.
    const badCrcZip = buildTestZip([
      { name: "manifest.json", data: "{}", crcOverride: 0xdeadbeef },
    ]);
    assert.throws(() => parseZipBuffer(badCrcZip), /CRC32 mismatch/);

    const zipSlip = buildTestZip([{ name: "../escape.txt", data: "bad" }]);
    assert.throws(() => parseZipBuffer(zipSlip), /unsafe ZIP entry/);
  });

  test("--sync-local-extension refuses Git-tracked paths and atomically syncs untracked dirs", async () => {
    // Must refuse tracked paths in the real repository.
    assert.throws(
      () => assertPathNotGitTracked(path.join(REPO_ROOT, "scripts", "prod-smoke")),
      /tracked by Git/,
    );
    assert.throws(() => assertPathNotGitTracked(REPO_ROOT), /repository root/);

    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "stage2-sync-test-"));
    try {
      const repoDir = path.join(tmpRoot, "repo");
      await fsp.mkdir(path.join(repoDir, "tracked_dir"), { recursive: true });
      await fsp.writeFile(path.join(repoDir, ".gitignore"), "dist-ext/\n", "utf8");
      await fsp.writeFile(path.join(repoDir, "tracked_dir", "keep.txt"), "original\n", "utf8");
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      execFileSync("git", ["add", ".gitignore", "tracked_dir/keep.txt"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

      const archiveInfo = validateExtensionArchive(buildValidExtensionZip(), {
        target: validateBaseUrl("https://snap.dokitool.com"),
      });

      // Must reject Git-tracked dir, tracked file, repo root, and .git.
      for (const forbidden of [
        repoDir,
        path.join(repoDir, ".git"),
        path.join(repoDir, "tracked_dir"),
        path.join(repoDir, "tracked_dir", "keep.txt"),
      ]) {
        await assert.rejects(
          () => syncExtensionAtomic(archiveInfo, forbidden),
          Stage2Error,
          `must reject tracked target ${forbidden}`,
        );
      }
      assert.equal(
        await fsp.readFile(path.join(repoDir, "tracked_dir", "keep.txt"), "utf8"),
        "original\n",
      );

      // Must succeed on gitignored / untracked dir (both initial create and atomic overwrite).
      const untrackedTarget = path.join(repoDir, "dist-ext");
      const first = await syncExtensionAtomic(archiveInfo, untrackedTarget);
      assert.equal(first.synced, true);
      assert.equal(first.fileCount, 8);
      assert.equal(
        JSON.parse(await fsp.readFile(path.join(untrackedTarget, "manifest.json"), "utf8")).version,
        "4.2.0",
      );

      // Add a stale file and verify atomic sync replaces directory cleanly with zero leftover staging dirs.
      await fsp.writeFile(path.join(untrackedTarget, "stale.txt"), "old", "utf8");
      const second = await syncExtensionAtomic(archiveInfo, untrackedTarget);
      assert.equal(second.synced, true);
      assert.equal(fs.existsSync(path.join(untrackedTarget, "stale.txt")), false);
      const siblings = await fsp.readdir(repoDir);
      assert.equal(
        siblings.some((name) => name.includes(".stage-") || name.includes(".prev-")),
        false,
      );
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 2. Local Loopback Mock End-to-End Headless Chrome Tests
// ============================================================================

async function startMockSiteServer({ injectHomeCspViolation = false } = {}) {
  const themeBootstrapCode =
    "(()=>{document.documentElement.style.colorScheme='light'})()";
  const themeHash = crypto
    .createHash("sha256")
    .update(themeBootstrapCode, "utf8")
    .digest("base64");

  const mainJsRaw = Buffer.from(
    `const app = document.getElementById('app');
const header = document.createElement('header');
header.textContent = 'DokiTool Mock Header';
const box = document.createElement('div');
const input = document.createElement('input');
input.setAttribute('data-initial-url', '');
const btn = document.createElement('button');
btn.className = 'parse-state-btn';
btn.textContent = '开始解析';
box.append(input, btn);
app.append(header, box);
`,
    "utf8",
  );
  const mainJsBr = zlib.brotliCompressSync(mainJsRaw);

  const monitorJsRaw = Buffer.from(
    `const app = document.getElementById('app');
const main = document.createElement('main');
main.className = 'monitor-root';
main.textContent = 'Monitor Ready';
app.appendChild(main);
`,
    "utf8",
  );
  const monitorCssRaw = Buffer.from(
    "html,body{margin:0;padding:0;width:100%;overflow-x:hidden}.monitor-root{max-width:100%;padding:12px;box-sizing:border-box}\n",
    "utf8",
  );

  const workerJsRaw = Buffer.from(
    `const PROTOCOL = 1;
const BUILD = "downloads-mock-2026.1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  const port = event.ports && event.ports[0];
  if (!port) return;
  if (event.data && event.data.protocol === PROTOCOL && event.data.action === "ping") {
    port.postMessage({
      protocol: PROTOCOL,
      workerBuild: BUILD,
      workerInstance: "mock-instance",
      capabilities: { admission: true, recovery: true, tbvideo: true },
    });
  }
});
`,
    "utf8",
  );

  const bridgeHtml = Buffer.from(
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Bridge</title></head><body id="dokitool-download-bridge"></body></html>',
    "utf8",
  );
  const llmsTxt = Buffer.from("# DokiTool Mock LLMs\n", "utf8");

  const extZip = buildValidExtensionZip({
    externally_connectable: {
      matches: ["http://127.0.0.1/*"],
    },
  });

  const extraInlineViolation = injectHomeCspViolation
    ? "<script>window.__INLINE_VIOLATION__ = 1;</script>"
    : "";
  const homeHtml = Buffer.from(
    `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>DokiTool Mock</title>
  <script id="dokitool-theme-bootstrap">${themeBootstrapCode}</script>
  ${extraInlineViolation}
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/assets/main-Mock1234.js"></script>
</body>
</html>`,
    "utf8",
  );

  const monitorHtml = Buffer.from(
    `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DokiTool Monitor Mock</title>
  <link rel="stylesheet" href="/assets/monitor-Mock1234.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/assets/monitor-Mock1234.js"></script>
</body>
</html>`,
    "utf8",
  );

  const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

  const manifestObj = {
    schema_version: "1.0",
    release_tag: "build-mock123",
    source_sha: "mock1234567890abcdef1234567890abcdef1234",
    artifacts: {
      "dokitool-chrome-extension.zip": {
        sha256: sha256(extZip),
        size_bytes: extZip.length,
      },
    },
    frontend_dist_files: {
      "assets/main-Mock1234.js": sha256(mainJsRaw),
      "assets/main-Mock1234.js.br": sha256(mainJsBr),
      "downloads/worker.js": sha256(workerJsRaw),
      "helper/dokitool-chrome-extension.zip": sha256(extZip),
      "llms.txt": sha256(llmsTxt),
    },
  };

  const baseHeaders = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": `default-src 'self'; script-src 'self' 'sha256-${themeHash}'; style-src 'self' 'unsafe-inline'; worker-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
      });
      res.end(homeHtml);
      return;
    }

    if (pathname === "/monitor" || pathname === "/monitor.html") {
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(monitorHtml);
      return;
    }

    if (pathname === "/downloads/bridge.html") {
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      });
      res.end(bridgeHtml);
      return;
    }

    if (pathname === "/downloads/worker.js") {
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Frame-Options": "DENY",
      });
      res.end(workerJsRaw);
      return;
    }

    if (pathname === "/assets/main-Mock1234.js") {
      const ae = String(req.headers["accept-encoding"] || "");
      const headers = {
        ...baseHeaders,
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Frame-Options": "DENY",
        Vary: "Accept-Encoding",
      };
      if (/\bbr\b/i.test(ae)) {
        headers["Content-Encoding"] = "br";
        res.writeHead(200, headers);
        res.end(mainJsBr);
      } else {
        res.writeHead(200, headers);
        res.end(mainJsRaw);
      }
      return;
    }

    if (pathname === "/assets/monitor-Mock1234.js") {
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Frame-Options": "DENY",
      });
      res.end(monitorJsRaw);
      return;
    }

    if (pathname === "/assets/monitor-Mock1234.css") {
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Frame-Options": "DENY",
      });
      res.end(monitorCssRaw);
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": "image/png",
        "Cache-Control": "no-cache",
        "X-Frame-Options": "DENY",
      });
      res.end(MINI_PNG);
      return;
    }

    if (pathname === "/llms.txt") {
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Frame-Options": "DENY",
      });
      res.end(llmsTxt);
      return;
    }

    if (pathname === "/helper/dokitool-chrome-extension.zip") {
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": "application/zip",
        "Cache-Control": "no-cache",
        "X-Frame-Options": "DENY",
      });
      res.end(extZip);
      return;
    }

    if (pathname === "/api/stats") {
      res.writeHead(401, {
        ...baseHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
      });
      res.end(
        JSON.stringify({
          schema_version: "1.0",
          code: "INVALID_INPUT",
          error: { code: "INVALID_INPUT", message: "未授权" },
        }),
      );
      return;
    }

    res.writeHead(404, {
      ...baseHeaders,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Frame-Options": "DENY",
    });
    res.end("not found\n");
  });

  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    manifestObj,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("Loopback mock end-to-end headless Chrome verification", () => {
  const skipBrowser = process.env.DOKITOOL_STAGE2_SKIP_BROWSER === "1";
  const requireBrowser = process.env.DOKITOOL_STAGE2_REQUIRE_BROWSER === "1";
  const discoveredChrome = skipBrowser ? null : discoverChromeBinary();

  test("passes full lite profile (HTTP + pure-web Chrome + official extension Chrome + atomic sync) with zero residual Chrome", async (t) => {
    if (skipBrowser) {
      t.skip("browser tests disabled via DOKITOOL_STAGE2_SKIP_BROWSER=1");
      return;
    }
    if (!discoveredChrome) {
      if (requireBrowser) {
        assert.fail("Chrome binary required (DOKITOOL_STAGE2_REQUIRE_BROWSER=1) but not found");
      }
      t.skip("Chrome binary not available in local environment");
      return;
    }

    const mock = await startMockSiteServer();
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "stage2-e2e-"));
    try {
      const manifestPath = path.join(tmpDir, "release-manifest.json");
      const syncDir = path.join(tmpDir, "synced-extension");
      await fsp.writeFile(manifestPath, JSON.stringify(mock.manifestObj, null, 2), "utf8");

      const report = await runStage2({
        baseUrl: mock.baseUrl,
        profile: "lite",
        manifestPath,
        syncLocalExtension: syncDir,
        expectedExtFiles: 8,
        expectedExtVersion: "4.2.0",
        timeoutSeconds: 20,
      });

      assert.equal(
        report.passed,
        true,
        `expected lite mock run to pass: ${JSON.stringify(report.checks, null, 2)}`,
      );
      assert.equal(report.summary.fail, 0);
      assert.equal(report.summary.skip, 0);
      assert.equal(report.environment.residual_chrome, 0);
      assert.equal(report.environment.extension_id, DOKITOOL_EXTENSION_ID);
      assert.equal(report.environment.extension_version, "4.2.0");
      assert.equal(report.target_host, "<ip-redacted>");

      const byId = new Map(report.checks.map((c) => [c.id, c]));
      for (const id of [
        "artifact_extension_zip",
        "sync_local_extension",
        "http_worker_build",
        "http_home_headers",
        "http_monitor_headers",
        "http_precompressed_br",
        "http_llms_txt",
        "http_true_404",
        "http_api_stats_unauth",
        "web_home_hydration",
        "web_sw_bridge",
        "web_monitor_responsive",
        "ext_bridge_handshake",
      ]) {
        assert.equal(byId.get(id)?.status, "PASS", `expected check ${id} to PASS`);
      }

      assert.equal(fs.existsSync(path.join(syncDir, "manifest.json")), true);

      // Rendered JSON and Markdown must pass fail-closed redaction with 0 violations.
      const jsonText = renderJsonReport(report);
      const mdText = renderMarkdownReport(report);
      assert.doesNotThrow(() => verifyRedactedOutput(jsonText));
      assert.doesNotThrow(() => verifyRedactedOutput(mdText));
      assert.ok(mdText.includes("`build-mock123` (`mock123`)"));
    } finally {
      await mock.close();
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("honors --skip-http-checks and fails closed on CSP violations", async (t) => {
    if (skipBrowser) {
      t.skip("browser tests disabled via DOKITOOL_STAGE2_SKIP_BROWSER=1");
      return;
    }
    if (!discoveredChrome) {
      if (requireBrowser) {
        assert.fail("Chrome binary required (DOKITOOL_STAGE2_REQUIRE_BROWSER=1) but not found");
      }
      t.skip("Chrome binary not available in local environment");
      return;
    }

    const mock = await startMockSiteServer({ injectHomeCspViolation: true });
    try {
      const report = await runStage2({
        baseUrl: mock.baseUrl,
        profile: "lite",
        skipHttpChecks: true,
        timeoutSeconds: 20,
      });

      assert.equal(report.passed, false);
      assert.equal(report.environment.residual_chrome, 0);
      const byId = new Map(report.checks.map((c) => [c.id, c]));
      assert.equal(byId.get("http_home_headers")?.status, "SKIP");
      assert.equal(byId.get("http_true_404")?.status, "SKIP");
      assert.equal(byId.get("web_home_hydration")?.status, "FAIL");
      assert.match(byId.get("web_home_hydration")?.note || "", /CSP violations=/);
      assert.equal(byId.get("web_sw_bridge")?.status, "PASS");
      assert.equal(byId.get("web_monitor_responsive")?.status, "PASS");
      assert.equal(byId.get("ext_bridge_handshake")?.status, "FAIL");
      assert.match(byId.get("ext_bridge_handshake")?.note || "", /CSP violations=/);
    } finally {
      await mock.close();
    }
  });
});
